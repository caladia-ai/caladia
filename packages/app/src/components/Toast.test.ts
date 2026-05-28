/**
 * Audit N-13 — locks in the kind-relative dwell ordering.
 *
 * The Toast component itself is React-shaped; the app package has no
 * React-render testing infra (DOM, RTL, etc.) so this file tests the
 * exported `DWELL_MS_BY_KIND` constant directly. The constant is the
 * full contract — `ToastItem` reads it via a single lookup — so locking
 * it down covers the audit row's concern.
 */

import { describe, it, expect } from 'vitest';
import { DWELL_MS_BY_KIND } from './Toast.js';

describe('DWELL_MS_BY_KIND (audit N-13)', () => {
  it('errors linger longer than warnings', () => {
    expect(DWELL_MS_BY_KIND.error).toBeGreaterThan(DWELL_MS_BY_KIND.warn);
  });

  it('warnings linger longer than info / success', () => {
    expect(DWELL_MS_BY_KIND.warn).toBeGreaterThan(DWELL_MS_BY_KIND.info);
    expect(DWELL_MS_BY_KIND.warn).toBeGreaterThan(DWELL_MS_BY_KIND.success);
  });

  it('info and success share the quick-acknowledgement dwell', () => {
    // Same kind of message (positive / informational), same dwell.
    // If these ever diverge it should be a deliberate choice, not drift.
    expect(DWELL_MS_BY_KIND.info).toBe(DWELL_MS_BY_KIND.success);
  });

  it('all dwell values are positive integers below 30 seconds', () => {
    // Sanity-bracket — guards against accidental sub-second timeouts
    // (toast vanishes before the user reads it) or runaway values
    // (toast sticks around minutes after the trigger).
    for (const kind of Object.keys(DWELL_MS_BY_KIND) as Array<keyof typeof DWELL_MS_BY_KIND>) {
      const ms = DWELL_MS_BY_KIND[kind];
      expect(ms, `${kind} dwell`).toBeGreaterThan(500);
      expect(ms, `${kind} dwell`).toBeLessThan(30_000);
      expect(ms, `${kind} dwell`).toBe(Math.floor(ms));
    }
  });
});
