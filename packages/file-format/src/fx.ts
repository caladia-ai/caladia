/**
 * Phase 19 — FX snapshot loading + display-only conversion.
 *
 * Snapshots live as JSON files under `src/fx-snapshots/<version>.json` and
 * are bundled with the package — never fetched at runtime. See
 * ARCHITECTURE.md "FX snapshots: bundled-not-fetched + pinned-at-save."
 *
 * Conversion runs only for display totals (Gantt cost KPI, Verdict-bar
 * Budget tile, Simulate cost histogram axes). Row-level activity costs
 * stay in the project's native currency — see ARCHITECTURE.md
 * "One currency per project, optional final-total display conversion."
 *
 * Convention: `snapshot.base` is the currency rates are expressed against;
 * `snapshot.rates[X]` is the number of X you get for 1 unit of base. This
 * matches the ECB reference-rate format (rates relative to EUR). For our
 * USD base, `rates["EUR"] = 0.854277` means 1 USD = €0.854277.
 */

import snapshot_2026_1 from './fx-snapshots/2026.1.json' with { type: 'json' };
import snapshot_2026_0 from './fx-snapshots/2026.0.json' with { type: 'json' };
import type { ProjectFile, Resource } from './schema.js';

export interface FxSnapshot {
  version: string;
  base: string;
  generatedAt: string;
  windowDescription: string;
  rates: Record<string, number>;
}

/**
 * Versions bundled with this package, ordered newest-first. The order is
 * load-bearing — `LATEST_BUNDLED_SNAPSHOT` reads `[0]` and the FX update
 * banner uses this ordering to decide whether to surface an update.
 */
const BUNDLED_SNAPSHOTS: readonly FxSnapshot[] = [
  snapshot_2026_1 as FxSnapshot,
  snapshot_2026_0 as FxSnapshot,
];

export const LATEST_BUNDLED_SNAPSHOT: FxSnapshot = BUNDLED_SNAPSHOTS[0]!;

/**
 * Load a bundled FX snapshot by version string. Returns `null` for
 * unknown versions (caller decides whether to surface an error or fall
 * back to the latest) and for the special `'NONE'` sentinel (which means
 * "this project explicitly opts out of FX conversion entirely").
 */
export function loadFxSnapshot(version: string): FxSnapshot | null {
  if (version === 'NONE') return null;
  for (const s of BUNDLED_SNAPSHOTS) {
    if (s.version === version) return s;
  }
  return null;
}

/** Iterate every bundled snapshot version, newest-first. */
export function listBundledSnapshotVersions(): readonly string[] {
  return BUNDLED_SNAPSHOTS.map((s) => s.version);
}

/**
 * Convert `amount` from one currency to another using `snapshot`. Returns
 * `null` when:
 *   - `snapshot` is `null` (e.g. project pinned to `'NONE'`),
 *   - either currency is missing from `snapshot.rates`.
 *
 * Same-currency conversions return the input amount unchanged (no precision
 * loss from a round-trip through the base).
 */
export function convertAmount(
  amount: number,
  from: string,
  to: string,
  snapshot: FxSnapshot | null,
): number | null {
  if (snapshot === null) return null;
  if (from === to) return amount;
  const fromRate = snapshot.rates[from];
  const toRate = snapshot.rates[to];
  if (fromRate === undefined || toRate === undefined) return null;
  // Express `amount` in base units, then in target units. The base cancels
  // out for cross-pairs (EUR → CAD via USD) so round-trips like
  // USD → CAD → USD return the input exactly modulo floating-point error.
  const inBase = amount / fromRate;
  return inBase * toRate;
}

/**
 * Return the ISO codes available in `snapshot` for display conversion.
 * Returns an empty array when `snapshot` is `null`. The base currency is
 * included so callers can offer it as an explicit "convert to base" option
 * if they wish.
 */
export function listAvailableTargetCurrencies(snapshot: FxSnapshot | null): readonly string[] {
  if (snapshot === null) return [];
  return Object.keys(snapshot.rates).sort();
}

/**
 * Phase 19 slice 4 follow-up — apply user-edited rate overrides on top of a
 * snapshot. Overrides use the same convention as the snapshot itself
 * (foreign-per-USD-base). Returns a new FxSnapshot with the merged rates;
 * the original snapshot reference is unchanged.
 *
 * Returns `snapshot` unchanged when `overrides` is `null` / `undefined` /
 * empty, or when `snapshot` is `null`.
 */
export function applyFxOverrides(
  snapshot: FxSnapshot | null,
  overrides: Record<string, number> | undefined | null,
): FxSnapshot | null {
  if (snapshot === null) return null;
  if (overrides === null || overrides === undefined) return snapshot;
  const keys = Object.keys(overrides);
  if (keys.length === 0) return snapshot;
  return {
    ...snapshot,
    rates: { ...snapshot.rates, ...overrides },
    // Mark the version so debugging in the field can tell at-a-glance
    // that user overrides are layered on top.
    version: `${snapshot.version}+overrides`,
  };
}

/**
 * Phase 33 Slice 2 — Convert each resource's cost fields from its
 * `currencyOverride` (when set) into the project's currency, using the
 * project's effective FX snapshot. Returns a new `Resource[]` ready to
 * hand to the cost engine (which assumes all `costRate` / `costPerUse`
 * values are in project currency).
 *
 * Resources without an override pass through unchanged. Resources whose
 * override equals the project currency also pass through (no math).
 *
 * When the project's FX snapshot is `'NONE'` (user opted out) OR the
 * override currency is missing from the snapshot, the resource passes
 * through unchanged — the engine computes with the un-converted number
 * as if it were already in project currency. This degrades gracefully:
 * the project total ends up slightly off but nothing crashes, and the
 * display sites (which read the raw `costRate` + `currencyOverride`)
 * still show the user-authored value correctly.
 *
 * Also scales `hourlyRateDistribution`'s numeric parameters by the same
 * FX factor so the Monte Carlo cost samples land in project currency.
 * The Phase 29 sub-stream invariants are preserved — we're transforming
 * the inputs, not changing the sampler.
 *
 * Pure: no I/O, no global state. The FX snapshot is bundled JSON loaded
 * by `loadFxSnapshot`; this helper just routes the math.
 */
export function convertResourceCostsToProjectCurrency(project: ProjectFile): Resource[] {
  const snapshot = applyFxOverrides(
    loadFxSnapshot(project.fxSnapshotVersion),
    project.fxRateOverrides,
  );
  const targetCurrency = project.currency;
  return project.resources.map((r) => {
    const from = r.currencyOverride;
    if (from === undefined || from === targetCurrency) return r;
    // Convert a positive amount; if conversion fails, fall back to the
    // stored value. We also use the converted value of 1 unit (a "FX
    // factor") to scale distribution parameters consistently.
    const factor = convertAmount(1, from, targetCurrency, snapshot);
    if (factor === null) {
      // Snapshot is NONE or the override currency is unknown — degrade
      // gracefully: pass through. Engine will read the raw value as if
      // it were already in project currency.
      return r;
    }
    const next: Resource = { ...r };
    if (next.costRate !== undefined) {
      next.costRate = next.costRate * factor;
    }
    if (next.costPerUse !== undefined) {
      next.costPerUse = next.costPerUse * factor;
    }
    if (next.hourlyRateDistribution !== undefined) {
      const d = next.hourlyRateDistribution;
      if (d.type === 'triangular' || d.type === 'pert-beta') {
        next.hourlyRateDistribution = {
          type: d.type,
          min: d.min * factor,
          mode: d.mode * factor,
          max: d.max * factor,
        };
      } else if (d.type === 'normal') {
        next.hourlyRateDistribution = {
          type: 'normal',
          mean: d.mean * factor,
          stddev: d.stddev * factor,
        };
      }
    }
    // Drop the override from the engine input — the engine doesn't read
    // it, and stripping it makes the engine input semantically pure
    // ("everything's in project currency now").
    delete next.currencyOverride;
    return next;
  });
}
