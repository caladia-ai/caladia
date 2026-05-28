import { describe, it, expect } from 'vitest';
import type { Calendar, Loop, ProjectEdge, ProjectNode } from '@procsim/file-format';
import { schedule } from './index.js';
import type { ScheduleInput } from './index.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const MON_FRI: Calendar = {
  id: 'cal-default',
  name: 'Mon–Fri 8 h',
  workingDays: [false, true, true, true, true, true, false],
  hoursPerDay: 8,
  daysPerWeek: 5,
  holidayPreset: 'NONE',
  holidayPresetVersion: '1.0',
  exceptions: [],
};

// Sat–Sun only (weekend contractor)
const SAT_SUN: Calendar = {
  id: 'cal-weekend',
  name: 'Sat–Sun',
  workingDays: [true, false, false, false, false, false, true],
  hoursPerDay: 8,
  daysPerWeek: 2,
  holidayPreset: 'NONE',
  holidayPresetVersion: '1.0',
  exceptions: [],
};

// Mon–Fri with a holiday on 2026-01-05 (the Monday project start)
const MON_FRI_HOLIDAY: Calendar = {
  ...MON_FRI,
  id: 'cal-holiday',
  exceptions: [{ date: '2026-01-05', type: 'holiday', name: 'Test Holiday' }],
};

// 2026-01-05 = Monday
const START_DATE = '2026-01-05';

function makeInput(
  nodes: ProjectNode[],
  edges: ProjectEdge[],
  calendarOverride?: Calendar,
): ScheduleInput {
  return {
    project: {
      name: 'Test',
      startDate: START_DATE,
      defaultCalendarId: calendarOverride?.id ?? 'cal-default',
      displayUnit: 'days',
      shareMode: 'percentage',
    },
    nodes,
    edges,
    resources: [],
    calendars: calendarOverride ? [calendarOverride] : [MON_FRI],
    loops: [],
  };
}

function node(id: string, hours: number, calendarId?: string): ProjectNode {
  return {
    id,
    nodeType: 'activity',
    name: id,
    duration: { value: hours, unit: 'hours' },
    durationSemantic: 'time',
    position: { x: 0, y: 0 },
    calendarId: calendarId ?? null,
    consumesResources: false,
    resourceAssignments: [],
  };
}

function edge(
  id: string,
  from: string,
  to: string,
  type: ProjectEdge['type'] = 'FS',
  lagValue = 0,
  lagUnit: ProjectEdge['lag']['unit'] = 'hours',
): ProjectEdge {
  return { id, from, to, type, lag: { value: lagValue, unit: lagUnit } };
}

// Local-time date constructor
function d(year: number, month: number, day: number, hour = 0, min = 0): Date {
  return new Date(year, month - 1, day, hour, min, 0, 0);
}

function expectSchedule(input: ScheduleInput): {
  es: Date;
  ef: Date;
  ls: Date;
  lf: Date;
  slack: number;
  critical: boolean;
} {
  // convenience: single-node results
  const out = schedule(input);
  if (!out.ok) throw new Error(JSON.stringify(out.errors));
  const nodeId = input.nodes[0]!.id;
  const s = out.result.nodes[nodeId]!;
  return {
    es: s.earliestStart,
    ef: s.earliestFinish,
    ls: s.latestStart,
    lf: s.latestFinish,
    slack: s.slackHours,
    critical: s.onCriticalPath,
  };
}

// ── Validation errors ─────────────────────────────────────────────────────────

describe('validation', () => {
  it('returns error for unknown default calendar', () => {
    const input: ScheduleInput = {
      ...makeInput([node('A', 8)], []),
      project: {
        name: 'T',
        startDate: START_DATE,
        defaultCalendarId: 'missing',
        displayUnit: 'days',
        shareMode: 'percentage',
      },
    };
    const out = schedule(input);
    expect(out.ok).toBe(false);
  });

  it('returns error for cycle', () => {
    const out = schedule(
      makeInput([node('A', 8), node('B', 8)], [edge('e1', 'A', 'B'), edge('e2', 'B', 'A')]),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors[0]!.message).toMatch(/cycle/i);
  });

  it('returns error for missing node reference in edge', () => {
    const out = schedule(makeInput([node('A', 8)], [edge('e1', 'A', 'GHOST')]));
    expect(out.ok).toBe(false);
  });
});

// ── Calendar intersection validation ─────────────────────────────────────────

describe('calendar intersection validation', () => {
  const WEEKEND_RESOURCE = {
    id: 'r-weekend',
    name: 'Weekend Contractor',
    capacity: 1,
    calendarId: 'cal-weekend',
  };

  function makeInputWithAssignment(
    policy: 'intersection' | 'resourceWins' | 'activityWins',
  ): ScheduleInput {
    return {
      project: {
        name: 'Test',
        startDate: START_DATE,
        defaultCalendarId: 'cal-default',
        displayUnit: 'days',
        shareMode: 'percentage',
      },
      nodes: [
        {
          id: 'A',
          nodeType: 'activity',
          name: 'Weekday Task',
          duration: { value: 8, unit: 'hours' },
          durationSemantic: 'time',
          position: { x: 0, y: 0 },
          calendarId: null, // inherits Mon–Fri default
          consumesResources: true,
          resourceAssignments: [{ resourceId: 'r-weekend', count: 1, calendarPolicy: policy }],
        },
      ],
      edges: [],
      resources: [WEEKEND_RESOURCE],
      calendars: [MON_FRI, SAT_SUN],
      loops: [],
    };
  }

  it('returns EMPTY_INTERSECTION error for Mon–Fri activity + Sat–Sun resource under intersection', () => {
    const out = schedule(makeInputWithAssignment('intersection'));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      const msg = out.errors[0]!.message;
      expect(msg).toMatch(/Weekday Task/);
      expect(msg).toMatch(/Weekend Contractor/);
      expect(msg).toMatch(/no working days/i);
    }
  });

  it("fails for Mon–Fri activity + Sat–Sun resource under resourceWins (Phase 18: 'resourceWins' actually narrows progress)", () => {
    // Phase 18 — switching to a resource-aware effective working calendar
    // means `'resourceWins'` on a Sat–Sun resource forces the activity to
    // try to run Sat–Sun, but the activity's own calendar is Mon–Fri, so
    // the intersection is empty. Previously this silently passed because
    // policy was a validation gate only and CPM ran on the activity's
    // own calendar regardless.
    const out = schedule(makeInputWithAssignment('resourceWins'));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      const msg = out.errors[0]!.message;
      expect(msg).toMatch(/Weekday Task/);
      expect(msg).toMatch(/no working days/i);
    }
  });

  it('succeeds for Mon–Fri activity + Sat–Sun resource under activityWins', () => {
    // `'activityWins'` still ignores the resource calendar — activity
    // runs Mon–Fri and the Sat–Sun resource bills during those days.
    const out = schedule(makeInputWithAssignment('activityWins'));
    expect(out.ok).toBe(true);
  });
});

// ── Single node ───────────────────────────────────────────────────────────────

describe('single node', () => {
  it('ES = Monday 08:00, EF = Monday 16:00', () => {
    const s = expectSchedule(makeInput([node('A', 8)], []));
    expect(s.es).toEqual(d(2026, 1, 5, 8));
    expect(s.ef).toEqual(d(2026, 1, 5, 16));
    expect(s.slack).toBeCloseTo(0, 4);
    expect(s.critical).toBe(true);
  });

  it('multi-day task spans weekend correctly', () => {
    // 40 h = 5 working days: Mon–Fri, EF = Friday 16:00
    const s = expectSchedule(makeInput([node('A', 40)], []));
    expect(s.es).toEqual(d(2026, 1, 5, 8));
    expect(s.ef).toEqual(d(2026, 1, 9, 16));
  });
});

// ── FS edges × {positive, zero, negative} lag ─────────────────────────────────

describe('FS dependency', () => {
  it('lag=0: B starts when A finishes', () => {
    const out = schedule(makeInput([node('A', 8), node('B', 8)], [edge('e', 'A', 'B', 'FS', 0)]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { nodes } = out.result;
    expect(nodes['A']!.earliestFinish).toEqual(d(2026, 1, 5, 16));
    expect(nodes['B']!.earliestStart).toEqual(d(2026, 1, 6, 8));
    expect(nodes['B']!.earliestFinish).toEqual(d(2026, 1, 6, 16));
  });

  it('lag=+8h: B starts 8 working hours after A finishes (next full day)', () => {
    const out = schedule(makeInput([node('A', 8), node('B', 8)], [edge('e', 'A', 'B', 'FS', 8)]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // A: Mon 08–16; +8h gap → Tue 16:00; B: Wed 08–16
    expect(out.result.nodes['B']!.earliestStart).toEqual(d(2026, 1, 7, 8));
  });

  it('lag=−4h (overlap): B can start 4 h before A finishes', () => {
    const out = schedule(makeInput([node('A', 8), node('B', 8)], [edge('e', 'A', 'B', 'FS', -4)]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // A finishes Mon 16:00; constraint = Mon 16:00 − 4h = Mon 12:00
    expect(out.result.nodes['B']!.earliestStart).toEqual(d(2026, 1, 5, 12));
    expect(out.result.nodes['B']!.earliestFinish).toEqual(d(2026, 1, 6, 12));
  });
});

// ── SS edges × {positive, zero, negative} lag ─────────────────────────────────

describe('SS dependency', () => {
  it('lag=0: B can start as soon as A starts', () => {
    const out = schedule(makeInput([node('A', 8), node('B', 8)], [edge('e', 'A', 'B', 'SS', 0)]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { nodes } = out.result;
    expect(nodes['B']!.earliestStart).toEqual(nodes['A']!.earliestStart);
  });

  it('lag=+4h: B starts 4 h after A starts', () => {
    const out = schedule(makeInput([node('A', 8), node('B', 8)], [edge('e', 'A', 'B', 'SS', 4)]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.nodes['B']!.earliestStart).toEqual(d(2026, 1, 5, 12));
  });

  it('lag=−4h: B can start 4 h before A starts (but not before project start)', () => {
    const out = schedule(makeInput([node('A', 8), node('B', 8)], [edge('e', 'A', 'B', 'SS', -4)]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Constraint = Mon 08:00 − 4h; but project start floors it to Mon 08:00
    expect(out.result.nodes['B']!.earliestStart).toEqual(d(2026, 1, 5, 8));
  });
});

// ── FF edges × {positive, zero, negative} lag ─────────────────────────────────

describe('FF dependency', () => {
  it('lag=0: B finishes at the same time as A', () => {
    const out = schedule(makeInput([node('A', 8), node('B', 8)], [edge('e', 'A', 'B', 'FF', 0)]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { nodes } = out.result;
    expect(nodes['B']!.earliestFinish).toEqual(nodes['A']!.earliestFinish);
    expect(nodes['B']!.earliestStart).toEqual(d(2026, 1, 5, 8));
  });

  it('lag=+4h: B finishes 4 h after A finishes', () => {
    const out = schedule(makeInput([node('A', 8), node('B', 8)], [edge('e', 'A', 'B', 'FF', 4)]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // A finishes Mon 16:00; B must finish Mon 16:00 + 4h = Tue 12:00; B starts Tue 04:00 → snap → Mon+?
    // A finishes Mon 16:00; +4h = Tue 12:00; B duration 8h → ES = Tue 12:00 − 8h = Mon 12:00 → snap Mon 12:00
    expect(out.result.nodes['B']!.earliestFinish).toEqual(d(2026, 1, 6, 12));
  });

  it('lag=−4h: B can finish 4 h before A finishes', () => {
    const out = schedule(makeInput([node('A', 8), node('B', 8)], [edge('e', 'A', 'B', 'FF', -4)]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // EF constraint = Mon 16:00 − 4h = Mon 12:00; ES = Mon 12:00 − 8h = Mon 04:00 → snap → Mon 08:00
    expect(out.result.nodes['B']!.earliestStart).toEqual(d(2026, 1, 5, 8));
    expect(out.result.nodes['B']!.earliestFinish).toEqual(d(2026, 1, 5, 16));
  });
});

// ── SF edges × {positive, zero, negative} lag ─────────────────────────────────

describe('SF dependency', () => {
  it('lag=0: B finishes when A starts (unusual but valid)', () => {
    const out = schedule(makeInput([node('A', 8), node('B', 8)], [edge('e', 'A', 'B', 'SF', 0)]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // EF_succ ≥ ES_pred + lag=0 → EF_B ≥ Mon 08:00; ES_B = Mon 08:00 − 8h → snap → Mon 08:00 - 8 = Fri 08:00 → project start floors → Mon 08:00
    // So B starts Mon 08:00 and finishes Mon 16:00
    expect(out.result.nodes['B']!.earliestStart).toEqual(d(2026, 1, 5, 8));
  });

  it('lag=+16h: B finishes 16 h after A starts', () => {
    const out = schedule(makeInput([node('A', 8), node('B', 8)], [edge('e', 'A', 'B', 'SF', 16)]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // ES_pred = Mon 08:00; constraint = Mon 08:00 + 16h − 8h (B duration) = Mon 08:00 + 8h = Mon 16:00
    // Snap Mon 16:00 → Tue 08:00; EF = Tue 16:00
    expect(out.result.nodes['B']!.earliestStart).toEqual(d(2026, 1, 6, 8));
    expect(out.result.nodes['B']!.earliestFinish).toEqual(d(2026, 1, 6, 16));
  });
});

// ── Diamond dependency ────────────────────────────────────────────────────────

describe('diamond dependency', () => {
  //   A → B → D
  //   A → C → D  (C is longer → critical path A→C→D)
  it('critical path goes through the longer branch', () => {
    const nodes = [node('A', 8), node('B', 8), node('C', 16), node('D', 8)];
    const edges = [
      edge('e1', 'A', 'B'),
      edge('e2', 'A', 'C'),
      edge('e3', 'B', 'D'),
      edge('e4', 'C', 'D'),
    ];
    const out = schedule(makeInput(nodes, edges));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { nodes: ns } = out.result;

    // A: Mon 08–16; B: Tue 08–16 (8h); C: Tue 08–Wed 16 (16h); D must wait for C → Thu 08–Thu 16
    expect(ns['A']!.onCriticalPath).toBe(true);
    expect(ns['B']!.onCriticalPath).toBe(false); // B has slack
    expect(ns['C']!.onCriticalPath).toBe(true);
    expect(ns['D']!.onCriticalPath).toBe(true);

    // B slack = 8 h (D waits for C which takes one more day than B)
    expect(ns['B']!.slackHours).toBeCloseTo(8, 4);
  });

  it('critical path array contains the longest path', () => {
    const nodes = [node('A', 8), node('B', 8), node('C', 16), node('D', 8)];
    const edges = [
      edge('e1', 'A', 'B'),
      edge('e2', 'A', 'C'),
      edge('e3', 'B', 'D'),
      edge('e4', 'C', 'D'),
    ];
    const out = schedule(makeInput(nodes, edges));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const paths = out.result.criticalPaths;
    expect(paths.length).toBe(1);
    expect(paths[0]).toEqual(['A', 'C', 'D']);
  });
});

// ── Parallel branches + multi-sink ────────────────────────────────────────────

describe('parallel branches and multi-sink', () => {
  it('independent parallel branches have correct schedules', () => {
    //  A(8h) and B(16h) start on the same day, no dependencies
    const out = schedule(makeInput([node('A', 8), node('B', 16)], []));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { nodes: ns } = out.result;
    expect(ns['A']!.earliestStart).toEqual(d(2026, 1, 5, 8));
    expect(ns['B']!.earliestStart).toEqual(d(2026, 1, 5, 8));
    // A has slack of 8h (project end is B's finish)
    expect(ns['A']!.slackHours).toBeCloseTo(8, 4);
    expect(ns['B']!.slackHours).toBeCloseTo(0, 4);
  });

  it('fan-in: three predecessors, latest determines successor start', () => {
    // A(8h), B(16h), C(8h) all → D(8h)
    const nodes = [node('A', 8), node('B', 16), node('C', 8), node('D', 8)];
    const edges = [edge('e1', 'A', 'D'), edge('e2', 'B', 'D'), edge('e3', 'C', 'D')];
    const out = schedule(makeInput(nodes, edges));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { nodes: ns } = out.result;
    // B finishes Tue 16:00; D starts Wed 08:00
    expect(ns['D']!.earliestStart).toEqual(d(2026, 1, 7, 8));
    expect(ns['B']!.onCriticalPath).toBe(true);
  });
});

// ── Calendar edge cases ───────────────────────────────────────────────────────

describe('calendar edge cases', () => {
  it('task starting on a holiday skips to next working day', () => {
    // 2026-01-05 is a holiday; project starts Mon but first working day is Tue
    const input: ScheduleInput = {
      project: {
        name: 'T',
        startDate: START_DATE,
        defaultCalendarId: 'cal-holiday',
        displayUnit: 'days',
        shareMode: 'percentage',
      },
      nodes: [node('A', 8)],
      edges: [],
      resources: [],
      calendars: [MON_FRI_HOLIDAY],
      loops: [],
    };
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.nodes['A']!.earliestStart).toEqual(d(2026, 1, 6, 8));
  });

  it('task spanning a weekend: 40h over Mon–Fri only', () => {
    const out = schedule(makeInput([node('A', 40)], []));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.nodes['A']!.earliestFinish).toEqual(d(2026, 1, 9, 16));
  });

  it('activity on a different calendar than project default', () => {
    // Node B uses SAT_SUN calendar; project default is MON_FRI
    const nodes = [node('A', 8), node('B', 8, 'cal-weekend')];
    const edges = [edge('e1', 'A', 'B', 'FS', 0)];
    const input: ScheduleInput = {
      project: {
        name: 'T',
        startDate: START_DATE,
        defaultCalendarId: 'cal-default',
        displayUnit: 'days',
        shareMode: 'percentage',
      },
      nodes,
      edges,
      resources: [],
      calendars: [MON_FRI, SAT_SUN],
      loops: [],
    };
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // A finishes Mon 16:00; B uses Sat–Sun cal, next working moment is Sat 08:00
    expect(out.result.nodes['B']!.earliestStart).toEqual(d(2026, 1, 10, 8));
    expect(out.result.nodes['B']!.earliestFinish).toEqual(d(2026, 1, 10, 16));
  });
});

// ── Phase 36 Slice 3: per-node calendar overrides ────────────────────────────
//
// `node.calendarId !== null` has been consumed by the scheduler since Phase
// 18 (via `nodeEffectiveWorkingCalendar` in utils.ts), but no UI ever
// authored a non-null value. Phase 36 Slice 3 exposes the override in
// NodePanel; these tests pin the engine behaviour that authored values
// now depend on.

describe('per-node calendar override', () => {
  it('schedules an activity on its overridden calendar, not the project default', () => {
    // Project default = Mon–Fri, activity A pinned to Sat–Sun via override.
    // Project starts Mon 2026-01-05. Without an override A would run
    // Mon 08:00 → Tue 16:00 (16h spread over two M-F days). With the
    // override it should snap to the next Sat–Sun working moment.
    const A = node('A', 16, 'cal-weekend');
    const input: ScheduleInput = {
      project: {
        name: 'Test',
        startDate: START_DATE,
        defaultCalendarId: 'cal-default',
        displayUnit: 'days',
        shareMode: 'percentage',
      },
      nodes: [A],
      edges: [],
      resources: [],
      calendars: [MON_FRI, SAT_SUN],
      loops: [],
    };
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const s = out.result.nodes['A']!;
    // First Sat–Sun working moment after Mon 2026-01-05 is Sat 2026-01-10
    // at 08:00; second 8h shift lands on Sun 2026-01-11 finishing 16:00.
    expect(s.earliestStart).toEqual(d(2026, 1, 10, 8));
    expect(s.earliestFinish).toEqual(d(2026, 1, 11, 16));
  });

  it('honours the override in combination with a resource on a different calendar (intersection)', () => {
    // Activity pinned to 24/7; a single intersection-policy resource on
    // Mon–Fri. Folded effective calendar = intersection of {24/7} ∩
    // {Mon–Fri} = Mon–Fri. Activity should run during Mon–Fri hours, not
    // the 24/7 surface its override would imply.
    const ALWAYS_ON: Calendar = {
      id: 'cal-24-7',
      name: '24/7',
      workingDays: [true, true, true, true, true, true, true],
      hoursPerDay: 24,
      daysPerWeek: 7,
      holidayPreset: 'NONE',
      holidayPresetVersion: '1.0',
      exceptions: [],
    };
    const A: ProjectNode = {
      id: 'A',
      nodeType: 'activity',
      name: 'A',
      duration: { value: 8, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: 'cal-24-7',
      consumesResources: true,
      resourceAssignments: [{ resourceId: 'r-mf', count: 1, calendarPolicy: 'intersection' }],
    };
    const input: ScheduleInput = {
      project: {
        name: 'Test',
        startDate: START_DATE,
        defaultCalendarId: 'cal-default',
        displayUnit: 'days',
        shareMode: 'percentage',
      },
      nodes: [A],
      edges: [],
      resources: [{ id: 'r-mf', name: 'MF Resource', capacity: 1, calendarId: 'cal-default' }],
      calendars: [MON_FRI, ALWAYS_ON],
      loops: [],
    };
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const s = out.result.nodes['A']!;
    // Mon 08:00 → Mon 16:00 — the Mon–Fri resource bounds the activity
    // despite the 24/7 node override.
    expect(s.earliestStart).toEqual(d(2026, 1, 5, 8));
    expect(s.earliestFinish).toEqual(d(2026, 1, 5, 16));
  });

  it('falls back to the project default when calendarId is null', () => {
    // Control case — already covered indirectly but pinned here for the
    // override path's regression suite.
    const A = node('A', 8);
    const input: ScheduleInput = {
      project: {
        name: 'Test',
        startDate: START_DATE,
        defaultCalendarId: 'cal-default',
        displayUnit: 'days',
        shareMode: 'percentage',
      },
      nodes: [A],
      edges: [],
      resources: [],
      calendars: [MON_FRI, SAT_SUN],
      loops: [],
    };
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.nodes['A']!.earliestStart).toEqual(d(2026, 1, 5, 8));
    expect(out.result.nodes['A']!.earliestFinish).toEqual(d(2026, 1, 5, 16));
  });
});

// ── Phase 10 Tier 1: zero-duration nodes (start/end) ─────────────────────────

describe('zero-duration nodes', () => {
  it('a Start→Activity→End graph schedules identically to the bare Activity', () => {
    // Bare activity: A only.
    const bare = schedule(makeInput([node('A', 8)], []));
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;

    // Wrapped: Start (0h) → A (8h) → End (0h).
    const start: ProjectNode = { ...node('S', 0), nodeType: 'start', name: 'Start' };
    const end: ProjectNode = { ...node('E', 0), nodeType: 'end', name: 'End' };
    const wrapped = schedule(
      makeInput([start, node('A', 8), end], [edge('e1', 'S', 'A'), edge('e2', 'A', 'E')]),
    );
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;

    // A's timing must be identical with or without the Start/End anchors.
    expect(wrapped.result.nodes['A']!.earliestStart).toEqual(bare.result.nodes['A']!.earliestStart);
    expect(wrapped.result.nodes['A']!.earliestFinish).toEqual(
      bare.result.nodes['A']!.earliestFinish,
    );

    // Start/End collapse to the boundary instants of the project.
    expect(wrapped.result.nodes['S']!.earliestStart).toEqual(
      wrapped.result.nodes['S']!.earliestFinish,
    );
    expect(wrapped.result.nodes['E']!.earliestStart).toEqual(
      wrapped.result.nodes['E']!.earliestFinish,
    );
    expect(wrapped.result.nodes['E']!.earliestFinish).toEqual(
      wrapped.result.nodes['A']!.earliestFinish,
    );
  });

  it('a Start node with anchorDate pins its descendants to that date', () => {
    // Project startDate = Mon 2026-01-05, but the Start node anchors to Mon 2026-02-02.
    // Descendants should flow from the anchor, not the project start.
    const start: ProjectNode = {
      ...node('S', 0),
      nodeType: 'start',
      name: 'Start',
      anchorDate: '2026-02-02',
    };
    const out = schedule(makeInput([start, node('A', 8)], [edge('e1', 'S', 'A')]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Start collapses to Mon 2026-02-02 08:00 (snapped working start of that date)
    expect(out.result.nodes['S']!.earliestStart).toEqual(d(2026, 2, 2, 8));
    expect(out.result.nodes['S']!.earliestFinish).toEqual(d(2026, 2, 2, 8));
    // A inherits the anchor via its FS edge from S
    expect(out.result.nodes['A']!.earliestStart).toEqual(d(2026, 2, 2, 8));
    expect(out.result.nodes['A']!.earliestFinish).toEqual(d(2026, 2, 2, 16));
  });

  it('a Start node without anchorDate falls back to project startDate', () => {
    const start: ProjectNode = { ...node('S', 0), nodeType: 'start', name: 'Start' };
    const out = schedule(makeInput([start, node('A', 8)], [edge('e1', 'S', 'A')]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // No anchorDate → S sits at the project start (Mon 2026-01-05 08:00).
    expect(out.result.nodes['S']!.earliestStart).toEqual(d(2026, 1, 5, 8));
    expect(out.result.nodes['A']!.earliestStart).toEqual(d(2026, 1, 5, 8));
    expect(out.result.nodes['A']!.earliestFinish).toEqual(d(2026, 1, 5, 16));
  });

  it('two independent chains with separate Start anchors schedule independently', () => {
    // S1 (anchor Feb 2) → A   |   S2 (anchor Mar 2) → B
    // Two disjoint chains; each anchors to its own Start.
    const s1: ProjectNode = {
      ...node('S1', 0),
      nodeType: 'start',
      name: 'Start1',
      anchorDate: '2026-02-02',
    };
    const s2: ProjectNode = {
      ...node('S2', 0),
      nodeType: 'start',
      name: 'Start2',
      anchorDate: '2026-03-02',
    };
    const out = schedule(
      makeInput(
        [s1, node('A', 8), s2, node('B', 8)],
        [edge('e1', 'S1', 'A'), edge('e2', 'S2', 'B')],
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.nodes['A']!.earliestStart).toEqual(d(2026, 2, 2, 8));
    expect(out.result.nodes['B']!.earliestStart).toEqual(d(2026, 3, 2, 8));
  });

  it('errors when a Start node has no outgoing edges', () => {
    // S is dangling — no chain to anchor.
    const s: ProjectNode = { ...node('S', 0), nodeType: 'start', name: 'Lonely' };
    const out = schedule(makeInput([s, node('A', 8)], []));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors.some((e) => /not connected/i.test(e.message))).toBe(true);
  });

  it('allows two Starts to converge transitively at a join (max of predecessors wins)', () => {
    // S1 (2026-02-02) → A → C  |  S2 (2026-03-02) → B → C
    // Both chains are independent until C. C's earliest start is the max of
    // (A.ef, B.ef) — i.e. the later chain dictates when C can begin.
    // This is the screenshot pattern: an unanchored side-branch given its own
    // Start so it doesn't inherit projectStart.
    const s1: ProjectNode = {
      ...node('S1', 0),
      nodeType: 'start',
      name: 'Start1',
      anchorDate: '2026-02-02',
    };
    const s2: ProjectNode = {
      ...node('S2', 0),
      nodeType: 'start',
      name: 'Start2',
      anchorDate: '2026-03-02',
    };
    const out = schedule(
      makeInput(
        [s1, s2, node('A', 8), node('B', 8), node('C', 8)],
        [edge('e1', 'S1', 'A'), edge('e2', 'S2', 'B'), edge('e3', 'A', 'C'), edge('e4', 'B', 'C')],
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // A starts on its anchor (Mon 2026-02-02), B starts on its (Mon 2026-03-02).
    expect(out.result.nodes['A']!.earliestStart).toEqual(d(2026, 2, 2, 8));
    expect(out.result.nodes['B']!.earliestStart).toEqual(d(2026, 3, 2, 8));
    // C waits for the later of the two chain ends — B's branch (2026-03-02 16:00).
    expect(out.result.nodes['C']!.earliestStart).toEqual(d(2026, 3, 3, 8));
  });

  it('anchors descendants EARLIER than projectStart when anchorDate is earlier', () => {
    // projectStart = 2026-01-05; anchor the chain back to 2025-12-01 (Mon).
    // The previous "one-way push" semantics floored descendants at
    // projectStart; the fix lets them move into the past.
    const start: ProjectNode = {
      ...node('S', 0),
      nodeType: 'start',
      name: 'Start',
      anchorDate: '2025-12-01',
    };
    const out = schedule(makeInput([start, node('A', 8)], [edge('e1', 'S', 'A')]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.nodes['S']!.earliestStart).toEqual(d(2025, 12, 1, 8));
    expect(out.result.nodes['A']!.earliestStart).toEqual(d(2025, 12, 1, 8));
    expect(out.result.nodes['A']!.earliestFinish).toEqual(d(2025, 12, 1, 16));
  });

  it('a non-working anchorDate is snapped forward to the next working moment', () => {
    // 2026-02-01 is a Sunday — under the Mon–Fri calendar that snaps to Mon 02-02 08:00.
    const start: ProjectNode = {
      ...node('S', 0),
      nodeType: 'start',
      name: 'Start',
      anchorDate: '2026-02-01',
    };
    const out = schedule(makeInput([start, node('A', 8)], [edge('e1', 'S', 'A')]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.nodes['S']!.earliestStart).toEqual(d(2026, 2, 2, 8));
    expect(out.result.nodes['A']!.earliestStart).toEqual(d(2026, 2, 2, 8));
  });
});

// ── Phase 11: decision nodes ─────────────────────────────────────────────────

describe('decision nodes', () => {
  it('a decision with passProbability=1 schedules identically to an activity', () => {
    // 2026-01-05 is Monday, work begins at 08:00 on the Mon–Fri cal.
    const decision: ProjectNode = {
      ...node('A', 8),
      nodeType: 'decision',
      passProbability: 1,
      failureDelay: { value: 8, unit: 'hours' },
    };
    const out = schedule(makeInput([decision], []));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Same finish as a plain 8h activity: Mon 16:00.
    expect(out.result.nodes['A']!.earliestFinish).toEqual(d(2026, 1, 5, 16));
  });

  it('a decision with passProbability=0.5, failureDelay=8h adds 4h (expected value)', () => {
    // duration 8h + (1 − 0.5) × 8h = 12h. Starting Mon 08:00 on a 8h-day cal,
    // 12 working hours lands Tue 12:00.
    const decision: ProjectNode = {
      ...node('A', 8),
      nodeType: 'decision',
      passProbability: 0.5,
      failureDelay: { value: 8, unit: 'hours' },
    };
    const out = schedule(makeInput([decision], []));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.nodes['A']!.earliestFinish).toEqual(d(2026, 1, 6, 12));
  });

  it('a decision with passProbability=0 (always fails) adds the full failureDelay', () => {
    // duration 8h + (1 − 0) × 8h = 16h. Mon 08:00 + 16 working hrs = Tue 16:00.
    const decision: ProjectNode = {
      ...node('A', 8),
      nodeType: 'decision',
      passProbability: 0,
      failureDelay: { value: 8, unit: 'hours' },
    };
    const out = schedule(makeInput([decision], []));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.nodes['A']!.earliestFinish).toEqual(d(2026, 1, 6, 16));
  });

  it('decision penalty propagates into the project end time', () => {
    // Activity → Decision: the decision's penalty extends the chain.
    const a = node('A', 8);
    const dec: ProjectNode = {
      ...node('B', 8),
      nodeType: 'decision',
      passProbability: 0.5,
      failureDelay: { value: 4, unit: 'hours' },
    };
    const out = schedule(makeInput([a, dec], [edge('e1', 'A', 'B')]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // A: Mon 08:00 → Mon 16:00 (8h). B starts at next working moment Tue 08:00,
    // runs 10h effective → Tue 16:00 (8h) then Wed 08:00 → Wed 10:00 (2h) = Wed 10:00.
    expect(out.result.nodes['B']!.earliestFinish).toEqual(d(2026, 1, 7, 10));
    expect(out.result.projectEnd).toEqual(d(2026, 1, 7, 10));
  });

  it('decision without passProbability/failureDelay defaults to no penalty', () => {
    // Schema permits these fields to be absent on a decision node — equivalent
    // to passProbability=1 and failureDelay=0 (no expected penalty).
    const decision: ProjectNode = {
      ...node('A', 8),
      nodeType: 'decision',
    };
    const out = schedule(makeInput([decision], []));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.nodes['A']!.earliestFinish).toEqual(d(2026, 1, 5, 16));
  });
});

// ── Duration units ────────────────────────────────────────────────────────────

describe('duration units', () => {
  it('1 day = 8 hours on Mon–Fri cal', () => {
    const n: ProjectNode = { ...node('A', 1), duration: { value: 1, unit: 'days' } };
    const out = schedule(makeInput([n], []));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.nodes['A']!.earliestFinish).toEqual(d(2026, 1, 5, 16));
  });

  it('1 week = 40 hours on Mon–Fri 8h/day cal', () => {
    const n: ProjectNode = { ...node('A', 1), duration: { value: 1, unit: 'weeks' } };
    const out = schedule(makeInput([n], []));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.nodes['A']!.earliestFinish).toEqual(d(2026, 1, 9, 16));
  });
});

// ── Non-FS combination chains ─────────────────────────────────────────────────

describe('non-FS chains', () => {
  it('SS → FF chain produces correct schedule', () => {
    // A(8h) -SS(0)-> B(8h) -FF(0)-> C(8h)
    // B starts when A starts; C must finish when B finishes (lag=0)
    // FF constraint: EF_C ≥ EF_B = Mon 16:00 → ES_C = Mon 16:00 − 8h = Mon 08:00
    // All three are concurrent on Monday.
    const nodes = [node('A', 8), node('B', 8), node('C', 8)];
    const edges = [edge('e1', 'A', 'B', 'SS', 0), edge('e2', 'B', 'C', 'FF', 0)];
    const out = schedule(makeInput(nodes, edges));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { nodes: ns } = out.result;
    // B: starts Mon 08:00 (SS from A), finishes Mon 16:00
    expect(ns['B']!.earliestStart).toEqual(d(2026, 1, 5, 8));
    expect(ns['B']!.earliestFinish).toEqual(d(2026, 1, 5, 16));
    // C: EF_C ≥ EF_B (Mon 16:00), so C starts Mon 08:00 and finishes Mon 16:00
    expect(ns['C']!.earliestStart).toEqual(d(2026, 1, 5, 8));
    expect(ns['C']!.earliestFinish).toEqual(d(2026, 1, 5, 16));
  });

  it('SF dependency with positive lag', () => {
    // A(8h) -SF(16h)-> B(8h): B finishes 16h after A starts
    // ES_A = Mon 08:00; constraint = Mon 08:00 + 16h − 8h = Mon 08:00 + 8h = Mon 16:00
    // snap → Tue 08:00; EF_B = Tue 16:00
    const out = schedule(makeInput([node('A', 8), node('B', 8)], [edge('e', 'A', 'B', 'SF', 16)]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.nodes['B']!.earliestStart).toEqual(d(2026, 1, 6, 8));
    expect(out.result.nodes['B']!.earliestFinish).toEqual(d(2026, 1, 6, 16));
  });
});

// ── Backward pass / slack / critical path ────────────────────────────────────

describe('backward pass and slack', () => {
  it('all nodes on a single chain are critical (slack=0)', () => {
    // A → B → C, each 8h
    const out = schedule(
      makeInput(
        [node('A', 8), node('B', 8), node('C', 8)],
        [edge('e1', 'A', 'B'), edge('e2', 'B', 'C')],
      ),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { nodes: ns } = out.result;
    expect(ns['A']!.slackHours).toBeCloseTo(0, 4);
    expect(ns['B']!.slackHours).toBeCloseTo(0, 4);
    expect(ns['C']!.slackHours).toBeCloseTo(0, 4);
  });

  it('LS = LF − duration for every node', () => {
    // A(8h) → B(16h)
    const out = schedule(makeInput([node('A', 8), node('B', 16)], [edge('e', 'A', 'B')]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { nodes: ns } = out.result;
    // A: LF=Tue 08:00, LS=Mon 08:00
    expect(ns['A']!.latestStart).toEqual(d(2026, 1, 5, 8));
    expect(ns['A']!.latestFinish).toEqual(d(2026, 1, 6, 8));
    // B: LF = project end = Wed 16:00, LS = Tue 08:00
    expect(ns['B']!.latestStart).toEqual(d(2026, 1, 6, 8));
    expect(ns['B']!.latestFinish).toEqual(d(2026, 1, 7, 16));
  });

  it('project end equals the latest EF across all nodes', () => {
    const out = schedule(makeInput([node('A', 8), node('B', 16)], []));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.projectEnd).toEqual(d(2026, 1, 6, 16));
  });
});

// ── Resource timeline ────────────────────────────────────────────────────────

describe('resource timeline', () => {
  it('entries appear for nodes with consumesResources=true', () => {
    const resource = {
      id: 'r1',
      name: 'R1',
      capacity: 2,
      calendarId: 'cal-default',
    };
    const n: ProjectNode = {
      ...node('A', 8),
      consumesResources: true,
      resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
    };
    const input: ScheduleInput = {
      ...makeInput([n], []),
      resources: [resource],
    };
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.resourceTimeline.length).toBe(1);
    const entry = out.result.resourceTimeline[0]!;
    expect(entry.resourceId).toBe('r1');
    expect(entry.count).toBe(1);
    expect(entry.iteration).toBe(0);
  });

  it('nodes with consumesResources=false are excluded from timeline', () => {
    const n: ProjectNode = { ...node('A', 8), consumesResources: false };
    const out = schedule(makeInput([n], []));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.resourceTimeline.length).toBe(0);
  });
});

// ── Property-based: random DAG invariants ────────────────────────────────────

describe('property-based: random DAG invariants', () => {
  // Generate a random DAG (guaranteed acyclic via topological numbering)
  function randomDag(
    seed: number,
    nodeCount: number,
    edgeDensity: number,
  ): { nodes: ProjectNode[]; edges: ProjectEdge[] } {
    // Simple LCG PRNG
    let s = seed;
    const rand = () => {
      s = (s * 1664525 + 1013904223) & 0xffffffff;
      return (s >>> 0) / 0xffffffff;
    };

    const ns: ProjectNode[] = [];
    for (let i = 0; i < nodeCount; i++) {
      ns.push(node(`n${i}`, Math.floor(rand() * 16 + 1))); // 1–16 h
    }

    const es: ProjectEdge[] = [];
    let eId = 0;
    for (let i = 0; i < nodeCount; i++) {
      for (let j = i + 1; j < nodeCount; j++) {
        if (rand() < edgeDensity) {
          // Only add edge i→j (i < j ensures no cycle)
          es.push(edge(`e${eId++}`, `n${i}`, `n${j}`, 'FS', 0));
        }
      }
    }
    return { nodes: ns, edges: es };
  }

  for (let seed = 1; seed <= 5; seed++) {
    it(`seed=${seed}: all FS constraints satisfied and all slack ≥ 0`, () => {
      const { nodes: ns, edges: es } = randomDag(seed, 10, 0.3);
      const out = schedule(makeInput(ns, es));
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const { nodes: scheduled } = out.result;

      // Build edge lookup
      const nodeMap = new Map(ns.map((n) => [n.id, n]));

      // All FS constraints satisfied: EF_pred ≤ ES_succ
      for (const e of es) {
        const pred = scheduled[e.from]!;
        const succ = scheduled[e.to]!;
        expect(pred.earliestFinish.getTime()).toBeLessThanOrEqual(succ.earliestStart.getTime() + 1);
      }

      // All slack ≥ 0
      for (const sched of Object.values(scheduled)) {
        expect(sched.slackHours).toBeGreaterThanOrEqual(-0.001);
      }

      // Critical path nodes exist
      const criticals = Object.values(scheduled).filter((s) => s.onCriticalPath);
      expect(criticals.length).toBeGreaterThan(0);

      // Project end = max EF
      const maxEf = Math.max(...Object.values(scheduled).map((s) => s.earliestFinish.getTime()));
      expect(out.result.projectEnd.getTime()).toBe(maxEf);

      // unused variable suppression
      void nodeMap;
    });
  }
});

// ── Loop scheduling (Phase 7) ─────────────────────────────────────────────────

describe('loop scheduling', () => {
  const LOOP_RESOURCE = { id: 'r1', name: 'R1', capacity: 2, calendarId: 'cal-default' };

  // Body node with consumesResources=true — produces resource timeline entries
  const workNode: ProjectNode = {
    id: 'work',
    nodeType: 'activity',
    name: 'Work',
    duration: { value: 8, unit: 'hours' },
    durationSemantic: 'time',
    position: { x: 0, y: 0 },
    calendarId: null,
    consumesResources: true,
    resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
  };

  // Body node with consumesResources=false — wait-state, no resource entries
  const waitNode: ProjectNode = {
    id: 'wait',
    nodeType: 'activity',
    name: 'Wait',
    duration: { value: 8, unit: 'hours' },
    durationSemantic: 'time',
    position: { x: 0, y: 0 },
    calendarId: null,
    consumesResources: false,
    resourceAssignments: [],
  };

  // Loop: 3 deterministic iterations of work → wait body (sequential, bodyCP = 16h)
  const threeIterLoop: Loop = {
    id: 'loop1',
    bodyNodeIds: ['work', 'wait'],
    kickout: { type: 'maxIterations', value: 3 },
    expectedIterations: { type: 'triangular', min: 3, mode: 3, max: 3 },
  };

  function makeLoopInput(
    loops: Loop[],
    sampledLoopIterations?: Record<string, number>,
  ): ScheduleInput {
    return {
      project: {
        name: 'T',
        startDate: START_DATE,
        defaultCalendarId: 'cal-default',
        displayUnit: 'days',
        shareMode: 'percentage',
      },
      nodes: [workNode, waitNode],
      edges: [edge('e1', 'work', 'wait')],
      resources: [LOOP_RESOURCE],
      calendars: [MON_FRI],
      loops,
      // exactOptionalPropertyTypes: don't spread undefined; omit the key instead
      ...(sampledLoopIterations !== undefined ? { sampledLoopIterations } : {}),
    };
  }

  // ── DoD #1: resource histogram shows exactly 3 bars, no phantom utilization ──

  it('DoD #1: 3 iterations produce exactly 3 resource entries for the work node', () => {
    const out = schedule(makeLoopInput([threeIterLoop]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const { resourceTimeline } = out.result;

    // Exactly 3 entries — one per iteration of the work node
    expect(resourceTimeline).toHaveLength(3);

    for (const entry of resourceTimeline) {
      expect(entry.nodeId).toBe('work');
      expect(entry.resourceId).toBe('r1');
      expect(entry.count).toBe(1);
    }

    // Iteration numbers are 1, 2, 3
    const iterNums = resourceTimeline.map((e) => e.iteration).sort((a, b) => a - b);
    expect(iterNums).toEqual([1, 2, 3]);
  });

  it('wait-state body node (consumesResources=false) produces no resource entries', () => {
    const out = schedule(makeLoopInput([threeIterLoop]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const waitEntries = out.result.resourceTimeline.filter((e) => e.nodeId === 'wait');
    expect(waitEntries).toHaveLength(0);
  });

  it('iteration 1 of work node starts at project start (Mon 08:00)', () => {
    const out = schedule(makeLoopInput([threeIterLoop]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const iter1 = out.result.resourceTimeline.find((e) => e.iteration === 1)!;
    expect(iter1).toBeDefined();
    expect(iter1.start).toEqual(d(2026, 1, 5, 8)); // Mon 08:00
    expect(iter1.end).toEqual(d(2026, 1, 5, 16)); // Mon 16:00
  });

  // ── Body node schedule distribution ──────────────────────────────────────────

  it('body node schedule reflects first-iteration timing', () => {
    const out = schedule(makeLoopInput([threeIterLoop]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const { nodes } = out.result;
    // work: esHours=0 → ES = Mon 08:00, efHours=8 → EF = Mon 16:00
    expect(nodes['work']!.earliestStart).toEqual(d(2026, 1, 5, 8));
    expect(nodes['work']!.earliestFinish).toEqual(d(2026, 1, 5, 16));
    // wait: esHours=8 → ES offset into Mon; efHours=16 → EF = Tue 16:00
    expect(nodes['wait']!.earliestFinish).toEqual(d(2026, 1, 6, 16)); // Tue 16:00
  });

  // ── sampledLoopIterations override ───────────────────────────────────────────

  it('sampledLoopIterations=2 overrides deterministicIterationCount=3', () => {
    const out = schedule(makeLoopInput([threeIterLoop], { loop1: 2 }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.result.resourceTimeline).toHaveLength(2);
    const iterNums = out.result.resourceTimeline.map((e) => e.iteration).sort((a, b) => a - b);
    expect(iterNums).toEqual([1, 2]);
  });

  // ── Loop + successor node: successor starts after all iterations ─────────────

  it('non-loop successor node starts after the full loop (all 3 iterations)', () => {
    // Edges from both body nodes into afterNode get condensed to one super→after edge
    const afterNode = node('after', 8);
    const input: ScheduleInput = {
      project: {
        name: 'T',
        startDate: START_DATE,
        defaultCalendarId: 'cal-default',
        displayUnit: 'days',
        shareMode: 'percentage',
      },
      nodes: [workNode, waitNode, afterNode],
      edges: [
        edge('e1', 'work', 'wait'),
        edge('e-after-work', 'work', 'after'),
        edge('e-after-wait', 'wait', 'after'),
      ],
      resources: [LOOP_RESOURCE],
      calendars: [MON_FRI],
      loops: [threeIterLoop],
    };
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // Super-node duration = 3 × 16h = 48h from Mon Jan 5 08:00
    // 40h = end of Fri Jan 9 (Mon–Fri week); +8h = Mon Jan 12 16:00 → super-node EF
    // After node: starts at next work start after Mon Jan 12 16:00 = Tue Jan 13 08:00
    expect(out.result.nodes['after']!.earliestStart).toEqual(d(2026, 1, 13, 8));
  });

  // ── DoD #2: Undeclared cycle → validation error ───────────────────────────────

  it('DoD #2: undeclared cycle returns validation error with loop hint', () => {
    const out = schedule(
      makeInput([node('A', 8), node('B', 8)], [edge('e1', 'A', 'B'), edge('e2', 'B', 'A')]),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    const msg = out.errors[0]!.message;
    expect(msg).toMatch(/cycle/i);
    // Hint about using Loop construct
    expect(msg).toMatch(/loop/i);
  });

  // ── Validation: bad loop metadata ────────────────────────────────────────────

  it('unknown body node ID in loop returns validation error', () => {
    const badLoop: Loop = {
      id: 'loop1',
      bodyNodeIds: ['work', 'GHOST'],
      kickout: { type: 'maxIterations', value: 3 },
      expectedIterations: { type: 'triangular', min: 3, mode: 3, max: 3 },
    };
    const out = schedule(makeLoopInput([badLoop]));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors[0]!.message).toMatch(/GHOST/);
  });

  it('node appearing in two loops returns validation error', () => {
    const loopA: Loop = {
      id: 'loopA',
      bodyNodeIds: ['work'],
      kickout: { type: 'maxIterations', value: 2 },
      expectedIterations: { type: 'triangular', min: 2, mode: 2, max: 2 },
    };
    const loopB: Loop = {
      id: 'loopB',
      bodyNodeIds: ['work', 'wait'],
      kickout: { type: 'maxIterations', value: 2 },
      expectedIterations: { type: 'triangular', min: 2, mode: 2, max: 2 },
    };
    const out = schedule({
      project: {
        name: 'T',
        startDate: START_DATE,
        defaultCalendarId: 'cal-default',
        displayUnit: 'days',
        shareMode: 'percentage',
      },
      nodes: [workNode, waitNode],
      edges: [],
      resources: [LOOP_RESOURCE],
      calendars: [MON_FRI],
      loops: [loopA, loopB],
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // Error should mention both loops and the shared node
    const msg = out.errors[0]!.message;
    expect(msg).toMatch(/work/);
    expect(msg).toMatch(/loopA/);
    expect(msg).toMatch(/loopB/);
  });
});

// ── Phase 50 Slice 6 — loop body cycle detection (audit C-2) ──────────────────

describe('loop body cycle detection (audit C-2)', () => {
  const RESOURCE = { id: 'r1', name: 'R1', capacity: 2, calendarId: 'cal-default' };

  function bodyNode(id: string): ProjectNode {
    return {
      id,
      nodeType: 'activity',
      name: id,
      duration: { value: 8, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: true,
      resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
    };
  }

  function inputWithLoops(
    bodyNodeDefs: ProjectNode[],
    edges: ProjectEdge[],
    loops: Loop[],
  ): ScheduleInput {
    return {
      project: {
        name: 'T',
        startDate: START_DATE,
        defaultCalendarId: 'cal-default',
        displayUnit: 'days',
        shareMode: 'percentage',
      },
      nodes: bodyNodeDefs,
      edges,
      resources: [RESOURCE],
      calendars: [MON_FRI],
      loops,
    };
  }

  it('rejects a loop body with a back-edge between two body nodes (A→B, B→A)', () => {
    const out = schedule(
      inputWithLoops(
        [bodyNode('A'), bodyNode('B')],
        [edge('e1', 'A', 'B'), edge('e2', 'B', 'A')],
        [
          {
            id: 'loop1',
            bodyNodeIds: ['A', 'B'],
            kickout: { type: 'maxIterations', value: 2 },
            expectedIterations: { type: 'triangular', min: 2, mode: 2, max: 2 },
          },
        ],
      ),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    const msg = out.errors.find((e) => /Cycle detected inside loop/i.test(e.message))?.message;
    expect(msg).toBeDefined();
    expect(msg).toMatch(/loop1/);
    expect(msg).toMatch(/\bA\b/);
    expect(msg).toMatch(/\bB\b/);
  });

  it('rejects a 3-node loop body where the cycle is between just two of them (A→B→C, C→B)', () => {
    const out = schedule(
      inputWithLoops(
        [bodyNode('A'), bodyNode('B'), bodyNode('C')],
        [edge('e1', 'A', 'B'), edge('e2', 'B', 'C'), edge('e3', 'C', 'B')],
        [
          {
            id: 'loop2',
            bodyNodeIds: ['A', 'B', 'C'],
            kickout: { type: 'maxIterations', value: 2 },
            expectedIterations: { type: 'triangular', min: 2, mode: 2, max: 2 },
          },
        ],
      ),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    const msg = out.errors.find((e) => /Cycle detected inside loop/i.test(e.message))?.message;
    expect(msg).toBeDefined();
    expect(msg).toMatch(/loop2/);
    // The cycle involves B and C (not A, which is the body entry).
    expect(msg).toMatch(/\bB\b/);
    expect(msg).toMatch(/\bC\b/);
  });

  it('accepts a benign loop body with no internal cycles (regression: the new check must not false-positive)', () => {
    const out = schedule(
      inputWithLoops(
        [bodyNode('A'), bodyNode('B'), bodyNode('C')],
        [edge('e1', 'A', 'B'), edge('e2', 'B', 'C')],
        [
          {
            id: 'healthy',
            bodyNodeIds: ['A', 'B', 'C'],
            kickout: { type: 'maxIterations', value: 2 },
            expectedIterations: { type: 'triangular', min: 2, mode: 2, max: 2 },
          },
        ],
      ),
    );
    expect(out.ok).toBe(true);
  });

  it('reports only the cyclic loop when one body cycles and another is healthy', () => {
    const out = schedule(
      inputWithLoops(
        [bodyNode('A1'), bodyNode('B1'), bodyNode('A2'), bodyNode('B2')],
        [
          edge('e1', 'A1', 'B1'),
          edge('e2', 'B1', 'A1'), // cyclic
          edge('e3', 'A2', 'B2'), // healthy
        ],
        [
          {
            id: 'bad',
            bodyNodeIds: ['A1', 'B1'],
            kickout: { type: 'maxIterations', value: 2 },
            expectedIterations: { type: 'triangular', min: 2, mode: 2, max: 2 },
          },
          {
            id: 'good',
            bodyNodeIds: ['A2', 'B2'],
            kickout: { type: 'maxIterations', value: 2 },
            expectedIterations: { type: 'triangular', min: 2, mode: 2, max: 2 },
          },
        ],
      ),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    const cycleErrors = out.errors.filter((e) => /Cycle detected inside loop/i.test(e.message));
    expect(cycleErrors).toHaveLength(1);
    expect(cycleErrors[0]!.message).toMatch(/bad/);
    expect(cycleErrors[0]!.message).not.toMatch(/good/);
  });
});

// ── Phase 50 Slice 18 — audit row I-1 ─────────────────────────────────────────
//
// Body nodes on a loop's critical path must appear in `criticalPaths[][]`
// (not just the synthetic `__loop__<id>` super-node id), AND every body
// node on a critical chain must have `onCriticalPath: true` (not only the
// sink, which was the prior `onBodyCP` heuristic's behavior).

describe('audit I-1: critical-path tracer includes loop-body edges', () => {
  it('critical path contains body node ids in source→sink order (not super-node id)', () => {
    // Pre-loop activity → loop[A→B→C body] → post-loop activity.
    // All FS edges, all 8h activities, single Mon–Fri calendar.
    // Project critical path runs through every node.
    const pre: ProjectNode = node('pre', 8);
    const a: ProjectNode = node('A', 4);
    const b: ProjectNode = node('B', 4);
    const c: ProjectNode = node('C', 4);
    const post: ProjectNode = node('post', 8);

    const loop1: Loop = {
      id: 'L1',
      bodyNodeIds: ['A', 'B', 'C'],
      kickout: { type: 'maxIterations', value: 2 },
      expectedIterations: { type: 'triangular', min: 2, mode: 2, max: 2 },
    };

    const input: ScheduleInput = {
      project: {
        name: 'I-1 test',
        startDate: START_DATE,
        defaultCalendarId: 'cal-default',
        displayUnit: 'days',
        shareMode: 'percentage',
      },
      nodes: [pre, a, b, c, post],
      edges: [
        edge('e-pre-A', 'pre', 'A'),
        edge('e-A-B', 'A', 'B'),
        edge('e-B-C', 'B', 'C'),
        edge('e-C-post', 'C', 'post'),
      ],
      resources: [],
      calendars: [MON_FRI],
      loops: [loop1],
    };

    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // At least one critical path; the longest one runs through everything.
    expect(out.result.criticalPaths.length).toBeGreaterThan(0);
    const cp = out.result.criticalPaths[0]!;

    // The synthetic super-node id must NOT appear.
    expect(cp.some((id) => id.startsWith('__loop__'))).toBe(false);

    // Body nodes A, B, C must appear in order (and after `pre`, before `post`).
    const idxPre = cp.indexOf('pre');
    const idxA = cp.indexOf('A');
    const idxB = cp.indexOf('B');
    const idxC = cp.indexOf('C');
    const idxPost = cp.indexOf('post');

    expect(idxPre).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeGreaterThan(idxPre);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxB);
    expect(idxPost).toBeGreaterThan(idxC);
  });

  it('all body-critical nodes have onCriticalPath: true (not just the sink)', () => {
    // Same shape as above. Previously only C (the sink with efHours==cpHours)
    // would get onCriticalPath: true; A and B would not, even though they're
    // on the body's critical chain.
    const pre: ProjectNode = node('pre', 8);
    const a: ProjectNode = node('A', 4);
    const b: ProjectNode = node('B', 4);
    const c: ProjectNode = node('C', 4);
    const post: ProjectNode = node('post', 8);

    const loop1: Loop = {
      id: 'L1',
      bodyNodeIds: ['A', 'B', 'C'],
      kickout: { type: 'maxIterations', value: 2 },
      expectedIterations: { type: 'triangular', min: 2, mode: 2, max: 2 },
    };

    const input: ScheduleInput = {
      project: {
        name: 'I-1 onCriticalPath test',
        startDate: START_DATE,
        defaultCalendarId: 'cal-default',
        displayUnit: 'days',
        shareMode: 'percentage',
      },
      nodes: [pre, a, b, c, post],
      edges: [
        edge('e-pre-A', 'pre', 'A'),
        edge('e-A-B', 'A', 'B'),
        edge('e-B-C', 'B', 'C'),
        edge('e-C-post', 'C', 'post'),
      ],
      resources: [],
      calendars: [MON_FRI],
      loops: [loop1],
    };

    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.result.nodes['A']!.onCriticalPath).toBe(true);
    expect(out.result.nodes['B']!.onCriticalPath).toBe(true);
    expect(out.result.nodes['C']!.onCriticalPath).toBe(true);
  });
});

// ── Phase 50 Slice 21 — audit row I-6 ─────────────────────────────────────────
//
// `bodyCriticalPathHours` used to return `0.001` for a zero-duration body
// rather than `0`. The synthetic value × iterations leaked into super-node
// duration → slack pollution proportional to the loop's iteration count
// (a 1000-iter loop with a zero-duration body adds 1.0 fake hour). Now
// the function returns the literal max (including 0).

describe('audit I-6: zero-duration loop body contributes zero hours', () => {
  it('1000-iteration loop with a single zero-duration body node has zero-duration super-node', () => {
    // Single body node with 0h duration. The loop's super-node duration
    // would be cpHours × iterations = 0.001 × 1000 = 1.0h pre-fix; 0h
    // post-fix. We verify the loop adds no working hours to the project
    // by comparing the project end against a baseline with no loop.
    const zero: ProjectNode = {
      ...node('z', 0),
      // Zero-duration but consumes resources is allowed; here we leave it
      // off to keep the scenario uncluttered.
      consumesResources: false,
      resourceAssignments: [],
    };
    const post: ProjectNode = node('post', 8);

    const loopNoOpBody: Loop = {
      id: 'LZ',
      bodyNodeIds: ['z'],
      kickout: { type: 'maxIterations', value: 1000 },
      expectedIterations: { type: 'triangular', min: 1000, mode: 1000, max: 1000 },
    };

    const input: ScheduleInput = {
      project: {
        name: 'I-6 test',
        startDate: START_DATE,
        defaultCalendarId: 'cal-default',
        displayUnit: 'days',
        shareMode: 'percentage',
      },
      nodes: [zero, post],
      edges: [edge('e-z-post', 'z', 'post')],
      resources: [],
      calendars: [MON_FRI],
      loops: [loopNoOpBody],
    };

    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // post should start at project start (no working hours consumed by
    // the zero-duration loop). Project start is Mon Jan 5 2026 08:00.
    expect(out.result.nodes['post']!.earliestStart).toEqual(d(2026, 1, 5, 8));
    // post finishes 8 working hours later = same day 16:00.
    expect(out.result.nodes['post']!.earliestFinish).toEqual(d(2026, 1, 5, 16));
  });
});
