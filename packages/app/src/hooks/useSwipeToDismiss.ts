import { useRef } from 'react';
import type { TouchEvent } from 'react';

const DISMISS_THRESHOLD_PX = 50;

/**
 * Swipe-down-to-dismiss for the mobile bottom-sheet panels. Spread the
 * returned handlers onto the sheet's `md:hidden` drag-pill container: a touch
 * that travels >= 50 px downward before release calls `onDismiss`.
 *
 * Attaching to the pill (not the sheet wrapper) keeps the gesture inert on
 * desktop — the pill is `md:hidden` — and free of scroll conflict, since the
 * pill is only reachable when the sheet is scrolled to the top.
 */
export function useSwipeToDismiss(onDismiss: () => void) {
  const startY = useRef<number | null>(null);
  return {
    onTouchStart: (e: TouchEvent) => {
      startY.current = e.touches[0]?.clientY ?? null;
    },
    onTouchEnd: (e: TouchEvent) => {
      if (startY.current === null) return;
      const endY = e.changedTouches[0]?.clientY ?? startY.current;
      if (endY - startY.current >= DISMISS_THRESHOLD_PX) onDismiss();
      startY.current = null;
    },
  };
}
