import { useViewStore } from '../store/viewStore.js';

/**
 * Phase 50 Slice 9 / audit C-9 — persistent banner shown when an
 * autosave write fails (QuotaExceeded, Safari private-mode storage
 * block, generic IDB rejection, etc.).
 *
 * Pre-Slice-9 the autosave was fire-and-forget: a rejection from
 * `idb-keyval`'s `set` silently went nowhere, and the user kept
 * editing under the illusion of "I'm safe to close the tab when I'm
 * done". On close, the work was gone. This banner replaces that
 * silent loss with a visible warning + actionable text.
 *
 * The state lives in `viewStore.autosaveError`, set by
 * `lib/autosave.ts`'s `flush()` and cleared on the next successful
 * write. The user can also dismiss the banner manually; the next
 * failed write re-arms it.
 */
export function AutosaveDisabledBanner() {
  const autosaveError = useViewStore((s) => s.autosaveError);
  const setAutosaveError = useViewStore((s) => s.setAutosaveError);

  if (!autosaveError) return null;

  return (
    <div
      role="alert"
      className="shrink-0 bg-rose-50 dark:bg-rose-900/20 border-b border-rose-300 dark:border-rose-800 px-4 py-2 flex items-center gap-3"
    >
      <span className="text-rose-700 dark:text-rose-400 text-sm font-medium shrink-0">
        ⚠ Autosave failed
      </span>
      <span className="text-rose-700 dark:text-rose-400 text-xs">{autosaveError.message}</span>
      <div className="flex-1" />
      <button
        onClick={() => setAutosaveError(null)}
        className="shrink-0 text-xs text-rose-600 dark:text-rose-500 hover:text-rose-900 px-2"
        title="Dismiss (re-arms on the next failed autosave)"
        aria-label="Dismiss autosave warning"
      >
        ×
      </button>
    </div>
  );
}
