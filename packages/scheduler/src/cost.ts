/**
 * Phase 19 — Cost pass.
 *
 * A third deterministic pass over the unrolled timeline that runs after the
 * forward / backward CPM and the resource timeline build. Pure: no DOM, no
 * I/O, no time-of-day reads. The pass walks `input.nodes` (post-flatten)
 * once, charges every node, then walks the preserved `subsystems` map
 * (deepest-first) to roll body totals into container ids.
 *
 * Why a separate pass instead of folding into the resource timeline build:
 * the resource pass already iterates the unrolled timeline for distinct
 * reasons (per-iteration ResourceTimelineEntry emission for the UI's
 * histogram). Mixing in cost would tangle two concerns; downstream tests
 * become harder to reason about; and slice 2's per-iteration Monte Carlo
 * cost accumulator needs a clean seam to plug into. See ARCHITECTURE.md
 * "Cost as a third deterministic pass over the unrolled timeline."
 */

import type { Calendar, ProjectNode, Resource } from '@procsim/file-format';
import {
  assignmentEffectiveDurationHours,
  assignmentShareTotal,
  nodeBaseHours,
  nodeEffectiveWorkingCalendar,
  perPoolBaseHours,
} from './utils.js';
import { deterministicIterationCount } from './loop.js';
import type { NodeCost, ScheduleInput } from './types.js';

export interface CostResult {
  nodeCosts: Record<string, NodeCost>;
  resourceCosts: Record<string, number>;
  projectCost: number;
}

/**
 * Compute deterministic cost outputs for a schedule.
 *
 * `flatInput` is the post-flatten `ScheduleInput` (container nodes already
 * removed). The original `subsystems` map is consumed here for the
 * container rollup — `flattenSubsystems` preserves it on its output.
 *
 * `sampledLoopIterations` is the same field the resource pass reads. In
 * deterministic mode it's undefined and we derive iteration counts from
 * each loop's kickout / expectedIterations.
 */
export function computeCosts(flatInput: ScheduleInput): CostResult {
  const resourceMap = new Map<string, Resource>(flatInput.resources.map((r) => [r.id, r]));
  const calMap = new Map<string, Calendar>(flatInput.calendars.map((c) => [c.id, c]));
  const defaultCal = calMap.get(flatInput.project.defaultCalendarId);

  // nodeId → loopId map for body-node lookups.
  const loopOfBodyNode = new Map<string, string>();
  for (const loop of flatInput.loops) {
    for (const nid of loop.bodyNodeIds) {
      loopOfBodyNode.set(nid, loop.id);
    }
  }

  // loopId → iteration count (sampled or deterministic).
  function iterationCountFor(loopId: string): number {
    const sampled = flatInput.sampledLoopIterations?.[loopId];
    if (sampled !== undefined) return sampled;
    const loop = flatInput.loops.find((l) => l.id === loopId);
    return loop ? deterministicIterationCount(loop) : 1;
  }

  const nodeCosts: Record<string, NodeCost> = {};
  const resourceCosts: Record<string, number> = {};

  function addToResource(resourceId: string, amount: number): void {
    resourceCosts[resourceId] = (resourceCosts[resourceId] ?? 0) + amount;
  }

  // ── Pass 1: per-node cost on every flat node ────────────────────────────
  for (const node of flatInput.nodes) {
    if (node.nodeType === 'subsystem') continue; // safety — flatten removed these
    const cost = costForNode(
      node,
      defaultCal,
      calMap,
      resourceMap,
      loopOfBodyNode,
      iterationCountFor,
      addToResource,
    );
    nodeCosts[node.id] = cost;
  }

  // ── Pass 2: sub-system container roll-ups (deepest-first) ─────────────────
  // An outer sub-system's bodyNodeIds may include an inner sub-system's
  // container id — by the time we sum that body, the inner container must
  // already be present in nodeCosts. The flatten module documents the
  // nesting-depth strategy; mirror it here.
  const subsystems = flatInput.subsystems ?? [];
  if (subsystems.length > 0) {
    const subById = new Map(subsystems.map((s) => [s.id, s]));
    const bodyNodeToSubId = new Map<string, string>();
    for (const sub of subsystems) {
      for (const nid of sub.bodyNodeIds) bodyNodeToSubId.set(nid, sub.id);
    }
    function depthOf(subId: string, visited: Set<string>): number {
      if (visited.has(subId)) return 0;
      visited.add(subId);
      const sub = subById.get(subId);
      if (!sub) return 0;
      const parent = bodyNodeToSubId.get(sub.containerNodeId);
      return parent === undefined ? 0 : 1 + depthOf(parent, visited);
    }
    const ordered = [...subsystems].sort(
      (a, b) => depthOf(b.id, new Set()) - depthOf(a.id, new Set()),
    );
    for (const sub of ordered) {
      let fromResources = 0;
      let fromFixed = 0;
      let fromCrash = 0;
      for (const bodyId of sub.bodyNodeIds) {
        const c = nodeCosts[bodyId];
        if (!c) continue;
        fromResources += c.fromResources;
        fromFixed += c.fromFixed;
        fromCrash += c.fromCrash;
      }
      nodeCosts[sub.containerNodeId] = {
        fromResources,
        fromFixed,
        fromCrash,
        total: fromResources + fromFixed + fromCrash,
      };
    }
  }

  // ── Project total ────────────────────────────────────────────────────────
  // Sum the FLAT nodes only — container rollups are derived from those same
  // body costs, so including them would double-count.
  let projectCost = 0;
  for (const node of flatInput.nodes) {
    if (node.nodeType === 'subsystem') continue;
    projectCost += nodeCosts[node.id]?.total ?? 0;
  }

  return { nodeCosts, resourceCosts, projectCost };
}

// ── Internals ─────────────────────────────────────────────────────────────────

function costForNode(
  node: ProjectNode,
  defaultCal: Calendar | undefined,
  calMap: Map<string, Calendar>,
  resourceMap: Map<string, Resource>,
  loopOfBodyNode: Map<string, string>,
  iterationCountFor: (loopId: string) => number,
  addToResource: (resourceId: string, amount: number) => void,
): NodeCost {
  // Anchor nodes (start / end) and any node without a working calendar
  // configured contribute zero cost. Schema already rejects `fixedCost`
  // on start / end so this is just a safety floor.
  if (!defaultCal) return { fromResources: 0, fromFixed: 0, fromCrash: 0, total: 0 };
  if (node.nodeType === 'start' || node.nodeType === 'end') {
    return { fromResources: 0, fromFixed: 0, fromCrash: 0, total: 0 };
  }

  const loopId = loopOfBodyNode.get(node.id);
  const iterations = loopId !== undefined ? iterationCountFor(loopId) : 1;

  const nodeCal = nodeEffectiveWorkingCalendar(node, calMap, defaultCal, resourceMap);
  // Phase 23 — cost uses `nodeBaseHours` (raw duration + decision
  // penalty for gate nodes), NOT the post-parallelism bottleneck.
  // Each assignment's own parallelism factor applies independently
  // inside the loop below — perfect parallel (α=1, count=N) keeps
  // total resource cost at `rate × baseHours` because the count
  // factor cancels.
  const baseHours = nodeBaseHours(node, nodeCal);

  // Phase 26 follow-up — resource-rate multiplier from the selected
  // compression option, if any. Models overtime / premium-contractor
  // pricing where compression makes the hourly rate go up. Default 1.0
  // (absent ≡ 1.0) means "pure expedite" — resource cost shrinks
  // linearly with compressed duration, the original Phase 25 behaviour.
  // Applies to `rateCost` only; `perUse` (mobilisation) and the
  // separate `fromCrash` bucket are not scaled.
  let resourceRateMult = 1;
  if (node.selectedCrashIndex !== undefined && node.crashOptions) {
    const opt = node.crashOptions[node.selectedCrashIndex];
    if (opt && opt.resourceCostMultiplier !== undefined) {
      resourceRateMult = opt.resourceCostMultiplier;
    }
  }

  // Resource-driven cost. Skip when consumesResources is false (wait state).
  let fromResources = 0;
  if (node.consumesResources) {
    // Phase 42 — compute the share total once per node so per-assignment
    // share scaling is O(1) inside the loop. shareTotal === 0 means
    // legacy mode (no shares anywhere) and `perPoolBaseHours` returns
    // the full baseHours — byte-equal with the pre-Phase-42 cost engine.
    const shareTotal = assignmentShareTotal(node.resourceAssignments);
    for (const asgn of node.resourceAssignments) {
      const resource = resourceMap.get(asgn.resourceId);
      if (!resource) continue;
      const rate = resource.costRate ?? 0;
      const perUse = resource.costPerUse ?? 0;

      // Phase 23 — per-assignment effective hours, NOT the bottleneck.
      // Each assignment is paid for the work it actually does. With
      // legacy assignments (parallelism absent / 0) this collapses to
      // `baseHours`, byte-equal with the pre-Phase-23 cost engine.
      // Phase 42 — when shares are present, each pool is paid for its
      // share of the work, not the full baseHours.
      const perPool = perPoolBaseHours(baseHours, asgn, shareTotal);
      const asgnHours = assignmentEffectiveDurationHours(perPool, asgn);
      // Phase 26 follow-up — multiply the rate side by the compression
      // option's `resourceCostMultiplier` (defaults to 1.0 = unchanged).
      const rateCost = rate * resourceRateMult * asgnHours * asgn.count * iterations;
      // costPerUse fires once per resourceAssignment instance, NOT per loop
      // iteration. A resource brought in for a loop body pays the
      // mobilization fee on first entry; iteration charges are hours-based.
      // The `count` multiplier reflects bringing N copies of the resource
      // (each copy mobilizes). Not affected by the compression rate
      // multiplier — per-use is a mobilisation fee, not an hourly charge.
      const onceCost = perUse * asgn.count;

      const contribution = rateCost + onceCost;
      fromResources += contribution;
      // Skip writing a 0 entry for resources that contribute nothing — keeps
      // `resourceCosts` empty for cost-free projects, which the UI uses as
      // the "no cost data anywhere" empty-state signal.
      if (contribution > 0) addToResource(asgn.resourceId, contribution);
    }
  }

  // Fixed cost. Loop-body nodes charge per iteration by default;
  // fixedCostOnce: true marks a one-time charge inside the loop.
  let fromFixed = 0;
  if (node.fixedCost) {
    const onceInLoop = node.fixedCostOnce === true;
    const multiplier = loopId !== undefined && !onceInLoop ? iterations : 1;
    fromFixed = node.fixedCost.value * multiplier;
  }

  // Phase 25 — crash add-on. Follows the same loop-iteration semantics as
  // fixedCost (per-iteration by default; one-time when `fixedCostOnce: true`).
  // Crash is conceptually another node-level one-time spend; treating it
  // identically to fixedCost keeps the per-iteration vs one-time decision
  // configured in a single place.
  let fromCrash = 0;
  if (node.selectedCrashIndex !== undefined && node.crashOptions) {
    const opt = node.crashOptions[node.selectedCrashIndex];
    if (opt) {
      const onceInLoop = node.fixedCostOnce === true;
      const multiplier = loopId !== undefined && !onceInLoop ? iterations : 1;
      fromCrash = opt.additionalCost * multiplier;
    }
  }

  return {
    fromResources,
    fromFixed,
    fromCrash,
    total: fromResources + fromFixed + fromCrash,
  };
}
