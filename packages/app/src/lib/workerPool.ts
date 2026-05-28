/**
 * Phase 48 Slice 4b — pre-warmed pool of engine workers for parallel MC.
 *
 * Lives alongside `engineWorker.ts`'s single-purpose singleton (which
 * keeps serving `schedule`, `simulate`, and `chance_crash` — unchanged).
 * The pool is dedicated to `simulate_shard` dispatch from
 * `simulateParallel.ts`.
 *
 * Lifecycle:
 *   - Pre-warm `min(hardwareConcurrency - 1, 4)` workers on SimulateView
 *     mount (call `prewarmWorkerPool()`). Subsequent mounts find the
 *     pool already warm.
 *   - `getWorkers(n)` returns up to `n` workers, lazily growing the pool
 *     to a hard cap of `min(hardwareConcurrency - 1, 10)`.
 *   - Workers stay alive for the tab session (same module-singleton
 *     pattern as `engineWorker.ts`). `disposeWorkerPool()` exists for
 *     tests / teardown only.
 *
 * Counts come from the Slice 4 planning conversation (locked decisions
 * documented in the handoff). Adjust both `PREWARM_SIZE` and
 * `MAX_POOL_SIZE` here if those decisions revisit.
 */

import { createEngineWorkerClient, type EngineWorkerClient } from '@procsim/engine-worker';

const PREWARM_SIZE = 4;
const MAX_POOL_SIZE = 10;

const _pool: EngineWorkerClient[] = [];

function hardwareConcurrencyOr(fallback: number): number {
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
    return navigator.hardwareConcurrency;
  }
  return fallback;
}

function poolSizeCap(): number {
  return Math.min(MAX_POOL_SIZE, Math.max(1, hardwareConcurrencyOr(4) - 1));
}

function prewarmTarget(): number {
  return Math.min(PREWARM_SIZE, Math.max(1, hardwareConcurrencyOr(4) - 1));
}

function spawn(): EngineWorkerClient {
  // Use a closure-captured handle so the onWorkerError callback can locate
  // and splice this exact client out of `_pool` when its underlying Worker
  // dies (Phase 50 Slice 8 / audit C-7). Without removal, `getWorkers(n)`
  // would keep returning the poisoned client and every subsequent shard
  // dispatch would silently hang on it.
  let client: EngineWorkerClient | null = null;
  client = createEngineWorkerClient(
    new Worker(new URL('@procsim/engine-worker/worker', import.meta.url), { type: 'module' }),
    {
      onWorkerError: () => {
        if (!client) return;
        const idx = _pool.indexOf(client);
        if (idx !== -1) _pool.splice(idx, 1);
      },
    },
  );
  return client;
}

function ensurePoolSize(target: number): void {
  // Drop any clients whose underlying Worker has already died — they
  // can't be reused, and the next call needs a real worker count.
  for (let i = _pool.length - 1; i >= 0; i--) {
    if (_pool[i]!.isDead()) _pool.splice(i, 1);
  }
  while (_pool.length < target) _pool.push(spawn());
}

/**
 * Idempotent. Call on SimulateView mount so the first user click doesn't
 * pay the worker-spawn latency (cold spawn is ~10–50 ms per worker on
 * M-series, more on older HW).
 */
export function prewarmWorkerPool(): void {
  ensurePoolSize(prewarmTarget());
}

/**
 * Return up to `n` workers from the pool, growing it on demand (capped
 * at `MAX_POOL_SIZE` / `hardwareConcurrency - 1`).
 */
export function getWorkers(n: number): EngineWorkerClient[] {
  const target = Math.min(n, poolSizeCap());
  ensurePoolSize(target);
  return _pool.slice(0, target);
}

/** Test-only teardown. Production keeps the pool for the tab's lifetime. */
export function disposeWorkerPool(): void {
  for (const w of _pool) w.dispose();
  _pool.length = 0;
}
