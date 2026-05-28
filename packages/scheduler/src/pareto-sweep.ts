/**
 * Phase 26 Slice 1 — Pareto sweep over deterministic greedy crash plans.
 *
 * Sample N deadlines uniformly between the **fully-crashed** finish
 * (greedy applied with no upper bound) and the **uncrashed** finish
 * (current `projectEnd` with no crash selections). For each sample,
 * run `greedyCrash` and collect `(cost, finish)`. Mark Pareto-frontier
 * points (those not dominated by any other sample).
 *
 * Pure / deterministic — same input always produces the same sweep.
 *
 * **Slice-1 scope**: deterministic only. A future slice could add a
 * chance-constrained variant by accepting a metric function or a mode
 * flag; the result shape stays identical (`GreedyCrashPlan` and
 * `ChanceCrashPlan` share `steps` / `totalAddedCost` / `finalFinish`).
 *
 * **Why deterministic-only for Slice 1**: chance-constrained sweep is
 * N × (~seconds per chanceCrash) — needs the worker, progress, and
 * cancellation plumbing. Deterministic sweep is fast enough on-thread
 * for typical projects (sub-second at N=15 for 100-activity projects).
 *
 * **Limitations** (documented per Phase 26 DoD):
 * - Sweep granularity is N (10–20 default). Not a full Pareto solver —
 *   gaps between sample deadlines can hide intermediate trade-off points
 *   that a continuous solver would surface.
 * - The greedy is monotone-step-ish but not guaranteed to produce the
 *   cheapest plan for every deadline. Some sample points may be
 *   dominated by deeper-deadline runs that found a cheaper configuration.
 *   The frontier-marking step filters those.
 */

import { greedyCrash } from './crash.js';
import type { GreedyCrashPlan } from './crash.js';
import { schedule } from './cpm.js';
import type { ScheduleInput } from './types.js';

export interface ParetoSweepPoint {
  /** The deadline used for this sample. */
  deadline: Date;
  /** The greedy plan produced for `deadline`. */
  plan: GreedyCrashPlan;
  /** Convenience: `plan.totalAddedCost`. Cost contributed by crash decisions. */
  cost: number;
  /** Convenience: `plan.finalFinish`. */
  finish: Date;
  /**
   * True iff no other point in the sweep dominates this one (lower cost
   * AND earlier finish). The uncrashed point and the fully-crashed point
   * are always on the frontier; interior dominated points are surfaced
   * in grey by the UI.
   */
  onFrontier: boolean;
}

export interface ParetoSweepOptions {
  /** Number of deadlines to sample (inclusive of both endpoints). Default 15. */
  samples: number;
}

export interface ParetoSweepResult {
  /** Sweep points in deadline-order (earliest deadline first → latest). */
  points: ParetoSweepPoint[];
  /**
   * The two bounds the sweep ran between. `uncrashed` is the project's
   * current finish with no crash selections applied. `fullyCrashed` is
   * the greedy applied with no deadline upper bound (deepest crash the
   * greedy can find — may not reach the algorithm's theoretical minimum
   * if it ran out of feasible steps).
   */
  uncrashed: { cost: 0; finish: Date };
  fullyCrashed: { cost: number; finish: Date };
}

const DEFAULTS: ParetoSweepOptions = {
  samples: 15,
};

/**
 * Run the Pareto sweep.
 *
 * Returns an empty result (no points, both bounds set to projectStart)
 * when the input schedule fails to compute or has no crashable activities
 * on the critical path — the UI hides the panel in that case.
 */
export function paretoSweep(
  input: ScheduleInput,
  options: Partial<ParetoSweepOptions> = {},
): ParetoSweepResult {
  const cfg: ParetoSweepOptions = { ...DEFAULTS, ...options };
  // Clamp samples to a sensible range. <2 makes no sense (need at least
  // both endpoints); >50 is wasteful and the UI scatterplot gets noisy.
  const N = Math.max(2, Math.min(50, Math.floor(cfg.samples)));

  const fallbackStart = new Date(input.project.startDate + 'T00:00:00');
  const empty: ParetoSweepResult = {
    points: [],
    uncrashed: { cost: 0, finish: fallbackStart },
    fullyCrashed: { cost: 0, finish: fallbackStart },
  };

  // ── Uncrashed bound ──────────────────────────────────────────────────────
  // The user's current project state with whatever `selectedCrashIndex`
  // values are already in place — that's the "no further crashes" anchor.
  // (If you want a clean-slate sweep, strip selectedCrashIndex from input
  // before calling — same escape hatch as the modal's "Reset first".)
  const uncrashedOutcome = schedule(input);
  if (!uncrashedOutcome.ok) return empty;
  const uncrashedFinish = uncrashedOutcome.result.projectEnd;

  // ── Fully-crashed bound ──────────────────────────────────────────────────
  // Run greedy with a deadline far in the past so it crashes everything
  // feasible. Using `projectStart - 1ms` is enough — finish > that for any
  // non-degenerate project.
  const veryEarlyDeadline = new Date(fallbackStart.getTime() - 1);
  const fullyCrashedPlan = greedyCrash(input, veryEarlyDeadline);
  const fullyCrashedFinish = fullyCrashedPlan.finalFinish;
  const fullyCrashedCost = fullyCrashedPlan.totalAddedCost;

  // Degenerate: no crashes possible at all (no critical-path activity has
  // crashOptions). The fully-crashed bound equals the uncrashed bound and
  // there's nothing to sweep.
  if (fullyCrashedFinish.getTime() >= uncrashedFinish.getTime() && fullyCrashedCost === 0) {
    return empty;
  }

  // ── Sample N deadlines uniformly between the two bounds ──────────────────
  // The endpoints sample deadlines = fullyCrashedFinish (forces deepest
  // crash again, producing the same plan) and uncrashedFinish (returns
  // empty plan, just the uncrashed bound). The N−2 interior samples land
  // between them.
  const tMin = fullyCrashedFinish.getTime();
  const tMax = uncrashedFinish.getTime();
  const points: ParetoSweepPoint[] = [];
  for (let i = 0; i < N; i++) {
    const t = tMin + ((tMax - tMin) * i) / (N - 1);
    const deadline = new Date(t);
    const plan = greedyCrash(input, deadline);
    points.push({
      deadline,
      plan,
      cost: plan.totalAddedCost,
      finish: plan.finalFinish,
      onFrontier: false, // filled in below
    });
  }

  // ── Mark Pareto frontier ─────────────────────────────────────────────────
  // A point is dominated iff some other point has lower-or-equal cost AND
  // earlier-or-equal finish, with at least one strict inequality. O(N²)
  // is trivially fine at N ≤ 50.
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    let dominated = false;
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue;
      const b = points[j]!;
      const costLE = b.cost <= a.cost;
      const finLE = b.finish.getTime() <= a.finish.getTime();
      const strict = b.cost < a.cost || b.finish.getTime() < a.finish.getTime();
      if (costLE && finLE && strict) {
        dominated = true;
        break;
      }
    }
    a.onFrontier = !dominated;
  }

  return {
    points,
    uncrashed: { cost: 0, finish: uncrashedFinish },
    fullyCrashed: { cost: fullyCrashedCost, finish: fullyCrashedFinish },
  };
}
