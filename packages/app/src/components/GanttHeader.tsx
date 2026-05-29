import type { ProjectFile } from '@procsim/file-format';
import type { ScheduleResult } from '@procsim/scheduler';
import type { SimRun } from '../store/viewStore.js';
import { useViewStore } from '../store/viewStore.js';
import { formatMoneyDual, getEffectiveFxSnapshot, projectHasCostData } from '../utils/cost.js';

interface GanttHeaderProps {
  project: ProjectFile;
  result: ScheduleResult;
  /** Latest sim run, if any — drives the P80 KPI tile. */
  latestSim: SimRun | null;
  /** Search filter (substring match on row name). */
  search: string;
  setSearch: (v: string) => void;
  /** Whether dependency arrows are visible in the chart. */
  showDeps: boolean;
  setShowDeps: (v: boolean) => void;
  /** Whether the per-node P95 tail overlay is visible on the chart. */
  showP95: boolean;
  setShowP95: (v: boolean) => void;
  /** Phase 19 — whether the cumulative-cost S-curve overlay is visible. */
  showSCurve: boolean;
  setShowSCurve: (v: boolean) => void;
  /** Click handler for "Today" — scrolls the chart to the current date. */
  onJumpToday: () => void;
  /**
   * Phase 47 Slice 2 — click handler for "Fit". Computes a zoom level so
   * the full project fits in the visible chart viewport. GanttView owns
   * the scroll container + projectDays, so it computes the value and
   * pushes it via `setGanttZoom`.
   */
  onFitToView: () => void;
  /**
   * Phase 25 Slice 3 — click handler for the "Crash to deadline" button.
   * Absent on projects that have no crash options defined (button hidden).
   */
  onOpenCrash?: () => void;
}

/**
 * KPI strip + inline toolstrip above the Gantt chart.
 *
 * KPIs (left → right):
 *   - Project ends: result.projectEnd, formatted
 *   - Critical path: derived from result.criticalPaths (longest one)
 *   - P80 (Monte Carlo): pulled from latestSim if present; tile hidden otherwise
 *   - Health: derived from result.warnings.length
 *
 * Toolstrip (right side):
 *   - Search input — substring filter on activity / loop / group names
 *   - Today — scrolls chart to today's x-position
 *   - Deps toggle — show/hide dependency arrows
 *   - P95 toggle — overlay Monte Carlo P95 tail behind each bar (rendering stub)
 */
export function GanttHeader({
  project,
  result,
  latestSim,
  search,
  setSearch,
  showDeps,
  setShowDeps,
  showP95,
  setShowP95,
  showSCurve,
  setShowSCurve,
  onJumpToday,
  onFitToView,
  onOpenCrash,
}: GanttHeaderProps) {
  const projectEnd = result.projectEnd;
  const cpLengths = result.criticalPaths.map((p) => p.length);
  const longestCp = cpLengths.length > 0 ? Math.max(...cpLengths) : 0;
  const cpDurationDays = computeCriticalPathDays(result);

  const startDate = new Date(project.project.startDate + 'T00:00:00');
  const projectDays = Math.max(
    1,
    Math.ceil((projectEnd.getTime() - startDate.getTime()) / 86_400_000),
  );

  const p80 = latestSim?.result.percentiles.p80 ?? null;
  const p80DeltaDays =
    p80 !== null ? Math.round((p80.getTime() - projectEnd.getTime()) / 86_400_000) : null;

  // Phase 19 — Project cost KPI. Hidden when the project has no cost data
  // anywhere; same predicate gates the S-curve toggle below.
  const hasCost = projectHasCostData(project);
  const costP80 = latestSim?.result.costPercentiles.p80 ?? null;
  // Phase 19 slice 4 — currency conversion. The user picks a display target
  // in Settings; we resolve their pick + the project's pinned FX snapshot
  // here and pass amounts through `formatMoneyDual`. When the target is
  // AUTO (default) or the snapshot is null, formatMoneyDual collapses to
  // plain native rendering.
  const currencyDisplay = useViewStore((s) => s.currencyDisplay);
  const fxSnapshot = getEffectiveFxSnapshot(project);
  // Phase 33 Slice 2 follow-up — Gantt zoom controls (− / % / +).
  // Read directly from viewStore to keep GanttHeader self-contained
  // (no new prop-drilling from GanttView).
  const ganttZoom = useViewStore((s) => s.ganttZoom);
  const zoomGanttIn = useViewStore((s) => s.zoomGanttIn);
  const zoomGanttOut = useViewStore((s) => s.zoomGanttOut);
  const resetGanttZoom = useViewStore((s) => s.resetGanttZoom);
  const zoomPct = Math.round(ganttZoom * 100);

  const warningCount = result.warnings.length;
  const healthLabel =
    warningCount === 0 ? 'On track' : `${warningCount} warning${warningCount === 1 ? '' : 's'}`;
  const healthTone = warningCount === 0 ? 'g-kpi-ok' : 'g-kpi-warn';

  return (
    <div className="shrink-0 flex items-center gap-3.5 px-4 py-2.5 border-b border-gray-200 dark:border-gray-800 bg-gradient-to-b from-white to-emerald-50/40 dark:from-gray-900 dark:to-gray-900">
      {/* Project ends */}
      <Kpi
        label="Project ends"
        value={formatShortDate(projectEnd)}
        sub={`${projectDays} calendar days`}
      />
      <Sep />
      {/* Critical path */}
      <Kpi
        label="Critical path"
        value={`${cpDurationDays}d`}
        sub={`${longestCp} activit${longestCp === 1 ? 'y' : 'ies'} · 0d slack`}
        tone="g-kpi-critical"
      />
      <Sep />
      {/* Project cost (Phase 19). Hidden when no cost data anywhere. */}
      {hasCost && (
        <>
          <Kpi
            label="Project cost"
            value={formatMoneyDual(
              result.projectCost,
              project.currency,
              currencyDisplay,
              fxSnapshot,
            )}
            sub={
              costP80 !== null
                ? `P80 ${formatMoneyDual(costP80, project.currency, currencyDisplay, fxSnapshot)} (Monte Carlo)`
                : 'deterministic'
            }
          />
          <Sep />
        </>
      )}
      {/* P80 — only shown if a sim run exists */}
      {p80 !== null && p80DeltaDays !== null ? (
        <>
          <Kpi
            label="P80 (Monte Carlo)"
            value={formatShortDate(p80)}
            sub={
              p80DeltaDays === 0
                ? 'matches baseline'
                : `${p80DeltaDays >= 0 ? '+' : ''}${p80DeltaDays}d vs baseline`
            }
            tone="g-kpi-p80"
          />
          <Sep />
        </>
      ) : null}
      {/* Health */}
      <Kpi
        label="Health"
        value={healthLabel}
        sub={`${warningCount} risks flagged`}
        tone={healthTone}
      />

      <div className="flex-1" />

      {/* Toolstrip */}
      <div className="inline-flex items-center gap-2">
        {/* Search */}
        <label className="inline-flex items-center gap-1.5 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1 w-[220px]">
          <span className="text-gray-400 dark:text-gray-500 text-[13px]">⌕</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find activity, resource…"
            className="flex-1 bg-transparent outline-none text-[12px] text-gray-700 dark:text-gray-200 placeholder:text-gray-400 dark:placeholder:text-gray-500"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-700 text-[11px] max-md:text-xs"
              title="Clear"
            >
              ×
            </button>
          )}
        </label>

        {/* Phase 33 Slice 2 follow-up — Gantt zoom (discrete steps).
            Compact group: − / % / +. Click the % readout to reset to
            100%. Keyboard shortcuts ['/']/[0] are wired in GanttView. */}
        <div className="inline-flex items-center bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md overflow-hidden">
          <button
            type="button"
            onClick={zoomGanttOut}
            className="px-2 py-1 text-[11.5px] max-md:text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-40"
            title="Zoom out  ·  ["
            disabled={ganttZoom <= 0.025}
          >
            −
          </button>
          <button
            type="button"
            onClick={resetGanttZoom}
            className="px-2 py-1 text-[11.5px] max-md:text-xs font-mono text-gray-500 dark:text-gray-400 border-x border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors w-12 text-center"
            title="Reset zoom to 100%  ·  0"
          >
            {zoomPct}%
          </button>
          <button
            type="button"
            onClick={zoomGanttIn}
            className="px-2 py-1 text-[11.5px] max-md:text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-40"
            title="Zoom in  ·  ]"
            disabled={ganttZoom >= 3}
          >
            +
          </button>
        </div>

        {/* Phase 47 Slice 2 — Fit. Snaps the zoom so the full project
            duration fits in the visible chart viewport. Useful for
            multi-year projects where even 10% zoom doesn't get them
            in one screen. */}
        <button
          type="button"
          onClick={onFitToView}
          className="text-[11.5px] max-md:text-xs font-medium text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md px-3 py-1 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          title="Fit the whole project in view"
        >
          Fit
        </button>

        {/* Today */}
        <button
          type="button"
          onClick={onJumpToday}
          className="text-[11.5px] max-md:text-xs font-medium text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md px-3 py-1 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          title="Scroll to today"
        >
          Today
        </button>

        {/* Phase 25 Slice 3 — Crash to deadline. Hidden when the project
            has no crash options defined anywhere; GanttView decides. */}
        {onOpenCrash && (
          <button
            type="button"
            onClick={onOpenCrash}
            className="text-[11.5px] max-md:text-xs font-medium text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md px-3 py-1 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            title="Greedy: assign compression options to hit a deadline"
          >
            Compress to deadline
          </button>
        )}

        {/* Toggles */}
        <ToggleBtn
          on={showDeps}
          onClick={() => setShowDeps(!showDeps)}
          title="Show dependency arrows"
        >
          ↳ Deps
        </ToggleBtn>
        <ToggleBtn
          on={showP95}
          onClick={() => setShowP95(!showP95)}
          title={
            latestSim
              ? 'Overlay Monte Carlo P95 tail'
              : 'Run a simulation first to enable P95 overlay'
          }
          disabled={!latestSim}
        >
          P95
        </ToggleBtn>
        {/* Phase 19 — Cumulative cost S-curve overlay. Disabled until both
            cost data exists AND a Monte Carlo run has landed (the curve
            comes from `result.costCurve`). */}
        {hasCost && (
          <ToggleBtn
            on={showSCurve}
            onClick={() => setShowSCurve(!showSCurve)}
            title={
              latestSim
                ? 'Overlay cumulative-cost S-curve with P10–P95 band'
                : 'Run a simulation first to enable the S-curve overlay'
            }
            disabled={!latestSim}
          >
            S-curve
          </ToggleBtn>
        )}
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'g-kpi-critical' | 'g-kpi-p80' | 'g-kpi-ok' | 'g-kpi-warn' | undefined;
}) {
  const valueColor =
    tone === 'g-kpi-critical'
      ? 'text-red-700 dark:text-red-400'
      : tone === 'g-kpi-p80'
        ? 'text-amber-700 dark:text-amber-400'
        : tone === 'g-kpi-ok'
          ? 'text-emerald-700 dark:text-emerald-400'
          : tone === 'g-kpi-warn'
            ? 'text-amber-700 dark:text-amber-400'
            : 'text-gray-900 dark:text-gray-100';
  return (
    <div className="flex flex-col gap-px min-w-[110px]">
      <div className="text-[10px] max-md:text-xs font-semibold uppercase tracking-[0.05em] text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div className={`text-[16px] font-bold leading-tight tracking-tight ${valueColor}`}>
        {value}
      </div>
      <div className="text-[10.5px] max-md:text-xs text-gray-400 dark:text-gray-500 mt-0.5">
        {sub}
      </div>
    </div>
  );
}

function Sep() {
  return <div className="w-px h-9 bg-gray-200 dark:bg-gray-700" />;
}

function ToggleBtn({
  children,
  on,
  onClick,
  title,
  disabled,
}: {
  children: React.ReactNode;
  on: boolean;
  onClick: () => void;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        'text-[11.5px] max-md:text-xs font-medium px-3 py-1 rounded-md border transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
        on
          ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
          : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

// ── Date / schedule helpers ──────────────────────────────────────────────────

function formatShortDate(d: Date): string {
  // e.g. "Apr 24, 2026"
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Sum of duration along the longest critical path.
 * Approximated as (latestFinish - earliestStart) of the path's last & first nodes,
 * which equals the path length in calendar days for FS dependencies.
 */
function computeCriticalPathDays(result: ScheduleResult): number {
  if (result.criticalPaths.length === 0) return 0;
  const path = result.criticalPaths[0]!;
  const firstId = path[0];
  const lastId = path[path.length - 1];
  if (!firstId || !lastId) return 0;
  const first = result.nodes[firstId];
  const last = result.nodes[lastId];
  if (!first || !last) return 0;
  const ms = last.earliestFinish.getTime() - first.earliestStart.getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}
