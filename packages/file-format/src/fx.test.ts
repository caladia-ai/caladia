import { describe, it, expect } from 'vitest';
import {
  applyFxOverrides,
  convertAmount,
  convertResourceCostsToProjectCurrency,
  listAvailableTargetCurrencies,
  listBundledSnapshotVersions,
  loadFxSnapshot,
  LATEST_BUNDLED_SNAPSHOT,
} from './fx.js';
import type { ProjectFile } from './schema.js';

describe('FX snapshot loader', () => {
  it('lists bundled snapshot versions newest-first', () => {
    const versions = listBundledSnapshotVersions();
    expect(versions).toEqual(['2026.1', '2026.0']);
  });

  it('LATEST_BUNDLED_SNAPSHOT is the first entry', () => {
    expect(LATEST_BUNDLED_SNAPSHOT.version).toBe('2026.1');
  });

  it('loads a known version', () => {
    const snap = loadFxSnapshot('2026.1');
    expect(snap?.version).toBe('2026.1');
    expect(snap?.base).toBe('USD');
    expect(snap?.rates.EUR).toBeCloseTo(0.854277, 6);
  });

  it('loads an older bundled version', () => {
    const snap = loadFxSnapshot('2026.0');
    expect(snap?.version).toBe('2026.0');
  });

  it('returns null for unknown versions', () => {
    expect(loadFxSnapshot('1999.7')).toBeNull();
  });

  it('returns null for the NONE sentinel', () => {
    expect(loadFxSnapshot('NONE')).toBeNull();
  });
});

describe('convertAmount', () => {
  const snap = LATEST_BUNDLED_SNAPSHOT;

  it('returns the input unchanged when from === to', () => {
    expect(convertAmount(100, 'USD', 'USD', snap)).toBe(100);
    expect(convertAmount(42.5, 'JPY', 'JPY', snap)).toBe(42.5);
  });

  it('round-trips USD → CAD → USD within rounding tolerance', () => {
    const inCad = convertAmount(100, 'USD', 'CAD', snap)!;
    const back = convertAmount(inCad, 'CAD', 'USD', snap)!;
    expect(back).toBeCloseTo(100, 8);
  });

  it('round-trips EUR → JPY → EUR within rounding tolerance', () => {
    const inJpy = convertAmount(1000, 'EUR', 'JPY', snap)!;
    const back = convertAmount(inJpy, 'JPY', 'EUR', snap)!;
    expect(back).toBeCloseTo(1000, 6);
  });

  it('converts 1 USD into the snapshot rate of the target currency', () => {
    expect(convertAmount(1, 'USD', 'EUR', snap)).toBeCloseTo(0.854277, 6);
    expect(convertAmount(1, 'USD', 'JPY', snap)).toBeCloseTo(157.401858, 4);
  });

  it('converts non-USD pairs via the base correctly', () => {
    // 1 EUR → ?CAD: 1/0.854277 USD = 1.170581 USD; × 1.372391 CAD/USD = 1.606..
    const result = convertAmount(1, 'EUR', 'CAD', snap)!;
    const viaUsd = (1 / snap.rates.EUR!) * snap.rates.CAD!;
    expect(result).toBeCloseTo(viaUsd, 10);
  });

  it('returns null when either currency is missing from the snapshot', () => {
    expect(convertAmount(100, 'USD', 'XYZ', snap)).toBeNull();
    expect(convertAmount(100, 'XYZ', 'USD', snap)).toBeNull();
  });

  it('returns null when snapshot is null (e.g. NONE)', () => {
    expect(convertAmount(100, 'USD', 'EUR', null)).toBeNull();
  });
});

describe('listAvailableTargetCurrencies', () => {
  it('returns every currency in the snapshot sorted alphabetically', () => {
    const codes = listAvailableTargetCurrencies(LATEST_BUNDLED_SNAPSHOT);
    expect([...codes]).toEqual(['AUD', 'CAD', 'CHF', 'CNY', 'EUR', 'GBP', 'INR', 'JPY', 'USD']);
  });

  it('returns an empty array when snapshot is null', () => {
    expect(listAvailableTargetCurrencies(null)).toEqual([]);
  });
});

describe('applyFxOverrides', () => {
  it('returns the snapshot unchanged when overrides is null/undefined/empty', () => {
    expect(applyFxOverrides(LATEST_BUNDLED_SNAPSHOT, null)).toBe(LATEST_BUNDLED_SNAPSHOT);
    expect(applyFxOverrides(LATEST_BUNDLED_SNAPSHOT, undefined)).toBe(LATEST_BUNDLED_SNAPSHOT);
    expect(applyFxOverrides(LATEST_BUNDLED_SNAPSHOT, {})).toBe(LATEST_BUNDLED_SNAPSHOT);
  });

  it('returns null when snapshot is null', () => {
    expect(applyFxOverrides(null, { EUR: 0.9 })).toBeNull();
  });

  it('merges overrides onto a fresh snapshot copy', () => {
    const out = applyFxOverrides(LATEST_BUNDLED_SNAPSHOT, { EUR: 0.9, CAD: 1.4 })!;
    expect(out.rates.EUR).toBe(0.9);
    expect(out.rates.CAD).toBe(1.4);
    expect(out.rates.GBP).toBe(LATEST_BUNDLED_SNAPSHOT.rates.GBP);
    expect(out.version).toBe('2026.1+overrides');
    // Source snapshot unchanged
    expect(LATEST_BUNDLED_SNAPSHOT.rates.EUR).not.toBe(0.9);
  });

  it('convertAmount uses the overridden rate', () => {
    const out = applyFxOverrides(LATEST_BUNDLED_SNAPSHOT, { EUR: 0.9 })!;
    expect(convertAmount(1, 'USD', 'EUR', out)).toBe(0.9);
  });
});

// ── Phase 33 Slice 2 — convertResourceCostsToProjectCurrency ────────────────

describe('convertResourceCostsToProjectCurrency', () => {
  function makeProject(currency: string, resources: ProjectFile['resources']): ProjectFile {
    return {
      kind: 'caladia-project',
      version: 8,
      currency,
      fxSnapshotVersion: '2026.1',
      project: {
        name: 'Test',
        startDate: '2026-01-01',
        defaultCalendarId: 'cal-1',
        displayUnit: 'days',
        shareMode: 'percentage',
      },
      calendars: [
        {
          id: 'cal-1',
          name: 'Standard',
          workingDays: [false, true, true, true, true, true, false],
          hoursPerDay: 8,
          daysPerWeek: 5,
          holidayPreset: 'NONE',
          holidayPresetVersion: '1.0',
          exceptions: [],
        },
      ],
      resources,
      nodes: [],
      edges: [],
      loops: [],
      subsystems: [],
      scenarios: [],
      comments: [],
      groupColors: {},
    };
  }

  it('passes through resources with no override', () => {
    const project = makeProject('USD', [
      { id: 'r1', name: 'Dev', capacity: 1, calendarId: 'cal-1', costRate: 100, costPerUse: 50 },
    ]);
    const result = convertResourceCostsToProjectCurrency(project);
    expect(result[0]).toEqual(project.resources[0]);
  });

  it('passes through resources whose override equals project currency', () => {
    const project = makeProject('USD', [
      {
        id: 'r1',
        name: 'Dev',
        capacity: 1,
        calendarId: 'cal-1',
        costRate: 100,
        currencyOverride: 'USD',
      },
    ]);
    const result = convertResourceCostsToProjectCurrency(project);
    expect(result[0]).toEqual(project.resources[0]);
  });

  it('converts costRate from EUR to USD via FX snapshot', () => {
    const project = makeProject('USD', [
      {
        id: 'r1',
        name: 'EU',
        capacity: 1,
        calendarId: 'cal-1',
        costRate: 100,
        currencyOverride: 'EUR',
      },
    ]);
    const result = convertResourceCostsToProjectCurrency(project);
    // 100 EUR @ ~0.854 EUR/USD ≈ 117 USD. Check it's in a plausible range
    // and not the input unchanged.
    expect(result[0]?.costRate).toBeGreaterThan(100);
    expect(result[0]?.costRate).toBeLessThan(150);
    expect(result[0]?.currencyOverride).toBeUndefined();
  });

  it('converts costPerUse with the same factor as costRate', () => {
    const project = makeProject('USD', [
      {
        id: 'r1',
        name: 'EU',
        capacity: 1,
        calendarId: 'cal-1',
        costRate: 100,
        costPerUse: 50,
        currencyOverride: 'EUR',
      },
    ]);
    const result = convertResourceCostsToProjectCurrency(project);
    const r = result[0]!;
    // The factor relating costRate to costPerUse should be preserved
    // (both scale by the same FX factor).
    expect(r.costRate! / r.costPerUse!).toBeCloseTo(100 / 50, 10);
  });

  it('scales triangular distribution parameters by the same factor', () => {
    const project = makeProject('USD', [
      {
        id: 'r1',
        name: 'EU',
        capacity: 1,
        calendarId: 'cal-1',
        costRate: 100,
        currencyOverride: 'EUR',
        hourlyRateDistribution: { type: 'triangular', min: 80, mode: 100, max: 150 },
      },
    ]);
    const result = convertResourceCostsToProjectCurrency(project);
    const r = result[0]!;
    const dist = r.hourlyRateDistribution!;
    expect(dist.type).toBe('triangular');
    if (dist.type === 'triangular') {
      // All three should scale by the same factor as costRate (which
      // converted 100 EUR → X USD).
      const factor = r.costRate! / 100;
      expect(dist.min).toBeCloseTo(80 * factor, 5);
      expect(dist.mode).toBeCloseTo(100 * factor, 5);
      expect(dist.max).toBeCloseTo(150 * factor, 5);
    }
  });

  it('passes through when fxSnapshotVersion is NONE (graceful degrade)', () => {
    const project = makeProject('USD', [
      {
        id: 'r1',
        name: 'EU',
        capacity: 1,
        calendarId: 'cal-1',
        costRate: 100,
        currencyOverride: 'EUR',
      },
    ]);
    project.fxSnapshotVersion = 'NONE';
    const result = convertResourceCostsToProjectCurrency(project);
    // Snapshot is null → conversion returns null → fall back to the
    // stored value. The override stays in the output since we didn't
    // convert.
    expect(result[0]?.costRate).toBe(100);
    expect(result[0]?.currencyOverride).toBe('EUR');
  });

  it('passes through when override currency is missing from the snapshot', () => {
    const project = makeProject('USD', [
      {
        id: 'r1',
        name: 'EU',
        capacity: 1,
        calendarId: 'cal-1',
        costRate: 100,
        currencyOverride: 'ZWL',
      },
    ]);
    const result = convertResourceCostsToProjectCurrency(project);
    // ZWL is not in the bundled snapshot → conversion fails → fall back
    expect(result[0]?.costRate).toBe(100);
    expect(result[0]?.currencyOverride).toBe('ZWL');
  });
});
