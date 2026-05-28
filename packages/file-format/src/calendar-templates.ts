import type { Calendar } from './schema.js';

/**
 * Phase 36 Slice 2 — Work-schedule templates.
 *
 * Each template specifies the three fields that define a working pattern:
 * which days of the week count as working, how many hours per working day,
 * and the integer days-per-week summary used for some downstream rollups.
 *
 * Applying a template overwrites only these three fields on the target
 * calendar — `name`, `holidayPreset`, and `exceptions` are intentionally
 * left alone, and the calendar's id is unchanged so any per-node /
 * per-resource bindings continue to resolve.
 */
export type WorkScheduleFields = Pick<Calendar, 'workingDays' | 'hoursPerDay' | 'daysPerWeek'>;

export interface CalendarTemplate extends WorkScheduleFields {
  /** Stable identifier; used by the apply action and tests. Kebab-case. */
  id: string;
  /** Human-readable name shown in the UI dropdown. */
  label: string;
  /** Short rationale shown under the dropdown to help users pick. */
  description: string;
}

// workingDays tuple ordering matches the schema: [Sun, Mon, Tue, Wed, Thu, Fri, Sat].
export const CALENDAR_TEMPLATES: ReadonlyArray<CalendarTemplate> = [
  {
    id: 'mf-8h',
    label: 'Standard M–F 8h',
    workingDays: [false, true, true, true, true, true, false],
    hoursPerDay: 8,
    daysPerWeek: 5,
    description: '40 h/week — US / Canada office baseline.',
  },
  {
    id: 'mf-7-5h',
    label: 'M–F 7.5h',
    workingDays: [false, true, true, true, true, true, false],
    hoursPerDay: 7.5,
    daysPerWeek: 5,
    description: '37.5 h/week — UK and much of Western Europe.',
  },
  {
    id: 'mf-7h',
    label: 'M–F 7h',
    workingDays: [false, true, true, true, true, true, false],
    hoursPerDay: 7,
    daysPerWeek: 5,
    description: '35 h/week — France statutory baseline.',
  },
  {
    id: 'msat-8h',
    label: 'M–Sat 8h',
    workingDays: [false, true, true, true, true, true, true],
    hoursPerDay: 8,
    daysPerWeek: 6,
    description: '48 h/week — six-day workweek common in construction and parts of Asia.',
  },
  {
    id: 'sun-thu-8h',
    label: 'Sun–Thu 8h',
    workingDays: [true, true, true, true, true, false, false],
    hoursPerDay: 8,
    daysPerWeek: 5,
    description: '40 h/week — Middle East (post-2022 UAE, Saudi Arabia, etc.).',
  },
  {
    id: 'compressed-4day',
    label: '4-day M–Thu 10h',
    workingDays: [false, true, true, true, true, false, false],
    hoursPerDay: 10,
    daysPerWeek: 4,
    description: '40 h/week, three-day weekend — compressed workweek pilots.',
  },
  {
    id: 'continuous-24-7',
    label: '24/7 continuous',
    workingDays: [true, true, true, true, true, true, true],
    hoursPerDay: 24,
    daysPerWeek: 7,
    description: 'Always-on — manufacturing, utilities, healthcare, on-call.',
  },
  {
    id: 'weekend-satsun',
    label: 'Weekend (Sat–Sun) 8h',
    workingDays: [true, false, false, false, false, false, true],
    hoursPerDay: 8,
    daysPerWeek: 2,
    description: 'Weekend-only coverage — useful for on-call or partial-staffing calendars.',
  },
  // High-intensity professional-services patterns. The schema allows any
  // positive `hoursPerDay`; the engine doesn't cap "reasonable" working
  // hours. These templates exist for industries where the model below
  // (40-hour week) understates the actual resource burn — deal-driven
  // finance, consulting, BigLaw, and intensive Chinese tech culture.
  {
    id: 'pe-banking',
    label: 'PE / Investment Banking (M–Sat 14h)',
    workingDays: [false, true, true, true, true, true, true],
    hoursPerDay: 14,
    daysPerWeek: 6,
    description:
      '84 h/week — the deal-team grind. Weekday + Saturday with the long end of the day baked in.',
  },
  {
    id: 'mbb-consulting',
    label: 'MBB Consulting (M–F 13h)',
    workingDays: [false, true, true, true, true, true, false],
    hoursPerDay: 13,
    daysPerWeek: 5,
    description:
      '65 h/week — strategy-consulting travel week. Heavy weekday hours; weekends nominally off (but bring the laptop).',
  },
  {
    id: 'law',
    label: 'Law (M–Sat 11h)',
    workingDays: [false, true, true, true, true, true, true],
    hoursPerDay: 11,
    daysPerWeek: 6,
    description:
      '66 h/week — corporate-law deal pace. Most associates closer to this than the public 60-hour myth.',
  },
  {
    id: '996',
    label: '996 (M–Sat 12h)',
    workingDays: [false, true, true, true, true, true, true],
    hoursPerDay: 12,
    daysPerWeek: 6,
    description:
      '72 h/week — 9am to 9pm, six days a week. The canonical Chinese tech-industry pattern.',
  },
];

export function getCalendarTemplate(id: string): CalendarTemplate | undefined {
  return CALENDAR_TEMPLATES.find((t) => t.id === id);
}
