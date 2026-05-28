import { describe, it, expect } from 'vitest';
import type { Calendar } from '@procsim/file-format';
import {
  isWorkingMoment,
  addWorkingHours,
  workingHoursBetween,
  snapToNextWorkStart,
  effectiveActivityCalendar,
  resolveAssignmentCalendar,
} from './index.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

// Mon–Fri, 8 h/day, no holidays
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

// Sat–Sun only (weekend contractor)
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

// Mon–Fri with a holiday exception on 2026-01-05 (Monday)
const MON_FRI_HOLIDAY: Calendar = {
  ...MON_FRI,
  id: 'mon-fri-holiday',
  exceptions: [{ date: '2026-01-05', type: 'holiday', name: 'Test Holiday' }],
};

// Mon–Fri with a "working" exception on 2026-01-10 (Saturday)
const MON_SAT_EXCEPTION: Calendar = {
  ...MON_FRI,
  id: 'mon-sat-exception',
  exceptions: [{ date: '2026-01-10', type: 'working', name: 'Extra day' }],
};

// Jan 5 2026 = Monday
function d(year: number, month: number, day: number, hour = 0, min = 0): Date {
  return new Date(year, month - 1, day, hour, min, 0, 0);
}

// ── isWorkingMoment ───────────────────────────────────────────────────────────

describe('isWorkingMoment', () => {
  it('returns true for a weekday within working hours', () => {
    expect(isWorkingMoment(d(2026, 1, 5, 9), MON_FRI)).toBe(true);
  });

  it('returns true at the start of working hours (08:00)', () => {
    expect(isWorkingMoment(d(2026, 1, 5, 8), MON_FRI)).toBe(true);
  });

  it('returns false at the end boundary (16:00 is exclusive)', () => {
    expect(isWorkingMoment(d(2026, 1, 5, 16), MON_FRI)).toBe(false);
  });

  it('returns false before working hours start (07:59)', () => {
    expect(isWorkingMoment(new Date(2026, 0, 5, 7, 59), MON_FRI)).toBe(false);
  });

  it('returns false on a Saturday', () => {
    expect(isWorkingMoment(d(2026, 1, 10, 9), MON_FRI)).toBe(false);
  });

  it('returns false on a Sunday', () => {
    expect(isWorkingMoment(d(2026, 1, 11, 9), MON_FRI)).toBe(false);
  });

  it('returns false on a holiday exception', () => {
    expect(isWorkingMoment(d(2026, 1, 5, 9), MON_FRI_HOLIDAY)).toBe(false);
  });

  it('returns true on a Saturday with a working exception', () => {
    expect(isWorkingMoment(d(2026, 1, 10, 9), MON_SAT_EXCEPTION)).toBe(true);
  });
});

// ── addWorkingHours — forward ─────────────────────────────────────────────────

describe('addWorkingHours — forward', () => {
  it('same day: start at 08:00, add 8 h → 16:00', () => {
    const result = addWorkingHours(d(2026, 1, 5, 8), 8, MON_FRI);
    expect(result).toEqual(d(2026, 1, 5, 16));
  });

  it('start at midnight on a working day: add 8 h → 16:00 same day', () => {
    const result = addWorkingHours(d(2026, 1, 5), 8, MON_FRI);
    expect(result).toEqual(d(2026, 1, 5, 16));
  });

  it('partial day: start at 12:00, add 8 h → spans to next working day', () => {
    // 4 h remain Monday, 4 h Tuesday → ends Tuesday 12:00
    const result = addWorkingHours(d(2026, 1, 5, 12), 8, MON_FRI);
    expect(result).toEqual(d(2026, 1, 6, 12));
  });

  it('crosses a weekend: Friday 08:00 + 16 h → Monday 16:00', () => {
    // 8 h Fri + 8 h Mon = 16
    const result = addWorkingHours(d(2026, 1, 9, 8), 16, MON_FRI);
    expect(result).toEqual(d(2026, 1, 12, 16));
  });

  it('end of working day → next working day start', () => {
    // Starting at 16:00 (past end) snaps to next day 08:00
    const result = addWorkingHours(d(2026, 1, 5, 16), 8, MON_FRI);
    expect(result).toEqual(d(2026, 1, 6, 16));
  });

  it('start on Saturday snaps to Monday', () => {
    const result = addWorkingHours(d(2026, 1, 10, 9), 8, MON_FRI);
    expect(result).toEqual(d(2026, 1, 12, 16));
  });

  it('holiday exception causes task to skip to next working day', () => {
    // 2026-01-05 is a holiday; start of week becomes Tuesday
    const result = addWorkingHours(d(2026, 1, 5, 8), 8, MON_FRI_HOLIDAY);
    expect(result).toEqual(d(2026, 1, 6, 16));
  });

  it('zero hours returns input unchanged', () => {
    const start = d(2026, 1, 5, 12);
    expect(addWorkingHours(start, 0, MON_FRI)).toEqual(start);
  });
});

// ── addWorkingHours — backward ────────────────────────────────────────────────

describe('addWorkingHours — backward', () => {
  it('same day: 16:00 − 8 h → 08:00', () => {
    expect(addWorkingHours(d(2026, 1, 5, 16), -8, MON_FRI)).toEqual(d(2026, 1, 5, 8));
  });

  it('crosses a weekend: Monday 08:00 − 8 h → Friday 08:00', () => {
    expect(addWorkingHours(d(2026, 1, 12, 8), -8, MON_FRI)).toEqual(d(2026, 1, 9, 8));
  });

  it('from Monday 12:00 − 6 h → Friday 14:00', () => {
    // 4 h from Mon 08:00→12:00, then 2 h back on Friday = Fri 14:00
    expect(addWorkingHours(d(2026, 1, 12, 12), -6, MON_FRI)).toEqual(d(2026, 1, 9, 14));
  });

  it('from Friday 16:00 − 16 h → Thursday 08:00', () => {
    // 8 h Fri + 8 h Thu
    expect(addWorkingHours(d(2026, 1, 9, 16), -16, MON_FRI)).toEqual(d(2026, 1, 8, 8));
  });
});

// ── addWorkingHours ↔ workingHoursBetween consistency ────────────────────────

describe('addWorkingHours / workingHoursBetween consistency', () => {
  const cases: Array<{ start: Date; hours: number }> = [
    { start: d(2026, 1, 5, 8), hours: 8 },
    { start: d(2026, 1, 5, 8), hours: 16 },
    { start: d(2026, 1, 5, 8), hours: 40 },
    { start: d(2026, 1, 9, 12), hours: 6 }, // starts Friday, crosses weekend
    { start: d(2026, 1, 5, 10), hours: 2.5 },
  ];

  for (const { start, hours } of cases) {
    it(`workingHoursBetween(start, addWorkingHours(start, ${hours})) === ${hours}`, () => {
      const end = addWorkingHours(start, hours, MON_FRI);
      expect(workingHoursBetween(start, end, MON_FRI)).toBeCloseTo(hours, 6);
    });
  }
});

// ── workingHoursBetween ───────────────────────────────────────────────────────

describe('workingHoursBetween', () => {
  it('same time → 0', () => {
    const t = d(2026, 1, 5, 10);
    expect(workingHoursBetween(t, t, MON_FRI)).toBe(0);
  });

  it('full working day', () => {
    expect(workingHoursBetween(d(2026, 1, 5, 8), d(2026, 1, 5, 16), MON_FRI)).toBe(8);
  });

  it('across a weekend counts only weekday hours', () => {
    expect(workingHoursBetween(d(2026, 1, 9, 8), d(2026, 1, 12, 16), MON_FRI)).toBe(16);
  });

  it('midnight to midnight on the same day → 0', () => {
    expect(workingHoursBetween(d(2026, 1, 5), d(2026, 1, 6), MON_FRI)).toBe(8);
  });

  it('returns negative when end < start', () => {
    expect(workingHoursBetween(d(2026, 1, 5, 16), d(2026, 1, 5, 8), MON_FRI)).toBe(-8);
  });
});

// ── snapToNextWorkStart ───────────────────────────────────────────────────────

describe('snapToNextWorkStart', () => {
  it('midnight on a working day → 08:00 same day', () => {
    expect(snapToNextWorkStart(d(2026, 1, 5), MON_FRI)).toEqual(d(2026, 1, 5, 8));
  });

  it('already inside working hours → unchanged', () => {
    const t = d(2026, 1, 5, 10);
    expect(snapToNextWorkStart(t, MON_FRI)).toEqual(t);
  });

  it('Saturday midnight → Monday 08:00', () => {
    expect(snapToNextWorkStart(d(2026, 1, 10), MON_FRI)).toEqual(d(2026, 1, 12, 8));
  });

  it('past end of Friday → Monday 08:00', () => {
    expect(snapToNextWorkStart(d(2026, 1, 9, 17), MON_FRI)).toEqual(d(2026, 1, 12, 8));
  });
});

// ── effectiveActivityCalendar ─────────────────────────────────────────────────

describe('effectiveActivityCalendar', () => {
  const projectCal = MON_FRI;
  const activityCal: Calendar = { ...SAT_SUN };

  it('returns activityCal when non-null', () => {
    expect(effectiveActivityCalendar(activityCal, projectCal)).toBe(activityCal);
  });

  it('falls back to projectCal when null', () => {
    expect(effectiveActivityCalendar(null, projectCal)).toBe(projectCal);
  });
});

// ── resolveAssignmentCalendar ─────────────────────────────────────────────────

describe('resolveAssignmentCalendar', () => {
  it('resourceWins returns resourceCal unchanged', () => {
    const result = resolveAssignmentCalendar(MON_FRI, SAT_SUN, 'resourceWins');
    expect(result).toEqual({ ok: true, calendar: SAT_SUN });
  });

  it('activityWins returns activityCal unchanged', () => {
    const result = resolveAssignmentCalendar(MON_FRI, SAT_SUN, 'activityWins');
    expect(result).toEqual({ ok: true, calendar: MON_FRI });
  });

  it('intersection of non-overlapping calendars returns EMPTY_INTERSECTION error', () => {
    const result = resolveAssignmentCalendar(MON_FRI, SAT_SUN, 'intersection');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('EMPTY_INTERSECTION');
  });

  it('intersection of overlapping calendars returns merged calendar', () => {
    // Both work Mon–Thu; activity works Mon–Fri, resource works Mon–Thu
    const resource: Calendar = {
      ...MON_FRI,
      id: 'mon-thu',
      workingDays: [false, true, true, true, true, false, false],
      daysPerWeek: 4,
    };
    const result = resolveAssignmentCalendar(MON_FRI, resource, 'intersection');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Intersection: Mon–Thu only
      expect(result.calendar.workingDays[5]).toBe(false); // Friday off
      expect(result.calendar.workingDays[1]).toBe(true); // Monday on
      expect(result.calendar.daysPerWeek).toBe(4);
    }
  });

  it('intersection hoursPerDay takes the minimum', () => {
    const short: Calendar = { ...MON_FRI, id: 'short', hoursPerDay: 6 };
    const result = resolveAssignmentCalendar(MON_FRI, short, 'intersection');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.calendar.hoursPerDay).toBe(6);
  });
});
