/**
 * MobileSelectionAutoFit — when the bottom-sheet inspector opens on a
 * phone, slide the canvas so the selected node / loop / edge appears
 * centered in the *visible* upper strip (the part above the sheet),
 * not behind it.
 *
 * Background. Slice 4 made the Inspector a bottom sheet at
 * `bottom-[86px] max-h-[60vh]`. The sheet covers the bottom ~60 % of
 * the viewport, plus the mobile tab bar (56 px) + footer (30 px)
 * underneath. Without auto-centering, tapping a node positioned
 * anywhere on the canvas often opens the inspector while the node
 * itself sits behind the sheet — invisible.
 *
 * Math. For window height H:
 *
 *   header              = 60 px
 *   tab bar             = 56 px (mobile only)
 *   footer              = 30 px
 *   sheet (max-h-[60vh]) = 0.6 × H
 *
 *   visible canvas top    = 60
 *   visible canvas bottom = H − 86 − 0.6H = 0.4H − 86
 *   visible center y      = (60 + 0.4H − 86) / 2 = 0.2H − 13
 *
 *   viewport center y     = H / 2
 *   shift (screen px)     = (H / 2) − (0.2H − 13) = 0.3H + 13
 *   shift (flow units)    = shift_screen / zoom
 *
 * `setCenter(x, y + shift, { zoom })` then anchors the selection's
 * center in the upper strip. We also shrink the zoom — out only — so a
 * large selection (loop / multi-node) fits the strip; a small selection
 * keeps the current zoom (never magnified).
 *
 * On dismiss (selection cleared) we restore the viewport captured just
 * before the first auto-pan — a "peek and return". The snapshot is taken
 * once per open; selection changes while the sheet stays open keep it, so
 * closing returns to where the interaction began. A manual pan / zoom while
 * the sheet is open is intentionally discarded on close (simplest correct
 * behaviour; pan-to-stay was the considered alternative).
 *
 * Lives inside `<ReactFlow>` (sibling of `CanvasFitOnLoad`) so
 * `useReactFlow()` resolves. Returns `null`; pure side effect.
 *
 * Out of scope (future polish if useful):
 *   - Per-selection padding tuning.
 */

import { useEffect, useRef } from 'react';
import { useReactFlow, type Viewport } from '@xyflow/react';
import { useDomainStore } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import { useIsMobile } from '../hooks/useIsMobile.js';
import { DEFAULT_NODE_W, DEFAULT_NODE_H } from '../utils/placement.js';

const HEADER_PX = 60;
const MOBILE_BOTTOM_CHROME_PX = 86; // tab bar (56) + footer (30)
const SHEET_VH = 0.6; // matches `max-md:max-h-[60vh]` on each panel
const ANIM_DURATION_MS = 400;
// Fraction of the visible strip the selection should occupy when zooming
// out to fit — leaves a little breathing room.
const FIT_PADDING = 0.85;
// React Flow's default minimum zoom (the app doesn't override it). Clamp
// our computed zoom to it so the shift math matches what RF actually applies.
const MIN_ZOOM = 0.5;

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Bounding box (in flow coords) of the currently-selected canvas
 * element(s), or `null` if nothing actionable is selected. Encloses the
 * full node rects — for an edge, its two endpoints; for a loop, its body
 * nodes. Reads live positions from the stores; does NOT subscribe (only
 * called from the effect after a selection-id change).
 */
function getSelectionBounds(): Bounds | null {
  const project = useDomainStore.getState().project;
  const view = useViewStore.getState();

  let nodes: typeof project.nodes = [];
  if (view.selection.nodeIds.length > 0) {
    nodes = view.selection.nodeIds
      .map((id) => project.nodes.find((n) => n.id === id))
      .filter((n): n is NonNullable<typeof n> => n !== undefined);
  } else if (view.selection.edgeId) {
    const edge = project.edges.find((e) => e.id === view.selection.edgeId);
    if (edge) {
      nodes = [edge.from, edge.to]
        .map((id) => project.nodes.find((n) => n.id === id))
        .filter((n): n is NonNullable<typeof n> => n !== undefined);
    }
  } else if (view.selectedLoopId) {
    const loop = project.loops.find((l) => l.id === view.selectedLoopId);
    if (loop) {
      nodes = loop.bodyNodeIds
        .map((id) => project.nodes.find((n) => n.id === id))
        .filter((n): n is NonNullable<typeof n> => n !== undefined);
    }
  }

  if (nodes.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const w = n.width ?? DEFAULT_NODE_W;
    const h = n.height ?? DEFAULT_NODE_H;
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  return { minX, minY, maxX, maxY };
}

export function MobileSelectionAutoFit() {
  const isMobile = useIsMobile();
  const rf = useReactFlow();

  // Viewport captured just before the auto-pan on the first open, so
  // dismissing the sheet can restore it ("peek and return"). A ref so it
  // survives re-renders without re-triggering the effect.
  const prePanViewport = useRef<Viewport | null>(null);

  // Subscribe to selection-id changes only — depending on the full
  // selection object or the project would re-fire the effect on
  // unrelated keystrokes. The `.join('|')` collapses the array to a
  // string identity so React's shallow-equality stops at the IDs.
  const nodeIdsKey = useViewStore((s) => s.selection.nodeIds.join('|'));
  const edgeId = useViewStore((s) => s.selection.edgeId);
  const loopId = useViewStore((s) => s.selectedLoopId);

  useEffect(() => {
    if (!isMobile) return;
    const bounds = getSelectionBounds();

    // Selection cleared — the sheet dismissed. Restore the viewport we
    // captured before the first auto-pan, then forget it.
    if (bounds === null) {
      if (prePanViewport.current !== null) {
        rf.setViewport(prePanViewport.current, { duration: ANIM_DURATION_MS });
        prePanViewport.current = null;
      }
      return;
    }

    // First open of this run — snapshot the pre-pan viewport so the
    // dismiss branch above can return to it. Selection changes while the
    // sheet stays open keep the original snapshot (don't re-capture).
    if (prePanViewport.current === null) {
      prePanViewport.current = rf.getViewport();
    }

    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    const selW = bounds.maxX - bounds.minX;
    const selH = bounds.maxY - bounds.minY;

    const viewportH = window.innerHeight;
    const sheetH = viewportH * SHEET_VH;
    const visibleTop = HEADER_PX;
    const visibleBottom = viewportH - MOBILE_BOTTOM_CHROME_PX - sheetH;
    const stripH = visibleBottom - visibleTop;

    // Zoom out (only) so the selection fits the strip with padding; a
    // selection that already fits keeps the current zoom — never magnified.
    // Clamp to RF's min zoom so the shift below matches what RF applies.
    const fitZoom = Math.min(
      (window.innerWidth * FIT_PADDING) / selW,
      (stripH * FIT_PADDING) / selH,
    );
    const zoom = Math.max(MIN_ZOOM, Math.min(rf.getZoom(), fitZoom));

    const visibleCenterY = (visibleTop + visibleBottom) / 2;
    const viewportCenterY = viewportH / 2;
    const shiftScreen = viewportCenterY - visibleCenterY;
    const shiftFlow = shiftScreen / zoom;

    rf.setCenter(centerX, centerY + shiftFlow, {
      zoom,
      duration: ANIM_DURATION_MS,
    });
  }, [isMobile, nodeIdsKey, edgeId, loopId, rf]);

  return null;
}
