import { describe, it, expect } from 'vitest';
import type { Calendar, ProjectEdge, ProjectNode, Resource } from '@procsim/file-format';
import { schedule } from './index.js';
import { greedyCrash } from './crash.js';
import type { ScheduleInput } from './index.js';

// ── Phase 25 Slice 3 — deterministic greedy CPM crasher ──────────────────────

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

const START_DATE = '2026-01-05'; // Monday

function makeInput(opts: {
  nodes: ProjectNode[];
  edges?: ProjectEdge[];
  resources?: Resource[];
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
    calendars: [MON_FRI],
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

describe('greedyCrash', () => {
  it('deadline already met → returns empty plan with reachedDeadline=true', () => {
    const input = makeInput({ nodes: [activity('a1', 8)] });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Use the current projectEnd itself as the deadline.
    const plan = greedyCrash(input, out.result.projectEnd);
    expect(plan.steps).toHaveLength(0);
    expect(plan.totalAddedCost).toBe(0);
    expect(plan.reachedDeadline).toBe(true);
  });

  it('single node, single crash option, deadline reachable → one step', () => {
    // Nominal 8h finishes EOD Monday. Crash option: 4h, additionalCost=400.
    // Deadline = current finish minus 4 hours (= noon Monday). One step
    // picks the option and we reach it.
    const node = activity('a1', 8, {
      crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 400 }],
    });
    const input = makeInput({ nodes: [node] });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const deadline = new Date(out.result.projectEnd.getTime() - 4 * 3_600_000);
    const plan = greedyCrash(input, deadline);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      nodeId: 'a1',
      fromIndex: undefined,
      toIndex: 0,
      addedCost: 400,
    });
    expect(plan.totalAddedCost).toBe(400);
    expect(plan.reachedDeadline).toBe(true);
  });

  it('multi-node greedy picks the cheapest $/day first', () => {
    // a1 → a2 in series. Both 8h. Each has one crash option to 4h:
    //   a1: +$400 → $800/day
    //   a2: +$200 → $400/day
    // The cheaper option (a2) should be picked first.
    const a1 = activity('a1', 8, {
      crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 400 }],
    });
    const a2 = activity('a2', 8, {
      crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 200 }],
    });
    const edges: ProjectEdge[] = [
      { id: 'e1', from: 'a1', to: 'a2', type: 'FS', lag: { value: 0, unit: 'hours' } },
    ];
    const input = makeInput({ nodes: [a1, a2], edges });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Deadline tight enough to require both crashes (each saves 4h; total
    // 8h, so deadline = current - 6h forces both steps).
    const deadline = new Date(out.result.projectEnd.getTime() - 6 * 3_600_000);
    const plan = greedyCrash(input, deadline);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.nodeId).toBe('a2'); // cheaper picked first
    expect(plan.steps[1]?.nodeId).toBe('a1');
    expect(plan.totalAddedCost).toBe(600);
    expect(plan.reachedDeadline).toBe(true);
  });

  it('ran out of options before deadline → reachedDeadline=false', () => {
    // a1 has crashOptions but the deepest crash isn't enough.
    const node = activity('a1', 16, {
      crashOptions: [{ duration: { value: 12, unit: 'hours' }, additionalCost: 100 }],
    });
    const input = makeInput({ nodes: [node] });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Deadline asks for 16h → 4h compression; we can only get 4h savings.
    const deadline = new Date(out.result.projectEnd.getTime() - 12 * 3_600_000);
    const plan = greedyCrash(input, deadline);
    expect(plan.steps).toHaveLength(1);
    expect(plan.reachedDeadline).toBe(false);
  });

  it('no crashOptions anywhere → empty plan, deadline not reached', () => {
    const input = makeInput({ nodes: [activity('a1', 16)] });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const deadline = new Date(out.result.projectEnd.getTime() - 8 * 3_600_000);
    const plan = greedyCrash(input, deadline);
    expect(plan.steps).toHaveLength(0);
    expect(plan.reachedDeadline).toBe(false);
  });

  it('extends current selections rather than starting from None', () => {
    // a1 has TWO options. The user has pre-selected option 0 (8→6h, $100).
    // Greedy should EXTEND to option 1 (6→2h additional savings) rather
    // than re-pick from None.
    const node = activity('a1', 8, {
      crashOptions: [
        { duration: { value: 6, unit: 'hours' }, additionalCost: 100 },
        { duration: { value: 2, unit: 'hours' }, additionalCost: 500 },
      ],
      selectedCrashIndex: 0,
    });
    const input = makeInput({ nodes: [node] });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Currently finishes at 6h-from-start. Deadline = 2h-from-start
    // requires advancing to option 1.
    const deadline = new Date(out.result.projectEnd.getTime() - 4 * 3_600_000);
    const plan = greedyCrash(input, deadline);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      nodeId: 'a1',
      fromIndex: 0,
      toIndex: 1,
      addedCost: 400, // 500 - 100
    });
    expect(plan.totalAddedCost).toBe(400);
    expect(plan.reachedDeadline).toBe(true);
  });

  it('idempotent — re-running on the post-plan state returns no further steps', () => {
    const node = activity('a1', 8, {
      crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 400 }],
    });
    const input = makeInput({ nodes: [node] });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const deadline = new Date(out.result.projectEnd.getTime() - 4 * 3_600_000);
    const plan1 = greedyCrash(input, deadline);
    expect(plan1.reachedDeadline).toBe(true);

    // Apply the plan in-memory: rewrite the node with the selected option.
    const appliedInput: ScheduleInput = {
      ...input,
      nodes: input.nodes.map((n) => {
        const step = plan1.steps.find((s) => s.nodeId === n.id);
        return step ? { ...n, selectedCrashIndex: step.toIndex } : n;
      }),
    };
    const plan2 = greedyCrash(appliedInput, deadline);
    expect(plan2.steps).toHaveLength(0);
    expect(plan2.reachedDeadline).toBe(true);
  });

  it('non-critical chain is left alone', () => {
    // Top chain: a1 (16h) — critical.
    // Bottom chain: b1 (4h) — non-critical (has slack).
    // Both have crashOptions; only a1 should be picked.
    const a1 = activity('a1', 16, {
      crashOptions: [{ duration: { value: 12, unit: 'hours' }, additionalCost: 100 }],
    });
    const b1 = activity('b1', 4, {
      crashOptions: [{ duration: { value: 1, unit: 'hours' }, additionalCost: 10 }],
    });
    const input = makeInput({ nodes: [a1, b1] });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Sanity: only a1 critical.
    expect(out.result.nodes.a1?.onCriticalPath).toBe(true);
    expect(out.result.nodes.b1?.onCriticalPath).toBe(false);
    // Deadline asks for 4h compression.
    const deadline = new Date(out.result.projectEnd.getTime() - 4 * 3_600_000);
    const plan = greedyCrash(input, deadline);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.nodeId).toBe('a1');
    // b1 untouched even though its option had cheaper raw $/day — it's
    // off the critical path so crashing it wouldn't shorten projectEnd.
  });

  it('critical-path shift across iterations: greedy revisits which chain is critical', () => {
    // Two parallel chains of unequal length:
    //   top:    a1 (12h, crash to 6h, $300 → $400/day)
    //   bottom: b1 (10h, crash to 6h, $100 → $200/day)
    // Top is the longer chain so a1 is the ONLY critical-path node at
    // start. Crashing a1 to 6h flips the bottom into being critical
    // (top now 6h < bottom 10h), so step 2 must come from b1.
    const a1 = activity('a1', 12, {
      crashOptions: [{ duration: { value: 6, unit: 'hours' }, additionalCost: 300 }],
    });
    const b1 = activity('b1', 10, {
      crashOptions: [{ duration: { value: 6, unit: 'hours' }, additionalCost: 100 }],
    });
    const input = makeInput({ nodes: [a1, b1] });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Sanity: only a1 critical at start.
    expect(out.result.nodes.a1?.onCriticalPath).toBe(true);
    expect(out.result.nodes.b1?.onCriticalPath).toBe(false);
    // Deadline asks for finish ≤ 6h. Need both crashes.
    const deadline = new Date(out.result.projectEnd.getTime() - 6 * 3_600_000);
    const plan = greedyCrash(input, deadline);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.nodeId).toBe('a1'); // only critical at iteration 1
    expect(plan.steps[1]?.nodeId).toBe('b1'); // becomes critical after a1's crash
    expect(plan.reachedDeadline).toBe(true);
  });
});
