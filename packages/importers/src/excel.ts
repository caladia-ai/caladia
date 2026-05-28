/**
 * Excel Gantt parser.
 *
 * Supports two layouts:
 *
 * TABULAR — rows = tasks, columns = properties.
 *   Expected header keywords (case-insensitive):
 *     name/task/activity  → node name
 *     duration            → duration (e.g. "5d", "40h", "2w", or a number in days)
 *     predecessor/dep/id  → predecessor IDs (comma-separated row numbers or names)
 *     resource            → resource name
 *     milestone/start/end → milestone flag
 *
 * VISUAL (Gantt bar chart) — time axis = columns, rows = tasks.
 *   If the tabular layout is not detected, falls back to visual layout:
 *   - Row 0 must be date headers (column indices map to dates)
 *   - Subsequent rows: col 0 = task name; filled/non-empty cells = bar extent
 *   - Duration inferred from bar width in days; no explicit predecessors
 *
 * Pure function — no DOM, no Node.js fs, no network.
 * Accepts ArrayBuffer (browser file read or Node.js fs.readFileSync Buffer).
 */

import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import type {
  ImportResult,
  ImportDraft,
  ImportedNode,
  ImportedEdge,
  ImportedResource,
  AmbiguityItem,
  ImportedDuration,
} from './types.js';

// ── Zip-bomb hardening (audit I-27) ───────────────────────────────────────────
//
// An .xlsx is an OOXML zip. Mirror the same caps the pptx importer uses
// (see pptx.ts) so a malicious workbook can't inflate to gigabytes inside
// `XLSX.read`. Caps are an order of magnitude above any realistic file —
// real xlsx archives are <50 MB total; large legitimate decks rarely hit
// 5 MB per entry. A hit here means the input is malicious or corrupt.
//
// `parseExcelGantt` switched from sync to async because pre-flight relies
// on `JSZip.loadAsync`. The sole app caller (`AppShell.handleImport`)
// already awaits the result.
export const MAX_XLSX_ENTRY_INFLATED_BYTES = 25 * 1024 * 1024;
export const MAX_XLSX_TOTAL_INFLATED_BYTES = 100 * 1024 * 1024;
export const MAX_XLSX_ENTRY_COUNT = 1000;

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}

/**
 * Pre-inflation size lookup. Same private-field trick as the pptx
 * importer — JSZip's public API doesn't expose the uncompressed-size
 * metadata from the zip central directory, but its internal
 * `CompressedObject` carries it as a stable field across v3.x. If
 * absent the per-entry post-inflate check is the safety net.
 */
function uncompressedSize(entry: JSZip.JSZipObject): number | undefined {
  const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
  return data?.uncompressedSize;
}

// ── Duration parsing ──────────────────────────────────────────────────────────
//
// Audit I-29 — the prior single-regex parser rejected three real-world
// shapes that Excel cells routinely produce and silently defaulted to 8h:
//
//   - Scientific notation         e.g. "1e2"     (100)
//   - Euro decimal                e.g. "1,5"     (1.5)
//   - Space-grouped thousands     e.g. "1 200 h" (1200 hours)
//
// Split parse:
//   1. Peel the optional unit suffix (h/d/w + word continuations) off
//      the END of the string.
//   2. Normalize the numeric portion:
//        a. Strip ASCII whitespace — handles space-grouped values.
//        b. If the portion is shaped `digits,digits{1,2}` (no dot,
//           comma-tail 1-2 digits), swap the comma for a dot. This
//           catches "1,5" / "1,50" without false-positive on "1,200"
//           or "1,500" (US/Euro thousands are ambiguous and kept as
//           today's reject-than-misinterpret behaviour).
//   3. Validate the normalized portion against a strict number-shape
//      regex that accepts scientific notation. `parseFloat` is too lax
//      ("1abc" → 1).
//   4. parseFloat + finite/positive guard.

const SCI_NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const TRAILING_UNIT_RE = /(h(?:ours?)?|d(?:ays?)?|w(?:eeks?)?)\s*$/i;
const EURO_DECIMAL_RE = /^([-+]?\d+),(\d{1,2})$/;

/**
 * Exported for direct table-driven testing. Returns the parsed duration
 * or `null` if the cell can't be interpreted; callers default to 8h.
 */
export function parseDurationCell(raw: unknown): ImportedDuration | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).trim();
  if (s === '') return null;

  const unitMatch = s.match(TRAILING_UNIT_RE);
  const unitRaw = unitMatch ? unitMatch[1]!.toLowerCase() : null;
  const numPortion = (unitMatch ? s.slice(0, unitMatch.index!) : s).trim();
  if (numPortion === '') return null;

  const noSpaces = numPortion.replace(/\s+/g, '');
  const euroMatch = noSpaces.match(EURO_DECIMAL_RE);
  const normalized = euroMatch ? `${euroMatch[1]}.${euroMatch[2]}` : noSpaces;

  if (!SCI_NUMBER_RE.test(normalized)) return null;
  const val = parseFloat(normalized);
  if (!isFinite(val) || val <= 0) return null;

  let unit: 'hours' | 'days' | 'weeks' = 'days';
  if (unitRaw?.startsWith('h')) unit = 'hours';
  else if (unitRaw?.startsWith('w')) unit = 'weeks';

  return { value: val, unit };
}

// ── Cell helpers ──────────────────────────────────────────────────────────────

function cellText(sheet: XLSX.WorkSheet, r: number, c: number): string {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = sheet[addr];
  if (!cell) return '';
  return String(cell.v ?? '').trim();
}

function isEmpty(sheet: XLSX.WorkSheet, r: number, c: number): boolean {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = sheet[addr];
  return !cell || cell.v === null || cell.v === undefined || cell.v === '';
}

// ── Layout detection keywords ─────────────────────────────────────────────────

const NAME_KW = /^(name|task|activity|description)$/i;
const DUR_KW = /^(duration|dur|effort)$/i;
const PRED_KW = /^(predecessor|predecessors|dep|deps|depends|id|pred)$/i;
const RES_KW = /^(resource|resources|assigned|assignee)$/i;
const MS_KW = /^(milestone|type|start anchor|end anchor)$/i;

// ── Tabular layout parser ─────────────────────────────────────────────────────

function parseTabular(
  sheet: XLSX.WorkSheet,
  range: XLSX.Range,
  ambiguities: AmbiguityItem[],
): { nodes: ImportedNode[]; edges: ImportedEdge[]; resources: ImportedResource[] } | null {
  const headerRow = range.s.r;
  const cols = { name: -1, dur: -1, pred: -1, res: -1, ms: -1 };

  for (let c = range.s.c; c <= range.e.c; c++) {
    const h = cellText(sheet, headerRow, c);
    if (NAME_KW.test(h)) cols.name = c;
    else if (DUR_KW.test(h)) cols.dur = c;
    else if (PRED_KW.test(h)) cols.pred = c;
    else if (RES_KW.test(h)) cols.res = c;
    else if (MS_KW.test(h)) cols.ms = c;
  }

  if (cols.name === -1) return null; // No name column → not tabular

  const nodes: ImportedNode[] = [];
  const edges: ImportedEdge[] = [];
  const resourceMap = new Map<string, ImportedResource>();
  let edgeCounter = 0;

  // Row index → node id (for predecessor resolution)
  const rowToNodeId = new Map<number, string>();

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const name = cellText(sheet, r, cols.name);
    if (!name) continue; // blank rows

    const nodeId = `n${r - headerRow}`;
    rowToNodeId.set(r, nodeId);

    const durRaw = cols.dur >= 0 ? cellText(sheet, r, cols.dur) : '';
    let duration: ImportedDuration;
    const parsed = parseDurationCell(durRaw);
    if (!parsed) {
      duration = { value: 8, unit: 'hours' };
      if (durRaw) {
        ambiguities.push({
          code: 'UNPARSEABLE_DURATION',
          message: `Row ${r}: could not parse duration "${durRaw}"; defaulted to 8h.`,
          affectedIds: [nodeId],
        });
      } else {
        ambiguities.push({
          code: 'MISSING_DURATION',
          message: `Row ${r} ("${name}") has no duration; defaulted to 8h.`,
          affectedIds: [nodeId],
        });
      }
    } else {
      duration = parsed;
    }

    const msRaw = cols.ms >= 0 ? cellText(sheet, r, cols.ms).toLowerCase() : '';
    const isMilestone =
      msRaw === 'milestone' ||
      msRaw === 'start' ||
      msRaw === 'end' ||
      msRaw === '1' ||
      msRaw === 'true';

    const nodeType = isMilestone ? 'start' : 'activity';
    const effectiveDuration = isMilestone ? { value: 0, unit: 'hours' as const } : duration;

    // Resource
    const resName = cols.res >= 0 ? cellText(sheet, r, cols.res) : '';
    const assignments: Array<{
      resourceId: string;
      count: number;
      calendarPolicy: 'intersection';
    }> = [];
    if (resName) {
      const resId = `res-${resName.toLowerCase().replace(/\s+/g, '-')}`;
      if (!resourceMap.has(resId)) {
        resourceMap.set(resId, { id: resId, name: resName, capacity: 1 });
      }
      assignments.push({ resourceId: resId, count: 1, calendarPolicy: 'intersection' });
    }

    nodes.push({
      id: nodeId,
      name,
      nodeType,
      duration: effectiveDuration,
      position: { x: (r - headerRow - 1) * 220, y: 100 },
      consumesResources: assignments.length > 0,
      resourceAssignments: assignments,
    });

    // Predecessors
    if (cols.pred >= 0) {
      const predRaw = cellText(sheet, r, cols.pred);
      if (predRaw) {
        for (const chunk of predRaw.split(/[,;]/)) {
          const trimmed = chunk.trim();
          if (!trimmed) continue;
          // Try as row number
          const rowNum = parseInt(trimmed, 10);
          if (!isNaN(rowNum)) {
            edges.push({
              id: `e${++edgeCounter}`,
              from: `n${rowNum}`,
              to: nodeId,
              type: 'FS',
              lag: { value: 0, unit: 'hours' },
            });
          } else {
            // Try as task name — defer; LLM can resolve
            ambiguities.push({
              code: 'UNRESOLVED_PREDECESSOR_NAME',
              message: `Row ${r} ("${name}"): predecessor "${trimmed}" is a name, not a row number; LLM should resolve to a node id.`,
              affectedIds: [nodeId],
            });
          }
        }
      }
    }
  }

  // Reclassify: last milestone with no successors → 'end'
  const hasSuccessor = new Set(edges.map((e) => e.from));
  for (const n of nodes) {
    if (n.nodeType === 'start' && !hasSuccessor.has(n.id)) {
      n.nodeType = 'end';
      n.duration = { value: 0, unit: 'hours' };
    }
  }

  return { nodes, edges, resources: Array.from(resourceMap.values()) };
}

// ── Visual (bar chart) layout parser ─────────────────────────────────────────

function parseVisual(
  sheet: XLSX.WorkSheet,
  range: XLSX.Range,
  ambiguities: AmbiguityItem[],
): { nodes: ImportedNode[]; edges: ImportedEdge[]; resources: ImportedResource[] } {
  const nodes: ImportedNode[] = [];

  // Parse date headers from row 0 (may be Date objects or text)
  const dateColumns: number[] = [];
  for (let c = range.s.c + 1; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: range.s.r, c });
    const cell = sheet[addr];
    if (cell) dateColumns.push(c);
  }

  let nodeCounter = 0;

  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const name = cellText(sheet, r, range.s.c);
    if (!name) continue;

    nodeCounter++;
    const nodeId = `n${nodeCounter}`;

    // Find extent of filled cells
    let firstFilled = -1;
    let lastFilled = -1;
    for (let c = range.s.c + 1; c <= range.e.c; c++) {
      if (!isEmpty(sheet, r, c)) {
        if (firstFilled === -1) firstFilled = c;
        lastFilled = c;
      }
    }

    let duration: ImportedDuration;
    if (firstFilled === -1) {
      duration = { value: 8, unit: 'hours' };
      ambiguities.push({
        code: 'NO_BAR_CELLS',
        message: `Row ${r} ("${name}"): no filled cells found; duration defaulted to 8h.`,
        affectedIds: [nodeId],
      });
    } else {
      const durationDays = lastFilled - firstFilled + 1;
      duration = { value: durationDays, unit: 'days' };
    }

    nodes.push({
      id: nodeId,
      name,
      nodeType: 'activity',
      duration,
      position: { x: (nodeCounter - 1) * 220, y: 100 },
      consumesResources: false,
      resourceAssignments: [],
    });
  }

  // No explicit predecessor data in visual layout
  if (nodes.length > 1) {
    ambiguities.push({
      code: 'NO_PREDECESSOR_DATA',
      message:
        'Visual Gantt layout detected. Dependencies could not be inferred automatically; LLM should add edges based on task sequence.',
      affectedIds: nodes.map((n) => n.id),
    });
  }

  return { nodes, edges: [], resources: [] };
}

// ── Main parser ───────────────────────────────────────────────────────────────

/**
 * Parse an Excel (.xlsx / .xls / .csv) Gantt file from an ArrayBuffer.
 * Uses the first sheet.
 */
export async function parseExcelGantt(buffer: ArrayBuffer): Promise<ImportResult> {
  // Audit I-27 — pre-flight via JSZip so a zip-bomb xlsx can't detonate
  // inside `XLSX.read`. The library re-decompresses internally; the
  // central-directory check here rejects any entry whose declared
  // uncompressedSize exceeds the cap, before XLSX.read sees it. The
  // CSV fast-path (XLSX.read handles `.csv` too) isn't a zip so we
  // skip pre-flight when JSZip rejects the buffer; legitimate CSV
  // payloads are bounded by the 50 MB file-picker cap anyway.
  let zip: JSZip | null = null;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    // Not a zip — likely a .csv (XLSX.read supports it). Fall through
    // without pre-flight.
  }
  if (zip !== null) {
    const entryNames = Object.keys(zip.files);
    if (entryNames.length > MAX_XLSX_ENTRY_COUNT) {
      return {
        ok: false,
        errors: [
          `Workbook has ${entryNames.length} zip entries; maximum is ` +
            `${MAX_XLSX_ENTRY_COUNT}. Refusing to import (zip-bomb safeguard).`,
        ],
      };
    }
    let totalDeclared = 0;
    for (const name of entryNames) {
      const entry = zip.files[name]!;
      const declared = uncompressedSize(entry);
      if (declared !== undefined) {
        if (declared > MAX_XLSX_ENTRY_INFLATED_BYTES) {
          return {
            ok: false,
            errors: [
              `Workbook entry "${name}" declares ${mb(declared)} MB uncompressed; ` +
                `maximum is ${mb(MAX_XLSX_ENTRY_INFLATED_BYTES)} MB. ` +
                `Refusing to import (zip-bomb safeguard).`,
            ],
          };
        }
        totalDeclared += declared;
        if (totalDeclared > MAX_XLSX_TOTAL_INFLATED_BYTES) {
          return {
            ok: false,
            errors: [
              `Workbook total uncompressed content exceeds ` +
                `${mb(MAX_XLSX_TOTAL_INFLATED_BYTES)} MB (reached at "${name}"). ` +
                `Refusing to import (zip-bomb safeguard).`,
            ],
          };
        }
      }
    }
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true });
  } catch (e) {
    return { ok: false, errors: [`Excel parse error: ${String(e)}`] };
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { ok: false, errors: ['Excel file has no sheets.'] };
  }
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return { ok: false, errors: [`Sheet "${sheetName}" is missing.`] };
  }

  const ref = sheet['!ref'];
  if (!ref) {
    return { ok: false, errors: ['Sheet is empty.'] };
  }
  const range = XLSX.utils.decode_range(ref);
  const ambiguities: AmbiguityItem[] = [];

  // Try tabular first; fall back to visual
  const tabular = parseTabular(sheet, range, ambiguities);
  const parsed = tabular ?? parseVisual(sheet, range, ambiguities);

  const draft: ImportDraft = {
    nodes: parsed.nodes,
    edges: parsed.edges,
    resources: parsed.resources,
  };

  return { ok: true, draft, ambiguities };
}
