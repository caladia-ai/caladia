/**
 * Loop scheduling helpers.
 *
 * A Loop wraps a subgraph that repeats N times in sequence. The edge graph
 * remains a DAG — there are no back-edges. The "cyclic" behaviour is conveyed
 * by the Loop metadata alone.
 *
 * Two-pass design (load-bearing — see ARCHITECTURE.md):
 *  1. Condensed timing pass: each loop's body collapses into a single super-node
 *     whose duration = iterationCount × bodyCriticalPath. Standard CPM runs on
 *     the condensed DAG.
 *  2. Resource unrolling: each body is expanded into N sequential copies.
 *     Activities with consumesResources=false produce no ResourceTimelineEntry.
 */

import type { Calendar, Loop, ProjectEdge, ProjectNode, Resource } from '@procsim/file-format';
import type { PreparedCalendar } from '@procsim/calendar';
import { addWorkingHoursP, snapToNextWorkStartP } from '@procsim/calendar';
import type { NodeSchedule, ResourceTimelineEntry } from './types.js';
import { topoSort } from './topo.js';
import { effectiveDurationHours, nodeEffectiveWorkingCalendar, toHours } from './utils.js';

// ── Super-node ID helpers ─────────────────────────────────────────────────────

const SUPER_PREFIX = '__loop__';

export function superNodeId(loopId: string): string {
  return `${SUPER_PREFIX}${loopId}`;
}

export function isSuperNode(nodeId: string): boolean {
  return nodeId.startsWith(SUPER_PREFIX);
}

export function loopIdFromSuperNode(id: string): string {
  return id.slice(SUPER_PREFIX.length);
}

// ── Deterministic iteration count ────────────────────────────────────────────

/**
 * Return the deterministic iteration count for CPM scheduling.
 * Monte Carlo passes overrides via ScheduleInput.sampledLoopIterations.
 */
export function deterministicIterationCount(loop: Loop): number {
  const k = loop.kickout;
  if (k.type === 'maxIterations') return k.value;
  if (k.type === 'timeBudget') return 1; // handled separately via duration override
  // convergenceCriterion / externalTrigger → use expectedIterations mode / mean
  const d = loop.expectedIterations;
  const raw = d.type === 'normal' ? d.mean : d.mode;
  return Math.max(1, Math.round(raw));
}

// ── Body forward-pass (working-hours offsets) ─────────────────────────────────

interface BodyOffset {
  esHours: number;
  efHours: number;
}

/**
 * Run a simplified forward pass on the loop body subgraph.
 * Returns ES/EF for each body node as working-hour offsets from the body start.
 *
 * Phase 18 — body-CPM now uses each body node's resource-aware effective
 * calendar (the intersection of the activity calendar with each
 * assignment's resolved calendar). Previously the loop body silently fell
 * back to the activity-only calendar, so a body node assigned to a Mon–Wed
 * resource via `'resourceWins'` would still advance through Mon–Fri here
 * — fixed.
 *
 * The hour offsets remain stored as plain numbers (no per-node calendar
 * tag) because they're applied at the unroll site through each node's
 * own resource-aware calendar — see `buildLoopResourceEntries`. As long as
 * body nodes share roughly the same effective calendar (the common case),
 * the accumulator stays internally consistent.
 */
export function bodyForwardOffsets(
  bodyNodes: ProjectNode[],
  bodyEdges: ProjectEdge[],
  defaultCal: Calendar,
  calMap: Map<string, Calendar>,
  resourceMap: Map<string, Resource>,
): Map<string, BodyOffset> {
  const bodySet = new Set(bodyNodes.map((n) => n.id));
  // Only edges that stay inside the body
  const internalEdges = bodyEdges.filter((e) => bodySet.has(e.from) && bodySet.has(e.to));

  const topo = topoSort(
    bodyNodes.map((n) => n.id),
    internalEdges,
  );
  // Cyclic bodies would fail here; caller is responsible for validation.
  const order = topo.ok ? topo.order : bodyNodes.map((n) => n.id);

  const offsets = new Map<string, BodyOffset>();

  for (const nodeId of order) {
    const node = bodyNodes.find((n) => n.id === nodeId);
    if (!node) continue;
    const nodeCal = nodeEffectiveWorkingCalendar(node, calMap, defaultCal, resourceMap);
    const durationHrs = effectiveDurationHours(node, nodeCal);

    let esHours = 0;

    for (const e of internalEdges.filter((e) => e.to === nodeId)) {
      const pred = offsets.get(e.from);
      if (!pred) continue;
      const lagHrs = toHours(e.lag, nodeCal);
      let constraint: number;
      switch (e.type) {
        case 'FS':
          constraint = pred.efHours + lagHrs;
          break;
        case 'SS':
          constraint = pred.esHours + lagHrs;
          break;
        case 'FF':
          constraint = pred.efHours + lagHrs - durationHrs;
          break;
        case 'SF':
          constraint = pred.esHours + lagHrs - durationHrs;
          break;
      }
      if (constraint > esHours) esHours = constraint;
    }

    esHours = Math.max(0, esHours);
    offsets.set(nodeId, { esHours, efHours: esHours + durationHrs });
  }

  return offsets;
}

/**
 * Body critical path in working hours (= max EF offset across all
 * body nodes).
 *
 * Phase 50 Slice 21 / audit I-6 — returns the literal max, including
 * 0 for a zero-duration body. The prior `max === 0 ? 0.001 : max`
 * guard polluted slack with `0.001 × iterations` of fake hours
 * (1 hour for a 1000-iter loop) when a loop happened to wrap only
 * zero-duration body nodes. Downstream math (super-node duration =
 * cpHours × iterations; slack arithmetic; the `< 0.0001` threshold
 * checks) handles 0 correctly — the guard wasn't load-bearing.
 */
export function bodyCriticalPathHours(offsets: Map<string, BodyOffset>): number {
  let max = 0;
  for (const { efHours } of offsets.values()) {
    if (efHours > max) max = efHours;
  }
  return max;
}

// ── Body critical chains (Phase 50 Slice 18 / audit I-1) ─────────────────────

/**
 * Loop-body counterpart to the main CPM critical-path tracer.
 *
 * Given a loop's body nodes, their forward-pass offsets, the body's
 * critical-path duration (cpHours), and a pre-built taut-edge successor
 * map, return:
 *   - `criticalNodes` — every body node that lies on a critical chain
 *     within the body (reverse-reachable from a sink via taut edges).
 *   - `chains`        — one or more critical chains in source→sink
 *     order. Each chain is a list of body node ids. Multiple chains
 *     appear when the body has parallel paths of equal length.
 *
 * Sinks are body nodes whose `efHours ≈ cpHours` (i.e., they finish at
 * the body's critical-path time). Sources are critical nodes with no
 * critical predecessor in the restricted graph.
 *
 * Pure graph traversal — the caller does the calendar-aware taut-edge
 * detection (so calendar lookups live in cpm.ts where they're already
 * available) and passes in the resulting successor map.
 *
 * Two consumers in cpm.ts (Slice 18):
 *   1. `distributeLoopSchedule` consumes `criticalNodes` to set
 *      `onCriticalPath` correctly on every body-critical node, not
 *      just sinks (the previous `onBodyCP` only caught sinks — bug
 *      half of audit row I-1).
 *   2. The path-tracer's super-node expansion consumes `chains` to
 *      replace `__loop__<id>` in `criticalPaths[][]` with the actual
 *      body chain(s) — bug half two of I-1.
 */
const BODY_SLACK_EPSILON = 0.0001;

export function bodyCriticalChains(args: {
  bodyNodeIds: ReadonlyArray<string>;
  offsets: Map<string, BodyOffset>;
  cpHours: number;
  tautSuccessors: ReadonlyMap<string, ReadonlyArray<string>>;
}): { criticalNodes: Set<string>; chains: string[][] } {
  const { bodyNodeIds, offsets, cpHours, tautSuccessors } = args;

  // Reverse map: predecessor lookup from successor map.
  const tautPredecessors = new Map<string, string[]>();
  for (const id of bodyNodeIds) tautPredecessors.set(id, []);
  for (const [from, succs] of tautSuccessors.entries()) {
    for (const to of succs) {
      const arr = tautPredecessors.get(to);
      if (arr) arr.push(from);
    }
  }

  // Sinks: body nodes whose EF matches cpHours.
  const sinks: string[] = [];
  for (const id of bodyNodeIds) {
    const o = offsets.get(id);
    if (o && Math.abs(o.efHours - cpHours) < BODY_SLACK_EPSILON) {
      sinks.push(id);
    }
  }

  // Reverse BFS from sinks via taut predecessors → all critical nodes.
  const criticalNodes = new Set<string>(sinks);
  const queue: string[] = [...sinks];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const pred of tautPredecessors.get(cur) ?? []) {
      if (!criticalNodes.has(pred)) {
        criticalNodes.add(pred);
        queue.push(pred);
      }
    }
  }

  // Critical sources: critical nodes whose taut predecessors are all
  // non-critical (i.e., they're the start of a critical chain in this
  // body subgraph).
  const criticalSources: string[] = [];
  for (const id of criticalNodes) {
    const hasCritPred = (tautPredecessors.get(id) ?? []).some((p) => criticalNodes.has(p));
    if (!hasCritPred) criticalSources.push(id);
  }
  criticalSources.sort(); // deterministic chain order across runs

  // DFS each source forward, restricted to critical successors.
  const chains: string[][] = [];
  function dfs(current: string, path: string[]): void {
    path.push(current);
    const succs = (tautSuccessors.get(current) ?? []).filter((s) => criticalNodes.has(s));
    if (succs.length === 0) {
      chains.push([...path]);
    } else {
      for (const s of [...succs].sort()) dfs(s, path);
    }
    path.pop();
  }
  for (const src of criticalSources) dfs(src, []);

  return { criticalNodes, chains };
}

// ── Condensed graph construction ─────────────────────────────────────────────

export interface CondensedGraph {
  nodes: ProjectNode[];
  edges: ProjectEdge[];
  /** loopId → body CP in working hours */
  bodyCPHoursMap: Map<string, number>;
  /** loopId → body forward offsets (for later distribution) */
  bodyOffsetsMap: Map<string, Map<string, BodyOffset>>;
}

/**
 * Replace each loop's body nodes with a single super-node.
 * Edges into/out of the body are redirected to/from the super-node.
 * Edges entirely within the body are removed.
 */
export function buildCondensedGraph(
  nodes: ProjectNode[],
  edges: ProjectEdge[],
  loops: ReadonlyArray<Loop>,
  defaultCal: Calendar,
  calMap: Map<string, Calendar>,
  resourceMap: Map<string, Resource>,
  sampledIterations?: Record<string, number>,
): CondensedGraph {
  // Map bodyNodeId → owning loop
  const nodeToLoop = new Map<string, Loop>();
  for (const loop of loops) {
    for (const nid of loop.bodyNodeIds) {
      nodeToLoop.set(nid, loop);
    }
  }

  const bodyCPHoursMap = new Map<string, number>();
  const bodyOffsetsMap = new Map<string, Map<string, BodyOffset>>();

  // For each loop, compute body CP and build super-node
  const superNodes: ProjectNode[] = [];
  for (const loop of loops) {
    const bodyNodes = nodes.filter((n) => loop.bodyNodeIds.includes(n.id));
    const bodyEdges = edges.filter(
      (e) => loop.bodyNodeIds.includes(e.from) && loop.bodyNodeIds.includes(e.to),
    );

    const offsets = bodyForwardOffsets(bodyNodes, bodyEdges, defaultCal, calMap, resourceMap);
    const cpHours = bodyCriticalPathHours(offsets);
    bodyOffsetsMap.set(loop.id, offsets);
    bodyCPHoursMap.set(loop.id, cpHours);

    const iterations = sampledIterations?.[loop.id] ?? deterministicIterationCount(loop);

    // timeBudget loops: super-node duration = budget hours directly
    const superDuration =
      loop.kickout.type === 'timeBudget' ? loop.kickout.value : cpHours * Math.max(1, iterations);

    superNodes.push({
      id: superNodeId(loop.id),
      nodeType: 'activity',
      name: `Loop: ${loop.id}`,
      duration: { value: superDuration, unit: 'hours' },
      durationSemantic: 'time',
      position: { x: 0, y: 0 },
      calendarId: null,
      consumesResources: false,
      resourceAssignments: [],
    });
  }

  // Non-body nodes pass through unchanged
  const bodyNodeIds = new Set<string>(loops.flatMap((l) => l.bodyNodeIds));
  const condensedNodes: ProjectNode[] = [
    ...nodes.filter((n) => !bodyNodeIds.has(n.id)),
    ...superNodes,
  ];

  // Remap edges: replace body-node endpoints with super-node IDs
  const seenEdges = new Set<string>(); // deduplicate redirected edges
  const condensedEdges: ProjectEdge[] = [];

  for (const e of edges) {
    const fromLoop = nodeToLoop.get(e.from);
    const toLoop = nodeToLoop.get(e.to);

    const fromId = fromLoop ? superNodeId(fromLoop.id) : e.from;
    const toId = toLoop ? superNodeId(toLoop.id) : e.to;

    // Drop self-loops and edges entirely within the body (same super-node)
    if (fromId === toId) continue;

    // Deduplicate by stringified key (same endpoints + type + lag)
    const key = `${fromId}→${toId}|${e.type}|${e.lag.value}${e.lag.unit}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);

    condensedEdges.push({ ...e, id: `${e.id}__condensed`, from: fromId, to: toId });
  }

  return { nodes: condensedNodes, edges: condensedEdges, bodyCPHoursMap, bodyOffsetsMap };
}

// ── NodeSchedule distribution ─────────────────────────────────────────────────

/**
 * Given the super-node's schedule from the condensed CPM, derive NodeSchedule
 * for each body node. Timing reflects the FIRST iteration.
 * Slack = super-node slack (v1 approximation — ignores within-body float).
 * onCriticalPath = super-node on CP && node on body CP.
 */
/**
 * Phase 48 Slice 3 — `getNodePrep` supplies the per-node prepared
 * calendar (built once in `prepareSchedule`). Replaces the
 * `defaultCal / calMap / resourceMap` triple that the pre-Slice-3
 * signature used to re-fold the effective calendar per call.
 */
export function distributeLoopSchedule(
  _loop: Loop,
  superSchedule: NodeSchedule,
  bodyNodes: ProjectNode[],
  offsets: Map<string, BodyOffset>,
  cpHours: number,
  getNodePrep: (nodeId: string) => PreparedCalendar,
  /**
   * Phase 50 Slice 18 — body-critical node set, pre-computed by
   * `bodyCriticalChains` in cpm.ts. Replaces the prior `onBodyCP`
   * heuristic that only matched body sinks (nodes whose `efHours` ≈
   * `cpHours`), missing every other node on a body-critical chain.
   * Half one of audit row I-1.
   */
  bodyCriticalNodes: ReadonlySet<string>,
): Record<string, NodeSchedule> {
  const result: Record<string, NodeSchedule> = {};
  const loopStart = superSchedule.earliestStart;

  for (const node of bodyNodes) {
    const o = offsets.get(node.id) ?? { esHours: 0, efHours: 0 };
    const nodePrep = getNodePrep(node.id);
    const nodeCal = nodePrep.source;

    const earliestStart = addWorkingHoursP(nodePrep, loopStart, o.esHours);
    const earliestFinish = addWorkingHoursP(nodePrep, loopStart, o.efHours);

    const remainingAfter = cpHours - o.efHours;
    const latestFinish = addWorkingHoursP(nodePrep, superSchedule.latestFinish, -remainingAfter);
    const latestStart = addWorkingHoursP(
      nodePrep,
      latestFinish,
      -effectiveDurationHours(node, nodeCal),
    );

    const slackHours = superSchedule.slackHours + (cpHours - o.efHours);
    const onCriticalPath = superSchedule.onCriticalPath && bodyCriticalNodes.has(node.id);

    result[node.id] = {
      nodeId: node.id,
      earliestStart,
      earliestFinish,
      latestStart,
      latestFinish,
      slackHours: Math.max(0, slackHours),
      onCriticalPath,
    };
  }

  return result;
}

// ── Resource unrolling ────────────────────────────────────────────────────────

/**
 * Expand the loop body into N sequential copies and return one
 * ResourceTimelineEntry per (iteration × resource assignment) where the node
 * has consumesResources=true. Wait-state nodes (consumesResources=false)
 * contribute to timing only and produce no entries.
 */
/**
 * Phase 48 Slice 3 — `defaultPrep` + `getNodePrep` replace the pre-
 * Slice-3 `defaultCal / calMap` parameters. The per-node prepared
 * calendar map is built once in `prepareSchedule`; the unroll loop
 * uses it directly via the fast-path calendar functions.
 */
export function buildLoopResourceEntries(
  _loop: Loop,
  loopStart: Date,
  bodyNodes: ProjectNode[],
  offsets: Map<string, BodyOffset>,
  cpHours: number,
  iterations: number,
  defaultPrep: PreparedCalendar,
  resources: ReadonlyArray<Resource>,
  getNodePrep: (nodeId: string) => PreparedCalendar,
): ResourceTimelineEntry[] {
  const resourceSet = new Set(resources.map((r) => r.id));
  const entries: ResourceTimelineEntry[] = [];

  for (let i = 1; i <= iterations; i++) {
    // Start of this iteration as a working-hour offset from loopStart,
    // measured in the project default calendar. See the pre-Slice-3
    // comment block (preserved in git history) for the rationale behind
    // the per-nodeCal snap below.
    const rawIterStart = addWorkingHoursP(defaultPrep, loopStart, (i - 1) * cpHours);

    for (const node of bodyNodes) {
      if (!node.consumesResources) continue;
      const o = offsets.get(node.id) ?? { esHours: 0, efHours: 0 };
      const nodePrep = getNodePrep(node.id);
      const iterStart = i === 1 ? rawIterStart : snapToNextWorkStartP(nodePrep, rawIterStart);

      const start = addWorkingHoursP(nodePrep, iterStart, o.esHours);
      const end = addWorkingHoursP(nodePrep, iterStart, o.efHours);

      for (const asgn of node.resourceAssignments) {
        if (!resourceSet.has(asgn.resourceId)) continue;
        entries.push({
          resourceId: asgn.resourceId,
          nodeId: node.id,
          iteration: i,
          start,
          end,
          count: asgn.count,
        });
      }
    }
  }

  return entries;
}
