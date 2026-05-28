import type {
  Calendar,
  DurationSemantic,
  DurationUnit,
  ProjectNode,
  Resource,
  ResourceAssignment,
} from '@procsim/file-format';
import { EFFORT_DAYS_PER_WEEK, EFFORT_HOURS_PER_DAY } from '@procsim/file-format';
import {
  effectiveActivityCalendar,
  intersectCalendars,
  resolveAssignmentCalendar,
} from '@procsim/calendar';

/**
 * Convert a duration to working hours.
 *
 * - `semantic: 'time'` (default — pre-Phase-40 behaviour): days/weeks are
 *   interpreted against the supplied calendar's `hoursPerDay` /
 *   `daysPerWeek`, so the effort hours scale with the calendar.
 * - `semantic: 'effort'`: days/weeks use the fixed canonical constants
 *   (`EFFORT_HOURS_PER_DAY` = 8, `EFFORT_DAYS_PER_WEEK` = 5). Switching
 *   the node's effective calendar does NOT change the effort hours.
 *
 * The calendar parameter is required even on the effort path so all call
 * sites pass the same shape; it is simply ignored when `semantic === 'effort'`.
 *
 * Edge-lag call sites that have no node context pass the default `'time'`
 * — lag is always elapsed (a Phase 40 design decision, see plan).
 */
export function toHours(
  d: { value: number; unit: DurationUnit },
  cal: Calendar,
  semantic: DurationSemantic = 'time',
): number {
  switch (d.unit) {
    case 'hours':
      return d.value;
    case 'days':
      return d.value * (semantic === 'effort' ? EFFORT_HOURS_PER_DAY : cal.hoursPerDay);
    case 'weeks':
      return (
        d.value *
        (semantic === 'effort'
          ? EFFORT_HOURS_PER_DAY * EFFORT_DAYS_PER_WEEK
          : cal.hoursPerDay * cal.daysPerWeek)
      );
  }
}

/**
 * Effective working duration (in hours) used by the CPM engine.
 *
 * For activity/start/end nodes this is just `toHours(node.duration)`.
 *
 * For decision nodes (Phase 11) the engine adds the *expected* failure-delay
 * penalty so a single deterministic point-estimate reflects the gate's risk:
 *
 *     effective = duration + (1 − passProbability) × failureDelay
 *
 * Defaults are applied here so legacy/decision-without-fields nodes behave
 * identically to activities: missing `passProbability` defaults to 1 (always
 * passes → no penalty); missing `failureDelay` defaults to 0.
 *
 * In Monte Carlo, the simulation pre-samples the iteration's duration and
 * Bernoulli outcome (adding `failureDelay` if the gate fails for that
 * iteration) and then sets `passProbability: 1` on the node it hands to the
 * scheduler. That makes this helper return the realized hours unchanged —
 * the expected-value formula collapses to the realized duration.
 */
export function effectiveDurationHours(node: ProjectNode, cal: Calendar): number {
  // Phase 23 — apply parallelism shrinkage to `nodeBaseHours` (which
  // already folds in the decision-penalty for gate nodes). Wall-clock
  // is the bottleneck (max) across per-assignment effective durations.
  // With no assignments OR all assignments having α=0 (the legacy
  // default) OR count=1, this collapses to `nodeBaseHours`, byte-equal
  // with the pre-Phase-23 engine.
  return assignmentBottleneckHours(nodeBaseHours(node, cal), node.resourceAssignments);
}

/**
 * Phase 23 — the per-assignment "base" hours that the parallelism
 * formula shrinks. For activity / start / end nodes this is just
 * `toHours(node.duration, cal)`. For decision nodes it adds the
 * expected failure-delay penalty (`(1 − passProbability) × failureDelay`),
 * matching the pre-Phase-23 `effectiveDurationHours` semantics.
 *
 * Used by both `effectiveDurationHours` (for wall-clock, after
 * bottleneck) and the cost engine (for per-assignment effective hours).
 */
export function nodeBaseHours(node: ProjectNode, cal: Calendar): number {
  // Phase 25 — if a crash option is selected, swap the nominal duration for
  // the option's (shorter) duration. The decision-failure penalty and the
  // parallelism Amdahl chain stack on the substituted duration. Schema
  // validation guarantees the index is in range and the option's unit
  // matches `node.duration.unit`, so the substitution is unambiguous.
  // Phase 40 — the duration's interpretation (`'effort'` vs `'time'`) is
  // a per-node attribute; crash options and the failure-delay penalty
  // share it (the alternative — letting one node mix semantics — would
  // be confusing and has no use case the user has asked for).
  const effectiveDuration = selectedCrashDuration(node) ?? node.duration;
  const baseHrs = toHours(effectiveDuration, cal, node.durationSemantic);
  if (node.nodeType !== 'decision') return baseHrs;
  const pass = node.passProbability ?? 1;
  const delayHrs = node.failureDelay ? toHours(node.failureDelay, cal, node.durationSemantic) : 0;
  return baseHrs + (1 - pass) * delayHrs;
}

/**
 * Phase 25 — returns the selected crash option's duration, or `undefined`
 * when no crash is selected (or when the index is somehow out of bounds —
 * schema validation prevents this, but a runtime fall-through to nominal
 * is the conservative behaviour).
 */
export function selectedCrashDuration(node: ProjectNode): ProjectNode['duration'] | undefined {
  if (node.selectedCrashIndex === undefined || !node.crashOptions) return undefined;
  return node.crashOptions[node.selectedCrashIndex]?.duration;
}

/**
 * Phase 23 — per-assignment effective duration in hours under Amdahl's
 * law for parallel resources.
 *
 *   effective = baseHours × ((1 − α) + α / count)
 *
 * At α=0 → `baseHours` (independent labour: more units add cost, not
 * speed). At α=1 → `baseHours / count` (perfect parallel: more units
 * shrink time, not cost — the cost engine multiplies by `count` so the
 * count factors cancel). At count=1 the formula collapses to
 * `baseHours` regardless of α — there's nothing to parallelise.
 *
 * Reads the optional `parallelism` field from the assignment; absent
 * (legacy files) is treated as α=0 to preserve pre-Phase-23 cost and
 * duration behaviour byte-for-byte.
 */
export function assignmentEffectiveDurationHours(
  baseHours: number,
  asgn: ResourceAssignment,
): number {
  if (asgn.count <= 1) return baseHours;
  const alpha = asgn.parallelism ?? 0;
  if (alpha <= 0) return baseHours;
  return baseHours * (1 - alpha + alpha / asgn.count);
}

/**
 * Phase 23 — activity wall-clock under Amdahl + multi-assignment
 * bottleneck. Returns `baseHours` when there are no assignments, or
 * when every assignment's effective duration equals `baseHours` (legacy
 * behaviour). Otherwise returns the max across per-assignment effective
 * durations — the slowest assignment is the activity's wall-clock.
 *
 * Phase 42 — when any assignment has `share` set, each pool gets a
 * fraction of `baseHours` proportional to its share, and the Amdahl
 * shrinkage applies inside that fraction. Wall-clock is still the max
 * across pools' post-share, post-Amdahl effective hours. Schema's
 * all-or-none invariant means we can detect share mode by inspecting
 * any one assignment.
 */
function assignmentBottleneckHours(
  baseHours: number,
  assignments: ReadonlyArray<ResourceAssignment>,
): number {
  if (assignments.length === 0) return baseHours;
  const shareTotal = assignmentShareTotal(assignments);
  let bottleneck = 0;
  for (const a of assignments) {
    const perPool = perPoolBaseHours(baseHours, a, shareTotal);
    const d = assignmentEffectiveDurationHours(perPool, a);
    if (d > bottleneck) bottleneck = d;
  }
  // Defensive: if every assignment somehow returned 0 (shouldn't happen
  // since assignmentEffectiveDurationHours always returns ≥0 with α≤1),
  // fall back to baseHours rather than collapsing the activity.
  return bottleneck === 0 ? baseHours : bottleneck;
}

/**
 * Phase 42 — sum of `share` across an assignment list. Returns 0 when
 * no assignment has a share set (legacy mode). The schema's all-or-none
 * + sum > 0 invariants mean any positive return value here implies
 * every assignment has a non-undefined share.
 */
export function assignmentShareTotal(assignments: ReadonlyArray<ResourceAssignment>): number {
  let total = 0;
  for (const a of assignments) {
    if (a.share === undefined) continue;
    total += a.share;
  }
  return total;
}

/**
 * Phase 42 — per-pool "base hours" that the Amdahl formula then shrinks.
 * When shares are in play (`shareTotal > 0`), each pool gets the
 * fraction `share / shareTotal` of the activity's baseHours. When
 * shares are absent (`shareTotal === 0`), every pool sees the full
 * baseHours — the pre-Phase-42 legacy behaviour, byte-equal with the
 * Phase 23 model.
 */
export function perPoolBaseHours(
  baseHours: number,
  assignment: ResourceAssignment,
  shareTotal: number,
): number {
  if (shareTotal <= 0) return baseHours;
  const share = assignment.share ?? 0;
  return baseHours * (share / shareTotal);
}

/**
 * Phase 18 — node's effective working calendar, resource-aware.
 *
 * Combines the node's own calendar (or the project default if `calendarId`
 * is null) with each of its `resourceAssignments`' resolved per-assignment
 * calendars, then fold-intersects them so the activity only progresses on
 * hours where ALL its assigned resources are working under their declared
 * `calendarPolicy`.
 *
 * - Anchor nodes (start/end), nodes with `consumesResources: false`, and
 *   nodes with no assignments fall back to the activity-only calendar.
 * - Unknown resource ids or unresolvable per-assignment calendars are
 *   skipped silently — validation in `cpm.ts` has already surfaced those
 *   as structured errors before this is called for time-advance work.
 * - A fold step that would collapse to an empty calendar also falls back
 *   to the prior accumulator (validation has already errored, but the
 *   schedule pass shouldn't blow up further by carrying around a null).
 *
 * Used by both the main CPM (`cpm.ts:getNodeCal`) and the loop body-CPM /
 * unroll passes (`loop.ts`). Phase 18 slice 1 wired this into CPM for
 * non-loop activities; the loop-body follow-up extended it to body nodes
 * so a body activity is finally gated by its resources' calendars during
 * the per-iteration unroll, not just by the project default.
 */
export function nodeEffectiveWorkingCalendar(
  node: ProjectNode,
  calMap: Map<string, Calendar>,
  defaultCal: Calendar,
  resourceMap: Map<string, Resource>,
): Calendar {
  const activityCal = effectiveActivityCalendar(
    node.calendarId !== null ? (calMap.get(node.calendarId) ?? null) : null,
    defaultCal,
  );
  if (!node.consumesResources || node.resourceAssignments.length === 0) {
    return activityCal;
  }
  let acc: Calendar = activityCal;
  for (const asgn of node.resourceAssignments) {
    const resource = resourceMap.get(asgn.resourceId);
    if (!resource) continue;
    const resourceCal = calMap.get(resource.calendarId);
    if (!resourceCal) continue;
    const resolved = resolveAssignmentCalendar(activityCal, resourceCal, asgn.calendarPolicy);
    if (!resolved.ok) continue;
    const next = intersectCalendars(acc, resolved.calendar);
    if (!next) continue;
    acc = next;
  }
  return acc;
}
