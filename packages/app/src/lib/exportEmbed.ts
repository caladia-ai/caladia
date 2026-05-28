/**
 * Phase 34 — Static HTML embed export.
 *
 * `toHtml` is a pure function that assembles a self-contained HTML
 * document from a project, its deterministic schedule, an optional
 * cached Monte Carlo run, and a pre-captured Gantt PNG data URL. The
 * output uses inline styles only — no external CSS, no <script>, no
 * external fonts. It survives copy-paste into Notion / wiki / email,
 * and opens cleanly via `file://`.
 *
 * The Monte Carlo run is optional: when absent, the verdict bar
 * shows the deterministic finish only, and the Sensitivity section
 * is omitted entirely. When present, the verdict bar gains P50 / P80
 * / P95 cells, the Risks section gains a tornado, and Sensitivity
 * renders the top Spearman ρ contributors.
 *
 * Engine boundary: this module reads `ScheduleResult` and
 * `SimulationResult` — both shapes the engines already publish.
 * It never imports React or DOM types; the only browser-specific
 * input is the pre-captured PNG data URL, which is plumbed in by
 * the caller (App.tsx, via `ganttToPngDataUrl`).
 */

import { saveProjectFile, currencyGlyph } from '@procsim/file-format';
import type { ProjectFile } from '@procsim/file-format';
import type { ScheduleResult } from '@procsim/scheduler';
import type { SimRun } from '../store/viewStore.js';

// ── Public API ────────────────────────────────────────────────────────────────

export interface ExportEmbedInput {
  project: ProjectFile;
  scheduleResult: ScheduleResult;
  /** Cached Monte Carlo run, if any. Triggers MC-only sections when present. */
  simRun: SimRun | null;
  /** `data:image/png;base64,…` payload — produced by `ganttToPngDataUrl`. */
  ganttPngDataUrl: string;
  /** Optional override; defaults to `new Date()` at call time. Injectable for tests. */
  generatedAt?: Date;
}

export function toHtml(input: ExportEmbedInput): string {
  const generatedAt = input.generatedAt ?? new Date();
  const { project, scheduleResult, simRun, ganttPngDataUrl } = input;

  const sections = [
    renderHeader(project, generatedAt),
    renderGantt(ganttPngDataUrl),
    renderVerdict(project, scheduleResult, simRun),
    renderRisks(project, scheduleResult, simRun),
    renderNotes(project),
    renderResources(project, scheduleResult),
    simRun ? renderSensitivity(project, simRun) : '',
    renderPlanJson(project),
    renderFooter(),
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(project.project.name)} — Caladia plan</title>
<style>${ROOT_STYLES}</style>
</head>
<body>
<main class="caladia-share">
${sections.join('\n')}
</main>
</body>
</html>`;
}

// ── Styling — single inline stylesheet, no external assets ────────────────────

const ROOT_STYLES = `
  body { margin: 0; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #111827; background: #ffffff; }
  .caladia-share { max-width: 960px; margin: 0 auto; padding: 32px 24px 48px; }
  h1 { font-size: 24px; font-weight: 700; margin: 0 0 4px; }
  h2 { font-size: 16px; font-weight: 600; margin: 32px 0 12px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
  .muted { color: #6b7280; font-size: 13px; }
  .gantt-toolbar { display: flex; align-items: center; gap: 4px; margin: 16px 0 8px; font-size: 12px; }
  .gantt-toolbar-label { color: #6b7280; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; font-size: 11px; margin-right: 4px; }
  .gantt-toolbar button { font: inherit; font-size: 12px; padding: 4px 10px; border: 1px solid #d1d5db; background: #ffffff; border-radius: 4px; cursor: pointer; color: #374151; transition: background-color 80ms, border-color 80ms, color 80ms; }
  .gantt-toolbar button:hover { background: #f3f4f6; }
  .gantt-toolbar button.active { background: #ecfdf5; border-color: #34d399; color: #065f46; }
  .gantt-wrap { margin: 0 0 24px; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; background: #f9fafb; overflow: auto; max-height: 80vh; }
  .gantt-wrap img { display: block; width: 100%; max-width: 100%; height: auto; }
  .verdict-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .verdict-cell { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 14px; background: #f9fafb; }
  .verdict-cell .label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; }
  .verdict-cell .value { font-size: 20px; font-weight: 700; margin-top: 4px; color: #111827; }
  .verdict-cell .sub { font-size: 12px; color: #6b7280; margin-top: 2px; }
  .verdict-cell.tone-good { background: #ecfdf5; border-color: #a7f3d0; }
  .verdict-cell.tone-warn { background: #fffbeb; border-color: #fde68a; }
  .verdict-cell.tone-bad { background: #fef2f2; border-color: #fecaca; }
  table.data { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.data th, table.data td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  table.data th { background: #f9fafb; font-weight: 600; color: #374151; }
  table.data td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.data td.notes-text { white-space: pre-wrap; color: #374151; }
  .empty { color: #9ca3af; font-style: italic; }
  a.download-btn { display: inline-block; padding: 8px 14px; background: #10b981; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 13px; border-radius: 6px; border: 1px solid #059669; transition: background-color 80ms; }
  a.download-btn:hover { background: #059669; }
  a.download-btn:focus { outline: 2px solid #34d399; outline-offset: 2px; }
  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; }
`;

// ── Section renderers ─────────────────────────────────────────────────────────

function renderHeader(project: ProjectFile, generatedAt: Date): string {
  return `<section>
  <h1>${escapeHtml(project.project.name)}</h1>
  <div class="muted">Generated ${escapeHtml(formatDateTime(generatedAt))} · Caladia plan snapshot</div>
</section>`;
}

function renderGantt(pngDataUrl: string): string {
  // Tiny inline script provides explicit zoom controls (50% / 100% / 150% /
  // 200% / fit). Pan is handled by the scrollable wrapper. The PNG is
  // captured at 2× pixelRatio (see App.tsx → ganttToPngDataUrl) so it stays
  // sharp under both the toolbar zoom and the reader's browser zoom.
  return `<section>
  <div class="gantt-toolbar" role="toolbar" aria-label="Gantt zoom">
    <span class="gantt-toolbar-label">Zoom</span>
    <button type="button" data-zoom="0.5">50%</button>
    <button type="button" data-zoom="1">100%</button>
    <button type="button" data-zoom="1.5">150%</button>
    <button type="button" data-zoom="2">200%</button>
    <button type="button" data-zoom="fit" class="active">Fit width</button>
  </div>
  <div class="gantt-wrap">
    <img id="caladia-gantt" src="${escapeHtmlAttr(pngDataUrl)}" alt="Gantt chart">
  </div>
  <script>${GANTT_ZOOM_SCRIPT}</script>
</section>`;
}

// Inline script wired up by `renderGantt`. Vanilla DOM only, ~20 lines.
// `width: 100%` of the wrap = "fit"; numeric zoom levels scale the image
// width as a multiple. Scroll-pan is handled by the wrap's `overflow: auto`.
const GANTT_ZOOM_SCRIPT = `
(function(){
  var img = document.getElementById('caladia-gantt');
  if (!img) return;
  var bar = img.parentElement.previousElementSibling;
  if (!bar) return;
  var buttons = bar.querySelectorAll('button[data-zoom]');
  function apply(zoom, btn) {
    for (var i = 0; i < buttons.length; i++) buttons[i].classList.remove('active');
    btn.classList.add('active');
    if (zoom === 'fit') {
      img.style.width = '100%';
      img.style.maxWidth = '100%';
    } else {
      var z = parseFloat(zoom);
      img.style.width = (z * 100) + '%';
      img.style.maxWidth = 'none';
    }
  }
  for (var i = 0; i < buttons.length; i++) {
    (function(b){ b.addEventListener('click', function(){ apply(b.getAttribute('data-zoom'), b); }); })(buttons[i]);
  }
})();
`;

function renderVerdict(
  project: ProjectFile,
  result: ScheduleResult,
  simRun: SimRun | null,
): string {
  const cells: string[] = [];

  // Deterministic project end
  cells.push(
    verdictCell({
      label: 'Project end (deterministic)',
      value: formatDate(result.projectEnd),
      sub: `From ${escapeHtml(project.project.startDate)}`,
    }),
  );

  // Critical path length — pick the first listed CP (canonical ordering from CPM)
  const cpHours = computeCriticalPathHours(result);
  cells.push(
    verdictCell({
      label: 'Critical path',
      value: formatHours(cpHours, project.project.displayUnit),
      sub: `${result.criticalPaths[0]?.length ?? 0} nodes`,
    }),
  );

  // Project cost (Phase 19 — may be 0 if no costs declared)
  if (result.projectCost > 0) {
    const overBudget = project.budget !== undefined && result.projectCost > project.budget;
    const sub =
      project.budget !== undefined
        ? `Budget ${formatMoneyInline(project.budget, project.currency)}`
        : '';
    cells.push(
      verdictCell({
        label: 'Project cost',
        value: formatMoneyInline(result.projectCost, project.currency),
        sub,
        ...(overBudget ? { tone: 'bad' as const } : {}),
      }),
    );
  }

  // Monte Carlo percentiles when present
  if (simRun) {
    const r = simRun.result;
    cells.push(
      verdictCell({
        label: 'P50 finish',
        value: formatDate(r.percentiles.p50),
        sub: `${simRun.iterations.toLocaleString()} iterations`,
      }),
      verdictCell({
        label: 'P80 finish',
        value: formatDate(r.percentiles.p80),
      }),
      verdictCell({
        label: 'P95 finish',
        value: formatDate(r.percentiles.p95),
      }),
    );
  }

  return `<section>
  <h2>Verdict</h2>
  <div class="verdict-grid">${cells.join('')}</div>
</section>`;
}

function renderRisks(
  project: ProjectFile,
  _scheduleResult: ScheduleResult,
  simRun: SimRun | null,
): string {
  // Phase 46 — risks are now derived: any decision gate with a non-trivial
  // failure probability counts. The legacy `isRisk` flag was removed.
  const flaggedRisks = project.nodes
    .filter((n) => n.nodeType === 'decision' && (n.passProbability ?? 1) < 1)
    .map((n) => ({
      name: n.name,
      passProb: n.passProbability ?? 1,
      failureHours: hoursOf(n.failureDelay) ?? 0,
    }));

  const costTornado = simRun?.result.costTornado ?? [];
  const dateTornado = simRun?.result.tornado ?? [];
  const nodeNameById = new Map(project.nodes.map((n) => [n.id, n.name]));

  const flaggedSection =
    flaggedRisks.length === 0
      ? `<div class="empty">No decision gates with failure probability.</div>`
      : `<table class="data">
      <thead><tr><th>Risk</th><th class="num">Pass probability</th><th class="num">Failure delay (h)</th></tr></thead>
      <tbody>${flaggedRisks
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.name)}</td><td class="num">${(r.passProb * 100).toFixed(0)}%</td><td class="num">${r.failureHours.toFixed(1)}</td></tr>`,
        )
        .join('')}</tbody>
    </table>`;

  const tornadoSection = !simRun
    ? ''
    : renderTornadoBlock('Schedule impact (date tornado)', dateTornado, nodeNameById, 'h') +
      renderTornadoBlock(
        `Cost impact (cost tornado, ${escapeHtml(currencyGlyph(project.currency))})`,
        costTornado,
        nodeNameById,
        '',
      );

  return `<section>
  <h2>Risks</h2>
  ${flaggedSection}
  ${tornadoSection}
</section>`;
}

function renderTornadoBlock(
  title: string,
  tornado: ReadonlyArray<{ nodeId: string; impactHours?: number; impactCost?: number }>,
  nodeNameById: Map<string, string>,
  unit: string,
): string {
  if (tornado.length === 0) return '';
  const TOP_N = 8;
  const rows = tornado.slice(0, TOP_N).map((entry) => {
    const value = entry.impactCost ?? entry.impactHours ?? 0;
    return `<tr><td>${escapeHtml(nodeNameById.get(entry.nodeId) ?? entry.nodeId)}</td><td class="num">${Math.round(value).toLocaleString()}${escapeHtml(unit)}</td></tr>`;
  });
  return `<h2 style="font-size: 13px; font-weight: 600; margin-top: 20px; border: none; padding: 0; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em;">${escapeHtml(title)}</h2>
    <table class="data">
      <thead><tr><th>Node</th><th class="num">Impact</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;
}

function renderNotes(project: ProjectFile): string {
  // Phase 35 Slice 2 — surface free-text descriptions from nodes and loops in
  // the export so stakeholders viewing the HTML get the same context the
  // authoring user sees in the Inspector. Section is omitted entirely when no
  // entity in the project has a description set — keeps the export clean for
  // projects that don't use the field.
  const rows: Array<{ name: string; description: string }> = [];
  for (const n of project.nodes) {
    if (n.description !== undefined && n.description !== '') {
      rows.push({ name: n.name, description: n.description });
    }
  }
  for (const l of project.loops) {
    if (l.description !== undefined && l.description !== '') {
      rows.push({
        name: l.group ? `Loop (${l.group})` : 'Loop',
        description: l.description,
      });
    }
  }
  if (rows.length === 0) return '';

  return `<section>
  <h2>Notes</h2>
  <table class="data">
    <thead><tr><th>Name</th><th>Notes</th></tr></thead>
    <tbody>${rows
      .map(
        (r) =>
          `<tr><td>${escapeHtml(r.name)}</td><td class="notes-text">${escapeHtml(r.description)}</td></tr>`,
      )
      .join('')}</tbody>
  </table>
</section>`;
}

function renderResources(project: ProjectFile, result: ScheduleResult): string {
  if (project.resources.length === 0) {
    return `<section>
  <h2>Resources</h2>
  <div class="empty">No resources declared.</div>
</section>`;
  }

  // Aggregate hours per resource from the timeline
  const hoursByResource = new Map<string, number>();
  for (const entry of result.resourceTimeline) {
    const h = ((entry.end.getTime() - entry.start.getTime()) / 3_600_000) * entry.count;
    hoursByResource.set(entry.resourceId, (hoursByResource.get(entry.resourceId) ?? 0) + h);
  }

  const rows = project.resources.map((r) => {
    const cost = result.resourceCosts[r.id] ?? 0;
    const totalHours = hoursByResource.get(r.id) ?? 0;
    const currency = r.currencyOverride ?? project.currency;
    return `<tr>
      <td>${escapeHtml(r.name)}</td>
      <td class="num">${r.capacity}</td>
      <td class="num">${totalHours.toFixed(1)} h</td>
      <td class="num">${cost > 0 ? formatMoneyInline(cost, currency) : '—'}</td>
    </tr>`;
  });

  return `<section>
  <h2>Resources</h2>
  <table class="data">
    <thead><tr><th>Resource</th><th class="num">Capacity</th><th class="num">Total hours</th><th class="num">Labour cost</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>
</section>`;
}

function renderSensitivity(project: ProjectFile, simRun: SimRun): string {
  // Top-N |ρ| against finish date, alongside cost ρ for the same nodes.
  const finishRho = simRun.result.finishSensitivity;
  const costRho = simRun.result.costSensitivity;
  const nodeNameById = new Map(project.nodes.map((n) => [n.id, n.name]));
  const TOP_N = 10;

  const entries = Object.entries(finishRho)
    .map(([id, rho]) => ({ id, finishRho: rho, costRho: costRho[id] ?? 0 }))
    .sort((a, b) => Math.abs(b.finishRho) - Math.abs(a.finishRho))
    .slice(0, TOP_N);

  if (entries.length === 0) {
    return `<section>
  <h2>Sensitivity</h2>
  <div class="empty">No variance-bearing nodes — Monte Carlo had nothing to correlate.</div>
</section>`;
  }

  const rows = entries
    .map(
      (e) =>
        `<tr>
          <td>${escapeHtml(nodeNameById.get(e.id) ?? e.id)}</td>
          <td class="num">${formatRho(e.finishRho)}</td>
          <td class="num">${formatRho(e.costRho)}</td>
        </tr>`,
    )
    .join('');

  return `<section>
  <h2>Sensitivity — top ${entries.length} nodes by |ρ|</h2>
  <div class="muted" style="margin-bottom: 8px;">Spearman rank correlation between each variance-bearing node's input and the project's finish / cost. ρ ≈ ±1 → dominates; ρ ≈ 0 → unrelated.</div>
  <table class="data">
    <thead><tr><th>Node</th><th class="num">ρ vs finish</th><th class="num">ρ vs cost</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderPlanJson(project: ProjectFile): string {
  // The canonical save serialisation — round-trips byte-equal with what
  // the user would `Open` later in Caladia. Wrapped in a base64 `data:`
  // URL on a plain <a download> element: no JavaScript, the browser
  // handles the download natively. The downloaded file is a real `.cala`
  // the user can drop into Caladia's File → Open dialog or upload to an
  // LLM chat to ask about / modify the plan.
  const json = saveProjectFile(project);
  const base64 = utf8ToBase64(json);
  const dataUrl = `data:application/json;base64,${base64}`;
  const filename = `${planSlug(project)}.cala`;
  return `<section>
  <h2>Plan file</h2>
  <p class="muted">Download the project's <code>.cala</code> file — open it back in Caladia, or upload it to an LLM chat to ask about or modify the plan.</p>
  <a href="${escapeHtmlAttr(dataUrl)}" download="${escapeHtmlAttr(filename)}" class="download-btn">↓ Download ${escapeHtml(filename)}</a>
</section>`;
}

function planSlug(project: ProjectFile): string {
  const slug = project.project.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'plan';
}

/**
 * UTF-8 safe base64 encoder. Browser `btoa` only handles Latin-1, and
 * project names / node names can contain non-ASCII characters (accents,
 * em-dashes, CJK). Convert through TextEncoder so multi-byte chars
 * survive the round-trip.
 */
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}

function renderFooter(): string {
  return `<div class="footer">
  Generated by <strong>Caladia</strong> — open-source business-process simulation.
</div>`;
}

// ── Render helpers ────────────────────────────────────────────────────────────

function verdictCell(opts: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'good' | 'warn' | 'bad';
}): string {
  const toneClass = opts.tone ? ` tone-${opts.tone}` : '';
  const sub = opts.sub ? `<div class="sub">${escapeHtml(opts.sub)}</div>` : '';
  return `<div class="verdict-cell${toneClass}">
    <div class="label">${escapeHtml(opts.label)}</div>
    <div class="value">${escapeHtml(opts.value)}</div>
    ${sub}
  </div>`;
}

function computeCriticalPathHours(result: ScheduleResult): number {
  const path = result.criticalPaths[0];
  if (!path) return 0;
  let total = 0;
  for (const id of path) {
    const s = result.nodes[id];
    if (!s) continue;
    total += (s.earliestFinish.getTime() - s.earliestStart.getTime()) / 3_600_000;
  }
  return total;
}

function hoursOf(d: { value: number; unit: string } | undefined): number | undefined {
  if (!d) return undefined;
  switch (d.unit) {
    case 'hours':
      return d.value;
    case 'days':
      return d.value * 24;
    case 'weeks':
      return d.value * 24 * 7;
    default:
      return d.value;
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatDateTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${formatDate(d)} ${hh}:${mi}`;
}

function formatHours(hours: number, displayUnit: 'hours' | 'days' | 'weeks'): string {
  switch (displayUnit) {
    case 'hours':
      return `${hours.toFixed(1)} h`;
    case 'days':
      return `${(hours / 8).toFixed(1)} d`;
    case 'weeks':
      return `${(hours / 40).toFixed(2)} w`;
  }
}

function formatMoneyInline(amount: number, currencyCode: string): string {
  const glyph = currencyGlyph(currencyCode);
  return `${glyph}${Math.round(amount).toLocaleString()}`;
}

function formatRho(rho: number): string {
  if (Number.isNaN(rho)) return '—';
  const sign = rho >= 0 ? '+' : '';
  return `${sign}${rho.toFixed(2)}`;
}

// ── HTML escaping ─────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttr(s: string): string {
  // data: URLs include `;base64,…` and arbitrary base64 chars — escape `"` and
  // `&` only. Other escapes would corrupt the payload.
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
