import type { HolidayPresetId } from './schema.js';

export interface HolidayEntry {
  date: string; // YYYY-MM-DD
  name: string;
}

export interface HolidayPreset {
  id: HolidayPresetId;
  version: string;
  holidays: HolidayEntry[];
}

// ── Date math helpers ─────────────────────────────────────────────────────────

function fmt(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Shift a weekend date to Friday (Sat) or Monday (Sun) for observed holidays. */
function observed(d: Date): Date {
  const dow = d.getDay();
  if (dow === 6) return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  if (dow === 0) return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return d;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/**
 * Nth weekday in a month (1-indexed). n=-1 = last occurrence.
 * weekday: 0=Sun, 1=Mon, …, 6=Sat
 */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  if (n > 0) {
    const first = new Date(year, month - 1, 1);
    const delta = (weekday - first.getDay() + 7) % 7;
    return new Date(year, month - 1, 1 + delta + (n - 1) * 7);
  }
  // n === -1: last occurrence
  const last = new Date(year, month, 0);
  const delta = (last.getDay() - weekday + 7) % 7;
  return new Date(year, month - 1, last.getDate() - delta);
}

/** Anonymous Gregorian Easter algorithm. */
function easter(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

/** Last Monday on or before May 24 (Victoria Day). */
function victoriaDay(year: number): Date {
  const may24 = new Date(year, 4, 24);
  const dow = may24.getDay();
  const daysBack = dow === 1 ? 0 : dow === 0 ? 6 : dow - 1;
  return new Date(year, 4, 24 - daysBack);
}

// ── Per-year holiday generators ───────────────────────────────────────────────

function usFederalYear(year: number): HolidayEntry[] {
  return [
    { date: fmt(observed(new Date(year, 0, 1))), name: "New Year's Day" },
    { date: fmt(nthWeekday(year, 1, 1, 3)), name: 'Martin Luther King Jr. Day' },
    { date: fmt(nthWeekday(year, 2, 1, 3)), name: "Presidents' Day" },
    { date: fmt(nthWeekday(year, 5, 1, -1)), name: 'Memorial Day' },
    { date: fmt(observed(new Date(year, 5, 19))), name: 'Juneteenth National Independence Day' },
    { date: fmt(observed(new Date(year, 6, 4))), name: 'Independence Day' },
    { date: fmt(nthWeekday(year, 9, 1, 1)), name: 'Labor Day' },
    { date: fmt(nthWeekday(year, 10, 1, 2)), name: 'Columbus Day' },
    { date: fmt(observed(new Date(year, 10, 11))), name: 'Veterans Day' },
    { date: fmt(nthWeekday(year, 11, 4, 4)), name: 'Thanksgiving Day' },
    { date: fmt(observed(new Date(year, 11, 25))), name: 'Christmas Day' },
  ].sort((a, b) => a.date.localeCompare(b.date));
}

function canadaFederalYear(year: number): HolidayEntry[] {
  const easterSunday = easter(year);
  const goodFriday = addDays(easterSunday, -2);
  const easterMonday = addDays(easterSunday, 1);
  // Canada Day: Jul 1, with weekend substitution
  const canadaDay = observed(new Date(year, 6, 1));
  return [
    { date: fmt(observed(new Date(year, 0, 1))), name: "New Year's Day" },
    { date: fmt(goodFriday), name: 'Good Friday' },
    { date: fmt(easterMonday), name: 'Easter Monday' },
    { date: fmt(victoriaDay(year)), name: 'Victoria Day' },
    { date: fmt(canadaDay), name: 'Canada Day' },
    { date: fmt(nthWeekday(year, 9, 1, 1)), name: 'Labour Day' },
    { date: fmt(new Date(year, 8, 30)), name: 'National Day for Truth and Reconciliation' },
    { date: fmt(nthWeekday(year, 10, 1, 2)), name: 'Thanksgiving' },
    { date: fmt(observed(new Date(year, 10, 11))), name: 'Remembrance Day' },
    { date: fmt(observed(new Date(year, 11, 25))), name: 'Christmas Day' },
    { date: fmt(observed(new Date(year, 11, 26))), name: 'Boxing Day' },
  ].sort((a, b) => a.date.localeCompare(b.date));
}

function euCommonYear(year: number): HolidayEntry[] {
  const easterSunday = easter(year);
  const goodFriday = addDays(easterSunday, -2);
  const easterMonday = addDays(easterSunday, 1);
  return [
    { date: fmt(new Date(year, 0, 1)), name: "New Year's Day" },
    { date: fmt(goodFriday), name: 'Good Friday' },
    { date: fmt(easterMonday), name: 'Easter Monday' },
    { date: fmt(new Date(year, 4, 1)), name: 'Labour Day' },
    { date: fmt(new Date(year, 11, 25)), name: 'Christmas Day' },
    { date: fmt(new Date(year, 11, 26)), name: 'Boxing Day' },
  ].sort((a, b) => a.date.localeCompare(b.date));
}

function brazilFederalYear(year: number): HolidayEntry[] {
  // Carnival Monday + Tuesday are Easter − 48 / − 47 (the two weekdays
  // immediately before Ash Wednesday, which is Easter − 46). Corpus Christi
  // is Easter + 60. Good Friday is Easter − 2. Black Awareness Day (Nov 20)
  // became a federal holiday in 2024; included across the full range for
  // consistency with the US Juneteenth pattern.
  const easterSunday = easter(year);
  return [
    { date: fmt(new Date(year, 0, 1)), name: 'Confraternização Universal' },
    { date: fmt(addDays(easterSunday, -48)), name: 'Carnaval (Segunda-feira)' },
    { date: fmt(addDays(easterSunday, -47)), name: 'Carnaval (Terça-feira)' },
    { date: fmt(addDays(easterSunday, -2)), name: 'Sexta-feira Santa' },
    { date: fmt(new Date(year, 3, 21)), name: 'Tiradentes' },
    { date: fmt(new Date(year, 4, 1)), name: 'Dia do Trabalho' },
    { date: fmt(addDays(easterSunday, 60)), name: 'Corpus Christi' },
    { date: fmt(new Date(year, 8, 7)), name: 'Independência do Brasil' },
    { date: fmt(new Date(year, 9, 12)), name: 'Nossa Senhora Aparecida' },
    { date: fmt(new Date(year, 10, 2)), name: 'Finados' },
    { date: fmt(new Date(year, 10, 15)), name: 'Proclamação da República' },
    { date: fmt(new Date(year, 10, 20)), name: 'Consciência Negra' },
    { date: fmt(new Date(year, 11, 25)), name: 'Natal' },
  ].sort((a, b) => a.date.localeCompare(b.date));
}

function mexicoFederalYear(year: number): HolidayEntry[] {
  // The 2006 Federal Labour Law reform moved Constitution Day, Juárez's
  // Birthday, and Revolution Day to the closest Monday — encoded here
  // directly. The sextennial presidential-inauguration holiday (Dec 1
  // every 6 years) is intentionally omitted.
  return [
    { date: fmt(new Date(year, 0, 1)), name: 'Año Nuevo' },
    { date: fmt(nthWeekday(year, 2, 1, 1)), name: 'Día de la Constitución' },
    { date: fmt(nthWeekday(year, 3, 1, 3)), name: 'Natalicio de Benito Juárez' },
    { date: fmt(new Date(year, 4, 1)), name: 'Día del Trabajo' },
    { date: fmt(new Date(year, 8, 16)), name: 'Día de la Independencia' },
    { date: fmt(nthWeekday(year, 11, 1, 3)), name: 'Día de la Revolución' },
    { date: fmt(new Date(year, 11, 25)), name: 'Navidad' },
  ].sort((a, b) => a.date.localeCompare(b.date));
}

// Japan vernal/autumnal equinoxes are officially announced each February by
// Japan's National Astronomical Observatory for the *following* year. The
// dates 2020–2035 are derived from the same astronomical calculation and
// published in advance for planning purposes — they shift between the 20th
// and 21st (vernal) / 22nd and 23rd (autumnal) depending on the exact
// UTC+9 moment of the equinox.
const JAPAN_VERNAL_EQUINOX_DAY: Record<number, number> = {
  2020: 20,
  2021: 20,
  2022: 21,
  2023: 21,
  2024: 20,
  2025: 20,
  2026: 20,
  2027: 21,
  2028: 20,
  2029: 20,
  2030: 20,
  2031: 21,
  2032: 20,
  2033: 20,
  2034: 20,
  2035: 21,
};
const JAPAN_AUTUMNAL_EQUINOX_DAY: Record<number, number> = {
  2020: 22,
  2021: 23,
  2022: 23,
  2023: 23,
  2024: 22,
  2025: 23,
  2026: 23,
  2027: 23,
  2028: 22,
  2029: 23,
  2030: 23,
  2031: 23,
  2032: 22,
  2033: 23,
  2034: 23,
  2035: 23,
};

function japanNationalYear(year: number): HolidayEntry[] {
  // Skips substitute-Monday and bridging-day logic — the calendar engine
  // treats holidays additively against `workingDays`, so missing a few
  // observance edge cases under-counts holidays by at most a day or two
  // a year. The 2020/2021 Olympic shifts of Marine, Mountain, and Sports
  // Days are intentionally NOT modelled (those years are historical at
  // this point; the standard rule is used for consistency with 2022+).
  const vernal = JAPAN_VERNAL_EQUINOX_DAY[year] ?? 20;
  const autumnal = JAPAN_AUTUMNAL_EQUINOX_DAY[year] ?? 23;
  return [
    { date: fmt(new Date(year, 0, 1)), name: "New Year's Day" },
    { date: fmt(nthWeekday(year, 1, 1, 2)), name: 'Coming of Age Day' },
    { date: fmt(new Date(year, 1, 11)), name: 'National Foundation Day' },
    { date: fmt(new Date(year, 1, 23)), name: "Emperor's Birthday" },
    { date: fmt(new Date(year, 2, vernal)), name: 'Vernal Equinox Day' },
    { date: fmt(new Date(year, 3, 29)), name: 'Shōwa Day' },
    { date: fmt(new Date(year, 4, 3)), name: 'Constitution Memorial Day' },
    { date: fmt(new Date(year, 4, 4)), name: 'Greenery Day' },
    { date: fmt(new Date(year, 4, 5)), name: "Children's Day" },
    { date: fmt(nthWeekday(year, 7, 1, 3)), name: 'Marine Day' },
    { date: fmt(new Date(year, 7, 11)), name: 'Mountain Day' },
    { date: fmt(nthWeekday(year, 9, 1, 3)), name: 'Respect for the Aged Day' },
    { date: fmt(new Date(year, 8, autumnal)), name: 'Autumnal Equinox Day' },
    { date: fmt(nthWeekday(year, 10, 1, 2)), name: 'Sports Day' },
    { date: fmt(new Date(year, 10, 3)), name: 'Culture Day' },
    { date: fmt(new Date(year, 10, 23)), name: 'Labour Thanksgiving Day' },
  ].sort((a, b) => a.date.localeCompare(b.date));
}

function australiaNationalYear(year: number): HolidayEntry[] {
  // National-only set — state-specific days (Labour Day variants, Queen's
  // Birthday in WA/QLD, Easter Saturday/Sunday in some states) are excluded
  // because they vary by jurisdiction. Weekend-substitution rules also vary
  // by state; keeping canonical dates avoids encoding the wrong shift.
  const easterSunday = easter(year);
  return [
    { date: fmt(new Date(year, 0, 1)), name: "New Year's Day" },
    { date: fmt(new Date(year, 0, 26)), name: 'Australia Day' },
    { date: fmt(addDays(easterSunday, -2)), name: 'Good Friday' },
    { date: fmt(addDays(easterSunday, 1)), name: 'Easter Monday' },
    { date: fmt(new Date(year, 3, 25)), name: 'Anzac Day' },
    { date: fmt(nthWeekday(year, 6, 1, 2)), name: "King's Birthday" },
    { date: fmt(new Date(year, 11, 25)), name: 'Christmas Day' },
    { date: fmt(new Date(year, 11, 26)), name: 'Boxing Day' },
  ].sort((a, b) => a.date.localeCompare(b.date));
}

// ── Preset registry ───────────────────────────────────────────────────────────

const YEAR_START = 2020;
const YEAR_END = 2035;

function computeRange(gen: (year: number) => HolidayEntry[]): HolidayEntry[] {
  const entries: HolidayEntry[] = [];
  for (let y = YEAR_START; y <= YEAR_END; y++) entries.push(...gen(y));
  return entries.sort((a, b) => a.date.localeCompare(b.date));
}

// Holiday lists are computed once and shared across version labels
// (the algorithmic rules haven't changed between `'2024.1'` and `'2026.1'`).
// Each version-label is a freshness signal for the maintainer — bumping it
// means "I confirmed this data is still correct as of <year>." Older labels
// stay registered so files saved against them continue to load.
const US_FEDERAL_HOLIDAYS = computeRange(usFederalYear);
const CANADA_FEDERAL_HOLIDAYS = computeRange(canadaFederalYear);
const EU_COMMON_HOLIDAYS = computeRange(euCommonYear);
const BRAZIL_FEDERAL_HOLIDAYS = computeRange(brazilFederalYear);
const MEXICO_FEDERAL_HOLIDAYS = computeRange(mexicoFederalYear);
const JAPAN_NATIONAL_HOLIDAYS = computeRange(japanNationalYear);
const AUSTRALIA_NATIONAL_HOLIDAYS = computeRange(australiaNationalYear);

const PRESETS: Record<string, HolidayPreset> = {
  'US_FEDERAL@2024.1': { id: 'US_FEDERAL', version: '2024.1', holidays: US_FEDERAL_HOLIDAYS },
  'US_FEDERAL@2026.1': { id: 'US_FEDERAL', version: '2026.1', holidays: US_FEDERAL_HOLIDAYS },
  'CANADA_FEDERAL@2024.1': {
    id: 'CANADA_FEDERAL',
    version: '2024.1',
    holidays: CANADA_FEDERAL_HOLIDAYS,
  },
  'CANADA_FEDERAL@2026.1': {
    id: 'CANADA_FEDERAL',
    version: '2026.1',
    holidays: CANADA_FEDERAL_HOLIDAYS,
  },
  'EU_COMMON@2024.1': { id: 'EU_COMMON', version: '2024.1', holidays: EU_COMMON_HOLIDAYS },
  'EU_COMMON@2026.1': { id: 'EU_COMMON', version: '2026.1', holidays: EU_COMMON_HOLIDAYS },
  'BRAZIL_FEDERAL@2024.1': {
    id: 'BRAZIL_FEDERAL',
    version: '2024.1',
    holidays: BRAZIL_FEDERAL_HOLIDAYS,
  },
  'BRAZIL_FEDERAL@2026.1': {
    id: 'BRAZIL_FEDERAL',
    version: '2026.1',
    holidays: BRAZIL_FEDERAL_HOLIDAYS,
  },
  'MEXICO_FEDERAL@2024.1': {
    id: 'MEXICO_FEDERAL',
    version: '2024.1',
    holidays: MEXICO_FEDERAL_HOLIDAYS,
  },
  'MEXICO_FEDERAL@2026.1': {
    id: 'MEXICO_FEDERAL',
    version: '2026.1',
    holidays: MEXICO_FEDERAL_HOLIDAYS,
  },
  'JAPAN_NATIONAL@2024.1': {
    id: 'JAPAN_NATIONAL',
    version: '2024.1',
    holidays: JAPAN_NATIONAL_HOLIDAYS,
  },
  'JAPAN_NATIONAL@2026.1': {
    id: 'JAPAN_NATIONAL',
    version: '2026.1',
    holidays: JAPAN_NATIONAL_HOLIDAYS,
  },
  'AUSTRALIA_NATIONAL@2024.1': {
    id: 'AUSTRALIA_NATIONAL',
    version: '2024.1',
    holidays: AUSTRALIA_NATIONAL_HOLIDAYS,
  },
  'AUSTRALIA_NATIONAL@2026.1': {
    id: 'AUSTRALIA_NATIONAL',
    version: '2026.1',
    holidays: AUSTRALIA_NATIONAL_HOLIDAYS,
  },
};

const LATEST_VERSIONS: Record<HolidayPresetId, string> = {
  US_FEDERAL: '2026.1',
  CANADA_FEDERAL: '2026.1',
  EU_COMMON: '2026.1',
  BRAZIL_FEDERAL: '2026.1',
  MEXICO_FEDERAL: '2026.1',
  JAPAN_NATIONAL: '2026.1',
  AUSTRALIA_NATIONAL: '2026.1',
  NONE: '1.0',
};

export function latestPresetVersion(id: HolidayPresetId): string {
  return LATEST_VERSIONS[id];
}

export function getPreset(id: HolidayPresetId, version?: string): HolidayPreset {
  if (id === 'NONE') return { id: 'NONE', version: '1.0', holidays: [] };
  const v = version ?? LATEST_VERSIONS[id];
  const key = `${id}@${v}`;
  const preset = PRESETS[key];
  if (preset === undefined) {
    throw new Error(`Unknown preset version: ${key}`);
  }
  return preset;
}
