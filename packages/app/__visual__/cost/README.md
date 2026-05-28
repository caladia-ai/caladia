# Phase 19 — Cost UI visual reference

This directory is reserved for reference screenshots of the three cost UI
states. Real visual regression infrastructure (Playwright + snapshot diff
runner) is deferred to a separate slice; for now this README describes what
each state should look like so a contributor can capture and commit reference
PNGs once the infra lands.

## State A — Empty (no cost data anywhere)

A project where no resource has `costRate` / `costPerUse` set and no node has
a `fixedCost` defined. **No** cost surface should render:

- **NodePanel** — "Cost" header shows (discoverability exception); derived
  row reads `— Add cost rates to resources to compute resource-driven cost.`
  The Fixed cost editor and Distribution picker remain accessible.
- **SubsystemPanel** — no Aggregate cost row.
- **Gantt** — Project cost KPI tile hidden; S-curve toggle hidden.
- **Resources** — Total labor cost KPI hidden; per-resource Cost contribution
  line hidden. Cost rate / per use inputs on the create / edit form remain
  (this is the authoring surface).
- **Simulate** — Verdict-bar Budget tile hidden; Date | Cost segmented
  control hidden; only the date histogram + Risk Drivers in date mode.

## State B — Deterministic-only (cost data, no MC run yet)

A project with at least one resource costRate (and/or fixedCost on some node).
The schedule has run (deterministic — `schedule()` runs reactively). Cost
surfaces appear; MC-derived sub-text falls back to "deterministic" or "—":

- **Gantt** — Project cost KPI tile shows `result.projectCost`, currency
  glyph, sub-line `deterministic`. S-curve toggle visible but **disabled**
  (`Run a simulation first to enable the S-curve overlay`).
- **Resources** — Total labor cost KPI shows the sum of `resourceCosts`.
  Per-resource Cost contribution row shows absolute cost + share %.
- **Inspector** (when an Activity / Decision node is selected with a
  `fixedCost`) — derived row + Fixed cost editor + Distribution picker, all
  populated.
- **Simulate** — Verdict-bar Budget tile visible. Probability tile reads
  `—` if MC hasn't run; "set a budget to see probability" sub-text when
  unset. Date | Cost segmented control visible; Cost mode renders the
  CostChartCard but with `No cost samples` empty state because
  `projectCosts` is empty until MC has run.

## State C — Post-simulation full state (cost data + MC run)

Same project as State B, after clicking **▶ Run** on the Simulate tab:

- **Gantt** — Project cost KPI sub-line reads
  `P80 <currency-formatted> (Monte Carlo)`. S-curve toggle enabled; turning
  it on overlays a thin P50 line + faded P10–P95 band in the bottom 35% of
  the chart body.
- **Simulate** — Verdict-bar Budget tile shows
  `X% chance of meeting budget (<budget>)`, tone good/warn/bad (≥80/≥50/<50).
  Date | Cost toggle works in both directions; Cost mode populates
  CostChartCard with histogram bars (amber over the budget line, blue
  below) and P10/P50/P80/P95 markers. Risk Drivers in Cost mode lists the
  top variance-bearing nodes by `p95 − p5` of their cost samples.

## Capture instructions (once infra lands)

When a real visual diff runner is wired up, capture each state at:

- Light mode, 1280×800 viewport
- Dark mode, 1280×800 viewport

with filenames:

- `state-a-empty.{light,dark}.png`
- `state-b-deterministic.{light,dark}.png`
- `state-c-postsim.{light,dark}.png`

The fixtures should use the in-repo default project plus a deterministic
test `.cala` file (the same fixture used by `cost-sim.test.ts`'s 50/50
decision-node bimodal test would work — its visible bimodal histogram is
a good correctness signal on top of the visual diff).
