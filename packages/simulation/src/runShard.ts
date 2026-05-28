/**
 * Phase 48 Slice 4b — single-shard MC iter runner.
 *
 * `runShard` duplicates the iteration loop body of `simulate()` for a
 * half-open `[iterStart, iterEnd)` slice of the total iteration budget,
 * pre-advancing each per-stream RNG by `iterStart × drawsPerIter[stream]`
 * so the byte-equivalent global iter `k` produces the byte-equivalent
 * draw. The Slice 1.5 fixture canary still guards `simulate()` head-on;
 * a parallel-mode canary (`runShard.test.ts`) guards
 * `assembleFromShards(runShard(0..k) + runShard(k..N)) ===
 * simulate()` byte-for-byte (modulo convergence, which is a single-
 * thread-only diagnostic — see `assembleFromShards.ts`).
 *
 * Why a duplicate, not a refactor: the previous session's attempt to
 * extract a shared `runIters(...)` body out of `simulate()` failed the
 * Slice 1.5 canary on giants (Oncology / Tentpole) with drift in cost-
 * related fields. The duplication trade-off was approved with the
 * understanding that the ~700 LOC overlap is the price for keeping
 * `simulate()` byte-untouched.
 *
 * Convergence machinery (sortedEndMs, trackers, prev* snapshots,
 * earlyStop) is intentionally absent. Per-shard convergence is
 * meaningless (each shard sees only its slice) and the parallel-mode
 * result reports `convergence: { converged: false, atIteration: null }`
 * — see `assembleFromShards.ts`.
 *
 * Per-iter progress reporting is also absent — the orchestrator
 * aggregates progress across shards on the main thread.
 */

import { prepareSchedule, scheduleFromPrepared } from '@procsim/scheduler';
import {
  nodeRng,
  nextUniform,
  sampleDistribution,
  COST_CURVE_BUCKETS,
  type RandomGenerator,
  type SimulationInput,
} from './index.js';
import { computePerStreamDraws } from './drawsPerIter.js';
import { CONVERGENCE_CHECK_INTERVAL } from './convergence.js';

const SENSITIVITY_RETENTION_CAP = 10_000;

/**
 * Per-checkpoint shard state for convergence replay (Phase 48 Slice 4b
 * follow-up). One entry per global multiple of `CONVERGENCE_CHECK_INTERVAL`
 * that fell inside `(iterStart, iterEnd]`. assembleFromShards uses
 * these to reconstruct the per-checkpoint global `nEnd` and
 * `criticalCount`; merged per-iter arrays slice to that prefix length for
 * the rest of the diagnostic computation.
 */
export interface ShardConvergenceCheckpoint {
  /** Global iter index (1-based, matches simulate()'s `iter + 1`). */
  iter: number;
  /** Successful endDates accumulated *within this shard* at this point. */
  shardSuccessCount: number;
  /** Per-node critical-path counts accumulated *within this shard*. */
  shardCriticalCount: Record<string, number>;
}

/**
 * Per-iter raw arrays produced by one shard. All arrays are in iter-
 * order within the shard so the orchestrator can concat shards in
 * `iterStart`-ascending order to reconstruct the global iter sequence.
 */
export interface RawShardOutput {
  /** Project-end times in epoch ms; one per successful iter. */
  endDateMs: number[];
  /** Per-node earliestFinish samples in epoch ms; lazily populated to
   *  match `simulate()`'s pattern. Non-anchor nodes only. */
  finishMsPerNode: Map<string, number[]>;
  /** Project costs aligned with `endDateMs` (parallel arrays). */
  projectCosts: number[];
  /** Per-node total cost samples; lazily populated (includes containers). */
  costPerNode: Map<string, number[]>;
  /** One array per bucket (length = COST_CURVE_BUCKETS); each iter
   *  pushes its cumulative cost at the bucket boundary. */
  costCurveBuckets: number[][];
  /** Anchor-stripped critical paths keyed by JSON.stringify(path) →
   *  { path, count }. Counts sum across shards in assemble. */
  pathCounts: Map<string, { path: string[]; count: number }>;
  /** Per-iter primary critical-path key (lex-min anchor-stripped). One
   *  entry per successful iter; `null` for anchor-only iters. */
  iterPrimaryKey: Array<string | null>;
  /** Per-node count of critical-path appearances. Summed across shards. */
  criticalCount: Record<string, number>;
  /** Stride-retained per-node input samples (variance-bearing nodes). */
  nodeInputSamples: Record<string, number[]>;
  /** Stride-retained project finish hours; index-aligned with `nodeInputSamples`. */
  retainedFinishHours: number[];
  /** Stride-retained project costs; index-aligned with `nodeInputSamples`. */
  retainedCosts: number[];
  /** Half-open global iter range this shard covered. */
  shardRange: { iterStart: number; iterEnd: number };
  /** Per-checkpoint snapshots for convergence replay (Slice 4b follow-up). */
  convergenceCheckpoints: ShardConvergenceCheckpoint[];
}

export interface ShardOpts {
  /** Inclusive global iter index this shard starts at. */
  iterStart: number;
  /** Exclusive global iter index this shard stops at. */
  iterEnd: number;
  /** Total iteration budget across all shards. Drives sensitivity
   *  stride alignment so shards retain the same global iter indices a
   *  single-thread `simulate()` would have retained. */
  totalIterations: number;
}

/**
 * Allocate an empty shard output with cost-curve bucket arrays pre-
 * sized. Used both as the return value's skeleton and as the
 * degenerate-input fallback (prepareSchedule failed → empty shard).
 */
function emptyShardOutput(iterStart: number, iterEnd: number): RawShardOutput {
  return {
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
    shardRange: { iterStart, iterEnd },
    convergenceCheckpoints: [],
  };
}

/** Burn `n` uniform draws from `rng`, returning the advanced generator. */
function advanceBy(rng: RandomGenerator, n: number): RandomGenerator {
  let r = rng;
  for (let i = 0; i < n; i++) {
    [, r] = nextUniform(r);
  }
  return r;
}

/**
 * Run iterations `[iterStart, iterEnd)` of the Monte Carlo loop and
 * return the raw per-iter accumulators. The caller (`assembleFromShards`)
 * merges N shards' outputs and runs the post-loop aggregation.
 */
export function runShard(input: SimulationInput, opts: ShardOpts): RawShardOutput {
  const { schedule: schedInput, seed } = input;
  const { iterStart, iterEnd, totalIterations } = opts;

  if (iterEnd <= iterStart) return emptyShardOutput(iterStart, iterEnd);

  const excludedFromDistribution = new Set<string>(input.excludeNodeDistributions ?? []);

  // Per-stream draws per iter — used both to pre-advance to `iterStart`
  // and to confirm the loop body's draw pattern stays in sync. See
  // drawsPerIter.ts for the per-stream rules.
  const draws = computePerStreamDraws(schedInput, excludedFromDistribution);

  // Pre-allocate streams matching simulate()'s allocation order, then
  // advance each by `iterStart × drawsPerIter[id]` so iter k draws what
  // simulate()'s iter k would draw.
  const nodeStreams = new Map<string, RandomGenerator>();
  for (const node of schedInput.nodes) {
    const rng0 = nodeRng(seed, node.id);
    nodeStreams.set(node.id, advanceBy(rng0, iterStart * (draws.nodeStream.get(node.id) ?? 0)));
  }

  const loopStreams = new Map<string, RandomGenerator>();
  for (const loop of schedInput.loops) {
    const rng0 = nodeRng(seed, `__loop__${loop.id}`);
    loopStreams.set(loop.id, advanceBy(rng0, iterStart * (draws.loopStream.get(loop.id) ?? 0)));
  }

  // SOH () prefix matches simulate()'s literal — it's the
  // documented anti-collision marker on rate/cost stream names so
  // user-typed resource/node IDs can never seed the wrong stream. Must
  // stay byte-identical to simulate()'s string for nodeRng to derive
  // the same seed.
  const resourceRateStreams = new Map<string, RandomGenerator>();
  for (const resource of schedInput.resources) {
    const rng0 = nodeRng(seed, `rate:${resource.id}`);
    resourceRateStreams.set(
      resource.id,
      advanceBy(rng0, iterStart * (draws.resourceRateStream.get(resource.id) ?? 0)),
    );
  }

  const costStreams = new Map<string, RandomGenerator>();
  for (const node of schedInput.nodes) {
    const rng0 = nodeRng(seed, `cost:${node.id}`);
    costStreams.set(node.id, advanceBy(rng0, iterStart * (draws.costStream.get(node.id) ?? 0)));
  }

  // Raw accumulators — same shape as simulate()'s pre-loop state, minus
  // convergence machinery.
  const out = emptyShardOutput(iterStart, iterEnd);

  // Pre-init finish-time arrays for non-anchor nodes so the merge step
  // doesn't need to discover node ids lazily. Cost arrays stay lazy
  // (containers appear via `outcome.result.nodeCosts` rollup).
  for (const node of schedInput.nodes) {
    if (node.nodeType === 'start' || node.nodeType === 'end') continue;
    out.finishMsPerNode.set(node.id, []);
  }

  for (const node of schedInput.nodes) {
    out.criticalCount[node.id] = 0;
  }

  const anchorNodeIds = new Set<string>(
    schedInput.nodes.filter((n) => n.nodeType === 'start' || n.nodeType === 'end').map((n) => n.id),
  );

  const projectStartMs = new Date(schedInput.project.startDate + 'T00:00:00').getTime();

  // Phase 31 — sensitivity stride uses the GLOBAL iteration budget so
  // shards retain the same global indices a single-thread run would
  // have retained.
  const varianceBearingNodes = schedInput.nodes.filter(
    (n) =>
      n.distribution !== undefined &&
      n.nodeType !== 'start' &&
      n.nodeType !== 'end' &&
      n.nodeType !== 'subsystem',
  );
  const sensitivityStride = Math.max(1, Math.ceil(totalIterations / SENSITIVITY_RETENTION_CAP));
  for (const n of varianceBearingNodes) out.nodeInputSamples[n.id] = [];

  // Prepare once for this shard. Worker workers call prepareSchedule
  // per shard too — cheap relative to the iter loop (Slice 3 made it
  // amortised; per-shard duplication is marginal).
  const prepResult = prepareSchedule(schedInput);
  if (!prepResult.ok) return out; // degenerate input → empty shard
  const prepared = prepResult.prepared;

  for (let iter = iterStart; iter < iterEnd; iter++) {
    const iterInputs: Record<string, number> = {};
    const retainThisIter = iter % sensitivityStride === 0;

    const sampledNodes = prepared.input.nodes.map((node) => {
      let next = node;
      let rng = nodeStreams.get(node.id)!;
      const skipDist = excludedFromDistribution.has(node.id);

      if (node.nodeType === 'decision') {
        let pIter = node.passProbability ?? 1;
        if (node.distribution && !skipDist) {
          const [sampled, rngAfter] = sampleDistribution(node.distribution, rng);
          rng = rngAfter;
          pIter = Math.max(0, Math.min(1, sampled));
          if (retainThisIter) iterInputs[node.id] = pIter;
        }
        const [u, rngAfter] = nextUniform(rng);
        rng = rngAfter;
        next = { ...next, passProbability: u < pIter ? 1 : 0 };
      } else if (node.distribution && !skipDist) {
        const [sampled, rngAfter] = sampleDistribution(node.distribution, rng);
        rng = rngAfter;
        const safe = Math.max(1 / 60, sampled);
        next = {
          ...next,
          duration: { value: safe, unit: node.duration.unit },
        };
        if (retainThisIter) iterInputs[node.id] = safe;
      }

      nodeStreams.set(node.id, rng);

      if (node.fixedCost?.distribution && !skipDist) {
        const costRng = costStreams.get(node.id)!;
        const [sampledCost, costRngAfter] = sampleDistribution(
          node.fixedCost.distribution,
          costRng,
        );
        costStreams.set(node.id, costRngAfter);
        const safeCost = Math.max(0, sampledCost);
        next = { ...next, fixedCost: { ...node.fixedCost, value: safeCost } };
      }

      return next;
    });

    const sampledLoopIterations: Record<string, number> = {};
    for (const loop of schedInput.loops) {
      const rng = loopStreams.get(loop.id)!;
      const [raw, nextRng] = sampleDistribution(loop.expectedIterations, rng);
      loopStreams.set(loop.id, nextRng);
      sampledLoopIterations[loop.id] = Math.max(1, Math.round(raw));
    }

    const sampledResources = schedInput.resources.map((resource) => {
      if (!resource.hourlyRateDistribution) return resource;
      const rng = resourceRateStreams.get(resource.id)!;
      const [sampled, nextRng] = sampleDistribution(resource.hourlyRateDistribution, rng);
      resourceRateStreams.set(resource.id, nextRng);
      const safeRate = Math.max(0, sampled);
      return { ...resource, costRate: safeRate };
    });

    // Snapshot helper — fires AT every global checkpoint, regardless of
    // whether this iter was degenerate, so the merger can reconstruct
    // per-checkpoint state via "largest snapshot.iter ≤ K" lookup. For
    // a degenerate iter the snapshot just captures the unchanged
    // running state.
    const maybeSnapshot = (): void => {
      if ((iter + 1) % CONVERGENCE_CHECK_INTERVAL === 0) {
        out.convergenceCheckpoints.push({
          iter: iter + 1,
          shardSuccessCount: out.endDateMs.length,
          shardCriticalCount: { ...out.criticalCount },
        });
      }
    };

    const outcome = scheduleFromPrepared(prepared, {
      nodes: sampledNodes,
      resources: sampledResources,
      sampledLoopIterations,
    });
    if (!outcome.ok) {
      maybeSnapshot();
      continue;
    }

    out.endDateMs.push(outcome.result.projectEnd.getTime());

    if (retainThisIter) {
      const finishHours = (outcome.result.projectEnd.getTime() - projectStartMs) / (1000 * 60 * 60);
      out.retainedFinishHours.push(finishHours);
      out.retainedCosts.push(outcome.result.projectCost);
      for (const node of varianceBearingNodes) {
        let v = iterInputs[node.id];
        if (v === undefined) {
          v = node.nodeType === 'decision' ? (node.passProbability ?? 1) : node.duration.value;
        }
        out.nodeInputSamples[node.id]!.push(v);
      }
    }

    for (const [nodeId, sched] of Object.entries(outcome.result.nodes)) {
      if (sched.onCriticalPath) {
        out.criticalCount[nodeId] = (out.criticalCount[nodeId] ?? 0) + 1;
      }
      const samples = out.finishMsPerNode.get(nodeId);
      if (samples !== undefined) {
        samples.push(sched.earliestFinish.getTime());
      }
    }

    out.projectCosts.push(outcome.result.projectCost);

    for (const [nodeId, nc] of Object.entries(outcome.result.nodeCosts)) {
      let arr = out.costPerNode.get(nodeId);
      if (arr === undefined) {
        arr = [];
        out.costPerNode.set(nodeId, arr);
      }
      arr.push(nc.total);
    }

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
        out.costCurveBuckets[b]!.push(cumCost);
      }
    }

    let primaryKey: string | null = null;
    let primaryLexKey: string | null = null;
    for (const path of outcome.result.criticalPaths) {
      const trimmed = path.filter((id) => !anchorNodeIds.has(id));
      if (trimmed.length === 0) continue;
      const key = JSON.stringify(trimmed);
      const existing = out.pathCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        out.pathCounts.set(key, { path: trimmed, count: 1 });
      }
      const lexKey = trimmed.join(' ');
      if (primaryLexKey === null || lexKey < primaryLexKey) {
        primaryLexKey = lexKey;
        primaryKey = key;
      }
    }
    out.iterPrimaryKey.push(primaryKey);

    maybeSnapshot();
  }

  return out;
}
