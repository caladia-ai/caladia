import * as prand from 'pure-rand';
import { prepareSchedule, scheduleFromPrepared } from '@procsim/scheduler';
import type { ScheduleInput } from '@procsim/scheduler';
import type { Distribution } from '@procsim/file-format';
import { spearmanCorrelation } from './spearman.js';
import {
  CONVERGENCE_CHECK_INTERVAL,
  makeConvergenceState,
  performConvergenceCheck,
} from './convergence.js';

// ── Public types ──────────────────────────────────────────────────────────────

export type { ScheduleInput };
export type RandomGenerator = prand.RandomGenerator;

export interface SimulationInput {
  schedule: ScheduleInput;
  /** Number of Monte Carlo iterations. Default 1000. */
  iterations: number;
  /** Root seed — same seed + same inputs = byte-identical results. */
  seed: number;
  /**
   * What-if override (Phase 16). When set, the named nodes use their
   * static `duration` (activity) / `passProbability` (decision) every
   * iteration instead of sampling from their `distribution`. The rest
   * of the simulation runs unchanged — same seed, same loops, same CPM.
   *
   * Used by the Risk Drivers "Show what-if without X" flow to answer
   * "how does the finish-date distribution shift if we collapse this
   * driver's variance to zero?"
   *
   * Excluding a node that has no distribution is a no-op.
   */
  excludeNodeDistributions?: ReadonlyArray<string>;
  /**
   * Phase 48 Slice 2 — opt into convergence-driven early stopping.
   *
   * When `true`, the engine stops iterating as soon as all six diagnostic
   * trackers (end-date / cost percentiles, criticality, nodeP95,
   * nodeCostStats, cost curve) have been stable for
   * `CONVERGENCE_STABILITY_SAMPLES` consecutive convergence checks. The
   * returned `endDates` / `projectCosts` / etc. arrays then have
   * `length === convergence.atIteration` (the actual K_ran), not
   * `iterations`. Bounded heaps (`nodeP95`, `nodeCostStats.p95`, cost
   * tornado) are resized at end-of-run so the percentile extractions
   * still match the K_ran iterations actually executed.
   *
   * When `false` (the default), the engine runs the full `iterations`
   * budget regardless of convergence. The `convergence.atIteration`
   * field is still populated for diagnostic purposes — it reports when
   * the run *would have* stopped under `earlyStop: true`.
   *
   * See packages/simulation/src/convergence.ts and ARCHITECTURE.md
   * "Multi-diagnostic convergence detection".
   */
  earlyStop?: boolean;
}

export interface SimulationResult {
  /** Raw project-end dates, one per successful iteration (length ≤ iterations). */
  endDates: Date[];
  percentiles: { p50: Date; p80: Date; p95: Date };
  /**
   * Fraction of iterations in which each node was on the critical path.
   * Range [0, 1]. Higher = more likely to be the bottleneck.
   */
  criticalityIndex: Record<string, number>;
  /**
   * Nodes sorted by schedule impact (sensitivity range × criticality).
   * Largest impact first.
   */
  tornado: Array<{ nodeId: string; impactHours: number }>;
  /**
   * Convergence diagnostic (Phase 16).
   *
   * Computed by sampling P50/P80/P95 every `CONVERGENCE_CHECK_INTERVAL`
   * iterations and counting how many consecutive samples kept all three
   * percentiles stable within `CONVERGENCE_STABILITY_EPSILON_HOURS`.
   * Once that count crosses `CONVERGENCE_STABILITY_SAMPLES` the run is
   * marked converged and `atIteration` is pinned to the iteration index
   * at which stability was first achieved. If stability is never reached
   * within the iteration budget, `converged: false, atIteration: null`.
   *
   * Deterministic for a fixed seed.
   */
  convergence: { converged: boolean; atIteration: number | null };
  /**
   * Critical-path frequency (Phase 16).
   *
   * Each iteration's CPM result may emit multiple parallel critical
   * paths (when independent chains share the same total float). For
   * every path we observe across all iterations we record an entry
   * with the ordered node list and the number of iterations in which
   * it appeared. Anchor nodes (start / end) are stripped from each
   * path before counting — they sit on every path that reaches them
   * and would otherwise dominate the dedupe key without adding signal.
   *
   * Sorted by `count` descending.
   */
  pathFrequency: Array<{ path: string[]; count: number }>;
  /**
   * Per-iteration "primary" critical-path index (Phase 20).
   *
   * For each successful iteration we pick a single canonical critical
   * path — the lexicographically-first one (by space-joined node-id
   * key) among that iteration's anchor-stripped `criticalPaths`. Its
   * post-sort index into `pathFrequency` is stored here. Length matches
   * `endDates`.
   *
   * Iterations whose only critical paths consist entirely of anchor
   * nodes (so nothing enters `pathFrequency`) store `-1`. The exporter
   * surfaces these as "—".
   *
   * NOTE: this is a *projection* of the iteration's critical paths to a
   * single primary path for human-readable per-row export. Aggregating
   * these indices does NOT reproduce `pathFrequency` counts when
   * iterations emit multiple parallel critical paths — `pathFrequency`
   * counts every path each iteration sees, while `pathPerIteration`
   * records only the chosen primary. The two outputs are deliberately
   * different views of the same data.
   *
   * Deterministic for a fixed seed.
   */
  pathPerIteration: number[];
  /**
   * Per-node P95 finish-time (Phase 16).
   *
   * For each non-anchor node we record the 95th-percentile of its
   * `earliestFinish` across all successful iterations, as an absolute
   * `Date`. The Gantt overlay uses this to draw a faded "tail" to the
   * right of each bar showing how much later the activity might
   * realistically finish.
   *
   * Stored as a Date (not an offset from project start) because the UI's
   * notion of project start can drift earlier than `project.startDate`
   * when a Start anchor's `anchorDate` predates it. Emitting absolute
   * dates lets consumers project onto whatever timeline they're rendering.
   *
   * Maintained as a per-node bounded min-heap (size ≈ iterations × 5%)
   * during the run so memory stays O(iterations × 5% × nodes) instead
   * of O(iterations × nodes). The heap's minimum after the run is
   * exactly the P95.
   *
   * Anchor nodes (start / end) are intentionally excluded — they're
   * zero-duration milestones whose P95 equals their P50 by construction.
   *
   * Deterministic for a fixed seed.
   */
  nodeP95: Record<string, Date>;

  // ── Phase 19 — Monte Carlo cost outputs ────────────────────────────────
  //
  // Slice 2 wires the deterministic cost engine (slice 1) into Monte Carlo.
  // Per iteration, the scheduler's `result.nodeCosts` / `projectCost` are
  // accumulated; per-node fixedCost distributions are sampled BEFORE the
  // schedule call from the same per-node sub-stream that drives duration
  // and bernoulli, with cost appended last (load-bearing — see
  // ARCHITECTURE.md "Per-node sub-stream draw order").
  //
  // All five fields are present for every run, including ones with no
  // cost data — in that case `projectCosts` is full of zeros, percentiles
  // are zero, stats are zero, the tornado is empty, and the curve is flat.

  /** Project cost per successful iteration. Length === endDates.length. */
  projectCosts: number[];
  /**
   * Cost percentiles across iterations. P10 is intentionally omitted
   * (the UI derives it from `projectCosts` when needed) to keep this
   * field aligned with `percentiles` (P50 / P80 / P95).
   */
  costPercentiles: { p50: number; p80: number; p95: number };
  /**
   * Per-node mean and P95 of `nodeCosts[id].total` across iterations.
   * Includes sub-system container ids (their cost is the rollup of body
   * costs — variance comes from the bodies). Excludes anchor nodes
   * (zero cost by construction).
   */
  nodeCostStats: Record<string, { mean: number; p95: number }>;
  /**
   * Cost tornado — nodes ranked by `impactCost = p95 − p5` of their
   * per-iteration `nodeCosts[id].total`. Sub-system containers are
   * excluded to avoid double-counting (their bodies already appear).
   * UI resolves names. Sorted by impactCost descending; ties broken by
   * `nodeId` lex ascending so output is deterministic for a fixed seed.
   */
  costTornado: Array<{ nodeId: string; impactCost: number }>;
  /**
   * Cumulative-cost S-curve.
   *
   * `times[i]` is `i / (BUCKETS − 1) × medianProjectEnd_hoursFromStart`
   * — the absolute hours-from-project-start axis anchored to the median
   * MC project end. (Each MC iteration normalises its own buckets to its
   * own projectEnd, so bucket `i` always represents "i/49 of the way
   * through this run." See ARCHITECTURE.md "Cost-curve bucketing
   * strategy.")
   *
   * `pXX[i]` is the XX-th percentile across iterations of cumulative
   * cost incurred by bucket `i`. Cost attribution model: each node's
   * full cost is attributed at its iteration `earliestFinish` (a v1
   * approximation — see ARCHITECTURE.md for the rationale).
   */
  costCurve: {
    times: number[];
    p10: number[];
    p50: number[];
    p80: number[];
    p95: number[];
  };
  /**
   * Phase 31 — per-iteration input samples for variance-bearing nodes.
   *
   * Each entry is a node id whose `distribution` (activity duration or
   * decision pass-probability) sampled per iteration. Activity samples
   * are the drawn duration in hours; decision samples are the drawn
   * `passProbability` ∈ [0, 1] BEFORE the bernoulli collapse (so the
   * continuous-input → ρ signal is preserved).
   *
   * Stride-capped at `SENSITIVITY_RETENTION_CAP` (10 000) per node. For
   * `iterations > cap` the stride is `Math.ceil(iterations / cap)` and
   * every node retains samples from the same subset of iteration indices.
   * The matching subsample of finish hours and project costs is used
   * when computing `finishSensitivity` and `costSensitivity`.
   *
   * Anchor nodes (start / end) and sub-system containers are excluded.
   * Nodes without a `distribution` get no entry — they have no variance
   * to correlate against.
   */
  nodeInputSamples: Record<string, number[]>;
  /**
   * Phase 31 Slice 2 — y-axis values for the sensitivity scatterplot.
   *
   * `sensitivityFinishHours[i]` is the project finish in hours-from-start
   * for the i-th stride-retained iteration; `sensitivityProjectCosts[i]`
   * is that same iteration's project cost. Both arrays are index-aligned
   * with every `nodeInputSamples[id]` (same retained-iteration subset),
   * so a scatterplot can plot `(nodeInputSamples[id][i], sensitivityFinishHours[i])`
   * directly. Same length as each per-node sample array.
   *
   * Cheaper to retain these once at the engine boundary than to ask
   * downstream code to reconstruct the stride alignment from `endDates` /
   * `projectCosts` (which contain every successful iteration, not just
   * the stride-retained ones).
   */
  sensitivityFinishHours: number[];
  sensitivityProjectCosts: number[];
  /**
   * Phase 31 — Spearman rank correlation ρ ∈ [-1, 1] between each
   * variance-bearing node's input samples and the project's finish
   * hours-from-start. High |ρ| means the node's distribution dominates
   * the finish-date variance monotonically. Captures non-linear
   * coupling that the range × criticality tornado misses.
   */
  finishSensitivity: Record<string, number>;
  /**
   * Phase 31 — Spearman rank correlation ρ ∈ [-1, 1] between each
   * variance-bearing node's input samples and the project's total cost.
   * Useful for cost-driven projects: a node whose duration distribution
   * drives heavy resource hours (and thus cost) will show high |ρ| here
   * even when its schedule impact is moderate.
   */
  costSensitivity: Record<string, number>;
}

// ── Phase 31 — Sensitivity sample retention cap ───────────────────────────────
// Per-node max retained input samples. Bounds memory at high iteration counts:
//   100k iters × 100 nodes × 8 bytes = 80 MB without the cap; 100k iters
//   stride-subsampled to 10k × 100 nodes × 8 bytes = 8 MB. Spearman ρ on
//   10k stride-subsampled samples is statistically indistinguishable from
//   ρ on the full set for typical project distributions.
//
// Documented in ARCHITECTURE.md under "Per-iteration sample retention for
// sensitivity analysis".
const SENSITIVITY_RETENTION_CAP = 10_000;

// ── Convergence detection constants ───────────────────────────────────────────
//
// Phase 48 Slice 2 — the legacy single-bar end-date-only detector was
// recalibrated and split into per-diagnostic stability trackers; the
// tunables (check interval, stability samples, per-axis epsilons) now
// live in ./convergence.ts. The MC loop imports them above.

// ── Phase 19 — Cost-curve constants ───────────────────────────────────────────

/**
 * Number of evenly-spaced time buckets used for the cost S-curve. 50 is the
 * sweet spot: smooth enough at typical day-to-quarter projection lengths,
 * cheap enough at 10k iterations (50 × 10k × 8 bytes ≈ 4MB) to keep the
 * engine memory budget honest.
 */
export const COST_CURVE_BUCKETS = 50;

/**
 * Minimum non-zero impactCost to include in the tornado. Mirrors the
 * date-tornado epsilon — entries below this threshold are dropped to keep
 * the chart focused on real drivers.
 */
export const COST_TORNADO_EPSILON = 0.001;

// ── Hierarchical seeding ──────────────────────────────────────────────────────

/**
 * Derive a deterministic per-node RNG sub-stream from the root seed and
 * the node's ID. Each node draws from its own independent stream so that
 * adding or removing a node never perturbs any other node's sample sequence.
 *
 * Algorithm: mix rootSeed with a character-by-character FNV-1a-style hash of
 * nodeId, then seed xoroshiro128+. The exact mixing function is load-bearing
 * (documented in ARCHITECTURE.md) — do not change without updating tests.
 */
export function nodeRng(rootSeed: number, nodeId: string): RandomGenerator {
  // 32-bit FNV-1a seeded with rootSeed
  let h = (rootSeed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < nodeId.length; i++) {
    h = Math.imul(h ^ nodeId.charCodeAt(i), 0x01000193) >>> 0;
  }
  // Second hash pass to improve avalanche
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b) >>> 0;
  h ^= h >>> 16;
  return prand.xoroshiro128plus(h);
}

// ── Uniform helper ────────────────────────────────────────────────────────────

/** Draw one uniform sample in [0, 1) and advance the generator. */
export function nextUniform(rng: RandomGenerator): [number, RandomGenerator] {
  // uniformIntDistribution(0, N-1) gives an integer; divide for [0,1)
  const [n, next] = prand.uniformIntDistribution(0, (1 << 30) - 1, rng);
  return [n / (1 << 30), next];
}

// ── Distribution samplers ─────────────────────────────────────────────────────

/**
 * Sample one value from a distribution. Returns [value, nextRng].
 * All samplers are pure (no mutation of the original rng reference).
 */
export function sampleDistribution(
  dist: Distribution,
  rng: RandomGenerator,
): [number, RandomGenerator] {
  switch (dist.type) {
    case 'triangular': {
      // Exact inverse-CDF for the triangular distribution.
      const { min, mode, max } = dist;
      const range = max - min;
      const [u, rng1] = nextUniform(rng);
      const fc = (mode - min) / range;
      const value =
        u < fc
          ? min + Math.sqrt(u * range * (mode - min))
          : max - Math.sqrt((1 - u) * range * (max - mode));
      return [value, rng1];
    }

    case 'pert-beta': {
      // PERT distribution approximated via Box-Muller normal:
      //   μ = (min + 4·mode + max) / 6
      //   σ = (max - min) / 6
      // Clamped to [min, max]. This is the standard PM approximation used
      // by most Monte Carlo tools (Crystal Ball, @Risk, Primavera Risk).
      const { min, mode, max } = dist;
      const mu = (min + 4 * mode + max) / 6;
      const sigma = (max - min) / 6;
      const [u1, rng1] = nextUniform(rng);
      const [u2, rng2] = nextUniform(rng1);
      const z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-15))) * Math.cos(2 * Math.PI * u2);
      return [Math.max(min, Math.min(max, mu + sigma * z)), rng2];
    }

    case 'normal': {
      // Box-Muller transform — exact for unbounded normal.
      const { mean, stddev } = dist;
      const [u1, rng1] = nextUniform(rng);
      const [u2, rng2] = nextUniform(rng1);
      const z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-15))) * Math.cos(2 * Math.PI * u2);
      return [mean + stddev * z, rng2];
    }
  }
}

// ── Monte Carlo engine ────────────────────────────────────────────────────────

/**
 * Optional progress callback.  Called every 50 iterations so the caller can
 * report partial progress without time-dependent logic in the engine itself.
 * `pct` ∈ (0, 1].  Not called for iterations < 50.
 *
 * The callback is an observer and does not affect the computation result.
 * Keeping `Date.now()` out of the engine ensures determinism; callers that
 * need wall-clock throttling should implement it inside the callback.
 */
export function simulate(
  input: SimulationInput,
  onProgress?: (pct: number) => void,
): SimulationResult {
  const { schedule: schedInput, iterations, seed } = input;

  // Phase 16 — what-if exclusion set. Nodes in this set skip distribution
  // sampling and use their static `duration` / `passProbability` instead.
  const excludedFromDistribution = new Set<string>(input.excludeNodeDistributions ?? []);

  // Pre-initialise per-node RNG streams. Each node owns a stream seeded by
  // nodeRng(seed, nodeId). Across iterations the stream advances sequentially,
  // meaning iteration i of node A is always the i-th draw from A's stream,
  // regardless of how many other nodes exist.
  const nodeStreams = new Map<string, RandomGenerator>();
  for (const node of schedInput.nodes) {
    nodeStreams.set(node.id, nodeRng(seed, node.id));
  }

  // Pre-initialise per-loop RNG streams for sampling expectedIterations.
  // Uses a dedicated sub-seed so loop draws are independent from node draws.
  const loopStreams = new Map<string, RandomGenerator>();
  for (const loop of schedInput.loops) {
    loopStreams.set(loop.id, nodeRng(seed, `__loop__${loop.id}`));
  }

  // Phase 19 — Pre-initialise per-node cost sub-streams. Each node draws
  // its `fixedCost.distribution` from a dedicated stream, independent of
  // the duration / bernoulli stream above. Without the split, adding a
  // cost distribution to a node would shift its duration / bernoulli
  // sequence by the cost draws' consumption, breaking the within-node
  // invariant ("adding cost never perturbs that node's existing duration
  // or bernoulli samples") for iterations beyond the first.
  //
  // The `cost:` prefix (SOH control character + literal "cost:")
  // can't appear in a user-typed node ID, so cost streams cannot collide
  // with any node's duration / bernoulli stream via a name that happens
  // to start with a similar literal.
  //
  // See ARCHITECTURE.md "Per-node sub-stream draw order".
  // Phase 29 — Per-resource hourly-rate sub-streams. Each resource whose
  // `hourlyRateDistribution` is set samples a fresh rate from a dedicated
  // stream every iteration, independent of every node stream above. The
  // `rate:` prefix (SOH control character + literal "rate:")
  // matches the `cost:` precedent — user-typed resource IDs cannot
  // contain SOH, so the streams cannot collide. Isolation invariants:
  //   - Adding a rate distribution to resource X never perturbs any node's
  //     duration / bernoulli / fixedCost samples (different parent keys);
  //   - Adding a rate distribution to resource X never perturbs resource
  //     Y's rate samples (each resource has its own stream).
  //
  // Streams are pre-allocated for every resource regardless of whether
  // `hourlyRateDistribution` is currently set so toggling the field on /
  // off doesn't shift the iteration sequence — the stream is keyed by
  // resource identity, not by field presence.
  //
  // See ARCHITECTURE.md "Per-resource sub-stream for hourly-rate uncertainty".
  const resourceRateStreams = new Map<string, RandomGenerator>();
  for (const resource of schedInput.resources) {
    resourceRateStreams.set(resource.id, nodeRng(seed, `rate:${resource.id}`));
  }

  const costStreams = new Map<string, RandomGenerator>();
  for (const node of schedInput.nodes) {
    costStreams.set(node.id, nodeRng(seed, `cost:${node.id}`));
  }

  const endDates: Date[] = [];
  const criticalCount: Record<string, number> = {};
  for (const node of schedInput.nodes) {
    criticalCount[node.id] = 0;
  }

  // Phase 16 — anchor-node IDs are stripped from critical paths before they
  // enter the frequency map. Same rationale as the criticality filter further
  // down: anchors sit on every path that reaches them and would otherwise
  // dominate the dedupe key without adding signal.
  const anchorNodeIds = new Set<string>(
    schedInput.nodes.filter((n) => n.nodeType === 'start' || n.nodeType === 'end').map((n) => n.id),
  );

  // Phase 16 — Streaming sorted end-date storage. We insert each successful
  // iteration's project-end (in milliseconds) into a sorted array so we can
  // pull P50/P80/P95 in O(1) for convergence checks without re-sorting every
  // time. Binary insert is O(N) per insert due to splice's memmove, which is
  // dominated by the underlying CPM cost per iteration so the overhead is
  // negligible in practice.
  const sortedEndMs: number[] = [];

  // Phase 48 Slice 2 — multi-diagnostic convergence state. Six per-
  // diagnostic stability trackers (see ./convergence.ts) replace the
  // legacy single-tracker end-date-only check. The state struct holds
  // the trackers + previous-check snapshots + once-frozen anchors;
  // `performConvergenceCheck` mutates it on each invocation.
  //
  // Slice 4b follow-up — the check logic was extracted into a reusable
  // helper so `assembleFromShards` can replay convergence on merged
  // shard data and report a real `convergence.atIteration` for the
  // parallel path too.
  const convergenceState = makeConvergenceState();
  let convergedAtIter: number | null = null;
  const reportableNodeIdsForConvergence = schedInput.nodes
    .filter((n) => n.nodeType !== 'start' && n.nodeType !== 'end')
    .map((n) => n.id);
  const earlyStopEnabled = input.earlyStop === true;

  // Phase 16 — per-path critical-path frequency. Keyed by `JSON.stringify(path)`
  // (after stripping anchor nodes) so semantically identical paths collapse to
  // a single entry regardless of how often we see them.
  const pathCounts = new Map<string, { path: string[]; count: number }>();

  // Phase 20 — per-iteration "primary" critical-path key. One entry per
  // successful iteration (push aligned with `endDates`). The chosen key is
  // the lexicographically-first (by space-joined node-id string) among that
  // iteration's anchor-stripped `criticalPaths`. Iterations whose only paths
  // are anchor-only push `null`, remapped to `-1` after sort.
  const iterPrimaryKey: Array<string | null> = [];

  // Phase 48 Slice 4 — per-node finish-time samples per iteration. Was a
  // bounded min-heap per node (capacity = ceil(iterations × 0.05)) in Phase
  // 16; switched to a raw array per node so Slice 4's parallel-worker
  // merge has the per-iter samples it needs to reconstruct the global
  // distribution. End-of-run percentile extraction sorts each array and
  // picks `len − ceil(0.05·len)` — algebraically identical to the heap's
  // K-th-largest peek (when K = ceil(0.05·len)), so post-run results are
  // byte-identical to the heap path.
  const finishMsPerNode = new Map<string, number[]>();
  for (const node of schedInput.nodes) {
    if (node.nodeType === 'start' || node.nodeType === 'end') continue;
    finishMsPerNode.set(node.id, []);
  }

  // ── Phase 19 — Monte Carlo cost trackers ───────────────────────────────
  //
  // Per-iteration project cost array (sorted at end-of-run for percentiles).
  const projectCosts: number[] = [];
  // Per-node raw cost samples per iteration (Phase 48 Slice 4 — was a
  // pair of bounded heaps for top-5% / bottom-5% in Phase 19). Stored
  // lazily — only nodes that appear in `outcome.result.nodeCosts` get an
  // entry, matching the pre-Slice-4 heap-creation pattern.
  const costPerNode = new Map<string, number[]>();
  // Cost-curve buckets: one cross-iteration array per bucket. Each iteration
  // pushes its cumulative cost at bucket `b` (normalized to that
  // iteration's projectEnd). After the run, each array is sorted to
  // extract percentiles.
  const costCurveBuckets: number[][] = Array.from({ length: COST_CURVE_BUCKETS }, () => []);
  // Sub-system container ids — excluded from the tornado to avoid
  // double-counting the bodies that already appear individually. Containers
  // remain in `nodeCostStats` (the inspector / panels surface their rollup).
  const subsystemContainerIds = new Set<string>(
    schedInput.subsystems?.map((s) => s.containerNodeId) ?? [],
  );
  // Project start in epoch ms for converting per-iteration finish times into
  // hours-from-start when filling the cost curve.
  const projectStartMs = new Date(schedInput.project.startDate + 'T00:00:00').getTime();

  // ── Phase 31 — Sensitivity-sample retention ────────────────────────────
  //
  // Per-iteration retention of the variance-bearing input variable for
  // each node with a `distribution`. Activities retain the sampled
  // duration in hours; decisions retain the sampled passProbability
  // (BEFORE bernoulli collapse). Anchor nodes and sub-system containers
  // are skipped — they have no distribution per schema.
  //
  // Memory: capped at SENSITIVITY_RETENTION_CAP samples per node.
  // For `iterations > cap` we stride-subsample at `ceil(iterations / cap)`
  // so every retained node aligns to the same iteration indices. The
  // matching subset of finish hours and project costs gets retained too
  // (so Spearman ρ is computed over a consistent sample alignment).
  //
  // See ARCHITECTURE.md "Per-iteration sample retention for sensitivity
  // analysis".
  const varianceBearingNodes = schedInput.nodes.filter(
    (n) =>
      n.distribution !== undefined &&
      n.nodeType !== 'start' &&
      n.nodeType !== 'end' &&
      n.nodeType !== 'subsystem',
  );
  const sensitivityStride = Math.max(1, Math.ceil(iterations / SENSITIVITY_RETENTION_CAP));
  const nodeInputSamples: Record<string, number[]> = {};
  for (const n of varianceBearingNodes) nodeInputSamples[n.id] = [];
  const retainedFinishHours: number[] = [];
  const retainedCosts: number[] = [];

  // Phase 48 Slice 3 — prepare iteration-invariant state once before the
  // MC loop. The prepared schedule carries the validated input, per-node
  // effective calendar resolution, and per-calendar working-time tables
  // (`PreparedCalendar`). Per-iter `scheduleFromPrepared` reuses all of
  // it; only the sampled scalars (`sampledNodes`, `sampledResources`,
  // `sampledLoopIterations`) change.
  const prepResult = prepareSchedule(schedInput);
  if (!prepResult.ok) {
    // Degenerate input — return an empty result rather than throwing,
    // matching the pre-Slice-3 behaviour where schedule() returned
    // { ok: false } and the loop's `if (!outcome.ok) continue` skipped
    // every iteration, eventually producing an empty result.
    // Fall through to the post-loop assembly with no `endDates` so all
    // downstream fields collapse to their empty / zero shapes.
  }
  const prepared = prepResult.ok ? prepResult.prepared : null;

  for (let iter = 0; iter < iterations; iter++) {
    // Phase 31 — per-iter input capture. Populated by the `sampledNodes`
    // map() below for variance-bearing nodes; flushed into the retained
    // arrays AFTER the schedule call succeeds (degenerate iterations
    // drop their samples to keep the per-node arrays aligned with finish
    // and cost).
    const iterInputs: Record<string, number> = {};
    const retainThisIter = iter % sensitivityStride === 0;
    // Sample per-node parameters — each node draws from its own independent
    // stream so adding/removing a node never perturbs another node's sequence.
    //
    // Activity / start / end: `distribution` (when present) drives duration.
    // Decision (Phase 11): `distribution` (when present) drives the *pass
    //   probability* — the sampled value is clamped to [0, 1] and used as `p`
    //   for that iteration's Bernoulli draw. This matches the UI's Distribution
    //   picker on decision nodes, which is labelled "Pass probability
    //   distribution". Without a distribution, the static `passProbability`
    //   field is used directly. The realised outcome is encoded as
    //   `passProbability ∈ {0, 1}` so the scheduler's effective-duration
    //   formula collapses to either `duration` (pass → no penalty) or
    //   `duration + failureDelay` (fail → full penalty).
    // Phase 48 Slice 3 — sample over the *post-flatten* node list. Before
    // Slice 3 `schedule()` ran `flattenSubsystems` per call and the raw
    // container nodes (which carry no cost / duration in their own right)
    // were silently stripped inside. `scheduleFromPrepared` trusts the
    // caller's `sampled.nodes` verbatim, so we must hand it a flattened
    // node set or container ids leak into `result.nodes` / `nodeP95` /
    // the cost-curve sweep. Falling back to `schedInput.nodes` when
    // prepare failed keeps the degenerate-input path tractable (the
    // sampling loop still draws from each per-node RNG stream, but the
    // loop body's `prepared === null` check below skips the schedule
    // call so the iteration silently fails).
    const sourceNodes = prepared !== null ? prepared.input.nodes : schedInput.nodes;
    const sampledNodes = sourceNodes.map((node) => {
      let next = node;
      let rng = nodeStreams.get(node.id)!;
      const skipDist = excludedFromDistribution.has(node.id);

      if (node.nodeType === 'decision') {
        let pIter = node.passProbability ?? 1;
        if (node.distribution && !skipDist) {
          const [sampled, rngAfter] = sampleDistribution(node.distribution, rng);
          rng = rngAfter;
          pIter = Math.max(0, Math.min(1, sampled));
          // Phase 31 — retain the sampled pass-probability (pre-bernoulli)
          // as this decision's sensitivity input. Skipping when no
          // distribution is set is correct: a static passProbability has
          // no variance to correlate against.
          if (retainThisIter) iterInputs[node.id] = pIter;
        }
        const [u, rngAfter] = nextUniform(rng);
        rng = rngAfter;
        next = { ...next, passProbability: u < pIter ? 1 : 0 };
      } else if (node.distribution && !skipDist) {
        const [sampled, rngAfter] = sampleDistribution(node.distribution, rng);
        rng = rngAfter;
        // The distribution's min / mode / max are in the SAME unit as
        // the activity's nominal `duration.unit` — templates author
        // them to match, and the schema doesn't carry an independent
        // unit on distributions. Preserve the unit so downstream
        // `nodeBaseHours` consumes the sample correctly.
        //
        // Pre-fix: this branch wrote `unit: 'hours'` unconditionally,
        // silently dividing day-authored samples by the days→hours
        // factor (e.g. a 10-day distribution sample became 10 hours =
        // 1.25 effort-days on the canonical 8h/day effort calendar),
        // causing MC P50 to read ~7-8× short of the deterministic CPM
        // project end. Floor at 1/60 of the source unit — small enough
        // to be benign in any reasonable unit, large enough to keep the
        // scheduler from collapsing the activity entirely.
        const safe = Math.max(1 / 60, sampled);
        next = {
          ...next,
          duration: { value: safe, unit: node.duration.unit },
        };
        // Phase 31 — retain the sampled duration as this activity's
        // sensitivity input. Stored in the source unit; Spearman
        // ranks are scale-invariant so the unit doesn't affect the
        // correlation.
        if (retainThisIter) iterInputs[node.id] = safe;
      }

      nodeStreams.set(node.id, rng);

      // Phase 19 — fixedCost.distribution draw from this node's DEDICATED
      // cost sub-stream. Independent of the duration / bernoulli stream
      // above so the per-node invariants hold across all iterations:
      //   - Adding a cost distribution never perturbs that node's existing
      //     duration / bernoulli samples (different streams, no shared
      //     consumption);
      //   - Removing a cost distribution doesn't perturb other nodes
      //     (each node has its own pair of sub-streams).
      //
      // Loop-body semantics: this draw fires ONCE per Monte Carlo
      // iteration. The deterministic cost pass then multiplies the sampled
      // value by the loop's sampled iteration count (or skips the
      // multiplier when `fixedCostOnce: true`). Matches user intent: "the
      // permit costs ~$5k per attempt and we attempt N times."
      if (node.fixedCost?.distribution && !skipDist) {
        const costRng = costStreams.get(node.id)!;
        const [sampledCost, costRngAfter] = sampleDistribution(
          node.fixedCost.distribution,
          costRng,
        );
        costStreams.set(node.id, costRngAfter);
        // Cost must be non-negative. Negative samples (possible for Normal
        // distributions centred near zero) clamp to 0 → "no cost this
        // iteration", which is a benign reading for the cost engine
        // (0 × any iteration multiplier === 0).
        const safeCost = Math.max(0, sampledCost);
        next = { ...next, fixedCost: { ...node.fixedCost, value: safeCost } };
      }

      return next;
    });

    // Sample iteration counts for each loop.
    // Each loop draws from its own stream so the sample sequence is stable.
    const sampledLoopIterations: Record<string, number> = {};
    for (const loop of schedInput.loops) {
      const rng = loopStreams.get(loop.id)!;
      const [raw, nextRng] = sampleDistribution(loop.expectedIterations, rng);
      loopStreams.set(loop.id, nextRng);
      sampledLoopIterations[loop.id] = Math.max(1, Math.round(raw));
    }

    // Phase 29 — Sample per-resource hourly rates for this iteration.
    // Each resource with `hourlyRateDistribution` draws ONCE per iteration
    // from its dedicated rate stream; the sampled value overrides
    // `costRate` in the per-iteration resources array passed to the
    // scheduler. The deterministic cost pass (packages/scheduler/cost.ts)
    // then reads the overridden rate via its existing `resource.costRate`
    // lookup — same code path, byte-equal for resources without a
    // distribution. Negative samples (possible for normal centred near
    // zero) clamp to 0; rate must be non-negative for the engine.
    const sampledResources = schedInput.resources.map((resource) => {
      if (!resource.hourlyRateDistribution) return resource;
      const rng = resourceRateStreams.get(resource.id)!;
      const [sampled, nextRng] = sampleDistribution(resource.hourlyRateDistribution, rng);
      resourceRateStreams.set(resource.id, nextRng);
      const safeRate = Math.max(0, sampled);
      return { ...resource, costRate: safeRate };
    });

    // Phase 48 Slice 3 — per-iter `scheduleFromPrepared` skips the
    // prepare side (validation + topology + calendar table build) since
    // that's iteration-invariant and was hoisted above the loop.
    if (prepared === null) continue;
    const outcome = scheduleFromPrepared(prepared, {
      nodes: sampledNodes,
      resources: sampledResources,
      sampledLoopIterations,
    });
    if (!outcome.ok) continue; // skip degenerate samples

    endDates.push(outcome.result.projectEnd);
    insertSorted(sortedEndMs, outcome.result.projectEnd.getTime());

    // Phase 31 — flush this iteration's variance-bearing input samples
    // into the retention arrays. Only stride-boundary iterations
    // contribute (when `retainThisIter` is true); the corresponding
    // finish-hours and project-cost values are captured here so all
    // arrays stay index-aligned for Spearman.
    //
    // When `excludedFromDistribution` (the Phase 16 what-if exclusion)
    // skips a variance-bearing node's draw, we fall back to its static
    // value as the captured sample. The fallback keeps the per-node
    // arrays length-aligned with finish/cost; the resulting input is
    // constant across iters and `spearmanCorrelation` collapses to 0
    // for a constant series, which is the right reading: an excluded
    // node contributes zero variance to anything.
    if (retainThisIter) {
      const finishHours = (outcome.result.projectEnd.getTime() - projectStartMs) / (1000 * 60 * 60);
      retainedFinishHours.push(finishHours);
      retainedCosts.push(outcome.result.projectCost);
      for (const node of varianceBearingNodes) {
        let v = iterInputs[node.id];
        if (v === undefined) {
          v = node.nodeType === 'decision' ? (node.passProbability ?? 1) : node.duration.value;
        }
        nodeInputSamples[node.id]!.push(v);
      }
    }

    for (const [nodeId, sched] of Object.entries(outcome.result.nodes)) {
      if (sched.onCriticalPath) {
        criticalCount[nodeId] = (criticalCount[nodeId] ?? 0) + 1;
      }
      // Phase 48 Slice 4 — append this iteration's finish time (epoch ms)
      // to the per-node sample array. Pre-Slice-4 used a bounded
      // min-heap so memory stayed O(iterations × 5% × nodes); the raw
      // array is O(iterations × nodes) but enables Slice 4's parallel-
      // shard merge and gives byte-identical percentile results after
      // a single end-of-run sort.
      const samples = finishMsPerNode.get(nodeId);
      if (samples !== undefined) {
        samples.push(sched.earliestFinish.getTime());
      }
    }

    // Phase 19 — accumulate per-iteration cost outputs.
    //
    // Project cost — one push per successful iteration; length matches
    // `endDates`. Sorted at end-of-run for percentile lookup.
    projectCosts.push(outcome.result.projectCost);

    // Per-node cost samples. Includes sub-system containers (whose costs
    // appear in `nodeCosts` via the slice-1 rollup) but excludes anchors,
    // which never have cost. Arrays are lazily created so we don't have
    // to pre-enumerate containers — they appear in `nodeCosts` the first
    // iteration any body node does. (Phase 48 Slice 4 — was a pair of
    // bounded heaps for P5 / P95 in Phase 19; switched to raw arrays for
    // the parallel-shard merge.)
    for (const [nodeId, nc] of Object.entries(outcome.result.nodeCosts)) {
      let arr = costPerNode.get(nodeId);
      if (arr === undefined) {
        arr = [];
        costPerNode.set(nodeId, arr);
      }
      arr.push(nc.total);
    }

    // Cost-curve buckets — per-iteration normalized S-curve fill.
    //
    // For each iteration we sort nodes by `earliestFinish` ascending,
    // sweep buckets, and accumulate cost as each node's finish crosses
    // each bucket boundary. Attribution: each node's *total* cost lands
    // at its `earliestFinish` (a v1 approximation — see ARCHITECTURE.md
    // "Cost-curve bucketing strategy").
    //
    // Bucket boundaries are normalized to THIS iteration's projectEnd, so
    // bucket b always represents "b/49 of the way through this run."
    // Cross-iteration percentile extraction produces the smoothed S-curve.
    {
      const iterEndHours = (outcome.result.projectEnd.getTime() - projectStartMs) / 3_600_000;
      const sortedFinishes: Array<{ cost: number; finishH: number }> = [];
      for (const [nodeId, sched] of Object.entries(outcome.result.nodes)) {
        const nc = outcome.result.nodeCosts[nodeId];
        if (nc === undefined) continue;
        const finishH = (sched.earliestFinish.getTime() - projectStartMs) / 3_600_000;
        sortedFinishes.push({ cost: nc.total, finishH });
      }
      sortedFinishes.sort((a, b) => a.finishH - b.finishH);

      let cumCost = 0;
      let nodeIdx = 0;
      for (let b = 0; b < COST_CURVE_BUCKETS; b++) {
        const bucketTime = iterEndHours === 0 ? 0 : (b / (COST_CURVE_BUCKETS - 1)) * iterEndHours;
        while (nodeIdx < sortedFinishes.length && sortedFinishes[nodeIdx]!.finishH <= bucketTime) {
          cumCost += sortedFinishes[nodeIdx]!.cost;
          nodeIdx++;
        }
        costCurveBuckets[b]!.push(cumCost);
      }
    }

    // Phase 16 — accumulate path-frequency counts. Strip anchors then
    // dedupe by stringified ordered node list.
    //
    // Phase 20 — alongside the count accumulation, pick this iteration's
    // canonical "primary" critical path: the lexicographically-first
    // (by space-joined node ids) among the anchor-stripped variants. Its
    // key is stashed in `iterPrimaryKey[i]` and remapped to a
    // `pathFrequency` index after the post-run sort. `null` records the
    // anchor-only case (becomes `-1`).
    let primaryKey: string | null = null;
    let primaryLexKey: string | null = null;
    for (const path of outcome.result.criticalPaths) {
      const trimmed = path.filter((id) => !anchorNodeIds.has(id));
      if (trimmed.length === 0) continue;
      const key = JSON.stringify(trimmed);
      const existing = pathCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        pathCounts.set(key, { path: trimmed, count: 1 });
      }
      const lexKey = trimmed.join(' ');
      if (primaryLexKey === null || lexKey < primaryLexKey) {
        primaryLexKey = lexKey;
        primaryKey = key;
      }
    }
    iterPrimaryKey.push(primaryKey);

    // Phase 48 Slice 2 — multi-diagnostic convergence check. Done every
    // CONVERGENCE_CHECK_INTERVAL iterations against snapshots of six
    // diagnostics whose stability matters for the public SimulationResult
    // shape. The check runs regardless of `earlyStop` — the diagnostic
    // value of `convergence.atIteration` is useful even on a full budget;
    // only breaking the loop is gated on `earlyStopEnabled`.
    if (convergedAtIter === null && (iter + 1) % CONVERGENCE_CHECK_INTERVAL === 0) {
      if (sortedEndMs.length > 0) {
        const hasConverged = performConvergenceCheck(convergenceState, {
          sortedEndMs,
          projectCosts,
          criticalCount,
          finishMsPerNode,
          costPerNode,
          costCurveBuckets,
          reportableNodeIds: reportableNodeIdsForConvergence,
          projectStartMs,
        });
        if (hasConverged) {
          convergedAtIter = iter + 1;
          if (earlyStopEnabled) {
            break;
          }
        }
      }
    }

    // Report progress every 50 iterations.  The callback decides whether to
    // emit a message (e.g. throttle to ~100 ms wall time) — no Date.now()
    // here so the engine stays deterministic.
    if (onProgress !== undefined && (iter + 1) % 50 === 0) {
      onProgress((iter + 1) / iterations);
    }
  }

  const n = endDates.length;

  // Phase 48 Slice 4 — the pre-Slice-4 heap-capacity correction for
  // earlyStop runs is no longer needed. The per-node sample arrays are
  // already sized to K_ran (= endDates.length), and the percentile
  // extractions below sort and index from the actual length, so an
  // early-stopped K_ran < iterations produces the same percentiles
  // it would have with a full run had it stopped at K_ran.

  // Sort ascending for percentile lookup
  const sorted = [...endDates].sort((a, b) => a.getTime() - b.getTime());

  function pct(p: number): Date {
    const idx = Math.min(Math.floor(n * p), n - 1);
    return sorted[idx] ?? sorted[n - 1] ?? new Date(0);
  }

  // Criticality / tornado deliberately exclude Start and End anchor nodes
  // (Phase 10 Tier 1). Anchors are zero-duration milestones that, by
  // construction, sit on every critical path that reaches them — reporting
  // them at 100% in the criticality chart and pinning them at the top of
  // the tornado is uninformative noise. Activities, decisions, and other
  // schedule-bearing nodes remain.
  const reportableNodes = schedInput.nodes.filter(
    (node) => node.nodeType !== 'start' && node.nodeType !== 'end',
  );

  const criticalityIndex: Record<string, number> = {};
  for (const node of reportableNodes) {
    criticalityIndex[node.id] = (criticalCount[node.id] ?? 0) / Math.max(1, n);
  }

  // Tornado: rank by sensitivity range × criticality index.
  // Nodes with no variance source (no distribution, no decision penalty) end
  // up with zero range and are filtered out below.
  const tornado = reportableNodes
    .map((node) => {
      const ci = criticalityIndex[node.id] ?? 0;
      // Phase 16 — what-if runs collapse the distribution for excluded
      // nodes to their nominal duration, so their `distRange` for this
      // run is effectively 0. Without this guard the tornado would still
      // rank the excluded node at the top despite contributing no
      // variance, which is the opposite of the user's intent.
      const distExcluded = excludedFromDistribution.has(node.id);
      const distRange =
        !distExcluded && node.distribution
          ? (() => {
              const d = node.distribution;
              switch (d.type) {
                case 'triangular':
                case 'pert-beta':
                  return d.max - d.min;
                case 'normal':
                  return d.stddev * 4; // ±2σ range
              }
            })()
          : 0;
      // Decision-node penalty range (Phase 11): the failure delay is the
      // ceiling of additional schedule cost contributed by this gate. We use
      // the raw delay value as a unit-agnostic range proxy — same scale as
      // distribution range for tornado-ranking purposes.
      const decisionRange =
        node.nodeType === 'decision' && node.failureDelay ? node.failureDelay.value : 0;
      const range = distRange + decisionRange;
      return { nodeId: node.id, impactHours: range * ci };
    })
    .filter((t) => t.impactHours > 0.001)
    .sort((a, b) => b.impactHours - a.impactHours);

  // Sort path frequencies by count descending. Ties broken by lexicographic
  // path order so the output is deterministic for a given seed.
  const pathFrequency = [...pathCounts.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    const aKey = a.path.join(' ');
    const bKey = b.path.join(' ');
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });

  // Phase 20 — remap per-iteration primary keys to their post-sort
  // `pathFrequency` indices. The dedupe key was `JSON.stringify(trimmed)`
  // when populating `pathCounts`; rebuild that same key from the sorted
  // entries so the map lookup is exact. Anchor-only iterations (recorded
  // as `null`) collapse to `-1`, the documented sentinel.
  const pathIndexByKey = new Map<string, number>();
  for (let i = 0; i < pathFrequency.length; i++) {
    pathIndexByKey.set(JSON.stringify(pathFrequency[i]!.path), i);
  }
  const pathPerIteration: number[] = iterPrimaryKey.map((key) =>
    key === null ? -1 : (pathIndexByKey.get(key) ?? -1),
  );

  // Phase 48 Slice 4 — per-node P95 from the raw sample arrays. Sort
  // ascending and pluck index `len − ceil(0.05·len)` — the heap's
  // K-th-largest peek (K = ceil(0.05·len)) in array form. Algebraically
  // equal to `floor(0.95·len)` for non-pathological lengths.
  //
  // Empty arrays are skipped so the consumer can guard on
  // `nodeP95[id] != null`.
  const nodeP95: Record<string, Date> = {};
  function topPctIdx(len: number): number {
    return Math.max(0, len - Math.ceil(len * 0.05));
  }
  function bottomPctIdx(len: number): number {
    return Math.max(0, Math.ceil(len * 0.05) - 1);
  }
  for (const node of reportableNodes) {
    const samples = finishMsPerNode.get(node.id);
    if (samples === undefined || samples.length === 0) continue;
    const sorted = [...samples].sort((a, b) => a - b);
    nodeP95[node.id] = new Date(sorted[topPctIdx(sorted.length)]!);
  }

  // ── Phase 19 — Assemble cost outputs ───────────────────────────────────

  // Cost percentiles across iterations. Sort a copy so the public
  // `projectCosts` field stays in insertion order (matches `endDates`).
  const sortedProjectCosts = [...projectCosts].sort((a, b) => a - b);
  function costPct(p: number): number {
    if (sortedProjectCosts.length === 0) return 0;
    const idx = Math.min(Math.floor(sortedProjectCosts.length * p), sortedProjectCosts.length - 1);
    return sortedProjectCosts[idx] ?? 0;
  }
  const costPercentiles = {
    p50: costPct(0.5),
    p80: costPct(0.8),
    p95: costPct(0.95),
  };

  // Phase 48 Slice 4 — per-node mean / P95 / P5 from the raw cost-sample
  // arrays. Sort each once; mean = sum/length; P95 = top heap-equivalent
  // index; P5 = bottom heap-equivalent index. Sub-system containers are
  // kept so the SubsystemPanel can surface their MC stats alongside the
  // deterministic rollup.
  //
  // `nodeCostStatsSorted` caches the sorted arrays so the cost-tornado
  // loop below doesn't re-sort them.
  const nodeCostStats: Record<string, { mean: number; p95: number }> = {};
  const nodeCostStatsSorted = new Map<string, number[]>();
  for (const [nodeId, arr] of costPerNode) {
    if (arr.length === 0) continue;
    let sum = 0;
    for (const v of arr) sum += v;
    const mean = sum / arr.length;
    const sorted = [...arr].sort((a, b) => a - b);
    nodeCostStatsSorted.set(nodeId, sorted);
    const p95 = sorted[topPctIdx(sorted.length)] ?? mean;
    nodeCostStats[nodeId] = { mean, p95 };
  }

  // Cost tornado — variance-bearing reportable nodes only. Sub-system
  // containers are excluded (their body nodes already appear; including
  // the container would double-count visually). `impactCost = p95 − p5`.
  const costTornado = reportableNodes
    .filter((n) => !subsystemContainerIds.has(n.id))
    .map((n) => {
      const sorted = nodeCostStatsSorted.get(n.id);
      const p95 = sorted ? (sorted[topPctIdx(sorted.length)] ?? 0) : 0;
      const p5 = sorted ? (sorted[bottomPctIdx(sorted.length)] ?? 0) : 0;
      return { nodeId: n.id, impactCost: p95 - p5 };
    })
    .filter((t) => t.impactCost > COST_TORNADO_EPSILON)
    .sort((a, b) => {
      if (b.impactCost !== a.impactCost) return b.impactCost - a.impactCost;
      return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
    });

  // Cost curve x-axis. Anchored to the median MC project end so users see
  // an absolute-time x-axis without paying for a separate deterministic
  // pre-run. Falls back to zero when there were no successful iterations
  // (degenerate / always-failing schedule).
  const sortedEndMsForCurve = endDates.map((d) => d.getTime()).sort((a, b) => a - b);
  const medianEndMs =
    sortedEndMsForCurve[Math.floor(sortedEndMsForCurve.length / 2)] ?? projectStartMs;
  const medianEndHours = Math.max(0, (medianEndMs - projectStartMs) / 3_600_000);
  const times = Array.from(
    { length: COST_CURVE_BUCKETS },
    (_, b) => (b / (COST_CURVE_BUCKETS - 1)) * medianEndHours,
  );
  function bucketPct(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const idx = Math.min(Math.floor(values.length * p), values.length - 1);
    return values[idx] ?? 0;
  }
  const curveP10: number[] = [];
  const curveP50: number[] = [];
  const curveP80: number[] = [];
  const curveP95: number[] = [];
  for (let b = 0; b < COST_CURVE_BUCKETS; b++) {
    const sorted = [...costCurveBuckets[b]!].sort((a, b) => a - b);
    curveP10.push(bucketPct(sorted, 0.1));
    curveP50.push(bucketPct(sorted, 0.5));
    curveP80.push(bucketPct(sorted, 0.8));
    curveP95.push(bucketPct(sorted, 0.95));
  }
  const costCurve = {
    times,
    p10: curveP10,
    p50: curveP50,
    p80: curveP80,
    p95: curveP95,
  };

  // ── Phase 31 — Compute sensitivity ρ per variance-bearing node ──────────
  //
  // Spearman ρ between each node's stride-subsampled input samples and
  // the matching subsample of finish hours and project costs. Returns 0
  // for nodes with < 2 samples or constant inputs (the utility handles
  // these edge cases). Cost ρ uses the matching `retainedCosts` array so
  // index alignment is preserved.
  const finishSensitivity: Record<string, number> = {};
  const costSensitivity: Record<string, number> = {};
  for (const node of varianceBearingNodes) {
    const samples = nodeInputSamples[node.id]!;
    finishSensitivity[node.id] = spearmanCorrelation(samples, retainedFinishHours);
    costSensitivity[node.id] = spearmanCorrelation(samples, retainedCosts);
  }

  return {
    endDates,
    percentiles: { p50: pct(0.5), p80: pct(0.8), p95: pct(0.95) },
    criticalityIndex,
    tornado,
    convergence: {
      converged: convergedAtIter !== null,
      atIteration: convergedAtIter,
    },
    pathFrequency,
    pathPerIteration,
    nodeP95,
    projectCosts,
    costPercentiles,
    nodeCostStats,
    costTornado,
    costCurve,
    nodeInputSamples,
    sensitivityFinishHours: retainedFinishHours,
    sensitivityProjectCosts: retainedCosts,
    finishSensitivity,
    costSensitivity,
  };
}

/**
 * Insert `value` into a number array kept sorted ascending. O(N) per insert
 * (binary search to find the position + splice). Used by the convergence
 * detector to maintain a running sorted view of project-end times without
 * re-sorting from scratch each iteration.
 */
function insertSorted(arr: number[], value: number): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, value);
}

// Phase 48 Slice 4 — `BoundedMinHeap` / `BoundedMaxHeap` were used in
// Phase 16 / 19 for streaming top-/bottom-K percentile extraction
// without retaining full per-iter sample arrays. Slice 4's parallel
// orchestrator needs raw per-iter arrays for the cross-shard merge to
// reconstruct the global distribution correctly (per-shard bounded
// heaps can't be merged to recover the true top-K of the union), so
// the heaps were dropped in favour of raw arrays + a one-shot end-of-
// run sort. See git history for the removed classes.

// ── Re-exports so consumers only need this package ────────────────────────────

export type { Distribution, ProjectFile } from '@procsim/file-format';

export { toJson, fromJson, SIM_EXPORT_VERSION } from './export.js';
export type { SimExport, SimExportInput, ParsedSimExport } from './export.js';

// Phase 48 Slice 4b — parallel MC engine surface. `runShard` runs a
// half-open iter slice with pre-advanced RNG streams; `assembleFromShards`
// merges N shard outputs and runs the post-loop aggregation. The app's
// `simulateParallel` orchestrator dispatches `runShard` calls across web
// workers and calls `assembleFromShards` on the main thread.
export { runShard, type RawShardOutput, type ShardOpts } from './runShard.js';
export { assembleFromShards } from './assembleFromShards.js';

// Phase 25 Slice 4 — chance-constrained greedy crasher.
export { chanceCrash } from './chance-crash.js';
export type { ChanceCrashOptions, ChanceCrashPlan } from './chance-crash.js';
