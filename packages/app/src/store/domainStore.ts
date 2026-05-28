import { create } from 'zustand';
import { temporal } from 'zundo';
import type { TemporalState } from 'zundo';
import { useStore } from 'zustand';
import { useViewStore } from './viewStore.js';
import type {
  ProjectFile,
  ProjectNode,
  ProjectEdge,
  Calendar,
  CalendarPolicy,
  Loop,
  Subsystem,
  SubsystemFile,
  Scenario,
  Resource,
  ResourceAssignment,
  Distribution,
  Duration,
  DurationUnit,
  DurationSemantic,
  EdgeType,
  FixedCost,
  CrashOption,
  HolidayPresetId,
  Comment,
} from '@procsim/file-format';
import { LATEST_FX_SNAPSHOT_VERSION } from '@procsim/file-format';
import { toHours } from '@procsim/scheduler';
import {
  applyFxOverrides,
  convertAmount,
  getCalendarTemplate,
  latestPresetVersion,
  loadFxSnapshot,
} from '@procsim/file-format';

// workingDays in UI order: [Mon, Tue, Wed, Thu, Fri, Sat, Sun]
export type WorkingDaysUI = [boolean, boolean, boolean, boolean, boolean, boolean, boolean];

/** Convert UI-order (Mon=0…Sun=6) → schema order (Sun=0…Sat=6). */
function uiToSchemaWorkingDays(
  ui: WorkingDaysUI,
): [boolean, boolean, boolean, boolean, boolean, boolean, boolean] {
  return [ui[6], ui[0], ui[1], ui[2], ui[3], ui[4], ui[5]];
}

/** Convert schema order (Sun=0…Sat=6) → UI order (Mon=0…Sun=6). */
export function schemaToUiWorkingDays(
  schema: readonly [boolean, boolean, boolean, boolean, boolean, boolean, boolean],
): WorkingDaysUI {
  return [schema[1], schema[2], schema[3], schema[4], schema[5], schema[6], schema[0]];
}

// ── Phase 40 — calendar-swap toast helpers ────────────────────────────────────

/**
 * True when two calendars differ in the shape that affects time-semantic
 * duration conversion. Holiday set / exceptions / id / name are ignored —
 * they don't enter `toHours`.
 */
function shapeChanged(a: Calendar, b: Calendar): boolean {
  return a.hoursPerDay !== b.hoursPerDay || a.daysPerWeek !== b.daysPerWeek;
}

/** Time-semantic activity / decision nodes with a calendar-dependent unit. */
function isCalendarSensitiveTimeNode(n: ProjectNode): boolean {
  return (
    (n.nodeType === 'activity' || n.nodeType === 'decision') &&
    n.durationSemantic === 'time' &&
    n.duration.unit !== 'hours'
  );
}

/** Count of nodes that inherit the project default calendar. */
function countDefaultInheritingTimeNodes(nodes: ReadonlyArray<ProjectNode>): number {
  return nodes.filter((n) => n.calendarId === null && isCalendarSensitiveTimeNode(n)).length;
}

/**
 * Count of nodes whose effective calendar IS the one being mutated — either
 * a direct override (`calendarId === id`) or, when the mutated calendar is
 * the project default, an inherited reference (`calendarId === null`).
 */
function countCalendarBoundTimeNodes(
  nodes: ReadonlyArray<ProjectNode>,
  calendarId: string,
  isDefault: boolean,
): number {
  return nodes.filter((n) => {
    if (!isCalendarSensitiveTimeNode(n)) return false;
    if (n.calendarId === calendarId) return true;
    if (isDefault && n.calendarId === null) return true;
    return false;
  }).length;
}

/**
 * Phase 50 Slice 3 / audit C-18 — when the user is currently drilled
 * into a subsystem, append the new node's id to that subsystem's
 * `bodyNodeIds` so it's visible in the drill view. Without this, every
 * add action lands the node at the top-level project but the canvas
 * filters by `sub.bodyNodeIds` when drilled in (see App.tsx
 * `visibleNodeIds`) — so the new node renders nowhere even though the
 * naming callout fires.
 *
 * Identity-preserves when not drilled in OR when the leaf breadcrumb
 * references a since-deleted subsystem, so callers can pass through
 * `state.project.subsystems` unchanged in the common case.
 */
function appendToActiveSubsystem(
  subsystems: ProjectFile['subsystems'],
  newNodeId: string,
): ProjectFile['subsystems'] {
  const subsystemId = useViewStore.getState().breadcrumb.at(-1)?.subsystemId;
  if (!subsystemId) return subsystems;
  let mutated = false;
  const next = subsystems.map((s) => {
    if (s.id !== subsystemId) return s;
    mutated = true;
    return { ...s, bodyNodeIds: [...s.bodyNodeIds, newNodeId] };
  });
  return mutated ? next : subsystems;
}

/** Emit the standard "you may have meant effort-based" warning toast. */
function pushTimeScalingToast(affected: number, newCal: Calendar): void {
  const noun = affected === 1 ? 'time-based node' : 'time-based nodes';
  useViewStore.getState().pushToast({
    kind: 'warn',
    text:
      `${affected} ${noun} will scale to ${newCal.name}'s ` +
      `${newCal.hoursPerDay}h/day — switch them to effort-based if you ` +
      `want the work to stay constant.`,
  });
}

// ── Phase 42 — share rebalance helpers ────────────────────────────────────────

/**
 * Scale a vector of non-negative values to a target sum and round each entry
 * to the nearest integer, then absorb the rounding remainder by ±1 on the
 * entries with the largest fractional drift so the resulting integers sum
 * *exactly* to `targetSum`. Used by the share editor / share-mode toggle to
 * keep `sum(shares) === 100` after auto-rebalance in percentage mode.
 *
 * `targetSum` is typically 100. When the input sums to 0 the function
 * returns the input untouched (no division-by-zero, no fabricated values).
 */
export function rebalanceSharesToTarget(
  values: ReadonlyArray<number>,
  targetSum: number,
): number[] {
  const current = values.reduce((s, v) => s + v, 0);
  if (current <= 0) return values.slice();
  const fractional = values.map((v) => (v / current) * targetSum);
  const rounded = fractional.map((v) => Math.round(v));
  let remainder = targetSum - rounded.reduce((s, v) => s + v, 0);
  // Distribute the remainder ±1 to entries with the largest fractional drift,
  // so no single value gets shifted more than necessary.
  const drifts = fractional.map((v, i) => ({ i, drift: v - rounded[i]! }));
  drifts.sort((a, b) => (remainder > 0 ? b.drift - a.drift : a.drift - b.drift));
  for (let k = 0; k < drifts.length && remainder !== 0; k++) {
    rounded[drifts[k]!.i]! += remainder > 0 ? 1 : -1;
    remainder += remainder > 0 ? -1 : 1;
  }
  return rounded;
}

// ── Cost-field invariant helpers (Phase 19) ───────────────────────────────────

/**
 * Phase 19 slice 4 follow-up — convert every numeric cost field in a project
 * by `factor`. Used when the user changes `project.currency`: the engine
 * works in plain numbers, so a currency change means a one-time bulk
 * conversion of stored amounts.
 *
 * Touches:
 *   - `project.budget`
 *   - every `resource.costRate` / `resource.costPerUse`
 *   - every `node.fixedCost.value` plus every numeric parameter inside
 *     its `fixedCost.distribution` (min / mode / max for triangular and
 *     pert-beta; mean / stddev for normal).
 *
 * `factor` is "new currency per 1 unit of old currency". Computed by the
 * caller via the FX snapshot (with overrides).
 *
 * Returns the same project reference when no cost fields are populated so
 * Zundo's reference-equality short-circuit doesn't push a no-op history
 * entry.
 */
function convertCostFields(project: ProjectFile, factor: number): ProjectFile {
  if (!isFinite(factor) || factor <= 0) return project;
  let changed = false;

  const nextResources = project.resources.map((r): Resource => {
    let touched = false;
    const next: Resource = { ...r };
    if (next.costRate !== undefined) {
      next.costRate = next.costRate * factor;
      touched = true;
    }
    if (next.costPerUse !== undefined) {
      next.costPerUse = next.costPerUse * factor;
      touched = true;
    }
    if (touched) changed = true;
    return next;
  });

  const nextNodes = project.nodes.map((n): ProjectNode => {
    if (n.fixedCost === undefined) return n;
    changed = true;
    const fc = n.fixedCost;
    const dist = fc.distribution;
    let scaledDist: typeof dist;
    if (dist === undefined) {
      scaledDist = undefined;
    } else if (dist.type === 'triangular' || dist.type === 'pert-beta') {
      scaledDist = {
        type: dist.type,
        min: dist.min * factor,
        mode: dist.mode * factor,
        max: dist.max * factor,
      };
    } else {
      // normal
      scaledDist = {
        type: 'normal',
        mean: dist.mean * factor,
        stddev: dist.stddev * factor,
      };
    }
    return {
      ...n,
      fixedCost:
        scaledDist !== undefined
          ? { value: fc.value * factor, distribution: scaledDist }
          : { value: fc.value * factor },
    };
  });

  let nextProject = project;
  if (project.budget !== undefined) {
    changed = true;
    nextProject = { ...project, budget: project.budget * factor };
  }
  if (!changed) return project;
  return { ...nextProject, resources: nextResources, nodes: nextNodes };
}

/**
 * Drop `fixedCostOnce` from any node that is no longer a member of any loop's
 * bodyNodeIds. The file-format schema enforces this at parse time; the store
 * keeps the invariant on every mutation that could orphan a body node
 * (loop deletion, body-shrink-to-empty, paste-out-of-loop, etc).
 *
 * Returns the same project reference when no changes are needed — preserves
 * Zundo's reference-equality short-circuit so this helper is safe to call
 * unconditionally after any loop / paste mutation.
 */
function dropOrphanFixedCostOnce(project: ProjectFile): ProjectFile {
  const inSomeLoop = new Set(project.loops.flatMap((l) => l.bodyNodeIds));
  let changed = false;
  const nodes = project.nodes.map((n) => {
    if (n.fixedCostOnce === undefined) return n;
    if (inSomeLoop.has(n.id)) return n;
    changed = true;
    const { fixedCostOnce: _x, ...rest } = n;
    return rest;
  });
  return changed ? { ...project, nodes } : project;
}

// ── Default project loaded on first run ───────────────────────────────────────

export function makeDefaultProject(): ProjectFile {
  return {
    kind: 'caladia-project' as const,
    version: 8,
    currency: 'USD',
    fxSnapshotVersion: LATEST_FX_SNAPSHOT_VERSION,
    project: {
      name: 'My Process',
      startDate: new Date().toISOString().slice(0, 10),
      defaultCalendarId: 'cal-default',
      displayUnit: 'days',
      shareMode: 'percentage',
    },
    calendars: [
      {
        id: 'cal-default',
        name: 'Standard (Mon–Fri)',
        workingDays: [false, true, true, true, true, true, false],
        hoursPerDay: 8,
        daysPerWeek: 5,
        holidayPreset: 'US_FEDERAL',
        holidayPresetVersion: latestPresetVersion('US_FEDERAL'),
        exceptions: [],
      },
      {
        id: 'cal-weekend',
        name: 'Weekend (Sat–Sun)',
        workingDays: [true, false, false, false, false, false, true],
        hoursPerDay: 8,
        daysPerWeek: 2,
        holidayPreset: 'NONE',
        holidayPresetVersion: '',
        exceptions: [],
      },
    ],
    resources: [],
    nodes: [
      {
        id: 'activity-1',
        nodeType: 'activity',
        name: 'Activity 1',
        duration: { value: 8, unit: 'hours' },
        durationSemantic: 'time',
        position: { x: 200, y: 150 },
        calendarId: null,
        consumesResources: true,
        resourceAssignments: [],
      },
    ],
    edges: [],
    loops: [],
    subsystems: [],
    scenarios: [],
    comments: [],
    groupColors: {},
  };
}

// ── Store interface ───────────────────────────────────────────────────────────

export interface DomainState {
  project: ProjectFile;

  /**
   * Phase 37 Slice 2 — human-readable description of the most recent
   * authored action. Snapshotted alongside `project` by zundo so undo /
   * redo can surface a toast naming what was rolled back. Actions
   * populate this inside the same `set()` call that mutates `project`,
   * so the label is atomic with the state change. `null` until any
   * action has run; toast emitters fall back to a generic label.
   */
  lastIntent: string | null;

  // Node actions
  updateNodeName(nodeId: string, name: string): void;
  updateNodeDuration(nodeId: string, value: number, unit: DurationUnit): void;
  /**
   * Phase 40 — switch a node's `durationSemantic` between `'effort'` and
   * `'time'`. Preserves the underlying hours: e.g. a 5-day time-based node
   * on a 996 calendar (60h) becomes 7.5 effort-days (still 60h), and a
   * 5-day effort-based node (40h) becomes 3.33 time-days on 996 (still 40h).
   * The unit is preserved (so the user keeps reading their familiar unit);
   * the value adapts. failureDelay shares the node's semantic and is
   * converted in the same pass.
   */
  updateNodeDurationSemantic(nodeId: string, semantic: DurationSemantic): void;
  updateNodePosition(nodeId: string, position: { x: number; y: number }): void;
  /**
   * Phase 45 Slice 5c — returns the newly-created node's id so callers
   * (e.g. the placement-drop path) can immediately hand it off to the
   * quick-name callout. Pre-5c callers ignoring the return value are
   * unaffected.
   */
  addNode(position: { x: number; y: number }): string;
  // Phase 10 Tier 1 — typed entry/terminus anchors (zero-duration).
  // `anchorDate` is optional on Start; if omitted, defaults to today (YYYY-MM-DD, local).
  addStartNode(position: { x: number; y: number }, anchorDate?: string): string;
  addEndNode(position: { x: number; y: number }): string;
  // Phase 11 — Decision node: activity-shaped gate with pass probability and
  // optional failure-delay surcharge.
  addDecisionNode(position: { x: number; y: number }): string;
  /**
   * Phase 49 Slice 4 — wire-on-place. Append a new activity / decision node
   * plus N incoming FS edges from `sourceNodeIds`, all in a single domain
   * commit so one undo reverts the whole drop. The edges match the shape
   * produced by `connectNodes` (type `'FS'`, `lag { value: 0, unit: 'hours' }`).
   * Empty `sourceNodeIds` is equivalent to plain `addNode` / `addDecisionNode`
   * (no dangling-edge invariant work needed). Returns the new node's id so
   * the placement caller can hand off to `startNaming`.
   */
  addNodeWithIncomingEdges(
    type: 'activity' | 'decision',
    position: { x: number; y: number },
    sourceNodeIds: ReadonlyArray<string>,
  ): string;
  /** Set a decision node's pass probability ∈ [0, 1]. Clamped at the call site. */
  updateNodePassProbability(nodeId: string, p: number): void;
  /** Set a decision node's failure-delay surcharge. Pass `undefined` to clear. */
  updateNodeFailureDelay(nodeId: string, delay: Duration | undefined): void;
  /**
   * Phase 33 — set or clear an activity/decision node's manual
   * resource-leveling priority. Pass `undefined` to drop the field
   * (destructure-rebuild for exactOptionalPropertyTypes). Silent no-op
   * on anchor / subsystem nodes — the schema refine rejects those
   * combinations and the Inspector never wires the input for them.
   */
  setNodeLevelPriority(nodeId: string, priority: number | undefined): void;
  /** Set or clear a Start node's anchor date (YYYY-MM-DD). Pass `undefined` to clear. */
  updateNodeAnchorDate(nodeId: string, anchorDate: string | undefined): void;
  /**
   * Phase 19 — set or clear an activity/decision node's fixedCost.
   * Pass `undefined` to drop the field entirely (clean save).
   */
  updateNodeFixedCost(nodeId: string, fixedCost: FixedCost | undefined): void;
  /**
   * Phase 19 — set or clear a body-node's fixedCostOnce flag (only meaningful
   * inside a loop body). The schema rejects a `true` value outside a loop body;
   * the store also drops the field automatically when a node leaves its loop.
   */
  updateNodeFixedCostOnce(nodeId: string, value: boolean | undefined): void;
  deleteNodes(nodeIds: ReadonlyArray<string>): void;

  // ── Phase 49 Slice 3 — free-floating canvas comments ───────────────────
  /**
   * Drop a new comment at the given flow-space position. Returns the new
   * id so the caller can route the just-created node into edit mode.
   * Comments start with empty text — the CommentNode renderer mounts
   * with `initialEditing: true` and removes the comment on first blur
   * if the user never typed anything.
   */
  addComment(position: { x: number; y: number }): string;
  /** Replace a comment's text. Caller is responsible for trim semantics. */
  updateComment(commentId: string, text: string): void;
  /** Update a comment's position (called from onNodesChange when the
   *  React Flow drag commits). */
  moveComment(commentId: string, position: { x: number; y: number }): void;
  /** Remove a comment. Idempotent — no-op if the id is unknown. */
  deleteComment(commentId: string): void;
  pasteNodes(
    nodes: ReadonlyArray<ProjectNode>,
    offset: { x: number; y: number },
  ): ReadonlyArray<string>;

  updateNodeSize(nodeId: string, width: number, height: number): void;
  updateNodeColor(nodeId: string, color: string | undefined): void;
  updateNodeGroup(nodeId: string, group: string | undefined): void;
  updateNodeDescription(nodeId: string, description: string | undefined): void;
  updateNodeDistribution(nodeId: string, dist: Distribution | undefined): void;
  setNodeResourceAssignments(nodeId: string, assignments: ReadonlyArray<ResourceAssignment>): void;

  // Phase 18 slice 1 — granular multi-resource assignment actions.
  //
  // These exist alongside setNodeResourceAssignments (which still works for
  // bulk replacement) and let the inspector + Reassign flows author and
  // edit individual assignments without rewriting the whole array. Each
  // action lands as one undo step except updateResourceAssignmentCount,
  // which is wrapped in the existing beginEdit/commitEdit discipline by
  // its caller so per-keystroke count edits coalesce within a focus
  // session — the same pattern as updateNodeName.
  /**
   * Append a new assignment to the node's resourceAssignments. Silent
   * no-op if the node already has an assignment for `assignment.resourceId`
   * (duplicate prevention) or if the node id is unknown.
   */
  addResourceAssignment(nodeId: string, assignment: ResourceAssignment): void;
  /**
   * Update the `count` of the assignment for `(nodeId, resourceId)`. Caller
   * is expected to wrap repeated calls in beginEdit/commitEdit; per-call
   * commits would push one history entry per keystroke. Silent no-op when
   * count < 1, the node has no assignment for resourceId, or the node is
   * unknown.
   */
  updateResourceAssignmentCount(nodeId: string, resourceId: string, count: number): void;
  /**
   * Remove the assignment for `(nodeId, resourceId)`. Silent no-op when
   * the assignment doesn't exist.
   */
  removeResourceAssignment(nodeId: string, resourceId: string): void;
  /**
   * Phase 18 slice 2 — Change the `calendarPolicy` on an existing
   * assignment. Single undo step; emitted by the inspector's per-row
   * policy <select>. Silent no-op when the assignment doesn't exist.
   */
  updateResourceAssignmentPolicy(nodeId: string, resourceId: string, policy: CalendarPolicy): void;
  /**
   * Phase 23 slice 1 — Set the parallelism coefficient (0..1) on an
   * existing assignment. Pass `undefined` to remove the field; the
   * inspector's "Off" segmented state stores 0 explicitly. Engine math
   * lands in slice 2 — until then this is a stored-only field.
   */
  updateResourceAssignmentParallelism(
    nodeId: string,
    resourceId: string,
    parallelism: number | undefined,
  ): void;
  /**
   * Phase 42 — set a single assignment's `share` value directly. NO
   * auto-rebalance — the inspector validates the running sum in
   * percentage mode and surfaces the delta to the user, who fixes
   * it manually. Caller is expected to wrap repeated edits in
   * beginEdit/commitEdit (matches `updateResourceAssignmentCount`).
   * Silent no-op when the assignment doesn't exist.
   */
  setAssignmentShare(nodeId: string, resourceId: string, share: number): void;
  /**
   * Phase 42 — seed every assignment on the node with an equal share.
   * In percentage mode the seeded values sum to exactly 100 (integer
   * rounding via `rebalanceSharesToTarget`); in weight mode each
   * assignment is seeded with `1`. Single undo step. No-op when the
   * node has no assignments OR when shares are already set on every
   * assignment (avoid clobbering author-set splits).
   */
  initialiseEqualShares(nodeId: string): void;
  /**
   * Phase 42 — drop `share` from every assignment on the node,
   * reverting to legacy "each pool does the full baseHours" mode.
   * Single undo step.
   */
  clearAllShares(nodeId: string): void;
  /**
   * Phase 42 — reset all assignments on the node to an equal share,
   * even if shares are already set. Differs from `initialiseEqualShares`
   * which is a no-op when shares already exist. Surfaced by the
   * inspector's "Distribute evenly" button.
   */
  distributeSharesEvenly(nodeId: string): void;
  /**
   * Convenience used by the Reassign-as-split UX (Phase 18 slice 3): move
   * `count` units of `from` to `to` on a single node. Decrements from's
   * count by N; creates (or grows) to's assignment by N. If from's count
   * hits 0, removes the from assignment entirely. Single undo step
   * restores both sides. Silent no-op for invalid arguments (from === to,
   * count <= 0, count > from.count, from not on this node).
   */
  splitResourceAssignment(
    nodeId: string,
    fromResourceId: string,
    toResourceId: string,
    count: number,
  ): void;

  // ── Phase 25: activity crashing ──────────────────────────────────────────
  /**
   * Append a new crash option to a node. The Inspector calls this with a
   * sensible starting `duration` (always strictly less than the node's
   * nominal duration, in the node's unit) and `additionalCost: 0`. The
   * caller is responsible for keeping `duration.unit === node.duration.unit`
   * and `duration.value < node.duration.value` — the Zod schema rejects
   * violations at save time. Silent no-op if the node doesn't exist or is
   * not an activity / decision node.
   */
  addCrashOption(nodeId: string, option: CrashOption): void;
  /**
   * Replace a single crash option in place. Silent no-op when `nodeId`
   * doesn't exist or `index` is out of range. The selectedCrashIndex is
   * preserved across edits.
   */
  updateCrashOption(nodeId: string, index: number, option: CrashOption): void;
  /**
   * Remove the crash option at `index`. If the removed entry was the
   * currently-selected one, `selectedCrashIndex` is cleared (back to
   * "no crash"). If a later entry was selected, its index shifts down
   * by one to keep the same option selected. Removes the `crashOptions`
   * array entirely when the last entry is deleted (destructure-rebuild,
   * matches the exactOptionalPropertyTypes pattern used elsewhere).
   */
  removeCrashOption(nodeId: string, index: number): void;
  /**
   * Set or clear the active crash selection. Pass `undefined` to revert to
   * the nominal duration / cost. The Zod schema rejects an index that
   * doesn't reference a valid `crashOptions` entry; callers must keep this
   * invariant.
   */
  selectCrashOption(nodeId: string, index: number | undefined): void;
  /**
   * Phase 25 Slice 3 — apply a bulk plan returned by `greedyCrash`. Walks
   * the plan's steps and writes each `selectedCrashIndex` in a single
   * Zundo history entry so the user's Undo reverts the whole batch.
   *
   * When `resetFirst` is true the action clears any pre-existing
   * `selectedCrashIndex` on EVERY node before applying the plan (matches
   * the modal's "Reset all crashes first" checkbox UX). Defaults to
   * false — the greedy already extends current selections by design, so
   * the apply path normally just stamps the picked steps.
   */
  applyCrashPlan(
    plan: { steps: Array<{ nodeId: string; toIndex: number }> },
    options?: { resetFirst?: boolean },
  ): void;

  // Resource actions — workingDays in UI order [Mon…Sun]
  addResource(opts: {
    name: string;
    capacity: number;
    workingDays: WorkingDaysUI;
    hoursPerDay: number;
    /** Phase 19 — optional cost fields. Absent ≡ zero. */
    costRate?: number;
    costPerUse?: number;
    /** Phase 29 — optional Monte Carlo rate distribution. */
    hourlyRateDistribution?: Distribution;
    /** Phase 33 Slice 2 — optional ISO 4217 currency override. */
    currencyOverride?: string;
  }): void;
  updateResource(
    id: string,
    name: string,
    capacity: number,
    workingDays: WorkingDaysUI,
    hoursPerDay: number,
    /** Phase 19 — optional cost fields. Pass `undefined` to clear. */
    costRate?: number,
    costPerUse?: number,
    /** Phase 29 — optional Monte Carlo rate distribution. Pass `undefined` to clear. */
    hourlyRateDistribution?: Distribution,
    /** Phase 33 Slice 2 — optional ISO 4217 currency override. Pass `undefined` to clear. */
    currencyOverride?: string,
  ): void;
  /**
   * Phase 17 — Bump a resource's capacity in isolation, without touching
   * its working days or hours-per-day. Used by the conflict card's
   * "Increase capacity" flow as a single undo step.
   */
  setResourceCapacity(id: string, capacity: number): void;
  /**
   * Phase 29 — set or clear the optional `hourlyRateDistribution` on a
   * resource. Pass `undefined` to drop the field entirely (destructure-
   * rebuild for exactOptionalPropertyTypes). The simulation engine
   * samples from this distribution per iteration via a dedicated
   * per-resource sub-stream; deterministic scheduling continues to use
   * `costRate`.
   */
  updateResourceHourlyRateDistribution(id: string, dist: Distribution | undefined): void;
  deleteResource(id: string): void;

  // Edge actions
  connectNodes(source: string, target: string): void;
  deleteEdges(edgeIds: ReadonlyArray<string>): void;
  updateEdgeType(edgeId: string, type: EdgeType): void;
  updateEdgeLag(edgeId: string, value: number, unit: DurationUnit): void;
  /**
   * Phase 17 — Bulk-apply an auto-leveling plan as a single undo step.
   * For each `{ edgeId, addedHours }` entry, the edge's existing lag is
   * normalised to hours and bumped by `addedHours`. Edges not in the map
   * are untouched.
   */
  applyEdgeLagBumps(bumps: Readonly<Record<string, number>>): void;

  // Loop actions
  addLoop(nodeIds: ReadonlyArray<string>): string;
  deleteLoop(loopId: string): void;
  updateLoopKickout(loopId: string, kickout: Loop['kickout']): void;
  updateLoopExpectedIterations(loopId: string, dist: Distribution): void;
  updateLoopGroup(loopId: string, group: string | undefined): void;
  updateLoopDescription(loopId: string, description: string | undefined): void;

  // Scenario actions
  addScenario(name: string, seed: number): string;
  deleteScenario(id: string): void;
  updateScenarioName(id: string, name: string): void;
  setScenarioSeed(id: string, seed: number): void;
  /** Set or update the duration override for a node within a scenario. */
  setScenarioNodeDuration(scenarioId: string, nodeId: string, duration: Duration): void;
  /** Remove all overrides for a node from a scenario. */
  deleteScenarioNodeOverride(scenarioId: string, nodeId: string): void;

  // Sub-system actions (Phase 12)
  /**
   * Wrap the given node IDs into a sub-system.
   * Returns an error message string on validation failure, or null on success.
   *
   * Requirements:
   *  - At least 2 nodes.
   *  - No node already belongs to a sub-system body.
   *  - Exactly one body node has external incoming edges (→ entryNodeId).
   *  - Exactly one body node has external outgoing edges (→ exitNodeId).
   *    If the selection is isolated (no external edges), the leftmost node by
   *    x-position is entry; the rightmost is exit.
   */
  wrapSelectedAsSubsystem(nodeIds: ReadonlyArray<string>): string | null;
  /** Remove the sub-system wrapper, rewiring edges back to body nodes. */
  unwrapSubsystem(subsystemId: string): void;
  /** Update the display name on a subsystem's container node. */
  updateSubsystemName(subsystemId: string, name: string): void;
  /**
   * Collect the body nodes/edges/loops for a sub-system and return a
   * SubsystemFile ready for download.  Returns null if the subsystem does
   * not exist.
   */
  buildSubsystemFile(subsystemId: string): import('@procsim/file-format').SubsystemFile | null;
  /**
   * Import a validated SubsystemFile into the project as a new sub-system,
   * placing the container at `position`.  Provenance metadata is stored in
   * `Subsystem.source` when `sourceMeta` is provided.
   * Returns an error string on failure, or null on success.
   */
  importSubsystemFromFile(
    subsystem: import('@procsim/file-format').SubsystemFile,
    position: { x: number; y: number },
    sourceMeta?: import('@procsim/file-format').SubsystemSource,
  ): string | null;

  // Bulk
  setProject(project: ProjectFile): void;
  /** Apply a batch of node positions as a single undo step (used by auto-layout). */
  updateNodePositions(positions: Record<string, { x: number; y: number }>): void;

  // ── Project settings (Phase 19 slice 3) ────────────────────────────────────
  //
  // No project-level setting UI existed pre-Phase-19; the `project.startDate`,
  // `project.name`, and the new `project.budget` were only editable by hand-
  // editing the .cala JSON. These three actions back the Project Settings
  // modal in the Caladia ▾ dropdown.

  /** Rename the project. */
  updateProjectName(name: string): void;
  /** Update the project's global start date (YYYY-MM-DD). */
  updateProjectStartDate(date: string): void;
  /**
   * Phase 42 — switch the project's resource-share rendering / validation
   * mode. Going `weight → percentage` normalises any existing shares to
   * integer percentages summing to 100 (round-to-nearest with a single
   * "absorbing" entry to fix rounding remainder). Going
   * `percentage → weight` is identity — the stored values are already
   * valid weights. No-op when the requested mode equals the current one.
   *
   * The conversion happens in a single labelled action so undo restores
   * both the previous mode AND the previous share values.
   */
  updateProjectShareMode(mode: 'percentage' | 'weight'): void;
  /**
   * Pick which calendar in `project.calendars` is the project default.
   * No-op when the id doesn't match an existing calendar; the dropdown
   * in ProjectSettingsModal is the only authored caller.
   */
  updateProjectDefaultCalendarId(calendarId: string): void;
  /**
   * Change a calendar's holiday preset (and re-pin its
   * `holidayPresetVersion` to the latest bundled version for that preset,
   * matching seed-time behaviour). No-op when the calendarId or preset
   * is unknown. Mutates only the named calendar — peers are left alone.
   */
  updateCalendarHolidayPreset(calendarId: string, preset: HolidayPresetId): void;
  /**
   * Apply a work-schedule template (CALENDAR_TEMPLATES) to a calendar.
   * Overwrites `workingDays` / `hoursPerDay` / `daysPerWeek`, and also
   * renames the calendar to the template's `label` so the displayed name
   * stays in sync with the schedule across the Resource / Node calendar
   * pickers. `holidayPreset` / `holidayPresetVersion` / `exceptions` are
   * left alone; the calendar's id is unchanged so any per-node /
   * per-resource bindings continue to resolve. No-op when either id is
   * unknown.
   */
  applyCalendarTemplate(calendarId: string, templateId: string): void;
  /**
   * Set or clear the node's per-node calendar override. `null` means
   * "inherit the project's default calendar" (the typical case). A non-null
   * id must reference an existing calendar in `project.calendars`; if it
   * doesn't, the action is a no-op. Only meaningful on activity / decision
   * nodes — start / end anchors are zero-duration and ignore the field
   * during scheduling.
   */
  updateNodeCalendarId(nodeId: string, calendarId: string | null): void;
  /**
   * Phase 41 — assign a node to a calendar produced from a work-schedule
   * template (CALENDAR_TEMPLATES). Materialise-on-first-pick semantics:
   *   - If a project calendar already shape-matches the template
   *     (same `workingDays` / `hoursPerDay` / `daysPerWeek`), reuse it.
   *   - Otherwise create one (auto-generated id, `name = template.label`,
   *     `holidayPreset = 'NONE'`, no exceptions) and add it to
   *     `project.calendars`, then assign.
   * No-op when the templateId is unknown or the node doesn't exist.
   */
  setNodeCalendarFromTemplate(nodeId: string, templateId: string): void;
  /**
   * Point a resource at a different calendar. The new id must reference
   * an existing calendar in `project.calendars`; if it doesn't, the action
   * is a no-op. The previous calendar (often an auto-generated private one
   * named `[Resource] — schedule`) is left untouched in the calendars
   * array — orphan-cleanup is a separate concern.
   */
  updateResourceCalendarId(resourceId: string, calendarId: string): void;
  /** Set / clear the project budget. Pass `undefined` to clear. */
  updateProjectBudget(amount: number | undefined): void;
  /**
   * Backlog Slice 6 / audit I-18 — set the persisted color override for a
   * named group. Color must be `#rrggbb` (lowercase hex). Setting an override
   * causes the group's auto-palette fallback (utils/groupColors.ts) to be
   * skipped in favour of this value across all node renderers and the
   * Gantt swimlane tint. Persists in the project schema → survives reload
   * and flows through the temporal undo stack.
   */
  updateGroupColor(groupName: string, color: string): void;
  /** Phase 19 slice 4 — re-pin the project's `fxSnapshotVersion` to a newer
   *  bundled snapshot (called from the FX update banner's Accept button). */
  updateProjectFxSnapshotVersion(version: string): void;
  /**
   * Phase 19 slice 4 follow-up — change the project's base currency, applying
   * the current FX snapshot (with overrides) to convert every stored cost
   * value to the new currency: resource costRate / costPerUse, node
   * fixedCost.value + distribution params, and project budget. No-op when
   * the snapshot can't convert the pair (e.g. project pinned to 'NONE' or
   * either currency missing from rates) — the UI guards on that before
   * calling this action.
   */
  updateProjectCurrency(newCurrency: string): void;
  /**
   * Phase 19 slice 4 follow-up — set or clear a per-currency FX rate
   * override. The value is in foreign-per-USD-base (same convention as the
   * snapshot). Pass `undefined` to drop the override (revert to snapshot).
   */
  updateProjectFxRateOverride(code: string, value: number | undefined): void;
}

// ── Store (wrapped with Zundo `temporal`) ─────────────────────────────────────

export const useDomainStore = create<DomainState>()(
  temporal(
    (set) => ({
      project: makeDefaultProject(),
      lastIntent: null,

      updateNodeName(nodeId, name) {
        set((state) => ({
          lastIntent: 'Renamed node',
          project: {
            ...state.project,
            nodes: state.project.nodes.map((n) => (n.id === nodeId ? { ...n, name } : n)),
          },
        }));
      },

      updateNodeDuration(nodeId, value, unit) {
        set((state) => ({
          lastIntent: 'Changed node duration',
          project: {
            ...state.project,
            nodes: state.project.nodes.map((n) =>
              n.id === nodeId ? { ...n, duration: { value, unit } } : n,
            ),
          },
        }));
      },

      // Phase 40 — flip a node's duration semantic between 'effort' (canonical
      // 8h/day, 5d/wk, calendar-independent) and 'time' (calendar-relative).
      // Preserves the underlying hours so that what the user just saw on the
      // canvas / Gantt remains true. The unit is kept; only the numeric value
      // is rebased. failureDelay (decision-only) is converted in the same
      // pass since it shares the node's semantic.
      updateNodeDurationSemantic(nodeId, semantic) {
        commitEdit();
        set((state) => {
          const node = state.project.nodes.find((n) => n.id === nodeId);
          if (!node || node.durationSemantic === semantic) return state;

          // The "calendar the user sees in the Inspector" is the node's own
          // calendar (or the project default if `calendarId` is null).
          // Resource-aware folding (used by the scheduler for wall-clock)
          // would be surprising here — a user clicking the toggle expects
          // the visible duration to anchor on their primary calendar.
          const cal: Calendar | undefined =
            node.calendarId === null
              ? state.project.calendars.find(
                  (c) => c.id === state.project.project.defaultCalendarId,
                )
              : state.project.calendars.find((c) => c.id === node.calendarId);
          if (!cal) return state; // dangling calendarId — schema validates elsewhere

          // Preserve hours across the switch. Hours unit is identity under
          // both semantics, so the value is unchanged in that case.
          const convertValue = (d: { value: number; unit: DurationUnit }): number => {
            if (d.unit === 'hours') return d.value;
            const hrs = toHours(d, cal, node.durationSemantic);
            const perUnit = toHours({ value: 1, unit: d.unit }, cal, semantic);
            return hrs / perUnit;
          };

          const nextDuration: Duration = {
            value: convertValue(node.duration),
            unit: node.duration.unit,
          };
          const nextFailureDelay: Duration | undefined = node.failureDelay
            ? { value: convertValue(node.failureDelay), unit: node.failureDelay.unit }
            : undefined;

          const label =
            semantic === 'effort'
              ? 'Switched to effort-based duration'
              : 'Switched to time-based duration';

          return {
            lastIntent: label,
            project: {
              ...state.project,
              nodes: state.project.nodes.map((n): ProjectNode => {
                if (n.id !== nodeId) return n;
                const base = { ...n, durationSemantic: semantic, duration: nextDuration };
                if (nextFailureDelay !== undefined) {
                  return { ...base, failureDelay: nextFailureDelay };
                }
                return base;
              }),
            },
          };
        });
      },

      updateNodePosition(nodeId, position) {
        commitEdit();
        set((state) => ({
          lastIntent: 'Moved node',
          project: {
            ...state.project,
            nodes: state.project.nodes.map((n) => (n.id === nodeId ? { ...n, position } : n)),
          },
        }));
      },

      updateNodeSize(nodeId, width, height) {
        commitEdit();
        set((state) => ({
          lastIntent: 'Resized node',
          project: {
            ...state.project,
            nodes: state.project.nodes.map((n) => (n.id === nodeId ? { ...n, width, height } : n)),
          },
        }));
      },

      updateNodeGroup(nodeId, group) {
        commitEdit();
        set((state) => ({
          lastIntent: 'Changed node group',
          project: {
            ...state.project,
            nodes: state.project.nodes.map((n): ProjectNode => {
              if (n.id !== nodeId) return n;
              const { group: _g, ...rest } = n;
              return group !== undefined ? { ...rest, group } : rest;
            }),
          },
        }));
      },

      updateNodeDescription(nodeId, description) {
        set((state) => ({
          lastIntent: 'Edited node description',
          project: {
            ...state.project,
            nodes: state.project.nodes.map((n): ProjectNode => {
              if (n.id !== nodeId) return n;
              const { description: _d, ...rest } = n;
              return description !== undefined ? { ...rest, description } : rest;
            }),
          },
        }));
      },

      updateNodeColor(nodeId, color) {
        commitEdit();
        set((state) => ({
          lastIntent: 'Changed node color',
          project: {
            ...state.project,
            nodes: state.project.nodes.map((n): ProjectNode => {
              if (n.id !== nodeId) return n;
              const { color: _c, ...rest } = n;
              return color !== undefined ? { ...rest, color } : rest;
            }),
          },
        }));
      },

      updateNodeDistribution(nodeId, dist) {
        commitEdit();
        set((state) => ({
          lastIntent: 'Edited node distribution',
          project: {
            ...state.project,
            nodes: state.project.nodes.map((n): ProjectNode => {
              if (n.id !== nodeId) return n;
              const { distribution: _d, ...rest } = n;
              return dist !== undefined ? { ...rest, distribution: dist } : rest;
            }),
          },
        }));
      },

      addNode(position) {
        commitEdit();
        const newNode: ProjectNode = {
          id: crypto.randomUUID(),
          nodeType: 'activity',
          name: 'New Activity',
          duration: { value: 8, unit: 'hours' },
          // Phase 40 — activity nodes default to effort semantics so adopting
          // a more intense calendar compresses wall-clock instead of inflating
          // effort. Decision / anchor nodes still default to 'time' because
          // they typically model elapsed periods (gate reviews, regulatory
          // waits) where the calendar IS the clock.
          durationSemantic: 'effort',
          position,
          calendarId: null,
          consumesResources: true,
          resourceAssignments: [],
        };
        set((state) => ({
          lastIntent: 'Added activity',
          project: {
            ...state.project,
            nodes: [...state.project.nodes, newNode],
            subsystems: appendToActiveSubsystem(state.project.subsystems, newNode.id),
          },
        }));
        return newNode.id;
      },

      // Phase 10 Tier 1 — Start node: zero-duration entry anchor.
      // Single-Start enforcement is a UI-level non-blocking warning, not a
      // hard error here, so legacy or malformed graphs still load.
      // `anchorDate` defaults to today's local date (YYYY-MM-DD) so the user sees
      // an explicit value in the property panel and can edit it directly.
      addStartNode(position, anchorDate) {
        commitEdit();
        const today = new Date().toISOString().slice(0, 10);
        const newNode: ProjectNode = {
          id: crypto.randomUUID(),
          nodeType: 'start',
          name: 'Start',
          duration: { value: 0, unit: 'hours' },
          durationSemantic: 'time',
          position,
          calendarId: null,
          consumesResources: false,
          resourceAssignments: [],
          anchorDate: anchorDate ?? today,
        };
        set((state) => ({
          lastIntent: 'Added start',
          project: {
            ...state.project,
            nodes: [...state.project.nodes, newNode],
            subsystems: appendToActiveSubsystem(state.project.subsystems, newNode.id),
          },
        }));
        return newNode.id;
      },

      // Phase 10 Tier 1 — set or clear a Start node's anchorDate.
      // Stored as YYYY-MM-DD; pass `undefined` to drop the property entirely
      // (under exactOptionalPropertyTypes the field must be absent, not undefined).
      updateNodeAnchorDate(nodeId, anchorDate) {
        commitEdit();
        set((state) => ({
          lastIntent: 'Set anchor date',
          project: {
            ...state.project,
            nodes: state.project.nodes.map((n): ProjectNode => {
              if (n.id !== nodeId) return n;
              const { anchorDate: _a, ...rest } = n;
              return anchorDate !== undefined ? { ...rest, anchorDate } : rest;
            }),
          },
        }));
      },

      // Phase 10 Tier 1 — End node: zero-duration completion anchor.
      addEndNode(position) {
        commitEdit();
        const newNode: ProjectNode = {
          id: crypto.randomUUID(),
          nodeType: 'end',
          name: 'End',
          duration: { value: 0, unit: 'hours' },
          durationSemantic: 'time',
          position,
          calendarId: null,
          consumesResources: false,
          resourceAssignments: [],
        };
        set((state) => ({
          lastIntent: 'Added end',
          project: {
            ...state.project,
            nodes: [...state.project.nodes, newNode],
            subsystems: appendToActiveSubsystem(state.project.subsystems, newNode.id),
          },
        }));
        return newNode.id;
      },

      // Phase 11 — Decision node: activity-shaped gate with pass probability
      // and a failure-delay surcharge. Defaults to 50/50 with no extra delay
      // so users immediately see how the parameter behaves in the schedule.
      addDecisionNode(position) {
        commitEdit();
        const newNode: ProjectNode = {
          id: crypto.randomUUID(),
          nodeType: 'decision',
          name: 'Decision',
          duration: { value: 4, unit: 'hours' },
          durationSemantic: 'time',
          position,
          calendarId: null,
          consumesResources: true,
          resourceAssignments: [],
          passProbability: 0.5,
          failureDelay: { value: 0, unit: 'hours' },
        };
        set((state) => ({
          lastIntent: 'Added decision',
          project: {
            ...state.project,
            nodes: [...state.project.nodes, newNode],
            subsystems: appendToActiveSubsystem(state.project.subsystems, newNode.id),
          },
        }));
        return newNode.id;
      },

      // Phase 49 Slice 4 — wire-on-place. Build the node from the same
      // templates as `addNode` / `addDecisionNode`, then append N FS
      // edges with `connectNodes`-equivalent shape. Single `set()` =
      // single undo step.
      addNodeWithIncomingEdges(type, position, sourceNodeIds) {
        commitEdit();
        const id = crypto.randomUUID();
        const newNode: ProjectNode =
          type === 'decision'
            ? {
                id,
                nodeType: 'decision',
                name: 'Decision',
                duration: { value: 4, unit: 'hours' },
                durationSemantic: 'time',
                position,
                calendarId: null,
                consumesResources: true,
                resourceAssignments: [],
                passProbability: 0.5,
                failureDelay: { value: 0, unit: 'hours' },
              }
            : {
                id,
                nodeType: 'activity',
                name: 'New Activity',
                duration: { value: 8, unit: 'hours' },
                durationSemantic: 'effort',
                position,
                calendarId: null,
                consumesResources: true,
                resourceAssignments: [],
              };
        const newEdges: ProjectEdge[] = sourceNodeIds.map((src) => ({
          id: crypto.randomUUID(),
          from: src,
          to: id,
          type: 'FS',
          lag: { value: 0, unit: 'hours' },
        }));
        const noun = type === 'decision' ? 'decision' : 'activity';
        const lastIntent =
          sourceNodeIds.length === 0
            ? type === 'decision'
              ? 'Added decision'
              : 'Added activity'
            : `Added ${noun} + ${sourceNodeIds.length} edge${sourceNodeIds.length === 1 ? '' : 's'}`;
        set((state) => ({
          lastIntent,
          project: {
            ...state.project,
            nodes: [...state.project.nodes, newNode],
            edges: [...state.project.edges, ...newEdges],
            subsystems: appendToActiveSubsystem(state.project.subsystems, id),
          },
        }));
        return id;
      },

      // Phase 11 — adjust pass probability (decision nodes only). The schema
      // refine layer will reject any application of this on a non-decision
      // node, so we only mutate when the existing node is a decision; other
      // node types are silently no-op'd for safety.
      updateNodePassProbability(nodeId, p) {
        set((state) => ({
          lastIntent: 'Set pass probability',
          project: {
            ...state.project,
            nodes: state.project.nodes.map((n): ProjectNode => {
              if (n.id !== nodeId || n.nodeType !== 'decision') return n;
              return { ...n, passProbability: Math.max(0, Math.min(1, p)) };
            }),
          },
        }));
      },

      // Phase 11 — adjust the failure-delay surcharge (decision nodes only).
      // Under exactOptionalPropertyTypes the field must be absent (not
      // explicitly `undefined`) when cleared, so we destructure-and-rebuild.
      updateNodeFailureDelay(nodeId, delay) {
        set((state) => ({
          lastIntent: 'Set failure delay',
          project: {
            ...state.project,
            nodes: state.project.nodes.map((n): ProjectNode => {
              if (n.id !== nodeId || n.nodeType !== 'decision') return n;
              const { failureDelay: _f, ...rest } = n;
              return delay !== undefined ? { ...rest, failureDelay: delay } : rest;
            }),
          },
        }));
      },

      // Phase 33 — manual resource-leveling priority. `undefined` (or 0)
      // strips the field so the file never carries an explicit 0 — the
      // engine treats absent / 0 identically. Silent no-op on anchor /
      // subsystem nodes (the schema would reject them anyway).
      setNodeLevelPriority(nodeId, priority) {
        commitEdit();
        set((state) => ({
          lastIntent: 'Set leveling priority',
          project: {
            ...state.project,
            nodes: state.project.nodes.map((n): ProjectNode => {
              if (n.id !== nodeId) return n;
              if (n.nodeType !== 'activity' && n.nodeType !== 'decision') return n;
              const { levelPriority: _p, ...rest } = n;
              // Drop the field for undefined OR for explicit zero — the
              // engine treats absent ≡ 0 and round-tripping a stray 0 in
              // the file is noisy.
              return priority !== undefined && priority > 0
                ? { ...rest, levelPriority: priority }
                : rest;
            }),
          },
        }));
      },

      // Phase 19 — set / clear the activity/decision node's fixedCost.
      // Silently no-op'd for incompatible node types — the schema would
      // reject those anyway and the inspector never wires the editor for
      // start/end/subsystem nodes.
      updateNodeFixedCost(nodeId, fixedCost) {
        commitEdit();
        set((state) => ({
          lastIntent: 'Edited fixed cost',
          project: {
            ...state.project,
            nodes: state.project.nodes.map((n): ProjectNode => {
              if (n.id !== nodeId) return n;
              if (n.nodeType !== 'activity' && n.nodeType !== 'decision') return n;
              const { fixedCost: _c, ...rest } = n;
              return fixedCost !== undefined ? { ...rest, fixedCost } : rest;
            }),
          },
        }));
      },

      // Phase 19 — set / clear the per-iteration-vs-once flag inside a loop
      // body. Silently no-op'd when the node isn't a member of any loop body
      // — the schema would reject the resulting state, and the inspector
      // only renders the toggle inside a loop.
      updateNodeFixedCostOnce(nodeId, value) {
        commitEdit();
        set((state) => {
          const inSomeLoop = new Set(state.project.loops.flatMap((l) => l.bodyNodeIds));
          if (value === true && !inSomeLoop.has(nodeId)) return state;
          return {
            lastIntent: 'Toggled charge-once',
            project: {
              ...state.project,
              nodes: state.project.nodes.map((n): ProjectNode => {
                if (n.id !== nodeId) return n;
                const { fixedCostOnce: _f, ...rest } = n;
                return value !== undefined ? { ...rest, fixedCostOnce: value } : rest;
              }),
            },
          };
        });
      },

      deleteNodes(nodeIds) {
        commitEdit();
        const toDelete = new Set(nodeIds);

        // Phase 50 Slice 3 / audit C-4 (extended in 3.5b for Simulink-style
        // structural ports) — refuse the batch atomically when any deletion
        // target is a subsystem's entry or exit. In V7 the entry/exit ARE
        // the structural port nodes (subsystemEntry / subsystemExit); the
        // existing reference check still catches them since
        // `sub.entryNodeId` / `sub.exitNodeId` point at the ports. Toast
        // text says "entry port" / "exit port" so the role is clear.
        // The user should Unwrap Sub-system first, then delete.
        const project = useDomainStore.getState().project;
        type Conflict = {
          nodeName: string;
          subsystemName: string;
          role: 'entry port' | 'exit port';
        };
        const conflicts: Conflict[] = [];
        const nodeName = (id: string): string => project.nodes.find((n) => n.id === id)?.name ?? id;
        for (const sub of project.subsystems) {
          const subsystemName =
            project.nodes.find((n) => n.id === sub.containerNodeId)?.name ?? 'Sub-system';
          if (toDelete.has(sub.entryNodeId)) {
            conflicts.push({
              nodeName: nodeName(sub.entryNodeId),
              subsystemName,
              role: 'entry port',
            });
          }
          // Skip the exit check when entry === exit (degenerate legacy
          // case; V7 superRefine rejects it but a malformed in-flight
          // mutation could still trigger this branch).
          if (sub.exitNodeId !== sub.entryNodeId && toDelete.has(sub.exitNodeId)) {
            conflicts.push({
              nodeName: nodeName(sub.exitNodeId),
              subsystemName,
              role: 'exit port',
            });
          }
        }
        if (conflicts.length > 0) {
          const uniqueSubsystems = [...new Set(conflicts.map((c) => `"${c.subsystemName}"`))].join(
            ', ',
          );
          const text =
            conflicts.length === 1
              ? `Can't delete the ${conflicts[0]!.role} of subsystem ${uniqueSubsystems}. Unwrap the subsystem first.`
              : `Can't delete ${conflicts.length} nodes — they're entry / exit ports of subsystems: ${uniqueSubsystems}. Unwrap them first.`;
          useViewStore.getState().pushToast({ kind: 'warn', text });
          return;
        }

        set((state) => {
          const next: ProjectFile = {
            ...state.project,
            nodes: state.project.nodes.filter((n) => !toDelete.has(n.id)),
            edges: state.project.edges.filter((e) => !toDelete.has(e.from) && !toDelete.has(e.to)),
            // Remove deleted nodes from loop bodies; drop loops that become empty
            loops: state.project.loops
              .map((l) => ({
                ...l,
                bodyNodeIds: l.bodyNodeIds.filter((id) => !toDelete.has(id)),
              }))
              .filter((l) => l.bodyNodeIds.length > 0),
            // C-4 — strip stale body-node refs from each subsystem. The
            // entry/exit guard above means every surviving subsystem
            // still has its entry and exit in bodyNodeIds, so the
            // schema's min(1) constraint stays satisfied.
            subsystems: state.project.subsystems.map((s) => ({
              ...s,
              bodyNodeIds: s.bodyNodeIds.filter((id) => !toDelete.has(id)),
            })),
          };
          // Phase 19 — if a loop's deletion (length===0 above) leaves a
          // surviving body node, that node now lacks loop membership and
          // its `fixedCostOnce` (if any) is orphaned. Strip it here so the
          // next save passes schema validation.
          return {
            lastIntent: nodeIds.length === 1 ? 'Deleted node' : `Deleted ${nodeIds.length} nodes`,
            project: dropOrphanFixedCostOnce(next),
          };
        });
      },

      // ── Comments (Phase 49 Slice 3) ────────────────────────────────────
      addComment(position): string {
        commitEdit();
        const newComment: Comment = {
          id: crypto.randomUUID(),
          x: position.x,
          y: position.y,
          text: '',
        };
        set((state) => ({
          lastIntent: 'Added comment',
          project: {
            ...state.project,
            comments: [...state.project.comments, newComment],
          },
        }));
        return newComment.id;
      },

      updateComment(commentId, text) {
        set((state) => ({
          lastIntent: 'Edited comment',
          project: {
            ...state.project,
            comments: state.project.comments.map((c) => (c.id === commentId ? { ...c, text } : c)),
          },
        }));
      },

      moveComment(commentId, position) {
        commitEdit();
        set((state) => {
          // Early-return on same-position calls so a spurious React Flow
          // position event (e.g. dragging: undefined with the existing
          // coords) doesn't churn the domain store — without this, the
          // comments array reference flipped on every fake event, which
          // invalidated rfCommentNodes' memo and cascaded into node /
          // edge re-renders on the React Flow canvas.
          const current = state.project.comments.find((c) => c.id === commentId);
          if (!current) return state;
          if (current.x === position.x && current.y === position.y) return state;
          return {
            lastIntent: 'Moved comment',
            project: {
              ...state.project,
              comments: state.project.comments.map((c) =>
                c.id === commentId ? { ...c, x: position.x, y: position.y } : c,
              ),
            },
          };
        });
      },

      deleteComment(commentId) {
        commitEdit();
        set((state) => {
          if (!state.project.comments.some((c) => c.id === commentId)) {
            return state;
          }
          return {
            lastIntent: 'Deleted comment',
            project: {
              ...state.project,
              comments: state.project.comments.filter((c) => c.id !== commentId),
            },
          };
        });
      },

      pasteNodes(nodes, offset): ReadonlyArray<string> {
        commitEdit();
        const newIds: string[] = [];
        const clones: ProjectNode[] = nodes.map((n) => {
          const id = crypto.randomUUID();
          newIds.push(id);
          // Phase 19 — pasted nodes land outside any loop body; strip
          // `fixedCostOnce` so the resulting state is schema-valid even
          // when the source was a loop body member.
          const { fixedCostOnce: _fco, ...rest } = n;
          return {
            ...rest,
            id,
            position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
          };
        });
        set((state) => ({
          lastIntent: clones.length === 1 ? 'Pasted node' : `Pasted ${clones.length} nodes`,
          project: { ...state.project, nodes: [...state.project.nodes, ...clones] },
        }));
        return newIds;
      },

      setNodeResourceAssignments(nodeId, assignments) {
        commitEdit();
        set((state) => ({
          lastIntent: 'Set resource assignments',
          project: {
            ...state.project,
            nodes: state.project.nodes.map((n) =>
              n.id === nodeId ? { ...n, resourceAssignments: [...assignments] } : n,
            ),
          },
        }));
      },

      // ── Phase 18 slice 1 — granular multi-resource actions ───────────────
      addResourceAssignment(nodeId, assignment) {
        commitEdit();
        if (assignment.count < 1) return;
        // Phase 23 slice 1 — newly-added assignments default to perfect-
        // parallel (parallelism: 1). Caller can override by passing the
        // field explicitly (paste/import paths preserve their source).
        const withDefaults: ResourceAssignment =
          assignment.parallelism === undefined ? { ...assignment, parallelism: 1 } : assignment;
        set((state) => {
          const node = state.project.nodes.find((n) => n.id === nodeId);
          if (!node) return state;
          // Duplicate-resource prevention. Callers wanting to grow an
          // existing assignment should use updateResourceAssignmentCount.
          if (node.resourceAssignments.some((a) => a.resourceId === withDefaults.resourceId)) {
            return state;
          }
          // Phase 42 — when shares are already set on the node, the new
          // assignment must also carry a share (the schema's all-or-none
          // invariant). Caller can pre-populate it; otherwise we synthesise
          // a sensible default based on `project.shareMode`:
          //   - percentage: split the next "1/(N+1)" off the existing
          //     shares proportionally, so the sum stays at 100.
          //   - weight: new entry gets `1`; existing weights untouched.
          const peers = node.resourceAssignments;
          const peersShared = peers.length > 0 && peers.every((a) => a.share !== undefined);
          let finalAssignment = withDefaults;
          let rebalancedPeers = peers;
          if (peersShared && withDefaults.share === undefined) {
            const mode = state.project.project.shareMode;
            if (mode === 'percentage') {
              // Target share for the new pool: 100/(N+1). Existing shares
              // scale down to (100 − newShare) total, then round to ints.
              const n = peers.length;
              const newShare = 100 / (n + 1);
              const scaled = peers.map((a) => (a.share ?? 0) * (n / (n + 1)));
              const ints = rebalanceSharesToTarget([...scaled, newShare], 100);
              rebalancedPeers = peers.map((a, i) => ({ ...a, share: ints[i] }));
              finalAssignment = { ...withDefaults, share: ints[n] };
            } else {
              // Weight mode: new entry gets weight 1.
              finalAssignment = { ...withDefaults, share: 1 };
            }
          }
          return {
            lastIntent: 'Added resource assignment',
            project: {
              ...state.project,
              nodes: state.project.nodes.map((n) =>
                n.id === nodeId
                  ? {
                      ...n,
                      resourceAssignments: [...rebalancedPeers, finalAssignment],
                    }
                  : n,
              ),
            },
          };
        });
      },

      updateResourceAssignmentCount(nodeId, resourceId, count) {
        // NB: no commitEdit() here — this is the per-keystroke action.
        // The caller (inspector input) wraps a focus session in
        // beginEdit/commitEdit so successive count edits coalesce into one
        // history entry. Mirrors the updateNodeName/updateNodeDuration pattern.
        if (count < 1) return;
        set((state) => {
          const node = state.project.nodes.find((n) => n.id === nodeId);
          if (!node) return state;
          if (!node.resourceAssignments.some((a) => a.resourceId === resourceId)) {
            return state;
          }
          return {
            lastIntent: 'Changed assignment count',
            project: {
              ...state.project,
              nodes: state.project.nodes.map((n) =>
                n.id === nodeId
                  ? {
                      ...n,
                      resourceAssignments: n.resourceAssignments.map((a) =>
                        a.resourceId === resourceId ? { ...a, count } : a,
                      ),
                    }
                  : n,
              ),
            },
          };
        });
      },

      removeResourceAssignment(nodeId, resourceId) {
        commitEdit();
        set((state) => {
          const node = state.project.nodes.find((n) => n.id === nodeId);
          if (!node) return state;
          if (!node.resourceAssignments.some((a) => a.resourceId === resourceId)) {
            return state;
          }
          // Phase 42 — when shares are set on every assignment and the
          // project is in percentage mode, the remaining shares no longer
          // sum to 100 after the removal. Rebalance proportionally so the
          // schema invariant stays valid. Weight mode leaves remaining
          // shares untouched (no sum constraint), and the legacy-mode
          // case (no shares anywhere) is identity.
          const remaining = node.resourceAssignments.filter((a) => a.resourceId !== resourceId);
          const allShared = remaining.length > 0 && remaining.every((a) => a.share !== undefined);
          let nextAssignments = remaining;
          if (allShared && state.project.project.shareMode === 'percentage') {
            const ints = rebalanceSharesToTarget(
              remaining.map((a) => a.share ?? 0),
              100,
            );
            nextAssignments = remaining.map((a, i) => ({ ...a, share: ints[i] }));
          }
          return {
            lastIntent: 'Removed resource assignment',
            project: {
              ...state.project,
              nodes: state.project.nodes.map((n) =>
                n.id === nodeId ? { ...n, resourceAssignments: nextAssignments } : n,
              ),
            },
          };
        });
      },

      updateResourceAssignmentPolicy(nodeId, resourceId, policy) {
        commitEdit();
        set((state) => {
          const node = state.project.nodes.find((n) => n.id === nodeId);
          if (!node) return state;
          if (!node.resourceAssignments.some((a) => a.resourceId === resourceId)) {
            return state;
          }
          return {
            lastIntent: 'Changed assignment policy',
            project: {
              ...state.project,
              nodes: state.project.nodes.map((n) =>
                n.id === nodeId
                  ? {
                      ...n,
                      resourceAssignments: n.resourceAssignments.map((a) =>
                        a.resourceId === resourceId ? { ...a, calendarPolicy: policy } : a,
                      ),
                    }
                  : n,
              ),
            },
          };
        });
      },

      // Phase 23 Slice 1 — write the parallelism coefficient on a single
      // resource assignment. Pass `undefined` to remove the field; the
      // segmented control's "Off" stores 0 explicitly per the user's spec.
      // Bounds [0, 1] enforced by the Zod schema at save time.
      updateResourceAssignmentParallelism(nodeId, resourceId, parallelism) {
        commitEdit();
        set((state) => {
          const node = state.project.nodes.find((n) => n.id === nodeId);
          if (!node) return state;
          if (!node.resourceAssignments.some((a) => a.resourceId === resourceId)) {
            return state;
          }
          return {
            lastIntent: 'Changed assignment parallelism',
            project: {
              ...state.project,
              nodes: state.project.nodes.map((n) =>
                n.id === nodeId
                  ? {
                      ...n,
                      resourceAssignments: n.resourceAssignments.map((a) => {
                        if (a.resourceId !== resourceId) return a;
                        if (parallelism === undefined) {
                          // exactOptionalPropertyTypes: destructure-and-rebuild
                          // (see CLAUDE.md note on optional-field clearing).
                          const { parallelism: _p, ...rest } = a;
                          return rest;
                        }
                        return { ...a, parallelism };
                      }),
                    }
                  : n,
              ),
            },
          };
        });
      },

      // ── Phase 42: resource-share editing ────────────────────────────────

      setAssignmentShare(nodeId, resourceId, share) {
        // NB: no commitEdit() — this is the per-keystroke action. Inspector
        // wraps the focus session so successive edits coalesce into one
        // history entry. Mirrors `updateResourceAssignmentCount`.
        //
        // Auto-rebalance: in *percentage mode* on a *two-pool* activity,
        // the peer is fully determined (it must be `100 − this`), so we
        // set it for free. The user's share is clamped to [0, 100] so
        // the peer never goes negative. With three+ pools the relationship
        // is under-determined (no canonical peer to debit), so no auto-
        // rebalance — the user fixes the off-100 sum manually with help
        // from the visible Total banner.
        if (!isFinite(share) || share < 0) return;
        set((state) => {
          const node = state.project.nodes.find((n) => n.id === nodeId);
          if (!node) return state;
          if (!node.resourceAssignments.some((a) => a.resourceId === resourceId)) {
            return state;
          }
          const isTwoPoolPercentage =
            state.project.project.shareMode === 'percentage' &&
            node.resourceAssignments.length === 2;
          const clamped = isTwoPoolPercentage ? Math.min(100, share) : share;
          const peer = isTwoPoolPercentage ? 100 - clamped : null;
          return {
            lastIntent: 'Changed assignment share',
            project: {
              ...state.project,
              nodes: state.project.nodes.map((n) =>
                n.id === nodeId
                  ? {
                      ...n,
                      resourceAssignments: n.resourceAssignments.map((a) => {
                        if (a.resourceId === resourceId) {
                          return { ...a, share: clamped };
                        }
                        if (peer !== null) {
                          return { ...a, share: peer };
                        }
                        return a;
                      }),
                    }
                  : n,
              ),
            },
          };
        });
      },

      initialiseEqualShares(nodeId) {
        commitEdit();
        set((state) => {
          const node = state.project.nodes.find((n) => n.id === nodeId);
          if (!node || node.resourceAssignments.length === 0) return state;
          // No-op when every assignment already has a share (don't clobber).
          if (node.resourceAssignments.every((a) => a.share !== undefined)) {
            return state;
          }
          const mode = state.project.project.shareMode;
          const n = node.resourceAssignments.length;
          const shares =
            mode === 'percentage'
              ? rebalanceSharesToTarget(new Array(n).fill(1), 100)
              : new Array<number>(n).fill(1);
          return {
            lastIntent: 'Initialised work split',
            project: {
              ...state.project,
              nodes: state.project.nodes.map((nd) =>
                nd.id === nodeId
                  ? {
                      ...nd,
                      resourceAssignments: nd.resourceAssignments.map((a, i) => ({
                        ...a,
                        share: shares[i],
                      })),
                    }
                  : nd,
              ),
            },
          };
        });
      },

      clearAllShares(nodeId) {
        commitEdit();
        set((state) => {
          const node = state.project.nodes.find((n) => n.id === nodeId);
          if (!node) return state;
          if (node.resourceAssignments.every((a) => a.share === undefined)) {
            return state;
          }
          return {
            lastIntent: 'Cleared work split',
            project: {
              ...state.project,
              nodes: state.project.nodes.map((nd) =>
                nd.id === nodeId
                  ? {
                      ...nd,
                      resourceAssignments: nd.resourceAssignments.map((a) => {
                        // exactOptionalPropertyTypes: destructure to drop.
                        const { share: _s, ...rest } = a;
                        return rest;
                      }),
                    }
                  : nd,
              ),
            },
          };
        });
      },

      distributeSharesEvenly(nodeId) {
        commitEdit();
        set((state) => {
          const node = state.project.nodes.find((n) => n.id === nodeId);
          if (!node || node.resourceAssignments.length === 0) return state;
          const mode = state.project.project.shareMode;
          const n = node.resourceAssignments.length;
          const shares =
            mode === 'percentage'
              ? rebalanceSharesToTarget(new Array(n).fill(1), 100)
              : new Array<number>(n).fill(1);
          return {
            lastIntent: 'Distributed work evenly',
            project: {
              ...state.project,
              nodes: state.project.nodes.map((nd) =>
                nd.id === nodeId
                  ? {
                      ...nd,
                      resourceAssignments: nd.resourceAssignments.map((a, i) => ({
                        ...a,
                        share: shares[i],
                      })),
                    }
                  : nd,
              ),
            },
          };
        });
      },

      // ── Phase 25: activity crashing ─────────────────────────────────────
      addCrashOption(nodeId, option) {
        commitEdit();
        set((state) => {
          const node = state.project.nodes.find((n) => n.id === nodeId);
          if (!node) return state;
          if (node.nodeType !== 'activity' && node.nodeType !== 'decision') {
            return state;
          }
          const next = [...(node.crashOptions ?? []), option];
          return {
            lastIntent: 'Added crash option',
            project: {
              ...state.project,
              nodes: state.project.nodes.map((n) =>
                n.id === nodeId ? { ...n, crashOptions: next } : n,
              ),
            },
          };
        });
      },

      updateCrashOption(nodeId, index, option) {
        commitEdit();
        set((state) => {
          const node = state.project.nodes.find((n) => n.id === nodeId);
          if (!node || !node.crashOptions) return state;
          if (index < 0 || index >= node.crashOptions.length) return state;
          const next = node.crashOptions.map((o, i) => (i === index ? option : o));
          return {
            lastIntent: 'Edited crash option',
            project: {
              ...state.project,
              nodes: state.project.nodes.map((n) =>
                n.id === nodeId ? { ...n, crashOptions: next } : n,
              ),
            },
          };
        });
      },

      removeCrashOption(nodeId, index) {
        commitEdit();
        set((state) => {
          const node = state.project.nodes.find((n) => n.id === nodeId);
          if (!node || !node.crashOptions) return state;
          if (index < 0 || index >= node.crashOptions.length) return state;
          const next = node.crashOptions.filter((_, i) => i !== index);

          // Re-anchor the selection: if the deleted index WAS selected, clear
          // it; if a later index was selected, shift it down by one.
          let nextSelected = node.selectedCrashIndex;
          if (nextSelected !== undefined) {
            if (nextSelected === index) nextSelected = undefined;
            else if (nextSelected > index) nextSelected = nextSelected - 1;
          }

          return {
            lastIntent: 'Removed crash option',
            project: {
              ...state.project,
              nodes: state.project.nodes.map((n) => {
                if (n.id !== nodeId) return n;
                // Destructure-rebuild so the field disappears entirely when
                // the array becomes empty OR when nextSelected is undefined
                // (exactOptionalPropertyTypes — see CLAUDE.md note).
                const { crashOptions: _co, selectedCrashIndex: _si, ...rest } = n;
                const updated: ProjectNode = { ...rest };
                if (next.length > 0) updated.crashOptions = next;
                if (nextSelected !== undefined) updated.selectedCrashIndex = nextSelected;
                return updated;
              }),
            },
          };
        });
      },

      selectCrashOption(nodeId, index) {
        commitEdit();
        set((state) => {
          const node = state.project.nodes.find((n) => n.id === nodeId);
          if (!node) return state;
          if (index !== undefined) {
            // Reject an out-of-range index instead of silently writing it —
            // the Zod schema would reject it at save time anyway.
            if (!node.crashOptions || index < 0 || index >= node.crashOptions.length) {
              return state;
            }
          }
          return {
            lastIntent: index === undefined ? 'Cleared crash selection' : 'Selected crash option',
            project: {
              ...state.project,
              nodes: state.project.nodes.map((n) => {
                if (n.id !== nodeId) return n;
                if (index === undefined) {
                  const { selectedCrashIndex: _si, ...rest } = n;
                  return rest;
                }
                return { ...n, selectedCrashIndex: index };
              }),
            },
          };
        });
      },

      // Phase 25 Slice 3 — bulk-apply a greedy-crash plan as a single
      // undo step. Walks `plan.steps` once, writes each node's new
      // `selectedCrashIndex` in one pass; optionally clears every
      // node's prior selection before applying (the modal's "Reset all
      // crashes first" checkbox uses this).
      applyCrashPlan(plan, options) {
        commitEdit();
        set((state) => {
          const stepByNode = new Map<string, number>();
          for (const s of plan.steps) stepByNode.set(s.nodeId, s.toIndex);

          const resetFirst = options?.resetFirst === true;
          const nodes = state.project.nodes.map((n): ProjectNode => {
            const picked = stepByNode.get(n.id);
            if (picked !== undefined) {
              // Validate against the live crashOptions length (defensive —
              // the greedy plan was computed against the same node array,
              // but stale plans could exist if the caller delayed apply).
              if (!n.crashOptions || picked < 0 || picked >= n.crashOptions.length) {
                return n;
              }
              return { ...n, selectedCrashIndex: picked };
            }
            if (resetFirst && n.selectedCrashIndex !== undefined) {
              // Destructure-rebuild to drop the field entirely.
              const { selectedCrashIndex: _si, ...rest } = n;
              return rest;
            }
            return n;
          });

          return { lastIntent: 'Applied crash plan', project: { ...state.project, nodes } };
        });
      },

      splitResourceAssignment(nodeId, fromResourceId, toResourceId, count) {
        commitEdit();
        if (fromResourceId === toResourceId || count <= 0) return;
        set((state) => {
          const node = state.project.nodes.find((n) => n.id === nodeId);
          if (!node) return state;
          const from = node.resourceAssignments.find((a) => a.resourceId === fromResourceId);
          if (!from) return state;
          if (count > from.count) return state;

          // Compute the new assignments array in one pass to keep this as a
          // single undo step: decrement from, grow-or-create to.
          const fromRemaining = from.count - count;
          const existingTo = node.resourceAssignments.find((a) => a.resourceId === toResourceId);

          const next: ResourceAssignment[] = [];
          for (const a of node.resourceAssignments) {
            if (a.resourceId === fromResourceId) {
              // Keep the from entry only if it still has units left.
              if (fromRemaining > 0) next.push({ ...a, count: fromRemaining });
              // else: drop it.
            } else if (a.resourceId === toResourceId) {
              next.push({ ...a, count: a.count + count });
            } else {
              next.push(a);
            }
          }
          // Create a brand-new `to` assignment when none existed before.
          // Inherits the from assignment's calendarPolicy so the split
          // doesn't silently change resource scheduling semantics.
          if (!existingTo) {
            next.push({
              resourceId: toResourceId,
              count,
              calendarPolicy: from.calendarPolicy,
            });
          }

          return {
            lastIntent: 'Split resource assignment',
            project: {
              ...state.project,
              nodes: state.project.nodes.map((n) =>
                n.id === nodeId ? { ...n, resourceAssignments: next } : n,
              ),
            },
          };
        });
      },

      addResource({
        name,
        capacity,
        workingDays,
        hoursPerDay,
        costRate,
        costPerUse,
        hourlyRateDistribution,
        currencyOverride,
      }) {
        commitEdit();
        const schemaWd = uiToSchemaWorkingDays(workingDays);
        const daysPerWeek = schemaWd.filter(Boolean).length;
        const calendarId = crypto.randomUUID();
        const cal: Calendar = {
          id: calendarId,
          name: `${name} — schedule`,
          workingDays: schemaWd,
          hoursPerDay,
          daysPerWeek: Math.max(1, daysPerWeek),
          holidayPreset: 'NONE',
          holidayPresetVersion: '',
          exceptions: [],
        };
        const r: Resource = {
          id: crypto.randomUUID(),
          name,
          capacity,
          calendarId,
          // Cost fields are only emitted when non-zero — keeps round-tripped
          // files clean for projects that never adopt cost modelling.
          ...(costRate !== undefined && costRate > 0 ? { costRate } : {}),
          ...(costPerUse !== undefined && costPerUse > 0 ? { costPerUse } : {}),
          ...(hourlyRateDistribution !== undefined ? { hourlyRateDistribution } : {}),
          ...(currencyOverride !== undefined ? { currencyOverride } : {}),
        };
        set((state) => ({
          lastIntent: 'Added resource',
          project: {
            ...state.project,
            calendars: [...state.project.calendars, cal],
            resources: [...state.project.resources, r],
          },
        }));
      },

      updateResource(
        id,
        name,
        capacity,
        workingDays,
        hoursPerDay,
        costRate,
        costPerUse,
        hourlyRateDistribution,
        currencyOverride,
      ) {
        commitEdit();
        const schemaWd = uiToSchemaWorkingDays(workingDays);
        const daysPerWeek = schemaWd.filter(Boolean).length;
        set((state) => {
          const resource = state.project.resources.find((r) => r.id === id);
          if (!resource) return state;
          return {
            lastIntent: 'Edited resource',
            project: {
              ...state.project,
              calendars: state.project.calendars.map((c) =>
                c.id === resource.calendarId
                  ? {
                      ...c,
                      name: `${name} — schedule`,
                      workingDays: schemaWd,
                      hoursPerDay,
                      daysPerWeek: Math.max(1, daysPerWeek),
                    }
                  : c,
              ),
              resources: state.project.resources.map((r) => {
                if (r.id !== id) return r;
                // Strip-then-rebuild so cleared optional fields don't linger
                // as explicit `undefined` (exactOptionalPropertyTypes).
                const {
                  costRate: _cr,
                  costPerUse: _cu,
                  hourlyRateDistribution: _hd,
                  currencyOverride: _co,
                  ...rest
                } = r;
                return {
                  ...rest,
                  name,
                  capacity,
                  ...(costRate !== undefined && costRate > 0 ? { costRate } : {}),
                  ...(costPerUse !== undefined && costPerUse > 0 ? { costPerUse } : {}),
                  ...(hourlyRateDistribution !== undefined ? { hourlyRateDistribution } : {}),
                  ...(currencyOverride !== undefined ? { currencyOverride } : {}),
                };
              }),
            },
          };
        });
      },

      setResourceCapacity(id, capacity) {
        commitEdit();
        if (capacity < 1) return;
        set((state) => ({
          lastIntent: 'Changed resource capacity',
          project: {
            ...state.project,
            resources: state.project.resources.map((r) => (r.id === id ? { ...r, capacity } : r)),
          },
        }));
      },

      // Phase 29 — set / clear the optional `hourlyRateDistribution`.
      // `undefined` strips the field entirely so the file never carries
      // an explicit `hourlyRateDistribution: undefined` (matches the
      // exactOptionalPropertyTypes destructure-rebuild pattern used by
      // updateNodeFailureDelay / updateNodeFixedCost).
      updateResourceHourlyRateDistribution(id, dist) {
        commitEdit();
        set((state) => ({
          lastIntent: 'Edited rate distribution',
          project: {
            ...state.project,
            resources: state.project.resources.map((r): Resource => {
              if (r.id !== id) return r;
              const { hourlyRateDistribution: _h, ...rest } = r;
              return dist !== undefined ? { ...rest, hourlyRateDistribution: dist } : rest;
            }),
          },
        }));
      },

      deleteResource(id) {
        commitEdit();
        set((state) => {
          const resource = state.project.resources.find((r) => r.id === id);
          const calendarId = resource?.calendarId;
          // Delete the resource's owned calendar only if no other resource references it
          // and it is not the project default calendar.
          const isShared =
            !calendarId ||
            calendarId === state.project.project.defaultCalendarId ||
            state.project.resources.some((r) => r.id !== id && r.calendarId === calendarId);
          // Phase 50 Slice 3 / audit C-5 — when a node loses an assignment
          // here, the remaining shares no longer sum to 100 in percentage
          // mode. Rebalance proportionally so the V6 schema's "shares sum
          // to 100" invariant stays valid. Weight mode leaves shares
          // untouched (no sum constraint); legacy-mode nodes (no shares
          // anywhere) are identity. Mirrors removeResourceAssignment — the
          // per-assignment path already rebalances; this bulk path was the
          // missing case.
          const isPercentage = state.project.project.shareMode === 'percentage';
          return {
            lastIntent: 'Deleted resource',
            project: {
              ...state.project,
              calendars: isShared
                ? state.project.calendars
                : state.project.calendars.filter((c) => c.id !== calendarId),
              resources: state.project.resources.filter((r) => r.id !== id),
              // Remove assignments to this resource from all nodes; rebalance
              // surviving shares when applicable (see C-5 comment above).
              nodes: state.project.nodes.map((n) => {
                const remaining = n.resourceAssignments.filter((a) => a.resourceId !== id);
                if (remaining.length === n.resourceAssignments.length) return n;
                const allShared =
                  remaining.length > 0 && remaining.every((a) => a.share !== undefined);
                if (!allShared || !isPercentage) {
                  return { ...n, resourceAssignments: remaining };
                }
                const ints = rebalanceSharesToTarget(
                  remaining.map((a) => a.share ?? 0),
                  100,
                );
                return {
                  ...n,
                  resourceAssignments: remaining.map((a, i) => ({ ...a, share: ints[i] })),
                };
              }),
            },
          };
        });
      },

      connectNodes(source, target) {
        commitEdit();
        const edge: ProjectEdge = {
          id: crypto.randomUUID(),
          from: source,
          to: target,
          type: 'FS',
          lag: { value: 0, unit: 'hours' },
        };
        set((state) => ({
          lastIntent: 'Connected nodes',
          project: { ...state.project, edges: [...state.project.edges, edge] },
        }));
      },

      deleteEdges(edgeIds) {
        commitEdit();
        const toDelete = new Set(edgeIds);
        set((state) => ({
          lastIntent: edgeIds.length === 1 ? 'Deleted edge' : `Deleted ${edgeIds.length} edges`,
          project: {
            ...state.project,
            edges: state.project.edges.filter((e) => !toDelete.has(e.id)),
          },
        }));
      },

      updateEdgeType(edgeId, type) {
        commitEdit();
        set((state) => ({
          lastIntent: 'Changed edge type',
          project: {
            ...state.project,
            edges: state.project.edges.map((e) => (e.id === edgeId ? { ...e, type } : e)),
          },
        }));
      },

      updateEdgeLag(edgeId, value, unit) {
        set((state) => ({
          lastIntent: 'Changed edge lag',
          project: {
            ...state.project,
            edges: state.project.edges.map((e) =>
              e.id === edgeId ? { ...e, lag: { value, unit } } : e,
            ),
          },
        }));
      },

      applyEdgeLagBumps(bumps) {
        commitEdit();
        const lagToHours = (lag: { value: number; unit: DurationUnit }): number => {
          switch (lag.unit) {
            case 'hours':
              return lag.value;
            case 'days':
              return lag.value * 24;
            case 'weeks':
              return lag.value * 24 * 7;
          }
        };
        set((state) => ({
          lastIntent: 'Applied lag adjustments',
          project: {
            ...state.project,
            edges: state.project.edges.map((e) => {
              const bump = bumps[e.id];
              if (!bump || bump === 0) return e;
              return {
                ...e,
                lag: {
                  value: lagToHours(e.lag) + bump,
                  unit: 'hours' as const,
                },
              };
            }),
          },
        }));
      },

      addLoop(nodeIds) {
        commitEdit();
        const id = crypto.randomUUID();
        const loop: Loop = {
          id,
          bodyNodeIds: [...nodeIds],
          kickout: { type: 'maxIterations', value: 3 },
          expectedIterations: { type: 'triangular', min: 2, mode: 3, max: 5 },
        };
        set((state) => ({
          lastIntent: 'Grouped as loop',
          project: { ...state.project, loops: [...state.project.loops, loop] },
        }));
        return id;
      },

      deleteLoop(loopId) {
        commitEdit();
        set((state) => {
          const next: ProjectFile = {
            ...state.project,
            loops: state.project.loops.filter((l) => l.id !== loopId),
          };
          // Phase 19 — drop now-orphaned fixedCostOnce on body nodes that
          // belonged exclusively to the deleted loop.
          return { lastIntent: 'Ungrouped loop', project: dropOrphanFixedCostOnce(next) };
        });
      },

      updateLoopKickout(loopId, kickout) {
        set((state) => ({
          lastIntent: 'Changed loop kickout',
          project: {
            ...state.project,
            loops: state.project.loops.map((l) => (l.id === loopId ? { ...l, kickout } : l)),
          },
        }));
      },

      updateLoopExpectedIterations(loopId, dist) {
        set((state) => ({
          lastIntent: 'Changed loop iterations',
          project: {
            ...state.project,
            loops: state.project.loops.map((l) =>
              l.id === loopId ? { ...l, expectedIterations: dist } : l,
            ),
          },
        }));
      },

      updateLoopGroup(loopId, group) {
        commitEdit();
        set((state) => ({
          lastIntent: 'Changed loop group',
          project: {
            ...state.project,
            loops: state.project.loops.map((l): Loop => {
              if (l.id !== loopId) return l;
              const { group: _g, ...rest } = l;
              return group !== undefined ? { ...rest, group } : rest;
            }),
          },
        }));
      },

      updateLoopDescription(loopId, description) {
        set((state) => ({
          lastIntent: 'Edited loop description',
          project: {
            ...state.project,
            loops: state.project.loops.map((l): Loop => {
              if (l.id !== loopId) return l;
              const { description: _d, ...rest } = l;
              return description !== undefined ? { ...rest, description } : rest;
            }),
          },
        }));
      },

      addScenario(name, seed) {
        // Audit I-12 — `seed` is passed in by the caller (computed at the
        // UI boundary). The domain mutation must be deterministic given
        // its arguments; pulling `Math.random()` into the call site keeps
        // non-deterministic sources out of the store layer.
        commitEdit();
        const id = crypto.randomUUID();
        const scenario: Scenario = {
          id,
          name,
          seed,
          nodeOverrides: {},
        };
        set((state) => ({
          lastIntent: 'Added scenario',
          project: {
            ...state.project,
            scenarios: [...state.project.scenarios, scenario],
          },
        }));
        return id;
      },

      deleteScenario(id) {
        commitEdit();
        set((state) => ({
          lastIntent: 'Deleted scenario',
          project: {
            ...state.project,
            scenarios: state.project.scenarios.filter((s) => s.id !== id),
          },
        }));
      },

      updateScenarioName(id, name) {
        commitEdit();
        set((state) => ({
          lastIntent: 'Renamed scenario',
          project: {
            ...state.project,
            scenarios: state.project.scenarios.map(
              (s): Scenario => (s.id === id ? { ...s, name } : s),
            ),
          },
        }));
      },

      setScenarioSeed(id, seed) {
        set((state) => ({
          lastIntent: 'Changed scenario seed',
          project: {
            ...state.project,
            scenarios: state.project.scenarios.map(
              (s): Scenario => (s.id === id ? { ...s, seed } : s),
            ),
          },
        }));
      },

      setScenarioNodeDuration(scenarioId, nodeId, duration) {
        commitEdit();
        set((state) => ({
          lastIntent: 'Set scenario override',
          project: {
            ...state.project,
            scenarios: state.project.scenarios.map((s): Scenario => {
              if (s.id !== scenarioId) return s;
              const existing = s.nodeOverrides[nodeId] ?? {};
              return {
                ...s,
                nodeOverrides: {
                  ...s.nodeOverrides,
                  [nodeId]: { ...existing, duration },
                },
              };
            }),
          },
        }));
      },

      deleteScenarioNodeOverride(scenarioId, nodeId) {
        commitEdit();
        set((state) => ({
          lastIntent: 'Cleared scenario override',
          project: {
            ...state.project,
            scenarios: state.project.scenarios.map((s): Scenario => {
              if (s.id !== scenarioId) return s;
              const { [nodeId]: _removed, ...rest } = s.nodeOverrides;
              return { ...s, nodeOverrides: rest };
            }),
          },
        }));
      },

      wrapSelectedAsSubsystem(nodeIds) {
        const state = useDomainStore.getState();
        const { nodes, edges, subsystems } = state.project;

        if (nodeIds.length < 2) {
          return 'Select at least 2 nodes to wrap as a sub-system.';
        }

        const bodySet = new Set(nodeIds);

        // Reject if any node is already inside a sub-system body.
        const alreadyUsed = new Set(subsystems.flatMap((s) => s.bodyNodeIds));
        for (const id of nodeIds) {
          if (alreadyUsed.has(id)) {
            return 'One or more selected nodes already belong to a sub-system.';
          }
        }

        // Classify edges: internal vs external. Used to pick the "natural"
        // entry/exit of the user's selection (the user-facing nodes that
        // currently have external connections). Structural Entry/Exit
        // nodes will be auto-injected just outside them.
        const externalIn = new Map<string, number>();
        const externalOut = new Map<string, number>();
        for (const id of nodeIds) {
          externalIn.set(id, 0);
          externalOut.set(id, 0);
        }
        for (const e of edges) {
          const fromIn = bodySet.has(e.from);
          const toIn = bodySet.has(e.to);
          if (!fromIn && toIn) {
            externalIn.set(e.to, (externalIn.get(e.to) ?? 0) + 1);
          } else if (fromIn && !toIn) {
            externalOut.set(e.from, (externalOut.get(e.from) ?? 0) + 1);
          }
        }

        const entryCandidates = [...nodeIds].filter((id) => (externalIn.get(id) ?? 0) > 0);
        const exitCandidates = [...nodeIds].filter((id) => (externalOut.get(id) ?? 0) > 0);

        if (entryCandidates.length > 1) {
          return 'The selection has multiple entry points (nodes with external incoming edges). A sub-system must have exactly one entry.';
        }
        if (exitCandidates.length > 1) {
          return 'The selection has multiple exit points (nodes with external outgoing edges). A sub-system must have exactly one exit.';
        }

        // Isolated group: pick by x-position.
        const nodeMap = new Map(nodes.map((n) => [n.id, n]));
        const sorted = [...nodeIds].sort(
          (a, b) => (nodeMap.get(a)?.position.x ?? 0) - (nodeMap.get(b)?.position.x ?? 0),
        );

        const naturalEntryId = entryCandidates[0] ?? sorted[0]!;
        let naturalExitId = exitCandidates[0] ?? sorted[sorted.length - 1]!;

        if (naturalEntryId === naturalExitId && nodeIds.length > 1) {
          naturalExitId = sorted[sorted.length - 1]!;
          if (naturalExitId === naturalEntryId) {
            naturalExitId = sorted[sorted.length - 2]!;
          }
        }

        // Compute centroid for the container node position.
        let cx = 0;
        let cy = 0;
        for (const id of nodeIds) {
          cx += nodeMap.get(id)?.position.x ?? 0;
          cy += nodeMap.get(id)?.position.y ?? 0;
        }
        cx /= nodeIds.length;
        cy /= nodeIds.length;

        const containerId = crypto.randomUUID();
        const subsystemId = crypto.randomUUID();
        const structuralEntryId = crypto.randomUUID();
        const structuralExitId = crypto.randomUUID();

        const containerNode: ProjectNode = {
          id: containerId,
          nodeType: 'subsystem',
          name: 'Sub-system',
          duration: { value: 0, unit: 'hours' },
          durationSemantic: 'time',
          position: { x: cx, y: cy - 80 },
          calendarId: null,
          consumesResources: false,
          resourceAssignments: [],
        };

        // Phase 50 Slice 3.5b — structural Entry / Exit pair. Positioned
        // just outside the natural entry / exit with a ~60 px gap. Zero-
        // duration, no resources, no calendar — pure structural anchors.
        // Live as body members alongside the user's selection so the
        // drill-in view shows them as the I/O boundary. The exit-side
        // offset uses the natural node's width (or the placement default
        // 160 px) so the wedge clears the activity rectangle — same
        // formula as the V6→V7 migration in load.ts.
        const STRUCTURAL_PORT_WIDTH = 44;
        const STRUCTURAL_PORT_GAP = 60;
        const NATURAL_NODE_DEFAULT_WIDTH = 160;
        const naturalEntryNode = nodeMap.get(naturalEntryId);
        const naturalExitNode = nodeMap.get(naturalExitId);
        const structuralEntryNode: ProjectNode = {
          id: structuralEntryId,
          nodeType: 'subsystemEntry',
          name: 'Entry',
          duration: { value: 0, unit: 'hours' },
          durationSemantic: 'time',
          position: naturalEntryNode
            ? {
                x: naturalEntryNode.position.x - STRUCTURAL_PORT_WIDTH - STRUCTURAL_PORT_GAP,
                y: naturalEntryNode.position.y,
              }
            : { x: cx - STRUCTURAL_PORT_WIDTH - STRUCTURAL_PORT_GAP, y: cy },
          calendarId: null,
          consumesResources: false,
          resourceAssignments: [],
        };
        const structuralExitNode: ProjectNode = {
          id: structuralExitId,
          nodeType: 'subsystemExit',
          name: 'Exit',
          duration: { value: 0, unit: 'hours' },
          durationSemantic: 'time',
          position: naturalExitNode
            ? {
                x:
                  naturalExitNode.position.x +
                  (naturalExitNode.width ?? NATURAL_NODE_DEFAULT_WIDTH) +
                  STRUCTURAL_PORT_GAP,
                y: naturalExitNode.position.y,
              }
            : { x: cx + NATURAL_NODE_DEFAULT_WIDTH + STRUCTURAL_PORT_GAP, y: cy },
          calendarId: null,
          consumesResources: false,
          resourceAssignments: [],
        };

        const subsystem: Subsystem = {
          id: subsystemId,
          containerNodeId: containerId,
          // Structural nodes live in bodyNodeIds alongside the user's
          // selection; they bookend the chain in the drill-in view.
          bodyNodeIds: [structuralEntryId, ...nodeIds, structuralExitId],
          entryNodeId: structuralEntryId,
          exitNodeId: structuralExitId,
        };

        // Rewrite external edges to/from the container node, and add the
        // two internal bookend edges that wire the structural pair to
        // the natural entry/exit.
        const newEdges = edges.map((e) => {
          if (!bodySet.has(e.from) && bodySet.has(e.to) && e.to === naturalEntryId) {
            return { ...e, to: containerId };
          }
          if (bodySet.has(e.from) && !bodySet.has(e.to) && e.from === naturalExitId) {
            return { ...e, from: containerId };
          }
          // External edges pointing to non-entry body nodes, or from
          // non-exit body nodes: reroute through container as a best-
          // effort fallback (carried over from the V6 wrap behaviour).
          if (!bodySet.has(e.from) && bodySet.has(e.to)) {
            return { ...e, to: containerId };
          }
          if (bodySet.has(e.from) && !bodySet.has(e.to)) {
            return { ...e, from: containerId };
          }
          return e;
        });
        const structuralEdges: ProjectEdge[] = [
          {
            id: crypto.randomUUID(),
            from: structuralEntryId,
            to: naturalEntryId,
            type: 'FS',
            lag: { value: 0, unit: 'hours' },
          },
          {
            id: crypto.randomUUID(),
            from: naturalExitId,
            to: structuralExitId,
            type: 'FS',
            lag: { value: 0, unit: 'hours' },
          },
        ];

        commitEdit();
        set((s) => ({
          lastIntent: 'Wrapped as sub-system',
          project: {
            ...s.project,
            nodes: [...s.project.nodes, containerNode, structuralEntryNode, structuralExitNode],
            edges: [...newEdges, ...structuralEdges],
            subsystems: [...s.project.subsystems, subsystem],
          },
        }));
        return null;
      },

      unwrapSubsystem(subsystemId) {
        commitEdit();
        set((s) => {
          const sub = s.project.subsystems.find((ss) => ss.id === subsystemId);
          if (!sub) return s;

          // Phase 50 Slice 3.5b — derive the natural entry/exit from the
          // structural pair's bookend edges. structuralEntry has exactly
          // one outgoing internal edge (to the natural entry); structuralExit
          // has exactly one incoming internal edge (from the natural exit).
          // These are invariants enforced by `wrapSelectedAsSubsystem` and
          // by V7's superRefine; if a malformed file slips through with
          // missing bookends, fall back to the structural node's own id
          // so unwrap stays a partial-recovery rather than a hard crash.
          const entryBookend = s.project.edges.find((e) => e.from === sub.entryNodeId);
          const exitBookend = s.project.edges.find((e) => e.to === sub.exitNodeId);
          const naturalEntryId = entryBookend?.to ?? sub.entryNodeId;
          const naturalExitId = exitBookend?.from ?? sub.exitNodeId;

          // Edges to keep / rewrite. Three cases:
          //   - Bookend edges (structuralEntry → naturalEntry and
          //     naturalExit → structuralExit): dropped, they were
          //     only meaningful inside the subsystem.
          //   - External edges that landed on the container: rewired
          //     to land directly on the natural entry / exit.
          //   - Everything else: passes through unchanged.
          const rewiredEdges = s.project.edges.flatMap((e): ProjectEdge[] => {
            if (e.from === sub.entryNodeId && e.to === naturalEntryId) return [];
            if (e.from === naturalExitId && e.to === sub.exitNodeId) return [];
            if (e.from === sub.containerNodeId) return [{ ...e, from: naturalExitId }];
            if (e.to === sub.containerNodeId) return [{ ...e, to: naturalEntryId }];
            return [e];
          });

          const removedNodeIds = new Set<string>([
            sub.containerNodeId,
            sub.entryNodeId,
            sub.exitNodeId,
          ]);

          return {
            lastIntent: 'Unwrapped sub-system',
            project: {
              ...s.project,
              nodes: s.project.nodes.filter((n) => !removedNodeIds.has(n.id)),
              edges: rewiredEdges,
              subsystems: s.project.subsystems.filter((ss) => ss.id !== subsystemId),
            },
          };
        });
      },

      updateSubsystemName(subsystemId, name) {
        set((s) => {
          const sub = s.project.subsystems.find((ss) => ss.id === subsystemId);
          if (!sub) return s;
          return {
            lastIntent: 'Renamed sub-system',
            project: {
              ...s.project,
              nodes: s.project.nodes.map((n) =>
                n.id === sub.containerNodeId ? { ...n, name } : n,
              ),
            },
          };
        });
      },

      buildSubsystemFile(subsystemId): SubsystemFile | null {
        const state = useDomainStore.getState();
        const sub = state.project.subsystems.find((s) => s.id === subsystemId);
        if (!sub) return null;

        const bodySet = new Set(sub.bodyNodeIds);
        const bodyNodes = state.project.nodes.filter((n) => bodySet.has(n.id));
        const internalEdges = state.project.edges.filter(
          (e) => bodySet.has(e.from) && bodySet.has(e.to),
        );
        const internalLoops = state.project.loops.filter((l) =>
          l.bodyNodeIds.every((id) => bodySet.has(id)),
        );
        const containerNode = state.project.nodes.find((n) => n.id === sub.containerNodeId);
        const name = containerNode?.name ?? 'Sub-system';

        // Nested sub-systems: those whose container node lives in the body.
        const nestedSubsystems = state.project.subsystems.filter((ss) =>
          bodySet.has(ss.containerNodeId),
        );

        return {
          kind: 'caladia-subsystem' as const,
          version: 4 as const,
          name,
          nodes: bodyNodes,
          edges: internalEdges,
          loops: internalLoops,
          // Carry over all calendars and resources so exported files are self-contained.
          calendars: state.project.calendars,
          resources: state.project.resources,
          subsystems: nestedSubsystems,
          entryNodeId: sub.entryNodeId,
          exitNodeId: sub.exitNodeId,
        };
      },

      importSubsystemFromFile(subsystem, position, sourceMeta) {
        // Phase 50 Slice 4 / audit C-6 — re-ID every node, edge, and
        // loop with `crypto.randomUUID()` so two imports within the
        // same millisecond can't collide. The previous formula was
        // `imp-${Date.now()}-${counter}`, which would fold both
        // imports onto the same prefix and silently corrupt refs.
        // UUIDs match the rest of the store's id-gen convention.
        const idMap = new Map<string, string>();
        for (const n of subsystem.nodes) {
          idMap.set(n.id, crypto.randomUUID());
        }
        for (const e of subsystem.edges) {
          idMap.set(e.id, crypto.randomUUID());
        }
        for (const l of subsystem.loops) {
          idMap.set(l.id, crypto.randomUUID());
        }

        const remap = (id: string) => idMap.get(id) ?? id;

        const newNodes: ProjectNode[] = subsystem.nodes.map((n) => ({
          ...n,
          id: remap(n.id),
        }));
        const newEdges: ProjectEdge[] = subsystem.edges.map((e) => ({
          ...e,
          id: remap(e.id),
          from: remap(e.from),
          to: remap(e.to),
        }));
        const newLoops: Loop[] = subsystem.loops.map((l) => ({
          ...l,
          id: remap(l.id),
          bodyNodeIds: l.bodyNodeIds.map(remap),
        }));

        const containerId = crypto.randomUUID();
        const subsystemId = crypto.randomUUID();

        const containerNode: ProjectNode = {
          id: containerId,
          nodeType: 'subsystem',
          name: subsystem.name,
          duration: { value: 0, unit: 'hours' },
          durationSemantic: 'time',
          position,
          calendarId: null,
          consumesResources: false,
          resourceAssignments: [],
        };

        const newSubsystem: Subsystem = {
          id: subsystemId,
          containerNodeId: containerId,
          bodyNodeIds: newNodes.map((n) => n.id),
          entryNodeId: remap(subsystem.entryNodeId),
          exitNodeId: remap(subsystem.exitNodeId),
          ...(sourceMeta !== undefined ? { source: sourceMeta } : {}),
        };

        commitEdit();
        set((s) => ({
          lastIntent: 'Imported sub-system',
          project: {
            ...s.project,
            nodes: [...s.project.nodes, ...newNodes, containerNode],
            edges: [...s.project.edges, ...newEdges],
            loops: [...s.project.loops, ...newLoops],
            subsystems: [...s.project.subsystems, newSubsystem],
          },
        }));
        return null;
      },

      setProject(project) {
        // Bulk-replace path (file load / new project). Intentionally NOT
        // labelled — these aren't undoable user actions in the usual sense
        // and we don't want a toast like "Undone: Loaded file" firing when
        // a Cmd-Z reverts to the snapshot just before the load.
        abortEdit();
        set({ project });
      },

      updateNodePositions(positions) {
        commitEdit();
        const count = Object.keys(positions).length;
        set((state) => ({
          lastIntent: count === 1 ? 'Moved node' : `Moved ${count} nodes`,
          project: {
            ...state.project,
            nodes: state.project.nodes.map((n) => {
              const pos = positions[n.id];
              return pos !== undefined ? { ...n, position: pos } : n;
            }),
          },
        }));
      },

      // ── Project settings (Phase 19 slice 3) ──────────────────────────────
      // NB: no internal commitEdit() — callers (the Project Settings modal)
      // wrap a focus session in beginEdit/commitEdit so multi-character /
      // multi-field edits within one modal session coalesce into a single
      // history entry. Mirrors the updateNodeName / updateResourceAssignmentCount
      // pattern.

      updateProjectName(name) {
        const trimmed = name.trim();
        if (!trimmed) return;
        set((state) => ({
          lastIntent: 'Renamed project',
          project: { ...state.project, project: { ...state.project.project, name: trimmed } },
        }));
      },

      updateProjectStartDate(date) {
        // Reject malformed input rather than corrupting state. The modal's
        // <input type="date"> already constrains to YYYY-MM-DD; this is a
        // defensive guard against direct callers.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
        set((state) => ({
          lastIntent: 'Changed project start date',
          project: { ...state.project, project: { ...state.project.project, startDate: date } },
        }));
      },

      // Phase 42 — switch shareMode + convert any existing shares so the
      // resulting project is schema-valid in the new mode. The conversion
      // is per-node so that nodes without shares stay untouched. Going to
      // 'percentage' is the lossy direction (rounding to integers + fixing
      // remainder); going to 'weight' is identity.
      updateProjectShareMode(mode) {
        commitEdit();
        set((state) => {
          if (state.project.project.shareMode === mode) return state;
          const nextNodes = state.project.nodes.map((n): ProjectNode => {
            const shares = n.resourceAssignments.map((a) => a.share);
            const anySet = shares.some((s) => s !== undefined);
            if (!anySet) return n; // legacy mode for this node — nothing to convert
            if (mode === 'weight') {
              // Identity: existing values are valid weights. No mutation.
              return n;
            }
            // mode === 'percentage' — normalise to integer percentages
            // summing to 100, sharing the helper used by add/remove +
            // distribute-evenly so the rounding math is one definition.
            const sum = (shares as number[]).reduce((s, v) => s + (v ?? 0), 0);
            if (sum <= 0) return n; // sum-zero case; schema would reject either way
            const ints = rebalanceSharesToTarget(shares as number[], 100);
            return {
              ...n,
              resourceAssignments: n.resourceAssignments.map((a, i) => ({
                ...a,
                share: ints[i],
              })),
            };
          });
          return {
            lastIntent: `Switched share mode to ${mode}`,
            project: {
              ...state.project,
              project: { ...state.project.project, shareMode: mode },
              nodes: nextNodes,
            },
          };
        });
      },

      updateProjectDefaultCalendarId(calendarId) {
        // One-shot dropdown change — flush any pending text edit so this
        // lands as its own undo step. Mirrors updateProjectCurrency.
        commitEdit();
        // Phase 40 — pre-compute the "this will inflate time-based effort"
        // warning *before* we mutate, since the toast needs the old and new
        // calendars to phrase the change.
        const before = useDomainStore.getState();
        const fromCal = before.project.calendars.find(
          (c) => c.id === before.project.project.defaultCalendarId,
        );
        const toCal = before.project.calendars.find((c) => c.id === calendarId);
        // Only nodes that inherit the default calendar are affected by this
        // particular action (per-node overrides ride out the change).
        const affected =
          fromCal && toCal && shapeChanged(fromCal, toCal)
            ? countDefaultInheritingTimeNodes(before.project.nodes)
            : 0;

        set((state) => {
          if (!state.project.calendars.some((c) => c.id === calendarId)) return state;
          if (state.project.project.defaultCalendarId === calendarId) return state;
          return {
            lastIntent: 'Changed default calendar',
            project: {
              ...state.project,
              project: { ...state.project.project, defaultCalendarId: calendarId },
            },
          };
        });

        if (affected > 0 && toCal) {
          pushTimeScalingToast(affected, toCal);
        }
      },

      updateCalendarHolidayPreset(calendarId, preset) {
        commitEdit();
        set((state) => {
          const target = state.project.calendars.find((c) => c.id === calendarId);
          if (!target) return state;
          if (target.holidayPreset === preset) return state;
          const version = latestPresetVersion(preset);
          return {
            lastIntent: 'Changed holidays',
            project: {
              ...state.project,
              calendars: state.project.calendars.map((c) =>
                c.id === calendarId
                  ? { ...c, holidayPreset: preset, holidayPresetVersion: version }
                  : c,
              ),
            },
          };
        });
      },

      applyCalendarTemplate(calendarId, templateId) {
        commitEdit();
        // Phase 40 — applying a schedule template wholesale (e.g. swapping
        // 9-5 for 996 on a calendar) is the case the toast cares about most:
        // every time-based node that references this calendar (directly OR
        // through the project default) will silently inflate or shrink. Count
        // *before* mutating so we can compare old → new shape.
        const before = useDomainStore.getState();
        const oldCal = before.project.calendars.find((c) => c.id === calendarId);
        const template = getCalendarTemplate(templateId);
        const newCal: Calendar | undefined =
          oldCal && template
            ? {
                ...oldCal,
                name: template.label,
                workingDays: template.workingDays,
                hoursPerDay: template.hoursPerDay,
                daysPerWeek: template.daysPerWeek,
              }
            : undefined;
        const isDefault =
          oldCal !== undefined && oldCal.id === before.project.project.defaultCalendarId;
        const affected =
          oldCal && newCal && shapeChanged(oldCal, newCal)
            ? countCalendarBoundTimeNodes(before.project.nodes, calendarId, isDefault)
            : 0;

        set((state) => {
          if (!template) return state;
          const target = state.project.calendars.find((c) => c.id === calendarId);
          if (!target) return state;
          return {
            lastIntent: `Applied schedule '${template.label}'`,
            project: {
              ...state.project,
              calendars: state.project.calendars.map((c) =>
                c.id === calendarId
                  ? {
                      ...c,
                      // Rename to the template's label so the calendar's
                      // displayed name stays consistent with its schedule
                      // across the Resource / Node pickers. Picking
                      // "Standard M–F 8h" should leave the calendar named
                      // "Standard M–F 8h", not whatever it was called
                      // before. holidayPreset / exceptions are left alone.
                      name: template.label,
                      workingDays: template.workingDays,
                      hoursPerDay: template.hoursPerDay,
                      daysPerWeek: template.daysPerWeek,
                    }
                  : c,
              ),
            },
          };
        });

        if (affected > 0 && newCal) {
          pushTimeScalingToast(affected, newCal);
        }
      },

      updateNodeCalendarId(nodeId, calendarId) {
        commitEdit();
        set((state) => {
          if (calendarId !== null && !state.project.calendars.some((c) => c.id === calendarId)) {
            return state;
          }
          const target = state.project.nodes.find((n) => n.id === nodeId);
          if (!target) return state;
          if (target.calendarId === calendarId) return state;
          return {
            lastIntent:
              calendarId === null ? 'Cleared node calendar override' : 'Changed node calendar',
            project: {
              ...state.project,
              nodes: state.project.nodes.map(
                (n): ProjectNode => (n.id === nodeId ? { ...n, calendarId } : n),
              ),
            },
          };
        });
      },

      setNodeCalendarFromTemplate(nodeId, templateId) {
        commitEdit();
        set((state) => {
          const template = getCalendarTemplate(templateId);
          if (!template) return state;
          const node = state.project.nodes.find((n) => n.id === nodeId);
          if (!node) return state;

          // Shape-match: if an existing project calendar already has this
          // template's hours / days / working-days, reuse its id so we don't
          // bloat the file with duplicate calendars whenever multiple nodes
          // pick the same template.
          const existing = state.project.calendars.find(
            (c) =>
              c.hoursPerDay === template.hoursPerDay &&
              c.daysPerWeek === template.daysPerWeek &&
              c.workingDays.every((v, i) => v === template.workingDays[i]),
          );
          if (existing) {
            if (node.calendarId === existing.id) return state;
            return {
              lastIntent: `Set calendar to ${template.label}`,
              project: {
                ...state.project,
                nodes: state.project.nodes.map(
                  (n): ProjectNode => (n.id === nodeId ? { ...n, calendarId: existing.id } : n),
                ),
              },
            };
          }

          // Materialise. Calendar id is a fresh UUID rather than something
          // derived from `templateId` so the id stays stable if the user
          // later renames the calendar in Project Settings.
          const newCalendar: Calendar = {
            id: crypto.randomUUID(),
            name: template.label,
            workingDays: template.workingDays,
            hoursPerDay: template.hoursPerDay,
            daysPerWeek: template.daysPerWeek,
            holidayPreset: 'NONE',
            holidayPresetVersion: '1.0',
            exceptions: [],
          };

          return {
            lastIntent: `Set calendar to ${template.label}`,
            project: {
              ...state.project,
              calendars: [...state.project.calendars, newCalendar],
              nodes: state.project.nodes.map(
                (n): ProjectNode => (n.id === nodeId ? { ...n, calendarId: newCalendar.id } : n),
              ),
            },
          };
        });
      },

      updateResourceCalendarId(resourceId, calendarId) {
        commitEdit();
        set((state) => {
          if (!state.project.calendars.some((c) => c.id === calendarId)) return state;
          const target = state.project.resources.find((r) => r.id === resourceId);
          if (!target) return state;
          if (target.calendarId === calendarId) return state;
          return {
            lastIntent: 'Changed resource calendar',
            project: {
              ...state.project,
              resources: state.project.resources.map((r) =>
                r.id === resourceId ? { ...r, calendarId } : r,
              ),
            },
          };
        });
      },

      updateProjectBudget(amount) {
        commitEdit();
        // Strip-then-rebuild so cleared budget doesn't linger as explicit
        // `undefined` (exactOptionalPropertyTypes).
        set((state) => {
          const { budget: _b, ...rest } = state.project;
          if (amount === undefined || amount < 0 || !isFinite(amount)) {
            return { lastIntent: 'Cleared budget', project: rest };
          }
          return { lastIntent: 'Changed budget', project: { ...rest, budget: amount } };
        });
      },

      updateGroupColor(groupName, color) {
        // Audit I-18 — group colors live on the project (V8). Pre-V8 they
        // lived in viewStore; setting a color there was lost on reload and
        // didn't go through the undo stack. This action writes to the
        // persisted `project.groupColors` map; the picker callers don't
        // wrap in begin/commit because they call this once per
        // colour-picker close, not per keystroke.
        commitEdit();
        set((state) => ({
          lastIntent: 'Changed group color',
          project: {
            ...state.project,
            groupColors: { ...state.project.groupColors, [groupName]: color },
          },
        }));
      },

      updateProjectFxSnapshotVersion(version) {
        // Schema requires a non-empty string; treat empty as no-op.
        if (!version) return;
        commitEdit();
        set((state) => ({
          lastIntent: 'Updated FX snapshot',
          project: { ...state.project, fxSnapshotVersion: version },
        }));
      },

      updateProjectCurrency(newCurrency) {
        if (!/^[A-Z]{3}$/.test(newCurrency)) return;
        commitEdit();
        set((state) => {
          const from = state.project.currency;
          if (from === newCurrency) return state;
          // Resolve the effective snapshot for conversion (snapshot + user
          // overrides on top). The conversion fails gracefully — we update
          // the currency code regardless, but skip the value scaling if
          // either currency is unsupported.
          const baseSnapshot = loadFxSnapshot(state.project.fxSnapshotVersion);
          const snap = applyFxOverrides(baseSnapshot, state.project.fxRateOverrides);
          const probe = convertAmount(1, from, newCurrency, snap);
          let nextProject: ProjectFile = { ...state.project, currency: newCurrency };
          if (probe !== null) {
            nextProject = convertCostFields(nextProject, probe);
          }
          return {
            lastIntent: `Changed currency ${from} → ${newCurrency}`,
            project: nextProject,
          };
        });
      },

      updateProjectFxRateOverride(code, value) {
        if (!/^[A-Z]{3}$/.test(code)) return;
        commitEdit();
        set((state) => {
          const existing: Record<string, number> = state.project.fxRateOverrides ?? {};
          const { [code]: _drop, ...rest } = existing;
          if (value === undefined || !isFinite(value) || value <= 0) {
            // Clearing the override — destructure-and-rebuild so the field is
            // absent under exactOptionalPropertyTypes when the map is empty.
            if (Object.keys(rest).length === 0) {
              const { fxRateOverrides: _x, ...projectRest } = state.project;
              return { lastIntent: `Cleared ${code} FX override`, project: projectRest };
            }
            return {
              lastIntent: `Cleared ${code} FX override`,
              project: { ...state.project, fxRateOverrides: rest },
            };
          }
          return {
            lastIntent: `Edited ${code} FX override`,
            project: {
              ...state.project,
              fxRateOverrides: { ...rest, [code]: value },
            },
          };
        });
      },
    }),
    {
      limit: 200,
      // `project` is the load-bearing historical field; `lastIntent` rides
      // alongside it so undo / redo can surface the label of the action
      // being rolled back. Equality is project-only — a same-project push
      // that changes only the intent label is a no-op for history, which
      // matches user intent (re-running the same authored action shouldn't
      // mint a new undo step just because the label string changed).
      partialize: (state) => ({ project: state.project, lastIntent: state.lastIntent }),
      equality: (a, b) => a.project === b.project,
    },
  ),
);

// ── Edit sessions (property-panel focus → blur = one history entry) ───────────
//
// Each text/number input in a property panel calls `beginEdit()` on focus and
// `commitEdit()` on blur. While a session is active, Zundo's temporal
// recording is paused, so rapid keystrokes (and any corrections mid-word)
// don't each produce a history entry. On blur, `commitEdit()` pushes **one**
// entry whose past state is the value from just before the user focused the
// field — so a single ⌘Z restores the pre-edit text.
//
// Structural actions (addNode, deleteNodes, connectNodes, etc.) call
// `commitEdit()` before mutating so an in-flight edit is flushed as its own
// history entry first. This preserves atomicity: edit-then-delete = 2 undo
// steps.

let editSession: { beforeEdit: ProjectFile; beforeIntent: string | null } | null = null;

export function beginEdit(): void {
  if (editSession !== null) return;
  const s = useDomainStore.getState();
  editSession = { beforeEdit: s.project, beforeIntent: s.lastIntent };
  useDomainStore.temporal.getState().pause();
}

export function commitEdit(): void {
  if (editSession === null) return;
  const { beforeEdit, beforeIntent } = editSession;
  editSession = null;
  const temporal = useDomainStore.temporal;
  temporal.getState().resume();
  const current = useDomainStore.getState().project;
  if (current === beforeEdit) return;
  const existing = temporal.getState().pastStates;
  // Snapshot must match the partialize shape: { project, lastIntent }.
  // beforeIntent is what was active at edit-session open, so undo restores
  // the label that described the action just before this edit.
  temporal.setState({
    pastStates: [...existing, { project: beforeEdit, lastIntent: beforeIntent }],
    futureStates: [],
  });
}

export function abortEdit(): void {
  editSession = null;
  useDomainStore.temporal.getState().resume();
}

/** Exposed for tests; not part of the public UI surface. */
export function __hasActiveEditSession(): boolean {
  return editSession !== null;
}

// ── Phase 37 Slice 2: undo / redo with toast feedback ─────────────────────────
//
// Wrap zundo's undo / redo so the user sees a brief toast naming the action
// being rolled back / re-applied. The label comes from `state.lastIntent` —
// authored actions populate it inside their own `set()` call (Slice 3 work),
// so undo of a labeled action surfaces a specific message; everything else
// falls back to a generic label.
//
// The raw temporal API (`useDomainStore.temporal.getState().undo()` /
// `.redo()`) remains available — tests use it directly to avoid coupling
// to view-store side effects. Production call sites (the keyboard hook,
// any toolbar buttons) should go through these wrappers.

const FALLBACK_INTENT_LABEL = 'Last action';

export function undoWithFeedback(): void {
  const temporal = useDomainStore.temporal.getState();
  if (temporal.pastStates.length === 0) return;
  // The label of the action we're about to undo is the *current* lastIntent.
  // After temporal.undo() runs it migrates into futureStates along with the
  // rest of the snapshot, but reading it here is simpler than fishing it out
  // of the future stack post-call.
  const label = useDomainStore.getState().lastIntent ?? FALLBACK_INTENT_LABEL;
  temporal.undo();
  useViewStore.getState().pushToast({ kind: 'info', text: `Undone: ${label}` });
}

export function redoWithFeedback(): void {
  const temporal = useDomainStore.temporal.getState();
  if (temporal.futureStates.length === 0) return;
  // The label of the action we're about to redo lives on the most-recently
  // pushed future entry — i.e. the state we're about to restore TO. Its
  // `lastIntent` describes the action that originally produced that state.
  const nextSnapshot = temporal.futureStates.at(-1);
  const label = nextSnapshot?.lastIntent ?? FALLBACK_INTENT_LABEL;
  temporal.redo();
  useViewStore.getState().pushToast({ kind: 'info', text: `Redone: ${label}` });
}

// ── Temporal accessor (typed hook to read undo/redo state from React) ─────────

export function useTemporalStore<T>(
  selector: (state: TemporalState<Pick<DomainState, 'project' | 'lastIntent'>>) => T,
): T {
  return useStore(useDomainStore.temporal, selector);
}
