import { useEffect, useRef, useState } from 'react';
import type { ScheduleResult } from '@procsim/scheduler';
import type { ProjectNode } from '@procsim/file-format';

interface GanttMinimapProps {
  /** All non-anchor nodes that have a schedule entry. */
  nodes: ReadonlyArray<ProjectNode>;
  result: ScheduleResult;
  /** Project start date (used to derive bar x-positions). */
  projectStart: Date;
  /** Total days in the visible Gantt timeline. */
  totalDays: number;
  /**
   * Live ref to the chart's scrollable container. Drives the viewport
   * indicator (the indigo box that shows what's currently visible).
   */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Width per day in the main chart (px). */
  dayWidth: number;
  /** Width of the frozen left column in the main chart (px). */
  labelWidth: number;
}

/**
 * Compact bottom-of-Gantt scrubber showing every activity as a tiny bar
 * across the project timeline. The translucent indigo box overlays the
 * region currently visible in the chart; clicking elsewhere on the strip
 * jumps the chart's scroll position to that point.
 */
export function GanttMinimap({
  nodes,
  result,
  projectStart,
  totalDays,
  scrollRef,
  dayWidth,
  labelWidth,
}: GanttMinimapProps) {
  // ── Viewport indicator ────────────────────────────────────────────────────
  // We mirror scrollLeft / clientWidth from the main chart's container into
  // local state so the indigo viewport box re-renders smoothly as the user
  // scrolls. ResizeObserver covers chart-pane resizes; scroll covers panning.
  const [viewport, setViewport] = useState({ scrollLeft: 0, clientWidth: 0 });
  const trackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    function update() {
      if (!el) return;
      setViewport({
        scrollLeft: el.scrollLeft,
        clientWidth: el.clientWidth,
      });
    }
    update();

    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [scrollRef]);

  // The chart's visible window (after the frozen column) in chart-coord pixels.
  const visibleWindowStart = Math.max(0, viewport.scrollLeft);
  const visibleWindowWidth = Math.max(0, viewport.clientWidth - labelWidth);

  const VBOX_W = 600;
  const VBOX_H = 32;
  const TIMELINE_BAR_AREA_W = totalDays * dayWidth;
  const xToVbox = (chartX: number) =>
    TIMELINE_BAR_AREA_W > 0 ? (chartX / TIMELINE_BAR_AREA_W) * VBOX_W : 0;

  // Project bars onto the minimap (one per scheduled, non-anchor node).
  const bars = nodes
    .map((n) => {
      const sched = result.nodes[n.id];
      if (!sched) return null;
      const start = (sched.earliestStart.getTime() - projectStart.getTime()) / 86_400_000;
      const end = (sched.earliestFinish.getTime() - projectStart.getTime()) / 86_400_000;
      return {
        id: n.id,
        critical: sched.onCriticalPath,
        x: (start * dayWidth * VBOX_W) / TIMELINE_BAR_AREA_W,
        w: Math.max(0.6, ((end - start) * dayWidth * VBOX_W) / TIMELINE_BAR_AREA_W),
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);

  const indicatorX = xToVbox(visibleWindowStart);
  const indicatorW = Math.max(4, xToVbox(visibleWindowWidth));

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    const track = trackRef.current;
    const el = scrollRef.current;
    if (!track || !el) return;
    const rect = track.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const fraction = Math.max(0, Math.min(1, px / rect.width));
    // Center the chart around the clicked fraction of the timeline.
    const chartX = fraction * TIMELINE_BAR_AREA_W;
    el.scrollTo({
      left: Math.max(0, chartX - (el.clientWidth - labelWidth) / 2),
      behavior: 'smooth',
    });
  }

  return (
    <div className="shrink-0 h-[52px] flex items-center gap-3 px-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-500 dark:text-gray-400 shrink-0">
        Overview
      </div>
      <div
        ref={trackRef}
        onClick={handleClick}
        className="flex-1 cursor-pointer"
        title="Click to jump to a point in the timeline"
      >
        <svg
          width="100%"
          height={VBOX_H}
          preserveAspectRatio="none"
          viewBox={`0 0 ${VBOX_W} ${VBOX_H}`}
          className="block"
        >
          {/* Project bar substrate */}
          <rect
            x={0}
            y={VBOX_H / 2 - 1}
            width={VBOX_W}
            height={2}
            className="fill-gray-200 dark:fill-gray-700"
          />
          {/* Activity bars — staggered vertically so they don't all overlap */}
          {bars.map((b, i) => {
            const yOffset = (i % 5) * 4;
            const fill = b.critical ? '#ef4444' : '#3b82f6';
            return (
              <rect
                key={b.id}
                x={b.x}
                y={3 + yOffset}
                width={b.w}
                height={3}
                rx={1}
                fill={fill}
                opacity={0.7}
              />
            );
          })}
          {/* Viewport indicator */}
          <rect
            x={indicatorX}
            y={0}
            width={Math.min(indicatorW, VBOX_W - indicatorX)}
            height={VBOX_H}
            rx={3}
            className="fill-emerald-500/15 stroke-emerald-600"
            strokeWidth={1}
          />
        </svg>
      </div>
    </div>
  );
}
