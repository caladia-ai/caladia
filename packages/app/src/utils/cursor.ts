/**
 * Phase 19 slice 5 — draggable vertical cursor for time / distribution
 * charts.
 *
 * Shared hook + small render primitives consumed by every continuous-x
 * chart in the app (Gantt bars, Gantt cost-curve panel, Resources
 * allocation timeline, Simulate histogram / CDF in both Date and Cost
 * modes). Each chart:
 *
 *   1. Calls `useChartCursor(opts)` with the chart's plot extent and a
 *      pointer→data converter.
 *   2. Spreads the returned `pointerHandlers` onto its SVG element.
 *   3. Renders the returned `cursorDataValue` (when non-null) via its own
 *      vertical-line + tooltip components, formatting the readout with
 *      its own labels.
 *
 * Why a hook + render helpers instead of a single drop-in component:
 * each chart has different x-axis units (epoch ms, days, hours-from-
 * start, currency amount) and different SVG layouts (frozen label
 * column, viewBox vs absolute pixels). The hook keeps the
 * pointer-event boilerplate consistent; the chart owns how the cursor
 * looks and what its tooltip says.
 *
 * State is local per chart (no viewStore). The cursor is an ephemeral
 * scrubber — restoring it across navigation would create more confusion
 * than convenience.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseChartCursorOptions {
  /**
   * Maps client X (relative to the SVG element) to a data-domain value.
   * Returns `null` when the X is outside the plot's valid extent so the
   * cursor stays unset / clears.
   *
   * The second argument is the SVG element's current CSS width — useful
   * for stretched SVGs (`preserveAspectRatio="none"`) where viewBox
   * units differ from CSS pixels. Fixed-pixel SVGs can ignore it.
   */
  clientXToData: (clientXRelativeToSvg: number, svgWidthCss: number) => number | null;
  /**
   * Snaps an incoming data value to the nearest valid position (bin
   * center, bucket boundary, calendar day). Pass-through for continuous
   * charts. Called on every move/drop so the cursor lands cleanly.
   */
  snap?: (dataValue: number) => number;
  /**
   * When true, ESC key clears the cursor while pointer is over the SVG.
   * Defaults to true.
   */
  clearOnEscape?: boolean;
  /**
   * CSS selector for elements that should NOT trigger cursor placement
   * (e.g. interactive bars / arrows the user clicks for other reasons).
   * Defaults to `'button, a, [role="button"]'`. Charts with click-able
   * SVG children (Gantt bars) pass a more specific selector so the
   * cursor doesn't fight the bar-click handler.
   */
  ignoreSelector?: string;
}

export interface UseChartCursorResult {
  /** Current cursor value in the chart's data domain, or `null` when unset. */
  cursorDataValue: number | null;
  /** Imperative setter — used for ESC clearing and programmatic placement. */
  setCursor: (value: number | null) => void;
  /** Spread onto the chart's SVG element. */
  pointerHandlers: {
    onPointerDown: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerUp: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerLeave: (e: React.PointerEvent<SVGSVGElement>) => void;
  };
  /**
   * True while the user is actively dragging (pointer down on the SVG).
   * Lets the chart highlight the cursor visually (heavier stroke /
   * brighter handle) during interaction.
   */
  isDragging: boolean;
}

/**
 * Hook used by every chart in slice 5. See `UseChartCursorOptions` for
 * the contract.
 */
export function useChartCursor(opts: UseChartCursorOptions): UseChartCursorResult {
  const { clientXToData, snap, clearOnEscape = true, ignoreSelector } = opts;
  const ignoreSelectorRef = useRef(ignoreSelector);
  useEffect(() => {
    ignoreSelectorRef.current = ignoreSelector;
  }, [ignoreSelector]);
  const [cursorDataValue, setCursorDataValue] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  // Keep the latest converter / snapper in a ref so the imperative pointer
  // handlers don't capture stale closures when the chart re-measures
  // (e.g. viewport resize → new client→data mapping).
  const clientXToDataRef = useRef(clientXToData);
  const snapRef = useRef(snap);
  useEffect(() => {
    clientXToDataRef.current = clientXToData;
    snapRef.current = snap;
  }, [clientXToData, snap]);

  const place = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const dataValue = clientXToDataRef.current(relX, rect.width);
    if (dataValue === null) return;
    const snapped = snapRef.current ? snapRef.current(dataValue) : dataValue;
    setCursorDataValue(snapped);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // Don't intercept clicks on interactive children (buttons inside the
      // chart, click-able bars, etc.) — only respond when the pointer is
      // on the SVG / non-interactive shapes. The default selector covers
      // the obvious HTML interactives; charts with click-able SVG
      // children pass a custom selector via opts.ignoreSelector.
      const sel = ignoreSelectorRef.current ?? 'button, a, [role="button"]';
      if ((e.target as Element).closest(sel)) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsDragging(true);
      place(e);
    },
    [place],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!isDragging) return;
      place(e);
    },
    [isDragging, place],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsDragging(false);
  }, []);

  const onPointerLeave = useCallback(() => {
    // Don't clear on leave — the cursor should persist after the user has
    // placed it so they can read the tooltip while moving the mouse to
    // (e.g.) a side panel. Only ESC or a new click clears.
  }, []);

  // ESC clears the cursor. Listener is attached to window so it fires
  // regardless of focus — chart cursors aren't focusable elements.
  useEffect(() => {
    if (!clearOnEscape) return;
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setCursorDataValue(null);
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [clearOnEscape]);

  const setCursor = useCallback((value: number | null) => {
    if (value === null) {
      setCursorDataValue(null);
      return;
    }
    const snapped = snapRef.current ? snapRef.current(value) : value;
    setCursorDataValue(snapped);
  }, []);

  return {
    cursorDataValue,
    setCursor,
    pointerHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerLeave },
    isDragging,
  };
}

// ── Snap helpers ──────────────────────────────────────────────────────────────

/**
 * Snap a value to the nearest entry in a sorted ascending array.
 * Used by chart cursors when the chart has bucketed data (histogram
 * bins, S-curve buckets).
 */
export function snapToNearest(value: number, sortedPoints: readonly number[]): number {
  if (sortedPoints.length === 0) return value;
  if (sortedPoints.length === 1) return sortedPoints[0]!;
  if (value <= sortedPoints[0]!) return sortedPoints[0]!;
  if (value >= sortedPoints[sortedPoints.length - 1]!) {
    return sortedPoints[sortedPoints.length - 1]!;
  }
  // Binary search for the insertion index, then compare neighbours.
  let lo = 0;
  let hi = sortedPoints.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedPoints[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  const right = sortedPoints[lo]!;
  const left = sortedPoints[lo - 1] ?? right;
  return value - left <= right - value ? left : right;
}

/**
 * Snap an epoch-ms value to local midnight on the same day. Used by the
 * Gantt bars and Resources allocation timeline cursors (day-granularity
 * is the natural unit there).
 */
export function snapToLocalMidnight(epochMs: number): number {
  const d = new Date(epochMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
