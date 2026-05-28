/**
 * Audit N-9 — coverage for the shared schedule cache that backs
 * `useSchedule`. Pure module tests; the engine-worker singleton is
 * `vi.mock`ed so each test controls async resolution timing without
 * spawning a real Worker.
 *
 * The hook itself (useSchedule.ts) is React-shaped; app package has no
 * React-render testing infra. Testing the cache module covers the
 * audit's concern (move CPM off the main thread, share work across
 * call sites) since the hook is a thin `useSyncExternalStore` over
 * this cache.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EngineWorkerClient, ScheduleOutcome } from '@procsim/engine-worker';
import { makeDefaultProject } from '../store/domainStore.js';
import type { ProjectFile } from '@procsim/file-format';

// ── vi.mock setup ─────────────────────────────────────────────────────────────

const { scheduleAsyncMock } = vi.hoisted(() => ({
  scheduleAsyncMock: vi.fn<EngineWorkerClient['scheduleAsync']>(),
}));

vi.mock('../engineWorker.js', () => ({
  getEngineWorker: (): Pick<EngineWorkerClient, 'scheduleAsync'> => ({
    scheduleAsync: scheduleAsyncMock,
  }),
}));

import {
  getCachedOrSyncFallback,
  triggerAsyncRefresh,
  subscribeToScheduleCache,
  _resetScheduleCache,
  _peekScheduleCache,
} from './scheduleCache.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProject(): ProjectFile {
  return makeDefaultProject();
}

function freshProject(): ProjectFile {
  // Distinct reference for each call — simulates a project edit (the
  // domain store always replaces `project` on every mutation).
  return { ...makeDefaultProject() };
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

// ── beforeEach / afterEach ────────────────────────────────────────────────────

beforeEach(() => {
  _resetScheduleCache();
  scheduleAsyncMock.mockReset();
});

afterEach(() => {
  _resetScheduleCache();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('scheduleCache — first-call sync fallback', () => {
  it('first call runs sync and populates the cache', () => {
    const p = makeProject();
    expect(_peekScheduleCache().outcome).toBeNull();

    const outcome = getCachedOrSyncFallback(p);

    expect(outcome).toBeDefined();
    expect(_peekScheduleCache().project).toBe(p);
    expect(_peekScheduleCache().outcome).toBe(outcome);
    // No async dispatch — sync fallback didn't need the worker.
    expect(scheduleAsyncMock).not.toHaveBeenCalled();
  });

  it('returns the same outcome on repeated calls with the same project', () => {
    const p = makeProject();
    const first = getCachedOrSyncFallback(p);
    const second = getCachedOrSyncFallback(p);
    expect(second).toBe(first);
  });
});

describe('scheduleCache — async refresh on project change', () => {
  it('returns STALE on cache miss; triggers async; updates on resolve', async () => {
    const p1 = freshProject();
    const stale = getCachedOrSyncFallback(p1);

    const p2 = freshProject();
    // Cache miss for p2 — returns the p1 outcome (stale).
    const observed = getCachedOrSyncFallback(p2);
    expect(observed).toBe(stale);

    // Now hand a fresh outcome to the async path.
    const fresh = { ok: true, result: { tag: 'fresh' } } as unknown as ScheduleOutcome;
    scheduleAsyncMock.mockResolvedValueOnce(fresh);

    triggerAsyncRefresh(p2);
    expect(scheduleAsyncMock).toHaveBeenCalledTimes(1);
    expect(_peekScheduleCache().inFlightProject).toBe(p2);

    await flush();

    expect(_peekScheduleCache().project).toBe(p2);
    expect(_peekScheduleCache().outcome).toBe(fresh);
    expect(_peekScheduleCache().inFlightProject).toBeNull();
    expect(_peekScheduleCache().inFlightAbort).toBeNull();
  });

  it('notifies subscribers when the async refresh lands', async () => {
    getCachedOrSyncFallback(makeProject()); // seed the cache

    const subscriber = vi.fn();
    const unsubscribe = subscribeToScheduleCache(subscriber);

    const p2 = freshProject();
    const fresh = { ok: true, result: { tag: 'fresh' } } as unknown as ScheduleOutcome;
    scheduleAsyncMock.mockResolvedValueOnce(fresh);
    triggerAsyncRefresh(p2);
    await flush();

    expect(subscriber).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('repeated triggerAsyncRefresh for the same project does not double-fire scheduleAsync', () => {
    getCachedOrSyncFallback(makeProject());
    const p2 = freshProject();

    scheduleAsyncMock.mockReturnValueOnce(new Promise(() => {})); // never resolves

    triggerAsyncRefresh(p2);
    triggerAsyncRefresh(p2);
    triggerAsyncRefresh(p2);

    expect(scheduleAsyncMock).toHaveBeenCalledTimes(1);
  });

  it('triggerAsyncRefresh is a no-op when the cache is already fresh for the project', () => {
    const p = makeProject();
    getCachedOrSyncFallback(p);
    expect(_peekScheduleCache().project).toBe(p);

    triggerAsyncRefresh(p);

    expect(scheduleAsyncMock).not.toHaveBeenCalled();
    expect(_peekScheduleCache().inFlightProject).toBeNull();
  });
});

describe('scheduleCache — abort on stale refresh', () => {
  it('a new project change aborts the previous in-flight refresh', () => {
    getCachedOrSyncFallback(makeProject());

    const p2 = freshProject();
    let firstSignal: AbortSignal | undefined;
    scheduleAsyncMock.mockImplementationOnce((_input, signal) => {
      firstSignal = signal;
      return new Promise(() => {}); // never resolves on its own
    });
    triggerAsyncRefresh(p2);
    expect(firstSignal?.aborted).toBe(false);

    const p3 = freshProject();
    scheduleAsyncMock.mockReturnValueOnce(new Promise(() => {}));
    triggerAsyncRefresh(p3);

    expect(firstSignal?.aborted).toBe(true);
    expect(_peekScheduleCache().inFlightProject).toBe(p3);
  });

  it('a late resolution from an aborted refresh does not overwrite a newer outcome', async () => {
    getCachedOrSyncFallback(makeProject());

    const p2 = freshProject();
    const p3 = freshProject();

    let resolveFirst!: (v: ScheduleOutcome) => void;
    const firstPromise = new Promise<ScheduleOutcome>((r) => (resolveFirst = r));
    scheduleAsyncMock.mockReturnValueOnce(firstPromise);
    triggerAsyncRefresh(p2);

    const p3Outcome = { ok: true, result: { tag: 'p3' } } as unknown as ScheduleOutcome;
    scheduleAsyncMock.mockResolvedValueOnce(p3Outcome);
    triggerAsyncRefresh(p3); // aborts p2's refresh
    await flush();

    expect(_peekScheduleCache().project).toBe(p3);
    expect(_peekScheduleCache().outcome).toBe(p3Outcome);

    // Now late-resolve the aborted p2 promise. The cache must NOT be
    // overwritten — p3's outcome stays.
    resolveFirst({ ok: true, result: { tag: 'stale-p2' } } as unknown as ScheduleOutcome);
    await flush();

    expect(_peekScheduleCache().project).toBe(p3);
    expect(_peekScheduleCache().outcome).toBe(p3Outcome);
  });
});

describe('scheduleCache — sync fallback on async error', () => {
  it('falls back to sync compute when scheduleAsync rejects', async () => {
    getCachedOrSyncFallback(makeProject());

    const p2 = freshProject();
    scheduleAsyncMock.mockRejectedValueOnce(new Error('worker exploded'));

    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    triggerAsyncRefresh(p2);
    await flush();
    consoleErr.mockRestore();

    // Cache should be updated to p2 via the sync fallback path.
    expect(_peekScheduleCache().project).toBe(p2);
    expect(_peekScheduleCache().outcome).not.toBeNull();
    expect(_peekScheduleCache().inFlightProject).toBeNull();
  });
});
