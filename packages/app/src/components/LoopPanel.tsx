/**
 * LoopPanel — right-side panel shown when a loop group is selected.
 */
import { useMemo } from 'react';
import { SCHEMA_LIMITS, type Loop, type Distribution } from '@procsim/file-format';
import { useDomainStore, beginEdit, commitEdit } from '../store/domainStore.js';
import { GroupAutocomplete } from './GroupAutocomplete.js';
import { NumericInput } from './NumericInput.js';
import { computeAllGroupNames, autoGroupColor } from '../utils/groupColors.js';

interface LoopPanelProps {
  loopId: string;
  onClose(): void;
}

export function LoopPanel({ loopId, onClose }: LoopPanelProps) {
  const project = useDomainStore((s) => s.project);
  const deleteLoop = useDomainStore((s) => s.deleteLoop);
  const updateLoopKickout = useDomainStore((s) => s.updateLoopKickout);
  const updateLoopExpectedIterations = useDomainStore((s) => s.updateLoopExpectedIterations);
  const updateLoopGroup = useDomainStore((s) => s.updateLoopGroup);
  const updateLoopDescription = useDomainStore((s) => s.updateLoopDescription);

  // Audit I-18 — group colors moved to domainStore (project.groupColors),
  // so the override persists across reload + threads through undo.
  const groupColors = useDomainStore((s) => s.project.groupColors);
  const setGroupColor = useDomainStore((s) => s.updateGroupColor);

  const loop = project.loops.find((l) => l.id === loopId);
  if (!loop) return null;

  const nodeMap = new Map(project.nodes.map((n) => [n.id, n]));

  // All unique group names (nodes + loops) sorted — for autocomplete + palette
  const allGroupNames = useMemo(
    () => computeAllGroupNames(project.nodes, project.loops),
    [project.nodes, project.loops],
  );

  // Resolved color for the loop's current group
  const resolvedGroupColor = loop.group
    ? (groupColors[loop.group] ?? autoGroupColor(loop.group, allGroupNames))
    : null;

  function handleDelete() {
    deleteLoop(loopId);
    onClose();
  }

  return (
    <div className="w-72 border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col overflow-y-auto shrink-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-700">
        <span className="text-violet-600 dark:text-violet-400 font-medium text-sm flex-1">
          ↻ Loop
        </span>
        <button
          onClick={handleDelete}
          className="text-red-400 hover:text-red-600 text-sm px-1"
          title="Delete loop (nodes are kept)"
        >
          🗑
        </button>
        <button
          onClick={onClose}
          className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-sm px-1"
          aria-label="Close loop panel"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-col gap-4 px-4 py-3">
        {/* Body nodes */}
        <section>
          <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
            Body nodes ({loop.bodyNodeIds.length})
          </h3>
          <ul className="space-y-1">
            {loop.bodyNodeIds.map((id) => {
              const node = nodeMap.get(id);
              return (
                <li
                  key={id}
                  className="text-sm text-gray-700 dark:text-gray-300 flex items-center gap-2"
                >
                  <span className="w-2 h-2 rounded-full bg-violet-400 shrink-0" />
                  {node?.name ?? (
                    <span className="italic text-gray-400 dark:text-gray-500">{id}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        {/* Group (swimlane) */}
        <section>
          <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
            Group
          </h3>
          <div className="flex items-center gap-2">
            <GroupAutocomplete
              value={loop.group ?? ''}
              suggestions={allGroupNames}
              placeholder="e.g. Design Phase"
              inputClassName="flex-1 text-sm border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-violet-400"
              onFocus={beginEdit}
              onCommit={(v) => {
                commitEdit();
                updateLoopGroup(loopId, v);
              }}
            />
            {loop.group && resolvedGroupColor && (
              <input
                type="color"
                value={resolvedGroupColor}
                onChange={(e) => setGroupColor(loop.group!, e.target.value)}
                title={`Color for "${loop.group}" group (shared with all items in this group)`}
                className="h-8 w-8 shrink-0 rounded cursor-pointer p-0.5 border border-gray-200 dark:border-gray-600"
              />
            )}
          </div>
        </section>

        {/* Description (free-text notes — Phase 35) */}
        <section>
          <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
            Description
          </h3>
          <textarea
            value={loop.description ?? ''}
            onFocus={beginEdit}
            onBlur={commitEdit}
            onChange={(e) => {
              const v = e.target.value;
              updateLoopDescription(loopId, v === '' ? undefined : v);
            }}
            rows={4}
            // Audit N-11 — hard-cap at the schema truncation point.
            maxLength={SCHEMA_LIMITS.loopDescription}
            placeholder="What the loop models; iteration logic; kickout rationale"
            className="w-full text-sm border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-violet-400 resize-y leading-snug"
          />
          <div className="flex justify-end">
            <span
              className={
                (loop.description?.length ?? 0) > 2000
                  ? 'text-xs text-amber-600 dark:text-amber-400 tabular-nums'
                  : 'text-xs text-gray-400 dark:text-gray-500 tabular-nums'
              }
            >
              {loop.description?.length ?? 0} / 2000
            </span>
          </div>
        </section>

        <KickoutEditor loop={loop} onUpdate={(k) => updateLoopKickout(loopId, k)} />
        <ExpectedIterationsEditor
          loop={loop}
          onUpdate={(d) => updateLoopExpectedIterations(loopId, d)}
        />
      </div>
    </div>
  );
}

// ── Kickout condition editor ──────────────────────────────────────────────────

interface KickoutEditorProps {
  loop: Loop;
  onUpdate(kickout: Loop['kickout']): void;
}

const KICKOUT_TYPES = [
  { value: 'maxIterations', label: 'Max Iterations' },
  { value: 'timeBudget', label: 'Time Budget (h)' },
  { value: 'convergenceCriterion', label: 'Convergence Criterion' },
  { value: 'externalTrigger', label: 'External Trigger' },
] as const;

function KickoutEditor({ loop, onUpdate }: KickoutEditorProps) {
  const k = loop.kickout;

  function handleTypeChange(type: Loop['kickout']['type']) {
    // I-17 — flush any in-flight edit session on a sibling field
    // before this discrete kickout-type change.
    commitEdit();
    switch (type) {
      case 'maxIterations':
        onUpdate({ type, value: k.type === 'maxIterations' ? k.value : 3 });
        break;
      case 'timeBudget':
        onUpdate({ type, value: k.type === 'timeBudget' ? k.value : 40 });
        break;
      case 'convergenceCriterion':
        onUpdate({ type, threshold: k.type === 'convergenceCriterion' ? k.threshold : 0.01 });
        break;
      case 'externalTrigger':
        onUpdate({
          type,
          description: k.type === 'externalTrigger' ? k.description : 'Approval received',
        });
        break;
    }
  }

  const inputCls =
    'text-sm border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-violet-400';

  return (
    <section>
      <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
        Kickout Condition
      </h3>
      <select
        value={k.type}
        onChange={(e) => handleTypeChange(e.target.value as Loop['kickout']['type'])}
        className={`w-full mb-2 ${inputCls}`}
      >
        {KICKOUT_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>

      {k.type === 'maxIterations' && (
        <LabeledNumber
          label="Iterations"
          value={k.value}
          min={1}
          step={1}
          onChange={(v) => onUpdate({ type: 'maxIterations', value: Math.max(1, Math.round(v)) })}
        />
      )}
      {k.type === 'timeBudget' && (
        <LabeledNumber
          label="Budget (h)"
          value={k.value}
          min={0.1}
          step={1}
          onChange={(v) => onUpdate({ type: 'timeBudget', value: Math.max(0.1, v) })}
        />
      )}
      {k.type === 'convergenceCriterion' && (
        <LabeledNumber
          label="Threshold"
          value={k.threshold}
          min={0.0001}
          step={0.01}
          onChange={(v) =>
            onUpdate({ type: 'convergenceCriterion', threshold: Math.max(0.0001, v) })
          }
        />
      )}
      {k.type === 'externalTrigger' && (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500 dark:text-gray-400">Description</label>
          <input
            type="text"
            value={k.description}
            onFocus={beginEdit}
            onBlur={commitEdit}
            onChange={(e) => onUpdate({ type: 'externalTrigger', description: e.target.value })}
            className={`w-full ${inputCls}`}
          />
        </div>
      )}
    </section>
  );
}

// ── Expected iterations distribution editor ───────────────────────────────────

interface ExpectedIterationsEditorProps {
  loop: Loop;
  onUpdate(dist: Distribution): void;
}

const DIST_TYPES = [
  { value: 'triangular', label: 'Triangular' },
  { value: 'pert-beta', label: 'PERT-Beta' },
  { value: 'normal', label: 'Normal' },
] as const;

function ExpectedIterationsEditor({ loop, onUpdate }: ExpectedIterationsEditorProps) {
  const d = loop.expectedIterations;

  function handleTypeChange(type: Distribution['type']) {
    // I-17 — flush any in-flight edit session before this discrete
    // distribution-type change.
    commitEdit();
    switch (type) {
      case 'triangular':
      case 'pert-beta': {
        const mode = d.type === 'triangular' || d.type === 'pert-beta' ? d.mode : d.mean;
        onUpdate({ type, min: Math.max(1, mode - 2), mode, max: mode + 2 });
        break;
      }
      case 'normal': {
        const mean =
          d.type === 'normal'
            ? d.mean
            : d.type === 'triangular' || d.type === 'pert-beta'
              ? d.mode
              : 3;
        onUpdate({ type, mean, stddev: Math.max(0.1, mean * 0.3) });
        break;
      }
    }
  }

  const inputCls =
    'text-sm border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 rounded px-2 py-1 w-full focus:outline-none focus:ring-1 focus:ring-violet-400';

  return (
    <section>
      <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
        Expected Iterations
      </h3>
      <select
        value={d.type}
        onChange={(e) => handleTypeChange(e.target.value as Distribution['type'])}
        className={`w-full mb-2 ${inputCls}`}
      >
        {DIST_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>

      {(d.type === 'triangular' || d.type === 'pert-beta') && (
        <div className="grid grid-cols-3 gap-2">
          {(['min', 'mode', 'max'] as const).map((field) => (
            <div key={field} className="flex flex-col gap-0.5">
              <label className="text-xs text-gray-400 dark:text-gray-500 capitalize">{field}</label>
              <NumericInput
                value={d[field]}
                min={field === 'min' ? 1 : -Infinity}
                step={0.5}
                onCommit={(v) => onUpdate({ ...d, [field]: v })}
                className={inputCls}
              />
            </div>
          ))}
        </div>
      )}

      {d.type === 'normal' && (
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['mean', 'Mean', 0.1],
              ['stddev', 'Std Dev', 0.01],
            ] as const
          ).map(([field, label, minVal]) => (
            <div key={field} className="flex flex-col gap-0.5">
              <label className="text-xs text-gray-400 dark:text-gray-500">{label}</label>
              <NumericInput
                value={d[field]}
                min={minVal}
                step={0.5}
                onCommit={(v) => onUpdate({ ...d, [field]: v })}
                className={inputCls}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Shared number input ───────────────────────────────────────────────────────
//
// Thin wrapper around `NumericInput`: adds the per-row label box plus
// the Loop-panel violet focus ring. Phase 50 Slice 22 / audit I-19
// dropped the prior local-draft + commit-on-blur logic in favour of
// `NumericInput`'s shared per-keystroke commit + draft-string focus
// protection (Backspace-to-clear now works).

interface LabeledNumberProps {
  label: string;
  value: number;
  min?: number;
  step?: number;
  onChange(v: number): void;
}

function LabeledNumber({ label, value, min, step, onChange }: LabeledNumberProps) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-gray-500 dark:text-gray-400 w-24 shrink-0">{label}</label>
      <NumericInput
        value={value}
        {...(min !== undefined ? { min } : {})}
        {...(step !== undefined ? { step } : {})}
        onCommit={onChange}
        className="text-sm border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 rounded px-2 py-1 flex-1 min-w-0 focus:outline-none focus:ring-1 focus:ring-violet-400"
      />
    </div>
  );
}
