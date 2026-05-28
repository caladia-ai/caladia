/**
 * Phase 20 Slice 2 — JSON exporter for `SimulationResult`.
 *
 * Originally landed in `packages/app/src/lib/exportSim.ts`. Phase 21
 * Slice 1A (refactor): the JSON-shaped pieces moved here so the
 * headless CLI can produce byte-identical output to a UI-driven
 * export without depending on `packages/app` (which would drag React,
 * Vite, and the DOM into the CLI binary).
 *
 * The split lines are mechanical:
 *   - JSON shape (`toJson`, `fromJson`, `SimExport`, `ParsedSimExport`,
 *     `SIM_EXPORT_VERSION`) is engine-side — pure functions over
 *     `SimulationResult` plus run/project metadata as primitives.
 *   - CSV outputs, filename builder, and the SimRun/ProjectFile
 *     adapter stay in `packages/app/src/lib/exportSim.ts`.
 *
 * The .json artefact is the canonical export — every field of
 * `SimulationResult` is round-trippable, with `Date` fields
 * serialised as ISO strings and parsed back by `fromJson`.
 */

import type { SimulationResult } from './index.js';

/** Schema version bumped only when a backwards-incompatible field changes. */
export const SIM_EXPORT_VERSION = 1 as const;

// ── Input shape ──────────────────────────────────────────────────────────────

/**
 * Primitives the engine exporter needs. The app-side adapter is
 * responsible for projecting `SimRun + ProjectFile` into this shape;
 * the CLI builds it directly from a parsed `.cala` file plus a
 * fresh `simulate()` call. Everything is plain data — no React, no
 * `SimRun` class, no `ProjectFile` cross-cutting state.
 */
export interface SimExportInput {
  result: SimulationResult;
  iterations: number;
  seed: number;
  runId: string;
  runTimestamp: Date;
  /** Phase 16 — Risk-Drivers what-if exclusions. Empty / absent for baseline runs. */
  excludes?: ReadonlyArray<string>;
  projectName: string;
  /** ISO 4217 alphabetic code (3 uppercase letters). */
  currency: string;
  fxSnapshotVersion: string;
  fxRateOverrides?: Record<string, number>;
  /** YYYY-MM-DD date the user was asking "P(finish ≤ this)" about, or null. */
  target: string | null;
  /** Wall-clock at export time. Caller-passed so this function stays pure. */
  exportedAt: Date;
  /**
   * Node id → display name, used to enrich `pathFrequency`, `tornado`,
   * and `costTornado` with human-readable names. The exporter falls
   * back to the id when a lookup misses (defensive — shouldn't happen
   * for in-project ids, but a stale id shouldn't crash the export).
   */
  nodeNames: Record<string, string>;
}

// ── Output shape ─────────────────────────────────────────────────────────────

/**
 * Serialised top-level shape. Mirrors the slice-2 plan's header
 * fields plus the result block. Dates are ISO strings; arrays of
 * dates become arrays of ISO strings.
 */
export interface SimExport {
  kind: 'caladia.sim';
  version: typeof SIM_EXPORT_VERSION;
  exportedAt: string;
  projectName: string;
  currency: string;
  fxSnapshotVersion: string;
  fxRateOverrides?: Record<string, number>;
  iterations: number;
  seed: number;
  excludes?: ReadonlyArray<string>;
  runId: string;
  runTimestamp: string;
  target: string | null;
  result: SerialisedResult;
}

interface SerialisedResult {
  endDates: string[];
  percentiles: { p50: string; p80: string; p95: string };
  criticalityIndex: Record<string, number>;
  tornado: Array<{ nodeId: string; name: string; impactHours: number }>;
  convergence: { converged: boolean; atIteration: number | null };
  pathFrequency: Array<{ ids: string[]; names: string[]; count: number }>;
  pathPerIteration: number[];
  nodeP95: Record<string, string>;
  projectCosts: number[];
  costPercentiles: { p50: number; p80: number; p95: number };
  nodeCostStats: Record<string, { mean: number; p95: number }>;
  costTornado: Array<{ nodeId: string; name: string; impactCost: number }>;
  costCurve: SimulationResult['costCurve'];
}

/** Parsed-back shape: Dates are real `Date` instances again. */
export interface ParsedSimExport extends Omit<SimExport, 'result'> {
  result: ParsedResult;
}
interface ParsedResult extends Omit<SerialisedResult, 'endDates' | 'percentiles' | 'nodeP95'> {
  endDates: Date[];
  percentiles: { p50: Date; p80: Date; p95: Date };
  nodeP95: Record<string, Date>;
}

// ── Functions ────────────────────────────────────────────────────────────────

function nameOf(map: Record<string, string>, id: string): string {
  return map[id] ?? id;
}

export function toJson(input: SimExportInput): string {
  const { result: r, nodeNames: names } = input;

  const result: SerialisedResult = {
    endDates: r.endDates.map((d) => d.toISOString()),
    percentiles: {
      p50: r.percentiles.p50.toISOString(),
      p80: r.percentiles.p80.toISOString(),
      p95: r.percentiles.p95.toISOString(),
    },
    criticalityIndex: r.criticalityIndex,
    tornado: r.tornado.map((t) => ({
      nodeId: t.nodeId,
      name: nameOf(names, t.nodeId),
      impactHours: t.impactHours,
    })),
    convergence: r.convergence,
    pathFrequency: r.pathFrequency.map((p) => ({
      ids: p.path,
      names: p.path.map((id) => nameOf(names, id)),
      count: p.count,
    })),
    pathPerIteration: r.pathPerIteration,
    nodeP95: Object.fromEntries(Object.entries(r.nodeP95).map(([id, d]) => [id, d.toISOString()])),
    projectCosts: r.projectCosts,
    costPercentiles: r.costPercentiles,
    nodeCostStats: r.nodeCostStats,
    costTornado: r.costTornado.map((t) => ({
      nodeId: t.nodeId,
      name: nameOf(names, t.nodeId),
      impactCost: t.impactCost,
    })),
    costCurve: r.costCurve,
  };

  const out: SimExport = {
    kind: 'caladia.sim',
    version: SIM_EXPORT_VERSION,
    exportedAt: input.exportedAt.toISOString(),
    projectName: input.projectName,
    currency: input.currency,
    fxSnapshotVersion: input.fxSnapshotVersion,
    ...(input.fxRateOverrides && Object.keys(input.fxRateOverrides).length > 0
      ? { fxRateOverrides: input.fxRateOverrides }
      : {}),
    iterations: input.iterations,
    seed: input.seed,
    ...(input.excludes && input.excludes.length > 0 ? { excludes: input.excludes } : {}),
    runId: input.runId,
    runTimestamp: input.runTimestamp.toISOString(),
    target: input.target,
    result,
  };
  return JSON.stringify(out, null, 2);
}

/**
 * Parse a JSON export back into a typed shape, converting ISO date
 * strings to real `Date` instances. Used by the round-trip test.
 *
 * Permissive on shape — trusts the input came from `toJson` and does
 * not validate every field. If we want a hardened import (load an
 * external export back into the app), add a Zod schema.
 */
export function fromJson(text: string): ParsedSimExport {
  const raw = JSON.parse(text) as SimExport;
  const r = raw.result;
  return {
    ...raw,
    result: {
      ...r,
      endDates: r.endDates.map((s) => new Date(s)),
      percentiles: {
        p50: new Date(r.percentiles.p50),
        p80: new Date(r.percentiles.p80),
        p95: new Date(r.percentiles.p95),
      },
      nodeP95: Object.fromEntries(Object.entries(r.nodeP95).map(([id, s]) => [id, new Date(s)])),
    },
  };
}
