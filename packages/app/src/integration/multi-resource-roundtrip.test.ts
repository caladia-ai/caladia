/**
 * Phase 18 slice 1 — File round-trip for multi-assignment activities.
 *
 * Builds a small project with one activity that has two resource
 * assignments, serializes via saveProjectFile, parses back via
 * loadProjectFile, and asserts the assignments survive the round-trip
 * intact. Also runs the result through the scheduler to confirm both
 * resources land in resourceTimeline.
 */

import { describe, it, expect } from 'vitest';
import { loadProjectFile, saveProjectFile, type ProjectFile } from '@procsim/file-format';
import { schedule } from '@procsim/scheduler';

const DEFAULT_CALENDAR_ID = 'cal-default';

function makeMultiResourceProject(): ProjectFile {
  return {
    kind: 'caladia-project',
    version: 8,
    currency: 'USD',
    fxSnapshotVersion: '2026.1',
    project: {
      name: 'Multi-resource fixture',
      startDate: '2026-01-05',
      defaultCalendarId: DEFAULT_CALENDAR_ID,
      displayUnit: 'days',
      shareMode: 'percentage',
    },
    calendars: [
      {
        id: DEFAULT_CALENDAR_ID,
        name: 'Mon–Fri 8h',
        workingDays: [false, true, true, true, true, true, false],
        hoursPerDay: 8,
        daysPerWeek: 5,
        holidayPreset: 'NONE',
        holidayPresetVersion: '',
        exceptions: [],
      },
    ],
    resources: [
      { id: 'r-dev', name: 'Dev Pool', capacity: 4, calendarId: DEFAULT_CALENDAR_ID },
      { id: 'r-overflow', name: 'Overflow', capacity: 2, calendarId: DEFAULT_CALENDAR_ID },
    ],
    nodes: [
      {
        id: 'A',
        nodeType: 'activity',
        name: 'Multi-resource activity',
        duration: { value: 8, unit: 'hours' },
        durationSemantic: 'time',
        position: { x: 0, y: 0 },
        calendarId: null,
        consumesResources: true,
        resourceAssignments: [
          { resourceId: 'r-dev', count: 2, calendarPolicy: 'activityWins' },
          { resourceId: 'r-overflow', count: 1, calendarPolicy: 'intersection' },
        ],
      },
    ],
    edges: [],
    loops: [],
    subsystems: [],
    scenarios: [],
    comments: [],
    groupColors: {},
  };
}

describe('Multi-resource activity file round-trip', () => {
  it('preserves both assignments through save → load', () => {
    const project = makeMultiResourceProject();
    const json = saveProjectFile(project);
    const loaded = loadProjectFile(json);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const activity = loaded.project.nodes.find((n) => n.id === 'A')!;
    expect(activity.resourceAssignments).toHaveLength(2);

    const dev = activity.resourceAssignments.find((a) => a.resourceId === 'r-dev');
    const ovf = activity.resourceAssignments.find((a) => a.resourceId === 'r-overflow');
    expect(dev).toEqual({
      resourceId: 'r-dev',
      count: 2,
      calendarPolicy: 'activityWins',
    });
    expect(ovf).toEqual({
      resourceId: 'r-overflow',
      count: 1,
      calendarPolicy: 'intersection',
    });
  });

  it('loaded project schedules with both resources in the timeline', () => {
    const project = makeMultiResourceProject();
    const json = saveProjectFile(project);
    const loaded = loadProjectFile(json);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const out = schedule({
      project: loaded.project.project,
      nodes: loaded.project.nodes,
      edges: loaded.project.edges,
      resources: loaded.project.resources,
      calendars: loaded.project.calendars,
      loops: loaded.project.loops,
      subsystems: loaded.project.subsystems,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const entries = out.result.resourceTimeline.filter((e) => e.nodeId === 'A');
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.resourceId).sort()).toEqual(['r-dev', 'r-overflow']);
  });
});
