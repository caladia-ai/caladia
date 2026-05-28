import { describe, it, expect } from 'vitest';
import type { Calendar } from '@procsim/file-format';
import { toHours } from './utils.js';

// Two calendars with deliberately different hours/day and days/week so the
// effort vs. time semantic split is observable. The numeric values match
// the kind of variance the Phase 39 intense-schedule templates introduce.
const STANDARD: Calendar = {
  id: 'std',
  name: 'Mon–Fri 8h',
  workingDays: [false, true, true, true, true, true, false],
  hoursPerDay: 8,
  daysPerWeek: 5,
  holidayPreset: 'NONE',
  holidayPresetVersion: '1.0',
  exceptions: [],
};

// 996: Mon–Sat, 12h/day. 72 hours per working week.
const INTENSE: Calendar = {
  id: 'intense',
  name: '996',
  workingDays: [false, true, true, true, true, true, true],
  hoursPerDay: 12,
  daysPerWeek: 6,
  holidayPreset: 'NONE',
  holidayPresetVersion: '1.0',
  exceptions: [],
};

describe('toHours', () => {
  describe('time semantic (legacy default)', () => {
    it('hours unit is identity regardless of calendar', () => {
      expect(toHours({ value: 5, unit: 'hours' }, STANDARD, 'time')).toBe(5);
      expect(toHours({ value: 5, unit: 'hours' }, INTENSE, 'time')).toBe(5);
    });

    it('days unit multiplies by calendar.hoursPerDay (calendar-dependent)', () => {
      expect(toHours({ value: 5, unit: 'days' }, STANDARD, 'time')).toBe(40);
      // Same "5 days" produces 60 hours under 996 — the inflation behaviour
      // that motivated Phase 40.
      expect(toHours({ value: 5, unit: 'days' }, INTENSE, 'time')).toBe(60);
    });

    it('weeks unit multiplies by hoursPerDay × daysPerWeek', () => {
      expect(toHours({ value: 2, unit: 'weeks' }, STANDARD, 'time')).toBe(80);
      expect(toHours({ value: 2, unit: 'weeks' }, INTENSE, 'time')).toBe(144);
    });

    it('defaults to time semantic when omitted (legacy call sites)', () => {
      expect(toHours({ value: 5, unit: 'days' }, STANDARD)).toBe(
        toHours({ value: 5, unit: 'days' }, STANDARD, 'time'),
      );
      expect(toHours({ value: 5, unit: 'days' }, INTENSE)).toBe(
        toHours({ value: 5, unit: 'days' }, INTENSE, 'time'),
      );
    });
  });

  describe('effort semantic (Phase 40)', () => {
    it('hours unit is identity (same as time semantic)', () => {
      expect(toHours({ value: 5, unit: 'hours' }, STANDARD, 'effort')).toBe(5);
      expect(toHours({ value: 5, unit: 'hours' }, INTENSE, 'effort')).toBe(5);
    });

    it('days unit uses the canonical 8h/day constant — calendar-independent', () => {
      // 5 effort-days = 40 hours, regardless of which calendar is active.
      // This is the load-bearing property the phase introduces.
      expect(toHours({ value: 5, unit: 'days' }, STANDARD, 'effort')).toBe(40);
      expect(toHours({ value: 5, unit: 'days' }, INTENSE, 'effort')).toBe(40);
    });

    it('weeks unit uses canonical 40h/week — calendar-independent', () => {
      expect(toHours({ value: 2, unit: 'weeks' }, STANDARD, 'effort')).toBe(80);
      expect(toHours({ value: 2, unit: 'weeks' }, INTENSE, 'effort')).toBe(80);
    });

    it('zero-duration is zero under both semantics, every unit', () => {
      for (const unit of ['hours', 'days', 'weeks'] as const) {
        expect(toHours({ value: 0, unit }, STANDARD, 'effort')).toBe(0);
        expect(toHours({ value: 0, unit }, STANDARD, 'time')).toBe(0);
        expect(toHours({ value: 0, unit }, INTENSE, 'effort')).toBe(0);
        expect(toHours({ value: 0, unit }, INTENSE, 'time')).toBe(0);
      }
    });
  });
});

// ── Phase 42 — share-aware per-pool baseHours ────────────────────────────────

import type { ResourceAssignment } from '@procsim/file-format';
import { assignmentShareTotal, perPoolBaseHours } from './utils.js';

function asgn(resourceId: string, count = 1, share?: number): ResourceAssignment {
  return {
    resourceId,
    count,
    calendarPolicy: 'intersection',
    ...(share !== undefined ? { share } : {}),
  };
}

describe('assignmentShareTotal + perPoolBaseHours', () => {
  it('returns 0 total when no assignment has a share — legacy mode signal', () => {
    const total = assignmentShareTotal([asgn('r1'), asgn('r2')]);
    expect(total).toBe(0);
  });

  it('sums set shares ignoring the absent / legacy invariant — schema guarantees all-or-none', () => {
    const total = assignmentShareTotal([asgn('r1', 1, 30), asgn('r2', 1, 70)]);
    expect(total).toBe(100);
  });

  it('perPoolBaseHours returns the full baseHours when shareTotal is 0 (legacy mode)', () => {
    const a = asgn('r1');
    expect(perPoolBaseHours(40, a, 0)).toBe(40);
  });

  it('perPoolBaseHours splits baseHours by share / shareTotal', () => {
    // 40h activity, 30/70 split → 12h / 28h.
    const a1 = asgn('r1', 1, 30);
    const a2 = asgn('r2', 1, 70);
    expect(perPoolBaseHours(40, a1, 100)).toBeCloseTo(12, 10);
    expect(perPoolBaseHours(40, a2, 100)).toBeCloseTo(28, 10);
  });

  it('perPoolBaseHours treats share=0 as "presence-only" (zero labour to this pool)', () => {
    const a = asgn('r1', 1, 0);
    expect(perPoolBaseHours(40, a, 100)).toBe(0);
  });

  it('weight-mode shares normalise to the same fractions as percentage shares', () => {
    // [3, 7] weights and [30, 70] percentages produce the same per-pool
    // hours after normalisation — the engine is mode-agnostic.
    const aw1 = asgn('r1', 1, 3);
    const aw2 = asgn('r2', 1, 7);
    const ap1 = asgn('r1', 1, 30);
    const ap2 = asgn('r2', 1, 70);
    expect(perPoolBaseHours(40, aw1, 10)).toBeCloseTo(perPoolBaseHours(40, ap1, 100), 10);
    expect(perPoolBaseHours(40, aw2, 10)).toBeCloseTo(perPoolBaseHours(40, ap2, 100), 10);
  });
});
