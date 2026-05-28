/**
 * Phase 48 Slice 4b — merge N `RawShardOutput`s and run the post-loop
 * assembly to produce a `SimulationResult`.
 *
 * Shards must be supplied in ascending `iterStart` order — the merged
 * `endDates` / `projectCosts` / `iterPrimaryKey` are concatenated in
 * shard order so the result matches what a single-thread `simulate()`
 * would have emitted iter-for-iter.
 *
 * Convergence in parallel mode is `{ converged: false, atIteration: null }`
 * by design. Per-shard convergence is meaningless (each shard sees only
 * its slice) and replaying it after the merge would need per-iter
 * critical-set data the shards don't currently carry. The app no longer
 * uses earlyStop (rollback in commit 21c3919), so convergence is purely
 * a diagnostic field and parallel callers accept this limitation.
 *
 * The post-loop assembly here is a deliberate copy of `simulate()`'s
 * post-loop block (index.ts lines ~1081–1330). The duplication trade-off
 * was approved in the Slice 4b planning conversation — see runShard.ts.
 */

import { spearmanCorrelation } from './spearman.js';
import { COST_CURVE_BUCKETS, type SimulationInput, type SimulationResult } from './index.js';
import type { RawShardOutput } from './runShard.js';
import {
  CONVERGENCE_CHECK_INTERVAL,
  makeConvergenceState,
  performConvergenceCheck,
} from './convergence.js';

const COST_TORNADO_EPSILON = 0.001;

/**
 * Per-iter arrays merged across shards in iter-ascending order. Does
 * NOT carry the per-shard convergence checkpoints or shardRange — those
 * stay on individual shards for the convergence replay below.
 */
type MergedShardData = Omit<RawShardOutput, 'shardRange' | 'convergenceCheckpoints'>;

/**
 * For a global checkpoint `K`, the shard's running contribution to the
 * global state. Three cases:
 *   - K past shard's iterEnd → use shard's final totals (post-loop state).
 *   - K within (iterStart, iterEnd] → use the snapshot at the largest
 *     `snapshot.iter ≤ K`. By construction snapshots fall at every
 *     multiple of CONVERGENCE_CHECK_INTERVAL within the range, so the
 *     "largest ≤ K" rule cleanly handles degenerate iters that left the
 *     running state unchanged.
 *   - K ≤ iterStart → shard hasn't run yet; contribute zero.
 */
function shardContributionAtCheckpoint(
  shard: RawShardOutput,
  globalK: number,
): { successCount: number; criticalCount: Record<string, number> } {
  if (globalK > shard.shardRange.iterEnd) {
    return {
      successCount: shard.endDateMs.length,
      criticalCount: shard.criticalCount,
    };
  }
  let best: { successCount: number; criticalCount: Record<string, number> } | null = null;
  for (const snap of shard.convergenceCheckpoints) {
    if (snap.iter > globalK) break;
    best = {
      successCount: snap.shardSuccessCount,
      criticalCount: snap.shardCriticalCount,
    };
  }
  if (best !== null) return best;
  return { successCount: 0, criticalCount: {} };
}

/** Merge raw shard outputs in submission (iter-ascending) order. */
function mergeShards(shards: ReadonlyArray<RawShardOutput>): MergedShardData {
  const merged: MergedShardData = {
    endDateMs: [],
    finishMsPerNode: new Map(),
    projectCosts: [],
    costPerNode: new Map(),
    costCurveBuckets: Array.from({ length: COST_CURVE_BUCKETS }, () => []),
    pathCounts: new Map(),
    iterPrimaryKey: [],
    criticalCount: {},
    nodeInputSamples: {},
    retainedFinishHours: [],
    retainedCosts: [],
  };

  for (const shard of shards) {
    for (const ms of shard.endDateMs) merged.endDateMs.push(ms);
    for (const c of shard.projectCosts) merged.projectCosts.push(c);
    for (const k of shard.iterPrimaryKey) merged.iterPrimaryKey.push(k);
    for (const h of shard.retainedFinishHours) merged.retainedFinishHours.push(h);
    for (const c of shard.retainedCosts) merged.retainedCosts.push(c);

    for (const [nodeId, samples] of shard.finishMsPerNode) {
      let arr = merged.finishMsPerNode.get(nodeId);
      if (arr === undefined) {
        arr = [];
        merged.finishMsPerNode.set(nodeId, arr);
      }
      for (const ms of samples) arr.push(ms);
    }

    for (const [nodeId, samples] of shard.costPerNode) {
      let arr = merged.costPerNode.get(nodeId);
      if (arr === undefined) {
        arr = [];
        merged.costPerNode.set(nodeId, arr);
      }
      for (const c of samples) arr.push(c);
    }

    for (let b = 0; b < COST_CURVE_BUCKETS; b++) {
      const src = shard.costCurveBuckets[b]!;
      const dst = merged.costCurveBuckets[b]!;
      for (const v of src) dst.push(v);
    }

    for (const [key, entry] of shard.pathCounts) {
      const existing = merged.pathCounts.get(key);
      if (existing) existing.count += entry.count;
      else merged.pathCounts.set(key, { path: entry.path, count: entry.count });
    }

    for (const [nodeId, count] of Object.entries(shard.criticalCount)) {
      merged.criticalCount[nodeId] = (merged.criticalCount[nodeId] ?? 0) + count;
    }

    for (const [nodeId, samples] of Object.entries(shard.nodeInputSamples)) {
      let arr = merged.nodeInputSamples[nodeId];
      if (arr === undefined) {
        arr = [];
        merged.nodeInputSamples[nodeId] = arr;
      }
      for (const v of samples) arr.push(v);
    }
  }

  return merged;
}

/**
 * Merge N shard outputs and run the post-loop assembly. The resulting
 * `SimulationResult` matches what a single-thread `simulate()` would
 * have produced for the same input, except for the convergence field
 * (always `{ converged: false, atIteration: null }`).
 */
export function assembleFromShards(
  input: SimulationInput,
  shards: ReadonlyArray<RawShardOutput>,
): SimulationResult {
  const schedInput = input.schedule;
  const excludedFromDistribution = new Set<string>(input.excludeNodeDistributions ?? []);

  const merged = mergeShards(shards);

  const endDates: Date[] = merged.endDateMs.map((ms) => new Date(ms));
  const projectCosts = merged.projectCosts;
  const criticalCount = merged.criticalCount;
  const finishMsPerNode = merged.finishMsPerNode;
  const costPerNode = merged.costPerNode;
  const costCurveBuckets = merged.costCurveBuckets;
  const pathCounts = merged.pathCounts;
  const iterPrimaryKey = merged.iterPrimaryKey;
  const nodeInputSamples = merged.nodeInputSamples;
  const retainedFinishHours = merged.retainedFinishHours;
  const retainedCosts = merged.retainedCosts;

  const projectStartMs = new Date(schedInput.project.startDate + 'T00:00:00').getTime();

  const subsystemContainerIds = new Set<string>(
    schedInput.subsystems?.map((s) => s.containerNodeId) ?? [],
  );

  const varianceBearingNodes = schedInput.nodes.filter(
    (n) =>
      n.distribution !== undefined &&
      n.nodeType !== 'start' &&
      n.nodeType !== 'end' &&
      n.nodeType !== 'subsystem',
  );
  // Stride-retained nodes need empty arrays even when no shard
  // contributed samples for them (e.g. degenerate runs) so the
  // sensitivity loop below can treat all variance-bearing ids uniformly.
  for (const n of varianceBearingNodes) {
    if (nodeInputSamples[n.id] === undefined) nodeInputSamples[n.id] = [];
  }

  const n = endDates.length;

  const sorted = [...endDates].sort((a, b) => a.getTime() - b.getTime());

  function pct(p: number): Date {
    const idx = Math.min(Math.floor(n * p), n - 1);
    return sorted[idx] ?? sorted[n - 1] ?? new Date(0);
  }

  const reportableNodes = schedInput.nodes.filter(
    (node) => node.nodeType !== 'start' && node.nodeType !== 'end',
  );
  const reportableNodeIds = reportableNodes.map((nd) => nd.id);

  const criticalityIndex: Record<string, number> = {};
  for (const node of reportableNodes) {
    criticalityIndex[node.id] = (criticalCount[node.id] ?? 0) / Math.max(1, n);
  }

  // Phase 48 Slice 4b follow-up — convergence replay. Walk every global
  // checkpoint, sum per-shard contributions for nEnd + criticalCount,
  // slice merged per-iter arrays to that prefix length, feed to the
  // shared `performConvergenceCheck` helper. Matches simulate()'s
  // single-thread result iter-for-iter; the only difference is when it
  // fires (after the parallel work merges, not during).
  const convergenceState = makeConvergenceState();
  let convergedAtIter: number | null = null;
  for (
    let K = CONVERGENCE_CHECK_INTERVAL;
    K <= input.iterations && convergedAtIter === null;
    K += CONVERGENCE_CHECK_INTERVAL
  ) {
    let nEndAtK = 0;
    const criticalCountAtK: Record<string, number> = {};
    for (const shard of shards) {
      const contrib = shardContributionAtCheckpoint(shard, K);
      nEndAtK += contrib.successCount;
      for (const [id, count] of Object.entries(contrib.criticalCount)) {
        criticalCountAtK[id] = (criticalCountAtK[id] ?? 0) + count;
      }
    }
    if (nEndAtK === 0) continue;

    // Slice merged per-iter arrays to the K-prefix. Per-node and per-
    // bucket arrays are length-nEnd-aligned with the global successful-
    // iter sequence (see runShard.ts), so the first nEndAtK entries
    // correspond exactly to "data through iter K".
    const sortedEndMsAtK = merged.endDateMs.slice(0, nEndAtK).sort((a, b) => a - b);
    const projectCostsAtK = merged.projectCosts.slice(0, nEndAtK);
    const finishMsPerNodeAtK = new Map<string, number[]>();
    for (const [id, arr] of finishMsPerNode) {
      finishMsPerNodeAtK.set(id, arr.slice(0, nEndAtK));
    }
    const costPerNodeAtK = new Map<string, number[]>();
    for (const [id, arr] of costPerNode) {
      costPerNodeAtK.set(id, arr.slice(0, nEndAtK));
    }
    const costCurveBucketsAtK = costCurveBuckets.map((bucket) => bucket.slice(0, nEndAtK));

    const hasConverged = performConvergenceCheck(convergenceState, {
      sortedEndMs: sortedEndMsAtK,
      projectCosts: projectCostsAtK,
      criticalCount: criticalCountAtK,
      finishMsPerNode: finishMsPerNodeAtK,
      costPerNode: costPerNodeAtK,
      costCurveBuckets: costCurveBucketsAtK,
      reportableNodeIds,
      projectStartMs,
    });
    if (hasConverged) convergedAtIter = K;
  }

  const tornado = reportableNodes
    .map((node) => {
      const ci = criticalityIndex[node.id] ?? 0;
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
                  return d.stddev * 4;
              }
            })()
          : 0;
      const decisionRange =
        node.nodeType === 'decision' && node.failureDelay ? node.failureDelay.value : 0;
      const range = distRange + decisionRange;
      return { nodeId: node.id, impactHours: range * ci };
    })
    .filter((t) => t.impactHours > 0.001)
    .sort((a, b) => b.impactHours - a.impactHours);

  const pathFrequency = [...pathCounts.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    const aKey = a.path.join(' ');
    const bKey = b.path.join(' ');
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });

  const pathIndexByKey = new Map<string, number>();
  for (let i = 0; i < pathFrequency.length; i++) {
    pathIndexByKey.set(JSON.stringify(pathFrequency[i]!.path), i);
  }
  const pathPerIteration: number[] = iterPrimaryKey.map((key) =>
    key === null ? -1 : (pathIndexByKey.get(key) ?? -1),
  );

  function topPctIdx(len: number): number {
    return Math.max(0, len - Math.ceil(len * 0.05));
  }
  function bottomPctIdx(len: number): number {
    return Math.max(0, Math.ceil(len * 0.05) - 1);
  }

  const nodeP95: Record<string, Date> = {};
  for (const node of reportableNodes) {
    const samples = finishMsPerNode.get(node.id);
    if (samples === undefined || samples.length === 0) continue;
    const sortedSamples = [...samples].sort((a, b) => a - b);
    nodeP95[node.id] = new Date(sortedSamples[topPctIdx(sortedSamples.length)]!);
  }

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

  const nodeCostStats: Record<string, { mean: number; p95: number }> = {};
  const nodeCostStatsSorted = new Map<string, number[]>();
  for (const [nodeId, arr] of costPerNode) {
    if (arr.length === 0) continue;
    let sum = 0;
    for (const v of arr) sum += v;
    const mean = sum / arr.length;
    const sortedArr = [...arr].sort((a, b) => a - b);
    nodeCostStatsSorted.set(nodeId, sortedArr);
    const p95 = sortedArr[topPctIdx(sortedArr.length)] ?? mean;
    nodeCostStats[nodeId] = { mean, p95 };
  }

  const costTornado = reportableNodes
    .filter((nd) => !subsystemContainerIds.has(nd.id))
    .map((nd) => {
      const s = nodeCostStatsSorted.get(nd.id);
      const p95 = s ? (s[topPctIdx(s.length)] ?? 0) : 0;
      const p5 = s ? (s[bottomPctIdx(s.length)] ?? 0) : 0;
      return { nodeId: nd.id, impactCost: p95 - p5 };
    })
    .filter((t) => t.impactCost > COST_TORNADO_EPSILON)
    .sort((a, b) => {
      if (b.impactCost !== a.impactCost) return b.impactCost - a.impactCost;
      return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
    });

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
    const sortedBucket = [...costCurveBuckets[b]!].sort((a, b) => a - b);
    curveP10.push(bucketPct(sortedBucket, 0.1));
    curveP50.push(bucketPct(sortedBucket, 0.5));
    curveP80.push(bucketPct(sortedBucket, 0.8));
    curveP95.push(bucketPct(sortedBucket, 0.95));
  }
  const costCurve = {
    times,
    p10: curveP10,
    p50: curveP50,
    p80: curveP80,
    p95: curveP95,
  };

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
