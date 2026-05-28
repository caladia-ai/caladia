import { describe, it, expect } from 'vitest';
import type { ProjectFile } from '@procsim/file-format';
import type { SimulationResult } from '@procsim/simulation';
import type { SimRun } from '../store/viewStore.js';
import {
  toJson,
  fromJson,
  toCsv,
  toCostCsv,
  buildExportFilename,
  SIM_EXPORT_VERSION,
} from './exportSim.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Minimal ProjectFile satisfying only the fields the exporter reads. The
 * exporter never touches calendars / resources / edges / loops / scenarios,
 * so the cast is safe — it's an acknowledged narrow-typed test fixture.
 */
function makeProject(
  overrides: Partial<{
    name: string;
    startDate: string;
    currency: string;
    fxSnapshotVersion: string;
    fxRateOverrides?: Record<string, number>;
    nodes: Array<{ id: string; name: string }>;
  }> = {},
): ProjectFile {
  const o = {
    name: 'Demo Project',
    startDate: '2026-01-05',
    currency: 'USD',
    fxSnapshotVersion: '2026.1',
    nodes: [
      { id: 'A', name: 'Build' },
      { id: 'B', name: 'Test' },
    ],
    ...overrides,
  };
  return {
    kind: 'caladia-project',
    version: 3,
    project: {
      name: o.name,
      startDate: o.startDate,
      defaultCalendarId: 'cal-default',
      displayUnit: 'days',
    },
    currency: o.currency,
    fxSnapshotVersion: o.fxSnapshotVersion,
    ...(o.fxRateOverrides ? { fxRateOverrides: o.fxRateOverrides } : {}),
    calendars: [],
    resources: [],
    nodes: o.nodes.map((n) => ({
      ...n,
      nodeType: 'activity',
      duration: { value: 8, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    })),
    edges: [],
    loops: [],
    subsystems: [],
    scenarios: [],
  } as unknown as ProjectFile;
}

function makeResult(overrides: Partial<SimulationResult> = {}): SimulationResult {
  const baseDate = new Date('2026-03-15T17:00:00.000Z');
  return {
    endDates: [
      new Date('2026-03-14T17:00:00.000Z'),
      new Date('2026-03-15T17:00:00.000Z'),
      new Date('2026-03-16T17:00:00.000Z'),
    ],
    percentiles: {
      p50: baseDate,
      p80: new Date('2026-03-16T17:00:00.000Z'),
      p95: new Date('2026-03-17T17:00:00.000Z'),
    },
    criticalityIndex: { A: 1.0, B: 1.0 },
    tornado: [{ nodeId: 'A', impactHours: 24 }],
    convergence: { converged: true, atIteration: 150 },
    pathFrequency: [{ path: ['A', 'B'], count: 3 }],
    pathPerIteration: [0, 0, 0],
    nodeP95: {
      A: new Date('2026-03-10T17:00:00.000Z'),
      B: new Date('2026-03-15T17:00:00.000Z'),
    },
    projectCosts: [1000, 1200, 1100],
    costPercentiles: { p50: 1100, p80: 1200, p95: 1200 },
    nodeCostStats: { A: { mean: 500, p95: 600 }, B: { mean: 600, p95: 700 } },
    costTornado: [{ nodeId: 'A', impactCost: 100 }],
    costCurve: { times: [0, 100], p10: [0, 500], p50: [0, 1100], p80: [0, 1200], p95: [0, 1200] },
    nodeInputSamples: {},
    sensitivityFinishHours: [],
    sensitivityProjectCosts: [],
    finishSensitivity: {},
    costSensitivity: {},
    ...overrides,
  };
}

function makeRun(overrides: Partial<SimRun> = {}): SimRun {
  return {
    id: 'run-1',
    timestamp: new Date('2026-05-13T10:00:00.000Z'),
    iterations: 100,
    seed: 42,
    result: makeResult(),
    projectSnapshot: '{}',
    ...overrides,
  };
}

// ── JSON adapter ────────────────────────────────────────────────────────────
//
// The full JSON shape is exercised by the engine-side suite in
// `packages/simulation/src/export.test.ts`. This block only proves the
// adapter projects `SimRun + ProjectFile` into the engine's primitives
// correctly — i.e. that the wiring is right, not that the JSON shape is
// right.

describe('toJson adapter', () => {
  it('projects SimRun + ProjectFile fields onto the engine input', () => {
    const project = makeProject({ fxRateOverrides: { EUR: 0.92 } });
    const run = makeRun({ excludes: ['A'] });
    const text = toJson(run, project, '2026-08-15', new Date('2026-05-13T15:00:00.000Z'));
    const parsed = JSON.parse(text);

    // Run-level fields project from SimRun
    expect(parsed.iterations).toBe(run.iterations);
    expect(parsed.seed).toBe(run.seed);
    expect(parsed.runId).toBe(run.id);
    expect(parsed.runTimestamp).toBe(run.timestamp.toISOString());
    expect(parsed.excludes).toEqual(['A']);

    // Project-level fields project from ProjectFile
    expect(parsed.projectName).toBe(project.project.name);
    expect(parsed.currency).toBe(project.currency);
    expect(parsed.fxSnapshotVersion).toBe(project.fxSnapshotVersion);
    expect(parsed.fxRateOverrides).toEqual({ EUR: 0.92 });

    // Caller-passed fields
    expect(parsed.target).toBe('2026-08-15');
    expect(parsed.exportedAt).toBe('2026-05-13T15:00:00.000Z');
    expect(parsed.kind).toBe('caladia.sim');
    expect(parsed.version).toBe(SIM_EXPORT_VERSION);

    // Names map is built from project.nodes — verify resolution lands
    // on real names, not ids.
    expect(parsed.result.tornado[0].name).toBe('Build');
  });

  it('omits excludes / fxRateOverrides when empty (parity with engine behaviour)', () => {
    const parsed = JSON.parse(toJson(makeRun(), makeProject(), null, new Date()));
    expect('excludes' in parsed).toBe(false);
    expect('fxRateOverrides' in parsed).toBe(false);
  });

  it('fromJson re-export round-trips a Date field', () => {
    // Smoke check that the re-exported parser is the engine's, not a
    // stub. Full round-trip semantics are tested engine-side.
    const text = toJson(makeRun(), makeProject(), null, new Date('2026-05-13T15:00:00.000Z'));
    const parsed = fromJson(text);
    expect(parsed.result.endDates[0]).toBeInstanceOf(Date);
  });
});

// ── Schedule CSV ─────────────────────────────────────────────────────────────

describe('toCsv', () => {
  it('emits the expected header row with CRLF', () => {
    const csv = toCsv(makeRun(), makeProject());
    const firstLineEnd = csv.indexOf('\r\n');
    expect(firstLineEnd).toBeGreaterThan(0);
    expect(csv.slice(0, firstLineEnd)).toBe(
      'iteration,finishDateISO,finishDays,criticalPathRank,criticalPathNodes',
    );
  });

  it('row count equals endDates.length', () => {
    const csv = toCsv(makeRun(), makeProject());
    const rows = csv.split('\r\n').filter((l) => l.length > 0);
    expect(rows.length - 1).toBe(3); // 3 endDates + 1 header
  });

  it('renders criticalPathNodes with project-resolved names joined by ›', () => {
    const csv = toCsv(makeRun(), makeProject());
    expect(csv).toContain('Build › Test');
  });

  it('uses calendar days for finishDays (decimal, 2 places)', () => {
    // projectStart = 2026-01-05 00:00 local; endDate[1] = 2026-03-15 17:00 UTC.
    // The exact decimal depends on the local timezone but parseable as a number.
    const csv = toCsv(makeRun(), makeProject());
    const lines = csv.split('\r\n').filter((l) => l.length > 0);
    const cells = lines[2]!.split(',');
    expect(cells[2]).toMatch(/^\d+\.\d{2}$/);
  });

  it('renders -1 sentinel literally and leaves criticalPathNodes empty', () => {
    const result = makeResult({
      pathFrequency: [],
      pathPerIteration: [-1, -1, -1],
    });
    const run = makeRun({ result });
    const csv = toCsv(run, makeProject());
    const lines = csv.split('\r\n').filter((l) => l.length > 0);
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i]!.split(',');
      expect(cells[3]).toBe('-1');
      expect(cells[4]).toBe('');
    }
  });

  it('quotes critical-path names that contain commas', () => {
    const project = makeProject({
      nodes: [
        { id: 'A', name: 'Foo, Bar' },
        { id: 'B', name: 'Baz' },
      ],
    });
    const csv = toCsv(makeRun(), project);
    expect(csv).toContain('"Foo, Bar › Baz"');
  });
});

// ── Cost CSV ─────────────────────────────────────────────────────────────────

describe('toCostCsv', () => {
  it('emits iteration,projectCost header and one row per iteration', () => {
    const csv = toCostCsv(makeRun(), makeProject());
    expect(csv).not.toBeNull();
    const lines = csv!.split('\r\n').filter((l) => l.length > 0);
    expect(lines[0]).toBe('iteration,projectCost');
    expect(lines.length - 1).toBe(3);
    expect(lines[1]).toBe('1,1000');
  });

  it('returns null when projectCosts is all zeros', () => {
    const result = makeResult({ projectCosts: [0, 0, 0] });
    const run = makeRun({ result });
    expect(toCostCsv(run, makeProject())).toBeNull();
  });

  it('returns null when projectCosts is empty', () => {
    const result = makeResult({ projectCosts: [] });
    const run = makeRun({ result });
    expect(toCostCsv(run, makeProject())).toBeNull();
  });
});

// ── Filename ─────────────────────────────────────────────────────────────────

describe('buildExportFilename', () => {
  it('slugs the project name and stamps local time', () => {
    const project = makeProject({ name: 'My Demo Project!' });
    const run = makeRun({ iterations: 1000, seed: 42 });
    // 2026-05-13 15:07 local (whatever the test runner's tz; the stamp is
    // formatted from getFullYear/getMonth/getDate so the assertion below
    // accepts any 8-digit date and 4-digit time).
    const name = buildExportFilename(project, run, new Date('2026-05-13T15:07:00'), 'json');
    expect(name).toMatch(/^caladia-sim-my_demo_project_-1000iters-42-\d{8}-\d{4}\.json$/);
  });

  it('appends -cost suffix when requested', () => {
    const name = buildExportFilename(makeProject(), makeRun(), new Date(), 'csv', 'cost');
    expect(name).toMatch(/-cost\.csv$/);
  });
});
