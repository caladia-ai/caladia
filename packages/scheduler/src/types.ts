import type { ProjectFile } from '@procsim/file-format';
export type { ValidationError } from '@procsim/file-format';

export interface ScheduleInput {
  project: ProjectFile['project'];
  nodes: ProjectFile['nodes'];
  edges: ProjectFile['edges'];
  resources: ProjectFile['resources'];
  calendars: ProjectFile['calendars'];
  loops: ProjectFile['loops'];
  /**
   * Monte Carlo override: sampled iteration counts per loop ID.
   * When absent the scheduler derives iteration counts from each loop's kickout
   * condition (deterministicIterationCount). Passed by the simulation engine
   * after sampling loop.expectedIterations each iteration.
   */
  sampledLoopIterations?: Record<string, number>;
  /**
   * Phase 12 — Sub-system topology. When present, the scheduler's
   * `flattenSubsystems` pre-pass rewrites edges that point at container nodes
   * to target the body's entry / exit nodes, then removes the container nodes.
   * CPM, loop, and decision logic run on the resulting flat DAG unchanged.
   */
  subsystems?: ProjectFile['subsystems'];
}

export interface NodeSchedule {
  nodeId: string;
  earliestStart: Date;
  earliestFinish: Date;
  latestStart: Date;
  latestFinish: Date;
  slackHours: number;
  onCriticalPath: boolean;
}

export interface ResourceTimelineEntry {
  resourceId: string;
  nodeId: string;
  /** 0 for non-loop nodes; ≥1 inside loop iterations */
  iteration: number;
  start: Date;
  end: Date;
  count: number;
}

export interface ValidationWarning {
  path: string;
  message: string;
}

/**
 * Phase 19 — per-node cost breakdown. `fromResources` covers the rate-and-
 * per-use contribution from this node's resourceAssignments; `fromFixed`
 * covers the node-level `fixedCost`. For nodes inside a loop body both
 * scale with the loop's iteration count (deterministic mode uses
 * `expectedIterations`; Monte Carlo passes a sampled count). The
 * `fixedCostOnce: true` opt-out skips the iteration multiplier for fixed
 * cost while leaving the per-iteration resource hours intact.
 *
 * Phase 25 — `fromCrash` is the `additionalCost` of the selected crash
 * option (zero when no crash is selected, or no `crashOptions` defined).
 * Kept as a separate bucket so the JSON export's cost source-of-truth
 * stays clean: a reviewer can see exactly how much of the project cost
 * came from crash decisions versus the nominal plan. Inside a loop body
 * the bucket follows the same iteration semantics as `fromFixed` —
 * per-iteration by default, one-time when `fixedCostOnce: true`.
 *
 * Sub-system container ids appear in `nodeCosts` even though they are not
 * present in `nodes` (the flatten pre-pass strips them). Their entry is
 * the body's aggregate — see ARCHITECTURE.md "Sub-system cost rollup
 * post-flatten."
 */
export interface NodeCost {
  fromResources: number;
  fromFixed: number;
  fromCrash: number;
  total: number;
}

/**
 * Phase 24 — one reason a node is involved in a resource conflict.
 * Surfaces in Canvas (⚠️ badge), Gantt (row prefix), and Inspector
 * (amber banner). Multiple entries when one node competes for several
 * over-capacity resources.
 */
export interface ConflictReason {
  resourceId: string;
  /** Count of distinct calendar days on which `resourceId` exceeds its capacity AND this node had an active timeline entry. */
  overCapacityDayCount: number;
}

export interface ScheduleResult {
  nodes: Record<string, NodeSchedule>;
  /** May be multiple when parallel branches share the same total float = 0 */
  criticalPaths: string[][];
  resourceTimeline: ResourceTimelineEntry[];
  projectEnd: Date;
  warnings: ValidationWarning[];
  /** Phase 19 — deterministic cost roll-up (see NodeCost). */
  nodeCosts: Record<string, NodeCost>;
  /** Phase 19 — per-resource lifetime cost across the schedule. */
  resourceCosts: Record<string, number>;
  /** Phase 19 — sum of every node's `total`, excluding sub-system rollups
   * (to avoid double-counting body costs that already appear individually). */
  projectCost: number;
  /**
   * Phase 24 — node ids involved in resource over-capacity conflicts.
   * A node is "involved" if any of its `resourceAssignments` competes
   * with another node for an over-capacity day on the same resource.
   * Subsystem containers inherit the entries of any body node with
   * conflicts (deduplicated and aggregated per resource). The map is
   * empty when no resource exceeds capacity anywhere in the schedule.
   *
   * Deterministic for fixed inputs. UI consumers should never derive
   * this themselves — the engine's day-bucketing is the single source
   * of truth and must stay consistent with the Resources tab.
   */
  conflictedNodeIds: Record<string, ConflictReason[]>;
}

export type ScheduleOutcome =
  | { ok: true; result: ScheduleResult }
  | { ok: false; errors: import('@procsim/file-format').ValidationError[] };
