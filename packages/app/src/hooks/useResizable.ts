import { useState, useCallback, useRef } from 'react';

/**
 * Returns a width value and a mousedown handler for a drag-to-resize edge.
 * Intended for a panel on the right side of the screen: dragging its left
 * edge leftward increases width, rightward decreases it.
 */
export function useResizable(defaultWidth: number, min = 200, max = 800) {
  const [width, setWidth] = useState(defaultWidth);
  const widthRef = useRef(defaultWidth);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = widthRef.current;

      const onMouseMove = (ev: MouseEvent) => {
        const delta = startX - ev.clientX; // left = wider
        const next = Math.max(min, Math.min(max, startWidth + delta));
        widthRef.current = next;
        setWidth(next);
      };

      const onMouseUp = () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [min, max],
  );

  return { width, onMouseDown };
}
