/**
 * Shared group-color utilities.
 *
 * Colors are assigned by alphabetical position of the group name within the
 * current set of all group names — not by a hash — so different groups always
 * get visually distinct palette entries, and the assignment is stable across
 * renders as long as the group names don't change.
 */

export const GROUP_COLORS = [
  '#6366f1', // indigo
  '#ec4899', // pink
  '#f59e0b', // amber
  '#10b981', // emerald
  '#3b82f6', // blue
  '#ef4444', // red
  '#14b8a6', // teal
  '#f97316', // orange
  '#06b6d4', // cyan
  '#8b5cf6', // violet
] as const;

export type GroupColorPalette = typeof GROUP_COLORS;

/**
 * Collect every unique group name from nodes and loops, sorted alphabetically.
 * Call this once per render wherever you need stable color assignment.
 */
export function computeAllGroupNames(
  nodes: readonly { group?: string | undefined }[],
  loops: readonly { group?: string | undefined }[],
): string[] {
  const names = new Set<string>();
  for (const n of nodes) {
    if (n.group) names.add(n.group);
  }
  for (const l of loops) {
    if (l.group) names.add(l.group);
  }
  return [...names].sort();
}

/**
 * Return the auto-assigned color for a group name.
 * `allGroupNames` must be the sorted output of `computeAllGroupNames`.
 * Falls back to the first palette color if the name is not found.
 */
export function autoGroupColor(groupName: string, allGroupNames: readonly string[]): string {
  const idx = allGroupNames.indexOf(groupName);
  return GROUP_COLORS[(idx >= 0 ? idx : 0) % GROUP_COLORS.length]!;
}
