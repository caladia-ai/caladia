import { useMemo } from 'react';
import { Handle, Position, NodeResizer } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import { useDomainStore } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import { autoGroupColor } from '../utils/groupColors.js';

// ── Node type definition ──────────────────────────────────────────────────────

export interface SubsystemData extends Record<string, unknown> {
  name: string;
  subsystemId: string;
  /** Phase 24 — inherited from any body node with a resource conflict. */
  hasConflict?: boolean;
  /** Phase 35 — drives the native hover tooltip on the node body. */
  description?: string;
}

export type SubsystemNodeType = Node<SubsystemData, 'subsystem'>;

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Visual representation of a sub-system container on the parent canvas.
 *
 * Appearance: rounded rect with a diagonal "chevron stripe" header accent
 * (repeating-linear-gradient) to visually distinguish it from a plain
 * activity node.  Includes a "→" drill-in button that pushes the sub-system
 * onto the breadcrumb trail.
 *
 * When group highlighting is on (showGroupColors) the diagonal stripe is
 * replaced by a multi-segment solid stripe — one equal-width band per group
 * found among the body nodes, coloured with the same palette as ActivityNode.
 * Hover any segment to see the group name; hover the whole stripe to see all
 * groups as a "A · B · C" tooltip.
 */
export function SubsystemNode({ id, data, selected }: NodeProps<SubsystemNodeType>) {
  const updateNodeSize = useDomainStore((s) => s.updateNodeSize);
  const drillIntoSubsystem = useViewStore((s) => s.drillIntoSubsystem);
  const setResizeDraft = useViewStore((s) => s.setResizeDraft);
  const clearResizeDraft = useViewStore((s) => s.clearResizeDraft);
  const darkMode = useViewStore((s) => s.darkMode);
  const showGroupColors = useViewStore((s) => s.showGroupColors);
  // Audit I-18 — group colors moved to project.groupColors.
  const groupColorOverrides = useDomainStore((s) => s.project.groupColors);

  // Sorted list of all group names across the project — same stable null-byte
  // key pattern as ActivityNode so palette assignments stay consistent.
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

  // Collect groups of body nodes inside this subsystem as a stable string key.
  // Sorted alphabetically so segment order is deterministic across renders.
  const bodyGroupKey = useDomainStore((s) => {
    const sub = s.project.subsystems.find((ss) => ss.id === data.subsystemId);
    if (!sub) return '';
    const bodyNodeIds = new Set(sub.bodyNodeIds);
    const groups = new Set<string>();
    for (const n of s.project.nodes) {
      if (bodyNodeIds.has(n.id) && n.group) groups.add(n.group);
    }
    return [...groups].sort().join('|');
  });
  const bodyGroups = useMemo(() => bodyGroupKey.split('|').filter(Boolean), [bodyGroupKey]);

  // Resolved hex color per group segment (empty when highlighting is off).
  const segmentColors = useMemo(() => {
    if (!showGroupColors || bodyGroups.length === 0) return [];
    return bodyGroups.map((g) => groupColorOverrides[g] ?? autoGroupColor(g, allGroupNames));
  }, [showGroupColors, bodyGroups, groupColorOverrides, allGroupNames]);

  const stripeColor = darkMode ? 'rgba(99,102,241,0.35)' : 'rgba(99,102,241,0.15)';
  const stripePattern = `repeating-linear-gradient(
    -45deg,
    ${stripeColor},
    ${stripeColor} 4px,
    transparent 4px,
    transparent 12px
  )`;

  return (
    <div
      className={[
        'rounded-lg border-2 bg-white dark:bg-gray-800 shadow-sm min-w-40 text-center w-full h-full flex flex-col justify-center items-center overflow-hidden relative',
        selected
          ? 'border-indigo-500 shadow-indigo-100 dark:shadow-indigo-900 shadow-md'
          : 'border-indigo-300 dark:border-indigo-600 hover:border-indigo-400 dark:hover:border-indigo-500',
      ].join(' ')}
      title={data.description || undefined}
    >
      <NodeResizer
        minWidth={140}
        minHeight={64}
        isVisible={selected}
        handleStyle={{ width: 14, height: 14, borderRadius: 3 }}
        onResize={(_e, params) =>
          setResizeDraft(id, { width: params.width, height: params.height })
        }
        onResizeEnd={(_e, params) => {
          updateNodeSize(id, params.width, params.height);
          clearResizeDraft(id);
        }}
      />
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-indigo-400 dark:!bg-indigo-500 hover:!bg-indigo-500 transition-colors"
      />

      {/* Header accent — multi-color group stripe when group highlighting is on
          and body nodes carry groups; diagonal indigo pattern otherwise. */}
      {segmentColors.length > 0 ? (
        <div
          className="absolute top-0 inset-x-0 h-5 rounded-t-md flex overflow-hidden"
          title={bodyGroups.join(' · ')}
        >
          {segmentColors.map((color, i) => (
            <div
              key={i}
              className="flex-1 h-full"
              style={{ backgroundColor: color }}
              title={bodyGroups[i] ?? ''}
            />
          ))}
        </div>
      ) : (
        <div
          className="absolute top-0 inset-x-0 h-5 rounded-t-md"
          style={{ background: stripePattern }}
        />
      )}

      {/* Phase 24 — resource conflict badge inherited from body nodes.
          Positioned below the header stripe (h-5) so it doesn't fight
          the group-color segments. */}
      {data.hasConflict && (
        <span
          className="absolute top-6 right-1.5 text-[14px] leading-none pointer-events-none select-none"
          title="Body node has a resource conflict — drill in to investigate"
          aria-label="Resource conflict"
        >
          ⚠️
        </span>
      )}

      {/* Content */}
      <div className="flex flex-col items-center gap-1 px-3 pt-4 pb-2">
        {/* Sub-system icon + name */}
        <div className="flex items-center gap-1">
          <svg
            className="w-3 h-3 text-indigo-500 dark:text-indigo-400 flex-shrink-0"
            fill="none"
            viewBox="0 0 16 16"
            aria-hidden
          >
            <rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
            <rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
            <rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
            <rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <span className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate max-w-36">
            {data.name}
          </span>
        </div>

        {/* Drill-in button */}
        <button
          className="text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-200 flex items-center gap-0.5 mt-0.5 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            drillIntoSubsystem(data.subsystemId, data.name);
          }}
          title="Drill into sub-system"
          // Prevent React Flow from treating this click as a node selection toggle.
          onPointerDown={(e) => e.stopPropagation()}
        >
          Drill in
          <svg className="w-3 h-3" fill="none" viewBox="0 0 16 16" aria-hidden>
            <path
              d="M3 8h10M9 4l4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!bg-indigo-400 dark:!bg-indigo-500 hover:!bg-indigo-500 transition-colors"
      />
    </div>
  );
}
