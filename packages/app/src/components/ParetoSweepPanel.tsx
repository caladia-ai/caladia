import { useMemo, useState } from 'react';
import { paretoSweep } from '@procsim/scheduler';
import type { ParetoSweepPoint, ScheduleInput, ScheduleResult } from '@procsim/scheduler';
import type { ProjectFile } from '@procsim/file-format';
import { convertResourceCostsToProjectCurrency } from '@procsim/file-format';
import { formatMoney } from '../utils/cost.js';
import { CrashToDeadlineModal } from './CrashToDeadlineModal.js';

interface ParetoSweepPanelProps {
  project: ProjectFile;
  result: ScheduleResult;
}

/**
 * Phase 26 Slice 1 — Pareto sweep panel.
 *
 * Renders a scatterplot of the (added cost, project finish) trade-off
 * curve produced by sampling N deadlines uniformly between the
 * uncrashed finish and the deepest-crashed finish. Frontier points
 * (those not dominated by any other sample) are highlighted; dominated
 * points render in grey.
 *
 * Click a point → opens the existing `CrashToDeadlineModal` pre-populated
 * with that configuration's deadline and plan, so the user gets the
 * same Accept / Discard experience they're familiar with.
 *
 * **Slice-1 scope**: deterministic only. Sweep is fast enough on-thread
 * for typical projects (sub-second at N=15 for 100-activity projects).
 */
export function ParetoSweepPanel({ project, result }: ParetoSweepPanelProps) {
  const [samples, setSamples] = useState(15);
  const [selectedPoint, setSelectedPoint] = useState<ParetoSweepPoint | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const sweep = useMemo(() => {
    const input: ScheduleInput = {
      project: project.project,
      nodes: project.nodes,
      edges: project.edges,
      // Phase 33 Slice 2 — convert per-resource costs to project currency.
      resources: convertResourceCostsToProjectCurrency(project),
      calendars: project.calendars,
      loops: project.loops,
      subsystems: project.subsystems,
    };
    return paretoSweep(input, { samples });
  }, [project, samples]);

  const nodeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of project.nodes) m.set(n.id, n.name);
    return m;
  }, [project.nodes]);

  // ── Empty state ───────────────────────────────────────────────────────────
  if (sweep.points.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400 text-center px-8">
        No critical-path activity has compression options to sweep. Add compression options on the
        Inspector to see the cost / finish trade-off curve.
      </div>
    );
  }

  // ── Plot geometry ────────────────────────────────────────────────────────
  const VBOX_W = 800;
  const VBOX_H = 480;
  const PAD = { left: 80, right: 24, top: 24, bottom: 56 };
  const plotW = VBOX_W - PAD.left - PAD.right;
  const plotH = VBOX_H - PAD.top - PAD.bottom;

  const costs = sweep.points.map((p) => p.cost);
  const finishes = sweep.points.map((p) => p.finish.getTime());
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const minFin = Math.min(...finishes);
  const maxFin = Math.max(...finishes);
  // Defensive: avoid divide-by-zero when all points share a value.
  const costRange = Math.max(1, maxCost - minCost);
  const finRange = Math.max(1, maxFin - minFin);

  function xOf(cost: number): number {
    return PAD.left + ((cost - minCost) / costRange) * plotW;
  }
  function yOf(finishMs: number): number {
    // Earlier finish = higher on chart (less time = better).
    // Map low ms (early) → bottom (large y), high ms (late) → top? No —
    // typical chart convention: high y value rendered at TOP. Late finish
    // = "more time" = visually "higher up" feels natural. So invert:
    // high ms → small y (top), low ms → large y (bottom).
    // Wait — for diminishing-returns curve readability we want the
    // uncrashed (cheap + late) to be top-left, fully-crashed (expensive
    // + early) to be bottom-right. Late finish = top, early finish = bottom.
    return PAD.top + (1 - (finishMs - minFin) / finRange) * plotH;
  }

  // Sort frontier points for connecting line — by cost ascending.
  const frontierSorted = [...sweep.points]
    .filter((p) => p.onFrontier)
    .sort((a, b) => a.cost - b.cost);

  // ── Tick marks ───────────────────────────────────────────────────────────
  // 4 ticks on each axis, including both ends.
  const costTicks = [0, 0.33, 0.66, 1].map((t) => ({
    x: PAD.left + t * plotW,
    label: formatMoney(minCost + t * costRange, project.currency),
  }));
  const finishTicks = [0, 0.33, 0.66, 1].map((t) => ({
    y: PAD.top + (1 - t) * plotH,
    label: new Date(minFin + t * finRange).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    }),
  }));

  // ── Hovered point details ────────────────────────────────────────────────
  const hovered = hoverIndex !== null ? sweep.points[hoverIndex] : null;

  return (
    <div className="flex-1 flex flex-col overflow-auto bg-white dark:bg-gray-900 p-4 gap-3">
      {/* Header */}
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold text-gray-700 dark:text-gray-200">
            Cost / finish trade-off curve
          </h2>
          <p className="text-[10.5px] text-gray-400 dark:text-gray-500 mt-0.5">
            {samples} sample deadlines between the uncompressed and fully-compressed bounds · click
            a point to apply that configuration · frontier points highlighted (sweep is not a full
            Pareto solver — granularity = N).
          </p>
        </div>
        <label className="flex items-center gap-2 text-[12px] text-gray-700 dark:text-gray-200 shrink-0">
          <span>Samples</span>
          <input
            type="number"
            min={10}
            max={20}
            step={1}
            value={samples}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (isFinite(v)) setSamples(v);
            }}
            className="w-16 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-[12px]"
          />
        </label>
      </div>

      {/* Bounds summary */}
      <div className="grid grid-cols-2 gap-3 text-[12px]">
        <div className="rounded border border-gray-200 dark:border-gray-800 px-3 py-2">
          <div className="text-[10.5px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
            Uncompressed (no compressions applied)
          </div>
          <div className="mt-0.5 text-gray-700 dark:text-gray-200">
            Cost <span className="font-semibold">{formatMoney(0, project.currency)}</span> · finish{' '}
            <span className="font-semibold">
              {sweep.uncrashed.finish.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
            </span>
          </div>
        </div>
        <div className="rounded border border-gray-200 dark:border-gray-800 px-3 py-2">
          <div className="text-[10.5px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
            Fully compressed (greedy max)
          </div>
          <div className="mt-0.5 text-gray-700 dark:text-gray-200">
            Cost{' '}
            <span className="font-semibold">
              {formatMoney(sweep.fullyCrashed.cost, project.currency)}
            </span>{' '}
            · finish{' '}
            <span className="font-semibold">
              {sweep.fullyCrashed.finish.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
            </span>
          </div>
        </div>
      </div>

      {/* Scatterplot */}
      <div className="rounded border border-gray-200 dark:border-gray-800 bg-emerald-50/20 dark:bg-gray-950/40 p-2">
        <svg viewBox={`0 0 ${VBOX_W} ${VBOX_H}`} className="w-full h-auto">
          {/* Axes */}
          <line
            x1={PAD.left}
            y1={PAD.top}
            x2={PAD.left}
            y2={PAD.top + plotH}
            stroke="currentColor"
            strokeWidth={1}
            className="text-gray-300 dark:text-gray-700"
          />
          <line
            x1={PAD.left}
            y1={PAD.top + plotH}
            x2={PAD.left + plotW}
            y2={PAD.top + plotH}
            stroke="currentColor"
            strokeWidth={1}
            className="text-gray-300 dark:text-gray-700"
          />

          {/* Gridlines */}
          {costTicks.map((t, i) => (
            <line
              key={`gx-${i}`}
              x1={t.x}
              y1={PAD.top}
              x2={t.x}
              y2={PAD.top + plotH}
              stroke="currentColor"
              strokeWidth={0.5}
              strokeDasharray="2 4"
              className="text-gray-200 dark:text-gray-800"
            />
          ))}
          {finishTicks.map((t, i) => (
            <line
              key={`gy-${i}`}
              x1={PAD.left}
              y1={t.y}
              x2={PAD.left + plotW}
              y2={t.y}
              stroke="currentColor"
              strokeWidth={0.5}
              strokeDasharray="2 4"
              className="text-gray-200 dark:text-gray-800"
            />
          ))}

          {/* Axis labels */}
          {costTicks.map((t, i) => (
            <text
              key={`tx-${i}`}
              x={t.x}
              y={PAD.top + plotH + 18}
              textAnchor="middle"
              fontSize="11"
              className="fill-gray-500 dark:fill-gray-400 tabular-nums"
            >
              {t.label}
            </text>
          ))}
          {finishTicks.map((t, i) => (
            <text
              key={`ty-${i}`}
              x={PAD.left - 8}
              y={t.y + 4}
              textAnchor="end"
              fontSize="11"
              className="fill-gray-500 dark:fill-gray-400 tabular-nums"
            >
              {t.label}
            </text>
          ))}

          {/* Axis titles */}
          <text
            x={PAD.left + plotW / 2}
            y={VBOX_H - 14}
            textAnchor="middle"
            fontSize="12"
            fontWeight="500"
            className="fill-gray-600 dark:fill-gray-300"
          >
            Added cost
          </text>
          <text
            x={20}
            y={PAD.top + plotH / 2}
            textAnchor="middle"
            fontSize="12"
            fontWeight="500"
            transform={`rotate(-90 20 ${PAD.top + plotH / 2})`}
            className="fill-gray-600 dark:fill-gray-300"
          >
            Project finish
          </text>

          {/* Frontier line */}
          {frontierSorted.length >= 2 && (
            <polyline
              points={frontierSorted
                .map((p) => `${xOf(p.cost)},${yOf(p.finish.getTime())}`)
                .join(' ')}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              className="text-emerald-500 dark:text-emerald-400"
            />
          )}

          {/* Points */}
          {sweep.points.map((p, i) => {
            const cx = xOf(p.cost);
            const cy = yOf(p.finish.getTime());
            const r = hoverIndex === i ? 7 : 5;
            return (
              <circle
                key={i}
                cx={cx}
                cy={cy}
                r={r}
                onMouseEnter={() => setHoverIndex(i)}
                onMouseLeave={() => setHoverIndex(null)}
                onClick={() => setSelectedPoint(p)}
                className={[
                  'cursor-pointer transition-all',
                  p.onFrontier
                    ? 'fill-emerald-500 dark:fill-emerald-400 stroke-emerald-700 dark:stroke-emerald-200'
                    : 'fill-gray-300 dark:fill-gray-600 stroke-gray-500 dark:stroke-gray-400',
                ].join(' ')}
                strokeWidth={1}
              >
                <title>
                  {p.onFrontier ? '★ Frontier · ' : 'Dominated · '}
                  Cost {formatMoney(p.cost, project.currency)} · finish{' '}
                  {p.finish.toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}{' '}
                  · {p.plan.steps.length} compression step
                  {p.plan.steps.length === 1 ? '' : 's'}
                </title>
              </circle>
            );
          })}
        </svg>
      </div>

      {/* Hovered point details */}
      {hovered && (
        <div className="rounded border border-emerald-200 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-950/20 px-3 py-2 text-[12px]">
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-gray-700 dark:text-gray-200">
              {hovered.onFrontier ? '★ Frontier point' : 'Dominated point'} · cost{' '}
              <span className="font-semibold">{formatMoney(hovered.cost, project.currency)}</span> ·
              finish{' '}
              <span className="font-semibold">
                {hovered.finish.toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
            </div>
            <div className="text-gray-500 dark:text-gray-400 text-[10.5px]">
              {hovered.plan.steps.length} compression step
              {hovered.plan.steps.length === 1 ? '' : 's'} · click to apply
            </div>
          </div>
          {hovered.plan.steps.length > 0 && (
            <div className="mt-1 text-[10.5px] text-gray-500 dark:text-gray-400 truncate">
              Picks:{' '}
              {hovered.plan.steps
                .map((s) => `${nodeNameById.get(s.nodeId) ?? s.nodeId} → option ${s.toIndex + 1}`)
                .join('; ')}
            </div>
          )}
        </div>
      )}

      {/* Apply-this-configuration modal */}
      {selectedPoint && (
        <CrashToDeadlineModal
          project={project}
          result={result}
          initialPlan={selectedPoint.plan}
          initialDeadline={selectedPoint.deadline}
          onClose={() => setSelectedPoint(null)}
        />
      )}
    </div>
  );
}
