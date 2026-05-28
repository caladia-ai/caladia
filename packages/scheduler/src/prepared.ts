/**
 * Phase 48 Slice 3 — `prepareSchedule()` / `scheduleFromPrepared()` split.
 *
 * The Phase 16 `schedule(input)` did every step in one shot: validate,
 * flatten, calendar resolution, topology, CPM, cost pass. Monte Carlo
 * re-paid the iteration-invariant cost on every iteration — the Slice 1
 * profile attributed ~55–60% of CPU to calendar functions whose inputs
 * never changed and another ~10% to `validate()` doing the same checks
 * 1 000 times.
 *
 * This module splits the work in two:
 *
 *   `prepareSchedule(input)` does the once-per-MC-run work:
 *     • `flattenSubsystems` (depends only on the subsystem topology)
 *     • `validate` (structural check — same input every iteration)
 *     • Calendar / resource lookups
 *     • Per-node effective calendar resolution
 *     • Per-effective-calendar `PreparedCalendar` table construction
 *       (deduplicated by calendar id — the 50 Oncology nodes that all use
 *       `cal-default` share one table)
 *
 *   `scheduleFromPrepared(prepared, sampled)` does the per-iteration work:
 *     • Loop condensation (super-node duration depends on sampled iter
 *       counts)
 *     • Topological sort (depends on condensed graph)
 *     • Forward / backward CPM passes (use the prepared calendar fast path)
 *     • Result assembly, cost pass, conflict pass
 *
 * Both `schedule(input)` and `simulate()` use this split: the former as a
 * convenience wrapper that calls `prepareSchedule` then `scheduleFromPrepared`
 * once with identity-sampled inputs; the latter calls `prepareSchedule`
 * once before the MC loop and `scheduleFromPrepared` per iteration.
 *
 * **Semantics are preserved byte-for-byte** — Slice 1.5's snapshot canary
 * (`SIM_DETERMINISM_FULL=1 pnpm --filter app test`) catches any drift.
 *
 * See ARCHITECTURE.md "Prepared schedule split".
 */

import type { Calendar, Resource, ValidationError } from '@procsim/file-format';
import type { PreparedCalendar } from '@procsim/calendar';
import { prepareCalendar } from '@procsim/calendar';
import { nodeEffectiveWorkingCalendar } from './utils.js';
import { flattenSubsystems } from './flatten.js';
import { validateInput } from './validate.js';
import type { ScheduleInput, ScheduleOutcome } from './types.js';
import { runScheduleFromPrepared } from './cpm.js';

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * Per-iteration inputs supplied to `scheduleFromPrepared`. These are the
 * fields that legitimately vary across Monte Carlo iterations.
 *
 * Convention: caller-mutated copies of the prepared input's `nodes` and
 * `resources` arrays, with sampled scalars (`duration`, `passProbability`,
 * `fixedCost`, `costRate`) and the optional per-loop iteration counts.
 */
export interface SampledInputs {
  nodes: ScheduleInput['nodes'];
  resources: ScheduleInput['resources'];
  sampledLoopIterations?: Record<string, number>;
}

/**
 * Iteration-invariant context returned by `prepareSchedule`. Opaque to
 * callers — passed verbatim to `scheduleFromPrepared`.
 */
export interface PreparedSchedule {
  /** Post-flatten input. Same shape as `ScheduleInput`. */
  input: ScheduleInput;
  /** Calendar id → Calendar. */
  calMap: Map<string, Calendar>;
  /** Default project calendar (resolved via `input.project.defaultCalendarId`). */
  defaultCal: Calendar;
  /** Resource id → Resource. */
  resourceMap: Map<string, Resource>;
  /**
   * Per-node resolved effective working calendar, computed via
   * `nodeEffectiveWorkingCalendar` once at prepare time. Iteration-invariant.
   *
   * Includes both real nodes (post-flatten) and the deterministic-count
   * super-nodes that loop condensation would generate. Super-nodes use the
   * default calendar.
   */
  nodeEffectiveCal: Map<string, Calendar>;
  /**
   * Per-effective-calendar `PreparedCalendar`. Keyed by calendar id (so
   * 50 nodes all using `cal-default` share one table). Lookups happen via
   * `nodeEffectiveCal[nodeId].id` → `preparedCalById[id]`.
   */
  preparedCalById: Map<string, PreparedCalendar>;
  /** Convenience: prepared form of the default calendar. */
  defaultPrepared: PreparedCalendar;
}

export type PrepareResult =
  | { ok: true; prepared: PreparedSchedule }
  | { ok: false; errors: ValidationError[] };

// ── prepareSchedule ──────────────────────────────────────────────────────────

/**
 * Decide the calendar-table horizon. We need to cover every date the
 * scheduler might query: project start, Start-node anchorDates, and the
 * far end of the schedule (project + all activity durations).
 *
 * For simplicity and per the Slice 3 plan, use a conservative fixed
 * window: base = earliest(`project.startDate`, any `anchorDate`) − 365
 * days; horizon = 100 calendar years from that base. Memory: ~10 bytes
 * per day per distinct calendar × ~10 calendars × 36 600 days ≈ 3.5 MB.
 * Trivial relative to a typical Monte Carlo run's heap.
 */
function decideTableRange(input: ScheduleInput): {
  baseY: number;
  baseM: number;
  baseD: number;
  numDays: number;
} {
  // Earliest queryable date.
  let earliest = input.project.startDate;
  for (const n of input.nodes) {
    if (n.nodeType === 'start' && n.anchorDate !== undefined) {
      if (n.anchorDate < earliest) earliest = n.anchorDate;
    }
  }
  // Parse YYYY-MM-DD and step back 365 days for safety margin.
  const earliestDate = new Date(earliest + 'T00:00:00');
  earliestDate.setDate(earliestDate.getDate() - 365);
  return {
    baseY: earliestDate.getFullYear(),
    baseM: earliestDate.getMonth(),
    baseD: earliestDate.getDate(),
    // 100 years × 366 days/yr (upper bound — overshoot for leaps).
    numDays: 100 * 366,
  };
}

/**
 * Build a `PreparedSchedule` from a raw `ScheduleInput`.
 *
 * Returns `{ ok: false, errors }` when validation surfaces structural
 * errors. Otherwise returns `{ ok: true, prepared }` with the full
 * iteration-invariant state.
 */
export function prepareSchedule(rawInput: ScheduleInput): PrepareResult {
  const input = flattenSubsystems(rawInput);

  const errors = validateInput(input);
  if (errors.length > 0) return { ok: false, errors };

  const calMap = new Map(input.calendars.map((c) => [c.id, c]));
  const defaultCal = calMap.get(input.project.defaultCalendarId)!;
  const resourceMap = new Map(input.resources.map((r) => [r.id, r]));

  // Per-node effective calendar — iteration-invariant (depends on node
  // calendarId, resource assignments, calendar policies). Computed once
  // here; cpm.ts hot path looks up via `prep.nodeEffectiveCal.get(id)`.
  const nodeEffectiveCal = new Map<string, Calendar>();
  for (const node of input.nodes) {
    nodeEffectiveCal.set(
      node.id,
      nodeEffectiveWorkingCalendar(node, calMap, defaultCal, resourceMap),
    );
  }

  // Build PreparedCalendar tables, deduplicated by calendar id. Two nodes
  // sharing the same resolved-calendar id (which captures activity-cal ×
  // resource-cal × policy via `intersectCalendars`'s `${a.id}∩${b.id}`
  // naming) share one table.
  const range = decideTableRange(input);
  const preparedCalById = new Map<string, PreparedCalendar>();
  for (const cal of nodeEffectiveCal.values()) {
    if (preparedCalById.has(cal.id)) continue;
    preparedCalById.set(
      cal.id,
      prepareCalendar(cal, range.baseY, range.baseM, range.baseD, range.numDays),
    );
  }
  // The default calendar is also used directly (super-node loop scheduling,
  // anchor snapping); ensure its prepared form is available.
  if (!preparedCalById.has(defaultCal.id)) {
    preparedCalById.set(
      defaultCal.id,
      prepareCalendar(defaultCal, range.baseY, range.baseM, range.baseD, range.numDays),
    );
  }
  const defaultPrepared = preparedCalById.get(defaultCal.id)!;

  return {
    ok: true,
    prepared: {
      input,
      calMap,
      defaultCal,
      resourceMap,
      nodeEffectiveCal,
      preparedCalById,
      defaultPrepared,
    },
  };
}

// ── scheduleFromPrepared ─────────────────────────────────────────────────────

/**
 * Run a single CPM + cost + conflict pass against pre-computed
 * iteration-invariant state. The hot path in cpm.ts uses the prepared
 * calendar fast-path functions; `sampled.nodes` / `sampled.resources` /
 * `sampled.sampledLoopIterations` supply the per-iteration scalars.
 *
 * Implementation lives in cpm.ts (`runScheduleFromPrepared`) — same module
 * that owns the forward / backward passes — so the helpers don't need to
 * be exported across module boundaries.
 */
export function scheduleFromPrepared(
  prepared: PreparedSchedule,
  sampled: SampledInputs,
): ScheduleOutcome {
  return runScheduleFromPrepared(prepared, sampled);
}
