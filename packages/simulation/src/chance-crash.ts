/**
 * Phase 25 Slice 4 — Chance-constrained greedy CPM crasher.
 *
 * Same outer loop as Slice 3's deterministic `greedyCrash`, but the
 * deadline-met check uses the Monte-Carlo **P95 finish** instead of the
 * deterministic projectEnd. Each iteration runs a fixed-budget MC
 * (~100 iterations by default) with a fixed seed, so re-evaluating any
 * given configuration is byte-identical — MC noise can't make the
 * algorithm bounce.
 *
 * Lives in `@procsim/simulation` because it consumes `simulate`. Shares
 * the candidate-picking math (`pickBestStep`) with Slice 3 — both use
 * the deterministic CPM critical path as the candidate pool; the only
 * difference is the metric.
 *
 * Decisions baked in (per Phase 25 Slice 4 planning notes):
 *   - **Deterministic critical-path detection.** Textbook treats the
 *     candidate pool as a CPM operation; MC only affects the finish-time
 *     metric. Avoids bouncing from MC-flipped critical paths.
 *   - **Single seed for every evaluation.** Reusing the same seed across
 *     successive evaluations means the same configuration always gives
 *     the same P95. Removes MC noise as a bouncing source.
 *   - **ε-tolerance on the deadline check.** P95 within ε working days
 *     of the deadline counts as met. Default 0.5 working days, scaled
 *     by the project default calendar's `hoursPerDay`.
 *   - **Cancellation via a polled signal.** Cheaper than AbortController
 *     and structured-clone-safe across the Web Worker boundary (the
 *     worker mutates its own copy of the signal flag).
 *   - **Discards partial plan on cancel.** UI surface treats cancellation
 *     as "give up entirely" rather than "show what you had so far."
 */

import { schedule, pickBestStep } from '@procsim/scheduler';
import type { CrashStep, GreedyCrashPlan, ScheduleInput } from '@procsim/scheduler';
import type { Calendar, ProjectNode, Resource } from '@procsim/file-format';
import { simulate } from './index.js';

export interface ChanceCrashOptions {
  /** MC iterations per evaluation step. Default 100. */
  iterations: number;
  /** Root seed — same seed → same MC paths → stable evaluations. Default 42. */
  seed: number;
  /**
   * P95 within ε working days of deadline counts as met. Default 0.5.
   * Converted to hours via the project default calendar's `hoursPerDay`.
   */
  epsilonDays: number;
  /**
   * Cooperative cancellation token. The greedy polls this between
   * iterations; when `cancelled` flips to true the function returns
   * with `cancelled: true` on the plan and no further MC runs are
   * launched. Caller-owned object — pass a fresh one per run.
   */
  signal?: { cancelled: boolean };
}

export interface ChanceCrashPlan extends GreedyCrashPlan {
  /**
   * True if the caller's signal flipped to `cancelled: true` before the
   * deadline was met. `steps` may be empty or partial. The UI is
   * expected to discard the plan on cancel (per Slice 4 spec).
   */
  cancelled: boolean;
  /** Final P95 finish (Date). Differs from `finalFinish` which is the deterministic CPM finish. */
  finalP95: Date;
}

const DEFAULTS: ChanceCrashOptions = {
  iterations: 100,
  seed: 42,
  epsilonDays: 0.5,
};

/**
 * Greedily compress the schedule's P95 finish toward `deadline`. Each
 * step picks the cheapest $/working-day candidate on the deterministic
 * critical path (same as `greedyCrash`), applies it, and re-evaluates
 * P95 by running an MC of `opts.iterations` paths with `opts.seed`.
 *
 * **Async.** The function yields to the event loop via a microtask
 * `Promise.resolve()` between iterations, which lets the worker thread
 * process incoming `cancel` messages mid-run. Without this yield, a
 * synchronous loop would block the worker's message handler and
 * cancellation would never fire until completion. The yield is
 * negligible cost — it adds one microtask per crash step.
 *
 * `onProgress(step, p95)` fires after each accepted step (throttled by
 * the worker layer; the helper itself doesn't time-throttle). Cheap to
 * call — no payload allocation beyond the two arguments.
 */
export async function chanceCrash(
  input: ScheduleInput,
  deadline: Date,
  opts: Partial<ChanceCrashOptions> = {},
  onProgress?: (step: number, p95: Date) => void,
): Promise<ChanceCrashPlan> {
  const cfg: ChanceCrashOptions = { ...DEFAULTS, ...opts };
  // Defensive — accidental signal omission shouldn't crash; treat as "never cancelled."
  const signal = cfg.signal;

  let workingNodes: ProjectNode[] = input.nodes.map((n) => ({ ...n }));

  const calMap = new Map<string, Calendar>(input.calendars.map((c) => [c.id, c]));
  const resourceMap = new Map<string, Resource>(input.resources.map((r) => [r.id, r]));
  const defaultCal = calMap.get(input.project.defaultCalendarId);

  const fallbackStart = new Date(input.project.startDate + 'T00:00:00');
  const fallbackPlan = (
    finish: Date,
    p95: Date,
    reached: boolean,
    cancelled: boolean,
    steps: CrashStep[] = [],
    totalAddedCost = 0,
  ): ChanceCrashPlan => ({
    steps,
    totalAddedCost,
    finalFinish: finish,
    finalP95: p95,
    reachedDeadline: reached,
    cancelled,
  });

  if (!defaultCal) return fallbackPlan(fallbackStart, fallbackStart, false, false);

  // ε in hours via the project default calendar. A project on a 4h/day
  // calendar gets a stricter wall-clock tolerance than one on 8h/day,
  // matching the user's expectation that "half a working day" scales.
  const epsilonHours = cfg.epsilonDays * defaultCal.hoursPerDay;

  // Baseline deterministic schedule (for critical-path detection on each iter).
  let outcome = schedule({ ...input, nodes: workingNodes });
  if (!outcome.ok) return fallbackPlan(fallbackStart, fallbackStart, false, false);

  // Baseline MC.
  let p95 = mcP95(input, workingNodes, cfg);
  if (signal?.cancelled) {
    return fallbackPlan(outcome.result.projectEnd, p95, false, true);
  }
  if (p95Met(p95, deadline, epsilonHours)) {
    return fallbackPlan(outcome.result.projectEnd, p95, true, false);
  }

  const steps: CrashStep[] = [];
  let totalAddedCost = 0;
  const maxIterations = workingNodes.length * 10 + 10;
  let iter = 0;

  while (iter < maxIterations) {
    // Yield to the event loop so a queued cancel message can be processed
    // by the worker before the next MC fires. Cheap — one microtask per
    // iteration. In Node test environments this is also a no-op except
    // for resolved-promise scheduling.

    await Promise.resolve();
    iter++;
    if (signal?.cancelled) {
      return fallbackPlan(outcome.result.projectEnd, p95, false, true, steps, totalAddedCost);
    }

    const next = pickBestStep(workingNodes, outcome.result, calMap, resourceMap, defaultCal);
    if (!next) break;

    workingNodes = workingNodes.map((n) =>
      n.id === next.nodeId ? { ...n, selectedCrashIndex: next.toIndex } : n,
    );
    steps.push({
      nodeId: next.nodeId,
      fromIndex: next.fromIndex,
      toIndex: next.toIndex,
      perDay: next.perDay,
      addedCost: next.addedCost,
    });
    totalAddedCost += next.addedCost;

    // Reschedule deterministic CPM (for the next iteration's critical-path detection).
    outcome = schedule({ ...input, nodes: workingNodes });
    if (!outcome.ok) {
      // Roll back the failing step and bail. Mirrors Slice 3's defensive path.
      const reverted = steps.pop()!;
      totalAddedCost -= reverted.addedCost;
      workingNodes = workingNodes.map((n) => {
        if (n.id !== reverted.nodeId) return n;
        if (reverted.fromIndex === undefined) {
          const { selectedCrashIndex: _omit, ...rest } = n;
          return rest;
        }
        return { ...n, selectedCrashIndex: reverted.fromIndex };
      });
      outcome = schedule({ ...input, nodes: workingNodes });
      const finFinish = outcome.ok ? outcome.result.projectEnd : fallbackStart;
      return fallbackPlan(finFinish, p95, false, false, steps, totalAddedCost);
    }

    // Re-evaluate P95 via MC.
    p95 = mcP95(input, workingNodes, cfg);
    if (onProgress) onProgress(iter, p95);

    if (signal?.cancelled) {
      return fallbackPlan(outcome.result.projectEnd, p95, false, true, steps, totalAddedCost);
    }
    if (p95Met(p95, deadline, epsilonHours)) {
      return fallbackPlan(outcome.result.projectEnd, p95, true, false, steps, totalAddedCost);
    }
  }

  return fallbackPlan(
    outcome.result.projectEnd,
    p95,
    p95Met(p95, deadline, epsilonHours),
    false,
    steps,
    totalAddedCost,
  );
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * P95 ≤ deadline + ε working hours. ε is in HOURS at the project default
 * calendar's rate; the caller has already scaled `epsilonDays`. Date math
 * uses raw ms — calendar-aware comparison would compute working hours
 * between the two dates which is more work for negligible accuracy gain
 * at the ε scale.
 */
function p95Met(p95: Date, deadline: Date, epsilonHours: number): boolean {
  return p95.getTime() <= deadline.getTime() + epsilonHours * 3_600_000;
}

/** Run a fixed-budget MC and return the resulting P95 finish. */
function mcP95(
  input: ScheduleInput,
  workingNodes: ReadonlyArray<ProjectNode>,
  cfg: ChanceCrashOptions,
): Date {
  const simResult = simulate({
    schedule: { ...input, nodes: workingNodes as ProjectNode[] },
    iterations: cfg.iterations,
    seed: cfg.seed,
  });
  return simResult.percentiles.p95;
}
