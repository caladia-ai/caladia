import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import {
  loadProjectFile,
  saveProjectFile,
  loadSubsystemFile,
  saveSubsystemFile,
  migrateV1ToV2,
  migrateV2ToV3,
  migrateV3ToV4,
} from './load.js';
import {
  ProjectFileV1,
  ProjectFileV2,
  ProjectFileV3,
  ProjectFileV6,
  DistributionSchema,
} from './schema.js';
import { LATEST_FX_SNAPSHOT_VERSION } from './currency.js';
import type { ProjectFile, SubsystemFile } from './schema.js';

// ── Minimal valid v8 fixture ──────────────────────────────────────────────────

const MINIMAL_VALID: ProjectFile = {
  kind: 'caladia-project',
  version: 8,
  currency: 'USD',
  fxSnapshotVersion: LATEST_FX_SNAPSHOT_VERSION,
  project: {
    name: 'Test Project',
    startDate: '2026-01-01',
    defaultCalendarId: 'cal-1',
    displayUnit: 'days',
    shareMode: 'percentage',
  },
  calendars: [
    {
      id: 'cal-1',
      name: 'Standard',
      workingDays: [false, true, true, true, true, true, false],
      hoursPerDay: 8,
      daysPerWeek: 5,
      holidayPreset: 'US_FEDERAL',
      holidayPresetVersion: '2026.1',
      exceptions: [],
    },
  ],
  resources: [],
  nodes: [
    {
      id: 'n1',
      nodeType: 'activity',
      name: 'Task A',
      duration: { value: 8, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: true,
      resourceAssignments: [],
    },
  ],
  edges: [],
  loops: [],
  subsystems: [],
  scenarios: [],
  comments: [],
  groupColors: {},
};

// ── loadProjectFile ──────────────────────────────────────────────────────────

describe('loadProjectFile', () => {
  it('parses a valid v5 file', () => {
    const json = saveProjectFile(MINIMAL_VALID);
    const result = loadProjectFile(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.project.name).toBe('Test Project');
      expect(result.project.nodes).toHaveLength(1);
      expect(result.project.version).toBe(8);
      expect(result.project.currency).toBe('USD');
      expect(result.project.fxSnapshotVersion).toBe(LATEST_FX_SNAPSHOT_VERSION);
    }
  });

  it('returns an error for invalid JSON', () => {
    const result = loadProjectFile('not json {{');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.message).toMatch(/JSON/i);
    }
  });

  it('returns an error when version is missing', () => {
    const bad = JSON.stringify({ project: { name: 'X' } });
    const result = loadProjectFile(bad);
    expect(result.ok).toBe(false);
  });

  it('returns an error pointing at a bad field', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[])[0]['duration']['value'] = -5;
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);
      expect(paths.some((p) => p.includes('duration'))).toBe(true);
    }
  });

  it('returns a round-tripped project identical to the input', () => {
    const json = saveProjectFile(MINIMAL_VALID);
    const result = loadProjectFile(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const reparsed = loadProjectFile(saveProjectFile(result.project));
      expect(reparsed.ok).toBe(true);
      if (reparsed.ok) {
        expect(reparsed.project).toEqual(result.project);
      }
    }
  });

  it('surfaces preset update banners when a calendar pins an older version', () => {
    const withOldPreset: ProjectFile = {
      ...MINIMAL_VALID,
      calendars: [
        {
          ...MINIMAL_VALID.calendars[0]!,
          holidayPresetVersion: '2023.1',
        },
      ],
    };
    const result = loadProjectFile(saveProjectFile(withOldPreset));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.presetUpdatesAvailable).toHaveLength(1);
      expect(result.presetUpdatesAvailable[0]?.latestVersion).toBe('2026.1');
    }
  });

  it('does not surface preset banners when version is current', () => {
    const result = loadProjectFile(saveProjectFile(MINIMAL_VALID));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.presetUpdatesAvailable).toHaveLength(0);
    }
  });

  it('accepts all four dependency edge types', () => {
    const withEdges: ProjectFile = {
      ...MINIMAL_VALID,
      nodes: [
        MINIMAL_VALID.nodes[0]!,
        { ...MINIMAL_VALID.nodes[0]!, id: 'n2', name: 'Task B', position: { x: 200, y: 0 } },
        { ...MINIMAL_VALID.nodes[0]!, id: 'n3', name: 'Task C', position: { x: 400, y: 0 } },
        { ...MINIMAL_VALID.nodes[0]!, id: 'n4', name: 'Task D', position: { x: 600, y: 0 } },
        { ...MINIMAL_VALID.nodes[0]!, id: 'n5', name: 'Task E', position: { x: 800, y: 0 } },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', type: 'FS', lag: { value: 0, unit: 'hours' } },
        { id: 'e2', from: 'n2', to: 'n3', type: 'SS', lag: { value: 4, unit: 'hours' } },
        { id: 'e3', from: 'n3', to: 'n4', type: 'FF', lag: { value: 0, unit: 'hours' } },
        { id: 'e4', from: 'n4', to: 'n5', type: 'SF', lag: { value: 0, unit: 'hours' } },
      ],
    };
    const result = loadProjectFile(saveProjectFile(withEdges));
    expect(result.ok).toBe(true);
  });

  it('rejects an activity node with zero duration', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[])[0]['duration']['value'] = 0;
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  // ── Phase 10 Tier 1: typed nodes ────────────────────────────────────────────

  it('accepts a start node with zero duration', () => {
    const withStart = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const nodes = withStart['nodes'] as any[];
    nodes[0]!['nodeType'] = 'start';
    nodes[0]!['duration'] = { value: 0, unit: 'hours' };
    const result = loadProjectFile(JSON.stringify(withStart));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.nodes[0]?.nodeType).toBe('start');
    }
  });

  it('accepts an end node with zero duration', () => {
    const withEnd = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const nodes = withEnd['nodes'] as any[];
    nodes[0]!['nodeType'] = 'end';
    nodes[0]!['duration'] = { value: 0, unit: 'hours' };
    const result = loadProjectFile(JSON.stringify(withEnd));
    expect(result.ok).toBe(true);
  });

  it('accepts a start node with anchorDate', () => {
    const withStart = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const nodes = withStart['nodes'] as any[];
    nodes[0]!['nodeType'] = 'start';
    nodes[0]!['duration'] = { value: 0, unit: 'hours' };
    nodes[0]!['anchorDate'] = '2026-03-15';
    const result = loadProjectFile(JSON.stringify(withStart));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.nodes[0]?.anchorDate).toBe('2026-03-15');
    }
  });

  it('rejects a malformed anchorDate', () => {
    const withStart = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const nodes = withStart['nodes'] as any[];
    nodes[0]!['nodeType'] = 'start';
    nodes[0]!['duration'] = { value: 0, unit: 'hours' };
    nodes[0]!['anchorDate'] = '03/15/2026'; // wrong format
    const result = loadProjectFile(JSON.stringify(withStart));
    expect(result.ok).toBe(false);
  });

  it('defaults nodeType to "activity" for legacy files (backward compat)', () => {
    // Pre-Phase-10 .procsim files have no `nodeType` field on nodes.
    const legacy = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    delete (legacy['nodes'] as any[])[0]!['nodeType'];
    const result = loadProjectFile(JSON.stringify(legacy));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.nodes[0]?.nodeType).toBe('activity');
    }
  });

  // ── Phase 11: decision nodes ────────────────────────────────────────────────

  it('accepts a decision node with passProbability and failureDelay', () => {
    const withDecision = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const nodes = withDecision['nodes'] as any[];
    nodes[0]!['nodeType'] = 'decision';
    nodes[0]!['passProbability'] = 0.75;
    nodes[0]!['failureDelay'] = { value: 4, unit: 'hours' };
    const result = loadProjectFile(JSON.stringify(withDecision));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.nodes[0]?.nodeType).toBe('decision');
      expect(result.project.nodes[0]?.passProbability).toBe(0.75);
      expect(result.project.nodes[0]?.failureDelay).toEqual({ value: 4, unit: 'hours' });
    }
  });

  it('accepts a decision node without optional fields (defaults at use-site)', () => {
    const withDecision = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const nodes = withDecision['nodes'] as any[];
    nodes[0]!['nodeType'] = 'decision';
    const result = loadProjectFile(JSON.stringify(withDecision));
    expect(result.ok).toBe(true);
  });

  it('rejects a decision node with zero duration', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const nodes = bad['nodes'] as any[];
    nodes[0]!['nodeType'] = 'decision';
    nodes[0]!['duration'] = { value: 0, unit: 'hours' };
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects passProbability outside [0, 1]', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const nodes = bad['nodes'] as any[];
    nodes[0]!['nodeType'] = 'decision';
    nodes[0]!['passProbability'] = 1.5;
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects passProbability on a non-decision node', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const nodes = bad['nodes'] as any[];
    // nodeType stays as 'activity'
    nodes[0]!['passProbability'] = 0.5;
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects failureDelay on a non-decision node', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const nodes = bad['nodes'] as any[];
    // nodeType stays as 'activity'
    nodes[0]!['failureDelay'] = { value: 4, unit: 'hours' };
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  // ── Phase 46: isRisk removed; legacy files silently strip the field ──────────

  it('silently strips legacy `isRisk` on load (no error, field gone)', () => {
    const withRisk = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const nodes = withRisk['nodes'] as any[];
    nodes[0]!['nodeType'] = 'decision';
    nodes[0]!['isRisk'] = true;
    const result = loadProjectFile(JSON.stringify(withRisk));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Zod's default .strip() drops unknown keys; the field is gone post-parse.
      expect((result.project.nodes[0] as Record<string, unknown>)['isRisk']).toBeUndefined();
    }
  });

  // ── Phase 29: per-resource rate uncertainty ─────────────────────────────────

  it('accepts a resource with triangular hourlyRateDistribution', () => {
    const withDist = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (withDist['resources'] as any[]).push({
      id: 'r1',
      name: 'Contractor',
      capacity: 1,
      calendarId: 'cal-1',
      costRate: 120,
      hourlyRateDistribution: { type: 'triangular', min: 100, mode: 120, max: 180 },
    });
    const result = loadProjectFile(JSON.stringify(withDist));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const dist = result.project.resources[0]?.hourlyRateDistribution;
      expect(dist).toEqual({ type: 'triangular', min: 100, mode: 120, max: 180 });
    }
  });

  it('round-trips hourlyRateDistribution through save / load', () => {
    const withDist = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (withDist['resources'] as any[]).push({
      id: 'r1',
      name: 'Contractor',
      capacity: 1,
      calendarId: 'cal-1',
      hourlyRateDistribution: { type: 'triangular', min: 80, mode: 100, max: 150 },
    });
    const parsed = loadProjectFile(JSON.stringify(withDist));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const reSaved = JSON.parse(saveProjectFile(parsed.project)) as Record<string, unknown>;

      const reRes = (reSaved['resources'] as any[])[0];
      expect(reRes['hourlyRateDistribution']).toEqual({
        type: 'triangular',
        min: 80,
        mode: 100,
        max: 150,
      });
    }
  });

  it('accepts a resource without hourlyRateDistribution (legacy)', () => {
    const noDist = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (noDist['resources'] as any[]).push({
      id: 'r1',
      name: 'Designer',
      capacity: 1,
      calendarId: 'cal-1',
      costRate: 80,
    });
    const result = loadProjectFile(JSON.stringify(noDist));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.resources[0]?.hourlyRateDistribution).toBeUndefined();
    }
  });

  it('accepts a resource with currencyOverride', () => {
    const withOverride = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (withOverride['resources'] as any[]).push({
      id: 'r1',
      name: 'EU Contractor',
      capacity: 1,
      calendarId: 'cal-1',
      costRate: 150,
      currencyOverride: 'EUR',
    });
    const result = loadProjectFile(JSON.stringify(withOverride));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.resources[0]?.currencyOverride).toBe('EUR');
    }
  });

  it('round-trips currencyOverride through save / load', () => {
    const withOverride = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (withOverride['resources'] as any[]).push({
      id: 'r1',
      name: 'EU Contractor',
      capacity: 1,
      calendarId: 'cal-1',
      costRate: 150,
      currencyOverride: 'EUR',
    });
    const parsed = loadProjectFile(JSON.stringify(withOverride));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const reSaved = JSON.parse(saveProjectFile(parsed.project)) as Record<string, unknown>;

      const reRes = (reSaved['resources'] as any[])[0]!;
      expect(reRes['currencyOverride']).toBe('EUR');
      expect(reRes['costRate']).toBe(150);
    }
  });

  it('rejects malformed currencyOverride (not ISO 4217)', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['resources'] as any[]).push({
      id: 'r1',
      name: 'Bad Currency',
      capacity: 1,
      calendarId: 'cal-1',
      currencyOverride: 'eur', // lowercase — must be uppercase
    });
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects currencyOverride with wrong length', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['resources'] as any[]).push({
      id: 'r1',
      name: 'Bad Currency',
      capacity: 1,
      calendarId: 'cal-1',
      currencyOverride: 'EURO', // 4 chars
    });
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('treats absent currencyOverride as project-currency default', () => {
    const legacy = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (legacy['resources'] as any[]).push({
      id: 'r1',
      name: 'Local',
      capacity: 1,
      calendarId: 'cal-1',
      costRate: 100,
    });
    const result = loadProjectFile(JSON.stringify(legacy));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.resources[0]?.currencyOverride).toBeUndefined();
    }
  });

  it('rejects an hourlyRateDistribution with bad shape (missing mode)', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['resources'] as any[]).push({
      id: 'r1',
      name: 'Designer',
      capacity: 1,
      calendarId: 'cal-1',
      // mode missing — discriminated union requires it for triangular
      hourlyRateDistribution: { type: 'triangular', min: 80, max: 150 },
    });
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  // ── Phase 33: manual resource-leveling priority ─────────────────────────────

  it('accepts an activity with levelPriority', () => {
    const withPri = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (withPri['nodes'] as any[])[0]!['levelPriority'] = 5;
    const result = loadProjectFile(JSON.stringify(withPri));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.nodes[0]?.levelPriority).toBe(5);
    }
  });

  it('round-trips levelPriority through save / load', () => {
    const withPri = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (withPri['nodes'] as any[])[0]!['levelPriority'] = 10;
    const parsed = loadProjectFile(JSON.stringify(withPri));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const reSaved = JSON.parse(saveProjectFile(parsed.project)) as Record<string, unknown>;

      const reNode = (reSaved['nodes'] as any[])[0]!;
      expect(reNode['levelPriority']).toBe(10);
    }
  });

  it('accepts a decision node with levelPriority', () => {
    const withPri = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const node = (withPri['nodes'] as any[])[0]!;
    node['nodeType'] = 'decision';
    node['levelPriority'] = 3;
    const result = loadProjectFile(JSON.stringify(withPri));
    expect(result.ok).toBe(true);
  });

  it('treats absent levelPriority on legacy nodes as default 0', () => {
    // The schema field is optional; absence is the legacy default.
    const legacy = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;
    const result = loadProjectFile(JSON.stringify(legacy));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.nodes[0]?.levelPriority).toBeUndefined();
    }
  });

  it('rejects negative levelPriority', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[])[0]!['levelPriority'] = -1;
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects non-integer levelPriority', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[])[0]!['levelPriority'] = 2.5;
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects levelPriority on a start node', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const node = (bad['nodes'] as any[])[0]!;
    node['nodeType'] = 'start';
    node['duration'] = { value: 0, unit: 'hours' };
    node['anchorDate'] = '2026-01-01';
    node['levelPriority'] = 5;
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  // ── Phase 35: node + loop description ───────────────────────────────────────

  it('accepts a node with description', () => {
    const withDesc = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (withDesc['nodes'] as any[])[0]!['description'] = 'Per-vendor permit; assumes EPA portal up.';
    const result = loadProjectFile(JSON.stringify(withDesc));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.nodes[0]?.description).toBe(
        'Per-vendor permit; assumes EPA portal up.',
      );
    }
  });

  it('round-trips node description through save / load', () => {
    const withDesc = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;
    const text = 'Multi-line\nnotes with "quotes" and other chars.';

    (withDesc['nodes'] as any[])[0]!['description'] = text;
    const parsed = loadProjectFile(JSON.stringify(withDesc));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const reSaved = JSON.parse(saveProjectFile(parsed.project)) as Record<string, unknown>;

      const reNode = (reSaved['nodes'] as any[])[0]!;
      expect(reNode['description']).toBe(text);
    }
  });

  it('treats absent description on legacy nodes as undefined', () => {
    const legacy = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;
    const result = loadProjectFile(JSON.stringify(legacy));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.nodes[0]?.description).toBeUndefined();
    }
  });

  it('accepts a loop with description and round-trips it', () => {
    const withLoop: ProjectFile = {
      ...MINIMAL_VALID,
      loops: [
        {
          id: 'loop-1',
          bodyNodeIds: ['n1'],
          kickout: { type: 'maxIterations', value: 3 },
          expectedIterations: { type: 'triangular', min: 1, mode: 3, max: 5 },
          description: 'Iterate per regulatory market until coverage threshold met.',
        },
      ],
    };
    const result = loadProjectFile(saveProjectFile(withLoop));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.loops[0]?.description).toBe(
        'Iterate per regulatory market until coverage threshold met.',
      );
    }
  });

  // ── Phase 12: v1 → v2 migration ─────────────────────────────────────────────

  it('migrates a legacy v1 file forward to v4 on load', () => {
    // A v1 file (no `subsystems`, no currency / fxSnapshotVersion, no
    // durationSemantic) written by Phase 11 and earlier builds. loadProjectFile
    // chains v1 → v2 → v3 → v4.
    const v1 = ProjectFileV1.parse({
      version: 1,
      project: MINIMAL_VALID.project,
      calendars: MINIMAL_VALID.calendars,
      resources: [],
      nodes: [
        {
          id: 'n1',
          nodeType: 'activity',
          name: 'Task A',
          duration: { value: 8, unit: 'hours' },
          position: { x: 0, y: 0 },
          calendarId: null,
          consumesResources: true,
          resourceAssignments: [],
        },
      ],
      edges: [],
      loops: [],
      scenarios: [],
    });

    const json = JSON.stringify(v1);
    const result = loadProjectFile(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.version).toBe(8);
      expect(result.project.subsystems).toEqual([]);
      expect(result.project.currency).toBe('USD');
      expect(result.project.fxSnapshotVersion).toBe(LATEST_FX_SNAPSHOT_VERSION);
      expect(result.project.nodes[0]!.durationSemantic).toBe('time');
      expect(result.project.project.shareMode).toBe('percentage');
      // Data is preserved through chained migration
      expect(result.project.project.name).toBe(MINIMAL_VALID.project.name);
      expect(result.project.nodes).toHaveLength(1);
    }
  });

  it('migrateV1ToV2 adds subsystems: [] and bumps version (intermediate step)', () => {
    const v1 = ProjectFileV1.parse({
      version: 1,
      project: MINIMAL_VALID.project,
      calendars: MINIMAL_VALID.calendars,
      resources: [],
      nodes: MINIMAL_VALID.nodes,
      edges: [],
      loops: [],
      scenarios: [],
    });
    const v2 = migrateV1ToV2(v1);
    expect(v2.version).toBe(2);
    expect(v2.subsystems).toEqual([]);
    expect(v2.project).toEqual(v1.project);
    expect(v2.nodes).toEqual(v1.nodes);
  });

  // ── Phase 19: v2 → v3 migration ────────────────────────────────────────────

  it('migrates a v2 file forward to v5 on load (currency + fxSnapshotVersion + durationSemantic + shareMode all defaulted)', () => {
    const v2 = ProjectFileV2.parse({
      kind: 'caladia-project',
      version: 2,
      project: MINIMAL_VALID.project,
      calendars: MINIMAL_VALID.calendars,
      resources: [],
      nodes: MINIMAL_VALID.nodes,
      edges: [],
      loops: [],
      subsystems: [],
      scenarios: [],
    });
    const result = loadProjectFile(JSON.stringify(v2));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.version).toBe(8);
      expect(result.project.currency).toBe('USD');
      expect(result.project.fxSnapshotVersion).toBe(LATEST_FX_SNAPSHOT_VERSION);
      expect(result.project.project.shareMode).toBe('percentage');
      for (const node of result.project.nodes) {
        expect(node.durationSemantic).toBe('time');
      }
      // Round-trip a fresh save through the v5 parser — byte-identical to a
      // hand-stamped v5 save with the same data.
      const reparsed = loadProjectFile(saveProjectFile(result.project));
      expect(reparsed.ok).toBe(true);
      if (reparsed.ok) {
        expect(reparsed.project).toEqual(result.project);
      }
    }
  });

  it('migrateV2ToV3 is idempotent over chained calls', () => {
    const v2 = ProjectFileV2.parse({
      kind: 'caladia-project',
      version: 2,
      project: MINIMAL_VALID.project,
      calendars: MINIMAL_VALID.calendars,
      resources: [],
      nodes: MINIMAL_VALID.nodes,
      edges: [],
      loops: [],
      subsystems: [],
      scenarios: [],
    });
    const once = migrateV2ToV3(v2);
    // Calling loadProjectFile on the migrated v3 output should migrate it
    // forward once more to v4 — not double-stamp or alter the data.
    const result = loadProjectFile(JSON.stringify(once));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Now chains all the way through to v8 (backlog Slice 6 / I-18 added
      // `groupColors` and a V7→V8 stamp). The earlier link in the chain
      // (V5→V6) still seeds `comments: []`; V6→V7 is a pure version stamp
      // for projects without subsystems; V7→V8 sets `groupColors: {}`.
      expect(result.project.version).toBe(8);
      // Apart from the version bumps and the auto-seeded fields, the
      // result is byte-equal to the v3 intermediate.
      expect(result.project).toEqual({ ...once, version: 8, comments: [], groupColors: {} });
    }
  });

  // ── Phase 40: v3 → v4 migration ────────────────────────────────────────────

  it('migrates a v3 file forward through v4 and v5 on load', () => {
    // A v3 file (no durationSemantic on any node, no shareMode on project)
    // authored by a pre-Phase-40 build. NodeSchema's .default('time') auto-
    // fills durationSemantic; ProjectSettingsSchema's .default('percentage')
    // auto-fills shareMode; migrateV3ToV4 → migrateV4ToV5 bump the version
    // stamps.
    const v3Raw = {
      kind: 'caladia-project' as const,
      version: 3 as const,
      currency: 'USD',
      fxSnapshotVersion: LATEST_FX_SNAPSHOT_VERSION,
      project: MINIMAL_VALID.project,
      calendars: MINIMAL_VALID.calendars,
      resources: [],
      nodes: [
        {
          id: 'n1',
          nodeType: 'activity' as const,
          name: 'Task A',
          duration: { value: 5, unit: 'days' as const },
          position: { x: 0, y: 0 },
          calendarId: null,
          consumesResources: true,
          resourceAssignments: [],
        },
      ],
      edges: [],
      loops: [],
      subsystems: [],
      scenarios: [],
    };
    const result = loadProjectFile(JSON.stringify(v3Raw));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.version).toBe(8);
      expect(result.project.nodes[0]!.durationSemantic).toBe('time');
      expect(result.project.project.shareMode).toBe('percentage');
      // Re-saving and re-loading is a no-op — v5 stays v5.
      const reparsed = loadProjectFile(saveProjectFile(result.project));
      expect(reparsed.ok).toBe(true);
      if (reparsed.ok) {
        expect(reparsed.project).toEqual(result.project);
      }
    }
  });

  it('migrateV5ToV6 stamps version: 6 and seeds comments: []', async () => {
    const { migrateV5ToV6 } = await import('./load.js');
    const { ProjectFileV5 } = await import('./schema.js');
    const v5 = ProjectFileV5.parse({
      kind: 'caladia-project',
      version: 5,
      currency: MINIMAL_VALID.currency,
      fxSnapshotVersion: MINIMAL_VALID.fxSnapshotVersion,
      project: MINIMAL_VALID.project,
      calendars: MINIMAL_VALID.calendars,
      resources: MINIMAL_VALID.resources,
      nodes: MINIMAL_VALID.nodes,
      edges: [],
      loops: [],
      subsystems: [],
      scenarios: [],
    });
    const v6 = migrateV5ToV6(v5);
    expect(v6.version).toBe(6);
    expect(v6.comments).toEqual([]);
    expect(v6.nodes).toEqual(v5.nodes);
    expect(v6.project).toEqual(v5.project);
    // V5 → V6 → V7 → V8 round-trip — comments stay an empty array on
    // re-save/load. The save step needs a V8 input now that
    // `ProjectFile = V8`, so we chain through migrateV6ToV7 then
    // migrateV7ToV8. The load step re-runs the same chain.
    const { migrateV6ToV7, migrateV7ToV8 } = await import('./load.js');
    const reparsed = loadProjectFile(saveProjectFile(migrateV7ToV8(migrateV6ToV7(v6))));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.project.version).toBe(8);
      expect(reparsed.project.comments).toEqual([]);
    }
  });

  it('migrateV6ToV7 is a pure version stamp when no subsystems are present', async () => {
    const { migrateV5ToV6, migrateV6ToV7, migrateV7ToV8 } = await import('./load.js');
    const { ProjectFileV5 } = await import('./schema.js');
    const v5 = ProjectFileV5.parse({
      kind: 'caladia-project',
      version: 5,
      currency: MINIMAL_VALID.currency,
      fxSnapshotVersion: MINIMAL_VALID.fxSnapshotVersion,
      project: MINIMAL_VALID.project,
      calendars: MINIMAL_VALID.calendars,
      resources: MINIMAL_VALID.resources,
      nodes: MINIMAL_VALID.nodes,
      edges: [],
      loops: [],
      subsystems: [],
      scenarios: [],
    });
    const v6 = migrateV5ToV6(v5);
    const v7 = migrateV6ToV7(v6);
    expect(v7.version).toBe(7);
    // Empty-subsystems early-return path: V7 is byte-equal to V6 apart
    // from the version literal. Real auto-injection (3.5b) only fires
    // when there's at least one subsystem to migrate.
    expect({ ...v7, version: 6 }).toEqual(v6);
    // Save needs a V8 input now; load chains through to V8 on the way back.
    const v8 = migrateV7ToV8(v7);
    const reparsed = loadProjectFile(saveProjectFile(v8));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.project).toEqual(v8);
    }
  });

  it('migrateV6ToV7 auto-injects subsystemEntry/Exit for a legacy subsystem', async () => {
    const { migrateV6ToV7 } = await import('./load.js');
    // Build a V6-shaped project with one subsystem. Use the inline shape
    // (with type cast) rather than going through ProjectFileV6.parse so
    // we control the exact V6 invariants — entry/exit are user nodes,
    // not structural ports.
    const v6Subsystem: z.infer<typeof ProjectFileV6> = {
      kind: 'caladia-project',
      version: 6,
      currency: 'USD',
      fxSnapshotVersion: MINIMAL_VALID.fxSnapshotVersion,
      project: MINIMAL_VALID.project,
      calendars: MINIMAL_VALID.calendars,
      resources: [],
      nodes: [
        {
          id: 'container',
          nodeType: 'subsystem',
          name: 'Sub',
          duration: { value: 0, unit: 'hours' },
          durationSemantic: 'time',
          position: { x: 0, y: 0 },
          calendarId: null,
          consumesResources: false,
          resourceAssignments: [],
        },
        {
          id: 'body1',
          nodeType: 'activity',
          name: 'Body 1',
          duration: { value: 4, unit: 'hours' },
          durationSemantic: 'time',
          position: { x: 100, y: 0 },
          calendarId: null,
          consumesResources: true,
          resourceAssignments: [],
        },
        {
          id: 'body2',
          nodeType: 'activity',
          name: 'Body 2',
          duration: { value: 4, unit: 'hours' },
          durationSemantic: 'time',
          position: { x: 200, y: 0 },
          calendarId: null,
          consumesResources: true,
          resourceAssignments: [],
        },
      ],
      edges: [],
      loops: [],
      subsystems: [
        {
          id: 'sub1',
          containerNodeId: 'container',
          bodyNodeIds: ['body1', 'body2'],
          entryNodeId: 'body1',
          exitNodeId: 'body2',
        },
      ],
      scenarios: [],
      comments: [],
    };

    // Deterministic id source for the test — sequential strings make the
    // assertions stable.
    let counter = 0;
    const v7 = migrateV6ToV7(v6Subsystem, () => `gen-${counter++}`);

    // 2 structural nodes added (entry + exit) for the one subsystem.
    expect(v7.nodes).toHaveLength(v6Subsystem.nodes.length + 2);
    const structuralEntry = v7.nodes.find((n) => n.nodeType === 'subsystemEntry');
    const structuralExit = v7.nodes.find((n) => n.nodeType === 'subsystemExit');
    expect(structuralEntry).toBeDefined();
    expect(structuralExit).toBeDefined();

    // Structural nodes are zero-duration, no resources.
    expect(structuralEntry?.duration.value).toBe(0);
    expect(structuralEntry?.consumesResources).toBe(false);
    expect(structuralExit?.duration.value).toBe(0);

    // Subsystem entry/exit now reference the structural nodes.
    const sub = v7.subsystems[0]!;
    expect(sub.entryNodeId).toBe(structuralEntry!.id);
    expect(sub.exitNodeId).toBe(structuralExit!.id);
    // Body ordering: structuralEntry first, then legacy body, then structuralExit.
    expect(sub.bodyNodeIds).toEqual([structuralEntry!.id, 'body1', 'body2', structuralExit!.id]);

    // 2 bookend edges added (structuralEntry → body1, body2 → structuralExit).
    expect(v7.edges).toHaveLength(2);
    expect(v7.edges.some((e) => e.from === structuralEntry!.id && e.to === 'body1')).toBe(true);
    expect(v7.edges.some((e) => e.from === 'body2' && e.to === structuralExit!.id)).toBe(true);

    // Structural-node positions: a 60 px gap between the wedge and the
    // natural entry / exit (with the natural exit's width factored in so
    // the wedge clears the rectangle on the right). See migrateV6ToV7's
    // STRUCTURAL_PORT_WIDTH / GAP / NATURAL_NODE_DEFAULT_WIDTH constants.
    expect(structuralEntry?.position.x).toBe(100 - 44 - 60); // -4
    expect(structuralExit?.position.x).toBe(200 + 160 + 60); // 420

    // V7 superRefine passes — the migrated file is a valid V7 ProjectFile.
    const { migrateV7ToV8 } = await import('./load.js');
    const reparsed = loadProjectFile(saveProjectFile(migrateV7ToV8(v7)));
    expect(reparsed.ok).toBe(true);
  });

  it('migrateV6ToV7 handles multiple subsystems independently', async () => {
    const { migrateV6ToV7, migrateV7ToV8 } = await import('./load.js');
    const v6: z.infer<typeof ProjectFileV6> = {
      kind: 'caladia-project',
      version: 6,
      currency: 'USD',
      fxSnapshotVersion: MINIMAL_VALID.fxSnapshotVersion,
      project: MINIMAL_VALID.project,
      calendars: MINIMAL_VALID.calendars,
      resources: [],
      nodes: ['c1', 'b1', 'c2', 'b2'].map((id, i) => ({
        id,
        nodeType: id.startsWith('c') ? ('subsystem' as const) : ('activity' as const),
        name: id,
        duration: { value: id.startsWith('c') ? 0 : 4, unit: 'hours' as const },
        durationSemantic: 'time' as const,
        position: { x: i * 100, y: 0 },
        calendarId: null,
        consumesResources: !id.startsWith('c'),
        resourceAssignments: [],
      })),
      edges: [],
      loops: [],
      subsystems: [
        {
          id: 's1',
          containerNodeId: 'c1',
          bodyNodeIds: ['b1'],
          entryNodeId: 'b1',
          exitNodeId: 'b1',
        },
        {
          id: 's2',
          containerNodeId: 'c2',
          bodyNodeIds: ['b2'],
          entryNodeId: 'b2',
          exitNodeId: 'b2',
        },
      ],
      scenarios: [],
      comments: [],
    };
    let counter = 0;
    const v7 = migrateV6ToV7(v6, () => `gen-${counter++}`);
    // 2 subsystems × 2 structural nodes each.
    expect(v7.nodes.filter((n) => n.nodeType === 'subsystemEntry')).toHaveLength(2);
    expect(v7.nodes.filter((n) => n.nodeType === 'subsystemExit')).toHaveLength(2);
    // 2 subsystems × 2 bookend edges each.
    expect(v7.edges).toHaveLength(4);
    // Each subsystem's entry/exit reference different structural nodes.
    expect(v7.subsystems[0]!.entryNodeId).not.toBe(v7.subsystems[1]!.entryNodeId);
    expect(v7.subsystems[0]!.exitNodeId).not.toBe(v7.subsystems[1]!.exitNodeId);
    // V7 superRefine passes.
    const reparsed = loadProjectFile(saveProjectFile(migrateV7ToV8(v7)));
    expect(reparsed.ok).toBe(true);
  });

  // ── V7 → V8 migration (backlog Slice 6 / audit I-18) ──────────────────────

  it('migrateV7ToV8 seeds an empty groupColors map and bumps version', async () => {
    const { migrateV6ToV7, migrateV7ToV8 } = await import('./load.js');
    const v6: z.infer<typeof ProjectFileV6> = {
      kind: 'caladia-project',
      version: 6,
      currency: 'USD',
      fxSnapshotVersion: MINIMAL_VALID.fxSnapshotVersion,
      project: MINIMAL_VALID.project,
      calendars: MINIMAL_VALID.calendars,
      resources: [],
      nodes: MINIMAL_VALID.nodes,
      edges: [],
      loops: [],
      subsystems: [],
      scenarios: [],
      comments: [],
    };
    const v7 = migrateV6ToV7(v6);
    const v8 = migrateV7ToV8(v7);
    expect(v8.version).toBe(8);
    expect(v8.groupColors).toEqual({});
    // Byte-equal to V7 apart from the version stamp + new groupColors field.
    expect({ ...v8, version: 7, groupColors: undefined }).toEqual({
      ...v7,
      groupColors: undefined,
    });
  });

  it('a V7 file (no groupColors field) auto-migrates to V8 on load', () => {
    // Build a V7-shaped JSON by hand — explicitly omits the groupColors
    // field so we exercise the V7 → V8 migration path on the load side.
    const v7Json = JSON.stringify({
      ...MINIMAL_VALID,
      version: 7,
      // Cast to drop groupColors from the V8 fixture.
      groupColors: undefined,
    });
    const result = loadProjectFile(v7Json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.version).toBe(8);
      expect(result.project.groupColors).toEqual({});
    }
  });

  it('V8 round-trips a non-empty groupColors map verbatim', () => {
    const withColors: ProjectFile = {
      ...MINIMAL_VALID,
      groupColors: { Finance: '#6366f1', Engineering: '#10b981' },
    };
    const result = loadProjectFile(saveProjectFile(withColors));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.groupColors).toEqual({
        Finance: '#6366f1',
        Engineering: '#10b981',
      });
    }
  });

  it('V8 rejects a malformed hex color in groupColors', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;
    bad['groupColors'] = { Finance: 'not-a-hex' };
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /hex/i.test(e.message))).toBe(true);
    }
  });

  it('V7 superRefine rejects a subsystem whose entryNodeId is not a structural-port node', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[]).push(
      {
        id: 'container',
        nodeType: 'subsystem',
        name: 'Sub',
        duration: { value: 0, unit: 'hours' },
        position: { x: 0, y: 0 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      },
      {
        id: 'body',
        nodeType: 'activity',
        name: 'Body',
        duration: { value: 4, unit: 'hours' },
        position: { x: 100, y: 0 },
        calendarId: null,
        consumesResources: true,
        resourceAssignments: [],
      },
      {
        id: 'exit-port',
        nodeType: 'subsystemExit',
        name: 'Exit',
        duration: { value: 0, unit: 'hours' },
        position: { x: 200, y: 0 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      },
    );
    bad['subsystems'] = [
      {
        id: 'sub1',
        containerNodeId: 'container',
        bodyNodeIds: ['body', 'exit-port'],
        entryNodeId: 'body',
        exitNodeId: 'exit-port',
      },
    ];
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) =>
          e.message.includes("must reference a node with nodeType 'subsystemEntry'"),
        ),
      ).toBe(true);
    }
  });

  it('V7 superRefine rejects an orphan subsystemEntry node (not claimed by any subsystem)', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[]).push({
      id: 'orphan',
      nodeType: 'subsystemEntry',
      name: 'Orphan',
      duration: { value: 0, unit: 'hours' },
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    });
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes('orphan subsystemEntry'))).toBe(true);
    }
  });

  it('migrateV3ToV4 is a pure version stamp; data is preserved', () => {
    const v3 = ProjectFileV3.parse({
      kind: 'caladia-project',
      version: 3,
      currency: 'USD',
      fxSnapshotVersion: LATEST_FX_SNAPSHOT_VERSION,
      project: MINIMAL_VALID.project,
      calendars: MINIMAL_VALID.calendars,
      resources: [],
      nodes: MINIMAL_VALID.nodes,
      edges: [],
      loops: [],
      subsystems: [],
      scenarios: [],
    });
    const v4 = migrateV3ToV4(v3);
    expect(v4.version).toBe(4);
    expect(v4.nodes).toEqual(v3.nodes);
    expect(v4.project).toEqual(v3.project);
    expect(v4.currency).toEqual(v3.currency);
  });

  // ── Phase 19: cost fields ──────────────────────────────────────────────────

  it('accepts a v3 project with cost fields on resources and a node', () => {
    const withCost: ProjectFile = {
      ...MINIMAL_VALID,
      currency: 'EUR',
      budget: 50_000,
      resources: [
        {
          id: 'r1',
          name: 'Engineer',
          capacity: 1,
          calendarId: 'cal-1',
          costRate: 100,
          costPerUse: 50,
        },
      ],
      nodes: [
        {
          ...MINIMAL_VALID.nodes[0]!,
          fixedCost: { value: 200 },
        },
      ],
    };
    const result = loadProjectFile(saveProjectFile(withCost));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.currency).toBe('EUR');
      expect(result.project.budget).toBe(50_000);
      expect(result.project.resources[0]?.costRate).toBe(100);
      expect(result.project.resources[0]?.costPerUse).toBe(50);
      expect(result.project.nodes[0]?.fixedCost?.value).toBe(200);
    }
  });

  it('rejects negative costRate', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;
    bad['resources'] = [{ id: 'r1', name: 'X', capacity: 1, calendarId: 'cal-1', costRate: -1 }];
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects negative costPerUse', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;
    bad['resources'] = [{ id: 'r1', name: 'X', capacity: 1, calendarId: 'cal-1', costPerUse: -10 }];
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects negative fixedCost.value', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[])[0]['fixedCost'] = { value: -1 };
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects fixedCost with a distribution but value === 0', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[])[0]['fixedCost'] = {
      value: 0,
      distribution: { type: 'triangular', min: 0, mode: 0, max: 0 },
    };
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects fixedCost on a start node', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const nodes = bad['nodes'] as any[];
    nodes[0]!['nodeType'] = 'start';
    nodes[0]!['duration'] = { value: 0, unit: 'hours' };
    nodes[0]!['fixedCost'] = { value: 100 };
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects fixedCostOnce on a node that is not a loop body member', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[])[0]['fixedCostOnce'] = true;
    // no loops → membership check fails
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('accepts fixedCostOnce on a node that IS a loop body member', () => {
    const withLoop: ProjectFile = {
      ...MINIMAL_VALID,
      nodes: [
        {
          ...MINIMAL_VALID.nodes[0]!,
          fixedCost: { value: 50 },
          fixedCostOnce: true,
        },
      ],
      loops: [
        {
          id: 'loop-1',
          bodyNodeIds: ['n1'],
          kickout: { type: 'maxIterations', value: 3 },
          expectedIterations: { type: 'triangular', min: 1, mode: 3, max: 5 },
        },
      ],
    };
    const result = loadProjectFile(saveProjectFile(withLoop));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.nodes[0]?.fixedCostOnce).toBe(true);
    }
  });

  it('rejects a malformed currency code', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;
    bad['currency'] = 'us'; // lowercase, too short
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects a negative budget', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;
    bad['budget'] = -1;
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  // ── Phase 25: crashOptions / selectedCrashIndex ──────────────────────────────

  it('round-trips crashOptions + selectedCrashIndex on an activity node', () => {
    const withCrash: ProjectFile = {
      ...MINIMAL_VALID,
      nodes: [
        {
          ...MINIMAL_VALID.nodes[0]!,
          crashOptions: [
            { duration: { value: 6, unit: 'hours' }, additionalCost: 500 },
            { duration: { value: 4, unit: 'hours' }, additionalCost: 1500 },
          ],
          selectedCrashIndex: 1,
        },
      ],
    };
    const result = loadProjectFile(saveProjectFile(withCrash));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const n = result.project.nodes[0]!;
      expect(n.crashOptions).toHaveLength(2);
      expect(n.crashOptions?.[0]?.duration.value).toBe(6);
      expect(n.crashOptions?.[1]?.additionalCost).toBe(1500);
      expect(n.selectedCrashIndex).toBe(1);
    }
  });

  it('rejects a crashOption whose duration is >= node.duration (must compress)', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[])[0]['crashOptions'] = [
      { duration: { value: 8, unit: 'hours' }, additionalCost: 100 }, // equal — must be strictly less
    ];
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects a crashOption whose unit differs from node.duration.unit', () => {
    // Node is 8 hours; the crash option is 0.5 days. Even though canonically
    // shorter, the schema requires same-unit so the comparison stays calendar-
    // free and unambiguous at parse time.
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[])[0]['crashOptions'] = [
      { duration: { value: 0.5, unit: 'days' }, additionalCost: 100 },
    ];
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects a negative crashOption.additionalCost', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[])[0]['crashOptions'] = [
      { duration: { value: 4, unit: 'hours' }, additionalCost: -50 },
    ];
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects selectedCrashIndex when it does not reference a valid option', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const nodes = bad['nodes'] as any[];
    nodes[0]['crashOptions'] = [{ duration: { value: 4, unit: 'hours' }, additionalCost: 100 }];
    nodes[0]['selectedCrashIndex'] = 1; // out of range — only index 0 exists
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects selectedCrashIndex when crashOptions is absent', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[])[0]['selectedCrashIndex'] = 0;
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects crashOptions on a start node', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const nodes = bad['nodes'] as any[];
    nodes[0]['nodeType'] = 'start';
    nodes[0]['duration'] = { value: 0, unit: 'hours' };
    nodes[0]['crashOptions'] = [{ duration: { value: 0, unit: 'hours' }, additionalCost: 100 }];
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('accepts crashOptions on a decision node', () => {
    const withCrashDecision: ProjectFile = {
      ...MINIMAL_VALID,
      nodes: [
        {
          ...MINIMAL_VALID.nodes[0]!,
          nodeType: 'decision',
          passProbability: 0.8,
          crashOptions: [{ duration: { value: 4, unit: 'hours' }, additionalCost: 200 }],
        },
      ],
    };
    const result = loadProjectFile(saveProjectFile(withCrashDecision));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.nodes[0]?.crashOptions).toHaveLength(1);
    }
  });

  // ── Phase 26 follow-up: crashOption.resourceCostMultiplier ───────────────────

  it('round-trips a crashOption with resourceCostMultiplier', () => {
    const withMult: ProjectFile = {
      ...MINIMAL_VALID,
      nodes: [
        {
          ...MINIMAL_VALID.nodes[0]!,
          crashOptions: [
            {
              duration: { value: 4, unit: 'hours' },
              additionalCost: 0,
              resourceCostMultiplier: 1.5,
            },
          ],
        },
      ],
    };
    const result = loadProjectFile(saveProjectFile(withMult));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.nodes[0]?.crashOptions?.[0]?.resourceCostMultiplier).toBe(1.5);
    }
  });

  it('accepts crashOption without resourceCostMultiplier (legacy / default 1.0)', () => {
    const result = loadProjectFile(saveProjectFile(MINIMAL_VALID));
    expect(result.ok).toBe(true);
    // The absence of the field is normal — Phase 25 Slice 1 files don't have it.
  });

  it('rejects resourceCostMultiplier === 0 (must be strictly positive)', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[])[0]['crashOptions'] = [
      {
        duration: { value: 4, unit: 'hours' },
        additionalCost: 0,
        resourceCostMultiplier: 0,
      },
    ];
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects a negative resourceCostMultiplier', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[])[0]['crashOptions'] = [
      {
        duration: { value: 4, unit: 'hours' },
        additionalCost: 0,
        resourceCostMultiplier: -1.5,
      },
    ];
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  // ── Phase 12: subsystem nodes ────────────────────────────────────────────────

  it('accepts a subsystem node with zero duration (V7 structural-port shape)', () => {
    const withSub = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;
    // Container node on the parent canvas.

    (withSub['nodes'] as any[]).push({
      id: 'container',
      nodeType: 'subsystem',
      name: 'Sub-system',
      duration: { value: 0, unit: 'hours' },
      position: { x: 200, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    });
    // V7 — body now requires a structuralEntry / structuralExit pair around
    // the user-facing body node. The structural nodes are zero-duration
    // anchors with no resources.

    (withSub['nodes'] as any[]).push({
      id: 'sub-entry',
      nodeType: 'subsystemEntry',
      name: 'Entry',
      duration: { value: 0, unit: 'hours' },
      position: { x: 220, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    });

    (withSub['nodes'] as any[]).push({
      id: 'body1',
      nodeType: 'activity',
      name: 'Body Node',
      duration: { value: 4, unit: 'hours' },
      position: { x: 250, y: 0 },
      calendarId: null,
      consumesResources: true,
      resourceAssignments: [],
    });

    (withSub['nodes'] as any[]).push({
      id: 'sub-exit',
      nodeType: 'subsystemExit',
      name: 'Exit',
      duration: { value: 0, unit: 'hours' },
      position: { x: 280, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    });
    withSub['subsystems'] = [
      {
        id: 'sub1',
        containerNodeId: 'container',
        bodyNodeIds: ['sub-entry', 'body1', 'sub-exit'],
        entryNodeId: 'sub-entry',
        exitNodeId: 'sub-exit',
      },
    ];
    const result = loadProjectFile(JSON.stringify(withSub));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.subsystems).toHaveLength(1);
      expect(result.project.subsystems[0]?.containerNodeId).toBe('container');
      expect(result.project.subsystems[0]?.entryNodeId).toBe('sub-entry');
      expect(result.project.subsystems[0]?.exitNodeId).toBe('sub-exit');
    }
  });

  it('rejects a subsystem node with non-zero duration', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[])[0]['nodeType'] = 'subsystem';
    // node n1 has duration.value = 8, which is > 0 — should be rejected
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects a subsystem descriptor whose containerNodeId references a non-subsystem node', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;
    bad['subsystems'] = [
      {
        id: 'sub1',
        containerNodeId: 'n1', // n1 is an 'activity', not 'subsystem'
        bodyNodeIds: ['n1'],
        entryNodeId: 'n1',
        exitNodeId: 'n1',
      },
    ];
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects a subsystem descriptor whose entryNodeId is not in bodyNodeIds', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[]).push({
      id: 'container',
      nodeType: 'subsystem',
      name: 'Sub',
      duration: { value: 0, unit: 'hours' },
      position: { x: 100, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    });
    bad['subsystems'] = [
      {
        id: 'sub1',
        containerNodeId: 'container',
        bodyNodeIds: ['n1'],
        entryNodeId: 'does-not-exist', // not in bodyNodeIds
        exitNodeId: 'n1',
      },
    ];
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  // Phase 50 Slice 20 — audit row I-3. The schema previously accepted
  // nested-subsystem cycles (A.body ⊃ cB; B.body ⊃ cA); downstream
  // `flatten.ts`'s `nestingDepth` silently returns 0 and produces
  // non-deterministic schedules. Now: reject at load with a cycle path.
  it('rejects a direct 2-cycle in subsystem nesting (A↔B) — audit I-3', () => {
    const base = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (base['nodes'] as any[]).push(
      // Subsystem containers
      {
        id: 'cA',
        nodeType: 'subsystem',
        name: 'A',
        duration: { value: 0, unit: 'hours' },
        position: { x: 100, y: 0 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      },
      {
        id: 'cB',
        nodeType: 'subsystem',
        name: 'B',
        duration: { value: 0, unit: 'hours' },
        position: { x: 300, y: 0 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      },
      // Structural ports for A
      {
        id: 'eA',
        nodeType: 'subsystemEntry',
        name: 'A entry',
        duration: { value: 0, unit: 'hours' },
        position: { x: 110, y: 0 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      },
      {
        id: 'xA',
        nodeType: 'subsystemExit',
        name: 'A exit',
        duration: { value: 0, unit: 'hours' },
        position: { x: 190, y: 0 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      },
      // Structural ports for B
      {
        id: 'eB',
        nodeType: 'subsystemEntry',
        name: 'B entry',
        duration: { value: 0, unit: 'hours' },
        position: { x: 310, y: 0 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      },
      {
        id: 'xB',
        nodeType: 'subsystemExit',
        name: 'B exit',
        duration: { value: 0, unit: 'hours' },
        position: { x: 390, y: 0 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      },
    );
    base['subsystems'] = [
      {
        id: 'subA',
        containerNodeId: 'cA',
        bodyNodeIds: ['eA', 'xA', 'cB'],
        entryNodeId: 'eA',
        exitNodeId: 'xA',
      },
      {
        id: 'subB',
        containerNodeId: 'cB',
        bodyNodeIds: ['eB', 'xB', 'cA'],
        entryNodeId: 'eB',
        exitNodeId: 'xB',
      },
    ];
    const result = loadProjectFile(JSON.stringify(base));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /nesting cycle/i.test(e.message))).toBe(true);
    }
  });

  it('rejects a 3-cycle in subsystem nesting (A→B→C→A) — audit I-3', () => {
    const base = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const nodes = base['nodes'] as any[];
    for (const id of ['cA', 'cB', 'cC']) {
      nodes.push({
        id,
        nodeType: 'subsystem',
        name: id.toUpperCase(),
        duration: { value: 0, unit: 'hours' },
        position: { x: 0, y: 0 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      });
    }
    for (const id of ['eA', 'xA', 'eB', 'xB', 'eC', 'xC']) {
      const t = id.startsWith('e') ? 'subsystemEntry' : 'subsystemExit';
      nodes.push({
        id,
        nodeType: t,
        name: id,
        duration: { value: 0, unit: 'hours' },
        position: { x: 0, y: 0 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      });
    }
    base['subsystems'] = [
      {
        id: 'subA',
        containerNodeId: 'cA',
        bodyNodeIds: ['eA', 'xA', 'cB'],
        entryNodeId: 'eA',
        exitNodeId: 'xA',
      },
      {
        id: 'subB',
        containerNodeId: 'cB',
        bodyNodeIds: ['eB', 'xB', 'cC'],
        entryNodeId: 'eB',
        exitNodeId: 'xB',
      },
      {
        id: 'subC',
        containerNodeId: 'cC',
        bodyNodeIds: ['eC', 'xC', 'cA'],
        entryNodeId: 'eC',
        exitNodeId: 'xC',
      },
    ];
    const result = loadProjectFile(JSON.stringify(base));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /nesting cycle/i.test(e.message))).toBe(true);
    }
  });

  it('accepts valid nested subsystem chain A ⊃ B ⊃ C (no cycle) — audit I-3 positive', () => {
    const base = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    const nodes = base['nodes'] as any[];
    for (const id of ['cA', 'cB', 'cC']) {
      nodes.push({
        id,
        nodeType: 'subsystem',
        name: id.toUpperCase(),
        duration: { value: 0, unit: 'hours' },
        position: { x: 0, y: 0 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      });
    }
    for (const id of ['eA', 'xA', 'eB', 'xB', 'eC', 'xC']) {
      const t = id.startsWith('e') ? 'subsystemEntry' : 'subsystemExit';
      nodes.push({
        id,
        nodeType: t,
        name: id,
        duration: { value: 0, unit: 'hours' },
        position: { x: 0, y: 0 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      });
    }
    // A contains B's container; B contains C's container; C has no children.
    base['subsystems'] = [
      {
        id: 'subA',
        containerNodeId: 'cA',
        bodyNodeIds: ['eA', 'xA', 'cB'],
        entryNodeId: 'eA',
        exitNodeId: 'xA',
      },
      {
        id: 'subB',
        containerNodeId: 'cB',
        bodyNodeIds: ['eB', 'xB', 'cC'],
        entryNodeId: 'eB',
        exitNodeId: 'xB',
      },
      {
        id: 'subC',
        containerNodeId: 'cC',
        bodyNodeIds: ['eC', 'xC'],
        entryNodeId: 'eC',
        exitNodeId: 'xC',
      },
    ];
    const result = loadProjectFile(JSON.stringify(base));
    expect(result.ok).toBe(true);
  });

  it('rejects when two subsystems share a body node', () => {
    const base = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (base['nodes'] as any[]).push(
      {
        id: 'c1',
        nodeType: 'subsystem',
        name: 'Sub1',
        duration: { value: 0, unit: 'hours' },
        position: { x: 100, y: 0 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      },
      {
        id: 'c2',
        nodeType: 'subsystem',
        name: 'Sub2',
        duration: { value: 0, unit: 'hours' },
        position: { x: 300, y: 0 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      },
    );
    base['subsystems'] = [
      {
        id: 'sub1',
        containerNodeId: 'c1',
        bodyNodeIds: ['n1'],
        entryNodeId: 'n1',
        exitNodeId: 'n1',
      },
      {
        id: 'sub2',
        containerNodeId: 'c2',
        bodyNodeIds: ['n1'],
        entryNodeId: 'n1',
        exitNodeId: 'n1',
      }, // n1 in both
    ];
    const result = loadProjectFile(JSON.stringify(base));
    expect(result.ok).toBe(false);
  });

  // ── Phase 19 slice 4: FX update banner ──────────────────────────────────

  it('does not surface fxUpdatesAvailable when project is pinned to the latest snapshot', () => {
    const result = loadProjectFile(saveProjectFile(MINIMAL_VALID));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fxUpdatesAvailable).toBeUndefined();
    }
  });

  it('surfaces fxUpdatesAvailable when project pins to an older bundled snapshot', () => {
    const withOlderFx: ProjectFile = { ...MINIMAL_VALID, fxSnapshotVersion: '2026.0' };
    const result = loadProjectFile(saveProjectFile(withOlderFx));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fxUpdatesAvailable).toEqual({
        currentVersion: '2026.0',
        latestVersion: '2026.1',
      });
    }
  });

  it('does not surface fxUpdatesAvailable when project is pinned to NONE', () => {
    const withNone: ProjectFile = { ...MINIMAL_VALID, fxSnapshotVersion: 'NONE' };
    const result = loadProjectFile(saveProjectFile(withNone));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fxUpdatesAvailable).toBeUndefined();
    }
  });

  it('does not surface fxUpdatesAvailable when project pins to an unknown version (forward compat)', () => {
    const withFuture: ProjectFile = { ...MINIMAL_VALID, fxSnapshotVersion: '2099.99' };
    const result = loadProjectFile(saveProjectFile(withFuture));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fxUpdatesAvailable).toBeUndefined();
    }
  });

  // ── Phase 23 — resourceAssignment.parallelism (Slice 1) ────────────────

  it('round-trips a resourceAssignment with parallelism: 0.5', () => {
    const project: ProjectFile = {
      ...MINIMAL_VALID,
      resources: [
        {
          id: 'r1',
          name: 'Dev Pool',
          capacity: 2,
          calendarId: 'cal-1',
          costRate: 100,
          costPerUse: 0,
        },
      ],
      nodes: [
        {
          ...MINIMAL_VALID.nodes[0]!,
          resourceAssignments: [
            {
              resourceId: 'r1',
              count: 2,
              calendarPolicy: 'intersection',
              parallelism: 0.5,
            },
          ],
        },
      ],
    };
    const result = loadProjectFile(saveProjectFile(project));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const a = result.project.nodes[0]!.resourceAssignments[0]!;
      expect(a.parallelism).toBe(0.5);
    }
  });

  it('accepts boundary values 0 and 1 for parallelism', () => {
    for (const value of [0, 1]) {
      const project: ProjectFile = {
        ...MINIMAL_VALID,
        resources: [
          { id: 'r1', name: 'Dev', capacity: 1, calendarId: 'cal-1', costRate: 0, costPerUse: 0 },
        ],
        nodes: [
          {
            ...MINIMAL_VALID.nodes[0]!,
            resourceAssignments: [
              { resourceId: 'r1', count: 1, calendarPolicy: 'intersection', parallelism: value },
            ],
          },
        ],
      };
      const result = loadProjectFile(saveProjectFile(project));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.project.nodes[0]!.resourceAssignments[0]!.parallelism).toBe(value);
      }
    }
  });

  it('rejects parallelism out of [0, 1]', () => {
    for (const value of [-0.1, 1.5]) {
      const bad: ProjectFile = {
        ...MINIMAL_VALID,
        resources: [
          { id: 'r1', name: 'Dev', capacity: 1, calendarId: 'cal-1', costRate: 0, costPerUse: 0 },
        ],
        nodes: [
          {
            ...MINIMAL_VALID.nodes[0]!,
            resourceAssignments: [
              { resourceId: 'r1', count: 1, calendarPolicy: 'intersection', parallelism: value },
            ],
          },
        ],
      };
      const result = loadProjectFile(JSON.stringify(bad));
      expect(result.ok).toBe(false);
    }
  });

  it('treats absent parallelism as a legacy file (loads cleanly, field undefined)', () => {
    // Construct a v3 file with resourceAssignment that omits the field.
    const legacy: ProjectFile = {
      ...MINIMAL_VALID,
      resources: [
        { id: 'r1', name: 'Dev', capacity: 1, calendarId: 'cal-1', costRate: 0, costPerUse: 0 },
      ],
      nodes: [
        {
          ...MINIMAL_VALID.nodes[0]!,
          resourceAssignments: [{ resourceId: 'r1', count: 1, calendarPolicy: 'intersection' }],
        },
      ],
    };
    const result = loadProjectFile(saveProjectFile(legacy));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const a = result.project.nodes[0]!.resourceAssignments[0]!;
      expect(a.parallelism).toBeUndefined();
    }
  });

  // ── Audit I-5 — error-version pick ──────────────────────────────────────────

  it('audit I-5: prefers the discriminator-matching version when nothing parses', () => {
    // Take a current v7 file, downgrade `version` to 3, and break a single
    // node duration. v3 reports one issue (the bad duration); v7 reports
    // that issue PLUS "version literal must be 7" plus any v7-only required
    // field complaints. Pre-fix the user saw the v7 wall of noise; post-fix
    // the report is the focused v3 list.
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;
    bad['version'] = 3;

    (bad['nodes'] as any[])[0]!['duration']['value'] = -5;
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The bad duration issue is present.
      expect(
        result.errors.some((e) => e.path.includes('duration') || /duration/i.test(e.message)),
      ).toBe(true);
      // No v7-discriminator complaint — would look like "Invalid literal value, expected 7"
      // at path "version" if the v7 candidate had been picked.
      expect(result.errors.every((e) => e.path !== 'version')).toBe(true);
    }
  });

  it('audit I-5: falls back to fewest-issues when version field is absent', () => {
    // Strip `version` entirely. None of v1..v7 will accept the file because
    // each requires `version: z.literal(N)`. The reducer should pick the
    // smallest issue list across the seven candidates rather than always
    // returning v7's.
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;
    delete bad['version'];

    (bad['nodes'] as any[])[0]!['duration']['value'] = -5;
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The negative duration appears in the chosen candidate's report.
      expect(
        result.errors.some((e) => e.path.includes('duration') || /duration/i.test(e.message)),
      ).toBe(true);
    }
  });

  it('audit I-5: a corrupted current-version file still surfaces v7 errors', () => {
    // Regression guard — when the file declares version: 7 and is corrupted,
    // the picker honours the discriminator and surfaces v7's issue list.
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;

    (bad['nodes'] as any[])[0]!['duration']['value'] = -5;
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.path.includes('duration') || /duration/i.test(e.message)),
      ).toBe(true);
    }
  });
});

// ── loadSubsystemFile ─────────────────────────────────────────────────────────

describe('loadSubsystemFile', () => {
  const MINIMAL_SUBSYSTEM: SubsystemFile = {
    kind: 'caladia-subsystem',
    version: 4,
    name: 'My Sub-system',
    nodes: [
      {
        id: 'entry',
        nodeType: 'activity',
        name: 'Entry Step',
        duration: { value: 4, unit: 'hours' },
        durationSemantic: 'time',
        position: { x: 0, y: 0 },
        calendarId: null,
        consumesResources: true,
        resourceAssignments: [],
      },
      {
        id: 'exit',
        nodeType: 'activity',
        name: 'Exit Step',
        duration: { value: 4, unit: 'hours' },
        durationSemantic: 'time',
        position: { x: 200, y: 0 },
        calendarId: null,
        consumesResources: true,
        resourceAssignments: [],
      },
    ],
    edges: [{ id: 'e1', from: 'entry', to: 'exit', type: 'FS', lag: { value: 0, unit: 'hours' } }],
    loops: [],
    calendars: [],
    resources: [],
    entryNodeId: 'entry',
    exitNodeId: 'exit',
    subsystems: [],
  };

  it('parses a valid .calasub file', () => {
    const json = saveSubsystemFile(MINIMAL_SUBSYSTEM);
    const result = loadSubsystemFile(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subsystem.name).toBe('My Sub-system');
      expect(result.subsystem.nodes).toHaveLength(2);
      expect(result.subsystem.entryNodeId).toBe('entry');
      expect(result.subsystem.exitNodeId).toBe('exit');
    }
  });

  it('rejects invalid JSON', () => {
    const result = loadSubsystemFile('{bad json');
    expect(result.ok).toBe(false);
  });

  it('rejects a ProjectFile-shaped input (kind discriminator catches it)', () => {
    const json = saveProjectFile(MINIMAL_VALID);
    const result = loadSubsystemFile(json);
    expect(result.ok).toBe(false);
  });

  it('rejects when entryNodeId references a non-existent node', () => {
    const bad: SubsystemFile = {
      ...MINIMAL_SUBSYSTEM,
      entryNodeId: 'does-not-exist',
    };
    const result = loadSubsystemFile(saveSubsystemFile(bad));
    expect(result.ok).toBe(false);
  });

  it('rejects when exitNodeId references a non-existent node', () => {
    const bad: SubsystemFile = {
      ...MINIMAL_SUBSYSTEM,
      exitNodeId: 'does-not-exist',
    };
    const result = loadSubsystemFile(saveSubsystemFile(bad));
    expect(result.ok).toBe(false);
  });

  it('round-trips a subsystem file cleanly', () => {
    const json = saveSubsystemFile(MINIMAL_SUBSYSTEM);
    const r1 = loadSubsystemFile(json);
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      const r2 = loadSubsystemFile(saveSubsystemFile(r1.subsystem));
      expect(r2.ok).toBe(true);
      if (r2.ok) {
        expect(r2.subsystem).toEqual(r1.subsystem);
      }
    }
  });

  // Audit I-4 — V7-shaped nested subsystem (structural-port entry / exit).
  // Reused across the invariant-violation tests below as the valid base.
  function nestedSubBase(): SubsystemFile {
    return {
      ...MINIMAL_SUBSYSTEM,
      nodes: [
        ...MINIMAL_SUBSYSTEM.nodes,
        {
          id: 'inner-container',
          nodeType: 'subsystem',
          name: 'Inner Sub',
          duration: { value: 0, unit: 'hours' },
          durationSemantic: 'time',
          position: { x: 100, y: 0 },
          calendarId: null,
          consumesResources: false,
          resourceAssignments: [],
        },
        {
          id: 'inner-entry',
          nodeType: 'subsystemEntry',
          name: 'Entry',
          duration: { value: 0, unit: 'hours' },
          durationSemantic: 'time',
          position: { x: 50, y: 50 },
          calendarId: null,
          consumesResources: false,
          resourceAssignments: [],
        },
        {
          id: 'inner-body',
          nodeType: 'activity',
          name: 'Inner Step',
          duration: { value: 4, unit: 'hours' },
          durationSemantic: 'time',
          position: { x: 100, y: 50 },
          calendarId: null,
          consumesResources: true,
          resourceAssignments: [],
        },
        {
          id: 'inner-exit',
          nodeType: 'subsystemExit',
          name: 'Exit',
          duration: { value: 0, unit: 'hours' },
          durationSemantic: 'time',
          position: { x: 150, y: 50 },
          calendarId: null,
          consumesResources: false,
          resourceAssignments: [],
        },
      ],
      subsystems: [
        {
          id: 'nested-sub',
          containerNodeId: 'inner-container',
          bodyNodeIds: ['inner-entry', 'inner-body', 'inner-exit'],
          entryNodeId: 'inner-entry',
          exitNodeId: 'inner-exit',
        },
      ],
    };
  }

  it('accepts a .calasub file with nested sub-systems inside the body', () => {
    const result = loadSubsystemFile(saveSubsystemFile(nestedSubBase()));
    expect(result.ok).toBe(true);
  });

  it('audit I-4: rejects when nested containerNodeId references a non-subsystem node', () => {
    const bad = nestedSubBase();
    bad.subsystems[0]!.containerNodeId = 'inner-body';
    const result = loadSubsystemFile(saveSubsystemFile(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /nodeType 'subsystem'/.test(e.message))).toBe(true);
    }
  });

  it('audit I-4: rejects when nested entryNodeId is not in bodyNodeIds', () => {
    const bad = nestedSubBase();
    bad.subsystems[0]!.bodyNodeIds = ['inner-body', 'inner-exit'];
    const result = loadSubsystemFile(saveSubsystemFile(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /not in bodyNodeIds/.test(e.message))).toBe(true);
    }
  });

  it('audit I-4: rejects when nested entryNodeId is not a subsystemEntry-typed node', () => {
    const bad = nestedSubBase();
    bad.subsystems[0]!.entryNodeId = 'inner-body';
    bad.subsystems[0]!.bodyNodeIds = ['inner-body', 'inner-exit'];
    const result = loadSubsystemFile(saveSubsystemFile(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /subsystemEntry/.test(e.message))).toBe(true);
    }
  });

  it('audit I-4: rejects when nested entryNodeId === exitNodeId', () => {
    const bad = nestedSubBase();
    bad.subsystems[0]!.exitNodeId = 'inner-entry';
    bad.subsystems[0]!.bodyNodeIds = ['inner-entry', 'inner-body'];
    const result = loadSubsystemFile(saveSubsystemFile(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /must be distinct/.test(e.message))).toBe(true);
    }
  });

  it('audit I-4: rejects when bodyNodeId references a non-existent node', () => {
    const bad = nestedSubBase();
    bad.subsystems[0]!.bodyNodeIds = ['inner-entry', 'inner-body', 'inner-exit', 'ghost-node'];
    const result = loadSubsystemFile(saveSubsystemFile(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /references a non-existent node/.test(e.message))).toBe(
        true,
      );
    }
  });

  it('audit I-4: rejects when one node belongs to two nested subsystem bodies', () => {
    const bad = nestedSubBase();
    // Add a second nested sub that claims the same inner-body node.
    bad.nodes.push(
      {
        id: 'inner-container-2',
        nodeType: 'subsystem',
        name: 'Inner Sub 2',
        duration: { value: 0, unit: 'hours' },
        durationSemantic: 'time',
        position: { x: 300, y: 0 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      },
      {
        id: 'inner-entry-2',
        nodeType: 'subsystemEntry',
        name: 'Entry 2',
        duration: { value: 0, unit: 'hours' },
        durationSemantic: 'time',
        position: { x: 250, y: 50 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      },
      {
        id: 'inner-exit-2',
        nodeType: 'subsystemExit',
        name: 'Exit 2',
        duration: { value: 0, unit: 'hours' },
        durationSemantic: 'time',
        position: { x: 350, y: 50 },
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      },
    );
    bad.subsystems.push({
      id: 'nested-sub-2',
      containerNodeId: 'inner-container-2',
      bodyNodeIds: ['inner-entry-2', 'inner-body', 'inner-exit-2'],
      entryNodeId: 'inner-entry-2',
      exitNodeId: 'inner-exit-2',
    });
    const result = loadSubsystemFile(saveSubsystemFile(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /belongs to both/.test(e.message))).toBe(true);
    }
  });

  it('audit I-4: rejects duplicate entry claim across nested subsystems', () => {
    const bad = nestedSubBase();
    bad.nodes.push({
      id: 'inner-container-2',
      nodeType: 'subsystem',
      name: 'Inner Sub 2',
      duration: { value: 0, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 300, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    });
    bad.subsystems.push({
      id: 'nested-sub-2',
      containerNodeId: 'inner-container-2',
      bodyNodeIds: ['inner-entry', 'inner-exit'],
      entryNodeId: 'inner-entry',
      exitNodeId: 'inner-exit',
    });
    const result = loadSubsystemFile(saveSubsystemFile(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /entry of both/.test(e.message))).toBe(true);
    }
  });

  it('audit I-4: rejects subsystem nesting cycles', () => {
    const bad = nestedSubBase();
    // Make nested-sub's body include outer's container — produces a 2-cycle
    // once we add the outer subsystem.
    bad.subsystems[0]!.bodyNodeIds = ['inner-entry', 'inner-body', 'inner-exit', 'outer-container'];
    bad.nodes.push({
      id: 'outer-container',
      nodeType: 'subsystem',
      name: 'Outer Sub',
      duration: { value: 0, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 100 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    });
    bad.subsystems.push({
      id: 'outer-sub',
      containerNodeId: 'outer-container',
      bodyNodeIds: ['inner-container'],
      entryNodeId: 'inner-container',
      exitNodeId: 'inner-container',
    });
    const result = loadSubsystemFile(saveSubsystemFile(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /nesting cycle/.test(e.message))).toBe(true);
    }
  });

  it('audit I-4: rejects orphan subsystemEntry node not claimed by any nested sub', () => {
    const bad = nestedSubBase();
    // Add a free-floating subsystemEntry-typed node that nothing claims.
    bad.nodes.push({
      id: 'orphan-port',
      nodeType: 'subsystemEntry',
      name: 'Orphan',
      duration: { value: 0, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 500, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    });
    const result = loadSubsystemFile(saveSubsystemFile(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /orphan subsystemEntry/.test(e.message))).toBe(true);
    }
  });

  it('audit I-4: rejects fixedCostOnce on a node that is not inside a loop body', () => {
    const bad = nestedSubBase();
    // inner-body is NOT in any loop's bodyNodeIds in this fixture.
    const innerBodyIndex = bad.nodes.findIndex((n) => n.id === 'inner-body');
    bad.nodes[innerBodyIndex] = {
      ...bad.nodes[innerBodyIndex]!,
      fixedCostOnce: true,
    };
    const result = loadSubsystemFile(saveSubsystemFile(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /fixedCostOnce/.test(e.message))).toBe(true);
    }
  });

  it('migrates a legacy v1 .calasub file forward to v4 on load', () => {
    const v1Json = JSON.stringify({
      ...MINIMAL_SUBSYSTEM,
      version: 1,
    });
    const result = loadSubsystemFile(v1Json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subsystem.version).toBe(4);
      expect(result.subsystem.entryNodeId).toBe('entry');
    }
  });

  it('migrates a v2 .calasub file forward to v4 on load', () => {
    const v2Json = JSON.stringify({
      ...MINIMAL_SUBSYSTEM,
      version: 2,
    });
    const result = loadSubsystemFile(v2Json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subsystem.version).toBe(4);
      // .default('time') filled in by NodeSchema during the v2 parse, so
      // post-migration every node carries the semantic field — even though
      // the original v2 JSON omitted it.
      for (const node of result.subsystem.nodes) {
        expect(node.durationSemantic).toBe('time');
      }
    }
  });

  it('migrates a v3 .calasub file forward to v4 on load', () => {
    const v3Json = JSON.stringify({
      ...MINIMAL_SUBSYSTEM,
      version: 3,
    });
    const result = loadSubsystemFile(v3Json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subsystem.version).toBe(4);
    }
  });
});

// ── Phase 42 — share + shareMode invariants ───────────────────────────────────

describe('Phase 42 — resource-assignment share invariants', () => {
  function projectWithShares(
    shares: Array<number | undefined>,
    shareMode: 'percentage' | 'weight' = 'percentage',
  ): ProjectFile {
    return {
      ...MINIMAL_VALID,
      project: { ...MINIMAL_VALID.project, shareMode },
      resources: [
        { id: 'r1', name: 'A', capacity: 1, calendarId: 'cal-1' },
        { id: 'r2', name: 'B', capacity: 1, calendarId: 'cal-1' },
      ],
      nodes: [
        {
          ...MINIMAL_VALID.nodes[0]!,
          resourceAssignments: [
            {
              resourceId: 'r1',
              count: 1,
              calendarPolicy: 'intersection',
              ...(shares[0] !== undefined ? { share: shares[0] } : {}),
            },
            {
              resourceId: 'r2',
              count: 1,
              calendarPolicy: 'intersection',
              ...(shares[1] !== undefined ? { share: shares[1] } : {}),
            },
          ],
        },
      ],
    };
  }

  it('accepts no shares anywhere — legacy mode is always valid', () => {
    const result = loadProjectFile(saveProjectFile(projectWithShares([undefined, undefined])));
    expect(result.ok).toBe(true);
  });

  it('accepts percentage shares that sum to 100', () => {
    const result = loadProjectFile(saveProjectFile(projectWithShares([30, 70])));
    expect(result.ok).toBe(true);
  });

  it('rejects partial shares (one set, one absent)', () => {
    const result = loadProjectFile(saveProjectFile(projectWithShares([30, undefined])));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /partial share/.test(e.message))).toBe(true);
    }
  });

  it('rejects all-zero shares (sum > 0 invariant)', () => {
    const result = loadProjectFile(saveProjectFile(projectWithShares([0, 0])));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /sum to 0/.test(e.message))).toBe(true);
    }
  });

  it('accepts a single-pool 100 share + zero on the other (presence-only)', () => {
    const result = loadProjectFile(saveProjectFile(projectWithShares([100, 0])));
    expect(result.ok).toBe(true);
  });

  it('rejects percentage shares that sum to ≠ 100', () => {
    const result = loadProjectFile(saveProjectFile(projectWithShares([30, 60])));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /sum to 90/.test(e.message))).toBe(true);
    }
  });

  it('accepts arbitrary positive shares in weight mode (no sum=100 constraint)', () => {
    const result = loadProjectFile(saveProjectFile(projectWithShares([3, 7], 'weight')));
    expect(result.ok).toBe(true);
  });

  it('still requires sum > 0 in weight mode', () => {
    const result = loadProjectFile(saveProjectFile(projectWithShares([0, 0], 'weight')));
    expect(result.ok).toBe(false);
  });

  it('tolerates float drift in percentage mode (33.33 / 33.33 / 33.34)', () => {
    // Single 3-pool node fixture
    const p: ProjectFile = {
      ...MINIMAL_VALID,
      resources: [
        { id: 'r1', name: 'A', capacity: 1, calendarId: 'cal-1' },
        { id: 'r2', name: 'B', capacity: 1, calendarId: 'cal-1' },
        { id: 'r3', name: 'C', capacity: 1, calendarId: 'cal-1' },
      ],
      nodes: [
        {
          ...MINIMAL_VALID.nodes[0]!,
          resourceAssignments: [
            { resourceId: 'r1', count: 1, calendarPolicy: 'intersection', share: 33.33 },
            { resourceId: 'r2', count: 1, calendarPolicy: 'intersection', share: 33.33 },
            { resourceId: 'r3', count: 1, calendarPolicy: 'intersection', share: 33.34 },
          ],
        },
      ],
    };
    const result = loadProjectFile(saveProjectFile(p));
    expect(result.ok).toBe(true);
  });
});

// ── Schema limits (audit item #4) ────────────────────────────────────────────
//
// Two enforcement modes per the load.ts preprocessor + Zod schema split:
//   - Free-text strings: truncated by load.ts, warning emitted, load OK.
//   - Identifiers + arrays: hard-rejected by Zod, load fails with errors.
//
// Each cap has one test at the limit (passes) and one one-past (the right
// behaviour for that cap's enforcement mode).

import { SCHEMA_LIMITS } from './schema.js';

function makeNode(
  overrides: Partial<ProjectFile['nodes'][number]> = {},
): ProjectFile['nodes'][number] {
  return {
    id: 'n1',
    nodeType: 'activity',
    name: 'Task',
    duration: { value: 8, unit: 'hours' },
    durationSemantic: 'time',
    position: { x: 0, y: 0 },
    calendarId: null,
    consumesResources: false,
    resourceAssignments: [],
    ...overrides,
  };
}

describe('SCHEMA_LIMITS — free-text string fields (soft cap, truncate + warn)', () => {
  it('preserves a node name at exactly the cap', () => {
    const exact = 'A'.repeat(SCHEMA_LIMITS.nodeName);
    const p: ProjectFile = { ...MINIMAL_VALID, nodes: [makeNode({ name: exact })] };
    const result = loadProjectFile(saveProjectFile(p));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.nodes[0]?.name.length).toBe(SCHEMA_LIMITS.nodeName);
    expect(result.truncationWarnings).toBeUndefined();
  });

  it('truncates a node name one past the cap and reports it', () => {
    const oversized = 'A'.repeat(SCHEMA_LIMITS.nodeName + 1);
    const p: ProjectFile = { ...MINIMAL_VALID, nodes: [makeNode({ name: oversized })] };
    const result = loadProjectFile(saveProjectFile(p));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.nodes[0]?.name.length).toBe(SCHEMA_LIMITS.nodeName);
    expect(result.truncationWarnings).toEqual([
      {
        path: 'nodes[0].name',
        field: 'name',
        originalLength: SCHEMA_LIMITS.nodeName + 1,
        truncatedTo: SCHEMA_LIMITS.nodeName,
      },
    ]);
  });

  it('truncates a node description over its cap', () => {
    const oversized = 'D'.repeat(SCHEMA_LIMITS.nodeDescription + 1);
    const p: ProjectFile = {
      ...MINIMAL_VALID,
      nodes: [makeNode({ description: oversized })],
    };
    const result = loadProjectFile(saveProjectFile(p));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.nodes[0]?.description?.length).toBe(SCHEMA_LIMITS.nodeDescription);
    expect(result.truncationWarnings?.[0]?.field).toBe('description');
  });

  it('truncates a node group label over its cap', () => {
    const oversized = 'G'.repeat(SCHEMA_LIMITS.nodeGroup + 1);
    const p: ProjectFile = { ...MINIMAL_VALID, nodes: [makeNode({ group: oversized })] };
    const result = loadProjectFile(saveProjectFile(p));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.nodes[0]?.group?.length).toBe(SCHEMA_LIMITS.nodeGroup);
  });

  it('truncates a project name over its cap', () => {
    const oversized = 'P'.repeat(SCHEMA_LIMITS.projectName + 1);
    const p: ProjectFile = {
      ...MINIMAL_VALID,
      project: { ...MINIMAL_VALID.project, name: oversized },
    };
    const result = loadProjectFile(saveProjectFile(p));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.project.name.length).toBe(SCHEMA_LIMITS.projectName);
    expect(result.truncationWarnings?.[0]?.path).toBe('project.name');
  });

  it('truncates a calendar name over its cap', () => {
    const oversized = 'C'.repeat(SCHEMA_LIMITS.calendarName + 1);
    const p: ProjectFile = {
      ...MINIMAL_VALID,
      calendars: [{ ...MINIMAL_VALID.calendars[0]!, name: oversized }],
    };
    const result = loadProjectFile(saveProjectFile(p));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.project.calendars[0]?.name.length).toBe(SCHEMA_LIMITS.calendarName);
  });

  it('collects warnings from multiple oversized fields in one load', () => {
    const p: ProjectFile = {
      ...MINIMAL_VALID,
      project: {
        ...MINIMAL_VALID.project,
        name: 'X'.repeat(SCHEMA_LIMITS.projectName + 1),
      },
      nodes: [makeNode({ id: 'n1', name: 'Y'.repeat(SCHEMA_LIMITS.nodeName + 1) })],
    };
    const result = loadProjectFile(saveProjectFile(p));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncationWarnings).toHaveLength(2);
    const paths = result.truncationWarnings?.map((w) => w.path).sort();
    expect(paths).toEqual(['nodes[0].name', 'project.name']);
  });
});

describe('SCHEMA_LIMITS — identifier fields (hard reject)', () => {
  it('accepts an id at exactly the cap', () => {
    const exact = 'i'.repeat(SCHEMA_LIMITS.id);
    const p: ProjectFile = {
      ...MINIMAL_VALID,
      project: { ...MINIMAL_VALID.project, defaultCalendarId: exact },
      calendars: [{ ...MINIMAL_VALID.calendars[0]!, id: exact }],
      nodes: [makeNode({ calendarId: exact })],
    };
    const result = loadProjectFile(saveProjectFile(p));
    expect(result.ok).toBe(true);
  });

  it('rejects a node id one past the cap', () => {
    const oversized = 'i'.repeat(SCHEMA_LIMITS.id + 1);
    const p: ProjectFile = {
      ...MINIMAL_VALID,
      nodes: [makeNode({ id: oversized })],
    };
    const result = loadProjectFile(saveProjectFile(p));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.path.includes('nodes'))).toBe(true);
  });

  it('rejects an edge.from one past the cap', () => {
    const oversized = 'i'.repeat(SCHEMA_LIMITS.id + 1);
    const p: ProjectFile = {
      ...MINIMAL_VALID,
      nodes: [makeNode({ id: 'n1' }), makeNode({ id: 'n2' })],
      edges: [
        { id: 'e1', from: oversized, to: 'n2', type: 'FS', lag: { value: 0, unit: 'hours' } },
      ],
    };
    const result = loadProjectFile(saveProjectFile(p));
    expect(result.ok).toBe(false);
  });
});

describe('SCHEMA_LIMITS — array caps (hard reject)', () => {
  // We test the smallest caps to avoid building enormous fixtures. The
  // crashOptions cap is 100 — easy to exceed. nodes/edges are large enough
  // that a real test would be slow; the principle is verified per-cap with
  // small-cap representatives.

  it('accepts crashOptions at exactly the cap', () => {
    const opts = Array.from({ length: SCHEMA_LIMITS.crashOptions }, (_, i) => ({
      id: `c${i}`,
      duration: { value: 1, unit: 'hours' as const },
      additionalCost: 100,
    }));
    const p: ProjectFile = {
      ...MINIMAL_VALID,
      nodes: [makeNode({ crashOptions: opts })],
    };
    const result = loadProjectFile(saveProjectFile(p));
    expect(result.ok).toBe(true);
  });

  it('rejects crashOptions one past the cap', () => {
    const opts = Array.from({ length: SCHEMA_LIMITS.crashOptions + 1 }, (_, i) => ({
      id: `c${i}`,
      duration: { value: 1, unit: 'hours' as const },
      additionalCost: 100,
    }));
    const p: ProjectFile = {
      ...MINIMAL_VALID,
      nodes: [makeNode({ crashOptions: opts })],
    };
    const result = loadProjectFile(saveProjectFile(p));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => /crashOptions/.test(e.message))).toBe(true);
  });

  it('rejects too many calendars', () => {
    const tooMany = Array.from({ length: SCHEMA_LIMITS.calendars + 1 }, (_, i) => ({
      ...MINIMAL_VALID.calendars[0]!,
      id: `c${i}`,
    }));
    const p: ProjectFile = { ...MINIMAL_VALID, calendars: tooMany };
    const result = loadProjectFile(saveProjectFile(p));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => /calendars/.test(e.message))).toBe(true);
  });

  it('rejects too many scenarios', () => {
    const tooMany = Array.from({ length: SCHEMA_LIMITS.scenarios + 1 }, (_, i) => ({
      id: `sc${i}`,
      name: `S${i}`,
      seed: i,
      nodeOverrides: {},
    }));
    const p: ProjectFile = { ...MINIMAL_VALID, scenarios: tooMany };
    const result = loadProjectFile(saveProjectFile(p));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => /scenarios/.test(e.message))).toBe(true);
  });

  it('rejects too many resourceAssignments on a single node', () => {
    const tooMany = Array.from({ length: SCHEMA_LIMITS.resourceAssignments + 1 }, () => ({
      resourceId: 'r1',
      count: 1,
      calendarPolicy: 'intersection' as const,
    }));
    const p: ProjectFile = {
      ...MINIMAL_VALID,
      resources: [{ id: 'r1', name: 'R', capacity: 1, calendarId: 'cal-1' }],
      nodes: [makeNode({ resourceAssignments: tooMany })],
    };
    const result = loadProjectFile(saveProjectFile(p));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => /resourceAssignments/.test(e.message))).toBe(true);
  });
});

// ── Phase 50 Slice 5 — distribution shape refinement (audit C-3) ──────────────

describe('DistributionSchema shape invariants (audit C-3)', () => {
  // Exercise DistributionSchema standalone so a malformed shape is caught
  // without round-tripping through a full ProjectFile. The Zod path
  // composition is tested separately via loadProjectFile further down.
  function parse(d: unknown) {
    return DistributionSchema.safeParse(d);
  }

  // Well-formed accepts ─────────────────────────────────────────────────────

  it('accepts a well-formed triangular distribution', () => {
    const r = parse({ type: 'triangular', min: 1, mode: 2, max: 3 });
    expect(r.success).toBe(true);
  });

  it('accepts a well-formed pert-beta distribution', () => {
    const r = parse({ type: 'pert-beta', min: 0, mode: 5, max: 10 });
    expect(r.success).toBe(true);
  });

  it('accepts a degenerate right-skewed triangular (mode === min)', () => {
    const r = parse({ type: 'triangular', min: 1, mode: 1, max: 5 });
    expect(r.success).toBe(true);
  });

  it('accepts a degenerate left-skewed triangular (mode === max)', () => {
    const r = parse({ type: 'triangular', min: 1, mode: 5, max: 5 });
    expect(r.success).toBe(true);
  });

  // Malformed rejects ───────────────────────────────────────────────────────

  it('rejects triangular with reversed bounds (min > max)', () => {
    const r = parse({ type: 'triangular', min: 20, mode: 15, max: 10 });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => /min < max/.test(i.message))).toBe(true);
  });

  it('rejects triangular with min === max (zero-variance)', () => {
    const r = parse({ type: 'triangular', min: 5, mode: 5, max: 5 });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => /min < max/.test(i.message))).toBe(true);
  });

  it('rejects triangular with mode below min', () => {
    const r = parse({ type: 'triangular', min: 10, mode: 5, max: 20 });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => /mode ≥ min/.test(i.message))).toBe(true);
  });

  it('rejects triangular with mode above max', () => {
    const r = parse({ type: 'triangular', min: 0, mode: 15, max: 10 });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => /mode ≤ max/.test(i.message))).toBe(true);
  });

  it('rejects pert-beta with mode below min (same shape as triangular)', () => {
    const r = parse({ type: 'pert-beta', min: 10, mode: 5, max: 20 });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.some((i) => /mode ≥ min/.test(i.message))).toBe(true);
  });

  it('still rejects normal with stddev === 0 (existing .positive() guard)', () => {
    // σ = 0 is semantically a Dirac delta, but the existing schema's
    // .positive() rejects it. C-3 doesn't relax this — see NodePanel
    // conventions for the UI-side σ ≥ 0 story.
    const r = parse({ type: 'normal', mean: 5, stddev: 0 });
    expect(r.success).toBe(false);
  });

  // Path composition — when a malformed distribution lives inside a
  // ProjectFile, the error path identifies which node / field it came
  // from so the user (or our auto-clamp / migrate path, if we ever add
  // one) can target the fix.
  it('surfaces the malformed-distribution error with a path including the offending node', () => {
    const bad = JSON.parse(saveProjectFile(MINIMAL_VALID)) as Record<string, unknown>;
    // Inject a malformed distribution onto the first node's duration.

    (bad['nodes'] as any[])[0]['distribution'] = {
      type: 'triangular',
      min: 10,
      mode: 5,
      max: 20,
    };
    const result = loadProjectFile(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const offending = result.errors.find((e) => /mode ≥ min/.test(e.message));
    expect(offending).toBeDefined();
    expect(offending!.path).toContain('nodes.0.distribution');
  });
});
