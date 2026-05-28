import { useMemo } from 'react';
import { currencyGlyph } from '@procsim/file-format';
import { useDomainStore } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import { useSchedule } from '../hooks/useSchedule.js';
import { autoResourceColor, computeAllResourceNames } from '../utils/resourceColors.js';
import {
  computeResourcePeaks,
  resolveResourceStatus,
  type ResourceStatus,
} from '../utils/resourceStatus.js';

/**
 * Phase 43 — drag-and-drop resource palette.
 *
 * Renders an absolutely-positioned strip of semi-transparent pool cards
 * along the top of the canvas surface when `viewStore.resourcePaletteOpen`
 * is true. The component must be a child of `<ReactFlow>` because its
 * positioning is relative to the canvas pane.
 *
 * The strip is `pointer-events-none` at the wrapper level so the empty
 * area beside / between cards stays interactive (canvas pan, marquee
 * select, etc.); only the cards themselves capture pointer events. That
 * way the floating overlay never blocks the canvas underneath — it sits
 * on top of the canvas visually but doesn't fight for clicks.
 *
 * Drag uses a custom MIME so unrelated browser drags (text selections,
 * file drops) don't trigger the drop handler on activity nodes.
 *
 * Card anatomy (Slice 3):
 *   - drag-handle hint (⋮⋮) telegraphs draggability before hover
 *   - leading color swatch — identity, matches Slice 2 per-node dot color
 *   - pool name
 *   - peak/capacity ratio badge — colored by status (active is neutral,
 *     at-cap amber, over-cap red); falls back to raw assignment count when
 *     the schedule fails to compute; hidden when the pool is unassigned
 *   - secondary line: `capacity X · $Y/h` (rate hidden when unset)
 *   - capacity meter bar at the bottom edge: emerald partial-fill when
 *     active (peak / capacity width), full amber at-cap, full red over-cap,
 *     empty gray idle / no-schedule. The bar is the single source of
 *     truth for "is this pool loaded?" — at a glance.
 *
 * The status surface is intentionally NOT another colored dot. The leading
 * identity swatch and a trailing status dot looked too similar (Slice 1+2
 * tried this and it confused at-a-glance reading); the bar + ratio combo
 * keeps the status signal visually distinct from the identity signal.
 */
export const RESOURCE_PALETTE_MIME = 'application/x-caladia-resource-id';

export function ResourcePalette() {
  const open = useViewStore((s) => s.resourcePaletteOpen);
  const setActiveTab = useViewStore((s) => s.setActiveTab);
  const project = useDomainStore((s) => s.project);
  const resources = project.resources;
  const nodes = project.nodes;
  const projectCurrency = project.currency;

  const allResourceNames = useMemo(() => computeAllResourceNames(resources), [resources]);

  // Assignment-coverage tallies, computed once per render. Used only for
  // the schedule-failed fallback now (peak/cap ratio is the primary
  // affordance); the node-side dots already surface coverage at a glance.
  const assignmentCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of nodes) {
      for (const a of n.resourceAssignments) {
        counts[a.resourceId] = (counts[a.resourceId] ?? 0) + 1;
      }
    }
    return counts;
  }, [nodes]);

  // Per-pool peak utilization, derived from the same schedule the canvas
  // already renders. `peaks` is null when the schedule failed to compute;
  // `resolveResourceStatus` degrades gracefully (drops at-cap / over-cap,
  // keeps idle / active).
  const scheduleOutcome = useSchedule();
  const peaks: Record<string, number> | null = useMemo(
    () =>
      scheduleOutcome.ok ? computeResourcePeaks(scheduleOutcome.result.resourceTimeline) : null,
    [scheduleOutcome],
  );

  if (!open) return null;

  return (
    <div
      data-testid="resource-palette"
      data-placement-passthrough
      // Phase 49 Slice 2 — the floating left toolbar (AppShell) lives
      // at `top-3 left-3` and is 60 px wide, so its right edge sits at
      // 72 px from the viewport's left. Start the palette at 84 px to
      // mirror the toolbar's 12 px gap from the canvas edge and avoid
      // hiding the leftmost resource card behind the toolbar.
      className="pointer-events-none absolute top-3 left-[84px] right-3 z-10"
    >
      <div className="pointer-events-auto inline-flex max-w-full gap-2 overflow-x-auto pb-1">
        {resources.length === 0 ? (
          <div className="rounded-md border border-gray-300/70 dark:border-gray-600/70 bg-white/70 dark:bg-gray-900/70 backdrop-blur-sm px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 shadow-sm inline-flex items-center gap-2">
            <span>No resources yet —</span>
            <button
              type="button"
              onClick={() => setActiveTab('resources')}
              className="font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:underline"
            >
              create one in the Resources tab →
            </button>
          </div>
        ) : (
          resources.map((r) => {
            const color = autoResourceColor(r.name, allResourceNames);
            const count = assignmentCounts[r.id] ?? 0;
            const rate = r.costRate ?? 0;
            const glyph = currencyGlyph(r.currencyOverride ?? projectCurrency);
            const peak = peaks ? (peaks[r.id] ?? 0) : null;
            const status = resolveResourceStatus({
              capacity: r.capacity,
              assignmentCount: count,
              peak,
            });
            return (
              <div
                key={r.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(RESOURCE_PALETTE_MIME, r.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                className="shrink-0 select-none cursor-grab active:cursor-grabbing overflow-hidden rounded-md border border-gray-300/70 dark:border-gray-600/70 bg-white/65 dark:bg-gray-900/55 backdrop-blur-sm shadow-[0_2px_6px_rgba(15,23,42,0.08)] hover:bg-white/85 dark:hover:bg-gray-900/80 hover:border-emerald-400 dark:hover:border-emerald-500 transition-colors"
                title={cardTooltip(r.capacity, status, peak)}
              >
                <div className="px-2.5 py-1.5">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="text-gray-300 dark:text-gray-600 text-xs leading-none tracking-[-0.15em] shrink-0"
                      title="Drag to assign"
                    >
                      ⋮⋮
                    </span>
                    <span
                      aria-hidden
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: color }}
                    />
                    <span className="text-xs font-medium text-gray-700 dark:text-gray-200 truncate max-w-[12rem]">
                      {r.name}
                    </span>
                    <UtilizationBadge
                      status={status}
                      peak={peak}
                      capacity={r.capacity}
                      assignmentCount={count}
                    />
                  </div>
                  <div className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400">
                    capacity {r.capacity}
                    {rate > 0 && (
                      <>
                        {' · '}
                        <span className="tabular-nums">
                          {glyph}
                          {rate}
                          /h
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <CapacityBar status={status} peak={peak} capacity={r.capacity} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

const STATUS_COPY: Record<ResourceStatus, string> = {
  idle: 'Idle — not assigned to any activity',
  active: 'Active — within capacity',
  'at-capacity': 'At capacity — no slack',
  'over-capacity': 'Over capacity — schedule conflict',
};

const RATIO_TEXT_CLASS: Record<ResourceStatus, string> = {
  idle: 'text-gray-600 dark:text-gray-300',
  active: 'text-gray-600 dark:text-gray-300',
  'at-capacity': 'text-amber-700 dark:text-amber-300',
  'over-capacity': 'text-red-700 dark:text-red-300',
};

const RATIO_BG_CLASS: Record<ResourceStatus, string> = {
  idle: 'bg-gray-200/70 dark:bg-gray-700/70',
  active: 'bg-gray-200/70 dark:bg-gray-700/70',
  'at-capacity': 'bg-amber-100/80 dark:bg-amber-900/40',
  'over-capacity': 'bg-red-100/80 dark:bg-red-900/40',
};

const BAR_FILL_CLASS: Record<ResourceStatus, string> = {
  idle: '',
  active: 'bg-emerald-500',
  'at-capacity': 'bg-amber-500',
  'over-capacity': 'bg-red-500',
};

function cardTooltip(capacity: number, status: ResourceStatus, peak: number | null): string {
  const detail = peak !== null ? ` (peak ${peak}/${capacity})` : '';
  return `${STATUS_COPY[status]}${detail} — drag to assign`;
}

/**
 * Compact badge shown in the card's name row. Carries the most-actionable
 * piece of state — peak vs. capacity — and colors itself by status so a
 * red badge catches the eye even before the user reads the numbers. Falls
 * back to the raw assignment count when the schedule can't be computed,
 * so the card stays informative without engine output.
 */
function UtilizationBadge({
  status,
  peak,
  capacity,
  assignmentCount,
}: {
  status: ResourceStatus;
  peak: number | null;
  capacity: number;
  assignmentCount: number;
}) {
  // Schedule failed but pool is assigned → show raw count as a fallback.
  if (peak === null) {
    if (assignmentCount === 0) return null;
    return (
      <span
        className="ml-1 shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-200/70 dark:bg-gray-700/70 text-gray-600 dark:text-gray-300 tabular-nums"
        title={`Assigned to ${assignmentCount} activit${assignmentCount === 1 ? 'y' : 'ies'} — schedule unavailable`}
      >
        {assignmentCount}
      </span>
    );
  }
  // Schedule OK + idle → no badge (matches the previous "hide count when
  // zero" behaviour; idle is implicit from the absence of the badge plus
  // the empty meter bar).
  if (peak === 0) return null;
  return (
    <span
      className={`ml-1 shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded tabular-nums ${RATIO_BG_CLASS[status]} ${RATIO_TEXT_CLASS[status]}`}
      title={`${STATUS_COPY[status]} — peak ${peak} of ${capacity} capacity`}
    >
      {peak}/{capacity}
    </span>
  );
}

/**
 * Thin meter bar at the bottom edge of the card. Width of the inner fill
 * represents `peak / capacity` clamped to [0, 1] — so a 2-of-3 pool shows
 * a ~67% emerald fill, a 3-of-3 pool shows 100% amber, a 5-of-3 pool
 * shows 100% red. The track itself is always rendered (consistent card
 * height) with a subtle gray background so the bar's presence is obvious
 * even when empty.
 */
function CapacityBar({
  status,
  peak,
  capacity,
}: {
  status: ResourceStatus;
  peak: number | null;
  capacity: number;
}) {
  const ratio =
    peak === null || peak === 0
      ? 0
      : status === 'at-capacity' || status === 'over-capacity'
        ? 1
        : Math.min(1, peak / Math.max(1, capacity));
  return (
    <div aria-hidden className="h-1 w-full bg-gray-200/60 dark:bg-gray-700/40">
      {ratio > 0 && (
        <div
          className={`h-full ${BAR_FILL_CLASS[status]} transition-[width] duration-200`}
          style={{ width: `${ratio * 100}%` }}
        />
      )}
    </div>
  );
}
