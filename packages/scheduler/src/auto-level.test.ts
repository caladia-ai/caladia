import { describe, it, expect } from 'vitest';
import type { Calendar, ProjectEdge, ProjectNode, Resource } from '@procsim/file-format';
import { schedule, suggestLeveling } from './index.js';
import type { ScheduleInput } from './index.js';
import { minStartMs } from './auto-level.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

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

const START_DATE = '2026-01-05'; // Monday

function makeNode(
  id: string,
  hours: number,
  resourceAssignments: Array<{ resourceId: string; count: number }> = [],
): ProjectNode {
  return {
    id,
    nodeType: 'activity',
    name: id,
    duration: { value: hours, unit: 'hours' },
    durationSemantic: 'time',
    position: { x: 0, y: 0 },
    calendarId: null,
    consumesResources: resourceAssignments.length > 0,
    resourceAssignments: resourceAssignments.map((a) => ({
      ...a,
      calendarPolicy: 'intersection' as const,
    })),
  };
}

function edge(id: string, from: string, to: string, lagDays = 0): ProjectEdge {
  return {
    id,
    from,
    to,
    type: 'FS',
    lag: { value: lagDays, unit: 'days' },
  };
}

const RES_DEV: Resource = {
  id: 'r-dev',
  name: 'Dev',
  capacity: 1,
  calendarId: 'cal-default',
};

function makeInput(
  nodes: ProjectNode[],
  edges: ProjectEdge[],
  resources: Resource[] = [RES_DEV],
): ScheduleInput {
  return {
    project: {
      name: 'Test',
      startDate: START_DATE,
      defaultCalendarId: 'cal-default',
      displayUnit: 'days',
      shareMode: 'percentage',
    },
    nodes,
    edges,
    resources,
    calendars: [MON_FRI],
    loops: [],
  };
}

function runBaseline(input: ScheduleInput) {
  const outcome = schedule(input);
  if (!outcome.ok) throw new Error('baseline schedule failed: ' + JSON.stringify(outcome.errors));
  return outcome.result;
}

// ── DoD: no-op when there are no conflicts ────────────────────────────────────

describe('suggestLeveling — no conflicts', () => {
  it('returns null when no resource is over capacity', () => {
    // A → B linear chain; both use 1 Dev, capacity is 1, sequenced.
    const input = makeInput(
      [
        makeNode('A', 8, [{ resourceId: 'r-dev', count: 1 }]),
        makeNode('B', 8, [{ resourceId: 'r-dev', count: 1 }]),
      ],
      [edge('e1', 'A', 'B')],
    );
    const result = runBaseline(input);
    expect(suggestLeveling(input, result)).toBeNull();
  });
});

// ── DoD: resolves a simple 2-way conflict ─────────────────────────────────────

describe('suggestLeveling — resolves 2-way conflict', () => {
  /**
   * Two parallel activities both start at project start and both use the
   * one Dev resource. The over-cap is on day 0; the leveler should shift
   * the higher-slack one later.
   */
  function build(): ScheduleInput {
    // Use a Start node so both A and B have at least one incoming edge
    // the leveler can extend. Without this, neither A nor B has an
    // incoming edge and the leveler would have nothing to push.
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
    return makeInput(
      [
        start,
        makeNode('A', 8, [{ resourceId: 'r-dev', count: 1 }]),
        makeNode('B', 16, [{ resourceId: 'r-dev', count: 1 }]),
      ],
      [edge('eSA', 'S', 'A'), edge('eSB', 'S', 'B')],
    );
  }

  it('produces a plan with at least one shifted change', () => {
    const input = build();
    const result = runBaseline(input);
    const plan = suggestLeveling(input, result);
    expect(plan).not.toBeNull();
    expect(plan!.changes.length).toBeGreaterThanOrEqual(1);
  });

  it('shifts the higher-slack activity, not the longer (lower-slack) one', () => {
    // A is 8h, B is 16h. Both have float, but A finishes earlier so it
    // has more slack relative to project end. The leveler should pick A
    // to shift (highest slack), leaving B in place.
    const input = build();
    const result = runBaseline(input);
    const plan = suggestLeveling(input, result)!;
    const shiftedIds = plan.changes.map((c) => c.nodeId);
    expect(shiftedIds).toContain('A');
  });

  it('eliminates the conflict (remainingConflicts = 0)', () => {
    const input = build();
    const result = runBaseline(input);
    const plan = suggestLeveling(input, result)!;
    expect(plan.remainingConflicts).toBe(0);
    expect(plan.resolvedConflicts).toBeGreaterThan(0);
  });

  it('does not hit the iteration cap on a simple project', () => {
    const input = build();
    const result = runBaseline(input);
    const plan = suggestLeveling(input, result)!;
    expect(plan.hitIterationCap).toBe(false);
  });
});

// ── DoD: deterministic for a given project ────────────────────────────────────

describe('suggestLeveling — deterministic', () => {
  it('produces byte-identical plans on repeated calls', () => {
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
    const input = makeInput(
      [
        start,
        makeNode('A', 8, [{ resourceId: 'r-dev', count: 1 }]),
        makeNode('B', 8, [{ resourceId: 'r-dev', count: 1 }]),
        makeNode('C', 8, [{ resourceId: 'r-dev', count: 1 }]),
      ],
      [edge('eSA', 'S', 'A'), edge('eSB', 'S', 'B'), edge('eSC', 'S', 'C')],
    );
    const result = runBaseline(input);
    const p1 = suggestLeveling(input, result)!;
    const p2 = suggestLeveling(input, result)!;
    expect(p1.changes.length).toBe(p2.changes.length);
    for (let i = 0; i < p1.changes.length; i++) {
      const a = p1.changes[i]!;
      const b = p2.changes[i]!;
      expect(a.nodeId).toBe(b.nodeId);
      expect(a.edgeId).toBe(b.edgeId);
      expect(a.addedLagHours).toBe(b.addedLagHours);
    }
    expect(p1.iterations).toBe(p2.iterations);
    expect(p1.resolvedConflicts).toBe(p2.resolvedConflicts);
    expect(p1.remainingConflicts).toBe(p2.remainingConflicts);
  });
});

// ── DoD: skipped list when no incoming edges to extend ────────────────────────

describe('suggestLeveling — unable to shift root nodes', () => {
  it('reports root-conflict activities under `skipped` and does not loop forever', () => {
    // Two activities both anchored to project start (no incoming edges)
    // both using Dev. Capacity = 1 → over-cap. Neither can be shifted via
    // edge-lag because they have no incoming edges.
    const input = makeInput(
      [
        makeNode('A', 8, [{ resourceId: 'r-dev', count: 1 }]),
        makeNode('B', 8, [{ resourceId: 'r-dev', count: 1 }]),
      ],
      [],
    );
    const result = runBaseline(input);
    const plan = suggestLeveling(input, result)!;
    // Either both A and B end up skipped, or the leveler bails after
    // exhausting candidates — both outcomes are acceptable. What's NOT
    // acceptable is hitting the iteration cap.
    expect(plan.hitIterationCap).toBe(false);
    expect(plan.skipped.length).toBeGreaterThanOrEqual(1);
  });
});

// ── DoD: respects higher capacity (no over-cap means no plan) ─────────────────

describe('suggestLeveling — capacity already satisfies demand', () => {
  it('returns null when the resource capacity covers all parallel work', () => {
    // Two parallel activities, but resource capacity = 2 so no over-cap.
    const wide: Resource = { ...RES_DEV, capacity: 2 };
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
    const input = makeInput(
      [
        start,
        makeNode('A', 8, [{ resourceId: 'r-dev', count: 1 }]),
        makeNode('B', 8, [{ resourceId: 'r-dev', count: 1 }]),
      ],
      [edge('eSA', 'S', 'A'), edge('eSB', 'S', 'B')],
      [wide],
    );
    const result = runBaseline(input);
    expect(suggestLeveling(input, result)).toBeNull();
  });
});

// ── Phase 33 Slice 1 — Manual leveling priority ─────────────────────────────

describe('suggestLeveling — levelPriority overrides the slack tie-break', () => {
  /**
   * The "shifts the higher-slack activity" baseline test above proves the
   * leveler picks A (higher slack) when A and B both compete. These tests
   * pin the new override: a sufficiently-high `levelPriority` on A causes
   * the leveler to pick B instead, leaving the high-priority node in place.
   *
   * Same two-way fixture: Start → A (8h, higher slack) and Start → B (16h,
   * lower slack). One Dev resource at capacity 1. Both compete on day 0.
   */
  function build(opts: { aPriority?: number; bPriority?: number } = {}): ScheduleInput {
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
    const a = makeNode('A', 8, [{ resourceId: 'r-dev', count: 1 }]);
    const b = makeNode('B', 16, [{ resourceId: 'r-dev', count: 1 }]);
    return makeInput(
      [
        start,
        opts.aPriority !== undefined ? { ...a, levelPriority: opts.aPriority } : a,
        opts.bPriority !== undefined ? { ...b, levelPriority: opts.bPriority } : b,
      ],
      [edge('eSA', 'S', 'A'), edge('eSB', 'S', 'B')],
    );
  }

  it('flagging A with high priority makes the leveler shift B instead', () => {
    // Baseline (no priorities) shifts A; this test pins that A's high
    // priority flips the choice to B.
    const input = build({ aPriority: 10 });
    const result = runBaseline(input);
    const plan = suggestLeveling(input, result)!;
    const shiftedIds = plan.changes.map((c) => c.nodeId);
    expect(shiftedIds).toContain('B');
    expect(shiftedIds).not.toContain('A');
  });

  it('equal priorities reproduce the legacy slack-driven choice (A shifts)', () => {
    // Both at priority 0 (absent) → priority tie → falls through to
    // slack. Same outcome as the baseline test above.
    const input = build();
    const result = runBaseline(input);
    const plan = suggestLeveling(input, result)!;
    const shiftedIds = plan.changes.map((c) => c.nodeId);
    expect(shiftedIds).toContain('A');
  });

  it('an explicit 0 on A behaves identically to absent', () => {
    // Defensive — exactOptionalPropertyTypes can let `levelPriority: 0`
    // slip through if a caller is sloppy. The engine treats 0 as the
    // default; same outcome as absent.
    const input = build({ aPriority: 0, bPriority: 0 });
    const result = runBaseline(input);
    const plan = suggestLeveling(input, result)!;
    expect(plan.changes.map((c) => c.nodeId)).toContain('A');
  });

  it('B-high-priority pins B and shifts A — same outcome as the baseline', () => {
    // Sanity check: priority on the slack-poor side doesn't change which
    // node gets moved (slack already favoured A). This confirms the
    // priority sort key isn't accidentally inverting the slack rule.
    const input = build({ bPriority: 10 });
    const result = runBaseline(input);
    const plan = suggestLeveling(input, result)!;
    expect(plan.changes.map((c) => c.nodeId)).toContain('A');
  });
});

// ── Regression: same-day boundary must not cascade ───────────────────────────

describe('suggestLeveling — same-day boundary does not produce false over-cap', () => {
  /**
   * Two parallel activities A (count=2) and B (count=1) compete on a
   * capacity-2 resource. A also has a successor C (count=1) on the same
   * resource. After the leveler shifts A past B, A's finish coincides with
   * C's start (same instant). The day-bucket version of findOverCapDays
   * would sum A.count + C.count on that shared day and report a false
   * over-cap, sending the leveler into an infinite shift cascade
   * (hits MAX_ITERATIONS with tens of thousands of hours of accumulated
   * lag). The sweep-line version correctly sees A's release event before
   * C's claim event on tied times, so running stays at the post-release
   * value and the leveler converges.
   */
  function build(): ScheduleInput {
    const cap2: Resource = {
      id: 'r-dev',
      name: 'Dev',
      capacity: 2,
      calendarId: 'cal-default',
    };
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
    return makeInput(
      [
        start,
        makeNode('A', 24, [{ resourceId: 'r-dev', count: 2 }]),
        makeNode('B', 32, [{ resourceId: 'r-dev', count: 1 }]),
        makeNode('C', 4, [{ resourceId: 'r-dev', count: 1 }]),
      ],
      [edge('eSA', 'S', 'A'), edge('eSB', 'S', 'B'), edge('eAC', 'A', 'C')],
      [cap2],
    );
  }

  it('converges in a small number of iterations (does not hit MAX_ITERATIONS)', () => {
    const input = build();
    const result = runBaseline(input);
    const plan = suggestLeveling(input, result)!;
    expect(plan.hitIterationCap).toBe(false);
    expect(plan.iterations).toBeLessThan(10);
  });

  it('adds bounded lag, not the runaway 60_000+ hours the day-bucket bug produced', () => {
    const input = build();
    const result = runBaseline(input);
    const plan = suggestLeveling(input, result)!;
    const totalAddedLag = Object.values(plan.edgeLagBumps).reduce((s, n) => s + n, 0);
    expect(totalAddedLag).toBeLessThan(500);
  });

  it('resolves the real conflict completely', () => {
    const input = build();
    const result = runBaseline(input);
    const plan = suggestLeveling(input, result)!;
    expect(plan.remainingConflicts).toBe(0);
  });
});

// ── Phase 50 Slice 7 — calendar-aware lag rewriting (audit C-1) ───────────────

describe('applyExtraLags calendar-aware rewriting (audit C-1)', () => {
  // Direct unit tests for the previously-buggy `applyExtraLags` helper.
  // The pre-Slice-7 code used wall-clock factors (24 h/day, 168 h/week)
  // when rewriting non-hour-unit lags as hours. The CPM engine reads
  // those hours back via `toHours(lag, cal)` which honours the
  // calendar's hoursPerDay — so a `{value:1, unit:'days'}` lag got
  // re-interpreted as 3 working days on an 8h calendar.

  // Import the internal helper via the dist re-export path — auto-level
  // module is small and the helper is a stable export point now.

  it('rewrites a 1-day lag on an 8h calendar as 8 working hours (not 24 wall-clock)', async () => {
    const { applyExtraLags } = await import('./auto-level.js');
    const input = makeInput(
      [makeNode('A', 8), makeNode('B', 8)],
      [{ id: 'e1', from: 'A', to: 'B', type: 'FS', lag: { value: 1, unit: 'days' } }],
    );
    // Leveler-style: add 8 extra hours to the edge.
    const extra = new Map<string, number>([['e1', 8]]);
    const out = applyExtraLags(input, extra, MON_FRI);
    const e1 = out.edges.find((e) => e.id === 'e1')!;
    expect(e1.lag.unit).toBe('hours');
    // Original day = 8 working hours (cal.hoursPerDay); + 8 extra = 16.
    // PRE-fix this would have been 24 + 8 = 32 (3× inflation).
    expect(e1.lag.value).toBe(16);
  });

  it('rewrites a 1-week lag on a 5-day/8h calendar as 40 working hours (not 168 wall-clock)', async () => {
    const { applyExtraLags } = await import('./auto-level.js');
    const input = makeInput(
      [makeNode('A', 8), makeNode('B', 8)],
      [{ id: 'e1', from: 'A', to: 'B', type: 'FS', lag: { value: 1, unit: 'weeks' } }],
    );
    const extra = new Map<string, number>([['e1', 0.5]]);
    const out = applyExtraLags(input, extra, MON_FRI);
    const e1 = out.edges.find((e) => e.id === 'e1')!;
    // 1 week = 5 days × 8 h = 40 working hours on MON_FRI. + 0.5 extra = 40.5.
    // PRE-fix: 7 × 24 + 0.5 = 168.5 (4.2× inflation).
    expect(e1.lag.value).toBe(40.5);
  });

  it('leaves hours-unit lags unchanged apart from the extra', async () => {
    const { applyExtraLags } = await import('./auto-level.js');
    const input = makeInput(
      [makeNode('A', 8), makeNode('B', 8)],
      [{ id: 'e1', from: 'A', to: 'B', type: 'FS', lag: { value: 5, unit: 'hours' } }],
    );
    const extra = new Map<string, number>([['e1', 3]]);
    const out = applyExtraLags(input, extra, MON_FRI);
    const e1 = out.edges.find((e) => e.id === 'e1')!;
    // No unit conversion needed; rewriting is identity + extra.
    expect(e1.lag.value).toBe(8);
  });

  it('leaves un-extra-bumped edges untouched even when other edges get rewritten', async () => {
    const { applyExtraLags } = await import('./auto-level.js');
    const input = makeInput(
      [makeNode('A', 8), makeNode('B', 8), makeNode('C', 8)],
      [
        { id: 'e1', from: 'A', to: 'B', type: 'FS', lag: { value: 1, unit: 'days' } },
        { id: 'e2', from: 'B', to: 'C', type: 'FS', lag: { value: 2, unit: 'days' } },
      ],
    );
    // Only bump e1, not e2.
    const extra = new Map<string, number>([['e1', 4]]);
    const out = applyExtraLags(input, extra, MON_FRI);
    const e1 = out.edges.find((e) => e.id === 'e1')!;
    const e2 = out.edges.find((e) => e.id === 'e2')!;
    expect(e1.lag).toEqual({ value: 12, unit: 'hours' }); // 8 + 4
    expect(e2.lag).toEqual({ value: 2, unit: 'days' }); // unchanged shape
  });
});

// ── Audit N-1 regression ──────────────────────────────────────────────────────
//
// `Math.min(...arr)` spreads every element onto the call stack and
// overflows in V8 around ~100k-200k entries. The resource timeline scales
// with nodes × loops-unrolled × resource-assignments — giant templates can
// plausibly cross that threshold. The fix uses a `for-of` running min;
// these tests lock in correctness on the small case and survival on the
// large case.

describe('minStartMs (audit N-1)', () => {
  it('returns the smallest start.getTime() across the entries', () => {
    const entries = [
      { start: new Date(500) },
      { start: new Date(100) },
      { start: new Date(900) },
      { start: new Date(200) },
    ];
    expect(minStartMs(entries)).toBe(100);
  });

  it('returns Infinity on an empty array', () => {
    // Callers guard with a length check before calling; documenting the
    // contract here so future refactors don't accidentally regress the
    // empty-input behaviour into a runtime error.
    expect(minStartMs([])).toBe(Infinity);
  });

  it('handles a single entry', () => {
    expect(minStartMs([{ start: new Date(42) }])).toBe(42);
  });

  it('survives 200k entries without a stack overflow', () => {
    // The pre-fix `Math.min(...arr.map(...))` on this size would throw
    // "Maximum call stack size exceeded" in V8. The for-of fix returns
    // in single-digit ms.
    const entries = Array.from({ length: 200_000 }, (_, i) => ({
      start: new Date(1_000_000 + i),
    }));
    expect(minStartMs(entries)).toBe(1_000_000);
  });
});
