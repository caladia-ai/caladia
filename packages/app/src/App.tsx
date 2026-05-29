import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  useReactFlow,
  getNodesBounds,
  getViewportForBounds,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type OnSelectionChangeFunc,
  type NodeMouseHandler,
  type EdgeMouseHandler,
} from '@xyflow/react';
// html-to-image is dynamically imported in the canvas-export callback
// below (and in lib/export.ts for the Gantt path). N-10 follow-up #2:
// lazy-loaded since PNG export is rare per session.

import type { ProjectFile, ProjectNode, Subsystem } from '@procsim/file-format';
import { deterministicIterationCount } from '@procsim/scheduler';
import { useDomainStore } from './store/domainStore.js';
import { useViewStore } from './store/viewStore.js';
import { ActivityNode } from './nodes/ActivityNode.js';
import { LoopGroupNode } from './nodes/LoopGroupNode.js';
import { StartNode } from './nodes/StartNode.js';
import { EndNode } from './nodes/EndNode.js';
import { SubsystemEntryNode } from './nodes/SubsystemEntryNode.js';
import { SubsystemExitNode } from './nodes/SubsystemExitNode.js';
import { DecisionNode } from './nodes/DecisionNode.js';
import { SubsystemNode } from './nodes/SubsystemNode.js';
import { CommentNode } from './nodes/CommentNode.js';
import { NodePanel } from './components/NodePanel.js';
import { SubsystemPanel } from './components/SubsystemPanel.js';
import { EdgePanel } from './components/EdgePanel.js';
import { LoopPanel } from './components/LoopPanel.js';
import { GanttView } from './components/GanttView.js';
import { ResourcesPanel } from './components/ResourcesPanel.js';
import { SimulateView } from './components/SimulateView.js';
import { RisksView } from './components/RisksView.js';
import { AppShell } from './components/AppShell.js';
import { FxUpdateBanner } from './components/FxUpdateBanner.js';
import { AutosaveDisabledBanner } from './components/AutosaveDisabledBanner.js';
import { SelectionToolbar } from './components/SelectionToolbar.js';
import { CanvasZoom, CanvasKeyboardShortcuts, CanvasFitOnLoad } from './components/CanvasZoom.js';
import { ResourcePalette } from './components/ResourcePalette.js';
import { MobileSelectionAutoFit } from './components/MobileSelectionAutoFit.js';
import { PlacementOverlay } from './components/PlacementOverlay.js';
import { CommentToolBinder } from './components/CommentToolBinder.js';
import { DEFAULT_NODE_W, DEFAULT_NODE_H } from './utils/placement.js';
import { NamingCallout } from './components/NamingCallout.js';
import { useIsMobile } from './hooks/useIsMobile.js';
import { useKeyboardShortcuts } from './hooks/useKeyboard.js';
import { useSchedule } from './hooks/useSchedule.js';
import {
  triggerDownload,
  downloadGanttPng,
  downloadScheduleCsv,
  ganttToPngDataUrl,
} from './lib/export.js';
import { toHtml as toEmbedHtml } from './lib/exportEmbed.js';
import { computeAutoLayout } from './lib/autolayout.js';
import { cancelActiveSim } from './lib/simRunController.js';

// ── CanvasExporter ─────────────────────────────────────────────────────────────
// Lives inside <ReactFlow> so it can call useReactFlow().
// Sets a ref to the async export function that the Toolbar can call.

interface CanvasExporterProps {
  exportTriggerRef: React.MutableRefObject<(() => Promise<void>) | null>;
  onError: (msg: string) => void;
}

function CanvasExporter({ exportTriggerRef, onError }: CanvasExporterProps) {
  const { getNodes } = useReactFlow();
  // Stable refs — keep export function current without re-running the effect.
  const getNodesRef = useRef(getNodes);
  getNodesRef.current = getNodes;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    exportTriggerRef.current = async () => {
      try {
        const nodes = getNodesRef.current();
        if (nodes.length === 0) return;

        // The React Flow viewport element has a CSS transform (translate+scale).
        // We override it so html-to-image captures the full diagram at a known
        // size instead of whatever the current pan/zoom happens to be.
        const viewportEl = document.querySelector('.react-flow__viewport') as HTMLElement | null;
        if (!viewportEl) return;

        const IMG_W = 2400;
        const IMG_H = 1600;
        const bounds = getNodesBounds(nodes);
        const vp = getViewportForBounds(bounds, IMG_W, IMG_H, 0.5, 2, 0.15);

        const { toPng } = await import('html-to-image');
        const dataUrl = await toPng(viewportEl, {
          cacheBust: true,
          pixelRatio: 2,
          width: IMG_W,
          height: IMG_H,
          style: {
            width: `${IMG_W}px`,
            height: `${IMG_H}px`,
            transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`,
          },
        });

        const res = await fetch(dataUrl);
        const blob = await res.blob();
        triggerDownload(blob, 'canvas.png');
      } catch (e) {
        onErrorRef.current(`Canvas export failed: ${String(e)}`);
      }
    };

    return () => {
      exportTriggerRef.current = null;
    };
  }, [exportTriggerRef]);

  return null;
}

// ── CanvasPanner ───────────────────────────────────────────────────────────────
// Lives inside <ReactFlow> so it can call useReactFlow().
// Implements middle-mouse pan by registering a capture-phase pointerdown
// listener on the pane element. Running in the capture phase means our handler
// fires BEFORE React Flow's bubble-phase handlers. Viewport is updated via
// setViewport() during pointermove; pointer capture keeps events coming even
// when the cursor leaves the pane.

interface CanvasPannerProps {
  onPanActiveChange: (active: boolean) => void;
}

function CanvasPanner({ onPanActiveChange }: CanvasPannerProps) {
  const { getViewport, setViewport } = useReactFlow();
  // Stable refs — the effect runs once; handlers always read the latest values.
  const getViewportRef = useRef(getViewport);
  getViewportRef.current = getViewport;
  const setViewportRef = useRef(setViewport);
  setViewportRef.current = setViewport;
  const onPanActiveChangeRef = useRef(onPanActiveChange);
  onPanActiveChangeRef.current = onPanActiveChange;

  useEffect(() => {
    const paneOrNull = document.querySelector('.react-flow__pane');
    if (!paneOrNull) return;
    // Reassign to a non-nullable const so TypeScript can see through closures.
    const pane: HTMLElement = paneOrNull as HTMLElement;

    type PanState = {
      pointerId: number;
      startX: number;
      startY: number;
      vpX: number;
      vpY: number;
      zoom: number;
    };
    let panState: PanState | null = null;

    function onPointerDown(e: PointerEvent) {
      if (e.button !== 1) return; // middle mouse only

      e.preventDefault(); // block browser middle-click autoscroll
      e.stopPropagation(); // prevent RF from starting anything
      const vp = getViewportRef.current();
      panState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        vpX: vp.x,
        vpY: vp.y,
        zoom: vp.zoom,
      };
      try {
        pane.setPointerCapture(e.pointerId);
      } catch {
        /* already captured */
      }
      onPanActiveChangeRef.current(true);
    }

    function onPointerMove(e: PointerEvent) {
      if (!panState || e.pointerId !== panState.pointerId) return;
      const dx = e.clientX - panState.startX;
      const dy = e.clientY - panState.startY;
      setViewportRef.current({ x: panState.vpX + dx, y: panState.vpY + dy, zoom: panState.zoom });
    }

    function endPan(e: PointerEvent) {
      if (!panState || e.pointerId !== panState.pointerId) return;
      try {
        pane.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      panState = null;
      onPanActiveChangeRef.current(false);
    }

    // Capture phase = runs before RF's bubble-phase handlers on the same element.
    pane.addEventListener('pointerdown', onPointerDown, { capture: true });
    pane.addEventListener('pointermove', onPointerMove);
    pane.addEventListener('pointerup', endPan);
    pane.addEventListener('pointercancel', endPan);

    return () => {
      pane.removeEventListener('pointerdown', onPointerDown, { capture: true });
      pane.removeEventListener('pointermove', onPointerMove);
      pane.removeEventListener('pointerup', endPan);
      pane.removeEventListener('pointercancel', endPan);
    };
  }, []); // empty deps — all mutable state accessed through stable refs

  return null;
}

const nodeTypes = {
  activity: ActivityNode,
  loopGroup: LoopGroupNode,
  start: StartNode,
  end: EndNode,
  decision: DecisionNode,
  subsystem: SubsystemNode,
  // Phase 50 Slice 3.5b — structural subsystem ports auto-injected by
  // wrap / V6→V7 migration. Rendered as small green / red wedges so
  // they read as "ports" rather than full activities.
  subsystemEntry: SubsystemEntryNode,
  subsystemExit: SubsystemExitNode,
  comment: CommentNode,
};

const LOOP_PADDING = 28;
// Phase 24 — stable empty conflicts map so the rfNodes useMemo doesn't
// re-allocate on every render when there are no conflicts.
const EMPTY_CONFLICTS: Record<string, unknown> = {};

/**
 * Phase 45 Slice 4 — per-node builder for the ReactFlow nodes array.
 * Module-level so we can type the cache by `ReturnType<typeof buildRfNode>`.
 *
 * Reads only its arguments; closure-free so a stable identity is trivial.
 * Keep the build branches byte-equivalent to the prior inline `.map(...)`
 * body — this extraction is mechanical, not a behavioural change.
 */
function buildRfNode(
  n: ProjectNode,
  draft: { x: number; y: number } | undefined,
  rdraft: { width: number; height: number } | undefined,
  selected: boolean,
  hasConflict: boolean,
  sub: Subsystem | undefined,
) {
  // Phase 12 — Sub-system container nodes rendered as SubsystemNode.
  if (n.nodeType === 'subsystem') {
    return {
      id: n.id,
      type: 'subsystem' as const,
      position: draft ?? n.position,
      selected,
      // During resize, apply the in-flight draft dimensions so the node
      // visually grows/shrinks in real-time instead of snapping at end.
      ...(rdraft
        ? { width: rdraft.width, height: rdraft.height }
        : n.width !== undefined && n.height !== undefined
          ? { width: n.width, height: n.height }
          : {}),
      data: {
        name: n.name,
        subsystemId: sub?.id ?? '',
        hasConflict,
        description: n.description,
      },
    };
  }
  // Start/End anchors have a minimal data payload — just `name`.
  // Width/height overrides are also activity-only (anchors are atomic).
  if (n.nodeType === 'start' || n.nodeType === 'end') {
    return {
      id: n.id,
      type: n.nodeType as 'start' | 'end',
      position: draft ?? n.position,
      selected,
      data: { name: n.name, group: n.group },
    };
  }
  // Phase 50 Slice 3.5b — structural subsystem ports. Tiny data payload
  // (just the label) and no group affordance; rendered as wedge-shaped
  // ports distinct from project-level Start / End anchors.
  if (n.nodeType === 'subsystemEntry' || n.nodeType === 'subsystemExit') {
    return {
      id: n.id,
      type: n.nodeType as 'subsystemEntry' | 'subsystemExit',
      position: draft ?? n.position,
      selected,
      data: { name: n.name },
    };
  }
  // Phase 11 — decision nodes share most of activity's data shape
  // (duration, resizing) but add the gate-specific fields and use a
  // diamond-shaped renderer.
  if (n.nodeType === 'decision') {
    return {
      id: n.id,
      type: 'decision' as const,
      position: draft ?? n.position,
      selected,
      ...(n.width !== undefined && n.height !== undefined
        ? { width: n.width, height: n.height }
        : {}),
      data: {
        name: n.name,
        durationValue: n.duration.value,
        durationUnit: n.duration.unit,
        passProbability: n.passProbability ?? 1,
        failureDelayValue: n.failureDelay?.value ?? 0,
        failureDelayUnit: n.failureDelay?.unit ?? 'hours',
        group: n.group,
        hasConflict,
        description: n.description,
      },
    };
  }
  return {
    id: n.id,
    type: 'activity' as const,
    position: draft ?? n.position,
    selected,
    ...(n.width !== undefined && n.height !== undefined
      ? { width: n.width, height: n.height }
      : {}),
    data: {
      name: n.name,
      durationValue: n.duration.value,
      durationUnit: n.duration.unit,
      color: n.color,
      group: n.group,
      hasConflict,
      description: n.description,
    },
  };
}

type RfNodeOutput = ReturnType<typeof buildRfNode>;

/**
 * Phase 45 Slice 4 — cache entry. Stores the per-node inputs that fed
 * the build, plus the resulting object. On subsequent renders, if all
 * inputs are reference-equal, the cached output is reused — preserving
 * the object identity that React Flow's `adoptUserNodes` checks via
 * `userNode === internals.userNode` to skip resetting `handleBounds`.
 */
interface RfNodeCacheEntry {
  readonly n: ProjectNode;
  readonly draft: { x: number; y: number } | undefined;
  readonly rdraft: { width: number; height: number } | undefined;
  readonly selected: boolean;
  readonly hasConflict: boolean;
  readonly sub: Subsystem | undefined;
  readonly output: RfNodeOutput;
}

export function App() {
  useKeyboardShortcuts();

  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const project = useDomainStore((s) => s.project);
  const updateNodePosition = useDomainStore((s) => s.updateNodePosition);
  const updateNodePositions = useDomainStore((s) => s.updateNodePositions);
  const moveComment = useDomainStore((s) => s.moveComment);
  const deleteComment = useDomainStore((s) => s.deleteComment);
  const connectNodes = useDomainStore((s) => s.connectNodes);
  const setProject = useDomainStore((s) => s.setProject);
  const requestFitView = useViewStore((s) => s.requestFitView);
  const deleteNodes = useDomainStore((s) => s.deleteNodes);
  const deleteEdges = useDomainStore((s) => s.deleteEdges);

  // Canvas export trigger ref — set by CanvasExporter inside <ReactFlow>
  const canvasExportTriggerRef = useRef<(() => Promise<void>) | null>(null);
  // Gantt container ref — used by html-to-image for Gantt PNG export
  const ganttContainerRef = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement>;

  const selection = useViewStore((s) => s.selection);
  const selectedLoopId = useViewStore((s) => s.selectedLoopId);
  const dragDraft = useViewStore((s) => s.dragDraft);
  const resizeDraft = useViewStore((s) => s.resizeDraft);
  const activeTab = useViewStore((s) => s.activeTab);
  const snapToGridEnabled = useViewStore((s) => s.snapToGridEnabled);
  const setSelectedNodeIds = useViewStore((s) => s.setSelectedNodeIds);
  const selectEdge = useViewStore((s) => s.selectEdge);
  const selectLoop = useViewStore((s) => s.selectLoop);
  const clearSelection = useViewStore((s) => s.clearSelection);
  const clearSimulationResults = useViewStore((s) => s.clearSimulationResults);
  const setDragDraft = useViewStore((s) => s.setDragDraft);
  const clearDragDraft = useViewStore((s) => s.clearDragDraft);
  const setActiveTab = useViewStore((s) => s.setActiveTab) as (
    tab: 'canvas' | 'gantt' | 'resources' | 'simulate' | 'risks',
  ) => void;

  // Phase 12 — breadcrumb / drill-in
  const breadcrumb = useViewStore((s) => s.breadcrumb);
  const drillOutTo = useViewStore((s) => s.drillOutTo);
  const inspectorHidden = useViewStore((s) => s.inspectorHidden);
  const revealInspector = useViewStore((s) => s.revealInspector);
  const drillIntoSubsystem = useViewStore((s) => s.drillIntoSubsystem);
  const currentSubsystemId = breadcrumb.at(-1)?.subsystemId ?? null;

  // Auto-pop breadcrumb when the drilled-into subsystem is removed (e.g., undo).
  useEffect(() => {
    if (!currentSubsystemId) return;
    if (!project.subsystems.some((s) => s.id === currentSubsystemId)) {
      drillOutTo(-1);
    }
  }, [project.subsystems, currentSubsystemId, drillOutTo]);

  const scheduleOutcome = useSchedule();

  // Mobile Slice 3 — drive React Flow's gesture model from viewport
  // size. Mobile (< 768 px) gets one-finger-drag-pan + tap-to-select;
  // desktop keeps the rubber-band-on-drag model. Pinch-zoom works
  // either way via RF's `zoomOnPinch` default.
  const isMobile = useIsMobile();

  // ── Canvas cursor / pan mode ──────────────────────────────────────────────
  // isActivePanning: CanvasPanner has pointer capture — show grabbing cursor.
  // Actual pan logic lives in <CanvasPanner> (inside ReactFlow context) which
  // intercepts middle-mouse pointer events and calls setViewport directly.
  const [isActivePanning, setIsActivePanning] = useState(false);

  // Two CSS classes drive cursor state on the canvas wrapper:
  //   rf-select-mode → arrow (default)
  //   rf-panning     → grabbing (pointer captured, actively panning)
  const canvasClass = isActivePanning ? 'rf-panning' : 'rf-select-mode';

  const selectedNodeSet = useMemo(() => new Set(selection.nodeIds), [selection.nodeIds]);

  // Phase 12 — Compute which node IDs are visible at the current drill level.
  //   Root level: show nodes NOT inside any sub-system body.
  //   Drilled-in: show only the current sub-system's body nodes.
  const allBodyNodeIds = useMemo(() => {
    const s = new Set<string>();
    for (const sub of project.subsystems) {
      for (const nid of sub.bodyNodeIds) s.add(nid);
    }
    return s;
  }, [project.subsystems]);

  const visibleNodeIds = useMemo(() => {
    if (!currentSubsystemId) {
      return new Set(project.nodes.filter((n) => !allBodyNodeIds.has(n.id)).map((n) => n.id));
    }
    const sub = project.subsystems.find((s) => s.id === currentSubsystemId);
    return new Set(sub?.bodyNodeIds ?? []);
  }, [currentSubsystemId, allBodyNodeIds, project.nodes, project.subsystems]);

  // Sub-system metadata lookup (containerNodeId → subsystem).
  const containerToSubsystem = useMemo(
    () => new Map(project.subsystems.map((s) => [s.containerNodeId, s])),
    [project.subsystems],
  );

  // Phase 24 — pull the conflicted-node map from the schedule so each
  // node's `data` can carry a `hasConflict` flag. Falls back to an empty
  // object if the schedule itself errored (the empty layout already
  // covers that case).
  const conflictedNodeIds = scheduleOutcome.ok
    ? scheduleOutcome.result.conflictedNodeIds
    : EMPTY_CONFLICTS;

  // Phase 45 Slice 4 — per-node cache. Lets us return the SAME object
  // reference for any node whose inputs (`n`, drag/resize drafts, selected,
  // hasConflict, subsystem entry) haven't changed since the last render.
  //
  // Why this matters: React Flow's `adoptUserNodes` (system pkg) uses
  // strict `userNode === internals.userNode` to decide whether to keep an
  // existing internal node (with measured `handleBounds`) or re-build it
  // from scratch and reset handleBounds to undefined. When we returned
  // fresh literals for every node on every selection change, ALL nodes
  // got their handleBounds reset every tick of the marquee drag — and
  // RF's `getNodesInside` flags any node with no handleBounds as
  // `forceInitialRender: true`, i.e. "inside the marquee," causing the
  // brief all-selected flash the user reported.
  //
  // Stable refs for unchanged nodes localise that reset to the few nodes
  // whose selected state actually flipped. Marquee intersection stays
  // accurate for the rest.
  const rfNodeCacheRef = useRef(new Map<string, RfNodeCacheEntry>());

  // Derive React Flow nodes from the domain store, layering drag drafts
  // (in-progress positions live in the view store, outside undo history).
  const rfNodes = useMemo(() => {
    const cache = rfNodeCacheRef.current;
    const nextCache = new Map<string, RfNodeCacheEntry>();
    const result = project.nodes
      .filter((n) => visibleNodeIds.has(n.id))
      .map((n): RfNodeOutput => {
        const draft = dragDraft[n.id];
        const rdraft = resizeDraft[n.id];
        const selected = selectedNodeSet.has(n.id);
        const hasConflict = conflictedNodeIds[n.id] !== undefined;
        const sub = n.nodeType === 'subsystem' ? containerToSubsystem.get(n.id) : undefined;

        const prev = cache.get(n.id);
        if (
          prev &&
          prev.n === n &&
          prev.draft === draft &&
          prev.rdraft === rdraft &&
          prev.selected === selected &&
          prev.hasConflict === hasConflict &&
          prev.sub === sub
        ) {
          nextCache.set(n.id, prev);
          return prev.output;
        }
        const output = buildRfNode(n, draft, rdraft, selected, hasConflict, sub);
        nextCache.set(n.id, { n, draft, rdraft, selected, hasConflict, sub, output });
        return output;
      });
    rfNodeCacheRef.current = nextCache;
    return result;
  }, [
    project.nodes,
    dragDraft,
    resizeDraft,
    selectedNodeSet,
    visibleNodeIds,
    containerToSubsystem,
    conflictedNodeIds,
  ]);

  const rfEdges = useMemo(
    () =>
      project.edges
        .filter((e) => visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to))
        .map((e) => ({
          id: e.id,
          source: e.from,
          target: e.to,
          selected: selection.edgeId === e.id,
          ...(e.type !== 'FS' || e.lag.value !== 0
            ? { label: edgeLabel(e.type, e.lag.value, e.lag.unit) }
            : {}),
        })),
    [project.edges, selection.edgeId, visibleNodeIds],
  );

  // Loop group background nodes — one per loop, sized to the bounding box of
  // body nodes, rendered behind activity nodes via zIndex: -1.
  // Only shown when all body nodes are visible at the current drill level.
  // Phase 49 Slice 3 — free-floating canvas comments. Mapped to RF nodes
  // alongside project nodes; the `__comment__` id prefix lets onNodesChange
  // route position/remove events to moveComment/deleteComment instead of
  // the project-node actions. `data.commentId` carries the raw store id
  // so CommentNode can update / delete without parsing the prefix.
  // Phase 50 Slice 10 / audit C-16 — id of the just-placed comment; used
  // to gate the auto-edit-on-mount behavior to ONLY freshly-placed
  // comments. Without this, every empty-text comment (including stale
  // ones from a previous session) auto-focused and stole keystrokes.
  const pendingInitialEditingCommentId = useViewStore((s) => s.pendingInitialEditingCommentId);
  const rfCommentNodes = useMemo(
    () =>
      project.comments.map((c) => {
        const draftKey = `__comment__${c.id}`;
        const pos = dragDraft[draftKey] ?? { x: c.x, y: c.y };
        return {
          id: draftKey,
          type: 'comment' as const,
          position: pos,
          data: {
            text: c.text,
            commentId: c.id,
            initialEditing: c.id === pendingInitialEditingCommentId,
          },
        };
      }),
    [project.comments, dragDraft, pendingInitialEditingCommentId],
  );

  const rfLoopGroupNodes = useMemo(() => {
    const nodeMap = new Map(project.nodes.map((n) => [n.id, n]));
    return project.loops
      .filter((loop) => loop.bodyNodeIds.every((id) => visibleNodeIds.has(id)))
      .map((loop) => {
        const bodyNodes = loop.bodyNodeIds
          .map((id) => nodeMap.get(id))
          .filter((n): n is ProjectNode => n !== undefined);
        if (bodyNodes.length === 0) return null;

        const minX = Math.min(...bodyNodes.map((n) => (dragDraft[n.id] ?? n.position).x));
        const minY = Math.min(...bodyNodes.map((n) => (dragDraft[n.id] ?? n.position).y));
        const maxX = Math.max(
          ...bodyNodes.map((n) => (dragDraft[n.id] ?? n.position).x + (n.width ?? DEFAULT_NODE_W)),
        );
        const maxY = Math.max(
          ...bodyNodes.map((n) => (dragDraft[n.id] ?? n.position).y + (n.height ?? DEFAULT_NODE_H)),
        );

        return {
          id: `__loopgroup__${loop.id}`,
          type: 'loopGroup' as const,
          position: { x: minX - LOOP_PADDING, y: minY - LOOP_PADDING },
          width: maxX - minX + LOOP_PADDING * 2,
          height: maxY - minY + LOOP_PADDING * 2,
          zIndex: -1,
          draggable: false,
          selectable: true,
          selected: selectedLoopId === loop.id,
          data: {
            loopId: loop.id,
            iterationCount: deterministicIterationCount(loop),
          },
        };
      })
      .filter((n): n is NonNullable<typeof n> => n !== null);
  }, [project.loops, project.nodes, dragDraft, selectedLoopId, visibleNodeIds]);

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          // Phase 49 Slice 3 — comments are RF nodes prefixed with
          // `__comment__`; route their position commits to moveComment
          // instead of updateNodePosition (which expects project.nodes
          // membership). Mid-drag frames go through dragDraft (keyed by
          // the prefixed RF id) so rfCommentNodes can render live
          // position without flooding undo history; the drag-end commit
          // is the single moveComment call = one undo step.
          if (change.id.startsWith('__comment__')) {
            if (change.dragging) {
              setDragDraft(change.id, change.position);
            } else {
              moveComment(change.id.slice('__comment__'.length), change.position);
              clearDragDraft(change.id);
            }
            continue;
          }
          if (change.dragging) {
            // In-flight drag: write to draft (view store, not tracked).
            setDragDraft(change.id, change.position);
          } else {
            // Drag-end: single domain commit = one undo step.
            updateNodePosition(change.id, change.position);
            clearDragDraft(change.id);
          }
        } else if (change.type === 'select') {
          // Handled via onNodeClick / onPaneClick for single-node semantics;
          // ignore React Flow's native select events to keep selection in the
          // view store as the single source of truth.
        } else if (change.type === 'remove') {
          if (change.id.startsWith('__comment__')) {
            deleteComment(change.id.slice('__comment__'.length));
          } else {
            deleteNodes([change.id]);
          }
        }
        // `dimensions` and other event types are intentionally ignored.
      }
    },
    [setDragDraft, clearDragDraft, updateNodePosition, deleteNodes, moveComment, deleteComment],
  );

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      for (const change of changes) {
        if (change.type === 'remove') deleteEdges([change.id]);
      }
    },
    [deleteEdges],
  );

  const onConnect: OnConnect = useCallback(
    (conn) => {
      if (conn.source && conn.target) connectNodes(conn.source, conn.target);
    },
    [connectNodes],
  );

  // Sync React Flow's rubber-band (and click) selection to the view store.
  // Using setSelectedNodeIds (not selectNodes) so that a nodes-only change
  // doesn't wipe out an independently set edgeId.
  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selNodes }) => {
      const ids = selNodes
        .filter((n) => !n.id.startsWith('__loopgroup__') && !n.id.startsWith('__comment__'))
        .map((n) => n.id);
      setSelectedNodeIds(ids);
      // Phase 50 Slice 10 / audit C-16 — also track comment selection so
      // the keyboard Delete handler can reach them. Comments stay OUT of
      // `nodeIds` (no Inspector, no node-specific UI), but the bare ids
      // ride on the `selectedCommentIds` field.
      const commentIds = selNodes
        .filter((n) => n.id.startsWith('__comment__'))
        .map((n) => n.id.slice('__comment__'.length));
      useViewStore.getState().setSelectedCommentIds(commentIds);
    },
    [setSelectedNodeIds],
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (e, node) => {
      // Loop group background nodes route to loop selection.
      if (node.id.startsWith('__loopgroup__')) {
        const loopId = node.id.slice('__loopgroup__'.length);
        selectLoop(loopId);
        return;
      }
      // Phase 49 Slice 3 — comment nodes don't participate in the
      // viewStore selection model (no Inspector panel for them); the
      // CommentNode handles its own edit / delete affordances inline.
      if (node.id.startsWith('__comment__')) return;
      // Phase 45 Slice 3 — explicit single-click selection. Earlier
      // versions relied on React Flow's onSelectionChange to sync the
      // view store, but with `selectionOnDrag={true}` a single click is
      // sometimes interpreted as a tiny marquee drag and the select
      // event never fires — the user would have to click again to
      // actually select. Setting the view store directly here makes
      // single-click selection deterministic.
      //
      // Multi-select modifier (Cmd / Shift / Ctrl) adds to selection;
      // no modifier replaces. Matches `multiSelectionKeyCode` on the
      // ReactFlow prop above.
      const current = useViewStore.getState().selection.nodeIds;
      if (e.metaKey || e.shiftKey || e.ctrlKey) {
        if (current.includes(node.id)) return; // already in selection, no-op
        setSelectedNodeIds([...current, node.id]);
      } else {
        setSelectedNodeIds([node.id]);
      }
    },
    [selectLoop, setSelectedNodeIds],
  );

  // Double-clicking a node:
  //   - For subsystems: drills into it (existing behaviour).
  //   - For all node types: reveals the Inspector if it's currently
  //     hidden. This is the discoverability fallback for the header
  //     toggle — users who hid the panel can re-reveal it without
  //     hunting for the small chrome button.
  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (_e, node) => {
      revealInspector();
      if (node.type !== 'subsystem') return;
      const sub = project.subsystems.find((s) => s.containerNodeId === node.id);
      if (sub) drillIntoSubsystem(sub.id, node.data.name as string);
    },
    [project.subsystems, drillIntoSubsystem, revealInspector],
  );

  const onEdgeClick: EdgeMouseHandler = useCallback(
    (_e, edge) => {
      selectEdge(edge.id);
    },
    [selectEdge],
  );

  function handleProjectLoad(p: ProjectFile) {
    setProject(p);
    clearSelection();
    // Abort any in-flight sim before wiping results — without this, a
    // worker still computing the previous project's input would land its
    // completion in simHistory with a snapshot mismatch (the existing
    // isStale banner would warn, but the result would still appear
    // briefly). `cancelActiveSim` aborts the AbortController; the run's
    // existing `.finally()` clears simRunning / simProgress /
    // simWarmupMessage when the worker rejects with AbortError.
    cancelActiveSim();
    // Wipe the previous project's sim run history + error + last-run-ms
    // so the Simulate tab doesn't display a "Latest" pill that belongs to
    // a file the user already moved on from.
    clearSimulationResults();
    // Phase 45 Slice 1 — fit the camera to the freshly-loaded diagram.
    // Without this, the canvas keeps the prior project's viewport, which
    // for a template load looks like "zoomed-in to the corner" if the
    // new diagram doesn't overlap the old extents. The CanvasFitOnLoad
    // watcher waits one render so the new nodes are committed before
    // calling fitView.
    requestFitView();
  }

  // ── Export handlers ───────────────────────────────────────────────────────

  const handleExportCanvasPng = useCallback(() => {
    void canvasExportTriggerRef.current?.();
  }, []);

  const handleExportGanttPng = useCallback(() => {
    if (ganttContainerRef.current) {
      void downloadGanttPng(ganttContainerRef.current).catch((e) =>
        setErrorMsg(`Gantt export failed: ${String(e)}`),
      );
    }
  }, []);

  const handleExportScheduleCsv = useCallback(() => {
    if (scheduleOutcome.ok) {
      downloadScheduleCsv(project, scheduleOutcome.result);
    }
  }, [project, scheduleOutcome]);

  // ── Phase 34 — "Share" — self-contained HTML snapshot of the plan ──────────
  //
  // The Gantt's DOM is the source for the embedded PNG. When the user clicks
  // Share from a non-Gantt tab, switch to Gantt first and wait two animation
  // frames so React Flow paints before we capture. The activeTab is preserved
  // — we read its pre-click value via a ref so we can restore it after.
  const handleShare = useCallback(() => {
    if (!scheduleOutcome.ok) return;
    const result = scheduleOutcome.result;
    const tabBeforeShare = activeTab;

    void (async () => {
      try {
        if (tabBeforeShare !== 'gantt') {
          setActiveTab('gantt');
          // Two rAFs: first to flush React's commit, second to let React Flow
          // measure / paint the Gantt SVG before html-to-image samples the DOM.
          await new Promise<void>((res) => requestAnimationFrame(() => res()));
          await new Promise<void>((res) => requestAnimationFrame(() => res()));
        }
        const el = ganttContainerRef.current;
        if (!el) {
          setErrorMsg('Share failed: Gantt container not ready');
          return;
        }
        const pngDataUrl = await ganttToPngDataUrl(el, {
          fullContent: true,
          pixelRatio: 2,
        });
        const simRun = useViewStore.getState().simHistory[0] ?? null;
        const html = toEmbedHtml({
          project,
          scheduleResult: result,
          simRun,
          ganttPngDataUrl: pngDataUrl,
        });
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const slug =
          project.project.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || 'plan';
        triggerDownload(blob, `${slug}.html`);
      } catch (e) {
        setErrorMsg(`Share failed: ${String(e)}`);
      } finally {
        if (tabBeforeShare !== 'gantt') {
          setActiveTab(tabBeforeShare);
        }
      }
    })();
  }, [project, scheduleOutcome, activeTab, setActiveTab]);

  // ── Auto-layout ───────────────────────────────────────────────────────────

  const handleAutoLayout = useCallback(() => {
    const positions = computeAutoLayout(project.nodes, project.edges, project.loops);
    updateNodePositions(positions);
  }, [project.nodes, project.edges, project.loops, updateNodePositions]);

  const firstSelectedNodeId = selection.nodeIds[0] ?? null;
  const showNodePanel = selection.nodeIds.length === 1 && firstSelectedNodeId;
  const selectedNodeIsSubsystem = firstSelectedNodeId
    ? project.nodes.find((n) => n.id === firstSelectedNodeId)?.nodeType === 'subsystem'
    : false;
  const showEdgePanel = selection.edgeId !== null;
  const showLoopPanel = selectedLoopId !== null;

  // Phase 10 Tier 1: multi-root advisory.
  // A "chain root" is any non-anchor node with no incoming edges. With two or
  // more chain roots, the diagram has independent entry points — usually a
  // signal the user forgot to wire one chain into the rest. Hint at using a
  // Start anchor as the single entry point. Non-blocking; the schedule still
  // runs.
  //
  // Phase 12 — subsystem body nodes are reached via their container, not via
  // a top-level edge, so they always look like chain roots to this heuristic.
  // Exclude them; otherwise templates with 2+ subsystems (e.g. construction-
  // project's four phase containers) trigger a false positive on load.
  const multiRootWarning = useMemo(() => {
    const targets = new Set(project.edges.map((e) => e.to));
    const subsystemBodyIds = new Set<string>();
    for (const sub of project.subsystems) {
      for (const id of sub.bodyNodeIds) subsystemBodyIds.add(id);
    }
    const chainRoots = project.nodes.filter(
      (n) =>
        n.nodeType !== 'start' &&
        n.nodeType !== 'end' &&
        !targets.has(n.id) &&
        !subsystemBodyIds.has(n.id),
    );
    return chainRoots.length >= 2;
  }, [project.nodes, project.edges, project.subsystems]);

  return (
    <AppShell
      project={project}
      activeTab={activeTab}
      onTabChange={(tab) => setActiveTab(tab)}
      onError={setErrorMsg}
      onProjectLoad={handleProjectLoad}
      onExportCanvasPng={handleExportCanvasPng}
      {...(scheduleOutcome.ok ? { onExportGanttPng: handleExportGanttPng } : {})}
      {...(scheduleOutcome.ok ? { onExportScheduleCsv: handleExportScheduleCsv } : {})}
      {...(scheduleOutcome.ok ? { onShare: handleShare } : {})}
      onAutoLayout={handleAutoLayout}
    >
      {errorMsg && (
        <div className="flex items-start gap-2 bg-red-50 dark:bg-red-950/40 border-b border-red-200 dark:border-red-900 px-4 py-2 text-sm text-red-700 dark:text-red-400">
          <span className="flex-1">{errorMsg}</span>
          <button
            onClick={() => setErrorMsg(null)}
            className="shrink-0 font-medium hover:text-red-900"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      {/* Phase 19 slice 4 — FX update banner. Self-gates on the project's
          pinned snapshot version; renders nothing when the project is on
          the latest snapshot, pinned to 'NONE', or pinned to an unknown
          forward version. */}
      <FxUpdateBanner project={project} />
      {/* Phase 50 Slice 9 / audit C-9 — surfaces when an autosave write
          fails (QuotaExceeded, Safari private-mode block, etc.). Clears
          on the next successful write. */}
      <AutosaveDisabledBanner />

      {/* Schedule error banner */}
      {!scheduleOutcome.ok && (
        <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900 px-4 py-2 text-sm text-amber-800 dark:text-amber-400">
          <span className="flex-1">
            Schedule error: {scheduleOutcome.errors.map((e) => e.message).join('; ')}
          </span>
        </div>
      )}

      {/* Multi-root advisory (Phase 10 Tier 1) — non-blocking */}
      {multiRootWarning && (
        <div className="flex items-start gap-2 bg-sky-50 dark:bg-sky-950/40 border-b border-sky-200 dark:border-sky-900 px-4 py-2 text-sm text-sky-800 dark:text-sky-300">
          <span className="flex-1">
            Multiple chains detected. Consider connecting all chains to a Start node.
          </span>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {activeTab === 'canvas' ? (
          /* Phase 12 — canvas tab needs flex-col so the breadcrumb sits above
             the canvas+panels row without overlapping the toolbar. */
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Drill-in breadcrumb bar — in normal flow, not absolute */}
            {breadcrumb.length > 0 && (
              <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 bg-emerald-50 dark:bg-emerald-950/60 border-b border-emerald-200 dark:border-emerald-800 text-xs text-emerald-700 dark:text-emerald-300">
                <button
                  className="hover:text-emerald-900 dark:hover:text-white transition-colors font-medium"
                  onClick={() => drillOutTo(-1)}
                >
                  Root
                </button>
                {breadcrumb.map((entry, i) => (
                  <React.Fragment key={entry.subsystemId}>
                    <span className="text-emerald-400 dark:text-emerald-600">/</span>
                    <button
                      className={[
                        'transition-colors',
                        i === breadcrumb.length - 1
                          ? 'font-semibold text-emerald-900 dark:text-emerald-100'
                          : 'hover:text-emerald-900 dark:hover:text-white',
                      ].join(' ')}
                      onClick={() => drillOutTo(i)}
                    >
                      {entry.label}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            )}

            {/* Canvas + side panels in a flex-row */}
            <div className="flex-1 flex overflow-hidden">
              <div className={`flex-1 ${canvasClass}`}>
                <ReactFlow
                  nodes={[...rfLoopGroupNodes, ...rfNodes, ...rfCommentNodes]}
                  edges={rfEdges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onNodeClick={onNodeClick}
                  onNodeDoubleClick={onNodeDoubleClick}
                  onEdgeClick={onEdgeClick}
                  onPaneClick={clearSelection}
                  onSelectionChange={onSelectionChange}
                  deleteKeyCode={null}
                  multiSelectionKeyCode={['Meta', 'Shift', 'Control']}
                  fitView
                  // ── Interaction mode ──────────────────────────────────────
                  // Desktop: canvas drag = rubber-band selection. Shift+drag
                  // and middle-mouse pan are handled by <CanvasPanner> which
                  // intercepts pointer events before RF sees them.
                  // Mobile Slice 3: one-finger drag pans instead, since
                  // rubber-banding with a thumb is awkward and there's no
                  // middle-mouse / spacebar to fall back on. Pinch-zoom is
                  // already on via RF's `zoomOnPinch` default.
                  selectionOnDrag={!isMobile}
                  panOnDrag={isMobile}
                  // `paneClickDistance` and `nodeDragThreshold` get a small
                  // bump on mobile so a tap with slight finger wobble still
                  // registers as a click on the pane / a select on a node,
                  // instead of starting a pan or a node drag immediately.
                  paneClickDistance={isMobile ? 8 : 1}
                  nodeDragThreshold={isMobile ? 5 : 0}
                  // ── Connection handles ────────────────────────────────────
                  // Increase snap radius so connections snap to handles from
                  // further away; makes wiring large diagrams less fiddly.
                  connectionRadius={50}
                  // ── Phase 49 Slice 8 — snap-to-grid ───────────────────────
                  // RF handles drag-end snapping when `snapToGrid` is true,
                  // and `rf.screenToFlowPosition()` snaps too — which means
                  // placement-mode drops snap for free without any extra
                  // code in PlacementOverlay. The 16 px pitch matches the
                  // canvas `<Background gap={16} />` below so the snap
                  // targets line up with what the user sees.
                  snapToGrid={snapToGridEnabled}
                  snapGrid={[16, 16]}
                >
                  <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#d1d5db" />
                  {/* SelectionToolbar / CanvasZoom / CanvasExporter / CanvasPanner all
                     need to live inside ReactFlow for useReactFlow() / NodeToolbar context. */}
                  <SelectionToolbar />
                  {/* Phase 43 — resource palette band; self-gates on
                      viewStore.resourcePaletteOpen, toggled from the left
                      rail. Sits inside <ReactFlow> so it floats over the
                      canvas surface as a translucent overlay instead of
                      eating its own vertical zone. */}
                  <ResourcePalette />
                  <CanvasZoom />
                  <CanvasKeyboardShortcuts />
                  <CanvasFitOnLoad />
                  <MobileSelectionAutoFit />
                  <PlacementOverlay />
                  <CommentToolBinder />
                  <NamingCallout />
                  <CanvasExporter exportTriggerRef={canvasExportTriggerRef} onError={setErrorMsg} />
                  <CanvasPanner onPanActiveChange={setIsActivePanning} />
                </ReactFlow>
              </div>
            </div>
          </div>
        ) : activeTab === 'gantt' ? (
          scheduleOutcome.ok ? (
            <GanttView
              project={project}
              result={scheduleOutcome.result}
              containerRef={ganttContainerRef}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-amber-600 dark:text-amber-400 text-sm">
              Fix the schedule error above to view the Gantt chart.
            </div>
          )
        ) : activeTab === 'simulate' ? (
          <SimulateView project={project} />
        ) : activeTab === 'risks' ? (
          <RisksView project={project} />
        ) : (
          <ResourcesPanel
            project={project}
            result={scheduleOutcome.ok ? scheduleOutcome.result : null}
          />
        )}

        {/* Phase 22 — Global Inspector dock. Renders as a flex sibling of
            the active-tab content so the panel follows the selection
            regardless of which tab is active. The hide-toggle in the header
            short-circuits the entire block. Multi-node selection
            intentionally renders nothing here — the inline SelectionToolbar
            already surfaces Wrap-as-Loop / Wrap-as-Sub-system, and bulk
            delete is reachable via Delete / Backspace. */}
        {!inspectorHidden &&
          (showNodePanel && selectedNodeIsSubsystem ? (
            <SubsystemPanel nodeId={firstSelectedNodeId} onClose={clearSelection} />
          ) : showNodePanel ? (
            <NodePanel nodeId={firstSelectedNodeId} onClose={clearSelection} />
          ) : showEdgePanel && selection.edgeId ? (
            <EdgePanel edgeId={selection.edgeId} onClose={clearSelection} />
          ) : showLoopPanel && selectedLoopId ? (
            <LoopPanel loopId={selectedLoopId} onClose={clearSelection} />
          ) : null)}
      </div>
    </AppShell>
  );
}

function edgeLabel(type: string, lagValue: number, lagUnit: string): string {
  if (lagValue === 0) return type;
  const sign = lagValue > 0 ? '+' : '';
  return `${type} ${sign}${lagValue}${unitShort(lagUnit)}`;
}

function unitShort(unit: string): string {
  if (unit === 'hours') return 'h';
  if (unit === 'days') return 'd';
  if (unit === 'weeks') return 'w';
  return unit;
}
