/**
 * Audit I-21 — `useModalEscape(onClose, options?)`.
 *
 * Drop-in replacement for the per-modal pattern:
 *
 *   useEffect(() => {
 *     const onKey = (e) => { if (e.key === 'Escape') onClose(); };
 *     window.addEventListener('keydown', onKey);
 *     return () => window.removeEventListener('keydown', onKey);
 *   }, [onClose]);
 *
 * Two changes from that pattern:
 *
 *   1. The modal registers with a shared `modalStack`. The keydown
 *      listener gates on `isTopModal(id)` so Esc only closes the
 *      top-most open modal. Without this, layering two Esc-enabled
 *      modals would close both on a single press.
 *
 *   2. The `enabled` option lets a modal opt out of Esc handling
 *      without unmounting (e.g. `CrashToDeadlineModal` while a run is
 *      in progress). Flipping `enabled` to false pops the modal from
 *      the stack — it shouldn't claim the top while Esc is suppressed.
 */

import { useEffect } from 'react';
import { pushModal, popModal, isTopModal } from '../utils/modalStack.js';

export function useModalEscape(onClose: () => void, options?: { enabled?: boolean }): void {
  const enabled = options?.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    const id = pushModal();
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      if (!isTopModal(id)) return;
      e.preventDefault();
      onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      popModal(id);
    };
  }, [onClose, enabled]);
}
