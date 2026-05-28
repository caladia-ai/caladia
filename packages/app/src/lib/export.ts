/**
 * Export utilities for Gantt PNG and schedule CSV.
 *
 * Canvas PNG export lives in CanvasExporter (App.tsx) because it needs
 * useReactFlow() — which requires the ReactFlow context — to correctly compute
 * the viewport transform and capture edge SVGs.
 */

// html-to-image is dynamically imported in `ganttToPngDataUrl` below
// (and at the canvas-export call site in App.tsx). N-10 follow-up #2:
// the lib is only used during PNG export — rare per session — so
// keeping its ~100 KB out of the initial chunk is a clear win.
import type { ScheduleResult } from '@procsim/scheduler';
import type { ProjectFile } from '@procsim/file-format';

// ── Download helper (also used by CanvasExporter in App.tsx) ──────────────────

export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Gantt PNG ──────────────────────────────────────────────────────────────────

export interface GanttCaptureOptions {
  /**
   * When `true`, drill into the scroll wrapper's first element child and
   * capture its full scroll dimensions — produces an image that includes
   * the entire Gantt content rather than the visible viewport. Used by
   * the Phase 34 "Share this plan" HTML export so the snapshot shows the
   * whole timeline regardless of how much was visible when the user
   * clicked Share. Default `false`.
   */
  fullContent?: boolean;
  /**
   * Override `window.devicePixelRatio`. The Share export uses `2` so the
   * resulting PNG stays sharp when the reader's browser zooms in.
   * Default is `window.devicePixelRatio ?? 1` (i.e. native).
   */
  pixelRatio?: number;
}

/**
 * Capture the Gantt chart container as a PNG and return its `data:` URL.
 * Used by both the standalone PNG download (below) and the Phase 34
 * "Share this plan" HTML export, which inlines the same PNG as a base64
 * `<img src=>` in the generated document. Keeping a single capture
 * helper means both consumers stay byte-equal on the image side.
 */
export async function ganttToPngDataUrl(
  element: HTMLElement,
  opts: GanttCaptureOptions = {},
): Promise<string> {
  const { toPng } = await import('html-to-image');
  const pixelRatio = opts.pixelRatio ?? window.devicePixelRatio ?? 1;
  // For the share export, the relevant content is inside the scroll wrapper
  // (the inline-flex inner div that React Flow / the Gantt grid renders into).
  // Capturing the wrapper itself produces a PNG with lots of empty space
  // below the data; capturing the inner content cropped to its scroll
  // dimensions gives a tight bounding box.
  const target =
    opts.fullContent && element.firstElementChild instanceof HTMLElement
      ? element.firstElementChild
      : element;
  return toPng(target, {
    cacheBust: true,
    pixelRatio,
    ...(opts.fullContent ? { width: target.scrollWidth, height: target.scrollHeight } : {}),
  });
}

/**
 * Capture the Gantt chart container as a PNG and trigger a browser download.
 */
export async function downloadGanttPng(element: HTMLElement): Promise<void> {
  const dataUrl = await ganttToPngDataUrl(element);
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  triggerDownload(blob, 'gantt.png');
}

// ── Schedule CSV ───────────────────────────────────────────────────────────────

function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Build a CSV string from the deterministic schedule result and trigger a
 * browser download. One row per project node:
 *   name, earliestStart, earliestFinish, latestStart, latestFinish,
 *   slackHours, onCriticalPath
 */
export function downloadScheduleCsv(project: ProjectFile, result: ScheduleResult): void {
  const header = [
    'name',
    'earliestStart',
    'earliestFinish',
    'latestStart',
    'latestFinish',
    'slackHours',
    'onCriticalPath',
  ].join(',');

  const rows = project.nodes.map((node) => {
    const s = result.nodes[node.id];
    if (!s) {
      return [csvField(node.name), '', '', '', '', '', 'false'].join(',');
    }
    return [
      csvField(node.name),
      s.earliestStart.toISOString(),
      s.earliestFinish.toISOString(),
      s.latestStart.toISOString(),
      s.latestFinish.toISOString(),
      s.slackHours.toFixed(2),
      s.onCriticalPath ? 'true' : 'false',
    ].join(',');
  });

  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, 'schedule.csv');
}
