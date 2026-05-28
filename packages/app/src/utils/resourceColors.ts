/**
 * Phase 43 — auto-assigned colors for resources.
 *
 * Mirrors the alphabetical-position scheme used by `autoGroupColor` so the
 * same palette is shared across the app's "thing identity by color" axes.
 * Sharing GROUP_COLORS keeps the visual language consistent: a user who's
 * already trained on group colors reads resource dots the same way.
 *
 * Slice 1 uses this on the palette card's leading swatch. Slice 2 will
 * reuse the same util for the per-node assignment dots so a card and its
 * dropped dot share a color, giving an obvious through-line from "card I
 * dragged" to "dot that appeared on the node."
 */

import { GROUP_COLORS } from './groupColors.js';

/**
 * Collect every resource name in deterministic order. The resulting array
 * is the input to `autoResourceColor`; sorting alphabetically keeps the
 * assignment stable across renders as long as the resource set is fixed.
 */
export function computeAllResourceNames(resources: readonly { name: string }[]): string[] {
  const names = new Set<string>();
  for (const r of resources) {
    if (r.name) names.add(r.name);
  }
  return [...names].sort();
}

export function autoResourceColor(
  resourceName: string,
  allResourceNames: readonly string[],
): string {
  const idx = allResourceNames.indexOf(resourceName);
  return GROUP_COLORS[(idx >= 0 ? idx : 0) % GROUP_COLORS.length]!;
}
