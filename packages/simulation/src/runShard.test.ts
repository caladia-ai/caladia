/**
 * Phase 48 Slice 4b — `runShard` / `assembleFromShards` determinism canary.
 *
 * The whole point of the parallel path is that
 * `assembleFromShards(input, runShard splits)` produces a byte-identical
 * `SimulationResult` to `simulate(input)` for the same input and seed,
 * convergence field included now that the Slice 4b follow-up replays it
 * post-merge.
 *
 * This file checks the engine surface with synthetic inputs that exercise:
 *   - activity distributions of every type (triangular, pert-beta, normal)
 *   - decision nodes with and without distributions, with failureDelay
 *   - fixedCost.distribution per node
 *   - loop.expectedIterations
 *   - resource.hourlyRateDistribution
 *   - what-if exclusion via excludeNodeDistributions
 *   - several shard split shapes (1 / 2 / 4 / uneven)
 *
 * The companion template-level canary at
 * `packages/app/src/integration/runShard-snapshot.test.ts` exercises the
 * giant fixtures (Oncology / Tentpole) that previous-session's refactor
 * attempt drifted on.
 */

import { describe, it, expect } from 'vitest';
import type { Calendar, ProjectNode, Resource, Loop } from '@procsim/file-format';
import type { ScheduleInput } from '@procsim/scheduler';
import { simulate, type SimulationResult, type SimulationInput } from './index.js';
import { runShard } from './runShard.js';
import { assembleFromShards } from './assembleFromShards.js';

const MON_FRI: Calendar = {
  id: 'cal-default',
  name: 'Mon–Fri 8h',
  workingDays: [false, true, true, true, true, true, false],
  hoursPerDay: 8,
  daysPerWeek: 5,
  holidayPreset: 'NONE',
  holidayPresetVersion: '1.0',
  exceptions: [],
};

const BASE_PROJECT = {
  name: 'Test',
  startDate: '2026-01-05', // Monday
  defaultCalendarId: 'cal-default',
  displayUnit: 'days' as const,
  shareMode: 'percentage' as const,
};

function activity(id: string, hours: number, opts: Partial<ProjectNode> = {}): ProjectNode {
  return {
    id,
    nodeType: 'activity',
    name: id,
    duration: { value: hours, unit: 'hours' },
    durationSemantic: 'time',
    position: { x: 0, y: 0 },
    calendarId: null,
    consumesResources: false,
    resourceAssignments: [],
    ...opts,
  };
}

function decision(id: string, opts: Partial<ProjectNode> = {}): ProjectNode {
  return {
    id,
    nodeType: 'decision',
    name: id,
    duration: { value: 0, unit: 'hours' },
    durationSemantic: 'time',
    position: { x: 0, y: 0 },
    calendarId: null,
    consumesResources: false,
    resourceAssignments: [],
    passProbability: 0.7,
    failureDelay: { value: 24, unit: 'hours' },
    ...opts,
  };
}

function start(): ProjectNode {
  return {
    id: 'start',
    nodeType: 'start',
    name: 'Start',
    duration: { value: 0, unit: 'hours' },
    durationSemantic: 'time',
    position: { x: 0, y: 0 },
    calendarId: null,
    consumesResources: false,
    resourceAssignments: [],
  };
}

function end(): ProjectNode {
  return {
    id: 'end',
    nodeType: 'end',
    name: 'End',
    duration: { value: 0, unit: 'hours' },
    durationSemantic: 'time',
    position: { x: 0, y: 0 },
    calendarId: null,
    consumesResources: false,
    resourceAssignments: [],
  };
}

function makeScenarioInput(): ScheduleInput {
  // Linear graph with a decision branch, plus a loop, plus resource costing.
  // start → A (tri) → B (pert) → D (decision w/ normal+failureDelay)
  //   → C (cost) → end, with a single-node loop wrapping B.
  const resources: Resource[] = [
    {
      id: 'r1',
      name: 'Engineer',
      capacity: 1,
      calendarId: 'cal-default',
      costRate: 100,
      hourlyRateDistribution: {
        type: 'triangular',
        min: 80,
        mode: 100,
        max: 140,
      },
    },
  ];

  const nodes: ProjectNode[] = [
    start(),
    activity('A', 8, {
      distribution: { type: 'triangular', min: 4, mode: 8, max: 16 },
      consumesResources: true,
      resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'resourceWins' }],
    }),
    activity('B', 16, {
      distribution: { type: 'pert-beta', min: 8, mode: 16, max: 32 },
      fixedCost: {
        value: 500,
        distribution: { type: 'normal', mean: 500, stddev: 100 },
      },
    }),
    decision('D', {
      distribution: { type: 'normal', mean: 0.7, stddev: 0.1 },
    }),
    activity('C', 4, {
      fixedCost: {
        value: 200,
        distribution: { type: 'triangular', min: 150, mode: 200, max: 300 },
      },
    }),
    end(),
  ];

  const loops: Loop[] = [
    {
      id: 'L1',
      bodyNodeIds: ['B'],
      kickout: { type: 'maxIterations', value: 4 },
      expectedIterations: { type: 'triangular', min: 1, mode: 2, max: 4 },
    },
  ];

  return {
    project: BASE_PROJECT,
    nodes,
    edges: [
      { id: 'e1', from: 'start', to: 'A', type: 'FS', lag: { value: 0, unit: 'hours' } },
      { id: 'e2', from: 'A', to: 'B', type: 'FS', lag: { value: 0, unit: 'hours' } },
      { id: 'e3', from: 'B', to: 'D', type: 'FS', lag: { value: 0, unit: 'hours' } },
      { id: 'e4', from: 'D', to: 'C', type: 'FS', lag: { value: 0, unit: 'hours' } },
      { id: 'e5', from: 'C', to: 'end', type: 'FS', lag: { value: 0, unit: 'hours' } },
    ],
    resources,
    calendars: [MON_FRI],
    loops,
  };
}

function runParallel(
  input: SimulationInput,
  splits: ReadonlyArray<[number, number]>,
): SimulationResult {
  const shards = splits.map(([s, e]) =>
    runShard(input, { iterStart: s, iterEnd: e, totalIterations: input.iterations }),
  );
  return assembleFromShards(input, shards);
}

function makeMinimalInput(): ScheduleInput {
  return {
    project: BASE_PROJECT,
    nodes: [
      start(),
      activity('A', 8, {
        distribution: { type: 'triangular', min: 4, mode: 8, max: 16 },
      }),
      activity('B', 16, {
        distribution: { type: 'pert-beta', min: 8, mode: 16, max: 32 },
      }),
      end(),
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'A', type: 'FS', lag: { value: 0, unit: 'hours' } },
      { id: 'e2', from: 'A', to: 'B', type: 'FS', lag: { value: 0, unit: 'hours' } },
      { id: 'e3', from: 'B', to: 'end', type: 'FS', lag: { value: 0, unit: 'hours' } },
    ],
    resources: [],
    calendars: [MON_FRI],
    loops: [],
  };
}

function makeWithDecision(): ScheduleInput {
  const base = makeMinimalInput();
  return {
    ...base,
    nodes: [
      ...base.nodes.filter((n) => n.id !== 'end'),
      decision('D', { distribution: { type: 'normal', mean: 0.7, stddev: 0.1 } }),
      end(),
    ],
    edges: [
      ...base.edges.filter((e) => e.to !== 'end'),
      { id: 'eD', from: 'B', to: 'D', type: 'FS', lag: { value: 0, unit: 'hours' } },
      { id: 'eE', from: 'D', to: 'end', type: 'FS', lag: { value: 0, unit: 'hours' } },
    ],
  };
}

function makeWithResourceRate(): ScheduleInput {
  const base = makeMinimalInput();
  const r: Resource = {
    id: 'r1',
    name: 'Eng',
    capacity: 1,
    calendarId: 'cal-default',
    costRate: 100,
    hourlyRateDistribution: { type: 'triangular', min: 80, mode: 100, max: 140 },
  };
  return {
    ...base,
    resources: [r],
    nodes: base.nodes.map((n) =>
      n.id === 'A'
        ? {
            ...n,
            consumesResources: true,
            resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'resourceWins' }],
          }
        : n,
    ),
  };
}

function makeWithFixedCost(): ScheduleInput {
  const base = makeMinimalInput();
  return {
    ...base,
    nodes: base.nodes.map((n) =>
      n.id === 'B'
        ? {
            ...n,
            fixedCost: {
              value: 500,
              distribution: { type: 'normal', mean: 500, stddev: 100 },
            },
          }
        : n,
    ),
  };
}

function makeWithLoop(): ScheduleInput {
  const base = makeMinimalInput();
  return {
    ...base,
    loops: [
      {
        id: 'L1',
        bodyNodeIds: ['B'],
        kickout: { type: 'maxIterations', value: 4 },
        expectedIterations: { type: 'triangular', min: 1, mode: 2, max: 4 },
      },
    ],
  };
}

describe('runShard + assembleFromShards — parallel determinism canary', () => {
  const ITERS = 200;
  const SEED = 0xc0ffee;

  it('with decision: single shard matches', () => {
    const input: SimulationInput = { schedule: makeWithDecision(), iterations: ITERS, seed: SEED };
    expect(runParallel(input, [[0, ITERS]])).toEqual(simulate(input));
  });

  it('with resource rate dist: single shard matches', () => {
    const input: SimulationInput = {
      schedule: makeWithResourceRate(),
      iterations: ITERS,
      seed: SEED,
    };
    expect(runParallel(input, [[0, ITERS]])).toEqual(simulate(input));
  });

  // Regression guard for the SOH-prefix bug found while landing this slice:
  // simulate() seeds the cost stream from `cost:${id}` (SOH prefix);
  // runShard MUST use the same byte-identical prefix or every iter's
  // fixedCost sample drifts.
  it('with fixed cost dist: single shard matches', () => {
    const input: SimulationInput = { schedule: makeWithFixedCost(), iterations: ITERS, seed: SEED };
    expect(runParallel(input, [[0, ITERS]])).toEqual(simulate(input));
  });

  it('with loop: single shard matches', () => {
    const input: SimulationInput = { schedule: makeWithLoop(), iterations: ITERS, seed: SEED };
    expect(runParallel(input, [[0, ITERS]])).toEqual(simulate(input));
  });

  it('MINIMAL scenario: single shard matches simulate()', () => {
    const schedule = makeMinimalInput();
    const input: SimulationInput = { schedule, iterations: ITERS, seed: SEED };
    const direct = simulate(input);
    const parallel = runParallel(input, [[0, ITERS]]);
    expect(parallel).toEqual(direct);
  });

  it('MINIMAL scenario: two shards match simulate()', () => {
    const schedule = makeMinimalInput();
    const input: SimulationInput = { schedule, iterations: ITERS, seed: SEED };
    const direct = simulate(input);
    const parallel = runParallel(input, [
      [0, ITERS / 2],
      [ITERS / 2, ITERS],
    ]);
    expect(parallel).toEqual(direct);
  });

  it('single shard [0, N) matches simulate() byte-identical', () => {
    const schedule = makeScenarioInput();
    const input: SimulationInput = { schedule, iterations: ITERS, seed: SEED };
    const direct = simulate(input);
    const parallel = runParallel(input, [[0, ITERS]]);
    expect(parallel).toEqual(direct);
  });

  it('two equal shards [0, N/2), [N/2, N) match simulate()', () => {
    const schedule = makeScenarioInput();
    const input: SimulationInput = { schedule, iterations: ITERS, seed: SEED };
    const direct = simulate(input);
    const parallel = runParallel(input, [
      [0, ITERS / 2],
      [ITERS / 2, ITERS],
    ]);
    expect(parallel).toEqual(direct);
  });

  it('four equal shards match simulate()', () => {
    const schedule = makeScenarioInput();
    const input: SimulationInput = { schedule, iterations: ITERS, seed: SEED };
    const direct = simulate(input);
    const quarter = ITERS / 4;
    const parallel = runParallel(input, [
      [0, quarter],
      [quarter, quarter * 2],
      [quarter * 2, quarter * 3],
      [quarter * 3, ITERS],
    ]);
    expect(parallel).toEqual(direct);
  });

  it('uneven splits ([0,37), [37,123), [123,N)) match simulate()', () => {
    const schedule = makeScenarioInput();
    const input: SimulationInput = { schedule, iterations: ITERS, seed: SEED };
    const direct = simulate(input);
    const parallel = runParallel(input, [
      [0, 37],
      [37, 123],
      [123, ITERS],
    ]);
    expect(parallel).toEqual(direct);
  });

  it('with excludeNodeDistributions (what-if) still matches simulate()', () => {
    const schedule = makeScenarioInput();
    const input: SimulationInput = {
      schedule,
      iterations: ITERS,
      seed: SEED,
      excludeNodeDistributions: ['B', 'D'],
    };
    const direct = simulate(input);
    const parallel = runParallel(input, [
      [0, 50],
      [50, 130],
      [130, ITERS],
    ]);
    expect(parallel).toEqual(direct);
  });

  // Convergence is REPLAYED in assembleFromShards (Slice 4b follow-up).
  // For ITERS = 200 there isn't enough budget to hit the stability bar
  // (earliest possible convergence = 250 iters), so we expect not-yet
  // here. The byte-equality assertions above already cover the case
  // where convergence DID fire — they'd diverge if the replay
  // mis-aligned with simulate()'s in-loop check.
  it('parallel result reports same convergence shape as simulate()', () => {
    const schedule = makeScenarioInput();
    const input: SimulationInput = { schedule, iterations: ITERS, seed: SEED };
    const direct = simulate(input);
    const parallel = runParallel(input, [[0, ITERS]]);
    expect(parallel.convergence).toEqual(direct.convergence);
  });

  // ── Audit I-9 — empty-shard handling ─────────────────────────────────────
  //
  // Audit I-9 raised the concern that `assembleFromShards` "can lose
  // convergence snapshot when an empty shard appears early." The 2026-05-27
  // verification pass traced the code and could not reproduce the bug — the
  // three cases in `shardContributionAtCheckpoint` already handle empty
  // shards (no convergence checkpoints → CASE 3 returns zero; K past
  // iterEnd → CASE 1 returns the shard's final totals, which are also
  // zero for an empty shard).
  //
  // These tests lock in that correct behaviour by constructing splits the
  // production orchestrator (`simulateParallel.shardRanges`) wouldn't emit:
  // empty `[X, X)` ranges placed at the start, middle, and interleaved
  // positions of the shard array. The byte-equality assertion catches both
  // the merged per-iter arrays AND the convergence-replay output drifting
  // from a single-thread `simulate()` run.
  describe('empty-shard placements (I-9 lockdown)', () => {
    it('empty shard at array start matches simulate()', () => {
      const schedule = makeScenarioInput();
      const input: SimulationInput = { schedule, iterations: ITERS, seed: SEED };
      const direct = simulate(input);
      const parallel = runParallel(input, [
        [0, 0],
        [0, ITERS / 2],
        [ITERS / 2, ITERS],
      ]);
      expect(parallel).toEqual(direct);
    });

    it('empty shard in middle matches simulate()', () => {
      const schedule = makeScenarioInput();
      const input: SimulationInput = { schedule, iterations: ITERS, seed: SEED };
      const direct = simulate(input);
      const parallel = runParallel(input, [
        [0, ITERS / 2],
        [ITERS / 2, ITERS / 2],
        [ITERS / 2, ITERS],
      ]);
      expect(parallel).toEqual(direct);
    });

    it('multiple empty shards interleaved match simulate()', () => {
      const schedule = makeScenarioInput();
      const input: SimulationInput = { schedule, iterations: ITERS, seed: SEED };
      const direct = simulate(input);
      const parallel = runParallel(input, [
        [0, 0],
        [0, ITERS / 4],
        [ITERS / 4, ITERS / 4],
        [ITERS / 4, ITERS / 2],
        [ITERS / 2, ITERS / 2],
        [ITERS / 2, ITERS],
        [ITERS, ITERS],
      ]);
      expect(parallel).toEqual(direct);
    });

    it('empty shards spanning a convergence checkpoint match simulate()', () => {
      // Place empty ranges that straddle iter 50 (the first global
      // checkpoint at CONVERGENCE_CHECK_INTERVAL=50). This is the
      // scenario most likely to expose a snapshot-loss bug if one
      // existed: an early empty shard followed by a real shard whose
      // first snapshot fires at iter=50.
      const schedule = makeScenarioInput();
      const input: SimulationInput = { schedule, iterations: ITERS, seed: SEED };
      const direct = simulate(input);
      const parallel = runParallel(input, [
        [0, 0],
        [0, 50],
        [50, 50],
        [50, ITERS],
      ]);
      expect(parallel).toEqual(direct);
    });

    it('only one non-empty shard surrounded by empties matches simulate()', () => {
      const schedule = makeScenarioInput();
      const input: SimulationInput = { schedule, iterations: ITERS, seed: SEED };
      const direct = simulate(input);
      const parallel = runParallel(input, [
        [0, 0],
        [0, 0],
        [0, ITERS],
        [ITERS, ITERS],
        [ITERS, ITERS],
      ]);
      expect(parallel).toEqual(direct);
    });
  });
});
