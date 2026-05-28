import { useEffect, useState } from 'react';
import { useReactFlow, ViewportPortal } from '@xyflow/react';
import { useViewStore } from '../store/viewStore.js';
import { useDomainStore } from '../store/domainStore.js';

// Module-level last-known mouse position. The comment tool needs to
// know the cursor's screen position at activation time so the ghost
// preview can appear immediately under the cursor — before the user
// has to move and trigger the inner `pointermove` listener. A passive
// window listener keeps this fresh between activations at negligible
// cost (one ref write per mousemove). Stays attached for the lifetime
// of the page; reattaching per-activation would defeat the purpose.
const lastMouseScreen: { x: number; y: number; known: boolean } = {
  x: 0,
  y: 0,
  known: false,
};

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointermove',
    (e) => {
      lastMouseScreen.x = e.clientX;
      lastMouseScreen.y = e.clientY;
      lastMouseScreen.known = true;
    },
    { passive: true },
  );
}

/**
 * Phase 49 Slice 3 — listens for canvas clicks while the comment tool
 * is active. A pane click drops a new comment at the click position
 * in flow coords and exits the tool (one-shot placement).
 *
 * Renders a dashed ghost preview of an empty comment at the cursor's
 * flow position so the user can see where the comment will land and
 * how much space it'll occupy. Seeded to the viewport center on
 * activation; `pointermove` over the pane updates it. `ViewportPortal`
 * scales the ghost with zoom automatically.
 *
 * Lives inside `<ReactFlow>` so it can call `useReactFlow()` for
 * `screenToFlowPosition`. Mirrors the PlacementOverlay pattern for
 * positioning + ghost rendering.
 *
 * N-30 — the listeners attach to the `.react-flow` root at capture
 * phase so they fire before React Flow's own handlers further down
 * the DOM. Two listeners cooperate:
 *
 *   - pointerdown (capture): RF's default `selectNodesOnDrag = true`
 *     means a node is selected on pointerdown via XYDrag's drag-start,
 *     before any click event fires. The click handler alone can't
 *     undo that. To suppress node selection in comment-mode, this
 *     listener `stopPropagation`s left-button pointerdowns whose
 *     target is inside `.react-flow__node`. Pane pointerdowns pass
 *     through so the click placement still works.
 *
 *   - click (capture): dispatch by target. NOTE — RF's DOM puts the
 *     node layer INSIDE `.react-flow__pane` (the pane is the outer
 *     wrapper, not a sibling of nodes), so a node click also matches
 *     `closest('.react-flow__pane')`. The node check has to run
 *     FIRST or the pane branch silently swallows node clicks. Order:
 *       - on `.react-flow__node` → exit tool cleanly (cancel)
 *       - on `.react-flow__pane` → drop comment, exit tool
 *       - anywhere else (NodeToolbar buttons, edges, controls) →
 *         exit tool but let the click run normally
 *
 * Esc also cancels the tool.
 */
export function CommentToolBinder() {
  const commentToolActive = useViewStore((s) => s.commentToolActive);
  const setCommentToolActive = useViewStore((s) => s.setCommentToolActive);
  const setPendingInitialEditingCommentId = useViewStore(
    (s) => s.setPendingInitialEditingCommentId,
  );
  const addComment = useDomainStore((s) => s.addComment);
  const rf = useReactFlow();

  // Local state — not in viewStore because the ghost has no consumers
  // outside this component and comment placement (unlike PlacementOverlay)
  // has no keyboard-nudge or other cross-component cursor source.
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!commentToolActive) {
      setGhostPos(null);
      return;
    }
    const root = document.querySelector('.react-flow');
    if (!(root instanceof HTMLElement)) return;
    const pane = root.querySelector('.react-flow__pane');
    if (!(pane instanceof HTMLElement)) return;

    // Seed the ghost at the user's current cursor position (tracked by
    // the module-level window listener above) so it's visible
    // immediately on keyboard `C` / toolbar 💬 click. The previous
    // "viewport center" seed read as "the cursor jumped to the middle"
    // and was wrong; falling back to "no seed" left activation
    // invisible until the first move. Using the actual cursor position
    // satisfies both — and if the user has never moved the mouse since
    // the page loaded (`!known`), we simply wait for the first move.
    if (lastMouseScreen.known) {
      setGhostPos(
        rf.screenToFlowPosition({
          x: lastMouseScreen.x,
          y: lastMouseScreen.y,
        }),
      );
    }

    function onMove(e: PointerEvent): void {
      setGhostPos(rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    }

    function onCanvasPointerDown(e: PointerEvent): void {
      // Suppress React Flow's pointerdown-based node selection
      // (XYDrag drag-start when `selectNodesOnDrag` is its default
      // `true`). Without this, a click on a node would select the
      // node before the click event fires. Only intercept primary-
      // button pointerdowns whose target is inside a node — pane
      // pointerdowns must pass through so the click placement still
      // works, and middle-button stays free for CanvasPanner.
      if (e.button !== 0) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.react-flow__node')) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    function onCanvasClick(e: MouseEvent): void {
      const target = e.target;
      if (!(target instanceof Element)) return;

      // Node check FIRST. RF's DOM nests the node layer inside
      // `.react-flow__pane`, so `closest('.react-flow__pane')` is
      // truthy on node clicks too — if the pane branch ran first it
      // would swallow node clicks and silently place a comment.
      if (target.closest('.react-flow__node')) {
        setCommentToolActive(false);
        e.stopPropagation();
        e.preventDefault();
        return;
      }

      if (target.closest('.react-flow__pane')) {
        const flowPos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const id = addComment(flowPos);
        // Phase 50 Slice 10 / audit C-16 — this is the only place a comment
        // is "freshly" created (paste / undo restore aren't covered here).
        // Setting the pending-edit flag here gates the auto-focus behavior
        // to ONLY the comment the user just dropped; stale empty comments
        // from previous sessions no longer auto-edit on mount.
        setPendingInitialEditingCommentId(id);
        setCommentToolActive(false);
        return;
      }

      setCommentToolActive(false);
    }

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setCommentToolActive(false);
    }

    pane.addEventListener('pointermove', onMove);
    root.addEventListener('pointerdown', onCanvasPointerDown, true);
    root.addEventListener('click', onCanvasClick, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      pane.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerdown', onCanvasPointerDown, true);
      root.removeEventListener('click', onCanvasClick, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [commentToolActive, rf, addComment, setCommentToolActive, setPendingInitialEditingCommentId]);

  if (!commentToolActive || !ghostPos) return null;

  // Ghost geometry mirrors an empty CommentNode (`min-w-[140px]
  // max-w-[280px]`, `px-2.5 py-1.5`, Caveat 18 px / leading-snug). The
  // dashed border + slight opacity telegraph "preview, not yet placed";
  // dimensions are 1:1 so the user sees the true space the dropped
  // comment will occupy. `pointer-events-none` keeps the ghost from
  // eating the placement click. Anchor is the cursor's top-left to
  // match `addComment(flowPos)`, which uses `flowPos` as the comment's
  // top-left.
  return (
    <ViewportPortal>
      <div
        aria-hidden
        className="
          pointer-events-none absolute
          min-w-[140px] max-w-[280px]
          rounded-md border-2 border-dashed shadow-sm
          bg-amber-50/60 border-amber-400/80
          dark:bg-stone-800/60 dark:border-stone-500
          px-2.5 py-1.5
          backdrop-blur-sm
        "
        style={{ left: ghostPos.x, top: ghostPos.y }}
      >
        <div
          className="text-[18px] leading-snug text-stone-400 dark:text-stone-500 select-none"
          style={{ fontFamily: "'Caveat', cursive" }}
        >
          {' '}
        </div>
      </div>
    </ViewportPortal>
  );
}
