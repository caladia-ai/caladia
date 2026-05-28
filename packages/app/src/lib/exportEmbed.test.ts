import { describe, it, expect } from 'vitest';
import type { ProjectFile } from '@procsim/file-format';
import type { ScheduleResult } from '@procsim/scheduler';
import type { SimulationResult } from '@procsim/simulation';
import type { SimRun } from '../store/viewStore.js';
import { toHtml } from './exportEmbed.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FIXED_DATE = new Date('2026-05-13T10:30:00.000Z');
const PROJECT_END = new Date('2026-05-20T17:00:00.000Z');

// 1×1 transparent PNG — keeps tests small and deterministic.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

function makeProject(overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    kind: 'caladia-project',
    version: 3,
    project: {
      name: 'Demo Project',
      startDate: '2026-05-04',
      defaultCalendarId: 'cal-default',
      displayUnit: 'days',
    },
    currency: 'USD',
    fxSnapshotVersion: '2026.1',
    calendars: [],
    resources: [
      {
        id: 'r-dev',
        name: 'Developer',
        capacity: 2,
        calendarId: 'cal-default',
        costRate: 100,
      },
    ],
    nodes: [
      {
        id: 'A',
        name: 'Build',
        nodeType: 'activity',
        duration: { value: 8, unit: 'hours' },
        durationSemantic: 'time',
        position: { x: 0, y: 0 },
        calendarId: null,
        consumesResources: true,
        resourceAssignments: [{ resourceId: 'r-dev', count: 1, calendarPolicy: 'intersection' }],
      },
      {
        id: 'B',
        name: 'Review',
        nodeType: 'decision',
        duration: { value: 4, unit: 'hours' },
        durationSemantic: 'time',
        passProbability: 0.8,
        failureDelay: { value: 8, unit: 'hours' },
        position: { x: 200, y: 0 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      },
    ],
    edges: [{ id: 'e1', from: 'A', to: 'B', type: 'FS', lag: { value: 0, unit: 'hours' } }],
    loops: [],
    subsystems: [],
    scenarios: [],
    ...overrides,
  } as unknown as ProjectFile;
}

function makeScheduleResult(overrides: Partial<ScheduleResult> = {}): ScheduleResult {
  return {
    nodes: {
      A: {
        nodeId: 'A',
        earliestStart: new Date('2026-05-04T09:00:00.000Z'),
        earliestFinish: new Date('2026-05-04T17:00:00.000Z'),
        latestStart: new Date('2026-05-04T09:00:00.000Z'),
        latestFinish: new Date('2026-05-04T17:00:00.000Z'),
        slackHours: 0,
        onCriticalPath: true,
      },
      B: {
        nodeId: 'B',
        earliestStart: new Date('2026-05-04T17:00:00.000Z'),
        earliestFinish: new Date('2026-05-04T21:00:00.000Z'),
        latestStart: new Date('2026-05-04T17:00:00.000Z'),
        latestFinish: new Date('2026-05-04T21:00:00.000Z'),
        slackHours: 0,
        onCriticalPath: true,
      },
    },
    criticalPaths: [['A', 'B']],
    resourceTimeline: [
      {
        resourceId: 'r-dev',
        nodeId: 'A',
        iteration: 0,
        start: new Date('2026-05-04T09:00:00.000Z'),
        end: new Date('2026-05-04T17:00:00.000Z'),
        count: 1,
      },
    ],
    projectEnd: PROJECT_END,
    warnings: [],
    nodeCosts: {
      A: { fromResources: 800, fromCrash: 0, fromFixed: 0, total: 800 },
    },
    resourceCosts: { 'r-dev': 800 },
    projectCost: 800,
    ...overrides,
  } as unknown as ScheduleResult;
}

function makeSimulationResult(overrides: Partial<SimulationResult> = {}): SimulationResult {
  return {
    endDates: [new Date('2026-05-19'), new Date('2026-05-20'), new Date('2026-05-21')],
    percentiles: {
      p50: new Date('2026-05-19T17:00:00.000Z'),
      p80: new Date('2026-05-21T17:00:00.000Z'),
      p95: new Date('2026-05-23T17:00:00.000Z'),
    },
    criticalityIndex: { A: 1.0, B: 0.95 },
    tornado: [
      { nodeId: 'A', impactHours: 24 },
      { nodeId: 'B', impactHours: 8 },
    ],
    convergence: { converged: true, atIteration: 200 },
    pathFrequency: [{ path: ['A', 'B'], count: 100 }],
    pathPerIteration: [],
    nodeP95: {},
    projectCosts: [800, 850, 900],
    costPercentiles: { p50: 850, p80: 900, p95: 950 },
    nodeCostStats: {},
    costTornado: [{ nodeId: 'A', impactCost: 150 }],
    costCurve: { times: [], p10: [], p50: [], p80: [], p95: [] },
    nodeInputSamples: { A: [8, 10, 12] },
    sensitivityFinishHours: [16, 18, 20],
    sensitivityProjectCosts: [800, 850, 900],
    finishSensitivity: { A: 0.82, B: 0.31 },
    costSensitivity: { A: 0.78, B: 0.12 },
    ...overrides,
  };
}

function makeSimRun(overrides: Partial<SimRun> = {}): SimRun {
  return {
    id: 'run-1',
    timestamp: FIXED_DATE,
    iterations: 1000,
    seed: 42,
    result: makeSimulationResult(),
    projectSnapshot: '{}',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('toHtml — structure + escape contract', () => {
  it('returns a complete HTML document', () => {
    const html = toHtml({
      project: makeProject(),
      scheduleResult: makeScheduleResult(),
      simRun: null,
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('inlines the Gantt PNG verbatim (no external fetch, no external CSS)', () => {
    const html = toHtml({
      project: makeProject(),
      scheduleResult: makeScheduleResult(),
      simRun: null,
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    expect(html).toContain(`src="${TINY_PNG}"`);
    expect(html).not.toMatch(/<link\s+rel="stylesheet"/i);
    // A single inline <script> is allowed: the Gantt zoom toolbar wires its
    // buttons via vanilla DOM. No external src.
    expect(html).not.toMatch(/<script[^>]+src=/i);
  });

  it('renders a zoom toolbar + scrollable wrapper around the Gantt image', () => {
    const html = toHtml({
      project: makeProject(),
      scheduleResult: makeScheduleResult(),
      simRun: null,
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    // Toolbar with 4 zoom buttons + Fit width
    expect(html).toContain('class="gantt-toolbar"');
    expect(html).toContain('data-zoom="0.5"');
    expect(html).toContain('data-zoom="1"');
    expect(html).toContain('data-zoom="1.5"');
    expect(html).toContain('data-zoom="2"');
    expect(html).toContain('data-zoom="fit"');
    // Image has the expected id the inline script wires to
    expect(html).toContain('id="caladia-gantt"');
    // Inline script is present (no external src)
    expect(html).toMatch(
      /<script>[\s\S]+document\.getElementById\('caladia-gantt'\)[\s\S]+<\/script>/,
    );
  });

  it('escapes project name when it contains HTML-sensitive chars', () => {
    const html = toHtml({
      project: makeProject({
        project: {
          name: '<script>alert(1)</script> & "co"',
          startDate: '2026-05-04',
          defaultCalendarId: 'cal-default',
          displayUnit: 'days',
        },
      } as unknown as Partial<ProjectFile>),
      scheduleResult: makeScheduleResult(),
      simRun: null,
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });

  it('renders a Download .cala link with a base64 data URL (no JS needed)', () => {
    const project = makeProject({
      project: {
        name: 'Round-Trip Test',
        startDate: '2026-05-04',
        defaultCalendarId: 'cal-default',
        displayUnit: 'days',
      },
    } as unknown as Partial<ProjectFile>);
    const html = toHtml({
      project,
      scheduleResult: makeScheduleResult(),
      simRun: null,
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    // The slug-derived filename is what the browser saves the file as.
    expect(html).toContain('download="round-trip-test.cala"');
    // The data URL carries the JSON as base64 so a plain <a download>
    // works without any inline script.
    expect(html).toMatch(/href="data:application\/json;base64,/);
  });

  it('the embedded data URL decodes to the canonical save serialisation', () => {
    const project = makeProject();
    const html = toHtml({
      project,
      scheduleResult: makeScheduleResult(),
      simRun: null,
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    const match = html.match(/href="data:application\/json;base64,([^"]+)"/);
    expect(match).not.toBeNull();
    const decoded = Buffer.from(match![1]!, 'base64').toString('utf-8');
    // Round-trips to a JSON document with the v3 schema fields.
    const parsed = JSON.parse(decoded);
    expect(parsed.kind).toBe('caladia-project');
    expect(parsed.version).toBe(3);
    expect(parsed.project.name).toBe('Demo Project');
  });

  it('uses a fallback slug when the project name has no usable characters', () => {
    const project = makeProject({
      project: {
        name: '!!! ???',
        startDate: '2026-05-04',
        defaultCalendarId: 'cal-default',
        displayUnit: 'days',
      },
    } as unknown as Partial<ProjectFile>);
    const html = toHtml({
      project,
      scheduleResult: makeScheduleResult(),
      simRun: null,
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    expect(html).toContain('download="plan.cala"');
  });
});

describe('toHtml — verdict bar contents', () => {
  it('renders deterministic project end without MC cells when simRun is null', () => {
    const html = toHtml({
      project: makeProject(),
      scheduleResult: makeScheduleResult(),
      simRun: null,
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    expect(html).toContain('Project end (deterministic)');
    expect(html).toContain('2026-05-20');
    expect(html).not.toContain('P50 finish');
    expect(html).not.toContain('P80 finish');
    expect(html).not.toContain('P95 finish');
  });

  it('adds P50 / P80 / P95 cells when a simRun is present', () => {
    const html = toHtml({
      project: makeProject(),
      scheduleResult: makeScheduleResult(),
      simRun: makeSimRun(),
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    expect(html).toContain('P50 finish');
    expect(html).toContain('P80 finish');
    expect(html).toContain('P95 finish');
    expect(html).toContain('1,000 iterations');
  });

  it('marks the project-cost cell as over-budget when budget is exceeded', () => {
    const project = makeProject({ budget: 500 } as unknown as Partial<ProjectFile>);
    const html = toHtml({
      project,
      scheduleResult: makeScheduleResult(),
      simRun: null,
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    expect(html).toContain('tone-bad');
  });
});

describe('toHtml — risks and sensitivity gating', () => {
  it('lists nodes flagged as risks with their pass probability', () => {
    const html = toHtml({
      project: makeProject(),
      scheduleResult: makeScheduleResult(),
      simRun: null,
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    expect(html).toContain('<h2>Risks</h2>');
    expect(html).toContain('Review'); // decision node with passProbability < 1
    expect(html).toContain('80%');
  });

  it('omits the Sensitivity section when no MC run is present', () => {
    const html = toHtml({
      project: makeProject(),
      scheduleResult: makeScheduleResult(),
      simRun: null,
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    expect(html).not.toContain('Sensitivity');
  });

  it('includes the Sensitivity table when a MC run is present', () => {
    const html = toHtml({
      project: makeProject(),
      scheduleResult: makeScheduleResult(),
      simRun: makeSimRun(),
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    expect(html).toMatch(/Sensitivity\b/);
    expect(html).toContain('+0.82'); // A's ρ vs finish
    expect(html).toContain('+0.31'); // B's ρ vs finish
  });

  it('renders both date and cost tornado tables when MC is present', () => {
    const html = toHtml({
      project: makeProject(),
      scheduleResult: makeScheduleResult(),
      simRun: makeSimRun(),
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    expect(html).toContain('Schedule impact');
    expect(html).toContain('Cost impact');
  });
});

describe('toHtml — resources section', () => {
  it('renders one row per resource with its capacity and aggregated hours', () => {
    const html = toHtml({
      project: makeProject(),
      scheduleResult: makeScheduleResult(),
      simRun: null,
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    expect(html).toContain('<h2>Resources</h2>');
    expect(html).toContain('Developer');
    expect(html).toContain('8.0 h'); // resource was used 8h on activity A
  });

  it('falls back to the empty-state when the project declares no resources', () => {
    const html = toHtml({
      project: makeProject({ resources: [] } as unknown as Partial<ProjectFile>),
      scheduleResult: makeScheduleResult({ resourceTimeline: [], resourceCosts: {} }),
      simRun: null,
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    expect(html).toContain('No resources declared');
  });
});

describe('toHtml — notes section', () => {
  it('omits the section entirely when no nodes or loops have a description', () => {
    const html = toHtml({
      project: makeProject(),
      scheduleResult: makeScheduleResult(),
      simRun: null,
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    expect(html).not.toContain('<h2>Notes</h2>');
  });

  it('renders one row per node and one row per loop that has a description', () => {
    const base = makeProject();
    const nodes = base.nodes.map((n) =>
      n.id === 'A' ? { ...n, description: 'Per-vendor permit; assumes EPA portal up.' } : n,
    );
    const project: ProjectFile = {
      ...base,
      nodes,
      loops: [
        {
          id: 'loop-1',
          bodyNodeIds: ['A'],
          kickout: { type: 'maxIterations', value: 3 },
          expectedIterations: { type: 'triangular', min: 1, mode: 3, max: 5 },
          group: 'Quality gate',
          description: 'Iterate per regulatory market until coverage met.',
        },
      ],
    };
    const html = toHtml({
      project,
      scheduleResult: makeScheduleResult(),
      simRun: null,
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    expect(html).toContain('<h2>Notes</h2>');
    expect(html).toContain('Per-vendor permit; assumes EPA portal up.');
    expect(html).toContain('Loop (Quality gate)');
    expect(html).toContain('Iterate per regulatory market until coverage met.');
    // Node row precedes loop row in the rendered table.
    const nodeIdx = html.indexOf('Per-vendor permit');
    const loopIdx = html.indexOf('Iterate per regulatory market');
    expect(nodeIdx).toBeGreaterThan(0);
    expect(loopIdx).toBeGreaterThan(nodeIdx);
  });

  it('labels a loop without a group as just "Loop"', () => {
    const base = makeProject();
    const project: ProjectFile = {
      ...base,
      loops: [
        {
          id: 'loop-1',
          bodyNodeIds: ['A'],
          kickout: { type: 'maxIterations', value: 3 },
          expectedIterations: { type: 'triangular', min: 1, mode: 3, max: 5 },
          description: 'Retry on transient failures.',
        },
      ],
    };
    const html = toHtml({
      project,
      scheduleResult: makeScheduleResult(),
      simRun: null,
      ganttPngDataUrl: TINY_PNG,
      generatedAt: FIXED_DATE,
    });
    expect(html).toContain('<h2>Notes</h2>');
    expect(html).toContain('>Loop<');
    expect(html).not.toContain('Loop (');
  });

  it('HTML-escapes both name and description', () => {
    const base = makeProject();
    const nodes = base.nodes.map((n) =>
      n.id === 'A'
        ? {
            ...n,
            name: '<img>',
            description: '<script>alert(1)</script>\n& ampersand',
          }
        : n,
    );
    const html = toHtml({
      ...{
        project: { ...base, nodes } as ProjectFile,
        scheduleResult: makeScheduleResult(),
        simRun: null,
        ganttPngDataUrl: TINY_PNG,
        generatedAt: FIXED_DATE,
      },
    });
    expect(html).toContain('&lt;img&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&amp; ampersand');
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
  });
});

describe('toHtml — generated-at default', () => {
  it('uses new Date() when generatedAt is not provided', () => {
    const before = Date.now();
    const html = toHtml({
      project: makeProject(),
      scheduleResult: makeScheduleResult(),
      simRun: null,
      ganttPngDataUrl: TINY_PNG,
    });
    const after = Date.now();
    // The footer / header text contains the timestamp — verify it's parseable
    // and falls within the call window. We don't pin the exact string because
    // the formatter uses local time and the test runner's TZ varies.
    const match = html.match(/Generated (\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/);
    expect(match).not.toBeNull();
    // The HTML's `formatDate` uses local-time getters (getFullYear / getMonth /
    // getDate), so the expected/observed bounds have to use the same timezone —
    // .toISOString() would compare UTC against a local-time string and flake
    // whenever local time is a day behind UTC.
    const formatLocalDate = (ts: number): string => {
      const d = new Date(ts);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    };
    const expectedDate = formatLocalDate(before);
    const observedDate = formatLocalDate(after);
    // The match should be one of those two dates (allows for midnight rollover)
    expect([expectedDate, observedDate]).toContain(match![1]);
  });
});
