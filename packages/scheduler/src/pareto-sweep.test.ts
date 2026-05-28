import { describe, it, expect } from 'vitest';
import type { Calendar, ProjectEdge, ProjectNode } from '@procsim/file-format';
import { schedule } from './index.js';
import { paretoSweep } from './pareto-sweep.js';
import type { ScheduleInput } from './index.js';

// ── Phase 26 Slice 1 — Pareto sweep over deterministic greedy crash ───────────

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

function makeInput(opts: { nodes: ProjectNode[]; edges?: ProjectEdge[] }): ScheduleInput {
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
    resources: [],
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

describe('paretoSweep', () => {
  it('returns empty result when no critical-path activity has crashOptions', () => {
    // Plain activity, no crash options anywhere.
    const input = makeInput({ nodes: [activity('a1', 16)] });
    const sweep = paretoSweep(input);
    expect(sweep.points).toHaveLength(0);
    expect(sweep.uncrashed.cost).toBe(0);
    expect(sweep.fullyCrashed.cost).toBe(0);
  });

  it('returns N points spanning uncrashed → fully-crashed bounds', () => {
    // One activity, three crash options of increasing depth + cost.
    // The greedy will pick deeper options as the deadline tightens.
    const node = activity('a1', 16, {
      crashOptions: [
        { duration: { value: 12, unit: 'hours' }, additionalCost: 100 },
        { duration: { value: 8, unit: 'hours' }, additionalCost: 300 },
        { duration: { value: 4, unit: 'hours' }, additionalCost: 700 },
      ],
    });
    const input = makeInput({ nodes: [node] });
    const sweep = paretoSweep(input, { samples: 10 });
    expect(sweep.points).toHaveLength(10);
    // Uncrashed bound has zero cost; fully-crashed bound has a positive cost.
    expect(sweep.uncrashed.cost).toBe(0);
    expect(sweep.fullyCrashed.cost).toBeGreaterThan(0);
    expect(sweep.fullyCrashed.finish.getTime()).toBeLessThan(sweep.uncrashed.finish.getTime());
  });

  it('cost is non-decreasing as the deadline tightens (deadline-order)', () => {
    // Points are emitted in deadline-ascending order (tMin → tMax).
    // tMin = fullyCrashedFinish (earliest), tMax = uncrashedFinish (latest).
    // So the first points have the EARLIEST deadlines → DEEPEST crash → HIGHEST cost.
    // Cost should be monotone non-increasing as the deadline relaxes.
    const node = activity('a1', 16, {
      crashOptions: [
        { duration: { value: 12, unit: 'hours' }, additionalCost: 100 },
        { duration: { value: 8, unit: 'hours' }, additionalCost: 300 },
        { duration: { value: 4, unit: 'hours' }, additionalCost: 700 },
      ],
    });
    const input = makeInput({ nodes: [node] });
    const sweep = paretoSweep(input, { samples: 10 });
    for (let i = 1; i < sweep.points.length; i++) {
      // As deadline relaxes (later sample → easier to meet), cost should
      // not increase. The greedy may pick a cheaper plan or the same plan.
      expect(sweep.points[i]!.cost).toBeLessThanOrEqual(sweep.points[i - 1]!.cost);
    }
  });

  it('first sample (earliest deadline) matches the fully-crashed bound', () => {
    const node = activity('a1', 16, {
      crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 700 }],
    });
    const input = makeInput({ nodes: [node] });
    const sweep = paretoSweep(input, { samples: 8 });
    expect(sweep.points[0]?.cost).toBe(sweep.fullyCrashed.cost);
    expect(sweep.points[0]?.finish.getTime()).toBe(sweep.fullyCrashed.finish.getTime());
  });

  it('last sample (latest deadline = uncrashed finish) produces an empty plan', () => {
    const node = activity('a1', 16, {
      crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 700 }],
    });
    const input = makeInput({ nodes: [node] });
    const sweep = paretoSweep(input, { samples: 8 });
    const last = sweep.points[sweep.points.length - 1]!;
    expect(last.cost).toBe(0);
    expect(last.plan.steps).toHaveLength(0);
    expect(last.finish.getTime()).toBe(sweep.uncrashed.finish.getTime());
  });

  it('marks every point as on-frontier when costs strictly increase with crash depth', () => {
    // Single chain with three strictly-Pareto crash options — every sample
    // is on the frontier (no point is dominated).
    const node = activity('a1', 16, {
      crashOptions: [
        { duration: { value: 12, unit: 'hours' }, additionalCost: 100 },
        { duration: { value: 8, unit: 'hours' }, additionalCost: 300 },
        { duration: { value: 4, unit: 'hours' }, additionalCost: 700 },
      ],
    });
    const input = makeInput({ nodes: [node] });
    const sweep = paretoSweep(input, { samples: 5 });
    // De-duplicate by (cost, finish) before checking — adjacent samples
    // commonly produce the same plan when the deadline range maps to the
    // same crash configuration. Unique points should all be on the frontier.
    const unique = new Map<string, (typeof sweep.points)[number]>();
    for (const p of sweep.points) {
      const key = `${p.cost}:${p.finish.getTime()}`;
      unique.set(key, p);
    }
    for (const p of unique.values()) {
      expect(p.onFrontier).toBe(true);
    }
  });

  it('determinism — two runs on the same input produce identical sweeps', () => {
    const node = activity('a1', 16, {
      crashOptions: [
        { duration: { value: 12, unit: 'hours' }, additionalCost: 100 },
        { duration: { value: 4, unit: 'hours' }, additionalCost: 700 },
      ],
    });
    const input = makeInput({ nodes: [node] });
    const a = paretoSweep(input, { samples: 10 });
    const b = paretoSweep(input, { samples: 10 });
    expect(a.points.length).toBe(b.points.length);
    for (let i = 0; i < a.points.length; i++) {
      expect(a.points[i]!.cost).toBe(b.points[i]!.cost);
      expect(a.points[i]!.finish.getTime()).toBe(b.points[i]!.finish.getTime());
      expect(a.points[i]!.onFrontier).toBe(b.points[i]!.onFrontier);
    }
  });

  it('samples option is clamped to [2, 50]', () => {
    const node = activity('a1', 16, {
      crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 100 }],
    });
    const input = makeInput({ nodes: [node] });
    expect(paretoSweep(input, { samples: 0 }).points.length).toBe(2);
    expect(paretoSweep(input, { samples: 1 }).points.length).toBe(2);
    expect(paretoSweep(input, { samples: 200 }).points.length).toBe(50);
  });

  it('handles a chain that requires crashing multiple nodes', () => {
    // Two activities in series, each with a crash option. Both must be
    // crashed for the deepest finish.
    const a1 = activity('a1', 16, {
      crashOptions: [{ duration: { value: 8, unit: 'hours' }, additionalCost: 300 }],
    });
    const a2 = activity('a2', 16, {
      crashOptions: [{ duration: { value: 8, unit: 'hours' }, additionalCost: 200 }],
    });
    const edges: ProjectEdge[] = [
      { id: 'e1', from: 'a1', to: 'a2', type: 'FS', lag: { value: 0, unit: 'hours' } },
    ];
    const input = makeInput({ nodes: [a1, a2], edges });
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const sweep = paretoSweep(input, { samples: 10 });
    // Fully-crashed has BOTH steps applied.
    expect(sweep.fullyCrashed.cost).toBe(500); // 300 + 200
    // Some sample in between should have only ONE step (cheaper of the two,
    // a2 at $200 — same cost / saved-hours ratio if hours are equal, so
    // tie-break by nodeId picks a1 first? Confirm: a2 cost=200/0.5d=$400/d
    // vs a1 cost=300/0.5d=$600/d, so a2 IS cheaper $/day → greedy picks a2
    // first. After step 1, a2 crashed; still slack on a1 vs deadline; if
    // deadline allows, stop here.)
    const intermediateCosts = new Set(sweep.points.map((p) => p.cost));
    expect(intermediateCosts.has(200)).toBe(true);
  });
});
