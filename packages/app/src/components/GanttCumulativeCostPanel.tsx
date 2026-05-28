import type { ProjectFile } from '@procsim/file-format';
import type { SimulationResult } from '@procsim/simulation';
import { formatMoney } from '../utils/cost.js';
import { snapToNearest, useChartCursor } from '../utils/cursor.js';

interface Props {
  project: ProjectFile;
  curve: SimulationResult['costCurve'];
  /** Total chart width in pixels (DAY_WIDTH × totalDays). */
  timelineWidth: number;
  totalDays: number;
  /** Set of non-working day indices (Sat/Sun/holidays). */
  nonWorkingSet: ReadonlySet<number>;
  darkMode: boolean;
  /** Pixel-per-day constant from GanttView. */
  dayWidth: number;
  /** Panel total height. */
  panelHeight: number;
  /** Non-working-day fill, taken from GanttView's theme constants. */
  nonWorkingBodyFill: string;
  /**
   * Deterministic project-end timestamp. Used as the cost curve's right
   * cutoff: the curve ends where the last cost-bearing activity finishes
   * (= result.projectEnd), not at the chart's right edge.
   */
  projectStart: Date;
  projectEnd: Date;
}

/**
 * Phase 19 — Cumulative cost S-curve panel. Lives below the Gantt body and
 * shares its time x-axis (DAY_WIDTH × totalDays) so the curve aligns with
 * the bars. Toggled on / off by the toolstrip "S-curve" button in
 * GanttHeader.
 *
 * Slice 5 added the draggable cursor: click / drag anywhere on the panel
 * to place a vertical line that snaps to the nearest bucket. The HTML
 * tooltip shows the cursor's day-from-start plus P10 / P50 / P80 / P95
 * cumulative cost at that bucket. ESC clears the cursor (handled by the
 * shared cursor hook).
 *
 * Why snap-to-bucket instead of continuous: the underlying data is
 * 50-bucket aggregated, so any "continuous" position would just lie
 * about which bucket's value the user is reading. Snapping makes the
 * reading honest.
 */
export function GanttCumulativeCostPanel({
  project,
  curve,
  timelineWidth,
  totalDays,
  nonWorkingSet,
  darkMode,
  dayWidth,
  panelHeight,
  nonWorkingBodyFill,
  projectStart,
  projectEnd,
}: Props) {
  // Cutoff in hours-from-project-start. The curve ends here (= where the
  // last cost-bearing activity finishes). Beyond this, the chart's
  // trailing days are empty — no work happening, no cost accruing.
  const cutoffHours = (projectEnd.getTime() - projectStart.getTime()) / 3_600_000;
  const finalP95 = curve.p95[curve.p95.length - 1] ?? 0;
  const finalP10 = curve.p10[curve.p10.length - 1] ?? 0;
  const yScaleMax = Math.max(finalP95, finalP10, 1);
  // X axis: curve.times[] is in hours-since-project-start; convert to days
  // then multiply by dayWidth to align with the chart above.
  const xAt = (hours: number): number => (hours / 24) * dayWidth;
  const PAD_T = 16;
  const PAD_B = 14;
  const innerH = panelHeight - PAD_T - PAD_B;
  const yAt = (cost: number): number => PAD_T + innerH - (cost / yScaleMax) * innerH;

  const cursor = useChartCursor({
    // SVG renders at fixed pixel dimensions (no preserveAspectRatio), so
    // CSS pixels equal SVG units. `_svgWidth` is unused here but the
    // hook's contract passes it for stretched SVGs (see HistogramCard).
    clientXToData: (clientX) => {
      if (clientX < 0 || clientX > timelineWidth) return null;
      return (clientX / dayWidth) * 24;
    },
    snap: (hours) => snapToNearest(hours, curve.times),
  });
  // When the user has scrubbed the cursor we know its bucket index by
  // exact equality (snap returns one of curve.times[] values verbatim).
  // Cursor only snaps to the ORIGINAL curve.times[] — the right-edge
  // extension below is visual only, not a snappable bucket.
  const cursorBucket =
    cursor.cursorDataValue !== null ? curve.times.indexOf(cursor.cursorDataValue) : -1;

  // Phase 19 slice 5 follow-up — align the curve's horizontal extent
  // with the Gantt's deterministic schedule. The slice-2 engine anchors
  // costCurve.times[49] to the *median* MC projectEnd; the Gantt bars
  // are on the *deterministic* schedule. Two cases to handle:
  //
  //  - Median end is BEFORE deterministic end (the common case for
  //    Decisions with an expected delay). Extend the curve horizontally
  //    from the last bucket to the deterministic end — flat, since all
  //    iterations have completed by then.
  //  - Median end is AFTER deterministic end (rare, possible with
  //    heavily right-skewed duration distributions). Drop buckets past
  //    the cutoff and interpolate the final value back onto the cutoff
  //    so the curve ends exactly at the deterministic end.
  //
  // Either way the curve's right edge is at `cutoffHours`. Past that,
  // the chart's trailing days are empty — no bars, no curve.
  const origTimes = curve.times;
  const origLastTime = origTimes[origTimes.length - 1] ?? 0;
  let extTimes: readonly number[];
  let extendTail: (arr: readonly number[]) => readonly number[];
  if (cutoffHours > origLastTime + 0.001) {
    // Extend: append cutoffHours holding the last value.
    extTimes = [...origTimes, cutoffHours];
    extendTail = (arr) => [...arr, arr[arr.length - 1] ?? 0];
  } else if (cutoffHours < origLastTime - 0.001) {
    // Truncate: keep buckets whose time is ≤ cutoffHours, then add the
    // cutoff point with linearly-interpolated value between the last
    // included bucket and the first dropped bucket.
    let keep = 0;
    while (keep < origTimes.length && origTimes[keep]! <= cutoffHours) keep++;
    // `keep` points at the first dropped index (or origTimes.length).
    const keptTimes = origTimes.slice(0, keep);
    extTimes = [...keptTimes, cutoffHours];
    extendTail = (arr) => {
      const kept = arr.slice(0, keep);
      const lastKept = kept[kept.length - 1] ?? 0;
      const nextOrig = arr[keep];
      const lastKeptT = keptTimes[keptTimes.length - 1] ?? 0;
      const nextT = origTimes[keep];
      let interp = lastKept;
      if (nextOrig !== undefined && nextT !== undefined && nextT > lastKeptT) {
        const frac = (cutoffHours - lastKeptT) / (nextT - lastKeptT);
        interp = lastKept + (nextOrig - lastKept) * frac;
      }
      return [...kept, interp];
    };
  } else {
    // Curves end exactly at cutoff already.
    extTimes = origTimes;
    extendTail = (arr) => arr;
  }
  const extend = extendTail;

  function buildPath(values: readonly number[]): string {
    const vs = extend(values);
    const pts: string[] = [];
    for (let i = 0; i < vs.length; i++) {
      const x = xAt(extTimes[i] ?? 0);
      const y = yAt(vs[i] ?? 0);
      pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return pts.join(' ');
  }
  function buildBandPath(lo: readonly number[], hi: readonly number[]): string {
    if (lo.length === 0) return '';
    const extLo = extend(lo);
    const extHi = extend(hi);
    const top: string[] = [];
    for (let i = 0; i < extHi.length; i++) {
      const x = xAt(extTimes[i] ?? 0);
      const y = yAt(extHi[i] ?? 0);
      top.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
    }
    const bot: string[] = [];
    for (let i = extLo.length - 1; i >= 0; i--) {
      const x = xAt(extTimes[i] ?? 0);
      const y = yAt(extLo[i] ?? 0);
      bot.push(`L${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return `${top.join(' ')} ${bot.join(' ')} Z`;
  }

  const bandFill = darkMode ? 'rgba(245, 158, 11, 0.22)' : 'rgba(245, 158, 11, 0.28)';
  const lineStroke = darkMode ? '#fbbf24' : '#d97706';
  const axisStroke = darkMode ? '#374151' : '#e5e7eb';
  const cursorStroke = darkMode ? '#94a3b8' : '#475569';

  // Final-percentile callouts at the right edge of the curve. After the
  // extension above, the visual curve reaches the chart right edge; we
  // anchor the labels to that extended end (NOT the raw last bucket) so
  // they sit at the same x-coordinate as the curve's actual visual end.
  const finalP10v = curve.p10[curve.p10.length - 1] ?? 0;
  const finalP50v = curve.p50[curve.p50.length - 1] ?? 0;
  const finalP95v = curve.p95[curve.p95.length - 1] ?? 0;
  const lastX = xAt(extTimes[extTimes.length - 1] ?? 0);
  const labelX = Math.min(lastX + 8, timelineWidth - 4);
  const textAnchor = lastX + 80 < timelineWidth ? 'start' : 'end';

  // Cursor pixel position for the line + tooltip placement.
  const cursorX = cursor.cursorDataValue !== null ? xAt(cursor.cursorDataValue) : null;

  return (
    <div className="relative">
      <svg
        width={timelineWidth}
        height={panelHeight}
        className="block border-t border-gray-200 dark:border-gray-700 bg-amber-50/30 dark:bg-amber-900/5 cursor-crosshair select-none"
        {...cursor.pointerHandlers}
      >
        {/* Non-working day shading */}
        {Array.from({ length: totalDays }, (_, i) =>
          nonWorkingSet.has(i) ? (
            <rect
              key={i}
              x={i * dayWidth}
              y={0}
              width={dayWidth}
              height={panelHeight}
              fill={nonWorkingBodyFill}
              opacity={0.5}
            />
          ) : null,
        )}

        {/* Y gridlines at 25/50/75% */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            y1={PAD_T + innerH - f * innerH}
            x2={timelineWidth}
            y2={PAD_T + innerH - f * innerH}
            stroke={axisStroke}
            strokeWidth={0.5}
            strokeDasharray="3 3"
          />
        ))}

        {/* Baseline (y = 0 axis) */}
        <line
          x1={0}
          y1={PAD_T + innerH}
          x2={timelineWidth}
          y2={PAD_T + innerH}
          stroke={axisStroke}
          strokeWidth={1}
        />

        {/* P10–P95 band */}
        <path d={buildBandPath(curve.p10, curve.p95)} fill={bandFill} />

        {/* P50 main line */}
        <path d={buildPath(curve.p50)} fill="none" stroke={lineStroke} strokeWidth={1.75} />

        {/* Cursor line + drop dots at each percentile intersection. Drawn
            BEFORE the right-edge callouts so the labels remain readable. */}
        {cursorX !== null && cursorBucket >= 0 && (
          <g pointerEvents="none">
            <line
              x1={cursorX}
              y1={PAD_T - 6}
              x2={cursorX}
              y2={PAD_T + innerH}
              stroke={cursorStroke}
              strokeWidth={cursor.isDragging ? 1.5 : 1}
              strokeDasharray="4 3"
            />
            {/* Top handle so the cursor is visually graspable. */}
            <path
              d={`M${cursorX - 4},${PAD_T - 6} L${cursorX + 4},${PAD_T - 6} L${cursorX},${PAD_T - 1} Z`}
              fill={cursorStroke}
            />
            {[
              { v: curve.p10[cursorBucket] ?? 0, color: darkMode ? '#6ee7b7' : '#059669' },
              { v: curve.p50[cursorBucket] ?? 0, color: lineStroke },
              { v: curve.p95[cursorBucket] ?? 0, color: darkMode ? '#fca5a5' : '#dc2626' },
            ].map((p, i) => (
              <circle
                key={i}
                cx={cursorX}
                cy={yAt(p.v)}
                r={3}
                fill={p.color}
                stroke={cursorStroke}
                strokeWidth={0.5}
              />
            ))}
          </g>
        )}

        {/* Right-edge final callouts */}
        <g pointerEvents="none">
          {[
            {
              y: yAt(finalP10v),
              label: `P10  ${formatMoney(finalP10v, project.currency)}`,
              color: darkMode ? '#6ee7b7' : '#059669',
              emphasize: false,
            },
            {
              y: yAt(finalP50v),
              label: `P50  ${formatMoney(finalP50v, project.currency)}`,
              color: lineStroke,
              emphasize: true,
            },
            {
              y: yAt(finalP95v),
              label: `P95  ${formatMoney(finalP95v, project.currency)}`,
              color: darkMode ? '#fca5a5' : '#dc2626',
              emphasize: false,
            },
          ].map((c, i) => (
            <g key={i}>
              <line
                x1={lastX}
                y1={c.y}
                x2={labelX - 2}
                y2={c.y}
                stroke={c.color}
                strokeWidth={c.emphasize ? 1.2 : 0.8}
                opacity={0.7}
              />
              <text
                x={labelX}
                y={c.y + 3}
                fontSize={c.emphasize ? 11 : 10}
                fontWeight={c.emphasize ? 600 : 400}
                fill={c.color}
                fontFamily="monospace"
                textAnchor={textAnchor}
              >
                {c.label}
              </text>
            </g>
          ))}
        </g>
      </svg>

      {/* Cursor tooltip — HTML overlay, positioned absolutely over the SVG
          so the readout text doesn't get caught by SVG-text scaling. Flips
          to the cursor's LEFT when it's near the right edge so the tooltip
          stays on-canvas. */}
      {cursorX !== null &&
        cursorBucket >= 0 &&
        (() => {
          const flipLeft = cursorX > timelineWidth - 200;
          const p10v = curve.p10[cursorBucket] ?? 0;
          const p50v = curve.p50[cursorBucket] ?? 0;
          const p80v = curve.p80[cursorBucket] ?? 0;
          const p95v = curve.p95[cursorBucket] ?? 0;
          const hoursAtCursor = cursor.cursorDataValue ?? 0;
          const dayLabel = (hoursAtCursor / 24).toFixed(1);
          return (
            <div
              className="absolute pointer-events-none rounded border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-900 shadow-md px-2.5 py-1.5 text-[10.5px] font-mono leading-tight"
              style={{
                top: 6,
                left: flipLeft ? undefined : cursorX + 8,
                right: flipLeft ? timelineWidth - cursorX + 8 : undefined,
                minWidth: 160,
                zIndex: 2,
              }}
            >
              <div className="text-gray-500 dark:text-gray-400 mb-0.5">
                Day {dayLabel} · bucket {cursorBucket + 1}/{curve.times.length}
              </div>
              <div className="flex justify-between gap-2">
                <span style={{ color: darkMode ? '#6ee7b7' : '#059669' }}>P10</span>
                <span className="text-gray-700 dark:text-gray-200">
                  {formatMoney(p10v, project.currency)}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span style={{ color: lineStroke }} className="font-semibold">
                  P50
                </span>
                <span className="text-gray-700 dark:text-gray-200 font-semibold">
                  {formatMoney(p50v, project.currency)}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span style={{ color: darkMode ? '#fcd34d' : '#b45309' }}>P80</span>
                <span className="text-gray-700 dark:text-gray-200">
                  {formatMoney(p80v, project.currency)}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span style={{ color: darkMode ? '#fca5a5' : '#dc2626' }}>P95</span>
                <span className="text-gray-700 dark:text-gray-200">
                  {formatMoney(p95v, project.currency)}
                </span>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
