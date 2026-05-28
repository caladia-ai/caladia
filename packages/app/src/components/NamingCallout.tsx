import { useEffect, useRef } from 'react';
import { useReactFlow, useViewport, ViewportPortal } from '@xyflow/react';
import { abortEdit, beginEdit, commitEdit, useDomainStore } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import { GHOST_H, GHOST_W } from '../utils/placement.js';

/**
 * Phase 45 Slice 5c — quick-name callout shown immediately after a
 * placement drop. Triggered by `viewStore.namingNodeId` going non-null
 * (the placement-drop path sets it; see PlacementOverlay click,
 * CanvasKeyboardShortcuts Enter, useKeyboard same-shortcut).
 *
 * Interaction:
 *   - Auto-focus + select-all on appear so the user can type to replace.
 *   - Each keystroke writes via `updateNodeName` inside a domain edit
 *     session, so the entire rename collapses to one undo entry.
 *   - Enter or blur → `commitEdit()` + close.
 *   - Esc → restore the original name, then `abortEdit()` + close.
 *
 * Position:
 *   - Centered horizontally on the node, rendered below by default.
 *   - Auto-flips above when the node sits low enough in the visible
 *     canvas that the below-placement would overflow off-screen.
 *
 * Must be mounted inside `<ReactFlow>` so `useReactFlow` / `useViewport`
 * / `ViewportPortal` work. `ViewportPortal` renders in flow coords so
 * the callout tracks the node through pan / zoom automatically.
 */

const CALLOUT_W = 180; // flow units (= CSS px at zoom 1)
const CALLOUT_H = 36;
const GAP = 6;

export function NamingCallout() {
  const namingNodeId = useViewStore((s) => s.namingNodeId);
  const endNaming = useViewStore((s) => s.endNaming);
  const node = useDomainStore((s) =>
    namingNodeId ? (s.project.nodes.find((n) => n.id === namingNodeId) ?? null) : null,
  );
  const updateNodeName = useDomainStore((s) => s.updateNodeName);
  const inputRef = useRef<HTMLInputElement>(null);
  const originalNameRef = useRef<string | null>(null);
  const rf = useReactFlow();
  // Subscribe to viewport so the auto-flip recomputes on pan / zoom while
  // the callout is open. Without this, panning the node out of view
  // wouldn't trigger a re-render here.
  useViewport();

  // Snapshot original name on open; open an edit session so rapid
  // keystrokes collapse into one undo entry. The cleanup commits any
  // pending edits (safer than discarding on unexpected unmount — Esc
  // is the explicit "revert" path).
  useEffect(() => {
    if (!namingNodeId) return;
    const current = useDomainStore.getState().project.nodes.find((n) => n.id === namingNodeId);
    if (!current) return;
    originalNameRef.current = current.name;
    beginEdit();
    // Defer focus to after paint so the input is mounted and visible.
    queueMicrotask(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
    return () => {
      commitEdit();
      originalNameRef.current = null;
    };
  }, [namingNodeId]);

  if (!namingNodeId || !node) return null;

  // Auto-flip: if rendering below would push the callout's bottom edge
  // off the visible canvas, flip above. Calculation is done in screen
  // pixels to keep the comparison zoom-correct: node bottom in screen
  // px + (callout height × zoom + gap) vs pane bottom.
  const pane = document.querySelector('.react-flow__pane');
  let flipAbove = false;
  if (pane instanceof HTMLElement) {
    const paneRect = pane.getBoundingClientRect();
    const nodeBottomScreen = rf.flowToScreenPosition({
      x: node.position.x,
      y: node.position.y + GHOST_H,
    }).y;
    const zoom = rf.getViewport().zoom || 1;
    const calloutScreenH = (CALLOUT_H + GAP) * zoom;
    flipAbove = nodeBottomScreen + calloutScreenH > paneRect.bottom;
  }

  // Center horizontally under (or over) the node. ViewportPortal
  // renders in flow coords, so positions stay in flow units.
  const x = node.position.x + GHOST_W / 2 - CALLOUT_W / 2;
  const y = flipAbove ? node.position.y - CALLOUT_H - GAP : node.position.y + GHOST_H + GAP;

  return (
    <ViewportPortal>
      <div className="absolute" style={{ left: x, top: y, width: CALLOUT_W }}>
        <input
          ref={inputRef}
          type="text"
          defaultValue={node.name}
          onChange={(e) => updateNodeName(node.id, e.target.value)}
          onBlur={() => {
            commitEdit();
            endNaming();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              // Trigger blur → commits + closes via the onBlur handler.
              inputRef.current?.blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              const original = originalNameRef.current;
              if (original !== null) {
                // Revert the in-flight rename. abortEdit() then closes
                // the session without pushing a history entry, so undo
                // history shows just the original add (one ⌘Z removes
                // the freshly-placed node).
                updateNodeName(node.id, original);
              }
              abortEdit();
              endNaming();
            } else {
              // Defence-in-depth: form-field guard in useKeyboard /
              // CanvasKeyboardShortcuts already bails on input targets,
              // but stop propagation so any future shortcut that
              // doesn't honour the guard can't hijack our keystrokes.
              e.stopPropagation();
            }
          }}
          className="w-full px-2 py-1 text-sm rounded border border-emerald-500/70 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
          placeholder="Name…"
          aria-label="Node name"
        />
      </div>
    </ViewportPortal>
  );
}
