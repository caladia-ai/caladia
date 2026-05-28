import { describe, it, expect } from 'vitest';
import type { Calendar, Loop, ProjectEdge, ProjectNode, Resource } from '@procsim/file-format';
import type { ScheduleInput } from '@procsim/scheduler';
import { simulate } from './index.js';

// ── Phase 19 slice 2 — Monte Carlo cost outputs ──────────────────────────────
//
// The slice-1 cost engine ran inside every `schedule()` call. Slice 2 wires
// that per-iteration into the Monte Carlo loop, adds a third per-node
// pre-sample draw (`fixedCost.distribution`), and emits five new fields on
// `SimulationResult`. These tests pin the determinism / invariants / shape.

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
  name: 'Cost Test',
  startDate: '2026-01-05',
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
    consumesResources: opts.resourceAssignments !== undefined,
    resourceAssignments: opts.resourceAssignments ?? [],
    ...opts,
  };
}

function makeInput(opts: {
  nodes: ProjectNode[];
  edges?: ProjectEdge[];
  resources?: Resource[];
  loops?: Loop[];
}): ScheduleInput {
  return {
    project: BASE_PROJECT,
    nodes: opts.nodes,
    edges: opts.edges ?? [],
    resources: opts.resources ?? [],
    calendars: [MON_FRI],
    loops: opts.loops ?? [],
  };
}

// ── Determinism ───────────────────────────────────────────────────────────────

describe('cost MC — determinism', () => {
  it('projectCosts byte-identical for fixed seed', () => {
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
          fixedCost: {
            value: 100,
            distribution: { type: 'triangular', min: 50, mode: 100, max: 200 },
          },
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 1, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const r1 = simulate({ schedule: input, iterations: 200, seed: 7 });
    const r2 = simulate({ schedule: input, iterations: 200, seed: 7 });
    expect(r1.projectCosts).toEqual(r2.projectCosts);
    expect(r1.costPercentiles).toEqual(r2.costPercentiles);
    expect(r1.nodeCostStats).toEqual(r2.nodeCostStats);
    expect(r1.costTornado).toEqual(r2.costTornado);
    expect(r1.costCurve).toEqual(r2.costCurve);
  });

  it('different seeds produce different cost samples', () => {
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          fixedCost: {
            value: 100,
            distribution: { type: 'triangular', min: 50, mode: 100, max: 200 },
          },
        }),
      ],
    });
    const r1 = simulate({ schedule: input, iterations: 200, seed: 1 });
    const r2 = simulate({ schedule: input, iterations: 200, seed: 99 });
    const allSame = r1.projectCosts.every((c, i) => c === r2.projectCosts[i]);
    expect(allSame).toBe(false);
  });
});

// ── Empty-cost project ───────────────────────────────────────────────────────

describe('cost MC — empty cost data', () => {
  it('returns all-zero / empty cost fields when no resource has rates and no node has fixedCost', () => {
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
          distribution: { type: 'triangular', min: 4, mode: 8, max: 12 },
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 1, calendarId: MON_FRI.id }],
    });
    const r = simulate({ schedule: input, iterations: 100, seed: 42 });
    expect(r.projectCosts.every((c) => c === 0)).toBe(true);
    expect(r.costPercentiles).toEqual({ p50: 0, p80: 0, p95: 0 });
    expect(r.costTornado).toEqual([]);
    // nodeCostStats has the activity (it appeared in nodeCosts, just always with total=0).
    expect(r.nodeCostStats.a1).toEqual({ mean: 0, p95: 0 });
    // Curve buckets all zero.
    expect(r.costCurve.p50.every((v) => v === 0)).toBe(true);
    expect(r.costCurve.p95.every((v) => v === 0)).toBe(true);
  });
});

// ── Loop-body fixedCost scaling ──────────────────────────────────────────────

describe('cost MC — loop body fixedCost scales per iteration', () => {
  it('mean MC cost on a maxIter=3 loop matches deterministic 3x', () => {
    // Body has fixedCost.value=100, no distribution → every MC iteration
    // charges 100 × 3 = 300 (per-iteration default; no fixedCostOnce).
    const input = makeInput({
      nodes: [activity('body', 8, { fixedCost: { value: 100 } })],
      loops: [
        {
          id: 'L1',
          bodyNodeIds: ['body'],
          kickout: { type: 'maxIterations', value: 3 },
          expectedIterations: { type: 'triangular', min: 3, mode: 3, max: 3 },
        },
      ],
    });
    const r = simulate({ schedule: input, iterations: 50, seed: 1 });
    // expectedIterations always samples 3 (no variance), so every iteration's
    // body cost is 100 × 3 = 300.
    expect(r.projectCosts.every((c) => c === 300)).toBe(true);
    expect(r.nodeCostStats.body).toEqual({ mean: 300, p95: 300 });
  });

  it('fixedCostOnce: true caps the loop-body cost at one charge', () => {
    const input = makeInput({
      nodes: [
        activity('body', 8, {
          fixedCost: { value: 100 },
          fixedCostOnce: true,
        }),
      ],
      loops: [
        {
          id: 'L1',
          bodyNodeIds: ['body'],
          kickout: { type: 'maxIterations', value: 5 },
          expectedIterations: { type: 'triangular', min: 5, mode: 5, max: 5 },
        },
      ],
    });
    const r = simulate({ schedule: input, iterations: 30, seed: 1 });
    expect(r.projectCosts.every((c) => c === 100)).toBe(true);
  });

  it('sampled loop iteration count multiplies the per-iter cost draw', () => {
    // expectedIterations varies 1..5; body fixedCost.distribution centred on
    // 100 → per-iteration project cost = sampled_cost × sampled_iter_count.
    const input = makeInput({
      nodes: [
        activity('body', 8, {
          fixedCost: {
            value: 100,
            distribution: { type: 'triangular', min: 80, mode: 100, max: 120 },
          },
        }),
      ],
      loops: [
        {
          id: 'L1',
          bodyNodeIds: ['body'],
          kickout: { type: 'maxIterations', value: 10 },
          expectedIterations: { type: 'triangular', min: 1, mode: 3, max: 5 },
        },
      ],
    });
    const r = simulate({ schedule: input, iterations: 500, seed: 1 });
    // Per-iteration cost range: 80×1=80 (min) to 120×5=600 (max).
    const min = Math.min(...r.projectCosts);
    const max = Math.max(...r.projectCosts);
    expect(min).toBeGreaterThanOrEqual(80);
    expect(max).toBeLessThanOrEqual(600);
    // Average should land near nominal: ~100 × 3 = 300.
    const mean = r.projectCosts.reduce((s, c) => s + c, 0) / r.projectCosts.length;
    expect(mean).toBeGreaterThan(240);
    expect(mean).toBeLessThan(360);
  });
});

// ── Decision-node bimodal cost ───────────────────────────────────────────────

describe('cost MC — decision-node failure delay produces bimodal cost', () => {
  it('50/50 decision + 100h failure + $1k/hr produces two cost clusters', () => {
    // Decision node: 8h base, passProbability 0.5, failureDelay 100h.
    // Resource: $1000/hour.
    // Pass iteration cost: 1000 × 8 = 8000.
    // Fail iteration cost: 1000 × (8 + 100) = 108000.
    // Bimodal: roughly 50% of iterations near 8k, the rest near 108k.
    const input = makeInput({
      nodes: [
        {
          id: 'decision',
          nodeType: 'decision',
          name: 'Gate',
          duration: { value: 8, unit: 'hours' },
          durationSemantic: 'time',
          position: { x: 0, y: 0 },
          calendarId: null,
          consumesResources: true,
          resourceAssignments: [{ resourceId: 'eng', count: 1, calendarPolicy: 'intersection' }],
          passProbability: 0.5,
          failureDelay: { value: 100, unit: 'hours' },
        },
      ],
      resources: [
        { id: 'eng', name: 'Engineer', capacity: 1, calendarId: MON_FRI.id, costRate: 1000 },
      ],
    });
    const r = simulate({ schedule: input, iterations: 1000, seed: 42 });

    const passCluster = r.projectCosts.filter((c) => c < 50_000);
    const failCluster = r.projectCosts.filter((c) => c >= 50_000);

    // Both clusters non-empty (50/50 — expect roughly 500 each).
    expect(passCluster.length).toBeGreaterThan(300);
    expect(failCluster.length).toBeGreaterThan(300);

    // Pass cluster mean near 8000; fail cluster mean near 108000.
    const meanPass = passCluster.reduce((s, c) => s + c, 0) / passCluster.length;
    const meanFail = failCluster.reduce((s, c) => s + c, 0) / failCluster.length;
    expect(Math.abs(meanPass - 8000)).toBeLessThan(100);
    expect(Math.abs(meanFail - 108_000)).toBeLessThan(100);
  });
});

// ── Cost tornado ─────────────────────────────────────────────────────────────

describe('cost MC — tornado ranks by p95 − p5 of nodeCosts.total', () => {
  it('a high-variance fixedCost dominates the cost tornado', () => {
    // Two activities: HIGH has wide cost variance, LOW has narrow.
    const input = makeInput({
      nodes: [
        activity('HIGH', 8, {
          fixedCost: {
            value: 1000,
            distribution: { type: 'triangular', min: 100, mode: 1000, max: 5000 },
          },
        }),
        activity('LOW', 8, {
          fixedCost: {
            value: 100,
            distribution: { type: 'triangular', min: 95, mode: 100, max: 105 },
          },
        }),
      ],
      edges: [{ id: 'e1', from: 'HIGH', to: 'LOW', type: 'FS', lag: { value: 0, unit: 'hours' } }],
    });
    const r = simulate({ schedule: input, iterations: 500, seed: 11 });
    expect(r.costTornado.length).toBe(2);
    expect(r.costTornado[0]?.nodeId).toBe('HIGH');
    expect(r.costTornado[1]?.nodeId).toBe('LOW');
    expect(r.costTornado[0]!.impactCost).toBeGreaterThan(r.costTornado[1]!.impactCost * 5);
  });

  it('excludes sub-system container ids from the tornado', () => {
    // Subsystem with two body nodes; container's nodeCosts entry is the
    // rollup. The tornado should rank the bodies, not the container.
    const input: ScheduleInput = {
      ...makeInput({
        nodes: [
          {
            id: 'container',
            nodeType: 'subsystem',
            name: 'Sub',
            duration: { value: 0, unit: 'hours' },
            durationSemantic: 'time',
            position: { x: 0, y: 0 },
            calendarId: null,
            consumesResources: false,
            resourceAssignments: [],
          },
          activity('b1', 8, {
            fixedCost: {
              value: 100,
              distribution: { type: 'triangular', min: 50, mode: 100, max: 150 },
            },
          }),
          activity('b2', 8, {
            fixedCost: { value: 100 },
          }),
        ],
        edges: [{ id: 'e1', from: 'b1', to: 'b2', type: 'FS', lag: { value: 0, unit: 'hours' } }],
      }),
      subsystems: [
        {
          id: 'sub-1',
          containerNodeId: 'container',
          bodyNodeIds: ['b1', 'b2'],
          entryNodeId: 'b1',
          exitNodeId: 'b2',
        },
      ],
    };
    const r = simulate({ schedule: input, iterations: 100, seed: 5 });
    const tornadoIds = r.costTornado.map((t) => t.nodeId);
    expect(tornadoIds).not.toContain('container');
    // b1 has variance (distribution); b2 doesn't. Only b1 makes the cut.
    expect(tornadoIds).toContain('b1');
    // Container rollup still appears in nodeCostStats (UI surfaces it).
    expect(r.nodeCostStats.container).toBeDefined();
  });
});

// ── Per-node sub-stream draw-order invariants ────────────────────────────────

describe('cost MC — per-node sub-stream invariants', () => {
  it('cross-node: adding fixedCost.distribution to node A leaves node B endDates identical', () => {
    // Two-activity project. Add cost variance to A in run 2 only; B's
    // duration samples (and therefore endDates ordering) must be unchanged.
    const baseNodes: ProjectNode[] = [
      activity('A', 8, { distribution: { type: 'triangular', min: 4, mode: 8, max: 12 } }),
      activity('B', 8, { distribution: { type: 'triangular', min: 4, mode: 8, max: 12 } }),
    ];
    const noCost = makeInput({
      nodes: baseNodes,
      edges: [{ id: 'e1', from: 'A', to: 'B', type: 'FS', lag: { value: 0, unit: 'hours' } }],
    });
    const withCost = makeInput({
      nodes: [
        {
          ...baseNodes[0]!,
          fixedCost: { value: 100, distribution: { type: 'normal', mean: 100, stddev: 20 } },
        },
        baseNodes[1]!,
      ],
      edges: [{ id: 'e1', from: 'A', to: 'B', type: 'FS', lag: { value: 0, unit: 'hours' } }],
    });
    const r1 = simulate({ schedule: noCost, iterations: 200, seed: 100 });
    const r2 = simulate({ schedule: withCost, iterations: 200, seed: 100 });

    // endDates byte-identical — A's duration draws are unchanged (cost is
    // appended AFTER duration in A's sub-stream) and B has its own
    // sub-stream that doesn't know about A's cost.
    expect(r1.endDates.length).toBe(r2.endDates.length);
    for (let i = 0; i < r1.endDates.length; i++) {
      expect(r1.endDates[i]!.getTime()).toBe(r2.endDates[i]!.getTime());
    }
  });

  it('within-node: adding fixedCost.distribution to A leaves A duration samples identical', () => {
    // A on its own — endDates depend solely on A's duration draws.
    const baseA = activity('A', 8, {
      distribution: { type: 'triangular', min: 4, mode: 8, max: 12 },
    });
    const r1 = simulate({
      schedule: makeInput({ nodes: [baseA] }),
      iterations: 200,
      seed: 50,
    });
    const r2 = simulate({
      schedule: makeInput({
        nodes: [
          {
            ...baseA,
            fixedCost: { value: 100, distribution: { type: 'normal', mean: 100, stddev: 20 } },
          },
        ],
      }),
      iterations: 200,
      seed: 50,
    });
    // A's duration draws come from its dedicated duration/bernoulli stream;
    // cost draws come from a separate parallel stream. Adding a cost
    // distribution touches only the cost stream, so duration draws (and
    // therefore endDates) stay byte-identical across the two runs.
    expect(r1.endDates.length).toBe(r2.endDates.length);
    for (let i = 0; i < r1.endDates.length; i++) {
      expect(r1.endDates[i]!.getTime()).toBe(r2.endDates[i]!.getTime());
    }
  });

  it('within-node decision: adding fixedCost.distribution leaves passProbability draws identical', () => {
    // Decision node A with passProbability distribution → bernoulli draws
    // both happen BEFORE the cost draw. Adding cost variance must not
    // perturb the pass/fail outcome (endDates).
    const baseA: ProjectNode = {
      id: 'A',
      nodeType: 'decision',
      name: 'Gate',
      duration: { value: 8, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
      passProbability: 0.5,
      failureDelay: { value: 16, unit: 'hours' },
    };
    const r1 = simulate({
      schedule: makeInput({ nodes: [baseA] }),
      iterations: 200,
      seed: 77,
    });
    const r2 = simulate({
      schedule: makeInput({
        nodes: [
          {
            ...baseA,
            fixedCost: { value: 100, distribution: { type: 'normal', mean: 100, stddev: 20 } },
          },
        ],
      }),
      iterations: 200,
      seed: 77,
    });
    expect(r1.endDates.length).toBe(r2.endDates.length);
    for (let i = 0; i < r1.endDates.length; i++) {
      expect(r1.endDates[i]!.getTime()).toBe(r2.endDates[i]!.getTime());
    }
  });
});

// ── Phase 29 — per-resource rate uncertainty ────────────────────────────────

describe('cost MC — per-resource hourlyRateDistribution', () => {
  it('produces variance in projectCosts when the rate is uncertain', () => {
    // 1h activity, count=1 → rateCost = sampledRate × 1. With a triangular
    // [50, 100, 200] rate, costs should vary across iterations.
    const input = makeInput({
      nodes: [
        activity('a1', 1, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
        }),
      ],
      resources: [
        {
          id: 'r1',
          name: 'Contractor',
          capacity: 1,
          calendarId: MON_FRI.id,
          costRate: 100,
          hourlyRateDistribution: { type: 'triangular', min: 50, mode: 100, max: 200 },
        },
      ],
    });
    const result = simulate({ schedule: input, iterations: 500, seed: 42 });
    // Spread should be non-trivial — at minimum, P95 should exceed P50.
    expect(result.costPercentiles.p95).toBeGreaterThan(result.costPercentiles.p50);
    expect(result.projectCosts.length).toBe(500);
    // Min / max range covers most of the triangular support.
    const minCost = Math.min(...result.projectCosts);
    const maxCost = Math.max(...result.projectCosts);
    expect(minCost).toBeGreaterThanOrEqual(50); // triangular floor
    expect(maxCost).toBeLessThanOrEqual(200 + 1e-6); // triangular ceiling (tiny float epsilon)
    expect(maxCost - minCost).toBeGreaterThan(20); // meaningful spread
  });

  it('deterministic schedule unaffected — uses costRate even when distribution present', () => {
    // Run with iterations=1: only one sample. Compare against a run with the
    // distribution removed. The two runs differ only in iteration 0's
    // sampled rate vs the static costRate.
    const baseInput = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
        }),
      ],
      resources: [
        {
          id: 'r1',
          name: 'r1',
          capacity: 1,
          calendarId: MON_FRI.id,
          costRate: 100,
        },
      ],
    });
    // Without distribution: nodeCosts.fromResources = 100 × 8 = 800.
    const noDist = simulate({ schedule: baseInput, iterations: 100, seed: 1 });
    expect(noDist.nodeCostStats['a1']?.mean).toBe(800);
    expect(noDist.nodeCostStats['a1']?.p95).toBe(800);
  });

  it('sub-stream isolation: adding rate distribution to resource A leaves resource B cost samples identical', () => {
    // Two resources on two activities. Run 1: neither has a distribution.
    // Run 2: only resource A has a distribution. Resource B's cost
    // contribution must be byte-identical across runs because B has its
    // own rate sub-stream (which is consumed zero times when its
    // distribution is absent).
    const nodes: ProjectNode[] = [
      activity('a1', 8, {
        resourceAssignments: [{ resourceId: 'rA', count: 1, calendarPolicy: 'intersection' }],
      }),
      activity('a2', 8, {
        resourceAssignments: [{ resourceId: 'rB', count: 1, calendarPolicy: 'intersection' }],
      }),
    ];
    const inputNoDist = makeInput({
      nodes,
      resources: [
        { id: 'rA', name: 'A', capacity: 1, calendarId: MON_FRI.id, costRate: 100 },
        { id: 'rB', name: 'B', capacity: 1, calendarId: MON_FRI.id, costRate: 50 },
      ],
    });
    const inputWithDist = makeInput({
      nodes,
      resources: [
        {
          id: 'rA',
          name: 'A',
          capacity: 1,
          calendarId: MON_FRI.id,
          costRate: 100,
          hourlyRateDistribution: { type: 'triangular', min: 50, mode: 100, max: 200 },
        },
        { id: 'rB', name: 'B', capacity: 1, calendarId: MON_FRI.id, costRate: 50 },
      ],
    });
    const r1 = simulate({ schedule: inputNoDist, iterations: 100, seed: 33 });
    const r2 = simulate({ schedule: inputWithDist, iterations: 100, seed: 33 });
    // a2 (uses rB only) — cost samples byte-identical across the two runs.
    expect(r2.nodeCostStats['a2']).toEqual(r1.nodeCostStats['a2']);
    // a1 (uses rA) — cost samples DIFFERENT because rA now varies.
    expect(r2.nodeCostStats['a1']?.mean).not.toBe(r1.nodeCostStats['a1']?.mean);
  });

  it('cross-stream isolation: adding rate distribution does not perturb endDates', () => {
    // Rate distribution lives in its own per-resource stream — it must
    // not consume from any node's duration / bernoulli / fixedCost stream.
    // endDates depend on durations only; they should be byte-identical
    // across runs that differ only in the rate distribution.
    const node = activity('a1', 8, {
      distribution: { type: 'triangular', min: 4, mode: 8, max: 12 },
      resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
    });
    const noDist = makeInput({
      nodes: [node],
      resources: [{ id: 'r1', name: 'r1', capacity: 1, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const withDist = makeInput({
      nodes: [node],
      resources: [
        {
          id: 'r1',
          name: 'r1',
          capacity: 1,
          calendarId: MON_FRI.id,
          costRate: 100,
          hourlyRateDistribution: { type: 'triangular', min: 50, mode: 100, max: 200 },
        },
      ],
    });
    const r1 = simulate({ schedule: noDist, iterations: 100, seed: 11 });
    const r2 = simulate({ schedule: withDist, iterations: 100, seed: 11 });
    expect(r1.endDates.length).toBe(r2.endDates.length);
    for (let i = 0; i < r1.endDates.length; i++) {
      expect(r1.endDates[i]!.getTime()).toBe(r2.endDates[i]!.getTime());
    }
  });

  it('determinism: fixed seed produces byte-identical projectCosts', () => {
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
        }),
      ],
      resources: [
        {
          id: 'r1',
          name: 'r1',
          capacity: 1,
          calendarId: MON_FRI.id,
          costRate: 100,
          hourlyRateDistribution: { type: 'triangular', min: 50, mode: 100, max: 200 },
        },
      ],
    });
    const r1 = simulate({ schedule: input, iterations: 200, seed: 99 });
    const r2 = simulate({ schedule: input, iterations: 200, seed: 99 });
    expect(r1.projectCosts).toEqual(r2.projectCosts);
  });
});

// ── Cost curve ───────────────────────────────────────────────────────────────

describe('cost MC — cost curve', () => {
  it('times[] is monotonically non-decreasing and starts at 0', () => {
    const input = makeInput({
      nodes: [activity('a1', 8, { fixedCost: { value: 100 } })],
    });
    const r = simulate({ schedule: input, iterations: 50, seed: 1 });
    expect(r.costCurve.times.length).toBe(50);
    expect(r.costCurve.times[0]).toBe(0);
    for (let i = 1; i < r.costCurve.times.length; i++) {
      expect(r.costCurve.times[i]!).toBeGreaterThanOrEqual(r.costCurve.times[i - 1]!);
    }
  });

  it('pXX curves are monotonically non-decreasing (cumulative cost only grows)', () => {
    const input = makeInput({
      nodes: [
        activity('a1', 8, { fixedCost: { value: 100 } }),
        activity('a2', 8, { fixedCost: { value: 200 } }),
        activity('a3', 8, { fixedCost: { value: 50 } }),
      ],
      edges: [
        { id: 'e1', from: 'a1', to: 'a2', type: 'FS', lag: { value: 0, unit: 'hours' } },
        { id: 'e2', from: 'a2', to: 'a3', type: 'FS', lag: { value: 0, unit: 'hours' } },
      ],
    });
    const r = simulate({ schedule: input, iterations: 50, seed: 1 });
    for (const curve of [r.costCurve.p10, r.costCurve.p50, r.costCurve.p80, r.costCurve.p95]) {
      for (let i = 1; i < curve.length; i++) {
        expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
      }
    }
    // Final bucket equals project total (350) for every percentile since
    // there's no variance.
    expect(r.costCurve.p50[r.costCurve.p50.length - 1]).toBe(350);
    expect(r.costCurve.p95[r.costCurve.p95.length - 1]).toBe(350);
  });
});

// ── Phase 23 — parallelism in MC ─────────────────────────────────────────────

describe('cost MC — parallelism (Phase 23)', () => {
  it('determinism preserved when assignment carries parallelism', () => {
    // Adding parallelism is a deterministic transformation — no extra RNG
    // draws — so the per-iteration project costs must still be byte-equal
    // for a fixed seed.
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [
            { resourceId: 'r1', count: 2, calendarPolicy: 'intersection', parallelism: 1 },
          ],
          distribution: { type: 'triangular', min: 4, mode: 8, max: 16 },
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 4, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const r1 = simulate({ schedule: input, iterations: 200, seed: 13 });
    const r2 = simulate({ schedule: input, iterations: 200, seed: 13 });
    expect(r1.projectCosts).toEqual(r2.projectCosts);
    expect(r1.endDates.map((d) => d.getTime())).toEqual(r2.endDates.map((d) => d.getTime()));
  });

  it('α=1 yields lower mean cost AND lower mean finish than α=0 for the same fixture', () => {
    // Same node, two scenarios. Per iteration: sampled duration h →
    //   α=1, count=2: cost = rate × (h/2) × 2 = rate × h     (cost stays at baseline)
    //   α=0, count=2: cost = rate × h × 2 = 2 × rate × h     (cost doubles)
    // and finish for α=1 is h-based, for α=0 is 2h-based (double the wall-clock).
    // Both lower for α=1.
    function makeFixture(parallelism: number): ScheduleInput {
      return makeInput({
        nodes: [
          activity('a1', 8, {
            resourceAssignments: [
              { resourceId: 'r1', count: 2, calendarPolicy: 'intersection', parallelism },
            ],
            distribution: { type: 'triangular', min: 4, mode: 8, max: 16 },
          }),
        ],
        resources: [{ id: 'r1', name: 'Dev', capacity: 4, calendarId: MON_FRI.id, costRate: 100 }],
      });
    }
    const r0 = simulate({ schedule: makeFixture(0), iterations: 500, seed: 42 });
    const r1 = simulate({ schedule: makeFixture(1), iterations: 500, seed: 42 });
    const mean0 = r0.projectCosts.reduce((s, x) => s + x, 0) / r0.projectCosts.length;
    const mean1 = r1.projectCosts.reduce((s, x) => s + x, 0) / r1.projectCosts.length;
    // α=1 costs roughly half of α=0 for this fixture (rate × h vs 2 × rate × h).
    expect(mean1).toBeLessThan(mean0);
    expect(mean1 / mean0).toBeCloseTo(0.5, 1);
    // And α=1 finishes earlier on every successful iteration (per-iteration sampled
    // h applied to bottleneck, halved by parallelism).
    expect(r1.percentiles.p50.getTime()).toBeLessThan(r0.percentiles.p50.getTime());
  });
});
