/**
 * Auto-leveling — priority-based serial resource-constrained scheduling.
 *
 * Given a baseline schedule with resource conflicts (days where a
 * resource's allocation exceeds its capacity), suggest shifts that move
 * lower-priority activities later in time so the resource has room.
 *
 * Strategy: iteratively
 *   1. Re-run `schedule()` with current accumulated lag overrides.
 *   2. Find the first day on which any resource is over-capacity.
 *   3. Identify activities competing for that resource on that day.
 *   4. Pick the lowest-priority activity — i.e. the one with the most
 *      slack (and the earliest start as a tie-break). Higher slack means
 *      shifting it later disrupts the schedule less.
 *   5. Find its constraining incoming edge — the predecessor whose
 *      `earliestFinish + lag` is exactly the activity's earliestStart.
 *      Add one working day (8 hours) of lag to that edge.
 *   6. Re-schedule and repeat.
 *
 * Stops when (a) no over-cap days remain, (b) we hit MAX_ITERATIONS as
 * a safety cap, or (c) the chosen activity has no incoming edge to
 * extend — in that case we remember the failure and move on to the next
 * over-cap day so we don't loop forever.
 *
 * The output is a plan that ResourcesPanel previews and applies as a
 * single domain-store undo step (the apply path mutates the project's
 * edges in one commit).
 *
 * Deterministic for a given (project, result) pair: ties in the
 * priority sort are broken by node-id lexicographic order, and ties in
 * the edge-pick are broken by edge-id lexicographic order.
 */

import type { Calendar } from '@procsim/file-format';
import type { ScheduleInput, ScheduleResult } from './types.js';
import { schedule } from './cpm.js';
import { toHours } from './utils.js';

/**
 * Minimum shift per leveling step, in hours. The actual shift is the larger
 * of this and the wall-clock distance to the latest competitor's finish on
 * the over-cap day — that way each iteration clears the chosen activity
 * past the conflict instead of oscillating in 1-day increments.
 */
const MIN_SHIFT_HOURS = 8;

/**
 * Safety cap: never run more leveling iterations than this. A well-formed
 * project converges in ≲ (over-cap-days × competing-activities) steps;
 * the cap is generous so realistic projects always complete.
 */
const MAX_ITERATIONS = 500;

export interface LevelingChange {
  /** The activity being shifted later. */
  nodeId: string;
  /** Human-readable name for the UI preview (looked up from project.nodes). */
  nodeName: string;
  /** Edge that received additional lag to effect the shift. */
  edgeId: string;
  /** Lag added to that edge by the leveler, in hours (positive). */
  addedLagHours: number;
  /** Predecessor node id (`edge.from`) — shown in the preview for clarity. */
  predecessorId: string;
  /** Predecessor name. */
  predecessorName: string;
  /**
   * The activity's earliest start under the final levelled schedule.
   * Useful for the UI to display "shifted from X to Y".
   */
  newStart: Date;
  /** The activity's earliest start in the baseline schedule. */
  baselineStart: Date;
}

export interface LevelingPlan {
  /**
   * One entry per shifted activity, sorted deterministically by nodeId.
   * This is for display only — the apply step uses `edgeLagBumps` so
   * multi-edge updates aren't lost when an activity has more than one
   * predecessor that got pushed.
   */
  changes: LevelingChange[];
  /**
   * The raw map of `edgeId → additional lag in hours` the leveler
   * accumulated. Applying the plan means adding each bump to that edge's
   * current lag. May include multiple bumps that all target the same
   * downstream activity.
   */
  edgeLagBumps: Record<string, number>;
  /** Number of over-cap days the plan resolves. */
  resolvedConflicts: number;
  /** Over-cap days still remaining after the plan is applied. */
  remainingConflicts: number;
  /** How many leveling iterations ran (for diagnostics + tests). */
  iterations: number;
  /** Whether the loop bailed because it hit `MAX_ITERATIONS`. */
  hitIterationCap: boolean;
  /** Activities the leveler couldn't shift (e.g. no incoming edges). */
  skipped: Array<{ nodeId: string; nodeName: string; reason: string }>;
}

interface OverCapDay {
  /** Day index since project start (0-based). */
  day: number;
  resourceId: string;
  resourceCapacity: number;
  /** Total count of this resource consumed on this day across all activities. */
  consumed: number;
  /** Node IDs of activities that use this resource on this day. */
  competingNodeIds: string[];
}

/**
 * Compute a leveling plan.
 *
 * `result` should be the un-levelled baseline. The leveler will re-call
 * `schedule()` internally as it iterates. Returns `null` when the
 * baseline has no over-cap days — there's nothing to level.
 */
export function suggestLeveling(input: ScheduleInput, result: ScheduleResult): LevelingPlan | null {
  const baselineOverCap = findOverCapDays(input, result);
  if (baselineOverCap.length === 0) return null;

  // Phase 50 Slice 7 / audit C-1 — lag conversion is calendar-aware. Look
  // up the project's default calendar; lagToHours / lagToMs use it so the
  // hours we write back into edge lags get re-interpreted by CPM as the
  // same elapsed time the user authored, not 3× more on a non-24h day.
  // Falls back to the first calendar in the array as a defensive guard
  // (schedule() would have failed already if no calendar is loadable, so
  // the fallback path is dead in practice).
  const defaultCal =
    input.calendars.find((c) => c.id === input.project.defaultCalendarId) ?? input.calendars[0]!;

  // Mutable copy of the input — we adjust per-edge lags by accumulating
  // hours into `extraLagHours[edgeId]` and rebuild the input each loop.
  // Anchor-date / Start-node fields are not touched.
  const extraLagHours = new Map<string, number>();

  // Track which (nodeId, edgeId) pairs we've already tried; if the same
  // node turns up as the "shift target" again with the same edge, the
  // loop just keeps adding lag — that's fine for converging the resource
  // peak. We use this set only to detect "no progress" (when the chosen
  // edge has no effect because of intervening logic).
  const skipped = new Map<string, { nodeName: string; reason: string }>();

  let currentResult = result;
  let currentInput = input;
  let iterations = 0;
  let hitIterationCap = false;
  const nodeNameById = new Map(input.nodes.map((n) => [n.id, n.name]));
  // Phase 33 — Manual leveling priority. Absent ≡ 0; higher = harder
  // to move. Used as the FIRST sort key in the candidate comparator
  // below so the leveler exhausts lower-priority slack before touching
  // a high-priority node.
  const levelPriorityById = new Map(input.nodes.map((n) => [n.id, n.levelPriority ?? 0]));

  // Loop / subsystem body nodes can't be levelled by extending edge lag —
  // their scheduling is constrained by the wrapping construct (loop's
  // wall-clock window, subsystem flattening pre-pass). Adding lag to one
  // of their incoming edges may have no visible effect, causing the
  // leveler to spin on the same node forever. We skip them up front and
  // surface them as `skipped` entries so the UI is honest about what
  // couldn't be touched.
  const loopBodyIds = new Set<string>();
  for (const loop of input.loops) {
    for (const id of loop.bodyNodeIds) loopBodyIds.add(id);
  }
  const subsystemBodyIds = new Set<string>();
  for (const sub of input.subsystems ?? []) {
    for (const id of sub.bodyNodeIds) subsystemBodyIds.add(id);
  }
  const unlevelableIds = new Set<string>([...loopBodyIds, ...subsystemBodyIds]);

  // Over-cap (day, resource) pairs the leveler couldn't make progress on
  // in a previous iteration — typically because all competing activities
  // were loop / sub-system body nodes. We skip them on subsequent passes
  // and move on to the next over-cap pair instead of breaking out of
  // the loop entirely.
  const abandoned = new Set<string>();

  while (iterations < MAX_ITERATIONS) {
    const overCap = findOverCapDays(currentInput, currentResult);
    if (overCap.length === 0) break;

    // Lowest-day-first so we attack the earliest conflict — fixing
    // earlier conflicts can cascade-resolve later ones.
    overCap.sort((a, b) => a.day - b.day || a.resourceId.localeCompare(b.resourceId));
    const target = overCap.find((o) => !abandoned.has(`${o.resourceId} ${o.day}`));
    if (!target) break;

    // Lowest-priority activity = highest slack, with earliest start as
    // tie-break. Skip nodes we've already given up on AND nodes inside a
    // loop / sub-system body (we can't reliably push them via edge lag).
    for (const id of target.competingNodeIds) {
      if (unlevelableIds.has(id) && !skipped.has(id)) {
        skipped.set(id, {
          nodeName: nodeNameById.get(id) ?? id,
          reason: loopBodyIds.has(id)
            ? 'inside a loop — leveling via edge lag has no visible effect'
            : 'inside a sub-system — leveling not yet supported across sub-systems',
        });
      }
    }
    const candidates = target.competingNodeIds
      .filter((id) => !skipped.has(id))
      .map((id) => {
        const sched = currentResult.nodes[id];
        if (!sched) return null;
        return {
          id,
          // Phase 33 — manual leveling priority; absent ≡ 0.
          priority: levelPriorityById.get(id) ?? 0,
          slack: sched.slackHours,
          start: sched.earliestStart.getTime(),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort(
        // Phase 33 — leveler picks the LOWEST-priority candidate to
        // shift first, so higher `levelPriority` values stay put longer.
        // Ties on priority fall through to slack (the legacy ordering):
        // highest slack picked first (most moveable), then earliest
        // start, then id for determinism.
        (a, b) =>
          a.priority - b.priority ||
          b.slack - a.slack ||
          a.start - b.start ||
          a.id.localeCompare(b.id),
      );

    if (candidates.length === 0) {
      // Every competing activity on this (day, resource) is already in
      // `skipped`. Mark the pair abandoned so the next iteration moves
      // on to the next over-cap pair instead of attacking this one
      // forever.
      abandoned.add(`${target.resourceId} ${target.day}`);
      continue;
    }

    const chosen = candidates[0]!;
    const edge = findConstrainingEdge(currentInput, currentResult, chosen.id, defaultCal);
    if (edge === null) {
      const reason = currentInput.edges.some((e) => e.to === chosen.id)
        ? 'no constraining predecessor edge found'
        : 'no incoming edges';
      skipped.set(chosen.id, {
        nodeName: nodeNameById.get(chosen.id) ?? chosen.id,
        reason,
      });
      continue;
    }

    // Shift amount: enough to get past the latest competitor's finish on
    // this over-cap day. Fall back to MIN_SHIFT_HOURS if we somehow can't
    // compute that. Using wall-clock hours here is intentional — the
    // scheduler interprets the lag as working hours, so it will move the
    // activity by even more wall-clock time, which is fine: we want to
    // clear the conflict, not be exact.
    const chosenStart = currentResult.nodes[chosen.id]!.earliestStart.getTime();
    let latestCompetitorFinish = chosenStart;
    for (const otherId of target.competingNodeIds) {
      if (otherId === chosen.id) continue;
      const other = currentResult.nodes[otherId];
      if (!other) continue;
      const f = other.earliestFinish.getTime();
      if (f > latestCompetitorFinish) latestCompetitorFinish = f;
    }
    const wallClockHours = Math.max(0, (latestCompetitorFinish - chosenStart) / 3_600_000);
    const shiftHours = Math.max(MIN_SHIFT_HOURS, Math.ceil(wallClockHours));

    extraLagHours.set(edge.id, (extraLagHours.get(edge.id) ?? 0) + shiftHours);

    currentInput = applyExtraLags(input, extraLagHours, defaultCal);
    const outcome = schedule(currentInput);
    if (!outcome.ok) {
      // Schedule failure — unwind the last edit and stop.
      extraLagHours.set(edge.id, Math.max(0, (extraLagHours.get(edge.id) ?? 0) - shiftHours));
      break;
    }
    currentResult = outcome.result;
    iterations++;
  }

  if (iterations >= MAX_ITERATIONS) hitIterationCap = true;

  // ── Build the plan ─────────────────────────────────────────────────────
  const finalOverCap = findOverCapDays(currentInput, currentResult);
  const resolvedConflicts = Math.max(0, baselineOverCap.length - finalOverCap.length);

  // One LevelingChange per activity that ended up with shifted start.
  // We aggregate by node so a node with multiple lag-extended incoming
  // edges still produces a single change row (using the edge that
  // received the most added lag).
  const baselineStartById = new Map<string, Date>();
  for (const [nodeId, s] of Object.entries(result.nodes)) {
    baselineStartById.set(nodeId, s.earliestStart);
  }

  const changesByNode = new Map<string, LevelingChange>();
  for (const [edgeId, added] of extraLagHours.entries()) {
    if (added <= 0) continue;
    const edge = input.edges.find((e) => e.id === edgeId);
    if (!edge) continue;
    const target = edge.to;
    const targetName = nodeNameById.get(target) ?? target;
    const predName = nodeNameById.get(edge.from) ?? edge.from;
    const baseline = baselineStartById.get(target);
    const newStart = currentResult.nodes[target]?.earliestStart;
    if (!baseline || !newStart) continue;
    const existing = changesByNode.get(target);
    if (!existing || added > existing.addedLagHours) {
      changesByNode.set(target, {
        nodeId: target,
        nodeName: targetName,
        edgeId,
        addedLagHours: added,
        predecessorId: edge.from,
        predecessorName: predName,
        newStart,
        baselineStart: baseline,
      });
    }
  }

  const edgeLagBumps: Record<string, number> = {};
  for (const [edgeId, added] of extraLagHours.entries()) {
    if (added > 0) edgeLagBumps[edgeId] = added;
  }

  return {
    changes: [...changesByNode.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    edgeLagBumps,
    resolvedConflicts,
    remainingConflicts: finalOverCap.length,
    iterations,
    hitIterationCap,
    skipped: [...skipped.entries()].map(([nodeId, info]) => ({
      nodeId,
      ...info,
    })),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Locate every (resource, day) pair on which demand exceeds capacity.
 *
 * Day index is computed relative to the schedule's earliest activity
 * start so projects with anchored Start nodes (earlier than
 * `project.startDate`) still land at day-0 = the chart origin.
 *
 * Uses interval-overlap (sweep-line) per resource rather than day-bucket
 * summation: when activity A finishes at the same instant activity B
 * starts, day-bucket sums them and reports a false over-cap. Sweep-line
 * sees A's release event before B's claim (-delta sorts before +delta on
 * tied times) so the running total stays accurate. This is load-bearing
 * for the leveler — without it, the leveler chases same-day boundary
 * false positives forever on cascading dependency chains.
 */
/**
 * Audit N-1 — return the smallest `start.getTime()` across an array of
 * timeline-shaped entries. The naive `Math.min(...arr.map(...))` spreads
 * every element onto the call stack and overflows in V8 around
 * ~100k-200k entries. The resource timeline scales with nodes ×
 * loops-unrolled × resource-assignments, so giant templates can plausibly
 * cross that threshold. A running min over a `for-of` loop is safe at
 * any size.
 *
 * Exported so the regression test can hammer it with 200k entries without
 * setting up an equivalently-sized synthetic project.
 */
export function minStartMs(entries: ReadonlyArray<{ start: Date }>): number {
  let min = Infinity;
  for (const entry of entries) {
    const t = entry.start.getTime();
    if (t < min) min = t;
  }
  return min;
}

function findOverCapDays(input: ScheduleInput, result: ScheduleResult): OverCapDay[] {
  // Origin: floor-to-midnight of the earliest resource-timeline entry,
  // matching what GanttView and ResourcesPanel use for their day axis.
  if (result.resourceTimeline.length === 0) return [];
  const minStart = minStartMs(result.resourceTimeline);
  const origin = new Date(minStart);
  origin.setHours(0, 0, 0, 0);
  const originMs = origin.getTime();

  const capacityById = new Map(input.resources.map((r) => [r.id, r.capacity]));

  // Group entries by resource so we can sweep each resource independently.
  const byResource = new Map<string, typeof result.resourceTimeline>();
  for (const entry of result.resourceTimeline) {
    const arr = byResource.get(entry.resourceId) ?? [];
    arr.push(entry);
    byResource.set(entry.resourceId, arr);
  }

  const out: OverCapDay[] = [];

  for (const [resourceId, entries] of byResource.entries()) {
    const capacity = capacityById.get(resourceId) ?? 0;

    // Build start (+count) / end (-count) events. Sort by time; on ties,
    // process negative deltas (releases) before positive deltas (claims)
    // so adjacent intervals don't artificially overlap.
    type Event = { t: number; delta: number; nodeId: string };
    const events: Event[] = [];
    for (const e of entries) {
      events.push({ t: e.start.getTime(), delta: e.count, nodeId: e.nodeId });
      events.push({ t: e.end.getTime(), delta: -e.count, nodeId: e.nodeId });
    }
    events.sort((a, b) => a.t - b.t || a.delta - b.delta);

    // Sweep. After processing every event at a given time `t`, if the
    // running total exceeds capacity we record the current active set as
    // an over-cap moment for the day containing `t`.
    let running = 0;
    // nodeId → overlap count (a single node can have multiple concurrent
    // entries, e.g. loop iterations of the same body node).
    const active = new Map<string, number>();
    // dayIndex → { peak, nodeIds }
    const days = new Map<number, { peak: number; nodeIds: Set<string> }>();

    let i = 0;
    while (i < events.length) {
      const t = events[i]!.t;
      while (i < events.length && events[i]!.t === t) {
        const ev = events[i]!;
        running += ev.delta;
        if (ev.delta > 0) {
          active.set(ev.nodeId, (active.get(ev.nodeId) ?? 0) + 1);
        } else {
          const cur = (active.get(ev.nodeId) ?? 0) - 1;
          if (cur <= 0) active.delete(ev.nodeId);
          else active.set(ev.nodeId, cur);
        }
        i++;
      }
      if (running > capacity && active.size > 0) {
        const day = Math.max(0, Math.floor((t - originMs) / 86_400_000));
        const slot = days.get(day) ?? { peak: 0, nodeIds: new Set<string>() };
        slot.peak = Math.max(slot.peak, running);
        for (const id of active.keys()) slot.nodeIds.add(id);
        days.set(day, slot);
      }
    }

    for (const [day, slot] of days.entries()) {
      out.push({
        day,
        resourceId,
        resourceCapacity: capacity,
        consumed: slot.peak,
        competingNodeIds: [...slot.nodeIds].sort(),
      });
    }
  }

  return out;
}

/**
 * For a target node, find the incoming edge that's currently determining
 * its earliestStart — i.e. the predecessor whose `earliestFinish + lag`
 * is exactly the target's `earliestStart` (within a millisecond
 * tolerance for floating-point safety).
 *
 * Returns `null` if there are no incoming edges or no edge matches.
 * Ties broken by edge-id lexicographic order for determinism.
 */
function findConstrainingEdge(
  input: ScheduleInput,
  result: ScheduleResult,
  nodeId: string,
  cal: Calendar,
): ScheduleInput['edges'][number] | null {
  const target = result.nodes[nodeId];
  if (!target) return null;
  const incoming = input.edges
    .filter((e) => e.to === nodeId)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (incoming.length === 0) return null;

  // The constraining predecessor is the one whose finish + lag closely
  // matches the target's start. We allow a one-second tolerance for
  // sub-second working-time rounding inside the scheduler. The lag is
  // converted to ms via the calendar-aware path (Slice 7 / C-1): if the
  // edge says `{value:1, unit:'days'}` we want 8 working hours, not 24
  // wall-clock hours, to keep the comparison match-rate high during
  // continuous-work spans. (Weekend-crossing spans still escape the
  // tolerance — that's a known limitation, the leveler falls back to
  // "first incoming edge" in that case, which still produces a valid
  // shift.)
  const TOL_MS = 1000;
  const targetStartMs = target.earliestStart.getTime();
  for (const e of incoming) {
    const predFinish = result.nodes[e.from]?.earliestFinish;
    if (!predFinish) continue;
    const lagMs = lagToMs(e.lag, cal);
    if (Math.abs(predFinish.getTime() + lagMs - targetStartMs) <= TOL_MS) {
      return e;
    }
  }
  // Fall back to the first incoming edge — the lag we add will still
  // shift the node, even if it's not the constraining predecessor.
  return incoming[0] ?? null;
}

/**
 * Phase 50 Slice 7 / audit C-1 — lag conversion is calendar-aware. The
 * CPM engine reads lags via `toHours(lag, nodeCal)` which honours the
 * calendar's `hoursPerDay` / `daysPerWeek`. The pre-Slice-7 leveler
 * used wall-clock factors (24 h/day, 168 h/week), so a `{value:1,
 * unit:'days'}` lag was rewritten as 24 hours and re-read by CPM as
 * 3 working days on an 8h calendar — silent ~3× inflation inside a
 * single undo step. Now both sides agree.
 *
 * The calendar passed here is the project's default. Per-node
 * calendars yield slightly imprecise extra-lag values for edges whose
 * destination uses a non-default calendar, but the dominant error
 * (units-mismatch) is gone, and the leveler's purpose is "shift
 * enough to clear the conflict" rather than "be exact".
 */
function lagToHours(lag: ScheduleInput['edges'][number]['lag'], cal: Calendar): number {
  // Edge lag is always 'time' semantic per the Phase 40 design — `toHours`'s
  // default semantic.
  return toHours(lag, cal);
}

function lagToMs(lag: ScheduleInput['edges'][number]['lag'], cal: Calendar): number {
  return lagToHours(lag, cal) * 3_600_000;
}

/**
 * Return a new ScheduleInput with `extraLagHours` added to each named
 * edge's lag. The original input is not mutated.
 *
 * Exported so tests can pin the calendar-aware rewriting from
 * Slice 7 / C-1 (a day-unit lag must become its calendar-hours
 * equivalent, not its wall-clock-hours equivalent, before extra
 * is added). Not part of the package's public surface — `index.ts`
 * only re-exports `suggestLeveling`.
 */
export function applyExtraLags(
  input: ScheduleInput,
  extraLagHours: ReadonlyMap<string, number>,
  cal: Calendar,
): ScheduleInput {
  if (extraLagHours.size === 0) return input;
  const newEdges = input.edges.map((e) => {
    const extra = extraLagHours.get(e.id);
    if (!extra) return e;
    return {
      ...e,
      lag: {
        // Normalise to hours so additions are unit-stable across calls.
        // Conversion is calendar-aware (matches what CPM does on read).
        value: lagToHours(e.lag, cal) + extra,
        unit: 'hours' as const,
      },
    };
  });
  return { ...input, edges: newEdges };
}
