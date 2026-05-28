import { describe, it, expect } from 'vitest';
import type { ResourceTimelineEntry } from '@procsim/scheduler';
import { computeResourcePeaks, resolveResourceStatus } from './resourceStatus.js';

function entry(
  resourceId: string,
  startISO: string,
  endISO: string,
  count: number,
): ResourceTimelineEntry {
  return {
    resourceId,
    nodeId: `n-${resourceId}-${startISO}`,
    iteration: 0,
    start: new Date(startISO),
    end: new Date(endISO),
    count,
  };
}

describe('computeResourcePeaks', () => {
  it('returns an empty map for an empty timeline', () => {
    expect(computeResourcePeaks([])).toEqual({});
  });

  it('returns the entry count when a resource has a single entry', () => {
    const peaks = computeResourcePeaks([entry('r1', '2026-01-01', '2026-01-05', 2)]);
    expect(peaks).toEqual({ r1: 2 });
  });

  it('sums counts across overlapping entries on the same resource', () => {
    // Two activities each use 2 units of r1, overlapping for several days
    // → peak concurrent count = 4 during the overlap.
    const peaks = computeResourcePeaks([
      entry('r1', '2026-01-01', '2026-01-10', 2),
      entry('r1', '2026-01-05', '2026-01-15', 2),
    ]);
    expect(peaks.r1).toBe(4);
  });

  it('does not sum non-overlapping entries on the same resource', () => {
    // Entries that abut but do not overlap shouldn't be double-counted.
    // End day is inclusive, so the second entry starting the day after
    // the first ends is the boundary case — peak should stay at 1.
    const peaks = computeResourcePeaks([
      entry('r1', '2026-01-01', '2026-01-05', 1),
      entry('r1', '2026-01-06', '2026-01-10', 1),
    ]);
    expect(peaks.r1).toBe(1);
  });

  it('keeps peaks per-resource independent', () => {
    const peaks = computeResourcePeaks([
      entry('r1', '2026-01-01', '2026-01-05', 3),
      entry('r2', '2026-01-01', '2026-01-05', 1),
    ]);
    expect(peaks).toEqual({ r1: 3, r2: 1 });
  });

  it('finds the peak across a multi-step pattern', () => {
    // Three overlapping windows of count=1; max concurrent = 3.
    const peaks = computeResourcePeaks([
      entry('r1', '2026-01-01', '2026-01-20', 1),
      entry('r1', '2026-01-05', '2026-01-15', 1),
      entry('r1', '2026-01-08', '2026-01-12', 1),
    ]);
    expect(peaks.r1).toBe(3);
  });
});

describe('resolveResourceStatus', () => {
  it('returns "idle" when the pool is unassigned', () => {
    const s = resolveResourceStatus({ capacity: 3, assignmentCount: 0, peak: 0 });
    expect(s).toBe('idle');
  });

  it('returns "idle" when peak is zero even if assignments exist', () => {
    // Defensive — a node could be present but never make it into the
    // resolved schedule (e.g. a wait-state branch). assignmentCount > 0
    // doesn't imply peak > 0.
    const s = resolveResourceStatus({ capacity: 3, assignmentCount: 2, peak: 0 });
    expect(s).toBe('idle');
  });

  it('returns "active" when peak is below capacity', () => {
    const s = resolveResourceStatus({ capacity: 3, assignmentCount: 4, peak: 2 });
    expect(s).toBe('active');
  });

  it('returns "at-capacity" when peak equals capacity', () => {
    const s = resolveResourceStatus({ capacity: 3, assignmentCount: 4, peak: 3 });
    expect(s).toBe('at-capacity');
  });

  it('returns "over-capacity" when peak exceeds capacity', () => {
    const s = resolveResourceStatus({ capacity: 3, assignmentCount: 4, peak: 5 });
    expect(s).toBe('over-capacity');
  });

  it('falls back to assignment-count when peak is null (schedule failed)', () => {
    // No timeline available → palette still distinguishes idle from
    // assigned, just without the cap-vs-overcap signal.
    expect(resolveResourceStatus({ capacity: 3, assignmentCount: 0, peak: null })).toBe('idle');
    expect(resolveResourceStatus({ capacity: 3, assignmentCount: 2, peak: null })).toBe('active');
  });
});
