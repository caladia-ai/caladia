import { describe, it, expect } from 'vitest';
import type { Calendar } from '@procsim/file-format';
import {
  addWorkingHours,
  workingHoursBetween,
  snapToNextWorkStart,
  isWorkingMoment,
} from './index.js';
import {
  prepareCalendar,
  addWorkingHoursP,
  workingHoursBetweenP,
  snapToNextWorkStartP,
  isWorkingMomentP,
} from './prepared.js';

// ── Fixtures (mirrored from index.test.ts so the equivalence runs over the
// same shapes the existing un-prepared functions are validated against).

const MON_FRI: Calendar = {
  id: 'mon-fri',
  name: 'Mon–Fri 8 h',
  workingDays: [false, true, true, true, true, true, false],
  hoursPerDay: 8,
  daysPerWeek: 5,
  holidayPreset: 'NONE',
  holidayPresetVersion: '1.0',
  exceptions: [],
};

const MON_FRI_12H: Calendar = { ...MON_FRI, id: 'mon-fri-12h', hoursPerDay: 12 };

const SAT_SUN: Calendar = {
  id: 'sat-sun',
  name: 'Sat–Sun',
  workingDays: [true, false, false, false, false, false, true],
  hoursPerDay: 8,
  daysPerWeek: 2,
  holidayPreset: 'NONE',
  holidayPresetVersion: '1.0',
  exceptions: [],
};

const MON_FRI_HOLIDAY: Calendar = {
  ...MON_FRI,
  id: 'mon-fri-holiday',
  exceptions: [{ date: '2026-01-05', type: 'holiday', name: 'Test Holiday' }],
};

const MON_SAT_EXCEPTION: Calendar = {
  ...MON_FRI,
  id: 'mon-sat-exception',
  exceptions: [{ date: '2026-01-10', type: 'working', name: 'Extra day' }],
};

function d(year: number, month: number, day: number, hour = 0, min = 0): Date {
  return new Date(year, month - 1, day, hour, min, 0, 0);
}

// Prepare each calendar with a generous horizon so all tested dates fall in
// the table. Base = 2025-01-01, horizon = 5 years = 1827 days.
function prep(cal: Calendar) {
  return prepareCalendar(cal, 2025, 0, 1, 1827);
}

// ── isWorkingMoment equivalence ─────────────────────────────────────────────

describe('isWorkingMomentP — equivalence with isWorkingMoment', () => {
  const cases: Array<[string, Date, Calendar]> = [
    ['Mon 09:00', d(2026, 1, 5, 9), MON_FRI],
    ['Mon 08:00 (boundary)', d(2026, 1, 5, 8), MON_FRI],
    ['Mon 16:00 (end-of-day boundary)', d(2026, 1, 5, 16), MON_FRI],
    ['Mon 07:59', new Date(2026, 0, 5, 7, 59), MON_FRI],
    ['Sat 09:00 (not working)', d(2026, 1, 10, 9), MON_FRI],
    ['Sun 09:00 (not working)', d(2026, 1, 11, 9), MON_FRI],
    ['Mon 09:00 on holiday-exception day', d(2026, 1, 5, 9), MON_FRI_HOLIDAY],
    ['Sat 09:00 on working-exception day', d(2026, 1, 10, 9), MON_SAT_EXCEPTION],
    ['Mon 09:00 on weekend-only calendar', d(2026, 1, 5, 9), SAT_SUN],
    ['Sat 09:00 on weekend-only calendar', d(2026, 1, 10, 9), SAT_SUN],
    ['Mon 12:00 on 12h calendar', d(2026, 1, 5, 12), MON_FRI_12H],
    ['Mon 20:00 on 12h calendar (end-of-day boundary)', d(2026, 1, 5, 20), MON_FRI_12H],
  ];

  for (const [name, t, cal] of cases) {
    it(name, () => {
      const expected = isWorkingMoment(t, cal);
      const actual = isWorkingMomentP(prep(cal), t);
      expect(actual).toBe(expected);
    });
  }
});

// ── snapToNextWorkStart equivalence ─────────────────────────────────────────

describe('snapToNextWorkStartP — equivalence with snapToNextWorkStart', () => {
  const cases: Array<[string, Date, Calendar]> = [
    ['Mon 09:00 (already working)', d(2026, 1, 5, 9), MON_FRI],
    ['Mon 06:00 (before 8am → 8am same day)', d(2026, 1, 5, 6), MON_FRI],
    ['Mon 17:00 (after 4pm → 8am Tue)', d(2026, 1, 5, 17), MON_FRI],
    ['Sat 09:00 → 8am Mon', d(2026, 1, 10, 9), MON_FRI],
    ['Sun 12:00 → 8am Mon', d(2026, 1, 11, 12), MON_FRI],
    ['Mon midnight → 8am Mon', d(2026, 1, 5, 0), MON_FRI],
    ['Fri 17:00 → 8am Mon next week', d(2026, 1, 9, 17), MON_FRI],
    ['Holiday Mon 9:00 → 8am Tue', d(2026, 1, 5, 9), MON_FRI_HOLIDAY],
  ];

  for (const [name, t, cal] of cases) {
    it(name, () => {
      const expected = snapToNextWorkStart(t, cal);
      const actual = snapToNextWorkStartP(prep(cal), t);
      expect(actual.getTime()).toBe(expected.getTime());
    });
  }
});

// ── addWorkingHours equivalence ─────────────────────────────────────────────

describe('addWorkingHoursP — equivalence (forward) with addWorkingHours', () => {
  const cases: Array<[string, Date, number, Calendar]> = [
    ['0 hours is identity', d(2026, 1, 5, 9), 0, MON_FRI],
    ['8h from Mon 8am → end of Mon (4pm)', d(2026, 1, 5, 8), 8, MON_FRI],
    ['8h from Mon midnight → 4pm Mon (snap to 8am first)', d(2026, 1, 5), 8, MON_FRI],
    ['8h from Mon 12pm → 12pm Tue', d(2026, 1, 5, 12), 8, MON_FRI],
    ['16h from Tue 8am → 4pm Wed', d(2026, 1, 6, 8), 16, MON_FRI],
    ['24h from Mon 8am → 4pm Wed (3 full days, end of day 3)', d(2026, 1, 5, 8), 24, MON_FRI],
    ['1h from Mon 12pm → 1pm Mon', d(2026, 1, 5, 12), 1, MON_FRI],
    ['40h from Mon 8am → 4pm Fri (full week)', d(2026, 1, 5, 8), 40, MON_FRI],
    ['41h from Mon 8am → 9am next Mon', d(2026, 1, 5, 8), 41, MON_FRI],
    ['Fractional 4.5h from Mon 12pm', d(2026, 1, 5, 12), 4.5, MON_FRI],
    ['9h from Mon 8am → 9am Tue (cross day)', d(2026, 1, 5, 8), 9, MON_FRI],
    ['skip weekend: Fri 12pm + 8h → 12pm Mon', d(2026, 1, 9, 12), 8, MON_FRI],
    ['skip holiday: Fri 12pm + 8h on holiday calendar', d(2026, 1, 9, 12), 8, MON_FRI_HOLIDAY],
    ['12h on 12h calendar (Mon 8am → end of Mon)', d(2026, 1, 5, 8), 12, MON_FRI_12H],
    ['13h on 12h calendar (Mon 8am → 9am Tue)', d(2026, 1, 5, 8), 13, MON_FRI_12H],
  ];

  for (const [name, t, hours, cal] of cases) {
    it(name, () => {
      const expected = addWorkingHours(t, hours, cal);
      const actual = addWorkingHoursP(prep(cal), t, hours);
      expect(actual.getTime()).toBe(expected.getTime());
    });
  }
});

describe('addWorkingHoursP — equivalence (backward) with addWorkingHours', () => {
  const cases: Array<[string, Date, number, Calendar]> = [
    ['-0 (negative zero) is identity', d(2026, 1, 5, 9), -0, MON_FRI],
    ['-8h from Mon 4pm → 8am Mon (full day back)', d(2026, 1, 5, 16), -8, MON_FRI],
    [
      '-1h from Tue 9am → 4pm Mon (cross day backward, into end-of-day)',
      d(2026, 1, 6, 9),
      -1,
      MON_FRI,
    ],
    ['-8h from Tue 12pm → 12pm Mon', d(2026, 1, 6, 12), -8, MON_FRI],
    ['-16h from Wed 4pm → 8am Tue', d(2026, 1, 7, 16), -16, MON_FRI],
    ['-24h from Wed 4pm → 8am Mon (3 full days back)', d(2026, 1, 7, 16), -24, MON_FRI],
    ['-8h from Mon 12pm crosses to previous Fri', d(2026, 1, 5, 12), -8, MON_FRI],
    ['Fractional -4.5h from Tue 12pm', d(2026, 1, 6, 12), -4.5, MON_FRI],
  ];

  for (const [name, t, hours, cal] of cases) {
    it(name, () => {
      const expected = addWorkingHours(t, hours, cal);
      const actual = addWorkingHoursP(prep(cal), t, hours);
      expect(actual.getTime()).toBe(expected.getTime());
    });
  }
});

// ── workingHoursBetween equivalence ─────────────────────────────────────────

describe('workingHoursBetweenP — equivalence with workingHoursBetween', () => {
  const cases: Array<[string, Date, Date, Calendar]> = [
    ['identical dates → 0', d(2026, 1, 5, 9), d(2026, 1, 5, 9), MON_FRI],
    ['within same day', d(2026, 1, 5, 9), d(2026, 1, 5, 13), MON_FRI],
    ['across one weekend', d(2026, 1, 9, 12), d(2026, 1, 12, 14), MON_FRI],
    ['full work week', d(2026, 1, 5, 8), d(2026, 1, 9, 16), MON_FRI],
    ['partial start, partial end, full middle', d(2026, 1, 5, 10), d(2026, 1, 8, 14), MON_FRI],
    ['end before start → negative', d(2026, 1, 7, 16), d(2026, 1, 5, 8), MON_FRI],
    ['span includes holiday', d(2026, 1, 2, 8), d(2026, 1, 7, 16), MON_FRI_HOLIDAY],
    [
      'span includes working-Saturday exception',
      d(2026, 1, 8, 8),
      d(2026, 1, 12, 16),
      MON_SAT_EXCEPTION,
    ],
    ['12h calendar span', d(2026, 1, 5, 8), d(2026, 1, 7, 20), MON_FRI_12H],
    ['weekend-only calendar', d(2026, 1, 9, 8), d(2026, 1, 12, 16), SAT_SUN],
    ['start in non-working day', d(2026, 1, 10, 12), d(2026, 1, 13, 12), MON_FRI],
    ['start before working hours, end after', d(2026, 1, 5, 6), d(2026, 1, 5, 18), MON_FRI],
  ];

  for (const [name, start, end, cal] of cases) {
    it(name, () => {
      const expected = workingHoursBetween(start, end, cal);
      const actual = workingHoursBetweenP(prep(cal), start, end);
      // Tolerate float noise of < 1 ns (different summation order across the
      // two implementations).
      expect(Math.abs(actual - expected)).toBeLessThan(1e-9);
    });
  }
});

// ── Cross-DST sanity (US spring-forward + fall-back) ────────────────────────
//
// US DST transitions: 2026-03-08 (spring-forward 02:00 → 03:00), 2026-11-01
// (fall-back 02:00 → 01:00). The local-time Date constructor handles these
// correctly; the prepared table must too.

describe('DST transitions', () => {
  it('workingHoursBetween across spring-forward equals unprepared version', () => {
    const start = d(2026, 3, 5, 8);
    const end = d(2026, 3, 12, 16);
    const expected = workingHoursBetween(start, end, MON_FRI);
    const actual = workingHoursBetweenP(prep(MON_FRI), start, end);
    expect(Math.abs(actual - expected)).toBeLessThan(1e-9);
  });

  it('workingHoursBetween across fall-back equals unprepared version', () => {
    const start = d(2026, 10, 30, 8);
    const end = d(2026, 11, 6, 16);
    const expected = workingHoursBetween(start, end, MON_FRI);
    const actual = workingHoursBetweenP(prep(MON_FRI), start, end);
    expect(Math.abs(actual - expected)).toBeLessThan(1e-9);
  });

  it('addWorkingHours across spring-forward equals unprepared version', () => {
    const start = d(2026, 3, 5, 12);
    const hours = 40;
    const expected = addWorkingHours(start, hours, MON_FRI);
    const actual = addWorkingHoursP(prep(MON_FRI), start, hours);
    expect(actual.getTime()).toBe(expected.getTime());
  });
});

// ── Range guards ────────────────────────────────────────────────────────────

describe('out-of-range', () => {
  it('throws when querying a date before base', () => {
    const p = prep(MON_FRI);
    expect(() => isWorkingMomentP(p, d(2024, 12, 31))).toThrow(/outside prepared range/);
  });

  it('throws when querying a date after horizon', () => {
    const p = prep(MON_FRI); // 5-year horizon from 2025-01-01
    expect(() => isWorkingMomentP(p, d(2031, 1, 1))).toThrow(/outside prepared range/);
  });
});
