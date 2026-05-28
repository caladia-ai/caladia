import { describe, it, expect } from 'vitest';
import type {
  Calendar,
  Loop,
  ProjectEdge,
  ProjectNode,
  Resource,
  Subsystem,
} from '@procsim/file-format';
import { schedule } from './index.js';
import type { ScheduleInput } from './index.js';

// ── Phase 19 slice 1 — deterministic cost engine tests ───────────────────────
//
// The cost pass runs after CPM and the resource timeline build. It walks
// the post-flatten nodes once, charges each one (resources × hours × count +
// per-use + fixed), then rolls body sums back to sub-system containers.
//
// Fixtures intentionally use small, hand-computable numbers so the worked
// totals in test descriptions stay readable.

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

const START_DATE = '2026-01-05';

function makeInput(opts: {
  nodes: ProjectNode[];
  edges?: ProjectEdge[];
  resources: Resource[];
  loops?: Loop[];
  subsystems?: Subsystem[];
}): ScheduleInput {
  const base: ScheduleInput = {
    project: {
      name: 'Test',
      startDate: START_DATE,
      defaultCalendarId: MON_FRI.id,
      displayUnit: 'days',
      shareMode: 'percentage',
    },
    nodes: opts.nodes,
    edges: opts.edges ?? [],
    resources: opts.resources,
    calendars: [MON_FRI],
    loops: opts.loops ?? [],
  };
  return opts.subsystems !== undefined ? { ...base, subsystems: opts.subsystems } : base;
}

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

describe('computeCosts (deterministic)', () => {
  it('produces zero cost when no resource has rates and no node has fixedCost', () => {
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 1, calendarId: MON_FRI.id }],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.projectCost).toBe(0);
      expect(out.result.nodeCosts.a1).toEqual({
        fromResources: 0,
        fromFixed: 0,
        fromCrash: 0,
        total: 0,
      });
      expect(out.result.resourceCosts).toEqual({});
    }
  });

  it('worked example: rate × hours × count + costPerUse + fixedCost = total', () => {
    // 1 activity, 8 hours, 1 resource @ $100/hr + $50/use, count=1, fixed cost $20.
    // Expected: 100 × 8 × 1 + 50 + 20 = 870.
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
          fixedCost: { value: 20 },
        }),
      ],
      resources: [
        {
          id: 'r1',
          name: 'Dev',
          capacity: 1,
          calendarId: MON_FRI.id,
          costRate: 100,
          costPerUse: 50,
        },
      ],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.nodeCosts.a1).toEqual({
        fromResources: 850, // 100 × 8 + 50
        fromFixed: 20,
        fromCrash: 0,
        total: 870,
      });
      expect(out.result.resourceCosts.r1).toBe(850);
      expect(out.result.projectCost).toBe(870);
    }
  });

  it('scales rate-cost by resource count', () => {
    // 1 activity, 4 hours, 2 of resource @ $100/hr + $25/use.
    // Expected: 100 × 4 × 2 + 25 × 2 = 850.
    const input = makeInput({
      nodes: [
        activity('a1', 4, {
          resourceAssignments: [{ resourceId: 'r1', count: 2, calendarPolicy: 'intersection' }],
        }),
      ],
      resources: [
        {
          id: 'r1',
          name: 'Dev',
          capacity: 4,
          calendarId: MON_FRI.id,
          costRate: 100,
          costPerUse: 25,
        },
      ],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.nodeCosts.a1?.fromResources).toBe(850);
      expect(out.result.projectCost).toBe(850);
    }
  });

  it('skips resource cost for nodes with consumesResources=false', () => {
    // A wait-state node with a fixedCost should still charge the fixed
    // cost, but never charge any resource hours.
    const input = makeInput({
      nodes: [
        {
          ...activity('wait', 4),
          consumesResources: false,
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
          fixedCost: { value: 200 },
        },
      ],
      resources: [
        {
          id: 'r1',
          name: 'Dev',
          capacity: 1,
          calendarId: MON_FRI.id,
          costRate: 100,
          costPerUse: 50,
        },
      ],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.nodeCosts.wait?.fromResources).toBe(0);
      expect(out.result.nodeCosts.wait?.fromFixed).toBe(200);
      expect(out.result.resourceCosts).toEqual({});
      expect(out.result.projectCost).toBe(200);
    }
  });

  // ── Loop body scaling ──────────────────────────────────────────────────────

  it('scales loop-body costs by deterministicIterationCount (per-iteration default)', () => {
    // maxIterations: 3, so deterministic count = 3.
    // Body node: 8h, $100/hr × 1, fixedCost 10.
    // Per iteration: rate cost 100 × 8 × 1 = 800; fixed 10.
    // Per-use fires ONCE per assignment (not per iter): 50 × 1 = 50.
    // Total: (800 × 3) + 50 + (10 × 3) = 2400 + 50 + 30 = 2480.
    const input = makeInput({
      nodes: [
        activity('body', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
          fixedCost: { value: 10 },
        }),
      ],
      resources: [
        {
          id: 'r1',
          name: 'Dev',
          capacity: 1,
          calendarId: MON_FRI.id,
          costRate: 100,
          costPerUse: 50,
        },
      ],
      loops: [
        {
          id: 'L1',
          bodyNodeIds: ['body'],
          kickout: { type: 'maxIterations', value: 3 },
          expectedIterations: { type: 'triangular', min: 1, mode: 3, max: 5 },
        },
      ],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.nodeCosts.body).toEqual({
        fromResources: 2450, // 100 × 8 × 1 × 3 + 50
        fromFixed: 30, // 10 × 3 (per iteration)
        fromCrash: 0,
        total: 2480,
      });
      expect(out.result.projectCost).toBe(2480);
    }
  });

  it('respects fixedCostOnce: true (fixed cost charged ONCE inside a loop)', () => {
    // Same fixture as previous, but fixedCostOnce: true → fixed = 10 (not × 3).
    const input = makeInput({
      nodes: [
        activity('body', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
          fixedCost: { value: 10 },
          fixedCostOnce: true,
        }),
      ],
      resources: [
        {
          id: 'r1',
          name: 'Dev',
          capacity: 1,
          calendarId: MON_FRI.id,
          costRate: 100,
          costPerUse: 50,
        },
      ],
      loops: [
        {
          id: 'L1',
          bodyNodeIds: ['body'],
          kickout: { type: 'maxIterations', value: 3 },
          expectedIterations: { type: 'triangular', min: 1, mode: 3, max: 5 },
        },
      ],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.nodeCosts.body?.fromFixed).toBe(10); // ← once, not × 3
      expect(out.result.nodeCosts.body?.fromResources).toBe(2450); // rate × hours × 3 + perUse × 1
    }
  });

  it('uses sampledLoopIterations when provided (Monte Carlo seam)', () => {
    // 5 sampled iterations override the deterministic count.
    const input: ScheduleInput = {
      ...makeInput({
        nodes: [
          activity('body', 8, {
            resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
            fixedCost: { value: 10 },
          }),
        ],
        resources: [{ id: 'r1', name: 'Dev', capacity: 1, calendarId: MON_FRI.id, costRate: 100 }],
        loops: [
          {
            id: 'L1',
            bodyNodeIds: ['body'],
            kickout: { type: 'maxIterations', value: 3 },
            expectedIterations: { type: 'triangular', min: 1, mode: 3, max: 5 },
          },
        ],
      }),
      sampledLoopIterations: { L1: 5 },
    };
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      // rate: 100 × 8 × 1 × 5 = 4000; fixed: 10 × 5 = 50.
      expect(out.result.nodeCosts.body).toEqual({
        fromResources: 4000,
        fromFixed: 50,
        fromCrash: 0,
        total: 4050,
      });
    }
  });

  // ── Sub-system rollup ──────────────────────────────────────────────────────

  it('rolls up body node costs into the sub-system container id', () => {
    // 2 body nodes, $100 each → container total = $200.
    const input = makeInput({
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
        activity('b1', 1, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
        }),
        activity('b2', 1, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
          fixedCost: { value: 100 },
        }),
      ],
      edges: [{ id: 'e1', from: 'b1', to: 'b2', type: 'FS', lag: { value: 0, unit: 'hours' } }],
      resources: [{ id: 'r1', name: 'Dev', capacity: 1, calendarId: MON_FRI.id, costRate: 100 }],
      subsystems: [
        {
          id: 'sub-1',
          containerNodeId: 'container',
          bodyNodeIds: ['b1', 'b2'],
          entryNodeId: 'b1',
          exitNodeId: 'b2',
        },
      ],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      // b1: rate × 1 = 100. b2: rate × 1 = 100, plus fixedCost 100 → 200.
      expect(out.result.nodeCosts.b1?.total).toBe(100);
      expect(out.result.nodeCosts.b2?.total).toBe(200);
      // Container rollup
      expect(out.result.nodeCosts.container).toEqual({
        fromResources: 200,
        fromFixed: 100,
        fromCrash: 0,
        total: 300,
      });
      // projectCost sums FLAT nodes only — no double-counting via the rollup.
      expect(out.result.projectCost).toBe(300);
    }
  });
});

// ── Phase 23 — parallelism on resource assignments ───────────────────────────

describe('computeCosts (parallelism)', () => {
  it('α=1, count=2 — perfect parallel keeps cost at rate × baseHours (count cancels)', () => {
    // baseHours=8, rate=100, count=2, α=1 → assignment effective = 8/2 = 4h.
    // rate × 4h × 2 = 800 — same total as a single-resource (count=1) baseline.
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [
            { resourceId: 'r1', count: 2, calendarPolicy: 'intersection', parallelism: 1 },
          ],
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 4, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.nodeCosts.a1?.fromResources).toBe(800);
  });

  it('α=0, count=2 — independent labour doubles cost (current behaviour preserved)', () => {
    // baseHours=8, rate=100, count=2, α=0 → assignment effective = 8h.
    // rate × 8 × 2 = 1600 — Phase 19's pre-Phase-23 formula.
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [
            { resourceId: 'r1', count: 2, calendarPolicy: 'intersection', parallelism: 0 },
          ],
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 4, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.nodeCosts.a1?.fromResources).toBe(1600);
  });

  it('α=0.5, count=2 — Amdahl midpoint (effective = 0.75 × base; cost = 1.5 × base × rate)', () => {
    // baseHours=8, α=0.5, count=2 → effective = 8 × (0.5 + 0.5/2) = 6h.
    // rate × 6 × 2 = 1200.
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [
            { resourceId: 'r1', count: 2, calendarPolicy: 'intersection', parallelism: 0.5 },
          ],
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 4, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.nodeCosts.a1?.fromResources).toBe(1200);
  });

  it('count=1 — parallelism is a no-op regardless of α', () => {
    // count=1 collapses the formula. rate × 8 × 1 = 800.
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [
            { resourceId: 'r1', count: 1, calendarPolicy: 'intersection', parallelism: 1 },
          ],
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 4, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.nodeCosts.a1?.fromResources).toBe(800);
  });

  it('mixed multi-assignment — each costs its own per-assignment effective hours', () => {
    // Dev (count=2, α=1, $100/hr) → 8 × (1/2) = 4h, cost = 100 × 4 × 2 = 800.
    // Reviewer (count=1, α=0, $200/hr) → 8h (count=1 short-circuit), cost = 200 × 8 × 1 = 1600.
    // Total resource cost = 2400. Activity wall-clock = max(4h, 8h) = 8h
    // (verified separately in the multi-resource schedule test).
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [
            { resourceId: 'dev', count: 2, calendarPolicy: 'intersection', parallelism: 1 },
            { resourceId: 'rev', count: 1, calendarPolicy: 'intersection', parallelism: 0 },
          ],
        }),
      ],
      resources: [
        { id: 'dev', name: 'Dev', capacity: 4, calendarId: MON_FRI.id, costRate: 100 },
        { id: 'rev', name: 'Reviewer', capacity: 1, calendarId: MON_FRI.id, costRate: 200 },
      ],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.resourceCosts.dev).toBe(800);
      expect(out.result.resourceCosts.rev).toBe(1600);
      expect(out.result.nodeCosts.a1?.fromResources).toBe(2400);
    }
  });

  it('legacy file (parallelism field absent) costs identically to α=0', () => {
    // No parallelism field at all — the engine treats it as α=0, byte-equal
    // with pre-Phase-23 behaviour. Same fixture as the earlier "scales rate-cost
    // by resource count" test, but with a different rate to avoid coincidence.
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 3, calendarPolicy: 'intersection' }],
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 5, calendarId: MON_FRI.id, costRate: 50 }],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.nodeCosts.a1?.fromResources).toBe(1200); // 50 × 8 × 3
  });
});

// ── Phase 25 — activity crashing (cost side) ─────────────────────────────────

describe('computeCosts (Phase 25 crashing)', () => {
  it('selected crash adds additionalCost to fromCrash and shrinks resource hours', () => {
    // Nominal: 8h × $100 = 800. Selected crash: 4h, +$300 → resources
    // 4 × 100 = 400, fromCrash = 300, total = 700.
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
          crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 300 }],
          selectedCrashIndex: 0,
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 1, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.nodeCosts.a1).toEqual({
        fromResources: 400,
        fromFixed: 0,
        fromCrash: 300,
        total: 700,
      });
      expect(out.result.projectCost).toBe(700);
    }
  });

  it('crashOptions defined but none selected → behaves identically to no-crash', () => {
    // Same fixture as the existing rate-only test but with unused crashOptions.
    // The presence of the field alone must not perturb costs.
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
          crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 300 }],
          // selectedCrashIndex deliberately absent
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 1, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.nodeCosts.a1?.fromResources).toBe(800); // nominal hours
      expect(out.result.nodeCosts.a1?.fromCrash).toBe(0);
      expect(out.result.nodeCosts.a1?.total).toBe(800);
    }
  });

  it('selecting a later (cheaper-duration / costlier) option swaps both duration and cost', () => {
    // Two options; pick the deeper crash (index 1).
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
          crashOptions: [
            { duration: { value: 6, unit: 'hours' }, additionalCost: 200 },
            { duration: { value: 2, unit: 'hours' }, additionalCost: 1000 },
          ],
          selectedCrashIndex: 1,
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 1, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      // 2h × $100 = 200; +1000 crash; total 1200.
      expect(out.result.nodeCosts.a1?.fromResources).toBe(200);
      expect(out.result.nodeCosts.a1?.fromCrash).toBe(1000);
      expect(out.result.nodeCosts.a1?.total).toBe(1200);
    }
  });

  it('crash inside a loop body charges fromCrash per iteration by default', () => {
    // 3 iterations × $100 crash = $300 fromCrash. Resources also scale × 3.
    const input = makeInput({
      nodes: [
        activity('body', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
          crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 100 }],
          selectedCrashIndex: 0,
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 1, calendarId: MON_FRI.id, costRate: 100 }],
      loops: [
        {
          id: 'L1',
          bodyNodeIds: ['body'],
          kickout: { type: 'maxIterations', value: 3 },
          expectedIterations: { type: 'triangular', min: 1, mode: 3, max: 5 },
        },
      ],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      // Each iteration: 4h × $100 = 400 resources, 100 crash.
      // Total across 3 iters: 1200 resources + 300 crash.
      expect(out.result.nodeCosts.body?.fromResources).toBe(1200);
      expect(out.result.nodeCosts.body?.fromCrash).toBe(300);
      expect(out.result.nodeCosts.body?.total).toBe(1500);
    }
  });

  it('crash inside a loop body with fixedCostOnce: true charges fromCrash only once', () => {
    // Same fixture but fixedCostOnce: true makes both the fixed and crash
    // buckets one-time. This pins the design decision that crash shares the
    // fixedCostOnce flag — there's no separate `crashCostOnce` field.
    const input = makeInput({
      nodes: [
        activity('body', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
          crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 100 }],
          selectedCrashIndex: 0,
          fixedCostOnce: true,
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 1, calendarId: MON_FRI.id, costRate: 100 }],
      loops: [
        {
          id: 'L1',
          bodyNodeIds: ['body'],
          kickout: { type: 'maxIterations', value: 3 },
          expectedIterations: { type: 'triangular', min: 1, mode: 3, max: 5 },
        },
      ],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      // Resources still scale × 3 (hours-based). fromCrash is ONCE: 100.
      expect(out.result.nodeCosts.body?.fromResources).toBe(1200);
      expect(out.result.nodeCosts.body?.fromCrash).toBe(100);
    }
  });

  it('crash stacks with parallelism (Phase 23): crashed duration becomes the new base', () => {
    // Nominal 16h, crash to 8h, then parallelism α=1 count=2 → effective 4h.
    // resources: 100 × 4h × 2 = 800; fromCrash: 200.
    const input = makeInput({
      nodes: [
        activity('a1', 16, {
          resourceAssignments: [
            { resourceId: 'r1', count: 2, calendarPolicy: 'intersection', parallelism: 1 },
          ],
          crashOptions: [{ duration: { value: 8, unit: 'hours' }, additionalCost: 200 }],
          selectedCrashIndex: 0,
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 4, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.nodeCosts.a1?.fromResources).toBe(800); // 100 × 4 × 2
      expect(out.result.nodeCosts.a1?.fromCrash).toBe(200);
      expect(out.result.nodeCosts.a1?.total).toBe(1000);
    }
  });
});

// ── Phase 26 follow-up — crashOption.resourceCostMultiplier ──────────────────

describe('computeCosts (Phase 26 — resourceCostMultiplier)', () => {
  it('multiplier=1 (or absent) behaves identically to the original expedite model', () => {
    // Baseline: 8h → 4h crash, $100/hr resource. No multiplier set.
    // Expected: resource cost = 100 × 4 × 1 = $400 (compressed-hours linear).
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
          crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 100 }],
          selectedCrashIndex: 0,
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 1, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.nodeCosts.a1?.fromResources).toBe(400);
      expect(out.result.nodeCosts.a1?.fromCrash).toBe(100);
      expect(out.result.nodeCosts.a1?.total).toBe(500);
    }
  });

  it('multiplier=2 doubles the rate side; halving hours nets back to nominal cost', () => {
    // 8h → 4h with 2× multiplier: resource = 100 × 2 × 4 × 1 = $800.
    // Same as uncompressed (100 × 8 × 1 = 800). Plus 0 additionalCost.
    // Models "double-time OT" — work done in half the wall-clock at 2× rate.
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
          crashOptions: [
            {
              duration: { value: 4, unit: 'hours' },
              additionalCost: 0,
              resourceCostMultiplier: 2,
            },
          ],
          selectedCrashIndex: 0,
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 1, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.nodeCosts.a1?.fromResources).toBe(800);
      expect(out.result.nodeCosts.a1?.fromCrash).toBe(0);
      expect(out.result.nodeCosts.a1?.total).toBe(800);
    }
  });

  it('multiplier=1.5 (time-and-a-half OT) — rate × 1.5 × compressedHours × count', () => {
    // 8h → 4h with 1.5× multiplier on 2 resources at $100/hr.
    // Resource cost = 100 × 1.5 × 4 × 2 = $1200. additionalCost = $50.
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 2, calendarPolicy: 'intersection' }],
          crashOptions: [
            {
              duration: { value: 4, unit: 'hours' },
              additionalCost: 50,
              resourceCostMultiplier: 1.5,
            },
          ],
          selectedCrashIndex: 0,
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 4, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.nodeCosts.a1?.fromResources).toBe(1200);
      expect(out.result.nodeCosts.a1?.fromCrash).toBe(50);
      expect(out.result.nodeCosts.a1?.total).toBe(1250);
    }
  });

  it('multiplier does NOT scale costPerUse (mobilisation fee stays flat)', () => {
    // 8h → 4h with 2× multiplier on a resource that has $200 perUse + 0 rate.
    // perUse fires once × count, regardless of compression.
    // resource cost = 0 × 2 × 4 × 1 + 200 × 1 = $200. Same as uncompressed.
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
          crashOptions: [
            {
              duration: { value: 4, unit: 'hours' },
              additionalCost: 0,
              resourceCostMultiplier: 2,
            },
          ],
          selectedCrashIndex: 0,
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 1, calendarId: MON_FRI.id, costPerUse: 200 }],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.nodeCosts.a1?.fromResources).toBe(200);
    }
  });

  it('multiplier composes with Phase 23 parallelism: α=1 count=2, mult=2 → cost = nominal', () => {
    // Nominal: 16h × 2 × $100 = uncompressed cost; with α=1 the rate × hours
    // collapses to $1600. Compressed to 8h with multiplier=2 should
    // also produce $1600 (8h × 2× rate × ((1-1)+1/2)*count effectively
    // cancels through to the same total person-hours-at-rate). Pins
    // that the multiplier composes correctly with parallelism.
    const nominal = makeInput({
      nodes: [
        activity('a1', 16, {
          resourceAssignments: [
            { resourceId: 'r1', count: 2, calendarPolicy: 'intersection', parallelism: 1 },
          ],
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 4, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const compressedWithMult = makeInput({
      nodes: [
        activity('a1', 16, {
          resourceAssignments: [
            { resourceId: 'r1', count: 2, calendarPolicy: 'intersection', parallelism: 1 },
          ],
          crashOptions: [
            {
              duration: { value: 8, unit: 'hours' },
              additionalCost: 0,
              resourceCostMultiplier: 2,
            },
          ],
          selectedCrashIndex: 0,
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 4, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const nominalOut = schedule(nominal);
    const compressedOut = schedule(compressedWithMult);
    expect(nominalOut.ok && compressedOut.ok).toBe(true);
    if (nominalOut.ok && compressedOut.ok) {
      expect(compressedOut.result.nodeCosts.a1?.fromResources).toBe(
        nominalOut.result.nodeCosts.a1?.fromResources,
      );
    }
  });

  it('multiplier applies only when a crash option is selected', () => {
    // Same fixture but selectedCrashIndex is absent — multiplier is ignored,
    // engine behaves as if no crash option were defined.
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
          crashOptions: [
            {
              duration: { value: 4, unit: 'hours' },
              additionalCost: 100,
              resourceCostMultiplier: 2,
            },
          ],
          // selectedCrashIndex intentionally absent
        }),
      ],
      resources: [{ id: 'r1', name: 'Dev', capacity: 1, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      // Nominal hours × rate × count = 100 × 8 × 1 = 800. Multiplier IGNORED.
      expect(out.result.nodeCosts.a1?.fromResources).toBe(800);
      expect(out.result.nodeCosts.a1?.fromCrash).toBe(0);
    }
  });
});

describe('computeCosts (Phase 42 — multi-pool work split)', () => {
  // Two engineers (resource r1, $100/h) and one designer (resource r2,
  // $200/h). 40-hour activity. Pool A does 70% of the work, pool B does 30%.
  // With no Amdahl (parallelism absent), per-pool hours = baseHours × share:
  //   pool A: 40 × 0.7 = 28h × 1 unit × $100 = $2800
  //   pool B: 40 × 0.3 = 12h × 1 unit × $200 = $2400
  //   total resource cost: $5200
  it('cost is billed per share, not per full baseHours', () => {
    const input = makeInput({
      nodes: [
        activity('a1', 40, {
          resourceAssignments: [
            { resourceId: 'r1', count: 1, calendarPolicy: 'intersection', share: 70 },
            { resourceId: 'r2', count: 1, calendarPolicy: 'intersection', share: 30 },
          ],
        }),
      ],
      resources: [
        { id: 'r1', name: 'Engineer', capacity: 1, calendarId: MON_FRI.id, costRate: 100 },
        { id: 'r2', name: 'Designer', capacity: 1, calendarId: MON_FRI.id, costRate: 200 },
      ],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.nodeCosts.a1?.fromResources).toBeCloseTo(5200, 6);
    // Per-resource breakdown
    expect(out.result.resourceCosts.r1).toBeCloseTo(2800, 6);
    expect(out.result.resourceCosts.r2).toBeCloseTo(2400, 6);
  });

  it('no-shares case is byte-equal to the pre-Phase-42 cost engine', () => {
    // Same fixture without shares — both pools get billed for full
    // baseHours (legacy mode). 40 × $100 + 40 × $200 = $12000.
    const input = makeInput({
      nodes: [
        activity('a1', 40, {
          resourceAssignments: [
            { resourceId: 'r1', count: 1, calendarPolicy: 'intersection' },
            { resourceId: 'r2', count: 1, calendarPolicy: 'intersection' },
          ],
        }),
      ],
      resources: [
        { id: 'r1', name: 'Engineer', capacity: 1, calendarId: MON_FRI.id, costRate: 100 },
        { id: 'r2', name: 'Designer', capacity: 1, calendarId: MON_FRI.id, costRate: 200 },
      ],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.nodeCosts.a1?.fromResources).toBe(12000);
  });

  it('share=0 puts no labour cost on that pool (presence-only)', () => {
    // Partner attends but contributes no hours → no rate-cost.
    // perUse fee would still fire if the resource had one, but rate × hours = 0.
    const input = makeInput({
      nodes: [
        activity('a1', 40, {
          resourceAssignments: [
            { resourceId: 'r1', count: 1, calendarPolicy: 'intersection', share: 100 },
            { resourceId: 'partner', count: 1, calendarPolicy: 'intersection', share: 0 },
          ],
        }),
      ],
      resources: [
        { id: 'r1', name: 'Analyst', capacity: 1, calendarId: MON_FRI.id, costRate: 100 },
        { id: 'partner', name: 'Partner', capacity: 1, calendarId: MON_FRI.id, costRate: 1000 },
      ],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Only the analyst's labour is billed. Partner attends but at 0 share.
    expect(out.result.nodeCosts.a1?.fromResources).toBe(4000); // 40 × $100
    expect(out.result.resourceCosts.partner ?? 0).toBe(0);
  });

  it('weight-mode shares produce the same cost as equivalent percentage shares', () => {
    // [3, 7] weights and [30, 70] percentages produce identical per-pool
    // hours and therefore identical costs.
    const withWeights = makeInput({
      nodes: [
        activity('a1', 40, {
          resourceAssignments: [
            { resourceId: 'r1', count: 1, calendarPolicy: 'intersection', share: 3 },
            { resourceId: 'r2', count: 1, calendarPolicy: 'intersection', share: 7 },
          ],
        }),
      ],
      resources: [
        { id: 'r1', name: 'A', capacity: 1, calendarId: MON_FRI.id, costRate: 100 },
        { id: 'r2', name: 'B', capacity: 1, calendarId: MON_FRI.id, costRate: 200 },
      ],
    });
    const withPercentages = makeInput({
      nodes: [
        activity('a1', 40, {
          resourceAssignments: [
            { resourceId: 'r1', count: 1, calendarPolicy: 'intersection', share: 30 },
            { resourceId: 'r2', count: 1, calendarPolicy: 'intersection', share: 70 },
          ],
        }),
      ],
      resources: [
        { id: 'r1', name: 'A', capacity: 1, calendarId: MON_FRI.id, costRate: 100 },
        { id: 'r2', name: 'B', capacity: 1, calendarId: MON_FRI.id, costRate: 200 },
      ],
    });
    // Weight-mode schema doesn't enforce sum=100, so the engine accepts
    // both. We're testing engine math, not schema validation.
    withWeights.project.shareMode = 'weight';
    const outW = schedule(withWeights);
    const outP = schedule(withPercentages);
    expect(outW.ok).toBe(true);
    expect(outP.ok).toBe(true);
    if (!outW.ok || !outP.ok) return;
    expect(outW.result.nodeCosts.a1?.fromResources).toBeCloseTo(
      outP.result.nodeCosts.a1?.fromResources ?? 0,
      6,
    );
  });
});
