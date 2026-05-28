/**
 * Phase 25 Slice 3 — Deterministic greedy CPM crashing helper.
 *
 * Classic textbook algorithm: while `currentFinish > deadline`, find the
 * cheapest critical-path activity with an unused crash step deeper than
 * its current selection, apply it, recompute CPM, repeat.
 *
 * Pure: no DOM, no I/O. Builds a deep-copied node array and calls
 * `schedule()` each iteration. Returns a `GreedyCrashPlan` the caller
 * applies via `applyCrashPlan` on the domain store (single undo step).
 *
 * Behaviour pinned by tests:
 *   - **Extends current selections.** If `input.nodes[i].selectedCrashIndex`
 *     is already set, the greedy treats that as the floor and only
 *     advances deeper. The UI's "Reset all crashes first" toggle is the
 *     escape hatch for a clean-slate run.
 *   - **Reads effective duration via `effectiveDurationHours`.** Decision
 *     failure penalties cancel in the delta; parallelism (Phase 23 Amdahl)
 *     correctly shrinks the schedule-perceived savings.
 *   - **Tie-break: deeper crash wins, then nodeId.** Two candidates with
 *     identical $/day are ordered by `deltaHours` desc, then `nodeId`
 *     asc — keeps the algorithm deterministic across runs.
 *   - **Doesn't reschedule resources.** Crashing only shortens durations;
 *     induced over-capacity is surfaced by Phase 24's conflictedNodeIds
 *     for the caller to warn the user about. Resolving conflicts is Phase
 *     17 auto-level's job.
 *   - **Iteration cap.** Bounded at `nodes.length * 10 + 10` to defend
 *     against pathological inputs. Reported as `reachedDeadline: false`
 *     if it ever fires before deadline is met.
 *   - **Pathological options accepted.** Schema enforces "strictly
 *     shorter" per option but not monotonicity vs. other options. If
 *     option B is BOTH shorter AND cheaper than A, the greedy treats the
 *     A→B step as a "free win" (negative perDay) and prioritises it.
 */

import type { Calendar, ProjectNode, Resource } from '@procsim/file-format';
import { schedule } from './cpm.js';
import { effectiveDurationHours, nodeEffectiveWorkingCalendar } from './utils.js';
import type { ScheduleInput, ScheduleResult } from './types.js';

export interface CrashStep {
  nodeId: string;
  /** selectedCrashIndex BEFORE this step (`undefined` = nominal). */
  fromIndex: number | undefined;
  /** selectedCrashIndex AFTER this step. */
  toIndex: number;
  /**
   * $/working-day-saved at the moment this step was picked. Diagnostic
   * for the preview modal; the algorithm itself uses this as the sort key.
   */
  perDay: number;
  /**
   * Incremental cost added by this step (`option[to].additionalCost −
   * option[from].additionalCost`, with `from === undefined` treated as 0).
   * May be negative if a "free win" step is taken.
   */
  addedCost: number;
}

export interface GreedyCrashPlan {
  /** Steps in the order the greedy picked them. */
  steps: CrashStep[];
  /** Sum of `addedCost` across `steps`. */
  totalAddedCost: number;
  /** Project end after applying all steps. */
  finalFinish: Date;
  /** True iff `finalFinish <= deadline`. False = greedy ran out of feasible steps. */
  reachedDeadline: boolean;
}

/**
 * Greedily compress the schedule toward `deadline` by selecting crash
 * options on critical-path activities. Cheapest $/working-day-saved
 * wins each round; ties broken by deeper crash, then nodeId.
 *
 * Read-only over `input` — returns a plan; mutation is the caller's
 * responsibility via `applyCrashPlan` on the domain store.
 */
export function greedyCrash(input: ScheduleInput, deadline: Date): GreedyCrashPlan {
  // Working copy: shallow-clone the nodes array; entries are replaced
  // (not mutated) when a step is applied, so the input is untouched.
  let workingNodes: ProjectNode[] = input.nodes.map((n) => ({ ...n }));

  const calMap = new Map<string, Calendar>(input.calendars.map((c) => [c.id, c]));
  const resourceMap = new Map<string, Resource>(input.resources.map((r) => [r.id, r]));
  const defaultCal = calMap.get(input.project.defaultCalendarId);

  const fallbackStart = new Date(input.project.startDate + 'T00:00:00');
  const emptyPlan = (finish: Date, reached: boolean): GreedyCrashPlan => ({
    steps: [],
    totalAddedCost: 0,
    finalFinish: finish,
    reachedDeadline: reached,
  });

  if (!defaultCal) return emptyPlan(fallbackStart, false);

  // Initial schedule.
  let outcome = schedule({ ...input, nodes: workingNodes });
  if (!outcome.ok) return emptyPlan(fallbackStart, false);
  if (outcome.result.projectEnd.getTime() <= deadline.getTime()) {
    return emptyPlan(outcome.result.projectEnd, true);
  }

  const steps: CrashStep[] = [];
  let totalAddedCost = 0;
  const maxIterations = workingNodes.length * 10 + 10;
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    const next = pickBestStep(workingNodes, outcome.result, calMap, resourceMap, defaultCal);
    if (!next) break;

    // Apply the step into the working copy.
    workingNodes = workingNodes.map((n) =>
      n.id === next.nodeId ? { ...n, selectedCrashIndex: next.toIndex } : n,
    );

    steps.push({
      nodeId: next.nodeId,
      fromIndex: next.fromIndex,
      toIndex: next.toIndex,
      perDay: next.perDay,
      addedCost: next.addedCost,
    });
    totalAddedCost += next.addedCost;

    // Reschedule. If the new schedule fails (shouldn't — we only changed
    // durations, not topology), bail out cleanly.
    outcome = schedule({ ...input, nodes: workingNodes });
    if (!outcome.ok) {
      // Roll back the last step so the returned plan stays schedulable
      // when applied. Conservative — leaves us with the best plan that
      // we know reschedules cleanly.
      const reverted = steps.pop()!;
      totalAddedCost -= reverted.addedCost;
      workingNodes = workingNodes.map((n) =>
        n.id === reverted.nodeId
          ? reverted.fromIndex === undefined
            ? (() => {
                const { selectedCrashIndex: _omit, ...rest } = n;
                return rest;
              })()
            : { ...n, selectedCrashIndex: reverted.fromIndex }
          : n,
      );
      outcome = schedule({ ...input, nodes: workingNodes });
      const fin = outcome.ok ? outcome.result.projectEnd : fallbackStart;
      return { steps, totalAddedCost, finalFinish: fin, reachedDeadline: false };
    }

    if (outcome.result.projectEnd.getTime() <= deadline.getTime()) {
      return {
        steps,
        totalAddedCost,
        finalFinish: outcome.result.projectEnd,
        reachedDeadline: true,
      };
    }
  }

  // Either ran out of candidates or hit the iteration cap.
  return {
    steps,
    totalAddedCost,
    finalFinish: outcome.result.projectEnd,
    reachedDeadline: outcome.result.projectEnd.getTime() <= deadline.getTime(),
  };
}

// ── Shared candidate-picking math (also used by Phase 25 Slice 4) ────────────

/**
 * One candidate step the greedy is considering: advancing `nodeId`'s
 * `selectedCrashIndex` from `fromIndex` to `toIndex`. Exposed alongside
 * `pickBestStep` for the chance-constrained variant in `@procsim/simulation`.
 */
export interface CrashCandidate {
  nodeId: string;
  fromIndex: number | undefined;
  toIndex: number;
  perDay: number;
  addedCost: number;
  deltaHours: number;
}

/**
 * Scan critical-path nodes for the globally cheapest next crash step.
 *
 * For each critical-path node N with `crashOptions`:
 *   - Determine the current effective duration (with whatever option,
 *     if any, is currently selected).
 *   - For every option J whose effective duration is strictly shorter
 *     than the current, compute incremental $/working-day-saved.
 *   - Track this node's best (lowest perDay; deeper crash on tie).
 *
 * Then pick the global best across all nodes (deeper crash on tie,
 * nodeId on tie).
 *
 * Exported so the Slice 4 chance-constrained variant in
 * `@procsim/simulation` can reuse the exact same candidate pool — both
 * algorithms share the deterministic-CPM critical-path detection and
 * delta-hours math; only the deadline-met check differs.
 */
export function pickBestStep(
  workingNodes: ReadonlyArray<ProjectNode>,
  result: ScheduleResult,
  calMap: Map<string, Calendar>,
  resourceMap: Map<string, Resource>,
  defaultCal: Calendar,
): CrashCandidate | null {
  let best: CrashCandidate | null = null;

  for (const node of workingNodes) {
    if (!node.crashOptions || node.crashOptions.length === 0) continue;
    const sched = result.nodes[node.id];
    if (!sched || !sched.onCriticalPath) continue;

    const cal = nodeEffectiveWorkingCalendar(node, calMap, defaultCal, resourceMap);
    const currentIdx = node.selectedCrashIndex;
    const currentHours = effectiveDurationHours(node, cal);
    const currentCost =
      currentIdx !== undefined && node.crashOptions[currentIdx]
        ? node.crashOptions[currentIdx].additionalCost
        : 0;

    for (let j = 0; j < node.crashOptions.length; j++) {
      if (j === currentIdx) continue;
      const opt = node.crashOptions[j];
      if (!opt) continue;
      // Build a "what-if J selected" view to ask the engine for the
      // hypothetical effective duration. exactOptionalPropertyTypes —
      // setting selectedCrashIndex explicitly to a number is fine.
      const hypothetical: ProjectNode = { ...node, selectedCrashIndex: j };
      const nextHours = effectiveDurationHours(hypothetical, cal);
      const deltaHours = currentHours - nextHours;
      // Must be a strict compression; ignore lateral / extending moves.
      if (deltaHours <= 0) continue;
      const daysSaved = deltaHours / cal.hoursPerDay;
      const addedCost = opt.additionalCost - currentCost;
      const perDay = addedCost / daysSaved;

      const candidate: CrashCandidate = {
        nodeId: node.id,
        fromIndex: currentIdx,
        toIndex: j,
        perDay,
        addedCost,
        deltaHours,
      };

      if (!best || isBetter(candidate, best)) {
        best = candidate;
      }
    }
  }

  return best;
}

/**
 * Tie-break: cheapest $/day wins; ties broken by deeper crash (larger
 * `deltaHours`); ultimate tie broken by `nodeId` ascending. The total
 * order is deterministic for fixed input.
 */
function isBetter(a: CrashCandidate, b: CrashCandidate): boolean {
  if (a.perDay !== b.perDay) return a.perDay < b.perDay;
  if (a.deltaHours !== b.deltaHours) return a.deltaHours > b.deltaHours;
  return a.nodeId < b.nodeId;
}
