import { describe, it, expect } from 'vitest';
import type { Calendar, ProjectNode } from '@procsim/file-format';
import type { ScheduleInput } from '@procsim/scheduler';
import { schedule } from '@procsim/scheduler';
import { simulate } from './index.js';
import { chanceCrash } from './chance-crash.js';

// ── Phase 25 Slice 4 — chance-constrained greedy crasher ─────────────────────

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
  startDate: '2026-01-05',
  defaultCalendarId: MON_FRI.id,
  displayUnit: 'days' as const,
  shareMode: 'percentage' as const,
};

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

function makeInput(nodes: ProjectNode[]): ScheduleInput {
  return {
    project: BASE_PROJECT,
    nodes,
    edges: [],
    resources: [],
    calendars: [MON_FRI],
    loops: [],
  };
}

describe('chanceCrash', () => {
  it('determinism — same seed + budget yields byte-identical plan across two runs', async () => {
    const node = activity('a1', 8, {
      distribution: { type: 'triangular', min: 4, mode: 8, max: 16 },
      crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 400 }],
    });
    const input = makeInput([node]);
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Deadline tight enough that the crash will get picked.
    const deadline = new Date(out.result.projectEnd.getTime() - 4 * 3_600_000);
    const planA = await chanceCrash(input, deadline, { iterations: 50, seed: 42 });
    const planB = await chanceCrash(input, deadline, { iterations: 50, seed: 42 });
    expect(planA.steps).toEqual(planB.steps);
    expect(planA.totalAddedCost).toBe(planB.totalAddedCost);
    expect(planA.finalP95.getTime()).toBe(planB.finalP95.getTime());
    expect(planA.reachedDeadline).toBe(planB.reachedDeadline);
  });

  it('deadline already met (P95) → empty plan, reachedDeadline=true', async () => {
    // Nominal triangular peaks at 8h. Choose a deadline far in the future so
    // P95 trivially meets it.
    const node = activity('a1', 8, {
      distribution: { type: 'triangular', min: 4, mode: 8, max: 12 },
      crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 100 }],
    });
    const input = makeInput([node]);
    const deadline = new Date('2026-12-31T23:59:59');
    const plan = await chanceCrash(input, deadline, { iterations: 50 });
    expect(plan.steps).toHaveLength(0);
    expect(plan.reachedDeadline).toBe(true);
    expect(plan.cancelled).toBe(false);
  });

  it('picks a crash step when P95 exceeds the deadline', async () => {
    // Heavy right tail so P95 > nominal. Crash option compresses by half.
    const node = activity('a1', 8, {
      distribution: { type: 'triangular', min: 4, mode: 8, max: 32 },
      crashOptions: [{ duration: { value: 1, unit: 'hours' }, additionalCost: 500 }],
    });
    const input = makeInput([node]);
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Deadline = deterministic finish — P95 is far beyond it because of the
    // right-tail distribution, so the greedy must crash.
    const deadline = out.result.projectEnd;
    const plan = await chanceCrash(input, deadline, { iterations: 100, seed: 42 });
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps[0]?.nodeId).toBe('a1');
    expect(plan.totalAddedCost).toBe(500);
  });

  it('P95 monotonically improves (or stays) after each accepted step', async () => {
    // Two crash options on one node, each strictly compressing further.
    const node = activity('a1', 16, {
      distribution: { type: 'triangular', min: 12, mode: 16, max: 32 },
      crashOptions: [
        { duration: { value: 8, unit: 'hours' }, additionalCost: 300 },
        { duration: { value: 4, unit: 'hours' }, additionalCost: 800 },
      ],
    });
    const input = makeInput([node]);
    // Make the deadline tight enough that BOTH options get applied. Use the
    // nominal start + a few hours.
    const start = new Date('2026-01-05T13:00:00');
    const plan = await chanceCrash(input, start, { iterations: 100, seed: 42 });
    // Reaching the deadline isn't guaranteed (start + 13:00 may still be too
    // tight after both crashes), but each accepted step's P95 should not
    // grow worse. We verify monotone improvement via the sequence of step
    // applications by replaying: P95 with no steps ≥ P95 with step 0 only ≥
    // P95 with steps 0+1.
    const seqP95s: number[] = [];
    // Baseline P95 (no steps).
    seqP95s.push(
      simulate({ schedule: input, iterations: 100, seed: 42 }).percentiles.p95.getTime(),
    );
    for (let k = 0; k < plan.steps.length; k++) {
      const partial = input.nodes.map((n) => {
        // Apply steps[0..k] inclusive — keep the latest step per node so a
        // multi-stage crash on one node ends up with its final index.
        const matches = plan.steps.slice(0, k + 1).filter((s) => s.nodeId === n.id);
        const step = matches.length > 0 ? matches[matches.length - 1] : undefined;
        return step ? { ...n, selectedCrashIndex: step.toIndex } : n;
      });
      const p95 = simulate({
        schedule: { ...input, nodes: partial },
        iterations: 100,
        seed: 42,
      }).percentiles.p95.getTime();
      seqP95s.push(p95);
    }
    // Monotone non-increasing.
    for (let i = 1; i < seqP95s.length; i++) {
      expect(seqP95s[i]).toBeLessThanOrEqual(seqP95s[i - 1]!);
    }
  });

  it('respects ε-tolerance — P95 just inside ε of deadline counts as met', async () => {
    // Construct a scenario where after 1 crash the P95 lands close to but
    // just past the deadline. With ε=2 working days that should pass the
    // gate; with ε=0 it shouldn't.
    const node = activity('a1', 16, {
      distribution: { type: 'triangular', min: 12, mode: 16, max: 28 },
      crashOptions: [{ duration: { value: 8, unit: 'hours' }, additionalCost: 500 }],
    });
    const input = makeInput([node]);
    // Pick a deadline computed from a single crash-applied MC P95.
    const crashedInput: ScheduleInput = {
      ...input,
      nodes: [{ ...node, selectedCrashIndex: 0 }],
    };
    const crashedP95 = simulate({
      schedule: crashedInput,
      iterations: 100,
      seed: 42,
    }).percentiles.p95;
    // Deadline = (crashedP95 - 4 hours) — i.e. just under what one crash achieves.
    const deadline = new Date(crashedP95.getTime() - 4 * 3_600_000);

    // With ε=0 the gate isn't met; the greedy returns reachedDeadline=false.
    const tight = await chanceCrash(input, deadline, {
      iterations: 100,
      seed: 42,
      epsilonDays: 0,
    });
    expect(tight.reachedDeadline).toBe(false);

    // With ε=2 working days = 16 hours the gate IS met after the crash.
    const loose = await chanceCrash(input, deadline, {
      iterations: 100,
      seed: 42,
      epsilonDays: 2,
    });
    expect(loose.reachedDeadline).toBe(true);
  });

  it('ran out of options before deadline → reachedDeadline=false, cancelled=false', async () => {
    // Only one shallow crash option; the deadline asks for much more.
    const node = activity('a1', 32, {
      distribution: { type: 'triangular', min: 28, mode: 32, max: 40 },
      crashOptions: [{ duration: { value: 28, unit: 'hours' }, additionalCost: 100 }],
    });
    const input = makeInput([node]);
    const deadline = new Date('2026-01-05T08:00:00'); // before start of day
    const plan = await chanceCrash(input, deadline, { iterations: 50, seed: 42 });
    expect(plan.steps).toHaveLength(1);
    expect(plan.reachedDeadline).toBe(false);
    expect(plan.cancelled).toBe(false);
  });

  it('cancellation — flipping signal.cancelled returns a cancelled plan', async () => {
    const node = activity('a1', 16, {
      distribution: { type: 'triangular', min: 12, mode: 16, max: 32 },
      crashOptions: [
        { duration: { value: 8, unit: 'hours' }, additionalCost: 100 },
        { duration: { value: 4, unit: 'hours' }, additionalCost: 300 },
      ],
    });
    const input = makeInput([node]);
    // Pre-cancelled signal — the greedy should return immediately after
    // the baseline MC, before applying any step.
    const signal = { cancelled: true };
    const deadline = new Date('2026-01-05T08:00:00');
    const plan = await chanceCrash(input, deadline, {
      iterations: 50,
      seed: 42,
      signal,
    });
    expect(plan.cancelled).toBe(true);
    expect(plan.reachedDeadline).toBe(false);
  });

  it('idempotent — re-running on the post-plan state returns an empty plan', async () => {
    const node = activity('a1', 8, {
      distribution: { type: 'triangular', min: 4, mode: 8, max: 16 },
      crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 200 }],
    });
    const input = makeInput([node]);
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const deadline = new Date(out.result.projectEnd.getTime() + 8 * 3_600_000);
    const plan1 = await chanceCrash(input, deadline, { iterations: 100, seed: 42 });

    // Apply plan1 to a new input copy and re-run with the same deadline +
    // seed. Should produce no further steps.
    const appliedInput: ScheduleInput = {
      ...input,
      nodes: input.nodes.map((n) => {
        const step = plan1.steps.find((s) => s.nodeId === n.id);
        return step ? { ...n, selectedCrashIndex: step.toIndex } : n;
      }),
    };
    const plan2 = await chanceCrash(appliedInput, deadline, {
      iterations: 100,
      seed: 42,
    });
    expect(plan2.steps).toHaveLength(0);
    expect(plan2.reachedDeadline).toBe(plan1.reachedDeadline);
  });

  it('non-critical chain is left alone (same as Slice 3)', async () => {
    // a1 dominant + critical (32h base, broad tail); b1 short + non-critical.
    // Both have crashOptions; only a1 should be picked.
    const a1 = activity('a1', 32, {
      distribution: { type: 'triangular', min: 28, mode: 32, max: 48 },
      crashOptions: [{ duration: { value: 16, unit: 'hours' }, additionalCost: 500 }],
    });
    const b1 = activity('b1', 4, {
      distribution: { type: 'triangular', min: 2, mode: 4, max: 6 },
      crashOptions: [{ duration: { value: 1, unit: 'hours' }, additionalCost: 10 }],
    });
    const input = makeInput([a1, b1]);
    const out = schedule(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.nodes.a1?.onCriticalPath).toBe(true);
    expect(out.result.nodes.b1?.onCriticalPath).toBe(false);
    const deadline = new Date(out.result.projectEnd.getTime() - 8 * 3_600_000);
    const plan = await chanceCrash(input, deadline, { iterations: 100, seed: 42 });
    // Either zero or more steps, but all on a1.
    for (const s of plan.steps) expect(s.nodeId).toBe('a1');
  });
});
