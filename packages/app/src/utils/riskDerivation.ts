import type { Distribution, Duration, ProjectFile, ProjectNode } from '@procsim/file-format';

/**
 * Phase 46 Slice 2 — derive risks from the project structure.
 *
 * The Risks tab was redesigned to auto-list risks rather than ask the
 * user to flag them manually. This module produces the two derived
 * lists that aren't already covered by the engine's cost-tornado:
 *
 *  - Loop risks: every loop whose `expectedIterations` has variance,
 *    annotated with its worst-case additional time.
 *  - Activity variation risks: activities whose duration distribution
 *    has a "large" spread relative to its central value.
 *
 * Decision-gate risks (every decision with passProbability < 1) are
 * trivial to derive inline in the view; they don't need a helper.
 *
 * Pure module — no React, no DOM. Easy to unit-test.
 */

/** Wall-clock conversion (matches `exportEmbed.hoursOf`). */
function hoursOf(d: Duration): number {
  switch (d.unit) {
    case 'hours':
      return d.value;
    case 'days':
      return d.value * 24;
    case 'weeks':
      return d.value * 24 * 7;
  }
}

/** Inclusive iteration bounds for a distribution. */
function iterationBounds(dist: Distribution): { min: number; max: number } {
  switch (dist.type) {
    case 'triangular':
    case 'pert-beta':
      return { min: dist.min, max: dist.max };
    case 'normal': {
      // ~99.7% interval; clamp lower bound to 1 (a loop runs at least once).
      const min = Math.max(1, dist.mean - 3 * dist.stddev);
      const max = dist.mean + 3 * dist.stddev;
      return { min, max };
    }
  }
}

/**
 * Central reference value for the spread ratio. For triangular /
 * pert-beta this is `mode`; for normal it's `mean`. Used as the
 * denominator in the variation-threshold check.
 */
function centralOf(dist: Distribution): number {
  switch (dist.type) {
    case 'triangular':
    case 'pert-beta':
      return dist.mode;
    case 'normal':
      return dist.mean;
  }
}

/** Half-width of the distribution in hours-equivalent units. */
function spreadOf(dist: Distribution): number {
  switch (dist.type) {
    case 'triangular':
    case 'pert-beta':
      return dist.max - dist.min;
    case 'normal':
      // ~95% interval; matches the central-mean ± 2σ rule of thumb. Using
      // 2σ rather than 3σ keeps the spread comparable to the bounded
      // distributions' (max − min).
      return 2 * dist.stddev;
  }
}

export interface LoopRisk {
  loopId: string;
  /** Display label: loop's `group` if set, otherwise "Loop N" with N = index+1. */
  label: string;
  minIterations: number;
  maxIterations: number;
  /** Sum of body-node durations, in hours (wall-clock). */
  bodyHours: number;
  /**
   * Worst-case additional time the loop could contribute, in hours.
   * Computed as `(maxIterations − minIterations) × bodyHours`. Loops
   * with no iteration variance (`max === min`) are filtered out before
   * this is computed.
   */
  maxExtensionHours: number;
}

/**
 * List loops where the iteration count could vary, annotated with the
 * worst-case additional time the loop could add. Loops with deterministic
 * iteration counts (`expectedIterations.max === min`) are skipped —
 * they introduce no schedule uncertainty by themselves.
 *
 * Loops without any body nodes (shouldn't happen per schema's `.min(1)`,
 * but defensive) are also skipped.
 */
export function deriveLoopRisks(project: ProjectFile): LoopRisk[] {
  const nodeById = new Map(project.nodes.map((n) => [n.id, n] as const));
  const risks: LoopRisk[] = [];
  project.loops.forEach((loop, idx) => {
    const { min, max } = iterationBounds(loop.expectedIterations);
    if (max <= min) return; // deterministic iteration count → not a risk
    const bodyHours = loop.bodyNodeIds.reduce<number>((sum, nid) => {
      const node = nodeById.get(nid);
      return sum + (node ? hoursOf(node.duration) : 0);
    }, 0);
    if (bodyHours === 0) return; // no time contribution → not a risk
    const label = loop.group ?? `Loop ${idx + 1}`;
    risks.push({
      loopId: loop.id,
      label,
      minIterations: min,
      maxIterations: max,
      bodyHours,
      maxExtensionHours: (max - min) * bodyHours,
    });
  });
  // Largest worst-case first — most important risk on top.
  risks.sort((a, b) => b.maxExtensionHours - a.maxExtensionHours);
  return risks;
}

export interface ActivityVariationRisk {
  nodeId: string;
  name: string;
  /** Central value (mode for triangular/pert-beta; mean for normal), in hours. */
  centralHours: number;
  /** Half-width of the distribution: (max − min) for bounded, 2σ for normal — in hours. */
  spreadHours: number;
  /**
   * `spread / central`. Risks with `spreadRatio > threshold` are surfaced;
   * exposing the ratio lets the view rank or label by intensity.
   */
  spreadRatio: number;
  /** Worst-case duration (max for bounded, mean + 2σ for normal), in hours. */
  worstCaseHours: number;
}

/**
 * List activities whose duration distribution has a large spread
 * relative to its central value. Threshold defaults to 0.75 (the value
 * picked at Phase 46 open) — meaning "the worst case is ≥1.75× the
 * expected." Adjustable per call so a future preference can flow in.
 *
 * Activities without a distribution are skipped. Distributions with a
 * non-positive central value are skipped (division-by-zero guard);
 * shouldn't happen in practice but defensive against authored data.
 *
 * The unit conversion uses wall-clock hours (24h/day, 168h/week) so the
 * spread comparison is unit-independent. Returned hours are wall-clock.
 */
export function deriveActivityVariationRisks(
  project: ProjectFile,
  threshold = 0.75,
): ActivityVariationRisk[] {
  const risks: ActivityVariationRisk[] = [];
  for (const node of project.nodes) {
    if (node.nodeType !== 'activity' && node.nodeType !== 'decision') continue;
    const dist = node.distribution;
    if (!dist) continue;
    const unit = node.duration.unit;
    const central = toHours(centralOf(dist), unit);
    const spread = toHours(spreadOf(dist), unit);
    if (central <= 0) continue;
    const spreadRatio = spread / central;
    if (spreadRatio <= threshold) continue;
    const worstCase = toHours(worstCaseOf(dist), unit);
    risks.push({
      nodeId: node.id,
      name: node.name,
      centralHours: central,
      spreadHours: spread,
      spreadRatio,
      worstCaseHours: worstCase,
    });
  }
  // Largest spread ratio first.
  risks.sort((a, b) => b.spreadRatio - a.spreadRatio);
  return risks;
}

/** Worst-case duration value (in distribution's authoring unit). */
function worstCaseOf(dist: Distribution): number {
  switch (dist.type) {
    case 'triangular':
    case 'pert-beta':
      return dist.max;
    case 'normal':
      return dist.mean + 2 * dist.stddev;
  }
}

/**
 * Distribution values are authored in the same unit as the parent
 * node's `duration.unit` (see DistributionSchema docstring) — convert
 * to wall-clock hours so all risk-list math is unit-independent.
 */
function toHours(value: number, unit: Duration['unit']): number {
  switch (unit) {
    case 'hours':
      return value;
    case 'days':
      return value * 24;
    case 'weeks':
      return value * 24 * 7;
  }
}

/**
 * Format an hours value for the Risks tab. Picks the most readable
 * unit (hours / days / weeks) by magnitude and rounds to one decimal.
 * Exported so the view can render LoopRisk / ActivityVariationRisk
 * hours fields uniformly.
 */
export function formatHours(hours: number): string {
  if (hours < 24) return `${Math.round(hours * 10) / 10}h`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days * 10) / 10}d`;
  const weeks = hours / (24 * 7);
  return `${Math.round(weeks * 10) / 10}w`;
}

/** Probability-of-failure derivation for a decision node. */
export function probabilityOfFailure(node: ProjectNode): number {
  if (node.nodeType !== 'decision') return 0;
  return 1 - (node.passProbability ?? 1);
}

/**
 * Cost-of-delay estimate for a decision node, in the project's currency.
 *
 * If the gate fails, its `failureDelay` is added to the schedule and the
 * resources assigned to the decision continue billing for that delay.
 * We surface a rough estimate: `failureDelay_workingHours × Σ (resource.costRate × count × share)`
 * across the decision's assignments.
 *
 * Returns `null` when:
 *  - no failure delay is set (no time impact ⇒ no cost),
 *  - the decision has no resource assignments,
 *  - or none of the assigned resources have a `costRate` (we'd otherwise
 *    return 0 which would render as `$0.00` and look like a real answer).
 *
 * Working-hours conversion uses the project's default calendar's
 * `hoursPerDay` (typical 8 h on the standard Mon–Fri, but the PE/Banking
 * calendar uses 14 h, etc.). Weeks use `hoursPerDay × daysPerWeek` from
 * the same calendar.
 *
 * Limitations (intentional, documented):
 *  - Resources blocked DOWNSTREAM by the delay aren't counted — only the
 *    decision's own assignments. A true cost-of-delay would propagate
 *    through the critical-path, which is engine work and overkill for
 *    the Risks-tab rough estimate.
 *  - The `share` field defaults to 100 (full allocation) when absent,
 *    matching how `cost.ts` treats it.
 *  - `costPerUse` is not counted — it's a per-instance fee, paid whether
 *    or not the gate fails.
 *  - Currency overrides on individual resources are ignored — the sum
 *    is reported in the project's currency. The Risks tab is a rough
 *    estimate, not an audited cost calculation.
 */
export function deriveDecisionCostOfDelay(project: ProjectFile, node: ProjectNode): number | null {
  if (node.nodeType !== 'decision') return null;
  if (!node.failureDelay || node.failureDelay.value <= 0) return null;
  if (node.resourceAssignments.length === 0) return null;

  const cal = project.calendars.find((c) => c.id === project.project.defaultCalendarId);
  const hoursPerDay = cal?.hoursPerDay ?? 8;
  const daysPerWeek = cal?.daysPerWeek ?? 5;
  const delayHours = workingHoursOf(node.failureDelay, hoursPerDay, daysPerWeek);

  const resourceById = new Map(project.resources.map((r) => [r.id, r]));
  let anyRated = false;
  let total = 0;
  for (const a of node.resourceAssignments) {
    const res = resourceById.get(a.resourceId);
    if (!res) continue;
    const rate = res.costRate;
    if (rate === undefined || rate <= 0) continue;
    anyRated = true;
    const shareFrac = (a.share ?? 100) / 100;
    total += delayHours * rate * a.count * shareFrac;
  }
  return anyRated ? total : null;
}

/**
 * Working-hours conversion that respects the calendar. Hours stay hours;
 * days become `hoursPerDay`; weeks become `hoursPerDay × daysPerWeek`.
 * Used by the cost-of-delay calc so a 30-day delay on a PE/Banking
 * (M–Sat, 14h) calendar is correctly 30 × 14 = 420 working hours, not
 * 30 × 24 = 720 wall-clock hours.
 */
function workingHoursOf(d: Duration, hoursPerDay: number, daysPerWeek: number): number {
  switch (d.unit) {
    case 'hours':
      return d.value;
    case 'days':
      return d.value * hoursPerDay;
    case 'weeks':
      return d.value * hoursPerDay * daysPerWeek;
  }
}
