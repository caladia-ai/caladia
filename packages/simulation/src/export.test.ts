import { describe, it, expect } from 'vitest';
import type { SimulationResult } from './index.js';
import { toJson, fromJson, SIM_EXPORT_VERSION, type SimExportInput } from './export.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

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

function makeInput(overrides: Partial<SimExportInput> = {}): SimExportInput {
  return {
    result: makeResult(),
    iterations: 100,
    seed: 42,
    runId: 'run-1',
    runTimestamp: new Date('2026-05-13T10:00:00.000Z'),
    projectName: 'Demo Project',
    currency: 'USD',
    fxSnapshotVersion: '2026.1',
    target: '2026-08-15',
    exportedAt: new Date('2026-05-13T15:00:00.000Z'),
    nodeNames: { A: 'Build', B: 'Test' },
    ...overrides,
  };
}

// ── toJson ──────────────────────────────────────────────────────────────────

describe('toJson', () => {
  it('emits the expected top-level header fields', () => {
    const text = toJson(makeInput());
    const parsed = JSON.parse(text);
    expect(parsed.kind).toBe('caladia.sim');
    expect(parsed.version).toBe(SIM_EXPORT_VERSION);
    expect(parsed.exportedAt).toBe('2026-05-13T15:00:00.000Z');
    expect(parsed.projectName).toBe('Demo Project');
    expect(parsed.currency).toBe('USD');
    expect(parsed.fxSnapshotVersion).toBe('2026.1');
    expect(parsed.iterations).toBe(100);
    expect(parsed.seed).toBe(42);
    expect(parsed.target).toBe('2026-08-15');
    expect(parsed.runId).toBe('run-1');
  });

  it('serialises endDates and nodeP95 as ISO strings', () => {
    const text = toJson(makeInput());
    const parsed = JSON.parse(text);
    expect(parsed.result.endDates[0]).toBe('2026-03-14T17:00:00.000Z');
    expect(parsed.result.percentiles.p50).toBe('2026-03-15T17:00:00.000Z');
    expect(parsed.result.nodeP95.A).toBe('2026-03-10T17:00:00.000Z');
  });

  it('resolves node names in pathFrequency and tornado', () => {
    const text = toJson(makeInput());
    const parsed = JSON.parse(text);
    expect(parsed.result.pathFrequency[0]).toEqual({
      ids: ['A', 'B'],
      names: ['Build', 'Test'],
      count: 3,
    });
    expect(parsed.result.tornado[0]).toEqual({
      nodeId: 'A',
      name: 'Build',
      impactHours: 24,
    });
  });

  it('falls back to the id when a name lookup misses', () => {
    // Stale nodeNames map (id 'A' missing). Defensive — exporter must
    // not crash; the id is the documented fallback.
    const input = makeInput({ nodeNames: { B: 'Test' } });
    const parsed = JSON.parse(toJson(input));
    expect(parsed.result.tornado[0].name).toBe('A');
    expect(parsed.result.pathFrequency[0].names).toEqual(['A', 'Test']);
  });

  it('omits excludes and fxRateOverrides when empty', () => {
    const parsed = JSON.parse(toJson(makeInput()));
    expect('excludes' in parsed).toBe(false);
    expect('fxRateOverrides' in parsed).toBe(false);
  });

  it('includes excludes and fxRateOverrides when present', () => {
    const input = makeInput({
      excludes: ['A'],
      fxRateOverrides: { EUR: 0.92 },
    });
    const parsed = JSON.parse(toJson(input));
    expect(parsed.excludes).toEqual(['A']);
    expect(parsed.fxRateOverrides).toEqual({ EUR: 0.92 });
  });
});

// ── fromJson ────────────────────────────────────────────────────────────────

describe('fromJson round-trip', () => {
  it('preserves every result field through serialise → parse', () => {
    // Field-by-field equality rather than byte-equal-round-trip because
    // the serialised pathFrequency uses `{ ids, names }` (a name-enriched
    // projection) while the source is `{ path }`. Names are derived from
    // the project and intentionally not part of the engine truth being
    // round-tripped.
    const input = makeInput();
    const text = toJson(input);
    const parsed = fromJson(text);

    expect(parsed.result.endDates.map((d) => d.getTime())).toEqual(
      input.result.endDates.map((d) => d.getTime()),
    );
    expect(parsed.result.percentiles.p50.getTime()).toBe(input.result.percentiles.p50.getTime());
    expect(parsed.result.percentiles.p80.getTime()).toBe(input.result.percentiles.p80.getTime());
    expect(parsed.result.percentiles.p95.getTime()).toBe(input.result.percentiles.p95.getTime());
    expect(parsed.result.criticalityIndex).toEqual(input.result.criticalityIndex);
    expect(parsed.result.convergence).toEqual(input.result.convergence);
    expect(parsed.result.pathPerIteration).toEqual(input.result.pathPerIteration);
    expect(parsed.result.projectCosts).toEqual(input.result.projectCosts);
    expect(parsed.result.costPercentiles).toEqual(input.result.costPercentiles);
    expect(parsed.result.nodeCostStats).toEqual(input.result.nodeCostStats);
    expect(parsed.result.costCurve).toEqual(input.result.costCurve);

    expect(parsed.result.pathFrequency.map((p) => p.ids)).toEqual(
      input.result.pathFrequency.map((p) => p.path),
    );
    expect(parsed.result.pathFrequency.map((p) => p.count)).toEqual(
      input.result.pathFrequency.map((p) => p.count),
    );

    expect(Object.keys(parsed.result.nodeP95).sort()).toEqual(
      Object.keys(input.result.nodeP95).sort(),
    );
    for (const [id, d] of Object.entries(input.result.nodeP95)) {
      expect(parsed.result.nodeP95[id]!.getTime()).toBe(d.getTime());
    }
  });
});
