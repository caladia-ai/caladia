import { describe, it, expect } from 'vitest';
import { CALENDAR_TEMPLATES, getCalendarTemplate } from './calendar-templates.js';
import { CalendarSchema } from './schema.js';

describe('calendar templates — registry shape', () => {
  it('every template has a unique id', () => {
    const ids = CALENDAR_TEMPLATES.map((t) => t.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('every template has a non-empty label and description', () => {
    for (const t of CALENDAR_TEMPLATES) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it('every template is schema-valid as a Calendar', () => {
    // Each template plus the metadata required by CalendarSchema must parse
    // cleanly — this catches drift between the template field set and the
    // Calendar schema (e.g. if hoursPerDay constraints tighten).
    for (const t of CALENDAR_TEMPLATES) {
      const candidate = {
        id: `cal-${t.id}`,
        name: t.label,
        workingDays: t.workingDays,
        hoursPerDay: t.hoursPerDay,
        daysPerWeek: t.daysPerWeek,
        holidayPreset: 'NONE' as const,
        holidayPresetVersion: '1.0',
        exceptions: [],
      };
      expect(() => CalendarSchema.parse(candidate)).not.toThrow();
    }
  });

  it('daysPerWeek equals the count of true entries in workingDays', () => {
    // Catches accidental miscounts (e.g. a template that says daysPerWeek=5
    // but actually has 6 days set true).
    for (const t of CALENDAR_TEMPLATES) {
      const trueCount = t.workingDays.filter(Boolean).length;
      expect(trueCount, `template ${t.id} workingDays count mismatch`).toBe(t.daysPerWeek);
    }
  });

  it('hoursPerDay is in (0, 24] for every template', () => {
    for (const t of CALENDAR_TEMPLATES) {
      expect(t.hoursPerDay).toBeGreaterThan(0);
      expect(t.hoursPerDay).toBeLessThanOrEqual(24);
    }
  });

  it('getCalendarTemplate returns the matching entry or undefined', () => {
    expect(getCalendarTemplate('mf-8h')?.label).toBe('Standard M–F 8h');
    expect(getCalendarTemplate('continuous-24-7')?.hoursPerDay).toBe(24);
    expect(getCalendarTemplate('does-not-exist')).toBeUndefined();
  });

  it('expected templates are present', () => {
    const ids = new Set(CALENDAR_TEMPLATES.map((t) => t.id));
    for (const required of [
      'mf-8h',
      'mf-7-5h',
      'mf-7h',
      'msat-8h',
      'sun-thu-8h',
      'compressed-4day',
      'continuous-24-7',
      'weekend-satsun',
      // Phase 39 — high-intensity professional-services patterns.
      'pe-banking',
      'mbb-consulting',
      'law',
      '996',
    ]) {
      expect(ids.has(required), `missing template ${required}`).toBe(true);
    }
  });
});
