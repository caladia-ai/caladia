/**
 * Phase 48 Slice 2 — Multi-diagnostic convergence detection.
 *
 * The Phase 16 detector only watched end-date P50/P80/P95 with a fixed
 * 6-hour stability bar. That worked for short-horizon projects but failed
 * silently on the Phase 47 giants (Oncology / Tentpole both span ~13–16
 * years; 6 h drift on a 16-year project is sub-noise precision the
 * detector kept reporting as "not converged" through 10 000 iterations).
 *
 * Slice 2 extends the criterion to the six diagnostics whose stability
 * is load-bearing for the public `SimulationResult` shape:
 *
 *   1. end-date percentiles (P50 / P80 / P95)
 *   2. cost percentiles (P50 / P80 / P95)
 *   3. criticality index (per-node fraction of iterations on critical path)
 *   4. nodeP95 (per-node 95th-percentile finish time)
 *   5. nodeCostStats (per-node mean + 95th cost)
 *   6. cost-curve percentiles (per-bucket cumulative cost percentiles)
 *
 * Each tracker counts consecutive checks where its drift sits below an
 * epsilon. When every tracker has reached `CONVERGENCE_STABILITY_SAMPLES`
 * consecutive stable observations, the simulation is "converged."
 *
 * Derived diagnostics (`tornado`, `pathFrequency`, `finishSensitivity`,
 * `costSensitivity`) fall out from the primitives above — once the
 * primitives are stable, the derived metrics are stable by construction,
 * so they don't need their own trackers.
 *
 * **Calibration.** Time and cost epsilons are *relative to project
 * scale*, with absolute floors so tiny projects still need a minimum drift
 * to declare stability. Anchors (median end-hours, median project cost)
 * are computed at the first check and frozen for the rest of the run.
 *
 * See ARCHITECTURE.md "Multi-diagnostic convergence detection".
 */

// ── Tunables ─────────────────────────────────────────────────────────────────

/** How often (in iterations) we re-sample the diagnostics to test stability. */
export const CONVERGENCE_CHECK_INTERVAL = 50;

/**
 * Minimum sample count below which `performConvergenceCheck` declines
 * to update its trackers or seed its previous-snapshot anchors.
 *
 * Phase 50 Slice 21 / audit I-8. The end/cost percentile lookup uses
 * `sortedEndMs[Math.floor(n * p)]` for p ∈ {0.5, 0.8, 0.95}. For very
 * small N (e.g. n=5), `floor(5 * 0.8) === floor(5 * 0.95) === 4` — the
 * top two percentiles collapse to the same array index, so their drift
 * is structurally zero and the tracker spuriously reports "stable" on
 * what's really sampling noise.
 *
 * Default `CONVERGENCE_CHECK_INTERVAL = 50` means production paths
 * always invoke this with N ≥ 50 (well above the threshold). The
 * guard exists so direct callers (tests, future tooling, weird
 * configurations) can't trip the collapse.
 */
export const MIN_N_FOR_CONVERGENCE = 20;

/**
 * Number of consecutive stable checks every tracker must hit before the
 * global decision flips to converged. At the default 50-iteration check
 * interval this corresponds to 200 consecutive iterations of stability
 * across every tracked diagnostic.
 */
export const CONVERGENCE_STABILITY_SAMPLES = 4;

/**
 * End-date percentile stability bar.
 *
 * Absolute floor: 6 hours — about the smallest delta a project manager
 * would notice in a finish-date forecast for a short-horizon project.
 *
 * Relative cap: 0.2% of the median project end (in hours from project
 * start). On a 16-year project (~140 000 h) that's ~280 h ≈ 12 days
 * of drift — about 0.2% of the project horizon and well below
 * user-perceptible precision on a multi-decade forecast.
 *
 * Calibration: at 0.05% the bar sat below Oncology's natural sampling
 * noise floor on the P50 / P80 / P95 stream (std-err of the median is
 * stdev/sqrt(N), which for a wide multi-year distribution at N≈2000
 * is ~100 h). The detector then never fires — see the iteration in
 * Phase 48 Slice 2's PR for the diagnostic dump.
 */
export const TIME_EPSILON_FLOOR_HOURS = 6;
export const TIME_EPSILON_RELATIVE = 0.002;

/**
 * Per-node P95 finish-time stability bar — `NODE_P95_EPSILON_MULTIPLIER`
 * times the end-date epsilon. The nodeP95 tracker reports the **max** drift
 * across all reportable nodes, which is a maximum-of-N statistic and
 * naturally noisier than the percentile stream's drift. Multiplying by
 * 2× keeps it consistent with the end-date bar's user-perceptible
 * precision while accommodating the max-across-nodes amplification.
 *
 * Calibration: the unscaled time eps left nodeP95 perma-unstable (drift
 * across ~80 Oncology nodes consistently exceeded the bar). With the 2×
 * multiplier nodeP95 converges alongside the other trackers within the
 * 1000-iter budget — see PR validation table.
 */
export const NODE_P95_EPSILON_MULTIPLIER = 2;

/**
 * Cost percentile, nodeCostStats, and cost-curve stability bars.
 *
 * Absolute floor: $100 — covers small / zero-cost projects.
 *
 * Relative cap: 0.5% of the median project cost. On a $500M Oncology
 * budget that's $2.5M ≈ small-program rounding; on a $200M Tentpole it's
 * $1M.
 */
export const COST_EPSILON_FLOOR = 100;
export const COST_EPSILON_RELATIVE = 0.005;

/**
 * Criticality-index stability bar — absolute drift in the fractional
 * critical-path frequency. 0.02 = 2 percentage points: tight enough to
 * catch a real shift in which nodes dominate the schedule, loose enough
 * that small-sample wobble in the early iterations doesn't keep the
 * detector permanently un-converged.
 */
export const CRITICALITY_EPSILON = 0.02;

// ── Stability tracker ────────────────────────────────────────────────────────

/**
 * Pure consecutive-stable counter. The caller owns the diagnostic state
 * (its "previous" snapshot) and the drift-vs-epsilon decision; the tracker
 * just accumulates / resets a counter.
 *
 * This split keeps the tracker uniform across the six diagnostic shapes
 * (scalar, fixed-length array, growable record) — each diagnostic uses
 * its own drift helper and feeds the boolean result here.
 */
export class StabilityTracker {
  /** Public so callers can read it (e.g. for tests / debug breakdowns). */
  consecutiveStable = 0;

  /**
   * Record one check's stable/not result. Stable → counter++; not stable
   * → counter reset to 0.
   */
  recordStable(stable: boolean): void {
    this.consecutiveStable = stable ? this.consecutiveStable + 1 : 0;
  }

  isStable(requiredSamples = CONVERGENCE_STABILITY_SAMPLES): boolean {
    return this.consecutiveStable >= requiredSamples;
  }
}

// ── Drift helpers ────────────────────────────────────────────────────────────

/**
 * Maximum absolute element-wise drift between two arrays of the same
 * length. Returns 0 when both arrays are empty. The caller must ensure
 * lengths match — a mismatch throws (would indicate a state-tracking
 * bug, not a runtime input error).
 */
export function maxAbsArrayDrift(curr: number[], prev: number[]): number {
  if (curr.length !== prev.length) {
    throw new Error(`maxAbsArrayDrift: length mismatch (${curr.length} vs ${prev.length})`);
  }
  let max = 0;
  for (let i = 0; i < curr.length; i++) {
    const d = Math.abs(curr[i]! - prev[i]!);
    if (d > max) max = d;
  }
  return max;
}

/**
 * Maximum absolute drift between two records keyed by the same set of
 * ids. Keys present in only one record contribute the value from that
 * record (treated as drift from 0 — equivalent to the missing side
 * being implicitly zero). This handles the case where a node's cost
 * heap only seeds on its first observation, so the record's key set
 * can grow across checks.
 */
export function maxAbsRecordDrift(
  curr: Record<string, number>,
  prev: Record<string, number>,
): number {
  let max = 0;
  for (const k of Object.keys(curr)) {
    const a = curr[k]!;
    const b = prev[k] ?? 0;
    const d = Math.abs(a - b);
    if (d > max) max = d;
  }
  // Keys present only in `prev` (a node that contributed once and never
  // again — rare but possible with degenerate iterations) also count.
  for (const k of Object.keys(prev)) {
    if (k in curr) continue;
    const d = Math.abs(prev[k]!);
    if (d > max) max = d;
  }
  return max;
}

// ── Epsilon resolution ───────────────────────────────────────────────────────

/**
 * Time-axis epsilon. Anchored on the median end-time-hours from the
 * first convergence check. Uses an absolute floor + a relative cap;
 * whichever is larger wins, so tiny projects don't have an
 * unreasonably-tight bar and huge projects don't have an unreasonably-
 * lax one.
 */
export function timeEpsilonHours(medianEndHours: number): number {
  return Math.max(TIME_EPSILON_FLOOR_HOURS, TIME_EPSILON_RELATIVE * medianEndHours);
}

/**
 * Cost-axis epsilon. Same floor / relative-cap shape as the time
 * epsilon, anchored on median project cost (dollars).
 */
export function costEpsilon(medianCost: number): number {
  return Math.max(COST_EPSILON_FLOOR, COST_EPSILON_RELATIVE * Math.abs(medianCost));
}

// ── Global decision ──────────────────────────────────────────────────────────

/**
 * The six trackers that drive the global decision. Names are stable and
 * intentionally read like field names — they're surfaced in test
 * assertions and could be exported as a debug breakdown later.
 */
export interface ConvergenceTrackers {
  endPercentiles: StabilityTracker;
  costPercentiles: StabilityTracker;
  criticality: StabilityTracker;
  nodeP95: StabilityTracker;
  nodeCostStats: StabilityTracker;
  costCurve: StabilityTracker;
}

export function makeTrackers(): ConvergenceTrackers {
  return {
    endPercentiles: new StabilityTracker(),
    costPercentiles: new StabilityTracker(),
    criticality: new StabilityTracker(),
    nodeP95: new StabilityTracker(),
    nodeCostStats: new StabilityTracker(),
    costCurve: new StabilityTracker(),
  };
}

/**
 * Global convergence decision: all six trackers must be stable for at
 * least `CONVERGENCE_STABILITY_SAMPLES` consecutive checks.
 */
export function allStable(
  t: ConvergenceTrackers,
  requiredSamples = CONVERGENCE_STABILITY_SAMPLES,
): boolean {
  return (
    t.endPercentiles.isStable(requiredSamples) &&
    t.costPercentiles.isStable(requiredSamples) &&
    t.criticality.isStable(requiredSamples) &&
    t.nodeP95.isStable(requiredSamples) &&
    t.nodeCostStats.isStable(requiredSamples) &&
    t.costCurve.isStable(requiredSamples)
  );
}

// ── Checkpoint runner ────────────────────────────────────────────────────────
//
// Phase 48 Slice 4b follow-up — extracted from the simulate() loop so that
// `assembleFromShards` can replay the same checks against merged shard data
// and produce a real `convergence.atIteration` for the parallel path. The
// `simulate()` inline call site is the canonical exec; this function is the
// same code lifted into a reusable shape. The Slice 1.5 fixture canary
// guarantees byte-identical simulate() output across the extraction.

/**
 * Mutable convergence state carried across checkpoints. Holds the six
 * trackers plus the previous-check snapshots that drive the drift
 * comparison, plus the once-frozen time/cost anchors that scale the
 * stability bars to project size.
 */
export interface ConvergenceState {
  trackers: ConvergenceTrackers;
  prevEndPctls: number[] | null;
  prevCostPctls: number[] | null;
  prevCriticality: Record<string, number> | null;
  prevNodeP95: Record<string, number> | null;
  prevNodeCostMean: Record<string, number> | null;
  prevCostCurve: number[] | null;
  timeAnchorHours: number | null;
  costAnchor: number | null;
}

export function makeConvergenceState(): ConvergenceState {
  return {
    trackers: makeTrackers(),
    prevEndPctls: null,
    prevCostPctls: null,
    prevCriticality: null,
    prevNodeP95: null,
    prevNodeCostMean: null,
    prevCostCurve: null,
    timeAnchorHours: null,
    costAnchor: null,
  };
}

/**
 * Inputs to one convergence check. All arrays must be the running-state
 * snapshots at the checkpoint — i.e. data accumulated from iters
 * `0 .. iter` (inclusive) for the currently-running simulate, or the
 * iter-ordered prefix sliced to the checkpoint's `nEnd` for replay in
 * `assembleFromShards`.
 *
 * `sortedEndMs` is assumed already sorted ascending. `projectCosts` and
 * the per-bucket / per-node sample arrays are sorted internally on each
 * call (cheap relative to the per-iter CPM cost simulate is amortising).
 */
export interface ConvergenceCheckInput {
  /** End-date epoch ms, sorted ascending; length == nEnd. */
  sortedEndMs: number[];
  /** Per-iter project costs (insertion order); sorted inside. Length == nEnd. */
  projectCosts: number[];
  /** Running critical-path counts per node. */
  criticalCount: Record<string, number>;
  /** Per-node earliestFinish samples (epoch ms). */
  finishMsPerNode: Map<string, number[]>;
  /** Per-node total cost samples. */
  costPerNode: Map<string, number[]>;
  /** Per-bucket cumulative-cost samples (length == COST_CURVE_BUCKETS). */
  costCurveBuckets: number[][];
  /**
   * Pre-filtered list of reportable node ids — i.e. `schedInput.nodes`
   * minus `start` / `end` anchors. Caller computes once before the
   * checkpoint loop to avoid re-filtering per check.
   */
  reportableNodeIds: ReadonlyArray<string>;
  /** Project start (epoch ms) — for end-pctl hours conversion. */
  projectStartMs: number;
}

/**
 * Run one convergence checkpoint. Mutates `state` (trackers, prev*
 * snapshots, anchors). Returns `true` if all six trackers are now stable
 * for at least `CONVERGENCE_STABILITY_SAMPLES` consecutive observations.
 *
 * Caller owns the trigger:
 *   - simulate() invokes when `(iter + 1) % CONVERGENCE_CHECK_INTERVAL === 0`
 *   - assembleFromShards invokes at every global multiple of
 *     `CONVERGENCE_CHECK_INTERVAL` up to the iter budget, slicing the
 *     per-iter arrays to the prefix length for that checkpoint
 *
 * Pre: `input.sortedEndMs.length > 0`. Callers must guard — an empty
 * checkpoint (all iters degenerate up to this point) is a no-op.
 */
export function performConvergenceCheck(
  state: ConvergenceState,
  input: ConvergenceCheckInput,
): boolean {
  const {
    sortedEndMs,
    projectCosts,
    criticalCount,
    finishMsPerNode,
    costPerNode,
    costCurveBuckets,
    reportableNodeIds,
    projectStartMs,
  } = input;
  const { trackers } = state;
  const nEnd = sortedEndMs.length;

  // Phase 50 Slice 21 / audit I-8 — small-N gate. The percentile
  // lookup below collapses for tiny N (top percentiles share an
  // index ⇒ structurally-zero drift ⇒ false stability). Skip the
  // checkpoint entirely until we have enough samples for the
  // percentile separation to be meaningful. Production callers
  // never hit this in practice (CONVERGENCE_CHECK_INTERVAL = 50).
  if (nEnd < MIN_N_FOR_CONVERGENCE) return false;

  // 1. End-date percentiles (epoch ms). Drift compared in hours.
  const endP50Ms = sortedEndMs[Math.min(Math.floor(nEnd * 0.5), nEnd - 1)]!;
  const endP80Ms = sortedEndMs[Math.min(Math.floor(nEnd * 0.8), nEnd - 1)]!;
  const endP95Ms = sortedEndMs[Math.min(Math.floor(nEnd * 0.95), nEnd - 1)]!;
  const endPctlsHours = [
    (endP50Ms - projectStartMs) / 3_600_000,
    (endP80Ms - projectStartMs) / 3_600_000,
    (endP95Ms - projectStartMs) / 3_600_000,
  ];

  // 2. Cost percentiles. Sort a snapshot of projectCosts for this check.
  const costsSorted = [...projectCosts].sort((a, b) => a - b);
  const nCost = costsSorted.length;
  const costPctls = [
    costsSorted[Math.min(Math.floor(nCost * 0.5), nCost - 1)] ?? 0,
    costsSorted[Math.min(Math.floor(nCost * 0.8), nCost - 1)] ?? 0,
    costsSorted[Math.min(Math.floor(nCost * 0.95), nCost - 1)] ?? 0,
  ];

  // 3. Criticality index (per reportable node, fraction of successful iters).
  const criticality: Record<string, number> = {};
  for (const id of reportableNodeIds) {
    criticality[id] = (criticalCount[id] ?? 0) / nEnd;
  }

  // 4. nodeP95 (per-node 95th-percentile finish, epoch ms → hours).
  const nodeP95Curr: Record<string, number> = {};
  for (const [nodeId, samples] of finishMsPerNode) {
    if (samples.length === 0) continue;
    const sorted = [...samples].sort((a, b) => a - b);
    const idx = sorted.length - Math.ceil(sorted.length * 0.05);
    nodeP95Curr[nodeId] = sorted[Math.max(0, idx)]! / 3_600_000;
  }

  // 5. nodeCostStats — per-node running mean.
  const nodeCostMeanCurr: Record<string, number> = {};
  for (const [nodeId, arr] of costPerNode) {
    if (arr.length === 0) continue;
    let sum = 0;
    for (const v of arr) sum += v;
    nodeCostMeanCurr[nodeId] = sum / arr.length;
  }

  // 6. Cost-curve P50 per bucket.
  const costCurveCurr: number[] = [];
  for (let b = 0; b < costCurveBuckets.length; b++) {
    const arr = costCurveBuckets[b]!;
    if (arr.length === 0) {
      costCurveCurr.push(0);
      continue;
    }
    const sorted = [...arr].sort((a, b) => a - b);
    costCurveCurr.push(sorted[Math.min(Math.floor(sorted.length * 0.5), sorted.length - 1)] ?? 0);
  }

  // Anchor on the first check and freeze for the rest of the run.
  if (state.timeAnchorHours === null) state.timeAnchorHours = endPctlsHours[0]!;
  if (state.costAnchor === null) state.costAnchor = costPctls[0]!;
  const timeEps = timeEpsilonHours(state.timeAnchorHours);
  const costEps = costEpsilon(state.costAnchor);

  // Record stable/not against the previous snapshots. First check seeds.
  if (state.prevEndPctls !== null) {
    trackers.endPercentiles.recordStable(
      maxAbsArrayDrift(endPctlsHours, state.prevEndPctls) <= timeEps,
    );
  }
  if (state.prevCostPctls !== null) {
    trackers.costPercentiles.recordStable(
      maxAbsArrayDrift(costPctls, state.prevCostPctls) <= costEps,
    );
  }
  if (state.prevCriticality !== null) {
    trackers.criticality.recordStable(
      maxAbsRecordDrift(criticality, state.prevCriticality) <= CRITICALITY_EPSILON,
    );
  }
  if (state.prevNodeP95 !== null) {
    trackers.nodeP95.recordStable(
      maxAbsRecordDrift(nodeP95Curr, state.prevNodeP95) <= timeEps * NODE_P95_EPSILON_MULTIPLIER,
    );
  }
  if (state.prevNodeCostMean !== null) {
    trackers.nodeCostStats.recordStable(
      maxAbsRecordDrift(nodeCostMeanCurr, state.prevNodeCostMean) <= costEps,
    );
  }
  if (state.prevCostCurve !== null) {
    trackers.costCurve.recordStable(
      maxAbsArrayDrift(costCurveCurr, state.prevCostCurve) <= costEps,
    );
  }

  state.prevEndPctls = endPctlsHours;
  state.prevCostPctls = costPctls;
  state.prevCriticality = criticality;
  state.prevNodeP95 = nodeP95Curr;
  state.prevNodeCostMean = nodeCostMeanCurr;
  state.prevCostCurve = costCurveCurr;

  return allStable(trackers, CONVERGENCE_STABILITY_SAMPLES);
}
