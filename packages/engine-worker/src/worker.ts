/**
 * Engine Web Worker — runs schedule() and simulate() off the main thread.
 *
 * Compiled with tsconfig.worker.json (lib: ES2022 + WebWorker) so that
 * `DedicatedWorkerGlobalScope` types are available and the DOM library does
 * not collide with the WebWorker library.
 *
 * Bundled separately from the main-thread package.  Consumers import it via
 * the `@procsim/engine-worker/worker` sub-path export.
 */

import { schedule } from '@procsim/scheduler';
import { simulate, chanceCrash, runShard } from '@procsim/simulation';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

// Jobs that have been cancelled before the worker could start them.
const cancelledIds = new Set<string>();

self.onmessage = (evt: MessageEvent<WorkerRequest>): void => {
  void handleMessage(evt.data);
};

async function handleMessage(msg: WorkerRequest): Promise<void> {
  // ── Cancel ────────────────────────────────────────────────────────────────
  if (msg.type === 'cancel') {
    cancelledIds.add(msg.id);
    return;
  }

  // ── Schedule ──────────────────────────────────────────────────────────────
  if (msg.type === 'schedule') {
    try {
      const outcome = schedule(msg.input);
      const response: WorkerResponse = { type: 'schedule_result', id: msg.id, outcome };
      self.postMessage(response);
    } catch (err) {
      const response: WorkerResponse = {
        type: 'error',
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(response);
    }
    return;
  }

  // ── Chance-crash (Phase 25 Slice 4) ──────────────────────────────────────
  if (msg.type === 'chance_crash') {
    if (cancelledIds.has(msg.id)) {
      cancelledIds.delete(msg.id);
      return;
    }
    try {
      // Build a signal whose `cancelled` flag flips when a `cancel` message
      // arrives for this job. The greedy polls this between steps; the
      // worker thread is single-threaded so the flip happens between
      // `mcP95` invocations once we re-enter the event loop. In practice
      // the worker runs `chanceCrash` synchronously below — meaning a
      // cancel that arrives mid-run won't fire until the current `simulate`
      // returns. That's good enough for typical MC budgets (~100 iters →
      // <100 ms wall-clock per step).
      const signal = { cancelled: false };
      const watchCancel = (): void => {
        // Re-check each microtask tick. The handler is only re-entered
        // when the main thread posts a `cancel` (handled by the early
        // `cancelledIds` mutation above); we then propagate to the signal.
        if (cancelledIds.has(msg.id)) {
          signal.cancelled = true;
          cancelledIds.delete(msg.id);
        }
      };
      let lastProgressMs = Date.now();
      const maxStepsHeuristic = msg.input.nodes.length * 10 + 10;

      const plan = await chanceCrash(
        msg.input,
        msg.deadline,
        { ...msg.opts, signal },
        (step, _p95) => {
          watchCancel();
          const now = Date.now();
          if (now - lastProgressMs >= 100) {
            lastProgressMs = now;
            const pct = Math.min(1, step / maxStepsHeuristic);
            const response: WorkerResponse = { type: 'progress', id: msg.id, pct };
            self.postMessage(response);
          }
        },
      );

      const response: WorkerResponse = {
        type: 'chance_crash_result',
        id: msg.id,
        plan,
      };
      self.postMessage(response);
    } catch (err) {
      const response: WorkerResponse = {
        type: 'error',
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(response);
    }
    return;
  }

  // ── Simulate shard (Phase 48 Slice 4b) ───────────────────────────────────
  if (msg.type === 'simulate_shard') {
    if (cancelledIds.has(msg.id)) {
      cancelledIds.delete(msg.id);
      return;
    }
    try {
      const raw = runShard(msg.input, {
        iterStart: msg.iterStart,
        iterEnd: msg.iterEnd,
        totalIterations: msg.totalIterations,
      });
      const response: WorkerResponse = { type: 'simulate_shard_result', id: msg.id, raw };
      self.postMessage(response);
    } catch (err) {
      const response: WorkerResponse = {
        type: 'error',
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(response);
    }
    return;
  }

  // ── Simulate ─────────────────────────────────────────────────────────────
  if (msg.type === 'simulate') {
    // Honour pre-flight cancellation.
    if (cancelledIds.has(msg.id)) {
      cancelledIds.delete(msg.id);
      return;
    }

    try {
      // Throttle progress messages to ≈100 ms wall-time intervals.
      // Date.now() lives here (worker code), not in the simulation engine,
      // so the engine computation stays deterministic.
      let lastProgressMs = Date.now();

      const result = simulate(msg.input, (pct) => {
        const now = Date.now();
        if (now - lastProgressMs >= 100) {
          lastProgressMs = now;
          const response: WorkerResponse = { type: 'progress', id: msg.id, pct };
          self.postMessage(response);
        }
      });

      const response: WorkerResponse = { type: 'simulate_result', id: msg.id, result };
      self.postMessage(response);
    } catch (err) {
      const response: WorkerResponse = {
        type: 'error',
        id: msg.id,
        message: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(response);
    }
  }
}
