/**
 * LoopGroupNode — a React Flow node that renders a coloured background
 * rectangle behind the loop's body nodes. It is non-draggable and non-
 * connectable; its size and position are driven by App.tsx from the body
 * nodes' bounding box.
 *
 * z-index is set to -1 on the node so it lives behind regular activity nodes.
 */
import type { NodeProps } from '@xyflow/react';
import { useDomainStore } from '../store/domainStore.js';

export interface LoopGroupNodeData extends Record<string, unknown> {
  loopId: string;
  iterationCount: number;
}

export function LoopGroupNode({ data, selected }: NodeProps) {
  const d = data as LoopGroupNodeData;

  // Read the loop's group label directly from the domain store so we don't
  // have to thread it through React Flow node data props.
  const loopGroup = useDomainStore((s) => s.project.loops.find((l) => l.id === d.loopId)?.group);
  // Phase 35 — same pattern for the description; drives the chip's hover tooltip.
  const loopDescription = useDomainStore(
    (s) => s.project.loops.find((l) => l.id === d.loopId)?.description,
  );

  return (
    <div
      className={[
        'relative w-full h-full rounded-xl border-2 pointer-events-none',
        selected
          ? 'border-violet-500 bg-violet-100/60 dark:bg-violet-900/30'
          : 'border-violet-300 dark:border-violet-700 bg-violet-50/60 dark:bg-violet-900/10',
      ].join(' ')}
      // Re-enable pointer events only on the label chip and the perimeter hit
      // strips below so the interior passes clicks through to body nodes.
      style={{ pointerEvents: 'none' }}
    >
      {/* Perimeter hit strips (N-18). The chip alone is unreachable when
          scrolled out of view; the four 16-px strips around the rectangle's
          edges make the whole border ring selectable. LOOP_PADDING is 28 px
          (App.tsx) so a 16-px strip stays clear of the body-node bounding
          box by ~12 px and never occludes body-node clicks. */}
      <div
        className="absolute top-0 left-0 right-0 h-4 cursor-pointer"
        style={{ pointerEvents: 'all' }}
      />
      <div
        className="absolute bottom-0 left-0 right-0 h-4 cursor-pointer"
        style={{ pointerEvents: 'all' }}
      />
      <div
        className="absolute top-4 bottom-4 left-0 w-4 cursor-pointer"
        style={{ pointerEvents: 'all' }}
      />
      <div
        className="absolute top-4 bottom-4 right-0 w-4 cursor-pointer"
        style={{ pointerEvents: 'all' }}
      />
      <div
        className={[
          'relative inline-flex items-center gap-1 px-2 py-0.5 m-2 rounded text-xs font-semibold select-none cursor-pointer',
          selected
            ? 'bg-violet-200 dark:bg-violet-800 text-violet-800 dark:text-violet-200'
            : 'bg-violet-100 dark:bg-violet-900/60 text-violet-700 dark:text-violet-300',
        ].join(' ')}
        style={{ pointerEvents: 'all' }}
        title={loopDescription || undefined}
      >
        <span>↻</span>
        <span>Loop</span>
        <span className="opacity-70">× {d.iterationCount}</span>
        {loopGroup && (
          <>
            <span className="opacity-40 mx-0.5">·</span>
            <span className="font-normal opacity-80">{loopGroup}</span>
          </>
        )}
      </div>
    </div>
  );
}
