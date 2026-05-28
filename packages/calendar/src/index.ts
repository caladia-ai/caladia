import type { Calendar, CalendarPolicy } from '@procsim/file-format';
import { getPreset } from '@procsim/file-format';

export type { CalendarPolicy } from '@procsim/file-format';

// Phase 48 Slice 3 — pre-computed per-calendar working-time tables.
export {
  prepareCalendar,
  isWorkingMomentP,
  snapToNextWorkStartP,
  addWorkingHoursP,
  workingHoursBetweenP,
} from './prepared.js';
export type { PreparedCalendar } from './prepared.js';

// Working day runs 08:00–(08:00+hoursPerDay) local time.
const WORK_START_HOUR = 8;
const MS_PER_HOUR = 3_600_000;

export type AssignmentCalendarResult =
  | { ok: true; calendar: Calendar }
  | { ok: false; error: 'EMPTY_INTERSECTION'; activityCal: Calendar; resourceCal: Calendar };

// ── Internal helpers ──────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function resolveHolidaySet(cal: Calendar): Set<string> {
  const preset = getPreset(cal.holidayPreset, cal.holidayPresetVersion);
  const holidays = new Set(preset.holidays.map((h) => h.date));
  for (const exc of cal.exceptions) {
    if (exc.type === 'holiday') holidays.add(exc.date);
    else holidays.delete(exc.date); // 'working' exception overrides a holiday
  }
  return holidays;
}

/**
 * Phase 33 Slice 2 follow-up — public, name-aware version of
 * `resolveHolidaySet`. Returns a Map keyed by `YYYY-MM-DD` whose value
 * is the holiday's display name (preset name OR exception name).
 *
 * Exceptions of `type === 'working'` are stripped from the result — they
 * legitimately override a holiday. Used by the Gantt to distinguish
 * holidays from weekends visually and to surface the holiday name on
 * hover.
 */
export function resolveHolidays(cal: Calendar): Map<string, string> {
  const preset = getPreset(cal.holidayPreset, cal.holidayPresetVersion);
  const out = new Map<string, string>();
  for (const h of preset.holidays) out.set(h.date, h.name);
  for (const exc of cal.exceptions) {
    if (exc.type === 'holiday') out.set(exc.date, exc.name);
    else out.delete(exc.date);
  }
  return out;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function startOfNextDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
}

function workingDayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), WORK_START_HOUR, 0, 0, 0);
}

function getHour(d: Date): number {
  return (
    d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600 + d.getMilliseconds() / 3_600_000
  );
}

function isDayWorking(d: Date, cal: Calendar, holidays: Set<string>): boolean {
  const dateStr = toDateStr(d);
  // A 'working' exception overrides the weekly pattern (e.g. a Saturday made into a work day).
  for (const exc of cal.exceptions) {
    if (exc.date === dateStr && exc.type === 'working') return true;
  }
  const dow = d.getDay(); // 0=Sun … 6=Sat, matches workingDays index
  if (!cal.workingDays[dow]) return false;
  return !holidays.has(dateStr);
}

// Advance d to the nearest working moment (inclusive — returns d if already there).
function snapForward(d: Date, cal: Calendar, holidays: Set<string>): Date {
  let current = d;
  for (let i = 0; i < 10_000; i++) {
    const day = startOfDay(current);
    if (!isDayWorking(day, cal, holidays)) {
      current = workingDayStart(startOfNextDay(current));
      continue;
    }
    const hour = getHour(current);
    if (hour < WORK_START_HOUR) return workingDayStart(current);
    if (hour >= WORK_START_HOUR + cal.hoursPerDay) {
      current = workingDayStart(startOfNextDay(current));
      continue;
    }
    return current;
  }
  throw new Error('snapForward: no working day found within search limit');
}

// Return the end of the most recent working period at or before d.
function snapBackward(d: Date, cal: Calendar, holidays: Set<string>): Date {
  const day = startOfDay(d);
  if (isDayWorking(day, cal, holidays)) {
    const hour = getHour(d);
    if (hour > WORK_START_HOUR + cal.hoursPerDay) {
      return new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        WORK_START_HOUR + cal.hoursPerDay,
        0,
        0,
        0,
      );
    }
    if (hour >= WORK_START_HOUR) return d; // within working hours (end boundary inclusive)
    // Before start of day — fall through to previous working day
  }
  let prev = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  for (let i = 0; i < 10_000; i++) {
    if (isDayWorking(startOfDay(prev), cal, holidays)) {
      return new Date(
        prev.getFullYear(),
        prev.getMonth(),
        prev.getDate(),
        WORK_START_HOUR + cal.hoursPerDay,
        0,
        0,
        0,
      );
    }
    prev = new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() - 1);
  }
  throw new Error('snapBackward: no working day found within search limit');
}

function hoursRemainingInDay(d: Date, cal: Calendar): number {
  const hour = getHour(d);
  if (hour >= WORK_START_HOUR + cal.hoursPerDay) return 0;
  if (hour < WORK_START_HOUR) return cal.hoursPerDay;
  return WORK_START_HOUR + cal.hoursPerDay - hour;
}

function hoursElapsedInDay(d: Date, cal: Calendar): number {
  const hour = getHour(d);
  if (hour <= WORK_START_HOUR) return 0;
  if (hour >= WORK_START_HOUR + cal.hoursPerDay) return cal.hoursPerDay;
  return hour - WORK_START_HOUR;
}

function prevWorkingDayEnd(d: Date, cal: Calendar, holidays: Set<string>): Date {
  let prev = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  for (let i = 0; i < 10_000; i++) {
    if (isDayWorking(startOfDay(prev), cal, holidays)) {
      return new Date(
        prev.getFullYear(),
        prev.getMonth(),
        prev.getDate(),
        WORK_START_HOUR + cal.hoursPerDay,
        0,
        0,
        0,
      );
    }
    prev = new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() - 1);
  }
  throw new Error('prevWorkingDayEnd: no working day found within search limit');
}

// ── Public API ────────────────────────────────────────────────────────────────

export function isWorkingMoment(t: Date, cal: Calendar): boolean {
  const holidays = resolveHolidaySet(cal);
  if (!isDayWorking(startOfDay(t), cal, holidays)) return false;
  const hour = getHour(t);
  return hour >= WORK_START_HOUR && hour < WORK_START_HOUR + cal.hoursPerDay;
}

/**
 * Add `hours` of working time to `start`, skipping non-working periods.
 * Positive advances forward; negative goes backward. Zero returns `start` unchanged.
 */
export function addWorkingHours(start: Date, hours: number, cal: Calendar): Date {
  if (hours === 0) return new Date(start);
  const holidays = resolveHolidaySet(cal);

  if (hours > 0) {
    let current = snapForward(start, cal, holidays);
    let remaining = hours;
    for (let i = 0; i < 1_000_000; i++) {
      const left = hoursRemainingInDay(current, cal);
      if (left <= 0) {
        current = workingDayStart(startOfNextDay(current));
        while (!isDayWorking(startOfDay(current), cal, holidays)) {
          current = workingDayStart(startOfNextDay(current));
        }
        continue;
      }
      if (remaining <= left) {
        return new Date(current.getTime() + remaining * MS_PER_HOUR);
      }
      remaining -= left;
      current = workingDayStart(startOfNextDay(current));
      while (!isDayWorking(startOfDay(current), cal, holidays)) {
        current = workingDayStart(startOfNextDay(current));
      }
    }
    throw new Error('addWorkingHours: exceeded iteration limit (forward)');
  } else {
    const absHours = -hours;
    let current = snapBackward(start, cal, holidays);
    let remaining = absHours;
    for (let i = 0; i < 1_000_000; i++) {
      const elapsed = hoursElapsedInDay(current, cal);
      if (elapsed <= 0) {
        current = prevWorkingDayEnd(current, cal, holidays);
        continue;
      }
      if (remaining <= elapsed) {
        return new Date(current.getTime() - remaining * MS_PER_HOUR);
      }
      remaining -= elapsed;
      current = prevWorkingDayEnd(current, cal, holidays);
    }
    throw new Error('addWorkingHours: exceeded iteration limit (backward)');
  }
}

/**
 * Count working hours between two dates.
 * Returns negative when `end` < `start`.
 */
export function workingHoursBetween(start: Date, end: Date, cal: Calendar): number {
  if (start.getTime() === end.getTime()) return 0;
  if (start > end) return -workingHoursBetween(end, start, cal);

  const holidays = resolveHolidaySet(cal);
  let total = 0;
  let d = startOfDay(start);
  while (d < end) {
    if (isDayWorking(d, cal, holidays)) {
      const ws = new Date(d.getFullYear(), d.getMonth(), d.getDate(), WORK_START_HOUR, 0, 0, 0);
      const we = new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        WORK_START_HOUR + cal.hoursPerDay,
        0,
        0,
        0,
      );
      const ols = start > ws ? start : ws;
      const ole = end < we ? end : we;
      if (ols < ole) total += (ole.getTime() - ols.getTime()) / MS_PER_HOUR;
    }
    d = startOfNextDay(d);
  }
  return total;
}

/**
 * Snap `d` forward to the first working moment at or after `d`.
 * The scheduler uses this to normalise raw constraint dates into actual start times.
 */
export function snapToNextWorkStart(d: Date, cal: Calendar): Date {
  const holidays = resolveHolidaySet(cal);
  return snapForward(d, cal, holidays);
}

export function effectiveActivityCalendar(
  activityCal: Calendar | null,
  projectCal: Calendar,
): Calendar {
  return activityCal ?? projectCal;
}

/**
 * Compute the intersection of two calendars: a day is working only if both
 * agree, hoursPerDay is the smaller of the two, and the holiday set is the
 * union (so any non-working day from either calendar is honoured).
 *
 * Returns `null` when the resulting workingDays bitmap is all-false \u2014 i.e.
 * the two calendars have no overlapping working days. Callers (validation,
 * the scheduler's node-level effective calendar) should turn `null` into a
 * structured error rather than passing it downstream.
 *
 * Phase 18 \u2014 factored out of `resolveAssignmentCalendar` so the scheduler
 * can fold-intersect any number of calendars when an activity has multiple
 * resource assignments. The pairwise behaviour is identical to what
 * `resolveAssignmentCalendar('intersection', \u2026)` produces today.
 */
export function intersectCalendars(a: Calendar, b: Calendar): Calendar | null {
  const workingDays = a.workingDays.map(
    (aw, i) => aw && (b.workingDays[i] ?? false),
  ) as Calendar['workingDays'];

  if (!workingDays.some(Boolean)) return null;

  // Union of both holiday sets so the intersection calendar respects all
  // non-working days from either side.
  const holidaysA = resolveHolidaySet(a);
  const holidaysB = resolveHolidaySet(b);
  const allHolidays = new Set([...holidaysA, ...holidaysB]);
  const exceptions: Calendar['exceptions'] = [...allHolidays].map((date) => ({
    date,
    type: 'holiday' as const,
    name: 'Holiday',
  }));

  return {
    id: `${a.id}\u2229${b.id}`,
    name: `${a.name} \u2229 ${b.name}`,
    workingDays,
    hoursPerDay: Math.min(a.hoursPerDay, b.hoursPerDay),
    daysPerWeek: workingDays.filter(Boolean).length,
    holidayPreset: 'NONE',
    holidayPresetVersion: '1.0',
    exceptions,
  };
}

export function resolveAssignmentCalendar(
  activityCal: Calendar,
  resourceCal: Calendar,
  policy: CalendarPolicy,
): AssignmentCalendarResult {
  if (policy === 'resourceWins') return { ok: true, calendar: resourceCal };
  if (policy === 'activityWins') return { ok: true, calendar: activityCal };

  // intersection
  const intersected = intersectCalendars(activityCal, resourceCal);
  if (!intersected) {
    return { ok: false, error: 'EMPTY_INTERSECTION', activityCal, resourceCal };
  }
  return { ok: true, calendar: intersected };
}
