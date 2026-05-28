import type { ScheduleInput } from './types.js';

/**
 * Pre-pass: replace each subsystem's container node with direct edges into /
 * out of its body's entry and exit nodes, then remove the container from the
 * node list.  The result is a flat `ScheduleInput` that the CPM engine can
 * schedule without any awareness of sub-system topology.
 *
 * Algorithm — post-order traversal of the subsystem nesting tree:
 *
 *  1. Sort subsystems deepest-first so inner sub-systems are processed before
 *     the outer ones that contain them.  (An outer sub-system's edges may
 *     currently point at an inner container node; once the inner sub-system is
 *     processed first those edges already target real body nodes.)
 *
 *  2. For each sub-system (inner before outer):
 *     a. Rewrite every edge where `edge.to === containerNodeId`
 *        → `edge.to = entryNodeId`.
 *     b. Rewrite every edge where `edge.from === containerNodeId`
 *        → `edge.from = exitNodeId`.
 *     c. Remove the container node from the nodes array.
 *
 * Body nodes (including `entryNodeId` and `exitNodeId`) are already present in
 * the flat nodes list — only the container proxy node is removed.
 *
 * Idempotent: calling this on input with no sub-systems returns the same
 * reference unchanged (fast-path guard).
 */
export function flattenSubsystems(input: ScheduleInput): ScheduleInput {
  const subsystems = input.subsystems;
  if (!subsystems || subsystems.length === 0) return input;

  // Build a map from nodeId → owning sub-system id (the one that lists the
  // node in its bodyNodeIds).  This is used to determine nesting depth:
  // sub-system A is nested inside B if A.containerNodeId ∈ B.bodyNodeIds.
  const bodyNodeToSubsystem = new Map<string, string>();
  for (const sub of subsystems) {
    for (const nid of sub.bodyNodeIds) {
      bodyNodeToSubsystem.set(nid, sub.id);
    }
  }

  const subsystemById = new Map(subsystems.map((s) => [s.id, s]));

  /** Recursively compute how many ancestor sub-systems wrap this one. */
  function nestingDepth(subId: string, visited: Set<string>): number {
    if (visited.has(subId)) return 0; // cycle guard — should not occur with valid data
    visited.add(subId);
    const sub = subsystemById.get(subId);
    if (!sub) return 0;
    const parentId = bodyNodeToSubsystem.get(sub.containerNodeId);
    if (parentId === undefined) return 0;
    return 1 + nestingDepth(parentId, visited);
  }

  // Sort deepest-first (post-order: inner before outer).
  const ordered = [...subsystems].sort(
    (a, b) => nestingDepth(b.id, new Set()) - nestingDepth(a.id, new Set()),
  );

  let nodes = [...input.nodes];
  let edges = [...input.edges];

  for (const sub of ordered) {
    // Redirect inbound edges to the entry node; outbound edges from exit node.
    edges = edges.map((e) => {
      const from = e.from === sub.containerNodeId ? sub.exitNodeId : e.from;
      const to = e.to === sub.containerNodeId ? sub.entryNodeId : e.to;
      // Avoid allocating a new object when neither endpoint changed.
      return from === e.from && to === e.to ? e : { ...e, from, to };
    });

    // Remove the container proxy — body nodes remain in the nodes array.
    nodes = nodes.filter((n) => n.id !== sub.containerNodeId);
  }

  return { ...input, nodes, edges };
}
