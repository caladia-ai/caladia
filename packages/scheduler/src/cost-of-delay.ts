/**
 * Phase 25 Slice 2 — Cost-of-delay derived stat.
 *
 * For each critical-path activity that has at least one crash option,
 * compute `additionalCost / workingDaysSaved` per option and surface the
 * cheapest (best ROI) as the node's "cost of delay." Pure derived data —
 * no scheduling, no I/O. Slices 3 and 4 consume this same math to rank
 * candidates for the greedy crasher.
 *
 * Decisions baked in:
 *   - **Critical path only.** Non-critical activities have slack;
 *     crashing them does not shorten projectEnd. Non-critical-with-options
 *     are counted in the result so the UI can surface them as a footer hint.
 *   - **One row per node** — the option with the lowest `$/day`. The
 *     option's index is returned so the UI can show it in a tooltip and
 *     Slice 3 can drive the actual selection.
 *   - **Working days, not calendar days.** Divide by the node's effective
 *     calendar `hoursPerDay` — matches the engine's `toHours` semantics.
 *   - **Loop iterations cancel** under the default per-iteration crash
 *     cost (both the cost and the time-saved scale by iterations, so the
 *     ratio is iteration-independent). The `fixedCostOnce: true` edge case
 *     under-reports — accepted as a Slice 2 simplification.
 *   - **Decision failure penalty cancels** in the delta (added equally to
 *     nominal and crashed effective hours).
 */

import type { Calendar, Resource } from '@procsim/file-format';
import { effectiveDurationHours, nodeEffectiveWorkingCalendar } from './utils.js';
import type { ScheduleInput, ScheduleResult } from './types.js';

export interface CostOfDelayRow {
  nodeId: string;
  /** Best $/working-day saved across this node's crash options. */
  bestPerDay: number;
  /** Index into `node.crashOptions` of the option achieving `bestPerDay`. */
  bestOptionIndex: number;
  /**
   * Nominal effective duration in working hours (after the engine's
   * effective-calendar fold, decision penalty, and parallelism Amdahl).
   * For decision nodes the failure-delay penalty is included, but it
   * cancels in the delta against `crashedHours`.
   */
  nominalHours: number;
  /** Effective duration of the picked crash option, in working hours. */
  crashedHours: number;
  /** `additionalCost` of the picked option, in project currency. */
  addedCost: number;
}

export interface CostOfDelayResult {
  /** Rows sorted ascending by `bestPerDay` — cheapest ROI first. */
  rows: CostOfDelayRow[];
  /**
   * Count of nodes that have `crashOptions` but are NOT on the critical
   * path. Surfaced so the UI can footer-hint "N more nodes have crash
   * options off the critical path."
   */
  nonCriticalWithOptionsCount: number;
}

export function computeCostOfDelay(
  input: ScheduleInput,
  result: ScheduleResult,
): CostOfDelayResult {
  const calMap = new Map<string, Calendar>(input.calendars.map((c) => [c.id, c]));
  const resourceMap = new Map<string, Resource>(input.resources.map((r) => [r.id, r]));
  const defaultCal = calMap.get(input.project.defaultCalendarId);
  if (!defaultCal) return { rows: [], nonCriticalWithOptionsCount: 0 };

  const rows: CostOfDelayRow[] = [];
  let nonCriticalWithOptionsCount = 0;

  for (const node of input.nodes) {
    if (!node.crashOptions || node.crashOptions.length === 0) continue;
    const sched = result.nodes[node.id];
    if (!sched) continue;
    if (!sched.onCriticalPath) {
      nonCriticalWithOptionsCount++;
      continue;
    }

    const cal = nodeEffectiveWorkingCalendar(node, calMap, defaultCal, resourceMap);

    // Compute the nominal effective duration by stripping any current crash
    // selection. exactOptionalPropertyTypes — destructure-and-rebuild so the
    // field disappears entirely (per CLAUDE.md note).
    const { selectedCrashIndex: _omit, ...nominalNode } = node;
    const nominalHours = effectiveDurationHours(nominalNode, cal);

    let bestPerDay = Infinity;
    let bestIdx = -1;
    let bestCrashedHours = 0;
    let bestAdded = 0;

    for (let i = 0; i < node.crashOptions.length; i++) {
      const opt = node.crashOptions[i];
      if (!opt) continue;
      const crashedNode = { ...node, selectedCrashIndex: i };
      const crashedHours = effectiveDurationHours(crashedNode, cal);
      const deltaHours = nominalHours - crashedHours;
      // Defensive: schema enforces "strictly shorter," but if a runtime
      // path somehow surfaces a non-positive delta, skip it rather than
      // emit a divide-by-zero or negative ROI.
      if (deltaHours <= 0) continue;
      const daysSaved = deltaHours / cal.hoursPerDay;
      const perDay = opt.additionalCost / daysSaved;
      if (perDay < bestPerDay) {
        bestPerDay = perDay;
        bestIdx = i;
        bestCrashedHours = crashedHours;
        bestAdded = opt.additionalCost;
      }
    }

    if (bestIdx === -1) continue;
    rows.push({
      nodeId: node.id,
      bestPerDay,
      bestOptionIndex: bestIdx,
      nominalHours,
      crashedHours: bestCrashedHours,
      addedCost: bestAdded,
    });
  }

  // Cheapest $/day first — best ROI at the top of the table.
  rows.sort((a, b) => a.bestPerDay - b.bestPerDay);
  return { rows, nonCriticalWithOptionsCount };
}
