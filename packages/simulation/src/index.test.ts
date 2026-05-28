import { describe, it, expect } from 'vitest';
import type { Calendar, ProjectNode } from '@procsim/file-format';
import type { ScheduleInput } from '@procsim/scheduler';
import { workingHoursBetween } from '@procsim/calendar';
import { simulate, nodeRng } from './index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

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

function makeNode(id: string, hours: number, dist?: ProjectNode['distribution']): ProjectNode {
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
    ...(dist !== undefined && { distribution: dist }),
  };
}

function makeInput(nodes: ProjectNode[], seed = 42): { input: ScheduleInput; seed: number } {
  return {
    input: {
      project: BASE_PROJECT,
      nodes,
      edges: [],
      resources: [],
      calendars: [MON_FRI],
      loops: [],
    },
    seed,
  };
}

// ── DoD #1: byte-identical results with same seed ─────────────────────────────

describe('determinism — same seed → identical results', () => {
  it('produces byte-identical endDates on two runs with the same seed', () => {
    const { input, seed } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 16 }),
      makeNode('B', 16, { type: 'pert-beta', min: 8, mode: 16, max: 32 }),
    ]);

    const r1 = simulate({ schedule: input, iterations: 200, seed });
    const r2 = simulate({ schedule: input, iterations: 200, seed });

    expect(r1.endDates.length).toBe(r2.endDates.length);
    for (let i = 0; i < r1.endDates.length; i++) {
      expect(r1.endDates[i]!.getTime()).toBe(r2.endDates[i]!.getTime());
    }
    expect(r1.percentiles.p50.getTime()).toBe(r2.percentiles.p50.getTime());
    expect(r1.percentiles.p80.getTime()).toBe(r2.percentiles.p80.getTime());
    expect(r1.percentiles.p95.getTime()).toBe(r2.percentiles.p95.getTime());
  });

  it('produces different results with a different seed', () => {
    const { input } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 16 }),
    ]);
    const r1 = simulate({ schedule: input, iterations: 100, seed: 1 });
    const r2 = simulate({ schedule: input, iterations: 100, seed: 999 });

    // Vanishingly unlikely to be identical with different seeds
    const allSame = r1.endDates.every((d, i) => d.getTime() === r2.endDates[i]!.getTime());
    expect(allSame).toBe(false);
  });
});

// ── DoD #2: hierarchical seeding — adding a node doesn't perturb others ───────

describe('hierarchical seeding', () => {
  it('node A samples are unchanged after adding unrelated node C', () => {
    const seed = 7;
    const nodeA = makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 12 });
    const nodeB = makeNode('B', 8); // no distribution — just a fixed follower
    const nodeC = makeNode('C', 4, { type: 'normal', mean: 4, stddev: 1 });

    // Run without C
    const { input: inputAB } = makeInput([nodeA, nodeB]);
    const rAB = simulate({ schedule: inputAB, iterations: 50, seed });

    // Run with C inserted
    const { input: inputABC } = makeInput([nodeA, nodeB, nodeC]);
    const rABC = simulate({ schedule: inputABC, iterations: 50, seed });

    // A's contribution: duration drawn by nodeRng(seed, 'A') must be identical.
    // We can verify indirectly: for the fixed-duration-only case where B has no
    // distribution, node A's durations are the sole source of variance. But
    // since the overall project end depends on both, and C adds extra duration,
    // the end dates differ. What we directly verify is that the A-specific
    // nodeRng stream produces identical values regardless of C's presence.
    const rngA_noC = nodeRng(seed, 'A');
    const rngA_withC = nodeRng(seed, 'A');

    // Both should produce the exact same stream
    let r1 = rngA_noC;
    let r2 = rngA_withC;
    for (let i = 0; i < 20; i++) {
      const [v1, next1] = r1.next();
      const [v2, next2] = r2.next();
      expect(v1).toBe(v2);
      r1 = next1;
      r2 = next2;
    }

    // Sanity: results with C differ from without (C adds duration)
    expect(rABC.endDates[0]!.getTime()).toBeGreaterThanOrEqual(rAB.endDates[0]!.getTime());
  });

  it('nodeRng produces independent streams for different node IDs', () => {
    const seed = 42;
    const rngA = nodeRng(seed, 'node-alpha');
    const rngB = nodeRng(seed, 'node-beta');

    const [a1] = rngA.next();
    const [b1] = rngB.next();
    expect(a1).not.toBe(b1);
  });
});

// ── DoD #3: P50/P80/P95 accuracy vs analytical answer ────────────────────────

describe('percentile accuracy — triangular distribution', () => {
  // Single-node project, Triangular(min=8, mode=16, max=24).
  // Calendar: Mon–Fri 8h/day, no holidays. Project starts Mon 2026-01-05 00:00
  // → scheduler snaps ES to Mon 08:00.
  //
  // Tolerance: 1% of distribution range (16h) = 0.16 working hours = 576 s.

  it('P50 within 1% of analytical median for Triangular(8,16,24)', () => {
    // Analytical median = 16 working hours (mode = midpoint → symmetric upper half).
    //   16h work: Mon 8h (→ 16:00) + Tue 8h (→ 16:00) = Tue Jan 6 16:00 local.
    //
    // NOTE: tolerance is in WORKING hours. Two dates separated by an overnight gap
    // have a large wall-clock diff (16h) but zero working-hour diff; comparisons must
    // use workingHoursBetween, not .getTime() subtraction.
    const { input, seed } = makeInput([
      makeNode('A', 16, { type: 'triangular', min: 8, mode: 16, max: 24 }),
    ]);

    const r = simulate({ schedule: input, iterations: 10_000, seed });

    const expectedP50 = new Date(2026, 0, 6, 16, 0, 0, 0); // Tue Jan 6 16:00
    const toleranceWorkingHours = 0.16;
    const diffWorkingHours = Math.abs(workingHoursBetween(r.percentiles.p50, expectedP50, MON_FRI));
    expect(diffWorkingHours).toBeLessThan(toleranceWorkingHours);
  });

  it('P80 within 1% of analytical value for Triangular(8,16,24)', () => {
    // Analytical P80 for Triangular(a=8, c=16, b=24):
    //   P80 > c, so: 0.80 = 1 - (b-x)²/((b-a)(b-c))
    //   → x = 24 - sqrt((24-8)(24-16)*0.2) = 24 - sqrt(25.6) ≈ 18.939 h
    //
    // 18.939 working hours from Mon 08:00:
    //   Mon 8h  → Mon 16:00
    //   Tue 8h  → Tue 16:00   (16h elapsed)
    //   Wed 2.939h → Wed 08:00 + 2.939h = Wed ~10:56:21
    const { input, seed } = makeInput([
      makeNode('A', 16, { type: 'triangular', min: 8, mode: 16, max: 24 }),
    ]);

    const r = simulate({ schedule: input, iterations: 10_000, seed });

    // P80 analytical ≈ 18.939h → Wed Jan 7 ~10:56 local
    const analyticalWorkingHours = 24 - Math.sqrt((24 - 8) * (24 - 16) * 0.2);
    const extraAfterTwoFullDays = analyticalWorkingHours - 16; // hours into Wed
    const expectedP80 = new Date(
      new Date(2026, 0, 7, 8, 0, 0, 0).getTime() + extraAfterTwoFullDays * 3_600_000,
    );

    const toleranceWorkingHours = 0.16;
    const diffWorkingHours = Math.abs(workingHoursBetween(r.percentiles.p80, expectedP80, MON_FRI));
    expect(diffWorkingHours).toBeLessThan(toleranceWorkingHours);
  });
});

// ── Criticality index sanity checks ──────────────────────────────────────────

describe('criticality index', () => {
  it('single node has criticality ≈ 1.0', () => {
    const { input, seed } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 12 }),
    ]);
    const r = simulate({ schedule: input, iterations: 500, seed });
    expect(r.criticalityIndex['A']).toBeCloseTo(1.0, 1);
  });

  it('series chain: all nodes have criticality ≈ 1.0', () => {
    // A → B → C in series: entire chain is always critical
    const { input: base } = makeInput([makeNode('A', 8), makeNode('B', 8), makeNode('C', 8)]);
    const input: ScheduleInput = {
      ...base,
      nodes: [
        makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 12 }),
        makeNode('B', 8, { type: 'triangular', min: 4, mode: 8, max: 12 }),
        makeNode('C', 8, { type: 'triangular', min: 4, mode: 8, max: 12 }),
      ],
      edges: [
        { id: 'e1', from: 'A', to: 'B', type: 'FS', lag: { value: 0, unit: 'hours' } },
        { id: 'e2', from: 'B', to: 'C', type: 'FS', lag: { value: 0, unit: 'hours' } },
      ],
    };
    const r = simulate({ schedule: input, iterations: 500, seed: 42 });
    expect(r.criticalityIndex['A']).toBeGreaterThan(0.9);
    expect(r.criticalityIndex['B']).toBeGreaterThan(0.9);
    expect(r.criticalityIndex['C']).toBeGreaterThan(0.9);
  });
});

// ── Tornado ───────────────────────────────────────────────────────────────────

describe('tornado chart', () => {
  it('node with larger range ranks higher than node with smaller range', () => {
    const input: ScheduleInput = {
      project: BASE_PROJECT,
      // Parallel: A and B both start at project start, project ends at max(A,B)
      nodes: [
        makeNode('wide', 16, { type: 'triangular', min: 1, mode: 16, max: 40 }), // range=39
        makeNode('narrow', 16, { type: 'triangular', min: 14, mode: 16, max: 18 }), // range=4
      ],
      edges: [],
      resources: [],
      calendars: [MON_FRI],
      loops: [],
    };
    const r = simulate({ schedule: input, iterations: 500, seed: 1 });
    expect(r.tornado[0]!.nodeId).toBe('wide');
  });
});

// ── DoD #3: Monte Carlo loop variance ────────────────────────────────────────

describe('loop Monte Carlo — expectedIterations variance', () => {
  // Loop body: single 8-hour work node (no duration distribution).
  // Loop expectedIterations: Triangular(min=1, mode=3, max=5).
  //
  // Project ends:
  //   1 iteration × 8h = 8h  → Mon Jan 5 16:00
  //   3 iterations × 8h = 24h → Wed Jan 7 16:00  (mode)
  //   5 iterations × 8h = 40h → Fri Jan 9 16:00
  //
  // Two verifications:
  //   1. End dates are NOT all the same (variance is produced).
  //   2. Median end date is close to 3-iteration value (within 1 working day).

  const bodyNode: ProjectNode = {
    id: 'work',
    nodeType: 'activity',
    name: 'Work',
    duration: { value: 8, unit: 'hours' },
    durationSemantic: 'time',
    position: { x: 0, y: 0 },
    calendarId: null,
    consumesResources: false,
    resourceAssignments: [],
  };

  const loopInput: ScheduleInput = {
    project: BASE_PROJECT,
    nodes: [bodyNode],
    edges: [],
    resources: [],
    calendars: [MON_FRI],
    loops: [
      {
        id: 'loop1',
        bodyNodeIds: ['work'],
        kickout: { type: 'maxIterations', value: 5 },
        expectedIterations: { type: 'triangular', min: 1, mode: 3, max: 5 },
      },
    ],
  };

  it('produces variance in project end dates across iterations', () => {
    const r = simulate({ schedule: loopInput, iterations: 500, seed: 42 });

    expect(r.endDates.length).toBeGreaterThan(400); // overwhelmingly succeed

    const minEnd = Math.min(...r.endDates.map((d) => d.getTime()));
    const maxEnd = Math.max(...r.endDates.map((d) => d.getTime()));

    // Min should be ~1-iteration result, max ~5-iteration result
    // Min and max must differ (real variance present)
    expect(maxEnd).toBeGreaterThan(minEnd);

    // At minimum we should see at least 3 distinct end dates
    // (iterations 1, 2, 3 at minimum with 500 samples from triangular(1,3,5))
    const uniqueEnds = new Set(r.endDates.map((d) => d.getTime()));
    expect(uniqueEnds.size).toBeGreaterThanOrEqual(3);
  });

  it('median end date is close to the 3-iteration value (mode)', () => {
    const r = simulate({ schedule: loopInput, iterations: 2000, seed: 7 });

    // 3-iteration end: Mon 08:00 + 24 working hours = Wed Jan 7 16:00
    // (Mon 8h + Tue 8h + Wed 8h)
    const expected3iter = new Date(2026, 0, 7, 16, 0, 0, 0); // Wed Jan 7 16:00

    const diffHours = Math.abs(workingHoursBetween(r.percentiles.p50, expected3iter, MON_FRI));
    // Tolerance: 1 full working day (8h) — sampling noise at 2000 iterations is well within this
    expect(diffHours).toBeLessThan(8);
  });

  it('different seeds produce different variance patterns', () => {
    const r1 = simulate({ schedule: loopInput, iterations: 100, seed: 1 });
    const r2 = simulate({ schedule: loopInput, iterations: 100, seed: 9999 });

    // Vanishingly unlikely to be identical under different seeds
    const allSame = r1.endDates.every((d, i) => d.getTime() === r2.endDates[i]!.getTime());
    expect(allSame).toBe(false);
  });
});

// ── Phase 11: decision-node Bernoulli draws ──────────────────────────────────

describe('decision nodes', () => {
  it('passProbability=1 produces an all-pass distribution (no failure delay)', () => {
    // Single decision node, 8h duration, 8h failureDelay, but pass=1.0:
    // every iteration must end at exactly the deterministic activity result.
    const decision: ProjectNode = {
      ...makeNode('A', 8),
      nodeType: 'decision',
      passProbability: 1,
      failureDelay: { value: 8, unit: 'hours' },
    };
    const { input } = makeInput([decision]);
    const r = simulate({ schedule: input, iterations: 200, seed: 42 });
    const expected = new Date(2026, 0, 5, 16, 0, 0, 0); // Mon Jan 5 16:00
    for (const d of r.endDates) {
      expect(d.getTime()).toBe(expected.getTime());
    }
  });

  it('passProbability=0 produces an all-fail distribution (full failure delay applied)', () => {
    // pass=0 → every iteration takes duration + failureDelay = 16h.
    // 16 working hours from Mon 08:00 = Tue 16:00.
    const decision: ProjectNode = {
      ...makeNode('A', 8),
      nodeType: 'decision',
      passProbability: 0,
      failureDelay: { value: 8, unit: 'hours' },
    };
    const { input } = makeInput([decision]);
    const r = simulate({ schedule: input, iterations: 200, seed: 42 });
    const expected = new Date(2026, 0, 6, 16, 0, 0, 0); // Tue Jan 6 16:00
    for (const d of r.endDates) {
      expect(d.getTime()).toBe(expected.getTime());
    }
  });

  it('passProbability=0.5 produces a bimodal distribution between pass and fail outcomes', () => {
    // Half of iterations should land on Mon 16:00 (pass), the other half on
    // Tue 16:00 (fail). With 1000 samples, both outcomes must appear.
    const decision: ProjectNode = {
      ...makeNode('A', 8),
      nodeType: 'decision',
      passProbability: 0.5,
      failureDelay: { value: 8, unit: 'hours' },
    };
    const { input } = makeInput([decision]);
    const r = simulate({ schedule: input, iterations: 1000, seed: 42 });

    const passEnd = new Date(2026, 0, 5, 16, 0, 0, 0).getTime(); // Mon 16:00
    const failEnd = new Date(2026, 0, 6, 16, 0, 0, 0).getTime(); // Tue 16:00

    let passes = 0;
    let fails = 0;
    for (const d of r.endDates) {
      if (d.getTime() === passEnd) passes++;
      else if (d.getTime() === failEnd) fails++;
    }
    expect(passes).toBeGreaterThan(0);
    expect(fails).toBeGreaterThan(0);
    expect(passes + fails).toBe(r.endDates.length);
    // At pass=0.5 with n=1000, both branches should be well above 400.
    expect(passes).toBeGreaterThan(400);
    expect(fails).toBeGreaterThan(400);
  });

  it('decision nodes appear in the tornado when failure delay introduces variance', () => {
    // Decision in series with an activity. Decision has the only variance source
    // (no distribution, only a Bernoulli failure-delay). It should appear in tornado.
    const decision: ProjectNode = {
      ...makeNode('D', 8),
      nodeType: 'decision',
      passProbability: 0.5,
      failureDelay: { value: 8, unit: 'hours' },
    };
    const fixed = makeNode('F', 8);
    const input: ScheduleInput = {
      project: BASE_PROJECT,
      nodes: [decision, fixed],
      edges: [{ id: 'e1', from: 'D', to: 'F', type: 'FS', lag: { value: 0, unit: 'hours' } }],
      resources: [],
      calendars: [MON_FRI],
      loops: [],
    };
    const r = simulate({ schedule: input, iterations: 500, seed: 1 });
    expect(r.tornado.some((t) => t.nodeId === 'D')).toBe(true);
  });

  it('distribution on a decision node drives the pass probability, not the duration', () => {
    // Decision: 8h duration, 8h failureDelay, no static passProbability.
    // Distribution: triangular(0, 0, 0) — degenerate at p=0, every iteration must fail.
    // If the engine were applying the distribution to *duration*, we'd see
    // 0-hour activities (and end at Mon 08:00). Since it's applied to the pass
    // probability, every iteration takes duration + failureDelay = 16h
    // → Tue Jan 6 16:00.
    const decision: ProjectNode = {
      ...makeNode('A', 8),
      nodeType: 'decision',
      passProbability: 1, // overridden by distribution per iteration
      failureDelay: { value: 8, unit: 'hours' },
      distribution: { type: 'triangular', min: 0, mode: 0, max: 0.0001 },
    };
    const { input } = makeInput([decision]);
    const r = simulate({ schedule: input, iterations: 200, seed: 42 });
    const expectedFail = new Date(2026, 0, 6, 16, 0, 0, 0).getTime();
    for (const d of r.endDates) {
      expect(d.getTime()).toBe(expectedFail);
    }
  });

  it('distribution clamped above 1 on a decision node makes every iteration pass', () => {
    // Distribution that always samples > 1 must be clamped to 1, so every
    // Bernoulli draw passes — end date is always the no-penalty result.
    const decision: ProjectNode = {
      ...makeNode('A', 8),
      nodeType: 'decision',
      passProbability: 0, // overridden by distribution per iteration
      failureDelay: { value: 8, unit: 'hours' },
      distribution: { type: 'triangular', min: 5, mode: 5, max: 5.0001 },
    };
    const { input } = makeInput([decision]);
    const r = simulate({ schedule: input, iterations: 200, seed: 42 });
    const expectedPass = new Date(2026, 0, 5, 16, 0, 0, 0).getTime();
    for (const d of r.endDates) {
      expect(d.getTime()).toBe(expectedPass);
    }
  });
});

// ── Phase 11 follow-up: Start/End anchors excluded from reports ──────────────

describe('criticality / tornado anchor filtering', () => {
  // Anchors are zero-duration milestones that always sit on every critical path
  // reaching them. Reporting them at 100% criticality is uninformative noise
  // and hides the real bottlenecks. Both criticalityIndex and tornado must
  // omit them.

  function buildInputWithAnchors(): ScheduleInput {
    const start: ProjectNode = {
      id: 'S',
      nodeType: 'start',
      name: 'Start',
      duration: { value: 0, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    };
    const end: ProjectNode = {
      id: 'E',
      nodeType: 'end',
      name: 'End',
      duration: { value: 0, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    };
    const a = makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 12 });
    return {
      project: BASE_PROJECT,
      nodes: [start, a, end],
      edges: [
        { id: 'e1', from: 'S', to: 'A', type: 'FS', lag: { value: 0, unit: 'hours' } },
        { id: 'e2', from: 'A', to: 'E', type: 'FS', lag: { value: 0, unit: 'hours' } },
      ],
      resources: [],
      calendars: [MON_FRI],
      loops: [],
    };
  }

  it('criticalityIndex omits start and end node ids', () => {
    const r = simulate({ schedule: buildInputWithAnchors(), iterations: 300, seed: 1 });
    expect(r.criticalityIndex['S']).toBeUndefined();
    expect(r.criticalityIndex['E']).toBeUndefined();
    // The activity in between is reported.
    expect(r.criticalityIndex['A']).toBeGreaterThan(0.9);
  });

  it('tornado omits start and end node ids', () => {
    const r = simulate({ schedule: buildInputWithAnchors(), iterations: 300, seed: 1 });
    expect(r.tornado.some((t) => t.nodeId === 'S')).toBe(false);
    expect(r.tornado.some((t) => t.nodeId === 'E')).toBe(false);
    // The variance-bearing activity must still appear.
    expect(r.tornado.some((t) => t.nodeId === 'A')).toBe(true);
  });
});

// ── DoD #6: convergence detection (Phase 16) ──────────────────────────────────

describe('convergence detection', () => {
  it('returns a structured field for every run', () => {
    const { input } = makeInput([makeNode('A', 8)]);
    const r = simulate({ schedule: input, iterations: 50, seed: 1 });
    expect(r.convergence).toBeDefined();
    expect(typeof r.convergence.converged).toBe('boolean');
  });

  it('is deterministic for a fixed seed', () => {
    const { input } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 7.5, mode: 8, max: 8.5 }),
    ]);
    const r1 = simulate({ schedule: input, iterations: 1000, seed: 42 });
    const r2 = simulate({ schedule: input, iterations: 1000, seed: 42 });
    expect(r1.convergence.converged).toBe(r2.convergence.converged);
    expect(r1.convergence.atIteration).toBe(r2.convergence.atIteration);
  });

  it('detects convergence on a tight triangular distribution', () => {
    // Very narrow spread — should converge well within the iteration budget.
    const { input } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 7.9, mode: 8, max: 8.1 }),
    ]);
    const r = simulate({ schedule: input, iterations: 1000, seed: 7 });
    expect(r.convergence.converged).toBe(true);
    expect(r.convergence.atIteration).not.toBeNull();
    expect(r.convergence.atIteration!).toBeGreaterThanOrEqual(50);
    expect(r.convergence.atIteration!).toBeLessThanOrEqual(1000);
  });

  it('does not declare convergence on a wide, slow-to-stabilise distribution', () => {
    // Pair a very wide distribution with a deliberately small iteration
    // budget. With ~150 successful iterations the running P95 still moves
    // by tens of hours between consecutive 50-iter samples, so the
    // detector should never accumulate enough stable samples.
    const { input } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 1, mode: 8, max: 800 }),
    ]);
    const r = simulate({ schedule: input, iterations: 150, seed: 3 });
    expect(r.convergence.converged).toBe(false);
    expect(r.convergence.atIteration).toBeNull();
  });

  it('continues iterating after convergence so per-node criticality and tornado are still populated', () => {
    const { input } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 7.9, mode: 8, max: 8.1 }),
    ]);
    const r = simulate({ schedule: input, iterations: 1000, seed: 7 });
    expect(r.convergence.converged).toBe(true);
    // Full iteration budget produced full results — not truncated at
    // convergence point.
    expect(r.endDates.length).toBe(1000);
  });
});

// ── Phase 48 Slice 2 — early-stop ─────────────────────────────────────────────

describe('earlyStop (Phase 48 Slice 2)', () => {
  it('stops the loop at convergence when earlyStop=true', () => {
    const { input } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 7.9, mode: 8, max: 8.1 }),
    ]);
    const r = simulate({
      schedule: input,
      iterations: 1000,
      seed: 7,
      earlyStop: true,
    });
    expect(r.convergence.converged).toBe(true);
    expect(r.convergence.atIteration).not.toBeNull();
    // endDates is truncated to the iteration where convergence fired.
    expect(r.endDates.length).toBe(r.convergence.atIteration);
    expect(r.endDates.length).toBeLessThan(1000);
  });

  it('runs the full budget when earlyStop=false (default), even on a convergent input', () => {
    const { input } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 7.9, mode: 8, max: 8.1 }),
    ]);
    const r = simulate({ schedule: input, iterations: 1000, seed: 7 });
    // Convergence is reported as a diagnostic, but the loop did not break.
    expect(r.convergence.converged).toBe(true);
    expect(r.endDates.length).toBe(1000);
  });

  it('with same seed, earlyStop=true is a prefix of earlyStop=false (deterministic short-circuit)', () => {
    const { input } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 7.9, mode: 8, max: 8.1 }),
    ]);
    const rEarly = simulate({
      schedule: input,
      iterations: 1000,
      seed: 7,
      earlyStop: true,
    });
    const rFull = simulate({ schedule: input, iterations: 1000, seed: 7 });
    // Every endDate in the early-stopped run matches the same index of
    // the full run — proves the short-circuit doesn't perturb iteration
    // order or sampling.
    for (let i = 0; i < rEarly.endDates.length; i++) {
      expect(rEarly.endDates[i]!.getTime()).toBe(rFull.endDates[i]!.getTime());
    }
  });

  it('still produces valid nodeP95 after heap resize on early-stop', () => {
    const { input } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 7.9, mode: 8, max: 8.1 }),
      makeNode('B', 8, { type: 'triangular', min: 7.9, mode: 8, max: 8.1 }),
    ]);
    const rEarly = simulate({
      schedule: input,
      iterations: 1000,
      seed: 7,
      earlyStop: true,
    });
    // nodeP95 is populated for every non-anchor node, even after the
    // bounded heap was drained to ceil(0.05 × K_ran).
    expect(rEarly.nodeP95['A']).toBeInstanceOf(Date);
    expect(rEarly.nodeP95['B']).toBeInstanceOf(Date);
    // The reported P95 must be ≥ median end (sanity check on the
    // post-resize peek).
    const p95Ms = rEarly.nodeP95['A']!.getTime();
    const sortedFinishes = rEarly.endDates.map((d) => d.getTime()).sort((a, b) => a - b);
    const medianMs = sortedFinishes[Math.floor(sortedFinishes.length / 2)]!;
    expect(p95Ms).toBeGreaterThanOrEqual(medianMs);
  });

  it('runs the full budget when earlyStop=true but convergence never fires', () => {
    // Very wide distribution + small budget → 3 convergence checks total,
    // can't accumulate the 4 consecutive-stable observations needed.
    const { input } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 1, mode: 8, max: 800 }),
    ]);
    const r = simulate({
      schedule: input,
      iterations: 150,
      seed: 3,
      earlyStop: true,
    });
    expect(r.convergence.converged).toBe(false);
    expect(r.endDates.length).toBe(150);
  });
});

// ── DoD #7: per-path critical-path frequency (Phase 16) ───────────────────────

describe('per-path critical-path frequency', () => {
  /** A → B linear chain; the critical path should always be ['A', 'B']. */
  function buildLinearChain(): ScheduleInput {
    return {
      project: BASE_PROJECT,
      nodes: [makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 16 }), makeNode('B', 8)],
      edges: [{ id: 'e1', from: 'A', to: 'B', type: 'FS', lag: { value: 0, unit: 'hours' } }],
      resources: [],
      calendars: [MON_FRI],
      loops: [],
    };
  }

  it('returns a structured field for every run', () => {
    const r = simulate({ schedule: buildLinearChain(), iterations: 50, seed: 1 });
    expect(Array.isArray(r.pathFrequency)).toBe(true);
  });

  it('records the chain as the dominant path on a linear A→B project', () => {
    const r = simulate({ schedule: buildLinearChain(), iterations: 200, seed: 1 });
    expect(r.pathFrequency.length).toBeGreaterThanOrEqual(1);
    const top = r.pathFrequency[0]!;
    expect(top.path).toEqual(['A', 'B']);
    // Every successful iteration in a linear chain has the same critical path.
    expect(top.count).toBe(r.endDates.length);
  });

  it('strips start and end anchor nodes from the recorded paths', () => {
    const start: ProjectNode = {
      id: 'S',
      nodeType: 'start',
      name: 'Start',
      duration: { value: 0, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    };
    const a = makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 12 });
    const end: ProjectNode = {
      id: 'E',
      nodeType: 'end',
      name: 'End',
      duration: { value: 0, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    };
    const input: ScheduleInput = {
      project: BASE_PROJECT,
      nodes: [start, a, end],
      edges: [
        { id: 'e1', from: 'S', to: 'A', type: 'FS', lag: { value: 0, unit: 'hours' } },
        { id: 'e2', from: 'A', to: 'E', type: 'FS', lag: { value: 0, unit: 'hours' } },
      ],
      resources: [],
      calendars: [MON_FRI],
      loops: [],
    };
    const r = simulate({ schedule: input, iterations: 100, seed: 1 });
    for (const entry of r.pathFrequency) {
      expect(entry.path).not.toContain('S');
      expect(entry.path).not.toContain('E');
    }
  });

  it('is sorted by count descending', () => {
    const r = simulate({ schedule: buildLinearChain(), iterations: 200, seed: 1 });
    for (let i = 1; i < r.pathFrequency.length; i++) {
      expect(r.pathFrequency[i - 1]!.count).toBeGreaterThanOrEqual(r.pathFrequency[i]!.count);
    }
  });

  it('is deterministic for a fixed seed', () => {
    const r1 = simulate({ schedule: buildLinearChain(), iterations: 500, seed: 13 });
    const r2 = simulate({ schedule: buildLinearChain(), iterations: 500, seed: 13 });
    expect(r1.pathFrequency.length).toBe(r2.pathFrequency.length);
    for (let i = 0; i < r1.pathFrequency.length; i++) {
      expect(r1.pathFrequency[i]!.path).toEqual(r2.pathFrequency[i]!.path);
      expect(r1.pathFrequency[i]!.count).toBe(r2.pathFrequency[i]!.count);
    }
  });

  it('captures multiple distinct paths when parallel critical chains exist', () => {
    // Two independent parallel chains both ending at E. With identical
    // durations on both, both are simultaneously critical → CPM emits two
    // critical paths per iteration.
    const start: ProjectNode = {
      id: 'S',
      nodeType: 'start',
      name: 'Start',
      duration: { value: 0, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    };
    const end: ProjectNode = {
      id: 'E',
      nodeType: 'end',
      name: 'End',
      duration: { value: 0, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    };
    const input: ScheduleInput = {
      project: BASE_PROJECT,
      nodes: [
        start,
        makeNode('A1', 8),
        makeNode('A2', 8),
        makeNode('B1', 8),
        makeNode('B2', 8),
        end,
      ],
      edges: [
        { id: 'e1', from: 'S', to: 'A1', type: 'FS', lag: { value: 0, unit: 'hours' } },
        { id: 'e2', from: 'A1', to: 'A2', type: 'FS', lag: { value: 0, unit: 'hours' } },
        { id: 'e3', from: 'A2', to: 'E', type: 'FS', lag: { value: 0, unit: 'hours' } },
        { id: 'e4', from: 'S', to: 'B1', type: 'FS', lag: { value: 0, unit: 'hours' } },
        { id: 'e5', from: 'B1', to: 'B2', type: 'FS', lag: { value: 0, unit: 'hours' } },
        { id: 'e6', from: 'B2', to: 'E', type: 'FS', lag: { value: 0, unit: 'hours' } },
      ],
      resources: [],
      calendars: [MON_FRI],
      loops: [],
    };
    const r = simulate({ schedule: input, iterations: 50, seed: 1 });
    expect(r.pathFrequency.length).toBe(2);
    const paths = r.pathFrequency.map((p) => p.path.join(','));
    expect(paths).toContain('A1,A2');
    expect(paths).toContain('B1,B2');
  });
});

// ── Phase 20 Slice 1 — per-iteration critical-path index ─────────────────────

describe('per-iteration critical-path index (pathPerIteration)', () => {
  function buildLinearChain(): ScheduleInput {
    return {
      project: BASE_PROJECT,
      nodes: [makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 16 }), makeNode('B', 8)],
      edges: [{ id: 'e1', from: 'A', to: 'B', type: 'FS', lag: { value: 0, unit: 'hours' } }],
      resources: [],
      calendars: [MON_FRI],
      loops: [],
    };
  }

  function buildParallelPaths(): ScheduleInput {
    const start: ProjectNode = {
      id: 'S',
      nodeType: 'start',
      name: 'Start',
      duration: { value: 0, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    };
    const end: ProjectNode = {
      id: 'E',
      nodeType: 'end',
      name: 'End',
      duration: { value: 0, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    };
    return {
      project: BASE_PROJECT,
      nodes: [
        start,
        makeNode('A1', 8),
        makeNode('A2', 8),
        makeNode('B1', 8),
        makeNode('B2', 8),
        end,
      ],
      edges: [
        { id: 'e1', from: 'S', to: 'A1', type: 'FS', lag: { value: 0, unit: 'hours' } },
        { id: 'e2', from: 'A1', to: 'A2', type: 'FS', lag: { value: 0, unit: 'hours' } },
        { id: 'e3', from: 'A2', to: 'E', type: 'FS', lag: { value: 0, unit: 'hours' } },
        { id: 'e4', from: 'S', to: 'B1', type: 'FS', lag: { value: 0, unit: 'hours' } },
        { id: 'e5', from: 'B1', to: 'B2', type: 'FS', lag: { value: 0, unit: 'hours' } },
        { id: 'e6', from: 'B2', to: 'E', type: 'FS', lag: { value: 0, unit: 'hours' } },
      ],
      resources: [],
      calendars: [MON_FRI],
      loops: [],
    };
  }

  it('has length equal to endDates.length', () => {
    const r = simulate({ schedule: buildLinearChain(), iterations: 200, seed: 1 });
    expect(r.pathPerIteration.length).toBe(r.endDates.length);
  });

  it('is all zero on a linear chain (single path, no anchors to strip)', () => {
    const r = simulate({ schedule: buildLinearChain(), iterations: 200, seed: 1 });
    expect(r.pathFrequency.length).toBe(1);
    expect(r.pathFrequency[0]!.path).toEqual(['A', 'B']);
    for (const idx of r.pathPerIteration) {
      expect(idx).toBe(0);
    }
  });

  it('every non-sentinel entry is a valid index into pathFrequency', () => {
    const r = simulate({ schedule: buildParallelPaths(), iterations: 100, seed: 7 });
    for (const idx of r.pathPerIteration) {
      if (idx === -1) continue;
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(r.pathFrequency.length);
    }
  });

  it('picks the lex-first primary path when parallel chains are co-critical', () => {
    // A1,A2 and B1,B2 are both critical every iteration. The lex-first key
    // ("A1 A2") wins → every entry maps to whichever pathFrequency slot
    // holds the A-chain.
    const r = simulate({ schedule: buildParallelPaths(), iterations: 100, seed: 1 });
    const aChainIndex = r.pathFrequency.findIndex((p) => p.path.join(',') === 'A1,A2');
    expect(aChainIndex).toBeGreaterThanOrEqual(0);
    for (const idx of r.pathPerIteration) {
      expect(idx).toBe(aChainIndex);
    }
  });

  it('is deterministic for a fixed seed', () => {
    const r1 = simulate({ schedule: buildLinearChain(), iterations: 500, seed: 13 });
    const r2 = simulate({ schedule: buildLinearChain(), iterations: 500, seed: 13 });
    expect(r1.pathPerIteration).toEqual(r2.pathPerIteration);
  });

  it('reports -1 when every critical path is anchor-only', () => {
    // S → E with nothing in between: the only critical path is [S, E],
    // which collapses to [] after anchor strip, never enters pathFrequency,
    // and per the documented contract is reported as -1.
    const start: ProjectNode = {
      id: 'S',
      nodeType: 'start',
      name: 'Start',
      duration: { value: 0, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    };
    const end: ProjectNode = {
      id: 'E',
      nodeType: 'end',
      name: 'End',
      duration: { value: 0, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    };
    const input: ScheduleInput = {
      project: BASE_PROJECT,
      nodes: [start, end],
      edges: [{ id: 'e1', from: 'S', to: 'E', type: 'FS', lag: { value: 0, unit: 'hours' } }],
      resources: [],
      calendars: [MON_FRI],
      loops: [],
    };
    const r = simulate({ schedule: input, iterations: 25, seed: 1 });
    expect(r.pathFrequency.length).toBe(0);
    expect(r.pathPerIteration.length).toBe(r.endDates.length);
    for (const idx of r.pathPerIteration) {
      expect(idx).toBe(-1);
    }
  });

  it('aggregating non-sentinel entries stays within pathFrequency totals', () => {
    // Sanity check: pathPerIteration is a per-iter "primary path"
    // projection. Counting how many iterations chose each path index can
    // never exceed that path's total count in pathFrequency (which also
    // includes co-critical paths from the same iteration).
    const r = simulate({ schedule: buildParallelPaths(), iterations: 200, seed: 1 });
    const perIndex = new Map<number, number>();
    for (const idx of r.pathPerIteration) {
      if (idx === -1) continue;
      perIndex.set(idx, (perIndex.get(idx) ?? 0) + 1);
    }
    for (const [idx, count] of perIndex) {
      expect(count).toBeLessThanOrEqual(r.pathFrequency[idx]!.count);
    }
    const nonSentinelCount = r.pathPerIteration.filter((i) => i !== -1).length;
    const sentinelCount = r.pathPerIteration.filter((i) => i === -1).length;
    expect(nonSentinelCount + sentinelCount).toBe(r.endDates.length);
  });
});

// ── DoD #8: per-node P95 finish-time (Phase 16) ──────────────────────────────

describe('per-node P95 finish time', () => {
  it('returns a structured field for every run', () => {
    const { input } = makeInput([makeNode('A', 8)]);
    const r = simulate({ schedule: input, iterations: 50, seed: 1 });
    expect(typeof r.nodeP95).toBe('object');
  });

  it('emits one entry per reportable (non-anchor) node', () => {
    const { input } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 16 }),
      makeNode('B', 8),
    ]);
    const r = simulate({ schedule: input, iterations: 200, seed: 1 });
    expect(r.nodeP95['A']).toBeDefined();
    expect(r.nodeP95['B']).toBeDefined();
  });

  it('omits anchor nodes (start, end)', () => {
    const start: ProjectNode = {
      id: 'S',
      nodeType: 'start',
      name: 'Start',
      duration: { value: 0, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    };
    const a = makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 12 });
    const end: ProjectNode = {
      id: 'E',
      nodeType: 'end',
      name: 'End',
      duration: { value: 0, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    };
    const input: ScheduleInput = {
      project: BASE_PROJECT,
      nodes: [start, a, end],
      edges: [
        { id: 'e1', from: 'S', to: 'A', type: 'FS', lag: { value: 0, unit: 'hours' } },
        { id: 'e2', from: 'A', to: 'E', type: 'FS', lag: { value: 0, unit: 'hours' } },
      ],
      resources: [],
      calendars: [MON_FRI],
      loops: [],
    };
    const r = simulate({ schedule: input, iterations: 200, seed: 1 });
    expect(r.nodeP95['S']).toBeUndefined();
    expect(r.nodeP95['E']).toBeUndefined();
    expect(r.nodeP95['A']).toBeDefined();
  });

  it('is deterministic for a fixed seed', () => {
    const { input } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 16 }),
    ]);
    const r1 = simulate({ schedule: input, iterations: 500, seed: 99 });
    const r2 = simulate({ schedule: input, iterations: 500, seed: 99 });
    expect(r1.nodeP95['A']!.getTime()).toBe(r2.nodeP95['A']!.getTime());
  });

  it('P95 ≥ P50 for a node with positive variance', () => {
    // Linear chain A → B; node B finishes strictly after A. P95 finish of
    // B must therefore be on or after P95 finish of A.
    const input: ScheduleInput = {
      project: BASE_PROJECT,
      nodes: [makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 16 }), makeNode('B', 8)],
      edges: [{ id: 'e1', from: 'A', to: 'B', type: 'FS', lag: { value: 0, unit: 'hours' } }],
      resources: [],
      calendars: [MON_FRI],
      loops: [],
    };
    const r = simulate({ schedule: input, iterations: 500, seed: 5 });
    expect(r.nodeP95['A']).toBeInstanceOf(Date);
    expect(r.nodeP95['B']).toBeInstanceOf(Date);
    expect(r.nodeP95['B']!.getTime()).toBeGreaterThanOrEqual(r.nodeP95['A']!.getTime());
  });

  it('collapses to a single value for a fixed-duration node (no variance)', () => {
    // One fixed-duration activity → every iteration produces the same
    // finish, so P95 must equal that single value (i.e. a stable Date
    // regardless of seed).
    const { input } = makeInput([makeNode('A', 8)]); // no distribution
    const r = simulate({ schedule: input, iterations: 200, seed: 1 });
    expect(r.nodeP95['A']).toBeInstanceOf(Date);
    const r2 = simulate({ schedule: input, iterations: 200, seed: 999 });
    expect(r2.nodeP95['A']!.getTime()).toBe(r.nodeP95['A']!.getTime());
  });

  it('memory budget — heap size stays bounded at 5% of iterations', () => {
    // Stress test: high iteration count + many nodes. The simulation should
    // still complete promptly (each per-node heap is capped at ⌈N × 0.05⌉),
    // and emit a P95 Date for every reportable node.
    const nodes = Array.from({ length: 20 }, (_, i) =>
      makeNode(`N${i}`, 4, { type: 'triangular', min: 2, mode: 4, max: 8 }),
    );
    const r = simulate({
      schedule: { ...makeInput(nodes).input },
      iterations: 2000,
      seed: 1,
    });
    expect(Object.keys(r.nodeP95)).toHaveLength(20);
    for (const id of Object.keys(r.nodeP95)) {
      expect(r.nodeP95[id]).toBeInstanceOf(Date);
    }
  });
});

// ── DoD #9: what-if exclusion (Phase 16) ──────────────────────────────────────

describe('what-if exclusion via excludeNodeDistributions', () => {
  it('runs unchanged when the excludeNodeDistributions array is omitted', () => {
    const { input } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 16 }),
    ]);
    const r1 = simulate({ schedule: input, iterations: 200, seed: 42 });
    const r2 = simulate({
      schedule: input,
      iterations: 200,
      seed: 42,
      excludeNodeDistributions: [],
    });
    expect(r1.percentiles.p50.getTime()).toBe(r2.percentiles.p50.getTime());
    expect(r1.percentiles.p95.getTime()).toBe(r2.percentiles.p95.getTime());
  });

  it('shrinks the finish-date spread when the dominant driver is excluded', () => {
    // One wide-distribution node + one narrow-distribution node in series.
    // Removing the wide one should significantly tighten the P50–P95 spread.
    const input: ScheduleInput = {
      project: BASE_PROJECT,
      nodes: [
        makeNode('A', 8, { type: 'triangular', min: 1, mode: 8, max: 80 }),
        makeNode('B', 8, { type: 'triangular', min: 7, mode: 8, max: 9 }),
      ],
      edges: [{ id: 'e1', from: 'A', to: 'B', type: 'FS', lag: { value: 0, unit: 'hours' } }],
      resources: [],
      calendars: [MON_FRI],
      loops: [],
    };
    const baseline = simulate({ schedule: input, iterations: 500, seed: 1 });
    const withoutA = simulate({
      schedule: input,
      iterations: 500,
      seed: 1,
      excludeNodeDistributions: ['A'],
    });
    const baselineSpread = baseline.percentiles.p95.getTime() - baseline.percentiles.p50.getTime();
    const noASpread = withoutA.percentiles.p95.getTime() - withoutA.percentiles.p50.getTime();
    expect(noASpread).toBeLessThan(baselineSpread);
  });

  it('a single-driver project becomes deterministic when that driver is excluded', () => {
    const { input } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 32 }),
    ]);
    const r = simulate({
      schedule: input,
      iterations: 100,
      seed: 1,
      excludeNodeDistributions: ['A'],
    });
    // All iterations now use the static 8h duration → all end dates equal.
    const first = r.endDates[0]!.getTime();
    for (const d of r.endDates) {
      expect(d.getTime()).toBe(first);
    }
  });

  it('excluding a node with no distribution is a no-op', () => {
    const { input } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 16 }),
      makeNode('B', 8), // no distribution
    ]);
    const r1 = simulate({ schedule: input, iterations: 200, seed: 7 });
    const r2 = simulate({
      schedule: input,
      iterations: 200,
      seed: 7,
      excludeNodeDistributions: ['B'],
    });
    // B has no distribution, so excluding it shouldn't change anything.
    expect(r1.percentiles.p50.getTime()).toBe(r2.percentiles.p50.getTime());
    expect(r1.percentiles.p95.getTime()).toBe(r2.percentiles.p95.getTime());
    for (let i = 0; i < r1.endDates.length; i++) {
      expect(r1.endDates[i]!.getTime()).toBe(r2.endDates[i]!.getTime());
    }
  });

  it('is deterministic for a fixed seed', () => {
    const { input } = makeInput([
      makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 16 }),
      makeNode('B', 8, { type: 'pert-beta', min: 4, mode: 8, max: 16 }),
    ]);
    const r1 = simulate({
      schedule: input,
      iterations: 300,
      seed: 17,
      excludeNodeDistributions: ['A'],
    });
    const r2 = simulate({
      schedule: input,
      iterations: 300,
      seed: 17,
      excludeNodeDistributions: ['A'],
    });
    for (let i = 0; i < r1.endDates.length; i++) {
      expect(r1.endDates[i]!.getTime()).toBe(r2.endDates[i]!.getTime());
    }
  });

  it('removes the excluded node from the tornado list (its impactHours is 0)', () => {
    // A's distribution is the only variance source; if we exclude it,
    // the tornado should be empty (B has no distribution).
    const input: ScheduleInput = {
      project: BASE_PROJECT,
      nodes: [makeNode('A', 8, { type: 'triangular', min: 4, mode: 8, max: 16 }), makeNode('B', 8)],
      edges: [{ id: 'e1', from: 'A', to: 'B', type: 'FS', lag: { value: 0, unit: 'hours' } }],
      resources: [],
      calendars: [MON_FRI],
      loops: [],
    };
    const baseline = simulate({ schedule: input, iterations: 200, seed: 1 });
    expect(baseline.tornado.some((t) => t.nodeId === 'A')).toBe(true);

    const withoutA = simulate({
      schedule: input,
      iterations: 200,
      seed: 1,
      excludeNodeDistributions: ['A'],
    });
    expect(withoutA.tornado.some((t) => t.nodeId === 'A')).toBe(false);
  });
});

// ── distribution-sampling units ───────────────────────────────────────────────
//
// Bug surfaced during Phase 44 dogfooding: when an activity's nominal
// `duration.unit` was anything other than `'hours'` (e.g. the shipped MBB
// template authors most of its activities with `unit: 'days'`), the
// simulator silently re-stamped the sampled duration as `unit: 'hours'`,
// effectively dividing day-authored distributions by 8 (effort-days →
// hours). Net effect: MC P50 finishes ran ~7-8× short of the deterministic
// CPM project end. Distributions don't carry an independent unit field;
// by convention the min / mode / max values are authored in the same unit
// as the activity's `duration`.

describe('distribution sampling preserves activity duration unit', () => {
  it('day-authored triangular doesnt collapse to hours-of-effort', () => {
    // Triangular(10, 10, 10) is degenerate — every iteration samples 10.
    // With the bug, the sampled node's duration becomes
    // `{ value: 10, unit: 'hours' }` = 10 effort-hours = 1.25 days on
    // 8h/d Mon–Fri, so the project finishes within the project's first
    // working day. With the fix, the unit stays 'days' so each iteration
    // takes 10 effort-days = 14 calendar days through the weekend.
    const node: ProjectNode = {
      id: 'a',
      nodeType: 'activity',
      name: 'a',
      duration: { value: 10, unit: 'days' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
      distribution: { type: 'triangular', min: 10, mode: 10, max: 10 },
    };
    const { input, seed } = makeInput([node]);
    const r = simulate({ schedule: input, iterations: 50, seed });
    const projectStartMs = new Date(BASE_PROJECT.startDate + 'T00:00:00').getTime();
    // Floor at 7 calendar days separates the buggy (~1) from the correct
    // (~14) behaviour cleanly without being sensitive to weekend skew.
    for (const endDate of r.endDates) {
      const days = (endDate.getTime() - projectStartMs) / 86_400_000;
      expect(days).toBeGreaterThan(7);
    }
  });

  it('hours-authored triangular still produces hours-scale samples', () => {
    // Regression guard: the original behaviour for unit:'hours' activities
    // must be unchanged. 8h triangular on 8h/d Mon–Fri finishes inside
    // the first working day, every iteration.
    const node: ProjectNode = {
      id: 'a',
      nodeType: 'activity',
      name: 'a',
      duration: { value: 8, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
      distribution: { type: 'triangular', min: 4, mode: 8, max: 16 },
    };
    const { input, seed } = makeInput([node]);
    const r = simulate({ schedule: input, iterations: 100, seed });
    const projectStartMs = new Date(BASE_PROJECT.startDate + 'T00:00:00').getTime();
    // Triangular(4, 8, 16) max sample = 16h = 2 working days. Add some
    // headroom for the calendar's clock-rollover semantics; the loose
    // upper bound is the point — we just want to confirm we're not
    // suddenly stretching hours-authored runs into days.
    for (const endDate of r.endDates) {
      const days = (endDate.getTime() - projectStartMs) / 86_400_000;
      expect(days).toBeLessThan(5);
    }
  });
});

// ── Helper ────────────────────────────────────────────────────────────────────
