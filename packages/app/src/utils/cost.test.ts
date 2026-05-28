import { describe, it, expect } from 'vitest';
import { currencyStep } from './cost.js';

// ── currencyStep ─────────────────────────────────────────────────────────────
//
// Pure helper that picks a sensible `step` for currency-bearing number
// inputs. Self-correcting: one order of magnitude below the value,
// clamped to a currency-aware floor.

describe('currencyStep (USD-class rate)', () => {
  it.each([
    [0, 1],
    [1, 1],
    [5, 1],
    [9, 1],
    [10, 1], // log10(10)=1 → 10^0=1
    [50, 1],
    [99, 1],
    [100, 10], // log10(100)=2 → 10^1=10
    [500, 10],
    [999, 10],
    [1_000, 100], // log10(1000)=3 → 10^2=100
    [9_999, 100],
    [10_000, 1_000],
    [100_000, 10_000],
  ])('value=%i → step=%i', (value, expectedStep) => {
    expect(currencyStep('USD', value, 'rate')).toBe(expectedStep);
  });

  it('respects the floor when value is small / 0 / non-finite', () => {
    expect(currencyStep('USD', 0, 'rate')).toBe(1);
    expect(currencyStep('USD', -50, 'rate')).toBe(1);
    expect(currencyStep('USD', NaN, 'rate')).toBe(1);
    // Infinity is non-finite → falls back to floor (defensive — caller
    // shouldn't pass Infinity, but a bug elsewhere shouldn't break the input).
    expect(currencyStep('USD', Infinity, 'rate')).toBe(1);
  });
});

describe('currencyStep (USD-class budget)', () => {
  // Budget floor is 100× rate floor (= 100 for USD), so values below 1000
  // all collapse to the floor.
  it.each([
    [0, 100],
    [50, 100],
    [999, 100],
    [1_000, 100], // log10(1000)=3 → 10^2=100, max(100, 100) = 100
    [10_000, 1_000],
    [50_000, 1_000],
    [100_000, 10_000],
    [1_000_000, 100_000],
  ])('value=%i → step=%i', (value, expectedStep) => {
    expect(currencyStep('USD', value, 'budget')).toBe(expectedStep);
  });
});

describe('currencyStep (JPY — no-minor-unit currency)', () => {
  // JPY-class: floor is 100× the USD-class floor.
  it('rate floor is 100', () => {
    expect(currencyStep('JPY', 0, 'rate')).toBe(100);
    expect(currencyStep('JPY', 50, 'rate')).toBe(100);
    expect(currencyStep('JPY', 999, 'rate')).toBe(100);
  });
  it('rate scales OOM-style above the floor', () => {
    expect(currencyStep('JPY', 1_000, 'rate')).toBe(100);
    expect(currencyStep('JPY', 10_000, 'rate')).toBe(1_000);
    expect(currencyStep('JPY', 100_000, 'rate')).toBe(10_000);
  });
  it('budget floor is 10,000', () => {
    expect(currencyStep('JPY', 0, 'budget')).toBe(10_000);
    expect(currencyStep('JPY', 5_000, 'budget')).toBe(10_000);
  });
  it('budget scales OOM-style above the floor', () => {
    expect(currencyStep('JPY', 100_000, 'budget')).toBe(10_000);
    expect(currencyStep('JPY', 1_000_000, 'budget')).toBe(100_000);
    expect(currencyStep('JPY', 10_000_000, 'budget')).toBe(1_000_000);
  });
  it('case-insensitive currency code', () => {
    expect(currencyStep('jpy', 1_000, 'rate')).toBe(100);
  });
});

describe('currencyStep (other no-minor-unit currencies)', () => {
  it.each(['KRW', 'VND', 'HUF', 'IDR', 'CLP', 'ISK'])('%s rate floor is 100', (code) => {
    expect(currencyStep(code, 0, 'rate')).toBe(100);
  });
});

describe('currencyStep (unknown currency defaults to minor-unit behaviour)', () => {
  // An unknown ISO code (or a typo) is conservatively treated as having a
  // minor unit — floor=1 for rate, floor=100 for budget.
  it('returns rate floor 1', () => {
    expect(currencyStep('XYZ', 0, 'rate')).toBe(1);
  });
  it('returns budget floor 100', () => {
    expect(currencyStep('XYZ', 0, 'budget')).toBe(100);
  });
});
