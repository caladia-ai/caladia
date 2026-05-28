import { useState } from 'react';
import { useDomainStore, beginEdit, commitEdit } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import { useSchedule } from '../hooks/useSchedule.js';
import { downloadSubsystemFile, sha256Hex, pickAndReadSubsystemFile } from '../fileio.js';
import { loadSubsystemFile, currencyGlyph, SCHEMA_LIMITS } from '@procsim/file-format';

interface SubsystemPanelProps {
  /** The container node ID of the subsystem. */
  nodeId: string;
  onClose: () => void;
}

/**
 * Property panel shown when a sub-system container node is selected.
 *
 * Provides:
 *  - Name editing
 *  - Entry / exit node display (read-only)
 *  - Drill-in shortcut
 *  - Unwrap action
 *  - Export as .calasub
 *  - Source provenance badge + update-from-source
 */
export function SubsystemPanel({ nodeId, onClose }: SubsystemPanelProps) {
  const project = useDomainStore((s) => s.project);
  const updateSubsystemName = useDomainStore((s) => s.updateSubsystemName);
  const updateNodeDescription = useDomainStore((s) => s.updateNodeDescription);
  const unwrapSubsystem = useDomainStore((s) => s.unwrapSubsystem);
  const buildSubsystemFile = useDomainStore((s) => s.buildSubsystemFile);
  const importSubsystemFromFile = useDomainStore((s) => s.importSubsystemFromFile);
  const drillIntoSubsystem = useViewStore((s) => s.drillIntoSubsystem);
  // Phase 19 — read deterministic cost rollup off the live schedule. When
  // the schedule has errors (`!ok`) we hide the row gracefully rather than
  // surfacing a stale number.
  const scheduleOutcome = useSchedule();

  const node = project.nodes.find((n) => n.id === nodeId);
  const sub = project.subsystems.find((s) => s.containerNodeId === nodeId);

  const [nameValue, setNameValue] = useState(node?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!node || !sub) return null;

  const entryNode = project.nodes.find((n) => n.id === sub.entryNodeId);
  const exitNode = project.nodes.find((n) => n.id === sub.exitNodeId);

  function handleNameBlur() {
    if (nameValue.trim() && nameValue !== node?.name) {
      updateSubsystemName(sub!.id, nameValue.trim());
    } else {
      setNameValue(node?.name ?? '');
    }
    // Audit I-20 — commitEdit MUST fire on both branches, otherwise the
    // edit session (opened by `onFocus={beginEdit}`) stays open after a
    // revert-blur. With temporal paused, any subsequent per-keystroke
    // session's mutations would coalesce into one undo step rooted at
    // the state before the original focus.
    commitEdit();
  }

  async function handleExport() {
    const file = buildSubsystemFile(sub!.id);
    if (!file) {
      setError('Could not build sub-system file.');
      return;
    }
    downloadSubsystemFile(file);
  }

  async function handleImportFromSource() {
    setError(null);
    setBusy(true);
    try {
      const picked = await pickAndReadSubsystemFile();
      if (!picked.ok) {
        if (picked.error) setError(picked.error);
        return;
      }

      const loadResult = loadSubsystemFile(picked.content);
      if (!loadResult.ok) {
        setError('Invalid .calasub file: ' + loadResult.errors.map((e) => e.message).join('; '));
        return;
      }

      const hash = await sha256Hex(picked.content);
      const now = new Date().toISOString();

      // Place the new import near the existing container node.
      const containerPos = node?.position ?? { x: 100, y: 100 };
      const newPos = { x: containerPos.x + 220, y: containerPos.y };

      const err = importSubsystemFromFile(loadResult.subsystem, newPos, {
        fileName: picked.fileName,
        contentHash: hash,
        importedAt: now,
        sourceName: loadResult.subsystem.name,
      });
      if (err) setError(err);
    } finally {
      setBusy(false);
    }
  }

  function handleUnwrap() {
    unwrapSubsystem(sub!.id);
    onClose();
  }

  function handleDrillIn() {
    drillIntoSubsystem(sub!.id, node?.name ?? 'Sub-system');
    onClose();
  }

  const hasSource = sub.source !== undefined;
  const sourceInfo = sub.source;

  // Phase 19 — aggregate cost rollup from the live schedule.
  const containerCost = scheduleOutcome.ok
    ? scheduleOutcome.result.nodeCosts[sub.containerNodeId]
    : undefined;
  // Empty-state: hide the row entirely when the project has no cost data
  // anywhere AND the container's rollup is zero — keeps the panel quiet
  // for projects that never adopt cost modelling.
  const projectHasCostData =
    project.resources.some((r) => (r.costRate ?? 0) > 0 || (r.costPerUse ?? 0) > 0) ||
    project.nodes.some((n) => n.fixedCost !== undefined);
  const showCost = projectHasCostData && containerCost !== undefined && containerCost.total > 0;
  const glyph = currencyGlyph(project.currency);
  const formattedCost = containerCost
    ? `${glyph}${(Math.round(containerCost.total * 100) / 100).toLocaleString()}`
    : '';

  return (
    <aside className="w-72 border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col overflow-y-auto shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <span className="text-sm font-semibold text-indigo-700 dark:text-indigo-300 flex items-center gap-1.5">
          <span className="text-base">⊞</span> Sub-system
        </span>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          aria-label="Close panel"
        >
          ×
        </button>
      </div>

      <div className="flex flex-col gap-4 px-4 py-4">
        {/* Name */}
        <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
          Name
          <input
            type="text"
            value={nameValue}
            className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            onFocus={() => beginEdit()}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={handleNameBlur}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        </label>

        {/* Description (free-text notes — Phase 35) */}
        <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-gray-400">
          Description
          <textarea
            value={node.description ?? ''}
            onFocus={beginEdit}
            onBlur={commitEdit}
            onChange={(e) => {
              const v = e.target.value;
              updateNodeDescription(nodeId, v === '' ? undefined : v);
            }}
            rows={4}
            // Audit N-11 — hard-cap at the schema truncation point.
            // The subsystem panel reuses NodeSchema's description so
            // SCHEMA_LIMITS.nodeDescription is the correct cap (not
            // subsystemNotes — that's a different field on the
            // subsystem-file root, not the container-node).
            maxLength={SCHEMA_LIMITS.nodeDescription}
            placeholder="What this sub-system models; assumptions; references"
            className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-y leading-snug"
          />
          <span
            className={
              ((node.description?.length ?? 0) > 2000
                ? 'text-amber-600 dark:text-amber-400 '
                : 'text-gray-400 dark:text-gray-500 ') + 'self-end tabular-nums'
            }
          >
            {node.description?.length ?? 0} / 2000
          </span>
        </label>

        {/* Entry / exit info */}
        <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
          <div className="flex justify-between">
            <span>Entry node</span>
            <span className="font-medium text-gray-700 dark:text-gray-200 truncate max-w-36">
              {entryNode?.name ?? sub.entryNodeId}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Exit node</span>
            <span className="font-medium text-gray-700 dark:text-gray-200 truncate max-w-36">
              {exitNode?.name ?? sub.exitNodeId}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Body nodes</span>
            <span className="font-medium text-gray-700 dark:text-gray-200">
              {sub.bodyNodeIds.length}
            </span>
          </div>
          {showCost && (
            <div
              className="flex justify-between"
              title="Sum of all body-node deterministic costs (resources + fixedCost), scaled by loop iterations where applicable."
            >
              <span>Aggregate cost</span>
              <span className="font-mono font-medium text-gray-700 dark:text-gray-200">
                {formattedCost}
              </span>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2">
          <button
            onClick={handleDrillIn}
            className="w-full rounded px-3 py-1.5 text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors flex items-center justify-center gap-1.5"
          >
            Drill in →
          </button>

          <button
            onClick={() => void handleExport()}
            className="w-full rounded px-3 py-1.5 text-sm font-medium border border-indigo-300 dark:border-indigo-600 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors"
          >
            Export .calasub
          </button>

          <button
            onClick={() => void handleImportFromSource()}
            disabled={busy}
            className="w-full rounded px-3 py-1.5 text-sm font-medium border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors"
          >
            {busy ? 'Importing…' : 'Import .calasub'}
          </button>

          <button
            onClick={handleUnwrap}
            className="w-full rounded px-3 py-1.5 text-sm font-medium border border-rose-300 dark:border-rose-700 text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
          >
            Unwrap sub-system
          </button>
        </div>

        {/* Source provenance */}
        {hasSource && sourceInfo && (
          <div className="rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs space-y-1">
            <div className="font-semibold text-amber-700 dark:text-amber-400">
              Imported from source
            </div>
            <div className="text-amber-600 dark:text-amber-500 truncate">{sourceInfo.fileName}</div>
            <div className="text-amber-500 dark:text-amber-600">
              {new Date(sourceInfo.importedAt).toLocaleDateString()}
            </div>
            <div className="font-mono text-[10px] text-amber-400 dark:text-amber-700 truncate">
              {sourceInfo.contentHash.slice(0, 16)}…
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 text-xs text-red-700 dark:text-red-400 flex items-start gap-2">
            <span className="flex-1">{error}</span>
            <button
              onClick={() => setError(null)}
              className="shrink-0 font-bold hover:text-red-900"
            >
              ×
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
