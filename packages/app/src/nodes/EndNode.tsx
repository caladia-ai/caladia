import { useMemo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import { useDomainStore } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import { autoGroupColor } from '../utils/groupColors.js';

// ── Node type definition ──────────────────────────────────────────────────────
//
// End: zero-duration completion anchor. Visual = double circle (BPMN
// end-event convention). No resizing — milestones are atomic.

export interface EndData extends Record<string, unknown> {
  name: string;
  group: string | undefined;
}

export type EndNodeType = Node<EndData, 'end'>;

// ── Component ─────────────────────────────────────────────────────────────────

const SIZE_PX = 56;
const INNER_INSET = 6;

export function EndNode({ data, selected }: NodeProps<EndNodeType>) {
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

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: SIZE_PX, height: SIZE_PX }}
    >
      <div
        className={[
          'absolute rounded-full border-2 transition-colors',
          selected
            ? 'border-blue-500 bg-rose-50 dark:bg-rose-950 shadow-md shadow-blue-100 dark:shadow-blue-900'
            : 'border-rose-700 bg-rose-50 dark:bg-rose-950 hover:border-rose-600',
        ].join(' ')}
        style={{
          width: SIZE_PX,
          height: SIZE_PX,
          // Group color indicator: outer ring glow when group highlighting is on.
          // box-shadow sits outside the border-radius so the circular shape is preserved.
          ...(gColor ? { boxShadow: `0 0 0 3px ${gColor}` } : {}),
        }}
        title={data.name}
        aria-label={data.name}
      />
      {/* Inner filled disc — the BPMN end event double-stroke convention. */}
      <div
        className="absolute rounded-full bg-rose-500"
        style={{
          width: SIZE_PX - INNER_INSET * 2,
          height: SIZE_PX - INNER_INSET * 2,
          top: INNER_INSET,
          left: INNER_INSET,
        }}
      />
      {/* No source handle — End nodes are leaves by definition. */}
      <Handle
        type="target"
        position={Position.Left}
        className="bg-gray-400! dark:bg-gray-500! hover:bg-blue-400! dark:hover:bg-blue-500! transition-colors"
      />
    </div>
  );
}
