import { useMemo, useState } from 'react';
import type { ProjectFile } from '@procsim/file-format';
import {
  LATEST_BUNDLED_SNAPSHOT,
  listBundledSnapshotVersions,
  loadFxSnapshot,
} from '@procsim/file-format';
import { useDomainStore } from '../store/domainStore.js';

/**
 * Phase 19 slice 4 — FX update banner.
 *
 * Surfaces when the project's pinned `fxSnapshotVersion` is older than
 * `LATEST_BUNDLED_SNAPSHOT.version`. Same dismissal model as the holiday-
 * preset banner: per-session dismissal; re-shows on next load until
 * accepted or the project pin is bumped some other way.
 *
 * Click "Review" → modal showing a rate-by-rate diff between the current
 * pin and the latest snapshot. Accept re-pins via the domain-store action.
 *
 * Hidden when:
 *   - project.fxSnapshotVersion === LATEST_BUNDLED_SNAPSHOT.version,
 *   - project.fxSnapshotVersion === 'NONE' (user opted out),
 *   - project.fxSnapshotVersion is unknown to this build (forward-compat;
 *     never suggest downgrading).
 *
 * Mirrors the detection logic in load.ts's `collectFxUpdate` so the
 * banner is consistent whether the project was just loaded or has been
 * sitting open since startup.
 */
export function FxUpdateBanner({ project }: { project: ProjectFile }) {
  const updateProjectFxSnapshotVersion = useDomainStore((s) => s.updateProjectFxSnapshotVersion);
  const [dismissed, setDismissed] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  const currentVersion = project.fxSnapshotVersion;
  const latestVersion = LATEST_BUNDLED_SNAPSHOT.version;

  const shouldShow = useMemo(() => {
    if (currentVersion === 'NONE') return false;
    if (currentVersion === latestVersion) return false;
    if (!listBundledSnapshotVersions().includes(currentVersion)) return false;
    return true;
  }, [currentVersion, latestVersion]);

  if (!shouldShow || dismissed) return null;

  function handleAccept(): void {
    updateProjectFxSnapshotVersion(latestVersion);
    setReviewing(false);
  }

  return (
    <>
      <div className="shrink-0 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800 px-4 py-2 flex items-center gap-3">
        <span className="text-amber-700 dark:text-amber-400 text-sm font-medium shrink-0">
          ⚠ Currency rates updated
        </span>
        <span className="text-amber-700 dark:text-amber-400 text-xs">
          This project pins FX snapshot <span className="font-mono">{currentVersion}</span>; a newer
          snapshot <span className="font-mono">{latestVersion}</span> is bundled with this build.
          Re-pin to refresh display conversions.
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setReviewing(true)}
          className="shrink-0 text-xs text-amber-700 dark:text-amber-400 hover:text-amber-900 underline"
        >
          Review…
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="shrink-0 text-xs text-amber-600 dark:text-amber-500 hover:text-amber-900 px-2"
          title="Dismiss for this session"
        >
          ×
        </button>
      </div>

      {reviewing && (
        <FxDiffModal
          currentVersion={currentVersion}
          latestVersion={latestVersion}
          onAccept={handleAccept}
          onCancel={() => setReviewing(false)}
        />
      )}
    </>
  );
}

function FxDiffModal({
  currentVersion,
  latestVersion,
  onAccept,
  onCancel,
}: {
  currentVersion: string;
  latestVersion: string;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const current = loadFxSnapshot(currentVersion);
  const latest = loadFxSnapshot(latestVersion);

  // If either snapshot is missing (shouldn't happen — banner gates on
  // listBundledSnapshotVersions.includes) bail out with a friendly note.
  if (current === null || latest === null) {
    return (
      <>
        <div className="fixed inset-0 z-50 bg-black/50" onClick={onCancel} />
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="pointer-events-auto w-full max-w-md rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-xl p-5">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              Snapshot data missing — can&rsquo;t show the diff.
            </p>
            <div className="mt-4 flex justify-end">
              <button
                onClick={onCancel}
                className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  // Diff rows: every currency present in EITHER snapshot, sorted alpha.
  const allCodes = new Set<string>([...Object.keys(current.rates), ...Object.keys(latest.rates)]);
  const rows = [...allCodes].sort();

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onCancel} aria-hidden />
      <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
        <div className="pointer-events-auto w-full max-w-lg rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-xl">
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-gray-800">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              Re-pin FX snapshot
            </h2>
            <button
              onClick={onCancel}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 text-lg leading-none"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div className="px-5 py-4 flex flex-col gap-3">
            <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">
              Re-pinning updates the conversion rates Caladia uses to render cost totals in your
              chosen display currency. Authoring values and engine computations stay in the
              project&rsquo;s native currency ({current.base}) — only display labels change.
            </p>

            <div className="rounded border border-gray-200 dark:border-gray-700 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400">
                  <tr>
                    <th className="text-left px-3 py-1.5 font-medium">Currency</th>
                    <th className="text-right px-3 py-1.5 font-medium font-mono">
                      {currentVersion}
                    </th>
                    <th className="text-right px-3 py-1.5 font-medium font-mono">
                      {latestVersion}
                    </th>
                    <th className="text-right px-3 py-1.5 font-medium">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((code) => {
                    const oldRate = current.rates[code];
                    const newRate = latest.rates[code];
                    const delta =
                      oldRate !== undefined && newRate !== undefined
                        ? ((newRate - oldRate) / oldRate) * 100
                        : null;
                    const deltaTone =
                      delta === null
                        ? 'text-gray-400'
                        : Math.abs(delta) < 0.5
                          ? 'text-gray-500'
                          : delta > 0
                            ? 'text-amber-700 dark:text-amber-400'
                            : 'text-emerald-700 dark:text-emerald-400';
                    return (
                      <tr key={code} className="border-t border-gray-100 dark:border-gray-800">
                        <td className="px-3 py-1.5 font-mono text-gray-700 dark:text-gray-300">
                          {code}
                        </td>
                        <td className="text-right px-3 py-1.5 font-mono tabular-nums text-gray-600 dark:text-gray-400">
                          {oldRate?.toFixed(4) ?? '—'}
                        </td>
                        <td className="text-right px-3 py-1.5 font-mono tabular-nums text-gray-700 dark:text-gray-200">
                          {newRate?.toFixed(4) ?? '—'}
                        </td>
                        <td
                          className={`text-right px-3 py-1.5 font-mono tabular-nums ${deltaTone}`}
                        >
                          {delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(2)}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <p className="text-[11px] text-gray-400 dark:text-gray-500">
              {latest.windowDescription}
            </p>
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60">
            <button
              onClick={onCancel}
              className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-800"
            >
              Cancel
            </button>
            <button
              onClick={onAccept}
              className="rounded bg-emerald-600 hover:bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white"
            >
              Re-pin to {latestVersion}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
