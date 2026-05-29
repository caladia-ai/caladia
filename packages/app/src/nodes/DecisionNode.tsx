import { useMemo } from 'react';
import { Handle, Position, NodeResizer } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import { useDomainStore } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import { autoGroupColor } from '../utils/groupColors.js';
import { AssignmentDots } from '../components/AssignmentDots.js';

// ── Node type definition ──────────────────────────────────────────────────────
//
// Decision: activity-shaped (positive duration, resource assignments) but
// drawn as a diamond / rhombus to visually flag a review or gate. Carries
// `passProbability` (0..1, defaults to 1) and an optional `failureDelay`
// surcharge that is added to the effective duration with weight (1 - p)
// in the deterministic schedule, and realised as a Bernoulli draw per
// iteration in the Monte Carlo simulation.

export interface DecisionData extends Record<string, unknown> {
  name: string;
  durationValue: number;
  durationUnit: string;
  passProbability: number;
  failureDelayValue: number;
  failureDelayUnit: string;
  group: string | undefined;
  // Phase 24 — resource conflict marker. Decisions rarely have resource
  // assignments in practice, but keeping the field consistent across
  // node types means the App.tsx data-projection stays uniform.
  hasConflict?: boolean;
  // Phase 35 — drives the native hover tooltip on the node body.
  description?: string;
}

export type DecisionNodeType = Node<DecisionData, 'decision'>;

// ── Component ─────────────────────────────────────────────────────────────────
//
// The diamond is drawn as an SVG <polygon> in a viewBox of (0..100, 0..100)
// with `preserveAspectRatio="none"` so its four vertices land exactly at the
// midpoints of the React Flow node's bounding rectangle — regardless of the
// aspect ratio the user resizes it to. This is what makes the left/right
// React Flow handles (which sit at the bounding-rect midpoints) coincide with
// the rhombus's west and east vertices, even after a non-square resize.
//
// `vectorEffect="non-scaling-stroke"` keeps the border 2 px thick in screen
// space rather than being stretched non-uniformly with the box.
//
// SVG `fill`/`stroke` are attribute values, not CSS — Tailwind `dark:` cannot
// override them. We read `darkMode` from `viewStore` and pick hex literals
// (matching the ARCHITECTURE.md "SVG color tokens" pattern used by GanttView).
//
// The node *name* is rendered outside the bounding box, beneath the diamond,
// so it never collides with the diamond's diagonals or the centred body
// labels (duration + pass-percentage). The duration and pass-probability
// remain centred inside the diamond's body.

export function DecisionNode({ id, data, selected }: NodeProps<DecisionNodeType>) {
  const updateNodeSize = useDomainStore((s) => s.updateNodeSize);
  const darkMode = useViewStore((s) => s.darkMode);
  const showGroupColors = useViewStore((s) => s.showGroupColors);
  // Audit I-18 — group colors moved to project.groupColors.
  const groupColorOverrides = useDomainStore((s) => s.project.groupColors);

  const groupListKey = useDomainStore((s) => {
    const names = new Set<string>();
    for (const n of s.project.nodes) {
      if (n.group) names.add(n.group);
    }
    for (const l of s.project.loops) {
      if (l.group) names.add(l.group);
    }
    return [...names].sort().join('|');
  });
  const allGroupNames = useMemo(() => groupListKey.split('|').filter(Boolean), [groupListKey]);
  const gColor = useMemo(() => {
    if (!showGroupColors || !data.group) return null;
    return groupColorOverrides[data.group] ?? autoGroupColor(data.group, allGroupNames);
  }, [showGroupColors, data.group, groupColorOverrides, allGroupNames]);

  const passPct = Math.round((data.passProbability ?? 1) * 100);

  // SVG color tokens — matches the GanttView pattern (see ARCHITECTURE.md).
  const fill = selected
    ? darkMode
      ? '#1e3a8a' // blue-900-ish, tinted for selected
      : '#eff6ff' // blue-50
    : darkMode
      ? '#451a03' // amber-950 / very dark amber
      : '#fffbeb'; // amber-50
  const stroke = selected
    ? '#3b82f6' // blue-500
    : darkMode
      ? '#fbbf24' // amber-400
      : '#f59e0b'; // amber-500

  return (
    <div
      className="relative w-full h-full"
      style={{ minWidth: 120, minHeight: 120 }}
      title={data.description || undefined}
    >
      <NodeResizer
        minWidth={100}
        minHeight={100}
        isVisible={selected}
        // Diamond scales freely — vertices stay at midpoints regardless of
        // aspect ratio thanks to preserveAspectRatio="none" in the SVG below.
        onResizeEnd={(_e, params) => updateNodeSize(id, params.width, params.height)}
      />

      {/* Diamond body — vertices at exactly (50,0) (100,50) (50,100) (2,50)
          in the normalised viewBox; with preserveAspectRatio="none" these
          map to the bounding rect's midpoints (top, right, bottom, left).
          The 2-unit inset on each side keeps the stroke from clipping at
          the edge of the SVG canvas. */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden
      >
        <polygon
          points="50,2 98,50 50,98 2,50"
          fill={fill}
          stroke={stroke}
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          style={{ transition: 'fill 150ms, stroke 150ms' }}
        />
      </svg>

      {/* Group color stripe — same 1px bar at the top of the bounding box as
          ActivityNode. Rendered after the SVG so DOM stacking places it in
          front of the diamond; pointer-events-none so drag/click still reach
          the SVG polygon beneath. */}
      {gColor && (
        <div
          className="absolute top-0 inset-x-0 h-1 pointer-events-none"
          style={{ backgroundColor: gColor }}
        />
      )}

      {/* Phase 24 — resource conflict badge (same as ActivityNode). */}
      {data.hasConflict && (
        <span
          className="absolute top-1 right-1 text-[14px] leading-none pointer-events-none select-none"
          title="Resource conflict — see Inspector or Resources tab"
          aria-label="Resource conflict"
        >
          ⚠️
        </span>
      )}

      {/* Inside-the-diamond content: duration + pass-% badge.
          Centred via flex; pointer-events-none so the box itself remains
          the click/drag surface (we want React Flow to receive the events,
          not these labels). Width capped so long values don't escape the
          rhombus (the diamond is widest at its horizontal axis). */}
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none px-4">
        <div
          className={[
            'text-xs font-medium tabular-nums whitespace-nowrap',
            darkMode ? 'text-amber-200' : 'text-amber-900',
          ].join(' ')}
        >
          {data.durationValue} {data.durationUnit}
        </div>
        <div
          className={[
            'text-[10px] mt-0.5 whitespace-nowrap',
            darkMode ? 'text-amber-300' : 'text-amber-700',
          ].join(' ')}
        >
          pass {passPct}%
          {data.failureDelayValue > 0 && (
            <>
              {' '}
              · +{data.failureDelayValue}
              {unitShort(data.failureDelayUnit)}
            </>
          )}
        </div>
        {/* Phase 43 Slice 2 — per-pool assignment dots. Decisions can carry
            resource assignments too (e.g. "a senior approves"); when they
            do, surface the same dot row used on activities. The dot row
            self-gates on the palette being open and on assignments being
            present, so this wrapper collapses cleanly otherwise. Wrapped
            with `max-w-[80%]` so the dots stay inside the diamond's
            narrowing lower half. */}
        <div className="mt-1 max-w-[80%] empty:hidden">
          <AssignmentDots nodeId={id} />
        </div>
      </div>

      {/* Name rendered BELOW the bounding box. Absolute / centred / non-
          interactive so it doesn't fight React Flow drag handlers. The
          parent canvas has overflow visible, so labels that overhang the
          node's bounding box still draw correctly. */}
      <div
        className={[
          'absolute left-1/2 top-full -translate-x-1/2 pt-1 pointer-events-none',
          'text-sm font-medium text-center max-w-[200px] truncate',
          darkMode ? 'text-gray-100' : 'text-gray-800',
        ].join(' ')}
      >
        {data.name}
      </div>

      {/* Handles on the bounding rect's left/right midpoints — which, with
          the SVG geometry above, are exactly the diamond's west and east
          vertices. */}
      <Handle
        type="target"
        position={Position.Left}
        className="bg-gray-400! dark:bg-gray-500! hover:bg-blue-400! dark:hover:bg-blue-500! transition-colors"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="bg-gray-400! dark:bg-gray-500! hover:bg-blue-400! dark:hover:bg-blue-500! transition-colors"
      />
    </div>
  );
}

function unitShort(unit: string): string {
  if (unit === 'hours') return 'h';
  if (unit === 'days') return 'd';
  if (unit === 'weeks') return 'w';
  return unit;
}
