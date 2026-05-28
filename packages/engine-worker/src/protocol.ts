/**
 * Shared message protocol between the engine worker thread and the main
 * thread.  Both tsconfig variants (DOM + WebWorker) include this file, so
 * it must not reference any DOM-only or WebWorker-only types.
 *
 * All payloads pass through `postMessage` / structured-clone.  `Date`
 * objects (inside `SimulationResult.endDates`) survive structured-clone
 * unchanged.  Functions (e.g. `onProgress`) are not serialisable and must
 * never appear in the payload types.
 */

import type { ScheduleInput, ScheduleOutcome } from '@procsim/scheduler';
import type {
  SimulationInput,
  SimulationResult,
  ChanceCrashOptions,
  ChanceCrashPlan,
  RawShardOutput,
  ShardOpts,
} from '@procsim/simulation';

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

/**
 * Phase 25 Slice 4 — wire-safe subset of `ChanceCrashOptions`. The full
 * options type carries a `signal` field (a mutable cancellation token)
 * which is not structured-clone-safe. The worker reconstructs the signal
 * on its side from the existing `cancel` request id; the wire payload
 * carries only the scalar settings.
 */
export type ChanceCrashOptionsWire = Omit<ChanceCrashOptions, 'signal'>;

// ── Requests (main thread → worker) ──────────────────────────────────────────

export type WorkerRequest =
  /** Run schedule() synchronously inside the worker. */
  | { type: 'schedule'; id: string; input: ScheduleInput }
  /** Run simulate() inside the worker with optional progress callbacks. */
  | { type: 'simulate'; id: string; input: SimulationInput }
  /**
   * Phase 48 Slice 4b — run a single shard of the MC loop and return its
   * raw per-iter arrays. The main-thread orchestrator merges N shards via
   * `assembleFromShards` to produce the final `SimulationResult`. Shards
   * don't emit progress: they're short by design (the orchestrator
   * aggregates progress across shards on the main thread).
   */
  | {
      type: 'simulate_shard';
      id: string;
      input: SimulationInput;
      iterStart: number;
      iterEnd: number;
      totalIterations: number;
    }
  /**
   * Phase 25 Slice 4 — run chanceCrash() inside the worker. `deadline` is
   * passed as a Date (structured-clone preserves Date). Progress events
   * reuse the existing `progress` response shape; the worker translates
   * the helper's `(step, p95)` callback into a `pct ∈ (0, 1]` estimate.
   */
  | {
      type: 'chance_crash';
      id: string;
      input: ScheduleInput;
      deadline: Date;
      opts: Partial<ChanceCrashOptionsWire>;
    }
  /** Cancel a job by id (no-op if the job has already completed). */
  | { type: 'cancel'; id: string };

// ── Responses (worker → main thread) ─────────────────────────────────────────

export type WorkerResponse =
  /** Final result for a schedule job. */
  | { type: 'schedule_result'; id: string; outcome: ScheduleOutcome }
  /** Final result for a simulate job. */
  | { type: 'simulate_result'; id: string; result: SimulationResult }
  /**
   * Phase 48 Slice 4b — raw per-iter arrays for one shard. The orchestrator
   * collects N of these and feeds them to `assembleFromShards`. Maps inside
   * `RawShardOutput` (finishMsPerNode, costPerNode, pathCounts) survive
   * structured-clone unchanged.
   */
  | { type: 'simulate_shard_result'; id: string; raw: RawShardOutput }
  /** Final result for a chance-crash job. */
  | { type: 'chance_crash_result'; id: string; plan: ChanceCrashPlan }
  /**
   * Intermediate progress update.  `pct` ∈ (0, 1].  May arrive multiple
   * times per job; never sent for schedule jobs (they complete too quickly
   * to need it).  The worker throttles to ~100 ms wall time between events.
   */
  | { type: 'progress'; id: string; pct: number }
  /** Unhandled error inside the worker for the given job. */
  | { type: 'error'; id: string; message: string };
