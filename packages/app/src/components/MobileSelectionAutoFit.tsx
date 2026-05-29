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
 *   shift (flow units)    = shift_screen / current_zoom
 *
 * `setCenter(x, y + shift, { zoom })` then anchors the target in the
 * upper strip. We pan only; current zoom is preserved.
 *
 * Lives inside `<ReactFlow>` (sibling of `CanvasFitOnLoad`) so
 * `useReactFlow()` resolves. Returns `null`; pure side effect.
 *
 * Out of scope (future polish if useful):
 *   - Adjusting zoom to fit the target snugly in the visible strip
 *     (this slice preserves current zoom — pan only).
 *   - Restoring the original viewport when the sheet dismisses.
 *   - Per-selection padding tuning.
 */

import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useDomainStore } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import { useIsMobile } from '../hooks/useIsMobile.js';
import { DEFAULT_NODE_W, DEFAULT_NODE_H } from '../utils/placement.js';

const HEADER_PX = 60;
const MOBILE_BOTTOM_CHROME_PX = 86; // tab bar (56) + footer (30)
const SHEET_VH = 0.6; // matches `max-md:max-h-[60vh]` on each panel
const ANIM_DURATION_MS = 400;

interface Rect {
  x: number;
  y: number;
}

/**
 * Compute the center point (in flow coords) of the currently-selected
 * canvas element, or `null` if nothing actionable is selected. Looks
 * up live positions from the domain store — does NOT subscribe; only
 * called from the effect after a selection-id change.
 */
function getSelectionCenter(): Rect | null {
  const state = useDomainStore.getState();
  const project = state.project;
  const view = useViewStore.getState();

  // Single-node selection (activity / decision / start / end / comment /
  // subsystem container). Multi-node selection: take the centroid of
  // their centers — better than nothing for a "look at my selection"
  // gesture.
  if (view.selection.nodeIds.length > 0) {
    const centers = view.selection.nodeIds
      .map((id) => project.nodes.find((n) => n.id === id))
      .filter((n): n is NonNullable<typeof n> => n !== undefined)
      .map((n) => ({
        x: n.position.x + (n.width ?? DEFAULT_NODE_W) / 2,
        y: n.position.y + (n.height ?? DEFAULT_NODE_H) / 2,
      }));
    if (centers.length === 0) return null;
    const sumX = centers.reduce((a, c) => a + c.x, 0);
    const sumY = centers.reduce((a, c) => a + c.y, 0);
    return { x: sumX / centers.length, y: sumY / centers.length };
  }

  // Edge selection — centroid of from + to node centers.
  if (view.selection.edgeId) {
    const edge = project.edges.find((e) => e.id === view.selection.edgeId);
    if (!edge) return null;
    const from = project.nodes.find((n) => n.id === edge.from);
    const to = project.nodes.find((n) => n.id === edge.to);
    if (!from || !to) return null;
    const fx = from.position.x + (from.width ?? DEFAULT_NODE_W) / 2;
    const fy = from.position.y + (from.height ?? DEFAULT_NODE_H) / 2;
    const tx = to.position.x + (to.width ?? DEFAULT_NODE_W) / 2;
    const ty = to.position.y + (to.height ?? DEFAULT_NODE_H) / 2;
    return { x: (fx + tx) / 2, y: (fy + ty) / 2 };
  }

  // Loop selection — centroid of body-node centers.
  if (view.selectedLoopId) {
    const loop = project.loops.find((l) => l.id === view.selectedLoopId);
    if (!loop) return null;
    const centers = loop.bodyNodeIds
      .map((id) => project.nodes.find((n) => n.id === id))
      .filter((n): n is NonNullable<typeof n> => n !== undefined)
      .map((n) => ({
        x: n.position.x + (n.width ?? DEFAULT_NODE_W) / 2,
        y: n.position.y + (n.height ?? DEFAULT_NODE_H) / 2,
      }));
    if (centers.length === 0) return null;
    const sumX = centers.reduce((a, c) => a + c.x, 0);
    const sumY = centers.reduce((a, c) => a + c.y, 0);
    return { x: sumX / centers.length, y: sumY / centers.length };
  }

  return null;
}

export function MobileSelectionAutoFit() {
  const isMobile = useIsMobile();
  const rf = useReactFlow();

  // Subscribe to selection-id changes only — depending on the full
  // selection object or the project would re-fire the effect on
  // unrelated keystrokes. The `.join('|')` collapses the array to a
  // string identity so React's shallow-equality stops at the IDs.
  const nodeIdsKey = useViewStore((s) => s.selection.nodeIds.join('|'));
  const edgeId = useViewStore((s) => s.selection.edgeId);
  const loopId = useViewStore((s) => s.selectedLoopId);

  useEffect(() => {
    if (!isMobile) return;
    const target = getSelectionCenter();
    if (target === null) return;

    const viewportH = window.innerHeight;
    const sheetH = viewportH * SHEET_VH;
    const visibleTop = HEADER_PX;
    const visibleBottom = viewportH - MOBILE_BOTTOM_CHROME_PX - sheetH;
    const visibleCenterY = (visibleTop + visibleBottom) / 2;
    const viewportCenterY = viewportH / 2;
    const shiftScreen = viewportCenterY - visibleCenterY;

    const zoom = rf.getZoom();
    const shiftFlow = shiftScreen / zoom;

    rf.setCenter(target.x, target.y + shiftFlow, {
      zoom,
      duration: ANIM_DURATION_MS,
    });
  }, [isMobile, nodeIdsKey, edgeId, loopId, rf]);

  return null;
}
