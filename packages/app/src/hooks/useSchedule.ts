import { useEffect, useSyncExternalStore } from 'react';
import { type ScheduleOutcome } from '@procsim/scheduler';
import { useDomainStore } from '../store/domainStore.js';
import {
  getCachedOrSyncFallback,
  subscribeToScheduleCache,
  triggerAsyncRefresh,
} from './scheduleCache.js';

/**
 * Reactively reads the CPM schedule for the current domain project.
 *
 * Returns the latest cached `ScheduleOutcome`, sharing one cache + one
 * in-flight refresh across all six call sites in the app.
 *
 * Audit N-9 — pre-this-refactor the hook ran `schedule()` synchronously
 * inside a `useMemo`, blocking the main thread on every project edit.
 * Now it reads from a module-level cache that's refreshed asynchronously
 * via the engine-worker's `scheduleAsync`. First render still computes
 * synchronously (so the initial paint is correct); subsequent edits run
 * off the main thread.
 *
 * Phase 33 Slice 2 — resources with `currencyOverride` are converted to
 * project currency BEFORE the engine sees them. The engine remains pure
 * project-currency in / project-currency out; the override is a
 * display-only concept that the conversion strips before reaching the
 * scheduler. The conversion happens inside `scheduleCache.buildInput`.
 *
 * Public signature unchanged from pre-N-9 — the six call sites (App,
 * NodePanel, SubsystemPanel, ProjectSettingsModal, ResourcePalette,
 * SimulateView) still receive a `ScheduleOutcome` synchronously. Briefly
 * stale data is acceptable for schedule display; the trade-off is
 * documented at the cache module's top.
 */
export function useSchedule(): ScheduleOutcome {
  const project = useDomainStore((s) => s.project);

  // useSyncExternalStore reads the shared cache. The snapshot getter
  // reads (and on first ever render, sync-computes); the subscribe
  // function plugs into cache notifications so an async refresh
  // landing fires a re-render across all useSchedule callers.
  const outcome = useSyncExternalStore(subscribeToScheduleCache, () =>
    getCachedOrSyncFallback(project),
  );

  // Side-effect: kick off an async refresh whenever the project ref
  // changes. The cache module dedupes per-project, so the six calling
  // components don't multiply the work — only the first to fire this
  // effect for a given project actually dispatches `scheduleAsync`.
  useEffect(() => {
    triggerAsyncRefresh(project);
  }, [project]);

  return outcome;
}
