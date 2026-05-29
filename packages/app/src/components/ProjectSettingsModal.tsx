import { useEffect, useMemo, useState } from 'react';
import type { Calendar, FxSnapshot, HolidayPresetId, ProjectFile } from '@procsim/file-format';
import {
  applyFxOverrides,
  CALENDAR_TEMPLATES,
  currencyGlyph,
  LATEST_BUNDLED_SNAPSHOT,
  listAvailableTargetCurrencies,
  loadFxSnapshot,
} from '@procsim/file-format';
import { useModalEscape } from '../hooks/useModalEscape.js';

// Day labels used by the schedule-summary helper. workingDays in the schema
// is [Sun, Mon, …, Sat]; render in week-start-Monday order so the summary
// reads naturally for the most common audience.
const DAY_LABELS_MON_FIRST: ReadonlyArray<{ index: number; short: string }> = [
  { index: 1, short: 'Mon' },
  { index: 2, short: 'Tue' },
  { index: 3, short: 'Wed' },
  { index: 4, short: 'Thu' },
  { index: 5, short: 'Fri' },
  { index: 6, short: 'Sat' },
  { index: 0, short: 'Sun' },
];

function summarizeSchedule(cal: Calendar): string {
  const workingDayNames = DAY_LABELS_MON_FIRST.filter((d) => cal.workingDays[d.index]).map(
    (d) => d.short,
  );
  const days = workingDayNames.length === 0 ? 'no working days' : workingDayNames.join(', ');
  // Strip trailing zero from hoursPerDay (e.g. 7.5 stays 7.5, 8.0 becomes 8).
  const hoursDisplay = Number.isInteger(cal.hoursPerDay)
    ? cal.hoursPerDay.toString()
    : cal.hoursPerDay.toString();
  return `${days} · ${hoursDisplay}h/day · ${cal.daysPerWeek} days/week`;
}

/**
 * Return the id of the CALENDAR_TEMPLATES entry whose schedule fields match
 * the calendar's current values exactly, or `null` if the calendar is in a
 * custom (off-template) state. Powers the controlled Work-schedule dropdown
 * — when matched, the dropdown shows the template label; when off-template,
 * it falls back to a "Custom schedule" placeholder.
 */
function matchedTemplateId(cal: Calendar | undefined): string {
  if (!cal) return '';
  const match = CALENDAR_TEMPLATES.find(
    (t) =>
      t.hoursPerDay === cal.hoursPerDay &&
      t.daysPerWeek === cal.daysPerWeek &&
      t.workingDays.every((v, i) => v === cal.workingDays[i]),
  );
  return match?.id ?? '';
}

const HOLIDAY_PRESET_LABELS: Record<HolidayPresetId, string> = {
  US_FEDERAL: 'US Federal',
  CANADA_FEDERAL: 'Canada Federal',
  EU_COMMON: 'EU Common',
  BRAZIL_FEDERAL: 'Brazil Federal',
  MEXICO_FEDERAL: 'Mexico Federal',
  JAPAN_NATIONAL: 'Japan National',
  AUSTRALIA_NATIONAL: 'Australia National',
  NONE: 'None',
};
const HOLIDAY_PRESET_OPTIONS: ReadonlyArray<HolidayPresetId> = [
  'US_FEDERAL',
  'CANADA_FEDERAL',
  'EU_COMMON',
  'BRAZIL_FEDERAL',
  'MEXICO_FEDERAL',
  'JAPAN_NATIONAL',
  'AUSTRALIA_NATIONAL',
  'NONE',
];
import { beginEdit, commitEdit, useDomainStore } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import { useSchedule } from '../hooks/useSchedule.js';
import { currencyStep } from '../utils/cost.js';

/**
 * Project Settings modal.
 *
 * Merged in Phase 19 slice 4 follow-up — folds the previously-separate
 * "Settings…" modal in here so the user has one settings entry per project.
 * Edits four logical groups:
 *
 *   - Identity: Name, Start date.
 *   - Cost: Currency (with bulk conversion on change), Budget.
 *   - Display: which currency to show alongside native totals.
 *   - FX rates: editable table; user overrides persist on the project.
 *
 * Opened from the Caladia ▾ dropdown. Renders as a centred modal with a
 * backdrop. Closes on outside click, ESC, or the explicit Done button.
 *
 * Edit-session discipline: `beginEdit()` is called when the modal opens and
 * `commitEdit()` when it closes, so multi-field / multi-character edits
 * within one open session coalesce into a single history entry.
 */
export function ProjectSettingsModal({
  project,
  onClose,
}: {
  project: ProjectFile;
  onClose: () => void;
}) {
  const updateProjectName = useDomainStore((s) => s.updateProjectName);
  const updateProjectStartDate = useDomainStore((s) => s.updateProjectStartDate);
  const updateProjectShareMode = useDomainStore((s) => s.updateProjectShareMode);
  const updateProjectBudget = useDomainStore((s) => s.updateProjectBudget);
  const updateProjectCurrency = useDomainStore((s) => s.updateProjectCurrency);
  const updateProjectFxRateOverride = useDomainStore((s) => s.updateProjectFxRateOverride);
  const updateCalendarHolidayPreset = useDomainStore((s) => s.updateCalendarHolidayPreset);
  const applyCalendarTemplate = useDomainStore((s) => s.applyCalendarTemplate);

  const setCurrencyDisplay = useViewStore((s) => s.setCurrencyDisplay);
  const scaleSimHistoryCosts = useViewStore((s) => s.scaleSimHistoryCosts);
  // Phase 25 follow-up — drive the budget input's spinner step from the
  // project's current total cost when the budget itself is empty / zero.
  // Once the user types a budget, the step self-corrects to that value.
  const scheduleOutcome = useSchedule();

  const [name, setName] = useState(project.project.name);
  const [startDate, setStartDate] = useState(project.project.startDate);
  // Budget value lives in project.currency. The (now-single) currency
  // picker controls the project's base currency; there's no separate
  // display currency — everything renders in project.currency.
  const [budget, setBudget] = useState<string>(
    project.budget !== undefined ? String(project.budget) : '',
  );

  // One-time cleanup: any persisted `currencyDisplay` from the previous
  // multi-currency design is reset to 'AUTO' so cost surfaces stop dual-
  // rendering with a stale target.
  useEffect(() => {
    setCurrencyDisplay('AUTO');
  }, [setCurrencyDisplay]);

  // Open / close one history entry per modal session.
  useEffect(() => {
    beginEdit();
    return () => commitEdit();
  }, []);

  // ESC to close — routed through modalStack so only the top-most modal
  // responds when layered (audit I-21).
  useModalEscape(onClose);

  // ── FX snapshot resolution (snapshot + overrides) ─────────────────────
  // The picker / table read from this; edits to the project store re-render
  // this useMemo because `project` changes reference.
  const baseSnapshot: FxSnapshot = useMemo(
    () => loadFxSnapshot(project.fxSnapshotVersion) ?? LATEST_BUNDLED_SNAPSHOT,
    [project.fxSnapshotVersion],
  );
  const effectiveSnapshot: FxSnapshot = useMemo(
    () => applyFxOverrides(baseSnapshot, project.fxRateOverrides) ?? baseSnapshot,
    [baseSnapshot, project.fxRateOverrides],
  );
  const availableCurrencies = useMemo(
    () => listAvailableTargetCurrencies(baseSnapshot),
    [baseSnapshot],
  );

  // Re-seed the budget input whenever the persisted budget changes (e.g.
  // after a currency change converts the stored value).
  useEffect(() => {
    setBudget(project.budget !== undefined ? String(project.budget) : '');
  }, [project.budget]);

  function handleSave(): void {
    if (name.trim() && name.trim() !== project.project.name) {
      updateProjectName(name.trim());
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(startDate) && startDate !== project.project.startDate) {
      updateProjectStartDate(startDate);
    }
    // Budget value is in project.currency directly — store as typed.
    const parsed = budget.trim() === '' ? undefined : parseFloat(budget);
    const storedBudget = parsed === undefined || !isFinite(parsed) ? undefined : parsed;
    if (storedBudget !== project.budget) {
      updateProjectBudget(storedBudget);
    }
    onClose();
  }

  function handleCurrencyChange(next: string): void {
    if (next === project.currency) return;
    if (!/^[A-Z]{3}$/.test(next)) return;
    // Compute the conversion factor up-front so we can both show it in the
    // confirm prompt AND apply it to cached MC runs after the project
    // mutation lands. Pulled from the effective snapshot (snapshot +
    // overrides) so user-edited rates are honoured.
    const toRate = effectiveSnapshot.rates[next];
    const fromRate = effectiveSnapshot.rates[project.currency];
    const factor =
      toRate !== undefined && fromRate !== undefined && fromRate > 0 ? toRate / fromRate : null;
    // Confirm before bulk-converting — destructive (rounding loss on
    // round-trips). Skip the prompt when no cost fields exist.
    const anyCost =
      project.budget !== undefined ||
      project.resources.some((r) => r.costRate !== undefined || r.costPerUse !== undefined) ||
      project.nodes.some((n) => n.fixedCost !== undefined);
    if (anyCost) {
      const display = factor !== null ? factor.toFixed(4) : '?';
      const ok = window.confirm(
        `Change currency from ${project.currency} to ${next}?\n\n` +
          `All cost values in this project (resource rates, fixed costs, ` +
          `budget) will be converted using rate 1 ${project.currency} = ` +
          `${display} ${next}. Round-trip conversions lose precision — ` +
          `there is no automatic undo.`,
      );
      if (!ok) return;
    }
    updateProjectCurrency(next);
    // Scale every cached MC run's cost fields by the same factor so the
    // Gantt cost-curve panel + any other display reading from
    // simHistory updates without forcing a re-run. No-op when factor
    // can't be derived (project pinned to 'NONE' / missing rates).
    if (factor !== null) {
      scaleSimHistoryCosts(factor);
    }
  }

  const inputCls =
    'rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400';
  const smallInputCls =
    'rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 px-2 py-1 text-xs font-mono text-right focus:outline-none focus:ring-1 focus:ring-emerald-400';
  const labelCls = 'text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400';

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-settings-title"
        className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none p-4"
      >
        <div className="pointer-events-auto w-full max-w-lg max-md:max-w-none max-h-[90vh] flex flex-col rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-xl">
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-gray-800 shrink-0">
            <h2
              id="project-settings-title"
              className="text-base font-semibold text-gray-900 dark:text-gray-100"
            >
              Project settings
            </h2>
            <button
              onClick={onClose}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 text-lg leading-none max-md:w-11 max-md:h-11 max-md:inline-flex max-md:items-center max-md:justify-center"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div className="flex flex-col gap-4 p-5 overflow-y-auto">
            {/* Name */}
            <div className="flex flex-col gap-1.5">
              <label className={labelCls} htmlFor="project-name-input">
                Name
              </label>
              <input
                id="project-name-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputCls}
              />
            </div>

            {/* Start date */}
            <div className="flex flex-col gap-1.5">
              <label className={labelCls} htmlFor="project-start-date-input">
                Start date
              </label>
              <input
                id="project-start-date-input"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={inputCls}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                Global project start. Activities anchored via a Start node&rsquo;s{' '}
                <em>Anchor date</em> override this for their branch.
              </p>
            </div>

            {/* Work schedule + holiday preset, both bound to the project's
                default calendar. The Default-calendar dropdown that used to
                live above was effectively vestigial: there's no UI to author
                additional named calendars, so users were always picking from
                seed entries — and the next dropdown (Work schedule) then
                rewrote that calendar's schedule fields anyway. Condensed
                into a single controlled Work-schedule dropdown that reflects
                whichever template matches the default calendar's current
                state (or shows "Custom schedule" when no template matches). */}
            {(() => {
              const defaultCal = project.calendars.find(
                (c) => c.id === project.project.defaultCalendarId,
              );
              const matchedId = matchedTemplateId(defaultCal);
              return (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className={labelCls} htmlFor="project-holiday-preset-select">
                      Holidays
                    </label>
                    <select
                      id="project-holiday-preset-select"
                      value={defaultCal?.holidayPreset ?? 'NONE'}
                      disabled={!defaultCal}
                      onChange={(e) => {
                        if (!defaultCal) return;
                        updateCalendarHolidayPreset(
                          defaultCal.id,
                          e.target.value as HolidayPresetId,
                        );
                      }}
                      className={inputCls}
                    >
                      {HOLIDAY_PRESET_OPTIONS.map((p) => (
                        <option key={p} value={p}>
                          {HOLIDAY_PRESET_LABELS[p]}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                      Holiday set applied to the project&rsquo;s default calendar. Other calendars
                      in the project keep their own preset.
                    </p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className={labelCls} htmlFor="project-schedule-template-select">
                      Work schedule
                    </label>
                    <select
                      id="project-schedule-template-select"
                      value={matchedId}
                      disabled={!defaultCal}
                      onChange={(e) => {
                        const id = e.target.value;
                        if (!id || !defaultCal) return;
                        applyCalendarTemplate(defaultCal.id, id);
                      }}
                      className={inputCls}
                    >
                      {!matchedId && (
                        <option value="" disabled>
                          Custom schedule
                        </option>
                      )}
                      {CALENDAR_TEMPLATES.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                    {defaultCal && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                        Currently: <strong>{summarizeSchedule(defaultCal)}</strong>. Applied to
                        nodes and resources that don&rsquo;t override their own.
                      </p>
                    )}
                  </div>
                </>
              );
            })()}

            {/* Phase 42 — resource-share mode. Controls how the inspector
                renders and validates `ResourceAssignment.share`. Percentage
                mode (default) enforces sum = 100 across a node's assignments;
                weight mode keeps the looser sum > 0 invariant. Switching
                modes converts existing shares so the project stays schema-
                valid. */}
            <div className="flex flex-col gap-1.5">
              <label className={labelCls}>Resource share mode</label>
              <div className="inline-flex rounded border border-gray-200 dark:border-gray-700 overflow-hidden w-fit">
                {(['percentage', 'weight'] as const).map((m) => {
                  const active = project.project.shareMode === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={active}
                      onClick={() => updateProjectShareMode(m)}
                      title={
                        m === 'percentage'
                          ? "Shares are entered as percentages and must sum to exactly 100 across each activity's resource assignments."
                          : 'Shares are entered as relative weights. No sum constraint; the engine normalises at compute time.'
                      }
                      className={[
                        'px-3 py-1 text-sm transition-colors capitalize',
                        active
                          ? 'bg-emerald-500 text-white'
                          : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700',
                      ].join(' ')}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                Controls how the Inspector renders resource-pool shares on multi-pool activities.
                Percentage mode requires shares to sum to 100; weight mode treats any positive
                numbers as relative weights. Switching modes converts existing shares — going to
                weight is identity; going to percentage rounds to integers summing to 100.
              </p>
            </div>

            {/* Project base currency */}
            <div className="flex flex-col gap-1.5">
              <label className={labelCls} htmlFor="project-currency-select">
                Currency
              </label>
              <select
                id="project-currency-select"
                value={project.currency}
                onChange={(e) => handleCurrencyChange(e.target.value)}
                className={inputCls}
              >
                {availableCurrencies.map((c) => (
                  <option key={c} value={c}>
                    {currencyGlyph(c)} {c}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                The project&rsquo;s base currency. Changing it converts every cost value (resource
                rates, fixed costs, budget) using the rates below. Round-trip conversions lose
                precision.
              </p>
            </div>

            {/* Budget — denominated in the project's currency (above). */}
            <div className="flex flex-col gap-1.5">
              <label className={labelCls} htmlFor="project-budget-input">
                Budget ({currencyGlyph(project.currency)} {project.currency})
              </label>
              <input
                id="project-budget-input"
                type="number"
                min={0}
                step={currencyStep(
                  project.currency,
                  parseFloat(budget) > 0
                    ? parseFloat(budget)
                    : scheduleOutcome.ok
                      ? scheduleOutcome.result.projectCost
                      : 0,
                  'budget',
                )}
                value={budget}
                placeholder="0 (no budget)"
                onChange={(e) => setBudget(e.target.value)}
                className={inputCls}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                Probability of finishing under budget is shown on the Verdict bar; the budget line
                appears on the cost histogram. Leave blank to hide both.
              </p>
            </div>

            {/* Editable rates table */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className={labelCls}>Conversion rates (1 {project.currency} =)</label>
              </div>
              <RatesTable
                project={project}
                effectiveSnapshot={effectiveSnapshot}
                baseSnapshot={baseSnapshot}
                smallInputCls={smallInputCls}
                onSetOverride={updateProjectFxRateOverride}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                Edits persist with this project (the <code>.cala</code> file). The reset button per
                row reverts to the bundled snapshot value.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60 shrink-0">
            <button
              onClick={onClose}
              className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-800"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="rounded bg-emerald-600 hover:bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Editable rates table — shows each currency's effective rate relative to the
 * project's native currency. Editing a cell sets / replaces an override on
 * `project.fxRateOverrides`. The "reset" button per row drops the override
 * (reverts to the bundled snapshot value).
 *
 * Convention: snapshot rates are foreign-per-USD-base; the table displays
 * foreign-per-project-currency by routing through the base. Edits are
 * translated back to USD-base before being stored.
 */
function RatesTable({
  project,
  effectiveSnapshot,
  baseSnapshot,
  smallInputCls,
  onSetOverride,
}: {
  project: ProjectFile;
  effectiveSnapshot: FxSnapshot;
  baseSnapshot: FxSnapshot;
  smallInputCls: string;
  onSetOverride: (code: string, value: number | undefined) => void;
}) {
  const codes = useMemo(
    () => Object.keys(effectiveSnapshot.rates).sort(),
    [effectiveSnapshot.rates],
  );
  // 1 project.currency = rate(project) USD-base ⇒ 1 USD = 1/rate(project) project.currency
  const projectRateInBase = effectiveSnapshot.rates[project.currency];

  return (
    <div className="rounded border border-gray-200 dark:border-gray-700 overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400">
          <tr>
            <th className="text-left px-3 py-1.5 font-medium">Currency</th>
            <th className="text-right px-3 py-1.5 font-medium">Per 1 {project.currency}</th>
            <th className="text-right px-3 py-1.5 font-medium w-[40px]"></th>
          </tr>
        </thead>
        <tbody>
          {codes.map((code) => {
            // Effective rate in the project's currency frame.
            const baseRate = effectiveSnapshot.rates[code];
            const perProject =
              baseRate !== undefined && projectRateInBase !== undefined && projectRateInBase > 0
                ? baseRate / projectRateInBase
                : 0;
            const isProjectCurrency = code === project.currency;
            const overrideValue = project.fxRateOverrides?.[code];
            const hasOverride = overrideValue !== undefined;
            const bundledBaseRate = baseSnapshot.rates[code];
            return (
              <tr key={code} className="border-t border-gray-100 dark:border-gray-800">
                <td className="px-3 py-1.5 font-mono text-gray-700 dark:text-gray-300">
                  {currencyGlyph(code)} {code}
                </td>
                <td className="text-right px-3 py-1.5">
                  {isProjectCurrency ? (
                    <span className="font-mono text-gray-400 dark:text-gray-500">1</span>
                  ) : (
                    <RateInput
                      perProject={perProject}
                      projectRateInBase={projectRateInBase ?? 1}
                      hasOverride={hasOverride}
                      smallInputCls={smallInputCls}
                      onCommit={(newPerProject) => {
                        if (newPerProject === null) return;
                        // Convert "per project.currency" back to USD-base.
                        const newBaseRate = newPerProject * (projectRateInBase ?? 1);
                        if (!isFinite(newBaseRate) || newBaseRate <= 0) return;
                        onSetOverride(code, newBaseRate);
                      }}
                    />
                  )}
                </td>
                <td className="text-right px-3 py-1.5">
                  {hasOverride && !isProjectCurrency && bundledBaseRate !== undefined ? (
                    <button
                      onClick={() => onSetOverride(code, undefined)}
                      className="text-[10px] text-gray-400 dark:text-gray-500 hover:text-emerald-600 dark:hover:text-emerald-400 underline"
                      title={`Revert to bundled rate (${(bundledBaseRate / (projectRateInBase ?? 1)).toFixed(4)})`}
                    >
                      reset
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Editable cell. Local state mirrors the displayed value while the user is
 * typing; commits on blur. Empty / invalid input is silently dropped (no
 * commit) — the cell snaps back to the persisted value on next render.
 */
function RateInput({
  perProject,
  hasOverride,
  smallInputCls,
  onCommit,
}: {
  perProject: number;
  projectRateInBase: number;
  hasOverride: boolean;
  smallInputCls: string;
  onCommit: (next: number | null) => void;
}) {
  const formatted = perProject > 0 ? perProject.toFixed(6) : '';
  const [text, setText] = useState(formatted);
  // Re-sync when the rendered value changes (currency switch, sibling edit).
  useEffect(() => {
    setText(formatted);
  }, [formatted]);

  function handleBlur(): void {
    const trimmed = text.trim();
    if (trimmed === '') {
      onCommit(null);
      return;
    }
    const parsed = parseFloat(trimmed);
    if (!isFinite(parsed) || parsed <= 0) {
      setText(formatted);
      return;
    }
    if (Math.abs(parsed - perProject) < 1e-9) return;
    onCommit(parsed);
  }

  return (
    <input
      type="number"
      step="any"
      min={0}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      className={[
        smallInputCls,
        'w-[110px]',
        hasOverride
          ? 'border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300'
          : '',
      ].join(' ')}
      title={hasOverride ? 'Override stored on this project' : 'Bundled snapshot rate'}
    />
  );
}
