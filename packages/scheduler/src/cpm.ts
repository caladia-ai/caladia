import type { ProjectEdge, ProjectNode } from '@procsim/file-format';
import type { PreparedCalendar } from '@procsim/calendar';
import { addWorkingHoursP, snapToNextWorkStartP, workingHoursBetweenP } from '@procsim/calendar';
import { topoSort } from './topo.js';
import { effectiveDurationHours, toHours } from './utils.js';
import {
  bodyCriticalChains,
  buildCondensedGraph,
  buildLoopResourceEntries,
  deterministicIterationCount,
  distributeLoopSchedule,
  isSuperNode,
  loopIdFromSuperNode,
  superNodeId,
} from './loop.js';
import type {
  NodeSchedule,
  ResourceTimelineEntry,
  ScheduleInput,
  ScheduleOutcome,
  ScheduleResult,
  ValidationWarning,
} from './types.js';
import { computeCosts } from './cost.js';
import { computeConflictedNodes } from './conflicts.js';
import { prepareSchedule, type PreparedSchedule, type SampledInputs } from './prepared.js';

// ── CPM engine ────────────────────────────────────────────────────────────────

interface NodeState {
  es: Date; // earliest start
  ef: Date; // earliest finish
}

interface BackwardState {
  ls: Date; // latest start
  lf: Date; // latest finish
}

/**
 * Convenience entry point for one-shot scheduling. Wraps the
 * `prepareSchedule` / `scheduleFromPrepared` pair — same I/O as before,
 * just internally split so Monte Carlo can hoist `prepareSchedule` out
 * of its iteration loop.
 *
 * Semantics are byte-identical to the pre-Slice-3 schedule(). Slice 1.5's
 * snapshot canary enforces this.
 */
export function schedule(rawInput: ScheduleInput): ScheduleOutcome {
  const prep = prepareSchedule(rawInput);
  if (!prep.ok) return { ok: false, errors: prep.errors };
  return runScheduleFromPrepared(prep.prepared, {
    nodes: rawInput.nodes,
    resources: rawInput.resources,
    ...(rawInput.sampledLoopIterations !== undefined
      ? { sampledLoopIterations: rawInput.sampledLoopIterations }
      : {}),
  });
}

/**
 * Per-iteration scheduling pass. Consumes the iteration-invariant
 * `PreparedSchedule` (built once via `prepareSchedule`) + the per-
 * iteration sampled scalars. Used by `simulate()` to skip the prepare
 * work on every iteration.
 *
 * All calendar arithmetic uses the prepared-calendar fast path
 * (`addWorkingHoursP`, `workingHoursBetweenP`, `snapToNextWorkStartP`).
 */
export function runScheduleFromPrepared(
  prep: PreparedSchedule,
  sampled: SampledInputs,
): ScheduleOutcome {
  // `prep.input` is post-flatten; node identities and edges are stable.
  // Override the per-iter scalars by reconstructing the input view the
  // CPM engine operates on. nodes / resources / sampledLoopIterations
  // come from `sampled`; everything else from prep.
  const input: ScheduleInput = {
    project: prep.input.project,
    nodes: sampled.nodes,
    edges: prep.input.edges,
    resources: sampled.resources,
    calendars: prep.input.calendars,
    loops: prep.input.loops,
    ...(sampled.sampledLoopIterations !== undefined
      ? { sampledLoopIterations: sampled.sampledLoopIterations }
      : {}),
    ...(prep.input.subsystems !== undefined ? { subsystems: prep.input.subsystems } : {}),
  };

  const { calMap, defaultCal, resourceMap, nodeEffectiveCal, preparedCalById, defaultPrepared } =
    prep;

  // ── Calendar lookup helpers ──────────────────────────────────────────────
  //
  // The hot path uses the prepared-calendar fast path; the raw `Calendar`
  // is still needed for `toHours` (hoursPerDay / daysPerWeek) and
  // `effectiveDurationHours` (semantic + crash duration math), so we
  // expose both via paired getters.

  function getNodeCal(nodeId: string) {
    return nodeEffectiveCal.get(nodeId) ?? defaultCal;
  }
  function getNodePrep(nodeId: string): PreparedCalendar {
    const cal = nodeEffectiveCal.get(nodeId);
    if (cal !== undefined) {
      const p = preparedCalById.get(cal.id);
      if (p !== undefined) return p;
    }
    return defaultPrepared;
  }

  // ── Loop condensation ────────────────────────────────────────────────────
  // Super-node duration depends on sampled iteration counts → per-iter.

  const hasLoops = input.loops.length > 0;
  const condensed = hasLoops
    ? buildCondensedGraph(
        input.nodes,
        input.edges,
        input.loops,
        defaultCal,
        calMap,
        resourceMap,
        input.sampledLoopIterations,
      )
    : null;

  const schedNodes = condensed ? condensed.nodes : input.nodes;
  const schedEdges = condensed ? condensed.edges : input.edges;

  const topo = topoSort(
    schedNodes.map((n) => n.id),
    schedEdges,
  );
  if (!topo.ok) {
    return {
      ok: false,
      errors: [{ path: 'edges', message: `Cycle detected: ${topo.cycle.join(', ')}` }],
    };
  }

  const nodeMap = new Map(schedNodes.map((n) => [n.id, n]));

  // Super-node calendar lookup falls back to default.
  function nodeCalFor(node: ProjectNode) {
    return isSuperNode(node.id) ? defaultCal : getNodeCal(node.id);
  }
  function nodePrepFor(node: ProjectNode) {
    return isSuperNode(node.id) ? defaultPrepared : getNodePrep(node.id);
  }

  // Project start (snapped under default calendar's fast path).
  const projectStart = snapToNextWorkStartP(
    defaultPrepared,
    new Date(input.project.startDate + 'T00:00:00'),
  );

  // Build inbound/outbound edge indexes for the condensed graph.
  const inEdges = new Map<string, ProjectEdge[]>();
  const outEdges = new Map<string, ProjectEdge[]>();
  for (const n of schedNodes) {
    inEdges.set(n.id, []);
    outEdges.set(n.id, []);
  }
  for (const e of schedEdges) {
    inEdges.get(e.to)?.push(e);
    outEdges.get(e.from)?.push(e);
  }

  // ── Per-node effective floor (Phase 10 Tier 1, multi-Start) ─────────────
  const effectiveFloor = new Map<string, Date>();
  for (const n of schedNodes) effectiveFloor.set(n.id, projectStart);

  const fwdAdj = new Map<string, string[]>();
  for (const n of schedNodes) fwdAdj.set(n.id, []);
  for (const e of schedEdges) fwdAdj.get(e.from)?.push(e.to);

  for (const s of schedNodes) {
    if (s.nodeType !== 'start' || s.anchorDate === undefined) continue;
    const sPrep = nodePrepFor(s);
    const sFloor = snapToNextWorkStartP(sPrep, new Date(s.anchorDate + 'T00:00:00'));
    if (sFloor >= projectStart) continue;
    const visited = new Set<string>([s.id]);
    const queue: string[] = [s.id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const curFloor = effectiveFloor.get(cur)!;
      if (sFloor < curFloor) effectiveFloor.set(cur, sFloor);
      for (const next of fwdAdj.get(cur) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
  }

  // ── Forward pass ────────────────────────────────────────────────────────

  const forward = new Map<string, NodeState>();

  for (const nodeId of topo.order) {
    const node = nodeMap.get(nodeId)!;
    const nodeCal = nodeCalFor(node);
    const nodePrep = nodePrepFor(node);
    const durationHrs = effectiveDurationHours(node, nodeCal);

    let rawEs =
      node.nodeType === 'start' && node.anchorDate !== undefined
        ? snapToNextWorkStartP(nodePrep, new Date(node.anchorDate + 'T00:00:00'))
        : (effectiveFloor.get(nodeId) ?? projectStart);

    for (const edge of inEdges.get(nodeId) ?? []) {
      const pred = forward.get(edge.from)!;
      const lagHrs = toHours(edge.lag, nodeCal);

      let constraint: Date;
      switch (edge.type) {
        case 'FS':
          constraint = addWorkingHoursP(nodePrep, pred.ef, lagHrs);
          break;
        case 'SS':
          constraint = addWorkingHoursP(nodePrep, pred.es, lagHrs);
          break;
        case 'FF':
          constraint = addWorkingHoursP(nodePrep, pred.ef, lagHrs - durationHrs);
          break;
        case 'SF':
          constraint = addWorkingHoursP(nodePrep, pred.es, lagHrs - durationHrs);
          break;
      }

      if (constraint > rawEs) rawEs = constraint;
    }

    const ef = durationHrs === 0 ? rawEs : addWorkingHoursP(nodePrep, rawEs, durationHrs);
    forward.set(nodeId, { es: rawEs, ef });
  }

  let projectEnd: Date | null = null;
  for (const { ef } of forward.values()) {
    if (projectEnd === null || ef > projectEnd) projectEnd = ef;
  }
  if (projectEnd === null) projectEnd = projectStart;

  // ── Backward pass ───────────────────────────────────────────────────────

  const backward = new Map<string, BackwardState>();

  for (const nodeId of [...topo.order].reverse()) {
    const node = nodeMap.get(nodeId)!;
    const nodeCal = nodeCalFor(node);
    const nodePrep = nodePrepFor(node);
    const durationHrs = effectiveDurationHours(node, nodeCal);

    let lf = projectEnd;

    for (const edge of outEdges.get(nodeId) ?? []) {
      const succ = backward.get(edge.to)!;
      const succNode = nodeMap.get(edge.to)!;
      const succCal = nodeCalFor(succNode);
      const succPrep = nodePrepFor(succNode);
      const lagHrs = toHours(edge.lag, succCal);
      const predDurationHrs = durationHrs;

      let constraint: Date;
      switch (edge.type) {
        case 'FS':
          constraint = addWorkingHoursP(succPrep, succ.ls, -lagHrs);
          break;
        case 'SS':
          constraint = addWorkingHoursP(
            nodePrep,
            addWorkingHoursP(succPrep, succ.ls, -lagHrs),
            predDurationHrs,
          );
          break;
        case 'FF':
          constraint = addWorkingHoursP(succPrep, succ.lf, -lagHrs);
          break;
        case 'SF':
          constraint = addWorkingHoursP(
            nodePrep,
            addWorkingHoursP(succPrep, succ.lf, -lagHrs),
            predDurationHrs,
          );
          break;
      }

      if (constraint < lf) lf = constraint;
    }

    const ls = addWorkingHoursP(nodePrep, lf, -durationHrs);
    backward.set(nodeId, { ls, lf });
  }

  // ── Build result ────────────────────────────────────────────────────────

  const SLACK_EPSILON = 0.0001;
  const warnings: ValidationWarning[] = [];
  const nodes: Record<string, NodeSchedule> = {};

  const bodyNodeIds = new Set<string>(hasLoops ? input.loops.flatMap((l) => l.bodyNodeIds) : []);

  for (const node of schedNodes) {
    if (isSuperNode(node.id)) continue;
    const nodeCal = nodeCalFor(node);
    const nodePrep = nodePrepFor(node);
    const fwd = forward.get(node.id)!;
    const bwd = backward.get(node.id)!;
    const isInstant = toHours(node.duration, nodeCal, node.durationSemantic) === 0;

    const earliestFinish = fwd.ef;
    const earliestStart = isInstant ? earliestFinish : snapToNextWorkStartP(nodePrep, fwd.es);
    const latestFinish = bwd.lf;
    const latestStart = isInstant ? latestFinish : bwd.ls;

    const slackHours = workingHoursBetweenP(nodePrep, earliestFinish, latestFinish);
    const onCriticalPath = slackHours <= SLACK_EPSILON;

    nodes[node.id] = {
      nodeId: node.id,
      earliestStart,
      earliestFinish,
      latestStart,
      latestFinish,
      slackHours: Math.max(0, slackHours),
      onCriticalPath,
    };
  }

  // Original-input node lookup. Used by:
  //   - the loop-body critical-chain analysis (taut-edge calendar lookups
  //     need access to body nodes, which aren't in `schedNodes` because
  //     they were collapsed into super-nodes).
  //   - the main critical-path tracer below.
  const originalNodeMap = new Map(input.nodes.map((n) => [n.id, n]));

  // Phase 50 Slice 18 — per-loop body critical-chain data. Built once,
  // consumed twice: by `distributeLoopSchedule` for the `onCriticalPath`
  // flag on body nodes (audit I-1 half one), and by the path-tracer
  // expansion below for the `criticalPaths[][]` output (I-1 half two).
  const bodyChainsByLoop = new Map<string, string[][]>();

  // Track which super-nodes are on the critical path. Super-nodes don't
  // appear in the `result.nodes` record (it's keyed by user-authored
  // node ids only), so the path-tracer can't infer their criticality
  // from there. Set here in the loop-body distribution block where the
  // super-node's slack is computed.
  const criticalSuperNodeIds = new Set<string>();

  // Loop body distribution.
  if (condensed) {
    for (const loop of input.loops) {
      const sid = superNodeId(loop.id);
      const fwd = forward.get(sid)!;
      const bwd = backward.get(sid)!;
      const supPrep = defaultPrepared;

      const earliestStart = snapToNextWorkStartP(supPrep, fwd.es);
      const earliestFinish = fwd.ef;
      const slackHours = workingHoursBetweenP(supPrep, earliestFinish, bwd.lf);

      const superSchedule: NodeSchedule = {
        nodeId: sid,
        earliestStart,
        earliestFinish,
        latestStart: bwd.ls,
        latestFinish: bwd.lf,
        slackHours: Math.max(0, slackHours),
        onCriticalPath: slackHours <= SLACK_EPSILON,
      };

      if (superSchedule.onCriticalPath) {
        criticalSuperNodeIds.add(sid);
      }

      const bodyNodes = input.nodes.filter((n) => loop.bodyNodeIds.includes(n.id));
      const offsets = condensed.bodyOffsetsMap.get(loop.id) ?? new Map();
      const cpHours = condensed.bodyCPHoursMap.get(loop.id) ?? 0;

      // Build the taut intra-body successor map for this loop. An edge is
      // "taut" when its constraint formula evaluates to the successor's
      // body-ES — i.e., this edge is binding for the successor's earliest
      // start. Calendar-aware lag conversion lives here (rather than in
      // loop.ts) so the pure graph traversal in `bodyCriticalChains` stays
      // mocking-free.
      const bodyIdSet = new Set(loop.bodyNodeIds);
      const tautSuccessors = new Map<string, string[]>();
      for (const id of loop.bodyNodeIds) tautSuccessors.set(id, []);

      for (const edge of input.edges) {
        if (!bodyIdSet.has(edge.from) || !bodyIdSet.has(edge.to)) continue;
        const fromO = offsets.get(edge.from);
        const toO = offsets.get(edge.to);
        if (!fromO || !toO) continue;

        const toNode = originalNodeMap.get(edge.to)!;
        const toCal = getNodeCal(toNode.id);
        const toPrepHrs = effectiveDurationHours(toNode, toCal);
        const lagHrs = toHours(edge.lag, toCal);

        let constraint: number;
        switch (edge.type) {
          case 'FS':
            constraint = fromO.efHours + lagHrs;
            break;
          case 'SS':
            constraint = fromO.esHours + lagHrs;
            break;
          case 'FF':
            constraint = fromO.efHours + lagHrs - toPrepHrs;
            break;
          case 'SF':
            constraint = fromO.esHours + lagHrs - toPrepHrs;
            break;
        }

        if (Math.abs(constraint - toO.esHours) <= SLACK_EPSILON) {
          tautSuccessors.get(edge.from)!.push(edge.to);
        }
      }

      const bodyData = bodyCriticalChains({
        bodyNodeIds: loop.bodyNodeIds,
        offsets,
        cpHours,
        tautSuccessors,
      });

      bodyChainsByLoop.set(loop.id, bodyData.chains);

      const bodySchedules = distributeLoopSchedule(
        loop,
        superSchedule,
        bodyNodes,
        offsets,
        cpHours,
        getNodePrep,
        bodyData.criticalNodes,
      );
      Object.assign(nodes, bodySchedules);
    }
  }

  // ── Critical path(s) ────────────────────────────────────────────────────

  // Phase 50 Slice 18 — operate at the condensed-graph level. Body nodes
  // are excluded from `criticalIds` here; they're reintroduced by the
  // super-node expansion below. Iterate `schedEdges` (which has body
  // endpoints already rewritten to super-node ids) so cross-loop
  // boundary edges (external→super-node, super-node→external) are
  // visible to the tracer. The prior code iterated `input.edges` and
  // skipped any body-touching edge, which dropped the boundary edges
  // entirely — so loop-containing projects produced only single-node
  // critical paths.
  const criticalIds = new Set<string>([
    ...schedNodes.filter((n) => !isSuperNode(n.id) && nodes[n.id]?.onCriticalPath).map((n) => n.id),
    ...criticalSuperNodeIds,
  ]);

  const critSuccessors = new Map<string, string[]>();
  for (const id of criticalIds) critSuccessors.set(id, []);

  for (const edge of schedEdges) {
    if (!criticalIds.has(edge.from) || !criticalIds.has(edge.to)) continue;

    const fwdFrom = forward.get(edge.from);
    const fwdTo = forward.get(edge.to);
    if (!fwdFrom || !fwdTo) continue;

    const toNode = nodeMap.get(edge.to)!;
    const toCal = nodeCalFor(toNode);
    const toPrep = nodePrepFor(toNode);
    const lagHrs = toHours(edge.lag, toCal);
    const toDurationHrs = effectiveDurationHours(toNode, toCal);

    let constraint: Date;
    switch (edge.type) {
      case 'FS':
        constraint = addWorkingHoursP(toPrep, fwdFrom.ef, lagHrs);
        break;
      case 'SS':
        constraint = addWorkingHoursP(toPrep, fwdFrom.es, lagHrs);
        break;
      case 'FF':
        constraint = addWorkingHoursP(toPrep, fwdFrom.ef, lagHrs - toDurationHrs);
        break;
      case 'SF':
        constraint = addWorkingHoursP(toPrep, fwdFrom.es, lagHrs - toDurationHrs);
        break;
    }

    const diff = Math.abs(workingHoursBetweenP(toPrep, constraint, fwdTo.es));
    if (diff <= SLACK_EPSILON) {
      critSuccessors.get(edge.from)!.push(edge.to);
    }
  }

  const hasCriticalPred = new Set<string>();
  for (const [, succs] of critSuccessors.entries()) {
    for (const s of succs) hasCriticalPred.add(s);
  }
  const critSources = [...criticalIds].filter((id) => !hasCriticalPred.has(id));

  const rawCriticalPaths: string[][] = [];
  function dfs(current: string, path: string[]): void {
    path.push(current);
    const succs = critSuccessors.get(current) ?? [];
    if (succs.length === 0) {
      rawCriticalPaths.push([...path]);
    } else {
      for (const s of succs) dfs(s, path);
    }
    path.pop();
  }
  for (const src of critSources) dfs(src, []);

  // Phase 50 Slice 18 — expand super-node ids to the body's critical
  // chains. Half two of audit row I-1: the raw DFS produces paths
  // containing `__loop__<id>` synthetic ids in place of the body's
  // critical work. Replace each with the body chain(s) computed
  // earlier (`bodyChainsByLoop`). Multiple chains → cross-product
  // forks the enclosing path. A loop with no chains (degenerate /
  // zero-cpHours body) is treated as an empty chain — the super-node
  // id is dropped from the path. Non-super ids pass through.
  const criticalPaths: string[][] = [];
  for (const path of rawCriticalPaths) {
    let expanded: string[][] = [[]];
    for (const id of path) {
      if (isSuperNode(id)) {
        const loopId = loopIdFromSuperNode(id);
        const chains = bodyChainsByLoop.get(loopId);
        const usableChains = chains && chains.length > 0 ? chains : [[]];
        const next: string[][] = [];
        for (const prefix of expanded) {
          for (const chain of usableChains) {
            next.push([...prefix, ...chain]);
          }
        }
        expanded = next;
      } else {
        expanded = expanded.map((p) => [...p, id]);
      }
    }
    for (const p of expanded) criticalPaths.push(p);
  }

  // ── Resource timeline ───────────────────────────────────────────────────

  const resourceTimeline: ResourceTimelineEntry[] = [];

  for (const node of input.nodes) {
    if (bodyNodeIds.has(node.id)) continue;
    if (!node.consumesResources) continue;
    const sched = nodes[node.id]!;
    for (const asgn of node.resourceAssignments) {
      if (!resourceMap.has(asgn.resourceId)) continue;
      resourceTimeline.push({
        resourceId: asgn.resourceId,
        nodeId: node.id,
        iteration: 0,
        start: sched.earliestStart,
        end: sched.earliestFinish,
        count: asgn.count,
      });
    }
  }

  if (condensed) {
    for (const loop of input.loops) {
      const sid = superNodeId(loop.id);
      const fwd = forward.get(sid);
      if (!fwd) continue;

      const loopStart = snapToNextWorkStartP(defaultPrepared, fwd.es);
      const bodyNodes = input.nodes.filter((n) => loop.bodyNodeIds.includes(n.id));
      const offsets = condensed.bodyOffsetsMap.get(loop.id) ?? new Map();
      const cpHours = condensed.bodyCPHoursMap.get(loop.id) ?? 0;

      const iterations =
        input.sampledLoopIterations?.[loop.id] ?? deterministicIterationCount(loop);

      const entries = buildLoopResourceEntries(
        loop,
        loopStart,
        bodyNodes,
        offsets,
        cpHours,
        iterations,
        defaultPrepared,
        input.resources,
        getNodePrep,
      );
      resourceTimeline.push(...entries);
    }
  }

  // ── Cost pass ───────────────────────────────────────────────────────────

  const { nodeCosts, resourceCosts, projectCost } = computeCosts(input);

  const conflictedNodeIds = computeConflictedNodes(
    resourceTimeline,
    input.resources,
    input.project.startDate,
    input.subsystems ?? [],
  );

  const result: ScheduleResult = {
    nodes,
    criticalPaths,
    resourceTimeline,
    projectEnd,
    warnings,
    nodeCosts,
    resourceCosts,
    projectCost,
    conflictedNodeIds,
  };

  return { ok: true, result };
}
