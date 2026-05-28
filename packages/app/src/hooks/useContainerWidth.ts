import { useEffect, useRef, useState } from 'react';

/**
 * Track the rendered width of a container via ResizeObserver.
 *
 * Used by SVG charts (`SimulateView` histogram + CDF, `ResourcesPanel`
 * stacked allocation) that want a `viewBox` matching the actual on-screen
 * width. Without this, the SVG renders at the natural viewBox size (e.g.
 * 720 units wide) inside a container that's actually 1500+ pixels wide,
 * and `preserveAspectRatio="xMidYMid meet"` then scales every `<text>`
 * inside the SVG along with the bars — making chart labels visibly larger
 * than the surrounding HTML text. Threading the measured width back as
 * the viewBox width keeps 1 viewBox-unit = 1 screen-pixel so `fontSize=13`
 * renders at the expected 13 px.
 *
 * Returns a ref + the latest measured width (defaults to `defaultWidth`
 * until the first measurement lands). Width is rounded and clamped at a
 * minimum so the chart's internal x-coordinate math doesn't collapse on
 * a transiently zero-width container.
 */
export function useContainerWidth(
  defaultWidth = 720,
  minWidth = 360,
): {
  ref: React.RefObject<HTMLDivElement>;
  width: number;
} {
  // Cast guards against the React-19 RefObject<T | null> type that doesn't
  // match the `ref` attribute's expected RefObject<T> shape in some
  // toolchains. The cast is safe because we always null-check inside the
  // effect before using ref.current.
  const ref = useRef<HTMLDivElement>(
    null as unknown as HTMLDivElement,
  ) as React.RefObject<HTMLDivElement>;
  const [width, setWidth] = useState<number>(defaultWidth);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Seed from the actual element so the first render after mount uses
    // the real width, not the default.
    const initial = el.getBoundingClientRect().width;
    if (initial > 0) setWidth(Math.max(minWidth, Math.round(initial)));

    const obs = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width;
        if (w > 0)
          setWidth((prev) => {
            const next = Math.max(minWidth, Math.round(w));
            return next === prev ? prev : next;
          });
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [minWidth]);

  return { ref, width };
}
