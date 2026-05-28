import { useState, useMemo, useRef } from 'react';
import { greedyCrash } from '@procsim/scheduler';
import type { GreedyCrashPlan, ScheduleInput, ScheduleResult } from '@procsim/scheduler';
import type { ChanceCrashPlan } from '@procsim/simulation';
import type { ProjectFile } from '@procsim/file-format';
import { convertResourceCostsToProjectCurrency } from '@procsim/file-format';
import { useDomainStore } from '../store/domainStore.js';
import { formatMoney } from '../utils/cost.js';
import { getEngineWorker } from '../engineWorker.js';
import { useModalEscape } from '../hooks/useModalEscape.js';

interface CrashToDeadlineModalProps {
  project: ProjectFile;
  result: ScheduleResult;
  onClose: () => void;
  /**
   * Phase 26 — pre-populate the modal with a sweep-derived plan + deadline.
   * When provided, the modal opens with the plan already shown in the
   * preview table; the user can click Accept directly without re-running
   * the greedy. Both must be set together; passing just one is ignored.
   */
  initialPlan?: GreedyCrashPlan;
  initialDeadline?: Date;
}

type RunMode = 'deterministic' | 'chance';
/** Union covering both Slice-3 and Slice-4 plan shapes. */
type AnyPlan = GreedyCrashPlan | ChanceCrashPlan;
function isChancePlan(p: AnyPlan): p is ChanceCrashPlan {
  return 'finalP95' in p;
}

/**
 * Phase 25 Slice 3 + Slice 4 — modal that runs a greedy crasher (either
 * deterministic via `greedyCrash` or chance-constrained via
 * `chanceCrash`), previews the picks, and applies the plan via the
 * domain store in a single undo step.
 *
 * UX shape mirrors Phase 17's `LevelingPreviewModal`. Slice 4 added a
 * "Run mode" segmented control: switching modes resets the plan but
 * preserves the deadline / reset-first selections so users can flip
 * back and forth to compare. Chance mode shows MC budget + seed inputs,
 * runs in the engine Web Worker, and displays a progress bar + Cancel
 * button while the run is in flight. Per Slice 4 spec, cancellation
 * discards the partial plan — the user "gave up" and shouldn't be
 * offered an incomplete artefact.
 */
export function CrashToDeadlineModal({
  project,
  result,
  onClose,
  initialPlan,
  initialDeadline,
}: CrashToDeadlineModalProps) {
  const applyCrashPlan = useDomainStore((s) => s.applyCrashPlan);

  // Pre-populated deadline (from Pareto sweep) or default to one day
  // before current finish.
  const defaultDeadline = useMemo(() => {
    const seed =
      initialDeadline && initialPlan
        ? initialDeadline
        : new Date(result.projectEnd.getTime() - 86_400_000);
    return seed.toISOString().slice(0, 10);
  }, [result.projectEnd, initialDeadline, initialPlan]);

  const [mode, setMode] = useState<RunMode>('deterministic');
  const [deadlineStr, setDeadlineStr] = useState<string>(defaultDeadline);
  const [resetFirst, setResetFirst] = useState(false);
  const [iterations, setIterations] = useState(100);
  const [seed, setSeed] = useState(42);
  const [plan, setPlan] = useState<AnyPlan | null>(
    initialPlan && initialDeadline ? initialPlan : null,
  );
  const [computeError, setComputeError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  // Cancellation: aborting the AbortController flips `signal.aborted` and
  // the worker rejects the in-flight chance-crash promise.
  const abortRef = useRef<AbortController | null>(null);

  const nodeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of project.nodes) m.set(n.id, n.name);
    return m;
  }, [project.nodes]);

  function buildInput(): ScheduleInput {
    const nodes = resetFirst
      ? project.nodes.map((n) => {
          if (n.selectedCrashIndex === undefined) return n;
          const { selectedCrashIndex: _omit, ...rest } = n;
          return rest;
        })
      : project.nodes;
    return {
      project: project.project,
      nodes,
      edges: project.edges,
      // Phase 33 Slice 2 — convert per-resource costs to project currency.
      resources: convertResourceCostsToProjectCurrency(project),
      calendars: project.calendars,
      loops: project.loops,
      subsystems: project.subsystems,
    };
  }

  function handlePreview() {
    setComputeError(null);
    setPlan(null);
    const deadline = new Date(deadlineStr + 'T23:59:59');
    if (!isFinite(deadline.getTime())) {
      setComputeError('Pick a valid deadline date.');
      return;
    }
    const input = buildInput();

    if (mode === 'deterministic') {
      setPlan(greedyCrash(input, deadline));
      return;
    }

    // Chance-constrained: kick off the worker run.
    if (iterations < 10 || iterations > 5000) {
      setComputeError('MC budget must be between 10 and 5000.');
      return;
    }
    setRunning(true);
    setProgress(0);
    const abort = new AbortController();
    abortRef.current = abort;
    void getEngineWorker()
      .chanceCrashAsync(input, deadline, { iterations, seed }, abort.signal, (pct) =>
        setProgress(pct),
      )
      .then((p) => {
        // Per Slice 4 spec: cancellation discards the partial plan.
        if (p.cancelled) {
          setPlan(null);
        } else {
          setPlan(p);
        }
      })
      .catch((err) => {
        if (abort.signal.aborted) {
          // Cancel-triggered rejection — discard quietly.
          setPlan(null);
        } else {
          setComputeError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        setRunning(false);
        setProgress(0);
        abortRef.current = null;
      });
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  // Audit I-26 — keyboard parity with the ×, Discard, and backdrop-click
  // close paths: Esc dismisses the modal while idle but is suppressed
  // mid-run (matching the disabled state on those other paths). Without
  // this, keyboard users had no way to close the modal.
  // Audit I-21 — routed through modalStack so only the top-most modal
  // responds when layered. `enabled: !running` matches the prior gate.
  useModalEscape(onClose, { enabled: !running });

  function handleAccept() {
    if (!plan) return;
    applyCrashPlan(plan, { resetFirst });
    onClose();
  }

  const finalFinishDate = plan ? plan.finalFinish : null;
  const finalP95Date = plan && isChancePlan(plan) ? plan.finalP95 : null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={running ? undefined : onClose}
    >
      <div
        className="relative w-[min(640px,92vw)] max-h-[85vh] flex flex-col bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <div>
            <div className="text-[14px] font-semibold text-gray-900 dark:text-gray-100">
              Compress to deadline
            </div>
            <div className="text-[11.5px] text-gray-500 dark:text-gray-400 mt-0.5">
              Pick a deadline. The greedy assigns compression options on critical-path activities,
              cheapest $/day first.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-700 w-[22px] h-[22px] inline-flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-30"
            aria-label="Cancel"
          >
            ×
          </button>
        </div>

        {/* Controls */}
        <div className="flex flex-col gap-3 px-5 py-3 border-b border-gray-100 dark:border-gray-800">
          {/* Run mode segmented control */}
          <div className="flex items-center gap-2 text-[12.5px]">
            <span className="text-gray-500 dark:text-gray-400 shrink-0">Run mode</span>
            <div className="inline-flex rounded border border-gray-200 dark:border-gray-700 overflow-hidden">
              {(['deterministic', 'chance'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={running}
                  onClick={() => {
                    setMode(m);
                    setPlan(null);
                  }}
                  className={[
                    'px-3 py-1 text-[12px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                    mode === m
                      ? 'bg-emerald-500 text-white'
                      : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700',
                  ].join(' ')}
                  title={
                    m === 'deterministic'
                      ? 'Point-estimate CPM — instant preview'
                      : 'Monte Carlo P95 — runs in the worker'
                  }
                >
                  {m === 'deterministic' ? 'Deterministic' : 'Chance-constrained P95'}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-[12.5px] text-gray-700 dark:text-gray-200">
              <span>Deadline</span>
              <input
                type="date"
                value={deadlineStr}
                onChange={(e) => setDeadlineStr(e.target.value)}
                disabled={running}
                className="rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-[12.5px] px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:opacity-50"
              />
            </label>
            <label className="flex items-center gap-2 text-[12.5px] text-gray-700 dark:text-gray-200">
              <input
                type="checkbox"
                checked={resetFirst}
                onChange={(e) => setResetFirst(e.target.checked)}
                disabled={running}
                className="rounded border-gray-300 dark:border-gray-600 text-emerald-600 focus:ring-emerald-400"
              />
              <span title="Clear every existing compression selection on the project before applying the new plan">
                Reset all compressions first
              </span>
            </label>
            <div className="ml-auto flex items-center gap-2">
              {running ? (
                <button
                  type="button"
                  onClick={handleCancel}
                  className="text-[12px] font-medium bg-red-600 text-white px-3 py-1.5 rounded hover:bg-red-700"
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handlePreview}
                  className="text-[12px] font-medium bg-emerald-600 text-white px-3 py-1.5 rounded hover:bg-emerald-700"
                >
                  Preview plan
                </button>
              )}
            </div>
          </div>

          {/* Chance-only knobs */}
          {mode === 'chance' && (
            <div className="flex items-center gap-3 flex-wrap text-[12.5px] text-gray-700 dark:text-gray-200">
              <label className="flex items-center gap-2">
                <span>MC budget</span>
                <input
                  type="number"
                  min={10}
                  max={5000}
                  step={50}
                  value={iterations}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (isFinite(v)) setIterations(v);
                  }}
                  disabled={running}
                  className="w-20 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 disabled:opacity-50"
                  title="Monte Carlo iterations per evaluation step"
                />
              </label>
              <label className="flex items-center gap-2">
                <span>Seed</span>
                <input
                  type="number"
                  value={seed}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (isFinite(v)) setSeed(v);
                  }}
                  disabled={running}
                  className="w-20 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 disabled:opacity-50"
                  title="Same seed → same MC paths → stable evaluations"
                />
              </label>
              <span className="text-[10.5px] text-gray-400 dark:text-gray-500">
                ε-tolerance: 0.5 working days.
              </span>
            </div>
          )}

          {/* Progress bar (chance mode only) */}
          {running && (
            <div className="h-1.5 rounded bg-gray-100 dark:bg-gray-800 overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${Math.max(2, Math.round(progress * 100))}%` }}
              />
            </div>
          )}

          {computeError && <p className="text-[11.5px] text-red-500">{computeError}</p>}
          <p className="text-[10.5px] text-gray-400 dark:text-gray-500">
            Current finish:{' '}
            {result.projectEnd.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })}
            .
          </p>
        </div>

        {/* Plan preview */}
        <div className="flex-1 overflow-auto px-5 py-3">
          {plan === null ? (
            <p className="text-[12.5px] text-gray-400 dark:text-gray-500 italic">
              {running
                ? 'Running chance-constrained greedy in the worker…'
                : 'Click Preview plan to compute the greedy compression assignment.'}
            </p>
          ) : plan.steps.length === 0 ? (
            <div className="text-[12.5px] text-gray-700 dark:text-gray-300 flex flex-col gap-2">
              {plan.reachedDeadline ? (
                <p>
                  Deadline already met — no compression steps needed (
                  {isChancePlan(plan) ? 'P95 finish' : 'current finish'} is on or before the chosen
                  date, within the ε-tolerance).
                </p>
              ) : (
                <p>
                  No critical-path activity has a feasible compression option to apply. Add
                  compression options on critical-path activities, then re-preview.
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
                <div className="text-gray-700 dark:text-gray-200">
                  {plan.steps.length} compression step
                  {plan.steps.length === 1 ? '' : 's'} ·{' '}
                  {isChancePlan(plan) && finalP95Date ? (
                    <>
                      final P95{' '}
                      <span className="font-medium">
                        {finalP95Date.toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                    </>
                  ) : (
                    <>
                      final finish{' '}
                      <span className="font-medium">
                        {finalFinishDate?.toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        }) ?? ''}
                      </span>
                    </>
                  )}
                </div>
                <div className="text-gray-700 dark:text-gray-200">
                  Total added cost:{' '}
                  <span className="font-semibold">
                    +{formatMoney(plan.totalAddedCost, project.currency)}
                  </span>
                </div>
              </div>
              {!plan.reachedDeadline && (
                <div className="rounded border border-amber-200 dark:border-amber-900 bg-amber-50/70 dark:bg-amber-950/30 px-3 py-2 text-[11.5px] text-amber-800 dark:text-amber-300">
                  Deadline not fully reachable — greedy applied every feasible compression but the{' '}
                  {isChancePlan(plan) ? 'P95 finish' : 'finish'} remains after the requested date.
                  Consider adding deeper compression options on critical-path activities.
                </div>
              )}
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[10.5px] uppercase tracking-wide text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-800">
                    <th className="py-1 pr-2 font-medium">#</th>
                    <th className="py-1 pr-2 font-medium">Activity</th>
                    <th className="py-1 pr-2 font-medium text-right">From → To</th>
                    <th className="py-1 pr-2 font-medium text-right">$/day</th>
                    <th className="py-1 pl-2 font-medium text-right">Added cost</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.steps.map((s, i) => {
                    const fromLabel =
                      s.fromIndex === undefined ? 'nominal' : `option ${s.fromIndex + 1}`;
                    const toLabel = `option ${s.toIndex + 1}`;
                    return (
                      <tr
                        key={`${s.nodeId}-${i}`}
                        className="border-b border-gray-100 dark:border-gray-800 last:border-b-0"
                      >
                        <td className="py-1 pr-2 text-gray-400 dark:text-gray-500 tabular-nums">
                          {i + 1}
                        </td>
                        <td className="py-1 pr-2 text-gray-700 dark:text-gray-200 truncate">
                          {nodeNameById.get(s.nodeId) ?? s.nodeId}
                        </td>
                        <td className="py-1 pr-2 text-right text-gray-500 dark:text-gray-400">
                          {fromLabel} → {toLabel}
                        </td>
                        <td className="py-1 pr-2 text-right text-gray-500 dark:text-gray-400 tabular-nums">
                          {formatMoney(s.perDay, project.currency)}
                        </td>
                        <td className="py-1 pl-2 text-right text-gray-700 dark:text-gray-200 tabular-nums">
                          +{formatMoney(s.addedCost, project.currency)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-100 dark:border-gray-800">
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="text-[12px] text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 px-3 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={handleAccept}
            disabled={running || plan === null || plan.steps.length === 0}
            className="text-[12px] font-medium bg-emerald-600 text-white px-3 py-1.5 rounded hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Accept and apply
          </button>
        </div>
      </div>
    </div>
  );
}
