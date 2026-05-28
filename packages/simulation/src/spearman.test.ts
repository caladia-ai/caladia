import { describe, it, expect } from 'vitest';
import { spearmanCorrelation } from './spearman.js';

describe('spearmanCorrelation', () => {
  it('returns 1.0 for a perfectly monotone-increasing relationship', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8];
    const ys = [10, 20, 30, 40, 50, 60, 70, 80];
    expect(spearmanCorrelation(xs, ys)).toBeCloseTo(1.0, 10);
  });

  it('returns 1.0 for a non-linear but monotone-increasing relationship', () => {
    // Spearman captures monotone relationships even when Pearson would
    // not. y = x^3 over positive x is strictly increasing.
    const xs = [1, 2, 3, 4, 5];
    const ys = xs.map((x) => x ** 3);
    expect(spearmanCorrelation(xs, ys)).toBeCloseTo(1.0, 10);
  });

  it('returns -1.0 for a perfectly monotone-decreasing relationship', () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = [50, 40, 30, 20, 10];
    expect(spearmanCorrelation(xs, ys)).toBeCloseTo(-1.0, 10);
  });

  it('returns a bounded ρ for unrelated series', () => {
    // y is a fixed pattern uncorrelated with x order. Spearman for this
    // specific 8-point arrangement is ≈ 0.50, well below the 1.0 ceiling.
    const xs = [1, 2, 3, 4, 5, 6, 7, 8];
    const ys = [3, 1, 4, 1, 5, 9, 2, 6];
    const r = spearmanCorrelation(xs, ys);
    expect(Math.abs(r)).toBeLessThan(0.7);
  });

  it('handles ties via averaged ranks', () => {
    // xs = [1, 2, 2, 3]; ys = [10, 20, 20, 30]. With averaged ranks both
    // series rank-transform to [1, 2.5, 2.5, 4], giving ρ = 1.
    const xs = [1, 2, 2, 3];
    const ys = [10, 20, 20, 30];
    expect(spearmanCorrelation(xs, ys)).toBeCloseTo(1.0, 10);
  });

  it('returns 0 for a constant series (no variance after ranking)', () => {
    const xs = [5, 5, 5, 5];
    const ys = [1, 2, 3, 4];
    expect(spearmanCorrelation(xs, ys)).toBe(0);
  });

  it('returns 0 for an empty input', () => {
    expect(spearmanCorrelation([], [])).toBe(0);
  });

  it('returns 0 for a single-element input', () => {
    expect(spearmanCorrelation([1], [2])).toBe(0);
  });

  it('throws on mismatched lengths', () => {
    expect(() => spearmanCorrelation([1, 2, 3], [1, 2])).toThrow(/length mismatch/);
  });

  it('is symmetric in its arguments', () => {
    const xs = [3, 1, 4, 1, 5, 9, 2, 6];
    const ys = [7, 2, 8, 1, 8, 5, 4, 2];
    expect(spearmanCorrelation(xs, ys)).toBeCloseTo(spearmanCorrelation(ys, xs), 10);
  });

  it('is deterministic (pure function of inputs)', () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = [2, 4, 1, 5, 3];
    const r1 = spearmanCorrelation(xs, ys);
    const r2 = spearmanCorrelation(xs, ys);
    expect(r1).toBe(r2);
  });

  it('matches the no-ties Spearman formula', () => {
    // xs and ys are both already-ranked (1..10) with no ties, so the
    // textbook shortcut ρ = 1 − 6·Σd² / (n(n²−1)) applies. By hand:
    //   d² = [4, 1, 1, 1, 9, 1, 4, 4, 1, 0]; Σd² = 26
    //   ρ = 1 − 6·26 / (10·99) = 1 − 156/990 ≈ 0.84242
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ys = [3, 1, 4, 5, 2, 7, 9, 6, 8, 10];
    const r = spearmanCorrelation(xs, ys);
    expect(r).toBeCloseTo(0.84242, 4);
  });
});
