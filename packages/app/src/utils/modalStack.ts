/**
 * Audit I-21 — modal stack for Esc routing.
 *
 * When multiple modals can be open simultaneously, each registering its
 * own window keydown listener for Escape means **all** of them respond
 * to a single Esc press. The user expectation is that Esc closes only
 * the top-most modal.
 *
 * This pure module is the shared source of truth for "which modal is on
 * top right now." Modals push themselves on mount, pop on unmount, and
 * their keydown listener gates on `isTopModal(id)` so only the top
 * actually fires `onClose`.
 *
 * Used via the `useModalEscape` hook in `hooks/useModalEscape.ts`.
 */

let nextId = 0;
const stack: number[] = [];

/** Push a new modal onto the stack. Returns an opaque id used for pop/peek. */
export function pushModal(): number {
  const id = ++nextId;
  stack.push(id);
  return id;
}

/** Remove a modal from the stack. No-op if `id` is not on the stack. */
export function popModal(id: number): void {
  const idx = stack.indexOf(id);
  if (idx !== -1) stack.splice(idx, 1);
}

/** True iff `id` is the top-most entry on the stack. */
export function isTopModal(id: number): boolean {
  return stack[stack.length - 1] === id;
}

/** Test-only: reset the stack between tests. Not part of the public API. */
export function _resetModalStack(): void {
  nextId = 0;
  stack.length = 0;
}
