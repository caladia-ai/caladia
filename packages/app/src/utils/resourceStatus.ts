/**
 * Phase 43 — palette card status helpers.
 *
 * Surfaces per-resource utilization on the floating palette so the user
 * can spot idle pools and over-allocation at a glance while authoring.
 *
 * Kept here (rather than as a scheduler field) because the status is a
 * UI-facing summary of the engine's `resourceTimeline` + each resource's
 * `capacity` — not a deterministic invariant the engine guarantees. If
 * a richer "resource pressure" telemetry surface emerges, this is the
 * place to grow it.
 */

import type { ResourceTimelineEntry } from '@procsim/scheduler';

export type ResourceStatus = 'idle' | 'active' | 'at-capacity' | 'over-capacity';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Per-resource peak concurrent count across the schedule, computed via a
 * day-bucketed sweep-line over the timeline. Day index is derived from the
 * raw Date's epoch (any monotonic discretisation works — only relative
 * ordering matters for the peak).
 *
 * Returns a map keyed by resourceId. Resources with no timeline entries
 * are absent from the map (the caller treats a missing key as 0).
 */
export function computeResourcePeaks(
  timeline: ReadonlyArray<ResourceTimelineEntry>,
): Record<string, number> {
  // Group events by resource to avoid a big single sort across all resources.
  const byResource: Map<string, [number, number][]> = new Map();
  for (const e of timeline) {
    const startDay = Math.floor(e.start.getTime() / MS_PER_DAY);
    const endDay = Math.floor(e.end.getTime() / MS_PER_DAY);
    let events = byResource.get(e.resourceId);
    if (!events) {
      events = [];
      byResource.set(e.resourceId, events);
    }
    events.push([startDay, e.count]);
    // end day is inclusive (matches `computeDailyUtilization` in
    // ResourcesPanel) so the closing event fires the day AFTER.
    events.push([endDay + 1, -e.count]);
  }
  const peaks: Record<string, number> = {};
  for (const [rid, events] of byResource) {
    events.sort((a, b) => a[0] - b[0]);
    let cur = 0;
    let peak = 0;
    for (const [, delta] of events) {
      cur += delta;
      if (cur > peak) peak = cur;
    }
    peaks[rid] = peak;
  }
  return peaks;
}

/**
 * Categorise a single resource into one of four UI states. The peak is
 * `null` when the schedule failed to compute — in that case the status
 * collapses to idle / active by raw assignment count so the palette stays
 * informative even without a working schedule.
 */
export function resolveResourceStatus({
  capacity,
  assignmentCount,
  peak,
}: {
  readonly capacity: number;
  readonly assignmentCount: number;
  readonly peak: number | null;
}): ResourceStatus {
  if (peak === null) {
    return assignmentCount === 0 ? 'idle' : 'active';
  }
  if (peak === 0 || assignmentCount === 0) return 'idle';
  if (peak > capacity) return 'over-capacity';
  if (peak === capacity) return 'at-capacity';
  return 'active';
}
