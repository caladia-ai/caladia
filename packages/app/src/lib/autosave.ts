import { get as idbGet, set as idbSet } from 'idb-keyval';
import { loadProjectFile, saveProjectFile } from '@procsim/file-format';
import type { ProjectFile } from '@procsim/file-format';
import { useDomainStore } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';

// Phase 11 — moved to a `caladia:` prefix to match the new brand and file
// extension. We still try the legacy key once on first load so users with
// in-flight autosaves don't lose their work across the upgrade.
const AUTOSAVE_KEY = 'caladia:autosave:v1';
const LEGACY_AUTOSAVE_KEY = 'procsim:autosave:v1';
// Audit I-16 — when `loadAutosaved` finds a stored blob that fails
// validation, the raw bytes are moved here so the next debounced
// write doesn't overwrite them. DevTools-savvy users can recover the
// blob from this key for inspection / manual repair.
const QUARANTINE_KEY = 'caladia:autosave:quarantine:v1';
const DEBOUNCE_MS = 1000;

export async function loadAutosaved(): Promise<ProjectFile | null> {
  let raw = await idbGet<string>(AUTOSAVE_KEY);
  let sourceKey: string = AUTOSAVE_KEY;
  if (typeof raw !== 'string') {
    // Fall back to the legacy procsim key. If found, surface the project
    // here; the next autosave write will land under the new key, after
    // which the legacy key is effectively orphaned (idb has no cleanup
    // hook, but the entry is harmless and we never read it again).
    const legacy = await idbGet<string>(LEGACY_AUTOSAVE_KEY);
    if (typeof legacy !== 'string') return null;
    raw = legacy;
    sourceKey = LEGACY_AUTOSAVE_KEY;
  }
  const result = loadProjectFile(raw);
  if (result.ok) return result.project;

  // Audit I-16 — pre-fix this path returned null and dropped both the
  // raw bytes and the validation errors on the floor. The user lost
  // recovery data with no breadcrumb. Now we (a) log the errors so
  // DevTools shows what failed, (b) move the bad blob to a quarantine
  // key so the next autosave write doesn't overwrite it, and (c)
  // surface a banner via viewStore so the user knows their last edit
  // wasn't restored.
  console.error(
    '[autosave] saved blob failed validation; preserved at IDB key ' +
      `"${QUARANTINE_KEY}" for inspection.`,
    result.errors,
  );
  try {
    await idbSet(QUARANTINE_KEY, raw);
    // Clear the bad blob from the active key so the next debounced
    // write doesn't immediately overwrite the quarantine on the next
    // edit (also avoids re-attempting the same bad parse on next
    // reload). Source could be either the v1 or legacy key.
    await idbSet(sourceKey, undefined);
  } catch (err) {
    // Quarantine itself failed (IDB is unavailable). Log but don't
    // crash bootstrap — the user can still proceed with a blank
    // project. The banner below still surfaces.
    console.error('[autosave] quarantine write failed:', err);
  }
  useViewStore
    .getState()
    .setAutosaveError(
      `Autosave couldn't be restored — the stored project failed validation. ` +
        `The original data is preserved in browser storage under ` +
        `"${QUARANTINE_KEY}" for inspection. Starting with a blank project.`,
    );
  return null;
}

export async function writeAutosave(project: ProjectFile): Promise<void> {
  await idbSet(AUTOSAVE_KEY, saveProjectFile(project));
}

/**
 * Phase 50 Slice 9 / audit C-9 — classify an autosave failure into a
 * short user-facing message. The banner stays generic ("Autosave
 * disabled — save manually before closing") for unrecognised
 * failure modes; well-known errors get a more specific hint so
 * users know whether the fix is "make space" vs "switch out of
 * private browsing".
 *
 * Exported for testing — production callers use `tryAutosave` below
 * which already classifies internally.
 */
export function classifyAutosaveError(err: unknown): string {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    if (err.name === 'QuotaExceededError') {
      return 'Autosave disabled — browser storage is full. Save to a .cala file before closing, or clear site data.';
    }
    if (err.name === 'SecurityError' || err.name === 'InvalidStateError') {
      // Safari private-mode and similar block IndexedDB writes with
      // SecurityError or InvalidStateError depending on the build.
      return 'Autosave disabled — browser storage is unavailable (private browsing?). Save to a .cala file before closing.';
    }
  }
  return 'Autosave disabled — your changes will not be retained. Save to a .cala file before closing.';
}

/**
 * Phase 50 Slice 9 / audit C-9 — write + update banner state in one
 * call. The persistent banner state lives on `viewStore.autosaveError`;
 * this helper sets it on failure (with a classified message) and
 * clears it on the next successful write after a failure.
 *
 * Exported for tests — production callers go through `startAutosave`.
 * Awaiting the returned promise is optional (the function swallows
 * the rejection internally; the side effect is the banner state).
 */
export async function tryAutosave(project: ProjectFile): Promise<void> {
  try {
    await writeAutosave(project);
    if (useViewStore.getState().autosaveError !== null) {
      useViewStore.getState().setAutosaveError(null);
    }
  } catch (err) {
    useViewStore.getState().setAutosaveError(classifyAutosaveError(err));
    // Also log to console so DevTools-savvy users can diagnose.
    console.error('Autosave failed:', err);
  }
}

/**
 * Subscribe to domain-store project changes and write an autosave snapshot
 * 1s after activity settles. Returns an unsubscribe function.
 *
 * Phase 50 Slice 9 / audit C-9 — autosave failures (QuotaExceeded,
 * Safari private-mode storage block, etc.) are no longer fire-and-
 * forget. On failure we surface a persistent banner via
 * `viewStore.setAutosaveError`; on the next successful write the
 * banner clears itself. Without this, a user whose browser refuses
 * IDB writes would silently lose every edit on tab close.
 */
export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: ProjectFile | null = null;

  const flush = () => {
    timer = null;
    if (pending) {
      const projectToWrite = pending;
      pending = null;
      void tryAutosave(projectToWrite);
    }
  };

  return useDomainStore.subscribe((state, prev) => {
    if (state.project === prev.project) return;
    pending = state.project;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  });
}
