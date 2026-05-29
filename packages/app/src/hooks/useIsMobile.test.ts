/**
 * Coverage for the pure subscription helper that backs `useIsMobile`.
 * The hook itself (useState + useEffect wrapping
 * `subscribeToMobileChange`) is React-shaped; app package has no
 * React-render testing infra. Testing the subscription module
 * covers the actual logic — the hook is a thin shell.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MOBILE_BREAKPOINT_PX,
  MOBILE_MEDIA_QUERY,
  subscribeToMobileChange,
} from './useIsMobile.js';

interface FakeMediaQueryList {
  matches: boolean;
  media: string;
  addEventListener: (type: 'change', listener: (e: MediaQueryListEvent) => void) => void;
  removeEventListener: (type: 'change', listener: (e: MediaQueryListEvent) => void) => void;
  /** Test-only: fire a synthetic change event from the test body. */
  __fire: (matches: boolean) => void;
}

function makeFakeMediaQuery(initialMatches: boolean): FakeMediaQueryList {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mq: FakeMediaQueryList = {
    matches: initialMatches,
    media: MOBILE_MEDIA_QUERY,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    __fire: (matches) => {
      mq.matches = matches;
      for (const l of listeners) {
        l({ matches } as MediaQueryListEvent);
      }
    },
  };
  return mq;
}

describe('subscribeToMobileChange', () => {
  it('fires the callback synchronously with the current match value', () => {
    const onChange = vi.fn();
    const fakeMq = makeFakeMediaQuery(true);
    const matchMediaImpl = vi.fn(() => fakeMq as unknown as MediaQueryList);

    subscribeToMobileChange(onChange, matchMediaImpl as typeof window.matchMedia);

    expect(matchMediaImpl).toHaveBeenCalledWith(MOBILE_MEDIA_QUERY);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('initial desktop viewport seeds `false`, then flips on resize-to-mobile', () => {
    const onChange = vi.fn();
    const fakeMq = makeFakeMediaQuery(false);
    const matchMediaImpl = vi.fn(() => fakeMq as unknown as MediaQueryList);

    subscribeToMobileChange(onChange, matchMediaImpl as typeof window.matchMedia);
    expect(onChange).toHaveBeenLastCalledWith(false);

    fakeMq.__fire(true);
    expect(onChange).toHaveBeenLastCalledWith(true);

    fakeMq.__fire(false);
    expect(onChange).toHaveBeenLastCalledWith(false);

    expect(onChange).toHaveBeenCalledTimes(3); // initial + two flips
  });

  it('cleanup detaches the listener — post-cleanup changes no longer fire onChange', () => {
    const onChange = vi.fn();
    const fakeMq = makeFakeMediaQuery(false);
    const matchMediaImpl = vi.fn(() => fakeMq as unknown as MediaQueryList);

    const unsubscribe = subscribeToMobileChange(
      onChange,
      matchMediaImpl as typeof window.matchMedia,
    );
    expect(onChange).toHaveBeenCalledTimes(1); // initial only

    unsubscribe();
    fakeMq.__fire(true);

    expect(onChange).toHaveBeenCalledTimes(1); // unchanged — listener was detached
  });
});

describe('MOBILE_BREAKPOINT_PX', () => {
  it("matches Tailwind's `md:` boundary (768)", () => {
    expect(MOBILE_BREAKPOINT_PX).toBe(768);
  });

  it('media query string uses (BREAKPOINT - 1) so 768 px is desktop, 767 px is mobile', () => {
    expect(MOBILE_MEDIA_QUERY).toBe('(max-width: 767px)');
  });
});
