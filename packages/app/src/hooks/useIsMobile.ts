/**
 * Mobile-viewport detection. Single source of truth for "is the user
 * on a phone-sized screen?" across the app — subsequent mobile-
 * optimisation slices (header collapse, bottom-sheet inspector, touch
 * pan/zoom, touch-target bumps) key off this hook.
 *
 * The breakpoint matches Tailwind's `md:` boundary (≥ 768 px), so a
 * `useIsMobile()` of `true` is exactly the viewport range where
 * `max-md:` Tailwind utilities apply. Keeping the JS and CSS sides on
 * the same number means a single source of truth — bump
 * `MOBILE_BREAKPOINT_PX` here AND `theme.screens.md` in
 * `tailwind.config` together if you ever need to move it.
 *
 * App package has no React-render testing infra (no jsdom, no RTL),
 * so the testable surface is the pure subscription helper
 * `subscribeToMobileChange` below — the hook is a thin
 * `useState + useEffect` wrapper over it. See `useIsMobile.test.ts`.
 */

import { useEffect, useState } from 'react';

/** Below this width, in CSS pixels, we treat the viewport as mobile. */
export const MOBILE_BREAKPOINT_PX = 768;

/**
 * `(max-width: 767px)` matches viewports strictly narrower than the
 * 768-px Tailwind `md` boundary. At exactly 768 px (the smallest
 * desktop / tablet width where `md:` utilities take effect), this
 * does NOT match — we're considered desktop. Matches the CSS-side
 * boundary exactly.
 */
export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`;

/**
 * Subscribe to mobile-viewport changes. Calls `onChange` immediately
 * with the current value and on every breakpoint crossing thereafter.
 * Returns a cleanup function that detaches the listener.
 *
 * `matchMediaImpl` is injectable for tests; in production it defaults
 * to `window.matchMedia`. Exported separately so tests can exercise
 * the subscription wiring without rendering React.
 */
export function subscribeToMobileChange(
  onChange: (isMobile: boolean) => void,
  matchMediaImpl: typeof window.matchMedia = window.matchMedia.bind(window),
): () => void {
  const mq = matchMediaImpl(MOBILE_MEDIA_QUERY);
  onChange(mq.matches);
  const listener = (e: MediaQueryListEvent): void => onChange(e.matches);
  mq.addEventListener('change', listener);
  return () => mq.removeEventListener('change', listener);
}

/**
 * React hook returning `true` when the viewport is below the mobile
 * breakpoint. Re-renders the calling component on every breakpoint
 * crossing.
 *
 * Initial value during the first render is `false` (desktop default).
 * On mount, the effect synchronously sets the real value before paint
 * — so a mobile user sees mobile-shaped UI from the first commit,
 * not a flash of desktop layout.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => subscribeToMobileChange(setIsMobile), []);
  return isMobile;
}
