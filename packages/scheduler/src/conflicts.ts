/**
 * Phase 24 — derive `conflictedNodeIds` from the resource timeline.
 *
 * A node is "involved in a conflict" if at least one of its
 * `resourceAssignments` competes with another node for an over-capacity
 * day on the same resource. Both competing nodes are marked; picking a
 * "culprit" is arbitrary and the user owns the resolution choice
 * (Auto-level or manual edge insertion).
 *
 * Subsystem containers inherit the union of their body nodes' conflict
 * reasons. The flatten pre-pass strips containers from the working
 * node set, but they remain in the project file and the UI renders
 * them — so the engine restores their conflict status here so Canvas
 * / Gantt / Inspector consumers see one consistent map.
 *
 * The day-bucketing approach matches `ResourcesPanel.tsx`'s
 * `computeDailyUtilization` byte-for-byte: floor `(ms - projectStart) /
 * 86_400_000` for both endpoints, accumulate `entry.count` into each
 * day in [from, to]. Keeping the two in lockstep avoids the "Resources
 * tab says over-capacity but Inspector doesn't" failure mode.
 *
 * Deterministic for fixed inputs: the timeline order, day bucketing,
 * and per-day aggregation are all fully ordered operations.
 */

import type { ProjectFile, Resource, Subsystem } from '@procsim/file-format';
import type { ConflictReason, ResourceTimelineEntry } from './types.js';

const MS_PER_DAY = 86_400_000;

/**
 * Calendar-day offset from project start. DST-safe: collapses the
 * input to its local-midnight ms first, then divides by MS_PER_DAY
 * and rounds. The `Math.round` absorbs the ±1h shift on DST boundary
 * days (a local day is 23h or 25h in UTC ms around spring-forward /
 * fall-back); the previous `Math.floor((date.getTime() -
 * projectStartMs) / 86_400_000)` mis-bucketed events in the first
 * hour after midnight of any day following a spring-forward Sunday
 * (audit row I-2). Mirrors `prepared.ts`'s `dayOf` pattern.
 */
function dayIdx(date: Date, projectStartMs: number): number {
  const localMidnightMs = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((localMidnightMs - projectStartMs) / MS_PER_DAY);
}

/**
 * Build `conflictedNodeIds` from a resource timeline + the resource
 * roster + subsystem topology. The function does NOT depend on any
 * scheduling-pass internals beyond what's already public in
 * `ScheduleResult.resourceTimeline`, so it could conceivably move
 * app-side; it lives here so the engine remains the single source of
 * truth and the UI never re-derives.
 */
export function computeConflictedNodes(
  timeline: ReadonlyArray<ResourceTimelineEntry>,
  resources: ReadonlyArray<Resource>,
  projectStartDate: ProjectFile['project']['startDate'],
  subsystems: ReadonlyArray<Subsystem>,
): Record<string, ConflictReason[]> {
  if (timeline.length === 0) return {};

  const projectStartMs = new Date(projectStartDate + 'T00:00:00').getTime();
  const resourceMap = new Map(resources.map((r) => [r.id, r]));

  // 1. Bucket per (resource, day) → total count.
  //    Also remember which (resource, day) pairs each node touched, so
  //    later we can credit a node only for the overlapping days it was
  //    actually on the timeline for.
  const dailyAllocation = new Map<string, Map<number, number>>(); // resourceId → day → count
  const nodeTouches = new Map<string, Map<string, Set<number>>>(); // nodeId → resourceId → set<day>

  for (const entry of timeline) {
    const from = dayIdx(entry.start, projectStartMs);
    const to = dayIdx(entry.end, projectStartMs);
    if (to < from) continue;

    let perDay = dailyAllocation.get(entry.resourceId);
    if (!perDay) {
      perDay = new Map();
      dailyAllocation.set(entry.resourceId, perDay);
    }
    let touches = nodeTouches.get(entry.nodeId);
    if (!touches) {
      touches = new Map();
      nodeTouches.set(entry.nodeId, touches);
    }
    let touchedDays = touches.get(entry.resourceId);
    if (!touchedDays) {
      touchedDays = new Set();
      touches.set(entry.resourceId, touchedDays);
    }

    for (let d = from; d <= to; d++) {
      perDay.set(d, (perDay.get(d) ?? 0) + entry.count);
      touchedDays.add(d);
    }
  }

  // 2. For each (resource, day) bucket where total > capacity, the
  //    resource is over capacity on that day. Collect the over-cap day
  //    set per resource.
  const overCapDaysByResource = new Map<string, Set<number>>();
  for (const [resourceId, perDay] of dailyAllocation) {
    const resource = resourceMap.get(resourceId);
    if (!resource) continue;
    const overSet = new Set<number>();
    for (const [day, total] of perDay) {
      if (total > resource.capacity) overSet.add(day);
    }
    if (overSet.size > 0) overCapDaysByResource.set(resourceId, overSet);
  }

  if (overCapDaysByResource.size === 0) return {};

  // 3. For each node × resource it touched, count the intersection
  //    between its touched days and the resource's over-cap days. A
  //    non-zero intersection ⇒ the node is involved.
  const conflicts: Record<string, ConflictReason[]> = {};
  for (const [nodeId, perResource] of nodeTouches) {
    for (const [resourceId, touchedDays] of perResource) {
      const overSet = overCapDaysByResource.get(resourceId);
      if (!overSet) continue;
      let count = 0;
      for (const d of touchedDays) if (overSet.has(d)) count++;
      if (count === 0) continue;
      const reasons = conflicts[nodeId] ?? (conflicts[nodeId] = []);
      reasons.push({ resourceId, overCapacityDayCount: count });
    }
  }

  // 4. Subsystem rollup. For each container node, union its body nodes'
  //    conflict reasons (aggregating overCapacityDayCount per resource).
  //    Container ids appear in project.subsystems but not in the
  //    flattened scheduler nodes — UI renders containers so they need
  //    the marker too. This matches the cost-engine rollup pattern.
  for (const sub of subsystems) {
    const merged = new Map<string, number>();
    for (const bodyId of sub.bodyNodeIds) {
      const bodyReasons = conflicts[bodyId];
      if (!bodyReasons) continue;
      for (const r of bodyReasons) {
        merged.set(r.resourceId, (merged.get(r.resourceId) ?? 0) + r.overCapacityDayCount);
      }
    }
    if (merged.size > 0) {
      conflicts[sub.containerNodeId] = [...merged].map(([resourceId, overCapacityDayCount]) => ({
        resourceId,
        overCapacityDayCount,
      }));
    }
  }

  // 5. Stable ordering inside each node's reasons array — keeps test
  //    assertions and JSON exports deterministic.
  for (const nodeId of Object.keys(conflicts)) {
    conflicts[nodeId] = conflicts[nodeId]!.sort((a, b) =>
      a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0,
    );
  }

  return conflicts;
}
