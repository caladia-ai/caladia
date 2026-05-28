/**
 * Dagre-based auto-layout for the process canvas.
 *
 * Runs a left-to-right (LR) dagre layout on the full node/edge graph.
 * Intra-loop edges are excluded from the top-level layout pass so that dagre
 * does not try to rank individual body nodes — each loop body is then
 * sub-laid-out independently and re-centered on its dagre position.
 */

import dagre from '@dagrejs/dagre';
import type { ProjectNode, ProjectEdge, Loop } from '@procsim/file-format';

const DEFAULT_W = 160;
const DEFAULT_H = 60;
const RANK_SEP = 80; // horizontal gap between ranks
const NODE_SEP = 40; // vertical gap between nodes in the same rank
const LOOP_PAD = 28; // matches App.tsx LOOP_PADDING for proper loop overlay spacing

function nodeW(n: ProjectNode): number {
  return n.width ?? DEFAULT_W;
}
function nodeH(n: ProjectNode): number {
  return n.height ?? DEFAULT_H;
}

/**
 * Compute new positions for all nodes using a dagre LR layout.
 * Returns a map of nodeId → {x, y} (top-left corner, matching React Flow's
 * position convention).
 */
export function computeAutoLayout(
  nodes: ReadonlyArray<ProjectNode>,
  edges: ReadonlyArray<ProjectEdge>,
  loops: ReadonlyArray<Loop>,
): Record<string, { x: number; y: number }> {
  // ── 1. Build nodeId → loop membership ─────────────────────────────────────
  const nodeToLoopId = new Map<string, string>();
  for (const loop of loops) {
    for (const nid of loop.bodyNodeIds) {
      nodeToLoopId.set(nid, loop.id);
    }
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // ── 2. Top-level dagre pass ────────────────────────────────────────────────
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', ranksep: RANK_SEP, nodesep: NODE_SEP });

  for (const n of nodes) {
    g.setNode(n.id, { width: nodeW(n), height: nodeH(n) });
  }

  for (const e of edges) {
    // Skip intra-loop edges — dagre should not rank individual body nodes
    const fl = nodeToLoopId.get(e.from);
    const tl = nodeToLoopId.get(e.to);
    if (fl !== undefined && fl === tl) continue;
    g.setEdge(e.from, e.to);
  }

  dagre.layout(g);

  const positions: Record<string, { x: number; y: number }> = {};

  for (const n of nodes) {
    const dn = g.node(n.id);
    if (dn) {
      // dagre places the centre; React Flow wants the top-left corner
      positions[n.id] = {
        x: dn.x - nodeW(n) / 2,
        y: dn.y - nodeH(n) / 2,
      };
    }
  }

  // ── 3. Per-loop sub-layout ────────────────────────────────────────────────
  // Each loop's body nodes are laid out independently in LR order, then the
  // result is translated so the body cluster is centred on the centroid of
  // those nodes' top-level positions.
  for (const loop of loops) {
    const bodyIds = loop.bodyNodeIds.filter((id) => nodeMap.has(id) && positions[id] !== undefined);
    if (bodyIds.length <= 1) continue;

    // Centroid from the top-level pass
    const cx = bodyIds.reduce((s, id) => s + positions[id]!.x, 0) / bodyIds.length;
    const cy = bodyIds.reduce((s, id) => s + positions[id]!.y, 0) / bodyIds.length;

    // Sub-layout
    const sg = new dagre.graphlib.Graph();
    sg.setDefaultEdgeLabel(() => ({}));
    sg.setGraph({ rankdir: 'LR', ranksep: RANK_SEP / 2, nodesep: NODE_SEP / 2 });

    for (const id of bodyIds) {
      const n = nodeMap.get(id)!;
      sg.setNode(id, { width: nodeW(n), height: nodeH(n) });
    }

    const bodySet = new Set(bodyIds);
    for (const e of edges) {
      if (bodySet.has(e.from) && bodySet.has(e.to)) {
        sg.setEdge(e.from, e.to);
      }
    }

    dagre.layout(sg);

    const sub: Record<string, { x: number; y: number }> = {};
    for (const id of bodyIds) {
      const dn = sg.node(id);
      if (dn) {
        const n = nodeMap.get(id)!;
        sub[id] = { x: dn.x - nodeW(n) / 2, y: dn.y - nodeH(n) / 2 };
      }
    }

    // Re-centre sub-layout on the top-level centroid, then add LOOP_PAD offset
    // so nodes sit inside the rendered loop overlay boundary.
    const scx = bodyIds.reduce((s, id) => s + sub[id]!.x, 0) / bodyIds.length;
    const scy = bodyIds.reduce((s, id) => s + sub[id]!.y, 0) / bodyIds.length;
    const dx = cx - scx + LOOP_PAD;
    const dy = cy - scy + LOOP_PAD;

    for (const id of bodyIds) {
      positions[id] = { x: sub[id]!.x + dx, y: sub[id]!.y + dy };
    }
  }

  return positions;
}
