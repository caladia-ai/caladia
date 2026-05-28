/**
 * Phase 48 Slice 1 — Simulation performance benchmark harness.
 *
 * Pure measurement; no engine modifications. Loads shipped `.cala` templates
 * from `packages/app/public/templates/`, runs `simulate()` and `schedule()`
 * under controlled timing, and prints a markdown table.
 *
 * Runs the full matrix by default:
 *   pnpm --filter @procsim/simulation bench
 *
 * For a V8 CPU profile of one configuration (uses node:inspector so worker-
 * thread profiling works under tsx, unlike `--cpu-prof`):
 *   pnpm --filter @procsim/simulation bench -- \
 *     --only oncology-drug-development:1000 \
 *     --profile /tmp/oncology-1k.cpuprofile
 *   (then open in Chrome DevTools → Performance → Load profile)
 *
 * Output goes to stdout as a markdown table — pipe to `tee baseline.md` to
 * snapshot. Each row reports median + (max − min) range across MEASURED_RUNS,
 * after one untimed warmup pass that lets V8 settle JIT optimisations.
 *
 * The schedule()-only column is a single `schedule(input)` call (median over
 * SCHEDULE_REPS calls) × the iteration count, modelling "what `simulate()`
 * would cost if all per-iteration sampling + aggregation were free." The
 * residual is the engine wrapping cost (sampling, criticality bookkeeping,
 * percentile maintenance, sensitivity capture, cost-curve buckets, etc).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Session } from 'node:inspector/promises';

import { loadProjectFile } from '@procsim/file-format';
import type { ScheduleInput } from '@procsim/scheduler';
import { schedule } from '@procsim/scheduler';
import { simulate, runShard, assembleFromShards } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const TEMPLATES_DIR = resolve(dirname(__filename), '../../app/public/templates');

const SEED = 0xc0ffee;
const WARMUP_RUNS = 1;
const MEASURED_RUNS = 3;
// Per-call schedule() repetitions for the differential. Enough to dilute
// per-call JIT noise without dominating bench wall-clock.
const SCHEDULE_REPS = 25;

// Phase 48 Slice 2 — passes earlyStop into simulate() when --early-stop is
// supplied on the CLI. Off by default to preserve the Slice 1 baseline
// numbers in baseline.md.
const EARLY_STOP = process.argv.includes('--early-stop');

// Phase 48 Slice 4b — when `--parallel N` is supplied, ALSO measures the
// parallel engine path by running N `runShard` calls sequentially in-
// process and merging via `assembleFromShards`. Node has no Web Workers
// so this measures merge-overhead + correctness only — actual wall-
// clock speedup must be captured in-browser. Useful to confirm the
// parallel path's overhead vs `simulate()` for a given shard count.
function parseParallelFlag(): number | null {
  const idx = process.argv.indexOf('--parallel');
  if (idx < 0) return null;
  const arg = process.argv[idx + 1];
  if (!arg) throw new Error('--parallel requires <N> (positive integer)');
  const n = Number.parseInt(arg, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`--parallel <N> must be a positive integer, got "${arg}"`);
  }
  return n;
}
const PARALLEL_N = parseParallelFlag();

interface MatrixEntry {
  template: string;
  iterations: number[];
}

const MATRIX: ReadonlyArray<MatrixEntry> = [
  { template: 'simple-sequential', iterations: [1_000, 10_000] },
  { template: 'oncology-drug-development', iterations: [100, 1_000, 10_000] },
  { template: 'tentpole-feature-film', iterations: [100, 1_000, 10_000] },
];

function loadScheduleInput(templateName: string): ScheduleInput {
  const json = readFileSync(resolve(TEMPLATES_DIR, `${templateName}.cala`), 'utf8');
  const result = loadProjectFile(json);
  if (!result.ok) {
    const detail = result.errors.map((e) => `${e.path}: ${e.message}`).join('\n  ');
    throw new Error(`Failed to load ${templateName}:\n  ${detail}`);
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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 10) return `${ms.toFixed(0)}ms`;
  return `${ms.toFixed(1)}ms`;
}

function timeOnce(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

interface Row {
  template: string;
  iterations: number;
  nodes: number;
  edges: number;
  loops: number;
  simulateMedianMs: number;
  simulateMinMs: number;
  simulateMaxMs: number;
  schedulePerCallMs: number;
  scheduleExtrapolatedMs: number;
  wrappingOverheadMs: number;
  wrappingOverheadPct: number;
  earlyStop: boolean;
  convergedAt: number | null;
  effectiveIters: number;
  /** Phase 48 Slice 4b — median sequential in-process parallel-path time
   *  (runShard N times + assembleFromShards). Null when --parallel is off. */
  parallelMedianMs: number | null;
  parallelOverheadPct: number | null;
}

/** Split [0, total) into `n` half-open ranges in iter-ascending order. */
function shardRanges(total: number, n: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const base = Math.floor(total / n);
  const extra = total - base * n;
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const size = base + (i < extra ? 1 : 0);
    ranges.push([cursor, cursor + size]);
    cursor += size;
  }
  return ranges;
}

/** Run the parallel engine path with `n` shards SEQUENTIALLY in-process. */
function runParallelInProcess(input: ScheduleInput, iterations: number, n: number): void {
  const simInput = { schedule: input, iterations, seed: SEED };
  const ranges = shardRanges(iterations, n);
  const shards = ranges.map(([s, e]) =>
    runShard(simInput, { iterStart: s, iterEnd: e, totalIterations: iterations }),
  );
  assembleFromShards(simInput, shards);
}

function benchOne(template: string, iterations: number): Row {
  const input = loadScheduleInput(template);
  const simInput = { schedule: input, iterations, seed: SEED, earlyStop: EARLY_STOP };

  // Warmup — settle JIT before the measured runs.
  for (let i = 0; i < WARMUP_RUNS; i++) {
    simulate(simInput);
  }

  // Measured `simulate()` runs. Capture the last result so we can report
  // `convergence.atIteration` + `endDates.length` (the actual iters run
  // when --early-stop fires).
  let lastResult: ReturnType<typeof simulate> | null = null;
  const simulateRuns: number[] = [];
  for (let i = 0; i < MEASURED_RUNS; i++) {
    simulateRuns.push(
      timeOnce(() => {
        lastResult = simulate(simInput);
      }),
    );
  }
  const convergedAt = lastResult?.convergence.atIteration ?? null;
  const effectiveIters = lastResult?.endDates.length ?? iterations;

  // Per-call `schedule()` cost: a tight loop with the static input, median
  // across SCHEDULE_REPS calls (after warming). Static-input schedule() does
  // the same CPM topology + calendar + loop work that `simulate()` repeats
  // per iteration, with only the duration / passProbability scalars varying.
  for (let i = 0; i < WARMUP_RUNS; i++) schedule(input);
  const schedRuns: number[] = [];
  for (let i = 0; i < SCHEDULE_REPS; i++) {
    schedRuns.push(timeOnce(() => schedule(input)));
  }
  const schedulePerCallMs = median(schedRuns);

  const simulateMedianMs = median(simulateRuns);
  const simulateMinMs = Math.min(...simulateRuns);
  const simulateMaxMs = Math.max(...simulateRuns);
  const scheduleExtrapolatedMs = schedulePerCallMs * iterations;
  const wrappingOverheadMs = simulateMedianMs - scheduleExtrapolatedMs;
  const wrappingOverheadPct = (wrappingOverheadMs / simulateMedianMs) * 100;

  // Phase 48 Slice 4b — optional sequential in-process parallel-path
  // timing. Same warm/measured pattern as simulate(). Wall-clock here
  // is NOT representative of in-browser parallel speedup (Node has no
  // Web Workers); useful for spotting overhead drift in the
  // assembleFromShards merge step at a given shard count.
  let parallelMedianMs: number | null = null;
  let parallelOverheadPct: number | null = null;
  if (PARALLEL_N !== null) {
    for (let i = 0; i < WARMUP_RUNS; i++) {
      runParallelInProcess(input, iterations, PARALLEL_N);
    }
    const parallelRuns: number[] = [];
    for (let i = 0; i < MEASURED_RUNS; i++) {
      parallelRuns.push(timeOnce(() => runParallelInProcess(input, iterations, PARALLEL_N)));
    }
    parallelMedianMs = median(parallelRuns);
    parallelOverheadPct = ((parallelMedianMs - simulateMedianMs) / simulateMedianMs) * 100;
  }

  return {
    template,
    iterations,
    nodes: input.nodes.length,
    edges: input.edges.length,
    loops: input.loops.length,
    simulateMedianMs,
    simulateMinMs,
    simulateMaxMs,
    schedulePerCallMs,
    scheduleExtrapolatedMs,
    wrappingOverheadMs,
    wrappingOverheadPct,
    earlyStop: EARLY_STOP,
    convergedAt,
    effectiveIters,
    parallelMedianMs,
    parallelOverheadPct,
  };
}

function printTable(rows: Row[]): void {
  console.log('');
  const earlyStopCol = rows.some((r) => r.earlyStop) ? ' converged@ | effective iters |' : '';
  const earlyStopAlign = rows.some((r) => r.earlyStop) ? '---:|---:|' : '';
  const parallelCol =
    PARALLEL_N !== null ? ` parallel(${PARALLEL_N}) in-proc | vs simulate() |` : '';
  const parallelAlign = PARALLEL_N !== null ? '---:|---:|' : '';
  console.log(
    `| Template | Nodes / Edges / Loops | Iters | simulate() median | range | schedule() per call | N × schedule() | wrapping overhead |${parallelCol}${earlyStopCol}`,
  );
  console.log(`|---|---|---:|---:|---:|---:|---:|---:|${parallelAlign}${earlyStopAlign}`);
  for (const r of rows) {
    const shape = `${r.nodes} / ${r.edges} / ${r.loops}`;
    const range = `${fmtMs(r.simulateMaxMs - r.simulateMinMs)}`;
    const wrappingPct = r.wrappingOverheadPct.toFixed(1);
    const earlyStopFields = r.earlyStop ? ` ${r.convergedAt ?? '—'} | ${r.effectiveIters} |` : '';
    const parallelFields =
      PARALLEL_N !== null && r.parallelMedianMs !== null && r.parallelOverheadPct !== null
        ? ` ${fmtMs(r.parallelMedianMs)} | ${r.parallelOverheadPct >= 0 ? '+' : ''}${r.parallelOverheadPct.toFixed(1)}% |`
        : '';
    console.log(
      `| \`${r.template}\` | ${shape} | ${r.iterations} | ${fmtMs(r.simulateMedianMs)} | ${range} | ${fmtMs(r.schedulePerCallMs)} | ${fmtMs(r.scheduleExtrapolatedMs)} | ${fmtMs(r.wrappingOverheadMs)} (${wrappingPct}%) |${parallelFields}${earlyStopFields}`,
    );
  }
  console.log('');
}

function parseOnlyFlag(): { template: string; iterations: number } | null {
  const idx = process.argv.indexOf('--only');
  if (idx < 0) return null;
  const arg = process.argv[idx + 1];
  if (!arg) throw new Error('--only requires <template>:<iterations>');
  const [t, n] = arg.split(':');
  if (!t || !n) throw new Error('--only format: <template>:<iterations>');
  const iters = Number.parseInt(n, 10);
  if (!Number.isFinite(iters) || iters <= 0) {
    throw new Error(`--only iterations must be a positive integer, got "${n}"`);
  }
  return { template: t, iterations: iters };
}

function parseProfileFlag(): string | null {
  const idx = process.argv.indexOf('--profile');
  if (idx < 0) return null;
  const out = process.argv[idx + 1];
  if (!out) throw new Error('--profile requires <output-path>');
  return out;
}

async function profileOne(template: string, iterations: number, outPath: string): Promise<void> {
  const input = loadScheduleInput(template);
  // Warmup so the profile reflects steady-state JIT-optimised code.
  for (let i = 0; i < WARMUP_RUNS; i++) {
    simulate({ schedule: input, iterations, seed: SEED });
  }

  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 200 });
  await session.post('Profiler.start');

  simulate({ schedule: input, iterations, seed: SEED });

  const { profile } = (await session.post('Profiler.stop')) as { profile: unknown };
  session.disconnect();

  writeFileSync(outPath, JSON.stringify(profile));
  console.log(`\nProfile written to ${outPath} (${template} @ ${iterations} iters).`);
  console.log(`Open in Chrome DevTools → Performance → Load profile.`);
}

async function main(): Promise<void> {
  const node = `node ${process.versions.node}`;
  const v8 = `v8 ${process.versions.v8}`;
  console.log(`# Phase 48 — simulation bench`);
  console.log('');
  const parallelStr = PARALLEL_N !== null ? ` | parallel(N=${PARALLEL_N}) in-proc` : '';
  console.log(
    `Runtime: ${node}, ${v8} | seed: 0x${SEED.toString(16).toUpperCase()} | warmup: ${WARMUP_RUNS} | measured: ${MEASURED_RUNS} | schedule-reps: ${SCHEDULE_REPS} | earlyStop: ${EARLY_STOP}${parallelStr}`,
  );

  const only = parseOnlyFlag();
  const profileOut = parseProfileFlag();

  if (profileOut) {
    if (!only) {
      throw new Error('--profile requires --only <template>:<iters> to scope the capture');
    }
    await profileOne(only.template, only.iterations, profileOut);
    return;
  }

  const rows: Row[] = [];

  if (only) {
    console.log(`\nRunning only: ${only.template} @ ${only.iterations} iters`);
    rows.push(benchOne(only.template, only.iterations));
  } else {
    for (const { template, iterations } of MATRIX) {
      for (const n of iterations) {
        process.stderr.write(`bench: ${template} @ ${n} iters…\n`);
        rows.push(benchOne(template, n));
      }
    }
  }

  printTable(rows);
}

await main();
