import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type { ProjectFile } from '@procsim/file-format';
import { currencyGlyph, convertResourceCostsToProjectCurrency } from '@procsim/file-format';
import type { SimulationResult } from '@procsim/simulation';
import { getEngineWorker } from '../engineWorker.js';
import { prewarmWorkerPool } from '../lib/workerPool.js';
import { simulateParallel, PARALLEL_FALLBACK_THRESHOLD } from '../lib/simulateParallel.js';
import { useDomainStore, beginEdit, commitEdit } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import type { SimRun } from '../store/viewStore.js';
import { ScenariosView } from './ScenariosView.js';
import { ParetoSweepPanel } from './ParetoSweepPanel.js';
import { useSchedule } from '../hooks/useSchedule.js';
import {
  formatMoney,
  formatMoneyDual,
  getEffectiveFxSnapshot,
  projectHasCostData,
} from '../utils/cost.js';
import { snapToNearest, useChartCursor } from '../utils/cursor.js';
import { useContainerWidth } from '../hooks/useContainerWidth.js';
import {
  toJson as simToJson,
  toCsv as simToCsv,
  toCostCsv as simToCostCsv,
  buildExportFilename,
} from '../lib/exportSim.js';
import { triggerDownload } from '../lib/export.js';
import {
  startSimRun,
  cancelActiveSim,
  clearSimControllerIfMatches,
} from '../lib/simRunController.js';

interface SimulateViewProps {
  project: ProjectFile;
}

type SimTab = 'montecarlo' | 'compare' | 'scenarios' | 'crashsweep';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Phase 47 Slice 2 — format a budget value with thousands separators
 * for display in the budget input. We use `en-US` grouping regardless
 * of the project's currency because the input strips non-digits on
 * parse (so any locale's grouping char re-enters as a digit-only string).
 * Locale-aware currency display happens elsewhere via `formatMoneyDual`.
 */
// Audit I-24 — the module-level AbortController singleton that used to
// live here is now in `lib/simRunController.ts` so `App.handleProjectLoad`
// can abort an in-flight sim when the user switches projects (without
// reaching into SimulateView's private state). The singleton's
// "abort-prior-on-replace" semantic is unchanged.

/**
 * Phase 48 Slice 4b follow-up — witty stand-ins for the "0%" label
 * during the parallel path's warm-up window. The pool may need a few
 * hundred ms to spawn fresh workers on the first run, and even after
 * pre-warm the first shard takes a couple of seconds at 10k iters /
 * giant template — long enough to feel stalled.
 *
 * Picked at random per-run (in `run()` below) and cleared on completion.
 * The VerdictBar swaps the "0%" label for this string while
 * `simProgress === 0`; the moment a real shard reports it falls back to
 * the percentage.
 */
const SIM_WARMUP_MESSAGES: ReadonlyArray<string> = [
  'Recruiting workers…',
  'Loading the dice…',
  'Forking timelines…',
  'Spinning up parallel universes…',
  'Sharpening the pencils…',
];

// Module-level so successive runs across re-mounts still avoid the same
// message twice in a row. With only 5 messages a uniform random pick
// repeats ~1-in-5; excluding the previous brings it to 0.
let lastWarmupMessage: string | null = null;

function pickWarmupMessage(): string {
  const pool = lastWarmupMessage
    ? SIM_WARMUP_MESSAGES.filter((m) => m !== lastWarmupMessage)
    : SIM_WARMUP_MESSAGES;
  const picked = pool[Math.floor(Math.random() * pool.length)] ?? SIM_WARMUP_MESSAGES[0]!;
  lastWarmupMessage = picked;
  return picked;
}

function formatBudgetGroups(n: number): string {
  if (!isFinite(n)) return '';
  return Math.round(n).toLocaleString('en-US');
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function projectSnapshot(project: ProjectFile): string {
  return JSON.stringify(project);
}

/**
 * Project end date in days since project.startDate. Used as the x-axis unit
 * across the verdict bar and the histogram.
 */
function daysSinceProjectStart(d: Date, projectStart: Date): number {
  return (d.getTime() - projectStart.getTime()) / 86_400_000;
}

/** Linear-interpolated percentile of a sorted Date array. */
function percentileOf(sorted: Date[], p: number): Date | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx]!;
}

// ── Main component ────────────────────────────────────────────────────────────

export function SimulateView({ project }: SimulateViewProps) {
  const [simTab, setSimTab] = useState<SimTab>('montecarlo');
  // Phase 26 — Pareto sweep tab is hidden when the project has no crash
  // options anywhere (sweep would have nothing to chew on). Also feeds
  // the ParetoSweepPanel with the schedule it needs.
  const scheduleOutcome = useSchedule();
  const projectHasCrashOptions = useMemo(
    () => project.nodes.some((n) => (n.crashOptions?.length ?? 0) > 0),
    [project.nodes],
  );
  // Phase 47 Slice 3 follow-up — sim-run status now lives in viewStore so
  // the progress bar / cancel button survive tab switches. The worker
  // itself is a persistent singleton (engineWorker.ts) so the simulation
  // keeps running in the background regardless of which tab is active;
  // the previous bug was purely that the local React state died with
  // the unmounted SimulateView.
  const running = useViewStore((s) => s.simRunning);
  const progress = useViewStore((s) => s.simProgress);
  const lastRunMs = useViewStore((s) => s.simLastRunMs);
  const error = useViewStore((s) => s.simError);
  const warmupMessage = useViewStore((s) => s.simWarmupMessage);
  const setRunning = useViewStore((s) => s.setSimRunning);
  const setProgress = useViewStore((s) => s.setSimProgress);
  const setLastRunMs = useViewStore((s) => s.setSimLastRunMs);
  const setError = useViewStore((s) => s.setSimError);
  const setWarmupMessage = useViewStore((s) => s.setSimWarmupMessage);

  const iterations = useViewStore((s) => s.mcIterations);
  const seed = useViewStore((s) => s.mcSeed);
  const setIterations = useViewStore((s) => s.setMcIterations);
  const setSeed = useViewStore((s) => s.setMcSeed);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const simHistory = useViewStore((s) => s.simHistory);
  const addSimRun = useViewStore((s) => s.addSimRun);
  const clearSimHistory = useViewStore((s) => s.clearSimHistory);

  const latestRun = simHistory[0] ?? null;
  const selectedRun: SimRun | null = selectedRunId
    ? (simHistory.find((r) => r.id === selectedRunId) ?? latestRun)
    : latestRun;

  const currentSnapshot = useMemo(() => projectSnapshot(project), [project]);
  const isStale = latestRun !== null && latestRun.projectSnapshot !== currentSnapshot;

  // Target date — local UI state (no schema field yet). Defaults to the latest
  // run's P50 once it lands, otherwise blank. User can shift it earlier or
  // later to ask "what's my probability of hitting this date?"
  const [target, setTarget] = useState<string>('');
  useEffect(() => {
    // Initialise target the first time a run lands so the verdict tile has
    // something meaningful to show.
    if (!target && latestRun) {
      const p50 = latestRun.result.percentiles.p50;
      setTarget(p50.toISOString().slice(0, 10));
    }
  }, [latestRun, target]);

  // Phase 48 Slice 4b — pre-warm the parallel worker pool so the first
  // Run click pays no spawn latency. Idempotent across remounts; pool is
  // module-singleton and lives for the tab session.
  useEffect(() => {
    prewarmWorkerPool();
  }, []);

  const handleCancel = useCallback(() => {
    cancelActiveSim();
  }, []);

  /**
   * Run a simulation. `opts.excludes` triggers a what-if run that omits
   * the given nodes' distributions; `opts.onDone` lets the caller react
   * after the run lands (e.g. switching to the Compare sub-tab once a
   * what-if run is in history).
   */
  const run = useCallback(
    (
      opts: {
        excludes?: ReadonlyArray<string>;
        onDone?: (newRunId: string) => void;
      } = {},
    ) => {
      setRunning(true);
      setProgress(0);
      setWarmupMessage(pickWarmupMessage());
      setError(null);
      const startedAt = performance.now();
      // Audit I-24 — `startSimRun` installs the new AbortController and
      // aborts any prior in-flight run. Lives in `lib/simRunController.ts`
      // so the cancel path is also reachable from App-level handlers
      // (project load, new project, template pick).
      const abort = startSimRun();

      const simInput = {
        schedule: {
          project: project.project,
          nodes: project.nodes,
          edges: project.edges,
          // Phase 33 Slice 2 — convert per-resource costs from
          // override currency to project currency before the
          // engine sees them.
          resources: convertResourceCostsToProjectCurrency(project),
          calendars: project.calendars,
          loops: project.loops,
          subsystems: project.subsystems,
        },
        iterations,
        seed,
        // Phase 48 — earlyStop is supported by the engine
        // (packages/simulation/src/index.ts) but intentionally not
        // opted in from the app. The "Iterations" budget shown in
        // the UI then matches what actually ran. The single-thread
        // path below still emits `convergence.atIteration` as a
        // diagnostic; the parallel path reports it as `null` by
        // design (see lib/simulateParallel.ts).
        ...(opts.excludes && opts.excludes.length > 0
          ? { excludeNodeDistributions: opts.excludes }
          : {}),
      };

      // Phase 48 Slice 4b — fork on iter budget. Small runs go via the
      // single-worker singleton so the convergence diagnostic keeps
      // working; large runs go via the worker pool for parallel speedup.
      const run$ =
        iterations >= PARALLEL_FALLBACK_THRESHOLD
          ? simulateParallel(simInput, abort.signal, (pct) => setProgress(pct))
          : getEngineWorker().simulateAsync(simInput, abort.signal, (pct) => setProgress(pct));

      void run$
        .then((r: SimulationResult) => {
          setLastRunMs(performance.now() - startedAt);
          const newRun: SimRun = {
            id: `run-${Date.now()}`,
            timestamp: new Date(),
            iterations,
            seed,
            result: r,
            projectSnapshot: currentSnapshot,
            ...(opts.excludes && opts.excludes.length > 0 ? { excludes: opts.excludes } : {}),
          };
          addSimRun(newRun);
          setSelectedRunId(null);
          opts.onDone?.(newRun.id);
        })
        .catch((e: unknown) => {
          if (e instanceof Error && e.name === 'AbortError') return;
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          setRunning(false);
          setProgress(null);
          setWarmupMessage(null);
          // Clear the singleton only if it still references THIS run.
          // A second click before the first one completes would have
          // replaced the handle; the equality check guards against the
          // late-arriving finally of the cancelled run clobbering the
          // new one.
          clearSimControllerIfMatches(abort);
        });
    },
    [project, iterations, seed, currentSnapshot, addSimRun],
  );

  const hasDistributions = project.nodes.some((n) => n.distribution !== undefined);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-gray-50 dark:bg-gray-950">
      {/* Sub-tab bar */}
      <div className="shrink-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 flex items-center gap-0">
        {[
          { id: 'montecarlo' as const, label: 'Monte Carlo', visible: true },
          { id: 'compare' as const, label: 'Compare', visible: true },
          { id: 'scenarios' as const, label: 'Scenarios', visible: true },
          // Phase 26 — only show "Crash sweep" when there are crash
          // options to sweep.
          {
            id: 'crashsweep' as const,
            label: 'Compression sweep',
            visible: projectHasCrashOptions,
          },
        ]
          .filter((t) => t.visible)
          .map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setSimTab(id)}
              disabled={id === 'compare' && simHistory.length < 2}
              title={
                id === 'compare' && simHistory.length < 2
                  ? 'Run two simulations to compare them'
                  : undefined
              }
              className={[
                'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                simTab === id
                  ? 'border-emerald-500 text-emerald-700 dark:text-emerald-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
      </div>

      {simTab === 'scenarios' && <ScenariosView project={project} />}
      {simTab === 'compare' && (
        <CompareView simHistory={simHistory} project={project} target={target} />
      )}
      {simTab === 'crashsweep' && projectHasCrashOptions && scheduleOutcome.ok && (
        <ParetoSweepPanel project={project} result={scheduleOutcome.result} />
      )}

      {simTab === 'montecarlo' && (
        <>
          <VerdictBar
            project={project}
            run={selectedRun}
            iterations={iterations}
            setIterations={setIterations}
            seed={seed}
            setSeed={setSeed}
            running={running}
            progress={progress}
            warmupMessage={warmupMessage}
            lastRunMs={lastRunMs}
            target={target}
            setTarget={setTarget}
            onRun={() => run()}
            onCancel={handleCancel}
            hasDistributions={hasDistributions}
          />

          {isStale && (
            <div className="shrink-0 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800 px-6 py-2 flex items-center gap-3">
              <span className="text-amber-700 dark:text-amber-400 text-sm font-medium">
                ⚠ Simulation is out of date
              </span>
              <span className="text-amber-600 dark:text-amber-500 text-xs">
                The project has changed since the last run. Click ▶ Re-run to refresh.
              </span>
            </div>
          )}

          {error && (
            <div className="shrink-0 mx-6 mt-3 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-4 py-2 text-sm text-red-700 dark:text-red-400">
              {error}
            </div>
          )}

          {simHistory.length > 1 && (
            <div className="shrink-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 flex items-center gap-1 overflow-x-auto">
              {simHistory.map((r, i) => {
                const isActive = r.id === (selectedRun?.id ?? latestRun?.id);
                const isRunStale = r.projectSnapshot !== currentSnapshot;
                return (
                  <button
                    key={r.id}
                    onClick={() => setSelectedRunId(r.id)}
                    className={[
                      'shrink-0 px-3 py-2 text-xs border-b-2 transition-colors whitespace-nowrap',
                      isActive
                        ? 'border-emerald-500 text-emerald-700 dark:text-emerald-400 font-medium'
                        : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700',
                    ].join(' ')}
                    title={`${r.iterations.toLocaleString()} iterations, seed ${r.seed}`}
                  >
                    {i === 0 ? 'Latest' : `Run ${simHistory.length - i}`}{' '}
                    <span className="opacity-60">{fmtTime(r.timestamp)}</span>
                    {isRunStale && (
                      <span className="ml-1 text-amber-500" title="Project changed since this run">
                        ●
                      </span>
                    )}
                  </button>
                );
              })}
              {simHistory.length > 0 && (
                <button
                  onClick={clearSimHistory}
                  className="ml-auto text-xs text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 px-2 py-2"
                  title="Clear all simulation history"
                >
                  Clear history
                </button>
              )}
            </div>
          )}

          {selectedRun ? (
            <SimulationResultView
              result={selectedRun.result}
              project={project}
              target={target}
              running={running}
              onRunWhatIf={(nodeId) => {
                run({
                  excludes: [nodeId],
                  onDone: () => setSimTab('compare'),
                });
              }}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500 text-sm">
              Configure distributions on nodes, then click ▶ Run.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Verdict bar ──────────────────────────────────────────────────────────────

interface VerdictBarProps {
  project: ProjectFile;
  run: SimRun | null;
  iterations: number;
  setIterations: (n: number) => void;
  seed: number;
  setSeed: (n: number) => void;
  running: boolean;
  progress: number | null;
  warmupMessage: string | null;
  lastRunMs: number | null;
  target: string;
  setTarget: (v: string) => void;
  onRun: () => void;
  onCancel: () => void;
  hasDistributions: boolean;
}

function VerdictBar({
  project,
  run,
  iterations,
  setIterations,
  seed,
  setSeed,
  running,
  progress,
  warmupMessage,
  lastRunMs,
  target,
  setTarget,
  onRun,
  onCancel,
  hasDistributions,
}: VerdictBarProps) {
  const projectStart = useMemo(
    () => new Date(project.project.startDate + 'T00:00:00'),
    [project.project.startDate],
  );

  const result = run?.result ?? null;
  const sortedEndDates = useMemo(() => {
    if (!result) return null;
    return [...result.endDates].sort((a, b) => a.getTime() - b.getTime());
  }, [result]);

  const p50 = result?.percentiles.p50 ?? null;
  const p95 = result?.percentiles.p95 ?? null;
  const p10 = sortedEndDates ? percentileOf(sortedEndDates, 0.1) : null;

  const p50Days = p50 ? daysSinceProjectStart(p50, projectStart) : null;
  const p10Days = p10 ? daysSinceProjectStart(p10, projectStart) : null;
  const p95Days = p95 ? daysSinceProjectStart(p95, projectStart) : null;

  // Probability of meeting the target = fraction of iterations whose end date
  // is on or before the target.
  const targetDate = target ? new Date(target + 'T23:59:59') : null;
  const targetDays = targetDate ? daysSinceProjectStart(targetDate, projectStart) : null;
  const targetProbPct =
    sortedEndDates && targetDate
      ? Math.round(
          (sortedEndDates.filter((d) => d.getTime() <= targetDate.getTime()).length /
            sortedEndDates.length) *
            100,
        )
      : null;

  const targetTone =
    targetProbPct === null
      ? 'mute'
      : targetProbPct >= 80
        ? 'good'
        : targetProbPct >= 50
          ? 'warn'
          : 'bad';

  // ── Phase 19 — Budget tile (parallel to Target) ─────────────────────────
  const hasCost = projectHasCostData(project);
  const updateProjectBudget = useDomainStore((s) => s.updateProjectBudget);
  const glyph = currencyGlyph(project.currency);
  const budget = project.budget;
  // Phase 19 slice 4 — currency conversion plumbing for the Budget tile's
  // sub-line. AUTO / native target collapses to plain native rendering.
  const currencyDisplay = useViewStore((s) => s.currencyDisplay);
  const fxSnapshot = getEffectiveFxSnapshot(project);
  // Track the editing buffer locally so the user can type "1000" without
  // intermediate parse failures (e.g. on an empty string).
  // Phase 47 Slice 2 — the buffer holds the formatted string with thousands
  // separators ("500,000,000"). Display always reads from this buffer; the
  // onChange handler strips non-digits, re-formats with commas, and keeps
  // the cursor anchored to the right so typing feels natural.
  const [budgetInput, setBudgetInput] = useState<string>(
    budget !== undefined ? formatBudgetGroups(budget) : '',
  );
  useEffect(() => {
    setBudgetInput(budget !== undefined ? formatBudgetGroups(budget) : '');
  }, [budget]);

  const sortedCosts = useMemo(() => {
    if (!result) return null;
    return [...result.projectCosts].sort((a, b) => a - b);
  }, [result]);
  const budgetProbPct =
    sortedCosts && budget !== undefined && sortedCosts.length > 0
      ? Math.round((sortedCosts.filter((c) => c <= budget).length / sortedCosts.length) * 100)
      : null;
  const budgetTone =
    budgetProbPct === null
      ? 'mute'
      : budgetProbPct >= 80
        ? 'good'
        : budgetProbPct >= 50
          ? 'warn'
          : 'bad';

  function commitBudget(): void {
    const stripped = budgetInput.replace(/[,\s]/g, '');
    if (stripped === '') {
      if (budget !== undefined) updateProjectBudget(undefined);
      return;
    }
    const parsed = parseFloat(stripped);
    if (!isFinite(parsed) || parsed < 0) {
      // Reject invalid input — revert the buffer to the persisted value.
      setBudgetInput(budget !== undefined ? formatBudgetGroups(budget) : '');
      return;
    }
    if (parsed !== budget) updateProjectBudget(parsed);
    // Re-format the buffer so the user sees the committed value with
    // the grouping separators they're used to.
    setBudgetInput(formatBudgetGroups(parsed));
  }

  return (
    <div className="shrink-0 flex items-stretch gap-5 px-6 py-4 border-b border-gray-200 dark:border-gray-800 bg-gradient-to-b from-emerald-50/40 to-white dark:from-gray-900 dark:to-gray-900 flex-wrap max-md:grid max-md:grid-cols-2 max-md:gap-3 max-md:px-3 max-md:py-3">
      {/* P50 finish — main verdict */}
      <div className="flex flex-col gap-1 min-w-[170px] justify-center max-md:min-w-0">
        <div className="text-[10.5px] max-md:text-xs font-semibold uppercase tracking-[0.06em] text-gray-500 dark:text-gray-400">
          P50 finish
        </div>
        {p50Days !== null ? (
          <>
            <div className="text-[28px] font-bold leading-none tracking-tight text-gray-900 dark:text-gray-100">
              {p50Days.toFixed(1)}
              <span className="text-[14px] font-medium text-gray-500 dark:text-gray-400 ml-1.5">
                days
              </span>
            </div>
            <div className="text-[11.5px] max-md:text-xs text-gray-500 dark:text-gray-400">
              {p10Days !== null && p95Days !== null
                ? `P10 – P95: ${p10Days.toFixed(0)} – ${p95Days.toFixed(0)}d`
                : '—'}
            </div>
          </>
        ) : (
          <div className="text-[16px] font-semibold text-gray-400 dark:text-gray-500">
            Not run yet
          </div>
        )}
      </div>

      <Sep />

      {/* Target probability */}
      <div className="flex flex-col gap-1 min-w-[210px] justify-center max-md:min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10.5px] max-md:text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-[0.06em]">
            Target
          </span>
          <input
            type="date"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="bg-transparent border-0 p-0 text-[11.5px] max-md:text-xs text-gray-700 dark:text-gray-300 focus:outline-none"
          />
        </div>
        <div
          className={[
            'text-[26px] font-bold leading-none tracking-tight',
            targetTone === 'good'
              ? 'text-emerald-700 dark:text-emerald-400'
              : targetTone === 'warn'
                ? 'text-amber-700 dark:text-amber-400'
                : targetTone === 'bad'
                  ? 'text-red-700 dark:text-red-400'
                  : 'text-gray-400 dark:text-gray-500',
          ].join(' ')}
        >
          {targetProbPct !== null ? `${targetProbPct}%` : '—'}
        </div>
        <div className="text-[11.5px] max-md:text-xs text-gray-500 dark:text-gray-400">
          {targetDays !== null
            ? `chance of meeting target (${targetDays.toFixed(0)}d)`
            : 'set a target to see probability'}
        </div>
      </div>

      {/* Phase 19 — Budget tile (parallel to Target). Hidden when the
          project has no cost data anywhere. */}
      {hasCost && (
        <>
          <Sep />
          <div className="flex flex-col gap-1 min-w-[210px] justify-center max-md:min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10.5px] max-md:text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-[0.06em]">
                Budget
              </span>
              <span className="text-gray-400 dark:text-gray-500 text-[11.5px] max-md:text-xs">
                {glyph}
              </span>
              <input
                type="text"
                inputMode="numeric"
                value={budgetInput}
                placeholder="not set"
                onFocus={beginEdit}
                onChange={(e) => {
                  // Strip non-digits so paste of "$500,000,000" still works;
                  // re-format with commas as the user types. Cursor stays at
                  // the input's end because the value gets longer on each
                  // keystroke (re-format only adds chars, never reshuffles).
                  const digits = e.target.value.replace(/\D/g, '');
                  if (digits === '') {
                    setBudgetInput('');
                    return;
                  }
                  const n = parseFloat(digits);
                  setBudgetInput(isFinite(n) ? formatBudgetGroups(n) : digits);
                }}
                onBlur={() => {
                  commitBudget();
                  commitEdit();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
                className="bg-transparent border-0 p-0 text-[11.5px] max-md:text-xs text-gray-700 dark:text-gray-300 focus:outline-none w-[14ch]"
              />
            </div>
            <div
              className={[
                'text-[26px] font-bold leading-none tracking-tight',
                budgetTone === 'good'
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : budgetTone === 'warn'
                    ? 'text-amber-700 dark:text-amber-400'
                    : budgetTone === 'bad'
                      ? 'text-red-700 dark:text-red-400'
                      : 'text-gray-400 dark:text-gray-500',
              ].join(' ')}
            >
              {budgetProbPct !== null ? `${budgetProbPct}%` : '—'}
            </div>
            <div className="text-[11.5px] max-md:text-xs text-gray-500 dark:text-gray-400">
              {budget !== undefined
                ? `chance of meeting budget (${formatMoneyDual(budget, project.currency, currencyDisplay, fxSnapshot)})`
                : 'set a budget to see probability'}
            </div>
          </div>
        </>
      )}

      <Sep />

      {/* Run meta — flat label/value pairs with breathing room */}
      <div className="flex flex-col gap-1.5 min-w-[170px] justify-center max-md:min-w-0">
        <div className="text-[10.5px] max-md:text-xs font-semibold uppercase tracking-[0.06em] text-gray-500 dark:text-gray-400">
          Run
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px] items-baseline">
          <span className="text-gray-500 dark:text-gray-400">Iterations</span>
          <span className="text-gray-900 dark:text-gray-100 font-semibold tabular-nums text-right">
            {result ? result.endDates.length.toLocaleString() : iterations.toLocaleString()}
          </span>
          <span className="text-gray-500 dark:text-gray-400">Run time</span>
          <span className="text-gray-900 dark:text-gray-100 font-semibold tabular-nums text-right">
            {lastRunMs !== null
              ? lastRunMs >= 1000
                ? `${(lastRunMs / 1000).toFixed(1)}s`
                : `${Math.round(lastRunMs)}ms`
              : '—'}
          </span>
          <span className="text-gray-500 dark:text-gray-400">Converged</span>
          {result ? (
            result.convergence.converged ? (
              <span
                className="text-emerald-700 dark:text-emerald-400 font-semibold tabular-nums text-right"
                title="End-date + cost percentiles, criticality, per-node P95, per-node cost stats, and the cost curve all stabilized at this iteration — running more is unlikely to move the answer."
              >
                at {result.convergence.atIteration!.toLocaleString()}
              </span>
            ) : (
              <span
                className="text-amber-700 dark:text-amber-400 text-right text-[11px] max-md:text-xs"
                title="One or more diagnostics (percentiles, criticality, per-node P95, cost stats) are still drifting between consecutive 50-iteration samples. Try more iterations or narrower distributions."
              >
                not yet
              </span>
            )
          ) : (
            <span className="text-gray-900 dark:text-gray-100 font-semibold tabular-nums text-right">
              —
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 max-md:hidden" />

      {/* Run controls */}
      <div className="flex items-center gap-2 flex-wrap max-md:col-span-2 max-md:justify-center">
        {running ? (
          <>
            <div className="w-32 h-2 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all duration-150 rounded-full"
                style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
              />
            </div>
            {progress !== null && progress > 0 ? (
              <span className="text-[11px] max-md:text-xs text-emerald-700 dark:text-emerald-400 w-9 tabular-nums">
                {Math.round(progress * 100)}%
              </span>
            ) : (
              <span className="text-[11px] max-md:text-xs text-emerald-700 dark:text-emerald-400 italic">
                {warmupMessage ?? '0%'}
              </span>
            )}
            <button
              onClick={onCancel}
              className="rounded-md border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 px-3 py-1.5 text-[12px] hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={onRun}
            disabled={!hasDistributions}
            title={
              !hasDistributions
                ? 'Add a distribution to at least one node on Canvas first'
                : run
                  ? 'Re-run the simulation'
                  : 'Run the simulation'
            }
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-[13px] font-medium px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            ▶ {run ? 'Re-run' : 'Run'}
          </button>
        )}

        <div className="inline-flex bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md overflow-hidden">
          <IterPreset value={100} active={iterations === 100} onClick={() => setIterations(100)}>
            100
          </IterPreset>
          <IterPreset value={1000} active={iterations === 1000} onClick={() => setIterations(1000)}>
            1k
          </IterPreset>
          <IterPreset
            value={10_000}
            active={iterations === 10_000}
            onClick={() => setIterations(10_000)}
          >
            10k
          </IterPreset>
        </div>

        <button
          type="button"
          disabled
          title="Compare runs — coming in Phase 16"
          className="w-8 h-8 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-500 hover:text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center text-[13px]"
        >
          ⇄
        </button>
        <ExportMenu run={run} project={project} target={target} />

        <div className="inline-flex items-center gap-1 ml-1">
          <span
            className="font-mono text-[10.5px] max-md:text-xs text-gray-500 dark:text-gray-400 tabular-nums select-all"
            title="Current RNG seed — same seed + same inputs = byte-identical simulation"
          >
            seed&nbsp;{seed}
          </span>
          <button
            type="button"
            onClick={() => setSeed(Math.floor(Math.random() * 2 ** 31))}
            title="Randomise seed"
            className="text-[16px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            🎲
          </button>
        </div>
      </div>
    </div>
  );
}

function Sep() {
  // Hidden on mobile (`<md`): the parent KPI band uses `flex-wrap`, so
  // when cards wrap to new rows these 1-px vertical dividers become
  // orphan vertical lines hanging beside the wrapped content. On
  // wrapped layouts the `gap-5` between cards already provides plenty
  // of visual separation.
  return <div className="w-px bg-gray-200 dark:bg-gray-700 max-md:hidden" />;
}

/**
 * Verdict-bar export popover (Phase 20 slice 2). Disabled until a run
 * exists. Click opens a small absolute-positioned menu below the button;
 * outside-click and Escape close it. Each menu item triggers exactly one
 * file download to avoid the "allow multiple downloads" browser prompt —
 * the cost-CSV item is hidden when there's no cost data rather than
 * piggybacking on the schedule download.
 */
function ExportMenu({
  run,
  project,
  target,
}: {
  run: SimRun | null;
  project: ProjectFile;
  target: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Outside-click + Escape close.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const disabled = run === null;
  // toCostCsv returns null when projectCosts is empty or all-zero — same
  // signal we use to gate the menu item.
  const hasCostData = run !== null && simToCostCsv(run, project) !== null;

  const onExportJson = useCallback(() => {
    if (!run) return;
    const now = new Date();
    const text = simToJson(run, project, target || null, now);
    triggerDownload(
      new Blob([text], { type: 'application/json' }),
      buildExportFilename(project, run, now, 'json'),
    );
    setOpen(false);
  }, [run, project, target]);

  const onExportCsv = useCallback(() => {
    if (!run) return;
    const now = new Date();
    const text = simToCsv(run, project);
    triggerDownload(
      new Blob([text], { type: 'text/csv;charset=utf-8' }),
      buildExportFilename(project, run, now, 'csv'),
    );
    setOpen(false);
  }, [run, project]);

  const onExportCostCsv = useCallback(() => {
    if (!run) return;
    const text = simToCostCsv(run, project);
    if (text === null) return;
    const now = new Date();
    triggerDownload(
      new Blob([text], { type: 'text/csv;charset=utf-8' }),
      buildExportFilename(project, run, now, 'csv', 'cost'),
    );
    setOpen(false);
  }, [run, project]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title={disabled ? 'Run a simulation to enable export' : 'Export simulation result'}
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-8 h-8 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-500 hover:text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center text-[13px]"
      >
        ↓
      </button>
      {open && !disabled && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-20 min-w-[180px] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg py-1 text-[12px]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={onExportJson}
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-800 dark:text-gray-200"
          >
            Export as JSON
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={onExportCsv}
            className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-800 dark:text-gray-200"
          >
            Export as CSV
          </button>
          {hasCostData && (
            <button
              type="button"
              role="menuitem"
              onClick={onExportCostCsv}
              className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-800 dark:text-gray-200"
            >
              Export cost CSV
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function IterPreset({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  value: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'px-2.5 py-1 text-[11px] max-md:text-xs font-medium border-r border-gray-100 dark:border-gray-800 last:border-r-0 transition-colors',
        active
          ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
          : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

// ── Result body — histogram hero + side cards ────────────────────────────────

interface SimulationResultViewProps {
  result: SimulationResult;
  project: ProjectFile;
  target: string;
  /** Phase 16 — fired when the user clicks "Show what-if without X" in Risk Drivers. */
  onRunWhatIf: (nodeId: string) => void;
  running: boolean;
}

function SimulationResultView({
  result,
  project,
  target,
  onRunWhatIf,
  running,
}: SimulationResultViewProps) {
  const projectStart = useMemo(
    () => new Date(project.project.startDate + 'T00:00:00'),
    [project.project.startDate],
  );

  // Phase 19 — Date|Cost axis toggle (persisted in viewStore). Cost mode is
  // gated on projectHasCostData; date mode is the default.
  const simChartMode = useViewStore((s) => s.simChartMode);
  const setSimChartMode = useViewStore((s) => s.setSimChartMode);
  const hasCost = projectHasCostData(project);
  // If cost data was removed since the user last picked cost mode, fall back
  // to date so the histogram doesn't render against an empty array.
  const axis: 'date' | 'cost' = hasCost && simChartMode === 'cost' ? 'cost' : 'date';

  return (
    <div className="flex-1 overflow-auto p-4 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4 bg-gray-50 dark:bg-gray-950">
      <div className="flex flex-col gap-3">
        {hasCost && (
          <div className="inline-flex bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-md p-0.5 self-start">
            <AxisModeTab on={axis === 'date'} onClick={() => setSimChartMode('date')}>
              Date
            </AxisModeTab>
            <AxisModeTab on={axis === 'cost'} onClick={() => setSimChartMode('cost')}>
              Cost
            </AxisModeTab>
          </div>
        )}
        {axis === 'date' ? (
          <HistogramCard result={result} target={target} projectStart={projectStart} />
        ) : (
          <CostChartCard result={result} project={project} />
        )}
      </div>
      <div className="flex flex-col gap-3">
        <RiskDriversCard
          result={result}
          project={project}
          onRunWhatIf={onRunWhatIf}
          running={running}
          axis={axis}
        />
        <CriticalPathFrequencyCard result={result} project={project} />
        <SensitivityCard result={result} project={project} />
      </div>
    </div>
  );
}

function AxisModeTab({
  children,
  on,
  onClick,
}: {
  children: React.ReactNode;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'px-3 py-1 text-[12px] font-medium rounded transition-colors',
        on
          ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
          : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

// ── Histogram hero ──────────────────────────────────────────────────────────

function HistogramCard({
  result,
  target,
  projectStart,
}: {
  result: SimulationResult;
  target: string;
  projectStart: Date;
}) {
  const [mode, setMode] = useState<'histogram' | 'cumulative'>('histogram');
  const sorted = useMemo(
    () => [...result.endDates].sort((a, b) => a.getTime() - b.getTime()),
    [result.endDates],
  );

  const p10 = percentileOf(sorted, 0.1);
  const p50 = result.percentiles.p50;
  const p80 = result.percentiles.p80;
  const p95 = result.percentiles.p95;

  // Bin in days. Choose ~24 bins across the actual data range.
  const minDay = Math.floor(daysSinceProjectStart(sorted[0]!, projectStart));
  const maxDay = Math.ceil(daysSinceProjectStart(sorted[sorted.length - 1]!, projectStart));
  const binCount = Math.max(8, Math.min(32, maxDay - minDay + 1));
  const binWidth = (maxDay - minDay) / binCount || 1;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    centerDay: minDay + (i + 0.5) * binWidth,
    count: 0,
  }));
  for (const d of sorted) {
    const day = daysSinceProjectStart(d, projectStart);
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor((day - minDay) / binWidth)));
    bins[idx]!.count++;
  }
  const maxCount = Math.max(...bins.map((b) => b.count), 1);

  const targetDate = target ? new Date(target + 'T23:59:59') : null;
  const targetDay = targetDate ? daysSinceProjectStart(targetDate, projectStart) : null;
  const passCount =
    targetDate !== null ? sorted.filter((d) => d.getTime() <= targetDate.getTime()).length : 0;
  const passPct = sorted.length > 0 ? Math.round((passCount / sorted.length) * 100) : 0;
  const missPct = 100 - passPct;

  // Chart viewBox is fixed; the SVG renders at the container's width with
  // `preserveAspectRatio="none"` so bars stretch horizontally to fill the
  // chart card. All text labels are HTML overlays positioned absolutely
  // over the chart (see `<div className="relative">` wrapper below). That
  // way text is immune to SVG scaling: an HTML span with `text-[13px]`
  // renders at 13 CSS pixels regardless of how wide the chart container
  // gets. Previous attempts to scale the viewBox to match the container
  // (PR #42) still produced oversized text because the SVG's height
  // (h-auto on a wide container) ended up taller than VBOX_H, scaling
  // text along with it.
  const VBOX_W = 720;
  // Extra room at the bottom so percentile labels can stack on a second
  // row without being clipped when their x-positions cluster.
  const VBOX_H = 300;
  const PLOT_TOP = 30;
  const PLOT_BOTTOM = 240;
  const PLOT_H = PLOT_BOTTOM - PLOT_TOP;
  const xAxisLeft = 36;
  const xAxisRight = VBOX_W - 12;
  const xAxisW = xAxisRight - xAxisLeft;

  const dayToX = (day: number) =>
    maxDay === minDay
      ? xAxisLeft + xAxisW / 2
      : xAxisLeft + ((day - minDay) / (maxDay - minDay)) * xAxisW;

  const p10Day = p10 ? daysSinceProjectStart(p10, projectStart) : null;
  const p50Day = daysSinceProjectStart(p50, projectStart);
  const p80Day = daysSinceProjectStart(p80, projectStart);
  const p95Day = daysSinceProjectStart(p95, projectStart);

  // Phase 19 slice 5 — draggable cursor. Snap to bin centers when in
  // histogram mode; continuous when in cumulative mode (per-iteration
  // data is dense enough that any position is honest). The cursor's
  // data value is `day` (days-since-project-start), the same domain the
  // existing dayToX / placed markers operate on.
  const binCenters = useMemo(() => bins.map((b) => b.centerDay), [bins]);
  const cursor = useChartCursor({
    clientXToData: (relX, svgWidth) => {
      // The SVG uses preserveAspectRatio="none" so it stretches to the
      // container width — translate CSS pixels back to viewBox units.
      if (svgWidth <= 0) return null;
      const svgX = (relX / svgWidth) * VBOX_W;
      if (svgX < xAxisLeft || svgX > xAxisRight) return null;
      const frac = (svgX - xAxisLeft) / xAxisW;
      return minDay + frac * (maxDay - minDay);
    },
    // Snap to bin centres on the histogram; continuous read on the CDF.
    // (exactOptionalPropertyTypes — omit the key when the snap is absent.)
    ...(mode === 'histogram' ? { snap: (d: number) => snapToNearest(d, binCenters) } : {}),
  });

  return (
    <section className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">
            Project finish distribution
          </div>
          <div className="text-[11px] max-md:text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {mode === 'histogram'
              ? `Histogram of ${sorted.length.toLocaleString()} simulated finish dates · P10 / P50 / P80 / P95 marked`
              : `Cumulative distribution of ${sorted.length.toLocaleString()} simulated finish dates — y is the probability of finishing on or before x`}
          </div>
        </div>
        <div className="inline-flex bg-gray-100 dark:bg-gray-800 rounded-md p-0.5 shrink-0">
          <ChartModeTab on={mode === 'histogram'} onClick={() => setMode('histogram')}>
            Histogram
          </ChartModeTab>
          <ChartModeTab on={mode === 'cumulative'} onClick={() => setMode('cumulative')}>
            Cumulative
          </ChartModeTab>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-md">
        {mode === 'histogram' &&
          (() => {
            // Pre-compute the percentile-marker layout so the SVG (lines) and
            // the HTML overlay (labels) share the same row assignments.
            // Wider LABEL_HALF_W catches near-coincident P-markers (e.g.
            // P10 / P50 at the same day in a tight distribution). ROW_GAP
            // = 32 is *larger than the label box itself* (≈30 px: text-13
            // line + mt-0.5 + text-11 line + line-heights) so row-1 sits
            // CLEAR of row-0 instead of overlapping in the leftover space.
            const LABEL_HALF_W = 22;
            const ROW_GAP = 32;
            const placed = [
              { day: p10Day, label: 'P10', color: '#10b981' },
              { day: p50Day, label: 'P50', color: '#3b82f6' },
              { day: p80Day, label: 'P80', color: '#f59e0b' },
              { day: p95Day, label: 'P95', color: '#ef4444' },
            ]
              .filter((m): m is { day: number; label: string; color: string } => m.day !== null)
              .map((m) => ({ ...m, x: dayToX(m.day) }))
              .sort((a, b) => a.x - b.x)
              .reduce<Array<{ day: number; label: string; color: string; x: number; row: number }>>(
                (acc, c) => {
                  const lastRow0X = acc
                    .filter((p) => p.row === 0)
                    .reduce((mx, p) => Math.max(mx, p.x), -Infinity);
                  const row = c.x - lastRow0X < LABEL_HALF_W * 2 ? 1 : 0;
                  acc.push({ ...c, row });
                  return acc;
                },
                [],
              );

            // Target pill: when the target is in the left third, place the
            // badge to the RIGHT of the marker line — otherwise the pill
            // would extend off the left edge AND collide with the
            // "X% on or before target" label. The previous SVG version
            // had this condition inverted, which is what produced the
            // "rget -52d" left-clipping in the user's screenshot.
            const targetX = targetDay !== null ? dayToX(targetDay) : null;
            const targetFracFromLeft =
              targetX !== null && xAxisW > 0 ? (targetX - xAxisLeft) / xAxisW : 0.5;
            const placeTargetRight = targetFracFromLeft < 0.33;

            return (
              <div className="relative" style={{ height: VBOX_H + 'px' }}>
                {/* SVG layer — bars, gridlines, marker lines only. No text.
                  `preserveAspectRatio="none"` lets bars span the full container
                  width while the fixed pixel height keeps the chart at a
                  predictable size regardless of viewport width. */}
                <svg
                  viewBox={`0 0 ${VBOX_W} ${VBOX_H}`}
                  preserveAspectRatio="none"
                  className="absolute inset-0 w-full h-full block cursor-crosshair select-none"
                  {...cursor.pointerHandlers}
                >
                  {/* Y gridlines */}
                  {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
                    <line
                      key={i}
                      x1={xAxisLeft}
                      y1={PLOT_BOTTOM - f * PLOT_H}
                      x2={xAxisRight}
                      y2={PLOT_BOTTOM - f * PLOT_H}
                      className="stroke-gray-100 dark:stroke-gray-800"
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}

                  {/* Bars */}
                  {bins.map((b, i) => {
                    const cx = dayToX(b.centerDay);
                    const w = xAxisW / binCount - 2;
                    const h = (b.count / maxCount) * PLOT_H;
                    const overTarget = targetDay !== null && b.centerDay > targetDay;
                    const fill = overTarget ? '#fb923c' : '#3b82f6';
                    return (
                      <rect
                        key={i}
                        x={cx - w / 2}
                        y={PLOT_BOTTOM - h}
                        width={Math.max(1, w)}
                        height={h}
                        fill={fill}
                        opacity={0.85}
                        rx={1.5}
                      >
                        <title>{`${b.count} runs · day ${b.centerDay.toFixed(0)}`}</title>
                      </rect>
                    );
                  })}

                  {/* Target marker line (badge is rendered as an HTML overlay below) */}
                  {targetX !== null &&
                    targetDay !== null &&
                    targetDay >= minDay &&
                    targetDay <= maxDay && (
                      <line
                        x1={targetX}
                        y1={PLOT_TOP + 6}
                        x2={targetX}
                        y2={PLOT_BOTTOM}
                        stroke="#059669"
                        strokeWidth={2}
                        opacity={0.85}
                        vectorEffect="non-scaling-stroke"
                      />
                    )}

                  {/* X-axis line */}
                  <line
                    x1={xAxisLeft}
                    y1={PLOT_BOTTOM}
                    x2={xAxisRight}
                    y2={PLOT_BOTTOM}
                    stroke="#9ca3af"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />

                  {/* P-marker lines (labels are rendered as HTML overlays below) */}
                  {placed.map((m) => (
                    <line
                      key={m.label}
                      x1={m.x}
                      y1={PLOT_BOTTOM}
                      x2={m.x}
                      y2={PLOT_BOTTOM + 8 + m.row * ROW_GAP}
                      stroke={m.color}
                      strokeWidth={1.5}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}

                  {/* Phase 19 slice 5 — draggable cursor. Snaps to bin centers
                    in histogram mode. Drawn last so it sits above bars and
                    markers. Drop circle highlights the bar the cursor is
                    pointing at. */}
                  {cursor.cursorDataValue !== null &&
                    (() => {
                      const cx = dayToX(cursor.cursorDataValue);
                      if (cx < xAxisLeft - 1 || cx > xAxisRight + 1) return null;
                      return (
                        <g pointerEvents="none">
                          <line
                            x1={cx}
                            y1={PLOT_TOP - 6}
                            x2={cx}
                            y2={PLOT_BOTTOM}
                            stroke="#64748b"
                            strokeWidth={cursor.isDragging ? 1.5 : 1}
                            strokeDasharray="4 3"
                            vectorEffect="non-scaling-stroke"
                          />
                          <path
                            d={`M${cx - 4},${PLOT_TOP - 6} L${cx + 4},${PLOT_TOP - 6} L${cx},${PLOT_TOP - 1} Z`}
                            fill="#64748b"
                          />
                        </g>
                      );
                    })()}
                </svg>

                {/* HTML overlay — all chart labels render here so they stay at
                  their declared CSS font sizes regardless of how wide the
                  chart container gets. Y positions are pixel offsets in the
                  same coordinate space as the SVG viewBox (1 viewBox unit = 1
                  CSS pixel because the SVG is forced to VBOX_H pixels tall).
                  X positions are container-percentage so they track the same
                  fractional locations as the SVG's stretched bar coordinates. */}

                {/* Pass / miss labels (top edge) */}
                {targetDay !== null && (
                  <>
                    <div
                      className="absolute text-[13px] font-semibold text-blue-700 dark:text-blue-400 pointer-events-none"
                      style={{
                        left: `${((xAxisLeft + 14) / VBOX_W) * 100}%`,
                        top: '6px',
                      }}
                    >
                      {passPct}% on or before target
                    </div>
                    <div
                      className="absolute text-[13px] font-semibold text-orange-700 dark:text-orange-400 pointer-events-none"
                      style={{
                        right: `${((VBOX_W - (xAxisRight - 14)) / VBOX_W) * 100}%`,
                        top: '6px',
                      }}
                    >
                      {missPct}% miss
                    </div>
                  </>
                )}

                {/* Target pill */}
                {targetX !== null &&
                  targetDay !== null &&
                  targetDay >= minDay &&
                  targetDay <= maxDay && (
                    <div
                      className="absolute bg-emerald-600 text-white px-2 py-0.5 rounded text-[12px] font-semibold whitespace-nowrap pointer-events-none shadow-sm"
                      style={{
                        left: `${(targetX / VBOX_W) * 100}%`,
                        top: `${PLOT_TOP + 6}px`,
                        transform: placeTargetRight
                          ? 'translateX(4px)'
                          : 'translateX(calc(-100% - 4px))',
                      }}
                    >
                      Target {targetDay.toFixed(0)}d
                    </div>
                  )}

                {/* P-marker labels */}
                {placed.map((m) => {
                  const labelTop = PLOT_BOTTOM + 12 + m.row * ROW_GAP;
                  return (
                    <div
                      key={m.label}
                      className="absolute -translate-x-1/2 text-center whitespace-nowrap pointer-events-none leading-tight"
                      style={{
                        left: `${(m.x / VBOX_W) * 100}%`,
                        top: `${labelTop}px`,
                      }}
                    >
                      <div className="text-[13px] font-semibold" style={{ color: m.color }}>
                        {m.label}
                      </div>
                      <div className="text-[11px] max-md:text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        {m.day.toFixed(0)}d
                      </div>
                    </div>
                  );
                })}

                {/* Phase 19 slice 5 — cursor tooltip overlay. Cursor data
                  value is days-since-project-start; snapped to bin
                  centers in histogram mode. Shows the bin count and the
                  cumulative % of runs at or before the cursor's date. */}
                {cursor.cursorDataValue !== null &&
                  (() => {
                    const day = cursor.cursorDataValue;
                    const binIdx = bins.findIndex(
                      (b) => Math.abs(b.centerDay - day) < binWidth / 2 + 0.001,
                    );
                    if (binIdx < 0) return null;
                    const bin = bins[binIdx]!;
                    const cursorMs = projectStart.getTime() + day * 86_400_000;
                    const cumulativeCount = sorted.filter((d) => d.getTime() <= cursorMs).length;
                    const cumulativePct =
                      sorted.length > 0 ? Math.round((cumulativeCount / sorted.length) * 100) : 0;
                    const cursorX = dayToX(day);
                    const flipLeft = cursorX > VBOX_W * 0.65;
                    const cursorDate = new Date(cursorMs);
                    return (
                      <div
                        className="absolute pointer-events-none rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-gray-900 shadow-md px-2.5 py-1.5 text-[11px] max-md:text-xs leading-tight"
                        style={{
                          left: flipLeft ? undefined : `calc(${(cursorX / VBOX_W) * 100}% + 8px)`,
                          right: flipLeft
                            ? `calc(${((VBOX_W - cursorX) / VBOX_W) * 100}% + 8px)`
                            : undefined,
                          top: `${PLOT_TOP - 4}px`,
                          minWidth: 170,
                          zIndex: 3,
                        }}
                      >
                        <div className="text-gray-500 dark:text-gray-400 text-[10px] max-md:text-xs mb-0.5">
                          Day {day.toFixed(0)} ·{' '}
                          {cursorDate.toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })}
                        </div>
                        <div className="flex justify-between gap-2 text-gray-700 dark:text-gray-200">
                          <span>Bin count</span>
                          <span className="font-mono font-semibold">{bin.count}</span>
                        </div>
                        <div className="flex justify-between gap-2 text-gray-700 dark:text-gray-200">
                          <span>On or before</span>
                          <span className="font-mono font-semibold">
                            {cumulativeCount} / {sorted.length} ({cumulativePct}%)
                          </span>
                        </div>
                      </div>
                    );
                  })()}
              </div>
            );
          })()}

        {mode === 'cumulative' && (
          <CumulativeSvg
            sorted={sorted}
            projectStart={projectStart}
            target={target}
            VBOX_W={VBOX_W}
            VBOX_H={VBOX_H}
            PLOT_TOP={PLOT_TOP}
            PLOT_BOTTOM={PLOT_BOTTOM}
            xAxisLeft={xAxisLeft}
            xAxisRight={xAxisRight}
            xAxisW={xAxisW}
            minDay={minDay}
            maxDay={maxDay}
            dayToX={dayToX}
            targetDay={targetDay}
            p50Day={p50Day}
            p80Day={p80Day}
            p95Day={p95Day}
            cursorDay={cursor.cursorDataValue}
            cursorPointerHandlers={cursor.pointerHandlers}
            cursorIsDragging={cursor.isDragging}
          />
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Chip>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          <span>
            <b>{sorted.length.toLocaleString()} runs</b> · range{' '}
            {p10 ? `${daysSinceProjectStart(p10, projectStart).toFixed(0)}d` : '—'} –{' '}
            {p95 ? `${daysSinceProjectStart(p95, projectStart).toFixed(0)}d` : '—'}
          </span>
        </Chip>
        {result.convergence.converged ? (
          <Chip>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span title="End-date + cost percentiles, criticality, per-node P95, per-node cost stats, and the cost curve all stabilized at this iteration — running more is unlikely to move the answer.">
              <b>Converged</b> — diagnostics stabilized at iteration{' '}
              {result.convergence.atIteration!.toLocaleString()}
            </span>
          </Chip>
        ) : (
          <Chip>
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span title="One or more diagnostics are still drifting between samples — try more iterations or narrower distributions.">
              <b>Not converged</b> — try more iterations or narrower distributions
            </span>
          </Chip>
        )}
      </div>
    </section>
  );
}

function ChartModeTab({
  children,
  on,
  onClick,
}: {
  children: React.ReactNode;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'px-2.5 py-1 rounded text-[11.5px] max-md:text-xs font-medium transition-colors',
        on
          ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-[0_1px_2px_rgba(15,23,42,0.06)]'
          : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

// ── Cumulative distribution (CDF) ─────────────────────────────────────────────

interface CumulativeSvgProps {
  sorted: Date[];
  projectStart: Date;
  target: string;
  VBOX_W: number;
  VBOX_H: number;
  PLOT_TOP: number;
  PLOT_BOTTOM: number;
  xAxisLeft: number;
  xAxisRight: number;
  xAxisW: number;
  minDay: number;
  maxDay: number;
  dayToX: (day: number) => number;
  targetDay: number | null;
  p50Day: number;
  p80Day: number;
  p95Day: number;
  /** Phase 19 slice 5 — shared cursor state from HistogramCard. */
  cursorDay: number | null;
  cursorPointerHandlers: {
    onPointerDown: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerUp: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerLeave: (e: React.PointerEvent<SVGSVGElement>) => void;
  };
  cursorIsDragging: boolean;
}

/**
 * Empirical CDF rendering of the same end-date stream. y is the probability
 * of finishing on or before x — by construction monotone non-decreasing from
 * 0 to 1. P10/P50/P80/P95 ticks are drawn the same way as the histogram so
 * the two views stay visually consistent across the toggle.
 */
function CumulativeSvg({
  sorted,
  projectStart,
  VBOX_W,
  VBOX_H,
  PLOT_TOP,
  PLOT_BOTTOM,
  xAxisLeft,
  xAxisRight,
  targetDay,
  dayToX,
  p50Day,
  p80Day,
  p95Day,
  cursorDay,
  cursorPointerHandlers,
  cursorIsDragging,
}: CumulativeSvgProps) {
  const totalRuns = sorted.length;
  const PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP;

  // Pre-compute the polyline points. The CDF rises by 1/N at each end-date,
  // so the polyline has one vertex per sample. For drawing efficiency we
  // bucket samples by day (the chart's x resolution) and emit one point per
  // distinct day reached.
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < totalRuns; i++) {
    const sample = sorted[i]!;
    const day = (sample.getTime() - projectStart.getTime()) / 86_400_000;
    const cumFrac = (i + 1) / totalRuns;
    const x = dayToX(day);
    const y = PLOT_BOTTOM - cumFrac * PLOT_HEIGHT;
    // De-duplicate adjacent samples that land on the same pixel column.
    const prev = points[points.length - 1];
    if (prev && Math.abs(prev.x - x) < 0.5) {
      prev.y = y; // keep climbing
    } else {
      points.push({ x, y });
    }
  }
  // Anchor the line to (xAxisLeft, PLOT_BOTTOM) on the left for a clean start.
  if (points.length > 0) {
    points.unshift({ x: xAxisLeft, y: PLOT_BOTTOM });
  }
  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  // Probability of finishing on or before target.
  const passFrac = (() => {
    if (targetDay === null || totalRuns === 0) return null;
    // Linear interp inside sorted to find the fraction of dates ≤ target.
    let lo = 0;
    let hi = totalRuns;
    const targetMs = projectStart.getTime() + targetDay * 86_400_000;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid]!.getTime() <= targetMs) lo = mid + 1;
      else hi = mid;
    }
    return lo / totalRuns;
  })();

  // Cursor's cumulative-fraction at the cursor day (continuous CDF, no
  // snap). Computed via binary search over the sorted end-dates so the
  // tooltip's "% on or before this date" reading is accurate.
  let cursorFrac: number | null = null;
  if (cursorDay !== null && totalRuns > 0) {
    const cursorMs = projectStart.getTime() + cursorDay * 86_400_000;
    let lo = 0;
    let hi = totalRuns;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid]!.getTime() <= cursorMs) lo = mid + 1;
      else hi = mid;
    }
    cursorFrac = lo / totalRuns;
  }
  const cursorX = cursorDay !== null ? dayToX(cursorDay) : null;
  const cursorY = cursorFrac !== null ? PLOT_BOTTOM - cursorFrac * PLOT_HEIGHT : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VBOX_W} ${VBOX_H}`}
        preserveAspectRatio="xMidYMid meet"
        className="block w-full h-auto cursor-crosshair select-none"
        {...cursorPointerHandlers}
      >
        {/* Y gridlines at 0/25/50/75/100% */}
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
          <g key={i}>
            <line
              x1={xAxisLeft}
              y1={PLOT_BOTTOM - f * PLOT_HEIGHT}
              x2={xAxisRight}
              y2={PLOT_BOTTOM - f * PLOT_HEIGHT}
              className="stroke-gray-100 dark:stroke-gray-800"
              strokeWidth={1}
            />
            <text
              x={xAxisLeft - 6}
              y={PLOT_BOTTOM - f * PLOT_HEIGHT + 3}
              fontSize={10}
              fill="#9ca3af"
              textAnchor="end"
            >
              {Math.round(f * 100)}%
            </text>
          </g>
        ))}

        {/* CDF area + line */}
        {points.length > 0 && (
          <>
            <polygon
              points={`${polyline} ${xAxisRight},${PLOT_BOTTOM}`}
              fill="#3b82f6"
              opacity={0.15}
            />
            <polyline points={polyline} fill="none" stroke="#3b82f6" strokeWidth={2} />
          </>
        )}

        {/* Target marker line + pass probability badge */}
        {targetDay !== null && passFrac !== null && (
          <g>
            <line
              x1={dayToX(targetDay)}
              y1={PLOT_TOP}
              x2={dayToX(targetDay)}
              y2={PLOT_BOTTOM}
              stroke="#059669"
              strokeWidth={2}
              opacity={0.85}
            />
            <circle
              cx={dayToX(targetDay)}
              cy={PLOT_BOTTOM - passFrac * PLOT_HEIGHT}
              r={5}
              fill="#059669"
            />
            <rect
              x={dayToX(targetDay) + 8}
              y={PLOT_BOTTOM - passFrac * PLOT_HEIGHT - 12}
              width={68}
              height={20}
              fill="#059669"
              rx={3}
            />
            <text
              x={dayToX(targetDay) + 42}
              y={PLOT_BOTTOM - passFrac * PLOT_HEIGHT + 2}
              fontSize={12}
              fontWeight={600}
              fill="#fff"
              textAnchor="middle"
            >
              {Math.round(passFrac * 100)}% by {targetDay.toFixed(0)}d
            </text>
          </g>
        )}

        {/* X-axis */}
        <line x1={xAxisLeft} y1={PLOT_BOTTOM} x2={xAxisRight} y2={PLOT_BOTTOM} stroke="#9ca3af" />

        {/* P-markers along the x-axis. Mirrors the histogram's 2-row
          stacking so labels don't bunch up when P80 and P95 are close.
          Drawn as SVG (no HTML overlay needed — this component is used
          with `preserveAspectRatio="xMidYMid meet"` which keeps text
          sizes uniform). ROW_GAP = 28 fits two SVG-text rows (label 13
          + day 11) with breathing room — row-1 starts BELOW row-0's
          day-text instead of inside it. */}
        {(() => {
          const LABEL_HALF_W = 22; // ≈ width of "P95" + padding for adjacency
          const ROW_GAP = 28;
          const stacked = (
            [
              { day: p50Day, label: 'P50', color: '#3b82f6' },
              { day: p80Day, label: 'P80', color: '#f59e0b' },
              { day: p95Day, label: 'P95', color: '#ef4444' },
            ] as const
          )
            .map((m) => ({ ...m, x: dayToX(m.day) }))
            .sort((a, b) => a.x - b.x)
            .reduce<Array<{ day: number; label: string; color: string; x: number; row: number }>>(
              (acc, c) => {
                const lastRow0X = acc
                  .filter((p) => p.row === 0)
                  .reduce((mx, p) => Math.max(mx, p.x), -Infinity);
                const row = c.x - lastRow0X < LABEL_HALF_W * 2 ? 1 : 0;
                acc.push({ ...c, row });
                return acc;
              },
              [],
            );
          return stacked.map((m) => {
            const tickEndY = PLOT_BOTTOM + 8 + m.row * ROW_GAP;
            const labelY = PLOT_BOTTOM + 22 + m.row * ROW_GAP;
            const dayY = PLOT_BOTTOM + 34 + m.row * ROW_GAP;
            return (
              <g key={m.label}>
                <line
                  x1={m.x}
                  y1={PLOT_BOTTOM}
                  x2={m.x}
                  y2={tickEndY}
                  stroke={m.color}
                  strokeWidth={1.5}
                />
                <text
                  x={m.x}
                  y={labelY}
                  fontSize={13}
                  fontWeight={600}
                  fill={m.color}
                  textAnchor="middle"
                >
                  {m.label}
                </text>
                <text x={m.x} y={dayY} fontSize={11} fill="#6b7280" textAnchor="middle">
                  {m.day.toFixed(0)}d
                </text>
              </g>
            );
          });
        })()}

        {/* Phase 19 slice 5 — cursor (continuous, no snap). Vertical
          line plus a circle at the curve's y position for the cursor's
          day. Drawn last so it sits above gridlines + curve. */}
        {cursorX !== null && cursorY !== null && (
          <g pointerEvents="none">
            <line
              x1={cursorX}
              y1={PLOT_TOP - 6}
              x2={cursorX}
              y2={PLOT_BOTTOM}
              stroke="#64748b"
              strokeWidth={cursorIsDragging ? 1.5 : 1}
              strokeDasharray="4 3"
            />
            <path
              d={`M${cursorX - 4},${PLOT_TOP - 6} L${cursorX + 4},${PLOT_TOP - 6} L${cursorX},${PLOT_TOP - 1} Z`}
              fill="#64748b"
            />
            <circle
              cx={cursorX}
              cy={cursorY}
              r={4}
              fill="#3b82f6"
              stroke="#64748b"
              strokeWidth={1}
            />
          </g>
        )}
      </svg>

      {/* Cursor tooltip — HTML overlay so the readout stays at its CSS
        font size regardless of the SVG's scaling. */}
      {cursorDay !== null &&
        cursorFrac !== null &&
        cursorX !== null &&
        (() => {
          const cursorMs = projectStart.getTime() + cursorDay * 86_400_000;
          const cursorDate = new Date(cursorMs);
          const flipLeft = cursorX > VBOX_W * 0.65;
          return (
            <div
              className="absolute pointer-events-none rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-gray-900 shadow-md px-2.5 py-1.5 text-[11px] max-md:text-xs leading-tight"
              style={{
                left: flipLeft ? undefined : `calc(${(cursorX / VBOX_W) * 100}% + 8px)`,
                right: flipLeft ? `calc(${((VBOX_W - cursorX) / VBOX_W) * 100}% + 8px)` : undefined,
                top: `${(PLOT_TOP / VBOX_H) * 100}%`,
                minWidth: 170,
                zIndex: 3,
              }}
            >
              <div className="text-gray-500 dark:text-gray-400 text-[10px] max-md:text-xs mb-0.5">
                Day {cursorDay.toFixed(1)} ·{' '}
                {cursorDate.toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </div>
              <div className="flex justify-between gap-2 text-gray-700 dark:text-gray-200">
                <span>On or before</span>
                <span className="font-mono font-semibold text-blue-700 dark:text-blue-400">
                  {(cursorFrac * 100).toFixed(1)}%
                </span>
              </div>
            </div>
          );
        })()}
    </div>
  );
}

// ── Phase 19 — Cost chart card (parallel to HistogramCard) ─────────────────
//
// Histogram + CDF over `result.projectCosts`. Mirrors the visual treatment of
// HistogramCard with a few simplifications:
//   - x axis is currency amount, formatted with the project's glyph.
//   - Single marker line at `project.budget` (instead of the Target line).
//   - Percentile markers come from `result.costPercentiles` (+P10 derived
//     from `projectCosts` since the engine emits P50/P80/P95 only).
//
// Deliberately not extracting a shared "distribution chart" primitive in this
// slice — the date chart has accumulated date-specific layout decisions
// (target-pill clip handling, working-day x labels) that would balloon the
// refactor. Keeping the cost chart a focused mirror; future consolidation
// can land separately once both have settled.

function CostChartCard({ result, project }: { result: SimulationResult; project: ProjectFile }) {
  const [mode, setMode] = useState<'histogram' | 'cumulative'>('histogram');
  // Phase 19 slice 4 — dual-currency display on the Budget pill only.
  // Histogram x-axis tick labels stay native (space constraints).
  const currencyDisplay = useViewStore((s) => s.currencyDisplay);
  const fxSnapshot = getEffectiveFxSnapshot(project);
  const sortedCosts = useMemo(
    () => [...result.projectCosts].sort((a, b) => a - b),
    [result.projectCosts],
  );

  if (sortedCosts.length === 0) {
    return (
      <section className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
        <div className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">
          Project cost distribution
        </div>
        <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-2">
          No cost samples — the simulation produced zero successful iterations.
        </div>
      </section>
    );
  }

  const minCost = sortedCosts[0]!;
  const maxCost = sortedCosts[sortedCosts.length - 1]!;
  const p10Cost =
    sortedCosts[Math.min(Math.floor(sortedCosts.length * 0.1), sortedCosts.length - 1)] ?? minCost;
  const p50Cost = result.costPercentiles.p50;
  const p80Cost = result.costPercentiles.p80;
  const p95Cost = result.costPercentiles.p95;

  // Histogram binning across the cost range.
  const binCount = Math.max(8, Math.min(32, 24));
  const binWidth = (maxCost - minCost) / binCount || 1;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    centerCost: minCost + (i + 0.5) * binWidth,
    count: 0,
  }));
  for (const c of sortedCosts) {
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor((c - minCost) / binWidth)));
    bins[idx]!.count++;
  }
  const maxBinCount = Math.max(...bins.map((b) => b.count), 1);

  const budget = project.budget;
  const passCount = budget !== undefined ? sortedCosts.filter((c) => c <= budget).length : 0;
  const passPct = sortedCosts.length > 0 ? Math.round((passCount / sortedCosts.length) * 100) : 0;
  const missPct = 100 - passPct;

  const VBOX_W = 720;
  const VBOX_H = 300;
  const PLOT_TOP = 30;
  const PLOT_BOTTOM = 240;
  const PLOT_H = PLOT_BOTTOM - PLOT_TOP;
  const xAxisLeft = 36;
  const xAxisRight = VBOX_W - 12;
  const xAxisW = xAxisRight - xAxisLeft;

  const costToX = (c: number): number =>
    maxCost === minCost
      ? xAxisLeft + xAxisW / 2
      : xAxisLeft + ((c - minCost) / (maxCost - minCost)) * xAxisW;

  // Phase 19 slice 5 — draggable cursor on the cost-axis chart. Same
  // pattern as the date histogram: snap to bin centres in histogram
  // mode, continuous in cumulative mode (per-iteration data is dense).
  const binCenters = useMemo(() => bins.map((b) => b.centerCost), [bins]);
  const cursor = useChartCursor({
    clientXToData: (relX, svgWidth) => {
      if (svgWidth <= 0) return null;
      const svgX = (relX / svgWidth) * VBOX_W;
      if (svgX < xAxisLeft || svgX > xAxisRight) return null;
      const frac = (svgX - xAxisLeft) / xAxisW;
      return minCost + frac * (maxCost - minCost);
    },
    ...(mode === 'histogram' ? { snap: (c: number) => snapToNearest(c, binCenters) } : {}),
  });

  // Percentile-marker layout. Mirrors HistogramCard's two-row stacking
  // logic when labels overlap (P10 ↔ P50 commonly do in tight runs).
  // Same ROW_GAP value (32) as HistogramCard so row-1 labels sit clear
  // of the row-0 label box (≈30 px tall: P-label + day-text + line
  // heights). Wider LABEL_HALF_W catches near-coincident markers.
  const LABEL_HALF_W = 22;
  const ROW_GAP = 32;
  const placed = [
    { value: p10Cost, label: 'P10', color: '#10b981' },
    { value: p50Cost, label: 'P50', color: '#3b82f6' },
    { value: p80Cost, label: 'P80', color: '#f59e0b' },
    { value: p95Cost, label: 'P95', color: '#ef4444' },
  ]
    .map((m) => ({ ...m, x: costToX(m.value) }))
    .sort((a, b) => a.x - b.x)
    .reduce<Array<{ value: number; label: string; color: string; x: number; row: number }>>(
      (acc, c) => {
        const lastRow0X = acc
          .filter((p) => p.row === 0)
          .reduce((mx, p) => Math.max(mx, p.x), -Infinity);
        const row = c.x - lastRow0X < LABEL_HALF_W * 2 ? 1 : 0;
        acc.push({ ...c, row });
        return acc;
      },
      [],
    );

  const budgetX = budget !== undefined ? costToX(budget) : null;

  return (
    <section className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">
            Project cost distribution
          </div>
          <div className="text-[11px] max-md:text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {mode === 'histogram'
              ? `Histogram of ${sortedCosts.length.toLocaleString()} simulated project costs · P10 / P50 / P80 / P95 marked`
              : `Cumulative distribution of ${sortedCosts.length.toLocaleString()} simulated project costs — y is the probability of finishing at or under x`}
          </div>
        </div>
        <div className="inline-flex bg-gray-100 dark:bg-gray-800 rounded-md p-0.5 shrink-0">
          <ChartModeTab on={mode === 'histogram'} onClick={() => setMode('histogram')}>
            Histogram
          </ChartModeTab>
          <ChartModeTab on={mode === 'cumulative'} onClick={() => setMode('cumulative')}>
            Cumulative
          </ChartModeTab>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-md">
        <div className="relative" style={{ height: VBOX_H + 'px' }}>
          <svg
            viewBox={`0 0 ${VBOX_W} ${VBOX_H}`}
            preserveAspectRatio="none"
            className="absolute inset-0 w-full h-full block cursor-crosshair"
            {...cursor.pointerHandlers}
          >
            {/* Y gridlines */}
            {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
              <line
                key={i}
                x1={xAxisLeft}
                y1={PLOT_BOTTOM - f * PLOT_H}
                x2={xAxisRight}
                y2={PLOT_BOTTOM - f * PLOT_H}
                className="stroke-gray-100 dark:stroke-gray-800"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {mode === 'histogram'
              ? bins.map((b, i) => {
                  const cx = costToX(b.centerCost);
                  const w = xAxisW / binCount - 2;
                  const h = (b.count / maxBinCount) * PLOT_H;
                  const overBudget = budget !== undefined && b.centerCost > budget;
                  const fill = overBudget ? '#fb923c' : '#3b82f6';
                  return (
                    <rect
                      key={i}
                      x={cx - w / 2}
                      y={PLOT_BOTTOM - h}
                      width={Math.max(1, w)}
                      height={h}
                      fill={fill}
                      opacity={0.85}
                      rx={1.5}
                    >
                      <title>{`${b.count} runs · ~${formatMoney(b.centerCost, project.currency)}`}</title>
                    </rect>
                  );
                })
              : // CDF: a thin polyline through (x, fractionAtOrBelow).
                (() => {
                  const pts: string[] = [];
                  for (let i = 0; i < sortedCosts.length; i++) {
                    const c = sortedCosts[i]!;
                    const x = costToX(c);
                    const f = (i + 1) / sortedCosts.length;
                    const y = PLOT_BOTTOM - f * PLOT_H;
                    pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
                  }
                  return (
                    <path
                      d={pts.join(' ')}
                      fill="none"
                      stroke="#3b82f6"
                      strokeWidth={1.8}
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })()}

            {/* Budget marker line */}
            {budgetX !== null && budget !== undefined && budget >= minCost && budget <= maxCost && (
              <line
                x1={budgetX}
                y1={PLOT_TOP + 6}
                x2={budgetX}
                y2={PLOT_BOTTOM}
                stroke="#059669"
                strokeWidth={2}
                opacity={0.85}
                vectorEffect="non-scaling-stroke"
              />
            )}

            {/* X-axis */}
            <line
              x1={xAxisLeft}
              y1={PLOT_BOTTOM}
              x2={xAxisRight}
              y2={PLOT_BOTTOM}
              stroke="#9ca3af"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />

            {/* P-marker lines */}
            {placed.map((m) => (
              <line
                key={m.label}
                x1={m.x}
                y1={PLOT_BOTTOM}
                x2={m.x}
                y2={PLOT_BOTTOM + 8 + m.row * ROW_GAP}
                stroke={m.color}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {/* Phase 19 slice 5 — draggable cursor on the cost axis. */}
            {cursor.cursorDataValue !== null &&
              (() => {
                const cx = costToX(cursor.cursorDataValue);
                if (cx < xAxisLeft - 1 || cx > xAxisRight + 1) return null;
                return (
                  <g pointerEvents="none">
                    <line
                      x1={cx}
                      y1={PLOT_TOP - 6}
                      x2={cx}
                      y2={PLOT_BOTTOM}
                      stroke="#64748b"
                      strokeWidth={cursor.isDragging ? 1.5 : 1}
                      strokeDasharray="4 3"
                      vectorEffect="non-scaling-stroke"
                    />
                    <path
                      d={`M${cx - 4},${PLOT_TOP - 6} L${cx + 4},${PLOT_TOP - 6} L${cx},${PLOT_TOP - 1} Z`}
                      fill="#64748b"
                    />
                  </g>
                );
              })()}
          </svg>

          {/* HTML overlay — percentile + axis labels at fixed sizes */}
          <div className="absolute inset-0 pointer-events-none">
            {placed.map((m) => (
              <div
                key={m.label}
                className="absolute text-[10.5px] max-md:text-xs font-semibold"
                style={{
                  left: `${(m.x / VBOX_W) * 100}%`,
                  top: `${((PLOT_BOTTOM + 10 + m.row * ROW_GAP) / VBOX_H) * 100}%`,
                  transform: 'translate(-50%, 0)',
                  color: m.color,
                }}
              >
                {m.label}
              </div>
            ))}
            {/* Axis x labels — min, mid, max */}
            <div
              className="absolute text-[10px] max-md:text-xs text-gray-500 dark:text-gray-400"
              style={{
                left: `${(xAxisLeft / VBOX_W) * 100}%`,
                top: `${((PLOT_BOTTOM + 36) / VBOX_H) * 100}%`,
                transform: 'translate(0, 0)',
              }}
            >
              {formatMoney(minCost, project.currency)}
            </div>
            <div
              className="absolute text-[10px] max-md:text-xs text-gray-500 dark:text-gray-400"
              style={{
                left: `${((xAxisLeft + xAxisW / 2) / VBOX_W) * 100}%`,
                top: `${((PLOT_BOTTOM + 36) / VBOX_H) * 100}%`,
                transform: 'translate(-50%, 0)',
              }}
            >
              {formatMoney((minCost + maxCost) / 2, project.currency)}
            </div>
            <div
              className="absolute text-[10px] max-md:text-xs text-gray-500 dark:text-gray-400"
              style={{
                left: `${(xAxisRight / VBOX_W) * 100}%`,
                top: `${((PLOT_BOTTOM + 36) / VBOX_H) * 100}%`,
                transform: 'translate(-100%, 0)',
              }}
            >
              {formatMoney(maxCost, project.currency)}
            </div>
            {/* Budget pill */}
            {budgetX !== null && budget !== undefined && budget >= minCost && budget <= maxCost && (
              <div
                className="absolute text-[10.5px] max-md:text-xs font-semibold bg-emerald-600 text-white rounded px-1.5 py-0.5"
                style={{
                  left: `${(budgetX / VBOX_W) * 100}%`,
                  top: `${(PLOT_TOP / VBOX_H) * 100}%`,
                  transform: 'translate(-50%, -100%)',
                }}
              >
                Budget {formatMoneyDual(budget, project.currency, currencyDisplay, fxSnapshot)}
              </div>
            )}

            {/* Phase 19 slice 5 — cursor tooltip. Histogram mode: bin
                count + cumulative % at or under this cost. Cumulative
                mode: cumulative % only (continuous read). */}
            {cursor.cursorDataValue !== null &&
              (() => {
                const cost = cursor.cursorDataValue;
                const cx = costToX(cost);
                const flipLeft = cx > VBOX_W * 0.65;
                const atOrUnder = sortedCosts.filter((c) => c <= cost).length;
                const atOrUnderPct =
                  sortedCosts.length > 0 ? (atOrUnder / sortedCosts.length) * 100 : 0;
                const binIdx =
                  mode === 'histogram'
                    ? bins.findIndex((b) => Math.abs(b.centerCost - cost) < binWidth / 2 + 0.001)
                    : -1;
                const bin = binIdx >= 0 ? bins[binIdx] : null;
                return (
                  <div
                    className="absolute rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-gray-900 shadow-md px-2.5 py-1.5 text-[11px] max-md:text-xs leading-tight"
                    style={{
                      left: flipLeft ? undefined : `calc(${(cx / VBOX_W) * 100}% + 8px)`,
                      right: flipLeft
                        ? `calc(${((VBOX_W - cx) / VBOX_W) * 100}% + 8px)`
                        : undefined,
                      top: `${((PLOT_TOP - 4) / VBOX_H) * 100}%`,
                      minWidth: 160,
                      zIndex: 3,
                    }}
                  >
                    <div className="text-gray-500 dark:text-gray-400 text-[10px] max-md:text-xs mb-0.5">
                      {formatMoney(cost, project.currency)}
                    </div>
                    {bin && (
                      <div className="flex justify-between gap-2 text-gray-700 dark:text-gray-200">
                        <span>Bin count</span>
                        <span className="font-mono font-semibold">{bin.count}</span>
                      </div>
                    )}
                    <div className="flex justify-between gap-2 text-gray-700 dark:text-gray-200">
                      <span>At or under</span>
                      <span className="font-mono font-semibold text-blue-700 dark:text-blue-400">
                        {atOrUnderPct.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                );
              })()}
          </div>
        </div>
      </div>

      {budget !== undefined && (
        <div className="flex items-center justify-between text-[11.5px] max-md:text-xs text-gray-600 dark:text-gray-300 px-1">
          <span>
            <span className="text-emerald-700 dark:text-emerald-400 font-semibold">{passPct}%</span>{' '}
            at or under budget
          </span>
          <span>
            <span className="text-amber-700 dark:text-amber-400 font-semibold">{missPct}%</span>{' '}
            over budget
          </span>
        </div>
      )}
    </section>
  );
}

// ── Compare sub-tab ───────────────────────────────────────────────────────────

interface CompareViewProps {
  simHistory: readonly SimRun[];
  project: ProjectFile;
  target: string;
}

/**
 * Phase 16 — side-by-side comparison of two simulation runs from history.
 * Default A = latest, B = next-most-recent (or the most recent what-if, if
 * one exists). Two dropdowns let the user pick any two runs.
 */
function CompareView({ simHistory, project, target }: CompareViewProps) {
  const projectStart = useMemo(
    () => new Date(project.project.startDate + 'T00:00:00'),
    [project.project.startDate],
  );

  const [aId, setAId] = useState<string | null>(simHistory[0]?.id ?? null);
  // Default B = a different run; prefer the most recent what-if if one exists,
  // otherwise the second-newest run.
  const [bId, setBId] = useState<string | null>(() => {
    const whatIf = simHistory.find((r) => r.excludes && r.excludes.length > 0);
    if (whatIf && whatIf.id !== simHistory[0]?.id) return whatIf.id;
    return simHistory[1]?.id ?? null;
  });

  // Keep selections valid as runs are added / cleared.
  useEffect(() => {
    if (!simHistory.some((r) => r.id === aId)) setAId(simHistory[0]?.id ?? null);
    if (!simHistory.some((r) => r.id === bId)) setBId(simHistory[1]?.id ?? null);
  }, [simHistory, aId, bId]);

  const runA = simHistory.find((r) => r.id === aId) ?? null;
  const runB = simHistory.find((r) => r.id === bId) ?? null;

  if (!runA || !runB) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500 text-sm">
        Run at least two simulations to compare them.
      </div>
    );
  }

  function runLabel(r: SimRun): string {
    const t = r.timestamp.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (r.excludes && r.excludes.length > 0) {
      const name = project.nodes.find((n) => n.id === r.excludes![0])?.name ?? r.excludes[0];
      return `What-if w/o ${name}  ·  ${t}`;
    }
    return `Run ${t}  ·  ${r.iterations.toLocaleString()} iters`;
  }

  return (
    <div className="flex-1 overflow-auto p-4 flex flex-col gap-4 bg-gray-50 dark:bg-gray-950">
      {/* Picker row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <RunPicker
          label="Run A"
          runs={simHistory}
          value={aId}
          onChange={setAId}
          runLabel={runLabel}
          accent="emerald"
        />
        <RunPicker
          label="Run B"
          runs={simHistory}
          value={bId}
          onChange={setBId}
          runLabel={runLabel}
          accent="amber"
        />
      </div>

      {/* Verdict deltas */}
      <CompareDeltas runA={runA} runB={runB} target={target} projectStart={projectStart} />

      {/* Dual histogram */}
      <CompareHistogram runA={runA} runB={runB} projectStart={projectStart} target={target} />

      {/* Side-by-side risk drivers */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <CompareDriversCard run={runA} label="Run A" project={project} accent="emerald" />
        <CompareDriversCard run={runB} label="Run B" project={project} accent="amber" />
      </div>
    </div>
  );
}

function RunPicker({
  label,
  runs,
  value,
  onChange,
  runLabel,
  accent,
}: {
  label: string;
  runs: readonly SimRun[];
  value: string | null;
  onChange: (id: string) => void;
  runLabel: (r: SimRun) => string;
  accent: 'emerald' | 'amber';
}) {
  const dot = accent === 'emerald' ? 'bg-emerald-500' : 'bg-amber-500';
  return (
    <label className="flex items-center gap-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg px-3 py-2">
      <span className={`w-2 h-2 rounded-full ${dot} shrink-0`} />
      <span className="text-[11px] max-md:text-xs font-semibold uppercase tracking-[0.06em] text-gray-500 dark:text-gray-400 shrink-0">
        {label}
      </span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 bg-transparent text-[13px] text-gray-900 dark:text-gray-100 focus:outline-none"
      >
        {runs.map((r) => (
          <option key={r.id} value={r.id}>
            {runLabel(r)}
          </option>
        ))}
      </select>
    </label>
  );
}

function CompareDeltas({
  runA,
  runB,
  target,
  projectStart,
}: {
  runA: SimRun;
  runB: SimRun;
  target: string;
  projectStart: Date;
}) {
  const p50A = daysSinceProjectStart(runA.result.percentiles.p50, projectStart);
  const p50B = daysSinceProjectStart(runB.result.percentiles.p50, projectStart);
  const p95A = daysSinceProjectStart(runA.result.percentiles.p95, projectStart);
  const p95B = daysSinceProjectStart(runB.result.percentiles.p95, projectStart);

  const targetDate = target ? new Date(target + 'T23:59:59') : null;
  function pct(r: SimRun): number | null {
    if (!targetDate) return null;
    const n = r.result.endDates.length;
    if (n === 0) return null;
    const passed = r.result.endDates.filter((d) => d.getTime() <= targetDate.getTime()).length;
    return passed / n;
  }
  const probA = pct(runA);
  const probB = pct(runB);

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <DeltaTile
        label="P50 finish"
        aValue={`${p50A.toFixed(1)}d`}
        bValue={`${p50B.toFixed(1)}d`}
        delta={p50B - p50A}
        unit="d"
      />
      <DeltaTile
        label="P95 finish"
        aValue={`${p95A.toFixed(1)}d`}
        bValue={`${p95B.toFixed(1)}d`}
        delta={p95B - p95A}
        unit="d"
      />
      <DeltaTile
        label="P50–P95 spread"
        aValue={`${(p95A - p50A).toFixed(1)}d`}
        bValue={`${(p95B - p50B).toFixed(1)}d`}
        delta={p95B - p50B - (p95A - p50A)}
        unit="d"
      />
      {probA !== null && probB !== null ? (
        <DeltaTile
          label="Target probability"
          aValue={`${Math.round(probA * 100)}%`}
          bValue={`${Math.round(probB * 100)}%`}
          delta={(probB - probA) * 100}
          unit="pp"
          // For probability, a positive delta is GOOD (higher chance of meeting target)
          // — invert the tone interpretation.
          positiveIsGood
        />
      ) : (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-3 text-[11px] max-md:text-xs text-gray-400 dark:text-gray-500">
          Set a target on the Monte Carlo tab to see target-probability delta.
        </div>
      )}
    </div>
  );
}

function DeltaTile({
  label,
  aValue,
  bValue,
  delta,
  unit,
  positiveIsGood,
}: {
  label: string;
  aValue: string;
  bValue: string;
  delta: number;
  unit: string;
  positiveIsGood?: boolean;
}) {
  const good = positiveIsGood ? delta >= 0 : delta <= 0;
  // Treat tiny deltas as neutral so we don't paint Δ=0.01d red/green.
  const neutral = Math.abs(delta) < 0.1;
  const tone = neutral
    ? 'text-gray-500 dark:text-gray-400'
    : good
      ? 'text-emerald-700 dark:text-emerald-400'
      : 'text-red-700 dark:text-red-400';
  const sign = delta > 0 ? '+' : '';
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-3 flex flex-col gap-1">
      <div className="text-[10.5px] max-md:text-xs font-semibold uppercase tracking-[0.05em] text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] max-md:text-xs text-gray-500 dark:text-gray-400 inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />A
        </span>
        <span className="text-[14px] font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          {aValue}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] max-md:text-xs text-gray-500 dark:text-gray-400 inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />B
        </span>
        <span className="text-[14px] font-semibold tabular-nums text-gray-900 dark:text-gray-100">
          {bValue}
        </span>
      </div>
      <div className={`text-[12px] font-semibold tabular-nums ${tone}`}>
        Δ {sign}
        {delta.toFixed(1)}
        {unit}
      </div>
    </div>
  );
}

function CompareHistogram({
  runA,
  runB,
  projectStart,
  target,
}: {
  runA: SimRun;
  runB: SimRun;
  projectStart: Date;
  target: string;
}) {
  // Shared day axis spanning both runs' min/max.
  const allDates = [...runA.result.endDates, ...runB.result.endDates];
  const minDay = Math.floor(
    Math.min(...allDates.map((d) => (d.getTime() - projectStart.getTime()) / 86_400_000)),
  );
  const maxDay = Math.ceil(
    Math.max(...allDates.map((d) => (d.getTime() - projectStart.getTime()) / 86_400_000)),
  );
  const binCount = Math.max(12, Math.min(32, maxDay - minDay + 1));
  const binWidth = (maxDay - minDay) / binCount || 1;

  function bin(dates: Date[]): number[] {
    const out = new Array<number>(binCount).fill(0);
    for (const d of dates) {
      const day = (d.getTime() - projectStart.getTime()) / 86_400_000;
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor((day - minDay) / binWidth)));
      out[idx]!++;
    }
    return out;
  }
  const binsA = bin(runA.result.endDates);
  const binsB = bin(runB.result.endDates);
  const maxCount = Math.max(...binsA, ...binsB, 1);

  const VBOX_W = 720;
  const VBOX_H = 240;
  const PLOT_TOP = 20;
  const PLOT_BOTTOM = 200;
  const PLOT_H = PLOT_BOTTOM - PLOT_TOP;
  const xAxisLeft = 30;
  const xAxisRight = VBOX_W - 12;
  const xAxisW = xAxisRight - xAxisLeft;
  const dayToX = (day: number) =>
    maxDay === minDay
      ? xAxisLeft + xAxisW / 2
      : xAxisLeft + ((day - minDay) / (maxDay - minDay)) * xAxisW;

  const targetDate = target ? new Date(target + 'T23:59:59') : null;
  const targetDay = targetDate
    ? (targetDate.getTime() - projectStart.getTime()) / 86_400_000
    : null;

  return (
    <section className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">
          Distribution overlay
        </div>
        <div className="inline-flex items-center gap-3 text-[11px] max-md:text-xs">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />A
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-500" />B
          </span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${VBOX_W} ${VBOX_H}`}
        preserveAspectRatio="xMidYMid meet"
        className="block w-full h-auto"
      >
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
          <line
            key={i}
            x1={xAxisLeft}
            y1={PLOT_BOTTOM - f * PLOT_H}
            x2={xAxisRight}
            y2={PLOT_BOTTOM - f * PLOT_H}
            className="stroke-gray-100 dark:stroke-gray-800"
          />
        ))}

        {targetDay !== null && targetDay >= minDay && targetDay <= maxDay && (
          <line
            x1={dayToX(targetDay)}
            y1={PLOT_TOP}
            x2={dayToX(targetDay)}
            y2={PLOT_BOTTOM}
            stroke="#059669"
            strokeWidth={2}
            opacity={0.7}
          />
        )}

        {binsA.map((countA, i) => {
          const countB = binsB[i] ?? 0;
          const centerDay = minDay + (i + 0.5) * binWidth;
          const x = dayToX(centerDay);
          const fullW = xAxisW / binCount - 1;
          const halfW = Math.max(1, fullW / 2 - 1);
          const hA = (countA / maxCount) * PLOT_H;
          const hB = (countB / maxCount) * PLOT_H;
          return (
            <g key={i}>
              <rect
                x={x - halfW - 0.5}
                y={PLOT_BOTTOM - hA}
                width={halfW}
                height={hA}
                fill="#10b981"
                opacity={0.85}
                rx={1.5}
              />
              <rect
                x={x + 0.5}
                y={PLOT_BOTTOM - hB}
                width={halfW}
                height={hB}
                fill="#f59e0b"
                opacity={0.85}
                rx={1.5}
              />
            </g>
          );
        })}

        <line x1={xAxisLeft} y1={PLOT_BOTTOM} x2={xAxisRight} y2={PLOT_BOTTOM} stroke="#9ca3af" />
        {/* Day-axis labels at minDay / mid / maxDay */}
        {[minDay, Math.round((minDay + maxDay) / 2), maxDay].map((d, i) => (
          <text
            key={i}
            x={dayToX(d)}
            y={PLOT_BOTTOM + 16}
            fontSize={11}
            fill="#6b7280"
            textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}
          >
            {d}d
          </text>
        ))}
      </svg>
    </section>
  );
}

function CompareDriversCard({
  run,
  label,
  project,
  accent,
}: {
  run: SimRun;
  label: string;
  project: ProjectFile;
  accent: 'emerald' | 'amber';
}) {
  const dot = accent === 'emerald' ? 'bg-emerald-500' : 'bg-amber-500';
  const top = run.result.tornado.slice(0, 4);
  const totalImpact = run.result.tornado.reduce((s, t) => s + t.impactHours, 0);

  return (
    <section className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-3.5 flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${dot}`} />
        <div className="text-[12.5px] font-semibold text-gray-900 dark:text-gray-100">
          {label} · top risk drivers
        </div>
      </div>
      {top.length === 0 ? (
        <div className="text-[12px] text-gray-500 dark:text-gray-400">
          No risk drivers in this run.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {top.map((t) => {
            const node = project.nodes.find((n) => n.id === t.nodeId);
            const sharePct = totalImpact > 0 ? Math.round((t.impactHours / totalImpact) * 100) : 0;
            return (
              <div key={t.nodeId} className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] font-medium text-gray-800 dark:text-gray-200 truncate min-w-0">
                  {node?.name ?? t.nodeId}
                </span>
                <span className="text-[12px] font-mono font-semibold text-gray-900 dark:text-gray-100">
                  {sharePct}%
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex items-center gap-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-full px-3 py-1 text-[11.5px] max-md:text-xs text-gray-700 dark:text-gray-300">
      {children}
    </div>
  );
}

// ── Risk Drivers card ───────────────────────────────────────────────────────

function RiskDriversCard({
  result,
  project,
  onRunWhatIf,
  running,
  axis,
}: {
  result: SimulationResult;
  project: ProjectFile;
  /**
   * Phase 16 — triggers a what-if simulation that excludes the given node's
   * distribution and switches to the Compare sub-tab when the run lands.
   * `null` means "no top driver to base the action on" (e.g. tornado empty).
   */
  onRunWhatIf: (nodeId: string) => void;
  running: boolean;
  /** Phase 19 — switches between the date tornado and the cost tornado. */
  axis: 'date' | 'cost';
}) {
  // Phase 19 — flatten the date / cost tornado to a single { nodeId, impact }
  // shape so the rendering below stays unchanged. Each ranking has its own
  // total / unit; the share % is computed against that ranking's own total.
  const rawDrivers =
    axis === 'cost'
      ? result.costTornado.map((t) => ({ nodeId: t.nodeId, impact: t.impactCost }))
      : result.tornado.map((t) => ({ nodeId: t.nodeId, impact: t.impactHours }));
  const subLabel = axis === 'cost' ? '% of project-cost variance' : '% of finish-date variance';

  if (rawDrivers.length === 0) {
    return (
      <SideCard title="Risk drivers" sub={subLabel}>
        <div className="text-[12px] text-gray-500 dark:text-gray-400 px-1 py-2">
          {axis === 'cost'
            ? 'No cost drivers — no node has variance flowing into project cost.'
            : 'No risk drivers — none of the variance-bearing nodes were on the critical path.'}
        </div>
      </SideCard>
    );
  }

  // Total impact across all drivers — used to compute each driver's share.
  const totalImpact = rawDrivers.reduce((s, t) => s + t.impact, 0);

  // Variance bucket from the impact quantile in the visible list.
  const top = rawDrivers[0]!.impact;
  function bucket(h: number): 'high' | 'medium' | 'low' {
    if (h >= top * 0.5) return 'high';
    if (h >= top * 0.2) return 'medium';
    return 'low';
  }

  const visible = rawDrivers.slice(0, 6);
  const topDriver = visible[0];
  const topName = project.nodes.find((n) => n.id === topDriver?.nodeId)?.name ?? '—';

  return (
    <SideCard title="Risk drivers" sub={subLabel}>
      <div className="flex flex-col gap-3">
        {visible.map((t) => {
          const node = project.nodes.find((n) => n.id === t.nodeId);
          const sharePct = totalImpact > 0 ? Math.round((t.impact / totalImpact) * 100) : 0;
          const b = bucket(t.impact);
          const impactLabel =
            axis === 'cost'
              ? `${formatMoney(t.impact, project.currency)} cost spread`
              : `${t.impact.toFixed(1)}h schedule impact`;
          return (
            <div key={t.nodeId} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] font-medium text-gray-900 dark:text-gray-100 truncate min-w-0">
                  {node?.name ?? t.nodeId}
                </span>
                <span className="text-[12px] font-mono font-semibold text-gray-900 dark:text-gray-100 shrink-0">
                  {sharePct}%
                </span>
              </div>
              <div className="h-1 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-emerald-300 to-emerald-600"
                  style={{ width: `${sharePct}%` }}
                />
              </div>
              <div className="inline-flex items-center gap-1.5">
                <VariancePill bucket={b} />
                <span className="text-[10.5px] max-md:text-xs text-gray-500 dark:text-gray-400">
                  {impactLabel}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        disabled={!topDriver || running}
        onClick={() => topDriver && onRunWhatIf(topDriver.nodeId)}
        title={
          running
            ? 'A simulation is already running'
            : `Re-run the simulation with ${topName}'s distribution collapsed to its nominal duration`
        }
        className="text-left w-full text-[12px] text-emerald-700 dark:text-emerald-400 hover:text-emerald-900 px-1 py-1 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Show what-if without &quot;{topName}&quot; →
      </button>
    </SideCard>
  );
}

function VariancePill({ bucket }: { bucket: 'high' | 'medium' | 'low' }) {
  const styles = {
    high: 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300',
    medium: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
    low: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
  }[bucket];
  return (
    <span
      className={`text-[9px] max-md:text-xs font-semibold uppercase tracking-[0.04em] px-1.5 py-0.5 rounded-full ${styles}`}
    >
      {bucket}
    </span>
  );
}

/**
 * Phase 31 Slice 2 — qualitative pill for Spearman ρ magnitudes.
 * Thresholds match the conventional "strong / moderate / weak" reading
 * of correlations and parallel the Variance pill above.
 */
function CorrelationPill({ rho }: { rho: number }) {
  const abs = Math.abs(rho);
  const bucket: 'strong' | 'moderate' | 'weak' =
    abs >= 0.7 ? 'strong' : abs >= 0.3 ? 'moderate' : 'weak';
  const styles = {
    strong: 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300',
    moderate: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
    weak: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
  }[bucket];
  return (
    <span
      className={`text-[9px] max-md:text-xs font-semibold uppercase tracking-[0.04em] px-1.5 py-0.5 rounded-full ${styles}`}
    >
      {bucket}
    </span>
  );
}

// ── Critical-path frequency (per-path is the primary view; per-node sub-toggle) ─

function CriticalPathFrequencyCard({
  result,
  project,
}: {
  result: SimulationResult;
  project: ProjectFile;
}) {
  const [mode, setMode] = useState<'path' | 'node'>('path');
  // Phase 47 Slice 2 — per-path expand/collapse. Set holds indices of
  // currently-expanded rows; clicking a row toggles its truncate class.
  // State persists across Path/Node mode switches — minor, harmless.
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<number>>(new Set());

  // Phase 16 — real per-path data. Each entry is a paths' frequency across
  // the run. Total iteration count is the denominator for percentages.
  const totalIter = result.endDates.length;
  const topPaths = result.pathFrequency.slice(0, 6);
  const topNodes = Object.entries(result.criticalityIndex)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6);

  const nodeName = (id: string): string => project.nodes.find((n) => n.id === id)?.name ?? id;

  return (
    <SideCard
      title="Critical-path frequency"
      sub={
        mode === 'path'
          ? 'how often each path was critical'
          : 'how often each node was on the critical path'
      }
      headerAside={
        <div className="inline-flex bg-gray-100 dark:bg-gray-800 rounded-md p-0.5 shrink-0">
          <SubToggle on={mode === 'path'} onClick={() => setMode('path')}>
            Path
          </SubToggle>
          <SubToggle on={mode === 'node'} onClick={() => setMode('node')}>
            Node
          </SubToggle>
        </div>
      }
    >
      {mode === 'path' ? (
        topPaths.length === 0 ? (
          <div className="text-[12px] text-gray-500 dark:text-gray-400 py-2">
            No per-path data yet.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {topPaths.map((entry, i) => {
              const pctRound = totalIter > 0 ? Math.round((entry.count / totalIter) * 100) : 0;
              const hot = pctRound >= 30;
              const label = entry.path.map(nodeName).join(' → ');
              const expanded = expandedPaths.has(i);
              return (
                <div key={i} className="flex flex-col gap-1">
                  {/* Phase 47 Slice 2 — click row to expand/collapse the
                      path label. Default is truncated (one line + tooltip);
                      expanded wraps to multiple lines so long pharma /
                      multi-subsystem paths can be read in full. */}
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedPaths((prev) => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i);
                        else next.add(i);
                        return next;
                      })
                    }
                    title={expanded ? 'Click to collapse' : 'Click to show full path'}
                    className="flex items-center gap-1.5 text-left w-full rounded hover:bg-gray-50 dark:hover:bg-gray-800/60 -mx-1 px-1 py-0.5 transition-colors"
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        hot ? 'bg-rose-500 ring-2 ring-rose-200/60' : 'bg-gray-400 dark:bg-gray-500'
                      }`}
                    />
                    <span
                      className={`text-[12px] font-medium text-gray-800 dark:text-gray-200 flex-1 ${
                        expanded ? 'whitespace-normal break-words' : 'truncate'
                      }`}
                    >
                      {label}
                    </span>
                    <span className="text-[12px] font-mono font-semibold text-gray-900 dark:text-gray-100 shrink-0">
                      {pctRound}%
                    </span>
                  </button>
                  <div className="h-[3px] rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${pctRound}%`,
                        background: hot ? '#ef4444' : '#94a3b8',
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : topNodes.length === 0 ? (
        <div className="text-[12px] text-gray-500 dark:text-gray-400 py-2">
          No per-node data yet.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {topNodes.map(([nodeId, pct]) => {
            const pctRound = Math.round(pct * 100);
            const hot = pctRound >= 50;
            return (
              <div key={nodeId} className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      hot ? 'bg-rose-500 ring-2 ring-rose-200/60' : 'bg-gray-400 dark:bg-gray-500'
                    }`}
                  />
                  <span className="text-[12px] font-medium text-gray-800 dark:text-gray-200 flex-1 truncate">
                    {nodeName(nodeId)}
                  </span>
                  <span className="text-[12px] font-mono font-semibold text-gray-900 dark:text-gray-100">
                    {pctRound}%
                  </span>
                </div>
                <div className="h-[3px] rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${pctRound}%`,
                      background: hot ? '#ef4444' : '#94a3b8',
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SideCard>
  );
}

// ── Sensitivity scatterplot (Phase 31 Slice 2) ──────────────────────────────

/**
 * Per-input scatterplot of (sampled input value, project finish hours OR
 * project cost) with Spearman ρ in the corner. Captures monotone non-linear
 * coupling that the range × criticality tornado misses.
 *
 * Data source: `result.nodeInputSamples` + `result.sensitivityFinishHours` /
 * `result.sensitivityProjectCosts` (all index-aligned, all stride-subsampled
 * by the engine — see ARCHITECTURE.md "Per-iteration sample retention").
 * No engine work in this slice; just renders what's already on the result.
 *
 * The axis toggle is local (not the global simChartMode) because the card
 * lives in the right sidebar regardless of the main panel's mode — the
 * user might be looking at the date histogram on the left while
 * inspecting cost sensitivity here.
 */
function SensitivityCard({ result, project }: { result: SimulationResult; project: ProjectFile }) {
  const hasCost = projectHasCostData(project);
  const [axis, setAxis] = useState<'finish' | 'cost'>('finish');
  // Drop to 'finish' if the project loses cost data after the card mounted
  // in cost mode (matches the simChartMode fallback pattern at line ~899).
  const effectiveAxis: 'finish' | 'cost' = hasCost && axis === 'cost' ? 'cost' : 'finish';

  const rhoMap = effectiveAxis === 'cost' ? result.costSensitivity : result.finishSensitivity;
  const yValues =
    effectiveAxis === 'cost' ? result.sensitivityProjectCosts : result.sensitivityFinishHours;

  // All variance-bearing node ids sorted by |ρ| desc (and stable by id for
  // determinism when ρ ties).
  const sortedIds = useMemo(() => {
    const ids = Object.keys(result.nodeInputSamples);
    return ids.sort((a, b) => {
      const ra = Math.abs(rhoMap[a] ?? 0);
      const rb = Math.abs(rhoMap[b] ?? 0);
      if (rb !== ra) return rb - ra;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }, [result.nodeInputSamples, rhoMap]);

  // Default to top-1 by |ρ| for the current axis. When the axis flips or
  // the run changes, fall back to the new top-1 unless the user has
  // already picked something that's still in scope.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const selectedId: string | null =
    pickedId !== null && rhoMap[pickedId] !== undefined ? pickedId : (sortedIds[0] ?? null);

  const axisToggle = hasCost ? (
    <div className="inline-flex bg-gray-100 dark:bg-gray-800 rounded p-0.5">
      <SubToggle on={effectiveAxis === 'finish'} onClick={() => setAxis('finish')}>
        Finish
      </SubToggle>
      <SubToggle on={effectiveAxis === 'cost'} onClick={() => setAxis('cost')}>
        Cost
      </SubToggle>
    </div>
  ) : null;

  // Empty state — no variance-bearing nodes at all.
  if (sortedIds.length === 0 || selectedId === null) {
    return (
      <SideCard
        title="Sensitivity"
        sub={`Spearman ρ — input vs project ${effectiveAxis === 'cost' ? 'cost' : 'finish'}`}
        headerAside={axisToggle}
      >
        <div className="text-[12px] text-gray-500 dark:text-gray-400 px-1 py-2">
          No variance-bearing nodes — add a distribution to an activity to surface sensitivity.
        </div>
      </SideCard>
    );
  }

  const xs = result.nodeInputSamples[selectedId] ?? [];
  const rho = rhoMap[selectedId] ?? 0;
  const node = project.nodes.find((n) => n.id === selectedId);
  const nodeName = node?.name ?? selectedId;
  const isDecision = node?.nodeType === 'decision';
  const xLabel = isDecision ? 'pass prob' : 'duration (h)';
  const yLabel = effectiveAxis === 'cost' ? 'project cost' : 'finish (h)';

  return (
    <SideCard
      title="Sensitivity"
      sub={`Spearman ρ — input vs project ${effectiveAxis === 'cost' ? 'cost' : 'finish'}`}
      headerAside={axisToggle}
    >
      {/* Node picker — every variance-bearing node, sorted by |ρ| desc. */}
      <select
        value={selectedId}
        onChange={(e) => setPickedId(e.target.value)}
        className="w-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-[11.5px] max-md:text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
        title="Pick an input variable (sorted by |ρ|)"
      >
        {sortedIds.map((id) => {
          const n = project.nodes.find((x) => x.id === id);
          const r = rhoMap[id] ?? 0;
          return (
            <option key={id} value={id}>
              {n?.name ?? id} · ρ = {r.toFixed(2)}
            </option>
          );
        })}
      </select>

      {/* ρ value + qualitative pill */}
      <div className="flex items-center justify-between gap-2 px-0.5">
        <span className="text-[11px] max-md:text-xs font-mono text-gray-700 dark:text-gray-300">
          ρ ={' '}
          <span className="font-semibold text-gray-900 dark:text-gray-100">{rho.toFixed(3)}</span>
        </span>
        <CorrelationPill rho={rho} />
      </div>

      {/* Scatter */}
      <Scatter
        xs={xs}
        ys={yValues}
        xLabel={xLabel}
        yLabel={yLabel}
        currency={effectiveAxis === 'cost' ? project.currency : null}
        nodeName={nodeName}
      />

      <div className="text-[10px] max-md:text-xs text-gray-400 dark:text-gray-500">
        {xs.length.toLocaleString()} retained samples · selected by |ρ|
      </div>
    </SideCard>
  );
}

/**
 * Pure-SVG scatterplot. Stretches to container width via
 * `preserveAspectRatio="none"`; HTML overlay labels carry the per-axis
 * range (mirrors the histogram's "text in HTML, not SVG" rule from
 * CLAUDE.md so the labels don't squish with the chart).
 *
 * Hover tooltip: the SVG carries a transparent <rect> overlay; on
 * mousemove we map the pointer position back into data space and find
 * the nearest sample by Euclidean distance (linear scan over xs/ys —
 * cheap at 10 k points and below).
 */
function Scatter({
  xs,
  ys,
  xLabel,
  yLabel,
  currency,
  nodeName,
}: {
  xs: number[];
  ys: number[];
  xLabel: string;
  yLabel: string;
  currency: string | null;
  nodeName: string;
}) {
  const { ref, width } = useContainerWidth(280, 200);
  const VBOX_W = 720;
  const VBOX_H = 220;
  const PAD_LEFT = 8;
  const PAD_RIGHT = 8;
  const PAD_TOP = 10;
  const PAD_BOTTOM = 14;

  const [hover, setHover] = useState<{
    px: number;
    py: number;
    x: number;
    y: number;
  } | null>(null);

  // Defensive: matching lengths should always hold per engine invariant.
  const n = Math.min(xs.length, ys.length);
  if (n === 0) {
    return (
      <div
        ref={ref}
        className="text-[11px] max-md:text-xs text-gray-500 dark:text-gray-400 px-1 py-3 text-center"
      >
        No samples to plot.
      </div>
    );
  }

  // Domain. Add tiny padding to avoid points sitting on the frame.
  let xMin = Infinity,
    xMax = -Infinity,
    yMin = Infinity,
    yMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  if (xMin === xMax) {
    xMin -= 0.5;
    xMax += 0.5;
  }
  if (yMin === yMax) {
    yMin -= 0.5;
    yMax += 0.5;
  }
  const xSpan = xMax - xMin;
  const ySpan = yMax - yMin;

  const innerW = VBOX_W - PAD_LEFT - PAD_RIGHT;
  const innerH = VBOX_H - PAD_TOP - PAD_BOTTOM;
  function xToPx(x: number): number {
    return PAD_LEFT + ((x - xMin) / xSpan) * innerW;
  }
  function yToPx(y: number): number {
    // Flip — higher y goes UP in screen space.
    return PAD_TOP + (1 - (y - yMin) / ySpan) * innerH;
  }

  // Format helper for the hover tooltip.
  function fmtY(y: number): string {
    if (currency) {
      // Compact currency display via existing formatMoney path.
      return formatMoney(y, currency);
    }
    return `${y.toFixed(1)}h`;
  }
  function fmtX(x: number): string {
    // pass-prob domain ([0, 1]) gets 2 decimals; duration in hours gets 1.
    if (xMax <= 1.01 && xMin >= -0.01) return x.toFixed(2);
    return `${x.toFixed(1)}h`;
  }

  function onMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    // Map pointer-px into viewBox coords. Because preserveAspectRatio
    // is "none", scale x and y independently.
    const vx = ((e.clientX - rect.left) / rect.width) * VBOX_W;
    const vy = ((e.clientY - rect.top) / rect.height) * VBOX_H;
    // Find the closest sample by viewBox-space distance.
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const px = xToPx(xs[i]!);
      const py = yToPx(ys[i]!);
      const dx = px - vx;
      const dy = py - vy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover({ px: xToPx(xs[best]!), py: yToPx(ys[best]!), x: xs[best]!, y: ys[best]! });
  }

  return (
    <div ref={ref} className="relative w-full">
      <svg
        viewBox={`0 0 ${VBOX_W} ${VBOX_H}`}
        preserveAspectRatio="none"
        className="w-full h-[140px] block"
        style={{ width: `${width}px` }}
      >
        {/* Frame */}
        <rect
          x={PAD_LEFT}
          y={PAD_TOP}
          width={innerW}
          height={innerH}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.08}
          vectorEffect="non-scaling-stroke"
        />
        {/* Points */}
        {Array.from({ length: n }, (_, i) => (
          <circle
            key={i}
            cx={xToPx(xs[i]!)}
            cy={yToPx(ys[i]!)}
            r={2}
            fill="rgb(16 185 129)"
            fillOpacity={0.2}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {/* Hover highlight (drawn after points) */}
        {hover && (
          <circle
            cx={hover.px}
            cy={hover.py}
            r={4}
            fill="rgb(16 185 129)"
            stroke="rgb(255 255 255)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {/* Pointer-capture overlay — captures mousemove for the tooltip
            without intercepting per-point hover (which we don't use). */}
        <rect
          x={0}
          y={0}
          width={VBOX_W}
          height={VBOX_H}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>
      {/* HTML overlay labels — kept out of SVG per "text scales with stretch"
          gotcha documented in CLAUDE.md. */}
      <div className="absolute inset-x-0 -bottom-0.5 flex items-center justify-between px-1 pointer-events-none text-[9px] max-md:text-xs text-gray-400 dark:text-gray-500 font-mono">
        <span>{fmtX(xMin)}</span>
        <span className="text-gray-500 dark:text-gray-400">{xLabel} →</span>
        <span>{fmtX(xMax)}</span>
      </div>
      <div className="absolute top-0 left-1 text-[9px] max-md:text-xs text-gray-400 dark:text-gray-500 font-mono pointer-events-none">
        ↑ {yLabel}
      </div>
      {hover && (
        <div
          className="absolute pointer-events-none z-10 bg-gray-900 dark:bg-gray-800 text-white text-[10px] max-md:text-xs font-mono px-1.5 py-1 rounded shadow whitespace-nowrap"
          style={{
            // Position the tooltip near the highlighted point, offset to
            // avoid overlapping the cursor.
            left: `${(hover.px / VBOX_W) * 100}%`,
            top: `${(hover.py / VBOX_H) * 100}%`,
            transform: 'translate(8px, -50%)',
          }}
          title={nodeName}
        >
          {fmtX(hover.x)} → {fmtY(hover.y)}
        </div>
      )}
    </div>
  );
}

// ── Side card shell ─────────────────────────────────────────────────────────

function SideCard({
  title,
  sub,
  headerAside,
  children,
}: {
  title: string;
  sub?: string;
  /** Optional element rendered on the right side of the title row (e.g. a sub-toggle). */
  headerAside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-3.5 flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-px min-w-0">
          <div className="text-[12.5px] font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </div>
          {sub && (
            <div className="text-[10.5px] max-md:text-xs text-gray-500 dark:text-gray-400">
              {sub}
            </div>
          )}
        </div>
        {headerAside}
      </div>
      {children}
    </section>
  );
}

function SubToggle({
  children,
  on,
  onClick,
}: {
  children: React.ReactNode;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'px-2 py-0.5 rounded text-[10.5px] max-md:text-xs font-medium transition-colors',
        on
          ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-[0_1px_2px_rgba(15,23,42,0.06)]'
          : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
      ].join(' ')}
    >
      {children}
    </button>
  );
}
