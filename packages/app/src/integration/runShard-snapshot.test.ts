/**
 * Phase 48 Slice 4b — template-level `runShard` / `assembleFromShards`
 * determinism canary.
 *
 * Mirrors `sim-output-snapshot.test.ts` (Slice 1.5) but for the parallel
 * engine path: for each of the same three template fixtures, runs
 * `simulate(input)` and sharded `assembleFromShards(input, runShard...)`
 * and asserts byte-equality of every field — convergence included now
 * that the Slice 4b follow-up replays it post-merge.
 *
 * Lives in `packages/app` for the same reason Slice 1.5's snapshot test
 * does: the canonical templates live in `packages/app/public/templates`
 * and the engine package can't reach them without breaking the
 * file-format → calendar → scheduler → simulation → app dep chain.
 *
 * The previous-session refactor attempt drifted specifically on these
 * giant templates (Oncology / Tentpole) in cost-related fields; the
 * synthetic engine-level canary (`packages/simulation/src/runShard.test.ts`)
 * catches the per-stream RNG cases but the templates exercise the full
 * cost-engine path at realistic node-counts. Keeping both layers.
 *
 * Run modes mirror Slice 1.5:
 *   default: 100-iter cases only (fast).
 *   SIM_DETERMINISM_FULL=1: also 1000-iter cases.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectFile } from '@procsim/file-format';
import { simulate, type SimulationInput, type SimulationResult } from '@procsim/simulation';
import { runShard, assembleFromShards } from '@procsim/simulation';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = resolve(__dirname, '../../public/templates');

const SEED = 0xc0ffee;
const FULL = process.env.SIM_DETERMINISM_FULL === '1';

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

/** Split [0, total) into `nShards` roughly-equal half-open ranges. */
function shardRanges(total: number, nShards: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const base = Math.floor(total / nShards);
  const extra = total - base * nShards;
  let cursor = 0;
  for (let i = 0; i < nShards; i++) {
    const size = base + (i < extra ? 1 : 0);
    ranges.push([cursor, cursor + size]);
    cursor += size;
  }
  return ranges;
}

function simulateParallelInProcess(input: SimulationInput, nShards: number): SimulationResult {
  const shards = shardRanges(input.iterations, nShards).map(([s, e]) =>
    runShard(input, { iterStart: s, iterEnd: e, totalIterations: input.iterations }),
  );
  return assembleFromShards(input, shards);
}

describe('runShard + assembleFromShards — template canary (Phase 48 Slice 4b)', () => {
  for (const { template, iterations, long } of CASES) {
    const runIt = long && !FULL ? it.skip : it;
    const tag = long ? ' [long]' : '';

    runIt(`${template} @ ${iterations} iters — 4-shard parallel matches simulate()${tag}`, () => {
      const schedule = loadScheduleInput(template);
      const input: SimulationInput = { schedule, iterations, seed: SEED };
      const direct = simulate(input);
      const parallel = simulateParallelInProcess(input, 4);
      // Full equality including convergence — replay matches simulate()'s
      // in-loop convergence detector iter-for-iter.
      expect(parallel).toEqual(direct);
    });
  }
});
