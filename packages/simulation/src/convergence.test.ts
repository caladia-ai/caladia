import { describe, it, expect } from 'vitest';
import {
  StabilityTracker,
  maxAbsArrayDrift,
  maxAbsRecordDrift,
  timeEpsilonHours,
  costEpsilon,
  makeTrackers,
  allStable,
  makeConvergenceState,
  performConvergenceCheck,
  TIME_EPSILON_FLOOR_HOURS,
  COST_EPSILON_FLOOR,
  CONVERGENCE_STABILITY_SAMPLES,
  MIN_N_FOR_CONVERGENCE,
} from './convergence.js';
import type { ConvergenceCheckInput } from './convergence.js';

describe('StabilityTracker', () => {
  it('starts unstable', () => {
    const t = new StabilityTracker();
    expect(t.consecutiveStable).toBe(0);
    expect(t.isStable()).toBe(false);
  });

  it('counts consecutive stable=true observations', () => {
    const t = new StabilityTracker();
    t.recordStable(true);
    t.recordStable(true);
    t.recordStable(true);
    expect(t.consecutiveStable).toBe(3);
  });

  it('resets the counter on stable=false', () => {
    const t = new StabilityTracker();
    t.recordStable(true);
    t.recordStable(true);
    expect(t.consecutiveStable).toBe(2);
    t.recordStable(false);
    expect(t.consecutiveStable).toBe(0);
  });

  it('isStable uses CONVERGENCE_STABILITY_SAMPLES by default', () => {
    const t = new StabilityTracker();
    for (let i = 0; i < CONVERGENCE_STABILITY_SAMPLES - 1; i++) {
      t.recordStable(true);
    }
    expect(t.isStable()).toBe(false); // one short
    t.recordStable(true);
    expect(t.isStable()).toBe(true);
  });

  it('honours a custom required-samples threshold', () => {
    const t = new StabilityTracker();
    t.recordStable(true);
    expect(t.isStable(1)).toBe(true);
    expect(t.isStable(5)).toBe(false);
  });
});

describe('maxAbsArrayDrift', () => {
  it('returns 0 for equal arrays', () => {
    expect(maxAbsArrayDrift([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it('finds the largest absolute element-wise difference', () => {
    expect(maxAbsArrayDrift([1, 5, 3], [1, 2, 3])).toBe(3);
    expect(maxAbsArrayDrift([1, 2, 10], [1, 2, 3])).toBe(7);
    expect(maxAbsArrayDrift([-5, 0, 5], [5, 0, -5])).toBe(10);
  });

  it('handles empty arrays', () => {
    expect(maxAbsArrayDrift([], [])).toBe(0);
  });

  it('throws on length mismatch', () => {
    expect(() => maxAbsArrayDrift([1, 2], [1, 2, 3])).toThrow(/length mismatch/);
  });
});

describe('maxAbsRecordDrift', () => {
  it('returns 0 for equal records', () => {
    expect(maxAbsRecordDrift({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(0);
  });

  it('finds the largest absolute per-key delta', () => {
    expect(maxAbsRecordDrift({ a: 1, b: 5 }, { a: 1, b: 2 })).toBe(3);
    expect(maxAbsRecordDrift({ a: 10 }, { a: 3 })).toBe(7);
  });

  it('treats a missing key as zero on the other side', () => {
    // 'b' missing from prev → drift is curr['b'] = 4
    expect(maxAbsRecordDrift({ a: 1, b: 4 }, { a: 1 })).toBe(4);
    // 'b' missing from curr → drift is prev['b'] = 7
    expect(maxAbsRecordDrift({ a: 1 }, { a: 1, b: 7 })).toBe(7);
  });

  it('handles empty records', () => {
    expect(maxAbsRecordDrift({}, {})).toBe(0);
  });
});

describe('timeEpsilonHours', () => {
  it('returns the absolute floor for tiny projects', () => {
    expect(timeEpsilonHours(40)).toBe(TIME_EPSILON_FLOOR_HOURS);
  });

  it('returns the relative bar for huge projects', () => {
    // 16-year project ~140k hours → 0.2% = ~280h, far above the 6h floor
    const huge = 16 * 365.25 * 24;
    expect(timeEpsilonHours(huge)).toBeCloseTo(huge * 0.002, 5);
  });

  it('uses whichever is larger (floor vs relative)', () => {
    const crossover = TIME_EPSILON_FLOOR_HOURS / 0.002; // 3 000h
    expect(timeEpsilonHours(crossover - 1)).toBe(TIME_EPSILON_FLOOR_HOURS);
    expect(timeEpsilonHours(crossover + 1)).toBeCloseTo((crossover + 1) * 0.002, 5);
  });
});

describe('costEpsilon', () => {
  it('returns the absolute floor for tiny budgets', () => {
    expect(costEpsilon(0)).toBe(COST_EPSILON_FLOOR);
    expect(costEpsilon(1000)).toBe(COST_EPSILON_FLOOR);
  });

  it('returns the relative bar for large budgets', () => {
    // $500M → 0.5% = $2.5M
    expect(costEpsilon(500_000_000)).toBe(2_500_000);
  });

  it('handles negative anchors via abs() (degenerate cost runs)', () => {
    expect(costEpsilon(-1_000_000)).toBe(1_000_000 * 0.005);
  });
});

describe('allStable / makeTrackers', () => {
  it('makeTrackers returns six independent trackers, all initially unstable', () => {
    const t = makeTrackers();
    expect(allStable(t)).toBe(false);
    for (const key of Object.keys(t) as Array<keyof typeof t>) {
      expect(t[key]).toBeInstanceOf(StabilityTracker);
    }
  });

  it('allStable returns true only when every tracker hits the threshold', () => {
    const t = makeTrackers();

    function feedStable(tracker: StabilityTracker, count: number) {
      for (let i = 0; i < count; i++) tracker.recordStable(true);
    }

    // Feed 5 of 6 to stability; one held back
    feedStable(t.endPercentiles, CONVERGENCE_STABILITY_SAMPLES);
    feedStable(t.costPercentiles, CONVERGENCE_STABILITY_SAMPLES);
    feedStable(t.criticality, CONVERGENCE_STABILITY_SAMPLES);
    feedStable(t.nodeP95, CONVERGENCE_STABILITY_SAMPLES);
    feedStable(t.nodeCostStats, CONVERGENCE_STABILITY_SAMPLES);
    expect(allStable(t)).toBe(false); // costCurve still unstable

    feedStable(t.costCurve, CONVERGENCE_STABILITY_SAMPLES);
    expect(allStable(t)).toBe(true);
  });

  it('allStable goes back to false if any tracker is reset mid-run', () => {
    const t = makeTrackers();
    for (const key of Object.keys(t) as Array<keyof typeof t>) {
      for (let i = 0; i < CONVERGENCE_STABILITY_SAMPLES; i++) {
        t[key].recordStable(true);
      }
    }
    expect(allStable(t)).toBe(true);

    t.criticality.recordStable(false);
    expect(allStable(t)).toBe(false);
  });
});

// Phase 50 Slice 21 / audit I-8 — small-N gate. The percentile lookup
// in performConvergenceCheck collapses for tiny N (top percentiles
// share an index when `floor(n * 0.8) === floor(n * 0.95)`). The gate
// declines to update trackers below `MIN_N_FOR_CONVERGENCE` so the
// detector doesn't falsely declare stability on what's structurally
// zero drift.
describe('performConvergenceCheck — small-N gate (audit I-8)', () => {
  it('returns false and does not seed snapshots when N < MIN_N_FOR_CONVERGENCE', () => {
    const state = makeConvergenceState();
    const input: ConvergenceCheckInput = {
      sortedEndMs: Array.from({ length: 5 }, (_, i) => 1_000_000 + i * 3_600_000),
      projectCosts: [100, 110, 120, 130, 140],
      criticalCount: { n1: 5 },
      finishMsPerNode: new Map([['n1', [1_000_000, 1_100_000, 1_200_000, 1_300_000, 1_400_000]]]),
      costPerNode: new Map([['n1', [10, 20, 30, 40, 50]]]),
      costCurveBuckets: [[10, 20, 30, 40, 50]],
      reportableNodeIds: ['n1'],
      projectStartMs: 0,
    };

    expect(performConvergenceCheck(state, input)).toBe(false);
    // Anchors and prev-snapshots stay null — checkpoint was skipped.
    expect(state.timeAnchorHours).toBeNull();
    expect(state.prevEndPctls).toBeNull();
    expect(state.prevCostPctls).toBeNull();
    // Trackers should not have advanced.
    expect(state.trackers.endPercentiles.consecutiveStable).toBe(0);
  });

  it('runs normally once N reaches MIN_N_FOR_CONVERGENCE', () => {
    const state = makeConvergenceState();
    const N = MIN_N_FOR_CONVERGENCE;
    const input: ConvergenceCheckInput = {
      sortedEndMs: Array.from({ length: N }, (_, i) => 1_000_000 + i * 3_600_000),
      projectCosts: Array.from({ length: N }, (_, i) => 100 + i),
      criticalCount: { n1: N },
      finishMsPerNode: new Map([
        ['n1', Array.from({ length: N }, (_, i) => 1_000_000 + i * 3_600_000)],
      ]),
      costPerNode: new Map([['n1', Array.from({ length: N }, (_, i) => 10 + i)]]),
      costCurveBuckets: [Array.from({ length: N }, (_, i) => 10 + i)],
      reportableNodeIds: ['n1'],
      projectStartMs: 0,
    };

    expect(performConvergenceCheck(state, input)).toBe(false); // first call seeds
    expect(state.timeAnchorHours).not.toBeNull();
    expect(state.prevEndPctls).not.toBeNull();
  });
});
