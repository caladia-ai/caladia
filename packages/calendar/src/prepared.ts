/**
 * Phase 48 Slice 3 — pre-computed per-calendar working-time tables.
 *
 * The Phase 16 calendar functions (`workingHoursBetween`, `addWorkingHours`,
 * `isDayWorking`, `prevWorkingDayEnd`, `snapToNextWorkStart`) walk day-by-
 * day on every call. The Slice 1 V8 profile showed those calls accounting
 * for ~55–60% of CPU on Oncology @ 1 000 iters — and their inputs (calendar
 * definitions + holiday presets) are invariant across Monte Carlo iterations.
 *
 * This module pre-computes, for a single resolved (possibly intersected)
 * calendar, two tables indexed by day-offset from a chosen base date:
 *
 *   isWorking[d]: is day `d` a working day under this calendar?
 *   workingDayCount[d]: how many working days fall in [0, d) — used as the
 *                       cumulative-working-hours index (cumHours = count × hpd).
 *
 * Plus two reverse-lookup tables:
 *
 *   dayMidnightMs[d]: epoch ms of day `d`'s 00:00 LOCAL time (DST-safe;
 *                     built from the local-time Date constructor)
 *   nthWorkingDay[k]: dayIdx of the k-th working day (0-indexed) — used by
 *                     the addWorkingHours fast path to jump directly to
 *                     the target day without scanning.
 *
 * With these, the four hot calendar ops become O(1) (workingHoursBetween,
 * isDayWorking, snapToNextWorkStart) or O(1) amortized (addWorkingHours
 * via direct array index instead of day-by-day walk).
 *
 * **Semantics are preserved byte-for-byte.** Every `*P` function below
 * must return identical results to its un-prepared counterpart in
 * `./index.ts` for every input that falls within the prepared range. The
 * unit tests in `prepared.test.ts` enforce this against a matrix of dates,
 * including DST boundaries, calendar-day boundaries (8am, 4pm, midnight),
 * and edge cases (hours == 0, zero-day spans, etc).
 *
 * Out-of-range queries (a date before day 0 or after the prepared horizon)
 * throw rather than silently falling back — a fallback would mask a real
 * preparation bug; the throw surfaces it.
 */

import type { Calendar } from '@procsim/file-format';
import { getPreset } from '@procsim/file-format';

// Same constant as ./index.ts — work day starts at 08:00 local time.
const WORK_START_HOUR = 8;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * Pre-computed working-time table for a single calendar.
 *
 * Field naming mirrors the un-prepared API where possible so call-site
 * substitution is mechanical. `source` retains the original `Calendar`
 * for any field that isn't pre-tabled (id, name).
 */
export interface PreparedCalendar {
  /** Original calendar — kept for non-tabled fields (id, name). */
  source: Calendar;
  /** Number of pre-tabled days. Queries outside [0, numDays) throw. */
  numDays: number;
  /** Epoch ms of day 0 at 00:00 local time. */
  baseMs: number;
  /** Working-hours per day (constant — calendars don't vary day-to-day). */
  hoursPerDay: number;
  /** `isWorking[d]` == 1 ⇔ day `d` is a working day. */
  isWorking: Uint8Array;
  /**
   * Running count of working days in `[0, d)`. Length `numDays + 1`.
   * Use `workingDayCount[d] × hoursPerDay` as the cumulative working
   * hours from project start through end-of-day-(d-1).
   */
  workingDayCount: Int32Array;
  /**
   * Reverse map: `nthWorkingDay[k]` is the dayIdx of the k-th working day
   * (0-indexed). Length = total working days in the range. Used by
   * `addWorkingHoursP` to jump directly to the target working day.
   */
  nthWorkingDay: Int32Array;
  /** Epoch ms of day d's 00:00 local time. Length `numDays + 1`. */
  dayMidnightMs: Float64Array;
}

// ── Construction ─────────────────────────────────────────────────────────────

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
    else holidays.delete(exc.date);
  }
  return holidays;
}

function isWorkingDayRaw(
  date: Date,
  cal: Calendar,
  holidays: Set<string>,
  exceptionWorkingDates: Set<string>,
): boolean {
  const dateStr = toDateStr(date);
  if (exceptionWorkingDates.has(dateStr)) return true;
  if (!cal.workingDays[date.getDay()]) return false;
  return !holidays.has(dateStr);
}

/**
 * Build a `PreparedCalendar` covering `[baseYear/baseMonth/baseDay,
 * + numDays)`. The base date defines day 0 at local midnight.
 *
 * `numDays` is the total number of calendar days covered. For a 100-year
 * horizon use `100 × 366` ≈ 36 600 (slight overshoot for leap years; the
 * extra days cost a few bytes each).
 *
 * The base date should typically be the project's startDate (or earlier
 * if Start nodes use `anchorDate` predating it — `prepareScheduleCalendars`
 * in `@procsim/scheduler/prepared.ts` handles that bookkeeping).
 */
export function prepareCalendar(
  cal: Calendar,
  baseY: number,
  baseM: number,
  baseD: number,
  numDays: number,
): PreparedCalendar {
  const baseMs = new Date(baseY, baseM, baseD, 0, 0, 0, 0).getTime();
  const isWorking = new Uint8Array(numDays);
  const workingDayCount = new Int32Array(numDays + 1);
  const dayMidnightMs = new Float64Array(numDays + 1);

  const holidays = resolveHolidaySet(cal);
  const exceptionWorkingDates = new Set<string>();
  for (const exc of cal.exceptions) {
    if (exc.type === 'working') exceptionWorkingDates.add(exc.date);
  }

  // Walk day-by-day with the local-time Date API so DST shifts don't
  // accumulate. Cheap (10-100 ns/day) and only happens once per prepare.
  let workingCount = 0;
  workingDayCount[0] = 0;
  dayMidnightMs[0] = baseMs;
  for (let d = 0; d < numDays; d++) {
    const cur = new Date(baseY, baseM, baseD + d, 0, 0, 0, 0);
    dayMidnightMs[d] = cur.getTime();
    const w = isWorkingDayRaw(cur, cal, holidays, exceptionWorkingDates);
    isWorking[d] = w ? 1 : 0;
    if (w) workingCount++;
    workingDayCount[d + 1] = workingCount;
  }
  // Sentinel: dayMidnightMs[numDays] is the midnight after the last
  // covered day. Used by range checks.
  dayMidnightMs[numDays] = new Date(baseY, baseM, baseD + numDays, 0, 0, 0, 0).getTime();

  const nthWorkingDay = new Int32Array(workingCount);
  let k = 0;
  for (let d = 0; d < numDays; d++) {
    if (isWorking[d]) {
      nthWorkingDay[k++] = d;
    }
  }

  return {
    source: cal,
    numDays,
    baseMs,
    hoursPerDay: cal.hoursPerDay,
    isWorking,
    workingDayCount,
    nthWorkingDay,
    dayMidnightMs,
  };
}

// ── Day-index lookup ─────────────────────────────────────────────────────────

/**
 * Calendar-day offset from `p.baseMs` for a `Date`. DST-safe (uses the
 * local-time Date constructor + Math.round to absorb the ±1h DST shift).
 *
 * Throws when `d` falls outside `[0, p.numDays)`.
 */
function dayOf(p: PreparedCalendar, d: Date): number {
  const dayMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
  const idx = Math.round((dayMs - p.baseMs) / MS_PER_DAY);
  if (idx < 0 || idx >= p.numDays) {
    throw new Error(
      `PreparedCalendar: date ${d.toISOString()} (day ${idx}) is outside prepared range [0, ${p.numDays})`,
    );
  }
  return idx;
}

// ── Public fast-path API ─────────────────────────────────────────────────────

/**
 * Is `t` inside a working window? Mirrors `isWorkingMoment` in `./index.ts`.
 */
export function isWorkingMomentP(p: PreparedCalendar, t: Date): boolean {
  const d = dayOf(p, t);
  if (!p.isWorking[d]) return false;
  const hour =
    t.getHours() + t.getMinutes() / 60 + t.getSeconds() / 3600 + t.getMilliseconds() / MS_PER_HOUR;
  return hour >= WORK_START_HOUR && hour < WORK_START_HOUR + p.hoursPerDay;
}

/**
 * Snap `t` forward to the first working moment ≥ `t`. Mirrors
 * `snapToNextWorkStart` / `snapForward` in `./index.ts`.
 */
export function snapToNextWorkStartP(p: PreparedCalendar, t: Date): Date {
  const dIdx = dayOf(p, t);
  const hour =
    t.getHours() + t.getMinutes() / 60 + t.getSeconds() / 3600 + t.getMilliseconds() / MS_PER_HOUR;

  // Current day is working AND moment is within [8am, 8am + hoursPerDay) →
  // already at a working moment.
  if (p.isWorking[dIdx]) {
    if (hour >= WORK_START_HOUR && hour < WORK_START_HOUR + p.hoursPerDay) {
      return new Date(t.getTime());
    }
    if (hour < WORK_START_HOUR) {
      // Same day, before working hours → 8am same day
      return new Date(p.dayMidnightMs[dIdx]! + WORK_START_HOUR * MS_PER_HOUR);
    }
    // hour ≥ 8 + hoursPerDay → advance to next working day's 8am
  }
  // Advance to next working day's 8am.
  // workingDayCount[dIdx+1] is the rank of the FIRST working day strictly
  // after dIdx-as-non-working OR after dIdx-if-working.
  const nextRank = p.workingDayCount[dIdx + 1]!;
  if (nextRank >= p.nthWorkingDay.length) {
    throw new Error(
      `PreparedCalendar: no working day at or after ${t.toISOString()} within prepared range`,
    );
  }
  const nextDayIdx = p.nthWorkingDay[nextRank]!;
  return new Date(p.dayMidnightMs[nextDayIdx]! + WORK_START_HOUR * MS_PER_HOUR);
}

/**
 * Return the end of the most recent working period at or before `t`.
 * Mirrors `snapBackward` semantics in `./index.ts`.
 */
function snapBackwardP(p: PreparedCalendar, t: Date): Date {
  const dIdx = dayOf(p, t);
  const hour =
    t.getHours() + t.getMinutes() / 60 + t.getSeconds() / 3600 + t.getMilliseconds() / MS_PER_HOUR;

  if (p.isWorking[dIdx]) {
    const dayEnd = WORK_START_HOUR + p.hoursPerDay;
    if (hour > dayEnd) {
      return new Date(p.dayMidnightMs[dIdx]! + dayEnd * MS_PER_HOUR);
    }
    if (hour >= WORK_START_HOUR) return new Date(t.getTime());
    // Before working hours — fall through to previous working day
  }
  // Previous working day's end.
  const prevRank = p.workingDayCount[dIdx]! - 1;
  if (prevRank < 0) {
    throw new Error(
      `PreparedCalendar: no working day at or before ${t.toISOString()} within prepared range`,
    );
  }
  const prevDayIdx = p.nthWorkingDay[prevRank]!;
  return new Date(p.dayMidnightMs[prevDayIdx]! + (WORK_START_HOUR + p.hoursPerDay) * MS_PER_HOUR);
}

/**
 * Add `hours` of working time to `start`, skipping non-working periods.
 * Mirrors `addWorkingHours` in `./index.ts`.
 */
export function addWorkingHoursP(p: PreparedCalendar, start: Date, hours: number): Date {
  if (hours === 0) return new Date(start.getTime());

  if (hours > 0) {
    const snapped = snapToNextWorkStartP(p, start);
    const dStart = dayOf(p, snapped);
    const hoursIntoDay =
      (snapped.getTime() - p.dayMidnightMs[dStart]! - WORK_START_HOUR * MS_PER_HOUR) / MS_PER_HOUR;
    const hoursLeftInStart = p.hoursPerDay - hoursIntoDay;

    if (hours <= hoursLeftInStart) {
      // Stays within the current working day.
      return new Date(snapped.getTime() + hours * MS_PER_HOUR);
    }

    const remaining = hours - hoursLeftInStart;
    // Index of `dStart` within the working-day sequence.
    const kStart = p.workingDayCount[dStart]!;
    const fullDaysAdded = Math.floor(remaining / p.hoursPerDay);
    const fractionalHours = remaining - fullDaysAdded * p.hoursPerDay;

    // Boundary case: exactly fits in `fullDaysAdded` working days. Match
    // the un-prepared `addWorkingHours`'s behaviour by reporting the end-
    // of-day moment, not the next day's start.
    //
    // The small-epsilon guard absorbs float-precision noise from
    // `hoursIntoDay` subtraction without admitting a real fractional
    // remainder (the smallest meaningful fractional hour from upstream
    // distributions is 1/3600 ≈ 0.000278 — well above 1e-9).
    if (fractionalHours <= 1e-9) {
      const targetRank = kStart + fullDaysAdded;
      const targetDayIdx = p.nthWorkingDay[targetRank]!;
      return new Date(
        p.dayMidnightMs[targetDayIdx]! + (WORK_START_HOUR + p.hoursPerDay) * MS_PER_HOUR,
      );
    }

    const targetRank = kStart + 1 + fullDaysAdded;
    if (targetRank >= p.nthWorkingDay.length) {
      throw new Error(
        `PreparedCalendar.addWorkingHoursP: target ${hours}h from ${start.toISOString()} exceeds prepared range`,
      );
    }
    const targetDayIdx = p.nthWorkingDay[targetRank]!;
    return new Date(
      p.dayMidnightMs[targetDayIdx]! + (WORK_START_HOUR + fractionalHours) * MS_PER_HOUR,
    );
  }

  // Backward direction — hours < 0
  const absHours = -hours;
  const snapped = snapBackwardP(p, start);
  const dStart = dayOf(p, snapped);
  const dayEndHour = WORK_START_HOUR + p.hoursPerDay;
  const hoursFromDayStart =
    (snapped.getTime() - p.dayMidnightMs[dStart]! - WORK_START_HOUR * MS_PER_HOUR) / MS_PER_HOUR;
  // Hours elapsed from start-of-working-day to `snapped`.
  const elapsedInStart = hoursFromDayStart;

  if (absHours <= elapsedInStart) {
    return new Date(snapped.getTime() - absHours * MS_PER_HOUR);
  }

  const remaining = absHours - elapsedInStart;
  const kStart = p.workingDayCount[dStart]!; // 0-indexed rank of dStart
  const fullDaysAdded = Math.floor(remaining / p.hoursPerDay);
  const fractionalHours = remaining - fullDaysAdded * p.hoursPerDay;

  if (fractionalHours <= 1e-9) {
    // End up at the START of the (kStart - fullDaysAdded)-th working day.
    const targetRank = kStart - fullDaysAdded;
    if (targetRank < 0) {
      throw new Error(
        `PreparedCalendar.addWorkingHoursP: target ${hours}h from ${start.toISOString()} exceeds prepared range (backward)`,
      );
    }
    const targetDayIdx = p.nthWorkingDay[targetRank]!;
    return new Date(p.dayMidnightMs[targetDayIdx]! + WORK_START_HOUR * MS_PER_HOUR);
  }

  const targetRank = kStart - 1 - fullDaysAdded;
  if (targetRank < 0) {
    throw new Error(
      `PreparedCalendar.addWorkingHoursP: target ${hours}h from ${start.toISOString()} exceeds prepared range (backward)`,
    );
  }
  const targetDayIdx = p.nthWorkingDay[targetRank]!;
  return new Date(p.dayMidnightMs[targetDayIdx]! + (dayEndHour - fractionalHours) * MS_PER_HOUR);
}

/**
 * Count working hours between `start` and `end`. Negative when `end < start`.
 * Mirrors `workingHoursBetween` in `./index.ts`.
 */
export function workingHoursBetweenP(p: PreparedCalendar, start: Date, end: Date): number {
  if (start.getTime() === end.getTime()) return 0;
  if (start > end) return -workingHoursBetweenP(p, end, start);

  const dStart = dayOf(p, start);
  const dEnd = dayOf(p, end);

  // Same calendar day
  if (dStart === dEnd) {
    if (!p.isWorking[dStart]) return 0;
    const ws = p.dayMidnightMs[dStart]! + WORK_START_HOUR * MS_PER_HOUR;
    const we = p.dayMidnightMs[dStart]! + (WORK_START_HOUR + p.hoursPerDay) * MS_PER_HOUR;
    const ols = Math.max(start.getTime(), ws);
    const ole = Math.min(end.getTime(), we);
    return ols < ole ? (ole - ols) / MS_PER_HOUR : 0;
  }

  let total = 0;

  // Partial start day.
  if (p.isWorking[dStart]) {
    const ws = p.dayMidnightMs[dStart]! + WORK_START_HOUR * MS_PER_HOUR;
    const we = p.dayMidnightMs[dStart]! + (WORK_START_HOUR + p.hoursPerDay) * MS_PER_HOUR;
    const ols = Math.max(start.getTime(), ws);
    const ole = we;
    if (ols < ole) total += (ole - ols) / MS_PER_HOUR;
  }

  // Full middle days — cumulativeHours[d] = workingDayCount[d] × hoursPerDay.
  if (dEnd > dStart + 1) {
    const middleWorkingDays = p.workingDayCount[dEnd]! - p.workingDayCount[dStart + 1]!;
    total += middleWorkingDays * p.hoursPerDay;
  }

  // Partial end day.
  if (p.isWorking[dEnd]) {
    const ws = p.dayMidnightMs[dEnd]! + WORK_START_HOUR * MS_PER_HOUR;
    const we = p.dayMidnightMs[dEnd]! + (WORK_START_HOUR + p.hoursPerDay) * MS_PER_HOUR;
    const ols = ws;
    const ole = Math.min(end.getTime(), we);
    if (ols < ole) total += (ole - ols) / MS_PER_HOUR;
  }

  return total;
}
