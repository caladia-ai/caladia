import { describe, it, expect } from 'vitest';
import type { Calendar, ProjectEdge, ProjectNode, Resource } from '@procsim/file-format';
import { schedule } from './index.js';
import { computeCostOfDelay } from './cost-of-delay.js';
import type { ScheduleInput } from './index.js';

// ── Phase 25 Slice 2 — cost-of-delay derived stat ────────────────────────────

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

const MON_FRI_4H: Calendar = {
  id: 'cal-4h',
  name: 'Mon–Fri 4h',
  workingDays: [false, true, true, true, true, true, false],
  hoursPerDay: 4,
  daysPerWeek: 5,
  holidayPreset: 'NONE',
  holidayPresetVersion: '1.0',
  exceptions: [],
};

const START_DATE = '2026-01-05';

function makeInput(opts: {
  nodes: ProjectNode[];
  edges?: ProjectEdge[];
  resources?: Resource[];
  calendars?: Calendar[];
}): ScheduleInput {
  return {
    project: {
      name: 'Test',
      startDate: START_DATE,
      defaultCalendarId: MON_FRI.id,
      displayUnit: 'days',
      shareMode: 'percentage',
    },
    nodes: opts.nodes,
    edges: opts.edges ?? [],
    resources: opts.resources ?? [],
    calendars: opts.calendars ?? [MON_FRI],
    loops: [],
  };
}

function activity(id: string, hours: number, extra: Partial<ProjectNode> = {}): ProjectNode {
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
    ...extra,
  };
}

describe('computeCostOfDelay', () => {
  it('single critical-path node with one option → row with that option', () => {
    // 8h nominal → 4h crash for $400. daysSaved = (8-4)/8 = 0.5 working day.
    // $/day = 400 / 0.5 = 800.
    const node = activity('a1', 8, {
      crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 400 }],
    });
    const input = makeInput({ nodes: [node] });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const cod = computeCostOfDelay(input, out.result);
    expect(cod.rows).toHaveLength(1);
    expect(cod.rows[0]).toMatchObject({
      nodeId: 'a1',
      bestPerDay: 800,
      bestOptionIndex: 0,
      nominalHours: 8,
      crashedHours: 4,
      addedCost: 400,
    });
    expect(cod.nonCriticalWithOptionsCount).toBe(0);
  });

  it('multi-option node → picks the option with the cheapest $/day', () => {
    // Option 0: 8→6h ($100). Saves 0.25 day. $/day = 400.
    // Option 1: 8→4h ($300). Saves 0.5 day. $/day = 600.
    // Option 2: 8→2h ($300). Saves 0.75 day. $/day = 400.
    // Lowest perDay = 400 — TIED between option 0 and 2. The min-first
    // iteration order picks option 0 (we keep the first one encountered).
    const node = activity('a1', 8, {
      crashOptions: [
        { duration: { value: 6, unit: 'hours' }, additionalCost: 100 },
        { duration: { value: 4, unit: 'hours' }, additionalCost: 300 },
        { duration: { value: 2, unit: 'hours' }, additionalCost: 300 },
      ],
    });
    const input = makeInput({ nodes: [node] });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const cod = computeCostOfDelay(input, out.result);
    expect(cod.rows).toHaveLength(1);
    expect(cod.rows[0]?.bestPerDay).toBe(400);
    expect(cod.rows[0]?.bestOptionIndex).toBe(0);
  });

  it('non-critical-path node with crashOptions is excluded and counted', () => {
    // Two parallel chains: a1 (8h) and b1 (4h). Both are activities. Only
    // a1 is on the critical path (longer). b1 has crashOptions but should
    // be excluded from rows and counted in nonCriticalWithOptionsCount.
    const nodes = [
      activity('a1', 8),
      activity('b1', 4, {
        crashOptions: [{ duration: { value: 2, unit: 'hours' }, additionalCost: 100 }],
      }),
    ];
    const input = makeInput({ nodes });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // sanity: b1 is NOT on the critical path
    expect(out.result.nodes.b1?.onCriticalPath).toBe(false);
    const cod = computeCostOfDelay(input, out.result);
    expect(cod.rows).toHaveLength(0);
    expect(cod.nonCriticalWithOptionsCount).toBe(1);
  });

  it('node without crashOptions is silently skipped (not counted)', () => {
    const input = makeInput({ nodes: [activity('a1', 8)] });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const cod = computeCostOfDelay(input, out.result);
    expect(cod.rows).toHaveLength(0);
    expect(cod.nonCriticalWithOptionsCount).toBe(0);
  });

  it('rows are sorted ascending by $/day (cheapest first)', () => {
    // Two critical-path nodes in series, each with one option.
    // a1: 8→4h ($200). daysSaved 0.5 → $/day 400.
    // a2: 8→4h ($100). daysSaved 0.5 → $/day 200.
    // Cheaper (a2) should appear first.
    const nodes = [
      activity('a1', 8, {
        crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 200 }],
      }),
      activity('a2', 8, {
        crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 100 }],
      }),
    ];
    const edges: ProjectEdge[] = [
      { id: 'e1', from: 'a1', to: 'a2', type: 'FS', lag: { value: 0, unit: 'hours' } },
    ];
    const input = makeInput({ nodes, edges });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const cod = computeCostOfDelay(input, out.result);
    expect(cod.rows.map((r) => r.nodeId)).toEqual(['a2', 'a1']);
    expect(cod.rows[0]?.bestPerDay).toBe(200);
    expect(cod.rows[1]?.bestPerDay).toBe(400);
  });

  it("uses the node's effective calendar hoursPerDay for the day denominator", () => {
    // Same fixture but on a 4h/day calendar — the same 4-hour delta now
    // equals 1 working day instead of 0.5. $/day halves.
    const node = activity('a1', 8, {
      crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 400 }],
    });
    const input: ScheduleInput = {
      project: {
        name: 'Test',
        startDate: START_DATE,
        defaultCalendarId: MON_FRI_4H.id,
        displayUnit: 'days',
        shareMode: 'percentage',
      },
      nodes: [node],
      edges: [],
      resources: [],
      calendars: [MON_FRI_4H],
      loops: [],
    };
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const cod = computeCostOfDelay(input, out.result);
    // deltaHours = 4; daysSaved = 4 / 4 = 1; $/day = 400 / 1 = 400.
    expect(cod.rows[0]?.bestPerDay).toBe(400);
  });

  it('cost of delay is invariant to parallelism (Phase 23 stacking)', () => {
    // 16h nominal, single crash to 8h, additionalCost $200, count=2 α=1.
    // Under α=1 count=2: effective nominal = 16 × 0.5 = 8h.
    //                    effective crashed = 8 × 0.5 = 4h.
    // delta = 4h → 0.5 day → $400/day.
    // Under α=0 (independent labour): effective nominal = 16h, crashed = 8h.
    //                                  delta = 8h → 1 day → $200/day.
    // So the value DOES depend on α. The test confirms cost-of-delay
    // reads the engine's effective-duration math — when parallelism
    // shrinks the delta, the per-day ROI gets correspondingly worse.
    const parallel = activity('a1', 16, {
      consumesResources: true,
      resourceAssignments: [
        { resourceId: 'r1', count: 2, calendarPolicy: 'intersection', parallelism: 1 },
      ],
      crashOptions: [{ duration: { value: 8, unit: 'hours' }, additionalCost: 200 }],
    });
    const independent = {
      ...parallel,
      resourceAssignments: [
        { resourceId: 'r1', count: 2, calendarPolicy: 'intersection' as const, parallelism: 0 },
      ],
    };
    const r1: Resource = { id: 'r1', name: 'Dev', capacity: 4, calendarId: MON_FRI.id };
    const parIn = makeInput({ nodes: [parallel], resources: [r1] });
    const indIn = makeInput({ nodes: [independent], resources: [r1] });
    const parOut = schedule(parIn);
    const indOut = schedule(indIn);
    expect(parOut.ok && indOut.ok).toBe(true);
    if (!parOut.ok || !indOut.ok) return;
    const parCod = computeCostOfDelay(parIn, parOut.result);
    const indCod = computeCostOfDelay(indIn, indOut.result);
    expect(parCod.rows[0]?.bestPerDay).toBe(400);
    expect(indCod.rows[0]?.bestPerDay).toBe(200);
  });

  it('decision-node failure penalty cancels in the delta', () => {
    // Decision node, 8h duration, passProbability 0.5, failureDelay 8h.
    // Nominal effective hours = 8 + (1-0.5) × 8 = 12.
    // Crash to 4h: crashed effective hours = 4 + 4 = 8.
    // delta = 4, daysSaved = 0.5, $/day = additionalCost / 0.5.
    // (Same delta as a non-decision activity 8→4 because the penalty
    //  adds the same constant on both sides.)
    const node: ProjectNode = {
      id: 'd1',
      nodeType: 'decision',
      name: 'Gate',
      duration: { value: 8, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
      passProbability: 0.5,
      failureDelay: { value: 8, unit: 'hours' },
      crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 400 }],
    };
    const input = makeInput({ nodes: [node] });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const cod = computeCostOfDelay(input, out.result);
    expect(cod.rows[0]?.nominalHours).toBe(12);
    expect(cod.rows[0]?.crashedHours).toBe(8);
    expect(cod.rows[0]?.bestPerDay).toBe(800); // 400 / 0.5
  });
});
