import type { ReactNode } from 'react';
import type { ProjectFile } from '@procsim/file-format';
import { QuickStartTemplates } from './QuickStartTemplates.js';

interface OnboardingOverlayProps {
  /** Whether the overlay is shown — drives the fade in / out. */
  visible: boolean;
  /** Dismiss permanently ("Got it"). */
  onDismiss: () => void;
  /** Open the full template picker ("Browse templates"). */
  onBrowseTemplates: () => void;
  /** Load a quick-start template into the project. */
  onPickTemplate: (project: ProjectFile) => void;
}

/**
 * First-run welcome over the empty canvas — Excalidraw-style. Anchored
 * top-left by the rail (so the "Add a step → +" tip sits next to the actual
 * + button). The welcome card carries the orientation tips; a quick-start
 * box sits beside it on desktop for one-click starter templates (hidden on
 * mobile, where the card's "Browse templates" covers it).
 *
 * AppShell mounts it on the canvas tab and toggles `visible`; the opacity
 * transition eases it away when the user dismisses it or adds their first
 * node. The wrapper is `pointer-events-none` so the canvas and rail stay
 * usable behind it — only the boxes capture clicks.
 */
export function OnboardingOverlay({
  visible,
  onDismiss,
  onBrowseTemplates,
  onPickTemplate,
}: OnboardingOverlayProps) {
  const interactivity = visible ? 'pointer-events-auto' : 'pointer-events-none';
  return (
    <div
      className={`absolute inset-0 z-30 flex items-start justify-start gap-3 pt-4 pr-4 pb-4 pl-20 pointer-events-none transition-opacity duration-300 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
      aria-hidden={!visible}
    >
      {/* Welcome card */}
      <div
        className={`${interactivity} w-80 max-w-full shrink-0 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl p-5`}
      >
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          Welcome to Caladia
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
          Model any process as a block diagram and get a live Gantt chart plus Monte Carlo what-ifs
          &mdash; all in your browser.
        </p>
        <ul className="mt-3 flex flex-col gap-2 text-sm text-gray-700 dark:text-gray-300">
          <li className="flex gap-2">
            <span aria-hidden>➕</span>
            <span>
              <strong>Add a step</strong> &mdash;{' '}
              <span className="max-md:hidden">
                press <Kbd>A</Kbd> or click <strong>+</strong> in the toolbar
              </span>
              <span className="md:hidden">
                tap the <strong>🧰</strong> tools button, then <strong>+</strong>
              </span>
              .
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden>🔗</span>
            <span>
              <strong>Connect steps</strong> &mdash; drag from a node&rsquo;s side handle to another
              node.
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden>📊</span>
            <span>
              <strong>See the schedule</strong> &mdash; open the <strong>Gantt</strong> tab.
            </span>
          </li>
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onBrowseTemplates}
            className="px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            Browse all templates
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="px-3 py-1.5 text-sm rounded-md font-medium bg-emerald-600 hover:bg-emerald-700 text-white transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>

      {/* Quick-start templates — desktop only; mobile uses "Browse templates". */}
      <div className={`${interactivity} flex-1 min-w-0 max-w-3xl max-md:hidden`}>
        <QuickStartTemplates active={visible} onPick={onPickTemplate} />
      </div>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="px-1 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-[11px] font-mono text-gray-700 dark:text-gray-300">
      {children}
    </kbd>
  );
}
