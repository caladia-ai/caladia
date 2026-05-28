/**
 * Unit tests for the module-level simulation-run controller.
 *
 * The contract this module owns:
 *
 *   - At most one AbortController is "active" at a time.
 *   - `startSimRun()` aborts the prior active controller before
 *     installing a new one. Closes audit I-24 (originally inlined in
 *     SimulateView with the same semantics — the extraction here makes
 *     the contract testable and reachable from App-level handlers).
 *   - `cancelActiveSim()` aborts the current controller without
 *     installing a new one.
 *   - `clearSimControllerIfMatches(c)` clears the slot only if it still
 *     references `c` — guards against a late-arriving `finally` from a
 *     cancelled run clobbering a newer run's controller.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  startSimRun,
  cancelActiveSim,
  clearSimControllerIfMatches,
  __getActiveSimAbort,
} from './simRunController.js';

describe('simRunController', () => {
  beforeEach(() => {
    // Reset module state between tests. Cancel anything that might be
    // active, then clear the slot.
    const c = __getActiveSimAbort();
    if (c) {
      cancelActiveSim();
      clearSimControllerIfMatches(c);
    }
  });

  it('startSimRun returns a new AbortController and installs it as active', () => {
    const c = startSimRun();
    expect(c).toBeInstanceOf(AbortController);
    expect(c.signal.aborted).toBe(false);
    expect(__getActiveSimAbort()).toBe(c);
  });

  it('audit I-24: a second startSimRun aborts the previous controller', () => {
    const first = startSimRun();
    expect(first.signal.aborted).toBe(false);
    const second = startSimRun();
    // Prior run's signal flipped to aborted.
    expect(first.signal.aborted).toBe(true);
    // The slot now points at the new controller, which is itself idle.
    expect(__getActiveSimAbort()).toBe(second);
    expect(second.signal.aborted).toBe(false);
  });

  it('cancelActiveSim aborts the current controller', () => {
    const c = startSimRun();
    cancelActiveSim();
    expect(c.signal.aborted).toBe(true);
    // Slot still points at it — the caller is expected to clear via
    // clearSimControllerIfMatches in its .finally().
    expect(__getActiveSimAbort()).toBe(c);
  });

  it('cancelActiveSim is a no-op when no run is active', () => {
    expect(__getActiveSimAbort()).toBeNull();
    expect(() => cancelActiveSim()).not.toThrow();
    expect(__getActiveSimAbort()).toBeNull();
  });

  it('clearSimControllerIfMatches clears the slot only when the argument matches', () => {
    const c = startSimRun();
    expect(__getActiveSimAbort()).toBe(c);
    clearSimControllerIfMatches(c);
    expect(__getActiveSimAbort()).toBeNull();
  });

  it('clearSimControllerIfMatches is a no-op for a stale controller (late finally guard)', () => {
    // Scenario: run A starts, run B starts (aborting A), A's late
    // finally fires with its own controller. Without the equality
    // check, that finally would wipe out B's controller.
    const a = startSimRun();
    const b = startSimRun();
    clearSimControllerIfMatches(a);
    // B's slot survives.
    expect(__getActiveSimAbort()).toBe(b);
  });
});
