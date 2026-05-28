import { useMemo } from 'react';
import { Handle, NodeResizer, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import { useDomainStore } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import { autoGroupColor } from '../utils/groupColors.js';

// ── Node type definition ──────────────────────────────────────────────────────
//
// Start: zero-duration entry anchor. Visual = a right-pointing wedge
// (rectangle on the left, pointed on the right) so the "flow direction"
// is unambiguous. Filled green, white label inside. The flag can be
// resized horizontally to fit longer names — height is locked because
// a taller wedge would look stretched and visually drift from the
// other anchor types (End, also 56 px tall).

export interface StartData extends Record<string, unknown> {
  name: string;
  group: string | undefined;
}

export type StartNodeType = Node<StartData, 'start'>;

// ── Component ─────────────────────────────────────────────────────────────────

// Geometry. The flat-back portion is `rectWidth` wide (variable); the wedge
// tip extends `WEDGE_EXTENSION` to the right (fixed — keeps the arrow shape
// recognisable at any size). Total visual width = rectWidth + WEDGE_EXTENSION.
const HEIGHT_PX = 56;
const WEDGE_EXTENSION = 28;
const STROKE_PX = 2;
const DEFAULT_RECT_WIDTH = 80;
const MIN_RECT_WIDTH = 56;
const MIN_TOTAL_WIDTH = MIN_RECT_WIDTH + WEDGE_EXTENSION;
const DEFAULT_TOTAL_WIDTH = DEFAULT_RECT_WIDTH + WEDGE_EXTENSION;

export function StartNode({ id, data, selected }: NodeProps<StartNodeType>) {
  const showGroupColors = useViewStore((s) => s.showGroupColors);
  // Audit I-18 — group colors moved to project.groupColors.
  const groupColorOverrides = useDomainStore((s) => s.project.groupColors);
  const updateNodeSize = useDomainStore((s) => s.updateNodeSize);
  const setResizeDraft = useViewStore((s) => s.setResizeDraft);
  const clearResizeDraft = useViewStore((s) => s.clearResizeDraft);

  // Committed width from the store; the live drag width comes through the
  // resize-draft slot in viewStore so the flag re-renders smoothly while
  // dragging without writing through the undo-tracked domain store.
  const storedWidth = useDomainStore((s) => s.project.nodes.find((n) => n.id === id)?.width);
  const draftWidth = useViewStore((s) => s.resizeDraft[id]?.width);
  const totalWidth = Math.max(MIN_TOTAL_WIDTH, draftWidth ?? storedWidth ?? DEFAULT_TOTAL_WIDTH);
  const rectWidth = totalWidth - WEDGE_EXTENSION;

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

  // Pentagon points (px, top-left origin):
  //   (0,0) ─ (rectW,0) ─ (totalW, height/2) ─ (rectW, height) ─ (0, height) ─ close
  const points = [
    `0,0`,
    `${rectWidth},0`,
    `${totalWidth},${HEIGHT_PX / 2}`,
    `${rectWidth},${HEIGHT_PX}`,
    `0,${HEIGHT_PX}`,
  ].join(' ');

  // Tailwind doesn't reach SVG attributes; pick the literal hex pair here.
  const strokeColor = selected ? '#3b82f6' /* blue-500 */ : '#047857'; /* emerald-700 */
  const fillColor = selected ? '#34d399' /* emerald-400 */ : '#10b981'; /* emerald-500 */

  return (
    <div className="relative" style={{ width: totalWidth, height: HEIGHT_PX }}>
      {/* Resize handles — visible only when selected. Height is locked by
          setting min === max so the user can only drag horizontally. */}
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_TOTAL_WIDTH}
        minHeight={HEIGHT_PX}
        maxHeight={HEIGHT_PX}
        onResize={(_e, params) => setResizeDraft(id, { width: params.width, height: HEIGHT_PX })}
        onResizeEnd={(_e, params) => {
          updateNodeSize(id, params.width, HEIGHT_PX);
          clearResizeDraft(id);
        }}
      />
      <svg
        width={totalWidth}
        height={HEIGHT_PX}
        viewBox={`0 0 ${totalWidth} ${HEIGHT_PX}`}
        className="block"
        aria-label={data.name}
      >
        <title>{data.name}</title>
        <polygon
          points={points}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={STROKE_PX}
          strokeLinejoin="miter"
          // Inset by half the stroke so the outline isn't clipped at the SVG edge.
          transform={`translate(${STROKE_PX / 2}, ${STROKE_PX / 2}) scale(${(totalWidth - STROKE_PX) / totalWidth}, ${(HEIGHT_PX - STROKE_PX) / HEIGHT_PX})`}
        />
      </svg>
      {/* HTML label overlay — native text rendering gives us proper
          `text-overflow: ellipsis` when the name doesn't fit in the
          rectangular portion. The label is positioned over the rectangle
          only (left edge to `rectWidth`); the wedge stays clean. */}
      <div
        className="absolute inset-y-0 left-0 flex items-center justify-center px-2 text-white text-sm font-semibold pointer-events-none select-none"
        style={{ width: rectWidth }}
      >
        <span className="block truncate" title={data.name} style={{ maxWidth: '100%' }}>
          {data.name}
        </span>
      </div>
      {/* Group color stripe — 1px bar at the top of the bounding box, after
          the SVG in DOM order so it renders in front. pointer-events-none so
          React Flow drag/click still reaches the SVG shape beneath. */}
      {gColor && (
        <div
          className="absolute top-0 inset-x-0 h-1 pointer-events-none"
          style={{ backgroundColor: gColor }}
        />
      )}
      {/* No target handle — Start nodes are roots by definition.
          A source handle on the wedge tip lets the user wire downstream activities. */}
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-gray-400 dark:!bg-gray-500 hover:!bg-blue-400 dark:hover:!bg-blue-500 transition-colors"
      />
    </div>
  );
}
