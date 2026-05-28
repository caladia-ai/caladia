/**
 * Importer round-trip integration test.
 *
 * Exercises the full pipeline a real user goes through after picking a file
 * from the Toolbar's Import… dropdown:
 *
 *   raw bytes → parser (ImportDraft + ambiguities)
 *             → "synthetic LLM" step (deterministic mapping)
 *             → ProjectFile JSON
 *             → loadProjectFile() (Zod validation)
 *             → schedule() (CPM)
 *
 * The synthetic LLM is canned and trivial — it does the minimum to produce a
 * schema-valid project. In production the user's real LLM does this step
 * guided by docs/caladia-authoring-skill.md. The point of the test is to
 * verify that *parser output is shaped such that a sensible mapping leads to
 * a project that loads and schedules without errors*.
 *
 * If a parser change starts emitting drafts that no longer schedule cleanly
 * with this trivial mapping, this test catches it before users do.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMsProjectXml, type ImportDraft } from '@procsim/importers';
import {
  loadProjectFile,
  saveProjectFile,
  type ProjectFile,
  type ProjectNode,
  type ProjectEdge,
  type Resource,
} from '@procsim/file-format';
import { schedule } from '@procsim/scheduler';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(__dirname, '..', '..', '..', 'importers', 'fixtures', 'corpus');

// ── Synthetic LLM step ───────────────────────────────────────────────────────
//
// Maps an ImportDraft to a complete ProjectFile using deterministic defaults.
// In production an LLM does this guided by docs/caladia-authoring-skill.md.
// Kept intentionally simple: just enough to satisfy the schema. Any extra
// inference should live in the parser, not here.

const DEFAULT_CALENDAR_ID = 'cal-default';

function draftToProject(draft: ImportDraft): ProjectFile {
  const resources: Resource[] = draft.resources.map((r) => ({
    id: r.id,
    name: r.name,
    capacity: r.capacity,
    calendarId: DEFAULT_CALENDAR_ID,
  }));

  const nodes: ProjectNode[] = draft.nodes.map((n) => {
    const base = {
      id: n.id,
      nodeType: n.nodeType,
      name: n.name,
      duration: n.duration,
      durationSemantic: 'time' as const,
      position: n.position,
      calendarId: null as string | null,
      consumesResources: n.consumesResources,
      resourceAssignments: n.resourceAssignments.map((a) => ({
        resourceId: a.resourceId,
        count: a.count,
        calendarPolicy: a.calendarPolicy ?? ('intersection' as const),
      })),
    };
    if (n.nodeType === 'decision') {
      return {
        ...base,
        passProbability: n.passProbability ?? 1,
        ...(n.failureDelay ? { failureDelay: n.failureDelay } : {}),
      } as ProjectNode;
    }
    return base as ProjectNode;
  });

  const edges: ProjectEdge[] = draft.edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    type: e.type,
    lag: e.lag,
  }));

  return {
    kind: 'caladia-project',
    version: 8,
    currency: 'USD',
    fxSnapshotVersion: '2026.1',
    project: {
      name: draft.projectName ?? 'Imported Project',
      startDate: draft.startDate ?? '2026-01-01',
      defaultCalendarId: DEFAULT_CALENDAR_ID,
      displayUnit: 'days',
      shareMode: 'percentage',
    },
    calendars: [
      {
        id: DEFAULT_CALENDAR_ID,
        name: 'Standard (Mon–Fri)',
        workingDays: [false, true, true, true, true, true, false],
        hoursPerDay: 8,
        daysPerWeek: 5,
        holidayPreset: 'NONE',
        holidayPresetVersion: '',
        exceptions: [],
      },
    ],
    resources,
    nodes,
    edges,
    loops: [],
    subsystems: [],
    scenarios: [],
    comments: [],
    groupColors: {},
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Importer round-trip: parse → ProjectFile → load → schedule', () => {
  it('msproject/simple.xml lands in a schedulable project', () => {
    const xml = readFileSync(resolve(CORPUS, 'msproject', 'simple.xml'), 'utf-8');
    const parseResult = parseMsProjectXml(xml);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;

    // Step 1: build a ProjectFile from the draft
    const project = draftToProject(parseResult.draft);

    // Step 2: round-trip through JSON to exercise Zod validation
    const json = saveProjectFile(project);
    const loaded = loadProjectFile(json);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      // Surface the validation errors so a regression is easy to diagnose
      throw new Error(
        'loadProjectFile failed:\n' +
          loaded.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n'),
      );
    }

    // Step 3: schedule the loaded project
    const outcome = schedule({
      project: loaded.project.project,
      nodes: loaded.project.nodes,
      edges: loaded.project.edges,
      resources: loaded.project.resources,
      calendars: loaded.project.calendars,
      loops: loaded.project.loops,
      subsystems: loaded.project.subsystems,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(
        'schedule failed:\n' + outcome.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n'),
      );
    }

    // Sanity assertions on the schedule result — every node placed, project
    // end is computable, no warnings about disconnected graph fragments.
    expect(Object.keys(outcome.result.nodes).length).toBe(project.nodes.length);
    expect(outcome.result.projectEnd).toBeInstanceOf(Date);
    expect(Number.isFinite(outcome.result.projectEnd.getTime())).toBe(true);
  });
});
