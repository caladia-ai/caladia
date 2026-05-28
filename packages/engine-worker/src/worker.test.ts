/**
 * Tests for the worker-thread message handler (`worker.ts`).
 *
 * Audit I-30: covers each request type's happy path, the engine-throws
 * error-path, pre-flight cancellation via `cancelledIds`, and progress
 * throttling for the simulate handler (~100 ms wall-time interval).
 *
 * Strategy:
 *   - `vi.mock` the engine imports so we test the message machinery, not
 *     the engines themselves.
 *   - `vi.hoisted` to stub `globalThis.self` BEFORE the module loads
 *     (worker.ts assigns to `self.onmessage` at module top-level).
 *   - Drive the handler by invoking the captured `self.onmessage` with
 *     a fake `MessageEvent`, then assert on `self.postMessage`'s calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ScheduleOutcome,
  SimulationResult,
  ChanceCrashPlan,
  RawShardOutput,
  WorkerRequest,
  WorkerResponse,
} from './protocol.js';

// ── Pre-import setup ──────────────────────────────────────────────────────────

const { postMessage, getSelf, schedule, simulate, chanceCrash, runShard } = vi.hoisted(() => {
  const postMessage = vi.fn<(msg: WorkerResponse) => void>();
  const selfStub: {
    onmessage: ((evt: { data: WorkerRequest }) => void) | null;
    postMessage: typeof postMessage;
  } = {
    onmessage: null,
    postMessage,
  };
  (globalThis as { self?: unknown }).self = selfStub;

  return {
    postMessage,
    getSelf: () => selfStub,
    schedule: vi.fn(),
    simulate: vi.fn(),
    chanceCrash: vi.fn(),
    runShard: vi.fn(),
  };
});

vi.mock('@procsim/scheduler', () => ({ schedule }));
vi.mock('@procsim/simulation', () => ({ simulate, chanceCrash, runShard }));

// Import for side-effect (worker.ts wires up self.onmessage at module load).
await import('./worker.js');

// Convenience: send a request through the handler the worker registered.
function send(msg: WorkerRequest): void {
  const handler = getSelf().onmessage;
  if (!handler) throw new Error('worker.ts did not register self.onmessage');
  handler({ data: msg });
}

// Wait two microtask ticks so the handler's async work resolves before
// assertions. The handler is `async` and posts results after awaiting.
// Microtask-based rather than setImmediate so it survives `vi.useFakeTimers()`.
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  postMessage.mockClear();
  schedule.mockReset();
  simulate.mockReset();
  chanceCrash.mockReset();
  runShard.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Happy paths ───────────────────────────────────────────────────────────────

describe('worker — happy paths', () => {
  it('schedule request → schedule_result with engine outcome', async () => {
    const outcome = { tag: 'sched-outcome' } as unknown as ScheduleOutcome;
    schedule.mockReturnValue(outcome);
    send({ type: 'schedule', id: 'a', input: { tag: 'input' } as never });
    await flush();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'schedule_result',
      id: 'a',
      outcome,
    });
  });

  it('simulate request → simulate_result with engine result', async () => {
    const result = { tag: 'sim-result' } as unknown as SimulationResult;
    simulate.mockReturnValue(result);
    send({ type: 'simulate', id: 'b', input: { tag: 'sim-input' } as never });
    await flush();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'simulate_result',
      id: 'b',
      result,
    });
  });

  it('chance_crash request → chance_crash_result with engine plan', async () => {
    const plan = { tag: 'crash-plan' } as unknown as ChanceCrashPlan;
    chanceCrash.mockResolvedValue(plan);
    send({
      type: 'chance_crash',
      id: 'c',
      // worker.ts reads `input.nodes.length` synchronously before awaiting
      // chanceCrash (line 73 — maxStepsHeuristic). Provide a real array.
      input: { tag: 'crash-in', nodes: [] } as never,
      deadline: new Date('2026-12-31'),
      opts: {},
    });
    await flush();
    await flush(); // chanceCrash is async → extra tick to flush
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'chance_crash_result',
      id: 'c',
      plan,
    });
  });

  it('simulate_shard request → simulate_shard_result with raw output', async () => {
    const raw = { tag: 'shard-raw' } as unknown as RawShardOutput;
    runShard.mockReturnValue(raw);
    send({
      type: 'simulate_shard',
      id: 'd',
      input: { tag: 'shard-in' } as never,
      iterStart: 0,
      iterEnd: 50,
      totalIterations: 200,
    });
    await flush();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'simulate_shard_result',
      id: 'd',
      raw,
    });
    expect(runShard).toHaveBeenCalledWith(expect.anything(), {
      iterStart: 0,
      iterEnd: 50,
      totalIterations: 200,
    });
  });
});

// ── Error-path ────────────────────────────────────────────────────────────────

describe('worker — error-path', () => {
  it('schedule throw → error response with message', async () => {
    schedule.mockImplementation(() => {
      throw new Error('sched boom');
    });
    send({ type: 'schedule', id: 'e1', input: {} as never });
    await flush();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'error',
      id: 'e1',
      message: 'sched boom',
    });
  });

  it('simulate throw → error response with message', async () => {
    simulate.mockImplementation(() => {
      throw new Error('sim boom');
    });
    send({ type: 'simulate', id: 'e2', input: {} as never });
    await flush();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'error',
      id: 'e2',
      message: 'sim boom',
    });
  });

  it('chance_crash rejection → error response with message', async () => {
    chanceCrash.mockRejectedValue(new Error('crash boom'));
    send({
      type: 'chance_crash',
      id: 'e3',
      input: { nodes: [] } as never,
      deadline: new Date(),
      opts: {},
    });
    await flush();
    await flush();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'error',
      id: 'e3',
      message: 'crash boom',
    });
  });

  it('simulate_shard throw → error response with message', async () => {
    runShard.mockImplementation(() => {
      throw new Error('shard boom');
    });
    send({
      type: 'simulate_shard',
      id: 'e4',
      input: {} as never,
      iterStart: 0,
      iterEnd: 10,
      totalIterations: 10,
    });
    await flush();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'error',
      id: 'e4',
      message: 'shard boom',
    });
  });

  it('non-Error throw is stringified', async () => {
    schedule.mockImplementation(() => {
      throw 'plain string';
    });
    send({ type: 'schedule', id: 'e5', input: {} as never });
    await flush();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'error',
      id: 'e5',
      message: 'plain string',
    });
  });
});

// ── Pre-flight cancellation ───────────────────────────────────────────────────

describe('worker — pre-flight cancellation', () => {
  it('cancel before simulate → handler skips work, posts nothing', async () => {
    send({ type: 'cancel', id: 'p1' });
    send({ type: 'simulate', id: 'p1', input: {} as never });
    await flush();
    expect(simulate).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('cancel before chance_crash → handler skips work, posts nothing', async () => {
    send({ type: 'cancel', id: 'p2' });
    send({
      type: 'chance_crash',
      id: 'p2',
      input: {} as never,
      deadline: new Date(),
      opts: {},
    });
    await flush();
    expect(chanceCrash).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('cancel before simulate_shard → handler skips work, posts nothing', async () => {
    send({ type: 'cancel', id: 'p3' });
    send({
      type: 'simulate_shard',
      id: 'p3',
      input: {} as never,
      iterStart: 0,
      iterEnd: 10,
      totalIterations: 10,
    });
    await flush();
    expect(runShard).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('cancel drains: a second job with the same id is NOT skipped', async () => {
    // The pre-flight check consumes the cancelled id, so reusing the
    // same id later runs normally. (Job IDs are allocated incrementally
    // by the client; this just locks in the cancelledIds set semantics.)
    send({ type: 'cancel', id: 'p4' });
    send({ type: 'simulate', id: 'p4', input: {} as never });
    await flush();
    expect(simulate).not.toHaveBeenCalled();

    simulate.mockReturnValue({ tag: 'second' } as unknown as SimulationResult);
    send({ type: 'simulate', id: 'p4', input: {} as never });
    await flush();
    expect(simulate).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'simulate_result',
      id: 'p4',
      result: { tag: 'second' } as unknown as SimulationResult,
    });
  });
});

// ── Progress throttling ───────────────────────────────────────────────────────

describe('worker — simulate progress throttling', () => {
  it('emits at most one progress event per ~100 ms wall-time tick', async () => {
    // Make `simulate` invoke its progress callback many times rapidly,
    // then return. We control `Date.now()` via fake timers; the handler
    // throttles on `now - lastProgressMs >= 100`.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    let progressCb: ((pct: number) => void) | null = null;
    simulate.mockImplementation((_input, cb) => {
      progressCb = cb ?? null;
      // Fire 5 callbacks at t=0 → only the first should NOT post (gate is
      // `now - lastProgressMs >= 100`; initial lastProgressMs is now,
      // so no diff → no post). Then advance time and fire more.
      for (let i = 0; i < 5; i++) progressCb?.(i / 5);
      vi.advanceTimersByTime(100);
      progressCb?.(0.99); // crosses the 100ms gate → posts
      return { tag: 'done' } as unknown as SimulationResult;
    });

    send({ type: 'simulate', id: 't1', input: {} as never });
    await flush();

    const progressCalls = postMessage.mock.calls.filter(
      (call) => (call[0] as WorkerResponse).type === 'progress',
    );
    // Exactly one progress event landed between the initial setup (no
    // post — same tick) and the time advance (post — gate cleared).
    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0]?.[0]).toMatchObject({ type: 'progress', id: 't1', pct: 0.99 });

    // The final simulate_result still lands.
    const resultCalls = postMessage.mock.calls.filter(
      (c) => (c[0] as WorkerResponse).type === 'simulate_result',
    );
    expect(resultCalls).toHaveLength(1);
  });
});
