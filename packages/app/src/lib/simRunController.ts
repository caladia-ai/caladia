/**
 * Module-level holder for the in-flight simulation's AbortController.
 *
 * Lives outside any component so:
 *
 *   1. `SimulateView` can unmount (tab switch, layout change) while the
 *      sim keeps running — the cancel button on remount still controls
 *      the right run.
 *   2. App-level handlers (project load, new project, template pick)
 *      can abort the previous project's in-flight sim without reaching
 *      into SimulateView's private state.
 *
 * One simulation is in flight at a time — a second `startSimRun()`
 * aborts the prior one before installing the new handle (audit I-24,
 * originally inlined in SimulateView, extracted here so the contract is
 * testable and reachable from App).
 */

let activeSimAbort: AbortController | null = null;

/**
 * Install a fresh AbortController for a new simulation run. If a prior
 * run is still in flight, abort it before replacing — without this, the
 * orphaned worker keeps consuming CPU until natural completion. Callers
 * pass the returned controller's `signal` to the worker API and pass the
 * controller itself to `clearSimControllerIfMatches` in the run's
 * `.finally()` block.
 */
export function startSimRun(): AbortController {
  if (activeSimAbort) activeSimAbort.abort();
  const next = new AbortController();
  activeSimAbort = next;
  return next;
}

/**
 * Abort the currently-in-flight simulation (if any). No-op when no run
 * is active. The aborted run's `.finally()` clears its slot via
 * `clearSimControllerIfMatches` once the worker rejects.
 *
 * Called from (a) SimulateView's Cancel button and (b) `App.handleProjectLoad`
 * — the latter so a sim in flight against the previous project doesn't
 * land as a stale-looking completed run after the user switches files.
 */
export function cancelActiveSim(): void {
  activeSimAbort?.abort();
}

/**
 * Clear the singleton iff it still references the supplied controller.
 * Guards against a late-arriving `finally` from a cancelled run wiping
 * out a *newer* run's controller — without the equality check, the
 * second click in a quick-replace sequence would lose its abort handle.
 */
export function clearSimControllerIfMatches(controller: AbortController): void {
  if (activeSimAbort === controller) activeSimAbort = null;
}

/**
 * Test-only accessor. Production code never reads the singleton
 * directly — callers either start a run, cancel, or clear-if-matches.
 */
export function __getActiveSimAbort(): AbortController | null {
  return activeSimAbort;
}
