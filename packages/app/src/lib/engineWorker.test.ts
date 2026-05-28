/**
 * Phase 50 Slice 8 / audit C-7 — worker respawn on error.
 *
 * Layer 1: direct unit tests of `createEngineWorkerClient` confirming
 * the `onWorkerError` callback fires, the worker is terminated, the
 * client marks itself dead, and future calls reject.
 *
 * Layer 2: integration test of the app's singleton (`getEngineWorker`)
 * confirming a dead worker is replaced with a fresh one on next access.
 *
 * Layer 3: integration test of the pool (`getWorkers` / `prewarmWorkerPool`)
 * confirming dead workers are spliced out.
 *
 * Uses a `FakeWorker` (EventTarget subclass) so the tests don't need a
 * real browser Worker. Each test installs FakeWorker as `globalThis.Worker`
 * inside a `beforeEach` so the singleton / pool's `new Worker(...)` paths
 * resolve to a stub.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createEngineWorkerClient } from '@procsim/engine-worker';

// ── FakeWorker stub ──────────────────────────────────────────────────────────

class FakeWorker extends EventTarget {
  public terminateCount = 0;
  public posted: unknown[] = [];
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  terminate(): void {
    this.terminateCount++;
  }
  // For convenience in tests — synthesize an ErrorEvent and dispatch.
  fireError(message = 'simulated worker crash'): void {
    // ErrorEvent isn't on the Node global; build a partial that satisfies
    // the engine-worker handler's `evt.message` access. The handler only
    // reads `.message`, so a plain object suffices.
    const evt = new Event('error') as ErrorEvent;
    Object.defineProperty(evt, 'message', { value: message, writable: false });
    this.dispatchEvent(evt);
  }
}

// Install FakeWorker as the Worker global ONCE for the whole file. The
// `instanceof Worker` check inside `createEngineWorkerClient` requires
// Worker to be defined; without this stub, the direct tests fail at
// import time with "Worker is not defined". The singleton/pool tests
// further down install per-test `TrackingWorker` subclasses; those
// re-set the global within their own beforeEach.
beforeAll(() => {
  Object.defineProperty(globalThis, 'Worker', {
    value: FakeWorker,
    configurable: true,
    writable: true,
  });
});

// ── Layer 1: createEngineWorkerClient direct ──────────────────────────────────

describe('createEngineWorkerClient — worker death handling (audit C-7)', () => {
  it('marks isDead() true after the underlying Worker fires error', () => {
    const worker = new FakeWorker() as unknown as Worker;
    const client = createEngineWorkerClient(worker);
    expect(client.isDead()).toBe(false);
    (worker as unknown as FakeWorker).fireError();
    expect(client.isDead()).toBe(true);
  });

  it('terminates the dead worker', () => {
    const worker = new FakeWorker();
    const client = createEngineWorkerClient(worker as unknown as Worker);
    void client;
    worker.fireError();
    expect(worker.terminateCount).toBe(1);
  });

  it('fires onWorkerError callback once with the ErrorEvent', () => {
    const worker = new FakeWorker();
    const cb = vi.fn();
    const client = createEngineWorkerClient(worker as unknown as Worker, {
      onWorkerError: cb,
    });
    void client;
    worker.fireError('boom');
    expect(cb).toHaveBeenCalledTimes(1);
    // Fire a second error — handler should no-op (dead-flag short-circuit).
    worker.fireError('boom again');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('rejects pending jobs when the worker dies', async () => {
    const worker = new FakeWorker();
    const client = createEngineWorkerClient(worker as unknown as Worker);
    // Kick off a schedule; the worker will never message back. Then crash.
    const promise = client.scheduleAsync({
      project: {} as never,
      nodes: [],
      edges: [],
      resources: [],
      calendars: [],
      loops: [],
    });
    worker.fireError('mid-job crash');
    await expect(promise).rejects.toThrow(/mid-job crash/);
  });

  it('rejects fresh calls made after the worker dies', async () => {
    const worker = new FakeWorker();
    const client = createEngineWorkerClient(worker as unknown as Worker);
    worker.fireError();
    await expect(
      client.scheduleAsync({
        project: {} as never,
        nodes: [],
        edges: [],
        resources: [],
        calendars: [],
        loops: [],
      }),
    ).rejects.toThrow(/dead/);
  });

  it('dispose() is idempotent with a prior error', () => {
    const worker = new FakeWorker();
    const client = createEngineWorkerClient(worker as unknown as Worker);
    worker.fireError();
    expect(worker.terminateCount).toBe(1);
    client.dispose(); // should not re-terminate
    expect(worker.terminateCount).toBe(1);
  });
});

// ── Layer 2: singleton getEngineWorker ───────────────────────────────────────

describe('getEngineWorker singleton — respawns on death (audit C-7)', () => {
  // Track Worker instances created during a test so we can reach in and
  // fireError on the right one. Stored on the FakeWorker class itself so
  // it survives the vi.resetModules call we use to re-import the singleton.
  const created: FakeWorker[] = [];

  beforeEach(() => {
    created.length = 0;
    class TrackingWorker extends FakeWorker {
      constructor() {
        super();
        created.push(this);
      }
    }
    // Stub the global Worker constructor.
    Object.defineProperty(globalThis, 'Worker', {
      value: TrackingWorker,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    // Reset the singleton between tests (module state leaks across `it`).
    vi.resetModules();
    delete (globalThis as unknown as { Worker?: unknown }).Worker;
  });

  it('returns the same instance on repeated calls (no respawn without death)', async () => {
    const { getEngineWorker } = await import('../engineWorker.js');
    const c1 = getEngineWorker();
    const c2 = getEngineWorker();
    expect(c1).toBe(c2);
    expect(created).toHaveLength(1);
  });

  it('returns a NEW instance after the underlying Worker dies (the C-7 repro)', async () => {
    const { getEngineWorker } = await import('../engineWorker.js');
    const c1 = getEngineWorker();
    expect(created).toHaveLength(1);

    // Crash the first instance's worker — onWorkerError nulls _client.
    created[0]!.fireError();
    expect(c1.isDead()).toBe(true);

    // Next access should spawn fresh — different client, different Worker.
    const c2 = getEngineWorker();
    expect(c2).not.toBe(c1);
    expect(c2.isDead()).toBe(false);
    expect(created).toHaveLength(2);
  });
});

// ── Layer 3: workerPool ──────────────────────────────────────────────────────

describe('workerPool — removes dead workers (audit C-7)', () => {
  const created: FakeWorker[] = [];

  beforeEach(() => {
    created.length = 0;
    class TrackingWorker extends FakeWorker {
      constructor() {
        super();
        created.push(this);
      }
    }
    Object.defineProperty(globalThis, 'Worker', {
      value: TrackingWorker,
      configurable: true,
      writable: true,
    });
    // Force a deterministic hardwareConcurrency so the pool's growth is
    // bounded for the test.
    Object.defineProperty(globalThis.navigator ?? {}, 'hardwareConcurrency', {
      value: 5,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.resetModules();
    delete (globalThis as unknown as { Worker?: unknown }).Worker;
  });

  it('removes a dead worker from the pool so subsequent getWorkers spawns fresh', async () => {
    const { getWorkers, disposeWorkerPool } = await import('./workerPool.js');
    const pool1 = getWorkers(3);
    expect(pool1).toHaveLength(3);
    expect(created.length).toBeGreaterThanOrEqual(3);

    // Crash the first client's worker — onWorkerError splices it out of
    // the pool array.
    const firstClient = pool1[0]!;
    created[0]!.fireError();
    expect(firstClient.isDead()).toBe(true);

    // Next request rebuilds the pool to 3 with a fresh worker replacing
    // the dead one. The new pool no longer contains the dead client.
    const createdCountBefore = created.length;
    const pool2 = getWorkers(3);
    expect(pool2).toHaveLength(3);
    expect(pool2).not.toContain(firstClient);
    expect(created.length).toBe(createdCountBefore + 1);

    disposeWorkerPool();
  });
});
