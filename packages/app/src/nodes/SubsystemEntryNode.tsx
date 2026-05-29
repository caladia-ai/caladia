import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';

// ── Node type definition ──────────────────────────────────────────────────────
//
// SubsystemEntry: structural port marking the input boundary of a subsystem.
// V7 schema invariant — every subsystem has exactly one of these and one
// SubsystemExit; they're auto-created by `wrapSelectedAsSubsystem` and the
// V6→V7 migration. Cannot be user-deleted (deleteNodes refuses with a toast
// naming the role). Zero-duration, no resources — pure structural anchor.
//
// Visual = small green right-pointing pentagon wedge with the label below
// the shape. Smaller than the project-level StartNode (project anchors are
// 56 px tall with the label inside; ports are 28 px wedges with the label
// underneath — signals "I'm a port, not a top-level anchor"). Color matches
// StartNode's emerald palette so the family resemblance is obvious.

export interface SubsystemEntryData extends Record<string, unknown> {
  name: string;
}

export type SubsystemEntryNodeType = Node<SubsystemEntryData, 'subsystemEntry'>;

// ── Component ─────────────────────────────────────────────────────────────────

// Geometry. Pentagon — flat back, pointed front. Matches StartNode's
// "rect + tip" shape but at a smaller scale so it reads as a port,
// not a top-level anchor.
const TOTAL_WIDTH = 44;
const HEIGHT = 28;
const TIP_OFFSET = 12; // pentagon's flat-back portion ends here; tip extends to TOTAL_WIDTH
const STROKE_PX = 2;

export function SubsystemEntryNode({ data, selected }: NodeProps<SubsystemEntryNodeType>) {
  const points = [
    `0,0`,
    `${TOTAL_WIDTH - TIP_OFFSET},0`,
    `${TOTAL_WIDTH},${HEIGHT / 2}`,
    `${TOTAL_WIDTH - TIP_OFFSET},${HEIGHT}`,
    `0,${HEIGHT}`,
  ].join(' ');

  // Tailwind doesn't reach SVG attributes; pick the literal hex pair here.
  // Same palette as StartNode for family resemblance.
  const strokeColor = selected ? '#3b82f6' /* blue-500 */ : '#047857'; /* emerald-700 */
  const fillColor = selected ? '#34d399' /* emerald-400 */ : '#10b981'; /* emerald-500 */

  return (
    <div className="relative" style={{ width: TOTAL_WIDTH }}>
      <svg
        width={TOTAL_WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${TOTAL_WIDTH} ${HEIGHT}`}
        className="block"
        aria-label={data.name || 'Entry port'}
      >
        <title>{data.name || 'Entry port'}</title>
        <polygon
          points={points}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={STROKE_PX}
          strokeLinejoin="miter"
          transform={`translate(${STROKE_PX / 2}, ${STROKE_PX / 2}) scale(${(TOTAL_WIDTH - STROKE_PX) / TOTAL_WIDTH}, ${(HEIGHT - STROKE_PX) / HEIGHT})`}
        />
      </svg>
      {/* Label sits below the wedge — distinguishes ports from full
          anchors (project Start has the name inside the wedge). */}
      <div
        className="mt-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400 text-center select-none pointer-events-none truncate"
        style={{ maxWidth: TOTAL_WIDTH + 32 }}
        title={data.name}
      >
        {data.name || 'Entry'}
      </div>
      {/* Source handle on the wedge tip — wires to the natural entry of the
          body via the internal bookend edge (created by wrap / migration).
          No target handle: structural Entry has no incoming edges in V7. */}
      <Handle
        type="source"
        position={Position.Right}
        className="bg-gray-400! dark:bg-gray-500! hover:bg-blue-400! dark:hover:bg-blue-500! transition-colors"
        style={{ top: HEIGHT / 2 }}
      />
    </div>
  );
}
