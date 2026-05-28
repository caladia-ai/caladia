import { useEffect, useRef, useState } from 'react';
import type { NodeProps, Node } from '@xyflow/react';
import { useDomainStore } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';

// ── Node type definition ──────────────────────────────────────────────────────
//
// Phase 49 Slice 3 — free-floating canvas comment. Not attached to nodes /
// edges; lives in flow-space (x, y) and persists in `project.comments`.
// Renders as a soft paper card with the Caveat handwritten font so it
// reads as user annotation rather than diagram content.
//
// Two render states:
//   - View: the card shows the comment's text; the whole card is
//     draggable via React Flow's default behaviour.
//   - Edit: the card's text becomes an inline textarea (.nodrag so RF
//     doesn't try to pan/drag while the user types). Blur or Esc exits
//     edit mode and writes through to `updateComment`. Freshly-placed
//     comments mount directly into edit mode (see Slice 10 below).

export interface CommentData extends Record<string, unknown> {
  text: string;
  /** Domain-store comment id. The React Flow node id is prefixed
   *  (`__comment__${commentId}`) to keep it from colliding with the
   *  project's node ids; store actions need the raw id. */
  commentId: string;
  /**
   * Phase 50 Slice 10 / audit C-16 — true only for a freshly-placed
   * comment (the comment-tool sets this on the just-added id via
   * `viewStore.pendingInitialEditingCommentId`). When true, the comment
   * mounts into edit mode so the user can immediately type. Stale
   * empty-text comments from a previous session no longer auto-edit
   * (which used to steal keystrokes on reload).
   */
  initialEditing?: boolean;
}

export type CommentNodeType = Node<CommentData, 'comment'>;

export function CommentNode({ data }: NodeProps<CommentNodeType>) {
  const updateComment = useDomainStore((s) => s.updateComment);
  const deleteComment = useDomainStore((s) => s.deleteComment);
  const setPendingInitialEditingCommentId = useViewStore(
    (s) => s.setPendingInitialEditingCommentId,
  );
  const id = data.commentId;

  // Phase 50 Slice 10 / audit C-16 — initialize edit state from the
  // pending-edit flag set on placement, NOT from `data.text === ''`.
  // The old rule auto-focused every empty-text comment on every mount
  // (including stale empties from a previous session); the new rule
  // only auto-focuses comments the user just placed via the comment
  // tool.
  const [editing, setEditing] = useState<boolean>(data.initialEditing === true);
  const [draft, setDraft] = useState<string>(data.text);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [editing]);

  // Sync local draft when the committed text changes externally
  // (e.g. undo / redo).
  useEffect(() => {
    setDraft(data.text);
  }, [data.text]);

  function commit(): void {
    setEditing(false);
    // Slice 10 — clear the pending-edit flag so a re-render after this
    // comment is committed (e.g. another comment is just placed
    // afterwards) doesn't re-arm us.
    setPendingInitialEditingCommentId(null);
    const trimmed = draft.trim();
    if (trimmed === '' && data.text === '') {
      // Empty comment never got real content — clean it up rather than
      // leave invisible chrome on the canvas.
      deleteComment(id);
      return;
    }
    if (trimmed !== data.text) {
      updateComment(id, trimmed);
    }
  }

  function cancel(): void {
    setEditing(false);
    setPendingInitialEditingCommentId(null);
    setDraft(data.text);
    if (data.text === '') {
      // Bailed out of editing an empty new comment — remove it.
      deleteComment(id);
    }
  }

  return (
    <div
      className="
        group relative inline-block min-w-[140px] max-w-[280px]
        rounded-md border shadow-sm cursor-grab active:cursor-grabbing
        bg-amber-50 border-amber-200/70
        dark:bg-stone-800 dark:border-stone-700
        px-2.5 py-1.5
        isolate
      "
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!editing) setEditing(true);
      }}
    >
      {/* Light-mode ruled-paper lines. Drawn as a separate absolutely-
          positioned overlay (rather than inline style on the card)
          so `dark:hidden` can suppress it cleanly. The 25 px pitch
          matches Caveat at 18 px with leading-snug (≈ 24.75 px line
          height), so text sits roughly on the rules. */}
      <div
        aria-hidden="true"
        className="
          pointer-events-none absolute inset-0 rounded-md
          block dark:hidden
        "
        style={{
          backgroundImage:
            'repeating-linear-gradient(to bottom, transparent 0, transparent 24px, rgba(180, 140, 60, 0.22) 24px, rgba(180, 140, 60, 0.22) 25px)',
        }}
      />
      {editing ? (
        <textarea
          ref={textareaRef}
          className="
            nodrag nopan relative
            w-full min-w-[120px] resize-none bg-transparent outline-none
            text-stone-900 dark:text-stone-100
            placeholder:text-stone-400 dark:placeholder:text-stone-500
            text-[18px] leading-snug
          "
          style={{ fontFamily: "'Caveat', cursive" }}
          rows={Math.max(1, draft.split('\n').length)}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            }
          }}
          placeholder="Type a note…"
          aria-label="Comment text"
        />
      ) : (
        <div
          className="
            relative
            text-[18px] leading-snug whitespace-pre-wrap break-words
            text-stone-900 dark:text-stone-100
            select-none
          "
          style={{ fontFamily: "'Caveat', cursive" }}
        >
          {data.text || ' '}
        </div>
      )}
      {/* Delete affordance. While editing the card always shows it so a
          freshly-placed empty comment is dismissable without relying on
          Esc / blur (the user can see + click). While not editing it's
          hover-only — keeps placed comments visually quiet.
          NOTE: previously `opacity-0 → opacity-100 transition-opacity`,
          but the opacity transition forced Chrome to dynamically promote
          the comment to its own compositor layer on each hover-enter /
          hover-leave. The layer thrash repainted neighbouring React Flow
          nodes and re-routed edges visibly (entire diagram "flashed"
          when the cursor passed over a comment). Snap-show via `hidden /
          group-hover:flex` is instant and side-effect-free. */}
      <button
        type="button"
        className={[
          'nodrag',
          'absolute -top-2 -right-2 w-5 h-5 rounded-full',
          'bg-stone-700 dark:bg-stone-600 text-white',
          'text-[12px] leading-none',
          editing ? 'inline-flex' : 'hidden group-hover:inline-flex',
          'items-center justify-center',
          'shadow-sm',
        ].join(' ')}
        aria-label="Delete comment"
        title="Delete comment"
        onClick={(e) => {
          e.stopPropagation();
          deleteComment(id);
        }}
      >
        ×
      </button>
    </div>
  );
}
