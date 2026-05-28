import { describe, it, expect } from 'vitest';
import { getPreset, latestPresetVersion } from './presets.js';
import type { HolidayPresetId } from './schema.js';

// Phase 36 Slice 1 — coverage for the four regional presets added beyond
// the original US / Canada / EU set. Each preset must:
//   (a) be reachable via latestPresetVersion + getPreset(id) without throw,
//   (b) cover the year range YEAR_START–YEAR_END (currently 2020–2035),
//   (c) deliver the same number of holidays each year (sanity check on the
//       generator + computeRange composition),
//   (d) include the named fixed-date holiday in the expected slot.
//
// Easter-derived dates (Carnival, Good Friday, Corpus Christi, Easter
// Monday) are spot-checked on a single year each — the underlying
// `easter()` helper is already exercised by the existing CA / EU tests.

const YEAR_START = 2020;
const YEAR_END = 2035;
const YEARS_COVERED = YEAR_END - YEAR_START + 1; // inclusive

function holidaysInYear(id: HolidayPresetId, year: number) {
  const preset = getPreset(id);
  return preset.holidays.filter((h) => h.date.startsWith(`${year}-`));
}

function expectCount(id: HolidayPresetId, perYear: number): void {
  const preset = getPreset(id);
  expect(preset.holidays.length).toBe(perYear * YEARS_COVERED);
  for (let y = YEAR_START; y <= YEAR_END; y++) {
    expect(holidaysInYear(id, y).length).toBe(perYear);
  }
}

function expectDate(id: HolidayPresetId, year: number, mmdd: string, nameContains: string): void {
  const date = `${year}-${mmdd}`;
  const match = getPreset(id).holidays.find(
    (h) => h.date === date && h.name.includes(nameContains),
  );
  expect(match, `expected ${id} to have ${nameContains} on ${date}`).toBeDefined();
}

describe('holiday presets — regional expansion', () => {
  it('BRAZIL_FEDERAL: reachable via latestPresetVersion + getPreset', () => {
    expect(latestPresetVersion('BRAZIL_FEDERAL')).toBe('2026.1');
    expect(() => getPreset('BRAZIL_FEDERAL')).not.toThrow();
  });

  it('BRAZIL_FEDERAL: 13 holidays per year × 16 years', () => {
    expectCount('BRAZIL_FEDERAL', 13);
  });

  it('BRAZIL_FEDERAL: includes fixed-date holidays', () => {
    expectDate('BRAZIL_FEDERAL', 2024, '01-01', 'Confraternização');
    expectDate('BRAZIL_FEDERAL', 2024, '04-21', 'Tiradentes');
    expectDate('BRAZIL_FEDERAL', 2024, '09-07', 'Independência');
    expectDate('BRAZIL_FEDERAL', 2024, '11-20', 'Consciência Negra');
    expectDate('BRAZIL_FEDERAL', 2024, '12-25', 'Natal');
  });

  it('BRAZIL_FEDERAL: Carnival lands on the Monday + Tuesday before Ash Wednesday (Easter 2024 = Mar 31)', () => {
    // Easter Sunday 2024 = 2024-03-31 → Carnival Tuesday = 2024-02-13, Monday = 2024-02-12.
    expectDate('BRAZIL_FEDERAL', 2024, '02-12', 'Carnaval (Segunda-feira)');
    expectDate('BRAZIL_FEDERAL', 2024, '02-13', 'Carnaval (Terça-feira)');
  });

  it('MEXICO_FEDERAL: reachable + 7 holidays per year × 16 years', () => {
    expect(latestPresetVersion('MEXICO_FEDERAL')).toBe('2026.1');
    expectCount('MEXICO_FEDERAL', 7);
  });

  it('MEXICO_FEDERAL: post-2006 Monday-shifted holidays land on a Monday', () => {
    for (let y = YEAR_START; y <= YEAR_END; y++) {
      const year = holidaysInYear('MEXICO_FEDERAL', y);
      const constitution = year.find((h) => h.name.includes('Constitución'));
      const juarez = year.find((h) => h.name.includes('Juárez'));
      const revolution = year.find((h) => h.name.includes('Revolución'));
      expect(constitution).toBeDefined();
      expect(juarez).toBeDefined();
      expect(revolution).toBeDefined();
      // Day of week 1 = Monday (Date.getDay() returns Sun=0).
      expect(new Date(`${constitution!.date}T00:00:00`).getDay()).toBe(1);
      expect(new Date(`${juarez!.date}T00:00:00`).getDay()).toBe(1);
      expect(new Date(`${revolution!.date}T00:00:00`).getDay()).toBe(1);
    }
  });

  it('MEXICO_FEDERAL: fixed-date Independence Day on Sep 16', () => {
    expectDate('MEXICO_FEDERAL', 2024, '09-16', 'Independencia');
  });

  it('JAPAN_NATIONAL: reachable + 16 holidays per year × 16 years', () => {
    expect(latestPresetVersion('JAPAN_NATIONAL')).toBe('2026.1');
    expectCount('JAPAN_NATIONAL', 16);
  });

  it('JAPAN_NATIONAL: vernal + autumnal equinoxes are dated from the lookup table', () => {
    // 2024: vernal = Mar 20, autumnal = Sep 22 (per Japan NAO).
    expectDate('JAPAN_NATIONAL', 2024, '03-20', 'Vernal Equinox');
    expectDate('JAPAN_NATIONAL', 2024, '09-22', 'Autumnal Equinox');
    // 2027: vernal = Mar 21 (the alternate slot).
    expectDate('JAPAN_NATIONAL', 2027, '03-21', 'Vernal Equinox');
  });

  it('JAPAN_NATIONAL: Coming of Age Day is the 2nd Monday of January', () => {
    for (let y = YEAR_START; y <= YEAR_END; y++) {
      const day = holidaysInYear('JAPAN_NATIONAL', y).find((h) => h.name.includes('Coming of Age'));
      expect(day).toBeDefined();
      const d = new Date(`${day!.date}T00:00:00`);
      expect(d.getMonth()).toBe(0);
      expect(d.getDay()).toBe(1);
      // 2nd-Monday: day-of-month in [8, 14].
      expect(d.getDate()).toBeGreaterThanOrEqual(8);
      expect(d.getDate()).toBeLessThanOrEqual(14);
    }
  });

  it('AUSTRALIA_NATIONAL: reachable + 8 holidays per year × 16 years', () => {
    expect(latestPresetVersion('AUSTRALIA_NATIONAL')).toBe('2026.1');
    expectCount('AUSTRALIA_NATIONAL', 8);
  });

  it('AUSTRALIA_NATIONAL: includes fixed-date national holidays', () => {
    expectDate('AUSTRALIA_NATIONAL', 2024, '01-26', 'Australia Day');
    expectDate('AUSTRALIA_NATIONAL', 2024, '04-25', 'Anzac Day');
    expectDate('AUSTRALIA_NATIONAL', 2024, '12-25', 'Christmas');
    expectDate('AUSTRALIA_NATIONAL', 2024, '12-26', 'Boxing Day');
  });

  it("AUSTRALIA_NATIONAL: King's Birthday is the 2nd Monday of June", () => {
    for (let y = YEAR_START; y <= YEAR_END; y++) {
      const kb = holidaysInYear('AUSTRALIA_NATIONAL', y).find((h) =>
        h.name.includes("King's Birthday"),
      );
      expect(kb).toBeDefined();
      const d = new Date(`${kb!.date}T00:00:00`);
      expect(d.getMonth()).toBe(5);
      expect(d.getDay()).toBe(1);
      expect(d.getDate()).toBeGreaterThanOrEqual(8);
      expect(d.getDate()).toBeLessThanOrEqual(14);
    }
  });

  it('AUSTRALIA_NATIONAL: Good Friday + Easter Monday flank Easter Sunday 2024-03-31', () => {
    expectDate('AUSTRALIA_NATIONAL', 2024, '03-29', 'Good Friday');
    expectDate('AUSTRALIA_NATIONAL', 2024, '04-01', 'Easter Monday');
  });
});
