import { useEffect, useRef, useState, useMemo } from 'react';
import type {
  Calendar,
  Duration,
  DurationUnit,
  DurationSemantic,
  CalendarPolicy,
  Distribution,
  FixedCost,
  CrashOption,
} from '@procsim/file-format';
import { currencyGlyph, CALENDAR_TEMPLATES, SCHEMA_LIMITS } from '@procsim/file-format';
import { toHours } from '@procsim/scheduler';
import { currencyStep } from '../utils/cost.js';
import { beginEdit, commitEdit, useDomainStore } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import type { InspectorSectionId } from '../store/viewStore.js';
import { useResizable } from '../hooks/useResizable.js';
import { useSchedule } from '../hooks/useSchedule.js';
import { GroupAutocomplete } from './GroupAutocomplete.js';
import { NumericInput } from './NumericInput.js';
import { computeAllGroupNames, autoGroupColor } from '../utils/groupColors.js';

const DEFAULT_COLOR = '#6366f1';

const POLICY_LABELS: Record<CalendarPolicy, string> = {
  intersection: 'Intersection',
  resourceWins: 'Resource wins',
  activityWins: 'Activity wins',
};

// ── Distribution picker ───────────────────────────────────────────────────────

type DistType = Distribution['type'] | 'none';

// Inline SVG curve shapes for each distribution type (viewBox 0 0 48 28)
const DIST_CURVES: Record<DistType, React.ReactNode> = {
  none: (
    // Flat horizontal line — fixed / deterministic
    <line x1={6} y1={14} x2={42} y2={14} stroke="currentColor" strokeWidth={2} />
  ),
  triangular: (
    // Straight-sided triangle
    <polyline points="6,24 24,4 42,24" stroke="currentColor" strokeWidth={2} fill="none" />
  ),
  'pert-beta': (
    // Smooth asymmetric bell — peaks slightly left of centre, long right tail
    <path
      d="M6,24 C10,24 16,4 22,4 C28,4 36,18 42,24"
      stroke="currentColor"
      strokeWidth={2}
      fill="none"
    />
  ),
  normal: (
    // Symmetric Gaussian bell
    <path
      d="M6,24 C10,24 14,4 24,4 C34,4 38,24 42,24"
      stroke="currentColor"
      strokeWidth={2}
      fill="none"
    />
  ),
};

const DIST_LABELS: Record<DistType, string> = {
  none: 'Fixed',
  triangular: 'Triangular',
  'pert-beta': 'PERT-Beta',
  normal: 'Normal',
};

const DIST_ORDER: DistType[] = ['none', 'triangular', 'pert-beta', 'normal'];

interface DistributionPickerProps {
  dist: Distribution | undefined;
  /**
   * The "centre" value used to populate sensible defaults when the user
   * picks a distribution type. For `kind: 'duration'` this is the nominal
   * duration in hours; for `kind: 'probability'` it is the static pass
   * probability in [0, 1]; for `kind: 'cost'` it is the static fixedCost
   * amount in project currency. The picker doesn't otherwise interpret
   * the value.
   */
  nominal: number;
  /**
   * 'duration': sampler drives node duration (hours). Defaults span ±50% of
   *   nominal and inputs are unbounded above zero.
   * 'probability' (Phase 11 — decision nodes): sampler drives the pass
   *   probability per Monte Carlo iteration. Defaults are clipped to [0, 1]
   *   and inputs accept fractional probability values. The footer hint
   *   reflects the probability semantics.
   * 'cost' (Phase 19 — fixedCost variance): sampler drives the per-node
   *   fixedCost. Defaults span ±50% of nominal (same shape as duration);
   *   the footer hint reflects cost / currency semantics. Loop-body
   *   semantics are documented in the NodePanel's loop-context tooltip.
   */
  kind: 'duration' | 'probability' | 'cost';
  /**
   * Required when `kind === 'cost'`: drives the adaptive `step` on each
   * distribution-parameter input via `currencyStep`. Ignored for the
   * other kinds (durations are integers; probabilities are 0.05-step
   * fractions in [0, 1]).
   */
  currency?: string;
  /**
   * For `kind === 'duration'` only: the activity's `duration.unit`. By
   * convention the distribution's min / mode / max / mean / stddev are
   * authored in the SAME unit as the activity's duration (see the
   * "distribution sampling preserves activity duration unit" test in
   * `packages/simulation`). The picker uses this for the footer label
   * ("Values in days." vs. "Values in hours.") so the user knows what
   * unit they're typing in. Falls back to 'hours' if absent.
   */
  durationUnit?: DurationUnit;
  onChange: (dist: Distribution | undefined) => void;
}

function DistributionPicker({
  dist,
  nominal,
  kind,
  currency,
  durationUnit,
  onChange,
}: DistributionPickerProps) {
  const type: DistType = dist?.type ?? 'none';

  function handleTypeChange(t: DistType) {
    if (t === 'none') {
      onChange(undefined);
      return;
    }
    const n = nominal;
    if (kind === 'probability') {
      // Probability defaults: cluster around `n` (the static pass probability),
      // clipped to [0, 1]. Mode = n; min = max(0, n − 0.2); max = min(1, n + 0.1).
      // The asymmetry encodes the typical PM intuition that a gate is more
      // likely to fail (drop in p) than to over-perform.
      const min = Math.max(0, n - 0.2);
      const mode = Math.max(0, Math.min(1, n));
      const max = Math.min(1, n + 0.1);
      if (t === 'triangular') {
        onChange({ type: 'triangular', min, mode, max: Math.max(max, mode + 0.01) });
      } else if (t === 'pert-beta') {
        onChange({ type: 'pert-beta', min, mode, max: Math.max(max, mode + 0.01) });
      } else {
        onChange({ type: 'normal', mean: mode, stddev: 0.1 });
      }
      return;
    }
    // Cost and duration share the same default shape (±50% of nominal,
    // unbounded above zero). The footer copy differentiates the two.
    if (t === 'triangular') {
      onChange({ type: 'triangular', min: Math.max(0.5, n * 0.5), mode: n, max: n * 1.5 });
    } else if (t === 'pert-beta') {
      onChange({ type: 'pert-beta', min: Math.max(0.5, n * 0.5), mode: n, max: n * 1.5 });
    } else {
      onChange({ type: 'normal', mean: n, stddev: Math.max(0.1, n * 0.2) });
    }
  }

  // Probability inputs accept fractional values; durations are integer hours;
  // cost inputs use a currency-aware adaptive step (computed per-input below
  // so each field's spinner scales to its own value).
  const probabilityStep = 0.05;
  const durationStep = 1;
  const numericMax = kind === 'probability' ? 1 : undefined;
  function stepFor(fieldValue: number): number {
    if (kind === 'probability') return probabilityStep;
    if (kind === 'duration') return durationStep;
    // kind === 'cost' — currency is supplied by the caller in this case.
    return currencyStep(currency ?? 'USD', fieldValue, 'rate');
  }

  const inputCls =
    'rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-1.5 py-1 text-xs w-full focus:outline-none focus:ring-1 focus:ring-emerald-400';

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
        {kind === 'probability'
          ? 'Pass probability distribution'
          : kind === 'cost'
            ? 'Fixed cost distribution'
            : 'Distribution'}
      </label>
      {/* Visual card selector — one card per distribution type */}
      <div className="grid grid-cols-2 gap-1.5">
        {DIST_ORDER.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => handleTypeChange(t)}
            className={[
              'flex flex-col items-center gap-1 rounded-lg border px-2 py-1.5 transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400',
              type === t
                ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'
                : 'border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-400 dark:text-gray-500 hover:border-gray-300 dark:hover:border-gray-500',
            ].join(' ')}
          >
            <svg width={48} height={28} viewBox="0 0 48 28" aria-hidden>
              {DIST_CURVES[t]}
            </svg>
            <span className="text-[10px] font-medium">{DIST_LABELS[t]}</span>
          </button>
        ))}
      </div>

      {/* Slice 10 — only spread params are editable here for every
          kind. The centre value (mode / μ) is owned by the schema
          field above:
            kind='duration'    → activity.duration.value
            kind='cost'        → fixedCost.value
            kind='probability' → node.passProbability   (Slice 10)
          The parent keeps the distribution's mode / mean in sync
          when the source field changes. */}
      {dist?.type === 'triangular' || dist?.type === 'pert-beta' ? (
        <div className="grid grid-cols-2 gap-1">
          {(['min', 'max'] as const).map((field) => {
            const fieldValue = (dist as Record<string, unknown>)[field] as number;
            return (
              <label key={field} className="flex flex-col gap-0.5">
                <span className="text-xs text-gray-400 dark:text-gray-500 capitalize">{field}</span>
                <NumericInput
                  value={fieldValue}
                  min={0}
                  {...(numericMax !== undefined ? { max: numericMax } : {})}
                  step={stepFor(fieldValue)}
                  onCommit={(v) => {
                    onChange({ ...dist, [field]: v } as Distribution);
                  }}
                  className={inputCls}
                />
              </label>
            );
          })}
        </div>
      ) : dist?.type === 'normal' ? (
        <div className="grid grid-cols-1 gap-1">
          <label className="flex flex-col gap-0.5">
            <span className="text-xs text-gray-400 dark:text-gray-500">σ</span>
            <NumericInput
              value={dist.stddev}
              // Slice 9 — σ = 0 is a degenerate-but-valid normal
              // (every sample equals μ). Allow it.
              min={0}
              step={stepFor(dist.stddev)}
              onCommit={(v) => {
                onChange({ ...dist, stddev: v });
              }}
              className={inputCls}
            />
          </label>
        </div>
      ) : null}

      {dist && (
        <p className="text-xs text-gray-400 dark:text-gray-500">
          {kind === 'probability'
            ? 'Values in [0, 1]. Sampled per iteration and clamped before the Bernoulli draw.'
            : kind === 'cost'
              ? 'Per-iteration in a loop, sampled once per Monte Carlo run and multiplied by the sampled loop count. Drawn after duration and bernoulli on the same per-node sub-stream.'
              : `Values in ${durationUnit ?? 'hours'}. Used by Monte Carlo simulation.`}
        </p>
      )}
    </div>
  );
}

// ── Cost section (Phase 19) ───────────────────────────────────────────────────

/**
 * Convert a Duration to working hours using the project default calendar.
 * Mirrors the scheduler's `toHours` helper but stays in the app package so
 * the NodePanel doesn't have to depend on scheduler internals. The 8h-day
 * / 40h-week shape is the same fallback used by the duration distribution
 * picker — close enough for the Inspector's "what does this cost" preview.
 */
function durationToHours(d: Duration, hoursPerDay: number, daysPerWeek: number): number {
  switch (d.unit) {
    case 'hours':
      return d.value;
    case 'days':
      return d.value * hoursPerDay;
    case 'weeks':
      return d.value * hoursPerDay * daysPerWeek;
  }
}

function formatMoney(amount: number, glyph: string): string {
  // 2 decimal places for fractions; integer for whole values. Slice 4 will
  // honour target-currency minor-unit conventions (e.g. JPY has none).
  const rounded = Math.round(amount * 100) / 100;
  const fixed = Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(2);
  return `${glyph}${fixed}`;
}

interface CostSectionProps {
  node: import('@procsim/file-format').ProjectNode;
  project: import('@procsim/file-format').ProjectFile;
  isLoopBody: boolean;
  updateNodeFixedCost: (nodeId: string, fc: FixedCost | undefined) => void;
  updateNodeFixedCostOnce: (nodeId: string, v: boolean | undefined) => void;
}

function CostSection({
  node,
  project,
  isLoopBody,
  updateNodeFixedCost,
  updateNodeFixedCostOnce,
}: CostSectionProps) {
  const glyph = currencyGlyph(project.currency);
  // Default-calendar hours conversion. The "real" cost uses each assignment's
  // resolved working calendar (scheduler computes this); the inspector's
  // preview keeps things readable with the project default.
  const defaultCal = project.calendars.find((c) => c.id === project.project.defaultCalendarId);
  const hoursPerDay = defaultCal?.hoursPerDay ?? 8;
  const daysPerWeek = defaultCal?.daysPerWeek ?? 5;
  const nodeHours = durationToHours(node.duration, hoursPerDay, daysPerWeek);

  // Per-assignment cost preview (rate × hours × count + perUse × count).
  // Matches the deterministic cost-engine formula, minus the loop iteration
  // scaling (we surface the per-iteration unit cost; loop scaling shows up
  // in the engine result's nodeCosts).
  const assignmentCosts = node.resourceAssignments.map((a) => {
    const res = project.resources.find((r) => r.id === a.resourceId);
    const rate = res?.costRate ?? 0;
    const perUse = res?.costPerUse ?? 0;
    const rateCost = rate * nodeHours * a.count;
    const onceCost = perUse * a.count;
    return {
      resourceId: a.resourceId,
      resourceName: res?.name ?? a.resourceId,
      rate,
      perUse,
      count: a.count,
      total: rateCost + onceCost,
    };
  });
  const resourceTotal = assignmentCosts.reduce((s, a) => s + a.total, 0);

  // Project-wide empty state: hide the derived row entirely when no resource
  // has any cost data AND this node has no fixedCost. The fixedCost editor
  // remains visible so users can introduce cost data via the inspector.
  const anyResourceHasRates = project.resources.some(
    (r) => (r.costRate ?? 0) > 0 || (r.costPerUse ?? 0) > 0,
  );
  const anyNodeHasFixed = project.nodes.some((n) => n.fixedCost !== undefined);
  const projectHasCostData = anyResourceHasRates || anyNodeHasFixed;

  const fixedValue = node.fixedCost?.value ?? 0;

  function handleFixedValueChange(v: number) {
    if (!isFinite(v) || v < 0) return;
    if (v === 0 && node.fixedCost?.distribution === undefined) {
      updateNodeFixedCost(node.id, undefined);
      return;
    }
    // Slice 9 — when a distribution is set, the value IS the
    // distribution's mode (tri / PERT) or mean (normal). Keep them
    // in sync; clamp min / max so the distribution stays valid.
    // beginEdit / commitEdit on focus / blur (NumericInput below)
    // groups both updates into one undo step.
    const existingDist = node.fixedCost?.distribution;
    let nextDist = existingDist;
    if (existingDist) {
      if (existingDist.type === 'triangular' || existingDist.type === 'pert-beta') {
        nextDist = {
          ...existingDist,
          mode: v,
          min: Math.min(existingDist.min, v),
          max: Math.max(existingDist.max, v),
        };
      } else if (existingDist.type === 'normal') {
        nextDist = { ...existingDist, mean: v };
      }
    }
    const next: FixedCost =
      nextDist !== undefined ? { value: v, distribution: nextDist } : { value: v };
    updateNodeFixedCost(node.id, next);
  }

  function handleFixedDistChange(d: Distribution | undefined) {
    if (d === undefined) {
      if (fixedValue === 0) {
        updateNodeFixedCost(node.id, undefined);
        return;
      }
      updateNodeFixedCost(node.id, { value: fixedValue });
      return;
    }
    // Schema rejects a zero-value cost with a distribution — clamp value to
    // a minimal positive when the user enables a distribution on a zero
    // fixedCost. The inspector input updates to reflect this on the next render.
    const value = fixedValue > 0 ? fixedValue : 1;
    updateNodeFixedCost(node.id, { value, distribution: d });
  }

  const inputCls =
    'rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400';

  return (
    <div className="flex flex-col gap-2">
      {/* Phase 41 Slice 2 — dropped the redundant "Cost" label; the
          containing <Section> already advertises the heading. */}

      {/* Derived resource cost preview */}
      {projectHasCostData ? (
        assignmentCosts.length === 0 || resourceTotal === 0 ? (
          <p className="text-xs text-gray-400 dark:text-gray-500">
            No resource-driven cost{' '}
            {node.consumesResources
              ? '— assign resources with rates above.'
              : '(wait state — no resource hours charged).'}
          </p>
        ) : (
          <div className="rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-2 flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500 dark:text-gray-400">
                Resources (per unit duration)
              </span>
              <span className="font-mono font-medium text-gray-700 dark:text-gray-200">
                {formatMoney(resourceTotal, glyph)}
              </span>
            </div>
            {assignmentCosts.map((a) => (
              <div
                key={a.resourceId}
                className="flex items-center justify-between text-[10.5px] text-gray-400 dark:text-gray-500"
              >
                <span className="truncate">
                  {a.resourceName}: {formatMoney(a.rate, glyph)}/hr × {nodeHours}h × {a.count}
                  {a.perUse > 0 ? ` + ${formatMoney(a.perUse, glyph)}/use × ${a.count}` : ''}
                </span>
                <span className="font-mono shrink-0 ml-2">{formatMoney(a.total, glyph)}</span>
              </div>
            ))}
            {isLoopBody && (
              <p className="text-[10.5px] text-amber-600 dark:text-amber-400 mt-1">
                Inside a loop — this is the per-iteration unit cost; the scheduler scales by the
                loop&rsquo;s iteration count.
              </p>
            )}
          </div>
        )
      ) : (
        <p className="text-xs text-gray-400 dark:text-gray-500">
          —{' '}
          <span className="text-gray-300 dark:text-gray-600">
            Add cost rates to resources to compute resource-driven cost.
          </span>
        </p>
      )}

      {/* Editable fixed cost — Phase 41 Slice 2 made this hide-when-default.
          When `node.fixedCost` is undefined the editor collapses into a
          "+ Add fixed cost" link; clicking seeds a zero-value fixed cost
          and reveals the full editor. Setting value back to 0 with no
          distribution returns to undefined → the link reappears. */}
      {node.fixedCost !== undefined ? (
        <div className="flex flex-col gap-1 pt-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">Fixed cost</span>
            <span className="text-xs text-gray-400 dark:text-gray-500">({glyph})</span>
            <NumericInput
              value={fixedValue}
              min={0}
              step={currencyStep(project.currency, fixedValue, 'rate')}
              onCommit={handleFixedValueChange}
              className={`flex-1 ${inputCls}`}
            />
            <button
              type="button"
              onClick={() => updateNodeFixedCost(node.id, undefined)}
              className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 underline"
              title="Remove the fixed-cost line item"
            >
              Remove
            </button>
          </div>
          <DistributionPicker
            dist={node.fixedCost?.distribution}
            nominal={fixedValue > 0 ? fixedValue : 100}
            kind="cost"
            currency={project.currency}
            onChange={handleFixedDistChange}
          />
          {isLoopBody && (
            <label
              className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 mt-1"
              title="Charged every iteration by default — toggle on to charge only once per loop."
            >
              <input
                type="checkbox"
                checked={node.fixedCostOnce === true}
                onChange={(e) =>
                  updateNodeFixedCostOnce(node.id, e.target.checked ? true : undefined)
                }
                className="rounded border-gray-300 dark:border-gray-600 text-emerald-600 focus:ring-emerald-400"
              />
              <span>One-time cost (not per iteration)</span>
            </label>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => updateNodeFixedCost(node.id, { value: 0 })}
          className="self-start text-xs text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 underline mt-1"
        >
          + Add fixed cost
        </button>
      )}
    </div>
  );
}

// ── Crash section (Phase 25) ──────────────────────────────────────────────────

interface CrashSectionProps {
  node: import('@procsim/file-format').ProjectNode;
  glyph: string;
  /** ISO 4217 code, used to drive `currencyStep` on the additionalCost input. */
  currency: string;
  addCrashOption: (nodeId: string, option: CrashOption) => void;
  updateCrashOption: (nodeId: string, index: number, option: CrashOption) => void;
  removeCrashOption: (nodeId: string, index: number) => void;
  selectCrashOption: (nodeId: string, index: number | undefined) => void;
}

function CrashSection({
  node,
  glyph,
  currency,
  addCrashOption,
  updateCrashOption,
  removeCrashOption,
  selectCrashOption,
}: CrashSectionProps) {
  const options = node.crashOptions ?? [];
  const selected = node.selectedCrashIndex;
  const nodeUnit = node.duration.unit;
  const nodeDurValue = node.duration.value;

  // Default for a new row: half the nominal duration in the same unit.
  // Activity / decision nodes are guaranteed > 0 by the schema, so half is
  // always a valid "shorter" value.
  function handleAdd() {
    addCrashOption(node.id, {
      duration: { value: nodeDurValue / 2, unit: nodeUnit },
      additionalCost: 0,
    });
  }

  const inputCls =
    'rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-400';

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
        Compression options
      </label>
      <p className="text-[10.5px] text-gray-400 dark:text-gray-500 -mt-1 leading-snug">
        Each option specifies the activity&rsquo;s new (shorter) duration when selected, an extra
        one-time cost added to this activity&rsquo;s total, and a resource-rate multiplier (1.0 =
        same rate, 2.0 = double-time OT, etc).
      </p>

      {/* "None" pseudo-row — always present so deselecting back to nominal
          is a single click. */}
      <label
        className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 cursor-pointer"
        title="Use the nominal duration (no extra cost)"
      >
        <input
          type="radio"
          name={`crash-${node.id}`}
          checked={selected === undefined}
          onChange={() => selectCrashOption(node.id, undefined)}
          className="text-emerald-600 focus:ring-emerald-400"
        />
        <span>
          None — nominal {nodeDurValue} {nodeUnit}
        </span>
      </label>

      {options.map((opt, idx) => {
        // Schema enforces same-unit at save time. If a stored entry's unit
        // somehow disagrees with the node's current unit (e.g. the user
        // changed the node unit after authoring options), surface that to
        // the user as a warning row rather than silently overwriting.
        const unitMismatch = opt.duration.unit !== nodeUnit;
        return (
          <div
            key={idx}
            className="rounded border border-gray-200 dark:border-gray-700 p-2 flex flex-col gap-1.5"
          >
            {/* Three rows per option — keeps each row inside the
                Inspector's 288px default width. Row 1: radio + label +
                duration input + unit + saves-Xh delta + remove.
                Row 2: extra-cost label + +$ + input.
                Row 3: rate-× label + multiplier input + reminder. */}
            <div className="flex items-center gap-2">
              <input
                type="radio"
                name={`crash-${node.id}`}
                checked={selected === idx}
                onChange={() => selectCrashOption(node.id, idx)}
                className="text-emerald-600 focus:ring-emerald-400 shrink-0"
                title="Select this compression option"
              />
              <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">
                Compress to
              </span>
              <NumericInput
                value={opt.duration.value}
                min={0}
                step={0.5}
                onCommit={(v) => {
                  if (v <= 0) return;
                  // Always write the node's current unit. The duration
                  // value is the user's edit; validation (must be strictly
                  // less than nominal) is enforced at save time, but we
                  // give them visual feedback below.
                  updateCrashOption(node.id, idx, {
                    ...opt,
                    duration: { value: v, unit: nodeUnit },
                  });
                }}
                className={`w-14 shrink-0 ${inputCls}`}
                title={`Compressed duration in ${nodeUnit}`}
              />
              <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">
                {nodeUnit}
              </span>
              <div className="flex-1" />
              <button
                onClick={() => removeCrashOption(node.id, idx)}
                className="text-xs text-gray-400 hover:text-red-500 shrink-0"
                title="Remove this compression option"
              >
                ×
              </button>
            </div>
            {/* Saves-N delta hint — only when the row currently passes
                schema validation (value < nominal); the red-warning copy
                below replaces it when the value is invalid. */}
            {opt.duration.value < nodeDurValue && !unitMismatch && (
              <p className="text-[10.5px] text-gray-400 dark:text-gray-500 -mt-1 ml-6">
                Saves {nodeDurValue - opt.duration.value} {nodeUnit} vs nominal ({nodeDurValue}{' '}
                {nodeUnit}).
              </p>
            )}
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">
                Extra cost
              </span>
              <span className="text-[11px] text-gray-400 dark:text-gray-500 shrink-0">
                +{glyph}
              </span>
              <NumericInput
                value={opt.additionalCost}
                min={0}
                step={currencyStep(currency, opt.additionalCost, 'rate')}
                onCommit={(v) =>
                  updateCrashOption(node.id, idx, {
                    ...opt,
                    additionalCost: v,
                  })
                }
                className={`flex-1 min-w-0 ${inputCls}`}
                title="One-time fee added on top of resource cost and fixed cost when this option is selected"
              />
            </div>
            <div className="flex items-center gap-2">
              <span
                className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0"
                title="Multiplies each assigned resource's hourly rate when this option is selected. 1.0 = no change (expedite). 1.5 = time-and-a-half OT. 2.0 = double-time."
              >
                Rate &times;
              </span>
              <NumericInput
                value={opt.resourceCostMultiplier ?? 1}
                min={0.1}
                step={0.1}
                onCommit={(v) => {
                  // Destructure-rebuild to drop the field when the user
                  // returns to exactly 1.0 (the engine default).
                  if (v === 1) {
                    const { resourceCostMultiplier: _x, ...rest } = opt;
                    updateCrashOption(node.id, idx, rest);
                  } else {
                    updateCrashOption(node.id, idx, {
                      ...opt,
                      resourceCostMultiplier: v,
                    });
                  }
                }}
                className={`w-16 shrink-0 ${inputCls}`}
                title="Resource rate multiplier when this option is selected"
              />
              <span className="text-[10.5px] text-gray-400 dark:text-gray-500">
                {(opt.resourceCostMultiplier ?? 1) === 1
                  ? '(expedite — no rate change)'
                  : (opt.resourceCostMultiplier ?? 1) > 1
                    ? '(overtime / premium)'
                    : '(discount)'}
              </span>
            </div>
            {opt.duration.value >= nodeDurValue && !unitMismatch && (
              <p className="text-[10.5px] text-red-500 dark:text-red-400">
                Must be strictly shorter than nominal ({nodeDurValue} {nodeUnit}).
              </p>
            )}
            {unitMismatch && (
              <p className="text-[10.5px] text-amber-600 dark:text-amber-400">
                Stored unit ({opt.duration.unit}) differs from node unit ({nodeUnit}). Re-edit the
                value to fix.
              </p>
            )}
          </div>
        );
      })}

      <button
        onClick={handleAdd}
        className="self-start text-xs text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 underline"
      >
        + Add compression option
      </button>
    </div>
  );
}

// ── Phase 40 — Duration semantic tooltip copy ────────────────────────────────

// Single source of truth for the explanatory text shown on each semantic.
// Used in two places: the inline dropdown's `title` attribute (so users see
// it on hover anywhere in the duration row) and the per-option `title`
// (so the native picker shows them when the user has the menu open).
const DURATION_SEMANTIC_TITLES: Readonly<Record<DurationSemantic, string>> = {
  effort:
    'Effort: a "day" is always 8 hours, regardless of calendar. ' +
    'Adopting an intense schedule compresses wall-clock; the work itself does not grow.',
  time:
    'Time: a "day" follows the calendar in use. Adopting an intense ' +
    'schedule inflates effort (more hours/day means a 5-day activity ' +
    'consumes more total hours). Good for elapsed periods (gate reviews, ' +
    'regulatory waits).',
};

interface EquivalentHoursLabelProps {
  duration: Duration;
  semantic: DurationSemantic;
  cal: Calendar | undefined;
  calName: string | undefined;
}

/**
 * Inline secondary label below a duration input that reveals the
 * underlying hours figure. Suppressed when the user is already entering
 * hours (the label would be tautological), and when no inspector
 * calendar is available (which only happens for malformed projects).
 *
 * The exact-vs-approximate distinction is deliberate: under effort
 * semantics the conversion is canonical and exact (`5 days = 40h`),
 * but under time semantics days/weeks fold into the calendar's
 * hoursPerDay which the user may have set to a non-integer — so we
 * show a "≈" prefix and the calendar name so it's clear *which*
 * calendar produced the figure.
 */
function EquivalentHoursLabel({ duration, semantic, cal, calName }: EquivalentHoursLabelProps) {
  if (duration.unit === 'hours') return null;
  if (!cal) return null;
  const hours = toHours(duration, cal, semantic);
  // 2-decimal precision when the figure isn't an integer; trims to "40"
  // rather than "40.00" when it is.
  const formatted = Number.isInteger(hours) ? hours.toString() : hours.toFixed(2);
  if (semantic === 'effort') {
    return (
      <p className="text-[11px] text-gray-400 dark:text-gray-500">
        = {formatted} hours <span className="opacity-70">(standard)</span>
      </p>
    );
  }
  return (
    <p className="text-[11px] text-gray-400 dark:text-gray-500">
      ≈ {formatted} hours{' '}
      <span className="opacity-70">(under {calName ?? 'current calendar'})</span>
    </p>
  );
}

// ── Phase 41 Slice 2 — Collapsible inspector sections + add-row link ────────

interface SectionProps {
  id: InspectorSectionId;
  title: string;
  children: React.ReactNode;
}

/**
 * Native `<details>` wrapper that syncs its open/closed state with
 * `viewStore.inspectorSectionsOpen`, so user preference persists across
 * node selections AND browser reloads.
 *
 * Sync rule: `onToggle` fires for any change to `details.open` (user click
 * or programmatic). We only push back to the store when the DOM value
 * diverges from the React-controlled `open` prop, which prevents the
 * loop "React renders open=true → DOM matches → onToggle fires → store
 * updates → React renders open=true again → ..." from triggering an
 * infinite cycle of `set` calls.
 */
function Section({ id, title, children }: SectionProps) {
  const isOpen = useViewStore((s) => s.inspectorSectionsOpen[id]);
  const toggle = useViewStore((s) => s.toggleInspectorSection);
  return (
    <details
      open={isOpen}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        if (next !== isOpen) toggle(id);
      }}
      className="group"
    >
      <summary className="cursor-pointer select-none flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-3 list-none [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="inline-block w-3 text-center transition-transform group-open:rotate-90"
        >
          ▸
        </span>
        {title}
      </summary>
      <div className="flex flex-col gap-5 pl-4">{children}</div>
    </details>
  );
}

/**
 * Compact "+ Add X" link used to reveal a hide-when-default row. Visually
 * matches the existing "+ Add" buttons elsewhere in the inspector.
 */
function AddRowLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="self-start text-xs text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 underline"
    >
      {label}
    </button>
  );
}

// ── Phase 42 — work-split editor ─────────────────────────────────────────────

interface ShareInputProps {
  nodeId: string;
  resourceId: string;
  share: number;
  shareMode: 'percentage' | 'weight';
  shareTotal: number;
  onChange: (next: number) => void;
}

/**
 * Per-assignment share input rendered inside each multi-pool resource card.
 * Behaviour by mode:
 *   - percentage: shows the raw share as `% [N]`. Tolerates user typing
 *     fractional values (33.33-style) but the action stores whatever
 *     the input parses to. No auto-rebalance on edit — the running
 *     total surfaced by `ShareControls` flags the off-100 state.
 *   - weight: shows the raw weight with the computed percentage
 *     `(shareTotal-relative)` in parens so the user has both axes
 *     visible while editing.
 */
function ShareInput({ resourceId, share, shareMode, shareTotal, onChange }: ShareInputProps) {
  const percent = shareTotal > 0 ? Math.round((share / shareTotal) * 100) : 0;
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 shrink-0"
        title={
          shareMode === 'percentage'
            ? "This pool's percentage share of the activity's effort. Must sum to 100 across all pools."
            : "This pool's relative weight. The engine normalises across all pools."
        }
      >
        Share
      </span>
      <input
        type="number"
        min={0}
        {...(shareMode === 'percentage' ? { max: 100 } : {})}
        step={shareMode === 'percentage' ? 1 : 0.5}
        value={share}
        onFocus={beginEdit}
        onBlur={commitEdit}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!isFinite(v) || v < 0) return;
          // Inspector caps at 100 in percentage mode; the action also
          // clamps defensively (and uses the cap to auto-set the peer in
          // 2-pool activities).
          onChange(shareMode === 'percentage' ? Math.min(100, v) : v);
        }}
        className="w-14 rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-400"
        aria-label={`Share for ${resourceId}`}
      />
      <span className="text-[11px] text-gray-400 dark:text-gray-500 tabular-nums">
        {shareMode === 'percentage' ? '%' : `(${percent}%)`}
      </span>
    </div>
  );
}

interface ShareControlsProps {
  nodeId: string;
  shareMode: 'percentage' | 'weight';
  sharesPresent: boolean;
  shareTotal: number;
  onAdd: () => void;
  onReset: () => void;
  onDistributeEvenly: () => void;
}

/**
 * Footer for the Resources section on multi-pool activities. Two states:
 *   - No shares anywhere → single "+ Add work split" link.
 *   - Shares present → Total line (validated in percentage mode) +
 *     "Distribute evenly" + "Reset to no work split" links.
 */
function ShareControls({
  shareMode,
  sharesPresent,
  shareTotal,
  onAdd,
  onReset,
  onDistributeEvenly,
}: ShareControlsProps) {
  if (!sharesPresent) {
    return <AddRowLink label="+ Add work split" onClick={onAdd} />;
  }
  // Percentage validation: green tick when sum=100±0.01, amber otherwise.
  // Weight mode has no sum constraint; show the raw total as info-only.
  const PERCENTAGE_TOLERANCE = 0.01;
  const ok = shareMode !== 'percentage' || Math.abs(shareTotal - 100) < PERCENTAGE_TOLERANCE;
  return (
    <div className="flex flex-col gap-1.5">
      {shareMode === 'percentage' ? (
        <div
          className={[
            'flex items-center justify-between rounded px-2 py-1 text-[11px]',
            ok
              ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
              : 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
          ].join(' ')}
        >
          <span>
            Total:{' '}
            <span className="font-mono tabular-nums">
              {shareTotal.toFixed(shareTotal === Math.round(shareTotal) ? 0 : 2)}%
            </span>{' '}
            {ok ? '✓' : `⚠ — adjust to 100`}
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-between rounded px-2 py-1 text-[11px] bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400">
          <span>
            Total weight: <span className="font-mono tabular-nums">{shareTotal}</span>
          </span>
        </div>
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onDistributeEvenly}
          className="text-xs text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 underline"
        >
          Distribute evenly
        </button>
        <button
          type="button"
          onClick={onReset}
          className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 underline"
        >
          Reset to no work split
        </button>
      </div>
    </div>
  );
}

interface NodePanelProps {
  nodeId: string;
  onClose: () => void;
}

export function NodePanel({ nodeId, onClose }: NodePanelProps) {
  const project = useDomainStore((s) => s.project);
  // Phase 24 — surface resource conflicts in an amber banner above the
  // Properties form. The engine's conflictedNodeIds is the single source
  // of truth (same day-bucketing as the Resources tab).
  const scheduleOutcome = useSchedule();
  const conflictReasons = scheduleOutcome.ok
    ? scheduleOutcome.result.conflictedNodeIds[nodeId]
    : undefined;
  const updateNodeName = useDomainStore((s) => s.updateNodeName);
  const updateNodeDuration = useDomainStore((s) => s.updateNodeDuration);
  const updateNodeDurationSemantic = useDomainStore((s) => s.updateNodeDurationSemantic);
  const updateNodeColor = useDomainStore((s) => s.updateNodeColor);
  const updateNodeGroup = useDomainStore((s) => s.updateNodeGroup);
  const updateNodeDescription = useDomainStore((s) => s.updateNodeDescription);
  const updateNodeCalendarId = useDomainStore((s) => s.updateNodeCalendarId);
  const setNodeCalendarFromTemplate = useDomainStore((s) => s.setNodeCalendarFromTemplate);
  const updateNodeDistribution = useDomainStore((s) => s.updateNodeDistribution);
  const updateNodeAnchorDate = useDomainStore((s) => s.updateNodeAnchorDate);
  const updateNodePassProbability = useDomainStore((s) => s.updateNodePassProbability);
  const updateNodeFailureDelay = useDomainStore((s) => s.updateNodeFailureDelay);
  const setNodeLevelPriority = useDomainStore((s) => s.setNodeLevelPriority);
  // Phase 18 slice 2 — granular multi-resource actions. The bulk
  // setNodeResourceAssignments still exists (and is kept for paste / import
  // paths) but per-row inspector edits now go through these so undo lands
  // one history entry per user action — and count keystrokes coalesce
  // within a focus session instead of stamping a history entry per stroke.
  const addResourceAssignment = useDomainStore((s) => s.addResourceAssignment);
  const removeResourceAssignment = useDomainStore((s) => s.removeResourceAssignment);
  const updateResourceAssignmentCount = useDomainStore((s) => s.updateResourceAssignmentCount);
  const updateResourceAssignmentPolicy = useDomainStore((s) => s.updateResourceAssignmentPolicy);
  const updateResourceAssignmentParallelism = useDomainStore(
    (s) => s.updateResourceAssignmentParallelism,
  );
  // Phase 42 — share-editing actions
  const setAssignmentShare = useDomainStore((s) => s.setAssignmentShare);
  const initialiseEqualShares = useDomainStore((s) => s.initialiseEqualShares);
  const clearAllShares = useDomainStore((s) => s.clearAllShares);
  const distributeSharesEvenly = useDomainStore((s) => s.distributeSharesEvenly);
  // Phase 19 — cost-field actions
  const updateNodeFixedCost = useDomainStore((s) => s.updateNodeFixedCost);
  const updateNodeFixedCostOnce = useDomainStore((s) => s.updateNodeFixedCostOnce);
  // Phase 25 — crashing actions
  const addCrashOption = useDomainStore((s) => s.addCrashOption);
  const updateCrashOption = useDomainStore((s) => s.updateCrashOption);
  const removeCrashOption = useDomainStore((s) => s.removeCrashOption);
  const selectCrashOption = useDomainStore((s) => s.selectCrashOption);
  // Phase 41 Slice 2 follow-up — bumped the default width from 288 to 320
  // (tailwind w-72 → w-80). The collapsibles + hide-when-default layout
  // fits better with a touch more horizontal room, especially the duration
  // row's three-dropdown layout (value / unit / semantic). Resize bounds
  // (200..800) unchanged; users who dragged it narrower keep their pick.
  const { width, onMouseDown } = useResizable(320);

  // Audit I-18 — group colors moved to domainStore (project.groupColors),
  // so the override persists across reload + threads through undo.
  const groupColors = useDomainStore((s) => s.project.groupColors);
  const setGroupColor = useDomainStore((s) => s.updateGroupColor);
  // Phase 43 Slice 1 — scroll-to-row hint set by the palette drop handler
  // when the user drops on an already-assigned node. Consumed once and
  // cleared so a later selection change doesn't re-scroll.
  const inspectorScrollToAssignmentId = useViewStore((s) => s.inspectorScrollToAssignmentId);
  const setInspectorScrollToAssignmentId = useViewStore((s) => s.setInspectorScrollToAssignmentId);

  const [addingAssignment, setAddingAssignment] = useState(false);
  const [newResourceId, setNewResourceId] = useState('');
  const [newCount, setNewCount] = useState(1);
  const [newPolicy, setNewPolicy] = useState<CalendarPolicy>('intersection');
  // Phase 49 Slice 8 — Calendar override is collapse-by-default. Shows
  // a "+ Add calendar override" link when `calendarId === null` AND
  // the user hasn't expanded; the link or an actually-set override
  // flips it to the select. Resets per nodeId so each freshly-
  // selected node opens in the default collapsed state.
  const [calOverrideOpen, setCalOverrideOpen] = useState(false);
  useEffect(() => {
    setCalOverrideOpen(false);
  }, [nodeId]);
  // Phase 43 Slice 1 — ref on the assignment-rows container so the
  // scroll-to-row effect can scope its query inside this panel (no DOM-
  // wide querySelector that could collide with other Inspectors).
  const assignmentsListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const resourceId = inspectorScrollToAssignmentId;
    if (!resourceId) return;
    const list = assignmentsListRef.current;
    if (!list) {
      // Section not mounted (anchor / decision node, or Resources still
      // collapsed for some reason). Clear the hint so a later activity-
      // node selection doesn't act on a stale id.
      setInspectorScrollToAssignmentId(null);
      return;
    }
    const row = list.querySelector<HTMLElement>(`[data-assignment-id="${CSS.escape(resourceId)}"]`);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    setInspectorScrollToAssignmentId(null);
  }, [inspectorScrollToAssignmentId, nodeId, setInspectorScrollToAssignmentId]);

  const node = project.nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  // Phase 10 Tier 1: Start/End anchors are atomic — only `name` and `id` are
  // user-meaningful. Bypass the full activity property panel.
  const isAnchor = node.nodeType === 'start' || node.nodeType === 'end';

  const assignments = node.resourceAssignments;
  // Phase 42 — derive share state once per render. The schema's all-or-none
  // invariant means `anyShareSet` is sufficient to switch UI modes; we
  // don't need a separate `allShareSet` because the two are equivalent
  // on a schema-valid project.
  const anyShareSet = assignments.some((a) => a.share !== undefined);
  const shareTotal = assignments.reduce((s, a) => s + (a.share ?? 0), 0);
  const assignedIds = new Set(assignments.map((a) => a.resourceId));
  const availableResources = project.resources.filter((r) => !assignedIds.has(r.id));

  // Phase 40 — primary calendar visible to the user in the Inspector. The
  // scheduler folds in resource calendars for the actual wall-clock, but in
  // the duration row the user is reasoning about their *own* calendar
  // choice (or the project default if they haven't set one), not the
  // resource-aware intersection.
  const inspectorCal: Calendar | undefined =
    node.calendarId === null
      ? project.calendars.find((c) => c.id === project.project.defaultCalendarId)
      : project.calendars.find((c) => c.id === node.calendarId);
  const inspectorCalName = inspectorCal?.name;

  // All unique group names (nodes + loops) sorted — for autocomplete + color palette assignment
  const allGroupNames = useMemo(
    () => computeAllGroupNames(project.nodes, project.loops),
    // Depend on the full arrays; useMemo keeps reference stable when content unchanged
    [project.nodes, project.loops],
  );
  const groupSuggestions = allGroupNames;

  // Resolved color for the node's current group (user override → auto palette)
  const resolvedGroupColor = node.group
    ? (groupColors[node.group] ?? autoGroupColor(node.group, allGroupNames))
    : null;

  // Detect if this node is a loop body member — its group field is superseded by the loop's group
  const owningLoop = project.loops.find((l) => l.bodyNodeIds.includes(nodeId));

  function handleAddAssignment() {
    const rid = newResourceId || availableResources[0]?.id;
    if (!rid) {
      // I-25 — no available resources to assign. Surface a toast so
      // the user knows why nothing happened (was a silent no-op).
      useViewStore.getState().pushToast({
        kind: 'info',
        text:
          project.resources.length === 0
            ? 'No resources defined yet — add one in the Resources tab.'
            : 'All resources are already assigned to this node.',
      });
      return;
    }
    addResourceAssignment(nodeId, {
      resourceId: rid,
      count: newCount,
      calendarPolicy: newPolicy,
    });
    setAddingAssignment(false);
    setNewResourceId('');
    setNewCount(1);
    setNewPolicy('intersection');
  }

  function handleRemoveAssignment(resourceId: string) {
    removeResourceAssignment(nodeId, resourceId);
  }

  function handlePolicyChange(resourceId: string, policy: CalendarPolicy) {
    updateResourceAssignmentPolicy(nodeId, resourceId, policy);
  }

  function handleCountChange(resourceId: string, count: number) {
    // count<1 is silently no-op'd inside the action. The surrounding input
    // owns the edit session (onFocus={beginEdit}, onBlur={commitEdit}) so
    // multiple keystrokes within one focus coalesce into a single history
    // entry — mirroring the updateNodeName pattern.
    updateResourceAssignmentCount(nodeId, resourceId, count);
  }

  // Phase 23 slice 1 — three-state parallelism control on each resource
  // assignment. The stored value (`parallelism: number | undefined`) is
  // projected onto a discrete UI state for the segmented control:
  //
  //   undefined → 'off' (legacy file with no field, treated as 0).
  //   0         → 'off'
  //   1         → 'on'
  //   else      → 'variable' (slider visible)
  //
  // Off-button writes 0 explicitly (per the user's spec: "make Off
  // storage as explicit 0"). On writes 1. Variable defaults to 0.5
  // when the user hasn't set a slider value yet.
  function parallelismMode(value: number | undefined): 'off' | 'variable' | 'on' {
    if (value === undefined || value === 0) return 'off';
    if (value === 1) return 'on';
    return 'variable';
  }
  function handleParallelismMode(resourceId: string, mode: 'off' | 'variable' | 'on') {
    if (mode === 'off') updateResourceAssignmentParallelism(nodeId, resourceId, 0);
    else if (mode === 'on') updateResourceAssignmentParallelism(nodeId, resourceId, 1);
    else updateResourceAssignmentParallelism(nodeId, resourceId, 0.5);
  }
  function handleParallelismSlider(resourceId: string, raw: number) {
    // Clamp to [0, 1] defensively; the slider's min/max already enforce.
    const clamped = Math.max(0, Math.min(1, raw));
    updateResourceAssignmentParallelism(nodeId, resourceId, clamped);
  }

  const inputCls =
    'rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400';
  const labelCls = 'text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide';

  if (isAnchor) {
    const kindLabel = node.nodeType === 'start' ? 'Start anchor' : 'End anchor';
    return (
      <aside
        style={{ width }}
        className="relative shrink-0 border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col overflow-y-auto max-md:fixed max-md:inset-x-0 max-md:bottom-[86px] max-md:w-full! max-md:max-w-full! max-md:max-h-[60vh] max-md:border-l-0 max-md:border-t max-md:rounded-t-lg max-md:shadow-xl max-md:z-40"
      >
        <div
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-emerald-400 transition-colors z-10 max-md:hidden"
          onMouseDown={onMouseDown}
        />
        {/* Mobile drag indicator pill — visual cue that this is a bottom
            sheet. No swipe-to-dismiss yet; × button + canvas-tap-clear
            handle dismissal. */}
        <div className="md:hidden flex justify-center pt-1.5 pb-1">
          <div className="h-1 w-12 rounded-full bg-gray-300 dark:bg-gray-700" />
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{kindLabel}</h2>
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none max-md:w-11 max-md:h-11 max-md:inline-flex max-md:items-center max-md:justify-center"
            aria-label="Close panel"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-5 p-4">
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>Name</label>
            <input
              type="text"
              value={node.name}
              onFocus={beginEdit}
              onBlur={commitEdit}
              onChange={(e) => updateNodeName(nodeId, e.target.value)}
              className={`w-full ${inputCls}`}
            />
          </div>

          {/* Group (swimlane) — same field as activity nodes, lets start/end
              anchors participate in group-color highlighting. */}
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>Group</label>
            <div className="flex items-center gap-2">
              <GroupAutocomplete
                value={node.group ?? ''}
                suggestions={groupSuggestions}
                placeholder="e.g. Design Phase"
                inputClassName={`flex-1 ${inputCls}`}
                onFocus={beginEdit}
                onCommit={(v) => {
                  commitEdit();
                  updateNodeGroup(nodeId, v);
                }}
              />
              {node.group && resolvedGroupColor && (
                <input
                  type="color"
                  value={resolvedGroupColor}
                  onChange={(e) => setGroupColor(node.group!, e.target.value)}
                  title={`Color for "${node.group}" group`}
                  className="h-8 w-8 shrink-0 rounded cursor-pointer p-0.5 border border-gray-300 dark:border-gray-600"
                />
              )}
            </div>
          </div>

          {/* Phase 10 Tier 1 — Anchor date for Start nodes only.
              Pins the start of this branch in the calendar. Cleared = fall
              back to the project's global startDate. */}
          {node.nodeType === 'start' && (
            <div className="flex flex-col gap-1.5">
              <label className={labelCls}>Anchor date</label>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={node.anchorDate ?? ''}
                  onFocus={beginEdit}
                  onBlur={commitEdit}
                  onChange={(e) => {
                    const v = e.target.value;
                    updateNodeAnchorDate(nodeId, v === '' ? undefined : v);
                  }}
                  className={`flex-1 ${inputCls}`}
                />
                {node.anchorDate && (
                  <button
                    onClick={() => updateNodeAnchorDate(nodeId, undefined)}
                    className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 underline shrink-0"
                    title="Use the project's global start date instead"
                  >
                    Clear
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500 leading-relaxed">
                Sets the calendar start date for the chain rooted at this Start node. If cleared,
                the project&rsquo;s start date is used. Snapped forward to the next working moment
                if it falls on a non-working day.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>ID</label>
            <p className="text-xs text-gray-400 dark:text-gray-500 font-mono break-all">
              {node.id}
            </p>
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
            Anchors are zero-duration milestones used to mark the entry or exit of the process. They
            don&rsquo;t consume resources and don&rsquo;t appear as bars in the Gantt chart.
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside
      style={{ width }}
      className="relative shrink-0 border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex flex-col overflow-y-auto max-md:fixed max-md:inset-x-0 max-md:bottom-[86px] max-md:w-full! max-md:max-w-full! max-md:max-h-[60vh] max-md:border-l-0 max-md:border-t max-md:rounded-t-lg max-md:shadow-xl max-md:z-40"
    >
      {/* Drag-to-resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-emerald-400 transition-colors z-10 max-md:hidden"
        onMouseDown={onMouseDown}
      />
      {/* Mobile drag indicator pill — visual cue that this is a bottom
          sheet. No swipe-to-dismiss yet; × button + canvas-tap-clear
          handle dismissal. */}
      <div className="md:hidden flex justify-center pt-1.5 pb-1">
        <div className="h-1 w-12 rounded-full bg-gray-300 dark:bg-gray-700" />
      </div>
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Properties</h2>
        <button
          onClick={onClose}
          className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none max-md:w-11 max-md:h-11 max-md:inline-flex max-md:items-center max-md:justify-center"
          aria-label="Close panel"
        >
          ×
        </button>
      </div>

      {/* Phase 24 — resource-conflict banner. Read-only signal; the
          Auto-level affordance lives on the Resources tab. */}
      {conflictReasons && conflictReasons.length > 0 && (
        <div
          className="mx-4 mt-3 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/30 dark:border-amber-700 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 flex flex-col gap-1"
          role="status"
        >
          <div className="flex items-center gap-1.5 font-medium">
            <span aria-hidden>⚠️</span>
            Resource conflict
          </div>
          {conflictReasons.map((r) => {
            const res = project.resources.find((x) => x.id === r.resourceId);
            const name = res?.name ?? r.resourceId;
            const days = r.overCapacityDayCount;
            return (
              <div key={r.resourceId} className="pl-5 text-amber-700 dark:text-amber-300">
                {name} — {days} day{days === 1 ? '' : 's'} over capacity
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-col gap-4 p-4">
        <Section id="identity" title="Identity">
          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>Name</label>
            <input
              type="text"
              value={node.name}
              onFocus={beginEdit}
              onBlur={commitEdit}
              onChange={(e) => updateNodeName(nodeId, e.target.value)}
              className={`w-full ${inputCls}`}
            />
          </div>

          {/* Group (swimlane) */}
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>Group</label>
            {owningLoop?.group ? (
              // Node is inside a loop that already owns a group — the group is
              // controlled by the loop, not the individual node.
              <div className="flex items-center gap-2">
                <div
                  className={`flex-1 ${inputCls} opacity-60 cursor-not-allowed select-none`}
                  title="Controlled by the parent loop"
                >
                  {owningLoop.group}
                </div>
                <div
                  className="h-8 w-8 shrink-0 rounded border border-gray-300 dark:border-gray-600 p-0.5"
                  style={{
                    backgroundColor:
                      groupColors[owningLoop.group] ??
                      autoGroupColor(owningLoop.group, allGroupNames),
                  }}
                  title={`Group color for "${owningLoop.group}"`}
                />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <GroupAutocomplete
                  value={node.group ?? ''}
                  suggestions={groupSuggestions}
                  placeholder="e.g. Design Phase"
                  inputClassName={`flex-1 ${inputCls}`}
                  onFocus={beginEdit}
                  onCommit={(v) => {
                    commitEdit();
                    updateNodeGroup(nodeId, v);
                  }}
                />
                {/* Color swatch — visible when a group is assigned */}
                {node.group && resolvedGroupColor && (
                  <input
                    type="color"
                    value={resolvedGroupColor}
                    onChange={(e) => setGroupColor(node.group!, e.target.value)}
                    title={`Color for "${node.group}" group (shared with all nodes in this group)`}
                    className="h-8 w-8 shrink-0 rounded cursor-pointer p-0.5 border border-gray-300 dark:border-gray-600"
                  />
                )}
              </div>
            )}
            {owningLoop && (
              <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1">
                <span className="shrink-0">ⓘ</span>
                <span>
                  This node is inside a loop. In the Gantt chart, it follows the{' '}
                  <strong>loop&rsquo;s group</strong>
                  {owningLoop.group ? ` ("${owningLoop.group}")` : ' (none set)'}. Set the group on
                  the loop to move it in the chart.
                </span>
              </p>
            )}
          </div>

          {/* Description (free-text notes — assumptions, references, context) */}
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>Description</label>
            <textarea
              value={node.description ?? ''}
              onFocus={beginEdit}
              onBlur={commitEdit}
              onChange={(e) => {
                const v = e.target.value;
                updateNodeDescription(nodeId, v === '' ? undefined : v);
              }}
              rows={4}
              // Audit N-11 — hard-cap at the schema's truncation point so
              // the user can't reach the silent "data lost on save" zone.
              // The amber soft-cap warning at 2000 chars below still fires
              // as an informational signal (the intended-length boundary).
              maxLength={SCHEMA_LIMITS.nodeDescription}
              placeholder="Assumptions, references, or context the title can't carry"
              className={`w-full ${inputCls} resize-y leading-snug`}
            />
            <div className="flex justify-end">
              <span
                className={
                  (node.description?.length ?? 0) > 2000
                    ? 'text-xs text-amber-600 dark:text-amber-400 tabular-nums'
                    : 'text-xs text-gray-400 dark:text-gray-500 tabular-nums'
                }
              >
                {node.description?.length ?? 0} / 2000
              </span>
            </div>
          </div>

          {/* Phase 41 Slice 2 — Color moved up from the panel footer so it
            sits with the other identity attributes (name / group /
            description). The picker is small and useful at a glance. */}
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>Color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={node.color ?? DEFAULT_COLOR}
                onChange={(e) => updateNodeColor(nodeId, e.target.value)}
                className="h-8 w-8 rounded border border-gray-300 dark:border-gray-600 cursor-pointer p-0.5"
              />
              {node.color ? (
                <button
                  onClick={() => updateNodeColor(nodeId, undefined)}
                  className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 underline"
                >
                  Remove
                </button>
              ) : (
                <span className="text-xs text-gray-400 dark:text-gray-500">None</span>
              )}
            </div>
          </div>
        </Section>

        <Section id="duration" title="Duration">
          {/* Duration row — value + unit + semantic, three dropdowns inline.
            Phase 41 Slice 2 collapsed the Phase 40 segmented "Effort-based /
            Time-based" control into a third <select> on this row so the
            section is one line tighter. Tooltip text moves to the dropdown
            itself + each option. */}
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>Duration</label>
            <div className="flex gap-2">
              <NumericInput
                value={node.duration.value}
                min={0}
                step={1}
                onCommit={(v) => {
                  updateNodeDuration(nodeId, v, node.duration.unit);
                  // Slice 9 — when a distribution is set, the duration
                  // value IS the distribution's `mode` (tri / PERT) or
                  // `mean` (normal). Keep them in sync; also clamp
                  // `min` / `max` so the distribution stays valid
                  // (e.g. user shrinks duration below the old min).
                  // beginEdit / commitEdit on focus / blur group both
                  // updates into one undo step.
                  const dist = node.distribution;
                  if (!dist) return;
                  if (dist.type === 'triangular' || dist.type === 'pert-beta') {
                    updateNodeDistribution(nodeId, {
                      ...dist,
                      mode: v,
                      min: Math.min(dist.min, v),
                      max: Math.max(dist.max, v),
                    });
                  } else if (dist.type === 'normal') {
                    updateNodeDistribution(nodeId, { ...dist, mean: v });
                  }
                }}
                className={`w-20 ${inputCls}`}
              />
              <select
                value={node.duration.unit}
                onChange={(e) =>
                  updateNodeDuration(nodeId, node.duration.value, e.target.value as DurationUnit)
                }
                className={inputCls}
              >
                <option value="hours">hours</option>
                <option value="days">days</option>
                <option value="weeks">weeks</option>
              </select>
              <select
                value={node.durationSemantic}
                onChange={(e) =>
                  updateNodeDurationSemantic(nodeId, e.target.value as DurationSemantic)
                }
                title={DURATION_SEMANTIC_TITLES[node.durationSemantic]}
                className={inputCls}
              >
                <option value="effort" title={DURATION_SEMANTIC_TITLES.effort}>
                  Effort
                </option>
                <option value="time" title={DURATION_SEMANTIC_TITLES.time}>
                  Time
                </option>
              </select>
            </div>
            <EquivalentHoursLabel
              duration={node.duration}
              semantic={node.durationSemantic}
              cal={inspectorCal}
              calName={inspectorCalName}
            />
          </div>

          {/* Decision gate parameters (Phase 11). Pass probability + failure
            delay are core to a gate's identity, so they stay always-visible.
            Phase 46 — the Phase 28 `isRisk` tagging flag was removed; the
            Risks tab now derives risks from `passProbability < 1` directly.

            PR #173 follow-up (Slice 10) — these fields now sit ABOVE the
            Distribution picker below, mirroring the activity-node
            convention that the source field for a distribution's centre
            value sits directly above the picker. For activities the
            source is Duration; for decisions it's Pass probability
            (Slice 10 made passProbability drive `mode` / `mean`). Keeping
            them visually paired makes the source ↔ picker link obvious. */}
          {node.nodeType === 'decision' && (
            <>
              <div className="flex flex-col gap-1.5">
                <label className={labelCls}>Pass probability</label>
                <div className="flex items-center gap-2">
                  <NumericInput
                    value={node.passProbability ?? 1}
                    min={0}
                    max={1}
                    step={0.05}
                    onCommit={(v) => {
                      updateNodePassProbability(nodeId, v);
                      // Slice 10 — pass-probability is now the source
                      // of truth for the probability distribution's
                      // mode (tri / PERT) or mean (normal). Keep them
                      // in sync; clamp min / max so the distribution
                      // stays valid (e.g. user drops passProbability
                      // below the old min). beginEdit / commitEdit on
                      // focus / blur groups both updates into one
                      // undo step (matches the duration / cost flow
                      // from Slice 9).
                      const dist = node.distribution;
                      if (!dist) return;
                      if (dist.type === 'triangular' || dist.type === 'pert-beta') {
                        updateNodeDistribution(nodeId, {
                          ...dist,
                          mode: v,
                          min: Math.min(dist.min, v),
                          max: Math.max(dist.max, v),
                        });
                      } else if (dist.type === 'normal') {
                        updateNodeDistribution(nodeId, { ...dist, mean: v });
                      }
                    }}
                    className={`w-24 ${inputCls}`}
                  />
                  <span className="text-xs text-gray-400 dark:text-gray-500">
                    {Math.round((node.passProbability ?? 1) * 100)}% pass on first attempt
                  </span>
                </div>
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  Probability the gate passes without rework. 1.0 = always passes.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className={labelCls}>Failure delay</label>
                <div className="flex gap-2">
                  <NumericInput
                    value={node.failureDelay?.value ?? 0}
                    min={0}
                    step={1}
                    onCommit={(v) => {
                      const unit = node.failureDelay?.unit ?? 'hours';
                      const next: Duration = { value: v, unit };
                      updateNodeFailureDelay(nodeId, next);
                    }}
                    className={`w-24 ${inputCls}`}
                  />
                  <select
                    value={node.failureDelay?.unit ?? 'hours'}
                    onChange={(e) => {
                      // I-17 — flush any in-flight edit session before
                      // this discrete unit change.
                      commitEdit();
                      const unit = e.target.value as DurationUnit;
                      const value = node.failureDelay?.value ?? 0;
                      const next: Duration = { value, unit };
                      updateNodeFailureDelay(nodeId, next);
                    }}
                    className={inputCls}
                  >
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                    <option value="weeks">weeks</option>
                  </select>
                </div>
                {node.failureDelay && (
                  <EquivalentHoursLabel
                    duration={node.failureDelay}
                    semantic={node.durationSemantic}
                    cal={inspectorCal}
                    calName={inspectorCalName}
                  />
                )}
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  Extra effort consumed when the gate fails. The deterministic schedule uses the
                  expected value: duration + (1 − pass) × failure delay.
                </p>
              </div>
            </>
          )}

          {/* Phase 49 Slice 8 — Distribution (Monte Carlo) moved up
            from the bottom of the section and made expanded-by-
            default. The picker handles `dist === undefined` natively
            by rendering the "None" card as selected, so we always
            mount it. Clicking any card seeds the appropriate default;
            clicking "None" returns the field to undefined without
            hiding the picker.

            PR #170 follow-up — `nominal` is the activity's duration
            value in its OWN unit (no conversion to hours). The
            distribution's min / mode / max / mean / stddev are
            authored in the SAME unit as the activity's duration —
            that's the locked-in convention enforced by the
            "distribution sampling preserves activity duration unit"
            test in packages/simulation. Earlier code converted to
            hours here (using a hardcoded 8 h / day, 40 h / week),
            which silently inflated samples by 8× / 40× when the
            sim later interpreted the value as days / weeks.

            PR #173 follow-up (Slice 10) — for decision nodes this
            picker now follows Pass probability + Failure delay
            (rendered above via the `node.nodeType === 'decision'`
            block) so the picker sits directly under its source
            field. For activities the picker still sits under Duration
            since that's the source. Calendar override stays at the
            bottom of the section regardless. */}
          {(node.nodeType === 'activity' || node.nodeType === 'decision') &&
            (node.nodeType === 'decision' ? (
              <DistributionPicker
                dist={node.distribution}
                nominal={node.passProbability ?? 1}
                kind="probability"
                onChange={(d) => updateNodeDistribution(nodeId, d)}
              />
            ) : (
              <DistributionPicker
                dist={node.distribution}
                nominal={node.duration.value}
                kind="duration"
                durationUnit={node.duration.unit}
                onChange={(d) => updateNodeDistribution(nodeId, d)}
              />
            ))}

          {/* Calendar override — Phase 41 Slice 2 moved it up from
            below Resources so all duration-shaping controls live in
            one section. Phase 49 Slice 8 now collapses it behind a
            "+ Add" link by default (only the rare power-user case
            needs to override; collapsing reclaims the visual real
            estate for the more-commonly-tweaked Distribution row
            above). The select stays visible once an override is set,
            and the `calOverrideOpen` flag (reset per-nodeId) tracks
            user-initiated expansion when no override is set yet. */}
          {(node.nodeType === 'activity' || node.nodeType === 'decision') &&
            (node.calendarId !== null || calOverrideOpen ? (
              <div className="flex flex-col gap-1.5">
                <label className={labelCls}>Calendar override</label>
                <select
                  value={node.calendarId === null ? '' : `cal:${node.calendarId}`}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '') {
                      updateNodeCalendarId(nodeId, null);
                    } else if (v.startsWith('tpl:')) {
                      setNodeCalendarFromTemplate(nodeId, v.slice(4));
                    } else if (v.startsWith('cal:')) {
                      updateNodeCalendarId(nodeId, v.slice(4));
                    }
                  }}
                  className={`w-full ${inputCls}`}
                >
                  <option value="">No override</option>
                  {project.calendars.length > 0 && (
                    <optgroup label="Project calendars">
                      {project.calendars.map((c) => (
                        <option key={c.id} value={`cal:${c.id}`}>
                          {c.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {(() => {
                    const unmaterialised = CALENDAR_TEMPLATES.filter(
                      (t) =>
                        !project.calendars.some(
                          (c) =>
                            c.hoursPerDay === t.hoursPerDay &&
                            c.daysPerWeek === t.daysPerWeek &&
                            c.workingDays.every((v, i) => v === t.workingDays[i]),
                        ),
                    );
                    if (unmaterialised.length === 0) return null;
                    return (
                      <optgroup label="Apply schedule template">
                        {unmaterialised.map((t) => (
                          <option key={t.id} value={`tpl:${t.id}`}>
                            {t.label}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })()}
                </select>
                <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                  Forces this activity onto the picked calendar. Resource calendars still fold in
                  via the per-assignment policy. Picking a schedule template adds it to the
                  project's calendars on first use.
                </p>
              </div>
            ) : (
              <AddRowLink
                label="+ Add calendar override"
                onClick={() => setCalOverrideOpen(true)}
              />
            ))}
        </Section>

        <Section id="resources" title="Resources">
          {/* Resource Assignments */}
          <div ref={assignmentsListRef} className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className={labelCls}>Resources</label>
              {availableResources.length > 0 && !addingAssignment && (
                <button
                  onClick={() => {
                    setNewResourceId(availableResources[0]?.id ?? '');
                    setAddingAssignment(true);
                  }}
                  className="text-xs text-blue-600 hover:text-blue-800"
                >
                  + Add
                </button>
              )}
            </div>

            {assignments.length === 0 && !addingAssignment && (
              <p className="text-xs text-gray-400 dark:text-gray-500">
                {project.resources.length === 0
                  ? 'Create resources in the Resources tab.'
                  : 'No assignments yet.'}
              </p>
            )}

            {assignments.map((a) => {
              const res = project.resources.find((r) => r.id === a.resourceId);
              return (
                <div
                  key={a.resourceId}
                  data-assignment-id={a.resourceId}
                  className="rounded border border-gray-200 dark:border-gray-700 p-2 flex flex-col gap-1.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate">
                      {res?.name ?? a.resourceId}
                    </span>
                    <button
                      onClick={() => handleRemoveAssignment(a.resourceId)}
                      className="text-xs text-gray-400 hover:text-red-500 ml-1"
                    >
                      ×
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      value={a.count}
                      min={1}
                      onFocus={beginEdit}
                      onBlur={commitEdit}
                      onChange={(e) =>
                        handleCountChange(a.resourceId, parseInt(e.target.value, 10))
                      }
                      className="w-14 rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-400"
                      title="Count"
                    />
                    <select
                      value={a.calendarPolicy}
                      onChange={(e) =>
                        handlePolicyChange(a.resourceId, e.target.value as CalendarPolicy)
                      }
                      className="flex-1 rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-400"
                    >
                      {(Object.keys(POLICY_LABELS) as CalendarPolicy[]).map((p) => (
                        <option key={p} value={p}>
                          {POLICY_LABELS[p]}
                        </option>
                      ))}
                    </select>
                  </div>
                  {/* Phase 42 — per-assignment share input, rendered only on
                    multi-pool activities (single-pool is always 100% by
                    definition) AND only when shares are set on this node
                    (schema's all-or-none invariant means a.share is defined
                    on every assignment if it's defined on any). The
                    affordance to seed shares lives below the assignment
                    list. */}
                  {assignments.length > 1 && a.share !== undefined && (
                    <ShareInput
                      nodeId={nodeId}
                      resourceId={a.resourceId}
                      share={a.share}
                      shareMode={project.project.shareMode}
                      shareTotal={shareTotal}
                      onChange={(v) => setAssignmentShare(nodeId, a.resourceId, v)}
                    />
                  )}
                  {/* Phase 23 slice 1 — Parallelism segmented control + slider.
                    Disabled at count=1 because the engine formula collapses
                    (parallelism has no effect when there's only one unit). */}
                  {(() => {
                    const mode = parallelismMode(a.parallelism);
                    const disabled = a.count <= 1;
                    const disabledTitle = 'Parallelism only applies when count > 1';
                    return (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 shrink-0"
                            title={disabled ? disabledTitle : undefined}
                          >
                            Parallel
                          </span>
                          <div className="inline-flex rounded border border-gray-200 dark:border-gray-700 overflow-hidden">
                            {(['off', 'variable', 'on'] as const).map((m) => (
                              <button
                                key={m}
                                type="button"
                                disabled={disabled}
                                onClick={() => handleParallelismMode(a.resourceId, m)}
                                title={disabled ? disabledTitle : `Set parallelism to ${m}`}
                                className={[
                                  'px-2 py-0.5 text-[11px] capitalize transition-colors',
                                  'disabled:opacity-40 disabled:cursor-not-allowed',
                                  mode === m && !disabled
                                    ? 'bg-emerald-500 text-white'
                                    : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700',
                                ].join(' ')}
                              >
                                {m}
                              </button>
                            ))}
                          </div>
                        </div>
                        {!disabled && mode === 'variable' && (
                          <div className="flex items-center gap-2">
                            <input
                              type="range"
                              min={0.05}
                              max={0.95}
                              step={0.05}
                              value={a.parallelism ?? 0.5}
                              onFocus={beginEdit}
                              onBlur={commitEdit}
                              onChange={(e) =>
                                handleParallelismSlider(a.resourceId, parseFloat(e.target.value))
                              }
                              className="flex-1 accent-emerald-500"
                            />
                            <span className="w-9 text-right tabular-nums text-[11px] text-gray-600 dark:text-gray-300">
                              {(a.parallelism ?? 0.5).toFixed(2)}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              );
            })}

            {/* Phase 42 — work-split affordances. Renders only on multi-pool
              activities (single pool is always 100% by definition). The
              behaviour depends on whether any assignment already has a
              share (schema's all-or-none invariant — checking any one is
              definitive). */}
            {assignments.length > 1 && (
              <ShareControls
                nodeId={nodeId}
                shareMode={project.project.shareMode}
                sharesPresent={anyShareSet}
                shareTotal={shareTotal}
                onAdd={() => initialiseEqualShares(nodeId)}
                onReset={() => clearAllShares(nodeId)}
                onDistributeEvenly={() => distributeSharesEvenly(nodeId)}
              />
            )}

            {addingAssignment && (
              <div className="rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-2 flex flex-col gap-1.5">
                <select
                  value={newResourceId}
                  onChange={(e) => setNewResourceId(e.target.value)}
                  className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-1 text-xs focus:outline-none"
                >
                  {availableResources.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <input
                    type="number"
                    value={newCount}
                    min={1}
                    onChange={(e) => setNewCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-14 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-2 py-0.5 text-xs focus:outline-none"
                    placeholder="Count"
                  />
                  <select
                    value={newPolicy}
                    onChange={(e) => setNewPolicy(e.target.value as CalendarPolicy)}
                    className="flex-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-1.5 py-0.5 text-xs focus:outline-none"
                  >
                    {(Object.keys(POLICY_LABELS) as CalendarPolicy[]).map((p) => (
                      <option key={p} value={p}>
                        {POLICY_LABELS[p]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleAddAssignment}
                    className="flex-1 rounded bg-emerald-600 text-white text-xs py-1 hover:bg-emerald-700"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => setAddingAssignment(false)}
                    className="flex-1 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-xs py-1 hover:bg-white dark:hover:bg-gray-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </Section>

        <Section id="cost" title="Cost">
          {/* Phase 19 — Cost section.
            Always shown on activity/decision nodes for discoverability. The
            derived row shows '—' when no resource has rates AND this node
            has no fixedCost. The fixed-cost editor inside CostSection is
            itself hide-when-default (Phase 41 Slice 2) — see CostSection. */}
          <CostSection
            node={node}
            project={project}
            isLoopBody={owningLoop !== undefined}
            updateNodeFixedCost={updateNodeFixedCost}
            updateNodeFixedCostOnce={updateNodeFixedCostOnce}
          />
        </Section>

        <Section id="advanced" title="Advanced">
          {/* Phase 25 — Crash options (time-cost trade-off). Only meaningful
            on activity / decision nodes; schema forbids the fields elsewhere.
            The Advanced section is collapsed by default, so the section
            header itself provides hide-when-default behaviour — when no
            crash options exist, the user sees just a "Crash options" empty
            list inside the section instead of taking up panel real-estate
            on every node. */}
          {(node.nodeType === 'activity' || node.nodeType === 'decision') && (
            <CrashSection
              node={node}
              glyph={currencyGlyph(project.currency)}
              currency={project.currency}
              addCrashOption={addCrashOption}
              updateCrashOption={updateCrashOption}
              removeCrashOption={removeCrashOption}
              selectCrashOption={selectCrashOption}
            />
          )}

          {/* Phase 33 — Manual resource-leveling priority. Hide-when-default
            (Phase 41 Slice 2): collapsed into a "+ Set leveling priority"
            link until the user assigns a non-zero priority, then the full
            editor renders. Setting back to 0 returns to the link state. */}
          {(node.levelPriority ?? 0) > 0 ? (
            <div className="flex flex-col gap-1.5">
              <label className={labelCls}>Leveling priority</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={node.levelPriority ?? 0}
                  onFocus={beginEdit}
                  onBlur={commitEdit}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!isFinite(v) || v < 0) return;
                    setNodeLevelPriority(nodeId, v);
                  }}
                  className={`w-20 ${inputCls}`}
                />
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {node.levelPriority} — higher = harder to move
                </span>
                <button
                  type="button"
                  onClick={() => setNodeLevelPriority(nodeId, undefined)}
                  className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 underline ml-auto"
                >
                  Reset
                </button>
              </div>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Used by the auto-leveler as the first tie-break. Higher values are exhausted from
                lower-priority slack first; set this on nodes that shouldn&rsquo;t be shifted by the
                leveler.
              </p>
            </div>
          ) : (
            <AddRowLink
              label="+ Set leveling priority"
              onClick={() => setNodeLevelPriority(nodeId, 1)}
            />
          )}

          {/* Node ID — diagnostic-only; kept at the bottom of Advanced. */}
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>ID</label>
            <p className="text-xs text-gray-400 dark:text-gray-500 font-mono break-all">
              {node.id}
            </p>
          </div>
        </Section>
      </div>
    </aside>
  );
}
