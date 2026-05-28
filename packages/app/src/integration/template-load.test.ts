import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectFile } from '@procsim/file-format';
import { schedule } from '@procsim/scheduler';

/**
 * Phase 27 — every shipped template under `public/templates/` must:
 *   1. Parse via `loadProjectFile` (Zod-valid v3 file).
 *   2. Produce a schedulable graph (`schedule()` returns ok=true).
 *
 * Catches authoring slips (typos, dangling edges, schema-violating
 * fields) before the picker tries to surface a broken template to the
 * user. Lives next to other integration tests so the existing test
 * runner picks it up without new wiring.
 */

const __filename = fileURLToPath(import.meta.url);
const TEMPLATES_DIR = resolve(dirname(__filename), '../../public/templates');

function listTemplates(): string[] {
  return readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith('.cala'))
    .sort();
}

describe('templates — every shipped template loads and schedules', () => {
  const names = listTemplates();
  // Sanity: we expect at least one template; a regression in the dir
  // glob shouldn't silently make the test always-pass.
  it('finds at least one template file', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)('%s loads via loadProjectFile', (name) => {
    const json = readFileSync(resolve(TEMPLATES_DIR, name), 'utf8');
    const result = loadProjectFile(json);
    if (!result.ok) {
      throw new Error(
        `Template ${name} failed to load:\n  ` +
          result.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('\n  '),
      );
    }
    expect(result.ok).toBe(true);
  });

  it.each(names)('%s schedules cleanly via schedule()', (name) => {
    const json = readFileSync(resolve(TEMPLATES_DIR, name), 'utf8');
    const result = loadProjectFile(json);
    if (!result.ok) {
      throw new Error(`Template ${name} failed to load (precondition)`);
    }
    const out = schedule({
      project: result.project.project,
      nodes: result.project.nodes,
      edges: result.project.edges,
      resources: result.project.resources,
      calendars: result.project.calendars,
      loops: result.project.loops,
      subsystems: result.project.subsystems,
    });
    if (!out.ok) {
      throw new Error(
        `Template ${name} failed to schedule:\n  ` +
          out.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('\n  '),
      );
    }
    expect(out.ok).toBe(true);
  });
});

// Phase 40 Slice 3 — intense-calendar templates compress wall-clock relative
// to a standard 8h/5d calendar. This is the load-bearing property the
// re-authoring exists to demonstrate: a "5 day" effort activity stays 40
// canonical hours regardless of calendar, so a 14h/day calendar should
// finish the same project earlier than a 5×8h calendar would. The bar is
// "measurably earlier" — exact ratios depend on whether the calendar's
// extra days fall on the critical path (resources can serialise around
// gates / loops), so we don't try to nail down a precise multiple.

interface IntenseTemplate {
  /** File name under public/templates */
  file: string;
  /**
   * Calendar id within the template's `calendars[]` array that we'll mutate
   * for the comparison run. Picking the default-calendar id is the obvious
   * choice; if a template grows a separate intense calendar later, point
   * this at that one.
   */
  calendarId: string;
}

const INTENSE_TEMPLATES: ReadonlyArray<IntenseTemplate> = [
  { file: 'ma-due-diligence.cala', calendarId: 'cal-default' },
  { file: 'mbb-engagement.cala', calendarId: 'cal-default' },
];

describe('templates — intense-calendar templates compress under their native schedule (Phase 40)', () => {
  it.each(INTENSE_TEMPLATES)(
    '$file finishes earlier on its intense calendar than under a swapped 8h/5d calendar',
    ({ file, calendarId }) => {
      const json = readFileSync(resolve(TEMPLATES_DIR, file), 'utf8');
      const loaded = loadProjectFile(json);
      if (!loaded.ok) throw new Error(`Precondition: ${file} must load`);
      const project = loaded.project;

      // Run 1: native intense calendar.
      const intenseOut = schedule({
        project: project.project,
        nodes: project.nodes,
        edges: project.edges,
        resources: project.resources,
        calendars: project.calendars,
        loops: project.loops,
        subsystems: project.subsystems,
      });
      if (!intenseOut.ok) throw new Error(`Intense run failed: ${file}`);

      // Run 2: swap the named calendar's shape down to standard 8h/5d
      // Mon–Fri. Everything else is preserved — same nodes, same resources,
      // same edges. With effort-based activities, the only thing the swap
      // changes is wall-clock per working day.
      const swappedCalendars = project.calendars.map((c) =>
        c.id === calendarId
          ? {
              ...c,
              workingDays: [false, true, true, true, true, true, false] as [
                boolean,
                boolean,
                boolean,
                boolean,
                boolean,
                boolean,
                boolean,
              ],
              hoursPerDay: 8,
              daysPerWeek: 5,
            }
          : c,
      );
      const standardOut = schedule({
        project: project.project,
        nodes: project.nodes,
        edges: project.edges,
        resources: project.resources,
        calendars: swappedCalendars,
        loops: project.loops,
        subsystems: project.subsystems,
      });
      if (!standardOut.ok) throw new Error(`Standard run failed: ${file}`);

      expect(intenseOut.result.projectEnd.getTime()).toBeLessThan(
        standardOut.result.projectEnd.getTime(),
      );
    },
  );
});
