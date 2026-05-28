/**
 * Tests for the main-thread client (`createEngineWorkerClient`).
 *
 * Audit I-30: covers cancellation (AbortSignal → cancel request + reject),
 * dispose (terminate + reject all + idempotent + isDead), error-path
 * (error response → reject; worker error event → mark dead + terminate +
 * onWorkerError callback), and the multi-job state machine (concurrent
 * jobs distinguished by id, progress events delivered to the right
 * callback, late messages for already-resolved jobs ignored).
 *
 * The worker side's throttling + cancelledIds drain is tested in
 * `worker.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEngineWorkerClient } from './index.js';
import type {
  EngineWorkerClient,
  ScheduleInput,
  ScheduleOutcome,
  SimulationInput,
  SimulationResult,
  ChanceCrashPlan,
  RawShardOutput,
  WorkerRequest,
  WorkerResponse,
} from './index.js';

// ── Mock Worker ───────────────────────────────────────────────────────────────

type WorkerListenerMap = {
  message: Array<(evt: { data: WorkerResponse }) => void>;
  error: Array<(evt: { message: string }) => void>;
};

// `Worker` is a DOM global; in vitest's node environment it's not defined.
// Stub it with our mock so `createEngineWorkerClient`'s `instanceof Worker`
// check succeeds and the passed instance is used directly (rather than
// trying to construct a fresh Worker from a URL).
vi.stubGlobal(
  'Worker',
  class WorkerStub {
    /* never constructed in tests — we always pass instances */
  },
);

class MockWorker extends (globalThis.Worker as unknown as { new (): object }) {
  readonly posted: WorkerRequest[] = [];
  terminated = false;
  private readonly listeners: WorkerListenerMap = { message: [], error: [] };

  addEventListener<K extends keyof WorkerListenerMap>(
    type: K,
    listener: WorkerListenerMap[K][number],
  ): void {
    (this.listeners[type] as Array<typeof listener>).push(listener);
  }

  postMessage(msg: WorkerRequest): void {
    this.posted.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  // Test helpers — drive the worker from the test side.
  _emit(response: WorkerResponse): void {
    for (const l of this.listeners.message) l({ data: response });
  }

  _fireError(evt: { message: string }): void {
    for (const l of this.listeners.error) l(evt);
  }
}

function makeClient(opts?: Parameters<typeof createEngineWorkerClient>[1]): {
  client: EngineWorkerClient;
  worker: MockWorker;
} {
  const worker = new MockWorker();
  const client = createEngineWorkerClient(worker as unknown as Worker, opts);
  return { client, worker };
}

// Minimal fixtures — we never actually run the engines from this file.
const SCHED_INPUT = {} as ScheduleInput;
const SIM_INPUT = {} as SimulationInput;
const SCHED_OUTCOME = { marker: 'schedule' } as unknown as ScheduleOutcome;
const SIM_RESULT = { marker: 'simulate' } as unknown as SimulationResult;
const CRASH_PLAN = { marker: 'crash' } as unknown as ChanceCrashPlan;
const SHARD_RAW = { marker: 'shard' } as unknown as RawShardOutput;

// ── Happy paths ───────────────────────────────────────────────────────────────

describe('createEngineWorkerClient — happy paths', () => {
  it('scheduleAsync posts a schedule request and resolves on schedule_result', async () => {
    const { client, worker } = makeClient();
    const promise = client.scheduleAsync(SCHED_INPUT);
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]).toMatchObject({ type: 'schedule', id: '0' });
    worker._emit({ type: 'schedule_result', id: '0', outcome: SCHED_OUTCOME });
    await expect(promise).resolves.toBe(SCHED_OUTCOME);
  });

  it('simulateAsync posts a simulate request and resolves on simulate_result', async () => {
    const { client, worker } = makeClient();
    const promise = client.simulateAsync(SIM_INPUT);
    expect(worker.posted[0]).toMatchObject({ type: 'simulate', id: '0' });
    worker._emit({ type: 'simulate_result', id: '0', result: SIM_RESULT });
    await expect(promise).resolves.toBe(SIM_RESULT);
  });

  it('chanceCrashAsync posts a chance_crash request and resolves on chance_crash_result', async () => {
    const { client, worker } = makeClient();
    const deadline = new Date('2026-12-31');
    const promise = client.chanceCrashAsync(SCHED_INPUT, deadline, {});
    expect(worker.posted[0]).toMatchObject({ type: 'chance_crash', id: '0', deadline });
    worker._emit({ type: 'chance_crash_result', id: '0', plan: CRASH_PLAN });
    await expect(promise).resolves.toBe(CRASH_PLAN);
  });

  it('simulateShardAsync posts a simulate_shard request and resolves on simulate_shard_result', async () => {
    const { client, worker } = makeClient();
    const promise = client.simulateShardAsync(SIM_INPUT, {
      iterStart: 0,
      iterEnd: 100,
      totalIterations: 200,
    });
    expect(worker.posted[0]).toMatchObject({
      type: 'simulate_shard',
      id: '0',
      iterStart: 0,
      iterEnd: 100,
      totalIterations: 200,
    });
    worker._emit({ type: 'simulate_shard_result', id: '0', raw: SHARD_RAW });
    await expect(promise).resolves.toBe(SHARD_RAW);
  });
});

// ── Multi-job state machine ───────────────────────────────────────────────────

describe('createEngineWorkerClient — multi-job state', () => {
  it('multiple concurrent jobs are distinguished by id', async () => {
    const { client, worker } = makeClient();
    const p1 = client.simulateAsync(SIM_INPUT);
    const p2 = client.simulateAsync(SIM_INPUT);
    const p3 = client.scheduleAsync(SCHED_INPUT);
    expect(worker.posted.map((m) => m.id)).toEqual(['0', '1', '2']);

    // Resolve out of order.
    worker._emit({
      type: 'simulate_result',
      id: '1',
      result: { tag: 'second' } as unknown as SimulationResult,
    });
    worker._emit({ type: 'schedule_result', id: '2', outcome: SCHED_OUTCOME });
    worker._emit({
      type: 'simulate_result',
      id: '0',
      result: { tag: 'first' } as unknown as SimulationResult,
    });

    await expect(p1).resolves.toMatchObject({ tag: 'first' });
    await expect(p2).resolves.toMatchObject({ tag: 'second' });
    await expect(p3).resolves.toBe(SCHED_OUTCOME);
  });

  it('progress events route to the right onProgress; other jobs unaffected', async () => {
    const { client, worker } = makeClient();
    const onProgress1 = vi.fn();
    const onProgress2 = vi.fn();
    const p1 = client.simulateAsync(SIM_INPUT, undefined, onProgress1);
    const p2 = client.simulateAsync(SIM_INPUT, undefined, onProgress2);

    worker._emit({ type: 'progress', id: '0', pct: 0.25 });
    worker._emit({ type: 'progress', id: '1', pct: 0.5 });
    worker._emit({ type: 'progress', id: '0', pct: 0.75 });

    expect(onProgress1).toHaveBeenCalledTimes(2);
    expect(onProgress1).toHaveBeenNthCalledWith(1, 0.25);
    expect(onProgress1).toHaveBeenNthCalledWith(2, 0.75);
    expect(onProgress2).toHaveBeenCalledTimes(1);
    expect(onProgress2).toHaveBeenCalledWith(0.5);

    // Jobs still pending — progress doesn't resolve.
    worker._emit({ type: 'simulate_result', id: '0', result: SIM_RESULT });
    worker._emit({ type: 'simulate_result', id: '1', result: SIM_RESULT });
    await Promise.all([p1, p2]);
  });

  it('late messages for already-resolved jobs are ignored', async () => {
    const { client, worker } = makeClient();
    const promise = client.simulateAsync(SIM_INPUT);
    worker._emit({ type: 'simulate_result', id: '0', result: SIM_RESULT });
    await expect(promise).resolves.toBe(SIM_RESULT);

    // Late progress / late result for id 0 — should not throw, just no-op.
    expect(() => worker._emit({ type: 'progress', id: '0', pct: 1 })).not.toThrow();
    expect(() =>
      worker._emit({ type: 'simulate_result', id: '0', result: SIM_RESULT }),
    ).not.toThrow();
  });

  it('error response rejects the right pending job; siblings unaffected', async () => {
    const { client, worker } = makeClient();
    const p1 = client.simulateAsync(SIM_INPUT);
    const p2 = client.simulateAsync(SIM_INPUT);
    worker._emit({ type: 'error', id: '0', message: 'engine blew up' });
    worker._emit({ type: 'simulate_result', id: '1', result: SIM_RESULT });
    await expect(p1).rejects.toThrow('engine blew up');
    await expect(p2).resolves.toBe(SIM_RESULT);
  });
});

// ── Cancellation via AbortSignal ──────────────────────────────────────────────

describe('createEngineWorkerClient — AbortSignal cancellation', () => {
  it('aborting a pending job posts a cancel request and rejects with signal.reason', async () => {
    const { client, worker } = makeClient();
    const ac = new AbortController();
    const promise = client.simulateAsync(SIM_INPUT, ac.signal);
    expect(worker.posted).toHaveLength(1);

    const reason = new Error('user cancelled');
    ac.abort(reason);

    await expect(promise).rejects.toBe(reason);
    expect(worker.posted).toHaveLength(2);
    expect(worker.posted[1]).toEqual({ type: 'cancel', id: '0' });
  });

  it('abort after the job already resolved is a no-op (no extra cancel posted)', async () => {
    const { client, worker } = makeClient();
    const ac = new AbortController();
    const promise = client.simulateAsync(SIM_INPUT, ac.signal);
    worker._emit({ type: 'simulate_result', id: '0', result: SIM_RESULT });
    await expect(promise).resolves.toBe(SIM_RESULT);

    ac.abort();
    // Original simulate post is the only message.
    expect(worker.posted).toHaveLength(1);
  });
});

// ── dispose() ─────────────────────────────────────────────────────────────────

describe('createEngineWorkerClient — dispose()', () => {
  it('dispose() terminates the worker and rejects all pending jobs', async () => {
    const { client, worker } = makeClient();
    const p1 = client.simulateAsync(SIM_INPUT);
    const p2 = client.scheduleAsync(SCHED_INPUT);

    client.dispose();

    expect(worker.terminated).toBe(true);
    expect(client.isDead()).toBe(true);
    await expect(p1).rejects.toThrow('EngineWorkerClient disposed');
    await expect(p2).rejects.toThrow('EngineWorkerClient disposed');
  });

  it('dispose() is idempotent (second call is a no-op)', () => {
    const { client, worker } = makeClient();
    client.dispose();
    expect(worker.terminated).toBe(true);
    client.dispose(); // should not throw, should not double-terminate logic
    expect(client.isDead()).toBe(true);
  });

  it('calls after dispose() reject synchronously without posting', async () => {
    const { client, worker } = makeClient();
    client.dispose();
    const before = worker.posted.length;
    await expect(client.simulateAsync(SIM_INPUT)).rejects.toThrow('dead');
    await expect(client.scheduleAsync(SCHED_INPUT)).rejects.toThrow('dead');
    expect(worker.posted.length).toBe(before);
  });
});

// ── Worker error event ────────────────────────────────────────────────────────

describe('createEngineWorkerClient — worker error event', () => {
  let onWorkerError: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    onWorkerError = vi.fn();
  });

  it('worker error marks dead, terminates, rejects pending, invokes callback', async () => {
    const { client, worker } = makeClient({ onWorkerError });
    const p1 = client.simulateAsync(SIM_INPUT);
    const p2 = client.scheduleAsync(SCHED_INPUT);

    worker._fireError({ message: 'worker exploded' });

    expect(client.isDead()).toBe(true);
    expect(worker.terminated).toBe(true);
    expect(onWorkerError).toHaveBeenCalledTimes(1);
    await expect(p1).rejects.toThrow(/worker exploded/);
    await expect(p2).rejects.toThrow(/worker exploded/);
  });

  it('calls after a worker error reject synchronously', async () => {
    const { client, worker } = makeClient({ onWorkerError });
    worker._fireError({ message: 'boom' });
    await expect(client.simulateAsync(SIM_INPUT)).rejects.toThrow('dead');
  });

  it('a buggy onWorkerError callback does not prevent death state', () => {
    const buggyCb = vi.fn(() => {
      throw new Error('callback bug');
    });
    const { client, worker } = makeClient({ onWorkerError: buggyCb });
    // Swallow the expected console.error from the wrap.
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    worker._fireError({ message: 'boom' });
    expect(buggyCb).toHaveBeenCalled();
    expect(client.isDead()).toBe(true);
    consoleErr.mockRestore();
  });

  it('a second error event after the first is ignored', () => {
    const { client, worker } = makeClient({ onWorkerError });
    worker._fireError({ message: 'first' });
    worker._fireError({ message: 'second' });
    expect(onWorkerError).toHaveBeenCalledTimes(1);
    expect(client.isDead()).toBe(true);
  });
});
