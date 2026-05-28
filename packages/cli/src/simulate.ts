/**
 * Pure core of the `caladia simulate` subcommand. Takes a `.cala` file's
 * contents (as a string) plus iteration / seed options, runs `schedule()`
 * then `simulate()`, and returns the same JSON the UI exporter produces
 * for an equivalent run.
 *
 * Kept separate from the Commander entry in `index.ts` so the smoke
 * tests can drive it directly without spawning a child process.
 */

import { loadProjectFile, type ProjectFile } from '@procsim/file-format';
import type { ScheduleInput } from '@procsim/scheduler';
import { simulate, toJson } from '@procsim/simulation';

export interface RunSimulateOptions {
  /** Raw `.cala` file contents (JSON text). */
  contents: string;
  /** MC iteration count. Defaults to 1000. */
  iterations?: number;
  /** RNG seed. Defaults to 42. */
  seed?: number;
  /**
   * Wall-clock at export time. Caller-passed so the function stays
   * deterministic for tests; the production CLI passes `new Date()`.
   */
  exportedAt?: Date;
  /**
   * Run identifier. Caller-passed for the same reason — the production
   * CLI generates one from the current time + seed.
   */
  runId?: string;
  runTimestamp?: Date;
}

export type RunSimulateResult =
  | { ok: true; json: string }
  | { ok: false; exitCode: 1 | 2; message: string };

/**
 * Project the loaded `ProjectFile` into the flat `ScheduleInput` shape
 * the engine expects. Same projection the app makes in `SimulateView`.
 */
function toScheduleInput(project: ProjectFile): ScheduleInput {
  return {
    project: project.project,
    nodes: project.nodes,
    edges: project.edges,
    resources: project.resources,
    calendars: project.calendars,
    loops: project.loops,
    subsystems: project.subsystems,
  };
}

/** Build the id → display name lookup the JSON exporter needs. */
function nameMap(project: ProjectFile): Record<string, string> {
  const m: Record<string, string> = {};
  for (const n of project.nodes) m[n.id] = n.name;
  return m;
}

export function runSimulate(opts: RunSimulateOptions): RunSimulateResult {
  const load = loadProjectFile(opts.contents);
  if (!load.ok) {
    const lines = load.errors.map((e) => `  ${e.path || '<root>'}: ${e.message}`).join('\n');
    return {
      ok: false,
      exitCode: 1,
      message: `Failed to parse .cala file:\n${lines}`,
    };
  }
  const project = load.project;
  const iterations = opts.iterations ?? 1000;
  const seed = opts.seed ?? 42;

  let result;
  try {
    result = simulate({
      schedule: toScheduleInput(project),
      iterations,
      seed,
    });
  } catch (e) {
    return {
      ok: false,
      exitCode: 2,
      message: `Engine error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (result.endDates.length === 0) {
    return {
      ok: false,
      exitCode: 2,
      message:
        'Simulation completed with zero successful iterations. Check that the project graph is solvable (no cycles, decisions are reachable, loops have valid kickout conditions).',
    };
  }

  const now = opts.exportedAt ?? new Date();
  const runTimestamp = opts.runTimestamp ?? now;
  const runId = opts.runId ?? `cli-${runTimestamp.getTime()}-${seed}`;

  const json = toJson({
    result,
    iterations,
    seed,
    runId,
    runTimestamp,
    projectName: project.project.name,
    currency: project.currency,
    fxSnapshotVersion: project.fxSnapshotVersion,
    ...(project.fxRateOverrides && Object.keys(project.fxRateOverrides).length > 0
      ? { fxRateOverrides: project.fxRateOverrides }
      : {}),
    target: null,
    exportedAt: now,
    nodeNames: nameMap(project),
  });

  return { ok: true, json };
}
