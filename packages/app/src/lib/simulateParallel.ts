/**
 * Phase 48 Slice 4b — main-thread orchestrator for parallel MC.
 *
 * Shards the iter range across N workers from the pool, awaits each
 * shard's raw output, and calls `assembleFromShards` on the main thread
 * to produce the final `SimulationResult`.
 *
 * Output is byte-identical to `simulate(input)` for the same input and
 * seed, except the convergence field (parallel mode reports
 * `{ converged: false, atIteration: null }` by design — see
 * packages/simulation/src/assembleFromShards.ts).
 *
 * Worker count formula (locked in Slice 4 planning):
 *   clamp(max(1, ceil(nodes/15)), 1, min(hardwareConcurrency - 1, 10))
 *
 * Progress reporting: shards don't emit intra-shard progress (the
 * engine's runShard intentionally omits it — orchestrator owns the
 * aggregate). We emit `completedShards / totalShards` on each shard
 * completion. With 4–8 shards that's a chunky progress bar, but each
 * shard typically finishes in <2 s on M-series even at 10k iters, so
 * the bar still feels responsive.
 *
 * For iter budgets below `PARALLEL_FALLBACK_THRESHOLD`, the caller
 * should route to the single-worker `simulateAsync` path instead — small
 * runs don't benefit from parallel speedup and the single-thread path
 * still emits per-50-iter convergence diagnostics.
 */

import {
  assembleFromShards,
  type SimulationInput,
  type SimulationResult,
} from '@procsim/simulation';
import { getWorkers } from './workerPool.js';

/** Iters below this threshold should use the single-worker `simulateAsync` instead. */
export const PARALLEL_FALLBACK_THRESHOLD = 100;

const MAX_WORKER_COUNT = 10;

/**
 * Tiered minimum visible run duration. After the pool is warm a parallel
 * run on a small project can complete in <100 ms — too fast for the
 * progress bar to fill, so the UI snaps from the warm-up message straight
 * to results and the user can't tell anything happened. The orchestrator
 * paces `onProgress` so the displayed value never exceeds
 * `elapsed / floorMs`, and holds the resolve until elapsed reaches the
 * floor. Cancel and error paths skip the floor.
 *
 * Floor scales with the iter budget — bigger runs feel "more substantial"
 * and warrant a longer visible animation:
 *   iters ≥ 10 000 → 2 000 ms
 *   iters ≥  1 000 → 1 000 ms
 *   else           → no floor (per-shard progress emits as-is)
 */
function floorMsForIterations(iterations: number): number {
  if (iterations >= 10_000) return 2_000;
  if (iterations >= 1_000) return 1_000;
  return 0;
}

function hardwareConcurrencyOr(fallback: number): number {
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
    return navigator.hardwareConcurrency;
  }
  return fallback;
}

function computeWorkerCount(nodeCount: number): number {
  const cap = Math.min(MAX_WORKER_COUNT, Math.max(1, hardwareConcurrencyOr(4) - 1));
  return Math.min(cap, Math.max(1, Math.ceil(nodeCount / 15)));
}

/** Split [0, total) into `nShards` half-open ranges in iter-ascending order. */
function shardRanges(total: number, nShards: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const base = Math.floor(total / nShards);
  const extra = total - base * nShards;
  let cursor = 0;
  for (let i = 0; i < nShards; i++) {
    const size = base + (i < extra ? 1 : 0);
    ranges.push([cursor, cursor + size]);
    cursor += size;
  }
  return ranges;
}

export async function simulateParallel(
  input: SimulationInput,
  signal?: AbortSignal,
  onProgress?: (pct: number) => void,
): Promise<SimulationResult> {
  const n = computeWorkerCount(input.schedule.nodes.length);
  const ranges = shardRanges(input.iterations, n);
  const workers = getWorkers(n);
  const floorMs = floorMsForIterations(input.iterations);
  const startedAt = performance.now();
  let completed = 0;

  // No floor — preserve the original per-shard emission pattern (one
  // onProgress per shard completion). Cheap path for sub-1 000-iter
  // runs where the bar isn't a UX concern.
  if (floorMs === 0) {
    const shardPromises = ranges.map(([s, e], i) =>
      workers[i]!.simulateShardAsync(
        input,
        { iterStart: s, iterEnd: e, totalIterations: input.iterations },
        signal,
      ).then((raw) => {
        completed += 1;
        onProgress?.(completed / n);
        return raw;
      }),
    );
    const shards = await Promise.all(shardPromises);
    return assembleFromShards(input, shards);
  }

  // Floored path. Tick at 50 ms so the bar advances smoothly across the
  // floor even when real shards complete in tens of ms.
  // `min(realProgress, elapsed / floorMs)` keeps the displayed value
  // from outrunning the floor; once real work is faster than the floor
  // the bar is essentially time-driven for the first `floorMs` ms.
  const floorInterval = setInterval(() => {
    const elapsed = performance.now() - startedAt;
    const floor = Math.min(1, elapsed / floorMs);
    const real = completed / n;
    onProgress?.(Math.min(real, floor));
  }, 50);

  try {
    const shardPromises = ranges.map(([s, e], i) =>
      workers[i]!.simulateShardAsync(
        input,
        { iterStart: s, iterEnd: e, totalIterations: input.iterations },
        signal,
      ).then((raw) => {
        completed += 1;
        return raw;
      }),
    );

    const shards = await Promise.all(shardPromises);
    const result = assembleFromShards(input, shards);

    // Hold here until the floor catches up so the bar visibly fills.
    // Honour `signal` so a Cancel during the floor wait still aborts
    // — without this, the user's Cancel would no-op for up to `floorMs`
    // after the real work finishes.
    const elapsed = performance.now() - startedAt;
    if (elapsed < floorMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, floorMs - elapsed);
        if (signal) {
          const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
    onProgress?.(1);
    return result;
  } finally {
    clearInterval(floorInterval);
  }
}
