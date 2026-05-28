import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';

// ── Node type definition ──────────────────────────────────────────────────────
//
// SubsystemExit: structural port marking the output boundary of a subsystem.
// V7 schema invariant — every subsystem has exactly one of these and one
// SubsystemEntry; they're auto-created by `wrapSelectedAsSubsystem` and the
// V6→V7 migration. Cannot be user-deleted (deleteNodes refuses with a toast
// naming the role). Zero-duration, no resources — pure structural anchor.
//
// Visual = small red right-pointing pentagon wedge with the label below the
// shape. Same wedge shape as SubsystemEntryNode (flow direction stays
// left-to-right inside the subsystem); the rose-700 palette distinguishes
// the role, mirroring the project-level Start (green) / End (rose)
// convention.

export interface SubsystemExitData extends Record<string, unknown> {
  name: string;
}

export type SubsystemExitNodeType = Node<SubsystemExitData, 'subsystemExit'>;

// ── Component ─────────────────────────────────────────────────────────────────

const TOTAL_WIDTH = 44;
const HEIGHT = 28;
const TIP_OFFSET = 12;
const STROKE_PX = 2;

export function SubsystemExitNode({ data, selected }: NodeProps<SubsystemExitNodeType>) {
  const points = [
    `0,0`,
    `${TOTAL_WIDTH - TIP_OFFSET},0`,
    `${TOTAL_WIDTH},${HEIGHT / 2}`,
    `${TOTAL_WIDTH - TIP_OFFSET},${HEIGHT}`,
    `0,${HEIGHT}`,
  ].join(' ');

  // Rose / red palette mirrors the project End's color scheme.
  const strokeColor = selected ? '#3b82f6' /* blue-500 */ : '#9f1239'; /* rose-800 */
  const fillColor = selected ? '#fb7185' /* rose-400 */ : '#e11d48'; /* rose-600 */

  return (
    <div className="relative" style={{ width: TOTAL_WIDTH }}>
      <svg
        width={TOTAL_WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${TOTAL_WIDTH} ${HEIGHT}`}
        className="block"
        aria-label={data.name || 'Exit port'}
      >
        <title>{data.name || 'Exit port'}</title>
        <polygon
          points={points}
          fill={fillColor}
          stroke={strokeColor}
          strokeWidth={STROKE_PX}
          strokeLinejoin="miter"
          transform={`translate(${STROKE_PX / 2}, ${STROKE_PX / 2}) scale(${(TOTAL_WIDTH - STROKE_PX) / TOTAL_WIDTH}, ${(HEIGHT - STROKE_PX) / HEIGHT})`}
        />
      </svg>
      <div
        className="mt-0.5 text-[11px] font-medium text-rose-700 dark:text-rose-400 text-center select-none pointer-events-none truncate"
        style={{ maxWidth: TOTAL_WIDTH + 32 }}
        title={data.name}
      >
        {data.name || 'Exit'}
      </div>
      {/* Target handle on the left edge — receives the bookend edge from the
          natural exit of the body. No source handle: structural Exit has no
          outgoing edges in V7. */}
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-gray-400 dark:!bg-gray-500 hover:!bg-blue-400 dark:hover:!bg-blue-500 transition-colors"
        style={{ top: HEIGHT / 2 }}
      />
    </div>
  );
}
