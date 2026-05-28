/**
 * Phase 48 Slice 2 — empirical validation of the early-stop bar.
 *
 * Runs each template at a high-iter "ground truth" budget and at a
 * convergence-driven early-stop run, then reports the divergence in the
 * user-facing metrics (end-date percentiles, project-cost percentiles,
 * top-5 tornado entries) between the two. Confirms the convergence bar
 * is tight enough that an early-stopped run is indistinguishable from
 * the ground truth at user-perceptible precision.
 *
 *   pnpm --filter @procsim/simulation exec tsx bench/validate-early-stop.ts
 *
 * Not committed as a test — uses high-iter runs that would dominate the
 * test suite. The output is captured in the Phase 48 Slice 2 PR
 * description.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { loadProjectFile } from '@procsim/file-format';
import type { ScheduleInput } from '@procsim/scheduler';
import { simulate, type SimulationResult } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const TEMPLATES_DIR = resolve(dirname(__filename), '../../app/public/templates');

const SEED = 0xc0ffee;

interface Case {
  template: string;
  groundTruthIters: number;
  earlyStopBudget: number;
}

const CASES: ReadonlyArray<Case> = [
  { template: 'simple-sequential', groundTruthIters: 10_000, earlyStopBudget: 5_000 },
  { template: 'oncology-drug-development', groundTruthIters: 5_000, earlyStopBudget: 3_000 },
  { template: 'tentpole-feature-film', groundTruthIters: 5_000, earlyStopBudget: 3_000 },
];

function loadInput(name: string): ScheduleInput {
  const json = readFileSync(resolve(TEMPLATES_DIR, `${name}.cala`), 'utf8');
  const result = loadProjectFile(json);
  if (!result.ok) throw new Error(`Failed to load ${name}`);
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

function pctDeltaHours(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / 3_600_000;
}

function pctDeltaRelative(a: number, b: number): number {
  if (b === 0) return a === 0 ? 0 : Infinity;
  return ((a - b) / b) * 100;
}

function topNTornado(r: SimulationResult, n: number): string[] {
  return r.tornado.slice(0, n).map((t) => t.nodeId);
}

function topNCostTornado(r: SimulationResult, n: number): string[] {
  return r.costTornado.slice(0, n).map((t) => t.nodeId);
}

function rankAgreement(a: string[], b: string[]): string {
  const matches = a.filter((id, i) => b[i] === id).length;
  return `${matches}/${a.length}`;
}

function rankSetOverlap(a: string[], b: string[]): string {
  const aset = new Set(a);
  const overlap = b.filter((id) => aset.has(id)).length;
  return `${overlap}/${a.length}`;
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function run(): void {
  console.log('# Phase 48 Slice 2 — early-stop validation\n');
  console.log(`Seed: 0x${SEED.toString(16).toUpperCase()} | each run reported as median of 1\n`);

  for (const c of CASES) {
    const input = loadInput(c.template);

    process.stderr.write(`bench: ${c.template} — ground truth @ ${c.groundTruthIters}…\n`);
    const t0 = performance.now();
    const truth = simulate({
      schedule: input,
      iterations: c.groundTruthIters,
      seed: SEED,
    });
    const truthMs = performance.now() - t0;

    process.stderr.write(`bench: ${c.template} — earlyStop @ ${c.earlyStopBudget}…\n`);
    const t1 = performance.now();
    const early = simulate({
      schedule: input,
      iterations: c.earlyStopBudget,
      seed: SEED,
      earlyStop: true,
    });
    const earlyMs = performance.now() - t1;

    console.log(`## ${c.template}\n`);
    console.log(
      `Ground truth: ${c.groundTruthIters} iters in ${(truthMs / 1000).toFixed(2)}s. ` +
        `Early-stop budget: ${c.earlyStopBudget}, ran ${early.endDates.length} iters in ${(earlyMs / 1000).toFixed(2)}s ` +
        `(${early.convergence.converged ? `converged@ iter ${early.convergence.atIteration}` : 'did not converge'}).\n`,
    );

    console.log('### End-date percentiles');
    console.log('| Pctl | Ground truth | Early-stop | Δ (days) |');
    console.log('|---|---|---|---:|');
    for (const [k, gt, es] of [
      ['P50', truth.percentiles.p50, early.percentiles.p50],
      ['P80', truth.percentiles.p80, early.percentiles.p80],
      ['P95', truth.percentiles.p95, early.percentiles.p95],
    ] as const) {
      const dDays = pctDeltaHours(es as Date, gt as Date) / 24;
      console.log(`| ${k} | ${fmt(gt as Date)} | ${fmt(es as Date)} | ${dDays.toFixed(2)} |`);
    }

    console.log('\n### Cost percentiles');
    console.log('| Pctl | Ground truth | Early-stop | Δ (%) |');
    console.log('|---|---:|---:|---:|');
    for (const [k, gt, es] of [
      ['P50', truth.costPercentiles.p50, early.costPercentiles.p50],
      ['P80', truth.costPercentiles.p80, early.costPercentiles.p80],
      ['P95', truth.costPercentiles.p95, early.costPercentiles.p95],
    ] as const) {
      const delta = pctDeltaRelative(es as number, gt as number);
      console.log(
        `| ${k} | $${(gt as number).toLocaleString()} | $${(es as number).toLocaleString()} | ${delta.toFixed(2)}% |`,
      );
    }

    console.log('\n### Tornado top-5 (schedule impact)');
    const gtT = topNTornado(truth, 5);
    const esT = topNTornado(early, 5);
    console.log(`- Ground truth: ${gtT.join(', ') || '(empty)'}`);
    console.log(`- Early-stop:   ${esT.join(', ') || '(empty)'}`);
    console.log(`- Identical order: ${rankAgreement(gtT, esT)}`);
    console.log(`- Set overlap:     ${rankSetOverlap(gtT, esT)}\n`);

    console.log('### Cost tornado top-5');
    const gtC = topNCostTornado(truth, 5);
    const esC = topNCostTornado(early, 5);
    console.log(`- Ground truth: ${gtC.join(', ') || '(empty)'}`);
    console.log(`- Early-stop:   ${esC.join(', ') || '(empty)'}`);
    console.log(`- Identical order: ${rankAgreement(gtC, esC)}`);
    console.log(`- Set overlap:     ${rankSetOverlap(gtC, esC)}\n`);
  }
}

run();
