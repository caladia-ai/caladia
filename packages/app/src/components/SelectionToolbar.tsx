import { forwardRef, useEffect, useRef, useState } from 'react';
import { NodeToolbar, Position } from '@xyflow/react';
import { useDomainStore } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import {
  alignBottom,
  alignCenter,
  alignLeft,
  alignMiddle,
  alignRight,
  alignTop,
  distributeHorizontally,
  distributeVertically,
  type AlignableNode,
  type PositionUpdates,
} from '../utils/alignment.js';
import { DEFAULT_NODE_H, DEFAULT_NODE_W } from '../utils/placement.js';

/**
 * Floating dark toolbar that appears above the bounding box of selected
 * canvas nodes. Carries the most common multi-select actions: Loop, Wrap as
 * Sub-system, Align ▾, Delete. Loop and Wrap remain available on the rail
 * too — this is just the contextual shortcut.
 *
 * Renders nothing when no nodes are selected. Edge / loop selections are
 * unaffected (those still surface their own panels).
 *
 * Phase 49 Slice 5 — "Align ▾" opens a 2×3 popover of icon buttons.
 * Rows mirror the user's natural reading of the icons (the reference
 * line in each glyph names the row):
 *   Top row    (icons show a HORIZONTAL rail): Top  / Middle / Bottom
 *                                              — these collapse y; the
 *                                                selection ends up on a
 *                                                horizontal line.
 *   Bottom row (icons show a VERTICAL   rail): Left / Center / Right
 *                                              — these collapse x; the
 *                                                selection ends up on a
 *                                                vertical column.
 * Each option computes a position-updates payload via the pure helpers
 * in `utils/alignment.ts` and applies it through the existing batch
 * domain action `updateNodePositions` — so the move lands as one undo
 * step. Already-aligned input produces an empty payload and is a no-op.
 *
 * Must be a child of `<ReactFlow>` so `<NodeToolbar>` can compute its
 * position from the selected nodes' bounding box and the viewport transform.
 */
export function SelectionToolbar() {
  const selectedIds = useViewStore((s) => s.selection.nodeIds);
  const project = useDomainStore((s) => s.project);
  const addLoop = useDomainStore((s) => s.addLoop);
  const wrapSelectedAsSubsystem = useDomainStore((s) => s.wrapSelectedAsSubsystem);
  const deleteNodes = useDomainStore((s) => s.deleteNodes);
  const updateNodePositions = useDomainStore((s) => s.updateNodePositions);
  const selectLoop = useViewStore((s) => s.selectLoop);
  const clearSelection = useViewStore((s) => s.clearSelection);

  if (selectedIds.length === 0) return null;

  // ── Gating: same rules the rail uses ──────────────────────────────────────
  const bodyNodeIdSet = new Set(project.loops.flatMap((l) => l.bodyNodeIds));
  const canLoop = selectedIds.every((id) => !bodyNodeIdSet.has(id));

  const subBodyNodeIdSet = new Set(project.subsystems.flatMap((s) => s.bodyNodeIds));
  const selectedNodeTypes = new Map(
    project.nodes.filter((n) => selectedIds.includes(n.id)).map((n) => [n.id, n.nodeType]),
  );
  const canWrap =
    selectedIds.length >= 2 &&
    selectedIds.every(
      (id) => !subBodyNodeIdSet.has(id) && selectedNodeTypes.get(id) !== 'subsystem',
    );

  // Phase 49 Slice 5 — alignment requires 2+ selected nodes (the
  // helpers return `{}` on fewer and the geometry isn't meaningful).
  const canAlign = selectedIds.length >= 2;
  // Phase 49 Slice 8 — distribute requires 3+ (no middle to spread
  // with fewer). Same popover; the row is enabled / disabled based
  // on this flag while alignment stays available at 2.
  const canDistribute = selectedIds.length >= 3;

  function handleLoop() {
    if (!canLoop) return;
    const id = addLoop([...selectedIds]);
    selectLoop(id);
  }

  function handleWrap() {
    if (!canWrap) return;
    wrapSelectedAsSubsystem([...selectedIds]);
  }

  function handleDelete() {
    deleteNodes([...selectedIds]);
    clearSelection();
  }

  function applyAlignment(fn: (nodes: ReadonlyArray<AlignableNode>) => PositionUpdates) {
    // PR #166 v3 — measure each selected node's rendered size from the
    // DOM, not from React Flow's `node.measured`. RF's measured is
    // typed `measured?: { width?: number; height?: number }` (both
    // levels optional) — in practice it was returning undefined for
    // some node types (Decision in particular), silently falling all
    // the way to DEFAULT_NODE_H = 60 and putting nodes with real
    // rendered heights of 120 px ~30 px off their target. The DOM's
    // `offsetWidth / offsetHeight` is always populated, reflects what
    // the user is actually looking at, and is in CSS pixels — which
    // equal flow units regardless of zoom (parent CSS transforms
    // don't affect offset metrics). The schema width / height path is
    // also dropped: when minWidth / minHeight CSS clamps a node
    // larger than what was pinned at resize-end, the rendered size
    // wins, and that's what the user is aligning by eye.
    const alignable: AlignableNode[] = [];
    for (const n of project.nodes) {
      if (!selectedIds.includes(n.id)) continue;
      const el = document.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${CSS.escape(n.id)}"]`,
      );
      alignable.push({
        id: n.id,
        position: n.position,
        width: el?.offsetWidth ?? n.width ?? DEFAULT_NODE_W,
        height: el?.offsetHeight ?? n.height ?? DEFAULT_NODE_H,
      });
    }
    const payload = fn(alignable);
    if (Object.keys(payload).length === 0) return; // no-op (already aligned)
    updateNodePositions(payload);
  }

  return (
    <NodeToolbar nodeId={[...selectedIds]} isVisible position={Position.Top} offset={12}>
      <div
        data-placement-passthrough
        className="inline-flex items-center gap-1 bg-gray-900/95 text-white rounded-full px-2.5 py-1 shadow-[0_8px_24px_rgba(15,23,42,0.18),0_2px_4px_rgba(15,23,42,0.08)] backdrop-blur-sm"
      >
        <span className="px-2 text-[11px] font-semibold text-gray-300">
          {selectedIds.length} selected
        </span>
        <span className="w-px h-4 bg-gray-700" />
        <ToolbarBtn
          onClick={handleLoop}
          disabled={!canLoop}
          title={canLoop ? 'Wrap as Loop' : 'Selected node(s) already in a loop'}
        >
          <span className="text-violet-300">↻</span>
          <span>Loop</span>
        </ToolbarBtn>
        <ToolbarBtn
          onClick={handleWrap}
          disabled={!canWrap}
          title={canWrap ? 'Wrap as Sub-system' : 'Select 2+ nodes (not in a sub-system) to wrap'}
        >
          <span className="text-indigo-300">⊞</span>
          <span>Wrap</span>
        </ToolbarBtn>
        <AlignMenu
          canAlign={canAlign}
          canDistribute={canDistribute}
          onAlign={(fn) => applyAlignment(fn)}
        />
        <span className="w-px h-4 bg-gray-700" />
        <ToolbarBtn onClick={handleDelete} title="Delete selection" danger>
          <span aria-hidden>⌫</span>
        </ToolbarBtn>
      </div>
    </NodeToolbar>
  );
}

// ── Align ▾ trigger + popover ────────────────────────────────────────────────

interface AlignMenuProps {
  canAlign: boolean;
  canDistribute: boolean;
  onAlign: (fn: (nodes: ReadonlyArray<AlignableNode>) => PositionUpdates) => void;
}

function AlignMenu({ canAlign, canDistribute, onAlign }: AlignMenuProps) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Close on outside mousedown + Esc, only while open.
  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (popoverRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // If the user de-selects down to <2 while the popover is open, fold it.
  useEffect(() => {
    if (!canAlign && open) setOpen(false);
  }, [canAlign, open]);

  function pick(fn: (nodes: ReadonlyArray<AlignableNode>) => PositionUpdates) {
    onAlign(fn);
    setOpen(false);
  }

  return (
    <div className="relative">
      <ToolbarBtn
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        disabled={!canAlign}
        title={canAlign ? 'Align selected nodes' : 'Select 2+ nodes to align'}
      >
        <span className="text-emerald-300">⇲</span>
        <span>Align</span>
        <span className="text-gray-400 text-[10px]">▾</span>
      </ToolbarBtn>
      {open && canAlign && (
        <div
          ref={popoverRef}
          role="menu"
          aria-label="Align selected nodes"
          // `w-max` (= `width: max-content`) is load-bearing. With
          // `position: absolute right-0` and no explicit `left` or
          // `width`, the popover's width was defaulting to
          // shrink-to-fit. Combined with `grid-cols-3` (Tailwind:
          // `repeat(3, minmax(0, 1fr))`), the `0` minimum let the
          // grid columns collapse below their content size — the
          // box ended up narrower than the icons, the third column
          // rendered past the right edge with overflow:visible, and
          // the dark backing only covered the collapsed box.
          // `w-max` pins the box to its natural max-content width so
          // it actually wraps the whole grid.
          className="
            absolute bottom-full right-0 mb-2 z-10 w-max
            bg-gray-900/95 text-white rounded-lg shadow-lg backdrop-blur-sm
            p-4 grid grid-cols-3 gap-5
          "
        >
          {/* Phase 49 Slice 8 — Distribute row (top). Spans all 3
              columns; the two distribute buttons sit centred inside
              with the same `gap-5` rhythm so they line up under the
              alignment grid below. Gated separately (3+ selected). */}
          <div className="col-span-3">
            <div className="flex gap-5 justify-center">
              <AlignIconButton
                title={canDistribute ? 'Distribute Horizontally' : 'Select 3+ nodes to distribute'}
                disabled={!canDistribute}
                onClick={() => pick(distributeHorizontally)}
              >
                <DistributeHorizontalIcon />
              </AlignIconButton>
              <AlignIconButton
                title={canDistribute ? 'Distribute Vertically' : 'Select 3+ nodes to distribute'}
                disabled={!canDistribute}
                onClick={() => pick(distributeVertically)}
              >
                <DistributeVerticalIcon />
              </AlignIconButton>
            </div>
            <div className="h-px bg-white/10 mt-4" />
          </div>
          {/* Row 1 — horizontal-rail icons (collapse y; selection ends
              up on a horizontal line). */}
          <AlignIconButton title="Align Top" onClick={() => pick(alignTop)}>
            <AlignTopIcon />
          </AlignIconButton>
          <AlignIconButton title="Align Middle" onClick={() => pick(alignMiddle)}>
            <AlignMiddleIcon />
          </AlignIconButton>
          <AlignIconButton title="Align Bottom" onClick={() => pick(alignBottom)}>
            <AlignBottomIcon />
          </AlignIconButton>
          {/* Row 2 — vertical-rail icons (collapse x; selection ends up
              on a vertical column). */}
          <AlignIconButton title="Align Left" onClick={() => pick(alignLeft)}>
            <AlignLeftIcon />
          </AlignIconButton>
          <AlignIconButton title="Align Center" onClick={() => pick(alignCenter)}>
            <AlignCenterIcon />
          </AlignIconButton>
          <AlignIconButton title="Align Right" onClick={() => pick(alignRight)}>
            <AlignRightIcon />
          </AlignIconButton>
        </div>
      )}
    </div>
  );
}

interface AlignIconButtonProps {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}

function AlignIconButton({ title, onClick, children, disabled }: AlignIconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className="
        inline-flex items-center justify-center
        w-11 h-10 rounded-md
        text-white hover:bg-white/20
        transition-colors
        disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent
      "
    >
      {children}
    </button>
  );
}

// ── Inline alignment-icon glyphs ─────────────────────────────────────────────
// Each is a 16×16 SVG. A reference line + three rectangles of varying
// sizes — the standard alignment-icon vocabulary across Figma /
// Illustrator / Simulink. `currentColor` cascades from the button's
// text color, so dark / light themes are automatic.
//
// `shape-rendering="crispEdges"` opts out of anti-aliasing on the
// integer-pixel rectangles — without it, the 2 px-wide bars looked
// blurry / washed on the dark popover surface. The reference line
// keeps anti-aliasing implicitly (no per-element override) so it
// stays smooth.

function AlignLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <line x1="2" y1="2" x2="2" y2="14" stroke="currentColor" strokeWidth="2" opacity="0.95" />
      <g shapeRendering="crispEdges" fill="currentColor">
        <rect x="3" y="3" width="6" height="2" />
        <rect x="3" y="7" width="10" height="2" />
        <rect x="3" y="11" width="4" height="2" />
      </g>
    </svg>
  );
}

function AlignCenterIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <line x1="8" y1="2" x2="8" y2="14" stroke="currentColor" strokeWidth="2" opacity="0.95" />
      <g shapeRendering="crispEdges" fill="currentColor">
        <rect x="5" y="3" width="6" height="2" />
        <rect x="3" y="7" width="10" height="2" />
        <rect x="6" y="11" width="4" height="2" />
      </g>
    </svg>
  );
}

function AlignRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <line x1="14" y1="2" x2="14" y2="14" stroke="currentColor" strokeWidth="2" opacity="0.95" />
      <g shapeRendering="crispEdges" fill="currentColor">
        <rect x="7" y="3" width="6" height="2" />
        <rect x="3" y="7" width="10" height="2" />
        <rect x="9" y="11" width="4" height="2" />
      </g>
    </svg>
  );
}

function AlignTopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <line x1="2" y1="2" x2="14" y2="2" stroke="currentColor" strokeWidth="2" opacity="0.95" />
      <g shapeRendering="crispEdges" fill="currentColor">
        <rect x="3" y="3" width="2" height="6" />
        <rect x="7" y="3" width="2" height="10" />
        <rect x="11" y="3" width="2" height="4" />
      </g>
    </svg>
  );
}

function AlignMiddleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="2" opacity="0.95" />
      <g shapeRendering="crispEdges" fill="currentColor">
        <rect x="3" y="5" width="2" height="6" />
        <rect x="7" y="3" width="2" height="10" />
        <rect x="11" y="6" width="2" height="4" />
      </g>
    </svg>
  );
}

function AlignBottomIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <line x1="2" y1="14" x2="14" y2="14" stroke="currentColor" strokeWidth="2" opacity="0.95" />
      <g shapeRendering="crispEdges" fill="currentColor">
        <rect x="3" y="7" width="2" height="6" />
        <rect x="7" y="3" width="2" height="10" />
        <rect x="11" y="9" width="2" height="4" />
      </g>
    </svg>
  );
}

// Phase 49 Slice 8 — Distribute icons. No reference rail (that's
// the align-icon vocabulary); instead, three evenly-spaced bars
// on the relevant axis, with a faint baseline connector to signal
// "even spacing along this axis" rather than "alignment to a rail".

function DistributeHorizontalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <line x1="1" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1" opacity="0.5" />
      <g shapeRendering="crispEdges" fill="currentColor">
        <rect x="1" y="3" width="2" height="10" />
        <rect x="7" y="3" width="2" height="10" />
        <rect x="13" y="3" width="2" height="10" />
      </g>
    </svg>
  );
}

function DistributeVerticalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <line x1="8" y1="1" x2="8" y2="15" stroke="currentColor" strokeWidth="1" opacity="0.5" />
      <g shapeRendering="crispEdges" fill="currentColor">
        <rect x="3" y="1" width="10" height="2" />
        <rect x="3" y="7" width="10" height="2" />
        <rect x="3" y="13" width="10" height="2" />
      </g>
    </svg>
  );
}

// ── Toolbar button (shared by Loop / Wrap / Align / Delete) ──────────────────

interface ToolbarBtnProps {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  danger?: boolean;
}

const ToolbarBtn = forwardRef<HTMLButtonElement, ToolbarBtnProps>(function ToolbarBtn(
  { children, onClick, title, disabled, danger },
  ref,
) {
  const base =
    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium transition-colors';
  const skin = danger
    ? 'text-gray-100 hover:bg-rose-500/30 hover:text-rose-200'
    : 'text-gray-100 hover:bg-white/10';
  const dis = disabled ? 'opacity-40 cursor-not-allowed hover:bg-transparent' : '';
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[base, skin, dis].filter(Boolean).join(' ')}
    >
      {children}
    </button>
  );
});
