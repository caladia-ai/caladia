/**
 * Phase 43 Slice 1 — pure helpers for the resource-palette drop flow.
 *
 * The DOM-side handler lives in ActivityNode (it touches React Flow's drag
 * event and zustand state); the multi-select expansion is split out here so
 * it can be tested without rendering. Keep it free of zustand / DOM imports.
 */

export interface ExpandDropTargetsInput {
  /** Activity node id under the cursor at drop time. */
  readonly dropTargetId: string;
  /** Currently-selected node ids (all kinds — anchors, decisions, etc.). */
  readonly selectedNodeIds: ReadonlyArray<string>;
  /** All activity-node ids in the current project (anchors / decisions
   *  / subsystems / loop groups excluded). Used to filter the selection
   *  so non-activity selections are skipped silently. */
  readonly activityNodeIds: ReadonlySet<string>;
}

/**
 * Decide which nodes a palette drop should affect.
 *
 *   - Drop target ∉ selection (or selection is empty / size 1) →
 *     just the drop target.
 *   - Drop target ∈ selection AND selection has 2+ entries → the
 *     selection's activity nodes (drop target included). Non-activity
 *     selected nodes (anchors, decisions, subsystems, loop groups) are
 *     filtered out — pool assignment doesn't apply to them.
 *
 * The drop target is always present in the result so the caller can
 * still scroll the inspector to it in the all-already-assigned case.
 */
export function expandDropTargets({
  dropTargetId,
  selectedNodeIds,
  activityNodeIds,
}: ExpandDropTargetsInput): ReadonlyArray<string> {
  if (!activityNodeIds.has(dropTargetId)) {
    // The drop target isn't an activity. The drop event shouldn't have
    // fired (only ActivityNode wires the handlers), but the helper
    // stays defensive — return empty so the caller no-ops cleanly.
    return [];
  }
  const inSelection = selectedNodeIds.includes(dropTargetId);
  if (!inSelection || selectedNodeIds.length < 2) {
    return [dropTargetId];
  }
  // De-dupe + filter to activity nodes, preserving selection order with
  // the drop target ensured first so downstream code that cares about
  // "primary" target (e.g. inspector navigation) doesn't have to re-scan.
  const seen = new Set<string>([dropTargetId]);
  const result: string[] = [dropTargetId];
  for (const id of selectedNodeIds) {
    if (seen.has(id)) continue;
    if (!activityNodeIds.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}
