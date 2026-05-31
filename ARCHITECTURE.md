# ARCHITECTURE

Current state of the built system. Describes the design of Caladia's engines and app — the contracts each package exposes, the patterns the codebase relies on, and the load-bearing decisions behind them. Pair with [`README.md`](README.md) for user-facing orientation.

## Contents

- [Package dependency graph](#package-dependency-graph) — how the eight packages relate
- [Package responsibilities and public API](#package-responsibilities-and-public-api) — one section per package, with exported API and notable decisions
- [Data flow](#data-flow) — how a user edit becomes a Gantt update
- [Load-bearing patterns](#load-bearing-patterns) — design decisions that look refactorable but aren't (~30 subsections)
- [Decision log](#decision-log) — notable choices and the reasoning behind them
- [Open questions](#open-questions) — load-bearing items still underspecified

---

## Package dependency graph

```
file-format
    │
    ▼
calendar
    │
    ▼
scheduler  ─────▶  simulation
    │                  │
    │         engine-worker ◀─────┐
    │                  │          │ (Worker, not import)
    └──────▶  app  ◀───┘          │
                 │   ▲            │
                 │   └─ importers │
                 └────────────────┘
```

Arrows indicate "imports from". No cycles. `app` is the only package that imports React or React Flow. `engine-worker` runs `scheduler` and `simulation` inside a persistent Web Worker; `app` communicates with it via `createEngineWorkerClient`. `importers` is a standalone pure package (no internal deps) that provides external-file parsers consumed only by `app`.

---

## Package responsibilities and public API

### `packages/file-format`

Zod schema, inferred TypeScript types, version migrations, holiday presets. Root of the dependency graph — imports nothing internal.

**Public API:**

- `ProjectFileV1` through `ProjectFileV6` — historical Zod schemas, exposed for round-trip / migration tests. `ProjectFile` (the consumer-facing type) is `z.infer<ProjectFileV7>` — every load result is migrated to V7 before it leaves the package.
- `loadProjectFile(contents: string): LoadResult` — parses + validates; runs the V1→V2→…→V7 migration chain as needed; returns typed project or structured Zod errors
- `saveProjectFile(project: ProjectFile): string` — serialises to JSON
- `migrateIfNeeded(parsed: unknown): ProjectFile` — migration entry-point running the full V1→V7 chain (`migrateV1ToV2` … `migrateV6ToV7` exported individually for tests)
- `loadSubsystemFile(contents: string): LoadSubsystemResult` / `saveSubsystemFile` — `.calasub` counterparts; subsystem schema runs v1→v4 via `migrateSubsystemV1ToV2` … `migrateSubsystemV3ToV4`
- `CommentSchema`, `CommentSchema`-derived `Comment` type — free-floating canvas comments (V6+)
- `CrashOptionSchema`, `FixedCostSchema`, `DurationSemanticSchema`, `ShareModeSchema` — sub-schemas exposed for app-level component composition
- `getPreset(id: HolidayPresetId, version?: string): HolidayPreset` — returns algorithmically-computed holiday list for 2020–2035
- `latestPresetVersion(id: HolidayPresetId): string`
- `CURRENCY_GLYPHS`, `currencyGlyph()`, `LATEST_FX_SNAPSHOT_VERSION`, `convertAmount`, `loadFxSnapshot`, `listAvailableTargetCurrencies`, `listBundledSnapshotVersions`, `applyFxOverrides`, `LATEST_BUNDLED_SNAPSHOT` — currency display + FX bundled-snapshot helpers

**Notable type decisions:**

- `DurationSchema` (node durations): `.nonnegative()` — must be ≥ 0. Zero is reserved for `start`/`end` anchor nodes; a refine on `NodeSchema` rejects zero for `nodeType: 'activity'` and `nodeType: 'decision'`.
- `LagDurationSchema` (edge lags): `.finite()` — allows zero and negative (overlap semantics).
- `ProjectNode` / `ProjectEdge` used as exported names (not bare `Node` / `Edge`) to avoid conflicts with `@xyflow/react` and DOM globals.
- `NodeType = 'start' | 'activity' | 'end' | 'decision'`. Stored on `ProjectNode.nodeType` with `.default('activity')` so legacy `.procsim` / `.cala` files load cleanly (a missing field reads back as `'activity'`).
- `ProjectNode.anchorDate?: 'YYYY-MM-DD'` — optional, only meaningful for `nodeType: 'start'`. Pins the chain rooted at the Start node to that calendar date instead of `project.startDate`. Validated by a regex; absent on legacy files.
- `ProjectNode.passProbability?: number ∈ [0, 1]` and `ProjectNode.failureDelay?: Duration` — only meaningful for `nodeType: 'decision'`. A second cross-field refine on `NodeSchema` rejects either field on non-decision node types so we don't silently accept ambiguous data on activity/start/end. Defaults are `passProbability = 1` (always passes — no penalty) and `failureDelay = 0h` (no surcharge).

Holiday presets (US_FEDERAL, CANADA_FEDERAL, EU_COMMON, NONE) are computed algorithmically for years 2020–2035 and stored under a version key (e.g. `"2024.1"`). Loading a file whose pinned version differs from the current latest surfaces a `presetUpdatesAvailable` banner — files never auto-upgrade.

### `packages/calendar`

Working-time math. Pure, synchronous, framework-free.

**Public API:**

- `addWorkingHours(start: Date, hours: number, cal: Calendar): Date` — advance (or retreat for negative) through working periods; zero returns `start` unchanged
- `workingHoursBetween(start: Date, end: Date, cal: Calendar): number` — signed count of working hours in [start, end)
- `isWorkingMoment(t: Date, cal: Calendar): boolean` — true when t falls within a working period (08:00–08:00+hoursPerDay on a working day)
- `snapToNextWorkStart(d: Date, cal: Calendar): Date` — normalises a raw constraint date to the first working moment at or after d
- `effectiveActivityCalendar(activityCal: Calendar | null, projectCal: Calendar): Calendar`
- `resolveAssignmentCalendar(activityCal, resourceCal, policy): AssignmentCalendarResult`

**Notable implementation decisions:**

- Working day is modelled as 08:00–(08:00+hoursPerDay) **local time**. No configurable start time in v1. See "Engine local-time anchoring" under Load-bearing patterns for the full design rationale + test-harness implications.
- `isDayWorking` checks date-specific `'working'` exceptions before the weekly pattern, so a Saturday with a `'working'` exception is correctly treated as a working day.
- `resolveAssignmentCalendar` with `'intersection'` policy builds a synthetic `Calendar` (holidayPreset=NONE, union of both holiday sets as exceptions) so the result is a first-class `Calendar` usable by all calendar functions.

### `packages/scheduler`

CPM engine covering all four dependency types (FS/SS/FF/SF) with signed lag, calendar-aware. Supports loop constructs via two-pass scheduling.

**Public API:**

- `schedule(input: ScheduleInput): ScheduleOutcome`

`ScheduleInput` draws directly from `ProjectFile` field types. `sampledLoopIterations?: Record<string, number>` — when present it overrides the deterministic iteration count derived from each loop's kickout condition. Passed by the simulation engine after sampling `loop.expectedIterations` each Monte Carlo iteration.

**Engine structure** (`src/cpm.ts`):

1. **Validation** — checks defaultCalendarId, node calendarIds, resource refs, edge endpoints; validates loop bodyNodeIds (unknown IDs, nodes in multiple loops); runs cycle detection on the _condensed_ graph so body-internal edges don't trip the detector; returns `{ ok: false }` with a hint message when an undeclared cycle is found.
2. **Loop condensation** (`src/loop.ts`) — when loops are present, `buildCondensedGraph()` replaces each loop's body nodes with a super-node whose duration = `iterations × bodyCriticalPath`; external edges are redirected; intra-body edges are dropped. CPM runs on the condensed DAG.
3. **Forward pass** — topological order; per-node constraint from each inbound edge using the four dependency formulas; lag converted via successor's calendar.
4. **Backward pass** — reverse topological order; symmetric constraint formulas for LF_pred.
5. **Critical path** — nodes with `slackHours ≤ 0.0001` are marked `onCriticalPath`; taut edges traced via DFS.
6. **Body schedule distribution** — `distributeLoopSchedule()` converts each super-node's CPM schedule into per-body-node `NodeSchedule`s reflecting first-iteration timing. Slack = superNode.slack + (cpHours − node.efHours). v1 approximation documented in-code.
7. **Resource timeline** — non-loop nodes: `iteration = 0`. Loop bodies: `buildLoopResourceEntries()` unrolls N sequential copies; `consumesResources: false` nodes produce no entries (prevents phantom utilization).

### `packages/simulation`

Seeded Monte Carlo with hierarchical per-node RNG.

**Public API:**

- `simulate(input: SimulationInput): SimulationResult` — runs N Monte Carlo iterations over the project graph, returns `endDates[]`, `percentiles` (p50/p80/p95), `criticalityIndex`, and `tornado`.
- `nodeRng(rootSeed: number, nodeId: string): RandomGenerator` — derives a deterministic per-node xoroshiro128+ sub-stream via FNV-1a hash of `(rootSeed, nodeId)`. Adding or removing nodes never perturbs existing node streams.
- `RandomGenerator` — re-exported from `pure-rand` for consumers that want to drive sampling directly.

**Notable implementation decisions:**

- `pure-rand@6` (not v8): v8 removed the root `"."` export; `import * as prand from 'pure-rand'` requires v6.
- **Pre-initialised per-node streams.** `simulate()` calls `nodeRng` once per node before the iteration loop. Each iteration advances only that node's own stream — no cross-node interference regardless of iteration count or node ordering.
- **Per-loop streams** — each loop gets its own RNG sub-stream seeded via `nodeRng(seed, '__loop__' + loopId)`. Per iteration, `loop.expectedIterations` is sampled and rounded to the nearest integer (≥1), then passed to `schedule()` as `sampledLoopIterations`. This gives loop iteration counts their own independent variance axis, orthogonal to node duration variance.
- **Distribution samplers** are pure (`[value, nextRng]` return, no mutation): triangular uses exact inverse-CDF; PERT-beta and normal use Box-Muller. PERT-beta is approximated as a normal with μ=(min+4·mode+max)/6, σ=(max-min)/6, clamped to [min, max] — matches Crystal Ball / @Risk convention.
- **Percentile lookup** uses `sorted[Math.floor(n * p)]` (floor, not nearest-rank) for simplicity.
- **Criticality index** = `criticalCount[nodeId] / successfulIterations`. The scheduler's `onCriticalPath` flag is used directly.
- **Tornado ranking** = `(distribution range) × criticalityIndex`; range is `max-min` for triangular/PERT-beta and `4·stddev` (±2σ) for normal. Nodes without a distribution have range=0 and are excluded.
- **Tolerance tests use `workingHoursBetween`**, not raw `.getTime()` subtraction. Two Date objects can be far apart in wall-clock milliseconds yet only seconds apart in working time if an overnight gap falls between them.

### `packages/engine-worker`

Thin Web Worker wrapper around `scheduler` and `simulation`. Runs engines off the main thread so long Monte Carlo runs don't freeze the UI.

**Public API:**

- `createEngineWorkerClient(workerOrUrl: Worker | string | URL): EngineWorkerClient` — instantiates (or adopts) a Web Worker running `dist/worker.js` and returns a client with:
  - `scheduleAsync(input, signal?): Promise<ScheduleOutcome>`
  - `simulateAsync(input, signal?, onProgress?): Promise<SimulationResult>`
  - `dispose(): void` — terminates the worker and rejects all pending calls
- Protocol (`src/protocol.ts`) — `WorkerRequest` / `WorkerResponse` discriminated unions; structured-clone-safe (no class instances in I/O).
- Worker script (`src/worker.ts`) — compiled separately with `lib: ["ES2022", "WebWorker"]` via `tsconfig.worker.json` to avoid DOM/WebWorker lib conflicts.

**Dual-tsconfig pattern:**

- `tsconfig.json` (`lib: ["ES2022", "DOM"]`) — compiles `src/index.ts` and `src/protocol.ts` to `dist/`.
- `tsconfig.worker.json` (`lib: ["ES2022", "WebWorker"]`) — compiles `src/worker.ts` and `src/protocol.ts` to `dist/worker.js`.
- `pnpm typecheck` runs both: `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.worker.json --noEmit`.

**Progress throttling:** The worker itself contains `Date.now()` for throttling `onProgress` callbacks (~100ms wall time). This keeps time-of-day calls out of `packages/simulation` (which is pure/deterministic), matching the hard rule that side-effectful time is banned from core engines.

### `packages/importers`

Pure, browser-safe parsers for converting external project files into an `ImportDraft` + `AmbiguityList` for the LLM authoring-skill step. No React, no DOM, no `@procsim/*` dependencies — can run in Node.js or a browser Worker.

**Public API:**

- `parseMsProjectXml(xml: string): ImportResult` — parses MS Project XML exports (tasks, resources, predecessor links, ISO 8601 durations, link-lag in tenths-of-minute). Summary tasks are skipped; milestones → `start`/`end` node type (heuristic reclassifies the last no-successor milestone as `end`).
- `parseExcelGantt(buffer: ArrayBuffer): ImportResult` — two-mode Excel parser: **tabular** layout (header keywords `Name/Duration/Predecessor/Resource/Milestone`) + **visual/bar-chart** fallback (date axis columns, filled cells = bar extent). Duration strings: `"5d"`, `"4h"`, `"2w"`, plain numbers (treated as days).
- `parsePptxDiagram(buffer: ArrayBuffer): Promise<ImportResult>` — async OOXML ZIP reader (JSZip). Shape-geometry → node type: `rect/roundRect` → activity; `diamond` → decision; `ellipse` → start/end (x-position heuristic: leftmost → start, rightmost → end). Duration hints in parentheses: `"Design (2d)"`. Connectors → edges via `stCxn`/`endCxn` OOXML attributes.

**`ImportResult` discriminated union:**

```ts
{ ok: true;  draft: ImportDraft; ambiguities: AmbiguityItem[] }
| { ok: false; errors: string[] }
```

**`ImportDraft`** carries `nodes`, `edges`, `resources`, and optional `projectName`/`startDate`. Nodes/edges use loose intermediate types (not the full Zod-validated `ProjectNode`) — the LLM authoring skill bridges from draft to a valid project file.

**`AmbiguityItem`** fields: `code: string` (e.g. `MISSING_DURATION`, `UNRESOLVED_CONNECTOR`, `NO_PREDECESSOR_DATA`), `message: string`, `affectedIds: string[]`.

**Notable design decisions:**

- `exactOptionalPropertyTypes` compliance — optional fields in `ImportedNode` (e.g. `notes?: string`) are always set via conditional spread (`...(val !== undefined ? { notes: val } : {})`) to satisfy TypeScript's strict optional-property assignment rule.
- OOXML connector detection relies on `p:cxnSp` element presence (structural, not attribute-based).

### `packages/app`

Vite + React + TypeScript web application. Canvas (React Flow), Gantt view, property panels, file I/O, IndexedDB autosave.

**Notable sub-modules — Import and validation:**

- **AI-guided import** (`ImportModal.tsx`) — `Import…` button in the Toolbar opens a file picker accepting `.xml` (MS Project), `.xlsx`/`.xls`/`.csv` (Excel Gantt), and `.pptx` (PowerPoint diagram). Routes to the corresponding `@procsim/importers` parser; on success shows an `ImportModal` with node/edge/resource counts, a scrollable ambiguity list, and a **Copy AI Prompt** button. The copied prompt contains the full `ImportDraft` JSON + ambiguity list and instructs an AI assistant to produce a valid Caladia project file. Parse errors surface in an error variant of the same modal.
- **Validate .cala** (`ValidateModal.tsx`, same file) — `Validate…` button picks a `.cala`/`.procsim` file, runs `loadProjectFile` without replacing the current project, and shows a `ValidateModal` with either a green "✓ Valid" message or a structured Zod-error list.
- **`pickAndReadBinaryFile`** (`fileio.ts`) — reads a picked file as `ArrayBuffer` (for binary parsers) and returns `{ buffer, fileName, ext }`. Complements the existing `pickAndReadFile` (text) and `pickAndReadSubsystemFile`.
- **Authoring-skill spec** (`docs/caladia-authoring-skill.md`) — self-contained LLM prompting reference for the import → Caladia bridge: domain model, required output schema, construction recipes for each source format, a worked 3-task example, and a 10-point validation checklist.
- **JSON schemas** (`caladia-project.schema.json`, `caladia-subsystem.schema.json`) — machine-readable JSON Schema files generated from the Zod schemas via `zod-to-json-schema`. The `file-format` package's `package.json` has a `generate-schema` script (`tsx scripts/generate-schema.ts`) to regenerate them. A `kind: 'caladia-project'` discriminator field on `ProjectFileV2+` (defaulted via `.default('caladia-project')`) enables unambiguous document-type dispatch without reading version fields first.

**Notable sub-modules — Sub-systems and engine worker:**

- **Sub-system blocks** (`SubsystemSchema` in `file-format`, `flattenSubsystems` in `scheduler`) — a user can wrap ≥2 selected nodes into a _sub-system container_ node. The wrap records a `Subsystem` row containing the container node ID, body node IDs, entry, and exit. The scheduler's `flattenSubsystems` pre-pass runs post-order DFS on the nesting tree, replaces container nodes with their entry/exit, and rewires external edges before CPM sees the graph. The flattened input is scheduling-equivalent to the original graph inlined. Sub-systems nest arbitrarily.
- **`SubsystemNode`** (`src/nodes/SubsystemNode.tsx`) — indigo rounded rectangle with a repeating diagonal chevron-stripe header. Shows name, internal node count indicator, left/right handles. "Drill in →" button (`stopPropagation` on pointer events) triggers `drillIntoSubsystem` in `viewStore` without also selecting the node.
- **Breadcrumb navigation** (`viewStore.breadcrumb: ReadonlyArray<BreadcrumbEntry>`) — drilling into a sub-system pushes `{ subsystemId, label }` onto the breadcrumb stack. `visibleNodeIds` in `App.tsx` derives the current canvas visibility: root level hides all body nodes; drilled-in shows only the current sub-system's body nodes. A breadcrumb bar renders above the canvas (absolute-positioned, indigo). `App.tsx` contains a `useEffect` that auto-pops the breadcrumb when the drilled-into sub-system is deleted (e.g. via undo).
- **`.calasub` file format** (`SubsystemFileV1`) — `kind: 'caladia-subsystem', version: 1`. Carries `nodes/edges/loops/calendars/resources/subsystems` for self-contained portability. `buildSubsystemFile` collects the body nodes and includes all project calendars/resources plus nested sub-systems. `importSubsystemFromFile` re-IDs all entities with a `imp-{timestamp}-N` prefix to avoid collision, then registers the body in the project with optional `Subsystem.source` provenance (`fileName`, `contentHash`, `importedAt`). `sha256Hex` (Web Crypto `subtle.digest`) signs the file content at import time.
- **`SubsystemPanel`** (`src/components/SubsystemPanel.tsx`) — property panel for selected container nodes. Sections: name edit, entry/exit/body-count display (read-only), Drill-in, Export .calasub, Import .calasub, Unwrap, source provenance badge showing `fileName` + `importedAt` date + first 16 hex chars of hash.
- **Gantt subsystem rows** (`GanttView.tsx`) — a new `subsystemHeader` row kind groups body nodes (and loops fully inside the sub-system) under a collapsible indigo header bar. Toggle state lives in `viewStore.collapsedSubsystemIds`. Container nodes are excluded from `nonBodyNodes` (they have no schedule result after flattening). Loops whose entire `bodyNodeIds` is a subset of a sub-system's `bodyNodeIds` are pulled under that sub-system; remaining loops are top-level as before.
- **Diagram-health indicator** (`DiagramHealthIndicator` in `Toolbar.tsx`) — a small `● N nodes` pill colored green/amber/red by node count. Thresholds (`HEALTH_AMBER=1000`, `HEALTH_RED=2000`) are derived from `tools/benchmark` measurements and document-linked to `diagram-health-thresholds.json`. Clicking opens a small popover with a recommendation message.
- **Engine worker integration** (`src/engineWorker.ts`) — a module-level singleton created lazily on first `getEngineWorker()` call. Instantiates `new Worker(new URL('@procsim/engine-worker/worker', import.meta.url), { type: 'module' })` — Vite bundles `dist/worker.js` as a separate chunk at build time. `SimulateView` now uses `simulateAsync` with an `AbortController` for cancellation and an `onProgress` callback that drives a progress bar. `useSchedule` remains synchronous (CPM runs in <15ms for real projects) but now passes `subsystems` to the scheduler so sub-system flattening applies.

**Notable sub-modules — Dark mode, group coloring, simulation history, dependency arrows:**

- **Dark mode** — `viewStore.darkMode: boolean` + `toggleDarkMode()`. `App.tsx` toggles the `dark` CSS class on `<html>` (Tailwind JIT class-based dark mode). SVG elements in `GanttView` cannot use Tailwind `dark:` variants because SVG `fill`/`stroke` are attribute-level, not CSS — instead the component derives conditional hex color strings from `darkMode` (e.g. `const nonWorkingBodyFill = darkMode ? '#1e293b' : '#f9fafb'`). A 🌙/☀️ toggle button lives in the Toolbar.
- **Swimlane group coloring on canvas** — `ActivityNode` renders a 4 px top accent stripe and a small group badge, both tinted by the group's palette entry. The feature is gated by `viewStore.showGroupColors` toggled via a "🏷 Groups" Toolbar button (canvas tab only).
- **Group color system** (`src/utils/groupColors.ts`) — colors are assigned by alphabetical sort position of the group name among all groups in the project (nodes + loops). `autoGroupColor(groupName, allGroupNames)` maps `indexOf(name) % 10` to a 10-entry hard-coded palette. `computeAllGroupNames(nodes, loops)` returns the sorted list. User-defined overrides live in `viewStore.groupColors: Record<string, string>`; `setGroupColor(name, hex)` records an override. Color pickers appear next to the group field in `NodePanel` and `LoopPanel`.
- **`groupListKey` selector pattern** (`src/nodes/ActivityNode.tsx`) — the Zustand selector for `allGroupNames` returns `[...names].sort().join('\u0000')` (a null-delimited string primitive) instead of a new array, so it only invalidates the memo when the set of groups actually changes — no new array reference on every render.
- **`GroupAutocomplete`** (`src/components/GroupAutocomplete.tsx`) — replaces the native `<datalist>` for group fields in both `NodePanel` and `LoopPanel`. Uses `createPortal(…, document.body)` with `position: fixed` coordinates from `getBoundingClientRect()` so the dropdown escapes any `overflow: hidden` or `overflow-y: auto` ancestor (the side panels). Closes on any `scroll` event via a `window` capture listener while open. `onMouseDown={(e) => e.preventDefault()}` on each option prevents the input's `blur` firing before the click registers.
- **Simulation history** — `viewStore.simHistory: readonly SimRun[]` (max 5, newest-first). `SimRun` carries `{ id, timestamp, iterations, seed, result, projectSnapshot }`. `projectSnapshot = JSON.stringify(project)` — when it diverges from the current project the Simulate tab shows an amber "out of date" banner. A run history tab bar appears when `simHistory.length > 1`, letting users switch between past results. `addSimRun` prepends + slices to 5; `clearSimHistory` resets.
- **Gantt dependency arrows** — FS/SS/FF/SF edges rendered as SVG paths beneath the bars. Forward edges (x₁ ≤ x₂) use a cubic Bezier S-curve; backward edges use an orthogonal U-route that runs below the bars. A `<marker>` element in `<defs>` draws the arrowhead (`<polyline>` with `strokeLinejoin="round"`). Intra-loop arrows are suppressed — both endpoints inside the same loop share a `nodeToLoopId` map entry and are skipped. For loop-body source nodes, the rightmost bar end (highest `iteration` entry in `timelineByNode`) is used as the arrow origin so cross-loop FS arrows connect from the final iteration.

**Notable sub-modules — Loop UI:**

- `src/nodes/LoopGroupNode.tsx` — custom React Flow parent node rendering a violet dashed border and a "↻ Loop / N iterations" label. Clicking the header selects the loop group and opens `LoopPanel`.
- `src/components/LoopPanel.tsx` — side panel for loop selection. Sections: body nodes list, group (via `GroupAutocomplete`), kickout condition editor (type selector + inline value field), expected iterations distribution editor. Delete button removes the loop grouping (nodes are kept as orphans).
- `src/store/domainStore.ts` — added `addLoop`, `deleteLoop`, `updateLoopKickout`, `updateLoopExpectedIterations`, `updateLoopGroup`.
- `src/store/viewStore.ts` — added `selectedLoopId`, `selectLoop`, `collapsedGroupIds: ReadonlySet<string>`, `toggleGroupCollapse`.
- `src/components/Toolbar.tsx` — "↻ Loop" button wraps selected nodes into a new loop. Enabled only when ≥1 node is selected and none are already in a loop body.
- `src/components/GanttView.tsx` — loop iterations unrolled into sequential bars per body node; body rows indented under a collapsible loop group header. Loop group header rows show the total loop span and an expand/collapse chevron. Clicking a bar for a loop-body node switches to the Canvas tab and selects the node; clicking a loop header opens `LoopPanel`.

**Notable sub-modules — Simulate tab and distributions:**

- `src/components/SimulateView.tsx` — Simulate tab. Top bar: iterations + seed controls + Run button + no-distributions warning. Body (grid): histogram SVG (20 bins, blue→green→amber→red by percentile region, P50/P80/P95 labels above their respective bins), criticality index horizontal bar chart (sorted desc, red≥80%, amber≥50%, blue otherwise), tornado chart (sorted by impact = range × CI, top bar red, second amber, rest blue). Simulation runs synchronously on click (`simulate()` from `@procsim/simulation`).
- `src/components/NodePanel.tsx` — Added **Distribution** section (between Duration and Resources). `DistributionPicker` component: type selector (Fixed / Triangular / PERT-Beta / Normal), auto-populates defaults from nominal hours on type change (min=50%, mode=100%, max=150% for triangular/pert-beta; mean=nominal, σ=20% for normal), inline number fields with focus/blur edit-session brackets.
- `src/store/domainStore.ts` — Added `updateNodeDistribution(nodeId, dist | undefined)`.
- `src/store/viewStore.ts` — `activeTab` extended to `'canvas' | 'gantt' | 'resources' | 'simulate'`. Carries loop-UI state (`selectedLoopId`, `collapsedGroupIds`, `selectLoop`, `toggleGroupCollapse`) and view preferences (`darkMode`, `showGroupColors`, `groupColors`, `setGroupColor`, `simHistory`, `addSimRun`, `clearSimHistory`, `toggleDarkMode`, `toggleGroupColors`).

**Notable sub-modules — Resources tab:**

- `src/components/ResourcesPanel.tsx` — Resources tab: left column is resource pool CRUD (name, capacity, calendar picker); right column is SVG utilization histogram (one per resource; blue=under capacity, amber=at, red=over). Histogram computed from `ScheduleResult.resourceTimeline` — daily overlap sums per resource.
- `src/components/NodePanel.tsx` — "Resources" section: lists current `resourceAssignments` with inline count and `calendarPolicy` pickers; "Add" form picks from unassigned project resources.
- `src/store/domainStore.ts` — Added `addResource`, `updateResource`, `deleteResource`, `setNodeResourceAssignments`. Default project now ships with a "Weekend (Sat–Sun)" calendar (`cal-weekend`) so the calendar conflict scenario can be demonstrated without manual calendar setup.

**Notable sub-modules — Schedule and Gantt:**

- `src/hooks/useSchedule.ts` — `useSchedule(): ScheduleOutcome`. Wraps `schedule()` in a `useMemo` keyed on the `project` object reference; re-runs on any domain-store change. Used by `App` to drive both the schedule error banner and the Gantt.
- `src/components/GanttView.tsx` — Custom SVG Gantt. Frozen 188 px label column (`position: sticky; left: 0`) beside a horizontally-scrollable SVG timeline. Rows sorted by `earliestStart`. Bars: blue for non-critical, red for critical path, lighter-blue tail for slack. Non-working days from the default calendar are shaded gray (calls `isWorkingMoment` at 08:00 for each day in range). Clicking a bar selects the node and switches to the Canvas tab.
- `src/store/viewStore.ts` — Added `activeTab: 'canvas' | 'gantt'` and `setActiveTab()`.
- `src/components/Toolbar.tsx` — Canvas | Gantt segmented tab control.

**Notable sub-modules — Domain store, autosave, canvas:**

- `src/store/domainStore.ts` — Zustand store holding the full `ProjectFile`, wrapped with `zundo`'s `temporal` middleware. Actions: `addNode`, `deleteNodes`, `pasteNodes`, `updateNodeName`, `updateNodeDuration`, `updateNodePosition`, `connectNodes`, `deleteEdges`, `updateEdgeType`, `updateEdgeLag`, `setProject`. Exports `useTemporalStore(selector)` for reading undo/redo state (`pastStates`, `futureStates`, `undo`, `redo`, `clear`). Also exports `beginEdit` / `commitEdit` / `abortEdit` — property panels bracket text/number input edit sessions so a whole focus→blur becomes one history entry (see Load-bearing patterns → Edit sessions).
- `src/store/viewStore.ts` — separate Zustand store for transient state (not in undo history): `selection` (`nodeIds` + `edgeId`) and `dragDraft` (in-progress positions keyed by node id).
- `src/lib/autosave.ts` — IndexedDB autosave via `idb-keyval` under key `procsim:autosave:v1`. Debounced 1000ms subscription to `useDomainStore`. `loadAutosaved()` restores before first render; `startAutosave()` begins the subscription.
- `src/hooks/useKeyboard.ts` — global shortcuts: ⌘/Ctrl+Z undo, ⌘/Ctrl+Shift+Z (and ⌘/Ctrl+Y) redo, Delete/Backspace on selection, ⌘/Ctrl+C/V for node copy/paste (clipboard in `localStorage` under `procsim:clipboard:v1`; paste offsets by `{x:40, y:40}` and fires `pasteNodes` in a single atomic store write).
- `src/nodes/ActivityNode.tsx` — custom React Flow node; shows name + duration, connection handles top/bottom.
- `src/components/NodePanel.tsx` — side panel for the single-selected node.
- `src/components/EdgePanel.tsx` — side panel for the selected edge (dependency type FS/SS/FF/SF, signed lag with unit, delete).
- `src/components/Toolbar.tsx` — "Add Node", Undo, Redo, Save, Open. Undo/redo buttons reflect `pastStates.length` / `futureStates.length` from `useTemporalStore`; Open clears history after load so users can't undo across an imported file.
- `src/fileio.ts` — `downloadProjectFile` (Blob URL download) and `pickAndReadFile` (FileReader promise).
- `src/main.tsx` — async bootstrap: `loadAutosaved()` → `setState({ project })` → `temporal.clear()` → `startAutosave()` → render.

**React Flow integration notes:**

- `ActivityNodeType` extends `Record<string, unknown>` (required by `@xyflow/react`'s `Node<T>` generic constraint) while also declaring typed `name`, `durationValue`, `durationUnit` fields.
- `rfNodes` is derived via `useMemo` from `(domain.nodes, view.dragDraft, selection)`. While a drag is in flight the node's position comes from `dragDraft`; once the drag ends the domain store commits the final position in a single undo step and the draft is cleared.
- `onNodesChange` filters React Flow's events: `position` + `dragging:true` writes to `viewStore.dragDraft`; `position` + `dragging:false` commits `updateNodePosition`; `remove` → `deleteNodes`; `select` events are ignored in favour of `onNodeClick`/`onPaneClick`/`onEdgeClick` so the view store is the single source of truth for selection.
- `deleteKeyCode={null}` disables React Flow's built-in Delete handling; `useKeyboardShortcuts` owns it instead so deletion routes through the domain store with one undo step.

**Notable sub-modules — Canvas UX polish:**

- **Free-floating comments** (`project.comments`, `nodes/CommentNode.tsx`, `components/CommentToolBinder.tsx`) — text annotations independent of nodes. The Zod schema at the project level carries a `comments: CommentSchema[]` array (cap `SCHEMA_LIMITS.comments = 10_000`). Comments are rendered as React Flow nodes via a small adapter: each domain `Comment` is wrapped in a synthetic RF node with id `__comment__${commentId}` so React Flow's existing drag / select / hit-test machinery applies without comments leaking into `project.nodes`. The `__comment__` prefix is the discriminator everywhere: `App.tsx`'s `onSelectionChange` filters it out of `selectedNodeIds`, and the keyboard-delete path has a dedicated comments-only fallback (`viewStore.selectedCommentIds`) so an off-screen empty comment can still be deleted by selecting + Delete. `CommentNode` auto-enters edit mode ONLY when `data.initialEditing === true`, set by `CommentToolBinder` immediately after a placement-driven `addComment` (gated by `viewStore.pendingInitialEditingCommentId`). Reloaded comments from disk don't carry the flag, so a stale empty comment doesn't steal keystrokes on mount.

- **Multi-node alignment + distribute** (`utils/alignment.ts`, `components/SelectionToolbar.tsx`) — six pure functions, one per alignment axis (Left / Centre / Right / Top / Middle / Bottom) plus distribute-horizontal / distribute-vertical. Each takes a `ReadonlyArray<AlignableNode>` (`{ id, position, width, height }`) and returns a `Record<id, { x, y }>` payload ready for the existing `updateNodePositions` batch action, so the alignment lands as one undo step. **Caller resolves real width/height** — the helpers never fall back to fixed defaults (a previous version did, and got Start/End/Activity sizes wrong). The `SelectionToolbar` walks `.react-flow__node[data-id="..."]` to read `offsetWidth/Height` for each selected node. **No-op detection:** entries whose target position equals the current position are omitted from the result; an already-aligned selection produces an empty record and the toolbar skips the domain commit entirely (no phantom undo step).

- **NumericInput draft-string pattern** (`components/NodePanel.tsx`, file-local function) — native `<input type="number">` bound directly to a `number` state field has three pathologies: typing "1.5" passes through invalid intermediate "1." states; Backspace-to-clear silently rejects (the field re-fills mid-keystroke); σ couldn't be set to 0 at all due to a `v <= 0` guard. `NumericInput` holds a local **draft string** while the input is focused. The user's keystrokes own the draft; the parent's `value` prop only syncs into the draft when **not focused** (the `focusedRef` guard). Every keystroke that parses to a valid in-range number calls `onCommit(n)`, so live updates keep working. On blur, if the draft never parsed cleanly the field reverts to the last committed value. `beginEdit` / `commitEdit` on focus / blur preserves the undo-grouping semantics — every burst of typing inside a single focused session is one history entry.

- **Distribution centre-value sync** (`NumericInput`'s `useEffect` guard) — the duration field and the triangular/pert-beta `mode` field (or normal `mean`) are linked: changing the duration updates the distribution's centre to track. The link is implemented by writing the new value into the distribution field's `value` prop. The "sync only when not focused" rule above is what makes the link useful: if the user is _currently editing_ the mode, the duration → mode link doesn't yank their cursor; if they're not, the sync happens silently. The same pattern protects every numeric field from external-write disruption.

- **Snap-to-grid + wire-on-place** (`App.tsx` `snapToGrid` + `snapGrid={[16,16]}` props on `<ReactFlow>`, `components/PlacementOverlay.tsx`) — RF handles drag-end snapping when `snapToGrid` is true; `rf.screenToFlowPosition()` also snaps, so placement-mode drops snap for free. The 16 px pitch matches the canvas's `<Background gap={16} />` so snap targets line up visually. Wire-on-place: when placing an activity or decision, moving the ghost over an existing node's right-side source handle arms a ghost edge (LIFO stack in `viewStore.pendingPlacementSources`). Click commits the node plus all collected edges in one undo step via `placeNodeWithIncomingEdges`. Esc pops one ghost edge at a time; only falls through to placement-cancel when the stack is empty.

---

## Data flow

```
user edit in canvas or property panel
    │
    ▼
domain Zustand store (Zundo-wrapped)
    │
    ▼
schedule(input) re-runs on change
    │
    ▼
ScheduleResult
    │
    ├──▶ Canvas: node positions, critical-path highlight
    └──▶ Gantt: bars, timeline, non-working-day shading
```

---

## Load-bearing patterns

These are design decisions that look refactorable but aren't. Read the rationale before changing anything here.

### Split domain / view Zustand stores

Zundo wraps the domain store (`project` field only — nodes, edges, resources, calendars, loops, scenarios, project settings). Pan/zoom, selection, hover, and drag-in-progress positions live in a separate `viewStore` and **never enter temporal history**.

Piping React Flow's `onNodesChange` straight into a single store produces 200+ undo steps per drag. The defense is layered in `packages/app`:

1. **Partialize** — `temporal(..., { partialize: s => ({ project: s.project }) })`. Any new unclassified store field is excluded by default.
2. **Event filtering in `App.tsx::onNodesChange`** — only `position` with `dragging:false` (drag-end) and `remove` reach the domain store. Intermediate `position` events with `dragging:true` write to `viewStore.dragDraft`. `select` and `dimensions` events are dropped; selection flows through `onNodeClick`/`onPaneClick`/`onEdgeClick` into the view store instead.
3. **Drag-draft merge** — `rfNodes` is derived from `project.nodes` overlaid with `viewStore.dragDraft[id]`. The domain store only sees the final position, so one undo step per drag regardless of pixels moved.
4. **Equality check** — `equality: (a, b) => a.project === b.project`. Re-setting the same `project` reference (e.g. autosave rehydration) never pushes a history entry.

Text and number inputs use a separate edit-session pattern (next section).

### Edit sessions for property-panel inputs

Text/number inputs in `NodePanel` and `EdgePanel` bracket their edit with `beginEdit()` on `onFocus` and `commitEdit()` on `onBlur` (exported from `domainStore.ts`). While a session is active:

1. `beginEdit()` snapshots the current `project` and calls `useDomainStore.temporal.getState().pause()`. Keystrokes on `updateNodeName` / `updateNodeDuration` / `updateEdgeLag` mutate state freely but do **not** push history entries.
2. `commitEdit()` resumes recording and, if the project actually changed during the session, pushes exactly one entry onto `pastStates` with the snapshotted pre-edit state via `useDomainStore.temporal.setState({ pastStates: [...existing, { project: beforeEdit }], futureStates: [] })`.

This gives one undo step per focus→blur, regardless of keystroke count or mid-edit corrections.

**Structural actions flush in-flight edits.** `addNode`, `deleteNodes`, `pasteNodes`, `connectNodes`, `deleteEdges`, `updateEdgeType`, and `updateNodePosition` all call `commitEdit()` as their first statement. If the user clicks a toolbar button while an input still holds focus and browser-specific event ordering delays `blur` past `click`, the flush still runs before the structural mutation so both actions land as separate entries. `setProject` calls `abortEdit()` instead (state is being wholly replaced).

### `setSelectedNodeIds` preserves `selectedLoopId` when the sync is empty

React Flow's `onSelectionChange` is the syncing path from the React Flow node selection into our view store. When the user clicks a loop group, React Flow internally selects the loop-group node and fires `onSelectionChange` with it. `App.tsx::onSelectionChange` strips loop-groups from the synced id array because their identity lives in `selectedLoopId` (a separate field), not in `selection.nodeIds`. The result is an empty id array.

The naive setter — always clear `selectedLoopId` when `setSelectedNodeIds` runs — race-clobbers loop selection. In React Flow 12.10+, `onSelectionChange` fires AFTER `onNodeClick`, so the sequence is:

1. `onNodeClick(loopgroup)` → `selectLoop(loopId)` → `selectedLoopId = loopId`
2. `onSelectionChange([loopgroup])` → strip → `setSelectedNodeIds([])` → if it cleared `selectedLoopId`, the loop selection would be wiped one tick after it was set.

`setSelectedNodeIds` therefore only clears `selectedLoopId` when the synced id array is non-empty:

```ts
setSelectedNodeIds(ids) {
  set((s) => ({
    selection: { ...s.selection, nodeIds: ids },
    ...(ids.length > 0 ? { selectedLoopId: null } : {}),
  }));
}
```

This invariant must be preserved, or selection routing in `App.tsx` must be restructured to keep the two stores in sync some other way.

### Lag calendar: successor's calendar

When the forward pass computes a constraint from an edge, the lag value is converted to hours using the **successor node's calendar** (`toHours(edge.lag, succCal)`). The same applies in the backward pass. This is the simplest consistent choice: the lag constrains when the successor can start/finish, so it lives in the successor's time domain. Cross-calendar arithmetic (e.g., predecessor finishes on a Mon–Fri calendar, lag is "2 days" on a Sat–Sun calendar) is not currently defined and would require an explicit project-level lag calendar policy. Log this under Open questions if it becomes relevant.

### Two-pass loop scheduling

Naive super-node condensation gives correct timing but produces phantom resource utilization when the loop body contains wait-state activities (awaiting approval, material delivery).

Fix: two representations from the same source. Run CPM on the **condensed graph** to get loop start/end; run the resource pass on the **unrolled graph** where each iteration is expanded and activities with `consumesResources: false` are excluded from the histogram. Don't try to unify them — the representations serve different purposes. `ResourceTimelineEntry.iteration` records which copy each entry belongs to.

### Per-node hierarchical RNG sub-seeds

A single linear RNG stream means inserting a node mid-graph shifts every subsequent node's samples, creating spurious variance in scenario diffs — exactly the opposite of what seed-locked comparison is for.

Each node draws from a sub-stream seeded via `nodeRng(root_seed, node_id)`. Scenario comparison locks the root seed across compared scenarios, so observed differences trace to user changes, not RNG drift. Adding or removing a node never perturbs other nodes' samples.

### Engine local-time anchoring

The calendar / scheduler / simulation engines are local-time-anchored by design. `packages/calendar/src/index.ts:16`:

```ts
// Working day runs 08:00–(08:00+hoursPerDay) local time.
```

`WORK_START_HOUR = 8` is wall-clock. Every `new Date(y, m, d, h, m, s)` in the engines is a local-time constructor; every `d.getHours()` / `getDate()` / `getDay()` is a local-time accessor; `scheduler/src/cpm.ts`'s `new Date(input.project.startDate + 'T00:00:00')` parses without `Z` so it lands on local midnight. This is internally coherent and matches the user's wall-clock intuition: a project authored in EDT renders 8am–5pm EDT, in EST renders 8am–5pm EST.

**The cost is at the test-harness boundary.** `simulate()` returns `Date` objects whose `toISOString()` output is host-TZ-dependent. The frozen-output snapshots in `packages/app/src/integration/sim-output-snapshot.test.ts` would shift 4 h between a Mac in EDT and a UTC CI runner. Resolution: both `.github/workflows/ci.yml` and the root `package.json` `test` script pin `TZ=America/New_York` (the project's canonical authoring TZ). Numeric outputs (costs, durations, RNG samples) are byte-identical regardless of TZ — only serialized dates need the pin.

If multi-TZ collaboration ever becomes a real requirement, the answer is an explicit `project.timezone: IANA-zone-id` field, not global UTC.

**Running tests outside the canonical TZ** — direct `vitest run` or `pnpm --filter <pkg> test` bypasses the root wrapper. Prefix with `TZ=America/New_York` or use `pnpm test` from the repo root.

### Streaming convergence detection

`simulate()` reports a `convergence: { converged, atIteration }` field. It's computed during the iteration loop, not after — sampling P50/P80/P95 every `CONVERGENCE_CHECK_INTERVAL` iterations against a running sorted view of project-end times. When all three percentiles stay within `CONVERGENCE_STABILITY_EPSILON_HOURS` for `CONVERGENCE_STABILITY_SAMPLES` consecutive checks, `atIteration` is pinned to the iteration where stability was first achieved. The run continues for its full budget regardless — convergence is a diagnostic, not an early-exit. Truncating would damage per-node criticality and tornado, which need the full sample distribution.

The sorted view (`sortedEndMs`) is maintained via binary insert (O(N) per insert due to splice's memmove). For 10k iterations that's ~5×10⁷ ops in total — dominated by the CPM cost per iteration, so the overhead is invisible.

The three constants are tuned defaults: ε=6h matches the smallest delta a PM would notice; N=4 stable samples at the 50-iteration interval = 200 stable iterations. The contract is that `converged === true` should mean "running more iterations is unlikely to change the answer in a way that matters to a human reader."

### Per-iteration critical-path tracking

`simulate()` also reports `pathFrequency: Array<{ path, count }>` — every distinct critical path the run observed, with how many iterations it appeared in. Built by stringifying each iteration's `criticalPaths[]` (after stripping anchor nodes) and incrementing a `Map<string, { path, count }>`.

Anchor stripping is the same rationale as the criticality/tornado filter: `start` and `end` anchors sit on every path that reaches them and dominate the dedupe key without adding signal. Removing them means `[S, A, B, E]` and `[A, B]` collapse to one entry.

Output is sorted by `count` descending, ties broken lexicographically — so the order is deterministic for a given seed. Both anchor stripping and deterministic tie-break are load-bearing: anchor stripping keeps the UI's "Build → Test → Deploy" label stable across projects that toggle Start/End anchors; the tie-break keeps two runs with the same seed byte-identical in `pathFrequency`.

### Auto-leveling via priority-based serial RCS over edge-lag

`suggestLeveling(input, baseResult)` produces a plan that resolves resource over-capacity days by shifting lower-priority activities later, expressed as additive lag bumps on existing edges.

The algorithm is priority-based serial RCS, deliberately simple to stay reasonable on small projects:

1. Re-run `schedule()` with the current accumulated `edgeId → extraLagHours` map (starts empty).
2. Find every (resource, day) where demand > capacity. Sort ascending by day, then by resourceId.
3. Skip pairs we previously `abandoned` because no levelable candidate remained.
4. For the first remaining pair, identify the competing activities. Filter out loop / sub-system body nodes up front — they live inside constructs that opaque edge lag can't move, and trying to shift them just causes the leveler to spin. Surface them under `plan.skipped` so the UI is honest.
5. Sort survivors by priority — `slackHours` descending, `earliestStart` ascending, `id` lex ascending — and pick the lowest-priority activity.
6. Find its constraining incoming edge (the predecessor whose `earliestFinish + lag` matches the target's `earliestStart` within 1 second). Bump that edge's lag by `max(MIN_SHIFT_HOURS=8, wall-clock hours to the latest competitor's finish)`. The wall-clock fallback lets a single iteration clear the chosen activity past the conflict instead of oscillating in 1-day increments.
7. Re-schedule and go to step 1, with a `MAX_ITERATIONS=500` safety cap.

The output is a `LevelingPlan`:

- `changes` — one row per shifted node (for UI display). Multiple bumps to the same node collapse to the one that received the most added lag, so the preview doesn't double-count.
- `edgeLagBumps: Record<edgeId, hours>` — the raw additive payload. Applying the plan means updating each edge's lag by its bump. The app applies via `domainStore.applyEdgeLagBumps` as a single undo step.

Determinism: ties everywhere are broken lex (node id, edge id, resource id), and the wall-clock shift is `Math.ceil`'d, so two calls on the same inputs produce byte-identical plans.

Edge lag is the only durable knob — Caladia's data model has no per-node start field (starts are derived from CPM). Nodes with no incoming edges get flagged in `plan.skipped`.

Limitations surfaced in `plan.skipped` / `plan.remainingConflicts`:

- Loop body / sub-system body activities can't be shifted via edge lag.
- The serial-greedy heuristic isn't optimal — it can leave some resolvable conflicts on the table if shifting one activity creates a new one elsewhere.
- The iteration cap and wall-clock shift fallback exist so the function returns in reasonable time on weird inputs.

Determinism is load-bearing — the tie-break ordering and the `abandoned` set together prevent infinite loops and oscillation; the `edgeLagBumps` shape is what the apply path depends on.

### Streaming per-node P95 via bounded min-heap

`simulate()` reports `nodeP95: Record<string, Date>` — the 95th-percentile finish time per non-anchor node, used by the Gantt P95 overlay to draw a faded tail to the right of each bar.

Per-node finish samples aren't retained in full. Each reportable node owns a `BoundedMinHeap` of capacity `⌈iterations × 0.05⌉`; every iteration pushes the node's `earliestFinish` into its heap, dropping the smallest when at capacity. After the run, the heap's minimum is exactly the P95. Memory is O(iterations × 5% × nodes) instead of O(iterations × nodes) — at 10k iterations × 1000 nodes that's ~4 MB instead of 80 MB.

P95 is stored as an absolute `Date`, not an offset from `project.project.startDate`. This is load-bearing: the Gantt computes its effective `projectStart` as the _earlier_ of `project.startDate` and any node's `earliestStart` (so a Start anchor with an `anchorDate` before project start expands the visible window). An offset against `project.startDate` would produce negative numbers in that case. `nodeP95` must stay a `Date` (or epoch ms) so the consumer can project it onto whatever timeline they're rendering.

### Calendar conflict policy is per-assignment, not global

Each `resourceAssignment` carries its own `calendarPolicy` (`intersection` / `resourceWins` / `activityWins`). A single project legitimately has different policies across assignments — a weekend contractor forces `resourceWins`; a factory-shift worker might use `activityWins`; most internal staff use the default `intersection`. The policy belongs on the assignment, not the project.

### Sub-system flattening pre-pass (not in-engine expansion)

Sub-systems are flattened before CPM, not expanded in-engine. `flattenSubsystems(input)` is a pure transform returning a new `ScheduleInput`; CPM then sees a flat DAG with no branching for container nodes.

- **Post-order matters.** Nested sub-systems (container nodes inside body sets) must be processed innermost-first so that when the outer pass rewrites edges, the inner container is already gone. `nestingDepth()` returns 0 for a sub-system with no containers in its body, 1 for a container that holds one, etc.; sorting descending gives the correct order.
- **Fast path.** `return input` when `subsystems` is empty or undefined — projects with no sub-systems pay zero cost.

### `.calasub` embed-with-provenance (not a link)

When a `.calasub` file is imported, its body is **deep-copied into the project** — not stored as an external reference. This keeps projects self-contained (no broken references if the source file moves or is renamed). `Subsystem.source` records the original `fileName`, `contentHash`, and `importedAt` purely for informational display; Caladia makes no attempt to auto-reload from the path.

### Multi-resource activities: resource-aware effective working calendar

An activity has one effective calendar: project default → activity override, intersected with each assignment's resolved calendar. For **non-loop activities**:

1. `intersectCalendars(a, b): Calendar | null` is factored out of `resolveAssignmentCalendar` as a public helper in `packages/calendar` (returns `null` when no shared working days, which callers translate into structured validation errors).
2. `cpm.ts`'s `getNodeCal(node)` now fold-intersects each assignment's resolved calendar with the activity calendar, caching the result per node. The fold uses `resolveAssignmentCalendar(activityCal, resourceCal, policy)` as the per-assignment step:
   - `'activityWins'` → resolved = activity calendar → intersection is the identity, no narrowing
   - `'resourceWins'` → resolved = resource calendar → activity is narrowed to the resource calendar
   - `'intersection'` → resolved = activity ∩ resource → narrows on both axes
3. Validation gains a node-level check: even when each per-assignment policy resolves successfully, the FOLD across assignments may collapse to empty (two `'resourceWins'` assignments with disjoint calendars). That case now surfaces a clear error naming the resource that caused the collapse, rather than letting CPM produce a far-future date.

**Loop body nodes.** The body-CPM (`bodyForwardOffsets`) and the per-iteration unroll (`buildLoopResourceEntries`) both compute each body node's effective calendar via the shared `nodeEffectiveWorkingCalendar` helper in `packages/scheduler/src/utils.ts`, so a body activity assigned to a Mon–Wed resource under `'resourceWins'` actually advances on Mon–Wed inside each iteration — not just on its activity calendar. The body-offset numbers are stored as plain hour scalars (not tagged with a per-node calendar) and applied at the unroll site through each node's own resource-aware calendar; this remains internally consistent as long as body nodes share roughly the same effective calendar, which is the common case. The cross-calendar-arithmetic approximation in body-CPM (predecessor's EF measured in its calendar's hours, added to successor's duration in a possibly-different calendar's hours) is a known v1 quirk.

**Iteration-boundary snap in `buildLoopResourceEntries`.** For `iter > 1`, the raw working-hour advance `addWorkingHours(loopStart, (i - 1) * cpHours, defaultCal)` lands on an end-of-working-day timestamp (e.g. Tue 4pm) when cpHours is a multiple of the working day. That timestamp carries a calendar-day index (Tue) but is not a working moment, so the resulting entry `[Tue 4pm, Thu 4pm]` would spuriously claim Tuesday in the UI's day-bucket utilization even though no real work happens there. Each body node's per-iteration start is therefore snapped forward using `snapToNextWorkStart` in **the body node's own effective calendar** (not the default calendar) before applying the body offset. Snapping per-nodeCal is load-bearing: snapping in defaultCal could land iter-start on a day the body doesn't actually work on (e.g. Thu when the body is on a Mon–Wed resource). End-times don't change — the snap only shifts the start timestamp to the next moment work actually begins, eliminating phantom iteration-boundary overlaps in `computeDailyUtilization`.

### Per-node domain-store actions for multi-resource assignments

`packages/app/src/store/domainStore.ts` grows five granular actions alongside the existing `setNodeResourceAssignments` (which still works for bulk replacement — e.g. paste / import paths):

- `addResourceAssignment(nodeId, assignment)` — one undo step, silent no-op on duplicate `resourceId`
- `updateResourceAssignmentCount(nodeId, resourceId, count)` — **does NOT call `commitEdit()` itself**; the caller wraps repeated calls in `beginEdit`/`commitEdit` so per-keystroke updates coalesce into one history entry, mirroring `updateNodeName` / `updateNodeDuration`
- `updateResourceAssignmentPolicy(nodeId, resourceId, policy)` — one undo step (emitted by the inspector's per-row `calendarPolicy` `<select>`)
- `removeResourceAssignment(nodeId, resourceId)` — one undo step
- `splitResourceAssignment(nodeId, from, to, count)` — convenience for the Reassign-as-split UX: decrement from by N, grow-or-create to by N, remove from if it hits zero; single undo restores both sides; inherits `from`'s `calendarPolicy` when creating a new `to` entry, but preserves the existing `to`'s policy when growing

These actions give granular undo, edit-session coalescing, and a typed shape for the split UX; anything they do can also be expressed as a `setNodeResourceAssignments` call with the full array (used on bulk paths like paste / import).

**Reassign-as-split is the canonical conflict-resolution verb.** The Resources conflict card's Reassign panel calls `splitResourceAssignment(nodeId, from, to, count)` for every "move" — not a swap. When `count === activity.count`, the split degenerates to a full move (decrement `from` to zero, remove, create/grow `to`); when `count < activity.count`, the activity ends up multi-resource.

Each candidate row in the panel carries its own Move-count input, defaulted by a **walk-until-covered** algorithm: starting from the highest-slack activity, accumulate `min(contribution, remaining-overflow)` until the conflict's `overflow` is covered. The candidate set is the shortest prefix of the slack-sorted activity list whose summed default counts exactly resolve the conflict. Activities outside the candidate set are reachable via the "Show N more activities staying on …" expansion toggle.

The conflict-card activity list shows a per-activity contribution (`Activity 3.2 — contributes N of P/C peak`) read from `Conflict.activityContributions[i]`, which `findConflicts` pulls from each node's `resourceAssignments.find(a => a.resourceId === res.id)?.count`.

### Cost from plan only, not tracked

Caladia computes cost the same way it computes the schedule: **deterministically from the plan**. Resources carry rates; activity / decision nodes carry an optional `fixedCost`; the cost engine derives `nodeCosts`, `resourceCosts`, and `projectCost` on every `schedule()` call, and Monte Carlo emits cost percentiles / tornado / cumulative-cost curve from the same per-iteration runs that produce date percentiles.

The bright line: derivable from the plan deterministically → engine scope; needs persisted execution state (actual costs, EVM, captured baselines, audit trails) → outside the local-first scope and deferred to a hypothetical hosted/cloud build. This keeps the engine pure (no side effects, no state-over-time tracking) and the file format simple (no audit trail, no rollup tables).

### Cost as a third deterministic pass over the unrolled timeline

The deterministic scheduler now runs three passes in sequence — and only in sequence:

1. **Forward / backward CPM** (`packages/scheduler/src/cpm.ts`) — produces `nodes`, `criticalPaths`, `projectEnd` on the condensed graph.
2. **Resource timeline build** (`buildLoopResourceEntries` for loops, inline for non-loop activities) — emits one `ResourceTimelineEntry` per (assignment × iteration) for the UI's allocation histogram and per-resource KPIs.
3. **Cost pass** (`packages/scheduler/src/cost.ts:computeCosts`) — walks the post-flatten nodes once, charges each one with `rate × hours × count × iterations + perUse × count + fixedCost`, then rolls body sums into sub-system container ids. Emits `nodeCosts`, `resourceCosts`, `projectCost`.

Cost is its own pass, not folded into the resource pass: the two passes aggregate differently (resource pass emits per-(assignment × iteration); cost rolls up to per-node / per-resource / project), and Monte Carlo needs a clean per-iteration `computeCosts` seam.

`costPerUse` fires **once per `resourceAssignment` instance**, not per loop iteration. The `count` multiplier reflects bringing N copies of the resource (each copy mobilizes once).

### Sub-system cost rollup post-flatten

`flattenSubsystems` strips sub-system container nodes from the scheduler input before CPM runs. After flattening, container ids no longer exist in the DAG — `ScheduleResult.nodes` has no entry for them. The cost pass therefore can't compute container costs by walking the flat node list.

Solution: walk the **preserved `subsystems` map** (which `flattenSubsystems` carries through on its output for exactly this purpose), deepest-first, summing each body's per-node costs into a synthetic `nodeCosts[containerId]` entry. Container ids appear in `nodeCosts` even though they aren't in `nodes` — an asymmetry the UI consumes intentionally (the SubsystemPanel reads `result.nodeCosts[containerId].total` for its Aggregate cost row).

Two consequences:

- **Ordering matters.** An outer sub-system's `bodyNodeIds` may include an inner container id (sub-systems nest). Deepest-first traversal guarantees the inner container's roll-up is in `nodeCosts` before the outer roll-up reads it.
- **`projectCost` sums flat nodes only.** Container roll-ups are derived from the same body costs that already appear individually — summing both would double-count. The project total iterates `flatInput.nodes` and skips the rollup entries.

### Per-node sub-stream draw order: duration → bernoulli within one stream; cost from a dedicated parallel stream

Each node has a single deterministic sub-stream seeded by `nodeRng(rootSeed, nodeId)`. Duration and bernoulli (pass/fail) draws come from that single stream, in that order within each iteration. This satisfies the cross-node invariant — adding or removing a node never perturbs any other node's samples — because each node has its own sub-stream.

Cost is a third draw type: `fixedCost.distribution`. The naive approach is to append it as a third draw on the same per-node stream, in the order `duration → bernoulli → cost`. Within a single iteration this preserves duration and bernoulli, which are drawn first. But **across iterations** it breaks: if iteration 0 consumes N positions of the stream for duration/bernoulli and M positions for cost, iteration 1's duration draw starts at position N+M instead of N. So iteration 2 onward diverges between the with-cost and without-cost runs.

The stronger invariant the engine asserts: adding a `fixedCost.distribution` to a node leaves that node's full **multi-iteration** duration sample stream byte-identical. Achieving this requires **two parallel sub-streams per node**:

- **Duration / bernoulli stream:** `nodeRng(rootSeed, nodeId)`. Within each iteration, draws proceed in declared order (duration first; if a decision node, bernoulli after).
- **Cost stream:** `nodeRng(rootSeed, 'cost:' + nodeId)` — independent of the duration/bernoulli stream. Cost draws consume from this stream only.

The two streams advance independently across iterations. Adding a cost distribution touches only the cost stream; duration / bernoulli sequences are byte-stable. Removing a cost distribution is also benign.

The `cost:` prefix (`` SOH control char + the literal `"cost:"`) cannot appear in a user-typed node ID, so cost streams cannot collide with the duration / bernoulli stream of any node literally named (e.g.) `cost:foo`. Same defensive pattern as `__loop__${loopId}` for sampled iteration counts, refined to use a control character separator.

The within-iteration order claim ("duration → bernoulli → cost") is still meaningful for UI copy and conceptual ordering — but the implementation enforces it by stream separation, not by sequence within one stream. The invariant tests (`cost-sim.test.ts`) cover both invariants explicitly:

- Cross-node — adding `fixedCost.distribution` to node A leaves node B's `endDates` byte-identical.
- Within-node — adding `fixedCost.distribution` to node A leaves A's duration samples (and therefore its single-node `endDates`) byte-identical; same for decision nodes' bernoulli outcomes.

### Cost UI empty-state strategy

Six UI surfaces show cost data: the NodePanel Cost section, SubsystemPanel Aggregate cost row, Resources Total labor cost KPI + per-resource Cost contribution, Gantt Project cost KPI + S-curve overlay, Simulate Verdict-bar Budget tile + Date|Cost histogram + Risk Drivers Cost mode. Each surface needs a consistent answer to "do we render anything when this project has no cost data?"

The policy is centralised in **`packages/app/src/utils/cost.ts:projectHasCostData(project)`**, a single predicate returning `true` when any resource has a non-zero `costRate` / `costPerUse` OR any node has a `fixedCost` defined. Every surface gates on this same predicate, with two intentional exceptions:

- **NodePanel "Cost" header** always shows — discoverability. The derived row inside it renders an em-dash + helper copy ("Add cost rates to resources to compute resource-driven cost.") when no cost data exists, and the Fixed cost editor remains so users can author cost data right there. This is the **only** "show, but explain" surface.
- **Inspector resource form's cost inputs** always show, since the form _is_ the way users enter cost data in the first place.

Every other surface follows this default:

| Surface                                         | When no cost data           |
| ----------------------------------------------- | --------------------------- |
| Gantt — Project cost KPI tile                   | hidden (skipped in JSX)     |
| Gantt — S-curve toggle                          | hidden                      |
| Resources — Total labor cost KPI                | hidden                      |
| Resources — per-resource Cost contribution line | hidden                      |
| SubsystemPanel — Aggregate cost row             | hidden                      |
| Simulate — Verdict-bar Budget tile              | hidden                      |
| Simulate — Date \| Cost toggle                  | hidden (defaults to Date)   |
| Simulate — CostChartCard                        | unreachable (toggle hidden) |
| Simulate — Risk Drivers Cost mode               | unreachable (toggle hidden) |

Two consequences worth flagging:

1. **`simChartMode` falls back to Date automatically.** The viewStore persists the user's pick in localStorage, but `SimulationResultView` reads `axis = hasCost && simChartMode === 'cost' ? 'cost' : 'date'` so a returning user who had Cost mode active on a previous project doesn't see broken cost charts when they open a no-cost project. The persisted value isn't overwritten — switching back to a cost-bearing project restores the user's last pick.
2. **Empty-with-cost-rates is distinct from empty-without.** When the project has rates but the schedule's `result.resourceCosts` is empty (e.g. degenerate / always-failing schedule), surfaces still render with zero values rather than hiding — the rates are real configuration, just no schedule run them yet. Hiding would silently mask the rates.

### Cost-curve bucketing strategy

`SimulationResult.costCurve` is the cumulative-cost S-curve: per-bucket percentiles (P10 / P50 / P80 / P95) of cumulative project cost incurred over the project's lifetime, with `times[]` as the absolute hours-from-project-start axis.

Two design choices need fixing because Monte Carlo iterations don't share a common time axis (each iteration has its own sampled `projectEnd`):

**1. Buckets are normalized per iteration, not absolute.** Each iteration is divided into 50 evenly-spaced buckets between `projectStart` and **that iteration's** `projectEnd`. Bucket `b` always represents "b/49 of the way through this iteration's run." Cross-iteration percentile extraction operates on a coherent "% of project complete" axis — bucketing on the deterministic `projectEnd` would clip late-finishing iterations and skew percentiles for early-finishing ones.

**2. `times[]` is anchored to the median MC `projectEnd`, not the deterministic one.** The x-axis labelling matches the user's intuitive sense of "how long this project takes" rather than an idealised deterministic figure that may not be representative of the simulated distribution.

**Cost attribution model: node's _total_ cost lands at its iteration `earliestFinish`.** Within each iteration, after the schedule completes, every node's full `nodeCosts[id].total` is attributed at the bucket index that contains its `earliestFinish`. Cumulative cost at bucket b is the sum of every node whose finish lands in bucket ≤ b. Cross-iteration averaging produces the smooth S-curve.

Two known approximations live in this model:

- **Loop bodies stack at iter-1 finish.** Body cost aggregates into a single `nodeCosts[bodyId]` entry; the body's `NodeSchedule` reports iter-1 timing. All iterations of a loop body land in the same bucket — a step, not a ramp. Cross-iteration smoothing softens this but the artifact is real.
- **No spreading over duration.** A node's resource cost actually accrues linearly between `earliestStart` and `earliestFinish`; we attribute it all at `earliestFinish`. For long tasks (e.g. a multi-month activity) the curve has a small staircase rather than a smooth ramp.

Memory bound: `O(buckets × iterations)` = 50 × 10k × 8 bytes ≈ 4MB at maximum-supported iteration counts. Per-bucket arrays are sorted at end-of-run for percentile extraction (O(buckets × iters log iters) total — dominated by the rest of the simulation).

### `fromCrash` as a third `NodeCost` bucket, not folded into `fromFixed`

The engine lets the user attach `crashOptions: Array<{ duration; additionalCost }>` to activity / decision nodes. When `selectedCrashIndex` is set, the engine swaps the nominal duration for the option's (shorter) duration AND charges `additionalCost`. That charge surfaces as a **third bucket** on `NodeCost` (`fromResources`, `fromFixed`, `fromCrash`), not as an addition to `fromFixed` — readers of `result.nodeCosts[id]` can tell whether a row's cost came from `fixedCost` (permit / license) or from a deliberate crash decision.

Loop-iteration semantics share `fixedCostOnce`: when the crashed node is inside a loop body, the crash add-on charges per-iteration by default and one-time when `fixedCostOnce: true` — the same flag that controls `fromFixed`.

The schema enforces `crashOption.duration.unit === node.duration.unit` and a strictly smaller value. Same-unit keeps the "strictly shorter" comparison unambiguous at parse time, with no calendar context required inside the Zod refine.

### Crashing as orchestration, not a fourth engine pass

The greedy crash helpers (`@procsim/scheduler/greedyCrash` for deterministic, `@procsim/simulation/chanceCrash` for chance-constrained) are wrappers around the existing three passes (CPM → resource timeline → cost): pick a candidate step, mutate `selectedCrashIndex` on a working copy of the nodes, re-invoke `schedule()`, repeat. Each iteration is a full re-evaluation; nothing is incremental.

`selectedCrashIndex` is a normal optional field on `NodeSchema` that the engine already honours via `nodeBaseHours` — the same field the Inspector writes when the user picks an option manually. The greedy just batches a sequence of those writes.

Both helpers share `pickBestStep` (exported from `@procsim/scheduler/crash.ts`). It returns the cheapest-`$/working-day` candidate using the engine's `effectiveDurationHours` so decision-failure penalty cancels in the delta and parallel-branch handling is honoured. Two-key tie-break (deeper crash, then `nodeId`) keeps the result deterministic.

A 100-activity CPM runs in single-digit milliseconds; a 10-step greedy run completes inside a frame on the main thread.

### Chance-constrained greedy uses a fixed seed across all evaluations

`chanceCrash` runs an MC at each greedy step to compute the configuration's P95 finish. With a naive new-seed-per-evaluation strategy, two evaluations of the same configuration would produce slightly different P95 values — and the algorithm would bounce between candidates whose true ROI is identical.

The fix: every `simulate()` call inside one `chanceCrash` run uses the **same root seed**. The per-node sub-stream isolation (`nodeRng(rootSeed, nodeId)` and `nodeRng(rootSeed, '__loop__' + loopId)`, plus the `'cost:'`-prefixed cost streams) means a fixed root seed deterministically replays the same per-node sample sequence every time. Re-evaluating any configuration is byte-identical; the algorithm's pick at each step is a pure function of its inputs.

The helper still applies an ε-tolerance (default 0.5 working days, scaled by the project default calendar's `hoursPerDay`), but only to prevent crashing one more step for a sub-working-day P95 gain that wouldn't materially help the user — not to prevent bouncing.

### Worker-runnable async helpers yield to the event loop via `Promise.resolve()`

`chanceCrash` is async; it `await Promise.resolve()` between iterations so the Web Worker's message handler can dispatch any queued `cancel` request before the next MC fires. `simulate()` itself stays synchronous (a Cancel during an in-flight simulation fires at the next `simulate()` boundary — typically ~100ms for the 100-iteration budget the chance-crash helper uses).

The pattern generalises: any long-running engine helper that wants worker-cooperative cancellation should be `async` and yield between outer-loop iterations.

### Per-resource sub-stream for hourly-rate uncertainty

A resource carrying `hourlyRateDistribution` (currently triangular in the UI; the schema accepts the full `DistributionSchema` union for forward-compatibility) draws its hourly rate from a dedicated per-resource RNG sub-stream every Monte Carlo iteration. The stream is keyed `nodeRng(seed, 'rate:${resource.id}')` — the SOH-prefixed namespace matches the `cost:` precedent and prevents collision with any user-typed node id. Streams are pre-allocated for every resource regardless of whether a distribution is currently set, so toggling the field on or off doesn't shift the iteration sequence for that resource.

The cost engine in `packages/scheduler/src/cost.ts` stays deterministic. Each iteration, `simulate()` builds a per-iteration `sampledResources` array overriding `costRate` with the sampled value, then passes it into `schedule({ ..., resources: sampledResources, ... })`. `costForNode` reads `resource.costRate` exactly as it does in the deterministic path — same code, same engine boundary. This mirrors how per-node `fixedCost.distribution` is plumbed: simulation owns the sampling; scheduler owns the deterministic math.

Stream-isolation invariants pinned by tests (`cost-sim.test.ts`):

- **Cross-resource**: adding a rate distribution to resource A leaves resource B's cost samples byte-identical (each resource has its own sub-stream; B's stream is consumed zero times when its distribution is absent).
- **Cross-stream**: adding a rate distribution leaves every node's `endDates` byte-identical — the rate stream is independent of every node's duration / bernoulli / `fixedCost` streams.

Negative samples (possible for `normal` distributions centred near zero) clamp to `0` at sample time — matches the `fixedCost` `Math.max(0, sampled)` precedent.

### Per-iteration sample retention for sensitivity analysis

The Monte Carlo loop retains per-iteration input samples for every variance-bearing node (one with a `distribution` set, excluding anchors and sub-system containers) so the engine can compute Spearman rank correlation ρ against project finish hours AND project cost. Activities retain the sampled duration in hours; decisions retain the sampled `passProbability` ∈ [0, 1] BEFORE the bernoulli collapse — the continuous-input signal is the point of the analysis. Bernoulli outcomes are discarded for retention; the bernoulli draw is downstream of the input we're correlating.

Three new fields on `SimulationResult`:

- `nodeInputSamples: Record<string, number[]>` — per-iter input values, stride-subsampled to `SENSITIVITY_RETENTION_CAP = 10 000` per node. For `iterations > cap`, stride = `Math.ceil(iterations / cap)` and every retained node aligns to the same iteration indices.
- `finishSensitivity: Record<string, number>` — Spearman ρ between each node's samples and the matching subsample of finish hours.
- `costSensitivity: Record<string, number>` — Spearman ρ between each node's samples and the matching subsample of project costs.

The stride cap bounds memory at high iteration counts: 100 k iters × 100 variance-bearing nodes × 8 bytes (Number) = 80 MB uncapped vs 8 MB capped. Spearman ρ on 10 k stride-subsampled samples is statistically indistinguishable from ρ on the full set for typical project distributions — the cap is a memory bound, not a precision bound.

Sub-stream isolation is pinned by tests in `sensitivity.test.ts`:

- **Adding a distribution to one node** leaves every other node's `nodeInputSamples` byte-identical. Each node has its own RNG sub-stream (the per-node hierarchical pattern); a new distribution only consumes from its owner's stream.
- **Determinism**: same seed → identical `nodeInputSamples` and identical `finishSensitivity` / `costSensitivity` maps.

`excludedFromDistribution` (the what-if exclusion) handling: when a variance-bearing node has its draw skipped, the retention falls back to its static value (`passProbability` for decisions; `duration.value` for activities) so the per-node arrays stay length-aligned with `retainedFinishHours` / `retainedCosts`. The resulting input is constant across iters; `spearmanCorrelation` collapses to 0 for constant inputs — the correct reading for an excluded node, which contributes zero variance by construction.

The new `spearmanCorrelation(xs, ys)` utility in `packages/simulation/src/spearman.ts` is pure (no RNG, no time, no global state). Standard fractional-rank Spearman: average rank for ties; returns 0 for length < 2, constant series, or zero variance. Throws on mismatched lengths (programmer error, not user input).

### Risks tab combines user-flagged timing risks and engine-detected cost drivers

The Risks tab surfaces two classes of risk under one register, with intentionally separate tables because their data sources don't overlap:

1. **Timing risks** — user-authored taxonomy. Decision nodes flagged with `node.isRisk: true` appear here. The author is making a judgement call ("this gate is an unintentional event") and the row's content is what they typed: probability, failure delay, optional crash-option cost.

2. **Cost drivers** — engine-detected. Read from `viewStore.simHistory[0].result.costTornado` and ranked by per-node cost spread (P95 − P5). No schema field, no user flag — purely a derived view over the cached simulation result. When `project.budget` is set and the project's P95 cost exceeds it, each driver is annotated with its share of the over-budget gap (computed as `share_of_total_variance × (p95Cost − budget)`).

The two data shapes are intentionally not unified: timing risks come from user judgement (probability, delay); cost drivers come from simulation output (per-node cost spread). Forcing both into one row would either require users to manually flag every variance-heavy activity (defeating auto-detection) or produce records with mostly empty cells. `Locate` is a shared affordance; editing flows diverge (timing risks edit inline; cost drivers don't have user-editable fields).

The cost-driver section has three states: no MC run cached (empty-state card with a Simulate-tab CTA); MC cached but `costTornado.length === 0` (hint to add a cost / rate distribution); or top-8 table, optionally with the "Share of gap" column when over-budget.

The Tornado card on the Simulate tab and the Risks-tab section both read the same `costTornado` field — Tornado as a ranking view, Risks as a register view.

### Risks share the decision-node engine path

A "risk" in the Risks register is just a decision node with `node.isRisk: true`. The engine — CPM, loop scheduling, Monte Carlo, cost — treats the flag as a no-op: identical to any other decision node, scheduled via the same `effectiveDurationHours = duration + (1 − passProbability) × failureDelay` expectation and resolved by the same per-node bernoulli draw under Monte Carlo. The flag is a UI taxonomy bit only — it surfaces the node in the Risks tab, lets the Canvas filter hide it, and gives the Tornado view a small "risk" badge.

Reusing `crashOptions` for the cost impact follows the same principle: the engine already allows `crashOptions` on decision nodes; the `fromCrash` bucket carries the cost.

The "+ Add risk" node is dropped at a fixed off-canvas offset (-400, 0) so the risk register stays list-managed. A disconnected risk node trips the "Multiple chains detected" diagram-health warning; connecting it is a one-edge user action when it matters.

### Schema string + array size limits (`SCHEMA_LIMITS`)

[packages/file-format/src/schema.ts](packages/file-format/src/schema.ts) exports a single `SCHEMA_LIMITS` const that's the source of truth for every size cap. Enforcement is **hybrid**:

- **Free-text strings** (`name`, `description`, `notes`, `group`, kickout `description`) — _soft cap_. [packages/file-format/src/load.ts](packages/file-format/src/load.ts) runs `truncateOversizedStrings` before Zod parse, clips over-cap values to the cap length, and surfaces a `TruncationWarning[]` on `LoadResult.truncationWarnings`. The toast handler in [packages/app/src/components/AppShell.tsx](packages/app/src/components/AppShell.tsx) shows a non-blocking notice. User keeps a recognizable, editable artifact; AI-generated long content still loads.
- **Identifiers, references, and arrays** (`id`, `from`, `to`, `nodes`, `edges`, ...) — _hard cap_ via Zod `.max()` on the schema. Truncating an ID would break references; truncating an array would corrupt project semantics (edges pointing at dropped nodes, cascading invariant breaks). A precise rejection error is safer.

**When adding a new field to the schema**, decide which side of the split it lives on: free-text → add a `SCHEMA_LIMITS.<name>` entry and wire it into `truncateOversizedStrings`. Identifier or array → add `.max(SCHEMA_LIMITS.<name>)` directly on the Zod schema. The cap values are intentionally an order of magnitude above realistic projects; tighten only with evidence.

---

## Decision log

Notable decisions and the reasoning behind them. Append as new ones arise; do not delete.

### File extension: `.cala` (single extension; legacy `.procsim` still loads)

Project files use a single extension `.cala` (formerly `.procsim`) to match the product name. MIME type is `application/json` — the on-disk JSON format itself is unchanged.

`.procsim` is still accepted on the load side (file picker `accept` attribute, no extension check on read) so files saved by older builds keep loading. The `@procsim/*` package names are retained as-is.

### FX snapshots: bundled-not-fetched + pinned-at-save

Currency conversion for display totals (Gantt KPI tile, Verdict-bar Budget tile, cost-histogram Budget pill) uses **bundled JSON snapshots** in `packages/file-format/src/fx-snapshots/<version>.json`. The mechanism mirrors holiday presets:

1. **Bundled, not fetched.** Snapshots ship with the package; the app never makes a network call for FX data. Two reasons: keeping the app fully offline-capable, and determinism (two users on the same project version compute the same dual-currency display).

2. **Pinned at save.** `project.fxSnapshotVersion` records the snapshot the user was on when they last saved. Loading a project re-binds the dual display to that exact snapshot, never auto-upgrading. The user accepts updates explicitly via the FX-update banner.

3. **`'NONE'` opt-out.** A project can pin to the literal string `'NONE'` to disable FX-snapshot loading entirely — `loadFxSnapshot('NONE')` returns `null`, `convertAmount(..., null)` returns `null`, and the FX-update banner self-suppresses.

4. **Forward-compat.** A project pinned to an unknown future version is left alone — the banner doesn't surface, conversion silently fails to null, the display falls back to native.

5. **Display-only.** Engine outputs and inputs stay in `project.currency`. The scheduler / simulator never see converted values. This keeps the engine pure (no FX dependency, no display concerns).

**Snapshot format.** ECB convention: rates are `<foreign>` per 1 unit of base. With USD as base, `rates["EUR"] = 0.854` means "1 USD = €0.854". Stored to 6 decimal places so round-trips through the base cancel to within 8 decimal places of floating-point error.

### Holiday presets pin at save, never auto-upgrade on load

Calendars store `holidayPresetVersion` (e.g. `"2024.1"`) at save time. Loading a file whose pinned preset has a newer available version surfaces a non-intrusive UI banner; the user explicitly accepts the update, which re-pins. Determinism over convenience — a schedule should not silently change just because Juneteenth was added to the US Federal list.

### "Progress on any day any resource works" deferred to v2

An activity has one effective calendar (project default → activity override, intersected with each assignment's resolved calendar). A more realistic "effort accumulates across parallel per-resource calendars" model would require a materially more complex engine and is deferred.

### Zod over Valibot

Chose Zod for ecosystem maturity and error-message quality. Valibot is a drop-in replacement with smaller bundle if size becomes a concern later.

### SVG color tokens instead of Tailwind `dark:` in GanttView

SVG attribute values (`fill`, `stroke`) are not CSS properties — Tailwind's `dark:` class modifier has no effect on them. Fix: read `darkMode` from `viewStore` and produce the correct hex literal with a JS ternary (e.g. `darkMode ? '#1e293b' : '#f9fafb'`). Named `const` tokens at the top of the render block (not inline magic strings) make the set of color pairs auditable in one place.

### Zero-duration anchor nodes collapse to a single instant

`Start` and `End` anchors are zero-duration milestones. The CPM forward pass treats them as instants: `earliestFinish === earliestStart === rawEs`, where `rawEs` is either the (snapped) `projectStart` for roots or the predecessor's `earliestFinish`. The published `earliestStart` skips the usual `snapToNextWorkStart` for these nodes — snapping a 4 PM end-of-shift instant would push it to the next workday morning, breaking the invariant that an End anchor lands at exactly its predecessor's finish.

Two consequences:

1. `projectStart` is snapped to the first working moment up front in `cpm.ts`, so a Start anchor at the project's entry sits at 08:00 on the first working day rather than the literal midnight of `startDate`. Activities with no predecessors are unaffected because their existing `addWorkingHours(rawEs, dur)` path already snaps internally.
2. `earliestStart` and `latestStart` for instants are pinned to `earliestFinish` / `latestFinish` respectively. Slack falls out of `workingHoursBetween(ef, lf)` as 0 — anchors are always on the critical path of any chain that reaches them.

Anchors are also excluded from the Gantt bar list (a 0-px bar is noise) and from the activity property panel (only `name` + `id` + `anchorDate` for Start are user-meaningful).

### Per-Start `anchorDate` overrides project start for that branch

A `Start` node may carry an optional `anchorDate` (`YYYY-MM-DD`) that pins the chain rooted at it to a specific calendar date. The CPM forward pass replaces the usual `rawEs = projectStart` initialization with `snapToNextWorkStart(anchorDate, nodeCal)` when a Start node has `anchorDate` set. Descendants inherit the anchor naturally via the existing FS/SS/FF/SF constraint propagation — no special-casing downstream.

Per-node effective floor lets anchors push descendants either later **or earlier** than `project.startDate`. Before the forward pass, the scheduler computes `effectiveFloor[nodeId] = min(projectStart, anchorDate of every Start ancestor that reaches this node via BFS)`. The forward pass uses this floor instead of a blanket `projectStart`. Three consequences worth noting:

1. **Unanchored chains keep the historic floor.** Nodes with no Start ancestor (or whose Start ancestors all anchor at-or-after `projectStart`) still floor at `projectStart`. This preserves the existing semantics that negative-lag edges (e.g. SS lag=−4h) cannot push activities into a date before the project's stated start.
2. **Anchored chains flow freely in both directions.** A Start whose `anchorDate` is earlier than `projectStart` lowers the floor for every node it reaches, so the anchor actually takes effect rather than being silently clamped. A Start whose `anchorDate` is later than `projectStart` doesn't relax the floor (the `>=` early-return in the floor-lowering loop) — its constraint still propagates forward via `Start.ef → descendants` in the standard forward pass.
3. **Today is the default.** New Start nodes default `anchorDate` to today's local date (`new Date().toISOString().slice(0, 10)`) so the user sees an explicit, editable value in the property panel rather than a blank field that silently inherits `projectStart`. Clearing the field falls back to `projectStart`.

The Gantt mirrors this on the view side: `GanttView.projectStart = min(project.startDate, every scheduled earliestStart)`. Without that, anchored-earlier chains would render to the left of the visible timeline.

### Multiple Start nodes anchor independent chains; convergence is allowed

A diagram may have any number of Start nodes — each anchors its own subgraph via `anchorDate`. The only structural invariant `validate()` enforces is:

1. **Every Start must lead somewhere.** A Start with zero outgoing edges produces a "not connected to any downstream activity" error. Dangling Starts are almost always a leftover from editing — the user added one and never wired it up.

Independent chains anchored by different Starts may converge downstream — at a join node, the standard CPM rule applies: `node.es = max(predecessor finish times)`. Convergence is not flagged as an error, since a common authoring pattern is dropping a second Start onto an unanchored side-branch so it gets an explicit anchor instead of inheriting `projectStart`.

If two Starts both directly anchor the same node (e.g. `S1 → A` and `S2 → A`), `effectiveFloor` lowers `A` to the earlier of the two anchors and the forward pass's `max()` over predecessors then floats `A.es` up to the later anchor's instant — both anchors are honored consistently.

End nodes remain capped at one in the UI (toolbar disables the option once one exists).

### Root `pnpm dev` runs engine watch + Vite in parallel

The app imports `@procsim/scheduler` from its compiled `dist/index.js`, not from source. Each engine package exposes a `dev` script (`tsc --watch --preserveWatchOutput`). Root `dev` does a one-shot engine build so `dist/` exists for Vite's initial module resolve, then runs `pnpm -r --parallel run dev` — engines emit incremental JS on save and Vite live-reloads. `--preserveWatchOutput` keeps prior compile messages visible across rebuilds.

This unblocks cross-package edits without manual orchestration (e.g. add a field to the schema, use it in scheduler, render it in app — all with a single hot-reload cycle).

### Decision nodes encode failure as a delay, not a branch

A decision (review/quality gate) has a probability of passing on first attempt and a configurable extra delay if it fails. Failure is modelled as **additional effort on the same path** rather than a branch, so the graph stays a DAG.

- The deterministic CPM uses the **expected effective duration** `duration + (1 − passProbability) × failureDelay`, computed in `effectiveDurationHours()` (`packages/scheduler/src/utils.ts`) and substituted at every site where the forward pass / backward pass / critical-path tracer / loop body summation previously read `toHours(node.duration, cal)`. The `isInstant` check at the top of the forward pass keeps the raw `node.duration` lookup — decision nodes always have positive duration, so the expected-value adjustment never resurrects an instant.
- The Monte Carlo path encodes the realised outcome by **rewriting `passProbability ∈ {0, 1}` per iteration** in `simulate()`. A Bernoulli draw collapses the scheduler's expected-value formula to either `duration` (pass) or `duration + failureDelay` (fail). Only one place in the codebase converts `failureDelay` to hours.
- **Tornado ranking** treats `decision.failureDelay.value` as a variance range (analogous to `dist.max - dist.min` for distributions) so decision gates with material failure penalties surface in the impact ranking even when no duration distribution is set.
- A decision node's resource assignments are held for the **full effective duration**, including any failure delay realised in that iteration. Resources are not released and re-acquired across the simulated rework loop.

The diamond renderer (`packages/app/src/nodes/DecisionNode.tsx`) inscribes a CSS-rotated square inside a square bounding box (side = box / √2) so the diamond's east/west vertices coincide with the bounding rect's left/right midpoints — that's where React Flow's `<Handle position="left|right">` lands, so connection points align cleanly without manual coordinate math.

### Alphabetical-index group color assignment over hash-based

Group names are sorted A→Z; the first group alphabetically gets palette entry 0, the second gets entry 1, etc. This guarantees distinct colors for distinct names and is stable across renders as long as the group set doesn't change (tracked via the `groupListKey` string selector). A hash function over short strings produced similar-looking palette indices for strings with shared prefixes, defeating the goal.

---

## Open questions

Log items here when something load-bearing but underspecified comes up during implementation. Remove items as they are resolved (with a note in the Decision log).

_None yet._
