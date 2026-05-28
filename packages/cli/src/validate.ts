/**
 * Pure core of the `caladia validate` subcommand. Takes a `.cala` file's
 * contents (as a string) and reports whether it parses cleanly against
 * the current schema. Produces either a structured summary on success
 * or a list of validation errors on failure.
 *
 * Audit N-7 — gives scripts / CI a no-side-effects way to gate on file
 * validity. Use cases:
 *   - pre-commit / CI hooks that verify .cala files in a repo parse
 *   - bulk validation of a directory of project files
 *   - smoke-checking exported subsystem snapshots
 *
 * Kept separate from the Commander entry in `index.ts` so the smoke
 * tests can drive it directly without spawning a child process.
 */

import { loadProjectFile, type ProjectFile } from '@procsim/file-format';
import type { TruncationWarning } from '@procsim/file-format';

export interface RunValidateOptions {
  /** Raw `.cala` file contents (JSON text). */
  contents: string;
}

export interface ProjectSummary {
  /** Schema version of the loaded project (always 8 on current main; older
   *  versions migrate forward on load and report as 8 here). */
  version: number;
  nodes: number;
  edges: number;
  resources: number;
  calendars: number;
  subsystems: number;
  loops: number;
  scenarios: number;
}

export type RunValidateResult =
  | {
      ok: true;
      summary: ProjectSummary;
      /** Free-text fields that were truncated during load. Empty when no
       *  truncation happened — present (and non-empty) when one or more
       *  description / note fields exceeded their schema cap. */
      truncationWarnings: ReadonlyArray<TruncationWarning>;
    }
  | {
      ok: false;
      exitCode: 1;
      errors: ReadonlyArray<{ path: string; message: string }>;
    };

function projectSummary(project: ProjectFile): ProjectSummary {
  return {
    version: project.version,
    nodes: project.nodes.length,
    edges: project.edges.length,
    resources: project.resources.length,
    calendars: project.calendars.length,
    subsystems: project.subsystems.length,
    loops: project.loops.length,
    scenarios: project.scenarios.length,
  };
}

export function runValidate(opts: RunValidateOptions): RunValidateResult {
  const load = loadProjectFile(opts.contents);
  if (!load.ok) {
    return {
      ok: false,
      exitCode: 1,
      errors: load.errors.map((e) => ({
        path: e.path || '<root>',
        message: e.message,
      })),
    };
  }
  return {
    ok: true,
    summary: projectSummary(load.project),
    truncationWarnings: load.truncationWarnings ?? [],
  };
}

// ── Output formatting helpers ────────────────────────────────────────────────
//
// Kept here (not in index.ts) so the test file can lock in the exact
// wording — guards against silent drift if someone tweaks a string.

/**
 * Human-readable single-line summary like
 * `Valid V8 .cala file: 12 nodes, 15 edges, 3 resources, 2 calendars, 1 subsystem, 1 loop, 2 scenarios`.
 *
 * Pluralisation is correct per count; singular for 1.
 */
export function formatSummaryLine(summary: ProjectSummary): string {
  const parts = [
    plural(summary.nodes, 'node'),
    plural(summary.edges, 'edge'),
    plural(summary.resources, 'resource'),
    plural(summary.calendars, 'calendar'),
    plural(summary.subsystems, 'subsystem'),
    plural(summary.loops, 'loop'),
    plural(summary.scenarios, 'scenario'),
  ];
  return `Valid V${summary.version} .cala file: ${parts.join(', ')}`;
}

function plural(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : noun + 's'}`;
}

/** Format a truncation-warning array as a multi-line block. */
export function formatTruncationWarnings(warnings: ReadonlyArray<TruncationWarning>): string {
  const lines = [`${warnings.length} field${warnings.length === 1 ? '' : 's'} truncated on load:`];
  for (const w of warnings) {
    lines.push(`  ${w.path}: ${w.originalLength} → ${w.truncatedTo} chars`);
  }
  return lines.join('\n');
}

/** Format a validation-error array as a multi-line block. */
export function formatErrors(errors: ReadonlyArray<{ path: string; message: string }>): string {
  const lines = ['Invalid .cala file:'];
  for (const e of errors) {
    lines.push(`  ${e.path}: ${e.message}`);
  }
  return lines.join('\n');
}
