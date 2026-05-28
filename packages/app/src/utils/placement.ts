import type { ProjectNode } from '@procsim/file-format';
import { useDomainStore } from '../store/domainStore.js';

/**
 * Phase 45 Slice 5 — geometry + drop logic for placement mode.
 *
 * Extracted from PlacementOverlay so the click-place path (mouse) and
 * the Enter / same-shortcut confirm paths (keyboard, Slice 5b) all go
 * through the same code. Pure module — no React, no DOM — so it's
 * trivial to import from any caller and exercise from tests.
 *
 * Phase 49 Slice 4 — extended with handle-pos geometry + proximity
 * detection so PlacementOverlay can arm ghost edges to existing
 * nodes' source handles. Still pure.
 */

/** Activity / decision nominal flow-width (matches `min-w-36` in ActivityNode). */
export const GHOST_W = 144;
/** Activity / decision nominal flow-height. */
export const GHOST_H = 60;
/** Vertical offset between the cursor-anchor (left-edge midpoint) and the node's top-left. */
export const ANCHOR_OFFSET_Y = GHOST_H / 2;

/**
 * Phase 49 Slice 4 — fallback rendered size of an existing project node
 * when its width / height isn't pinned on the schema. Moved here from
 * `App.tsx` (where it was only used for loop-group bounds) so the
 * placement-mode geometry helpers compute right-handle world positions
 * consistently with the rest of the canvas.
 */
export const DEFAULT_NODE_W = 160;
export const DEFAULT_NODE_H = 60;

/**
 * Phase 49 Slice 4 — cursor-to-handle hit radius in flow coords.
 * React Flow's enlarged handle is 14 px (see `index.css`), plus grace
 * so the user doesn't have to be pixel-perfect.
 */
export const PICKUP_RADIUS = 24;

export type PlacementType = 'activity' | 'decision' | 'start' | 'end';

/**
 * Drop a node at `cursorFlow` (the left-edge midpoint of the preview)
 * via the appropriate domain action. The cursor anchors at the node's
 * left-edge midpoint, so the top-left of the dropped node sits at
 * `(cursor.x, cursor.y - GHOST_H/2)` — exactly where the user expects.
 *
 * Returns the new node's id on success, or `null` when the drop was
 * rejected (only `end` can refuse — the schema allows at most one End
 * node per project). Slice 5c — callers hand the returned id off to
 * `viewStore.startNaming(id)` to open the quick-name callout.
 */
export function placeNode(
  type: PlacementType,
  cursorFlow: { x: number; y: number },
): string | null {
  const domain = useDomainStore.getState();
  const pos = { x: cursorFlow.x, y: cursorFlow.y - ANCHOR_OFFSET_Y };
  switch (type) {
    case 'activity':
      return domain.addNode(pos);
    case 'decision':
      return domain.addDecisionNode(pos);
    case 'start':
      return domain.addStartNode(pos);
    case 'end': {
      const hasEnd = domain.project.nodes.some((n) => n.nodeType === 'end');
      if (hasEnd) return null;
      return domain.addEndNode(pos);
    }
  }
}

/**
 * Phase 49 Slice 4 — wire-on-place commit. Drops an activity / decision
 * node AND `sourceNodeIds.length` incoming FS edges in one undo step
 * (see `domainStore.addNodeWithIncomingEdges`). Cursor anchors at the
 * new node's target handle (left-edge midpoint), so the top-left
 * convention matches `placeNode` — the dropped node lands at
 * `(cursor.x, cursor.y - ANCHOR_OFFSET_Y)`.
 *
 * Start / End are out of scope for wire-on-place (their handle shape
 * doesn't fit the "right-source → new left-target" model); callers
 * route those through `placeNode` as before.
 */
export function placeNodeWithIncomingEdges(
  type: 'activity' | 'decision',
  cursorFlow: { x: number; y: number },
  sourceNodeIds: ReadonlyArray<string>,
): string {
  const domain = useDomainStore.getState();
  const pos = { x: cursorFlow.x, y: cursorFlow.y - ANCHOR_OFFSET_Y };
  return domain.addNodeWithIncomingEdges(type, pos, sourceNodeIds);
}

/**
 * Phase 49 Slice 4 — world-space position of the right-side source
 * handle on an existing project node, or `null` when the node has no
 * source (End nodes). Activity, decision, and start nodes all expose
 * `Position.Right` on their bounding rect's right-middle; this helper
 * computes that point from the node's stored position and optional
 * width / height (with `DEFAULT_NODE_*` fallbacks).
 */
export function sourceHandleWorldPos(node: ProjectNode): { x: number; y: number } | null {
  if (node.nodeType === 'end') return null;
  const w = node.width ?? DEFAULT_NODE_W;
  const h = node.height ?? DEFAULT_NODE_H;
  return { x: node.position.x + w, y: node.position.y + h / 2 };
}

/**
 * Phase 49 Slice 4 — closest source handle within `radius` of the
 * cursor, in flow coords. Returns `null` if no candidate is in range.
 * Linear scan; the candidate set is the caller's responsibility (e.g.
 * `App.tsx` filters to `visibleNodes` at the current drill level).
 *
 * Ties are broken by encounter order. The placement use-case doesn't
 * care which one wins since both would be within hit-radius of the
 * cursor at the moment of arming.
 */
export function closestSourceWithin(
  cursor: { x: number; y: number },
  nodes: ReadonlyArray<ProjectNode>,
  radius: number,
): { id: string; dist: number } | null {
  let best: { id: string; dist: number } | null = null;
  for (const n of nodes) {
    const pos = sourceHandleWorldPos(n);
    if (!pos) continue;
    const dx = pos.x - cursor.x;
    const dy = pos.y - cursor.y;
    const dist = Math.hypot(dx, dy);
    if (dist > radius) continue;
    if (best === null || dist < best.dist) {
      best = { id: n.id, dist };
    }
  }
  return best;
}
