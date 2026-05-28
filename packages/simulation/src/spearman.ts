/**
 * Phase 31 — Spearman rank-order correlation.
 *
 * ρ ∈ [-1, 1] between two equal-length numeric series. The result is
 * Pearson's correlation computed on the rank-transformed series, which
 * captures monotone relationships even when the underlying signal is
 * non-linear (e.g., a long-tail duration distribution coupling
 * monotonically with project finish through a critical-path activity).
 *
 * Ties get the average rank (the standard "fractional ranking" approach)
 * so that two identical samples don't artificially inflate or deflate ρ.
 *
 * Edge cases:
 *   - Length < 2 → returns 0 (correlation undefined; the engine treats
 *     this as "no signal" rather than NaN).
 *   - Constant series (zero variance after ranking) → returns 0. A flat
 *     input can't have a monotone relationship with anything.
 *   - Mismatched lengths → throws (programmer error, not user input).
 *
 * Determinism: pure function of the inputs. No RNG, no time, no global state.
 */
export function spearmanCorrelation(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length) {
    throw new Error(`spearmanCorrelation: length mismatch (xs=${xs.length}, ys=${ys.length})`);
  }
  const n = xs.length;
  if (n < 2) return 0;

  const xRanks = fractionalRanks(xs);
  const yRanks = fractionalRanks(ys);
  return pearsonCorrelation(xRanks, yRanks);
}

/**
 * Convert a numeric series to fractional ranks (1-based; ties averaged).
 *
 * Example: [10, 20, 20, 30] → [1, 2.5, 2.5, 4] (the two 20s share ranks
 * 2 and 3, averaged to 2.5).
 *
 * O(n log n) — dominated by the sort. Allocation is one index array +
 * one output array. Returns a fresh array; does not mutate the input.
 */
function fractionalRanks(values: readonly number[]): number[] {
  const n = values.length;
  const indices = new Array<number>(n);
  for (let i = 0; i < n; i++) indices[i] = i;
  indices.sort((a, b) => values[a]! - values[b]!);

  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    // Find the run of tied values starting at sorted-position i.
    let j = i + 1;
    while (j < n && values[indices[j]!]! === values[indices[i]!]!) j++;
    // Average rank for this tie group (1-based: positions [i, j-1] map
    // to ranks [i+1, j], whose mean is (i + 1 + j) / 2).
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      ranks[indices[k]!] = avgRank;
    }
    i = j;
  }
  return ranks;
}

/**
 * Pearson product-moment correlation. Used here only as the inner kernel
 * for Spearman (operating on rank-transformed inputs). Not exported —
 * `spearmanCorrelation` is the public surface.
 */
function pearsonCorrelation(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i]!;
    sumY += ys[i]!;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  const denom = Math.sqrt(varX * varY);
  if (denom === 0) return 0;
  return cov / denom;
}
