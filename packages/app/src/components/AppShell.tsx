import { useEffect, useState, type ReactNode } from 'react';
import { loadProjectFile } from '@procsim/file-format';
import type { ProjectFile, TruncationWarning } from '@procsim/file-format';
// Value imports for the parser functions are dynamic — see the
// `await import('@procsim/importers')` inside `handleImport()` below.
// N-10 follow-up: keeps the ~513 KB xlsx + JSZip + fast-xml-parser
// payload out of the initial-page download. Type-only imports stay
// static (erased at build time, no runtime cost).
import type { ImportResult } from '@procsim/importers';
import {
  makeDefaultProject,
  redoWithFeedback,
  undoWithFeedback,
  useDomainStore,
  useTemporalStore,
} from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import { downloadProjectFile, pickAndReadFile, pickAndReadBinaryFile } from '../fileio.js';
import { ImportModal, ValidateModal } from './ImportModal.js';
import { ProjectSettingsModal } from './ProjectSettingsModal.js';
import { ReplaceProjectConfirmModal } from './ReplaceProjectConfirmModal.js';
import { TemplatePickerModal } from './TemplatePickerModal.js';
import { ToastContainer } from './Toast.js';
import { hasUserContent } from '../utils/projectContent.js';

type Tab = 'canvas' | 'gantt' | 'resources' | 'simulate' | 'risks';

/**
 * Push a non-blocking toast when a project load clipped one or more free-text
 * fields to fit the schema's soft cap. Silent when no truncation happened.
 * Full per-field details (path, original length, truncated length) go to
 * console.warn so a power user can dig in without us cramming it into the
 * toast text.
 */
function surfaceTruncationWarnings(warnings: ReadonlyArray<TruncationWarning> | undefined): void {
  if (!warnings || warnings.length === 0) return;
  const count = warnings.length;
  const text =
    count === 1
      ? `Loaded — 1 long text field was clipped to fit the size limit. See console for details.`
      : `Loaded — ${count} long text fields were clipped to fit size limits. See console for details.`;
  useViewStore.getState().pushToast({ kind: 'warn', text });

  console.warn('[caladia] truncation warnings on load:', warnings);
}

interface AppShellProps {
  project: ProjectFile;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  onError: (msg: string) => void;
  onProjectLoad: (project: ProjectFile) => void;
  onExportCanvasPng?: () => void;
  onExportGanttPng?: () => void;
  onExportScheduleCsv?: () => void;
  onAutoLayout?: () => void;
  /**
   * Phase 34 — handler for the top-bar "Share" button. When set, the
   * button is enabled and triggers the self-contained HTML export.
   * Absent only when the schedule has errors (parent gates on
   * `scheduleOutcome.ok`).
   */
  onShare?: () => void;
  children: ReactNode;
}

const TABS: Tab[] = ['canvas', 'gantt', 'resources', 'simulate', 'risks'];

// Mobile Slice 2 — single-glyph icons for the bottom tab bar (visible
// only at `<md` viewports). Matches the rail's mixed-vocabulary
// convention (Unicode glyphs for layout-like concepts, emoji for
// richer concepts like Resources / Simulate).
const MOBILE_TAB_ICONS: Record<Tab, string> = {
  canvas: '▦', // grid — diagram surface
  gantt: '▤', // horizontal bars — Gantt
  resources: '👥', // people — matches the rail's resource palette glyph
  simulate: '🎲', // dice — signals Monte Carlo / randomness
  risks: '⚠', // warning — risks
};

export function AppShell({
  project,
  activeTab,
  onTabChange,
  onError,
  onProjectLoad,
  onExportCanvasPng,
  onExportGanttPng,
  onExportScheduleCsv,
  onAutoLayout,
  onShare,
  children,
}: AppShellProps) {
  const addLoop = useDomainStore((s) => s.addLoop);
  const wrapSelectedAsSubsystem = useDomainStore((s) => s.wrapSelectedAsSubsystem);

  const hasEndNode = project.nodes.some((n) => n.nodeType === 'end');

  const pastCount = useTemporalStore((s) => s.pastStates.length);
  const futureCount = useTemporalStore((s) => s.futureStates.length);
  // The raw temporal.undo / .redo handles still come out of the temporal
  // store (for the disabled-state checks above), but the click handlers
  // route through the feedback wrappers so undo / redo via the top-bar
  // buttons also surfaces a toast — same behaviour as the keyboard hook.
  const clearTemporal = useTemporalStore((s) => s.clear);

  const selection = useViewStore((s) => s.selection);
  const selectLoop = useViewStore((s) => s.selectLoop);
  const darkMode = useViewStore((s) => s.darkMode);
  const toggleDarkMode = useViewStore((s) => s.toggleDarkMode);
  const inspectorHidden = useViewStore((s) => s.inspectorHidden);
  const toggleInspectorHidden = useViewStore((s) => s.toggleInspectorHidden);
  const showGroupColors = useViewStore((s) => s.showGroupColors);
  const toggleGroupColors = useViewStore((s) => s.toggleGroupColors);
  // Phase 43 — left-rail toggle for the canvas resource palette. Sits in
  // Group 2 with the other view toggles (group colors).
  const resourcePaletteOpen = useViewStore((s) => s.resourcePaletteOpen);
  const toggleResourcePalette = useViewStore((s) => s.toggleResourcePalette);
  const snapToGridEnabled = useViewStore((s) => s.snapToGridEnabled);
  const toggleSnapToGrid = useViewStore((s) => s.toggleSnapToGrid);
  const commentToolActive = useViewStore((s) => s.commentToolActive);
  const setCommentToolActive = useViewStore((s) => s.setCommentToolActive);

  const [addOpen, setAddOpen] = useState(false);
  // Mobile rail collapse — on `<md` the floating rail hides behind a FAB so
  // it doesn't eat canvas width; tapping the FAB opens it as an overlay.
  // Desktop ignores this (the aside always shows; the FAB/backdrop are
  // `md:hidden`).
  const [railOpen, setRailOpen] = useState(false);
  // Single "Caladia ▾" menu (file + contextual export items merged) since
  // the user-facing distinction between File and Export wasn't earning its
  // top-bar real estate — both lived on the right rail of the header.
  const [caladiaMenuOpen, setCaladiaMenuOpen] = useState(false);
  // Mobile Slice 2 — hamburger menu (visible only at `<md` viewports)
  // that holds the Inspector toggle / Settings / Dark-mode buttons that
  // sit inline on desktop. Same DropdownItem pattern as the Caladia menu.
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Phase 27 — template picker modal visibility.
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

  const isProjectDirty = useViewStore((s) => s.isProjectDirty);
  const markProjectSaved = useViewStore((s) => s.markProjectSaved);
  const markTemplatePickerSeen = useViewStore((s) => s.markTemplatePickerSeen);
  const hasSeenTemplatePicker = useViewStore((s) => s.hasSeenTemplatePicker);

  // Phase 27 — first-run auto-open of the template picker. Fires once
  // per browser (localStorage-gated) when the user lands on a fresh,
  // unmodified default project. Skipped on reloads where the user has
  // either already seen the picker or has been editing their project.
  useEffect(() => {
    if (hasSeenTemplatePicker) return;
    if (isProjectDirty(project)) return;
    setTemplatePickerOpen(true);
  }, []);

  /**
   * Pending destructive action: when the project has user content
   * (`hasUserContent` true), Open / New / New from template / Import
   * all queue here and pop the ReplaceProjectConfirmModal instead of
   * running immediately. The modal then either saves and continues,
   * proceeds without saving, or cancels.
   *
   * Pre-feature-flag: this used to be a synchronous `window.confirm`
   * gated only on `isProjectDirty(project)` — see commit history.
   */
  const [pendingDestructive, setPendingDestructive] = useState<{
    label: string;
    proceed: () => void;
  } | null>(null);

  function guardDestructive(label: string, proceed: () => void): void {
    if (!hasUserContent(project)) {
      proceed();
      return;
    }
    setPendingDestructive({ label, proceed });
  }

  function handleNewProject() {
    guardDestructive('New project', () => {
      const blank = makeDefaultProject();
      onProjectLoad(blank);
      markProjectSaved(blank);
      // Phase 50 Slice 9 / audit C-8 — clear undo history so Cmd-Z can't
      // pop the user back into the old project (which is already gone
      // from the autosave write that fires on the project replacement).
      clearTemporal();
      useViewStore.getState().clearSelection();
    });
  }

  function handleOpenTemplatePicker() {
    guardDestructive('Choose a template…', () => {
      setTemplatePickerOpen(true);
    });
  }

  function handleTemplatePick(p: ProjectFile) {
    onProjectLoad(p);
    markProjectSaved(p);
    markTemplatePickerSeen();
    setTemplatePickerOpen(false);
    // Phase 50 Slice 9 / audit C-8 — same as handleNewProject. Without
    // this, the user could Cmd-Z from "I just loaded template X" back
    // into "I had project Y open" — but the autosave already wrote
    // template X, so the surface state and the persistent state would
    // diverge after a reload.
    clearTemporal();
    useViewStore.getState().clearSelection();
  }

  const [importResult, setImportResult] = useState<{
    result: ImportResult;
    fileName: string;
  } | null>(null);
  const [validateState, setValidateState] = useState<{
    fileName: string;
    errors: string[] | null;
  } | null>(null);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);

  // ── Selection-derived gating (matches Toolbar logic) ─────────────────────
  const bodyNodeIdSet = new Set(project.loops.flatMap((l) => l.bodyNodeIds));
  const canGroupAsLoop =
    selection.nodeIds.length >= 1 && selection.nodeIds.every((id) => !bodyNodeIdSet.has(id));

  const subBodyNodeIdSet = new Set(project.subsystems.flatMap((s) => s.bodyNodeIds));
  const selectedNodeTypes = new Map(
    project.nodes.filter((n) => selection.nodeIds.includes(n.id)).map((n) => [n.id, n.nodeType]),
  );
  const canWrapAsSubsystem =
    selection.nodeIds.length >= 2 &&
    selection.nodeIds.every(
      (id) => !subBodyNodeIdSet.has(id) && selectedNodeTypes.get(id) !== 'subsystem',
    );

  // ── Action handlers ──────────────────────────────────────────────────────
  // Phase 45 Slice 5a — flyout picks no longer drop a node at a random
  // offset; they enter placement mode where the cursor tracks a ghost
  // preview and a left-click places. The Add flyout itself is closed
  // by its surrounding onClick (see the rail JSX); placement handles
  // its own cancel paths (Esc / click-outside / different shortcut).
  const startPlacement = useViewStore((s) => s.startPlacement);
  function addActivityAt() {
    startPlacement('activity');
  }
  function addStartAt() {
    startPlacement('start');
  }
  function addEndAt() {
    startPlacement('end');
  }
  function addDecisionAt() {
    startPlacement('decision');
  }

  function handleGroupAsLoop() {
    if (!canGroupAsLoop) return;
    const loopId = addLoop(selection.nodeIds);
    selectLoop(loopId);
  }

  function handleWrapAsSubsystem() {
    if (!canWrapAsSubsystem) return;
    const err = wrapSelectedAsSubsystem(selection.nodeIds);
    if (err) onError(err);
  }

  function handleSave() {
    downloadProjectFile(project);
    // Phase 27 — "Saved" = downloaded a .cala file locally. Stamping the
    // last-saved snapshot here drives the dirty-check used by New project
    // / New from template / first-run auto-open guards.
    markProjectSaved(project);
  }

  function handleOpen() {
    guardDestructive('Open file…', () => {
      void runOpen();
    });
  }

  async function runOpen() {
    const picked = await pickAndReadFile();
    if (!picked.ok) {
      if (picked.error) onError(picked.error);
      return;
    }
    const result = loadProjectFile(picked.content);
    if (!result.ok) {
      const msg = result.errors
        .map((e) => (e.path ? `${e.path}: ${e.message}` : e.message))
        .join(' • ');
      onError(`Could not load file — ${msg}`);
      return;
    }
    onProjectLoad(result.project);
    markProjectSaved(result.project);
    clearTemporal();
    useViewStore.getState().clearSelection();
    surfaceTruncationWarnings(result.truncationWarnings);
  }

  function handleImport() {
    guardDestructive('Import file…', () => {
      void runImport();
    });
  }

  async function runImport() {
    const picked = await pickAndReadBinaryFile('.xml,.xlsx,.xls,.csv,.pptx');
    if (!picked.ok) {
      if (picked.error) onError(picked.error);
      return;
    }
    // Lazy-load the importers chunk on first Import. Vite emits this
    // as the `importers` async chunk (configured in vite.config.ts);
    // the network fetch happens in parallel with the user-perceived
    // file-read so the added latency is hidden.
    const { parseMsProjectXml, parseExcelGantt, parsePptxDiagram } =
      await import('@procsim/importers');
    let result: ImportResult;
    const { buffer, ext, fileName } = picked;
    if (ext === '.xml') {
      const text = new TextDecoder().decode(buffer);
      result = parseMsProjectXml(text);
    } else if (ext === '.pptx') {
      result = await parsePptxDiagram(buffer);
    } else {
      result = await parseExcelGantt(buffer);
    }
    setImportResult({ result, fileName });
  }

  async function handleValidate() {
    const picked = await pickAndReadFile();
    if (!picked.ok) {
      if (picked.error) onError(picked.error);
      return;
    }
    const fileName = 'project file';
    setValidateState({ fileName, errors: null });
    const result = loadProjectFile(picked.content);
    if (result.ok) {
      setValidateState({ fileName, errors: [] });
    } else {
      setValidateState({
        fileName,
        errors: result.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)),
      });
    }
  }

  const hasExports =
    (activeTab === 'canvas' && (onExportCanvasPng ?? onExportScheduleCsv)) ||
    (activeTab === 'gantt' && (onExportGanttPng ?? onExportScheduleCsv)) ||
    onExportScheduleCsv;

  const projectName = project.project.name || 'Untitled';
  const isCanvas = activeTab === 'canvas';
  const isGantt = activeTab === 'gantt';
  // Group colors render on both canvas (node borders) and gantt (row tints);
  // the toggle is meaningless on Resources and Simulate.
  const isCanvasOrGantt = isCanvas || isGantt;
  // The drill-in breadcrumb (rendered in App.tsx's canvas tab) takes ~28px
  // at the top of the body div. The floating toolbar's anchor parent is
  // the body div, so without an offset the toolbar's `top-3` lands right
  // on top of the breadcrumb strip. Shift the toolbar down when drilled
  // in so the breadcrumb stays readable.
  const breadcrumbDepth = useViewStore((s) => s.breadcrumb.length);
  const drilledIn = isCanvas && breadcrumbDepth > 0;

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* ── Top bar ───────────────────────────────────────────────────── */}
      <header className="h-[60px] shrink-0 flex items-center gap-3 px-4 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div className="inline-flex items-center gap-2.5 flex-1 min-w-0">
          <div className="relative">
            <button
              onClick={() => setCaladiaMenuOpen((o) => !o)}
              aria-expanded={caladiaMenuOpen}
              className="inline-flex items-center gap-1.5 text-sm font-bold text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 rounded px-1.5 py-1 transition-colors"
              title="File menu"
            >
              <span className="text-[16px] text-emerald-600 dark:text-emerald-500">◇</span>
              Caladia
              <span aria-hidden className="text-[10px] text-gray-400 dark:text-gray-500 ml-0.5">
                ▾
              </span>
            </button>
            {caladiaMenuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setCaladiaMenuOpen(false)} />
                <div className="absolute left-0 top-full mt-1 z-40 w-48 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg py-1 text-sm">
                  {/* Phase 27 — New / New from template at the top of the
                      menu, above Project settings. */}
                  <DropdownItem
                    onSelect={() => {
                      setCaladiaMenuOpen(false);
                      handleNewProject();
                    }}
                  >
                    New project
                  </DropdownItem>
                  <DropdownItem
                    onSelect={() => {
                      setCaladiaMenuOpen(false);
                      handleOpenTemplatePicker();
                    }}
                  >
                    New from template…
                  </DropdownItem>
                  <DropdownDivider />
                  <DropdownItem
                    onSelect={() => {
                      setCaladiaMenuOpen(false);
                      setProjectSettingsOpen(true);
                    }}
                  >
                    Project settings…
                  </DropdownItem>
                  <DropdownDivider />
                  <DropdownItem
                    onSelect={() => {
                      setCaladiaMenuOpen(false);
                      handleSave();
                    }}
                  >
                    Save
                  </DropdownItem>
                  <DropdownItem
                    onSelect={() => {
                      setCaladiaMenuOpen(false);
                      handleOpen();
                    }}
                  >
                    Open…
                  </DropdownItem>
                  <DropdownDivider />
                  <DropdownItem
                    onSelect={() => {
                      setCaladiaMenuOpen(false);
                      void handleValidate();
                    }}
                  >
                    Validate…
                  </DropdownItem>
                  <DropdownItem
                    onSelect={() => {
                      setCaladiaMenuOpen(false);
                      handleImport();
                    }}
                  >
                    Import…
                  </DropdownItem>
                  {hasExports && (
                    <>
                      <DropdownDivider />
                      <div className="px-4 pt-1 pb-0.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-gray-500 dark:text-gray-400">
                        Export
                      </div>
                      {activeTab === 'canvas' && onExportCanvasPng && (
                        <DropdownItem
                          onSelect={() => {
                            setCaladiaMenuOpen(false);
                            onExportCanvasPng();
                          }}
                        >
                          Canvas → PNG
                        </DropdownItem>
                      )}
                      {activeTab === 'gantt' && onExportGanttPng && (
                        <DropdownItem
                          onSelect={() => {
                            setCaladiaMenuOpen(false);
                            onExportGanttPng();
                          }}
                        >
                          Gantt → PNG
                        </DropdownItem>
                      )}
                      {onExportScheduleCsv && (
                        <DropdownItem
                          onSelect={() => {
                            setCaladiaMenuOpen(false);
                            onExportScheduleCsv();
                          }}
                        >
                          Schedule → CSV
                        </DropdownItem>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
          <span className="h-[18px] w-px bg-gray-200 dark:bg-gray-800" />
          <span className="text-[13px] font-medium text-gray-800 dark:text-gray-200 truncate max-w-[16ch] md:max-w-[28ch]">
            {projectName}
          </span>
          <span className="font-mono text-[11px] text-gray-400 dark:text-gray-500 max-md:hidden">
            .cala
          </span>
        </div>

        {/* Mobile Slice 2 — desktop tab nav hidden on `<md`; tabs move
            to the bottom bar (rendered below the canvas area, before
            the footer) for one-handed reachability. */}
        <nav className="hidden md:inline-flex bg-gray-100 dark:bg-gray-800 rounded-lg p-[3px]">
          {TABS.map((t, i) => (
            <button
              key={t}
              onClick={() => onTabChange(t)}
              // Phase 49 Slice 6 — tabs surface their `1..5` shortcut
              // via the native tooltip. `${i + 1}` matches the
              // `TAB_KEYS` order in `useKeyboard.ts` (single source).
              title={`${t.charAt(0).toUpperCase()}${t.slice(1)} (${i + 1})`}
              className={[
                'px-3.5 py-1.5 text-[13px] font-medium rounded-md transition-colors capitalize',
                t === activeTab
                  ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-[0_1px_2px_rgba(15,23,42,0.06)]'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
              ].join(' ')}
            >
              {t}
            </button>
          ))}
        </nav>

        <div className="inline-flex items-center gap-1.5 flex-1 justify-end max-md:flex-none">
          {/* File and Export are merged under the Caladia menu (Phase 18
              slice 2 follow-up); dark-mode toggle moved here from the
              footer so it sits with the other top-of-page chrome.
              Mobile Slice 2 — on `<md` viewports these three icon
              buttons collapse into the hamburger dropdown below. */}
          <div className="hidden md:inline-flex items-center gap-1.5">
            <button
              type="button"
              onClick={toggleInspectorHidden}
              title={inspectorHidden ? 'Show Inspector panel' : 'Hide Inspector panel'}
              aria-label={inspectorHidden ? 'Show Inspector panel' : 'Hide Inspector panel'}
              aria-pressed={!inspectorHidden}
              className="w-9 h-9 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 inline-flex items-center justify-center text-[16px] transition-colors"
            >
              {inspectorHidden ? '◫' : '◨'}
            </button>
            {/* Phase 41 Slice 3 — direct entry point to Project Settings,
                mirrors the Caladia ▾ → "Project settings…" item. Same modal,
                same state hook; the menu entry stays for menu-driven users. */}
            <button
              type="button"
              onClick={() => setProjectSettingsOpen(true)}
              title="Project settings"
              aria-label="Open project settings"
              className="w-9 h-9 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 inline-flex items-center justify-center text-[16px] transition-colors"
            >
              ⚙
            </button>
            <button
              type="button"
              onClick={toggleDarkMode}
              title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              className="w-9 h-9 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 inline-flex items-center justify-center text-[16px] transition-colors"
            >
              {darkMode ? '☀' : '🌙'}
            </button>
          </div>

          {/* Mobile hamburger — collapses the three icon buttons above
              on `<md`. Same DropdownItem pattern as the Caladia menu. */}
          <div className="md:hidden relative">
            <button
              type="button"
              onClick={() => setMobileMenuOpen((o) => !o)}
              title="More"
              aria-label="More actions"
              aria-expanded={mobileMenuOpen}
              className="w-9 h-9 max-md:w-11 max-md:h-11 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 inline-flex items-center justify-center text-[18px] transition-colors"
            >
              ☰
            </button>
            {mobileMenuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMobileMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-40 w-48 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg py-1 text-sm">
                  <DropdownItem
                    onSelect={() => {
                      setMobileMenuOpen(false);
                      toggleInspectorHidden();
                    }}
                  >
                    {inspectorHidden ? 'Show Inspector' : 'Hide Inspector'}
                  </DropdownItem>
                  <DropdownItem
                    onSelect={() => {
                      setMobileMenuOpen(false);
                      setProjectSettingsOpen(true);
                    }}
                  >
                    Project settings…
                  </DropdownItem>
                  <DropdownItem
                    onSelect={() => {
                      setMobileMenuOpen(false);
                      toggleDarkMode();
                    }}
                  >
                    {darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                  </DropdownItem>
                </div>
              </>
            )}
          </div>

          <button
            disabled={!onShare}
            onClick={onShare}
            aria-label="Share"
            title={
              onShare
                ? 'Download a self-contained HTML snapshot of your plan'
                : 'Sharing is disabled while the schedule has errors'
            }
            className="ml-0.5 inline-flex items-center justify-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-3.5 py-2 max-md:w-11 max-md:h-11 max-md:px-0 max-md:py-0 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <span aria-hidden>↗</span>
            <span className="max-md:sr-only">Share</span>
          </button>
        </div>
      </header>

      {/* ── Body: floating toolbar (canvas only) + main ────────────────
          Phase 49 Slice 2 — the rail is no longer a flex sibling; it
          floats over the canvas (Excalidraw-style, not movable). Main
          reclaims the full body width. Body wrapper is `relative` so
          the absolute-positioned aside anchors against it.

          Visible only on the Canvas tab — on data tabs (Gantt /
          Simulate / Resources / Risks) the toolbar would overlap the
          top stats cards and the rail's buttons are mostly canvas-only
          anyway. Undo/Redo stay accessible via ⌘Z / ⌘⇧Z everywhere. */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Mobile — FAB that opens the rail; hidden once the rail is open. */}
        {isCanvas && !railOpen && (
          <button
            type="button"
            onClick={() => setRailOpen(true)}
            aria-label="Editing tools"
            className={`md:hidden absolute ${drilledIn ? 'top-10' : 'top-3'} left-3 z-20 w-11 h-11 inline-flex items-center justify-center rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-[0_1px_2px_rgba(15,23,42,0.06),0_8px_24px_-8px_rgba(15,23,42,0.15)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.3),0_8px_24px_-8px_rgba(0,0,0,0.5)] text-gray-600 dark:text-gray-400 text-lg`}
          >
            🧰
          </button>
        )}
        {/* Mobile — tap-outside backdrop to collapse the rail. */}
        {isCanvas && railOpen && (
          <div
            className="md:hidden fixed inset-0 z-10"
            onClick={() => setRailOpen(false)}
            aria-hidden
          />
        )}
        {isCanvas && (
          <aside
            className={`${railOpen ? '' : 'max-md:hidden'} absolute ${drilledIn ? 'top-10' : 'top-3'} left-3 z-20 w-[60px] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-[0_1px_2px_rgba(15,23,42,0.06),0_8px_24px_-8px_rgba(15,23,42,0.15)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.3),0_8px_24px_-8px_rgba(0,0,0,0.5)] flex flex-col items-center py-2 gap-1.5`}
          >
            {/* Group 1: Add / Loop / Wrap */}
            <RailGroup>
              <div className="relative">
                <RailButton
                  primary
                  active={addOpen}
                  title={isCanvas ? 'Add node' : 'Add node — canvas tab only'}
                  disabled={!isCanvas}
                  onClick={() => setAddOpen((o) => !o)}
                >
                  ＋
                </RailButton>
                {isCanvas && addOpen && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setAddOpen(false)} />
                    <div className="absolute left-[52px] top-0 z-40 w-[240px] rounded-[10px] border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-[0_8px_24px_rgba(15,23,42,0.10),0_1px_2px_rgba(15,23,42,0.04)] p-2">
                      <div className="px-2 pt-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500 dark:text-gray-400">
                        Add to canvas
                      </div>
                      <FlyoutItem
                        icon="▭"
                        tone="activity"
                        name="Activity"
                        desc="A task with a duration"
                        shortcut="A"
                        onSelect={() => {
                          setAddOpen(false);
                          addActivityAt();
                        }}
                      />
                      <FlyoutItem
                        icon="◆"
                        tone="decision"
                        name="Decision"
                        desc="Probability gate"
                        shortcut="D"
                        onSelect={() => {
                          setAddOpen(false);
                          addDecisionAt();
                        }}
                      />
                      <FlyoutItem
                        icon="▶"
                        tone="start"
                        name="Start"
                        desc="Anchor with a date"
                        shortcut="S"
                        onSelect={() => {
                          setAddOpen(false);
                          addStartAt();
                        }}
                      />
                      <FlyoutItem
                        icon="◎"
                        tone="end"
                        name="End"
                        desc={hasEndNode ? 'Already added' : 'Terminus'}
                        shortcut="E"
                        disabled={hasEndNode}
                        onSelect={() => {
                          setAddOpen(false);
                          if (!hasEndNode) addEndAt();
                        }}
                      />
                    </div>
                  </>
                )}
              </div>

              <RailButton
                title={
                  !isCanvas
                    ? 'Wrap selection as Loop — canvas tab only'
                    : canGroupAsLoop
                      ? 'Wrap selection as Loop (L)'
                      : 'Select node(s) (not already in a loop) to create a Loop'
                }
                disabled={!isCanvas || !canGroupAsLoop}
                onClick={handleGroupAsLoop}
              >
                <span className="text-violet-600 dark:text-violet-400">↻</span>
              </RailButton>

              <RailButton
                title={
                  !isCanvas
                    ? 'Wrap selection as Sub-system — canvas tab only'
                    : canWrapAsSubsystem
                      ? 'Wrap selection as Sub-system (G)'
                      : 'Select 2+ nodes (not already in a sub-system) to wrap'
                }
                disabled={!isCanvas || !canWrapAsSubsystem}
                onClick={handleWrapAsSubsystem}
              >
                <span className="text-indigo-600 dark:text-indigo-400">⊞</span>
              </RailButton>
            </RailGroup>

            <RailSep />

            {/* Group 2: Auto-layout / Groups */}
            <RailGroup>
              <RailButton
                title={
                  isCanvas && onAutoLayout ? 'Auto-layout (⇧L)' : 'Auto-layout — canvas tab only'
                }
                disabled={!isCanvas || !onAutoLayout}
                onClick={onAutoLayout}
              >
                ⬡
              </RailButton>
              {/* Phase 49 Slice 8 — snap-to-grid toggle. Default ON; the
                user can opt out and the choice persists. Canvas-only
                gate matches the other layout-oriented entries in this
                group. Slotted directly below Auto-layout since both
                are layout-shaping controls. */}
              <RailButton
                title={
                  isCanvas
                    ? snapToGridEnabled
                      ? 'Disable snap to grid (N)'
                      : 'Enable snap to grid (N)'
                    : 'Snap to grid — canvas only'
                }
                active={snapToGridEnabled && isCanvas}
                disabled={!isCanvas}
                onClick={toggleSnapToGrid}
              >
                #
              </RailButton>
              <RailButton
                title={
                  isCanvasOrGantt
                    ? showGroupColors
                      ? 'Hide group colors (⇧G)'
                      : 'Show group colors (⇧G)'
                    : 'Group colors — canvas and Gantt only'
                }
                active={showGroupColors && isCanvasOrGantt}
                disabled={!isCanvasOrGantt}
                onClick={toggleGroupColors}
              >
                🏷
              </RailButton>
              {/* Phase 43 — toggle the floating resource palette over the
                canvas. Drag pool cards onto activity nodes to bulk-assign.
                Inactive tooltip reads "Assign Resources" — the action,
                not the chrome — so the rail self-documents at a glance. */}
              <RailButton
                title={
                  isCanvas
                    ? resourcePaletteOpen
                      ? 'Hide resource palette (P)'
                      : 'Assign Resources (P)'
                    : 'Resource palette — canvas only'
                }
                active={resourcePaletteOpen && isCanvas}
                disabled={!isCanvas}
                onClick={toggleResourcePalette}
              >
                👥
              </RailButton>
            </RailGroup>

            <RailSep />

            {/* Phase 49 Slice 3 — comment placement tool. Click to enter
              placement mode; next canvas-pane click drops a new comment
              and exits the mode. Active styling mirrors the resource-
              palette toggle. Canvas-only (this whole aside already is). */}
            <RailGroup>
              <RailButton
                title={
                  commentToolActive
                    ? 'Cancel comment placement (Esc)'
                    : 'Comment — click on the canvas to drop a note (C)'
                }
                active={commentToolActive}
                onClick={() => setCommentToolActive(!commentToolActive)}
              >
                💬
              </RailButton>
            </RailGroup>

            <RailSep />

            {/* Group 4: Undo / Redo */}
            <RailGroup>
              <RailButton
                title="Undo (⌘Z)"
                disabled={pastCount === 0}
                onClick={() => undoWithFeedback()}
              >
                ↶
              </RailButton>
              <RailButton
                title="Redo (⌘⇧Z)"
                disabled={futureCount === 0}
                onClick={() => redoWithFeedback()}
              >
                ↷
              </RailButton>
            </RailGroup>

            {/* Search — sits naturally under Undo/Redo now that the
              panel is content-sized (was previously pushed to the
              bottom via a flex-1 spacer when the rail filled the
              body height; meaningless in the floating layout). */}
            <RailGroup>
              <RailButton title="Search — coming soon" disabled>
                ⌕
              </RailButton>
            </RailGroup>
          </aside>
        )}

        <main className="flex-1 flex flex-col overflow-hidden min-w-0">{children}</main>
      </div>

      {/* ── Mobile bottom tab bar (Slice 2) ───────────────────────────────
          Rendered only on `<md` viewports; the desktop tab nav in the
          header takes over above 768 px. Icon-only with `aria-label`
          for screen readers. 56 px tall for comfortable thumb taps. */}
      <nav className="md:hidden h-14 shrink-0 flex border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        {TABS.map((t, i) => {
          const icon = MOBILE_TAB_ICONS[t];
          const isActive = t === activeTab;
          return (
            <button
              key={t}
              type="button"
              onClick={() => onTabChange(t)}
              aria-label={`${t.charAt(0).toUpperCase()}${t.slice(1)} (${i + 1})`}
              aria-current={isActive ? 'page' : undefined}
              className={[
                'flex-1 inline-flex items-center justify-center text-2xl transition-colors',
                isActive
                  ? 'text-emerald-600 dark:text-emerald-500'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100',
              ].join(' ')}
            >
              {icon}
            </button>
          );
        })}
      </nav>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <footer className="h-[30px] shrink-0 flex items-center px-3 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-xs">
        <div className="flex-1 inline-flex items-center gap-2.5">
          <DiagramHealthIndicator nodeCount={project.nodes.length} />
        </div>
        <div className="flex items-center gap-2.5 text-gray-400 dark:text-gray-500">
          {/* Audit N-24 — in-product link to the marketing-site privacy
              page. Marketing covers privacy in depth; the app just needs
              a discoverable handle so users know it exists. */}
          <a
            href="https://caladia.ai/privacy/"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-gray-600 dark:hover:text-gray-300 focus:outline-none focus:ring-1 focus:ring-violet-400 rounded"
          >
            Privacy
          </a>
          <span aria-hidden="true">·</span>
          {/* Version stamp — Vite-injected from packages/app/package.json
              at build time. Visible in bug reports / screenshots so
              issues are attributable to a build. */}
          <span className="tabular-nums" title="Caladia version">
            v{__APP_VERSION__}
          </span>
        </div>
      </footer>

      {importResult !== null && (
        <ImportModal
          result={importResult.result}
          fileName={importResult.fileName}
          onClose={() => setImportResult(null)}
        />
      )}
      {validateState !== null && (
        <ValidateModal
          errors={validateState.errors}
          fileName={validateState.fileName}
          onClose={() => setValidateState(null)}
        />
      )}
      {projectSettingsOpen && (
        <ProjectSettingsModal project={project} onClose={() => setProjectSettingsOpen(false)} />
      )}
      {templatePickerOpen && (
        <TemplatePickerModal
          onPick={handleTemplatePick}
          onPickBlank={() => handleTemplatePick(makeDefaultProject())}
          onClose={() => {
            // Even on dismissal, mark the picker as seen so first-run
            // auto-open doesn't fire on every reload. The user can still
            // re-open it from the Caladia menu any time.
            markTemplatePickerSeen();
            setTemplatePickerOpen(false);
          }}
        />
      )}
      {pendingDestructive !== null && (
        <ReplaceProjectConfirmModal
          actionLabel={pendingDestructive.label}
          onSaveAndContinue={() => {
            const { proceed } = pendingDestructive;
            downloadProjectFile(project);
            markProjectSaved(project);
            setPendingDestructive(null);
            proceed();
          }}
          onProceedWithoutSaving={() => {
            const { proceed } = pendingDestructive;
            setPendingDestructive(null);
            proceed();
          }}
          onCancel={() => setPendingDestructive(null)}
        />
      )}

      {/* Phase 37 Slice 1 — transient toast notifications. The container
          subscribes to the viewStore queue and renders nothing when empty,
          so this is a zero-cost addition until Slice 2 wires undo/redo to
          start pushing toasts. */}
      <ToastContainer />
    </div>
  );
}

// ── Rail building blocks ─────────────────────────────────────────────────────

function RailGroup({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-1">{children}</div>;
}

function RailSep() {
  return <div className="w-[26px] h-px bg-gray-200 dark:bg-gray-800 my-1" />;
}

interface RailButtonProps {
  children: ReactNode;
  onClick?: (() => void) | undefined;
  title: string;
  primary?: boolean;
  active?: boolean;
  disabled?: boolean;
}

function RailButton({ children, onClick, title, primary, active, disabled }: RailButtonProps) {
  const base =
    'w-9 h-9 max-md:w-11 max-md:h-11 rounded-lg inline-flex items-center justify-center text-base transition-colors';
  const skin = primary
    ? `bg-emerald-600 hover:bg-emerald-700 text-white ${active ? 'ring-2 ring-emerald-600/25' : ''}`
    : `text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100 ${
        active
          ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-1 ring-inset ring-emerald-500/30 dark:ring-emerald-400/40'
          : ''
      }`;
  const dis = disabled ? 'opacity-40 cursor-not-allowed' : '';
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={[base, skin, dis].filter(Boolean).join(' ')}
    >
      {children}
    </button>
  );
}

// ── Flyout item (Add menu) ───────────────────────────────────────────────────

interface FlyoutItemProps {
  icon: string;
  tone: 'activity' | 'decision' | 'start' | 'end';
  name: string;
  desc: string;
  shortcut: string;
  disabled?: boolean;
  onSelect: () => void;
}

function FlyoutItem({ icon, tone, name, desc, shortcut, disabled, onSelect }: FlyoutItemProps) {
  const toneCls = {
    activity: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    decision: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    start: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    end: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  }[tone];
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed text-left transition-colors"
    >
      <span
        className={`w-6 h-6 inline-flex items-center justify-center text-[13px] rounded-[5px] shrink-0 ${toneCls}`}
      >
        {icon}
      </span>
      <span className="flex flex-col flex-1 min-w-0">
        <span className="text-[12.5px] font-medium text-gray-800 dark:text-gray-200">{name}</span>
        <span className="text-[10.5px] text-gray-400 dark:text-gray-500">{desc}</span>
      </span>
      <span className="font-mono text-[10px] text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-1.5 py-px rounded">
        {shortcut}
      </span>
    </button>
  );
}

// ── Dropdown menu primitives ─────────────────────────────────────────────────
// The previous standalone `Dropdown` wrapper was removed when File + Export
// merged under the Caladia button (which composes its own trigger inline).
// `DropdownItem` and `DropdownDivider` are still used inside that menu.

function DropdownItem({ children, onSelect }: { children: ReactNode; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className="w-full text-left px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
    >
      {children}
    </button>
  );
}

function DropdownDivider() {
  return <div className="my-1 border-t border-gray-100 dark:border-gray-800" />;
}

// ── Diagram health indicator (footer) ────────────────────────────────────────

const HEALTH_AMBER = 1000;
const HEALTH_RED = 2000;

function DiagramHealthIndicator({ nodeCount }: { nodeCount: number }) {
  const [open, setOpen] = useState(false);
  const level: 'green' | 'amber' | 'red' =
    nodeCount >= HEALTH_RED ? 'red' : nodeCount >= HEALTH_AMBER ? 'amber' : 'green';

  const dot =
    level === 'red'
      ? 'bg-red-500 shadow-[0_0_0_2px_rgba(239,68,68,0.18)]'
      : level === 'amber'
        ? 'bg-amber-400 shadow-[0_0_0_2px_rgba(251,191,36,0.18)]'
        : 'bg-emerald-500 shadow-[0_0_0_2px_rgba(16,185,129,0.18)]';

  const recommendation =
    level === 'red'
      ? 'Large diagram — consider splitting into sub-systems to improve readability and scheduling performance.'
      : level === 'amber'
        ? 'Medium-sized diagram — wrapping related nodes as sub-systems will keep the canvas readable.'
        : 'Diagram size is healthy.';

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={`${nodeCount} nodes — diagram health`}
        className="inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        <span className={`inline-block w-[7px] h-[7px] rounded-full ${dot}`} />
        {nodeCount} nodes · {level === 'green' ? 'healthy' : level}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 bottom-full mb-1 z-40 w-64 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg p-3 text-xs text-gray-700 dark:text-gray-300">
            <div className="font-semibold mb-1 inline-flex items-center gap-1.5">
              <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
              Diagram Health
            </div>
            <p className="text-gray-500 dark:text-gray-400">{recommendation}</p>
            <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700 text-gray-400 dark:text-gray-500">
              Thresholds: amber ≥ {HEALTH_AMBER} nodes · red ≥ {HEALTH_RED} nodes
            </div>
          </div>
        </>
      )}
    </div>
  );
}
