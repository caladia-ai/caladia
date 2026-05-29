import { useState, useMemo, useCallback } from 'react';
import { suggestLeveling, computeCostOfDelay } from '@procsim/scheduler';
import type {
  LevelingPlan,
  ScheduleInput,
  ScheduleResult,
  CostOfDelayResult,
} from '@procsim/scheduler';
import type { Distribution, ProjectFile } from '@procsim/file-format';
import {
  currencyGlyph,
  convertAmount,
  convertResourceCostsToProjectCurrency,
} from '@procsim/file-format';
import { getEffectiveFxSnapshot } from '../utils/cost.js';
import { useDomainStore, schemaToUiWorkingDays } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import { formatMoney, projectHasCostData, currencyStep } from '../utils/cost.js';
import { useChartCursor } from '../utils/cursor.js';
import type { WorkingDaysUI } from '../store/domainStore.js';
import { useContainerWidth } from '../hooks/useContainerWidth.js';

// ── Day picker helpers ────────────────────────────────────────────────────────

const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;
const DAY_FULL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const DEFAULT_WORKING_DAYS: WorkingDaysUI = [true, true, true, true, true, false, false];

interface DayPickerProps {
  value: WorkingDaysUI;
  onChange: (next: WorkingDaysUI) => void;
}

function DayPicker({ value, onChange }: DayPickerProps) {
  return (
    <div className="flex gap-1">
      {DAY_LABELS.map((label, i) => (
        <button
          key={i}
          type="button"
          title={DAY_FULL[i]}
          onClick={() => {
            const next = [...value] as WorkingDaysUI;
            next[i] = !next[i];
            onChange(next);
          }}
          className={`w-7 h-7 rounded text-xs font-medium transition-colors ${
            value[i] ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ── Resource form (shared for Add and Edit) ───────────────────────────────────

interface ResourceFormProps {
  initialName?: string;
  initialCapacity?: number;
  initialWorkingDays?: WorkingDaysUI;
  initialHoursPerDay?: number;
  initialCostRate?: number;
  initialCostPerUse?: number;
  /** Phase 29 — optional rate uncertainty distribution. */
  initialHourlyRateDistribution?: Distribution;
  /** Phase 33 Slice 2 — optional per-resource currency override. */
  initialCurrencyOverride?: string;
  currencyCode: string;
  submitLabel: string;
  onSubmit: (
    name: string,
    capacity: number,
    workingDays: WorkingDaysUI,
    hoursPerDay: number,
    costRate: number | undefined,
    costPerUse: number | undefined,
    hourlyRateDistribution: Distribution | undefined,
    currencyOverride: string | undefined,
  ) => void;
  onCancel: () => void;
  /**
   * Phase 36 Slice 3 — optional calendar picker. When supplied (edit mode),
   * renders a select after the Working days picker so the resource can be
   * pointed at a different calendar. The picker action runs immediately on
   * change (not gated on form Save). When the bound calendar is shared
   * (project default, or another resource points at it), `sharedNote` is
   * non-null and rendered as an amber warning under the picker — editing
   * the working-days / hours fields above will mutate the shared calendar.
   */
  calendarPicker?: {
    currentCalendarId: string;
    availableCalendars: ReadonlyArray<{ id: string; name: string }>;
    sharedNote: string | null;
    onChange: (calendarId: string) => void;
  };
}

/**
 * Phase 33 Slice 2 — short list of common ISO 4217 codes to expose in the
 * resource form's currency-override dropdown. Covers the vast majority of
 * realistic mixed-currency projects (USD project + EUR/GBP/CAD contractor
 * etc.). Users who need an obscure code can add it via free-text in a
 * follow-up; for slice 1 the dropdown is intentionally compact.
 */
const COMMON_CURRENCY_OVERRIDES = [
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'JPY',
  'CHF',
  'CNY',
  'INR',
  'MXN',
] as const;

function ResourceForm({
  initialName = '',
  initialCapacity = 1,
  initialWorkingDays = DEFAULT_WORKING_DAYS,
  initialHoursPerDay = 8,
  initialCostRate,
  initialCostPerUse,
  initialHourlyRateDistribution,
  initialCurrencyOverride,
  currencyCode,
  submitLabel,
  onSubmit,
  onCancel,
  calendarPicker,
}: ResourceFormProps) {
  const [name, setName] = useState(initialName);
  // Phase 50 Slice 22 / audit I-19 — capacity + hoursPerDay stored as
  // draft strings (matches the costRate / costPerUse pattern below) so
  // Backspace-to-clear works. Pre-fix the inline coercion
  // `Math.max(1, parseInt(e.target.value, 10) || 1)` snapped any
  // mid-edit empty to "1" on every keystroke. Parsed on submit.
  const [capacity, setCapacity] = useState(String(initialCapacity));
  const [workingDays, setWorkingDays] = useState<WorkingDaysUI>(initialWorkingDays);
  const [hoursPerDay, setHoursPerDay] = useState(String(initialHoursPerDay));
  // Phase 19 — cost fields. Empty string ≡ "not set" so users can clear an
  // existing rate without resorting to typing 0.
  const [costRate, setCostRate] = useState<string>(
    initialCostRate !== undefined && initialCostRate > 0 ? String(initialCostRate) : '',
  );
  const [costPerUse, setCostPerUse] = useState<string>(
    initialCostPerUse !== undefined && initialCostPerUse > 0 ? String(initialCostPerUse) : '',
  );
  // Phase 33 Slice 2 follow-up — rate uncertainty UI reframed as
  // "best case −X%  /  worst case +Y%" instead of raw triangular
  // min/mode/max. Procurement reasoning is naturally asymmetric
  // ("could go 10% cheaper if everything works out, could go 30% over
  // if we hit problems"), and asking users to invent three numbers
  // that satisfy `min <= mode <= max` was a math homework problem
  // rather than a modelling one.
  //
  // Storage is unchanged — we still store a `triangular` distribution
  // on the schema; we just compute it from `rate × percentage` at
  // form-submit time and back-derive the percentages from any
  // pre-existing distribution at form-mount time. The current
  // `costRate` is the central tendency (mode); user-edited rate
  // changes propagate to the stored triangular automatically on save.
  const initialIsTriangular = initialHourlyRateDistribution?.type === 'triangular';
  function inferBestPct(): string {
    if (!initialIsTriangular) return '';
    const rate = initialCostRate ?? initialHourlyRateDistribution!.mode;
    if (rate <= 0) return '';
    const pct = ((rate - initialHourlyRateDistribution!.min) / rate) * 100;
    return pct > 0 ? String(Math.round(pct * 10) / 10) : '';
  }
  function inferWorstPct(): string {
    if (!initialIsTriangular) return '';
    const rate = initialCostRate ?? initialHourlyRateDistribution!.mode;
    if (rate <= 0) return '';
    const pct = ((initialHourlyRateDistribution!.max - rate) / rate) * 100;
    return pct > 0 ? String(Math.round(pct * 10) / 10) : '';
  }
  const [rateIsUncertain, setRateIsUncertain] = useState<boolean>(
    initialHourlyRateDistribution !== undefined,
  );
  const [bestPct, setBestPct] = useState<string>(inferBestPct());
  const [worstPct, setWorstPct] = useState<string>(inferWorstPct());
  // Phase 33 Slice 2 — currency override. Empty string ≡ "use project
  // currency" so users can clear an existing override without typing the
  // project code explicitly.
  const [currencyOverride, setCurrencyOverride] = useState<string>(initialCurrencyOverride ?? '');
  // The override drives the glyph in the form's own inputs — user types
  // values "as displayed", which means in the override currency when set.
  const effectiveCurrencyCode = currencyOverride || currencyCode;
  const glyph = currencyGlyph(effectiveCurrencyCode);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    // Parse the draft strings for capacity / hoursPerDay; clamp to the
    // same minimums the inline coercion used to enforce (≥1 for
    // capacity, ≥0.5 for hoursPerDay). Empty / non-numeric drafts fall
    // back to the form's initial defaults rather than 1 / 8 hardcoded.
    const parsedCapacity = Math.max(1, Math.round(parseFloat(capacity)) || initialCapacity);
    const parsedHoursPerDay = Math.max(0.5, parseFloat(hoursPerDay) || initialHoursPerDay);
    const parsedRate = costRate.trim() === '' ? undefined : Math.max(0, parseFloat(costRate));
    const parsedPerUse = costPerUse.trim() === '' ? undefined : Math.max(0, parseFloat(costPerUse));

    // Phase 33 Slice 2 follow-up — derive the triangular distribution
    // from the user-friendly best-case / worst-case percentages.
    // Requires a non-zero rate (the percentage model is meaningless
    // without a base value). Distribution is dropped silently when the
    // checkbox is on but both percentages are 0/empty — that's a
    // degenerate distribution (min=mode=max) and indistinguishable
    // from "no uncertainty" anyway.
    let dist: Distribution | undefined;
    if (rateIsUncertain && parsedRate !== undefined && parsedRate > 0) {
      const best = parseFloat(bestPct);
      const worst = parseFloat(worstPct);
      const safeBest = isFinite(best) ? Math.max(0, best) : 0;
      const safeWorst = isFinite(worst) ? Math.max(0, worst) : 0;
      if (safeBest > 0 || safeWorst > 0) {
        // min = rate × (1 − best%); max = rate × (1 + worst%); mode = rate.
        // safeBest is clamped to ≤ 100 so min stays non-negative
        // (a 100% best-case discount means the rate could go to 0).
        const clampedBest = Math.min(100, safeBest);
        dist = {
          type: 'triangular',
          min: parsedRate * (1 - clampedBest / 100),
          mode: parsedRate,
          max: parsedRate * (1 + safeWorst / 100),
        };
      }
    }

    // Phase 33 Slice 2 — empty / project-matching override → undefined
    // so the file never carries a redundant `currencyOverride` equal to
    // the project's own currency.
    const overrideOut =
      currencyOverride.trim() === '' || currencyOverride === currencyCode
        ? undefined
        : currencyOverride;

    onSubmit(
      trimmed,
      parsedCapacity,
      workingDays,
      parsedHoursPerDay,
      parsedRate !== undefined && isFinite(parsedRate) ? parsedRate : undefined,
      parsedPerUse !== undefined && isFinite(parsedPerUse) ? parsedPerUse : undefined,
      dist,
      overrideOut,
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-2 px-4 py-3 bg-emerald-50 dark:bg-emerald-900/20 border-b border-emerald-100 dark:border-gray-700"
    >
      <input
        type="text"
        placeholder="Resource name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
        autoFocus
      />

      <div className="flex items-center gap-3">
        <div className="flex flex-col gap-0.5">
          <label className="text-xs text-gray-500">Capacity</label>
          <input
            type="number"
            min={1}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            className="w-16 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-1 text-sm focus:outline-none"
          />
        </div>
        <div className="flex flex-col gap-0.5">
          <label className="text-xs text-gray-500">Hrs/day</label>
          <input
            type="number"
            min={1}
            max={24}
            step={0.5}
            value={hoursPerDay}
            onChange={(e) => setHoursPerDay(e.target.value)}
            className="w-16 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-1 text-sm focus:outline-none"
          />
        </div>
      </div>

      <div className="flex flex-col gap-0.5">
        <label className="text-xs text-gray-500">Working days</label>
        <DayPicker value={workingDays} onChange={setWorkingDays} />
      </div>

      {/* Phase 36 Slice 3 — calendar picker. Allows pointing the resource at
          a shared / project-level calendar instead of its auto-generated
          private one. The picker runs immediately on change (separate from
          the form's Save) so the underlying resource.calendarId switches
          right away; the working-days / hrs-per-day inputs above remain
          available so the user can still adjust the *currently-bound*
          calendar. When that calendar is shared, the amber note flags
          that those adjustments now ripple to every consumer. */}
      {calendarPicker && (
        <div className="flex flex-col gap-0.5">
          <label className="text-xs text-gray-500">Calendar</label>
          <select
            value={calendarPicker.currentCalendarId}
            onChange={(e) => calendarPicker.onChange(e.target.value)}
            className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-1 text-sm focus:outline-none"
          >
            {calendarPicker.availableCalendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {calendarPicker.sharedNote && (
            <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1 mt-0.5">
              <span className="shrink-0">ⓘ</span>
              <span>{calendarPicker.sharedNote}</span>
            </p>
          )}
        </div>
      )}

      {/* Phase 33 Slice 2 — per-resource currency override. Drives the
          glyph used in the Cost rate / Cost per use / triangular inputs
          below. Empty value means "use project currency". The engine
          converts the stored cost values from this currency to project
          currency at the ScheduleInput boundary via
          `convertResourceCostsToProjectCurrency`. */}
      <div className="flex flex-col gap-0.5">
        <label className="text-xs text-gray-500">
          Currency
          {currencyOverride && currencyOverride !== currencyCode
            ? ` (override · project is ${currencyCode})`
            : ''}
        </label>
        <select
          value={currencyOverride}
          onChange={(e) => setCurrencyOverride(e.target.value)}
          className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-1 text-sm focus:outline-none"
        >
          <option value="">Use project currency ({currencyCode})</option>
          {COMMON_CURRENCY_OVERRIDES.filter((c) => c !== currencyCode).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          {/* If the resource already has an override that's not in the
              common list, surface it as an option so editing doesn't drop
              it silently. */}
          {currencyOverride &&
            currencyOverride !== currencyCode &&
            !COMMON_CURRENCY_OVERRIDES.includes(
              currencyOverride as (typeof COMMON_CURRENCY_OVERRIDES)[number],
            ) && (
              <option key={currencyOverride} value={currencyOverride}>
                {currencyOverride}
              </option>
            )}
        </select>
      </div>

      {/* Phase 19 — Cost fields. Both optional; absent ≡ zero. Phase 33
          Slice 2 follow-up — `min-w-0` + `w-full` lets the inputs shrink
          below their intrinsic ~120px min-width so two side-by-side
          fit in the 320px Resources Pool column without overflow. */}
      <div className="flex items-start gap-3">
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <label className="text-xs text-gray-500 truncate">Cost rate ({glyph}/hour)</label>
          <input
            type="number"
            min={0}
            step={currencyStep(effectiveCurrencyCode, parseFloat(costRate) || 0, 'rate')}
            value={costRate}
            placeholder="0"
            onChange={(e) => setCostRate(e.target.value)}
            className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-1 text-sm focus:outline-none"
          />
        </div>
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <label className="text-xs text-gray-500 truncate">Cost per use ({glyph})</label>
          <input
            type="number"
            min={0}
            step={currencyStep(effectiveCurrencyCode, parseFloat(costPerUse) || 0, 'rate')}
            value={costPerUse}
            placeholder="0"
            onChange={(e) => setCostPerUse(e.target.value)}
            className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-1 text-sm focus:outline-none"
          />
        </div>
      </div>

      {/* Phase 33 Slice 2 follow-up — rate uncertainty in
          "best-case −% / worst-case +%" terms. Asymmetric by design:
          procurement reasoning is naturally asymmetric. Disabled when
          the rate is empty/zero — percentages need a base value to
          mean anything. Stored as a triangular distribution behind
          the scenes; the user never sees min/mode/max. */}
      <div className="flex flex-col gap-1">
        {(() => {
          const parsedRate = parseFloat(costRate);
          const hasRate = isFinite(parsedRate) && parsedRate > 0;
          const previewBest = (() => {
            const b = parseFloat(bestPct);
            if (!hasRate || !isFinite(b) || b <= 0) return null;
            return parsedRate * (1 - Math.min(100, b) / 100);
          })();
          const previewWorst = (() => {
            const w = parseFloat(worstPct);
            if (!hasRate || !isFinite(w) || w <= 0) return null;
            return parsedRate * (1 + w / 100);
          })();
          return (
            <>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={rateIsUncertain}
                  disabled={!hasRate}
                  onChange={(e) => setRateIsUncertain(e.target.checked)}
                  className="rounded border-gray-300 dark:border-gray-600 text-emerald-600 focus:ring-emerald-500 disabled:opacity-40"
                />
                <span
                  className={`text-xs ${hasRate ? 'text-gray-600 dark:text-gray-400' : 'text-gray-400 dark:text-gray-600'}`}
                >
                  Rate is uncertain
                </span>
                {!hasRate && (
                  <span className="text-[10px] max-md:text-xs text-gray-400 dark:text-gray-500">
                    (set a cost rate first)
                  </span>
                )}
              </label>
              {rateIsUncertain && hasRate && (
                <>
                  <div className="flex items-start gap-1.5">
                    <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                      <label className="text-[10.5px] max-md:text-xs text-gray-400 truncate">
                        Best case
                      </label>
                      <div className="relative">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          value={bestPct}
                          placeholder="0"
                          onChange={(e) => setBestPct(e.target.value)}
                          className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 pl-5 pr-1.5 py-1 text-sm focus:outline-none"
                        />
                        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[11px] max-md:text-xs text-gray-400 pointer-events-none">
                          −
                        </span>
                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[11px] max-md:text-xs text-gray-400 pointer-events-none">
                          %
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                      <label className="text-[10.5px] max-md:text-xs text-gray-400 truncate">
                        Worst case
                      </label>
                      <div className="relative">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={worstPct}
                          placeholder="0"
                          onChange={(e) => setWorstPct(e.target.value)}
                          className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 pl-5 pr-1.5 py-1 text-sm focus:outline-none"
                        />
                        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[11px] max-md:text-xs text-gray-400 pointer-events-none">
                          +
                        </span>
                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[11px] max-md:text-xs text-gray-400 pointer-events-none">
                          %
                        </span>
                      </div>
                    </div>
                  </div>
                  {(previewBest !== null || previewWorst !== null) && (
                    <div className="text-[10px] max-md:text-xs text-gray-500 dark:text-gray-400 pl-5 font-mono">
                      Range: {glyph}
                      {(previewBest ?? parsedRate).toFixed(2)} → {glyph}
                      {parsedRate.toFixed(2)} → {glyph}
                      {(previewWorst ?? parsedRate).toFixed(2)}
                    </div>
                  )}
                </>
              )}
            </>
          );
        })()}
      </div>

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          className="flex-1 rounded bg-emerald-600 text-white text-sm py-1 hover:bg-emerald-700"
        >
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-sm py-1 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Day-grid math ─────────────────────────────────────────────────────────────

function dayIdx(date: Date, start: Date): number {
  return Math.floor((date.getTime() - start.getTime()) / 86_400_000);
}

/**
 * Returns resourceId → number[] where index i = utilization on day i.
 */
function computeDailyUtilization(
  result: ScheduleResult,
  projectStart: Date,
  totalDays: number,
  resourceIds: ReadonlyArray<string>,
): Record<string, number[]> {
  const util: Record<string, number[]> = {};
  for (const id of resourceIds) {
    util[id] = new Array<number>(totalDays).fill(0);
  }
  for (const entry of result.resourceTimeline) {
    const arr = util[entry.resourceId];
    if (!arr) continue;
    const from = Math.max(0, dayIdx(entry.start, projectStart));
    const to = Math.min(totalDays - 1, dayIdx(entry.end, projectStart));
    for (let d = from; d <= to; d++) {
      arr[d] = (arr[d] ?? 0) + entry.count;
    }
  }
  return util;
}

// ── Per-resource histogram (existing chart, kept for the "Per resource" tab) ─

const BAR_W = 20;
const MAX_BAR_H = 60;
const OVER_CAPACITY_BAR_H = MAX_BAR_H * 1.25;
const LABEL_H = 30;
const SVG_H = OVER_CAPACITY_BAR_H + LABEL_H;

const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

interface PerResourceChartProps {
  project: ProjectFile;
  result: ScheduleResult;
  projectStart: Date;
  totalDays: number;
  util: Record<string, number[]>;
}

interface TooltipState {
  resourceId: string;
  day: number;
  count: number;
  capacity: number;
  x: number;
  y: number;
}

function PerResourceChart({
  project,
  result: _result,
  projectStart,
  totalDays,
  util,
}: PerResourceChartProps) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const clearTooltip = useCallback(() => setTooltip(null), []);

  return (
    <div className="flex-1 overflow-auto p-4 flex flex-col gap-6">
      {project.resources.map((res) => {
        const days = util[res.id] ?? [];
        const svgW = totalDays * BAR_W;
        const tt = tooltip?.resourceId === res.id ? tooltip : null;

        return (
          <div key={res.id} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
                {res.name}
              </span>
              <span className="text-xs text-gray-400 dark:text-gray-500">
                capacity {res.capacity}
              </span>
            </div>

            <div className="overflow-x-auto">
              <svg width={svgW} height={SVG_H} onMouseLeave={clearTooltip}>
                <line
                  x1={0}
                  y1={SVG_H - LABEL_H - MAX_BAR_H}
                  x2={svgW}
                  y2={SVG_H - LABEL_H - MAX_BAR_H}
                  stroke="#d1d5db"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
                {days.map((count, i) => {
                  if (count === 0) return null;
                  const overCapacity = count > res.capacity;
                  const atCapacity = count === res.capacity;
                  const barH = overCapacity
                    ? OVER_CAPACITY_BAR_H
                    : (count / res.capacity) * MAX_BAR_H;
                  const fill = overCapacity ? '#ef4444' : atCapacity ? '#f59e0b' : '#3b82f6';
                  const barTop = SVG_H - LABEL_H - barH;
                  return (
                    <g key={i}>
                      <rect
                        x={i * BAR_W + 1}
                        y={barTop}
                        width={BAR_W - 2}
                        height={barH}
                        fill={fill}
                        rx={2}
                        opacity={0.85}
                        style={{ cursor: 'crosshair' }}
                        onMouseEnter={() =>
                          setTooltip({
                            resourceId: res.id,
                            day: i,
                            count,
                            capacity: res.capacity,
                            x: i * BAR_W + BAR_W / 2,
                            y: barTop,
                          })
                        }
                      />
                      {overCapacity && (
                        <text
                          x={i * BAR_W + BAR_W / 2}
                          y={barTop - 2}
                          textAnchor="middle"
                          fontSize={9}
                          fill="#ef4444"
                        >
                          {count}
                        </text>
                      )}
                    </g>
                  );
                })}

                <text x={2} y={SVG_H - LABEL_H - MAX_BAR_H + 10} fontSize={9} fill="#9ca3af">
                  {res.capacity}
                </text>

                {Array.from({ length: totalDays }, (_, i) => {
                  const d = new Date(projectStart.getTime() + i * 86_400_000);
                  return (
                    <text
                      key={i}
                      x={i * BAR_W + BAR_W / 2}
                      y={SVG_H - 18}
                      textAnchor="middle"
                      fontSize={8}
                      fill="#9ca3af"
                    >
                      {d.getDate()}
                    </text>
                  );
                })}

                {Array.from({ length: totalDays }, (_, i) => {
                  const d = new Date(projectStart.getTime() + i * 86_400_000);
                  const isMonthStart = i === 0 || d.getDate() === 1;
                  if (!isMonthStart) return null;
                  return (
                    <text
                      key={`m${i}`}
                      x={i * BAR_W + 1}
                      y={SVG_H - 6}
                      textAnchor="start"
                      fontSize={8}
                      fontWeight="600"
                      fill="#6b7280"
                    >
                      {MONTH_ABBR[d.getMonth()]}
                    </text>
                  );
                })}

                {tt !== null &&
                  (() => {
                    const pct = Math.round((tt.count / tt.capacity) * 100);
                    const label = `${tt.count}/${tt.capacity} · ${pct}%`;
                    const tx = Math.min(Math.max(tt.x - 34, 2), svgW - 70);
                    const ty = Math.max(tt.y - 20, 2);
                    return (
                      <g style={{ pointerEvents: 'none' }}>
                        <rect
                          x={tx}
                          y={ty}
                          width={68}
                          height={16}
                          fill="white"
                          stroke="#e5e7eb"
                          strokeWidth={1}
                          rx={3}
                        />
                        <text
                          x={tx + 34}
                          y={ty + 11}
                          textAnchor="middle"
                          fontSize={9}
                          fill="#374151"
                        >
                          {label}
                        </text>
                      </g>
                    );
                  })()}
              </svg>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Stacked allocation chart (the new "Stacked" tab) ─────────────────────────

const STACK_PALETTE = [
  '#6366f1', // indigo
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#8b5cf6', // violet
  '#0ea5e9', // sky
  '#84cc16', // lime
];

// ── Toolbar (zoom + pool filter, Phase 47 Slice 2) ───────────────────────────

interface ResourcesChartToolbarProps {
  project: ProjectFile;
  hiddenResourceIds: ReadonlySet<string>;
  onToggleResource: (id: string) => void;
  onClearHidden: () => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  /** Per-resource subtab doesn't need the pool-filter chips (each chart is
   *  per-pool anyway), so it passes `false` to render zoom only. */
  showFilter?: boolean;
}

function ResourcesChartToolbar({
  project,
  hiddenResourceIds,
  onToggleResource,
  onClearHidden,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  showFilter = true,
}: ResourcesChartToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {showFilter && (
        <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
          {project.resources.map((res, idx) => {
            const hidden = hiddenResourceIds.has(res.id);
            const color = STACK_PALETTE[idx % STACK_PALETTE.length] ?? STACK_PALETTE[0]!;
            return (
              <button
                key={res.id}
                type="button"
                onClick={() => onToggleResource(res.id)}
                title={hidden ? `Show ${res.name}` : `Hide ${res.name}`}
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] max-md:text-xs transition-colors ${
                  hidden
                    ? 'border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-600 line-through'
                    : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                <span
                  className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                  style={{ backgroundColor: hidden ? '#9ca3af' : color }}
                />
                <span className="truncate max-w-[14ch]">{res.name}</span>
              </button>
            );
          })}
          {hiddenResourceIds.size > 0 && (
            <button
              type="button"
              onClick={onClearHidden}
              className="text-[10.5px] max-md:text-xs text-emerald-700 dark:text-emerald-400 hover:underline"
            >
              Show all
            </button>
          )}
        </div>
      )}
      {/* `ml-auto` keeps the zoom group right-aligned even when the
          pool-filter chip row is hidden (Per-resource subtab), so its
          position matches the Stacked subtab exactly. */}
      <div className="inline-flex items-center bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-md overflow-hidden text-[12px] shrink-0 ml-auto">
        <button
          type="button"
          onClick={onZoomOut}
          disabled={zoom <= 1}
          title="Zoom out"
          className="w-7 h-7 inline-flex items-center justify-center text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed border-r border-gray-100 dark:border-gray-800"
        >
          −
        </button>
        <button
          type="button"
          onClick={onZoomReset}
          title="Reset zoom"
          className="px-2 h-7 inline-flex items-center justify-center font-mono text-[11px] max-md:text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 border-r border-gray-100 dark:border-gray-800 min-w-[3.5ch]"
        >
          {zoom}×
        </button>
        <button
          type="button"
          onClick={onZoomIn}
          disabled={zoom >= 8}
          title="Zoom in"
          className="w-7 h-7 inline-flex items-center justify-center text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          ＋
        </button>
      </div>
    </div>
  );
}

interface StackedChartProps {
  project: ProjectFile;
  totalDays: number;
  projectStart: Date;
  util: Record<string, number[]>;
  /** Sum of all resource capacities — the team-wide ceiling. */
  teamCapacity: number;
  /**
   * Phase 47 Slice 2 — resource ids the user has toggled off via the
   * pool-filter chips above the chart. Hidden resources don't contribute
   * to dailyTotals (so over-capacity wash reflects only visible pools)
   * and skip their bars / legend entries / tooltip rows.
   */
  hiddenResourceIds: ReadonlySet<string>;
}

function StackedAllocationChart({
  project,
  totalDays,
  projectStart,
  util,
  teamCapacity,
  hiddenResourceIds,
}: StackedChartProps) {
  // viewBox width tracks the actual rendered container width so 1
  // viewBox-unit = 1 screen-pixel. Combined with the HTML legend below
  // (extracted previously because `preserveAspectRatio="none"` stretches
  // <text> horizontally), this keeps the in-chart axis labels at their
  // declared `fontSize` instead of growing/stretching with the container.
  const { ref: chartRef, width: VBOX_W } = useContainerWidth(720);
  // VBOX_H stays at 220 (was 240 before the legend extraction); the
  // legend now renders as HTML below the SVG so the in-chart area is
  // bars + axis + capacity-line only.
  const VBOX_H = 220;
  const PLOT_H = 200;
  const dayW = totalDays > 0 ? VBOX_W / totalDays : 0;

  // Find max stacked sum across days for scaling.
  // Phase 47 Slice 2 — hidden resources are excluded from the totals so the
  // over-capacity wash reflects only what's currently plotted.
  const visibleResources = project.resources.filter((r) => !hiddenResourceIds.has(r.id));
  const dailyTotals = Array.from({ length: totalDays }, (_, d) =>
    visibleResources.reduce((sum, r) => sum + (util[r.id]?.[d] ?? 0), 0),
  );
  const ceiling = Math.max(teamCapacity, ...dailyTotals, 1);
  const yScale = PLOT_H / ceiling;

  // Mark over-capacity days for the red wash.
  const overCapDays = dailyTotals
    .map((total, i) => (total > teamCapacity ? i : -1))
    .filter((i) => i >= 0);

  // Phase 19 slice 5 — draggable date cursor. Snaps to integer day index;
  // tooltip shows the cursor's date plus each resource's headcount on
  // that day, flagged when the team is over capacity.
  const cursor = useChartCursor({
    clientXToData: (relX, svgWidth) => {
      if (svgWidth <= 0 || totalDays === 0) return null;
      const svgX = (relX / svgWidth) * VBOX_W;
      if (svgX < 0 || svgX > VBOX_W) return null;
      return svgX / dayW;
    },
    snap: (dayFractional) => {
      const d = Math.floor(dayFractional);
      return Math.max(0, Math.min(totalDays - 1, d));
    },
  });
  const cursorDay = cursor.cursorDataValue;

  return (
    <div ref={chartRef} className="relative">
      <svg
        width="100%"
        height={VBOX_H}
        viewBox={`0 0 ${VBOX_W} ${VBOX_H}`}
        preserveAspectRatio="none"
        className="block cursor-crosshair select-none"
        {...cursor.pointerHandlers}
      >
        {/* Y gridlines (4 ticks) */}
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
          <line
            key={i}
            x1={0}
            y1={PLOT_H - f * PLOT_H}
            x2={VBOX_W}
            y2={PLOT_H - f * PLOT_H}
            className="stroke-gray-100 dark:stroke-gray-800"
            strokeWidth={1}
          />
        ))}

        {/* Capacity ceiling line */}
        <line
          x1={0}
          y1={PLOT_H - teamCapacity * yScale}
          x2={VBOX_W}
          y2={PLOT_H - teamCapacity * yScale}
          stroke="#cbd5e1"
          strokeDasharray="3 3"
          strokeWidth={1}
        />
        <text x={4} y={PLOT_H - teamCapacity * yScale - 4} fontSize={9} fill="#6b7280">
          team capacity ({teamCapacity})
        </text>

        {/* Over-cap day washes */}
        {overCapDays.map((i) => (
          <rect
            key={`over-${i}`}
            x={i * dayW}
            y={0}
            width={dayW}
            height={PLOT_H}
            fill="#fef2f2"
            opacity={0.55}
          />
        ))}

        {/* Stacked bars — iterate over the full resource list so the palette
          index stays stable (hiding pool #3 doesn't shift pool #4's colour),
          but skip hidden ones at render time. */}
        {Array.from({ length: totalDays }, (_, d) => {
          let yCursor = PLOT_H;
          return (
            <g key={d}>
              {project.resources.map((res, idx) => {
                if (hiddenResourceIds.has(res.id)) return null;
                const v = util[res.id]?.[d] ?? 0;
                if (v === 0) return null;
                const h = v * yScale;
                yCursor -= h;
                const overTeam = dailyTotals[d]! > teamCapacity;
                const color = STACK_PALETTE[idx % STACK_PALETTE.length] ?? STACK_PALETTE[0]!;
                return (
                  <rect
                    key={res.id}
                    x={d * dayW + 0.5}
                    y={yCursor}
                    width={Math.max(0.5, dayW - 1)}
                    height={h}
                    fill={color}
                    opacity={overTeam ? 0.95 : 0.78}
                    rx={1}
                  >
                    <title>{`${res.name}: ${v} on day ${d}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}

        {/* X-axis: week markers */}
        {Array.from({ length: totalDays }, (_, i) => {
          const d = new Date(projectStart.getTime() + i * 86_400_000);
          const isMonthStart = i === 0 || d.getDate() === 1;
          if (!isMonthStart) return null;
          return (
            <text key={`m${i}`} x={i * dayW + 4} y={VBOX_H - 6} fontSize={9} fill="#6b7280">
              {MONTH_ABBR[d.getMonth()]} {d.getDate()}
            </text>
          );
        })}

        {/* Phase 19 slice 5 — cursor line. Snaps to integer day; spans the
          full plot height so the day column is unambiguous. */}
        {cursorDay !== null &&
          (() => {
            const cx = (cursorDay + 0.5) * dayW;
            return (
              <g pointerEvents="none">
                <line
                  x1={cx}
                  y1={0}
                  x2={cx}
                  y2={PLOT_H}
                  stroke="#64748b"
                  strokeWidth={cursor.isDragging ? 1.5 : 1}
                  strokeDasharray="4 3"
                  vectorEffect="non-scaling-stroke"
                />
                <path d={`M${cx - 5},0 L${cx + 5},0 L${cx},6 Z`} fill="#64748b" />
              </g>
            );
          })()}
      </svg>
      {/* The in-chart legend was removed in Phase 47 Slice 2 — the
        pool-filter chip row above the chart now doubles as the legend
        and the toggle, so a separate legend below would be redundant. */}

      {/* Phase 19 slice 5 — cursor tooltip. Lists each resource's headcount
        on the cursor's day, flags the over-team-capacity case. */}
      {cursorDay !== null &&
        (() => {
          const cursorDate = new Date(projectStart.getTime() + cursorDay * 86_400_000);
          const cxFrac = (cursorDay + 0.5) / totalDays;
          const flipLeft = cxFrac > 0.65;
          const total = dailyTotals[cursorDay] ?? 0;
          const overCap = total > teamCapacity;
          return (
            <div
              className="absolute pointer-events-none rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-gray-900 shadow-md px-2.5 py-1.5 text-[11px] max-md:text-xs leading-tight"
              style={{
                top: 6,
                left: flipLeft ? undefined : `calc(${cxFrac * 100}% + 8px)`,
                right: flipLeft ? `calc(${(1 - cxFrac) * 100}% + 8px)` : undefined,
                minWidth: 170,
                maxWidth: 220,
                zIndex: 3,
              }}
            >
              <div className="text-gray-500 dark:text-gray-400 text-[10px] max-md:text-xs mb-0.5">
                {cursorDate.toLocaleDateString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })}{' '}
                · Day {cursorDay}
              </div>
              <div className="flex justify-between gap-2 text-gray-700 dark:text-gray-200">
                <span>Team total</span>
                <span
                  className={`font-mono font-semibold ${overCap ? 'text-rose-700 dark:text-rose-400' : 'text-gray-700 dark:text-gray-200'}`}
                >
                  {total} {overCap ? `/ ${teamCapacity}` : ''}
                </span>
              </div>
              <div className="mt-1 flex flex-col gap-0.5">
                {project.resources.map((res, idx) => {
                  if (hiddenResourceIds.has(res.id)) return null;
                  const v = (util[res.id] ?? [])[cursorDay] ?? 0;
                  if (v === 0) return null;
                  const color = STACK_PALETTE[idx % STACK_PALETTE.length] ?? STACK_PALETTE[0]!;
                  const over = v > res.capacity;
                  return (
                    <div
                      key={res.id}
                      className="flex justify-between gap-2 text-[10.5px] max-md:text-xs"
                    >
                      <span className="inline-flex items-center gap-1.5 truncate">
                        <span
                          className="inline-block w-2 h-2 rounded-sm shrink-0"
                          style={{ backgroundColor: color }}
                        />
                        <span className="truncate text-gray-700 dark:text-gray-300">
                          {res.name}
                        </span>
                      </span>
                      <span
                        className={`font-mono ${over ? 'text-rose-700 dark:text-rose-400 font-semibold' : 'text-gray-600 dark:text-gray-400'}`}
                      >
                        {v}
                        {over ? ` / ${res.capacity}` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}
    </div>
  );
}

// ── Sparkline (resource list per-row) ────────────────────────────────────────

function Sparkline({ vals, capacity }: { vals: number[]; capacity: number }) {
  const W = 110;
  const H = 22;
  const cap = Math.max(capacity, 1);
  const n = Math.max(vals.length, 1);
  const step = W / n;
  return (
    <svg width={W} height={H} className="block shrink-0">
      <line
        x1={0}
        y1={H - (H - 2) * (cap / Math.max(cap, ...vals, 1))}
        x2={W}
        y2={H - (H - 2) * (cap / Math.max(cap, ...vals, 1))}
        stroke="#cbd5e1"
        strokeDasharray="2 2"
        strokeWidth={0.5}
      />
      {vals.map((v, i) => {
        if (v === 0) return null;
        const over = v > cap;
        const at = v === cap && v > 0;
        const fill = over ? '#ef4444' : at ? '#f59e0b' : '#3b82f6';
        const peak = Math.max(cap, ...vals, 1);
        const h = (v / peak) * (H - 3);
        return (
          <rect
            key={i}
            x={i * step + 0.4}
            y={H - h - 1}
            width={Math.max(0.6, step - 0.8)}
            height={h}
            fill={fill}
            opacity={0.85}
            rx={0.5}
          />
        );
      })}
    </svg>
  );
}

// ── Conflict card (stub actions for Phase 16) ───────────────────────────────

interface Conflict {
  /** Phase 17 — resource id, needed by the Increase-capacity + Reassign flows. */
  resourceId: string;
  resourceName: string;
  capacity: number;
  peakCount: number;
  /** Day indices where the resource is over-capacity. */
  overDays: number[];
  /**
   * Activities (by name) sharing this resource on at least one over-cap day.
   * Sorted by slack descending — least-critical first.
   */
  activities: string[];
  /** Phase 17 — node ids parallel to `activities`, in the same order. */
  activityIds: string[];
  /**
   * Phase 17 slice 2 (priority-ordered reassign) — slack hours per activity,
   * parallel to activityIds. Used to display "low priority / high priority"
   * hints in the Reassign panel.
   */
  activitySlackHours: number[];
  /**
   * Phase 18 slice 3 — units this activity contributes to the conflicting
   * resource (the assignment's `count`). Parallel to activityIds. Drives the
   * conflict-card "contributes N of P/C peak" display and the Reassign
   * panel's per-row count input (bounded to [1, activityContributions[i]]
   * because you can't split more than the activity actually demands).
   */
  activityContributions: number[];
  /**
   * Phase 17 slice 2 — peakCount − capacity. The number of activities we
   * suggest moving to a fallback resource to bring peak back under capacity.
   * Zero means no overflow (shouldn't happen for a conflict, but defensive).
   */
  overflow: number;
  /**
   * Phase 17 slice 2 — for each OTHER resource, free units on this conflict's
   * over-cap days. Free = capacity − max(util on those days). Lets the
   * Reassign panel show "free X/cap Y" hints in the target dropdown and
   * default to the target with the most available capacity, instead of
   * blindly suggesting a resource that's already saturated.
   */
  targetHeadroom: Record<string, number>;
}

function findConflicts(
  project: ProjectFile,
  result: ScheduleResult,
  util: Record<string, number[]>,
  totalDays: number,
  projectStart: Date,
): Conflict[] {
  const out: Conflict[] = [];
  const startMs = projectStart.getTime();
  for (const res of project.resources) {
    const days = util[res.id] ?? [];
    const overDays: number[] = [];
    let peak = 0;
    for (let d = 0; d < totalDays; d++) {
      const v = days[d] ?? 0;
      if (v > res.capacity) overDays.push(d);
      if (v > peak) peak = v;
    }
    if (overDays.length === 0) continue;

    // Day indices in `util` are relative to projectStart, so timeline entry
    // start/end need to be projected onto the same axis before checking
    // overlap with `overDays`.
    const overSet = new Set(overDays);
    const activityIds = new Set<string>();
    for (const e of result.resourceTimeline) {
      if (e.resourceId !== res.id) continue;
      const fromDay = Math.max(0, Math.floor((e.start.getTime() - startMs) / 86_400_000));
      const toDay = Math.min(totalDays - 1, Math.floor((e.end.getTime() - startMs) / 86_400_000));
      for (let d = fromDay; d <= toDay; d++) {
        if (overSet.has(d)) {
          activityIds.add(e.nodeId);
          break;
        }
      }
    }
    // Phase 17 slice 2 — sort activities by slack descending so the
    // Reassign panel can present least-critical (highest-slack) activities
    // as the suggested ones to move, preserving the user's primary
    // assignments on the most schedule-critical activities. Tiebreaker on
    // node id keeps the order deterministic across reruns.
    const sortedIds = [...activityIds].sort((a, b) => {
      const sa = result.nodes[a]?.slackHours ?? 0;
      const sb = result.nodes[b]?.slackHours ?? 0;
      if (sa !== sb) return sb - sa;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const idList = sortedIds.slice(0, 6);
    const nameList = idList.map((id) => project.nodes.find((n) => n.id === id)?.name ?? id);
    const slackList = idList.map((id) => result.nodes[id]?.slackHours ?? 0);
    // Phase 18 slice 3 — pull each activity's count on this specific
    // resource. Falls back to 0 if the activity somehow doesn't have an
    // assignment for this resource (shouldn't happen — activityIds came
    // from the resource's timeline — but defensive).
    const contributionList = idList.map((id) => {
      const node = project.nodes.find((n) => n.id === id);
      return node?.resourceAssignments.find((a) => a.resourceId === res.id)?.count ?? 0;
    });

    // Phase 17 slice 2 — compute available headroom on every OTHER resource
    // restricted to this conflict's over-cap days. Free = capacity − max
    // (util on those days). Drives "free X/cap Y" hints in the Reassign
    // dropdown and the smart default-target choice (prefer the target
    // most able to absorb the move).
    const targetHeadroom: Record<string, number> = {};
    for (const target of project.resources) {
      if (target.id === res.id) continue;
      const tDays = util[target.id] ?? [];
      let maxOnOverDays = 0;
      for (const d of overDays) {
        const v = tDays[d] ?? 0;
        if (v > maxOnOverDays) maxOnOverDays = v;
      }
      targetHeadroom[target.id] = Math.max(0, target.capacity - maxOnOverDays);
    }

    out.push({
      resourceId: res.id,
      resourceName: res.name,
      capacity: res.capacity,
      peakCount: peak,
      overDays,
      activities: nameList,
      activityIds: idList,
      activitySlackHours: slackList,
      activityContributions: contributionList,
      overflow: Math.max(0, peak - res.capacity),
      targetHeadroom,
    });
  }
  return out;
}

type ConflictAction = 'reassign' | 'capacity' | null;

function ConflictCard({
  conflict,
  project,
  onSuggestLeveling,
  onSetCapacity,
  onSplitAssignment,
  busy,
}: {
  conflict: Conflict;
  project: ProjectFile;
  onSuggestLeveling: () => void;
  onSetCapacity: (resourceId: string, newCapacity: number) => void;
  // Phase 18 slice 3 — Reassign is now a split, not a swap. The parent
  // dispatches `splitResourceAssignment(nodeId, from, to, count)`; full-swap
  // is just a split where count === activity's current contribution.
  onSplitAssignment: (
    nodeId: string,
    fromResourceId: string,
    toResourceId: string,
    count: number,
  ) => void;
  busy: boolean;
}) {
  const [openAction, setOpenAction] = useState<ConflictAction>(null);
  const dayRange =
    conflict.overDays.length === 1
      ? `day ${conflict.overDays[0]}`
      : `${conflict.overDays.length} days`;

  return (
    <div className="border border-rose-200 dark:border-rose-900 bg-rose-50/70 dark:bg-rose-950/30 rounded-lg p-3.5 flex flex-col gap-2">
      <div className="inline-flex items-center gap-2">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-100 dark:bg-rose-900/60 text-rose-700 dark:text-rose-300 text-[10.5px] max-md:text-xs font-semibold">
          {conflict.overDays.length} conflict{conflict.overDays.length === 1 ? '' : 's'}
        </span>
        <span className="text-[13px] font-semibold text-rose-900 dark:text-rose-200">
          {conflict.resourceName} over-capacity on {dayRange}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {conflict.activities.map((name, i) => {
          // Phase 18 slice 3 — per-activity contribution. The "N of P/C peak"
          // wording makes the relationship explicit: this activity uses N of
          // the P units demanded against C capacity. After a split lands, the
          // schedule re-runs and N updates to reflect what's still on this
          // resource (with the activity dropping out of the list entirely if
          // its contribution falls to zero).
          const contribution = conflict.activityContributions[i] ?? 0;
          return (
            <div key={name} className="flex items-center gap-2 text-[12px]">
              <span className="w-1 h-3.5 rounded-sm bg-amber-400" />
              <span className="text-gray-800 dark:text-gray-200 font-medium flex-1">{name}</span>
              <span className="text-[11px] max-md:text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                contributes {contribution} of {conflict.peakCount}/{conflict.capacity} peak
              </span>
            </div>
          );
        })}
      </div>
      <div className="inline-flex gap-1.5 mt-1.5">
        <button
          type="button"
          onClick={onSuggestLeveling}
          disabled={busy}
          title={
            busy
              ? 'Computing leveling plan…'
              : 'Compute an auto-leveling plan that shifts lower-priority activities later until no resource is over capacity'
          }
          className="text-[11.5px] max-md:text-xs font-medium px-2.5 py-1 rounded border bg-rose-600 hover:bg-rose-700 text-white border-rose-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? 'Computing…' : 'Suggest leveling'}
        </button>
        <button
          type="button"
          onClick={() => setOpenAction((cur) => (cur === 'reassign' ? null : 'reassign'))}
          disabled={busy}
          aria-expanded={openAction === 'reassign'}
          title="Move one or more of these activities to a different resource"
          className={[
            'text-[11.5px] max-md:text-xs font-medium px-2.5 py-1 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
            openAction === 'reassign'
              ? 'bg-rose-100 dark:bg-rose-900/60 text-rose-800 dark:text-rose-200 border-rose-300 dark:border-rose-800'
              : 'bg-white dark:bg-gray-900 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900 hover:bg-rose-50 dark:hover:bg-rose-950/40',
          ].join(' ')}
        >
          Reassign…
        </button>
        <button
          type="button"
          onClick={() => setOpenAction((cur) => (cur === 'capacity' ? null : 'capacity'))}
          disabled={busy}
          aria-expanded={openAction === 'capacity'}
          title={`Bump ${conflict.resourceName}'s capacity to cover peak demand (${conflict.peakCount})`}
          className={[
            'text-[11.5px] max-md:text-xs font-medium px-2.5 py-1 rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
            openAction === 'capacity'
              ? 'bg-rose-100 dark:bg-rose-900/60 text-rose-800 dark:text-rose-200 border-rose-300 dark:border-rose-800'
              : 'bg-white dark:bg-gray-900 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900 hover:bg-rose-50 dark:hover:bg-rose-950/40',
          ].join(' ')}
        >
          Increase capacity
        </button>
      </div>

      {/* Phase 17 slice 2 — inline panels. Render inside the same red card
          so the action stays in context with the conflict it addresses,
          instead of a centred modal that interrupts the flow. */}
      {openAction === 'capacity' && (
        <IncreaseCapacityPanel
          conflict={conflict}
          onClose={() => setOpenAction(null)}
          onApply={(newCapacity) => {
            onSetCapacity(conflict.resourceId, newCapacity);
            setOpenAction(null);
          }}
        />
      )}
      {openAction === 'reassign' && (
        <ReassignPanel
          conflict={conflict}
          project={project}
          onClose={() => setOpenAction(null)}
          onApplySplit={(nodeId, fromResourceId, toResourceId, count) =>
            onSplitAssignment(nodeId, fromResourceId, toResourceId, count)
          }
        />
      )}
    </div>
  );
}

// ── KPI strip ────────────────────────────────────────────────────────────────

interface KpiData {
  totalWorkHours: number;
  peakUtilizationPct: number;
  peakResourceName: string | null;
  overCapDays: number;
  overCapResourceCount: number;
  idleResourceCount: number;
  firstIdleResourceName: string | null;
  /** Phase 19 — sum of `result.resourceCosts` across all resources. `null`
   *  when project has no cost data (hides the tile). */
  totalLaborCost: number | null;
  currency: string;
}

function ResourcesKpi({ data }: { data: KpiData }) {
  return (
    <div className="shrink-0 flex items-center gap-3.5 px-4 py-2.5 border-b border-gray-200 dark:border-gray-800 bg-gradient-to-b from-white to-emerald-50/40 dark:from-gray-900 dark:to-gray-900 max-md:flex-wrap">
      <Kpi
        label="Total work"
        value={`${Math.round(data.totalWorkHours)}h`}
        sub="across resources"
      />
      <Sep />
      {data.totalLaborCost !== null && (
        <>
          <Kpi
            label="Total labor cost"
            value={formatMoney(data.totalLaborCost, data.currency)}
            sub="rate × hours + per-use"
          />
          <Sep />
        </>
      )}
      <Kpi
        label="Peak utilization"
        value={`${data.peakUtilizationPct}%`}
        sub={data.peakResourceName ?? 'no resources'}
        tone={
          data.peakUtilizationPct > 100
            ? 'warn'
            : data.peakUtilizationPct === 100
              ? 'mid'
              : undefined
        }
      />
      <Sep />
      <Kpi
        label="Over-capacity days"
        value={String(data.overCapDays)}
        sub={`${data.overCapResourceCount} resource${data.overCapResourceCount === 1 ? '' : 's'} affected`}
        tone={data.overCapDays > 0 ? 'bad' : undefined}
      />
      <Sep />
      <Kpi
        label="Idle resources"
        value={String(data.idleResourceCount)}
        sub={data.firstIdleResourceName ?? 'none'}
        tone="mute"
      />

      <div className="flex-1" />
      <button
        type="button"
        disabled
        title="Auto-level — coming in Phase 16"
        className="bg-emerald-600 hover:bg-emerald-700 text-white text-[12.5px] font-medium px-3 py-1.5 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Auto-level…
      </button>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'warn' | 'bad' | 'mid' | 'mute' | undefined;
}) {
  const valueColor =
    tone === 'warn'
      ? 'text-amber-700 dark:text-amber-400'
      : tone === 'bad'
        ? 'text-red-700 dark:text-red-400'
        : tone === 'mid'
          ? 'text-emerald-700 dark:text-emerald-400'
          : tone === 'mute'
            ? 'text-gray-500 dark:text-gray-400'
            : 'text-gray-900 dark:text-gray-100';
  return (
    <div className="flex flex-col gap-px min-w-[120px]">
      <div className="text-[10px] max-md:text-xs font-semibold uppercase tracking-[0.05em] text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div className={`text-[16px] font-bold leading-tight tracking-tight ${valueColor}`}>
        {value}
      </div>
      <div className="text-[10.5px] max-md:text-xs text-gray-400 dark:text-gray-500 mt-0.5 truncate">
        {sub}
      </div>
    </div>
  );
}

function Sep() {
  // Hidden on mobile (`<md`) for the same reason SimulateView's Sep is:
  // the parent KPI band wraps on mobile (`max-md:flex-wrap`), so these
  // 1-px verticals become orphan lines hanging beside wrapped cards.
  return <div className="w-px h-9 bg-gray-200 dark:bg-gray-700 max-md:hidden" />;
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface ResourcesPanelProps {
  project: ProjectFile;
  result: ScheduleResult | null;
}

type FilterKey = 'all' | 'over' | 'at' | 'idle';
type DetailTab = 'stacked' | 'per' | 'conflicts';

export function ResourcesPanel({ project, result }: ResourcesPanelProps) {
  const addResource = useDomainStore((s) => s.addResource);
  const updateResource = useDomainStore((s) => s.updateResource);
  const updateResourceCalendarId = useDomainStore((s) => s.updateResourceCalendarId);
  const deleteResource = useDomainStore((s) => s.deleteResource);
  const applyEdgeLagBumps = useDomainStore((s) => s.applyEdgeLagBumps);
  const setResourceCapacity = useDomainStore((s) => s.setResourceCapacity);
  const splitResourceAssignment = useDomainStore((s) => s.splitResourceAssignment);

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [detailTab, setDetailTab] = useState<DetailTab>('stacked');

  // Phase 47 Slice 2 — Resources tab time-axis zoom + pool-visibility filter.
  // Lives in viewStore so the user's zoom level survives tab switches; the
  // hide-set is session-only because focusing on a subset is a momentary
  // intent, not a long-lived preference.
  const resourcesZoom = useViewStore((s) => s.resourcesZoom);
  const zoomResourcesIn = useViewStore((s) => s.zoomResourcesIn);
  const zoomResourcesOut = useViewStore((s) => s.zoomResourcesOut);
  const resetResourcesZoom = useViewStore((s) => s.resetResourcesZoom);
  const hiddenResourceIds = useViewStore((s) => s.hiddenResourceIds);
  const toggleResourceHidden = useViewStore((s) => s.toggleResourceHidden);
  const clearHiddenResources = useViewStore((s) => s.clearHiddenResources);

  // Phase 33 Slice 2 — FX snapshot for the per-resource cost-contribution
  // display when the resource has a `currencyOverride`. Memoised on the
  // project (the snapshot only depends on the project's pinned version
  // and the user's FX overrides). `null` when the project is pinned to
  // 'NONE' or the version is unknown — display falls back to project
  // currency in that case.
  const fxSnapshot = useMemo(() => getEffectiveFxSnapshot(project), [project]);

  // Phase 17 — auto-level state
  const [levelingPlan, setLevelingPlan] = useState<LevelingPlan | null>(null);
  const [levelingBusy, setLevelingBusy] = useState(false);
  const [levelingError, setLevelingError] = useState<string | null>(null);

  // Phase 17 slice 2 — Reassign and Increase-capacity are inline panels
  // owned by each ConflictCard, so no parent-level modal state is needed.
  // The card calls back into this handler for the actual domain mutation.
  //
  // Phase 18 slice 3 — Reassign is a split, not a swap. When `count` equals
  // the activity's current count on `fromResourceId`, splitResourceAssignment
  // naturally collapses to a swap (decrement to 0 → remove; create `to`).
  // When `count` is smaller, the activity ends up with assignments on both
  // resources — exactly the multi-resource semantics this phase enables.
  function handleSplitAssignment(
    nodeId: string,
    fromResourceId: string,
    toResourceId: string,
    count: number,
  ) {
    splitResourceAssignment(nodeId, fromResourceId, toResourceId, count);
  }

  // Compute the leveling plan on demand. We call into the scheduler
  // directly here (not the worker) because the plan is small and the
  // user is waiting for an immediate preview.
  //
  // Phase 33 Slice 2 follow-up — `suggestLeveling` is synchronous and
  // CPU-bound; on larger projects it blocks the main thread for a few
  // hundred milliseconds before the result lands. Without yielding,
  // React batches both `setLevelingBusy(true)` and `setLevelingBusy(false)`
  // around the work, so the "Computing…" button label never paints and
  // the click feels frozen. Wrapping the work in a `requestAnimationFrame`
  // (with a fallback to `setTimeout(0)`) gives React one frame to commit
  // the busy state before the synchronous computation runs.
  function handleSuggestLeveling() {
    if (!result) return;
    setLevelingBusy(true);
    setLevelingError(null);
    const yieldThenRun = (run: () => void): void => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(run));
      } else {
        setTimeout(run, 0);
      }
    };
    yieldThenRun(() => {
      try {
        const scheduleInput: ScheduleInput = {
          project: project.project,
          nodes: project.nodes,
          edges: project.edges,
          // Phase 33 Slice 2 — convert per-resource costs to project currency.
          resources: convertResourceCostsToProjectCurrency(project),
          calendars: project.calendars,
          loops: project.loops,
          subsystems: project.subsystems,
        };
        const plan = suggestLeveling(scheduleInput, result);
        if (plan === null) {
          setLevelingError(
            'No conflicts to resolve — the resource schedule is already within capacity.',
          );
        } else {
          setLevelingPlan(plan);
        }
      } catch (e) {
        setLevelingError(e instanceof Error ? e.message : String(e));
      } finally {
        setLevelingBusy(false);
      }
    });
  }

  function handleApplyLeveling() {
    if (!levelingPlan) return;
    applyEdgeLagBumps(levelingPlan.edgeLagBumps);
    setLevelingPlan(null);
  }

  // ── Schedule-derived data ─────────────────────────────────────────────────

  const projectStart = useMemo(() => {
    if (!result || result.resourceTimeline.length === 0) {
      return new Date(project.project.startDate + 'T00:00:00');
    }
    const minTs = Math.min(...result.resourceTimeline.map((e) => e.start.getTime()));
    const d = new Date(minTs);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [result, project.project.startDate]);

  const totalDays = useMemo(() => {
    if (!result) return 1;
    return Math.max(1, dayIdx(result.projectEnd, projectStart) + 2);
  }, [result, projectStart]);

  const resourceIds = project.resources.map((r) => r.id);
  const util = useMemo(
    () =>
      result
        ? computeDailyUtilization(result, projectStart, totalDays, resourceIds)
        : Object.fromEntries(resourceIds.map((id) => [id, [] as number[]])),
    [result, projectStart, totalDays, resourceIds],
  );

  const teamCapacity = project.resources.reduce((s, r) => s + r.capacity, 0);

  // Per-resource summary used by both the KPI strip and the per-row pills.
  const resourceSummary = useMemo(() => {
    const map = new Map<
      string,
      { peak: number; overDays: number; totalHours: number; idle: boolean }
    >();
    for (const res of project.resources) {
      const days = util[res.id] ?? [];
      let peak = 0;
      let overDays = 0;
      let usedDays = 0;
      let totalHours = 0;
      for (const v of days) {
        if (v > 0) usedDays++;
        if (v > peak) peak = v;
        if (v > res.capacity) overDays++;
        // Assume 8-hour days unless the resource calendar says otherwise.
        const cal = project.calendars.find((c) => c.id === res.calendarId);
        const hpd = cal?.hoursPerDay ?? 8;
        totalHours += v * hpd;
      }
      const idle = totalDays > 0 && usedDays / totalDays < 0.5;
      map.set(res.id, { peak, overDays, totalHours, idle });
    }
    return map;
  }, [project.resources, project.calendars, util, totalDays]);

  const kpi = useMemo<KpiData>(() => {
    let totalWorkHours = 0;
    let peakUtilizationPct = 0;
    let peakResourceName: string | null = null;
    let overCapResourceCount = 0;
    let firstIdleResourceName: string | null = null;
    let idleResourceCount = 0;

    for (const res of project.resources) {
      const s = resourceSummary.get(res.id);
      if (!s) continue;
      totalWorkHours += s.totalHours;
      const pct = res.capacity > 0 ? Math.round((s.peak / res.capacity) * 100) : 0;
      if (pct > peakUtilizationPct) {
        peakUtilizationPct = pct;
        peakResourceName = res.name;
      }
      if (s.overDays > 0) overCapResourceCount++;
      if (s.idle) {
        idleResourceCount++;
        if (firstIdleResourceName === null) firstIdleResourceName = res.name;
      }
    }

    // Days where the team's total exceeded the team capacity ceiling.
    let overCapDays = 0;
    for (let d = 0; d < totalDays; d++) {
      const total = project.resources.reduce((sum, r) => sum + (util[r.id]?.[d] ?? 0), 0);
      if (total > teamCapacity) overCapDays++;
    }

    // Phase 19 — total labor cost. Hidden (null) when project has no cost
    // data anywhere, even if the schedule emitted a zero result.resourceCosts
    // map. Without the predicate gate the tile would render `$0` on every
    // pre-Phase-19 project and add no information. Also `null` when the
    // schedule itself failed (no `result`).
    const totalLaborCost =
      result !== null && projectHasCostData(project)
        ? Object.values(result.resourceCosts).reduce((s, v) => s + v, 0)
        : null;

    return {
      totalWorkHours,
      peakUtilizationPct,
      peakResourceName,
      overCapDays,
      overCapResourceCount,
      idleResourceCount,
      firstIdleResourceName,
      totalLaborCost,
      currency: project.currency,
    };
  }, [project, resourceSummary, util, totalDays, teamCapacity, result]);

  const conflicts = useMemo(
    () => (result ? findConflicts(project, result, util, totalDays, projectStart) : []),
    [project, result, util, totalDays, projectStart],
  );

  // Phase 25 Slice 2 — cost of delay across critical-path activities with
  // crash options. Pure derived stat; recomputes when the schedule or any
  // crashOptions / selectedCrashIndex on those nodes changes.
  const costOfDelay: CostOfDelayResult | null = useMemo(() => {
    if (!result) return null;
    const scheduleInput: ScheduleInput = {
      project: project.project,
      nodes: project.nodes,
      edges: project.edges,
      // Phase 33 Slice 2 — convert per-resource costs to project currency.
      resources: convertResourceCostsToProjectCurrency(project),
      calendars: project.calendars,
      loops: project.loops,
      subsystems: project.subsystems,
    };
    return computeCostOfDelay(scheduleInput, result);
  }, [project, result]);

  // ── Filter chips ──────────────────────────────────────────────────────────

  const filterCounts = useMemo(() => {
    let over = 0,
      at = 0,
      idle = 0;
    for (const res of project.resources) {
      const s = resourceSummary.get(res.id);
      if (!s) continue;
      if (s.overDays > 0) over++;
      else if (s.peak === res.capacity) at++;
      else if (s.idle) idle++;
    }
    return { all: project.resources.length, over, at, idle };
  }, [project.resources, resourceSummary]);

  const visibleResources = project.resources.filter((res) => {
    const s = resourceSummary.get(res.id);
    if (!s) return true;
    switch (filter) {
      case 'over':
        return s.overDays > 0;
      case 'at':
        return s.overDays === 0 && s.peak === res.capacity;
      case 'idle':
        return s.idle && s.overDays === 0;
      default:
        return true;
    }
  });

  // ── Form handlers ─────────────────────────────────────────────────────────

  function handleAdd(
    name: string,
    capacity: number,
    workingDays: WorkingDaysUI,
    hoursPerDay: number,
    costRate: number | undefined,
    costPerUse: number | undefined,
    hourlyRateDistribution: Distribution | undefined,
    currencyOverride: string | undefined,
  ) {
    addResource({
      name,
      capacity,
      workingDays,
      hoursPerDay,
      ...(costRate !== undefined ? { costRate } : {}),
      ...(costPerUse !== undefined ? { costPerUse } : {}),
      ...(hourlyRateDistribution !== undefined ? { hourlyRateDistribution } : {}),
      ...(currencyOverride !== undefined ? { currencyOverride } : {}),
    });
    setAdding(false);
  }

  function handleUpdate(
    id: string,
    name: string,
    capacity: number,
    workingDays: WorkingDaysUI,
    hoursPerDay: number,
    costRate: number | undefined,
    costPerUse: number | undefined,
    hourlyRateDistribution: Distribution | undefined,
    currencyOverride: string | undefined,
  ) {
    updateResource(
      id,
      name,
      capacity,
      workingDays,
      hoursPerDay,
      costRate,
      costPerUse,
      hourlyRateDistribution,
      currencyOverride,
    );
    setEditingId(null);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  // Mobile Slice 5c — outer becomes the page scroller on `<md`; the
  // inner left + right panes drop their own scroll and stack vertically
  // so the right "Allocation timeline" panel isn't squeezed off-screen
  // by the 320-px left pane.
  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-gray-900 max-md:overflow-y-auto">
      <ResourcesKpi data={kpi} />

      <div className="flex-1 flex overflow-hidden max-md:flex-col max-md:overflow-visible">
        {/* ── Resource list (left) ───────────────────────────────────── */}
        <div className="w-[320px] shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col bg-white dark:bg-gray-900 max-md:w-full max-md:border-r-0 max-md:border-b">
          <div className="px-4 py-3 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">
              Resource Pool
            </h2>
            {!adding && (
              <button
                onClick={() => {
                  setEditingId(null);
                  setAdding(true);
                }}
                className="text-[12px] text-emerald-700 dark:text-emerald-400 hover:text-emerald-900 font-medium"
              >
                + Add
              </button>
            )}
          </div>

          {/* Filter chips */}
          <div className="px-4 pb-2.5 border-b border-gray-100 dark:border-gray-800 flex flex-wrap gap-1">
            <FilterChip
              on={filter === 'all'}
              count={filterCounts.all}
              onClick={() => setFilter('all')}
            >
              All
            </FilterChip>
            <FilterChip
              on={filter === 'over'}
              count={filterCounts.over}
              onClick={() => setFilter('over')}
            >
              Over capacity
            </FilterChip>
            <FilterChip
              on={filter === 'at'}
              count={filterCounts.at}
              onClick={() => setFilter('at')}
            >
              At capacity
            </FilterChip>
            <FilterChip
              on={filter === 'idle'}
              count={filterCounts.idle}
              onClick={() => setFilter('idle')}
            >
              Idle
            </FilterChip>
          </div>

          <div className="flex-1 overflow-y-auto max-md:flex-none max-md:overflow-visible">
            {project.resources.length === 0 && !adding && (
              <div className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                No resources yet.
                <br />
                Click + Add to create one.
              </div>
            )}

            {visibleResources.map((res) => {
              const summary = resourceSummary.get(res.id);
              const cal = project.calendars.find((c) => c.id === res.calendarId);
              const uiDays = cal ? schemaToUiWorkingDays(cal.workingDays) : DEFAULT_WORKING_DAYS;
              const hoursPerDay = cal?.hoursPerDay ?? 8;
              const days = util[res.id] ?? [];
              const overCapDays = summary?.overDays ?? 0;
              const idle = summary?.idle ?? false;

              if (editingId === res.id) {
                // Phase 36 Slice 3 — compute the shared-calendar warning for
                // this resource's bound calendar. A calendar is "shared" if
                // it's the project's default OR another resource points at
                // it OR any node has it as an override. Editing the working
                // pattern below would ripple to all those consumers, so we
                // surface the implication inline.
                const otherResourceCount = project.resources.filter(
                  (r) => r.calendarId === res.calendarId && r.id !== res.id,
                ).length;
                const nodeRefCount = project.nodes.filter(
                  (n) => n.calendarId === res.calendarId,
                ).length;
                const isProjectDefault = project.project.defaultCalendarId === res.calendarId;
                const consumers: string[] = [];
                if (isProjectDefault) consumers.push('the project default');
                if (otherResourceCount > 0) {
                  consumers.push(
                    `${otherResourceCount} other resource${otherResourceCount === 1 ? '' : 's'}`,
                  );
                }
                if (nodeRefCount > 0) {
                  consumers.push(`${nodeRefCount} node override${nodeRefCount === 1 ? '' : 's'}`);
                }
                const sharedNote =
                  consumers.length === 0
                    ? null
                    : `This calendar is also used by ${consumers.join(' and ')}. Editing the days/hours above will update all consumers.`;
                return (
                  <ResourceForm
                    key={res.id}
                    initialName={res.name}
                    initialCapacity={res.capacity}
                    initialWorkingDays={uiDays}
                    initialHoursPerDay={hoursPerDay}
                    {...(res.costRate !== undefined ? { initialCostRate: res.costRate } : {})}
                    {...(res.costPerUse !== undefined ? { initialCostPerUse: res.costPerUse } : {})}
                    {...(res.hourlyRateDistribution !== undefined
                      ? { initialHourlyRateDistribution: res.hourlyRateDistribution }
                      : {})}
                    {...(res.currencyOverride !== undefined
                      ? { initialCurrencyOverride: res.currencyOverride }
                      : {})}
                    currencyCode={project.currency}
                    submitLabel="Save"
                    onSubmit={(
                      name,
                      capacity,
                      workingDays,
                      hpd,
                      costRate,
                      costPerUse,
                      dist,
                      override,
                    ) =>
                      handleUpdate(
                        res.id,
                        name,
                        capacity,
                        workingDays,
                        hpd,
                        costRate,
                        costPerUse,
                        dist,
                        override,
                      )
                    }
                    onCancel={() => setEditingId(null)}
                    calendarPicker={{
                      currentCalendarId: res.calendarId,
                      availableCalendars: project.calendars.map((c) => ({
                        id: c.id,
                        name: c.name,
                      })),
                      sharedNote,
                      onChange: (id) => updateResourceCalendarId(res.id, id),
                    }}
                  />
                );
              }

              return (
                <div
                  key={res.id}
                  className={[
                    'px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 flex flex-col gap-1.5 group',
                    overCapDays > 0 ? 'bg-rose-50/40 dark:bg-rose-950/20' : '',
                  ].join(' ')}
                >
                  {/* Top row: name · capacity · pill */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="w-[7px] h-[7px] rounded-full shrink-0"
                        style={{ background: overCapDays > 0 ? '#ef4444' : '#3b82f6' }}
                      />
                      <span className="text-[13px] font-medium text-gray-900 dark:text-gray-100 truncate">
                        {res.name}
                      </span>
                      <span className="text-[10.5px] max-md:text-xs text-gray-400 dark:text-gray-500 shrink-0">
                        ×{res.capacity}
                      </span>
                    </div>
                    <div className="inline-flex items-center gap-1 shrink-0">
                      {overCapDays > 0 && (
                        <span className="text-[10px] max-md:text-xs font-medium px-1.5 py-px rounded-full bg-rose-100 dark:bg-rose-900/60 text-rose-700 dark:text-rose-300">
                          {overCapDays} over-cap
                        </span>
                      )}
                      {overCapDays === 0 && idle && (
                        <span className="text-[10px] max-md:text-xs font-medium px-1.5 py-px rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
                          idle
                        </span>
                      )}
                      <button
                        onClick={() => {
                          setAdding(false);
                          setEditingId(res.id);
                        }}
                        className="text-[11px] max-md:text-xs text-gray-400 hover:text-emerald-700 px-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Edit resource"
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => deleteResource(res.id)}
                        className="text-[11px] max-md:text-xs text-gray-400 hover:text-red-500 px-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Delete resource"
                      >
                        ×
                      </button>
                    </div>
                  </div>

                  {/* Sparkline + hours */}
                  <div className="flex items-center gap-2">
                    <Sparkline vals={days} capacity={res.capacity} />
                    <span className="ml-auto text-[11px] max-md:text-xs font-mono text-gray-500 dark:text-gray-400 shrink-0">
                      {Math.round(summary?.totalHours ?? 0)}h
                    </span>
                  </div>

                  {/* Working-day badges */}
                  <div className="flex items-center gap-0.5">
                    {DAY_LABELS.map((label, i) => (
                      <span
                        key={i}
                        className={[
                          'inline-flex items-center justify-center w-[16px] h-[16px] text-[9px] max-md:text-xs font-semibold rounded',
                          uiDays[i]
                            ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400'
                            : 'bg-gray-100 dark:bg-gray-800 text-gray-300 dark:text-gray-600',
                        ].join(' ')}
                      >
                        {label}
                      </span>
                    ))}
                    <span className="text-[10px] max-md:text-xs text-gray-400 dark:text-gray-500 ml-1.5">
                      {hoursPerDay}h/d
                    </span>
                  </div>

                  {/* Phase 19 — Cost badges. Hidden when both rates are
                      zero. Phase 33 Slice 2 — when the resource has a
                      `currencyOverride`, display in that currency's glyph
                      (the stored number IS in the override currency; no
                      FX conversion at display time). */}
                  {(res.costRate ?? 0) > 0 || (res.costPerUse ?? 0) > 0 ? (
                    <div className="flex items-center gap-2 text-[10.5px] max-md:text-xs text-gray-500 dark:text-gray-400">
                      {(res.costRate ?? 0) > 0 && (
                        <span>
                          <span className="text-gray-400 dark:text-gray-500">rate</span>{' '}
                          <span className="font-mono text-gray-700 dark:text-gray-300">
                            {currencyGlyph(res.currencyOverride ?? project.currency)}
                            {res.costRate}/hr
                          </span>
                        </span>
                      )}
                      {(res.costPerUse ?? 0) > 0 && (
                        <span>
                          <span className="text-gray-400 dark:text-gray-500">per use</span>{' '}
                          <span className="font-mono text-gray-700 dark:text-gray-300">
                            {currencyGlyph(res.currencyOverride ?? project.currency)}
                            {res.costPerUse}
                          </span>
                        </span>
                      )}
                      {res.currencyOverride && res.currencyOverride !== project.currency && (
                        <span className="text-[9.5px] uppercase tracking-wider text-amber-700 dark:text-amber-400 font-semibold">
                          {res.currencyOverride}
                        </span>
                      )}
                    </div>
                  ) : null}

                  {/* Phase 19 — Cost contribution. Shown whenever the project
                      has cost data anywhere; for a resource without rates,
                      its contribution is 0 and the share is 0% — useful
                      signal alongside its zero-rate badges.
                      Phase 33 Slice 2 — when the resource has a
                      `currencyOverride`, the engine's contribution (in
                      project currency) is converted BACK to the override
                      currency for display, so the contribution and rate
                      badges read in the same currency. The share % stays
                      computed in project currency (an apples-to-apples
                      ratio against `kpi.totalLaborCost`). Falls back to
                      project-currency display when FX conversion fails. */}
                  {kpi.totalLaborCost !== null && result
                    ? (() => {
                        const contribution = result.resourceCosts[res.id] ?? 0;
                        const share =
                          kpi.totalLaborCost > 0
                            ? Math.round((contribution / kpi.totalLaborCost) * 100)
                            : 0;
                        const override = res.currencyOverride;
                        let displayAmount = contribution;
                        let displayCurrency = project.currency;
                        if (override && override !== project.currency) {
                          const converted = convertAmount(
                            contribution,
                            project.currency,
                            override,
                            fxSnapshot,
                          );
                          if (converted !== null) {
                            displayAmount = converted;
                            displayCurrency = override;
                          }
                        }
                        return (
                          <div className="flex items-center justify-between text-[10.5px] max-md:text-xs text-gray-500 dark:text-gray-400">
                            <span className="text-gray-400 dark:text-gray-500">
                              Cost contribution
                            </span>
                            <span className="font-mono">
                              <span className="text-gray-700 dark:text-gray-300">
                                {formatMoney(displayAmount, displayCurrency)}
                              </span>
                              <span className="text-gray-400 dark:text-gray-500 ml-1.5">
                                {share}%
                              </span>
                            </span>
                          </div>
                        );
                      })()
                    : null}
                </div>
              );
            })}

            {adding && (
              <ResourceForm
                currencyCode={project.currency}
                submitLabel="Create"
                onSubmit={handleAdd}
                onCancel={() => setAdding(false)}
              />
            )}
          </div>
        </div>

        {/* ── Right detail pane ───────────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-auto bg-white dark:bg-gray-900 p-4 gap-3 max-md:flex-none max-md:overflow-visible">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">
                Allocation timeline
              </div>
              <div className="text-[11px] max-md:text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {detailTab === 'stacked'
                  ? 'Stacked by resource — over-capacity days highlighted'
                  : detailTab === 'per'
                    ? 'Per resource histogram'
                    : 'Days where demand exceeds capacity, with concrete actions'}
              </div>
            </div>

            {/* Tab toggle */}
            <div className="inline-flex bg-gray-100 dark:bg-gray-800 rounded-md p-0.5 shrink-0">
              <DetailTabBtn on={detailTab === 'stacked'} onClick={() => setDetailTab('stacked')}>
                Stacked
              </DetailTabBtn>
              <DetailTabBtn on={detailTab === 'per'} onClick={() => setDetailTab('per')}>
                Per resource
              </DetailTabBtn>
              <DetailTabBtn
                on={detailTab === 'conflicts'}
                onClick={() => setDetailTab('conflicts')}
                accent={conflicts.length > 0}
              >
                Conflicts
                {conflicts.length > 0 && (
                  <span className="ml-1 text-[10px] max-md:text-xs font-semibold text-rose-600 dark:text-rose-400">
                    {conflicts.length}
                  </span>
                )}
              </DetailTabBtn>
            </div>
          </div>

          {/* Tab content */}
          {!result && (
            <div className="flex-1 flex items-center justify-center text-sm text-amber-600">
              Fix schedule errors to view utilization.
            </div>
          )}
          {result && project.resources.length === 0 && (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-400 dark:text-gray-500 text-center px-8">
              Add resources and assign them to activities to see utilization here.
            </div>
          )}
          {result && project.resources.length > 0 && (
            <>
              {detailTab === 'stacked' && (
                <div className="bg-emerald-50/30 dark:bg-gray-950/40 border border-gray-200 dark:border-gray-800 rounded-lg p-3 flex flex-col gap-2">
                  <ResourcesChartToolbar
                    project={project}
                    hiddenResourceIds={hiddenResourceIds}
                    onToggleResource={toggleResourceHidden}
                    onClearHidden={clearHiddenResources}
                    zoom={resourcesZoom}
                    onZoomIn={zoomResourcesIn}
                    onZoomOut={zoomResourcesOut}
                    onZoomReset={resetResourcesZoom}
                  />
                  {/* overflow-x-scroll (not auto) so the bar reserves space
                      and stays visible on macOS — `auto` lets the OS hide
                      it idle even when scrolling is possible. The inner div
                      adds pb-3 below the chart so the SVG ends above the
                      scrollbar instead of having the date-axis labels sit
                      under the bar. */}
                  <div className="overflow-x-scroll cala-scroll-x">
                    <div
                      className="pb-3"
                      style={{ width: `${resourcesZoom * 100}%`, minWidth: '100%' }}
                    >
                      <StackedAllocationChart
                        project={project}
                        totalDays={totalDays}
                        projectStart={projectStart}
                        util={util}
                        teamCapacity={teamCapacity}
                        hiddenResourceIds={hiddenResourceIds}
                      />
                    </div>
                  </div>
                </div>
              )}
              {detailTab === 'per' && (
                <div className="flex flex-col gap-2">
                  <ResourcesChartToolbar
                    project={project}
                    hiddenResourceIds={hiddenResourceIds}
                    onToggleResource={toggleResourceHidden}
                    onClearHidden={clearHiddenResources}
                    zoom={resourcesZoom}
                    onZoomIn={zoomResourcesIn}
                    onZoomOut={zoomResourcesOut}
                    onZoomReset={resetResourcesZoom}
                    showFilter={false}
                  />
                  {/* overflow-x-scroll (not auto) so the bar reserves space
                      and stays visible on macOS — `auto` lets the OS hide
                      it idle even when scrolling is possible. The inner div
                      adds pb-3 below the chart so the SVG ends above the
                      scrollbar instead of having the date-axis labels sit
                      under the bar. */}
                  <div className="overflow-x-scroll cala-scroll-x">
                    <div
                      className="pb-3"
                      style={{ width: `${resourcesZoom * 100}%`, minWidth: '100%' }}
                    >
                      <PerResourceChart
                        project={project}
                        result={result}
                        projectStart={projectStart}
                        totalDays={totalDays}
                        util={util}
                      />
                    </div>
                  </div>
                </div>
              )}
              {detailTab === 'conflicts' && (
                <div className="flex flex-col gap-3">
                  {conflicts.length === 0 ? (
                    <div className="border border-emerald-200 dark:border-emerald-900 bg-emerald-50/70 dark:bg-emerald-950/30 rounded-lg p-4 text-[13px] text-emerald-800 dark:text-emerald-300">
                      No conflicts — every resource is within capacity.
                    </div>
                  ) : (
                    conflicts.map((c) => (
                      <ConflictCard
                        key={c.resourceName}
                        conflict={c}
                        project={project}
                        onSuggestLeveling={handleSuggestLeveling}
                        onSetCapacity={setResourceCapacity}
                        onSplitAssignment={handleSplitAssignment}
                        busy={levelingBusy}
                      />
                    ))
                  )}
                </div>
              )}
            </>
          )}

          {/* Phase 25 Slice 2 — cost-of-delay table. Always rendered when
              there's relevant data; quiet (hidden) otherwise so the panel
              doesn't grow for projects without crash options. */}
          {costOfDelay !== null &&
            (costOfDelay.rows.length > 0 || costOfDelay.nonCriticalWithOptionsCount > 0) && (
              <CostOfDelayTable data={costOfDelay} project={project} />
            )}
        </div>
      </div>

      {/* Phase 17 — auto-level preview modal */}
      {(levelingPlan !== null || levelingError !== null) && (
        <LevelingPreviewModal
          plan={levelingPlan}
          error={levelingError}
          onCancel={() => {
            setLevelingPlan(null);
            setLevelingError(null);
          }}
          onApply={handleApplyLeveling}
        />
      )}

      {/* Phase 17 slice 2 — Reassign and Increase-capacity render inline
          inside each ConflictCard, so there's nothing to mount at the
          panel level. */}
    </div>
  );
}

// ── Cost of delay table (Phase 25 Slice 2) ───────────────────────────────────

/**
 * Pure presentational table for the cost-of-delay rows. The math is done
 * upstream by `computeCostOfDelay`. Rows are pre-sorted ascending by $/day.
 * Renders nothing meaningful when given an empty result; the caller guards
 * the empty case so this component never appears as an empty box.
 */
function CostOfDelayTable({ data, project }: { data: CostOfDelayResult; project: ProjectFile }) {
  const { rows, nonCriticalWithOptionsCount } = data;
  const nodeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of project.nodes) m.set(n.id, n.name);
    return m;
  }, [project.nodes]);

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-3 flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-gray-700 dark:text-gray-200">
          Cost of delay
        </h3>
        <span className="text-[10.5px] max-md:text-xs text-gray-400 dark:text-gray-500">
          Critical-path activities with compression options · cheapest $/day-saved first
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-[12px] text-gray-400 dark:text-gray-500">
          No critical-path activity has compression options yet.
        </p>
      ) : (
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-[10.5px] max-md:text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-800">
              <th className="py-1 pr-2 font-medium">Activity</th>
              <th className="py-1 pr-2 font-medium text-right">Nominal → Compressed</th>
              <th className="py-1 pr-2 font-medium text-right">Added cost</th>
              <th className="py-1 pl-2 font-medium text-right">$/day saved</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const name = nodeNameById.get(r.nodeId) ?? r.nodeId;
              return (
                <tr
                  key={r.nodeId}
                  className="border-b border-gray-100 dark:border-gray-800 last:border-b-0"
                  title={`Option ${r.bestOptionIndex + 1} on this activity is the cheapest per day saved`}
                >
                  <td className="py-1 pr-2 text-gray-700 dark:text-gray-200 truncate">{name}</td>
                  <td className="py-1 pr-2 text-right text-gray-500 dark:text-gray-400 tabular-nums">
                    {formatHours(r.nominalHours)} → {formatHours(r.crashedHours)}
                  </td>
                  <td className="py-1 pr-2 text-right text-gray-700 dark:text-gray-200 tabular-nums">
                    +{formatMoney(r.addedCost, project.currency)}
                  </td>
                  <td className="py-1 pl-2 text-right font-medium text-emerald-700 dark:text-emerald-400 tabular-nums">
                    {formatMoney(r.bestPerDay, project.currency)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {nonCriticalWithOptionsCount > 0 && (
        <p className="text-[10.5px] max-md:text-xs text-gray-400 dark:text-gray-500 mt-1">
          {nonCriticalWithOptionsCount} more node
          {nonCriticalWithOptionsCount === 1 ? ' has' : 's have'} compression options on
          non-critical paths (no projectEnd impact — not shown).
        </p>
      )}
    </div>
  );
}

/** Format a working-hour number compactly. 8h → "8h"; 1.5 → "1.5h". */
function formatHours(h: number): string {
  const rounded = Math.round(h * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}h`;
}

// ── Auto-level preview modal ─────────────────────────────────────────────────

function LevelingPreviewModal({
  plan,
  error,
  onCancel,
  onApply,
}: {
  plan: LevelingPlan | null;
  error: string | null;
  onCancel: () => void;
  onApply: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="relative w-[min(600px,90vw)] max-h-[80vh] flex flex-col bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <div>
            <div className="text-[14px] font-semibold text-gray-900 dark:text-gray-100">
              Auto-level plan
            </div>
            <div className="text-[11.5px] max-md:text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {error
                ? 'Nothing to apply'
                : plan
                  ? plan.resolvedConflicts === 0 && plan.changes.length === 0
                    ? 'No changes proposed'
                    : `${plan.changes.length} shift${plan.changes.length === 1 ? '' : 's'} · resolves ${plan.resolvedConflicts} of ${plan.resolvedConflicts + plan.remainingConflicts} over-cap day${plan.resolvedConflicts + plan.remainingConflicts === 1 ? '' : 's'}`
                  : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-700 w-[22px] h-[22px] inline-flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label="Cancel"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-3">
          {error ? (
            <div className="text-[13px] text-gray-700 dark:text-gray-300">{error}</div>
          ) : plan === null ? null : plan.changes.length === 0 ? (
            <div className="text-[13px] text-gray-700 dark:text-gray-300">
              The leveler couldn&apos;t shift any activities — likely because the competing
              activities have no incoming edges to extend. Try adding a Start anchor or sequencing
              them explicitly.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {plan.changes.map((c) => {
                const baseline = c.baselineStart.toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                });
                const next = c.newStart.toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                });
                return (
                  <div
                    key={c.nodeId}
                    className="flex items-center gap-3 px-3 py-2 rounded-md border border-gray-100 dark:border-gray-800 text-[12.5px]"
                  >
                    <span className="font-medium text-gray-900 dark:text-gray-100 flex-1 truncate">
                      {c.nodeName}
                    </span>
                    <span className="text-gray-500 dark:text-gray-400 font-mono text-[11px] max-md:text-xs">
                      {baseline} → {next}
                    </span>
                    <span className="text-[10.5px] max-md:text-xs text-gray-500 dark:text-gray-400 inline-flex items-center gap-1 ml-2">
                      <span>+{Math.round(c.addedLagHours)}h lag on</span>
                      <span className="font-medium text-gray-700 dark:text-gray-300">
                        {c.predecessorName} → {c.nodeName}
                      </span>
                    </span>
                  </div>
                );
              })}
              {plan.skipped.length > 0 && (
                <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-800">
                  <div className="text-[11px] max-md:text-xs font-semibold uppercase tracking-[0.05em] text-amber-700 dark:text-amber-400 mb-1.5">
                    Skipped
                  </div>
                  <div className="flex flex-col gap-1">
                    {plan.skipped.map((s) => (
                      <div
                        key={s.nodeId}
                        className="text-[11.5px] max-md:text-xs text-gray-600 dark:text-gray-400"
                      >
                        <span className="font-medium text-gray-800 dark:text-gray-200">
                          {s.nodeName}
                        </span>
                        <span className="text-gray-500 dark:text-gray-500"> — {s.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {plan.remainingConflicts > 0 && (
                <div className="mt-2 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-[11.5px] max-md:text-xs text-amber-800 dark:text-amber-300">
                  {plan.remainingConflicts} over-cap day{plan.remainingConflicts === 1 ? '' : 's'}{' '}
                  couldn&apos;t be resolved automatically
                  {plan.hitIterationCap ? ' (iteration cap reached)' : ''}.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-100 dark:border-gray-800">
          <button
            type="button"
            onClick={onCancel}
            className="text-[12.5px] font-medium px-3 py-1.5 rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
          {plan !== null && plan.changes.length > 0 && (
            <button
              type="button"
              onClick={onApply}
              className="text-[12.5px] font-medium px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white transition-colors"
            >
              Apply leveling
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Increase capacity panel (Phase 17 slice 2 — inline in ConflictCard) ──────

function IncreaseCapacityPanel({
  conflict,
  onClose,
  onApply,
}: {
  conflict: Conflict;
  onClose: () => void;
  onApply: (newCapacity: number) => void;
}) {
  // Default proposal: bump to peak demand so every over-cap day is resolved
  // in one step. The user can pick a smaller bump if they don't want to
  // commit to the full peak.
  const peak = conflict.peakCount;
  const current = conflict.capacity;
  const [newCapacity, setNewCapacity] = useState(peak);
  const fullyResolves = newCapacity >= peak;

  return (
    <div className="mt-1 rounded-md border border-rose-200 dark:border-rose-900 bg-white/60 dark:bg-rose-950/30 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 text-[12px]">
        <span className="text-[11px] max-md:text-xs font-semibold uppercase tracking-[0.05em] text-rose-800 dark:text-rose-300">
          Increase {conflict.resourceName} capacity
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="text-rose-700 dark:text-rose-300 hover:text-rose-900 w-[18px] h-[18px] inline-flex items-center justify-center rounded hover:bg-rose-100 dark:hover:bg-rose-900/40 transition-colors"
        >
          ×
        </button>
      </div>
      <div className="flex items-center gap-3 text-[12px] flex-wrap">
        <span className="inline-flex items-center gap-1.5">
          <span className="text-gray-500 dark:text-gray-400">Current</span>
          <span className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">
            {current}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-gray-500 dark:text-gray-400">Peak</span>
          <span className="font-semibold tabular-nums text-rose-700 dark:text-rose-400">
            {peak}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-gray-500 dark:text-gray-400">New</span>
          <input
            type="number"
            min={current + 1}
            max={peak * 2}
            value={newCapacity}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (Number.isFinite(v) && v > 0) setNewCapacity(v);
            }}
            className="w-16 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 px-1.5 py-0.5 text-[12px] focus:outline-none focus:ring-2 focus:ring-emerald-400"
          />
        </span>
        <span
          className={[
            'text-[11px] max-md:text-xs flex-1 min-w-0',
            fullyResolves
              ? 'text-emerald-700 dark:text-emerald-400'
              : 'text-amber-700 dark:text-amber-400',
          ].join(' ')}
        >
          {fullyResolves
            ? `Resolves all ${conflict.overDays.length} over-cap day${conflict.overDays.length === 1 ? '' : 's'}.`
            : `Partial — some over-cap days will remain.`}
        </span>
        <button
          type="button"
          onClick={() => onApply(newCapacity)}
          disabled={newCapacity <= current}
          className="text-[11.5px] max-md:text-xs font-medium px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

// ── Reassign panel (Phase 17 slice 2 / Phase 18 slice 3 — inline split) ─────

/**
 * Phase 18 slice 3 — Reassign is now a split, not a swap.
 *
 * Each visible row carries:
 *   - the activity name + slack hours
 *   - a Move count input (default chosen by the walk-until-covered algorithm
 *     in `pickCandidates` below, bounded to [1, activityContribution])
 *   - a target dropdown (sorted by free headroom on the conflict's over-cap
 *     days; landed in Phase 17 slice 2)
 *   - an Apply button that fires `splitResourceAssignment(from, to, count)`
 *
 * `splitResourceAssignment` collapses to the legacy swap when
 * `count === activity.count`, so we no longer need a separate "Move all"
 * verb — the count input handles both cases.
 */

interface ReassignCandidate {
  nodeId: string;
  defaultCount: number;
}

/**
 * Walk-until-covered: starting from the highest-slack activity, accumulate
 * each one's `min(contribution, remaining-overflow)` until the conflict's
 * overflow is fully covered. Returns the minimal candidate set whose
 * default counts exactly resolve the conflict — so "Apply suggested" never
 * over-applies.
 */
function pickCandidates(conflict: Conflict): ReassignCandidate[] {
  const out: ReassignCandidate[] = [];
  let remaining = conflict.overflow;
  for (let i = 0; i < conflict.activityIds.length; i++) {
    if (remaining <= 0) break;
    const nodeId = conflict.activityIds[i]!;
    const contribution = conflict.activityContributions[i] ?? 0;
    if (contribution <= 0) continue;
    const moveCount = Math.min(contribution, remaining);
    out.push({ nodeId, defaultCount: moveCount });
    remaining -= moveCount;
  }
  return out;
}

function ReassignPanel({
  conflict,
  project,
  onClose,
  onApplySplit,
}: {
  conflict: Conflict;
  project: ProjectFile;
  onClose: () => void;
  onApplySplit: (
    nodeId: string,
    fromResourceId: string,
    toResourceId: string,
    count: number,
  ) => void;
}) {
  // Available targets: any other resource. We don't filter by "has capacity
  // on the conflicting days" because the user might want to consciously
  // accept a smaller overlap on a different resource. The conflict card
  // will simply re-appear with the new resource if it's also overloaded.
  // Phase 17 slice 2 — sort targets by available headroom on this conflict's
  // over-cap days (most free first). The default pick becomes the resource
  // most able to absorb the move.
  const otherResources = project.resources
    .filter((r) => r.id !== conflict.resourceId)
    .map((r) => ({
      ...r,
      free: conflict.targetHeadroom[r.id] ?? 0,
    }))
    .sort((a, b) => {
      if (a.free !== b.free) return b.free - a.free;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

  const defaultTarget = otherResources[0]?.id ?? '';

  const candidates = pickCandidates(conflict);
  const candidateIds = candidates.map((c) => c.nodeId);
  const stayingIds = conflict.activityIds.filter((id) => !candidateIds.includes(id));

  // Per-row state. Counts default to the walk-until-covered amount for
  // candidate rows, and to the activity's full contribution for the
  // expanded "staying" rows (so manually opting to move one of them
  // is a full-swap by default).
  const initialCounts: Record<string, number> = {};
  for (const c of candidates) initialCounts[c.nodeId] = c.defaultCount;
  for (let i = 0; i < conflict.activityIds.length; i++) {
    const id = conflict.activityIds[i]!;
    if (!(id in initialCounts)) {
      initialCounts[id] = conflict.activityContributions[i] ?? 1;
    }
  }
  const [counts, setCounts] = useState<Record<string, number>>(initialCounts);
  const [picks, setPicks] = useState<Record<string, string>>(
    Object.fromEntries(conflict.activityIds.map((id) => [id, defaultTarget])),
  );
  const [applied, setApplied] = useState<ReadonlySet<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);

  const visibleIds = showAll ? conflict.activityIds : candidateIds;

  function applyRow(nodeId: string): void {
    const pick = picks[nodeId] ?? defaultTarget;
    if (!pick) return;
    const count = Math.max(1, counts[nodeId] ?? 1);
    onApplySplit(nodeId, conflict.resourceId, pick, count);
    setApplied((prev) => {
      const next = new Set(prev);
      next.add(nodeId);
      return next;
    });
  }

  const remainingVisible = visibleIds.filter((id) => !applied.has(id));
  // "All done" applies to the suggested-move set — once those are applied
  // the conflict should be resolved (or close to it). We don't gate on
  // staying activities since the user opted not to move them.
  const candidatesRemaining = candidateIds.filter((id) => !applied.has(id));
  const allCandidatesApplied = candidateIds.length > 0 && candidatesRemaining.length === 0;

  // Helper for the per-row contribution lookup (used in count clamping).
  function contributionOf(nodeId: string): number {
    const i = conflict.activityIds.indexOf(nodeId);
    return i < 0 ? 1 : (conflict.activityContributions[i] ?? 1);
  }

  return (
    <div className="mt-1 rounded-md border border-rose-200 dark:border-rose-900 bg-white/60 dark:bg-rose-950/30 p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[11px] max-md:text-xs font-semibold uppercase tracking-[0.05em] text-rose-800 dark:text-rose-300">
            Reassign from {conflict.resourceName}
          </span>
          <span className="text-[10.5px] max-md:text-xs text-gray-500 dark:text-gray-400">
            {conflict.overflow > 0 && candidates.length > 0 ? (
              <>
                Over capacity by {conflict.overflow}. Splitting{' '}
                {candidates.reduce((s, c) => s + c.defaultCount, 0)} unit
                {candidates.reduce((s, c) => s + c.defaultCount, 0) === 1 ? '' : 's'} off{' '}
                {candidates.length} highest-slack activit
                {candidates.length === 1 ? 'y' : 'ies'} brings {conflict.resourceName} back under
                capacity.
              </>
            ) : (
              <>Pick an activity, choose a count to split off, and a target resource.</>
            )}
          </span>
          {applied.size > 0 && (
            <span className="text-[10.5px] max-md:text-xs text-emerald-700 dark:text-emerald-400 mt-0.5">
              {applied.size} of {candidateIds.length || conflict.activityIds.length} applied
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="text-rose-700 dark:text-rose-300 hover:text-rose-900 w-[18px] h-[18px] inline-flex items-center justify-center rounded hover:bg-rose-100 dark:hover:bg-rose-900/40 transition-colors shrink-0"
        >
          ×
        </button>
      </div>

      {otherResources.length === 0 ? (
        <div className="text-[12px] text-gray-700 dark:text-gray-300">
          There&apos;s only one resource in this project — add another resource before reassigning.
        </div>
      ) : allCandidatesApplied && !showAll ? (
        <div className="px-2 py-1.5 rounded bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-[11.5px] max-md:text-xs text-emerald-800 dark:text-emerald-300">
          Split applied across {candidateIds.length} activit
          {candidateIds.length === 1 ? 'y' : 'ies'} — the schedule updates above.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {remainingVisible.map((nodeId) => {
            const node = project.nodes.find((n) => n.id === nodeId);
            if (!node) return null;
            const pick = picks[nodeId] ?? defaultTarget;
            const slackIdx = conflict.activityIds.indexOf(nodeId);
            const slackH = conflict.activitySlackHours[slackIdx] ?? 0;
            const contribution = contributionOf(nodeId);
            const isCandidate = candidateIds.includes(nodeId);
            const count = counts[nodeId] ?? 1;
            const target = otherResources.find((r) => r.id === pick);
            const targetFree = target?.free ?? 0;
            const wontFit = count > targetFree;
            return (
              <div
                key={nodeId}
                className={[
                  'flex items-center flex-wrap gap-1.5 px-2 py-1 rounded border text-[12px]',
                  isCandidate
                    ? 'border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/30'
                    : 'border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900',
                ].join(' ')}
              >
                <span className="flex-1 min-w-0 truncate font-medium text-gray-900 dark:text-gray-100">
                  {node.name}
                </span>
                <span
                  className="text-[10px] max-md:text-xs text-gray-500 dark:text-gray-400 tabular-nums"
                  title={
                    isCandidate
                      ? 'High slack — safer to move to a fallback resource'
                      : 'Low slack — closer to the critical path, kept on primary'
                  }
                >
                  slack {Math.round(slackH)}h
                </span>
                <label
                  className="inline-flex items-center gap-1 text-[10.5px] max-md:text-xs text-gray-600 dark:text-gray-400"
                  title={`This activity demands ${contribution} unit${contribution === 1 ? '' : 's'} from ${conflict.resourceName}. Reducing the count splits the demand; choosing ${contribution} moves the activity entirely.`}
                >
                  Move
                  <input
                    type="number"
                    min={1}
                    max={contribution}
                    value={count}
                    onChange={(e) => {
                      const raw = parseInt(e.target.value, 10);
                      const next = Number.isFinite(raw)
                        ? Math.max(1, Math.min(contribution, raw))
                        : 1;
                      setCounts((prev) => ({ ...prev, [nodeId]: next }));
                    }}
                    className="w-12 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-1.5 py-0.5 text-[11.5px] max-md:text-xs text-gray-900 dark:text-gray-100 tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-400"
                  />
                  <span className="text-gray-400 dark:text-gray-500">/ {contribution}</span>
                </label>
                <span className="text-[10.5px] max-md:text-xs text-gray-500 dark:text-gray-400">
                  →
                </span>
                <select
                  value={pick}
                  onChange={(e) => setPicks((prev) => ({ ...prev, [nodeId]: e.target.value }))}
                  title={
                    wontFit
                      ? `Target has only ${targetFree} free — split would still leave the conflict ${count - targetFree} over capacity.`
                      : undefined
                  }
                  className={[
                    'border rounded-md px-1.5 py-0.5 text-[11.5px] max-md:text-xs focus:outline-none focus:ring-2 focus:ring-emerald-400',
                    wontFit
                      ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-200'
                      : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100',
                  ].join(' ')}
                >
                  {otherResources.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} — cap {r.capacity}, free {r.free}
                      {r.free === 0 ? ' ⚠' : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => applyRow(nodeId)}
                  className="text-[11px] max-md:text-xs font-medium px-2 py-0.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white transition-colors"
                >
                  Apply
                </button>
              </div>
            );
          })}

          <div className="flex items-center justify-between gap-2 mt-1">
            {stayingIds.length > 0 ? (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="text-[10.5px] max-md:text-xs text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 underline-offset-2 hover:underline"
              >
                {showAll
                  ? `Show only suggested (${candidateIds.length})`
                  : `Show ${stayingIds.length} more activit${
                      stayingIds.length === 1 ? 'y' : 'ies'
                    } staying on ${conflict.resourceName}`}
              </button>
            ) : (
              <span />
            )}
            {candidatesRemaining.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  for (const id of candidatesRemaining) applyRow(id);
                }}
                className="text-[11.5px] max-md:text-xs font-medium px-3 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white transition-colors"
              >
                Apply suggested ({candidatesRemaining.length})
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Local UI helpers ─────────────────────────────────────────────────────────

function FilterChip({
  children,
  on,
  count,
  onClick,
}: {
  children: React.ReactNode;
  on: boolean;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] max-md:text-xs border transition-colors',
        on
          ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
          : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800',
      ].join(' ')}
    >
      {children}
      <span className="text-[10px] max-md:text-xs opacity-70">{count}</span>
    </button>
  );
}

function DetailTabBtn({
  children,
  on,
  onClick,
  accent,
}: {
  children: React.ReactNode;
  on: boolean;
  onClick: () => void;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'px-2.5 py-1 rounded text-[11.5px] max-md:text-xs font-medium transition-colors',
        on
          ? `bg-white dark:bg-gray-900 ${accent ? 'text-rose-700 dark:text-rose-300' : 'text-gray-900 dark:text-gray-100'} shadow-[0_1px_2px_rgba(15,23,42,0.06)]`
          : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
      ].join(' ')}
    >
      {children}
    </button>
  );
}
