/**
 * Phase 19 — shared cost helpers used by every UI cost surface.
 *
 * `projectHasCostData(project)` is the single empty-state predicate consumed
 * by NodePanel (Cost section), SubsystemPanel (Aggregate cost), Gantt
 * (Project cost KPI + S-curve toggle), Resources (Total labor cost KPI +
 * per-resource contribution), and Simulate (Budget tile + Date|Cost toggle).
 * Keeping the predicate in one place keeps the show/hide policy uniform —
 * see ARCHITECTURE.md "Cost UI empty-state strategy."
 *
 * `formatMoney(amount, currencyCode)` is a thin display helper around the
 * existing `currencyGlyph()` map. It does NOT do FX conversion (Slice 4 ships
 * that); it just renders the project's native currency with locale-grouped
 * digits and 2-decimal precision for fractions / no decimals for integers.
 */

import type { FxSnapshot, ProjectFile } from '@procsim/file-format';
import type { SimulationResult } from '@procsim/simulation';
import {
  applyFxOverrides,
  convertAmount,
  currencyGlyph,
  loadFxSnapshot,
} from '@procsim/file-format';

/**
 * Returns true when at least one resource has a non-zero cost rate / per-use
 * OR at least one node has a `fixedCost` defined. The Inspector Cost section
 * is intentionally exempt from this gate — it stays visible so users can
 * discover the feature.
 */
export function projectHasCostData(project: ProjectFile): boolean {
  for (const r of project.resources) {
    if ((r.costRate ?? 0) > 0) return true;
    if ((r.costPerUse ?? 0) > 0) return true;
  }
  for (const n of project.nodes) {
    if (n.fixedCost !== undefined) return true;
  }
  return false;
}

/**
 * Format an amount in the project's native currency.
 *
 * - Integer amounts render without decimals: `$1,250`.
 * - Fractional amounts render with 2 decimals: `$1,250.75`.
 * - Negative amounts (shouldn't occur in normal flow — engine clamps cost
 *   to ≥ 0) render with a `−` prefix.
 *
 * No FX conversion. Slice 4 will introduce a separate `formatMoneyConverted`.
 */
/**
 * Resolve the effective FX snapshot for a project — loads the pinned bundled
 * snapshot and layers any user-edited overrides on top. Returns `null` when
 * the project pins to `'NONE'` or the version isn't bundled.
 *
 * Single seam consumed by every cost surface so a project edit (currency
 * change, rate override) propagates through every display in one render.
 */
export function getEffectiveFxSnapshot(project: ProjectFile): FxSnapshot | null {
  const base = loadFxSnapshot(project.fxSnapshotVersion);
  return applyFxOverrides(base, project.fxRateOverrides);
}

/**
 * Scale every cost-bearing numeric field on a cached `SimulationResult` by
 * `factor`. Used when the user changes `project.currency` mid-session — the
 * MC result is cached in viewStore and would otherwise hold values in the
 * old currency until the user re-runs the simulation.
 *
 * Date / hour / criticality fields are intentionally untouched — only
 * currency-denominated fields are scaled:
 *   - `projectCosts[]`
 *   - `costPercentiles` (p50 / p80 / p95)
 *   - `nodeCostStats[*]` (mean / p95)
 *   - `costTornado[*].impactCost`
 *   - `costCurve.pXX[]` (P10 / P50 / P80 / P95 cumulative-cost rows;
 *     `costCurve.times[]` is hours-from-start, NOT scaled).
 *
 * Pure — returns a new `SimulationResult` object; the input is unchanged.
 */
export function scaleSimulationCosts(result: SimulationResult, factor: number): SimulationResult {
  if (!isFinite(factor) || factor === 1 || factor <= 0) return result;
  const scaledNodeCostStats: Record<string, { mean: number; p95: number }> = {};
  for (const [id, s] of Object.entries(result.nodeCostStats)) {
    scaledNodeCostStats[id] = { mean: s.mean * factor, p95: s.p95 * factor };
  }
  return {
    ...result,
    projectCosts: result.projectCosts.map((c) => c * factor),
    costPercentiles: {
      p50: result.costPercentiles.p50 * factor,
      p80: result.costPercentiles.p80 * factor,
      p95: result.costPercentiles.p95 * factor,
    },
    nodeCostStats: scaledNodeCostStats,
    costTornado: result.costTornado.map((t) => ({
      nodeId: t.nodeId,
      impactCost: t.impactCost * factor,
    })),
    costCurve: {
      times: result.costCurve.times, // hours — unchanged
      p10: result.costCurve.p10.map((v) => v * factor),
      p50: result.costCurve.p50.map((v) => v * factor),
      p80: result.costCurve.p80.map((v) => v * factor),
      p95: result.costCurve.p95.map((v) => v * factor),
    },
  };
}

export function formatMoney(amount: number, currencyCode: string): string {
  const glyph = currencyGlyph(currencyCode);
  const abs = Math.abs(amount);
  const rounded = Math.round(abs * 100) / 100;
  const body = Number.isInteger(rounded)
    ? rounded.toLocaleString()
    : rounded.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = amount < 0 ? '−' : '';
  return `${sign}${glyph}${body}`;
}

/**
 * Phase 19 slice 4 — render an amount in the project's native currency,
 * optionally followed by an approximate conversion into the user's chosen
 * display target. Format: `"$12,450 USD / ≈€11,460 EUR"`.
 *
 * Returns the plain native render when:
 *   - `displayTarget` is `'AUTO'` (the default),
 *   - `displayTarget` equals `nativeCurrency` (nothing to convert),
 *   - `snapshot` is `null` (project pinned to `'NONE'`),
 *   - `convertAmount` returns `null` (currency missing from the snapshot).
 *
 * Conversion is display-only — engine outputs and inputs stay in
 * `nativeCurrency`. See ARCHITECTURE.md "One currency per project,
 * optional final-total display conversion."
 */
/**
 * ISO 4217 currencies with **no minor unit** (zero decimal places). Inputs
 * denominated in these currencies need a 100× larger step floor —
 * incrementing JPY by 1 makes sense; incrementing JPY by 0.01 does not.
 *
 * Curated rather than pulled from the FX snapshot to keep the schema
 * unchanged. The set is short and stable — no new no-minor currencies are
 * being created.
 */
const NO_MINOR_UNIT_CURRENCIES = new Set([
  'JPY',
  'KRW',
  'VND',
  'HUF',
  'IDR',
  'CLP',
  'ISK',
  'XOF',
  'XAF',
  'BIF',
  'DJF',
  'GNF',
  'KMF',
  'PYG',
  'RWF',
  'UGX',
  'UYI',
  'XPF',
]);

/**
 * Pick a sensible `step` for a currency-bearing number input.
 *
 * **Self-correcting** — derives the step from the input's CURRENT value
 * by taking one order of magnitude below it. As the value grows past a
 * 10× threshold, the step grows with it. Examples (USD, `kind: 'rate'`):
 *
 *     value   |  step
 *     ──────────────
 *     0       |  1
 *     50      |  1
 *     100     |  10
 *     500     |  10
 *     1,000   |  100
 *     10,000  |  1,000
 *
 * `kind`:
 *   - `'rate'`   — per-hour rates, per-use fees, fixedCost, crash adds.
 *                  Floor = 1 (USD/EUR/GBP/…) or 100 (JPY-class).
 *   - `'budget'` — project budgets. Floor = 100 (USD/EUR/GBP/…) or 10,000
 *                  (JPY-class). The caller passes a signal — the budget
 *                  value itself if non-zero, otherwise the project's
 *                  current total cost so even an empty-budget input gets
 *                  useful increments.
 *
 * Pure / deterministic — same inputs always return the same step.
 */
export function currencyStep(currencyCode: string, value: number, kind: 'rate' | 'budget'): number {
  const noMinor = NO_MINOR_UNIT_CURRENCIES.has(currencyCode.toUpperCase());
  const baseFloor = noMinor ? 100 : 1;
  const floor = kind === 'budget' ? baseFloor * 100 : baseFloor;

  if (!isFinite(value) || value < 10) return floor;

  // One order of magnitude below the value, clamped to the floor.
  const oom = Math.floor(Math.log10(value));
  const step = Math.pow(10, oom - 1);
  return Math.max(floor, step);
}

export function formatMoneyDual(
  amount: number,
  nativeCurrency: string,
  displayTarget: string,
  snapshot: FxSnapshot | null,
): string {
  const native = formatMoney(amount, nativeCurrency);
  if (displayTarget === 'AUTO') return native;
  if (displayTarget === nativeCurrency) return native;
  if (snapshot === null) return native;
  const converted = convertAmount(amount, nativeCurrency, displayTarget, snapshot);
  if (converted === null) return native;
  return `${native} ${nativeCurrency} / ≈${formatMoney(converted, displayTarget)} ${displayTarget}`;
}
