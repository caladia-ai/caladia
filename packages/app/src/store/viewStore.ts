import { create } from 'zustand';
import type { ProjectFile } from '@procsim/file-format';
import type { SimulationResult } from '@procsim/simulation';
import { scaleSimulationCosts } from '../utils/cost.js';

export interface ViewSelection {
  nodeIds: ReadonlyArray<string>;
  edgeId: string | null;
}

/** One level of the drill-in breadcrumb trail. */
export interface BreadcrumbEntry {
  subsystemId: string;
  label: string;
}

/** One completed simulation run kept in history (max 5). */
export interface SimRun {
  id: string;
  timestamp: Date;
  iterations: number;
  seed: number;
  result: SimulationResult;
  /** JSON.stringify of the ProjectFile at the time the run was executed. */
  projectSnapshot: string;
  /**
   * Phase 16 — node IDs whose `distribution` was excluded for this run
   * (the input to `simulate()`). Empty / undefined for baseline runs;
   * populated for what-if runs from the Risk Drivers card. Used by the
   * Compare sub-tab to label runs as e.g. "what-if without Activity 22".
   */
  excludes?: ReadonlyArray<string>;
}

// Phase 11 — moved to a `caladia:` prefix. The old `procsim:darkMode` key
// is read once on first load so a returning user keeps their preference,
// then all subsequent writes go to the new key.
const DARK_MODE_KEY = 'caladia:darkMode';
const LEGACY_DARK_MODE_KEY = 'procsim:darkMode';
// Phase 19 — Date | Cost toggle on the Simulate tab (histogram + Risk
// Drivers). Persisted so navigating away and back keeps the user's choice.
const SIM_CHART_MODE_KEY = 'caladia:simChartMode';
// Phase 19 slice 4 — Currency display preference. 'AUTO' = show only the
// project's native currency; any ISO code = show "$X / ≈€Y" dual display.
// 'NONE' is intentionally not a stored value — AUTO already covers the
// "no conversion" intent.
const CURRENCY_DISPLAY_KEY = 'caladia:currencyDisplay';
// Phase 22 — Inspector hide-toggle. When true, the global right-docked
// Inspector panel is suppressed even with a selection. Persisted so the
// user's preference survives reloads.
const INSPECTOR_HIDDEN_KEY = 'caladia:inspectorHidden';
// Phase 27 — Template picker first-run flag. Once the user has been shown
// the picker (or dismissed it once), don't auto-open it again on reload.
const TEMPLATE_PICKER_SEEN_KEY = 'caladia:hasSeenTemplatePicker';
// First-run onboarding overlay (the empty-canvas welcome card). Same
// localStorage-flag pattern as the template picker above.
const ONBOARDING_SEEN_KEY = 'caladia:hasSeenOnboarding';
// Phase 41 — per-section open/closed state for the Inspector's node-properties
// panel. Persisted so the user's chosen layout (e.g. "I always want Cost
// expanded") survives reloads.
const INSPECTOR_SECTIONS_KEY = 'caladia:inspectorSections';
// Phase 43 — resource palette open/closed. Off by default; user opts in via
// the canvas toolbar toggle when they want to bulk-assign pools.
const RESOURCE_PALETTE_OPEN_KEY = 'caladia:resourcePaletteOpen';
// Phase 49 Slice 8 — snap-to-grid preference. ON by default (a fresh
// user gets the gridded feel right away); persisted so an opt-out
// sticks across reloads. The grid pitch matches the canvas dot-pattern
// (16 px) so the snap targets line up with what the user already sees.
const SNAP_TO_GRID_KEY = 'caladia:snapToGrid';
// Phase 47 Slice 2 — Gantt label-column width. Persisted so the user's
// preferred split between the name column and the timeline survives reloads.
const GANTT_LABEL_WIDTH_KEY = 'caladia:ganttLabelWidth';

const GANTT_LABEL_DEFAULT = 188;
const GANTT_LABEL_MIN = 120;
const GANTT_LABEL_MAX = 480;
// Gantt zoom steps — extended down in Phase 47 Slice 2 follow-up to support
// multi-decade projects (the Oncology template's ~18-year arc didn't fit at
// the previous 0.1× floor on standard viewport widths). At 0.025× (= 0.7
// px/day) ~20 years of calendar days fit in ~5000 px.
const GANTT_ZOOM_STEPS = [0.025, 0.05, 0.075, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3] as const;
const RESOURCES_ZOOM_STEPS = [1, 2, 4, 8] as const;

function loadGanttLabelWidth(): number {
  try {
    const v = localStorage.getItem(GANTT_LABEL_WIDTH_KEY);
    if (v === null) return GANTT_LABEL_DEFAULT;
    const n = Number(v);
    if (!Number.isFinite(n)) return GANTT_LABEL_DEFAULT;
    return Math.min(GANTT_LABEL_MAX, Math.max(GANTT_LABEL_MIN, n));
  } catch {
    return GANTT_LABEL_DEFAULT;
  }
}

function saveGanttLabelWidth(px: number): void {
  try {
    localStorage.setItem(GANTT_LABEL_WIDTH_KEY, String(px));
  } catch {
    // ignore
  }
}

/**
 * Phase 41 — section ids for the activity-node properties panel. New entries
 * default to "open" if the user has never toggled them, so adding a section
 * later doesn't silently hide it from returning users.
 */
export type InspectorSectionId = 'identity' | 'duration' | 'resources' | 'cost' | 'advanced';

const INSPECTOR_SECTION_DEFAULTS: Readonly<Record<InspectorSectionId, boolean>> = {
  identity: true,
  duration: true,
  resources: true,
  // Cost / Advanced are collapsed by default — most activities don't author
  // these fields, and showing the collapsed header is enough to advertise
  // that the capability exists.
  cost: false,
  advanced: false,
};

/**
 * Resolve the initial dark-mode value.
 *
 * Precedence:
 *   1. Explicit user choice in localStorage (current key, then legacy key).
 *   2. OS preference via `prefers-color-scheme: dark` when matchMedia
 *      is available.
 *   3. Light mode as the final fallback (SSR, ancient browsers).
 *
 * The OS-preference branch only fires when the user has *never* toggled the
 * theme on this device; once they toggle, applyDarkMode persists their
 * choice and step 1 wins on every subsequent load. That gives "follow my
 * OS" for first-time visitors and "remember what I picked" for returning
 * users, without a manual auto/light/dark setting.
 */
function loadDarkMode(): boolean {
  try {
    const v = localStorage.getItem(DARK_MODE_KEY);
    if (v !== null) return v === 'true';
    const legacy = localStorage.getItem(LEGACY_DARK_MODE_KEY);
    if (legacy !== null) return legacy === 'true';
  } catch {
    // localStorage may throw on private-mode Safari etc. — fall through.
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      // matchMedia shouldn't throw, but be defensive — fall through to light.
    }
  }
  return false;
}

/**
 * Apply the dark-mode class to <html> and optionally persist the choice.
 *
 * The module-load call (line below) passes `persist: false` so following
 * the OS preference doesn't write to localStorage — that would lock the
 * very first OS reading in and stop us honouring OS changes on future
 * visits. The toggle action passes `persist: true` so an explicit user
 * choice sticks.
 */
function applyDarkMode(dark: boolean, persist: boolean): void {
  // Module-load calls applyDarkMode unconditionally so the html.dark class is
  // present before first render. The workspace tests run in the default node
  // environment (no DOM) — keep this a safe no-op there so importing the
  // viewStore from any test doesn't crash on `document`.
  if (typeof document !== 'undefined') {
    if (dark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }
  if (!persist) return;
  try {
    localStorage.setItem(DARK_MODE_KEY, String(dark));
  } catch {
    // ignore
  }
}

export type SimChartMode = 'date' | 'cost';

function loadSimChartMode(): SimChartMode {
  try {
    const v = localStorage.getItem(SIM_CHART_MODE_KEY);
    return v === 'cost' ? 'cost' : 'date';
  } catch {
    return 'date';
  }
}

function saveSimChartMode(mode: SimChartMode): void {
  try {
    localStorage.setItem(SIM_CHART_MODE_KEY, mode);
  } catch {
    // ignore
  }
}

/**
 * Currency display preference. `'AUTO'` means "render only the project's
 * native currency"; any other string is a 3-letter ISO 4217 code (e.g.
 * `'EUR'`, `'CAD'`) and triggers dual-currency display via `formatMoneyDual`.
 * Persisted to localStorage so the user's pick survives navigation and
 * page reloads.
 */
export type CurrencyDisplay = string; // 'AUTO' or ISO 4217

function loadCurrencyDisplay(): CurrencyDisplay {
  try {
    const v = localStorage.getItem(CURRENCY_DISPLAY_KEY);
    if (v === null || v === '') return 'AUTO';
    return v;
  } catch {
    return 'AUTO';
  }
}

function saveCurrencyDisplay(value: CurrencyDisplay): void {
  try {
    localStorage.setItem(CURRENCY_DISPLAY_KEY, value);
  } catch {
    // ignore
  }
}

function loadInspectorHidden(): boolean {
  try {
    return localStorage.getItem(INSPECTOR_HIDDEN_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveInspectorHidden(hidden: boolean): void {
  try {
    localStorage.setItem(INSPECTOR_HIDDEN_KEY, String(hidden));
  } catch {
    // ignore
  }
}

function loadHasSeenOnboarding(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_SEEN_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveHasSeenOnboarding(seen: boolean): void {
  try {
    localStorage.setItem(ONBOARDING_SEEN_KEY, String(seen));
  } catch {
    // ignore
  }
}

function loadHasSeenTemplatePicker(): boolean {
  try {
    return localStorage.getItem(TEMPLATE_PICKER_SEEN_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveHasSeenTemplatePicker(seen: boolean): void {
  try {
    localStorage.setItem(TEMPLATE_PICKER_SEEN_KEY, String(seen));
  } catch {
    // ignore
  }
}

/**
 * Phase 41 — read the persisted Inspector section open/closed map and merge
 * it onto the current defaults. Unknown keys in storage are dropped; missing
 * keys fall back to defaults so adding a section later doesn't hide it for
 * returning users. A corrupt / unreadable blob returns defaults.
 */
function loadInspectorSections(): Record<InspectorSectionId, boolean> {
  try {
    const raw = localStorage.getItem(INSPECTOR_SECTIONS_KEY);
    if (raw === null) return { ...INSPECTOR_SECTION_DEFAULTS };
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') {
      return { ...INSPECTOR_SECTION_DEFAULTS };
    }
    const result: Record<InspectorSectionId, boolean> = { ...INSPECTOR_SECTION_DEFAULTS };
    for (const key of Object.keys(INSPECTOR_SECTION_DEFAULTS) as InspectorSectionId[]) {
      const v = (parsed as Record<string, unknown>)[key];
      if (typeof v === 'boolean') result[key] = v;
    }
    return result;
  } catch {
    return { ...INSPECTOR_SECTION_DEFAULTS };
  }
}

function saveInspectorSections(sections: Record<InspectorSectionId, boolean>): void {
  try {
    localStorage.setItem(INSPECTOR_SECTIONS_KEY, JSON.stringify(sections));
  } catch {
    // ignore
  }
}

function loadResourcePaletteOpen(): boolean {
  try {
    return localStorage.getItem(RESOURCE_PALETTE_OPEN_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveResourcePaletteOpen(open: boolean): void {
  try {
    localStorage.setItem(RESOURCE_PALETTE_OPEN_KEY, String(open));
  } catch {
    // ignore
  }
}

// Phase 49 Slice 8 — defaults TRUE. The localStorage key is only
// present after the user toggles, so a missing key means "never
// touched it" → return the default. An explicit `'false'` value
// means the user opted out and we honour it.
function loadSnapToGrid(): boolean {
  try {
    const raw = localStorage.getItem(SNAP_TO_GRID_KEY);
    if (raw === null) return true; // never set → default ON
    return raw === 'true';
  } catch {
    return true;
  }
}

function saveSnapToGrid(on: boolean): void {
  try {
    localStorage.setItem(SNAP_TO_GRID_KEY, String(on));
  } catch {
    // ignore
  }
}

interface ViewState {
  selection: ViewSelection;
  selectedLoopId: string | null;
  dragDraft: Record<string, { x: number; y: number }>;
  /** In-flight resize dimensions for subsystem nodes — cleared on onResizeEnd. */
  resizeDraft: Record<string, { width: number; height: number }>;
  activeTab: 'canvas' | 'gantt' | 'resources' | 'simulate' | 'risks';
  darkMode: boolean;
  collapsedGroupIds: ReadonlySet<string>;

  selectNodes(ids: ReadonlyArray<string>): void;
  /** Update only nodeIds, leaving edgeId unchanged. Used by onSelectionChange to avoid clearing edge selection. */
  setSelectedNodeIds(ids: ReadonlyArray<string>): void;
  selectEdge(id: string | null): void;
  selectLoop(id: string): void;
  clearSelection(): void;

  setDragDraft(nodeId: string, position: { x: number; y: number }): void;
  clearDragDraft(nodeId: string): void;
  clearAllDragDrafts(): void;
  setResizeDraft(nodeId: string, size: { width: number; height: number }): void;
  clearResizeDraft(nodeId: string): void;

  setActiveTab(tab: 'canvas' | 'gantt' | 'resources' | 'simulate' | 'risks'): void;

  toggleDarkMode(): void;
  toggleGroupCollapse(groupId: string): void;

  /**
   * Phase 12 — Drill-in breadcrumb.  Empty = top-level canvas.
   * Each entry is a subsystem the user has drilled into.
   */
  breadcrumb: ReadonlyArray<BreadcrumbEntry>;
  /** Drill into a sub-system, pushing it onto the breadcrumb. */
  drillIntoSubsystem(subsystemId: string, label: string): void;
  /**
   * Navigate back to the given breadcrumb index.
   * Pass -1 (or any negative) to go all the way back to the root.
   */
  drillOutTo(index: number): void;

  /** Whether to show group color stripes + badges on canvas nodes. */
  showGroupColors: boolean;
  toggleGroupColors(): void;

  /**
   * Phase 33 Slice 2 follow-up — Gantt time-axis zoom level. Multiplies
   * the base day-pixel width. Discrete steps: 0.025, 0.05, 0.075, 0.1,
   * 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3. Phase 47 Slice 2 added the
   * 0.025–0.35 low end so multi-year and multi-decade projects (e.g. a
   * 15-year oncology development arc) fit on a single viewport.
   * Session-only. Default 1.0 matches the legacy fixed width (28 px / day).
   */
  ganttZoom: number;
  zoomGanttIn(): void;
  zoomGanttOut(): void;
  resetGanttZoom(): void;
  /**
   * Phase 47 Slice 2 — set ganttZoom explicitly. Used by the "Fit to
   * view" button which computes the zoom from container width / project
   * day count. Clamped to a sensible range (snaps to the same min/max
   * as the discrete-step controls).
   */
  setGanttZoom(zoom: number): void;

  /**
   * Phase 47 Slice 2 — Gantt label column (left-pane) width in pixels.
   * Resizable via a drag handle on the column's right edge; persisted to
   * localStorage so the user's preferred width survives reloads. Default
   * 188 matches the pre-Slice-2 hardcoded `LABEL_WIDTH`. Clamped to
   * [120, 480] in the setter.
   */
  ganttLabelWidth: number;
  setGanttLabelWidth(px: number): void;

  /**
   * Phase 47 Slice 2 — Resources tab time-axis zoom (stacked + per-
   * resource subtabs). Discrete steps `[1, 2, 4, 8]`; default 1 keeps
   * the chart fitting the container. Above 1 the chart wraps in a
   * horizontal-scroll container so the user can pan across days.
   * Session-only — Resources view is glanced at, not tuned over time.
   */
  resourcesZoom: number;
  zoomResourcesIn(): void;
  zoomResourcesOut(): void;
  resetResourcesZoom(): void;

  /**
   * Phase 47 Slice 2 — resource ids hidden from the Allocation timeline's
   * stacked totals. Click a pool chip above the chart to toggle. Session-
   * only — a hide is a "focus on the others" intent, not a long-lived
   * preference.
   */
  hiddenResourceIds: ReadonlySet<string>;
  toggleResourceHidden(resourceId: string): void;
  clearHiddenResources(): void;

  // Audit I-18 / backlog Slice 6 — `groupColors` + `setGroupColor` moved to
  // domainStore (`project.groupColors`, `updateGroupColor`). They were
  // transient session state here, so colors were lost on reload and weren't
  // undoable. Project-schema-resident now.

  /** Phase 12 — Gantt: sub-system group rows that are currently collapsed. */
  collapsedSubsystemIds: ReadonlySet<string>;
  toggleSubsystemCollapse(subsystemId: string): void;

  /** Simulation run history — newest first, capped at 5. */
  simHistory: readonly SimRun[];
  addSimRun(run: SimRun): void;
  clearSimHistory(): void;
  /**
   * Wipe everything the SimulateView surfaces as "results": run history,
   * last-error banner, last-run wall-clock. Called from App's project-load
   * handler so a freshly-loaded file doesn't inherit a stale "Latest run"
   * label that belongs to the previous project. Leaves the in-flight
   * status fields (`simRunning` / `simProgress` / `simWarmupMessage`)
   * alone — if a worker is still computing the previous project's run,
   * its completion lands in `simHistory` with a snapshot mismatch and the
   * existing `isStale` banner handles it.
   */
  clearSimulationResults(): void;

  /**
   * Phase 47 Slice 3 follow-up — in-flight simulation status.
   *
   * Hoisted out of SimulateView's local state so the progress bar and
   * cancel button survive tab switches. The simulation itself runs in a
   * persistent Web Worker (see `engineWorker.ts`), so navigation away
   * from the Simulate tab never cancelled the worker — but the local
   * `running` / `progress` state died with the unmounted component,
   * making it look like the sim had cancelled. Persisting here means
   * the user can switch tabs while a long run progresses and find the
   * progress bar still ticking when they return.
   *
   * Session-only — a running sim doesn't survive a page reload anyway
   * (the worker dies with the page).
   */
  simRunning: boolean;
  simProgress: number | null;
  simLastRunMs: number | null;
  simError: string | null;
  /**
   * Witty stand-in for the "0%" label during the parallel path's warm-up
   * window (workers spawning, first shard yet to report). Picked at
   * random on each run start; cleared when the run completes. Hidden
   * the moment `simProgress > 0` so the user sees real progress as soon
   * as it arrives.
   */
  simWarmupMessage: string | null;
  setSimRunning(running: boolean): void;
  setSimProgress(progress: number | null): void;
  setSimLastRunMs(ms: number | null): void;
  setSimError(err: string | null): void;
  setSimWarmupMessage(msg: string | null): void;

  /** Monte Carlo controls — persisted across tab switches. */
  mcIterations: number;
  mcSeed: number;
  setMcIterations(n: number): void;
  setMcSeed(n: number): void;

  /** Phase 19 — Date | Cost toggle on the Simulate tab. Drives the histogram,
   *  cumulative chart, and Risk Drivers card. Persisted to localStorage. */
  simChartMode: SimChartMode;
  setSimChartMode(mode: SimChartMode): void;

  /** Phase 19 slice 4 — currency display target. `'AUTO'` = native only;
   *  any ISO code = dual display. Persisted to localStorage. */
  currencyDisplay: CurrencyDisplay;
  setCurrencyDisplay(value: CurrencyDisplay): void;

  /** Phase 22 — When true, the global right-docked Inspector is suppressed
   *  even if a selection exists. Persisted to localStorage. */
  inspectorHidden: boolean;
  toggleInspectorHidden(): void;
  /**
   * Phase 22 follow-up — force the Inspector visible. Called from
   * double-click handlers (Canvas + Gantt) so users who hid the panel
   * have a self-evident way to re-reveal it without hunting for the
   * header toggle. No-op when already visible.
   */
  revealInspector(): void;

  /**
   * Phase 19 slice 4 follow-up — scale every cached MC run's currency-
   * denominated fields by `factor`. Called from the Project Settings modal
   * when the user changes `project.currency` so the Gantt cost-curve panel
   * (and any other cached display) updates without forcing a re-run.
   */
  scaleSimHistoryCosts(factor: number): void;

  /**
   * Phase 27 — JSON snapshot of the project at the last successful save
   * (or load / template pick). Compared against the current project via
   * `isProjectDirty` to decide whether to warn the user about losing
   * unsaved work when they pick a new project or template.
   *
   * In-memory only (not persisted) — on page reload the user starts
   * with the default-project, which we mark as "saved" at startup so
   * the first un-edited state isn't a false-positive dirty.
   */
  lastSavedJson: string | null;
  /**
   * Record `project` as the new saved snapshot. Called after a successful
   * Save (download), Open (load from disk), or template pick. Cheap O(n)
   * stringify per call — fine because this only fires on user action.
   */
  markProjectSaved(project: ProjectFile): void;
  /**
   * Compare `project` to the last saved snapshot. Used by the "New" /
   * "New from template" entries to decide whether to surface a confirm
   * dialog. Returns true when the project differs from the last save.
   *
   * False-positive scenario (acceptable): undoing back to exactly the
   * saved content produces a different object identity but the same
   * JSON — the comparison is content-based to avoid that confusion.
   */
  isProjectDirty(project: ProjectFile): boolean;

  /**
   * Phase 27 — whether the user has been shown (or dismissed) the
   * template picker at least once. Loaded from localStorage at startup;
   * `markTemplatePickerSeen` sets it to true and persists.
   *
   * Drives the first-run auto-open on AppShell mount when this is false
   * AND the current project is the unmodified default.
   */
  hasSeenTemplatePicker: boolean;
  markTemplatePickerSeen(): void;

  /**
   * First-run onboarding overlay (the empty-canvas welcome card). Loaded
   * from localStorage; `markOnboardingSeen` sets it true and persists, so
   * the card never returns after the user dismisses it or adds content.
   */
  hasSeenOnboarding: boolean;
  markOnboardingSeen(): void;

  /**
   * Phase 41 — open/closed state for the Inspector's node-properties
   * sections. Persisted across reloads so the user's preferred layout
   * sticks. See `InspectorSectionId` for the full list.
   *
   * Defaults: Identity / Duration / Resources open, Cost / Advanced
   * collapsed. New sections added later default to `true` (open) so they
   * are discoverable to returning users.
   */
  inspectorSectionsOpen: Readonly<Record<InspectorSectionId, boolean>>;
  toggleInspectorSection(id: InspectorSectionId): void;
  /**
   * Phase 43 — force a specific Inspector section open (no toggle).
   * Used by the drag-to-assign flow when dropping a pool card on an
   * already-assigned node: the inspector navigates to that pool's row,
   * which requires the Resources section to be open. No-op if already open.
   */
  expandInspectorSection(id: InspectorSectionId): void;

  /**
   * Phase 43 — whether the resource palette band is visible above the
   * canvas. Persisted to localStorage so the user's pick survives reloads.
   * Off by default — the palette is a bulk-assignment affordance, not
   * something every canvas-tab visit needs to consume vertical space for.
   */
  resourcePaletteOpen: boolean;
  toggleResourcePalette(): void;

  /**
   * Phase 49 Slice 8 — snap drag-end node positions + placement-mode
   * drops to a 16 px grid (matching the canvas dot-pattern's `gap={16}`
   * so the grid the user sees IS the snap target). Defaults ON; the
   * user can opt out via the canvas rail's `#` button, and the choice
   * persists in localStorage.
   *
   * React Flow's built-in `snapToGrid` / `snapGrid` props on
   * `<ReactFlow>` handle the drag-end snapping for free, and
   * `rf.screenToFlowPosition(...)` also snaps when the flag is on —
   * which means placement-mode drops are snapped without any extra
   * code in PlacementOverlay. Programmatic moves (align / distribute /
   * auto-layout / paste / comments) are NOT snapped on purpose: they
   * produce intentional positions that snapping would undo.
   */
  snapToGridEnabled: boolean;
  toggleSnapToGrid(): void;

  /**
   * Phase 49 Slice 3 — comment tool placement mode. When true, the next
   * canvas-pane click drops a new comment at the click position and
   * exits the mode (one-shot placement). The floating toolbar's 💬
   * button toggles this; pressing Esc also clears it.
   */
  commentToolActive: boolean;
  setCommentToolActive(active: boolean): void;

  /**
   * Phase 43 — transient hint set by the drag-to-assign flow when the user
   * drops a pool card on an activity node that already has that pool. The
   * Inspector's Resources section watches this field, scrolls the matching
   * assignment row into view, then clears the hint via the setter below.
   * In-memory only — survives across selection changes but not reloads.
   */
  inspectorScrollToAssignmentId: string | null;
  setInspectorScrollToAssignmentId(resourceId: string | null): void;

  /**
   * Phase 45 Slice 1 — transient flag set by bulk project-load paths
   * (template pick, file open, "New project"). A small consumer
   * mounted inside `<ReactFlow>` watches it, calls `rf.fitView(...)`,
   * then clears the flag. Decoupling through the store avoids passing
   * imperative refs from App.tsx into the ReactFlow scope.
   *
   * Why a flag and not "re-fit on every project change": the project
   * reference also changes on every node edit, which would cause the
   * camera to jump every time the user nudges anything. We only want
   * to fit on a fresh load.
   */
  pendingFitView: boolean;
  requestFitView(): void;
  consumeFitView(): void;

  /**
   * Phase 45 Slice 5 — node-placement mode. When non-null, the canvas
   * is in "place this node type" mode: a `<PlacementOverlay />` inside
   * `<ReactFlow>` tracks the cursor and renders a ghost preview; the
   * Add rail flyout and keyboard shortcuts (A/D/S/E) trigger this
   * instead of immediately adding a node at a random offset.
   *
   * Cancelled by Esc, click-outside-canvas, switching tabs, or by the
   * placement-drop itself. Pressing a *different* node-shortcut while
   * active switches the type (no need to cancel-and-restart).
   */
  placementType: 'activity' | 'decision' | 'start' | 'end' | null;
  startPlacement(type: 'activity' | 'decision' | 'start' | 'end'): void;
  setPlacementType(type: 'activity' | 'decision' | 'start' | 'end'): void;
  cancelPlacement(): void;

  /**
   * Phase 45 Slice 5b — current preview position during placement mode,
   * in React Flow coordinates. Anchored at the preview's left-edge
   * midpoint (matches the cursor-anchor convention from Slice 5a).
   *
   * Written by both pointermove (mouse) AND arrow-key nudge (keyboard),
   * which is why it lives in the store rather than in PlacementOverlay's
   * local state. `null` when not in placement mode, or when the user has
   * entered placement via shortcut/flyout and not yet moved the mouse or
   * pressed a directional key — `PlacementOverlay` seeds it to the
   * viewport center on mount so the first arrow press has something to
   * nudge.
   *
   * Cleared by `cancelPlacement` so a fresh placement always seeds anew.
   */
  placementPosition: { x: number; y: number } | null;
  setPlacementPosition(pos: { x: number; y: number }): void;

  /**
   * Phase 49 Slice 4 — wire-on-place. Source nodes the ghost has armed
   * during the active placement, in insertion order. Each entry is the
   * id of an existing project node whose right-side source handle the
   * ghost's anchor passed within `PICKUP_RADIUS` of (see
   * `utils/placement.ts`). The PlacementOverlay renders one dashed
   * ghost edge per entry, and the commit click hands them to the
   * domain action `addNodeWithIncomingEdges` for an atomic drop.
   *
   * Stack semantics:
   *   - push    : idempotent — pushing an already-present id is a no-op
   *               (prevents the same handle creating duplicates as the
   *                cursor re-enters its hit radius).
   *   - pop     : LIFO, called by Esc when at least one source is
   *               armed. Esc with an empty stack falls through to
   *               `cancelPlacement`.
   *   - clear   : called by `cancelPlacement` AND by `startPlacement`
   *               so neither end of the placement lifecycle leaves a
   *               stale stack behind.
   */
  pendingPlacementSources: ReadonlyArray<string>;
  pushPendingPlacementSource(nodeId: string): void;
  popPendingPlacementSource(): void;
  clearPendingPlacementSources(): void;

  /**
   * Phase 45 Slice 5c — id of the node whose quick-name callout is
   * currently open, or `null` when no callout is active. Set by the
   * placement-drop path immediately after a successful drop; cleared by
   * the callout itself on commit (Enter/blur) or cancel (Esc).
   *
   * In-memory only — the callout is purely transient interaction state
   * and shouldn't survive reloads or enter undo history.
   */
  namingNodeId: string | null;
  startNaming(nodeId: string): void;
  endNaming(): void;

  /**
   * Phase 37 Slice 1 — transient toast notifications.
   *
   * Lives in the view store because toasts are ephemeral UI feedback, not
   * persisted state (they never enter the `.cala` file or the undo history).
   * The queue is capped at MAX_VISIBLE_TOASTS — once full, pushing a new one
   * drops the oldest. Each toast carries its own id (caller-stable, used by
   * the rendering component to schedule auto-dismiss and key the React list).
   */
  notifications: ReadonlyArray<Toast>;
  pushToast(input: { kind?: Toast['kind']; text: string }): string;
  dismissToast(id: string): void;
  clearAllToasts(): void;

  /**
   * Phase 50 Slice 9 / audit C-9 — persistent autosave-disabled banner.
   *
   * Set by `lib/autosave.ts` when an autosave write fails (Quota exceeded,
   * Safari private-mode storage block, or generic IDB rejection). Cleared
   * automatically on the next successful write. Also dismissable by the
   * user via the banner's × button — re-arms on the next failure.
   *
   * Holds a short human-readable message describing the failure mode so
   * the banner can be specific ("Browser storage is full — free some
   * space" vs the generic "Autosave disabled").
   */
  autosaveError: { message: string } | null;
  setAutosaveError(message: string | null): void;

  /**
   * Phase 50 Slice 10 / audit C-16 — comment selection (raw ids, no
   * `__comment__` prefix). Tracked SEPARATELY from `selection.nodeIds`
   * because comments don't participate in the Inspector / node-specific
   * UI; the only consumer is the keyboard-Delete fallback, which now
   * deletes selected comments when no nodes / edges / loops are
   * selected. The set is updated by App.tsx's `onSelectionChange`
   * (which filters comments out of the regular `selectedNodeIds`).
   *
   * `clearSelection()` clears this too so a click-elsewhere drops
   * pending-comment deletes alongside the rest.
   */
  selectedCommentIds: ReadonlyArray<string>;
  setSelectedCommentIds(ids: ReadonlyArray<string>): void;

  /**
   * Phase 50 Slice 10 / audit C-16 — id of the comment that should
   * auto-enter edit mode on its next mount. Set by `CommentToolBinder`
   * right after `addComment` so a freshly-placed comment focuses its
   * textarea automatically. Cleared by `CommentNode` on commit / cancel
   * (or when the comment dismounts). Without this flag, every
   * empty-text comment auto-edited on mount — including stale ones
   * loaded from a previous session, which stole keystrokes.
   */
  pendingInitialEditingCommentId: string | null;
  setPendingInitialEditingCommentId(id: string | null): void;
}

export interface Toast {
  id: string;
  /** Visual treatment; default 'info'. */
  kind: 'info' | 'success' | 'warn' | 'error';
  text: string;
  /** Epoch ms when the toast was pushed; primarily for ordering / debugging. */
  createdAt: number;
}

/**
 * Cap the visible queue. The user can fire Cmd-Z rapidly during a
 * bulk-undo session — without a cap the screen would fill with toasts.
 */
export const MAX_VISIBLE_TOASTS = 3;

const initialDarkMode = loadDarkMode();
// Apply on load before first render
// persist:false — module-load is "follow stored preference or OS pref",
// not a user action. Writing here would lock the OS reading into localStorage.
applyDarkMode(initialDarkMode, false);
const initialSimChartMode = loadSimChartMode();
const initialCurrencyDisplay = loadCurrencyDisplay();
const initialInspectorHidden = loadInspectorHidden();
const initialHasSeenTemplatePicker = loadHasSeenTemplatePicker();
const initialHasSeenOnboarding = loadHasSeenOnboarding();
const initialInspectorSections = loadInspectorSections();
const initialResourcePaletteOpen = loadResourcePaletteOpen();
const initialSnapToGrid = loadSnapToGrid();
const initialGanttLabelWidth = loadGanttLabelWidth();

export const useViewStore = create<ViewState>()((set) => ({
  selection: { nodeIds: [], edgeId: null },
  selectedLoopId: null,
  dragDraft: {},
  resizeDraft: {},
  activeTab: 'canvas',
  darkMode: initialDarkMode,
  collapsedGroupIds: new Set<string>(),
  collapsedSubsystemIds: new Set<string>(),
  simHistory: [],
  simRunning: false,
  simProgress: null,
  simLastRunMs: null,
  simError: null,
  simWarmupMessage: null,
  mcIterations: 1_000,
  mcSeed: 42,
  showGroupColors: false,
  ganttZoom: 1,
  ganttLabelWidth: initialGanttLabelWidth,
  resourcesZoom: 1,
  hiddenResourceIds: new Set<string>(),
  // groupColors moved to domainStore — see project.groupColors.
  breadcrumb: [],
  simChartMode: initialSimChartMode,
  currencyDisplay: initialCurrencyDisplay,
  inspectorHidden: initialInspectorHidden,
  lastSavedJson: null,
  hasSeenTemplatePicker: initialHasSeenTemplatePicker,
  hasSeenOnboarding: initialHasSeenOnboarding,
  inspectorSectionsOpen: initialInspectorSections,
  resourcePaletteOpen: initialResourcePaletteOpen,
  snapToGridEnabled: initialSnapToGrid,
  commentToolActive: false,
  inspectorScrollToAssignmentId: null,
  pendingFitView: false,
  placementType: null,
  placementPosition: null,
  pendingPlacementSources: [],
  namingNodeId: null,
  notifications: [],
  autosaveError: null,
  selectedCommentIds: [],
  pendingInitialEditingCommentId: null,

  selectNodes(ids) {
    set({ selection: { nodeIds: ids, edgeId: null }, selectedLoopId: null });
  },
  setSelectedNodeIds(ids) {
    // React Flow's `onSelectionChange` is the syncing path for selection. It
    // can fire with `ids = []` when a loop group is the only RF-selected node
    // (we strip loop groups in App.tsx because their loopId is tracked
    // separately under `selectedLoopId`). If we cleared `selectedLoopId` on
    // every empty sync we'd race-clobber the loop selection that
    // `onNodeClick → selectLoop` just set in the same tick. So only clear it
    // when the user actually selected real nodes.
    set((s) => ({
      selection: { ...s.selection, nodeIds: ids },
      ...(ids.length > 0 ? { selectedLoopId: null } : {}),
    }));
  },
  selectEdge(id) {
    set({ selection: { nodeIds: [], edgeId: id }, selectedLoopId: null });
  },
  selectLoop(id) {
    set({ selection: { nodeIds: [], edgeId: null }, selectedLoopId: id });
  },
  clearSelection() {
    set({
      selection: { nodeIds: [], edgeId: null },
      selectedLoopId: null,
      // Slice 10 — comment selection lives on its own field but is part
      // of the same "user intent: nothing selected" concept, so clear
      // it together.
      selectedCommentIds: [],
    });
  },

  setDragDraft(nodeId, position) {
    set((s) => ({ dragDraft: { ...s.dragDraft, [nodeId]: position } }));
  },
  clearDragDraft(nodeId) {
    set((s) => {
      if (!(nodeId in s.dragDraft)) return s;
      const next = { ...s.dragDraft };
      delete next[nodeId];
      return { dragDraft: next };
    });
  },
  clearAllDragDrafts() {
    set({ dragDraft: {} });
  },
  setResizeDraft(nodeId, size) {
    set((s) => ({ resizeDraft: { ...s.resizeDraft, [nodeId]: size } }));
  },
  clearResizeDraft(nodeId) {
    set((s) => {
      if (!(nodeId in s.resizeDraft)) return s;
      const next = { ...s.resizeDraft };
      delete next[nodeId];
      return { resizeDraft: next };
    });
  },

  setActiveTab(tab) {
    set({ activeTab: tab });
  },

  toggleDarkMode() {
    set((s) => {
      const next = !s.darkMode;
      applyDarkMode(next, true);
      return { darkMode: next };
    });
  },

  toggleGroupCollapse(groupId) {
    set((s) => {
      const next = new Set(s.collapsedGroupIds);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return { collapsedGroupIds: next };
    });
  },

  drillIntoSubsystem(subsystemId, label) {
    set((s) => ({
      breadcrumb: [...s.breadcrumb, { subsystemId, label }],
      // Clear selection when navigating — avoids stale selection in the new view.
      selection: { nodeIds: [], edgeId: null },
      selectedLoopId: null,
    }));
  },

  drillOutTo(index) {
    set((s) => ({
      breadcrumb: index < 0 ? [] : s.breadcrumb.slice(0, index + 1),
      selection: { nodeIds: [], edgeId: null },
      selectedLoopId: null,
    }));
  },

  toggleSubsystemCollapse(subsystemId) {
    set((s) => {
      const next = new Set(s.collapsedSubsystemIds);
      if (next.has(subsystemId)) {
        next.delete(subsystemId);
      } else {
        next.add(subsystemId);
      }
      return { collapsedSubsystemIds: next };
    });
  },

  // Phase 33 Slice 2 follow-up — Gantt zoom. Discrete steps so the
  // pixel widths are predictable and "fit nicely" at every level. The
  // sequence is roughly 1.5× per step, which matches how zoom is
  // exposed in spreadsheet / IDE UIs (no awkward in-between values).
  zoomGanttIn() {
    set((s) => {
      const i = GANTT_ZOOM_STEPS.findIndex((v) => v >= s.ganttZoom - 1e-9);
      const next =
        i < 0 || i >= GANTT_ZOOM_STEPS.length - 1
          ? GANTT_ZOOM_STEPS[GANTT_ZOOM_STEPS.length - 1]!
          : GANTT_ZOOM_STEPS[i + 1]!;
      return { ganttZoom: next };
    });
  },
  zoomGanttOut() {
    set((s) => {
      const i = GANTT_ZOOM_STEPS.findIndex((v) => v >= s.ganttZoom - 1e-9);
      const next = i <= 0 ? GANTT_ZOOM_STEPS[0]! : GANTT_ZOOM_STEPS[i - 1]!;
      return { ganttZoom: next };
    });
  },
  resetGanttZoom() {
    set({ ganttZoom: 1 });
  },
  setGanttZoom(zoom) {
    // Clamp into the discrete-step range. The "Fit" button picks an
    // arbitrary float, but we don't want it falling outside the bounds
    // (or going so small that the first zoom-out tap doesn't shrink).
    const min = GANTT_ZOOM_STEPS[0]!;
    const max = GANTT_ZOOM_STEPS[GANTT_ZOOM_STEPS.length - 1]!;
    set({ ganttZoom: Math.max(min, Math.min(max, zoom)) });
  },

  setGanttLabelWidth(px) {
    const clamped = Math.max(GANTT_LABEL_MIN, Math.min(GANTT_LABEL_MAX, Math.round(px)));
    saveGanttLabelWidth(clamped);
    set({ ganttLabelWidth: clamped });
  },

  zoomResourcesIn() {
    set((s) => {
      const i = RESOURCES_ZOOM_STEPS.findIndex((v) => v >= s.resourcesZoom - 1e-9);
      const next =
        i < 0 || i >= RESOURCES_ZOOM_STEPS.length - 1
          ? RESOURCES_ZOOM_STEPS[RESOURCES_ZOOM_STEPS.length - 1]!
          : RESOURCES_ZOOM_STEPS[i + 1]!;
      return { resourcesZoom: next };
    });
  },
  zoomResourcesOut() {
    set((s) => {
      const i = RESOURCES_ZOOM_STEPS.findIndex((v) => v >= s.resourcesZoom - 1e-9);
      const next = i <= 0 ? RESOURCES_ZOOM_STEPS[0]! : RESOURCES_ZOOM_STEPS[i - 1]!;
      return { resourcesZoom: next };
    });
  },
  resetResourcesZoom() {
    set({ resourcesZoom: 1 });
  },

  toggleResourceHidden(resourceId) {
    set((s) => {
      const next = new Set(s.hiddenResourceIds);
      if (next.has(resourceId)) next.delete(resourceId);
      else next.add(resourceId);
      return { hiddenResourceIds: next };
    });
  },
  clearHiddenResources() {
    set((s) => (s.hiddenResourceIds.size === 0 ? s : { hiddenResourceIds: new Set<string>() }));
  },

  toggleGroupColors() {
    set((s) => ({ showGroupColors: !s.showGroupColors }));
  },

  // setGroupColor moved to domainStore.updateGroupColor (audit I-18).

  addSimRun(run) {
    set((s) => ({
      simHistory: [run, ...s.simHistory].slice(0, 5),
    }));
  },
  setSimRunning(running) {
    set({ simRunning: running });
  },
  setSimProgress(progress) {
    set({ simProgress: progress });
  },
  setSimLastRunMs(ms) {
    set({ simLastRunMs: ms });
  },
  setSimError(err) {
    set({ simError: err });
  },
  setSimWarmupMessage(msg) {
    set({ simWarmupMessage: msg });
  },

  clearSimHistory() {
    set({ simHistory: [] });
  },

  clearSimulationResults() {
    set({
      simHistory: [],
      simError: null,
      simLastRunMs: null,
    });
  },

  setMcIterations(n) {
    set({ mcIterations: n });
  },
  setMcSeed(n) {
    set({ mcSeed: n });
  },
  setSimChartMode(mode) {
    saveSimChartMode(mode);
    set({ simChartMode: mode });
  },
  setCurrencyDisplay(value) {
    saveCurrencyDisplay(value);
    set({ currencyDisplay: value });
  },

  toggleInspectorHidden() {
    set((s) => {
      const next = !s.inspectorHidden;
      saveInspectorHidden(next);
      return { inspectorHidden: next };
    });
  },

  revealInspector() {
    set((s) => {
      if (!s.inspectorHidden) return s;
      saveInspectorHidden(false);
      return { inspectorHidden: false };
    });
  },
  scaleSimHistoryCosts(factor) {
    if (!isFinite(factor) || factor === 1 || factor <= 0) return;
    set((s) => ({
      simHistory: s.simHistory.map((run) => ({
        ...run,
        result: scaleSimulationCosts(run.result, factor),
      })),
    }));
  },

  markProjectSaved(project) {
    set({ lastSavedJson: JSON.stringify(project) });
  },
  isProjectDirty(project): boolean {
    // Read state imperatively (not via `set`) so this selector-style helper
    // can be called from event handlers without subscribing.
    const last: string | null = useViewStore.getState().lastSavedJson;
    if (last === null) return false; // no saved baseline yet — treat as clean
    return JSON.stringify(project) !== last;
  },

  markTemplatePickerSeen() {
    saveHasSeenTemplatePicker(true);
    set({ hasSeenTemplatePicker: true });
  },

  markOnboardingSeen() {
    saveHasSeenOnboarding(true);
    set({ hasSeenOnboarding: true });
  },

  toggleInspectorSection(id) {
    set((state) => {
      const next = {
        ...state.inspectorSectionsOpen,
        [id]: !state.inspectorSectionsOpen[id],
      };
      saveInspectorSections(next);
      return { inspectorSectionsOpen: next };
    });
  },

  expandInspectorSection(id) {
    set((state) => {
      if (state.inspectorSectionsOpen[id]) return state;
      const next = { ...state.inspectorSectionsOpen, [id]: true };
      saveInspectorSections(next);
      return { inspectorSectionsOpen: next };
    });
  },

  toggleResourcePalette() {
    set((state) => {
      const next = !state.resourcePaletteOpen;
      saveResourcePaletteOpen(next);
      return { resourcePaletteOpen: next };
    });
  },

  // Phase 49 Slice 8 — flips the snap-to-grid preference and
  // persists the new value. The rest of the wiring lives in
  // App.tsx (passing the flag to <ReactFlow>'s snapToGrid prop).
  toggleSnapToGrid() {
    set((state) => {
      const next = !state.snapToGridEnabled;
      saveSnapToGrid(next);
      return { snapToGridEnabled: next };
    });
  },

  setCommentToolActive(active) {
    set({ commentToolActive: active });
  },

  setInspectorScrollToAssignmentId(resourceId) {
    set({ inspectorScrollToAssignmentId: resourceId });
  },

  requestFitView() {
    set({ pendingFitView: true });
  },

  consumeFitView() {
    set((state) => (state.pendingFitView ? { pendingFitView: false } : state));
  },

  startPlacement(type) {
    // Clear any in-progress selection so the placement preview is the
    // only thing the user is focused on. Avoids the "selected node moves
    // with arrow keys" path competing with placement.
    //
    // Also clear `placementPosition` so a fresh entry into placement
    // always re-seeds from viewport center; otherwise a previous drop
    // site would briefly flash before pointermove or the overlay's
    // mount-effect updates it.
    //
    // Slice 4 — also clear `pendingPlacementSources` defensively in case
    // a prior placement was abandoned in a way that bypassed
    // `cancelPlacement` (shouldn't happen, but harmless to belt-and-
    // suspender it here).
    set({
      placementType: type,
      placementPosition: null,
      pendingPlacementSources: [],
      selection: { nodeIds: [], edgeId: null },
      selectedLoopId: null,
    });
  },

  setPlacementType(type) {
    // Switching type during placement preserves `placementPosition` —
    // the user has already positioned the ghost; they're just changing
    // the shape. See Slice 5b notes.
    set((state) => (state.placementType === type ? state : { placementType: type }));
  },

  cancelPlacement() {
    set((state) =>
      state.placementType === null &&
      state.placementPosition === null &&
      state.pendingPlacementSources.length === 0
        ? state
        : {
            placementType: null,
            placementPosition: null,
            pendingPlacementSources: [],
          },
    );
  },

  setPlacementPosition(pos) {
    set({ placementPosition: pos });
  },

  // Phase 49 Slice 4 — wire-on-place. See the interface doc-comment for
  // semantics; each action is a single-property set guarded against
  // no-op writes so subscribers don't churn.
  pushPendingPlacementSource(nodeId) {
    set((state) =>
      state.pendingPlacementSources.includes(nodeId)
        ? state
        : { pendingPlacementSources: [...state.pendingPlacementSources, nodeId] },
    );
  },
  popPendingPlacementSource() {
    set((state) =>
      state.pendingPlacementSources.length === 0
        ? state
        : { pendingPlacementSources: state.pendingPlacementSources.slice(0, -1) },
    );
  },
  clearPendingPlacementSources() {
    set((state) =>
      state.pendingPlacementSources.length === 0 ? state : { pendingPlacementSources: [] },
    );
  },

  startNaming(nodeId) {
    set({ namingNodeId: nodeId });
  },
  endNaming() {
    set((state) => (state.namingNodeId === null ? state : { namingNodeId: null }));
  },

  pushToast({ kind = 'info', text }) {
    // crypto.randomUUID is available in every browser supported by this app
    // (it's also used in domainStore for node / edge ids).
    const id = crypto.randomUUID();
    const toast: Toast = { id, kind, text, createdAt: Date.now() };
    set((state) => {
      const next = [...state.notifications, toast];
      // Cap by dropping the oldest entries when over the limit.
      const trimmed =
        next.length > MAX_VISIBLE_TOASTS ? next.slice(next.length - MAX_VISIBLE_TOASTS) : next;
      return { notifications: trimmed };
    });
    return id;
  },

  dismissToast(id) {
    set((state) => ({
      notifications: state.notifications.filter((t) => t.id !== id),
    }));
  },

  clearAllToasts() {
    set({ notifications: [] });
  },

  setAutosaveError(message) {
    set({ autosaveError: message === null ? null : { message } });
  },

  setSelectedCommentIds(ids) {
    set({ selectedCommentIds: ids });
  },

  setPendingInitialEditingCommentId(id) {
    set({ pendingInitialEditingCommentId: id });
  },
}));
