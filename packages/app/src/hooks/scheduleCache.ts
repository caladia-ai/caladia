/**
 * Audit N-9 — shared schedule cache for `useSchedule`.
 *
 * Pre-N-9 `useSchedule` ran `schedule()` synchronously inside a useMemo.
 * Six components call the hook independently, so every project edit
 * triggered up to six main-thread CPM recomputes — perceptible jank on
 * the flagship templates (Oncology ~90 nodes, Tentpole ~88 nodes).
 *
 * This module holds the cached `ScheduleOutcome` and orchestrates async
 * refreshes via the engine-worker's `scheduleAsync`. Six hook calls
 * share one cache, one in-flight refresh, one outcome.
 *
 * Lifecycle:
 *
 *   1. First call to `getCachedOrSyncFallback(P)` (cache empty):
 *      compute SYNC, populate cache, return outcome. One-time first-
 *      paint cost; matches the pre-N-9 behaviour.
 *
 *   2. Subsequent calls with project === cachedProject: cache hit,
 *      return cached outcome. No work.
 *
 *   3. Call with a NEW project (project !== cachedProject):
 *      return the STALE cachedOutcome immediately. The caller's
 *      `useEffect` (in useSchedule.ts) fires `triggerAsyncRefresh(P)`
 *      which dispatches `scheduleAsync` on the engine-worker. When
 *      the async resolves, the cache updates and subscribers fire,
 *      causing all `useSchedule` callers to re-read the fresh value.
 *
 *   4. Project changes again while async in-flight: the in-flight
 *      refresh is aborted, a fresh refresh starts. The cache stays
 *      at the last successfully-resolved value until the new one
 *      lands.
 *
 *   5. Async fails (worker dead / network error / scheduleAsync
 *      rejection): fall back to a sync compute so the cache stays
 *      usable. The first-render sync compute already proves the
 *      engine works in this process, so this fallback is reliable
 *      defence-in-depth.
 *
 * Trade-off: between a project edit and the async result landing,
 * the UI displays the previous schedule (stale by ~50-200 ms on
 * flagship templates). For schedule display this is invisible — the
 * dates lag a hundred ms behind a typed character. The main thread
 * stays unblocked, so animations / pan-zoom / typing all stay
 * responsive.
 */

import { schedule, type ScheduleInput, type ScheduleOutcome } from '@procsim/scheduler';
import { convertResourceCostsToProjectCurrency, type ProjectFile } from '@procsim/file-format';
import { getEngineWorker } from '../engineWorker.js';

interface CacheState {
  /** Project ref the current `outcome` was computed from. */
  project: ProjectFile | null;
  outcome: ScheduleOutcome | null;
  /** Project ref of the refresh currently in-flight (or null if none). */
  inFlightProject: ProjectFile | null;
  /** Cancellation handle for the in-flight refresh. */
  inFlightAbort: AbortController | null;
}

const state: CacheState = {
  project: null,
  outcome: null,
  inFlightProject: null,
  inFlightAbort: null,
};

const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

function buildInput(project: ProjectFile): ScheduleInput {
  return {
    project: project.project,
    nodes: project.nodes,
    edges: project.edges,
    resources: convertResourceCostsToProjectCurrency(project),
    calendars: project.calendars,
    loops: project.loops,
    subsystems: project.subsystems,
  };
}

function computeSync(project: ProjectFile): ScheduleOutcome {
  return schedule(buildInput(project));
}

/**
 * Read the outcome corresponding to `project` from the cache.
 *
 * - First call ever (cache empty): compute SYNC and populate. Used by
 *   `useSyncExternalStore`'s snapshot read on first render so the
 *   initial paint is correct.
 * - Cache hit (project === cachedProject): return cached outcome.
 * - Cache miss (project !== cachedProject): return the STALE cached
 *   outcome. Callers should pair this with `triggerAsyncRefresh` to
 *   eventually replace it.
 */
export function getCachedOrSyncFallback(project: ProjectFile): ScheduleOutcome {
  if (state.outcome === null || state.project === null) {
    const outcome = computeSync(project);
    state.project = project;
    state.outcome = outcome;
    // No notify — we're synchronously inside a render read.
    return outcome;
  }
  // Either a cache hit (project === cachedProject) or a stale hit
  // (project !== cachedProject). Either way return what we have; the
  // refresh side-effect catches up via subscribers.
  return state.outcome;
}

/**
 * Idempotent — calling repeatedly for the same project is safe (will
 * not start a second concurrent refresh). Calling for a NEW project
 * aborts the previous in-flight refresh.
 *
 * No-op when `project === state.project` (cache already fresh).
 */
export function triggerAsyncRefresh(project: ProjectFile): void {
  // Cache already fresh for this project.
  if (state.project === project) return;
  // A refresh is already running for this exact project.
  if (state.inFlightProject === project) return;

  // Abort any prior in-flight refresh (the project has changed since).
  state.inFlightAbort?.abort();

  const ac = new AbortController();
  state.inFlightProject = project;
  state.inFlightAbort = ac;

  getEngineWorker()
    .scheduleAsync(buildInput(project), ac.signal)
    .then((outcome) => {
      if (ac.signal.aborted) return;
      // Sanity: another refresh may have superseded this one between
      // the `then` queuing and execution. Bail if so.
      if (state.inFlightProject !== project) return;
      state.project = project;
      state.outcome = outcome;
      state.inFlightProject = null;
      state.inFlightAbort = null;
      notify();
    })
    .catch((err) => {
      // Expected abort: another refresh took over. No fallback needed.
      if (ac.signal.aborted) return;
      // Real failure (worker crashed, etc.). Fall back to sync so the
      // cache stays usable. Surface for diagnosis but don't throw —
      // the caller is a React render path.
      console.error('[useSchedule] async refresh failed; falling back to sync:', err);
      if (state.inFlightProject !== project) return;
      try {
        const outcome = computeSync(project);
        state.project = project;
        state.outcome = outcome;
        state.inFlightProject = null;
        state.inFlightAbort = null;
        notify();
      } catch (syncErr) {
        // schedule() itself threw — nothing to do but log. Cache stays
        // at the previous successfully-resolved value.
        console.error('[useSchedule] sync fallback also threw:', syncErr);
        state.inFlightProject = null;
        state.inFlightAbort = null;
      }
    });
}

/**
 * Subscribe to cache-update notifications. Returns an unsubscribe
 * function. Used by `useSyncExternalStore` in `useSchedule.ts`.
 */
export function subscribeToScheduleCache(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

// ── Test-only helpers ────────────────────────────────────────────────────────

/**
 * Reset cache to its initial empty state. Tests MUST call this in
 * `beforeEach` to prevent state leaking between tests.
 */
export function _resetScheduleCache(): void {
  state.inFlightAbort?.abort();
  state.project = null;
  state.outcome = null;
  state.inFlightProject = null;
  state.inFlightAbort = null;
  // Don't notify — tests shouldn't depend on reset firing subscribers.
}

/** Inspect the cache state (read-only). Test-only. */
export function _peekScheduleCache(): Readonly<CacheState> {
  return state;
}
