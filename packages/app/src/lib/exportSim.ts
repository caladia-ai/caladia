/**
 * App-side adapter over the engine's JSON exporter (`@procsim/simulation`'s
 * `toJson` / `fromJson`) plus the app-only CSV outputs and filename helper.
 *
 * Phase 21 Slice 1A split the JSON shape out of this file into
 * `packages/simulation/src/export.ts` so the headless CLI can consume it
 * without dragging React/Vite into a Node binary. Everything app-side
 * (anything depending on `SimRun`, `ProjectFile`, browser locale time
 * formatting, or CSV-for-Excel formatting) stays here.
 *
 * The verdict-bar popover in SimulateView calls `toJson` / `toCsv` /
 * `toCostCsv` / `buildExportFilename` here, wraps results in a Blob, and
 * hands them to `triggerDownload` (lib/export.ts). Keeping these
 * adapter functions pure (no DOM, no `Date.now()` inside their bodies)
 * makes them trivially testable — every "current time" enters as a
 * parameter.
 *
 * Two .csv artefacts are emitted alongside the JSON:
 *  - The "schedule" CSV (`toCsv`) is one row per iteration with
 *    finish-date, decimal calendar days, and the primary critical-path
 *    rank+nodes (using `pathPerIteration` from Phase 20 Slice 1).
 *  - The "cost" CSV (`toCostCsv`) is one row per iteration with the
 *    project-level cost. It deliberately does NOT include per-node cost
 *    columns: `SimulationResult` retains only project-level cost per
 *    iteration (`projectCosts: number[]`) and across-iteration aggregates
 *    (`nodeCostStats: mean + p95`); the engine does not keep per-node
 *    per-iteration detail. The JSON export carries `nodeCostStats` for
 *    anyone needing the aggregate view. Promoting per-node per-iteration
 *    data to a public engine output is a future engine-side change, not
 *    something this UI slice can fake honestly.
 */

import type { ProjectFile } from '@procsim/file-format';
import {
  toJson as engineToJson,
  fromJson as engineFromJson,
  SIM_EXPORT_VERSION as ENGINE_SIM_EXPORT_VERSION,
} from '@procsim/simulation';
import type { SimExport, ParsedSimExport } from '@procsim/simulation';
import type { SimRun } from '../store/viewStore.js';

/** Re-export so existing callers / tests don't break. */
export const SIM_EXPORT_VERSION = ENGINE_SIM_EXPORT_VERSION;
export type { SimExport, ParsedSimExport };

/** Single-right-pointing-angle separator for joined critical-path node lists. */
const PATH_SEPARATOR = ' › ';

const CRLF = '\r\n';

// ── Name lookup (shared by toJson adapter + CSV) ─────────────────────────────

/**
 * Build the node-id → display-name map. Subsystem container ids appear in
 * `nodeCostStats` AND `project.nodes` (the scheduler's flatten strips them
 * from its own `nodes` output but they remain in the project file).
 */
function buildNameMap(project: ProjectFile): Record<string, string> {
  const m: Record<string, string> = {};
  for (const n of project.nodes) m[n.id] = n.name;
  return m;
}

function nameOf(map: Record<string, string>, id: string): string {
  return map[id] ?? id;
}

// ── JSON (adapter) ───────────────────────────────────────────────────────────

/**
 * Project the app-side `SimRun + ProjectFile` shapes into the engine
 * exporter's `SimExportInput` primitives, then call through. Output is
 * byte-identical to a CLI-driven export at the same seed — that's the
 * whole reason `toJson` lives in `packages/simulation` rather than
 * being duplicated here.
 */
export function toJson(
  run: SimRun,
  project: ProjectFile,
  target: string | null,
  exportedAt: Date,
): string {
  return engineToJson({
    result: run.result,
    iterations: run.iterations,
    seed: run.seed,
    runId: run.id,
    runTimestamp: run.timestamp,
    ...(run.excludes && run.excludes.length > 0 ? { excludes: run.excludes } : {}),
    projectName: project.project.name,
    currency: project.currency,
    fxSnapshotVersion: project.fxSnapshotVersion,
    ...(project.fxRateOverrides && Object.keys(project.fxRateOverrides).length > 0
      ? { fxRateOverrides: project.fxRateOverrides }
      : {}),
    target,
    exportedAt,
    nodeNames: buildNameMap(project),
  });
}

/** Re-export the engine parser so the app-side round-trip surface stays here. */
export const fromJson = engineFromJson;

// ── CSV ──────────────────────────────────────────────────────────────────────

/**
 * Quote a CSV field if it contains a comma, double-quote, CR, or LF.
 * Internal double-quotes are doubled. Mirrors the rule in lib/export.ts
 * but inlined here so this module stays self-contained.
 */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Per-iteration schedule CSV. Excel/Sheets-friendly (CRLF, no BOM).
 *
 * Columns:
 *   iteration, finishDateISO, finishDays, criticalPathRank, criticalPathNodes
 *
 * - `iteration` is 1-based for human readability.
 * - `finishDays` is decimal calendar days from `project.startDate` 00:00
 *   local to the iteration's `projectEnd`. Calendar (not working) days —
 *   that's what Excel users expect when filtering / pivoting.
 * - `criticalPathRank` is `pathPerIteration[i] + 1` (1-based post-sort
 *   index into `pathFrequency`). `-1` literal when the iteration's only
 *   critical path was anchor-only (the documented Phase 20 Slice 1
 *   sentinel) — `criticalPathNodes` in that row is empty.
 * - `criticalPathNodes` is the resolved node names joined with ` › `.
 *
 * Row count equals `endDates.length`, NOT `iterations` — degenerate
 * (always-failing) samples are skipped by the engine.
 */
export function toCsv(run: SimRun, project: ProjectFile): string {
  const names = buildNameMap(project);
  const r = run.result;
  const projectStartMs = new Date(project.project.startDate + 'T00:00:00').getTime();

  const header = [
    'iteration',
    'finishDateISO',
    'finishDays',
    'criticalPathRank',
    'criticalPathNodes',
  ].join(',');

  const lines: string[] = [header];
  for (let i = 0; i < r.endDates.length; i++) {
    const finish = r.endDates[i]!;
    const days = (finish.getTime() - projectStartMs) / 86_400_000;
    const pathIdx = r.pathPerIteration[i] ?? -1;
    let rank: string;
    let pathNames: string;
    if (pathIdx < 0) {
      rank = '-1';
      pathNames = '';
    } else {
      rank = String(pathIdx + 1);
      const entry = r.pathFrequency[pathIdx];
      pathNames = entry
        ? csvField(entry.path.map((id) => nameOf(names, id)).join(PATH_SEPARATOR))
        : '';
    }
    lines.push([String(i + 1), finish.toISOString(), days.toFixed(2), rank, pathNames].join(','));
  }
  return lines.join(CRLF) + CRLF;
}

/**
 * Per-iteration cost CSV. Returns `null` when the project has no cost data
 * (every `projectCosts` entry is zero — the documented Phase 19 empty-cost
 * state).
 *
 * Columns: `iteration, projectCost`.
 *
 * **Scope note.** Per-node cost columns were considered (the original
 * plan named them) but the engine does not retain per-iteration per-node
 * cost — only `projectCosts` (per-iteration project total) and
 * `nodeCostStats` (mean / P95 aggregated across iterations). The
 * aggregate per-node data is exported in the JSON. If per-iteration
 * per-node detail is needed later, the engine has to be extended to keep
 * a `nodeCostsPerIteration: Record<string, number[]>` field on
 * `SimulationResult` — a separate engine-side slice.
 */
export function toCostCsv(run: SimRun, _project: ProjectFile): string | null {
  const r = run.result;
  if (r.projectCosts.length === 0) return null;
  const anyNonZero = r.projectCosts.some((c) => c > 0);
  if (!anyNonZero) return null;
  const header = ['iteration', 'projectCost'].join(',');
  const lines: string[] = [header];
  for (let i = 0; i < r.projectCosts.length; i++) {
    lines.push([String(i + 1), String(r.projectCosts[i] ?? 0)].join(','));
  }
  return lines.join(CRLF) + CRLF;
}

// ── Filename ─────────────────────────────────────────────────────────────────

/** Strip non-alphanumeric, lowercase. Matches the .cala save-file rule. */
function slugify(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * `caladia-sim-<projectSlug>-<iters>iters-<seed>-<YYYYMMDD-HHmm>.<ext>`
 *
 * Timestamp is local-time (what the user sees on their clock) so the
 * filename matches their wall-clock memory of "when did I export this."
 * The JSON header's `exportedAt` field is the canonical UTC ISO timestamp.
 */
export function buildExportFilename(
  project: ProjectFile,
  run: SimRun,
  exportedAt: Date,
  ext: 'json' | 'csv',
  suffix?: 'cost',
): string {
  const slug = slugify(project.project.name);
  const ts =
    `${exportedAt.getFullYear()}` +
    `${pad2(exportedAt.getMonth() + 1)}` +
    `${pad2(exportedAt.getDate())}` +
    `-` +
    `${pad2(exportedAt.getHours())}` +
    `${pad2(exportedAt.getMinutes())}`;
  const base = `caladia-sim-${slug}-${run.iterations}iters-${run.seed}-${ts}`;
  return suffix ? `${base}-${suffix}.${ext}` : `${base}.${ext}`;
}
