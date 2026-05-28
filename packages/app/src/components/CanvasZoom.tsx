import { useEffect } from 'react';
import { useReactFlow, useNodes } from '@xyflow/react';
import { useViewStore } from '../store/viewStore.js';
import { placeNode } from '../utils/placement.js';

/**
 * Custom zoom widget pinned to the bottom-right of the canvas — replaces
 * React Flow's default `<Controls>` (which is busier and bottom-left).
 *
 * Buttons: zoom-in, zoom-out, fit-view. Must be a child of `<ReactFlow>`.
 */
export function CanvasZoom() {
  const rf = useReactFlow();

  return (
    <div
      data-placement-passthrough
      className="absolute right-3 bottom-3 z-10 inline-flex bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-[0_1px_2px_rgba(15,23,42,0.04)] overflow-hidden"
    >
      <ZoomBtn title="Zoom in" onClick={() => rf.zoomIn({ duration: 150 })}>
        ＋
      </ZoomBtn>
      <ZoomBtn title="Zoom out" onClick={() => rf.zoomOut({ duration: 150 })}>
        −
      </ZoomBtn>
      <ZoomBtn
        title="Fit view (Space)"
        onClick={() => rf.fitView({ duration: 200, padding: 0.15 })}
      >
        ⊡
      </ZoomBtn>
    </div>
  );
}

/**
 * Phase 41 Slice 3 / Phase 45 Slice 2 / Phase 45 Slice 5b — canvas
 * keyboard shortcuts. Lives inside `<ReactFlow>` so it only mounts on
 * the canvas tab (the tab gating in App.tsx unmounts ReactFlow when the
 * user is anywhere else), giving us automatic scoping without any
 * tab-state plumbing.
 *
 * Bindings (no modifier, no form-field):
 *   - Space            → fitView
 *   - `+` / `=`        → zoom in
 *   - `-`              → zoom out
 *   - Arrow keys       → during placement, nudge the preview by ~20 px
 *                        (screen-pixel-equivalent). With no selection,
 *                        pan the viewport by PAN_STEP_PX. With a node
 *                        selection, defer to React Flow.
 *   - Enter            → during placement, confirm the drop at the
 *                        current preview position.
 *
 * Bindings (Cmd/Ctrl modifier):
 *   - Cmd+Arrow during placement → pan the viewport (the unmodified
 *                        arrow path during placement is reserved for
 *                        preview-nudge per Slice 5b).
 *
 * All handlers ignore keystrokes coming from form fields and
 * contentEditable regions — otherwise typing a space in the Inspector's
 * Name / Description field would jump the canvas behind it (and arrow
 * keys would shift the camera while the user is just moving the caret).
 *
 * Arrow keys use the capture phase so this listener wins over React
 * Flow's default "nudge selected nodes with arrow keys" behaviour;
 * `preventDefault()` then keeps the default from firing at all.
 */
const PAN_STEP_PX = 100;
const ZOOM_DURATION_MS = 120;
/**
 * Slice 5b — placement nudge step, in screen pixels. Divided by current
 * zoom to compute the flow-coord delta so the perceived step is constant
 * across zoom levels. 20 px feels like fine positioning; the browser's
 * key-repeat handles "move further" by repeating presses.
 */
const PLACEMENT_NUDGE_PX = 20;

export function CanvasKeyboardShortcuts() {
  const rf = useReactFlow();

  useEffect(() => {
    function isFormField(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (target.isContentEditable) return true;
      return false;
    }

    function panBy(dx: number, dy: number) {
      const vp = rf.getViewport();
      rf.setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }, { duration: ZOOM_DURATION_MS });
    }

    function nudgePlacement(dxScreen: number, dyScreen: number) {
      const view = useViewStore.getState();
      const pos = view.placementPosition;
      if (!pos) return;
      // Screen-pixel-perceived nudge: divide by zoom so the visual step
      // stays constant across zoom levels. Falls back to dx/dy directly
      // if zoom is somehow zero (shouldn't happen — React Flow clamps).
      const zoom = rf.getViewport().zoom || 1;
      view.setPlacementPosition({
        x: pos.x + dxScreen / zoom,
        y: pos.y + dyScreen / zoom,
      });
    }

    function onKeyDown(e: KeyboardEvent) {
      // Most shortcuts require no modifier and a non-form target. The
      // exception is Cmd/Ctrl+Arrow during placement (Slice 5b), which
      // pans the viewport while the unmodified arrows are reserved for
      // preview-nudge. Alt-modified arrows are deferred to the browser
      // unconditionally.
      if (e.altKey) return;
      if (isFormField(e.target)) return;

      const mod = e.ctrlKey || e.metaKey;
      const isArrow =
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight' ||
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown';
      const placementType = useViewStore.getState().placementType;

      // Cmd+Arrow during placement → pan the viewport. Without
      // placement, defer to the browser (Cmd+Left/Right is word-nav in
      // text fields, but the form-field guard already bailed; outside
      // form fields the browser has no default action for these).
      if (mod && isArrow) {
        if (!placementType) return;
        switch (e.key) {
          case 'ArrowLeft':
            e.preventDefault();
            panBy(PAN_STEP_PX, 0);
            return;
          case 'ArrowRight':
            e.preventDefault();
            panBy(-PAN_STEP_PX, 0);
            return;
          case 'ArrowUp':
            e.preventDefault();
            panBy(0, PAN_STEP_PX);
            return;
          case 'ArrowDown':
            e.preventDefault();
            panBy(0, -PAN_STEP_PX);
            return;
        }
        return;
      }

      // Any other modifier → defer to the browser (Cmd+= for browser
      // zoom, Cmd+Z for undo handled elsewhere, etc.).
      if (mod) return;

      // Enter during placement → confirm the drop at the current
      // preview position. No-op when placementPosition is null
      // (defensive — PlacementOverlay seeds it on mount).
      if (placementType && e.key === 'Enter') {
        const pos = useViewStore.getState().placementPosition;
        if (!pos) return;
        e.preventDefault();
        const newId = placeNode(placementType, pos);
        useViewStore.getState().cancelPlacement();
        // Slice 5c — open quick-name callout on the freshly-dropped node.
        if (newId) useViewStore.getState().startNaming(newId);
        return;
      }

      // Phase 47 Slice 3 follow-up — Esc while drilled into a sub-system
      // pops one breadcrumb level. PlacementOverlay handles Esc when
      // placement mode is active (gets the window-level listener first
      // via its own capture-phase registration), so we only run this
      // branch when placement isn't active.
      if (e.key === 'Escape' && !placementType) {
        const view = useViewStore.getState();
        if (view.breadcrumb.length > 0) {
          e.preventDefault();
          view.drillOutTo(view.breadcrumb.length - 2);
          return;
        }
      }

      // Space → fitView (Phase 41 Slice 3).
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        rf.fitView({ duration: 200, padding: 0.15 });
        return;
      }

      // `+` (shifted on most keyboards) and unshifted `=` both zoom in;
      // `-` zooms out. We check `e.key` so the OS keyboard layout maps
      // physical-key to logical-character consistently.
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        rf.zoomIn({ duration: ZOOM_DURATION_MS });
        return;
      }
      if (e.key === '-') {
        e.preventDefault();
        rf.zoomOut({ duration: ZOOM_DURATION_MS });
        return;
      }

      if (!isArrow) return;

      // Arrow keys split three ways:
      //
      //   - Placement active  → nudge the preview by PLACEMENT_NUDGE_PX
      //                         (screen-pixel-equivalent). Slice 5b.
      //   - Nothing selected  → pan the viewport by PAN_STEP_PX.
      //   - Node(s) selected  → defer to React Flow's default, which
      //                         nudges the selected node(s).
      //
      // First cut at Phase 45 Slice 2 unconditionally panned the
      // viewport AND let React Flow's node-move fire, so both ran at
      // once (preventDefault stops the browser's default action, not
      // other JS listeners). The fix is to bail out without
      // preventing when nodes are selected — React Flow's listener
      // then runs and moves the node; we don't pan.
      //
      // Sign convention for the pan path: ArrowLeft means "I want to
      // see content to the left," which means the camera shifts left,
      // which in ReactFlow's viewport-as-translation model means
      // viewport.x INCREASES (the canvas slides right under the
      // camera).
      if (placementType) {
        switch (e.key) {
          case 'ArrowLeft':
            e.preventDefault();
            nudgePlacement(-PLACEMENT_NUDGE_PX, 0);
            return;
          case 'ArrowRight':
            e.preventDefault();
            nudgePlacement(PLACEMENT_NUDGE_PX, 0);
            return;
          case 'ArrowUp':
            e.preventDefault();
            nudgePlacement(0, -PLACEMENT_NUDGE_PX);
            return;
          case 'ArrowDown':
            e.preventDefault();
            nudgePlacement(0, PLACEMENT_NUDGE_PX);
            return;
        }
        return;
      }

      const hasNodeSelection = useViewStore.getState().selection.nodeIds.length > 0;
      if (hasNodeSelection) {
        // Defer to React Flow — let the node move.
        return;
      }
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          panBy(PAN_STEP_PX, 0);
          return;
        case 'ArrowRight':
          e.preventDefault();
          panBy(-PAN_STEP_PX, 0);
          return;
        case 'ArrowUp':
          e.preventDefault();
          panBy(0, PAN_STEP_PX);
          return;
        case 'ArrowDown':
          e.preventDefault();
          panBy(0, -PAN_STEP_PX);
          return;
      }
    }

    // Capture phase so we run BEFORE React Flow's keydown handler that
    // would otherwise move selected nodes on arrow press.
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [rf]);

  return null;
}

/**
 * Phase 45 Slice 1 — fit the camera to the full diagram on bulk project
 * load (template pick, file open, "New project"). The load path can't
 * call `rf.fitView` directly because it runs outside the `<ReactFlow>`
 * scope, so it signals via `viewStore.requestFitView()`. This watcher
 * consumes the request on the next render — but only after React Flow
 * has finished mounting the new nodes (otherwise `fitView` operates on
 * the stale node set and lands the camera at the previous diagram's
 * extents).
 *
 * The `useNodes()` dependency in the effect is what makes that work:
 * the effect re-runs every time the node list reference changes, so on
 * the render where the new project's nodes are committed we get a
 * chance to fit. The `pendingFitView` flag scopes the fit to one-shot
 * bulk loads; ordinary node edits change `useNodes()` too but the flag
 * is false, so the effect is a no-op.
 */
export function CanvasFitOnLoad() {
  const rf = useReactFlow();
  const nodes = useNodes();
  const pendingFitView = useViewStore((s) => s.pendingFitView);
  const consumeFitView = useViewStore((s) => s.consumeFitView);

  useEffect(() => {
    if (!pendingFitView) return;
    // No nodes means the load was probably a fresh-blank project; still
    // safe to call fitView but skip to avoid the engine logging a
    // "no nodes" advisory on every empty-project boot.
    if (nodes.length === 0) {
      consumeFitView();
      return;
    }
    rf.fitView({ duration: 250, padding: 0.15 });
    consumeFitView();
  }, [pendingFitView, nodes, rf, consumeFitView]);

  return null;
}

function ZoomBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="w-[30px] h-[30px] inline-flex items-center justify-center text-[13px] text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 border-r border-gray-100 dark:border-gray-800 last:border-r-0 transition-colors"
    >
      {children}
    </button>
  );
}
