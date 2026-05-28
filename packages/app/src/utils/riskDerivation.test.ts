import { describe, it, expect } from 'vitest';
import type { Distribution, ProjectFile, ProjectNode } from '@procsim/file-format';
import {
  deriveActivityVariationRisks,
  deriveDecisionCostOfDelay,
  deriveLoopRisks,
  formatHours,
  probabilityOfFailure,
} from './riskDerivation.js';

// ── Minimal fixture helpers ───────────────────────────────────────────────────

function makeActivity(id: string, durationHours: number, distribution?: Distribution): ProjectNode {
  return {
    id,
    nodeType: 'activity',
    name: id,
    duration: { value: durationHours, unit: 'hours' },
    durationSemantic: 'time',
    position: { x: 0, y: 0 },
    calendarId: null,
    consumesResources: false,
    resourceAssignments: [],
    ...(distribution ? { distribution } : {}),
  };
}

function makeProject(overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    version: 7,
    project: {
      name: 'Test',
      startDate: '2026-01-01',
      defaultCalendarId: 'cal-default',
      displayUnit: 'hours',
      shareMode: 'percentage',
    },
    calendars: [
      {
        id: 'cal-default',
        name: 'Default',
        workingDays: [false, true, true, true, true, true, false],
        hoursPerDay: 8,
        daysPerWeek: 5,
        holidayPreset: 'NONE',
        holidayPresetVersion: '',
        exceptions: [],
      },
    ],
    resources: [],
    nodes: [],
    edges: [],
    loops: [],
    subsystems: [],
    scenarios: [],
    comments: [],
    currency: 'USD',
    fxSnapshotVersion: '2026.1',
    ...overrides,
  } as ProjectFile;
}

// ── deriveLoopRisks ───────────────────────────────────────────────────────────

describe('deriveLoopRisks', () => {
  it('skips loops with deterministic iteration count', () => {
    const project = makeProject({
      nodes: [makeActivity('body', 4)],
      loops: [
        {
          id: 'L1',
          bodyNodeIds: ['body'],
          kickout: { type: 'maxIterations', value: 10 },
          expectedIterations: { type: 'triangular', min: 3, mode: 3, max: 3 },
        },
      ],
    });
    expect(deriveLoopRisks(project)).toEqual([]);
  });

  it('computes max extension as (max − min) × Σ body durations', () => {
    const project = makeProject({
      nodes: [makeActivity('b1', 4), makeActivity('b2', 6)],
      loops: [
        {
          id: 'L1',
          bodyNodeIds: ['b1', 'b2'],
          kickout: { type: 'maxIterations', value: 10 },
          expectedIterations: { type: 'triangular', min: 1, mode: 2, max: 4 },
        },
      ],
    });
    const risks = deriveLoopRisks(project);
    expect(risks).toHaveLength(1);
    // (4 − 1) × (4 + 6) = 30 hours
    expect(risks[0]!.maxExtensionHours).toBe(30);
    expect(risks[0]!.bodyHours).toBe(10);
    expect(risks[0]!.minIterations).toBe(1);
    expect(risks[0]!.maxIterations).toBe(4);
  });

  it('skips loops with zero body duration', () => {
    const project = makeProject({
      nodes: [makeActivity('b', 0)],
      loops: [
        {
          id: 'L1',
          bodyNodeIds: ['b'],
          kickout: { type: 'maxIterations', value: 10 },
          expectedIterations: { type: 'triangular', min: 1, mode: 2, max: 3 },
        },
      ],
    });
    expect(deriveLoopRisks(project)).toEqual([]);
  });

  it('sorts loops by max extension descending', () => {
    const project = makeProject({
      nodes: [makeActivity('b', 1)],
      loops: [
        {
          id: 'small',
          bodyNodeIds: ['b'],
          kickout: { type: 'maxIterations', value: 10 },
          expectedIterations: { type: 'triangular', min: 1, mode: 2, max: 3 },
        },
        {
          id: 'large',
          bodyNodeIds: ['b'],
          kickout: { type: 'maxIterations', value: 10 },
          expectedIterations: { type: 'triangular', min: 1, mode: 5, max: 20 },
        },
      ],
    });
    const risks = deriveLoopRisks(project);
    expect(risks.map((r) => r.loopId)).toEqual(['large', 'small']);
  });

  it('uses the loop group as label when set, else "Loop N"', () => {
    const project = makeProject({
      nodes: [makeActivity('b', 1)],
      loops: [
        {
          id: 'L1',
          bodyNodeIds: ['b'],
          kickout: { type: 'maxIterations', value: 10 },
          expectedIterations: { type: 'triangular', min: 1, mode: 2, max: 3 },
          group: 'QA Cycle',
        },
        {
          id: 'L2',
          bodyNodeIds: ['b'],
          kickout: { type: 'maxIterations', value: 10 },
          expectedIterations: { type: 'triangular', min: 1, mode: 2, max: 4 },
        },
      ],
    });
    const risks = deriveLoopRisks(project);
    // Sorted by extension descending: L2 (max=4) first, L1 (max=3) second.
    const labels = risks.map((r) => r.label);
    expect(labels).toEqual(['Loop 2', 'QA Cycle']);
  });

  it('handles normal-distribution iteration counts via ±3σ', () => {
    const project = makeProject({
      nodes: [makeActivity('b', 2)],
      loops: [
        {
          id: 'L1',
          bodyNodeIds: ['b'],
          kickout: { type: 'maxIterations', value: 10 },
          expectedIterations: { type: 'normal', mean: 5, stddev: 1 },
        },
      ],
    });
    const risks = deriveLoopRisks(project);
    expect(risks).toHaveLength(1);
    // min = max(1, 5 − 3) = 2; max = 5 + 3 = 8; extension = (8 − 2) × 2 = 12
    expect(risks[0]!.minIterations).toBe(2);
    expect(risks[0]!.maxIterations).toBe(8);
    expect(risks[0]!.maxExtensionHours).toBe(12);
  });
});

// ── deriveActivityVariationRisks ──────────────────────────────────────────────

describe('deriveActivityVariationRisks', () => {
  it('skips activities without a distribution', () => {
    const project = makeProject({ nodes: [makeActivity('a', 8)] });
    expect(deriveActivityVariationRisks(project)).toEqual([]);
  });

  it('skips activities below the threshold', () => {
    const project = makeProject({
      nodes: [
        makeActivity('low', 8, { type: 'triangular', min: 7, mode: 8, max: 10 }),
        // spread = 3, central = 8 → ratio = 0.375 → below 0.75 default
      ],
    });
    expect(deriveActivityVariationRisks(project)).toEqual([]);
  });

  it('surfaces activities above the threshold (triangular)', () => {
    const project = makeProject({
      nodes: [
        makeActivity('high', 8, { type: 'triangular', min: 4, mode: 8, max: 20 }),
        // spread = 16, central = 8 → ratio = 2.0 → above 0.75
      ],
    });
    const risks = deriveActivityVariationRisks(project);
    expect(risks).toHaveLength(1);
    expect(risks[0]!.nodeId).toBe('high');
    expect(risks[0]!.spreadRatio).toBe(2);
    expect(risks[0]!.centralHours).toBe(8);
    expect(risks[0]!.spreadHours).toBe(16);
    expect(risks[0]!.worstCaseHours).toBe(20);
  });

  it('handles pert-beta and normal distributions consistently', () => {
    const project = makeProject({
      nodes: [
        makeActivity('pert', 10, { type: 'pert-beta', min: 4, mode: 10, max: 20 }),
        // spread = 16, central = 10 → ratio = 1.6
        makeActivity('norm', 10, { type: 'normal', mean: 10, stddev: 5 }),
        // spread = 2σ = 10, central = 10 → ratio = 1.0
      ],
    });
    const risks = deriveActivityVariationRisks(project);
    expect(risks).toHaveLength(2);
    // Sorted by ratio descending: pert (1.6) first, norm (1.0) second.
    expect(risks.map((r) => r.nodeId)).toEqual(['pert', 'norm']);
  });

  it('respects the threshold parameter', () => {
    const project = makeProject({
      nodes: [
        makeActivity('mid', 8, { type: 'triangular', min: 4, mode: 8, max: 12 }),
        // spread = 8, central = 8 → ratio = 1.0
      ],
    });
    expect(deriveActivityVariationRisks(project, 0.5)).toHaveLength(1);
    expect(deriveActivityVariationRisks(project, 1.5)).toHaveLength(0);
  });

  it('skips activities with non-positive central value (defensive)', () => {
    const project = makeProject({
      nodes: [makeActivity('zero-mode', 1, { type: 'triangular', min: 0, mode: 0, max: 5 })],
    });
    expect(deriveActivityVariationRisks(project)).toEqual([]);
  });

  it('respects the node duration unit when converting to hours', () => {
    const node: ProjectNode = {
      ...makeActivity('days', 5, { type: 'triangular', min: 1, mode: 5, max: 15 }),
      duration: { value: 5, unit: 'days' },
    };
    const project = makeProject({ nodes: [node] });
    const risks = deriveActivityVariationRisks(project);
    expect(risks).toHaveLength(1);
    // central = mode × 24 = 5 × 24 = 120 h
    expect(risks[0]!.centralHours).toBe(120);
    // spread = (15 − 1) × 24 = 336 h
    expect(risks[0]!.spreadHours).toBe(336);
    // worstCase = 15 × 24 = 360 h
    expect(risks[0]!.worstCaseHours).toBe(360);
  });

  it('skips non-activity / non-decision nodes', () => {
    const project = makeProject({
      nodes: [
        {
          ...makeActivity('s', 0, { type: 'triangular', min: 1, mode: 5, max: 20 }),
          nodeType: 'start',
        } as ProjectNode,
      ],
    });
    expect(deriveActivityVariationRisks(project)).toEqual([]);
  });
});

// ── formatHours ───────────────────────────────────────────────────────────────

describe('formatHours', () => {
  it('renders < 24 h as hours', () => {
    expect(formatHours(0)).toBe('0h');
    expect(formatHours(8)).toBe('8h');
    expect(formatHours(23.4)).toBe('23.4h');
  });

  it('renders 24..335 h as days', () => {
    expect(formatHours(24)).toBe('1d');
    expect(formatHours(72)).toBe('3d');
    expect(formatHours(24 * 13)).toBe('13d');
  });

  it('renders ≥ 336 h (2 weeks) as weeks', () => {
    expect(formatHours(24 * 14)).toBe('2w');
    expect(formatHours(24 * 30)).toBe(`${Math.round(((24 * 30) / (24 * 7)) * 10) / 10}w`);
  });
});

// ── probabilityOfFailure ──────────────────────────────────────────────────────

describe('probabilityOfFailure', () => {
  it('returns 1 − passProbability for decisions', () => {
    const node: ProjectNode = {
      id: 'd',
      nodeType: 'decision',
      name: 'D',
      duration: { value: 1, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
      passProbability: 0.7,
    };
    expect(probabilityOfFailure(node)).toBeCloseTo(0.3, 6);
  });

  it('defaults to 0 when passProbability is missing', () => {
    const node: ProjectNode = {
      id: 'd',
      nodeType: 'decision',
      name: 'D',
      duration: { value: 1, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    };
    expect(probabilityOfFailure(node)).toBe(0);
  });

  it('returns 0 for non-decision nodes', () => {
    expect(probabilityOfFailure(makeActivity('a', 1))).toBe(0);
  });
});

// ── deriveDecisionCostOfDelay ─────────────────────────────────────────────────

function makeDecision(
  id: string,
  failureDelay: { value: number; unit: 'hours' | 'days' | 'weeks' } | undefined,
  assignments: Array<{ resourceId: string; count: number; share?: number }>,
): ProjectNode {
  return {
    id,
    nodeType: 'decision',
    name: id,
    duration: { value: 1, unit: 'hours' },
    durationSemantic: 'time',
    position: { x: 0, y: 0 },
    calendarId: null,
    consumesResources: true,
    resourceAssignments: assignments.map((a) => ({
      resourceId: a.resourceId,
      count: a.count,
      calendarPolicy: 'intersection',
      parallelism: 1,
      ...(a.share !== undefined ? { share: a.share } : {}),
    })),
    passProbability: 0.8,
    ...(failureDelay ? { failureDelay } : {}),
  };
}

function makeResource(id: string, costRate: number | undefined) {
  return {
    id,
    name: id,
    capacity: 1,
    calendarId: 'cal-default',
    ...(costRate !== undefined ? { costRate } : {}),
  };
}

describe('deriveDecisionCostOfDelay', () => {
  it('returns null for non-decision nodes', () => {
    const project = makeProject({ nodes: [makeActivity('a', 1)] });
    expect(deriveDecisionCostOfDelay(project, project.nodes[0]!)).toBe(null);
  });

  it('returns null when failureDelay is absent or zero', () => {
    const d = makeDecision('d', undefined, [{ resourceId: 'r1', count: 1 }]);
    const project = makeProject({
      nodes: [d],
      resources: [makeResource('r1', 100)],
    });
    expect(deriveDecisionCostOfDelay(project, d)).toBe(null);
  });

  it('returns null when no assigned resource has a costRate', () => {
    const d = makeDecision('d', { value: 1, unit: 'days' }, [{ resourceId: 'r1', count: 1 }]);
    const project = makeProject({
      nodes: [d],
      resources: [makeResource('r1', undefined)],
    });
    expect(deriveDecisionCostOfDelay(project, d)).toBe(null);
  });

  it('computes delay × rate × count for a single resource', () => {
    const d = makeDecision('d', { value: 1, unit: 'days' }, [{ resourceId: 'r1', count: 2 }]);
    const project = makeProject({
      nodes: [d],
      resources: [makeResource('r1', 100)],
    });
    // 1 day × 8 h/day (default cal) × $100 × 2 = $1600
    expect(deriveDecisionCostOfDelay(project, d)).toBe(1600);
  });

  it('applies the share % to each assignment', () => {
    const d = makeDecision('d', { value: 1, unit: 'hours' }, [
      { resourceId: 'r1', count: 1, share: 50 },
    ]);
    const project = makeProject({
      nodes: [d],
      resources: [makeResource('r1', 100)],
    });
    // 1 h × $100 × 1 × 0.5 = $50
    expect(deriveDecisionCostOfDelay(project, d)).toBe(50);
  });

  it('defaults share to 100 when absent', () => {
    const d = makeDecision('d', { value: 1, unit: 'hours' }, [{ resourceId: 'r1', count: 1 }]);
    const project = makeProject({
      nodes: [d],
      resources: [makeResource('r1', 100)],
    });
    expect(deriveDecisionCostOfDelay(project, d)).toBe(100);
  });

  it('uses the project default calendar hoursPerDay (not 8 when overridden)', () => {
    const d = makeDecision('d', { value: 1, unit: 'days' }, [{ resourceId: 'r1', count: 1 }]);
    const peBankingProject = makeProject({
      nodes: [d],
      resources: [makeResource('r1', 100)],
      calendars: [
        {
          id: 'cal-default',
          name: 'PE/Banking',
          workingDays: [false, true, true, true, true, true, true],
          hoursPerDay: 14,
          daysPerWeek: 6,
          holidayPreset: 'NONE',
          holidayPresetVersion: '',
          exceptions: [],
        },
      ],
    });
    // 1 day × 14 h/day × $100 × 1 = $1400
    expect(deriveDecisionCostOfDelay(peBankingProject, d)).toBe(1400);
  });

  it('converts weeks using hoursPerDay × daysPerWeek', () => {
    const d = makeDecision('d', { value: 1, unit: 'weeks' }, [{ resourceId: 'r1', count: 1 }]);
    const project = makeProject({
      nodes: [d],
      resources: [makeResource('r1', 100)],
    });
    // 1 week × 8 h/day × 5 days/week × $100 = $4000
    expect(deriveDecisionCostOfDelay(project, d)).toBe(4000);
  });

  it('sums multiple resources, skipping unrated ones', () => {
    const d = makeDecision('d', { value: 1, unit: 'hours' }, [
      { resourceId: 'r1', count: 1, share: 60 },
      { resourceId: 'r2', count: 1, share: 40 }, // no rate set
      { resourceId: 'r3', count: 1, share: 100 },
    ]);
    const project = makeProject({
      nodes: [d],
      resources: [makeResource('r1', 200), makeResource('r2', undefined), makeResource('r3', 150)],
    });
    // r1: 1 × 200 × 0.6 = 120; r3: 1 × 150 × 1.0 = 150; total = 270
    expect(deriveDecisionCostOfDelay(project, d)).toBe(270);
  });

  it('returns null when none of the assigned resources match (orphan IDs)', () => {
    const d = makeDecision('d', { value: 1, unit: 'days' }, [{ resourceId: 'missing', count: 1 }]);
    const project = makeProject({
      nodes: [d],
      resources: [],
    });
    expect(deriveDecisionCostOfDelay(project, d)).toBe(null);
  });
});
