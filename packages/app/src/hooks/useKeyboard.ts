import { useEffect } from 'react';
import { NodeSchema, type ProjectNode } from '@procsim/file-format';
import { redoWithFeedback, undoWithFeedback, useDomainStore } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import { computeAutoLayout } from '../lib/autolayout.js';
import { placeNode } from '../utils/placement.js';
import { downloadProjectFile } from '../fileio.js';

// Phase 49 Slice 6 — tab-navigation list, keyed off the digit keys 1–5.
// Order MUST match the tab order surfaced in `AppShell`; `setActiveTab`
// accepts only these literal strings.
const TAB_KEYS = ['canvas', 'gantt', 'resources', 'simulate', 'risks'] as const;

// Phase 11 — moved to a `caladia:` prefix. The legacy `procsim:clipboard:v1`
// key is read once on first paste so an in-flight clipboard survives the
// upgrade; subsequent copies write under the new key only.
const CLIPBOARD_KEY = 'caladia:clipboard:v1';
const LEGACY_CLIPBOARD_KEY = 'procsim:clipboard:v1';

/**
 * Parse a clipboard payload from localStorage. Same-origin code (browser
 * extensions, future XSS) can write arbitrary JSON into the clipboard key,
 * so every entry is validated against NodeSchema before it can reach the
 * domain store. A malformed array element rejects the whole paste — we
 * never want to push a partially-corrupt set of nodes into the canvas.
 *
 * Exported so the validation contract can be unit-tested directly.
 */
export function parseClipboardPayload(raw: string): ReadonlyArray<ProjectNode> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const validated: ProjectNode[] = [];
  for (const item of parsed) {
    const result = NodeSchema.safeParse(item);
    if (!result.success) return [];
    validated.push(result.data);
  }
  return validated;
}

function readClipboard(): ReadonlyArray<ProjectNode> {
  const raw = localStorage.getItem(CLIPBOARD_KEY) ?? localStorage.getItem(LEGACY_CLIPBOARD_KEY);
  if (!raw) return [];
  return parseClipboardPayload(raw);
}

function writeClipboard(nodes: ReadonlyArray<ProjectNode>): void {
  localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(nodes));
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Global keyboard shortcuts:
 *   ⌘/Ctrl+Z      undo
 *   ⌘/Ctrl+Shift+Z  redo  (also ⌘/Ctrl+Y)
 *   Delete/Backspace  delete selection
 *   ⌘/Ctrl+C      copy selected nodes to clipboard
 *   ⌘/Ctrl+V      paste clipboard (offset by 40,40)
 *   ⌘/Ctrl+S      save (download) the project file — works on any tab / field
 *
 * Canvas-tab shortcuts (no modifier, not in an input):
 *   A             add Activity — enter placement mode
 *   D             add Decision
 *   S             add Start
 *   E             add End  (no-op if one already exists)
 *   C             toggle the comment tool
 *   L             wrap selection as Loop
 *   G             wrap selection as Sub-system
 *   P             toggle the Resource palette
 *   N             toggle snap-to-grid (sNap)
 *   ⇧L            auto-layout (dagre)
 *   ⇧G            toggle group colors
 *
 * Tab navigation (any tab, no modifier, not in an input):
 *   1..5          Canvas / Gantt / Resources / Simulate / Risks
 *
 * Phase 49 Slice 6 — every new shortcut uses an unmodified letter / digit
 * so it never collides with a browser shortcut (Cmd+L = URL bar, Cmd+G =
 * find-next, Cmd+P = print, Cmd+1..9 = switch browser tab) and gates on
 * `!editable` so it never fires inside an input.
 *
 * Copy/paste is a single atomic store write → single undo step for the paste.
 */
export function useKeyboardShortcuts(): void {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      const editable = isEditableTarget(e.target);

      // Add-node shortcuts — canvas tab only, no modifiers, not in an input.
      // Phase 45 Slice 5a — these now enter placement mode (the cursor
      // tracks a ghost preview; left-click places). If placement is
      // already active for a *different* type, the shortcut switches
      // the type instead of re-starting from scratch.
      //
      // Phase 45 Slice 5b — pressing the *same* shortcut while already
      // placing that type confirms the drop at the current preview
      // position (e.g. `A` while placing an Activity → drops). Defensive
      // bail when `placementPosition` is null (PlacementOverlay seeds
      // it on mount, but if for any reason it hasn't yet we'd rather
      // no-op than guess at a position).
      if (!mod && !e.altKey && !editable) {
        // Phase 49 Slice 6 — tab navigation. Plain digits 1–5 switch tab.
        // Sits above the canvas-only gate so it works on every tab. Note:
        // shift-digits produce different `e.key` values ("!", "@", …) so
        // a SHIFTED digit doesn't trigger; no explicit shiftKey check
        // needed.
        if (e.key >= '1' && e.key <= '5') {
          e.preventDefault();
          const idx = parseInt(e.key, 10) - 1;
          const target = TAB_KEYS[idx];
          if (target) useViewStore.getState().setActiveTab(target);
          return;
        }

        const view = useViewStore.getState();
        if (view.activeTab === 'canvas') {
          const lower = e.key.toLowerCase();
          const startOrSwitch = (type: 'activity' | 'decision' | 'start' | 'end'): void => {
            if (view.placementType === type) {
              const pos = view.placementPosition;
              if (!pos) return;
              const newId = placeNode(type, pos);
              view.cancelPlacement();
              // Slice 5c — open the quick-name callout on drop.
              if (newId) view.startNaming(newId);
              return;
            }
            if (view.placementType) {
              view.setPlacementType(type);
            } else {
              view.startPlacement(type);
            }
          };
          if (lower === 'a') {
            e.preventDefault();
            startOrSwitch('activity');
            return;
          }
          if (lower === 'd') {
            e.preventDefault();
            startOrSwitch('decision');
            return;
          }
          if (lower === 's') {
            e.preventDefault();
            startOrSwitch('start');
            return;
          }
          if (lower === 'e') {
            // End node is single-cardinality — if one already exists,
            // don't enter placement mode at all (would be a dead end).
            const project = useDomainStore.getState().project;
            const hasEnd = project.nodes.some((n) => n.nodeType === 'end');
            if (hasEnd) return;
            e.preventDefault();
            startOrSwitch('end');
            return;
          }
          // I-22 — C / L / G / P (and N) are unrelated to active node
          // placement; while a placement is in flight, swallow them so
          // a stray keystroke doesn't toggle the comment tool, wrap the
          // selection, or pop the resource palette mid-drop. The
          // A / D / S / E handlers above intentionally remain
          // placement-aware (they switch between placement types).
          if (view.placementType) return;

          if (lower === 'c') {
            // Toggle the comment tool. Distinct from the add-node
            // shortcuts above — comments aren't ProjectNodes, so they
            // don't go through the placement system; the toolbar 💬
            // and this key flip the same viewStore flag.
            e.preventDefault();
            view.setCommentToolActive(!view.commentToolActive);
            return;
          }

          // Phase 49 Slice 6 — rail shortcuts. `L` / `G` pair the
          // most-used wraps with their less-common shift-modified
          // siblings (`⇧L` = Layout, `⇧G` = Group colors) so each
          // mnemonic letter covers both "do the thing" and "tweak
          // related diagram state". Gating mirrors the rail buttons
          // (`canGroupAsLoop` / `canWrapAsSubsystem` in AppShell);
          // a shortcut on a non-eligible selection is a silent no-op,
          // matching how the disabled rail button feels.
          if (lower === 'l') {
            e.preventDefault();
            if (e.shiftKey) {
              // ⇧L — auto-layout. Pure compute + batched commit; the
              // result is one undo step via `updateNodePositions`.
              const domain = useDomainStore.getState();
              const positions = computeAutoLayout(
                domain.project.nodes,
                domain.project.edges,
                domain.project.loops,
              );
              domain.updateNodePositions(positions);
            } else {
              // L — wrap selection as Loop. Matches canGroupAsLoop.
              const { selection } = view;
              if (selection.nodeIds.length === 0) return;
              const project = useDomainStore.getState().project;
              const inLoop = new Set(project.loops.flatMap((l) => l.bodyNodeIds));
              if (selection.nodeIds.some((id) => inLoop.has(id))) return;
              const loopId = useDomainStore.getState().addLoop(selection.nodeIds);
              view.selectLoop(loopId);
            }
            return;
          }
          if (lower === 'g') {
            e.preventDefault();
            if (e.shiftKey) {
              // ⇧G — group-colors toggle. Pure view flag.
              view.toggleGroupColors();
            } else {
              // G — wrap selection as Sub-system. Matches
              // canWrapAsSubsystem: 2+ selected, none already in a
              // sub-system, none themselves a sub-system. On
              // wrapSelectedAsSubsystem error (string return value)
              // surface via toast — keyboard path doesn't have
              // access to AppShell's local error-banner setter.
              const { selection } = view;
              if (selection.nodeIds.length < 2) return;
              const project = useDomainStore.getState().project;
              const inSub = new Set(project.subsystems.flatMap((s) => s.bodyNodeIds));
              const nodeTypes = new Map(project.nodes.map((n) => [n.id, n.nodeType]));
              const ok = selection.nodeIds.every(
                (id) => !inSub.has(id) && nodeTypes.get(id) !== 'subsystem',
              );
              if (!ok) return;
              const err = useDomainStore.getState().wrapSelectedAsSubsystem(selection.nodeIds);
              if (err) view.pushToast({ kind: 'error', text: err });
            }
            return;
          }
          if (lower === 'p') {
            // P — toggle the Resource palette. Canvas-only by gate.
            e.preventDefault();
            view.toggleResourcePalette();
            return;
          }
          if (lower === 'n') {
            // N — toggle snap-to-grid (mnemonic: sNap). Canvas-only
            // by gate; mirrors the `#` rail button.
            e.preventDefault();
            view.toggleSnapToGrid();
            return;
          }
        }
      }

      // Save — ⌘/Ctrl+S downloads the project as a .cala file, same as the
      // Caladia menu's "Save". Fires on every tab and even inside inputs (so
      // it always blocks the browser's native "Save Page As" dialog), unlike
      // the letter shortcuts which gate on `!editable`.
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        const project = useDomainStore.getState().project;
        downloadProjectFile(project);
        useViewStore.getState().markProjectSaved(project);
        return;
      }

      // Undo / redo — route through the feedback wrappers so each keystroke
      // surfaces a toast naming the rolled-back / re-applied action.
      if (mod && e.key.toLowerCase() === 'z') {
        if (editable) return;
        e.preventDefault();
        if (e.shiftKey) redoWithFeedback();
        else undoWithFeedback();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        if (editable) return;
        e.preventDefault();
        redoWithFeedback();
        return;
      }

      // Delete selection
      if ((e.key === 'Delete' || e.key === 'Backspace') && !editable) {
        const viewState = useViewStore.getState();
        const { selection, selectedLoopId, selectedCommentIds } = viewState;
        if (selection.nodeIds.length > 0) {
          e.preventDefault();
          useDomainStore.getState().deleteNodes(selection.nodeIds);
          viewState.clearSelection();
        } else if (selection.edgeId) {
          e.preventDefault();
          useDomainStore.getState().deleteEdges([selection.edgeId]);
          viewState.clearSelection();
        } else if (selectedLoopId) {
          // Delete loop grouping (nodes are kept, only the loop metadata is removed)
          e.preventDefault();
          useDomainStore.getState().deleteLoop(selectedLoopId);
          viewState.clearSelection();
        } else if (selectedCommentIds.length > 0) {
          // Phase 50 Slice 10 / audit C-16 — comments-only deletion path.
          // The previous lack of a delete path meant off-canvas empty
          // comments were unreachable (the hover × button is the only
          // alternative and it's only visible on the comment's own
          // bounding box). Selected via marquee or click-then-Delete now
          // works for one or many comments at a time.
          e.preventDefault();
          const domain = useDomainStore.getState();
          for (const cid of selectedCommentIds) domain.deleteComment(cid);
          viewState.setSelectedCommentIds([]);
        }
        return;
      }

      // Copy
      if (mod && e.key.toLowerCase() === 'c' && !editable) {
        const { selection } = useViewStore.getState();
        if (selection.nodeIds.length === 0) return;
        const selected = new Set(selection.nodeIds);
        const project = useDomainStore.getState().project;
        const toCopy = project.nodes.filter((n) => selected.has(n.id));
        if (toCopy.length > 0) writeClipboard(toCopy);
        return;
      }

      // Paste
      if (mod && e.key.toLowerCase() === 'v' && !editable) {
        const clip = readClipboard();
        if (clip.length === 0) return;
        e.preventDefault();
        const newIds = useDomainStore.getState().pasteNodes(clip, { x: 40, y: 40 });
        useViewStore.getState().selectNodes(newIds);
        return;
      }
    }

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
