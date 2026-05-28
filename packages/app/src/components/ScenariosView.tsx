/**
 * ScenariosView — deterministic "what-if" scenario editor.
 *
 * Shows a list of user-created scenarios on the left. The right panel lets
 * you override individual node durations and immediately see how the CPM
 * schedule compares to the baseline (current project, no overrides).
 *
 * This is the deterministic counterpart to the Monte Carlo tab. It just runs
 * `schedule()` twice and diffs the results — no sampling involved.
 */
import { useState, useMemo, useEffect } from 'react';
import type {
  ProjectFile,
  Scenario,
  Duration,
  DurationUnit,
  ProjectNode,
  Calendar,
} from '@procsim/file-format';
import { convertResourceCostsToProjectCurrency } from '@procsim/file-format';
import { schedule } from '@procsim/scheduler';
import type { ScheduleOutcome } from '@procsim/scheduler';
import { workingHoursBetween } from '@procsim/calendar';
import { useDomainStore, beginEdit, commitEdit } from '../store/domainStore.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: Date): string {
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function runSchedule(project: ProjectFile): ScheduleOutcome {
  return schedule({
    project: project.project,
    nodes: project.nodes,
    edges: project.edges,
    // Phase 33 Slice 2 — convert per-resource costs from override
    // currency to project currency before the engine sees them.
    resources: convertResourceCostsToProjectCurrency(project),
    calendars: project.calendars,
    loops: project.loops,
  });
}

/**
 * Apply a scenario's nodeOverrides to the baseline project, producing a
 * modified ProjectFile for a deterministic CPM run.
 */
function applyScenarioOverrides(project: ProjectFile, scenario: Scenario): ProjectFile {
  return {
    ...project,
    nodes: project.nodes.map((n): ProjectNode => {
      const override = scenario.nodeOverrides[n.id];
      if (!override) return n;
      return {
        ...n,
        ...(override.duration !== undefined ? { duration: override.duration } : {}),
      };
    }),
  };
}

// ── Root component ────────────────────────────────────────────────────────────

interface ScenariosViewProps {
  project: ProjectFile;
}

export function ScenariosView({ project }: ScenariosViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const addScenario = useDomainStore((s) => s.addScenario);
  const deleteScenario = useDomainStore((s) => s.deleteScenario);

  const scenarios = project.scenarios;

  // Keep selection valid when scenarios change (e.g. undo deleted one)
  const selectedScenario = selectedId ? (scenarios.find((s) => s.id === selectedId) ?? null) : null;

  function handleAddScenario() {
    const name = `Scenario ${scenarios.length + 1}`;
    // Audit I-12 — RNG seed computed at the UI boundary; the domain
    // mutation receives the value as an argument so the store stays
    // deterministic given its inputs.
    const seed = Math.floor(Math.random() * 2 ** 31);
    const id = addScenario(name, seed);
    setSelectedId(id);
  }

  function handleDeleteScenario(id: string) {
    deleteScenario(id);
    if (selectedId === id) setSelectedId(null);
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* ── Left: scenario list ──────────────────────────────────────────── */}
      <div className="w-64 shrink-0 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between shrink-0">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Scenarios
          </span>
          <button
            onClick={handleAddScenario}
            className="text-xs rounded px-2 py-0.5 bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            + New
          </button>
        </div>

        {/* Baseline entry */}
        <button
          onClick={() => setSelectedId(null)}
          className={[
            'w-full text-left px-4 py-2.5 text-sm border-b border-gray-100 dark:border-gray-800 flex items-center gap-2 shrink-0',
            selectedId === null
              ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 font-medium'
              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800',
          ].join(' ')}
        >
          <span className="text-base leading-none">📋</span>
          <span>Baseline</span>
        </button>

        {/* User scenarios */}
        <div className="flex-1 overflow-y-auto">
          {scenarios.length === 0 ? (
            <p className="px-4 py-6 text-xs text-gray-400 dark:text-gray-500 text-center leading-relaxed">
              No scenarios yet.
              <br />
              Click <strong>+ New</strong> to create one.
            </p>
          ) : (
            scenarios.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={[
                  'w-full text-left px-4 py-2.5 text-sm flex items-center gap-2 group border-b border-gray-100 dark:border-gray-800 transition-colors',
                  selectedId === s.id
                    ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 font-medium'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800',
                ].join(' ')}
              >
                <span className="flex-1 truncate">
                  {s.name || <em className="text-gray-400">Unnamed</em>}
                </span>
                {Object.keys(s.nodeOverrides).length > 0 && (
                  <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500">
                    {Object.keys(s.nodeOverrides).length}✏
                  </span>
                )}
                <span
                  role="button"
                  title="Delete scenario"
                  className="shrink-0 opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 text-xs px-0.5 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteScenario(s.id);
                  }}
                >
                  🗑
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Right: baseline info or scenario editor ───────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden bg-gray-50 dark:bg-gray-950">
        {selectedId === null ? (
          <BaselinePanel project={project} />
        ) : selectedScenario ? (
          <ScenarioEditor key={selectedScenario.id} project={project} scenario={selectedScenario} />
        ) : null}
      </div>
    </div>
  );
}

// ── Baseline panel ────────────────────────────────────────────────────────────

function BaselinePanel({ project }: { project: ProjectFile }) {
  const outcome = useMemo(() => runSchedule(project), [project]);

  return (
    <div className="flex-1 p-6 flex flex-col gap-4 overflow-auto">
      <div>
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-1">
          Baseline — {project.project.name}
        </h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
          The baseline is the current project with no modifications. Create a scenario to explore
          "what-if" variations and compare them here.
        </p>
      </div>

      {outcome.ok ? (
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4 inline-flex flex-col gap-2.5 w-fit">
          <InfoRow label="Start" value={project.project.startDate} />
          <InfoRow label="Project end" value={fmtDate(outcome.result.projectEnd)} />
          <InfoRow label="Nodes" value={String(project.nodes.length)} />
          <InfoRow
            label="Critical path"
            value={
              (outcome.result.criticalPaths[0] ?? [])
                .map((id) => project.nodes.find((n) => n.id === id)?.name ?? id)
                .join(' → ') || '—'
            }
          />
        </div>
      ) : (
        <p className="text-sm text-red-600 dark:text-red-400">
          Schedule error: {outcome.errors.map((e) => e.message).join(' · ')}
        </p>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-xs text-gray-500 dark:text-gray-400 w-24 shrink-0 pt-0.5">{label}</span>
      <span className="text-sm text-gray-800 dark:text-gray-200 leading-snug">{value}</span>
    </div>
  );
}

// ── Scenario editor ───────────────────────────────────────────────────────────

interface ScenarioEditorProps {
  project: ProjectFile;
  scenario: Scenario;
}

function ScenarioEditor({ project, scenario }: ScenarioEditorProps) {
  const [nameDraft, setNameDraft] = useState(scenario.name);
  const [seedDraft, setSeedDraft] = useState(String(scenario.seed));

  // Sync drafts when the store changes externally (undo/redo)
  useEffect(() => {
    setNameDraft(scenario.name);
  }, [scenario.name]);
  useEffect(() => {
    setSeedDraft(String(scenario.seed));
  }, [scenario.seed]);

  const updateScenarioName = useDomainStore((s) => s.updateScenarioName);
  const setScenarioSeed = useDomainStore((s) => s.setScenarioSeed);
  const setScenarioNodeDuration = useDomainStore((s) => s.setScenarioNodeDuration);
  const deleteScenarioNodeOverride = useDomainStore((s) => s.deleteScenarioNodeOverride);

  const overriddenNodeIds = new Set(Object.keys(scenario.nodeOverrides));
  const availableNodes = project.nodes.filter((n) => !overriddenNodeIds.has(n.id));

  // Comparison schedules
  const baselineOutcome = useMemo(() => runSchedule(project), [project]);
  const scenarioOutcome = useMemo(
    () => runSchedule(applyScenarioOverrides(project, scenario)),
    [project, scenario],
  );

  const defaultCal = project.calendars.find((c) => c.id === project.project.defaultCalendarId);

  const inputCls =
    'text-sm border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400';

  return (
    <div className="flex-1 overflow-auto">
      <div className="p-6 flex flex-col gap-5 max-w-2xl">
        {/* Name + seed */}
        <section className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <label className="text-xs text-gray-500 dark:text-gray-400 w-10 shrink-0">Name</label>
            <input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onFocus={beginEdit}
              onBlur={() => {
                commitEdit();
                updateScenarioName(scenario.id, nameDraft.trim() || 'Unnamed');
              }}
              className={`flex-1 ${inputCls}`}
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-gray-500 dark:text-gray-400 w-10 shrink-0">Seed</label>
            <input
              type="number"
              value={seedDraft}
              min={0}
              onChange={(e) => setSeedDraft(e.target.value)}
              onFocus={beginEdit}
              onBlur={() => {
                commitEdit();
                const v = parseInt(seedDraft, 10);
                if (isFinite(v)) setScenarioSeed(scenario.id, v);
                else setSeedDraft(String(scenario.seed));
              }}
              className={`w-32 ${inputCls}`}
            />
            <button
              onClick={() => {
                const s = Math.floor(Math.random() * 2 ** 31);
                setSeedDraft(String(s));
                setScenarioSeed(scenario.id, s);
              }}
              className="text-lg leading-none text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              title="Randomise seed"
            >
              🎲
            </button>
            <span className="text-xs text-gray-400 dark:text-gray-500">Used for Monte Carlo</span>
          </div>
        </section>

        {/* Node duration overrides */}
        <section className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4 flex flex-col gap-3">
          <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Duration Overrides
          </h3>

          {Object.keys(scenario.nodeOverrides).length === 0 && (
            <p className="text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
              No overrides yet. Add a node below to see how its duration change shifts the schedule.
            </p>
          )}

          {/* Existing overrides */}
          {Object.entries(scenario.nodeOverrides).map(([nodeId, override]) => {
            const node = project.nodes.find((n) => n.id === nodeId);
            if (!node || !override.duration) return null;
            return (
              <NodeOverrideRow
                key={nodeId}
                nodeName={node.name}
                originalDuration={node.duration}
                overrideDuration={override.duration}
                onUpdate={(dur) => setScenarioNodeDuration(scenario.id, nodeId, dur)}
                onDelete={() => deleteScenarioNodeOverride(scenario.id, nodeId)}
              />
            );
          })}

          {/* Add override */}
          {availableNodes.length > 0 && (
            <AddOverrideRow
              availableNodes={availableNodes}
              onAdd={(nodeId) => {
                const node = project.nodes.find((n) => n.id === nodeId);
                if (node) setScenarioNodeDuration(scenario.id, nodeId, node.duration);
              }}
            />
          )}
        </section>

        {/* Comparison */}
        <ComparisonPanel
          project={project}
          scenario={scenario}
          baselineOutcome={baselineOutcome}
          scenarioOutcome={scenarioOutcome}
          defaultCal={defaultCal}
        />
      </div>
    </div>
  );
}

// ── Node override row ─────────────────────────────────────────────────────────

interface NodeOverrideRowProps {
  nodeName: string;
  originalDuration: Duration;
  overrideDuration: Duration;
  onUpdate(dur: Duration): void;
  onDelete(): void;
}

function NodeOverrideRow({
  nodeName,
  originalDuration,
  overrideDuration,
  onUpdate,
  onDelete,
}: NodeOverrideRowProps) {
  const [valueDraft, setValueDraft] = useState(String(overrideDuration.value));
  const [unit, setUnit] = useState<DurationUnit>(overrideDuration.unit);

  // Sync when store changes
  useEffect(() => {
    setValueDraft(String(overrideDuration.value));
  }, [overrideDuration.value]);
  useEffect(() => {
    setUnit(overrideDuration.unit);
  }, [overrideDuration.unit]);

  function commitValue() {
    commitEdit();
    const v = parseFloat(valueDraft);
    if (isFinite(v) && v > 0) onUpdate({ value: v, unit });
    else setValueDraft(String(overrideDuration.value));
  }

  const orig = originalDuration;

  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-gray-100 dark:border-gray-800 last:border-0">
      <span className="flex-1 text-sm text-gray-700 dark:text-gray-300 truncate" title={nodeName}>
        {nodeName}
      </span>
      <span className="text-xs text-gray-400 dark:text-gray-500 line-through shrink-0">
        {orig.value}
        {orig.unit.charAt(0)}
      </span>
      <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">→</span>
      <input
        type="number"
        value={valueDraft}
        min={0}
        step={1}
        onChange={(e) => setValueDraft(e.target.value)}
        onFocus={beginEdit}
        onBlur={commitValue}
        className="w-16 text-sm border border-blue-300 dark:border-blue-600 bg-white dark:bg-gray-800 text-blue-700 dark:text-blue-300 rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
      />
      <select
        value={unit}
        onChange={(e) => {
          const u = e.target.value as DurationUnit;
          setUnit(u);
          const v = parseFloat(valueDraft);
          if (isFinite(v) && v > 0) onUpdate({ value: v, unit: u });
        }}
        className="text-sm border border-blue-300 dark:border-blue-600 bg-white dark:bg-gray-800 text-blue-700 dark:text-blue-300 rounded px-1 py-0.5 focus:outline-none"
      >
        <option value="hours">h</option>
        <option value="days">d</option>
        <option value="weeks">w</option>
      </select>
      <button
        onClick={onDelete}
        className="text-red-400 hover:text-red-600 text-xs px-0.5 shrink-0"
        title="Remove override"
      >
        🗑
      </button>
    </div>
  );
}

// ── Add override row ──────────────────────────────────────────────────────────

interface AddOverrideRowProps {
  availableNodes: readonly ProjectNode[];
  onAdd(nodeId: string): void;
}

function AddOverrideRow({ availableNodes, onAdd }: AddOverrideRowProps) {
  const [selected, setSelected] = useState('');

  return (
    <div className="flex items-center gap-2 pt-1">
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        className="flex-1 text-sm border border-dashed border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400"
      >
        <option value="">Add node override…</option>
        {availableNodes.map((n) => (
          <option key={n.id} value={n.id}>
            {n.name} ({n.duration.value} {n.duration.unit})
          </option>
        ))}
      </select>
      <button
        onClick={() => {
          if (selected) {
            onAdd(selected);
            setSelected('');
          }
        }}
        disabled={!selected}
        className="text-sm rounded px-3 py-1 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Add
      </button>
    </div>
  );
}

// ── Comparison panel ──────────────────────────────────────────────────────────

interface ComparisonPanelProps {
  project: ProjectFile;
  scenario: Scenario;
  baselineOutcome: ScheduleOutcome;
  scenarioOutcome: ScheduleOutcome;
  defaultCal: Calendar | undefined;
}

function ComparisonPanel({
  project,
  scenario,
  baselineOutcome,
  scenarioOutcome,
  defaultCal,
}: ComparisonPanelProps) {
  return (
    <section className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-4 flex flex-col gap-4">
      <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
        Schedule Comparison — Baseline vs {scenario.name || 'Unnamed'}
      </h3>

      {/* Errors */}
      {!baselineOutcome.ok && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Baseline error: {baselineOutcome.errors.map((e) => e.message).join(' · ')}
        </p>
      )}
      {!scenarioOutcome.ok && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Scenario error: {scenarioOutcome.errors.map((e) => e.message).join(' · ')}
        </p>
      )}

      {baselineOutcome.ok && scenarioOutcome.ok && (
        <ComparisonBody
          project={project}
          scenario={scenario}
          baselineOutcome={baselineOutcome.result}
          scenarioOutcome={scenarioOutcome.result}
          defaultCal={defaultCal}
        />
      )}
    </section>
  );
}

// Extracted to keep the ok-branch readable
function ComparisonBody({
  project,
  scenario,
  baselineOutcome,
  scenarioOutcome,
  defaultCal,
}: {
  project: ProjectFile;
  scenario: Scenario;
  baselineOutcome: import('@procsim/scheduler').ScheduleResult;
  scenarioOutcome: import('@procsim/scheduler').ScheduleResult;
  defaultCal: Calendar | undefined;
}) {
  const baseEnd = baselineOutcome.projectEnd;
  const scenEnd = scenarioOutcome.projectEnd;

  // Working-hours difference (positive = scenario ends later)
  const cal = defaultCal ?? project.calendars[0];
  const whDiff = cal ? workingHoursBetween(baseEnd, scenEnd, cal) : 0;
  const hoursPerDay = cal?.hoursPerDay ?? 8;
  const daysDiff = whDiff / hoursPerDay;

  const nodeMap = new Map(project.nodes.map((n) => [n.id, n.name]));
  const baseCPath = (baselineOutcome.criticalPaths[0] ?? []).map((id) => nodeMap.get(id) ?? id);
  const scenCPath = (scenarioOutcome.criticalPaths[0] ?? []).map((id) => nodeMap.get(id) ?? id);
  const cpChanged = JSON.stringify(baseCPath) !== JSON.stringify(scenCPath);

  return (
    <>
      {/* End-date comparison */}
      <div className="grid grid-cols-[auto_1fr_1fr] gap-x-4 gap-y-2 items-center text-sm">
        <span />
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Baseline</span>
        <span className="text-xs font-medium text-blue-600 dark:text-blue-400">
          {scenario.name || 'Unnamed'}
        </span>

        <span className="text-xs text-gray-500 dark:text-gray-400">Project end</span>
        <span className="text-gray-700 dark:text-gray-300">{fmtDate(baseEnd)}</span>
        <span
          className={
            scenEnd < baseEnd
              ? 'text-green-600 dark:text-green-400 font-medium'
              : scenEnd > baseEnd
                ? 'text-red-600 dark:text-red-400 font-medium'
                : 'text-gray-700 dark:text-gray-300'
          }
        >
          {fmtDate(scenEnd)}
        </span>
      </div>

      {/* Delta badge */}
      {daysDiff === 0 ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">No change in project end date.</p>
      ) : (
        <div
          className={[
            'inline-flex items-center gap-1.5 text-sm font-medium px-2.5 py-1 rounded-full w-fit',
            daysDiff < 0
              ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
              : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300',
          ].join(' ')}
        >
          {daysDiff < 0 ? '▼' : '▲'} {Math.abs(daysDiff).toFixed(1)} working days
          {daysDiff < 0 ? ' earlier' : ' later'}
        </div>
      )}

      {/* Critical path */}
      {cpChanged && (
        <div className="flex flex-col gap-1 pt-1 border-t border-gray-100 dark:border-gray-800">
          <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
            ⚠ Critical path changed
          </span>
          <div className="text-xs text-gray-600 dark:text-gray-400">
            <span className="font-medium text-gray-500 dark:text-gray-400">Baseline: </span>
            {baseCPath.join(' → ') || '—'}
          </div>
          <div className="text-xs text-blue-600 dark:text-blue-400">
            <span className="font-medium">{scenario.name || 'Unnamed'}: </span>
            {scenCPath.join(' → ') || '—'}
          </div>
        </div>
      )}

      {/* Override summary */}
      {Object.keys(scenario.nodeOverrides).length > 0 && (
        <div className="flex flex-col gap-1.5 pt-1 border-t border-gray-100 dark:border-gray-800">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
            Changed nodes
          </span>
          {Object.entries(scenario.nodeOverrides).map(([nodeId, override]) => {
            const node = project.nodes.find((n) => n.id === nodeId);
            if (!node || !override.duration) return null;
            const orig = node.duration;
            const ov = override.duration;
            const changed =
              Math.round(orig.value * 100) !== Math.round(ov.value * 100) || orig.unit !== ov.unit;
            return (
              <div key={nodeId} className="text-xs text-gray-600 dark:text-gray-400">
                {'• '}
                <span className="font-medium">{node.name}</span>:{' '}
                <span
                  className={
                    changed
                      ? 'line-through text-gray-400 dark:text-gray-600'
                      : 'text-gray-500 dark:text-gray-400'
                  }
                >
                  {orig.value} {orig.unit}
                </span>
                {changed && (
                  <>
                    {' → '}
                    <span className="font-medium text-blue-600 dark:text-blue-400">
                      {ov.value} {ov.unit}
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
