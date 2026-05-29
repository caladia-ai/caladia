import React, { useEffect, useMemo, useRef, useState } from 'react';
import { isWorkingMoment, resolveHolidays } from '@procsim/calendar';
import { deterministicIterationCount } from '@procsim/scheduler';
import type { ScheduleResult } from '@procsim/scheduler';
import type { ProjectFile, ProjectNode, Loop } from '@procsim/file-format';
import { useViewStore } from '../store/viewStore.js';
import { GanttHeader } from './GanttHeader.js';
import { CrashToDeadlineModal } from './CrashToDeadlineModal.js';
import { GanttMinimap } from './GanttMinimap.js';
import { GanttCumulativeCostPanel } from './GanttCumulativeCostPanel.js';
import { snapToLocalMidnight, useChartCursor } from '../utils/cursor.js';

// ── Layout constants ──────────────────────────────────────────────────────────

// Phase 47 Slice 2 — the frozen left-column width is now sourced from
// `viewStore.ganttLabelWidth` (persisted to localStorage). Default 188
// matches the pre-Slice-2 hardcoded width; resizable via a drag handle
// on the column's right edge — see `GanttLabelResizer` below.
// Phase 33 Slice 2 follow-up — base day-pixel width. Runtime day width
// is `BASE_DAY_WIDTH * viewStore.ganttZoom`; UI exposes a discrete-step
// zoom (0.1 → 3×) with `[` / `]` shortcuts and a Cmd+0 reset, plus a
// Fit button that snaps to the project-fits-viewport zoom.
const BASE_DAY_WIDTH = 28; // px per calendar day at zoom 1.0
const ROW_HEIGHT = 36; // px per row
const HEADER_H = 52; // px — date header (month + day rows)
const BODY_INDENT = 14; // px — body node left indent inside a loop/group
const BAR_TOP = ROW_HEIGHT * 0.22;
const BAR_H = ROW_HEIGHT * 0.56;
// Phase 19 — cost S-curve panel. Lives below the chart body, sharing the
// x-axis (DAY_WIDTH × totalDays) so the curve aligns with the bars above.
// Toggled via the toolstrip "S-curve" button; hidden by default.
const COST_PANEL_H = 140;

// ── Row model ─────────────────────────────────────────────────────────────────

type GanttRow =
  | { kind: 'node'; node: ProjectNode; inLoop: boolean; inGroup: boolean; inSubsystem: boolean }
  | {
      kind: 'loopHeader';
      loop: Loop;
      start: Date;
      end: Date;
      iterCount: number;
      inGroup: boolean;
      inSubsystem: boolean;
    }
  | { kind: 'groupHeader'; groupId: string; start: Date; end: Date; itemCount: number }
  | {
      kind: 'subsystemHeader';
      subsystemId: string;
      name: string;
      start: Date;
      end: Date;
      itemCount: number;
    };

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Compact mono label for a node's duration — e.g. `8h`, `4d`, `2w`. */
function formatDuration(d: { value: number; unit: 'hours' | 'days' | 'weeks' }): string {
  const short = d.unit === 'hours' ? 'h' : d.unit === 'weeks' ? 'w' : 'd';
  // Round to 1 decimal to keep the chip narrow; integers print without `.0`.
  const v = Number.isInteger(d.value) ? d.value : Math.round(d.value * 10) / 10;
  return `${v}${short}`;
}

/**
 * Phase 24 — hover-text builder for the conflict ⚠️ row marker. Resolves
 * resource ids to display names; falls back to id if a stale id leaks
 * through (defensive).
 */
function conflictTitle(
  reasons: ReadonlyArray<{ resourceId: string; overCapacityDayCount: number }>,
  resources: ReadonlyArray<{ id: string; name: string }>,
): string {
  return (
    'Resource conflict — ' +
    reasons
      .map((r) => {
        const name = resources.find((x) => x.id === r.resourceId)?.name ?? r.resourceId;
        return `${name} (${r.overCapacityDayCount} day${r.overCapacityDayCount === 1 ? '' : 's'})`;
      })
      .join(', ')
  );
}

/** Days elapsed since project start (floor to whole days) — used for the grid ruler only. */
function dayIdx(date: Date, start: Date): number {
  return Math.floor((date.getTime() - start.getTime()) / 86_400_000);
}

/**
 * Continuous (fractional) x position for a date on the timeline.
 *
 * Uses wall-clock elapsed days so that two events on the same calendar day
 * but at different times (e.g. Mon 08:00 vs Mon 16:00) land at different
 * x coordinates.
 */
function xOf(date: Date, projectStart: Date, dayWidth: number): number {
  return ((date.getTime() - projectStart.getTime()) / 86_400_000) * dayWidth;
}

/** Month/year label groups for the header ruler. */
function monthGroups(
  start: Date,
  totalDays: number,
): Array<{ label: string; startDay: number; spanDays: number }> {
  const groups: Array<{ label: string; startDay: number; spanDays: number }> = [];
  let groupStart = 0;
  let cur = new Date(start);
  cur.setHours(0, 0, 0, 0);

  for (let i = 1; i <= totalDays; i++) {
    const next = new Date(start.getTime() + i * 86_400_000);
    next.setHours(0, 0, 0, 0);
    const monthChanged = next.getMonth() !== cur.getMonth() || i === totalDays;
    if (monthChanged) {
      groups.push({
        label: cur.toLocaleString('default', { month: 'short', year: 'numeric' }),
        startDay: groupStart,
        spanDays: i - groupStart,
      });
      groupStart = i;
      cur = next;
    }
  }
  return groups;
}

/**
 * Compute the wall-clock start/end of the full loop (all N iterations).
 */
function loopBounds(loop: Loop, result: ScheduleResult): { start: Date; end: Date } | null {
  let start: Date | null = null;
  for (const id of loop.bodyNodeIds) {
    const s = result.nodes[id];
    if (!s) continue;
    if (!start || s.earliestStart < start) start = s.earliestStart;
  }
  if (!start) return null;

  const bodySet = new Set(loop.bodyNodeIds);
  let end: Date | null = null;
  for (const e of result.resourceTimeline) {
    if (!bodySet.has(e.nodeId)) continue;
    if (!end || e.end > end) end = e.end;
  }

  if (!end) {
    for (const id of loop.bodyNodeIds) {
      const s = result.nodes[id];
      if (!s) continue;
      if (!end || s.latestFinish > end) end = s.latestFinish;
    }
  }

  return end ? { start, end } : null;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface GanttViewProps {
  project: ProjectFile;
  result: ScheduleResult;
  containerRef?: React.RefObject<HTMLDivElement>;
}

export function GanttView({ project, result, containerRef }: GanttViewProps) {
  const selection = useViewStore((s) => s.selection);
  const selectedLoopId = useViewStore((s) => s.selectedLoopId);
  const collapsedGroupIds = useViewStore((s) => s.collapsedGroupIds);
  const collapsedSubsystemIds = useViewStore((s) => s.collapsedSubsystemIds);
  const selectNodes = useViewStore((s) => s.selectNodes);
  const selectLoop = useViewStore((s) => s.selectLoop);
  const revealInspector = useViewStore((s) => s.revealInspector);
  const toggleGroupCollapse = useViewStore((s) => s.toggleGroupCollapse);
  const toggleSubsystemCollapse = useViewStore((s) => s.toggleSubsystemCollapse);
  const darkMode = useViewStore((s) => s.darkMode);
  const simHistory = useViewStore((s) => s.simHistory);
  // Phase 33 Slice 2 follow-up — Gantt zoom. Computed as the runtime
  // day-pixel width from the viewStore zoom level. All x-coordinate
  // math in this component uses `DAY_WIDTH` — same name as the legacy
  // module-level constant, scoped here so the zoom level flows
  // through every render automatically.
  const ganttZoom = useViewStore((s) => s.ganttZoom);
  const zoomGanttIn = useViewStore((s) => s.zoomGanttIn);
  const zoomGanttOut = useViewStore((s) => s.zoomGanttOut);
  const resetGanttZoom = useViewStore((s) => s.resetGanttZoom);
  const setGanttZoom = useViewStore((s) => s.setGanttZoom);
  // Phase 47 Slice 2 — resizable left pane. Source of truth lives in
  // viewStore (persisted); a drag handle below updates it on mousemove.
  const labelWidth = useViewStore((s) => s.ganttLabelWidth);
  const setGanttLabelWidth = useViewStore((s) => s.setGanttLabelWidth);
  const DAY_WIDTH = BASE_DAY_WIDTH * ganttZoom;

  // Phase 33 Slice 2 follow-up — Gantt-tab keyboard shortcuts.
  // Mounted only while this view is rendered (which is itself
  // gated on `activeTab === 'gantt'` in App.tsx). Ignores presses
  // inside editable fields so the search box doesn't lose `[`/`]`.
  useEffect(() => {
    function isEditable(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target)) return;
      if (e.key === '[') {
        e.preventDefault();
        zoomGanttOut();
      } else if (e.key === ']') {
        e.preventDefault();
        zoomGanttIn();
      } else if (e.key === '0') {
        e.preventDefault();
        resetGanttZoom();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomGanttIn, zoomGanttOut, resetGanttZoom]);

  // Phase 15 — toolstrip state
  const [search, setSearch] = useState('');
  const [showDeps, setShowDeps] = useState(true);
  const [showP95, setShowP95] = useState(false);
  // Phase 19 — cumulative-cost S-curve overlay. Off by default; the header
  // gates the toggle to disabled when no MC run has landed yet.
  const [showSCurve, setShowSCurve] = useState(false);
  // Phase 25 Slice 3 — "Crash to deadline" modal visibility.
  const [crashModalOpen, setCrashModalOpen] = useState(false);
  // Hide the toolstrip button when the project has no crash options
  // anywhere — the modal would have nothing to suggest.
  const projectHasCrashOptions = project.nodes.some((n) => (n.crashOptions?.length ?? 0) > 0);

  // Local scroll ref — wraps the chart area inside the new chrome so
  // GanttMinimap can read scroll position and the Today button can jump.
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const latestSim = simHistory[0] ?? null;

  // Project time range. Default origin = project.startDate, but if any
  // scheduled activity starts earlier (e.g. a Start node anchors a chain into
  // a date before project.startDate), expand the timeline left so all bars
  // are visible. Snapped to local midnight so the date axis labels are clean.
  const projectStart = useMemo(() => {
    const projDefaultMs = new Date(project.project.startDate + 'T00:00:00').getTime();
    let earliestMs = projDefaultMs;
    for (const sched of Object.values(result.nodes)) {
      const t = sched.earliestStart.getTime();
      if (t < earliestMs) earliestMs = t;
    }
    const out = new Date(earliestMs);
    out.setHours(0, 0, 0, 0);
    return out;
  }, [result.nodes, project.project.startDate]);
  const projectEnd = result.projectEnd;
  // Extend the calendar 28 days past the last scheduled activity so there is
  // visible empty space after the bars — useful for reviewing float and will
  // serve as the placeholder area for the P95 Monte Carlo overlay (future).
  const GANTT_TRAIL_DAYS = 28;
  const totalDays = Math.max(1, dayIdx(projectEnd, projectStart) + GANTT_TRAIL_DAYS);

  // Default calendar for non-working day detection
  const defaultCal = useMemo(
    () =>
      project.calendars.find((c) => c.id === project.project.defaultCalendarId) ??
      project.calendars[0],
    [project.calendars, project.project.defaultCalendarId],
  );

  const nonWorkingSet = useMemo((): ReadonlySet<number> => {
    if (!defaultCal) return new Set();
    const s = new Set<number>();
    for (let i = 0; i < totalDays; i++) {
      const probe = new Date(projectStart.getTime() + i * 86_400_000);
      probe.setHours(8, 0, 0, 0);
      if (!isWorkingMoment(probe, defaultCal)) s.add(i);
    }
    return s;
  }, [projectStart, totalDays, defaultCal]);

  // Phase 33 Slice 2 follow-up — holiday lookup keyed by day index.
  // Resolves the project's default-calendar holiday set (preset +
  // exceptions) to a Map<dayIdx, holidayName> so the Gantt can render
  // holidays with a distinct fill and surface the holiday name on
  // hover. Holidays are a strict subset of `nonWorkingSet` — weekend
  // days that happen to coincide with a holiday show as holidays
  // (more informative than just "non-working").
  const holidayByDayIdx = useMemo((): ReadonlyMap<number, string> => {
    if (!defaultCal) return new Map();
    const namesByDate = resolveHolidays(defaultCal);
    const out = new Map<number, string>();
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(projectStart.getTime() + i * 86_400_000);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const key = `${y}-${m}-${day}`;
      const name = namesByDate.get(key);
      if (name !== undefined) out.set(i, name);
    }
    return out;
  }, [projectStart, totalDays, defaultCal]);

  // ── Build row list ────────────────────────────────────────────────────────

  const allRows = useMemo((): GanttRow[] => {
    // Phase 12 — track subsystem body nodes so they can be grouped under
    // a subsystem header row rather than appearing at the top level.
    const subsystemBodyNodeIdSet = new Set<string>();
    for (const sub of project.subsystems) {
      for (const nid of sub.bodyNodeIds) subsystemBodyNodeIdSet.add(nid);
    }

    const bodyNodeIdSet = new Set(project.loops.flatMap((l) => l.bodyNodeIds));

    // Phase 10 Tier 1: Start/End anchors are zero-duration milestones, not
    // schedulable activities. Hide them from the Gantt.
    const isAnchor = (n: ProjectNode): boolean => n.nodeType === 'start' || n.nodeType === 'end';
    // Phase 12: container nodes have no schedule result — always excluded.
    const isContainer = (n: ProjectNode): boolean => n.nodeType === 'subsystem';

    // loopId → body node IDs ordered by ES then name
    const loopBodyOrder = new Map<string, ProjectNode[]>();
    for (const loop of project.loops) {
      const bodyNodes = loop.bodyNodeIds
        .map((id) => project.nodes.find((n) => n.id === id))
        .filter((n): n is ProjectNode => n !== undefined && !isAnchor(n))
        .sort((a, b) => {
          const sa = result.nodes[a.id];
          const sb = result.nodes[b.id];
          if (!sa || !sb) return 0;
          const dt = sa.earliestStart.getTime() - sb.earliestStart.getTime();
          return dt !== 0 ? dt : a.name.localeCompare(b.name);
        });
      loopBodyOrder.set(loop.id, bodyNodes);
    }

    // Non-body nodes: anchors, subsystem body nodes, and container nodes all excluded.
    const nonBodyNodes = [...project.nodes]
      .filter(
        (n) =>
          !bodyNodeIdSet.has(n.id) &&
          !isAnchor(n) &&
          !subsystemBodyNodeIdSet.has(n.id) &&
          !isContainer(n),
      )
      .sort((a, b) => {
        const sa = result.nodes[a.id];
        const sb = result.nodes[b.id];
        if (!sa || !sb) return 0;
        const dt = sa.earliestStart.getTime() - sb.earliestStart.getTime();
        return dt !== 0 ? dt : a.name.localeCompare(b.name);
      });

    // ── Determine which loops live entirely inside a subsystem ────────
    const subsystemBodySets = new Map<string, Set<string>>();
    for (const sub of project.subsystems) {
      subsystemBodySets.set(sub.id, new Set(sub.bodyNodeIds));
    }
    const loopToSubsystemId = new Map<string, string>();
    for (const loop of project.loops) {
      for (const sub of project.subsystems) {
        const s = subsystemBodySets.get(sub.id)!;
        if (loop.bodyNodeIds.every((id) => s.has(id))) {
          loopToSubsystemId.set(loop.id, sub.id);
          break;
        }
      }
    }

    // ── Partition loops into grouped vs ungrouped (excl. subsystem loops) ─
    const groupedLoops = new Map<string, Loop[]>();
    const ungroupedLoops: Loop[] = [];
    for (const loop of project.loops) {
      if (loopToSubsystemId.has(loop.id)) continue; // handled by subsystem row
      if (loop.group) {
        const list = groupedLoops.get(loop.group) ?? [];
        list.push(loop);
        groupedLoops.set(loop.group, list);
      } else {
        ungroupedLoops.push(loop);
      }
    }

    // ── Build group member registry (nodes + loops) ───────────────────
    const groupMembers = new Map<string, { nodes: ProjectNode[]; loops: Loop[] }>();
    for (const node of nonBodyNodes) {
      if (!node.group) continue;
      const m = groupMembers.get(node.group) ?? { nodes: [], loops: [] };
      m.nodes.push(node);
      groupMembers.set(node.group, m);
    }
    for (const [gId, loops] of groupedLoops) {
      const m = groupMembers.get(gId) ?? { nodes: [], loops: [] };
      m.loops.push(...loops);
      groupMembers.set(gId, m);
    }

    // ── Compute group time bounds ─────────────────────────────────────
    const groupBounds = new Map<string, { start: Date; end: Date }>();
    for (const [groupId, { nodes, loops: gLoops }] of groupMembers) {
      let start: Date | null = null;
      let end: Date | null = null;
      for (const n of nodes) {
        const s = result.nodes[n.id];
        if (!s) continue;
        if (!start || s.earliestStart < start) start = s.earliestStart;
        if (!end || s.latestFinish > end) end = s.latestFinish;
      }
      for (const l of gLoops) {
        const b = loopBounds(l, result);
        if (!b) continue;
        if (!start || b.start < start) start = b.start;
        if (!end || b.end > end) end = b.end;
      }
      if (start && end) groupBounds.set(groupId, { start, end });
    }

    // ── Compute subsystem body nodes and time bounds ──────────────────
    const subsystemBodyOrderedNodes = new Map<string, ProjectNode[]>();
    const subsystemBounds = new Map<string, { start: Date; end: Date }>();

    for (const sub of project.subsystems) {
      // Body nodes that are not loop bodies (loops get their own header rows)
      const bodyNodes = sub.bodyNodeIds
        .map((id) => project.nodes.find((n) => n.id === id))
        .filter(
          (n): n is ProjectNode =>
            n !== undefined &&
            !isAnchor(n) &&
            !bodyNodeIdSet.has(n.id) &&
            result.nodes[n.id] !== undefined,
        )
        .sort((a, b) => {
          const sa = result.nodes[a.id];
          const sb = result.nodes[b.id];
          if (!sa || !sb) return 0;
          const dt = sa.earliestStart.getTime() - sb.earliestStart.getTime();
          return dt !== 0 ? dt : a.name.localeCompare(b.name);
        });
      subsystemBodyOrderedNodes.set(sub.id, bodyNodes);

      let start: Date | null = null;
      let end: Date | null = null;
      for (const n of bodyNodes) {
        const s = result.nodes[n.id];
        if (!s) continue;
        if (!start || s.earliestStart < start) start = s.earliestStart;
        if (!end || s.latestFinish > end) end = s.latestFinish;
      }
      // Also expand bounds for loops that live inside this subsystem
      for (const [loopId, subId] of loopToSubsystemId) {
        if (subId !== sub.id) continue;
        const loop = project.loops.find((l) => l.id === loopId);
        if (!loop) continue;
        const b = loopBounds(loop, result);
        if (!b) continue;
        if (!start || b.start < start) start = b.start;
        if (!end || b.end > end) end = b.end;
      }
      if (start && end) subsystemBounds.set(sub.id, { start, end });
    }

    // ── Top-level item list ───────────────────────────────────────────
    type Item =
      | { sort: number; kind: 'loop'; loop: Loop }
      | { sort: number; kind: 'group'; groupId: string }
      | { sort: number; kind: 'nonBody'; node: ProjectNode }
      | { sort: number; kind: 'subsystem'; subsystemId: string };

    const items: Item[] = [];

    for (const loop of ungroupedLoops) {
      const b = loopBounds(loop, result);
      items.push({ sort: b?.start.getTime() ?? 0, kind: 'loop', loop });
    }
    for (const [groupId, bounds] of groupBounds) {
      items.push({ sort: bounds.start.getTime(), kind: 'group', groupId });
    }
    for (const node of nonBodyNodes) {
      if (node.group) continue; // handled by its group row
      const s = result.nodes[node.id];
      items.push({ sort: s?.earliestStart.getTime() ?? 0, kind: 'nonBody', node });
    }
    for (const [subId, bounds] of subsystemBounds) {
      items.push({ sort: bounds.start.getTime(), kind: 'subsystem', subsystemId: subId });
    }
    items.sort((a, b) => a.sort - b.sort);

    // ── Emit rows ─────────────────────────────────────────────────────
    const out: GanttRow[] = [];

    function emitLoop(loop: Loop, inGroup: boolean, inSubsystem: boolean) {
      const b = loopBounds(loop, result);
      if (!b) return;
      out.push({
        kind: 'loopHeader',
        loop,
        start: b.start,
        end: b.end,
        iterCount: deterministicIterationCount(loop),
        inGroup,
        inSubsystem,
      });
      for (const node of loopBodyOrder.get(loop.id) ?? []) {
        out.push({ kind: 'node', node, inLoop: true, inGroup, inSubsystem });
      }
    }

    for (const item of items) {
      if (item.kind === 'loop') {
        emitLoop(item.loop, false, false);
      } else if (item.kind === 'group') {
        const { groupId } = item;
        const bounds = groupBounds.get(groupId);
        if (!bounds) continue;
        const { nodes: gNodes, loops: gLoops } = groupMembers.get(groupId) ?? {
          nodes: [],
          loops: [],
        };
        out.push({
          kind: 'groupHeader',
          groupId,
          start: bounds.start,
          end: bounds.end,
          itemCount: gNodes.length + gLoops.length,
        });

        if (!collapsedGroupIds.has(groupId)) {
          type GM = { sort: number } & (
            | { t: 'node'; node: ProjectNode }
            | { t: 'loop'; loop: Loop }
          );
          const members: GM[] = [];
          for (const node of gNodes) {
            const s = result.nodes[node.id];
            members.push({ sort: s?.earliestStart.getTime() ?? 0, t: 'node', node });
          }
          for (const loop of gLoops) {
            const b = loopBounds(loop, result);
            members.push({ sort: b?.start.getTime() ?? 0, t: 'loop', loop });
          }
          members.sort((a, b) => a.sort - b.sort);

          for (const m of members) {
            if (m.t === 'node') {
              out.push({
                kind: 'node',
                node: m.node,
                inLoop: false,
                inGroup: true,
                inSubsystem: false,
              });
            } else {
              emitLoop(m.loop, true, false);
            }
          }
        }
      } else if (item.kind === 'subsystem') {
        const { subsystemId } = item;
        const sub = project.subsystems.find((s) => s.id === subsystemId);
        if (!sub) continue;
        const bounds = subsystemBounds.get(subsystemId);
        if (!bounds) continue;
        const containerNode = project.nodes.find((n) => n.id === sub.containerNodeId);
        const subName = containerNode?.name ?? 'Sub-system';
        const bodyNodes = subsystemBodyOrderedNodes.get(subsystemId) ?? [];
        const subLoops = project.loops.filter((l) => loopToSubsystemId.get(l.id) === subsystemId);
        out.push({
          kind: 'subsystemHeader',
          subsystemId,
          name: subName,
          start: bounds.start,
          end: bounds.end,
          itemCount: bodyNodes.length + subLoops.length,
        });

        if (!collapsedSubsystemIds.has(subsystemId)) {
          type SubItem = { sort: number } & (
            | { t: 'node'; node: ProjectNode }
            | { t: 'loop'; loop: Loop }
          );
          const subItems: SubItem[] = [];
          for (const node of bodyNodes) {
            const s = result.nodes[node.id];
            subItems.push({ sort: s?.earliestStart.getTime() ?? 0, t: 'node', node });
          }
          for (const loop of subLoops) {
            const b = loopBounds(loop, result);
            subItems.push({ sort: b?.start.getTime() ?? 0, t: 'loop', loop });
          }
          subItems.sort((a, b) => a.sort - b.sort);

          for (const m of subItems) {
            if (m.t === 'node') {
              out.push({
                kind: 'node',
                node: m.node,
                inLoop: false,
                inGroup: false,
                inSubsystem: true,
              });
            } else {
              emitLoop(m.loop, false, true);
            }
          }
        }
      } else {
        out.push({
          kind: 'node',
          node: item.node,
          inLoop: false,
          inGroup: false,
          inSubsystem: false,
        });
      }
    }
    return out;
  }, [
    project.nodes,
    project.loops,
    project.subsystems,
    result,
    collapsedGroupIds,
    collapsedSubsystemIds,
  ]);

  // Phase 15 — apply the toolstrip search filter. Drop activity rows whose
  // node name doesn't contain the query; headers (group / loop / sub-system)
  // are kept so users still see structural context. Empty query → no filter.
  // The rest of this component uses `rows` for rendering (filtered) and
  // `allRows` for things like the minimap that need every activity.
  const rows = useMemo((): GanttRow[] => {
    const q = search.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((r) => {
      if (r.kind !== 'node') return true;
      return r.node.name.toLowerCase().includes(q);
    });
  }, [allRows, search]);

  // Map nodeId → loopId for the loop it belongs to (if any)
  const nodeToLoopId = useMemo(() => {
    const map = new Map<string, string>();
    for (const loop of project.loops) {
      for (const nodeId of loop.bodyNodeIds) {
        map.set(nodeId, loop.id);
      }
    }
    return map;
  }, [project.loops]);

  // Resource timeline grouped by nodeId for quick lookup
  const timelineByNode = useMemo(() => {
    const map = new Map<string, typeof result.resourceTimeline>();
    for (const e of result.resourceTimeline) {
      const list = map.get(e.nodeId) ?? [];
      list.push(e);
      map.set(e.nodeId, list);
    }
    return map;
  }, [result.resourceTimeline]);

  // Bar info per node — used for dependency arrow endpoints.
  // For loop body nodes with multiple iterations, the right edge is the END of
  // the LAST iteration so that outgoing arrows leave from after the whole loop.
  const nodeBarInfo = useMemo(() => {
    const map = new Map<string, { barX: number; barW: number; centerY: number }>();
    rows.forEach((row, rowIdx) => {
      if (row.kind !== 'node') return;
      const sched = result.nodes[row.node.id];
      if (!sched) return;
      const barX = xOf(sched.earliestStart, projectStart, DAY_WIDTH);

      let rightX: number;
      if (row.inLoop) {
        const entries = timelineByNode.get(row.node.id) ?? [];
        if (entries.length > 1) {
          // Last iteration = highest iteration index
          const last = entries.reduce((best, e) => (e.iteration > best.iteration ? e : best));
          rightX = xOf(last.end, projectStart, DAY_WIDTH);
        } else if (entries.length === 1) {
          rightX = xOf(entries[0]!.end, projectStart, DAY_WIDTH);
        } else {
          rightX = xOf(sched.earliestFinish, projectStart, DAY_WIDTH);
        }
      } else {
        rightX = xOf(sched.earliestFinish, projectStart, DAY_WIDTH);
      }

      map.set(row.node.id, {
        barX,
        barW: Math.max(4, rightX - barX),
        centerY: rowIdx * ROW_HEIGHT + ROW_HEIGHT * 0.5,
      });
    });
    return map;
    // DAY_WIDTH is included in deps — zooming changes xOf's output, and
    // forgetting this leaves dependency-arrow endpoints stuck at the
    // old scale while bars and grid re-render at the new one.
  }, [rows, result.nodes, timelineByNode, projectStart, DAY_WIDTH]);

  const months = useMemo(() => monthGroups(projectStart, totalDays), [projectStart, totalDays]);

  const timelineWidth = totalDays * DAY_WIDTH;
  const bodyHeight = rows.length * ROW_HEIGHT;

  // ── Dark-mode aware SVG color tokens ─────────────────────────────────────
  const nonWorkingHeaderFill = darkMode ? '#1e293b' : '#e5e7eb';
  const nonWorkingBodyFill = darkMode ? '#1e293b' : '#f9fafb';
  // Phase 33 Slice 2 follow-up — holidays use a warmer tint than the
  // neutral non-working shade so users can read "weekend vs holiday"
  // at a glance. Saturation and luminance chosen to stay subtle (not
  // pull the eye away from the bars) while still being distinct.
  const holidayHeaderFill = darkMode ? '#3f2014' : '#fef3c7';
  const holidayBodyFill = darkMode ? '#2a1610' : '#fffbeb';
  const monthTextFill = darkMode ? '#d1d5db' : '#374151';
  const monthDividerStroke = darkMode ? '#4b5563' : '#d1d5db';
  const dayTextFill = darkMode ? '#9ca3af' : '#6b7280';
  const dayNonWorkTextFill = darkMode ? '#4b5563' : '#9ca3af';
  const headerDayLineStroke = darkMode ? '#374151' : '#e5e7eb';
  const dimLineStroke = darkMode ? '#374151' : '#f3f4f6';
  const arrowStroke = darkMode ? '#4b5563' : '#cbd5e1';

  // ── Render ────────────────────────────────────────────────────────────────

  // Today's x-position on the chart (in chart-pixel coords). Returned as null
  // when today falls outside the project's visible window so we can skip
  // drawing the marker.
  const todayX = useMemo(() => {
    const now = new Date();
    const x = xOf(now, projectStart, DAY_WIDTH);
    if (x < 0 || x > totalDays * DAY_WIDTH) return null;
    return x;
    // DAY_WIDTH in deps so the today marker re-positions on zoom.
  }, [projectStart, totalDays, DAY_WIDTH]);

  // Phase 19 slice 5 — draggable date cursor on the main Gantt chart.
  // Snaps to local midnight (day-granularity). Cursor data value is an
  // epoch ms. The bar groups carry inline `style={{ cursor: 'pointer' }}`
  // + onClick — we filter those out via ignoreSelector so the cursor
  // doesn't fight the existing bar-click selection flow.
  const totalChartWidth = totalDays * DAY_WIDTH;
  const cursor = useChartCursor({
    clientXToData: (clientX) => {
      if (clientX < 0 || clientX > totalChartWidth) return null;
      const daysFromStart = clientX / DAY_WIDTH;
      return projectStart.getTime() + daysFromStart * 86_400_000;
    },
    snap: snapToLocalMidnight,
    ignoreSelector: 'button, a, [role="button"], g[style*="cursor: pointer"]',
  });

  function jumpToToday() {
    const el = scrollRef.current;
    if (!el) return;
    if (todayX === null) {
      el.scrollTo({ left: 0, behavior: 'smooth' });
      return;
    }
    el.scrollTo({
      left: Math.max(0, todayX - (el.clientWidth - labelWidth) / 2),
      behavior: 'smooth',
    });
  }

  // Phase 47 Slice 2 — Fit-to-view. Picks the largest zoom level whose
  // total chart pixel width (BASE_DAY_WIDTH × ganttZoom × projectDays)
  // still fits in the visible chart area (scroll container width minus
  // the label column). Clamped by viewStore.setGanttZoom to the
  // discrete-step min/max.
  function fitToView() {
    const el = scrollRef.current;
    if (!el) return;
    const projectStart = new Date(project.project.startDate + 'T00:00:00');
    const projectDays = Math.max(
      1,
      Math.ceil((result.projectEnd.getTime() - projectStart.getTime()) / 86_400_000),
    );
    const visiblePx = Math.max(100, el.clientWidth - labelWidth);
    const zoomForFit = visiblePx / (BASE_DAY_WIDTH * projectDays);
    setGanttZoom(zoomForFit);
  }

  if (allRows.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-500 text-sm">
        Add nodes on the Canvas tab to see the schedule here.
      </div>
    );
  }

  // Activities for the minimap — every scheduled, non-anchor node, regardless
  // of the search filter so the overview always reflects the whole project.
  const minimapNodes = project.nodes.filter(
    (n) => n.nodeType !== 'start' && n.nodeType !== 'end' && n.nodeType !== 'subsystem',
  );

  // Combined ref: keep the external `containerRef` (PNG export) in sync with
  // the internal `scrollRef` (minimap & Today button) by writing both.
  const setScrollEl = (el: HTMLDivElement | null) => {
    scrollRef.current = el;
    if (containerRef) {
      (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-gray-900">
      <GanttHeader
        project={project}
        result={result}
        latestSim={latestSim}
        search={search}
        setSearch={setSearch}
        showDeps={showDeps}
        setShowDeps={setShowDeps}
        showP95={showP95}
        setShowP95={setShowP95}
        showSCurve={showSCurve}
        setShowSCurve={setShowSCurve}
        onJumpToday={jumpToToday}
        onFitToView={fitToView}
        {...(projectHasCrashOptions ? { onOpenCrash: () => setCrashModalOpen(true) } : {})}
      />

      {/* Phase 25 Slice 3 — Crash-to-deadline modal */}
      {crashModalOpen && (
        <CrashToDeadlineModal
          project={project}
          result={result}
          onClose={() => setCrashModalOpen(false)}
        />
      )}

      <div ref={setScrollEl} className="flex-1 overflow-auto select-none">
        <div style={{ display: 'inline-flex', minWidth: '100%' }}>
          {/* ── Frozen label column ─────────────────────────────────────── */}
          <div
            className="sticky left-0 z-20 shrink-0 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 relative"
            style={{ width: labelWidth }}
          >
            {/* Phase 47 Slice 2 — drag handle on the right edge of the label
              column. Pointer-down captures the pointer and the global
              pointermove handler updates viewStore.ganttLabelWidth until
              release. The strip is 6 px wide centred over the column
              border (so a 2 px border still feels clickable). */}
            <GanttLabelResizer onResize={(deltaPx) => setGanttLabelWidth(labelWidth + deltaPx)} />
            <div
              className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800"
              style={{ height: HEADER_H }}
            />

            {rows.map((row) => {
              // ── Subsystem header label ──────────────────────────────────
              if (row.kind === 'subsystemHeader') {
                const isCollapsed = collapsedSubsystemIds.has(row.subsystemId);
                return (
                  <div
                    key={`subsystem-${row.subsystemId}`}
                    className="flex items-center px-3 border-b border-gray-100 dark:border-gray-700 cursor-pointer text-sm gap-1.5 bg-indigo-50/60 dark:bg-indigo-900/20 hover:bg-indigo-50 dark:hover:bg-indigo-900/30"
                    style={{ height: ROW_HEIGHT }}
                    onClick={() => toggleSubsystemCollapse(row.subsystemId)}
                    title={`Sub-system: ${row.name} — ${row.itemCount} item${row.itemCount !== 1 ? 's' : ''}`}
                  >
                    <span className="text-indigo-500 dark:text-indigo-400 shrink-0 text-xs w-3">
                      {isCollapsed ? '▶' : '▼'}
                    </span>
                    <span
                      className="shrink-0 text-indigo-500 dark:text-indigo-400"
                      style={{ fontSize: 13 }}
                    >
                      ⊞
                    </span>
                    <span className="truncate font-medium text-indigo-700 dark:text-indigo-300">
                      {row.name}
                    </span>
                    <span className="text-xs text-indigo-400 dark:text-indigo-500 shrink-0 ml-auto">
                      {row.itemCount}
                    </span>
                  </div>
                );
              }

              // ── Group header label ──────────────────────────────────────
              if (row.kind === 'groupHeader') {
                const isCollapsed = collapsedGroupIds.has(row.groupId);
                return (
                  <div
                    key={`group-${row.groupId}`}
                    className="flex items-center px-3 border-b border-gray-100 dark:border-gray-700 cursor-pointer text-sm gap-1.5 bg-teal-50/60 dark:bg-teal-900/20 hover:bg-teal-50 dark:hover:bg-teal-900/30"
                    style={{ height: ROW_HEIGHT }}
                    onClick={() => toggleGroupCollapse(row.groupId)}
                    title={`Group: ${row.groupId} — ${row.itemCount} item${row.itemCount !== 1 ? 's' : ''}`}
                  >
                    <span className="text-teal-500 dark:text-teal-400 shrink-0 text-xs w-3">
                      {isCollapsed ? '▶' : '▼'}
                    </span>
                    <span className="truncate font-medium text-teal-700 dark:text-teal-300">
                      {row.groupId}
                    </span>
                    <span className="text-xs text-teal-400 dark:text-teal-500 shrink-0 ml-auto">
                      {row.itemCount}
                    </span>
                  </div>
                );
              }

              // ── Loop header label ───────────────────────────────────────
              if (row.kind === 'loopHeader') {
                const isSelected = selectedLoopId === row.loop.id;
                return (
                  <div
                    key={`loop-${row.loop.id}`}
                    className={[
                      'flex items-center border-b border-gray-100 dark:border-gray-700 cursor-pointer text-sm gap-1.5',
                      isSelected
                        ? 'bg-violet-50 dark:bg-violet-900/30'
                        : 'hover:bg-violet-50/50 dark:hover:bg-violet-900/20',
                    ].join(' ')}
                    style={{
                      height: ROW_HEIGHT,
                      paddingLeft: row.inGroup || row.inSubsystem ? BODY_INDENT + 8 : 12,
                    }}
                    onClick={() => {
                      selectLoop(row.loop.id);
                    }}
                    onDoubleClick={() => {
                      selectLoop(row.loop.id);
                      revealInspector();
                    }}
                    title={`Loop — ${row.iterCount} iteration${row.iterCount !== 1 ? 's' : ''}`}
                  >
                    {row.inGroup && (
                      <span
                        className="text-teal-300 dark:text-teal-600 mr-1 shrink-0"
                        style={{ fontSize: 9 }}
                      >
                        ┗
                      </span>
                    )}
                    <span className="text-violet-500 dark:text-violet-400 shrink-0">↻</span>
                    <span
                      className={[
                        'truncate font-medium',
                        isSelected
                          ? 'text-violet-700 dark:text-violet-300'
                          : 'text-violet-600 dark:text-violet-400',
                      ].join(' ')}
                    >
                      Loop
                    </span>
                    <span className="text-xs text-violet-400 dark:text-violet-500 shrink-0">
                      ×{row.iterCount}
                    </span>
                  </div>
                );
              }

              // ── Node row label ──────────────────────────────────────────
              const { node, inLoop, inGroup, inSubsystem } = row;
              const sched = result.nodes[node.id];
              const isCritical = sched?.onCriticalPath ?? false;
              const isSelected = selection.nodeIds.includes(node.id);
              const indented = inLoop || inGroup || inSubsystem;
              return (
                <div
                  key={node.id}
                  className={[
                    'flex items-center border-b border-gray-100 dark:border-gray-700 cursor-pointer text-sm',
                    isSelected
                      ? 'bg-blue-50 dark:bg-blue-900/30'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-800',
                  ].join(' ')}
                  style={{ height: ROW_HEIGHT, paddingLeft: indented ? BODY_INDENT + 8 : 12 }}
                  onClick={() => {
                    selectNodes([node.id]);
                  }}
                  onDoubleClick={() => {
                    selectNodes([node.id]);
                    revealInspector();
                  }}
                  title={node.name}
                >
                  {inLoop && (
                    <span
                      className="text-violet-300 dark:text-violet-500 mr-1.5 shrink-0"
                      style={{ fontSize: 9 }}
                    >
                      ┗
                    </span>
                  )}
                  {inGroup && !inLoop && (
                    <span
                      className="text-teal-300 dark:text-teal-600 mr-1.5 shrink-0"
                      style={{ fontSize: 9 }}
                    >
                      ┗
                    </span>
                  )}
                  {inSubsystem && !inLoop && (
                    <span
                      className="text-indigo-300 dark:text-indigo-600 mr-1.5 shrink-0"
                      style={{ fontSize: 9 }}
                    >
                      ┗
                    </span>
                  )}
                  {result.conflictedNodeIds[node.id] && (
                    <span
                      className="mr-1.5 shrink-0 text-[12px] leading-none"
                      title={conflictTitle(result.conflictedNodeIds[node.id]!, project.resources)}
                      aria-label="Resource conflict"
                    >
                      ⚠️
                    </span>
                  )}
                  <span
                    className={[
                      'flex-1 truncate',
                      isCritical
                        ? 'font-semibold text-red-700 dark:text-red-400'
                        : 'text-gray-700 dark:text-gray-300',
                    ].join(' ')}
                  >
                    {node.name}
                  </span>
                  <span className="shrink-0 inline-flex items-center gap-1 ml-1.5">
                    <span className="font-mono text-[10px] max-md:text-xs text-gray-500 dark:text-gray-400">
                      {formatDuration(node.duration)}
                    </span>
                    {(node.resourceAssignments ?? []).length > 0 && (
                      <span className="inline-flex gap-0.5">
                        {(node.resourceAssignments ?? []).slice(0, 2).map((a, k) => {
                          const res = project.resources.find((r) => r.id === a.resourceId);
                          const name = (res?.name ?? '?').slice(0, 3);
                          return (
                            <span
                              key={k}
                              className="bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 text-[9.5px] font-medium px-1 py-px rounded"
                            >
                              {name}
                            </span>
                          );
                        })}
                        {(node.resourceAssignments ?? []).length > 2 && (
                          <span className="bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 text-[9.5px] font-medium px-1 py-px rounded">
                            +{(node.resourceAssignments ?? []).length - 2}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}

            {/* Phase 19 — Cumulative cost section label. Pairs with the
              dedicated panel rendered in the timeline column below. The
              user toggles visibility via the "S-curve" toolstrip button;
              hidden when toggle is off or no MC run has landed yet. */}
            {showSCurve && latestSim?.result && (
              <div
                className="flex items-center px-3 border-t border-gray-200 dark:border-gray-700 bg-amber-50/40 dark:bg-amber-900/10 gap-1.5"
                style={{ height: COST_PANEL_H }}
              >
                <span className="text-amber-600 dark:text-amber-400 text-[14px] shrink-0">📈</span>
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-[11px] max-md:text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400 truncate">
                    Cumulative cost
                  </span>
                  <span className="text-[9.5px] text-amber-600/80 dark:text-amber-500/80 truncate">
                    P10 – P95 band
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* ── Timeline (header + bars) ────────────────────────────────── */}
          <div style={{ position: 'relative', width: timelineWidth }}>
            {/* Date header */}
            <svg
              width={timelineWidth}
              height={HEADER_H}
              className="block border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800"
              style={{ position: 'sticky', top: 0, zIndex: 10 }}
            >
              {Array.from({ length: totalDays }, (_, i) => {
                // Phase 33 Slice 2 follow-up — holidays render with a
                // distinct fill so users can tell weekends apart from
                // observed holidays. Holiday name surfaced via <title>
                // (native SVG tooltip).
                const holidayName = holidayByDayIdx.get(i);
                if (holidayName !== undefined) {
                  return (
                    <rect
                      key={i}
                      x={i * DAY_WIDTH}
                      y={0}
                      width={DAY_WIDTH}
                      height={HEADER_H}
                      fill={holidayHeaderFill}
                    >
                      <title>{holidayName}</title>
                    </rect>
                  );
                }
                if (nonWorkingSet.has(i)) {
                  return (
                    <rect
                      key={i}
                      x={i * DAY_WIDTH}
                      y={0}
                      width={DAY_WIDTH}
                      height={HEADER_H}
                      fill={nonWorkingHeaderFill}
                    />
                  );
                }
                return null;
              })}
              {months.map((m) => (
                <g key={m.label + m.startDay}>
                  <text
                    x={m.startDay * DAY_WIDTH + 4}
                    y={16}
                    fontSize={11}
                    fontWeight={600}
                    fill={monthTextFill}
                  >
                    {m.label}
                  </text>
                  <line
                    x1={m.startDay * DAY_WIDTH}
                    y1={0}
                    x2={m.startDay * DAY_WIDTH}
                    y2={HEADER_H}
                    stroke={monthDividerStroke}
                    strokeWidth={1}
                  />
                </g>
              ))}
              {Array.from({ length: totalDays }, (_, i) => {
                const d = new Date(projectStart.getTime() + i * 86_400_000);
                return (
                  <text
                    key={i}
                    x={i * DAY_WIDTH + DAY_WIDTH / 2}
                    y={HEADER_H - 8}
                    textAnchor="middle"
                    fontSize={9}
                    fill={nonWorkingSet.has(i) ? dayNonWorkTextFill : dayTextFill}
                  >
                    {d.getDate()}
                  </text>
                );
              })}
              {Array.from({ length: totalDays }, (_, i) => (
                <line
                  key={i}
                  x1={i * DAY_WIDTH}
                  y1={HEADER_H / 2}
                  x2={i * DAY_WIDTH}
                  y2={HEADER_H}
                  stroke={headerDayLineStroke}
                  strokeWidth={0.5}
                />
              ))}
            </svg>

            {/* Gantt bar area */}
            <svg
              width={timelineWidth}
              height={bodyHeight}
              className="block select-none"
              {...cursor.pointerHandlers}
            >
              {/* Arrowhead marker definition */}
              <defs>
                <marker
                  id="gantt-arr"
                  markerWidth="8"
                  markerHeight="8"
                  refX="6"
                  refY="4"
                  orient="auto"
                >
                  <polyline
                    points="0,0 7,4 0,8"
                    fill="none"
                    stroke={arrowStroke}
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                </marker>
              </defs>

              {/* Non-working day shading. Phase 33 Slice 2 follow-up —
                holiday columns get a distinct warm tint so they can be
                read apart from weekends. */}
              {Array.from({ length: totalDays }, (_, i) => {
                const holidayName = holidayByDayIdx.get(i);
                if (holidayName !== undefined) {
                  return (
                    <rect
                      key={i}
                      x={i * DAY_WIDTH}
                      y={0}
                      width={DAY_WIDTH}
                      height={bodyHeight}
                      fill={holidayBodyFill}
                    >
                      <title>{holidayName}</title>
                    </rect>
                  );
                }
                if (nonWorkingSet.has(i)) {
                  return (
                    <rect
                      key={i}
                      x={i * DAY_WIDTH}
                      y={0}
                      width={DAY_WIDTH}
                      height={bodyHeight}
                      fill={nonWorkingBodyFill}
                    />
                  );
                }
                return null;
              })}

              {/* Row separators */}
              {rows.map((_, row) => (
                <line
                  key={row}
                  x1={0}
                  y1={(row + 1) * ROW_HEIGHT}
                  x2={timelineWidth}
                  y2={(row + 1) * ROW_HEIGHT}
                  stroke={dimLineStroke}
                  strokeWidth={1}
                />
              ))}

              {/* Day dividers */}
              {Array.from({ length: totalDays }, (_, i) => (
                <line
                  key={i}
                  x1={i * DAY_WIDTH}
                  y1={0}
                  x2={i * DAY_WIDTH}
                  y2={bodyHeight}
                  stroke={dimLineStroke}
                  strokeWidth={0.5}
                />
              ))}

              {/* Dependency arrows — rendered below bars (toggled via the toolstrip Deps button) */}
              {showDeps &&
                project.edges.map((edge) => {
                  // Skip edges where both endpoints are in the same loop — the
                  // loop structure itself already communicates the sequence (A1→B1→A2→B2…)
                  // and drawing an arrow from the last-iteration end back to iter-1
                  // of the same loop would be misleading.
                  const fromLoop = nodeToLoopId.get(edge.from);
                  const toLoop = nodeToLoopId.get(edge.to);
                  if (fromLoop && fromLoop === toLoop) return null;

                  const from = nodeBarInfo.get(edge.from);
                  const to = nodeBarInfo.get(edge.to);
                  if (!from || !to) return null;

                  let x1: number, y1: number, x2: number, y2: number;

                  switch (edge.type) {
                    case 'FS':
                      x1 = from.barX + from.barW;
                      y1 = from.centerY;
                      x2 = to.barX;
                      y2 = to.centerY;
                      break;
                    case 'SS':
                      x1 = from.barX;
                      y1 = from.centerY;
                      x2 = to.barX;
                      y2 = to.centerY;
                      break;
                    case 'FF':
                      x1 = from.barX + from.barW;
                      y1 = from.centerY;
                      x2 = to.barX + to.barW;
                      y2 = to.centerY;
                      break;
                    case 'SF':
                      x1 = from.barX;
                      y1 = from.centerY;
                      x2 = to.barX + to.barW;
                      y2 = to.centerY;
                      break;
                    default:
                      return null;
                  }

                  // Forward path: smooth S-curve bezier. Backward path: orthogonal U-route.
                  const forward = x2 >= x1 - 4;
                  let d: string;
                  if (forward) {
                    const cp = Math.max((x2 - x1) * 0.5, 20);
                    d = `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`;
                  } else {
                    const pad = 14;
                    const midY = (y1 + y2) / 2;
                    d = `M ${x1} ${y1} h ${pad} V ${midY} H ${x2 - pad} V ${y2} h ${pad}`;
                  }

                  return (
                    <path
                      key={edge.id}
                      d={d}
                      fill="none"
                      stroke={arrowStroke}
                      strokeWidth={1.5}
                      markerEnd="url(#gantt-arr)"
                      opacity={0.85}
                    />
                  );
                })}

              {/* Bars */}
              {rows.map((row, rowIdx) => {
                const y0 = rowIdx * ROW_HEIGHT;

                // ── Subsystem header bar ──────────────────────────────────
                if (row.kind === 'subsystemHeader') {
                  const barX = xOf(row.start, projectStart, DAY_WIDTH);
                  const barW = Math.max(DAY_WIDTH, xOf(row.end, projectStart, DAY_WIDTH) - barX);
                  const barY = y0 + BAR_TOP;
                  const isCollapsed = collapsedSubsystemIds.has(row.subsystemId);
                  return (
                    <g
                      key={`subsystem-${row.subsystemId}`}
                      style={{ cursor: 'pointer' }}
                      onClick={() => toggleSubsystemCollapse(row.subsystemId)}
                    >
                      <rect
                        x={barX}
                        y={barY}
                        width={barW}
                        height={BAR_H}
                        fill="#6366f1"
                        rx={3}
                        opacity={0.75}
                      />
                      {barW >= 48 && (
                        <text
                          x={barX + 6}
                          y={barY + BAR_H / 2 + 4}
                          fontSize={10}
                          fill="white"
                          style={{ pointerEvents: 'none' }}
                        >
                          {isCollapsed ? '▶ ' : '⊞ '}
                          {row.name.length > 16 ? row.name.slice(0, 14) + '…' : row.name}
                        </text>
                      )}
                    </g>
                  );
                }

                // ── Group header bar ──────────────────────────────────────
                if (row.kind === 'groupHeader') {
                  const barX = xOf(row.start, projectStart, DAY_WIDTH);
                  const barW = Math.max(DAY_WIDTH, xOf(row.end, projectStart, DAY_WIDTH) - barX);
                  const barY = y0 + BAR_TOP;
                  const isCollapsed = collapsedGroupIds.has(row.groupId);

                  return (
                    <g
                      key={`group-${row.groupId}`}
                      style={{ cursor: 'pointer' }}
                      onClick={() => toggleGroupCollapse(row.groupId)}
                    >
                      <rect
                        x={barX}
                        y={barY}
                        width={barW}
                        height={BAR_H}
                        fill="#14b8a6"
                        rx={3}
                        opacity={0.72}
                      />
                      {barW >= 48 && (
                        <text
                          x={barX + 6}
                          y={barY + BAR_H / 2 + 4}
                          fontSize={10}
                          fill="white"
                          style={{ pointerEvents: 'none' }}
                        >
                          {isCollapsed ? '▶ ' : ''}
                          {row.groupId.length > 18 ? row.groupId.slice(0, 16) + '…' : row.groupId}
                        </text>
                      )}
                    </g>
                  );
                }

                // ── Loop header bar ───────────────────────────────────────
                if (row.kind === 'loopHeader') {
                  const barX = xOf(row.start, projectStart, DAY_WIDTH);
                  const barW = Math.max(DAY_WIDTH, xOf(row.end, projectStart, DAY_WIDTH) - barX);
                  const barY = y0 + BAR_TOP;
                  const isSelected = selectedLoopId === row.loop.id;

                  return (
                    <g
                      key={`loop-${row.loop.id}`}
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        selectLoop(row.loop.id);
                      }}
                      onDoubleClick={() => {
                        selectLoop(row.loop.id);
                        revealInspector();
                      }}
                    >
                      <rect
                        x={barX}
                        y={barY}
                        width={barW}
                        height={BAR_H}
                        fill="#8b5cf6"
                        rx={3}
                        opacity={0.75}
                        stroke={isSelected ? '#6d28d9' : 'none'}
                        strokeWidth={isSelected ? 2 : 0}
                      />
                      {row.iterCount > 1 &&
                        (() => {
                          const iterW = barW / row.iterCount;
                          return Array.from({ length: row.iterCount - 1 }, (_, k) => (
                            <line
                              key={k}
                              x1={barX + (k + 1) * iterW}
                              y1={barY + 2}
                              x2={barX + (k + 1) * iterW}
                              y2={barY + BAR_H - 2}
                              stroke="white"
                              strokeWidth={1}
                              opacity={0.6}
                            />
                          ));
                        })()}
                      {barW >= 48 && (
                        <text
                          x={barX + 6}
                          y={barY + BAR_H / 2 + 4}
                          fontSize={10}
                          fill="white"
                          style={{ pointerEvents: 'none' }}
                        >
                          ↻ ×{row.iterCount}
                        </text>
                      )}
                    </g>
                  );
                }

                // ── Node row ──────────────────────────────────────────────
                const { node, inLoop } = row;
                const sched = result.nodes[node.id];
                if (!sched) return null;

                const isCritical = sched.onCriticalPath;
                const isSelected = selection.nodeIds.includes(node.id);
                const barFill = isCritical ? '#ef4444' : '#3b82f6';
                const barY = y0 + BAR_TOP;

                const entries = inLoop ? (timelineByNode.get(node.id) ?? []) : [];

                if (inLoop && entries.length > 1) {
                  return (
                    <g
                      key={node.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        selectNodes([node.id]);
                      }}
                      onDoubleClick={() => {
                        selectNodes([node.id]);
                        revealInspector();
                      }}
                    >
                      {entries.map((e) => {
                        const bx = xOf(e.start, projectStart, DAY_WIDTH);
                        const bw = Math.max(4, xOf(e.end, projectStart, DAY_WIDTH) - bx);
                        return (
                          <rect
                            key={e.iteration}
                            x={bx}
                            y={barY}
                            width={bw}
                            height={BAR_H}
                            fill={barFill}
                            rx={3}
                            opacity={isSelected ? 1 : 0.82}
                            stroke={isSelected ? '#1d4ed8' : 'none'}
                            strokeWidth={isSelected ? 2 : 0}
                          />
                        );
                      })}
                      {(() => {
                        const first = entries[0]!;
                        const bx = xOf(first.start, projectStart, DAY_WIDTH);
                        return (
                          <text
                            x={bx + 4}
                            y={barY + BAR_H / 2 + 4}
                            fontSize={10}
                            fill="white"
                            style={{ pointerEvents: 'none' }}
                          >
                            {node.name.length > 10 ? node.name.slice(0, 8) + '…' : node.name}
                          </text>
                        );
                      })()}
                    </g>
                  );
                }

                const barX = xOf(sched.earliestStart, projectStart, DAY_WIDTH);
                const barW = Math.max(4, xOf(sched.earliestFinish, projectStart, DAY_WIDTH) - barX);
                const slackW = Math.max(
                  0,
                  xOf(sched.latestFinish, projectStart, DAY_WIDTH) -
                    xOf(sched.earliestFinish, projectStart, DAY_WIDTH),
                );

                const iterCount = inLoop ? (entries.length > 0 ? entries.length : 1) : 1;

                // Phase 16 — P95 tail overlay. When the toggle is on AND we have
                // a sim result with a per-node P95 Date, draw a faded extension
                // to the right of the bar up to that date. Anchor nodes are
                // excluded from `nodeP95` so they'll never render.
                let p95X: number | null = null;
                let p95Date: Date | null = null;
                if (showP95 && latestSim) {
                  const d = latestSim.result.nodeP95[node.id];
                  if (d) {
                    const candidateX = xOf(d, projectStart, DAY_WIDTH);
                    if (candidateX > barX + barW) {
                      p95X = candidateX;
                      p95Date = d;
                    }
                  }
                }
                const p95W = p95X !== null ? p95X - (barX + barW) : 0;

                return (
                  <g
                    key={node.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => {
                      selectNodes([node.id]);
                    }}
                    onDoubleClick={() => {
                      selectNodes([node.id]);
                      revealInspector();
                    }}
                  >
                    {!isCritical && slackW > 0 && !inLoop && (
                      <rect
                        x={barX + barW}
                        y={barY + BAR_H * 0.3}
                        width={slackW}
                        height={BAR_H * 0.4}
                        fill="#bfdbfe"
                        rx={2}
                      />
                    )}
                    {/* P95 tail — drawn before the main bar so the bar's
                      rounded right edge sits cleanly on top. */}
                    {p95W > 0 && p95Date && (
                      <rect
                        x={barX + barW}
                        y={barY}
                        width={p95W}
                        height={BAR_H}
                        fill={barFill}
                        opacity={0.22}
                        rx={3}
                      >
                        <title>
                          {`P95 finish · ${p95Date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}
                        </title>
                      </rect>
                    )}
                    <rect
                      x={barX}
                      y={barY}
                      width={barW}
                      height={BAR_H}
                      fill={node.consumesResources === false && inLoop ? '#a78bfa' : barFill}
                      rx={3}
                      opacity={node.consumesResources === false && inLoop ? 0.45 : 0.88}
                      stroke={isSelected ? '#1d4ed8' : 'none'}
                      strokeWidth={isSelected ? 2 : 0}
                      strokeDasharray={node.consumesResources === false ? '4 2' : undefined}
                    />
                    {barW >= 48 && (
                      <text
                        x={barX + 6}
                        y={barY + BAR_H / 2 + 4}
                        fontSize={10}
                        fill={node.consumesResources === false && inLoop ? '#5b21b6' : 'white'}
                        style={{ pointerEvents: 'none' }}
                      >
                        {node.name.length > 14 ? node.name.slice(0, 12) + '…' : node.name}
                        {iterCount > 1 ? ` ×${iterCount}` : ''}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Today vertical line — drawn last so it overlays bars/arrows */}
              {todayX !== null && (
                <g pointerEvents="none">
                  <line
                    x1={todayX}
                    y1={0}
                    x2={todayX}
                    y2={bodyHeight}
                    stroke="#dc2626"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                  />
                </g>
              )}

              {/* Phase 19 slice 5 — draggable date cursor. Sits in slate
                (distinct from the red Today line). Drawn last so it sits
                above bars. The HTML tooltip below the SVG carries the
                readout (activities in progress / starting / finishing
                on the cursor date). */}
              {cursor.cursorDataValue !== null &&
                (() => {
                  const cx = xOf(new Date(cursor.cursorDataValue), projectStart, DAY_WIDTH);
                  if (cx < -1 || cx > totalChartWidth + 1) return null;
                  return (
                    <g pointerEvents="none">
                      <line
                        x1={cx}
                        y1={0}
                        x2={cx}
                        y2={bodyHeight}
                        stroke="#64748b"
                        strokeWidth={cursor.isDragging ? 1.5 : 1}
                        strokeDasharray="4 3"
                      />
                      <path d={`M${cx - 5},0 L${cx + 5},0 L${cx},6 Z`} fill="#64748b" />
                    </g>
                  );
                })()}
            </svg>

            {/* Phase 19 — Cumulative cost panel. Lives below the chart in its
              own dedicated row so it doesn't share vertical space with the
              bars. Shares the x-axis (timelineWidth + DAY_WIDTH) with the
              chart above so the curve aligns with the bars. Toggled via
              the toolstrip "S-curve" button; hidden when toggle is off or
              no MC run has landed. */}
            {showSCurve && latestSim?.result && (
              <GanttCumulativeCostPanel
                project={project}
                curve={latestSim.result.costCurve}
                timelineWidth={timelineWidth}
                totalDays={totalDays}
                nonWorkingSet={nonWorkingSet}
                darkMode={darkMode}
                dayWidth={DAY_WIDTH}
                panelHeight={COST_PANEL_H}
                nonWorkingBodyFill={nonWorkingBodyFill}
                projectStart={projectStart}
                projectEnd={projectEnd}
              />
            )}

            {/* Phase 19 slice 5 — cursor tooltip for the main Gantt chart.
              Positioned absolutely within the timeline column wrapper so
              it scrolls with the chart. Shows the cursor date and counts
              of activities in progress / starting / finishing that day. */}
            {cursor.cursorDataValue !== null &&
              (() => {
                const cursorMs = cursor.cursorDataValue;
                const cursorDate = new Date(cursorMs);
                // Snap is local-midnight; "this day" is the 24h window starting here.
                const dayEnd = cursorMs + 86_400_000;
                let inProgress = 0;
                let starting = 0;
                let finishing = 0;
                for (const sched of Object.values(result.nodes)) {
                  const s = sched.earliestStart.getTime();
                  const f = sched.earliestFinish.getTime();
                  if (s >= cursorMs && s < dayEnd) starting += 1;
                  if (f > cursorMs && f <= dayEnd) finishing += 1;
                  if (s < dayEnd && f > cursorMs) inProgress += 1;
                }
                const cx = xOf(cursorDate, projectStart, DAY_WIDTH);
                const flipLeft = cx > totalChartWidth - 220;
                return (
                  <div
                    className="absolute pointer-events-none rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-gray-900 shadow-md px-2.5 py-1.5 text-[11px] max-md:text-xs leading-tight"
                    style={{
                      top: HEADER_H + 4,
                      left: flipLeft ? undefined : cx + 8,
                      right: flipLeft ? totalChartWidth - cx + 8 : undefined,
                      minWidth: 180,
                      zIndex: 3,
                    }}
                  >
                    <div className="text-gray-500 dark:text-gray-400 text-[10px] max-md:text-xs mb-0.5">
                      {cursorDate.toLocaleDateString(undefined, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </div>
                    <div className="flex justify-between gap-2 text-gray-700 dark:text-gray-200">
                      <span>In progress</span>
                      <span className="font-mono font-semibold">{inProgress}</span>
                    </div>
                    <div className="flex justify-between gap-2 text-gray-700 dark:text-gray-200">
                      <span>Starting</span>
                      <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                        {starting}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2 text-gray-700 dark:text-gray-200">
                      <span>Finishing</span>
                      <span className="font-mono font-semibold text-blue-700 dark:text-blue-400">
                        {finishing}
                      </span>
                    </div>
                  </div>
                );
              })()}
          </div>
        </div>
      </div>

      <GanttMinimap
        nodes={minimapNodes}
        result={result}
        projectStart={projectStart}
        totalDays={totalDays}
        scrollRef={scrollRef}
        dayWidth={DAY_WIDTH}
        labelWidth={labelWidth}
      />
    </div>
  );
}

/**
 * Phase 47 Slice 2 — drag handle that lets the user widen / narrow the
 * Gantt label column. Lives at the right edge of the column. On pointer
 * down we capture the pointer and the parent component's onResize fires
 * once per pointermove with the delta vs the pointer-down x.
 *
 * Width is clamped to a sensible range in viewStore's `setGanttLabelWidth`
 * (120–480 px), so we don't enforce here.
 */
function GanttLabelResizer({ onResize }: { onResize: (deltaPx: number) => void }) {
  const startXRef = useRef<number | null>(null);
  const lastDeltaRef = useRef(0);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    startXRef.current = e.clientX;
    lastDeltaRef.current = 0;
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (startXRef.current === null) return;
    const delta = e.clientX - startXRef.current;
    // Only call onResize when delta has changed — avoids tight setState
    // loops at the same x while the pointer is still.
    if (delta === lastDeltaRef.current) return;
    onResize(delta - lastDeltaRef.current);
    lastDeltaRef.current = delta;
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (startXRef.current === null) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    startXRef.current = null;
    lastDeltaRef.current = 0;
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize label column"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // 6 px wide strip centred over the column's right border. cursor-col-resize
      // gives the standard double-arrow affordance. Layered above subsequent
      // sticky content via z-30 so it stays clickable when bars scroll under.
      className="absolute right-0 top-0 bottom-0 w-1.5 -mr-[3px] cursor-col-resize z-30 hover:bg-emerald-400/30"
    />
  );
}
