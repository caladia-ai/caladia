import { useModalEscape } from '../hooks/useModalEscape.js';

interface ReplaceProjectConfirmModalProps {
  /** Label for the destructive-action button (e.g. "Open file…", "New project"). */
  actionLabel: string;
  /** Download the current project to disk, then proceed with the destructive action. */
  onSaveAndContinue: () => void;
  /** Run the destructive action without saving the current project first. */
  onProceedWithoutSaving: () => void;
  /** Close the modal without doing anything. Also fires on Esc / backdrop click. */
  onCancel: () => void;
}

/**
 * Shown before a destructive replace (Open / New / New from template /
 * Import) when the current project has user content. Two paths:
 *
 *   - Save to disk — downloads the current project as a .cala file
 *     and then runs the destructive action (one-click commitment).
 *   - {actionLabel} anyway — runs the destructive action without
 *     saving.
 *
 * Backdrop click, Esc, and the explicit × button all cancel.
 *
 * Modeled on Excalidraw's "Load from file" pre-flight dialog but
 * trimmed to two action paths per the feature request.
 */
export function ReplaceProjectConfirmModal({
  actionLabel,
  onSaveAndContinue,
  onProceedWithoutSaving,
  onCancel,
}: ReplaceProjectConfirmModalProps) {
  useModalEscape(onCancel);

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onCancel} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="replace-project-confirm-title"
        className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none p-4"
      >
        <div className="pointer-events-auto w-full max-w-lg flex flex-col rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-xl">
          <div className="flex items-start justify-between px-5 pt-4 pb-2">
            <h2
              id="replace-project-confirm-title"
              className="text-base font-semibold text-gray-900 dark:text-gray-100"
            >
              Replace existing project?
            </h2>
            <button
              type="button"
              onClick={onCancel}
              aria-label="Cancel"
              className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-xl leading-none -mt-0.5"
            >
              ×
            </button>
          </div>

          <div className="px-5 pb-4">
            <div className="flex gap-3 rounded-md border border-amber-200 dark:border-amber-700/40 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-900 dark:text-amber-100">
              <span aria-hidden className="text-lg leading-none mt-0.5">
                ⚠️
              </span>
              <p>
                Continuing will <strong>replace your current project</strong>. Save a copy first so
                you can come back to it.
              </p>
            </div>
          </div>

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 px-5 pb-5">
            <button
              type="button"
              onClick={onProceedWithoutSaving}
              className="px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              {actionLabel} without saving
            </button>
            <button
              type="button"
              onClick={onSaveAndContinue}
              autoFocus
              className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium"
            >
              Save to disk and continue
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
