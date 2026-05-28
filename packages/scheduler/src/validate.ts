import type { Calendar, ValidationError } from '@procsim/file-format';
import {
  effectiveActivityCalendar,
  intersectCalendars,
  resolveAssignmentCalendar,
} from '@procsim/calendar';
import { topoSort } from './topo.js';
import { buildCondensedGraph, isSuperNode } from './loop.js';
import type { ScheduleInput } from './types.js';

/**
 * Phase 48 Slice 3 — structural validation pass.
 *
 * Extracted from `cpm.ts`'s inline `validate()` so `prepareSchedule()` can
 * call it once before the MC loop. The signature, behaviour, and error
 * messages are byte-identical to the inline pre-Slice-3 version — the
 * Slice 1.5 snapshot canary catches any drift.
 *
 * Cycle detection runs against the condensed loop graph with
 * `sampledLoopIterations` left undefined (cycles are structural and
 * iteration-count-independent), so this is safe to run at prepare time
 * before any Monte Carlo sampling.
 */
export function validateInput(input: ScheduleInput): ValidationError[] {
  const errors: ValidationError[] = [];
  const calMap = new Map(input.calendars.map((c) => [c.id, c]));
  const nodeIds = new Set(input.nodes.map((n) => n.id));
  const resourceMap = new Map(input.resources.map((r) => [r.id, r]));

  if (!calMap.has(input.project.defaultCalendarId)) {
    errors.push({
      path: 'project.defaultCalendarId',
      message: `Default calendar '${input.project.defaultCalendarId}' not found`,
    });
  }

  const defaultCal = calMap.get(input.project.defaultCalendarId);

  for (const node of input.nodes) {
    if (node.calendarId !== null && !calMap.has(node.calendarId)) {
      errors.push({
        path: `nodes.${node.id}.calendarId`,
        message: `Calendar '${node.calendarId}' not found`,
      });
    }

    for (const asgn of node.resourceAssignments) {
      const resource = resourceMap.get(asgn.resourceId);
      if (!resource) {
        errors.push({
          path: `nodes.${node.id}.resourceAssignments`,
          message: `Resource '${asgn.resourceId}' not found`,
        });
        continue;
      }

      if (defaultCal) {
        const activityCal = effectiveActivityCalendar(
          node.calendarId !== null ? (calMap.get(node.calendarId) ?? null) : null,
          defaultCal,
        );
        const resourceCal = calMap.get(resource.calendarId);
        if (resourceCal) {
          const resolved = resolveAssignmentCalendar(activityCal, resourceCal, asgn.calendarPolicy);
          if (!resolved.ok) {
            errors.push({
              path: `nodes.${node.id}.resourceAssignments.${asgn.resourceId}`,
              message:
                `Activity "${node.name}" and resource "${resource.name}" share no working days ` +
                `under the 'intersection' policy. ` +
                `Activity calendar works on: ${calendarDayList(activityCal.workingDays)}. ` +
                `Resource calendar works on: ${calendarDayList(resourceCal.workingDays)}. ` +
                `Switch the calendar policy to 'resourceWins' or 'activityWins', ` +
                `or adjust the resource's working days.`,
            });
          }
        }
      }
    }

    if (defaultCal && node.consumesResources && node.resourceAssignments.length > 0) {
      const activityCal = effectiveActivityCalendar(
        node.calendarId !== null ? (calMap.get(node.calendarId) ?? null) : null,
        defaultCal,
      );
      let acc: Calendar | null = activityCal;
      let cause: { resourceName: string; resourceCal: Calendar } | null = null;
      for (const asgn of node.resourceAssignments) {
        const resource = resourceMap.get(asgn.resourceId);
        if (!resource) continue;
        const resourceCal = calMap.get(resource.calendarId);
        if (!resourceCal) continue;
        const resolved = resolveAssignmentCalendar(activityCal, resourceCal, asgn.calendarPolicy);
        if (!resolved.ok) continue;
        const next = intersectCalendars(acc, resolved.calendar);
        if (!next) {
          cause = { resourceName: resource.name, resourceCal: resolved.calendar };
          acc = null;
          break;
        }
        acc = next;
      }
      if (!acc && cause) {
        errors.push({
          path: `nodes.${node.id}.resourceAssignments`,
          message:
            `Activity "${node.name}" has no working days left after applying every ` +
            `resource's calendar policy. The conflict surfaced when adding resource ` +
            `"${cause.resourceName}" (works on ${calendarDayList(cause.resourceCal.workingDays)}). ` +
            `Either relax that resource's calendar policy to 'activityWins', or pick a ` +
            `resource whose calendar overlaps with the rest.`,
        });
      }
    }
  }

  for (const edge of input.edges) {
    if (!nodeIds.has(edge.from)) {
      errors.push({ path: `edges.${edge.id}.from`, message: `Node '${edge.from}' not found` });
    }
    if (!nodeIds.has(edge.to)) {
      errors.push({ path: `edges.${edge.id}.to`, message: `Node '${edge.to}' not found` });
    }
  }

  const bodyNodeOwner = new Map<string, string>();
  for (const loop of input.loops) {
    for (const nid of loop.bodyNodeIds) {
      if (!nodeIds.has(nid)) {
        errors.push({
          path: `loops.${loop.id}.bodyNodeIds`,
          message: `Loop '${loop.id}' references unknown node '${nid}'`,
        });
      } else if (bodyNodeOwner.has(nid)) {
        errors.push({
          path: `loops.${loop.id}.bodyNodeIds`,
          message: `Node '${nid}' appears in both loop '${bodyNodeOwner.get(nid)!}' and loop '${loop.id}'`,
        });
      } else {
        bodyNodeOwner.set(nid, loop.id);
      }
    }
  }

  const startNodes = input.nodes.filter((n) => n.nodeType === 'start');
  if (startNodes.length > 0) {
    const outDegree = new Map<string, number>();
    for (const n of input.nodes) outDegree.set(n.id, 0);
    for (const e of input.edges) {
      outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + 1);
    }
    for (const s of startNodes) {
      if ((outDegree.get(s.id) ?? 0) === 0) {
        errors.push({
          path: `nodes.${s.id}`,
          message:
            `Start node "${s.name}" is not connected to any downstream activity. ` +
            `Wire it into the chain it should anchor, or delete it.`,
        });
      }
    }
  }

  if (errors.length > 0) return errors;

  // Phase 50 Slice 6 / audit C-2 — per-loop body cycle detection. The
  // condensed-graph cycle check below treats each loop body as a single
  // super-node, and `buildCondensedGraph` filters out edges where
  // `fromId === toId` (its dedup step at loop.ts). Back-edges entirely
  // between two body nodes of the same loop (e.g. body=[A,B] with edges
  // A→B and B→A) get dropped at condensation, so the super-level cycle
  // check never sees them. Without this per-body topo, `bodyForwardOffsets`
  // would fall back to insertion order and silently produce wrong
  // offsets / `cpHours`. Catching it here surfaces an explicit error.
  for (const loop of input.loops) {
    const bodySet = new Set(loop.bodyNodeIds);
    const internalEdges = input.edges.filter((e) => bodySet.has(e.from) && bodySet.has(e.to));
    const topo = topoSort([...loop.bodyNodeIds], internalEdges);
    if (!topo.ok) {
      errors.push({
        path: `loops.${loop.id}`,
        message:
          `Cycle detected inside loop '${loop.id}' body among nodes: ${topo.cycle.join(', ')}. ` +
          `Loop bodies must be acyclic DAGs — the loop's iteration count is the only repetition. ` +
          `Either remove the back-edge, or wrap the recurring fragment in a nested loop.`,
      });
    }
  }
  if (errors.length > 0) return errors;

  // Cycle detection — run on the condensed graph (body nodes replaced by
  // super-nodes). A cycle in the condensed graph means a genuine
  // undeclared cycle, not a loop body. Iteration counts are irrelevant
  // to cycle structure, so we pass no `sampledLoopIterations`.
  if (defaultCal) {
    const condensed = buildCondensedGraph(
      input.nodes,
      input.edges,
      input.loops,
      defaultCal,
      calMap,
      resourceMap,
    );
    const topo = topoSort(
      condensed.nodes.map((n) => n.id),
      condensed.edges,
    );
    if (!topo.ok) {
      const cycleNodes = topo.cycle.filter((id) => !isSuperNode(id));
      const hint =
        input.loops.length > 0
          ? ' Declare loops explicitly via Loop metadata rather than edge back-links.'
          : ' Wrap these nodes in a Loop construct if the cycle is intentional.';
      errors.push({
        path: 'edges',
        message: `Cycle detected among nodes: ${cycleNodes.join(', ')}.${hint}`,
      });
    }
  } else {
    const topo = topoSort(
      input.nodes.map((n) => n.id),
      input.edges,
    );
    if (!topo.ok) {
      errors.push({
        path: 'edges',
        message: `Cycle detected among nodes: ${topo.cycle.join(', ')}`,
      });
    }
  }

  return errors;
}

function calendarDayList(
  workingDays: readonly [boolean, boolean, boolean, boolean, boolean, boolean, boolean],
): string {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
  const active = names.filter((_, i) => workingDays[i]);
  return active.length === 0 ? 'none' : active.join(', ');
}
