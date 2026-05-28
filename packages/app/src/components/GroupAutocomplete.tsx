/**
 * GroupAutocomplete — a text input with suggestion dropdown that renders via
 * a React portal so it escapes overflow:hidden / overflow:auto ancestor panels
 * and always appears directly below the input.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface GroupAutocompleteProps {
  /** Current committed value from the store ('' when none set). */
  value: string;
  /** List of existing group names to suggest. */
  suggestions: string[];
  placeholder?: string;
  inputClassName?: string;
  /** Called when the input is focused — use to call beginEdit(). */
  onFocus?(): void;
  /** Called on blur or option selection with the trimmed value (undefined = clear). */
  onCommit(value: string | undefined): void;
}

interface DropdownRect {
  top: number;
  left: number;
  width: number;
}

export function GroupAutocomplete({
  value,
  suggestions,
  placeholder,
  inputClassName,
  onFocus,
  onCommit,
}: GroupAutocompleteProps) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [dropdownRect, setDropdownRect] = useState<DropdownRect | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync draft when committed value changes externally (undo/redo, node switch)
  useEffect(() => {
    setDraft(value);
  }, [value]);

  // Close dropdown if the user scrolls anything while it's open
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', close, { capture: true });
  }, [open]);

  const updateDropdownRect = useCallback(() => {
    if (!inputRef.current) return;
    const r = inputRef.current.getBoundingClientRect();
    setDropdownRect({ top: r.bottom + 2, left: r.left, width: r.width });
  }, []);

  function handleFocus() {
    onFocus?.();
    updateDropdownRect();
    setOpen(true);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setDraft(e.target.value);
    updateDropdownRect();
    setOpen(true);
  }

  function handleBlur() {
    // Delay slightly so that a mousedown on an option fires before blur commits.
    setTimeout(() => {
      setOpen(false);
      const v = draft.trim();
      onCommit(v.length > 0 ? v : undefined);
    }, 150);
  }

  function selectOption(opt: string) {
    setDraft(opt);
    setOpen(false);
    onCommit(opt.length > 0 ? opt : undefined);
  }

  const filtered =
    draft.trim().length === 0
      ? suggestions
      : suggestions.filter((s) => s.toLowerCase().includes(draft.toLowerCase()));

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={draft}
        placeholder={placeholder}
        onFocus={handleFocus}
        onChange={handleChange}
        onBlur={handleBlur}
        className={inputClassName}
        autoComplete="off"
      />

      {open &&
        filtered.length > 0 &&
        dropdownRect &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              top: dropdownRect.top,
              left: dropdownRect.left,
              width: dropdownRect.width,
              zIndex: 9999,
            }}
            className="rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-xl overflow-hidden"
          >
            {filtered.map((opt) => (
              <div
                key={opt}
                className="px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
                onMouseDown={(e) => {
                  // Prevent blur firing before click so the option registers
                  e.preventDefault();
                  selectOption(opt);
                }}
              >
                {opt}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
