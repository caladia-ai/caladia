import { useEffect, useRef, useState } from 'react';
import { beginEdit, commitEdit } from '../store/domainStore.js';

/**
 * Draft-string numeric input for property panels.
 *
 * The straight-controlled `<input type="number" value={fieldValue}>`
 * pattern elsewhere in the app rejects empty / mid-edit / invalid
 * strings inside `onChange` and snaps the input back to the last
 * valid value on every keystroke. Visible symptoms:
 *
 *   - Backspace-to-clear doesn't work (the field re-fills mid-keystroke).
 *   - Triple-click + type-to-replace flickers / doesn't reach 0 cleanly
 *     when the current value isn't trivially overwriteable.
 *   - σ couldn't be set to 0 at all (an explicit `v <= 0` guard).
 *
 * `NumericInput` holds a local DRAFT STRING while the input is focused
 * so the user can type freely (including empty / partial states). It
 * calls `onCommit(n)` for every keystroke that parses to a valid
 * in-range number — so live updates keep working — but the DOM value
 * follows the user's keystrokes, not the parent's snap-back. On blur,
 * if the draft never parsed cleanly the field reverts to the last
 * committed value.
 *
 * `beginEdit` / `commitEdit` framing on focus / blur preserves the
 * undo-grouping semantics: every burst of typing inside a single
 * focused session lands as one history entry.
 *
 * History:
 * - Originally defined inline in `NodePanel.tsx` (Phase 49 Slice 9).
 * - Extracted to this module by Phase 50 Slice 22 / audit I-19
 *   so other property panels (`LoopPanel`, `NodePanel`'s
 *   `CrashSection`, etc.) can share the same draft-string discipline.
 */

interface NumericInputProps {
  value: number;
  /** Lower bound, inclusive. Default 0. Set to e.g. -Infinity to disable. */
  min?: number;
  /** Upper bound, inclusive. Default Infinity. */
  max?: number;
  step?: number;
  className?: string;
  title?: string;
  onCommit: (n: number) => void;
}

export function NumericInput({
  value,
  min = 0,
  max = Infinity,
  step,
  className,
  title,
  onCommit,
}: NumericInputProps) {
  const [draft, setDraft] = useState<string>(String(value));
  const focusedRef = useRef(false);

  // External value changes (e.g. duration → distribution mode link) sync
  // into the draft, but ONLY when the user isn't currently editing. While
  // focused, the user's keystrokes own the draft.
  useEffect(() => {
    if (!focusedRef.current) setDraft(String(value));
  }, [value]);

  function tryCommit(raw: string): void {
    const v = parseFloat(raw);
    if (!isFinite(v)) return;
    if (v < min) return;
    if (v > max) return;
    onCommit(v);
  }

  return (
    <input
      type="number"
      value={draft}
      {...(min !== -Infinity ? { min } : {})}
      {...(max !== Infinity ? { max } : {})}
      {...(step !== undefined ? { step } : {})}
      {...(title !== undefined ? { title } : {})}
      onFocus={() => {
        focusedRef.current = true;
        beginEdit();
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        tryCommit(e.target.value);
      }}
      onBlur={() => {
        focusedRef.current = false;
        // If the user left an invalid draft behind, revert visually to the
        // last committed value so the field always shows a real number.
        const v = parseFloat(draft);
        if (!isFinite(v) || v < min || v > max) setDraft(String(value));
        commitEdit();
      }}
      className={className}
    />
  );
}
