import type { ProjectFile } from '@procsim/file-format';
import { loadAutosaved } from './autosave.js';

/**
 * Discriminated result for the ErrorBoundary's "Download autosave snapshot"
 * button. The boundary branches on `kind` to render the right inline message
 * (none for `ready`, an explanation for `no-snapshot` / `error`).
 */
export type SnapshotResult =
  | { kind: 'ready'; project: ProjectFile }
  | { kind: 'no-snapshot' }
  | { kind: 'error'; reason: string };

/**
 * Wrap `loadAutosaved()` so the ErrorBoundary can branch cleanly on three
 * cases — autosave exists, no autosave, IDB rejected (Safari private mode,
 * quota, permission denial). `loadAutosaved` returns `null` for both
 * "no entry" and "Zod-invalid entry"; we collapse both into `no-snapshot`
 * because the boundary's user-visible message is the same: nothing to save.
 *
 * IDB rejection separately classifies as `error` so the user sees a
 * different message ("try reloading; the snapshot may still be intact").
 */
export async function prepareAutosaveDownload(): Promise<SnapshotResult> {
  try {
    const project = await loadAutosaved();
    if (!project) return { kind: 'no-snapshot' };
    return { kind: 'ready', project };
  } catch (err) {
    return {
      kind: 'error',
      reason: err instanceof Error ? err.message : 'Unknown error.',
    };
  }
}
