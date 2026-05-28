/**
 * Phase 49 Slice 5 — multi-node alignment helpers.
 *
 * Six pure functions, one per Simulink-style alignment operation
 * (Align Left / Center / Right collapse the horizontal axis; Align
 * Top / Middle / Bottom collapse the vertical axis). Each takes the
 * currently-selected nodes' geometry and returns a
 * `Record<id, { x, y }>` payload ready for the existing batch domain
 * action `updateNodePositions` — so the result of an alignment lands
 * as a single undo step.
 *
 * The input shape is a minimal `AlignableNode { id, position, width,
 * height }` where width / height are REQUIRED. The caller is
 * responsible for resolving the actual rendered size — pinned
 * `n.width / n.height` on the schema take precedence; otherwise
 * React Flow's `measured: { width, height }` (always populated for
 * any node currently rendered on the canvas) is the source of truth.
 *
 * This is the v1 → v2 fix: a previous version fell back to fixed
 * `DEFAULT_NODE_W / H` constants when the schema didn't pin a size.
 * That misaligned Start (108 × 56) and End (56 × 56) nodes against
 * Activity (≈ 144 × 64–80 depending on content) because the bbox
 * math was using the wrong dimensions. Pushing width / height
 * resolution out to the caller fixes it once and forever — the
 * helpers no longer guess.
 *
 * Only entries whose position would actually change are included in
 * the result. That means:
 *   - already-aligned input → empty record → SelectionToolbar can
 *     skip the domain commit entirely, so the no-op doesn't push a
 *     phantom undo step.
 *   - `nodes.length < 2` → empty record (the action is a no-op on a
 *     single node anyway, and the toolbar already gates the UI from
 *     offering it).
 *
 * Zero React / DOM — trivially unit-testable.
 */

export interface AlignableNode {
  id: string;
  position: { x: number; y: number };
  /** Real rendered width in flow coords (caller-resolved). */
  width: number;
  /** Real rendered height in flow coords (caller-resolved). */
  height: number;
}

export type PositionUpdates = Record<string, { x: number; y: number }>;

/** Build a position-updates record from a per-node "where it ought to be"
 *  function, omitting entries whose target position equals the current
 *  one — that's how the no-op detection works. */
function diffOnly(
  nodes: ReadonlyArray<AlignableNode>,
  newXY: (n: AlignableNode) => { x: number; y: number },
): PositionUpdates {
  const out: PositionUpdates = {};
  for (const n of nodes) {
    const next = newXY(n);
    if (next.x !== n.position.x || next.y !== n.position.y) {
      out[n.id] = next;
    }
  }
  return out;
}

// ── Horizontal alignment (collapses x; preserves each node's y) ──────────────

/** All selected nodes' LEFT edges move to the leftmost selected node's left edge. */
export function alignLeft(nodes: ReadonlyArray<AlignableNode>): PositionUpdates {
  if (nodes.length < 2) return {};
  const minLeft = Math.min(...nodes.map((n) => n.position.x));
  return diffOnly(nodes, (n) => ({ x: minLeft, y: n.position.y }));
}

/** All selected nodes' RIGHT edges move to the rightmost selected node's right edge. */
export function alignRight(nodes: ReadonlyArray<AlignableNode>): PositionUpdates {
  if (nodes.length < 2) return {};
  const maxRight = Math.max(...nodes.map((n) => n.position.x + n.width));
  return diffOnly(nodes, (n) => ({
    x: maxRight - n.width,
    y: n.position.y,
  }));
}

/** All selected nodes' HORIZONTAL CENTRES move to the bounding box's centre x. */
export function alignCenter(nodes: ReadonlyArray<AlignableNode>): PositionUpdates {
  if (nodes.length < 2) return {};
  const minLeft = Math.min(...nodes.map((n) => n.position.x));
  const maxRight = Math.max(...nodes.map((n) => n.position.x + n.width));
  const centerX = (minLeft + maxRight) / 2;
  return diffOnly(nodes, (n) => ({
    x: centerX - n.width / 2,
    y: n.position.y,
  }));
}

// ── Vertical alignment (collapses y; preserves each node's x) ────────────────

/** All selected nodes' TOP edges move to the topmost selected node's top edge. */
export function alignTop(nodes: ReadonlyArray<AlignableNode>): PositionUpdates {
  if (nodes.length < 2) return {};
  const minTop = Math.min(...nodes.map((n) => n.position.y));
  return diffOnly(nodes, (n) => ({ x: n.position.x, y: minTop }));
}

/** All selected nodes' BOTTOM edges move to the bottommost selected node's bottom edge. */
export function alignBottom(nodes: ReadonlyArray<AlignableNode>): PositionUpdates {
  if (nodes.length < 2) return {};
  const maxBottom = Math.max(...nodes.map((n) => n.position.y + n.height));
  return diffOnly(nodes, (n) => ({
    x: n.position.x,
    y: maxBottom - n.height,
  }));
}

/** All selected nodes' VERTICAL CENTRES move to the bounding box's centre y. */
export function alignMiddle(nodes: ReadonlyArray<AlignableNode>): PositionUpdates {
  if (nodes.length < 2) return {};
  const minTop = Math.min(...nodes.map((n) => n.position.y));
  const maxBottom = Math.max(...nodes.map((n) => n.position.y + n.height));
  const centerY = (minTop + maxBottom) / 2;
  return diffOnly(nodes, (n) => ({
    x: n.position.x,
    y: centerY - n.height / 2,
  }));
}

// ── Phase 49 Slice 8 — Distribute ────────────────────────────────────────────
//
// Convention: edge-to-edge equal gaps. The leftmost / rightmost (or
// topmost / bottommost) selected nodes stay put; intermediates space
// out so the gaps between adjacent nodes are equal. Matches the
// "even spacing" intuition users have when arranging icons or blocks
// in design tools (Figma "distribute spacing", Sketch "distribute
// horizontally", etc.).
//
// `nodes.length < 3` → empty record (no middle to distribute). Already
// evenly-spaced input → empty record (no-op via diffOnly).
//
// Algorithm (horizontal):
//   1. Sort by `position.x`.
//   2. Free space = (last.right − first.left) − Σ widths.
//   3. Per-gap = freeSpace / (N − 1).
//   4. Walk sorted left → right; each node i (i ≥ 1) lands at
//      `prev.right + per-gap`. The first node stays put; the last
//      one also stays put because the gap budget is computed
//      symmetrically.

/** Selected nodes get equal horizontal edge-to-edge gaps. Leftmost +
 *  rightmost stay in place. */
export function distributeHorizontally(nodes: ReadonlyArray<AlignableNode>): PositionUpdates {
  if (nodes.length < 3) return {};
  const sorted = [...nodes].sort((a, b) => a.position.x - b.position.x);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const span = last.position.x + last.width - first.position.x;
  const sumWidths = sorted.reduce((acc, n) => acc + n.width, 0);
  const gap = (span - sumWidths) / (sorted.length - 1);
  const out: PositionUpdates = {};
  let cursorX = first.position.x + first.width + gap;
  for (let i = 1; i < sorted.length - 1; i++) {
    const n = sorted[i]!;
    if (n.position.x !== cursorX) {
      out[n.id] = { x: cursorX, y: n.position.y };
    }
    cursorX += n.width + gap;
  }
  return out;
}

/** Selected nodes get equal vertical edge-to-edge gaps. Topmost +
 *  bottommost stay in place. */
export function distributeVertically(nodes: ReadonlyArray<AlignableNode>): PositionUpdates {
  if (nodes.length < 3) return {};
  const sorted = [...nodes].sort((a, b) => a.position.y - b.position.y);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const span = last.position.y + last.height - first.position.y;
  const sumHeights = sorted.reduce((acc, n) => acc + n.height, 0);
  const gap = (span - sumHeights) / (sorted.length - 1);
  const out: PositionUpdates = {};
  let cursorY = first.position.y + first.height + gap;
  for (let i = 1; i < sorted.length - 1; i++) {
    const n = sorted[i]!;
    if (n.position.y !== cursorY) {
      out[n.id] = { x: n.position.x, y: cursorY };
    }
    cursorY += n.height + gap;
  }
  return out;
}
