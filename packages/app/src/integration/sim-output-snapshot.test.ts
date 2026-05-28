import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectFile } from '@procsim/file-format';
import { simulate, type SimulationResult } from '@procsim/simulation';

/**
 * Phase 48 Slice 1.5 — frozen `SimulationResult` snapshots.
 *
 * The Phase 48 hard constraint is that engine semantics stay byte-identical
 * across the optimization slices that follow (cross-iteration calendar
 * cache, convergence early-stop, parallel workers). The pre-existing
 * "same seed → same result" determinism test in
 * [packages/simulation/src/index.test.ts](../../../simulation/src/index.test.ts)
 * only re-runs the engine twice in one process and compares — it would
 * silently pass if a refactor introduced a consistent output drift. These
 * snapshots catch that: every field of `SimulationResult` for three
 * representative templates is frozen to disk, and any deviation fails the
 * suite.
 *
 * **Run modes:**
 * - Default: 100-iteration cases only. ~7 s added to the suite.
 * - `SIM_DETERMINISM_FULL=1`: also runs 1 000-iteration cases. ~70 s
 *   added; intended to be run before merging a Phase 48 optimization PR.
 * - `SIM_DETERMINISM_UPDATE=1`: regenerates the snapshot files instead of
 *   comparing. Only legitimate after a *deliberate* engine-semantics
 *   change (Phase 48 is explicitly not such a change). Pair with the
 *   FULL flag to refresh the long-running fixtures too.
 *
 * Snapshots are stored as pretty-printed JSON with object keys sorted, so
 * a regression diff highlights exactly which field drifted.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = resolve(__dirname, '../../public/templates');
const FIXTURES_DIR = resolve(__dirname, '__fixtures__/sim-output');

const SEED = 0xc0ffee;
const FULL = process.env.SIM_DETERMINISM_FULL === '1';
const UPDATE = process.env.SIM_DETERMINISM_UPDATE === '1';

interface Case {
  template: string;
  iterations: number;
  long: boolean;
}

const CASES: ReadonlyArray<Case> = [
  { template: 'simple-sequential', iterations: 100, long: false },
  { template: 'simple-sequential', iterations: 1_000, long: true },
  { template: 'oncology-drug-development', iterations: 100, long: false },
  { template: 'oncology-drug-development', iterations: 1_000, long: true },
  { template: 'tentpole-feature-film', iterations: 100, long: false },
  { template: 'tentpole-feature-film', iterations: 1_000, long: true },
];

function loadScheduleInput(name: string) {
  const json = readFileSync(resolve(TEMPLATES_DIR, `${name}.cala`), 'utf8');
  const result = loadProjectFile(json);
  if (!result.ok) {
    throw new Error(
      `Failed to load template ${name}:\n  ` +
        result.errors.map((e) => `${e.path}: ${e.message}`).join('\n  '),
    );
  }
  const p = result.project;
  return {
    project: p.project,
    nodes: p.nodes,
    edges: p.edges,
    resources: p.resources,
    calendars: p.calendars,
    loops: p.loops,
    subsystems: p.subsystems,
  };
}

/**
 * Pretty-printed JSON with object keys sorted recursively. Dates serialize
 * to their ISO string via the built-in `Date.toJSON` — `JSON.stringify`
 * calls it transparently, so we don't need to convert them manually.
 */
function canonicalJson(result: SimulationResult): string {
  return JSON.stringify(
    result,
    (_key, value) => {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        !(value instanceof Date)
      ) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(value).sort()) {
          sorted[k] = (value as Record<string, unknown>)[k];
        }
        return sorted;
      }
      return value;
    },
    2,
  );
}

function fixturePath(template: string, iterations: number): string {
  return resolve(FIXTURES_DIR, `${template}-${iterations}.json`);
}

describe('simulate() — frozen output snapshots (Phase 48 Slice 1.5)', () => {
  for (const { template, iterations, long } of CASES) {
    const runIt = long && !FULL ? it.skip : it;
    const tag = long ? ' [long]' : '';
    runIt(`${template} @ ${iterations} iters${tag}`, () => {
      const input = loadScheduleInput(template);
      const result = simulate({ schedule: input, iterations, seed: SEED });
      const actual = canonicalJson(result);
      const path = fixturePath(template, iterations);

      if (UPDATE || !existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, actual + '\n', 'utf8');
        if (!UPDATE) {
          // First-run generation: write the fixture and ALSO assert it
          // round-trips, so the test still functions as a comparison from
          // its very first run. Failing here would mean the canonicalizer
          // is non-deterministic, which is a bug we need to know about.
          const written = readFileSync(path, 'utf8');
          expect(written.replace(/\n$/, '')).toBe(actual);
        }
        return;
      }

      const expected = readFileSync(path, 'utf8').replace(/\n$/, '');
      expect(actual).toBe(expected);
    });
  }
});
