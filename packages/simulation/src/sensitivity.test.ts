import { describe, it, expect } from 'vitest';
import type { Calendar, ProjectEdge, ProjectNode, Resource } from '@procsim/file-format';
import type { ScheduleInput } from '@procsim/scheduler';
import { simulate } from './index.js';

// ── Phase 31 — Sensitivity (Spearman ρ) tests ──────────────────────────────
//
// Slice 1 ships engine-side sample retention and Spearman ρ vs project
// finish + project cost. Tests below pin:
//   1. Determinism for a fixed seed (sample retention + ρ both stable).
//   2. Cross-stream isolation (adding a distribution to one node leaves
//      every other node's samples and ρ byte-identical).
//   3. Known-ρ fixtures — a critical-path activity whose duration is the
//      sole variance source produces ρ ≈ 1 against finish.
//   4. Memory cap — at iterations > 10 000 the retained arrays stride-
//      subsample to ≤ 10 000 per node.

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
  name: 'Sensitivity Test',
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
}): ScheduleInput {
  return {
    project: BASE_PROJECT,
    nodes: opts.nodes,
    edges: opts.edges ?? [],
    resources: opts.resources ?? [],
    calendars: [MON_FRI],
    loops: [],
  };
}

// ── Determinism ────────────────────────────────────────────────────────────

describe('sensitivity — determinism', () => {
  it('nodeInputSamples + finishSensitivity byte-identical for fixed seed', () => {
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          distribution: { type: 'triangular', min: 4, mode: 8, max: 12 },
        }),
        activity('a2', 8, {
          distribution: { type: 'triangular', min: 4, mode: 8, max: 12 },
        }),
      ],
      edges: [{ id: 'e1', from: 'a1', to: 'a2', type: 'FS', lag: { value: 0, unit: 'hours' } }],
    });
    const r1 = simulate({ schedule: input, iterations: 300, seed: 11 });
    const r2 = simulate({ schedule: input, iterations: 300, seed: 11 });
    expect(r1.nodeInputSamples).toEqual(r2.nodeInputSamples);
    expect(r1.finishSensitivity).toEqual(r2.finishSensitivity);
    expect(r1.costSensitivity).toEqual(r2.costSensitivity);
  });
});

// ── Cross-stream isolation ─────────────────────────────────────────────────

describe('sensitivity — cross-stream isolation', () => {
  it('adding a distribution to one node leaves the other node samples identical', () => {
    // a1 has a distribution in both runs. a2 has a distribution ONLY in
    // run 2. a1's nodeInputSamples must stay byte-identical because its
    // own RNG sub-stream is unaffected by a2's distribution.
    const a1WithDist = activity('a1', 8, {
      distribution: { type: 'triangular', min: 4, mode: 8, max: 12 },
    });
    const a2NoDist = activity('a2', 8);
    const a2WithDist = activity('a2', 8, {
      distribution: { type: 'triangular', min: 4, mode: 8, max: 12 },
    });
    const edges = [
      {
        id: 'e1',
        from: 'a1',
        to: 'a2',
        type: 'FS' as const,
        lag: { value: 0, unit: 'hours' as const },
      },
    ];
    const r1 = simulate({
      schedule: makeInput({ nodes: [a1WithDist, a2NoDist], edges }),
      iterations: 200,
      seed: 42,
    });
    const r2 = simulate({
      schedule: makeInput({ nodes: [a1WithDist, a2WithDist], edges }),
      iterations: 200,
      seed: 42,
    });
    expect(r2.nodeInputSamples['a1']).toEqual(r1.nodeInputSamples['a1']);
    // r1 has no a2 entry (a2 has no distribution); r2 does.
    expect(r1.nodeInputSamples['a2']).toBeUndefined();
    expect(r2.nodeInputSamples['a2']).toBeDefined();
  });
});

// ── Known-ρ fixture: sole driver of finish has ρ ≈ 1 ───────────────────────

describe('sensitivity — known ρ fixtures', () => {
  it('a sole variance-bearing critical-path activity has finishSensitivity ≈ 1', () => {
    // Single activity → its duration directly determines project finish.
    // Spearman of duration vs finish should be 1.0 (perfect monotone).
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          distribution: { type: 'triangular', min: 4, mode: 8, max: 16 },
        }),
      ],
    });
    const r = simulate({ schedule: input, iterations: 500, seed: 7 });
    expect(r.finishSensitivity['a1']).toBeGreaterThan(0.95);
  });

  it('a node with no distribution has no sensitivity entry', () => {
    const input = makeInput({
      nodes: [activity('a1', 8)],
    });
    const r = simulate({ schedule: input, iterations: 100, seed: 1 });
    expect(r.finishSensitivity['a1']).toBeUndefined();
    expect(r.costSensitivity['a1']).toBeUndefined();
    expect(r.nodeInputSamples['a1']).toBeUndefined();
  });

  it('a variance-bearing activity with cost-bearing resources has nonzero costSensitivity', () => {
    // Duration drives resource hours; resource hours × rate drives cost.
    // So duration variance should correlate positively with cost.
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          distribution: { type: 'triangular', min: 4, mode: 8, max: 16 },
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
        }),
      ],
      resources: [{ id: 'r1', name: 'r1', capacity: 1, calendarId: MON_FRI.id, costRate: 100 }],
    });
    const r = simulate({ schedule: input, iterations: 300, seed: 13 });
    expect(r.costSensitivity['a1']).toBeGreaterThan(0.95);
  });
});

// ── Memory cap ─────────────────────────────────────────────────────────────

describe('sensitivity — retention cap', () => {
  it('retains all samples when iterations ≤ 10 000', () => {
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          distribution: { type: 'triangular', min: 4, mode: 8, max: 12 },
        }),
      ],
    });
    const r = simulate({ schedule: input, iterations: 5000, seed: 1 });
    // Successful iterations only — should equal iterations exactly when
    // none degenerate (this fixture never degenerates).
    expect(r.nodeInputSamples['a1']?.length).toBe(5000);
  });

  it('stride-subsamples to ≤ 10 000 when iterations > 10 000', () => {
    const input = makeInput({
      nodes: [
        activity('a1', 8, {
          distribution: { type: 'triangular', min: 4, mode: 8, max: 12 },
        }),
      ],
    });
    // 25 000 iters → stride = ceil(25000 / 10000) = 3 → retain every 3rd.
    const r = simulate({ schedule: input, iterations: 25_000, seed: 1 });
    const len = r.nodeInputSamples['a1']?.length ?? 0;
    expect(len).toBeLessThanOrEqual(10_000);
    expect(len).toBeGreaterThan(8_000); // stride=3 over 25k → ~8334
  });
});
