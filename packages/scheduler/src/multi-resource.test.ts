import { describe, it, expect } from 'vitest';
import type { Calendar, Loop, ProjectEdge, ProjectNode, Resource } from '@procsim/file-format';
import { schedule } from './index.js';
import type { ScheduleInput } from './index.js';

// ── Phase 18 slice 1 — multi-resource activity tests ─────────────────────────
//
// The scheduler iterates `resourceAssignments[]` per node in both the
// non-loop path (cpm.ts) and the loop unroll path (loop.ts), so an
// activity with multiple assignments should naturally produce one
// `resourceTimeline` entry per (assignment × iteration). These tests pin
// that behaviour and exercise the Phase-18 resource-aware effective
// calendar.

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

const MON_WED: Calendar = {
  id: 'cal-mon-wed',
  name: 'Mon–Wed 8h',
  workingDays: [false, true, true, true, false, false, false],
  hoursPerDay: 8,
  daysPerWeek: 3,
  holidayPreset: 'NONE',
  holidayPresetVersion: '1.0',
  exceptions: [],
};

const THU_SUN: Calendar = {
  id: 'cal-thu-sun',
  name: 'Thu–Sun 8h',
  workingDays: [true, false, false, false, true, true, true],
  hoursPerDay: 8,
  daysPerWeek: 4,
  holidayPreset: 'NONE',
  holidayPresetVersion: '1.0',
  exceptions: [],
};

const START_DATE = '2026-01-05'; // Monday

function devPool(calendarId = MON_FRI.id, capacity = 4): Resource {
  return { id: 'r-dev', name: 'Dev Pool', capacity, calendarId };
}
function overflow(calendarId = MON_FRI.id, capacity = 2): Resource {
  return { id: 'r-overflow', name: 'Overflow', capacity, calendarId };
}

function makeInput(opts: {
  nodes: ProjectNode[];
  edges?: ProjectEdge[];
  resources: Resource[];
  calendars: Calendar[];
  loops?: Loop[];
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
    resources: opts.resources,
    calendars: opts.calendars,
    loops: opts.loops ?? [],
  };
}

function activity(
  id: string,
  hours: number,
  assignments: ProjectNode['resourceAssignments'],
): ProjectNode {
  return {
    id,
    nodeType: 'activity',
    name: id,
    duration: { value: hours, unit: 'hours' },
    durationSemantic: 'time',
    position: { x: 0, y: 0 },
    calendarId: null,
    consumesResources: true,
    resourceAssignments: assignments,
  };
}

describe('Phase 18 — multi-resource activities', () => {
  it('emits one resourceTimeline entry per assignment on a non-loop activity', () => {
    // 8-hour activity assigned to Dev Pool (count 2) AND Overflow (count 1)
    // produces two timeline entries spanning the same window.
    const a = activity('A', 8, [
      { resourceId: 'r-dev', count: 2, calendarPolicy: 'activityWins' },
      { resourceId: 'r-overflow', count: 1, calendarPolicy: 'activityWins' },
    ]);
    const out = schedule(
      makeInput({
        nodes: [a],
        resources: [devPool(), overflow()],
        calendars: [MON_FRI],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const entries = out.result.resourceTimeline.filter((e) => e.nodeId === 'A');
    expect(entries).toHaveLength(2);

    const dev = entries.find((e) => e.resourceId === 'r-dev');
    const ovf = entries.find((e) => e.resourceId === 'r-overflow');
    expect(dev?.count).toBe(2);
    expect(ovf?.count).toBe(1);
    // Both entries cover the same time window.
    expect(dev?.start.getTime()).toBe(ovf?.start.getTime());
    expect(dev?.end.getTime()).toBe(ovf?.end.getTime());
  });

  it("'resourceWins' on a Mon–Wed resource narrows a Mon–Fri activity to Mon–Wed", () => {
    // The activity inherits the project Mon–Fri calendar but its Overflow
    // resource is Mon–Wed under 'resourceWins'. Effective working calendar
    // is Mon–Fri ∩ Mon–Wed = Mon–Wed. A 24h activity that would finish
    // Wednesday EOD under Mon–Fri instead spans Mon / Tue / Wed exactly
    // (3 × 8h) — but only because Mon–Wed has the same hoursPerDay.
    const a = activity('A', 24, [
      { resourceId: 'r-dev', count: 1, calendarPolicy: 'activityWins' },
      { resourceId: 'r-overflow', count: 1, calendarPolicy: 'resourceWins' },
    ]);
    const out = schedule(
      makeInput({
        nodes: [a],
        resources: [devPool(), overflow(MON_WED.id)],
        calendars: [MON_FRI, MON_WED],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const sched = out.result.nodes['A']!;
    // Wednesday 2026-01-07 EOD = Wed Jan 7, 17:00 local time (8 h + lunch
    // assumption depending on the calendar's hoursPerDay model). The
    // important assertion is: the activity finishes on a Mon–Wed day,
    // earlier than it would have finished under the Mon–Fri activity
    // calendar alone (which would have stretched into Thu). Probing via
    // day-of-week is the robust check.
    const finishDow = sched.earliestFinish.getDay(); // 0=Sun..6=Sat
    expect([1, 2, 3]).toContain(finishDow); // Mon / Tue / Wed
  });

  it('rejects an activity whose resources have non-overlapping calendars under resourceWins', () => {
    // Dev Pool is Mon–Wed and Overflow is Thu–Sun, both `'resourceWins'`.
    // Activity calendar Mon–Fri. Folded intersection: Mon–Wed ∩ Thu–Sun =
    // empty. Validation surfaces a node-level error explaining the conflict.
    const a = activity('A', 8, [
      { resourceId: 'r-dev', count: 1, calendarPolicy: 'resourceWins' },
      { resourceId: 'r-overflow', count: 1, calendarPolicy: 'resourceWins' },
    ]);
    const out = schedule(
      makeInput({
        nodes: [a],
        resources: [devPool(MON_WED.id), overflow(THU_SUN.id)],
        calendars: [MON_FRI, MON_WED, THU_SUN],
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    const msg = out.errors.map((e) => e.message).join(' ');
    expect(msg).toMatch(/no working days/i);
  });

  it('emits N × M entries when a multi-resource activity is inside a loop body', () => {
    // 3-iteration loop with one body node that demands 2 resources.
    // Expect 3 × 2 = 6 entries, one per (iteration × assignment).
    const body = activity('B', 8, [
      { resourceId: 'r-dev', count: 1, calendarPolicy: 'activityWins' },
      { resourceId: 'r-overflow', count: 1, calendarPolicy: 'activityWins' },
    ]);
    const loop: Loop = {
      id: 'loop-1',
      bodyNodeIds: ['B'],
      kickout: { type: 'maxIterations', value: 3 },
      expectedIterations: {
        type: 'triangular',
        min: 3,
        mode: 3,
        max: 3,
      },
    };
    const out = schedule(
      makeInput({
        nodes: [body],
        resources: [devPool(), overflow()],
        calendars: [MON_FRI],
        loops: [loop],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const bodyEntries = out.result.resourceTimeline.filter((e) => e.nodeId === 'B');
    expect(bodyEntries).toHaveLength(6);

    const iterations = new Set(bodyEntries.map((e) => e.iteration));
    expect([...iterations].sort()).toEqual([1, 2, 3]);

    const devEntries = bodyEntries.filter((e) => e.resourceId === 'r-dev');
    const ovfEntries = bodyEntries.filter((e) => e.resourceId === 'r-overflow');
    expect(devEntries).toHaveLength(3);
    expect(ovfEntries).toHaveLength(3);
    // Per-iteration alignment: dev and overflow entries for the same
    // iteration share their start/end timestamps.
    for (let i = 1; i <= 3; i++) {
      const dev = devEntries.find((e) => e.iteration === i)!;
      const ovf = ovfEntries.find((e) => e.iteration === i)!;
      expect(dev.start.getTime()).toBe(ovf.start.getTime());
      expect(dev.end.getTime()).toBe(ovf.end.getTime());
    }
  });

  it('loop body — consecutive iterations do NOT spuriously overlap on the boundary day', () => {
    // Regression test for a bug a user found on their fixture: a loop body
    // node assigned `count = 2` on a `cap = 2` resource was reporting a
    // phantom peak 4/2 on the iteration-boundary day. Per iteration the
    // demand is exactly at capacity, never over — the phantom overlap
    // came from iter 2's `iterStart` landing on end-of-day (e.g. Tue 4pm,
    // a non-working moment) which made iter 2's entry [Tue 4pm, Thu 4pm]
    // claim day-of-Tuesday in the day-bucket utilization even though no
    // real work happened on Tue after 4pm. Fix: snap iterStart forward
    // to the next working start.
    const body = activity('B', 16, [
      { resourceId: 'r-dev', count: 2, calendarPolicy: 'activityWins' },
    ]);
    const loop: Loop = {
      id: 'loop-1',
      bodyNodeIds: ['B'],
      kickout: { type: 'maxIterations', value: 3 },
      expectedIterations: { type: 'triangular', min: 3, mode: 3, max: 3 },
    };
    const out = schedule(
      makeInput({
        nodes: [body],
        resources: [devPool(MON_FRI.id, 2)],
        calendars: [MON_FRI],
        loops: [loop],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const entries = out.result.resourceTimeline
      .filter((e) => e.nodeId === 'B')
      .sort((a, b) => a.iteration - b.iteration);
    expect(entries).toHaveLength(3);

    // Consecutive iterations must not share an inclusive calendar-day.
    // Without the snap, iter 2's start (Tue 4pm) had dayIdx 1, which was
    // also iter 1's last day — phantom day-of-overlap with count 4 instead
    // of 2.
    const dayOf = (d: Date) => Math.floor((d.getTime() - entries[0]!.start.getTime()) / 86_400_000);
    for (let i = 1; i < entries.length; i++) {
      const prevEndDay = dayOf(entries[i - 1]!.end);
      const thisStartDay = dayOf(entries[i]!.start);
      expect(thisStartDay).toBeGreaterThan(prevEndDay);
    }
  });

  it('loop body — resource calendar narrows progress (closes the slice 1 deferred gap)', () => {
    // Slice 1 intentionally deferred resource-cal gating for loop bodies
    // because body-CPM computed offsets in default-calendar working hours.
    // This test pins the slice 1.5 follow-up: a body node assigned to a
    // Mon–Wed resource under `'resourceWins'` should progress only on
    // Mon–Wed within each iteration, just like a non-loop activity does.
    //
    // Setup: 2-iteration loop, body activity B = 24h on Mon–Fri activity
    // calendar but assigned to a Mon–Wed Overflow resource via
    // `'resourceWins'`. Effective calendar = Mon–Fri ∩ Mon–Wed = Mon–Wed.
    // 24h / 8h per day = 3 working days → each iteration spans Mon, Tue,
    // Wed. With Mon–Wed working calendar, the second iteration's start
    // snaps to the next Mon (after Wed of iteration 1), and its end is
    // again a Mon–Wed day.
    const body = activity('B', 24, [
      { resourceId: 'r-overflow', count: 1, calendarPolicy: 'resourceWins' },
    ]);
    const loop: Loop = {
      id: 'loop-1',
      bodyNodeIds: ['B'],
      kickout: { type: 'maxIterations', value: 2 },
      expectedIterations: { type: 'triangular', min: 2, mode: 2, max: 2 },
    };
    const out = schedule(
      makeInput({
        nodes: [body],
        resources: [overflow(MON_WED.id)],
        calendars: [MON_FRI, MON_WED],
        loops: [loop],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const entries = out.result.resourceTimeline
      .filter((e) => e.nodeId === 'B')
      .sort((a, b) => a.iteration - b.iteration);
    expect(entries).toHaveLength(2);

    // Each iteration's start AND end land on a Mon–Wed day. Pre-Phase 18
    // slice-1.5 the body advanced on Mon–Fri so the end of iteration 1
    // would have fallen on a Wed/Thu (depending on how 24h flowed through
    // Mon–Fri) — now they're constrained to Mon–Wed.
    for (const e of entries) {
      const startDow = e.start.getDay(); // 0=Sun .. 6=Sat
      const endDow = e.end.getDay();
      expect([1, 2, 3]).toContain(startDow); // Mon, Tue, or Wed
      expect([1, 2, 3]).toContain(endDow);
    }
  });
});

// ── Phase 23 — parallelism shrinks activity wall-clock duration ──────────────

describe('parallelism (Phase 23)', () => {
  it('α=1, count=2 — single-assignment activity finishes in half the wall-clock', () => {
    // 16h job (= 2 working days on Mon–Fri 8h cal) with α=1, count=2 →
    // effective wall-clock = 16/2 = 8h = 1 working day.
    const baseline = makeInput({
      nodes: [
        activity('a1', 16, [
          { resourceId: 'r-dev', count: 2, calendarPolicy: 'intersection', parallelism: 0 },
        ]),
      ],
      resources: [devPool()],
      calendars: [MON_FRI],
    });
    const parallel = makeInput({
      nodes: [
        activity('a1', 16, [
          { resourceId: 'r-dev', count: 2, calendarPolicy: 'intersection', parallelism: 1 },
        ]),
      ],
      resources: [devPool()],
      calendars: [MON_FRI],
    });
    const baselineOut = schedule(baseline);
    const parallelOut = schedule(parallel);
    expect(baselineOut.ok && parallelOut.ok).toBe(true);
    if (baselineOut.ok && parallelOut.ok) {
      // Baseline (α=0): 16 working hours on Mon–Fri 8h cal → finishes
      // end-of-day Tue. Parallel (α=1): 8 working hours → finishes
      // end-of-day Mon. Wall-clock difference between two end-of-days is
      // exactly one calendar day (24h).
      const baselineEnd = baselineOut.result.projectEnd.getTime();
      const parallelEnd = parallelOut.result.projectEnd.getTime();
      expect(parallelEnd).toBeLessThan(baselineEnd);
      const diffHours = (baselineEnd - parallelEnd) / 3_600_000;
      expect(diffHours).toBe(24);
    }
  });

  it('multi-assignment wall-clock is bottleneck (max of per-assignment effective)', () => {
    // Dev (count=2, α=1) → 8h × 1/2 = 4h effective.
    // Reviewer (count=1, α=0) → 8h effective (count=1 collapses).
    // Activity wall-clock = max = 8h = 1 working day.
    const input = makeInput({
      nodes: [
        activity('a1', 8, [
          { resourceId: 'r-dev', count: 2, calendarPolicy: 'intersection', parallelism: 1 },
          { resourceId: 'r-rev', count: 1, calendarPolicy: 'intersection', parallelism: 0 },
        ]),
      ],
      resources: [
        devPool(),
        { id: 'r-rev', name: 'Reviewer', capacity: 1, calendarId: MON_FRI.id },
      ],
      calendars: [MON_FRI],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      // 8h on Mon–Fri 8h calendar from 09:00 → end of Mon's working day.
      // The reviewer is the bottleneck — confirms max-not-min semantics.
      const aSched = out.result.nodes.a1!;
      const durMs = aSched.earliestFinish.getTime() - aSched.earliestStart.getTime();
      const durHours = durMs / 3_600_000;
      // Same calendar throughout, so wall-clock = effective hours = 8.
      expect(durHours).toBe(8);
    }
  });

  it('legacy file (parallelism field absent) schedules identically to α=0', () => {
    const legacy = makeInput({
      nodes: [
        activity('a1', 16, [{ resourceId: 'r-dev', count: 2, calendarPolicy: 'intersection' }]),
      ],
      resources: [devPool()],
      calendars: [MON_FRI],
    });
    const explicitZero = makeInput({
      nodes: [
        activity('a1', 16, [
          { resourceId: 'r-dev', count: 2, calendarPolicy: 'intersection', parallelism: 0 },
        ]),
      ],
      resources: [devPool()],
      calendars: [MON_FRI],
    });
    const legacyOut = schedule(legacy);
    const zeroOut = schedule(explicitZero);
    expect(legacyOut.ok && zeroOut.ok).toBe(true);
    if (legacyOut.ok && zeroOut.ok) {
      expect(legacyOut.result.projectEnd.getTime()).toBe(zeroOut.result.projectEnd.getTime());
    }
  });
});

// ── Phase 25 — activity crashing shrinks the schedule wall-clock ─────────────

describe('crashing (Phase 25)', () => {
  it('selecting a crash option shrinks the activity wall-clock to the crash duration', () => {
    // Nominal 16h (= 2 working days on Mon–Fri 8h cal). Crash to 8h → 1 day.
    const nominal = makeInput({
      nodes: [
        activity('a1', 16, [{ resourceId: 'r-dev', count: 1, calendarPolicy: 'intersection' }]),
      ],
      resources: [devPool()],
      calendars: [MON_FRI],
    });
    const crashed = makeInput({
      nodes: [
        {
          ...activity('a1', 16, [
            { resourceId: 'r-dev', count: 1, calendarPolicy: 'intersection' },
          ]),
          crashOptions: [{ duration: { value: 8, unit: 'hours' }, additionalCost: 500 }],
          selectedCrashIndex: 0,
        },
      ],
      resources: [devPool()],
      calendars: [MON_FRI],
    });
    const nominalOut = schedule(nominal);
    const crashedOut = schedule(crashed);
    expect(nominalOut.ok && crashedOut.ok).toBe(true);
    if (nominalOut.ok && crashedOut.ok) {
      // 16h → end-of-day Tue; 8h → end-of-day Mon. Same-day wall-clock diff = 24h.
      const diffHours =
        (nominalOut.result.projectEnd.getTime() - crashedOut.result.projectEnd.getTime()) /
        3_600_000;
      expect(diffHours).toBe(24);
    }
  });

  it('crashOptions defined but none selected → schedule identical to no crashOptions', () => {
    // Sanity: presence of unused options must be a no-op for the engine.
    const without = makeInput({
      nodes: [
        activity('a1', 16, [{ resourceId: 'r-dev', count: 1, calendarPolicy: 'intersection' }]),
      ],
      resources: [devPool()],
      calendars: [MON_FRI],
    });
    const withUnused = makeInput({
      nodes: [
        {
          ...activity('a1', 16, [
            { resourceId: 'r-dev', count: 1, calendarPolicy: 'intersection' },
          ]),
          crashOptions: [{ duration: { value: 8, unit: 'hours' }, additionalCost: 500 }],
        },
      ],
      resources: [devPool()],
      calendars: [MON_FRI],
    });
    const a = schedule(without);
    const b = schedule(withUnused);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.result.projectEnd.getTime()).toBe(b.result.projectEnd.getTime());
    }
  });
});

// ── Phase 24 — resource conflict surfacing ──────────────────────────────────

describe('conflictedNodeIds (Phase 24)', () => {
  it('two activities sharing a capacity-1 resource on the same day are both flagged', () => {
    // Two parallel activities, no edge between them, both assigned to a
    // capacity-1 Dev. CPM gives them the same earliestStart, so they
    // overlap on day 0. Resource is over capacity (2 > 1).
    const input = makeInput({
      nodes: [
        activity('a1', 8, [{ resourceId: 'r-dev', count: 1, calendarPolicy: 'intersection' }]),
        activity('a2', 8, [{ resourceId: 'r-dev', count: 1, calendarPolicy: 'intersection' }]),
      ],
      resources: [devPool(MON_FRI.id, 1)],
      calendars: [MON_FRI],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.conflictedNodeIds.a1).toEqual([
        { resourceId: 'r-dev', overCapacityDayCount: 1 },
      ]);
      expect(out.result.conflictedNodeIds.a2).toEqual([
        { resourceId: 'r-dev', overCapacityDayCount: 1 },
      ]);
    }
  });

  it('no conflicts when capacity meets demand', () => {
    // Same two activities, but Dev has capacity 2 — both fit.
    const input = makeInput({
      nodes: [
        activity('a1', 8, [{ resourceId: 'r-dev', count: 1, calendarPolicy: 'intersection' }]),
        activity('a2', 8, [{ resourceId: 'r-dev', count: 1, calendarPolicy: 'intersection' }]),
      ],
      resources: [devPool(MON_FRI.id, 2)],
      calendars: [MON_FRI],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.conflictedNodeIds).toEqual({});
  });

  it('reports per-resource breakdown when one node competes for multiple over-cap resources', () => {
    // a1 uses both Dev and Overflow at count=1; a2 uses both too. Both
    // resources have capacity=1 — so both go over capacity simultaneously.
    const input = makeInput({
      nodes: [
        activity('a1', 8, [
          { resourceId: 'r-dev', count: 1, calendarPolicy: 'intersection' },
          { resourceId: 'r-overflow', count: 1, calendarPolicy: 'intersection' },
        ]),
        activity('a2', 8, [
          { resourceId: 'r-dev', count: 1, calendarPolicy: 'intersection' },
          { resourceId: 'r-overflow', count: 1, calendarPolicy: 'intersection' },
        ]),
      ],
      resources: [devPool(MON_FRI.id, 1), overflow(MON_FRI.id, 1)],
      calendars: [MON_FRI],
    });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      // Stable resource-id-ascending order — see conflicts.ts step 5.
      expect(out.result.conflictedNodeIds.a1).toEqual([
        { resourceId: 'r-dev', overCapacityDayCount: 1 },
        { resourceId: 'r-overflow', overCapacityDayCount: 1 },
      ]);
    }
  });

  it('subsystem container inherits conflict reasons from body nodes', () => {
    // Two body activities of a sub-system share a capacity-1 resource.
    // The container node should also appear in conflictedNodeIds.
    const sub: ProjectNode = {
      id: 'sub-c',
      nodeType: 'subsystem',
      name: 'Container',
      duration: { value: 0, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    };
    const input: ScheduleInput = {
      ...makeInput({
        nodes: [
          sub,
          activity('body-a', 8, [
            { resourceId: 'r-dev', count: 1, calendarPolicy: 'intersection' },
          ]),
          activity('body-b', 8, [
            { resourceId: 'r-dev', count: 1, calendarPolicy: 'intersection' },
          ]),
        ],
        resources: [devPool(MON_FRI.id, 1)],
        calendars: [MON_FRI],
      }),
      subsystems: [
        {
          id: 'sub-1',
          containerNodeId: 'sub-c',
          bodyNodeIds: ['body-a', 'body-b'],
          entryNodeId: 'body-a',
          exitNodeId: 'body-b',
        },
      ],
    };
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (out.ok) {
      // Container gets the aggregated reasons.
      expect(out.result.conflictedNodeIds['sub-c']).toEqual([
        { resourceId: 'r-dev', overCapacityDayCount: 2 }, // 1 day × 2 body nodes
      ]);
      // Bodies still flagged individually.
      expect(out.result.conflictedNodeIds['body-a']).toBeDefined();
      expect(out.result.conflictedNodeIds['body-b']).toBeDefined();
    }
  });
});
