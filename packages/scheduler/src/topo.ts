import type { ProjectEdge } from '@procsim/file-format';

export type TopoResult = { ok: true; order: string[] } | { ok: false; cycle: string[] };

/**
 * Kahn's algorithm topological sort.
 * Returns the node IDs in dependency order, or the set of cycle-participating
 * nodes if a cycle is detected.
 */
export function topoSort(
  nodeIds: ReadonlyArray<string>,
  edges: ReadonlyArray<ProjectEdge>,
): TopoResult {
  const inDegree = new Map<string, number>();
  const successors = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    successors.set(id, []);
  }

  for (const edge of edges) {
    // Ignore edges whose endpoints aren't in the node set (validated upstream)
    if (!inDegree.has(edge.from) || !inDegree.has(edge.to)) continue;
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    successors.get(edge.from)!.push(edge.to);
  }

  // Phase 50 Slice 21 / audit I-7 — head-index pointer instead of
  // `queue.shift()`. `Array.prototype.shift` re-indexes every remaining
  // element (O(N)), and we call it N times during topo, making the
  // sort O(N²). With the 50k-node schema cap and a per-iteration topo
  // inside Monte Carlo, worst-case ~2.5×10⁹ ops per `schedule()`.
  // Walking with an index keeps it O(N+E).
  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  let head = 0;
  while (head < queue.length) {
    const node = queue[head++]!;
    order.push(node);
    for (const succ of successors.get(node) ?? []) {
      const newDeg = (inDegree.get(succ) ?? 0) - 1;
      inDegree.set(succ, newDeg);
      if (newDeg === 0) queue.push(succ);
    }
  }

  if (order.length === nodeIds.length) return { ok: true, order };

  // Nodes with remaining in-degree > 0 are part of the cycle
  const cycle = [...inDegree.entries()].filter(([, deg]) => deg > 0).map(([id]) => id);
  return { ok: false, cycle };
}
