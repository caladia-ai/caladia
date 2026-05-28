import { useEffect, useMemo } from 'react';
import { useReactFlow, ViewportPortal } from '@xyflow/react';
import type { ProjectNode } from '@procsim/file-format';
import { useDomainStore } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import {
  ANCHOR_OFFSET_Y,
  GHOST_H,
  GHOST_W,
  PICKUP_RADIUS,
  closestSourceWithin,
  placeNode,
  placeNodeWithIncomingEdges,
  sourceHandleWorldPos,
  type PlacementType,
} from '../utils/placement.js';

/**
 * Phase 45 Slice 5a — node-placement overlay.
 *
 * Active whenever `viewStore.placementType` is non-null. Tracks the
 * cursor over the React Flow pane and renders a ghost preview of the
 * node-to-be at the cursor. Left-click on the pane places the node via
 * the existing domain-store actions; Esc / click-outside cancel.
 *
 * The cursor anchors at the preview's left-edge midpoint — the node's
 * "target handle" — so the user can line the new node up with a
 * preceding node's source handle by eye. The placement position
 * passed to `addNode(...)` accounts for this offset so the dropped
 * node lands centred under the cursor in the same orientation.
 *
 * Slice 5b — the preview position now lives in `viewStore.placementPosition`
 * (writable by both pointermove and arrow-key nudge in CanvasKeyboardShortcuts).
 * On entry to placement mode, if no position has been set yet, seed it to
 * the viewport center so keyboard-only entry has a starting point.
 *
 * Phase 49 Slice 4 — wire-on-place.
 * When the placement type is activity or decision (the two with a
 * left-target handle that matches the cursor anchor), moving the
 * ghost over an existing node's right-side source handle arms a
 * ghost edge from that handle to the cursor. Multiple arms accumulate
 * — the LIFO stack lives in `viewStore.pendingPlacementSources`.
 * Visuals: a dashed emerald line per pending source + a solid emerald
 * ring at the currently-in-range handle (the user's "where the click
 * will wire" affordance). Click commits the node AND all collected
 * edges in one undo step. Esc pops one ghost edge at a time and only
 * falls through to placement-cancel when the stack is empty.
 *
 * Must be mounted inside `<ReactFlow>` so `useReactFlow` works.
 * `ViewportPortal` makes the ghost render in flow coordinates so it
 * scales with zoom automatically — no manual transform math.
 */

const TYPE_LABEL: Record<PlacementType, string> = {
  activity: 'Activity',
  decision: 'Decision',
  start: 'Start',
  end: 'End',
};

/**
 * Phase 50 Slice 11 — three-way classification for placement-mode clicks.
 *
 * `passthrough` is checked first so a click on a floating overlay
 * (SelectionToolbar, ResourcePalette, CanvasZoom — all marked with
 * `data-placement-passthrough`) reaches its button without dropping
 * a stray node. Without this branch, every click inside `.react-flow`
 * (which contains those overlays) was a place click.
 *
 * Exported for unit-testing the policy without a DOM.
 */
export function classifyPlacementClick(matchers: {
  passthrough: boolean;
  insideCanvas: boolean;
}): 'passthrough' | 'place' | 'cancel' {
  if (matchers.passthrough) return 'passthrough';
  if (matchers.insideCanvas) return 'place';
  return 'cancel';
}

/** Hover-ring radius (flow units). Handle is 14 px (per index.css), so a
 *  ring at r=11 sits ~4 px outside the handle's edge — clearly visible
 *  without obscuring the handle itself. */
const PICKUP_RING_R = 11;

export function PlacementOverlay() {
  const placementType = useViewStore((s) => s.placementType);
  const placementPosition = useViewStore((s) => s.placementPosition);
  const setPlacementPosition = useViewStore((s) => s.setPlacementPosition);
  const cancelPlacement = useViewStore((s) => s.cancelPlacement);
  const pendingSources = useViewStore((s) => s.pendingPlacementSources);
  const pushPendingPlacementSource = useViewStore((s) => s.pushPendingPlacementSource);
  const popPendingPlacementSource = useViewStore((s) => s.popPendingPlacementSource);
  const breadcrumb = useViewStore((s) => s.breadcrumb);
  const project = useDomainStore((s) => s.project);
  const rf = useReactFlow();

  // Phase 49 Slice 4 — candidate set for source-handle proximity.
  // Mirrors App.tsx's `visibleNodeIds` logic locally so the overlay
  // doesn't need to thread the prop down (placement is short-lived;
  // the small duplication is the lesser evil over a refactor that
  // touches App.tsx and would expand the slice's footprint).
  const currentSubsystemId = breadcrumb.at(-1)?.subsystemId ?? null;
  const visibleCandidates = useMemo<ReadonlyArray<ProjectNode>>(() => {
    if (!currentSubsystemId) {
      const allBodyIds = new Set(project.subsystems.flatMap((s) => s.bodyNodeIds));
      return project.nodes.filter((n) => !allBodyIds.has(n.id));
    }
    const sub = project.subsystems.find((s) => s.id === currentSubsystemId);
    if (!sub) return [];
    const bodyIds = new Set(sub.bodyNodeIds);
    return project.nodes.filter((n) => bodyIds.has(n.id));
  }, [currentSubsystemId, project.nodes, project.subsystems]);

  const isWireable = placementType === 'activity' || placementType === 'decision';

  // Currently-armed source for the hover ring — re-derived each render
  // from the cursor position. Cheap (linear scan of visibleCandidates)
  // and avoids an extra piece of local state that could drift from
  // the pendingSources stack.
  const armedSource = useMemo(() => {
    if (!isWireable || placementPosition === null) return null;
    return closestSourceWithin(placementPosition, visibleCandidates, PICKUP_RADIUS);
  }, [isWireable, placementPosition, visibleCandidates]);

  useEffect(() => {
    if (!placementType) return;
    const pane = document.querySelector('.react-flow__pane');
    if (!(pane instanceof HTMLElement)) return;

    // Seed `placementPosition` with viewport center on entry when no
    // position has been written yet. Reading the store imperatively
    // here (not via subscription) avoids re-running the effect every
    // time the position updates — we only need the value at the moment
    // of entry. Pointermove and the arrow-key handler write subsequent
    // updates.
    if (useViewStore.getState().placementPosition === null) {
      const rect = pane.getBoundingClientRect();
      const center = rf.screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
      setPlacementPosition(center);
    }

    function onMove(e: PointerEvent) {
      const flowPos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setPlacementPosition(flowPos);

      // Phase 49 Slice 4 — auto-arm a ghost connection when the cursor
      // enters a source handle's hit radius. Idempotent against the
      // store (the push action no-ops on duplicates), but we check
      // here too so a still-in-range cursor doesn't churn through the
      // no-op set() on every frame. Out-of-range simply doesn't arm
      // — pendingSources stays sticky (the user's collected wires
      // persist until commit / Esc-pop / cancel).
      const type = useViewStore.getState().placementType;
      if (type !== 'activity' && type !== 'decision') return;
      const closest = closestSourceWithin(flowPos, visibleCandidates, PICKUP_RADIUS);
      if (closest === null) return;
      const pending = useViewStore.getState().pendingPlacementSources;
      if (!pending.includes(closest.id)) {
        pushPendingPlacementSource(closest.id);
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // Slice 4 — LIFO: pop one ghost edge per Esc; only fall through
      // to placement-cancel when the stack is empty. This makes Esc
      // an "undo my last wire" affordance during placement and keeps
      // the existing "Esc cancels placement" semantic for the empty-
      // stack case the user already knows.
      const pending = useViewStore.getState().pendingPlacementSources;
      if (pending.length > 0) {
        popPendingPlacementSource();
      } else {
        cancelPlacement();
      }
    }

    function onWindowClick(e: MouseEvent) {
      // Three-way routing (see `classifyPlacementClick` below):
      //   - passthrough → let the click flow through to the underlying
      //     button (SelectionToolbar / ResourcePalette / CanvasZoom);
      //     don't place, don't cancel, don't stopPropagation.
      //   - place → inside `.react-flow` (pane OR existing node OR
      //     loop group); preventDefault + stopPropagation so RF's
      //     onNodeClick can't also fire.
      //   - cancel → outside (rail, header, inspector, etc.).
      if (!(e.target instanceof Element)) return;
      const decision = classifyPlacementClick({
        passthrough: e.target.closest('[data-placement-passthrough]') !== null,
        insideCanvas: e.target.closest('.react-flow') !== null,
      });
      if (decision === 'passthrough') return;
      if (decision === 'cancel') {
        cancelPlacement();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const flowPos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      // Slice 4 — when wire-on-place collected any sources, route
      // through the atomic node + edges helper so undo reverts the
      // whole drop. Otherwise (start / end, or activity / decision
      // with no wires collected) keep the original placeNode path.
      const type = placementType!;
      const pending = useViewStore.getState().pendingPlacementSources;
      let newId: string | null;
      if ((type === 'activity' || type === 'decision') && pending.length > 0) {
        newId = placeNodeWithIncomingEdges(type, flowPos, pending);
      } else {
        newId = placeNode(type, flowPos);
      }
      cancelPlacement();
      // Slice 5c — open the quick-name callout on the freshly-dropped
      // node so the user can rename without opening the Inspector.
      // Skipped when placeNode returned null (single-End guard).
      if (newId) useViewStore.getState().startNaming(newId);
    }

    pane.addEventListener('pointermove', onMove);
    window.addEventListener('keydown', onKeyDown);
    // Capture phase so we see the click before React Flow's listeners on
    // the pane / nodes. Without capture, RF's onNodeClick would fire
    // first when the user clicked on an existing node, selecting it
    // instead of placing the new one.
    window.addEventListener('click', onWindowClick, { capture: true });
    return () => {
      pane.removeEventListener('pointermove', onMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('click', onWindowClick, { capture: true });
    };
  }, [
    placementType,
    cancelPlacement,
    rf,
    setPlacementPosition,
    visibleCandidates,
    pushPendingPlacementSource,
    popPendingPlacementSource,
  ]);

  if (!placementType || !placementPosition) return null;

  // Cursor sits at the left-edge midpoint of the preview. Translate the
  // top-left of the preview accordingly.
  const x = placementPosition.x;
  const y = placementPosition.y - ANCHOR_OFFSET_Y;
  const label = TYPE_LABEL[placementType];

  // Slice 4 — pending-source handle world positions, resolved against
  // the candidate set so a mid-placement undo / delete (the node
  // disappears from `project.nodes`) doesn't dangle a ghost line.
  const candidatesById = new Map(visibleCandidates.map((n) => [n.id, n]));
  const pendingHandlePositions = pendingSources
    .map((id) => {
      const node = candidatesById.get(id);
      if (!node) return null;
      const pos = sourceHandleWorldPos(node);
      return pos ? { id, pos } : null;
    })
    .filter((p): p is { id: string; pos: { x: number; y: number } } => p !== null);

  const armedRingPos = (() => {
    if (!armedSource) return null;
    const node = candidatesById.get(armedSource.id);
    if (!node) return null;
    return sourceHandleWorldPos(node);
  })();

  return (
    <ViewportPortal>
      {/* Phase 49 Slice 4 — ghost edges + hover ring. One large SVG
          with a centred viewBox so internal coords match flow world
          coords; the SVG's CSS box covers ±50 000 flow units, which
          easily contains any realistic project. ViewportPortal
          applies the zoom/pan transform on the way out. */}
      {isWireable && (pendingHandlePositions.length > 0 || armedRingPos) && (
        <svg
          aria-hidden
          className="pointer-events-none absolute"
          style={{ left: -50000, top: -50000, width: 100000, height: 100000 }}
          viewBox="-50000 -50000 100000 100000"
        >
          {pendingHandlePositions.map(({ id, pos }) => (
            <line
              key={id}
              x1={pos.x}
              y1={pos.y}
              x2={placementPosition.x}
              y2={placementPosition.y}
              strokeWidth={2}
              strokeDasharray="6 4"
              className="stroke-emerald-500 dark:stroke-emerald-400"
              opacity={0.75}
            />
          ))}
          {armedRingPos && (
            <circle
              cx={armedRingPos.x}
              cy={armedRingPos.y}
              r={PICKUP_RING_R}
              fill="none"
              strokeWidth={2}
              className="stroke-emerald-500 dark:stroke-emerald-400"
              opacity={0.9}
            />
          )}
        </svg>
      )}

      <div
        aria-hidden
        // pointer-events-none so the ghost doesn't eat the placement
        // click — it has to land on the underlying pane.
        className="pointer-events-none absolute"
        style={{ left: x, top: y }}
      >
        {placementType === 'decision' ? (
          <DecisionGhost label={label} />
        ) : placementType === 'start' || placementType === 'end' ? (
          <AnchorGhost label={label} />
        ) : (
          <ActivityGhost label={label} />
        )}
      </div>
    </ViewportPortal>
  );
}

function ActivityGhost({ label }: { label: string }) {
  return (
    <div
      className="rounded-lg border-2 border-dashed border-emerald-500/70 bg-white/60 dark:bg-gray-800/60 backdrop-blur-sm px-4 py-3 shadow-[0_2px_8px_rgba(15,23,42,0.12)] text-center"
      style={{ width: GHOST_W, height: GHOST_H }}
    >
      <div className="text-sm font-medium text-gray-700 dark:text-gray-200">{label}</div>
      <div className="text-[10px] text-gray-500 dark:text-gray-400">click to place</div>
    </div>
  );
}

function DecisionGhost({ label }: { label: string }) {
  // Diamond — render a square rotated 45°. Match the DecisionNode's
  // amber palette + dashed border for the ghost state.
  const side = Math.min(GHOST_W, GHOST_H);
  return (
    <div
      style={{ width: GHOST_W, height: GHOST_H }}
      className="relative flex items-center justify-center"
    >
      <div
        className="absolute border-2 border-dashed border-amber-500/70 bg-amber-50/60 dark:bg-amber-950/60 backdrop-blur-sm shadow-[0_2px_8px_rgba(15,23,42,0.12)]"
        style={{ width: side * 0.8, height: side * 0.8, transform: 'rotate(45deg)' }}
      />
      <div className="relative text-[11px] font-medium text-amber-900 dark:text-amber-200">
        {label}
      </div>
    </div>
  );
}

function AnchorGhost({ label }: { label: string }) {
  return (
    <div
      className="rounded-full border-2 border-dashed border-blue-500/70 bg-blue-50/60 dark:bg-blue-950/60 backdrop-blur-sm shadow-[0_2px_8px_rgba(15,23,42,0.12)] flex items-center justify-center"
      style={{ width: GHOST_W * 0.6, height: GHOST_H }}
    >
      <div className="text-xs font-medium text-blue-900 dark:text-blue-200">{label}</div>
    </div>
  );
}
