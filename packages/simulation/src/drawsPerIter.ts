/**
 * Phase 48 Slice 4b — per-stream per-iter draw counts.
 *
 * The parallel shard runner pre-advances each per-stream RNG by
 * `iterStart × drawsPerIter[stream]` so shard k's stream starts exactly
 * where the equivalent iteration `k` of the single-thread `simulate()`
 * would have it. This module is the single source of truth for "how many
 * `nextUniform` draws does one iteration consume from each stream", and
 * is byte-equality-critical: get it wrong by one and shard k diverges
 * from `simulate()` at every iter ≥ `iterStart`.
 *
 * The per-distribution counts are derived from `sampleDistribution` in
 * index.ts:
 *   triangular  → 1 nextUniform (inverse CDF)
 *   pert-beta   → 2 nextUniform (Box-Muller for the normal underlying it)
 *   normal      → 2 nextUniform (Box-Muller)
 *
 * Per-stream usage in the iter loop body (index.ts lines ~661–773):
 *   nodeStream         (one per node id; pre-allocated for every node):
 *     - decision node: drawsPerSample(distribution if not excluded) + 1
 *       (the +1 is the bernoulli `nextUniform` that fires every iter
 *       regardless of distribution presence or exclusion)
 *     - other node:    drawsPerSample(distribution if not excluded)
 *     - subsystem container: 0 (post-flatten strip removes container
 *       from iteration; pre-allocation is dormant)
 *   costStream         (one per node id; pre-allocated for every node):
 *     - drawsPerSample(fixedCost.distribution if not excluded), else 0
 *   loopStream         (one per loop id):
 *     - drawsPerSample(loop.expectedIterations)
 *   resourceRateStream (one per resource id; pre-allocated for every
 *     resource):
 *     - drawsPerSample(hourlyRateDistribution) if set, else 0
 *
 * If you add a new distribution type to `DistributionSchema` or change
 * the draw count of an existing one, update `drawsPerSample` here in
 * lock-step or the parallel determinism canary will fail loudly.
 */

import type { Distribution } from '@procsim/file-format';
import type { ScheduleInput } from '@procsim/scheduler';

/** Number of `nextUniform` draws one sample from `dist` consumes. */
export function drawsPerSample(dist: Distribution | undefined): number {
  if (!dist) return 0;
  switch (dist.type) {
    case 'triangular':
      return 1;
    case 'pert-beta':
      return 2;
    case 'normal':
      return 2;
  }
}

export interface PerStreamDraws {
  /** Node id → draws per iter from the node's duration / bernoulli stream. */
  nodeStream: Map<string, number>;
  /** Node id → draws per iter from the node's cost sub-stream. */
  costStream: Map<string, number>;
  /** Loop id → draws per iter from the loop's expectedIterations stream. */
  loopStream: Map<string, number>;
  /** Resource id → draws per iter from the resource's hourly-rate stream. */
  resourceRateStream: Map<string, number>;
}

/**
 * Per-stream per-iter draw counts for `schedule`. `excludedNodeIds` is the
 * Phase 16 what-if exclusion set — excluded nodes skip their distribution
 * draw but still consume the bernoulli draw on the decision branch.
 */
export function computePerStreamDraws(
  schedule: ScheduleInput,
  excludedNodeIds: ReadonlySet<string>,
): PerStreamDraws {
  const nodeStream = new Map<string, number>();
  const costStream = new Map<string, number>();
  const loopStream = new Map<string, number>();
  const resourceRateStream = new Map<string, number>();

  for (const node of schedule.nodes) {
    const skipDist = excludedNodeIds.has(node.id);

    let nodeDraws: number;
    if (node.nodeType === 'decision') {
      const distDraws = node.distribution && !skipDist ? drawsPerSample(node.distribution) : 0;
      nodeDraws = distDraws + 1; // unconditional bernoulli
    } else if (node.distribution && !skipDist) {
      nodeDraws = drawsPerSample(node.distribution);
    } else {
      nodeDraws = 0;
    }
    nodeStream.set(node.id, nodeDraws);

    costStream.set(
      node.id,
      node.fixedCost?.distribution && !skipDist ? drawsPerSample(node.fixedCost.distribution) : 0,
    );
  }

  for (const loop of schedule.loops) {
    loopStream.set(loop.id, drawsPerSample(loop.expectedIterations));
  }

  for (const resource of schedule.resources) {
    resourceRateStream.set(
      resource.id,
      resource.hourlyRateDistribution ? drawsPerSample(resource.hourlyRateDistribution) : 0,
    );
  }

  return { nodeStream, costStream, loopStream, resourceRateStream };
}
