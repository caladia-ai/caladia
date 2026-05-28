# Caladia Authoring Skill

**Purpose:** Convert a source process artifact (MS Project XML, Excel Gantt, PowerPoint diagram, or plain text) into a valid Caladia project file (`.cala` JSON).

Paste this document into any capable LLM (Claude, GPT-4, Gemini, etc.) together with the source material and the import draft produced by Caladia. The LLM should output only the JSON — no prose, no markdown fences.

---

## What Caladia Is

A business process simulator. A project is a directed graph of **nodes** (activities, gateways, loop groups) connected by **edges** (FS/SS/FF/SF dependencies). The scheduler runs CPM on the graph to produce start/finish dates and a critical path. Monte Carlo simulation samples duration distributions to produce risk percentiles.

Projects are stored as `.cala` files — plain JSON, no binary encoding.

---

## Required Output Format

```json
{
  "kind": "caladia-project",
  "version": 3,
  "currency": "USD",
  "fxSnapshotVersion": "2026.1",
  "project": { ... },
  "calendars": [ ... ],
  "resources": [ ... ],
  "nodes": [ ... ],
  "edges": [ ... ],
  "loops": [],
  "subsystems": [],
  "scenarios": []
}
```

- `kind` **must** be `"caladia-project"` (literal).
- `version` **must** be `3` (integer).
- `currency` **must** be a 3-letter ISO 4217 code (uppercase), e.g. `"USD"`, `"EUR"`, `"GBP"`. Used by the cost engine and verdict-bar Budget tile.
- `fxSnapshotVersion` is a pinned identifier of the FX rate snapshot the file was authored against. Use `"2026.1"` for new files unless you have a specific snapshot to target.
- `budget` (optional, top-level number ≥ 0, in project currency) — enables the "% chance of meeting budget" Verdict-bar probability when present.
- All IDs must be non-empty strings. Use short slugs (`"n1"`, `"n2"`) or UUIDs — just be consistent within the file.
- `loops`, `subsystems`, and `scenarios` default to `[]` when the source has no equivalent.

---

## Schema Reference

### `project` object (required)

| Field               | Type                               | Notes                                     |
| ------------------- | ---------------------------------- | ----------------------------------------- |
| `name`              | string                             | Project display name                      |
| `startDate`         | `"YYYY-MM-DD"`                     | Project start date (ISO 8601, local time) |
| `defaultCalendarId` | string                             | Must match an `id` in `calendars`         |
| `displayUnit`       | `"hours"` \| `"days"` \| `"weeks"` | UI preference; doesn't affect storage     |

### `calendars` array (at least one required)

| Field                  | Type                                                              | Notes                                                                             |
| ---------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `id`                   | string                                                            | Unique within the file                                                            |
| `name`                 | string                                                            | Display name                                                                      |
| `workingDays`          | `[bool×7]`                                                        | Index 0 = Sunday … 6 = Saturday                                                   |
| `hoursPerDay`          | number (positive)                                                 | Working hours per day                                                             |
| `daysPerWeek`          | integer 1–7                                                       |                                                                                   |
| `holidayPreset`        | `"US_FEDERAL"` \| `"CANADA_FEDERAL"` \| `"EU_COMMON"` \| `"NONE"` |                                                                                   |
| `holidayPresetVersion` | string (non-empty)                                                | Use `"1.0"` when `holidayPreset` is `"NONE"`; otherwise pin a real preset version |
| `exceptions`           | `CalendarException[]`                                             | Per-date overrides                                                                |

**Standard 5-day calendar (Mon–Fri, 8 h/day):**

```json
{
  "id": "cal-standard",
  "name": "Standard",
  "workingDays": [false, true, true, true, true, true, false],
  "hoursPerDay": 8,
  "daysPerWeek": 5,
  "holidayPreset": "NONE",
  "holidayPresetVersion": "1.0",
  "exceptions": []
}
```

### `resources` array (optional)

| Field              | Type                         | Notes                                                                                          |
| ------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `id`               | string                       |                                                                                                |
| `name`             | string                       |                                                                                                |
| `capacity`         | positive integer             | Max simultaneous units                                                                         |
| `calendarId`       | string                       | Must match a calendar id                                                                       |
| `costRate`         | number ≥ 0 (optional)        | Per working hour, in project currency unless `currencyOverride` is set                         |
| `costPerUse`       | number ≥ 0 (optional)        | One-time fee per assignment instance                                                           |
| `currencyOverride` | 3-letter ISO 4217 (optional) | When set, `costRate` / `costPerUse` are denominated in this currency, not the project currency |

### `nodes` array

Every node must include all fields, even when they don't apply (use zero-duration / empty arrays for anchors).

| Field                 | Type                                                 | Notes                                                                                                                                      |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                  | string                                               |                                                                                                                                            |
| `nodeType`            | `"activity"` \| `"start"` \| `"end"` \| `"decision"` | Default: `"activity"`                                                                                                                      |
| `name`                | string                                               |                                                                                                                                            |
| `duration`            | `{value: number≥0, unit: DurationUnit}`              | Positive for activity/decision; 0 for start/end                                                                                            |
| `position`            | `{x: number, y: number}`                             | Canvas position in pixels                                                                                                                  |
| `calendarId`          | string \| `null`                                     | `null` = inherit project default                                                                                                           |
| `consumesResources`   | boolean                                              | `false` for wait states (external approval, delivery)                                                                                      |
| `resourceAssignments` | `ResourceAssignment[]`                               | See below                                                                                                                                  |
| `distribution`        | Distribution \| undefined                            | Only for Monte Carlo; omit if not needed                                                                                                   |
| `color`               | `"#rrggbb"` \| undefined                             | Optional border color                                                                                                                      |
| `group`               | string \| undefined                                  | Swimlane group label                                                                                                                       |
| `description`         | string \| undefined                                  | Optional free-text notes (assumptions, references, reasoning behind the estimate). Keep under 2000 chars; not rendered on `start` / `end`. |

**`nodeType` semantics:**

- `"activity"` — positive-duration work step. Most tasks map here.
- `"start"` — zero-duration process entry anchor. MS Project project start / Excel first row without predecessors.
- `"end"` — zero-duration terminus. MS Project project finish / Excel last summary row.
- `"decision"` — review/quality gate with `passProbability` and `failureDelay`. PPTX diamonds map here.

**`ResourceAssignment`:**

```json
{ "resourceId": "r1", "count": 2, "calendarPolicy": "intersection" }
```

`calendarPolicy`: `"intersection"` (default) | `"resourceWins"` | `"activityWins"`

**`Distribution` (optional, for Monte Carlo):**

```json
{ "type": "triangular", "min": 6, "mode": 8, "max": 16 }
{ "type": "pert-beta",  "min": 6, "mode": 8, "max": 16 }
{ "type": "normal",     "mean": 8, "stddev": 2 }
```

All duration values in the same unit as the node's `duration.unit`.

**Decision node extra fields (only when `nodeType: "decision"`):**

```json
"passProbability": 0.8,
"failureDelay": { "value": 16, "unit": "hours" }
```

### `edges` array

| Field  | Type                                  | Notes                                          |
| ------ | ------------------------------------- | ---------------------------------------------- |
| `id`   | string                                |                                                |
| `from` | string                                | Source node id                                 |
| `to`   | string                                | Target node id                                 |
| `type` | `"FS"` \| `"SS"` \| `"FF"` \| `"SF"`  | Dependency type                                |
| `lag`  | `{value: number, unit: DurationUnit}` | Signed lag: positive = gap, negative = overlap |

**Dependency type semantics:**

- `FS` (Finish-to-Start) — successor starts after predecessor finishes. **Most common.**
- `SS` (Start-to-Start) — successor starts after predecessor starts.
- `FF` (Finish-to-Finish) — successor finishes after predecessor finishes.
- `SF` (Start-to-Finish) — unusual; successor finishes after predecessor starts.

---

## Construction Recipes

### MS Project XML → Caladia

| MS Project concept                               | Caladia mapping                                            |
| ------------------------------------------------ | ---------------------------------------------------------- |
| `<Task>` with `<Milestone>false</Milestone>`     | `"nodeType": "activity"`                                   |
| `<Task>` with `<Milestone>true</Milestone>`      | `"nodeType": "start"` or `"end"` depending on position     |
| Project start milestone                          | `"nodeType": "start"`, `duration: {value:0, unit:"hours"}` |
| Project finish milestone                         | `"nodeType": "end"`, `duration: {value:0, unit:"hours"}`   |
| `<Duration>` (ISO 8601, e.g. `PT8H`)             | Parse to hours; `{value: 8, unit: "hours"}`                |
| `<PredecessorLink><PredecessorUID>`              | Edge `from` the predecessor task                           |
| `<PredecessorLink><Type>`                        | `0`→`FS`, `1`→`SS`, `2`→`FF`, `3`→`SF`                     |
| `<PredecessorLink><LinkLag>` (tenths of minutes) | Convert: `lag_hours = lagValue / 600`                      |
| `<Resource>`                                     | `resources` array entry                                    |
| `<Assignment>`                                   | `resourceAssignments` on the node                          |
| `<Task><Start>`                                  | Use as `position` hint; schedule is recalculated           |

**Duration parsing (MS Project `<Duration>`):**

- Format: `PT[n]H[n]M[n]S` (ISO 8601 duration)
- `PT8H` → 8 hours; `P1DT0H` → 8 hours (assuming 8 h/day); `P5D` → 40 hours

### Excel Gantt → Caladia

**Tabular layout** (rows = tasks, columns = properties):

- Look for header row with keywords: `Name/Task`, `Duration`, `Start`, `Predecessors/Deps`, `Resources`
- Each data row → one node
- `Predecessors` column: comma-separated row numbers or task names → edges
- Duration column: parse numeric + unit string → `{value, unit}`

**Visual layout** (rows = tasks, time axis = columns):

- Each row = one node; name in the leftmost non-empty cell of that row
- Filled/colored cells in time columns = task bar (start col → end col)
- Duration = (end column date − start column date) in working days
- No explicit predecessors — infer FS dependencies from adjacent tasks in same row sequence

### PPTX diagram → Caladia

- **Rectangle / rounded-rectangle shapes** → `"nodeType": "activity"`
- **Diamond shapes** → `"nodeType": "decision"` (set `passProbability: 1.0` if unknown)
- **Circle / oval** → `"nodeType": "start"` or `"end"` (infer from position: leftmost = start, rightmost = end)
- **Connector lines / arrows** → edges; direction = arrow direction; assume `FS` unless label says otherwise
- **Text content of shapes** → node `name`; look for duration hints in parentheses, e.g. `"Review (2d)"` → `{value: 2, unit: "days"}`
- **Grouped shapes** → consider wrapping as a sub-system (leave as flat nodes for simplicity)

### Plain text / description → Caladia

- Numbered or bulleted list of tasks → `"activity"` nodes in sequence (FS edges)
- Indented sub-items → parallel activities (all preceded by the parent activity)
- "After X, do Y" → FS edge from X to Y
- "Simultaneously with X, do Y" → SS edge from X to Y, FF edge from Y to X (parallel)
- Duration clues: "2 weeks", "3 days", "40 hours" → parse and store in matching unit

---

## Ambiguity Resolution Defaults

When the source is ambiguous, apply these defaults:

| Situation                             | Default                                                           |
| ------------------------------------- | ----------------------------------------------------------------- |
| Unknown duration                      | `{value: 8, unit: "hours"}` (one day)                             |
| Unknown dependency type               | `"FS"`                                                            |
| Unknown lag                           | `{value: 0, unit: "hours"}`                                       |
| Unknown calendar                      | Use the project default calendar (set `calendarId: null`)         |
| Unknown resource count                | `1`                                                               |
| Unknown `calendarPolicy`              | `"intersection"`                                                  |
| Unknown `passProbability` on decision | `1.0` (always passes)                                             |
| No start node                         | Omit — the scheduler infers start from nodes with no predecessors |
| No end node                           | Omit — the scheduler uses the latest-finishing node               |

---

## Layout (position)

Positions are React Flow canvas pixels and represent the node's **top-left corner**. Node types render at different heights, so to make a horizontal chain look straight, compute `y` so every node's **visual center** lands on the same spine — otherwise mixed-type rows look stair-stepped (decision diamonds will sit 30 px lower than activity rectangles at the same `y`).

### Node-type rendered heights

| `nodeType`  | Rendered height (px) |
| ----------- | -------------------- |
| `start`     | 56                   |
| `end`       | 56                   |
| `activity`  | 60                   |
| `subsystem` | 64                   |
| `decision`  | 120                  |

### Spine `y` values

For a spine centered at `y = 250` (a reasonable default), set `y = spine_center − height / 2`:

| `nodeType`  | `y` on spine 250 |
| ----------- | ---------------- |
| `start`     | 222              |
| `end`       | 222              |
| `activity`  | 220              |
| `subsystem` | 218              |
| `decision`  | 190              |

### Branch symmetry

When several activities branch from a common parent (e.g. parallel paths from a decision or fan-out from start), distribute them **symmetrically** above and below the spine, with **at least 200-px center-to-center spacing** between adjacent rows. With 60-px-tall activity boxes that leaves a 140-px vertical gap between adjacent rows — enough breathing room for diverging/converging edges to fan without looking cramped. Tighter spacing (e.g. 150 px) leaves only 90 px of gap and reads as busy on a wide canvas, especially with three or more branches.

The same minimum applies on the **fan-in side**: when multiple branches converge back into a single merge node, keep each branch at its 200-px row position all the way through the merge — don't squeeze the rows closer together as they approach the merge point. The merge node itself sits at the visual centroid (median) of its incoming branches, or on the spine if it continues a horizontal flow downstream.

- **Two branches**: centers at spine ± 200. With spine 250, the activity `y` values are `20` (upper) and `420` (lower).
- **Four branches**: centers at spine ± 300 and ± 100 (still 200 apart). With spine 350, activity `y` values are `20`, `220`, `420`, `620`.

To compute the activity `y` for a branch whose center should land at `c`, use `y = c − 30`. (For a decision on a branch, use `y = c − 60`.) Negative `y` values are fine — React Flow coordinates are unbounded and `fitView` handles off-origin nodes.

### Horizontal spacing

Use ~180-px increments between sequential spine nodes for purely horizontal flow (where adjacent nodes share the same row). Branches that fan out from the same parent share the same `x`. After a merge point, return to spine increments.

**Fan-out / fan-in horizontal gap** (load-bearing — pairs with the 200-px branch spacing rule above):

At fan-out points (one node → many branches) and fan-in points (many branches → one merge node), the horizontal gap between the fan node and the branch column must scale with the branch column's _vertical_ extent. Tight horizontal gaps with wide vertical fan-out force the edges to go nearly vertical, which reads as cramped and tangled.

| Fan-out / fan-in shape                                       | Min horizontal gap | Why                          |
| ------------------------------------------------------------ | ------------------ | ---------------------------- |
| 2 branches at spine ± 200 (vertical extent 400 px)           | **200 px**         | Outermost edge slope ≤ 1:1   |
| 4 branches at ± 300 / ± 100 (vertical extent 600 px)         | **300 px**         | Outermost edge slope ≤ 1:1   |
| Asymmetric fan-in where one input has a 300-px vertical drop | **300 px**         | Slope ≤ 1:1 on the steep arm |

Rule of thumb: aim for the longest edge's slope at the fan point to be **≤ 1:1** (45°). Compute it as `vertical_jump ÷ horizontal_gap ≤ 1`. Slopes between 1 and 1.5 are tolerable but read busy; above 1.5 the line looks vertically squeezed.

When a loop wraps body nodes, the rendered loop frame extends ~28 px past the leftmost and rightmost body node. Leave at least a 60-px gap between a loop body node and its non-loop neighbour (i.e. use a 220-px increment across the loop boundary instead of the usual 180) so the loop frame doesn't overlap the adjacent node's bounding rect.

### Worked-example positions

5-node chain `start → activity → decision → activity → end` on spine 250:

```
{ "x":  40, "y": 222 }   // start    — visual center 250
{ "x": 220, "y": 220 }   // activity — visual center 250
{ "x": 400, "y": 190 }   // decision — visual center 250
{ "x": 580, "y": 220 }   // activity — visual center 250
{ "x": 760, "y": 222 }   // end      — visual center 250
```

Fan-out from a decision into two parallel activities and a merge, on spine 250. Horizontal gap = 200 px on both the fan-out and fan-in side (matches the 200-px vertical branch extent — slope ≤ 1):

```
{ "x":  400, "y": 190 }   // decision (spine, center 250)
{ "x":  720, "y":  20 }   // upper branch activity (center 50, gap 200 above)
{ "x":  720, "y": 420 }   // lower branch activity (center 450, gap 200 below)
{ "x": 1080, "y": 220 }   // merge activity (back on spine, center 250)
```

Four-branch fan-out and fan-in on spine 350. Vertical extent is 600 px (outer branches at ± 300), so horizontal gaps on both sides are 300 px:

```
{ "x":  200, "y": 320 }   // brief (spine, activity center 350)
{ "x":  660, "y":  20 }   // branch 1 (center  50, gap 300 above)
{ "x":  660, "y": 220 }   // branch 2 (center 250, gap 100 above)
{ "x":  660, "y": 420 }   // branch 3 (center 450, gap 100 below)
{ "x":  660, "y": 620 }   // branch 4 (center 650, gap 300 below)
{ "x": 1120, "y": 320 }   // merge   (all four converge here, on spine)
```

---

## Worked Example — 3-task project

**Input description:** "Design phase (5 days) → Review (1 day, 80% pass, 2-day rework on fail) → Build (10 days). Start January 6, 2025."

**Output:**

```json
{
  "kind": "caladia-project",
  "version": 3,
  "currency": "USD",
  "fxSnapshotVersion": "2026.1",
  "project": {
    "name": "Example Project",
    "startDate": "2025-01-06",
    "defaultCalendarId": "cal-standard",
    "displayUnit": "days"
  },
  "calendars": [
    {
      "id": "cal-standard",
      "name": "Standard",
      "workingDays": [false, true, true, true, true, true, false],
      "hoursPerDay": 8,
      "daysPerWeek": 5,
      "holidayPreset": "NONE",
      "holidayPresetVersion": "1.0",
      "exceptions": []
    }
  ],
  "resources": [],
  "nodes": [
    {
      "id": "n1",
      "nodeType": "activity",
      "name": "Design",
      "duration": { "value": 5, "unit": "days" },
      "position": { "x": 40, "y": 220 },
      "calendarId": null,
      "consumesResources": true,
      "resourceAssignments": []
    },
    {
      "id": "n2",
      "nodeType": "decision",
      "name": "Review",
      "duration": { "value": 1, "unit": "days" },
      "position": { "x": 220, "y": 190 },
      "calendarId": null,
      "consumesResources": true,
      "resourceAssignments": [],
      "passProbability": 0.8,
      "failureDelay": { "value": 2, "unit": "days" }
    },
    {
      "id": "n3",
      "nodeType": "activity",
      "name": "Build",
      "duration": { "value": 10, "unit": "days" },
      "position": { "x": 400, "y": 220 },
      "calendarId": null,
      "consumesResources": true,
      "resourceAssignments": []
    }
  ],
  "edges": [
    { "id": "e1", "from": "n1", "to": "n2", "type": "FS", "lag": { "value": 0, "unit": "hours" } },
    { "id": "e2", "from": "n2", "to": "n3", "type": "FS", "lag": { "value": 0, "unit": "hours" } }
  ],
  "loops": [],
  "subsystems": [],
  "scenarios": []
}
```

Note the position values: `n1` and `n3` (activities, h=60) sit at `y=220`; `n2` (decision, h=120) sits at `y=190`. All three visual centers land on `y=250`, so the spine looks straight.

---

## Validation Contract

Before returning the JSON, verify:

1. `kind === "caladia-project"` and `version === 3`.
2. `currency` is a 3-letter uppercase ISO 4217 code; `fxSnapshotVersion` is a non-empty string.
3. `project.defaultCalendarId` references an `id` in `calendars`.
4. Every edge's `from` and `to` reference a node `id` in `nodes`.
5. Every `resourceAssignment.resourceId` references a `resource.id` in `resources`.
6. Every `calendarId` on nodes/resources is either `null` or references a calendar.
7. `nodeType: "activity"` and `nodeType: "decision"` nodes have `duration.value > 0`.
8. `nodeType: "start"`, `"end"`, and `"subsystem"` nodes have `duration.value === 0`.
9. `passProbability` and `failureDelay` only appear on `nodeType: "decision"` nodes.
10. No duplicate `id` values across nodes, edges, calendars, or resources.
11. The graph has no cycles (except within declared `loops`, which can be empty).
12. Decision nodes have `y` 30 px lower than adjacent activities on the same spine (per the Layout section above) — visual centers should match.

If you detect a violation, fix it rather than returning invalid JSON.

---

## Output Instructions

- Output **only** the JSON object — no prose, no markdown code fences, no explanations.
- Validate against the checklist above before outputting.
- If you cannot resolve a required field (e.g., no duration clue at all), use the ambiguity defaults from the table above and note the assumptions in a `"_comments"` field at the top level (which Caladia will ignore during validation).
