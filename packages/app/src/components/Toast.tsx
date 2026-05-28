/**
 * Phase 37 Slice 1 — toast notification UI.
 *
 * The store (viewStore) owns the queue. Each rendered `ToastItem` schedules
 * its own auto-dismiss `setTimeout` on mount and clears it on unmount; the
 * timer's only job is to call `dismissToast(id)` once the dwell window
 * elapses. Manual dismiss via the × button does the same thing immediately.
 *
 * Positioning: fixed bottom-right, stacked newest-at-bottom so the most
 * recent message is closest to the cursor's expected resting position.
 * Each toast is pointer-events-auto; the container is pointer-events-none
 * so empty slots don't block clicks on the canvas underneath.
 */
import { useEffect } from 'react';
import { useViewStore } from '../store/viewStore.js';
import type { Toast as ToastModel } from '../store/viewStore.js';

/**
 * Audit N-13 — auto-dismiss dwell per toast kind.
 *
 * Errors and warnings need longer because the user has to read, decide,
 * and possibly act. Info / success are quick acknowledgements; 3 s
 * matches the original Phase 37 default and the prevailing toast-UX
 * convention.
 *
 * Exported for the unit test that locks in the kind-relative ordering
 * (error > warn > info / success). Pre-N-13 a single `DEFAULT_DWELL_MS`
 * applied to every kind — errors got the same 3 s as a "Saved" success.
 */
export const DWELL_MS_BY_KIND: Record<ToastModel['kind'], number> = {
  info: 3_000,
  success: 3_000,
  warn: 6_000,
  error: 10_000,
};

const KIND_STYLES: Record<ToastModel['kind'], { border: string; iconBg: string; icon: string }> = {
  info: {
    border: 'border-l-blue-500',
    iconBg: 'bg-blue-500/15 text-blue-300',
    icon: 'i',
  },
  success: {
    border: 'border-l-emerald-500',
    iconBg: 'bg-emerald-500/15 text-emerald-300',
    icon: '✓',
  },
  warn: {
    border: 'border-l-amber-500',
    iconBg: 'bg-amber-500/15 text-amber-300',
    icon: '!',
  },
  error: {
    border: 'border-l-rose-500',
    iconBg: 'bg-rose-500/15 text-rose-300',
    icon: '×',
  },
};

export function ToastContainer() {
  const notifications = useViewStore((s) => s.notifications);
  if (notifications.length === 0) return null;
  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-atomic="false"
    >
      {notifications.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: ToastModel }) {
  const dismissToast = useViewStore((s) => s.dismissToast);
  const styles = KIND_STYLES[toast.kind];

  useEffect(() => {
    const handle = setTimeout(() => {
      dismissToast(toast.id);
    }, DWELL_MS_BY_KIND[toast.kind]);
    return () => clearTimeout(handle);
  }, [toast.id, toast.kind, dismissToast]);

  return (
    <div
      role="status"
      className={[
        'pointer-events-auto flex items-start gap-2.5 min-w-[260px] max-w-[420px]',
        'rounded-md border-l-4 bg-gray-900 text-gray-100 shadow-lg',
        'pl-3 pr-2 py-2 text-sm',
        styles.border,
      ].join(' ')}
    >
      <span
        aria-hidden
        className={[
          'shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-xs font-semibold',
          styles.iconBg,
        ].join(' ')}
      >
        {styles.icon}
      </span>
      <span className="flex-1 leading-snug">{toast.text}</span>
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        aria-label="Dismiss notification"
        className="shrink-0 text-gray-400 hover:text-gray-100 transition-colors text-base leading-none px-1 -mr-1"
      >
        ×
      </button>
    </div>
  );
}
