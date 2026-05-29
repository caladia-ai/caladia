import { useMemo, useState } from 'react';
import { Handle, Position, NodeResizer } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import { useDomainStore } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import { autoGroupColor } from '../utils/groupColors.js';
import { RESOURCE_PALETTE_MIME } from '../components/ResourcePalette.js';
import { AssignmentDots } from '../components/AssignmentDots.js';
import { expandDropTargets } from '../utils/resourcePaletteDrop.js';

// ── Node type definition ──────────────────────────────────────────────────────

// Index signature required by @xyflow/react's Node<T> constraint.
export interface ActivityData extends Record<string, unknown> {
  name: string;
  durationValue: number;
  durationUnit: string;
  color: string | undefined;
  group: string | undefined;
  // Phase 24 — `true` when this node's id appears in
  // ScheduleResult.conflictedNodeIds. Drives the small ⚠️ badge.
  hasConflict?: boolean;
  // Phase 35 — drives the native hover tooltip on the node body.
  description?: string;
}

export type ActivityNodeType = Node<ActivityData, 'activity'>;

// ── Component ─────────────────────────────────────────────────────────────────

export function ActivityNode({ id, data, selected }: NodeProps<ActivityNodeType>) {
  const updateNodeSize = useDomainStore((s) => s.updateNodeSize);
  const showGroupColors = useViewStore((s) => s.showGroupColors);
  // Audit I-18 — group colors moved from viewStore (transient) to
  // project.groupColors (persisted, undoable).
  const groupColors = useDomainStore((s) => s.project.groupColors);
  // Phase 43 Slice 1 — drag-over highlight when a pool card hovers this
  // node. Local component state (not viewStore) — it's purely visual feedback
  // tied to this node's drag-event lifecycle.
  const [dragHover, setDragHover] = useState(false);

  // Compute alphabetically sorted group list for consistent palette assignment.
  // The string-key trick avoids a new array reference on every render while
  // still invalidating only when groups actually change.
  const groupListKey = useDomainStore((s) => {
    const names = new Set<string>();
    for (const n of s.project.nodes) {
      if (n.group) names.add(n.group);
    }
    for (const l of s.project.loops) {
      if (l.group) names.add(l.group);
    }
    return [...names].sort().join('\u0000');
  });
  const allGroupNames = useMemo(() => groupListKey.split('\u0000').filter(Boolean), [groupListKey]);

  const gColor = useMemo(() => {
    if (!showGroupColors || !data.group) return null;
    return groupColors[data.group] ?? autoGroupColor(data.group, allGroupNames);
  }, [showGroupColors, data.group, groupColors, allGroupNames]);

  function handlePaletteDragOver(e: React.DragEvent<HTMLDivElement>) {
    // Only accept drags that carry our custom MIME — keeps unrelated
    // browser drags (text selections, files) from triggering visual or
    // mutation paths.
    if (!e.dataTransfer.types.includes(RESOURCE_PALETTE_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragHover) setDragHover(true);
  }

  function handlePaletteDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes(RESOURCE_PALETTE_MIME)) return;
    setDragHover(false);
  }

  function handlePaletteDrop(e: React.DragEvent<HTMLDivElement>) {
    const resourceId = e.dataTransfer.getData(RESOURCE_PALETTE_MIME);
    if (!resourceId) return;
    e.preventDefault();
    e.stopPropagation();
    setDragHover(false);

    // Read state imperatively so the closure doesn't go stale across
    // drag sessions. The domain action mutates state synchronously so a
    // subsequent getState() reads the post-mutation snapshot.
    const view = useViewStore.getState();
    const domain = useDomainStore.getState();
    const project = domain.project;

    const activityNodeIds = new Set(
      project.nodes.filter((n) => n.nodeType === 'activity').map((n) => n.id),
    );
    const targets = expandDropTargets({
      dropTargetId: id,
      selectedNodeIds: view.selection.nodeIds,
      activityNodeIds,
    });
    if (targets.length === 0) return;

    let appliedCount = 0;
    for (const targetId of targets) {
      const node = project.nodes.find((n) => n.id === targetId);
      if (!node) continue;
      if (node.resourceAssignments.some((a) => a.resourceId === resourceId)) {
        continue; // already assigned — skip silently; inspector nav handled below
      }
      domain.addResourceAssignment(targetId, {
        resourceId,
        count: 1,
        calendarPolicy: 'intersection',
      });
      appliedCount += 1;
    }

    // All targets already had this pool → treat as a navigation gesture:
    // focus the drop target in the inspector, expand Resources, scroll to
    // the matching row. When at least one target was mutated, stay silent
    // so the user isn't yanked into the inspector mid-bulk-assignment.
    if (appliedCount === 0) {
      view.selectNodes([id]);
      view.revealInspector();
      view.expandInspectorSection('resources');
      view.setInspectorScrollToAssignmentId(resourceId);
    }
  }

  return (
    <div
      onDragOver={handlePaletteDragOver}
      onDragLeave={handlePaletteDragLeave}
      onDrop={handlePaletteDrop}
      className={[
        'rounded-lg border-2 bg-white dark:bg-gray-800 px-4 py-3 shadow-sm min-w-36 text-center w-full h-full flex flex-col justify-center items-center overflow-hidden relative',
        selected
          ? 'border-blue-500 shadow-blue-100 dark:shadow-blue-900 shadow-md'
          : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500',
        dragHover
          ? 'ring-2 ring-emerald-400 dark:ring-emerald-500 ring-offset-1 dark:ring-offset-gray-900'
          : '',
      ].join(' ')}
      style={!selected && data.color ? { borderColor: data.color } : undefined}
      title={data.description || undefined}
    >
      <NodeResizer
        minWidth={120}
        minHeight={60}
        isVisible={selected}
        onResizeEnd={(_e, params) => updateNodeSize(id, params.width, params.height)}
      />
      <Handle
        type="target"
        position={Position.Left}
        className="bg-gray-400! dark:bg-gray-500! hover:bg-blue-400! dark:hover:bg-blue-500! transition-colors"
      />

      {/* Group color stripe — top accent bar */}
      {gColor && (
        <div className="absolute top-0 inset-x-0 h-1" style={{ backgroundColor: gColor }} />
      )}

      {/* Phase 24 — resource conflict badge. Hover the node body to see
          the Inspector banner for full details (resource names + day
          counts). Positioned top-right so it doesn't fight the group
          color stripe or the name/duration lines. */}
      {data.hasConflict && (
        <span
          className="absolute top-1 right-1 text-[14px] leading-none pointer-events-none select-none"
          title="Resource conflict — see Inspector or Resources tab"
          aria-label="Resource conflict"
        >
          ⚠️
        </span>
      )}

      <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate max-w-40 mt-0.5">
        {data.name}
      </div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
        {data.durationValue} {data.durationUnit}
      </div>

      {/* Phase 43 Slice 2 — per-pool assignment dots. Shared component
          self-gates on `resourcePaletteOpen` and on the node having any
          assignments. The mt-1.5 wrapper preserves the spacing when the
          dot row is rendered; an empty wrapper collapses to zero. */}
      <div className="mt-1.5 empty:hidden">
        <AssignmentDots nodeId={id} />
      </div>

      {/* Group label is shown on the LoopGroupNode chip (for loop body nodes)
          or in the Gantt chart header. Individual node badges are omitted to
          prevent overlap with the duration line and node size instability. */}

      <Handle
        type="source"
        position={Position.Right}
        className="bg-gray-400! dark:bg-gray-500! hover:bg-blue-400! dark:hover:bg-blue-500! transition-colors"
      />
    </div>
  );
}
