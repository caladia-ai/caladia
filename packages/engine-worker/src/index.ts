/**
 * Main-thread API for the persistent engine worker.
 *
 * Compiled with tsconfig.json (lib: ES2022 + DOM) so that the `Worker` and
 * `AbortSignal` browser APIs are available.
 *
 * Usage with Vite:
 *
 *   import EngineWorker from '@procsim/engine-worker/worker?worker';
 *   const client = createEngineWorkerClient(new EngineWorker());
 *
 * Usage with a URL (e.g. in tests or non-Vite environments):
 *
 *   const url = new URL('@procsim/engine-worker/worker', import.meta.url);
 *   const client = createEngineWorkerClient(url);
 */

import type { ScheduleOutcome } from '@procsim/scheduler';
import type {
  SimulationResult,
  ChanceCrashOptions,
  ChanceCrashPlan,
  RawShardOutput,
  ShardOpts,
} from '@procsim/simulation';
import type {
  ScheduleInput,
  SimulationInput,
  ChanceCrashOptionsWire,
  WorkerRequest,
  WorkerResponse,
} from './protocol.js';

export type {
  ScheduleInput,
  ScheduleOutcome,
  SimulationInput,
  SimulationResult,
  ChanceCrashOptions,
  ChanceCrashPlan,
  RawShardOutput,
  ShardOpts,
};
export type { WorkerRequest, WorkerResponse, ChanceCrashOptionsWire } from './protocol.js';

// ── Client interface ──────────────────────────────────────────────────────────

/** Persistent off-main-thread engine client. */
export interface EngineWorkerClient {
  /**
   * Run `schedule()` in the worker thread.
   * @param signal - Optional AbortSignal; rejects with `signal.reason` when aborted.
   */
  scheduleAsync(input: ScheduleInput, signal?: AbortSignal): Promise<ScheduleOutcome>;

  /**
   * Run `simulate()` in the worker thread.
   * @param signal     - Optional AbortSignal; rejects when aborted.
   * @param onProgress - Called with `pct ∈ (0, 1]` at ≈100 ms intervals.
   */
  simulateAsync(
    input: SimulationInput,
    signal?: AbortSignal,
    onProgress?: (pct: number) => void,
  ): Promise<SimulationResult>;

  /**
   * Phase 25 Slice 4 — run `chanceCrash()` in the worker thread. Returns
   * the resulting plan (or partial plan if `signal` aborts). Progress
   * events fire as the greedy advances; their `pct ∈ (0, 1]` is a
   * `step / cap` estimate (the worker doesn't know the true endpoint).
   */
  chanceCrashAsync(
    input: ScheduleInput,
    deadline: Date,
    opts: Partial<ChanceCrashOptionsWire>,
    signal?: AbortSignal,
    onProgress?: (pct: number) => void,
  ): Promise<ChanceCrashPlan>;

  /**
   * Phase 48 Slice 4b — run one MC shard in the worker thread. Returns
   * the raw per-iter arrays for `[iterStart, iterEnd)` slice of the
   * total iteration budget. Caller merges N shards via
   * `assembleFromShards` on the main thread.
   *
   * No `onProgress` — shards are short by design and the orchestrator
   * aggregates progress across shards.
   */
  simulateShardAsync(
    input: SimulationInput,
    opts: ShardOpts,
    signal?: AbortSignal,
  ): Promise<RawShardOutput>;

  /** Terminate the underlying Worker.  All pending promises are rejected. */
  dispose(): void;

  /**
   * Phase 50 Slice 8 / audit C-7 — true when the underlying Worker fired an
   * `error` event (or `dispose()` was called). Once dead, every async
   * method rejects synchronously rather than posting to a terminated
   * worker — callers should drop the reference and spawn a fresh client.
   */
  isDead(): boolean;
}

// ── Factory options ───────────────────────────────────────────────────────────

export interface EngineWorkerClientOptions {
  /**
   * Phase 50 Slice 8 / audit C-7 — called once if the underlying Worker
   * fires an `error` event. By the time this fires the worker has been
   * `terminate()`'d and all pending promises rejected; the client is
   * marked dead and future calls will reject.
   *
   * Typical use: null out a singleton, or remove from a pool, so the
   * next access lazily spawns a fresh worker. Without this callback,
   * a poisoned worker silently hangs every subsequent run in the tab.
   */
  onWorkerError?: (error: ErrorEvent) => void;
}

// ── Internal pending-job registry ─────────────────────────────────────────────

interface PendingJob {
  resolve: (value: ScheduleOutcome | SimulationResult | ChanceCrashPlan | RawShardOutput) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (pct: number) => void;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Wrap an existing `Worker` instance (or construct one from a URL) into an
 * `EngineWorkerClient`.
 *
 * Accepting a `Worker | string | URL` lets the caller decide how to bundle
 * the worker script.  Vite users pass `new EngineWorker()` (imported with
 * `?worker`); other bundlers or test environments can pass a URL string.
 */
export function createEngineWorkerClient(
  workerOrUrl: Worker | string | URL,
  options: EngineWorkerClientOptions = {},
): EngineWorkerClient {
  const worker: Worker =
    workerOrUrl instanceof Worker ? workerOrUrl : new Worker(workerOrUrl, { type: 'module' });

  const pending = new Map<string, PendingJob>();
  let nextId = 0;
  let dead = false;

  // ── Incoming messages from the worker ──────────────────────────────────────
  worker.addEventListener('message', (evt: MessageEvent<WorkerResponse>) => {
    const msg = evt.data;
    const job = pending.get(msg.id);
    if (!job) return;

    if (msg.type === 'progress') {
      job.onProgress?.(msg.pct);
      return; // job remains pending until result or error
    }

    pending.delete(msg.id);

    if (msg.type === 'schedule_result') {
      job.resolve(msg.outcome);
    } else if (msg.type === 'simulate_result') {
      job.resolve(msg.result);
    } else if (msg.type === 'chance_crash_result') {
      job.resolve(msg.plan);
    } else if (msg.type === 'simulate_shard_result') {
      job.resolve(msg.raw);
    } else if (msg.type === 'error') {
      job.reject(new Error(msg.message));
    }
  });

  worker.addEventListener('error', (evt: ErrorEvent) => {
    if (dead) return; // already handled (e.g. dispose() fired this)
    dead = true;
    const message = `EngineWorker unhandled error: ${evt.message}`;
    for (const job of pending.values()) {
      job.reject(new Error(message));
    }
    pending.clear();
    // Phase 50 Slice 8 / audit C-7 — terminate the dead worker so a
    // future caller can't accidentally postMessage to it (which would
    // silently never resolve). The owning singleton / pool nulls out
    // its reference via `onWorkerError` so the next access lazily
    // spawns a fresh client.
    try {
      worker.terminate();
    } catch {
      // Best-effort — some environments throw if terminate is called
      // on an already-terminated worker. Either way, we're done with it.
    }
    if (options.onWorkerError) {
      // Wrap in try/catch so a buggy callback can't prevent the death
      // state from being set or future calls from being rejected.
      try {
        options.onWorkerError(evt);
      } catch (err) {
        console.error('EngineWorker onWorkerError handler threw:', err);
      }
    }
  });

  function allocateId(): string {
    return String(nextId++);
  }

  /** Reject a fresh call when the worker is already dead. */
  function rejectIfDead<T>(): Promise<T> | null {
    if (!dead) return null;
    return Promise.reject(
      new Error('EngineWorkerClient is dead — spawn a fresh client via createEngineWorkerClient'),
    );
  }

  function registerAbort(id: string, signal: AbortSignal, reject: (r: unknown) => void): void {
    signal.addEventListener('abort', () => {
      if (!pending.has(id)) return; // already resolved
      pending.delete(id);
      const req: WorkerRequest = { type: 'cancel', id };
      worker.postMessage(req);
      reject(signal.reason);
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    scheduleAsync(input: ScheduleInput, signal?: AbortSignal): Promise<ScheduleOutcome> {
      const deadReject = rejectIfDead<ScheduleOutcome>();
      if (deadReject) return deadReject;
      const id = allocateId();
      return new Promise<ScheduleOutcome>((resolve, reject) => {
        pending.set(id, {
          resolve: resolve as PendingJob['resolve'],
          reject,
        });
        if (signal) registerAbort(id, signal, reject);
        const req: WorkerRequest = { type: 'schedule', id, input };
        worker.postMessage(req);
      });
    },

    simulateAsync(
      input: SimulationInput,
      signal?: AbortSignal,
      onProgress?: (pct: number) => void,
    ): Promise<SimulationResult> {
      const deadReject = rejectIfDead<SimulationResult>();
      if (deadReject) return deadReject;
      const id = allocateId();
      return new Promise<SimulationResult>((resolve, reject) => {
        pending.set(id, {
          resolve: resolve as PendingJob['resolve'],
          reject,
          ...(onProgress !== undefined ? { onProgress } : {}),
        });
        if (signal) registerAbort(id, signal, reject);
        const req: WorkerRequest = { type: 'simulate', id, input };
        worker.postMessage(req);
      });
    },

    chanceCrashAsync(
      input: ScheduleInput,
      deadline: Date,
      opts: Partial<ChanceCrashOptionsWire>,
      signal?: AbortSignal,
      onProgress?: (pct: number) => void,
    ): Promise<ChanceCrashPlan> {
      const deadReject = rejectIfDead<ChanceCrashPlan>();
      if (deadReject) return deadReject;
      const id = allocateId();
      return new Promise<ChanceCrashPlan>((resolve, reject) => {
        pending.set(id, {
          resolve: resolve as PendingJob['resolve'],
          reject,
          ...(onProgress !== undefined ? { onProgress } : {}),
        });
        if (signal) registerAbort(id, signal, reject);
        const req: WorkerRequest = {
          type: 'chance_crash',
          id,
          input,
          deadline,
          opts,
        };
        worker.postMessage(req);
      });
    },

    simulateShardAsync(
      input: SimulationInput,
      opts: ShardOpts,
      signal?: AbortSignal,
    ): Promise<RawShardOutput> {
      const deadReject = rejectIfDead<RawShardOutput>();
      if (deadReject) return deadReject;
      const id = allocateId();
      return new Promise<RawShardOutput>((resolve, reject) => {
        pending.set(id, {
          resolve: resolve as PendingJob['resolve'],
          reject,
        });
        if (signal) registerAbort(id, signal, reject);
        const req: WorkerRequest = {
          type: 'simulate_shard',
          id,
          input,
          iterStart: opts.iterStart,
          iterEnd: opts.iterEnd,
          totalIterations: opts.totalIterations,
        };
        worker.postMessage(req);
      });
    },

    dispose(): void {
      if (dead) return; // idempotent — already done by an earlier error event
      dead = true;
      try {
        worker.terminate();
      } catch {
        // ignore
      }
      const err = new Error('EngineWorkerClient disposed');
      for (const job of pending.values()) {
        job.reject(err);
      }
      pending.clear();
    },

    isDead(): boolean {
      return dead;
    },
  };
}
