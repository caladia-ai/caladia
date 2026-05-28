/**
 * MS Project XML parser.
 *
 * Parses the XML format produced by "Save As → XML (.xml)" in MS Project
 * (Project 2003 format, schema: http://schemas.microsoft.com/project).
 *
 * Key mappings:
 *   Task (Milestone=false, Summary=false) → activity node
 *   Task (Milestone=true)                 → start or end node (by position)
 *   Task (Summary=true)                   → skipped (rolled-up parent)
 *   PredecessorLink                       → edge
 *   Resource                              → resource
 *   Assignment                            → resourceAssignment on node
 *
 * Duration format: ISO 8601 — PT[n]H[n]M or P[n]DT[n]H[n]M.
 * LagFormat: tenths of a minute (XML standard for lag) → convert to hours.
 *
 * Pure function — no DOM, no Node.js fs, no network.
 */

import { XMLParser } from 'fast-xml-parser';
import { decodeXmlEntities } from './xml-entities.js';

// Audit I-27 — cap the input XML size to bound parser memory pressure.
// MS Project XML is a single file (no zip layer), so the threat is a
// huge-XML bomb: deeply nested or massively repetitive elements that
// would build a giant object graph inside fast-xml-parser. Real MS
// Project exports of huge projects stay under 10 MB; the 50 MB cap is
// an order of magnitude above any realistic file. `xml.length` is char
// count (≈ bytes for ASCII XML, ≤ 2× bytes for UTF-16 strings, ≤ 4×
// bytes after UTF-8 decode); checking the char count is a tight enough
// proxy.
export const MAX_MSPROJECT_XML_CHARS = 50 * 1024 * 1024;

import type {
  ImportResult,
  ImportDraft,
  ImportedNode,
  ImportedEdge,
  ImportedResource,
  AmbiguityItem,
  ImportedDuration,
  ImportedEdgeType,
} from './types.js';

// ── ISO 8601 duration parsing ─────────────────────────────────────────────────

/**
 * Parse an ISO 8601 duration string to decimal hours.
 * Supports P[nY][nM][nW][nD]T[nH][nM][nS] (any subset).
 * All units are converted using MS Project's documented default
 * working-time conventions (Tools → Options → Calendar):
 *   1 day   =   8 working hours
 *   1 week  =   5 days    =   40 h
 *   1 month =  20 days    =  160 h
 *   1 year  =  12 months  = 1920 h
 * These match what MS Project itself uses when the user enters a duration
 * like "1mo" in the GUI and the XML round-trips as P1M. Honoring
 * per-project CalendarConventions overrides is out of scope (N-29);
 * users on bespoke calendars get a defensible approximation rather than
 * the previous silent drop to zero.
 */
function parseDurationToHours(raw: string | undefined | null): number | null {
  if (!raw) return null;
  // Strip leading/trailing whitespace
  const s = raw.trim();
  // Regex: P[nY][nM][nW][nD][T[nH][nM][nS]]
  const m = s.match(
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!m) return null;

  const [, years, months, weeks, days, hours, minutes, seconds] = m;
  let total = 0;
  if (years) total += parseFloat(years) * 12 * 20 * 8; // 12mo × 20d × 8h
  if (months) total += parseFloat(months) * 20 * 8; // 20 working days, 8h/day
  if (weeks) total += parseFloat(weeks) * 5 * 8; // 5-day week, 8h/day
  if (days) total += parseFloat(days) * 8;
  if (hours) total += parseFloat(hours);
  if (minutes) total += parseFloat(minutes) / 60;
  if (seconds) total += parseFloat(seconds) / 3600;
  return total;
}

function hoursToImportedDuration(hours: number): ImportedDuration {
  if (hours === 0) return { value: 0, unit: 'hours' };
  // Round to nearest 0.25 h; prefer "days" when evenly divisible and ≥ 8 h
  const rounded = Math.round(hours * 4) / 4;
  if (rounded >= 8 && rounded % 8 === 0) {
    return { value: rounded / 8, unit: 'days' };
  }
  return { value: rounded, unit: 'hours' };
}

// ── Predecessor link type mapping ─────────────────────────────────────────────

const TYPE_MAP: Record<number, ImportedEdgeType> = { 0: 'FS', 1: 'SS', 2: 'FF', 3: 'SF' };

// ── Raw XML shapes (fast-xml-parser output) ───────────────────────────────────

interface RawTask {
  UID?: number | string;
  ID?: number | string;
  Name?: string;
  Duration?: string;
  Milestone?: number | string | boolean;
  Summary?: number | string | boolean;
  Notes?: string;
  PredecessorLink?:
    | {
        PredecessorUID?: number | string;
        Type?: number | string;
        LinkLag?: number | string;
      }
    | Array<{
        PredecessorUID?: number | string;
        Type?: number | string;
        LinkLag?: number | string;
      }>;
}

interface RawResource {
  UID?: number | string;
  Name?: string;
  MaxUnits?: number | string;
  Type?: number | string; // 0=Work, 1=Material, 2=Cost
}

interface RawAssignment {
  TaskUID?: number | string;
  ResourceUID?: number | string;
  Units?: number | string;
}

interface RawProject {
  Task?: RawTask | RawTask[];
  Resource?: RawResource | RawResource[];
  Assignment?: RawAssignment | RawAssignment[];
  Name?: string;
  StartDate?: string;
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function toBoolean(v: number | string | boolean | undefined): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true';
  return false;
}

function toString(v: number | string | undefined): string {
  if (v === undefined || v === null) return '';
  // The parser is configured with `processEntities: false` (hardens against
  // entity-expansion DoS), so we decode the five named XML entities here
  // before any downstream string handling. No-op for numeric / non-entity
  // values like UIDs.
  return decodeXmlEntities(String(v));
}

// ── Main parser ───────────────────────────────────────────────────────────────

/**
 * Parse an MS Project XML string into an ImportDraft + ambiguity list.
 *
 * @param xml - Raw contents of an `.xml` MS Project export.
 */
export function parseMsProjectXml(xml: string): ImportResult {
  // Audit I-27 — refuse oversized input before fast-xml-parser builds
  // its in-memory tree. `xml.length` is char count, which is ≤ 2× the
  // UTF-16 byte budget; close enough as a gate.
  if (xml.length > MAX_MSPROJECT_XML_CHARS) {
    return {
      ok: false,
      errors: [
        `MS Project XML is ${(xml.length / 1024 / 1024).toFixed(0)} MB; ` +
          `maximum is ${(MAX_MSPROJECT_XML_CHARS / 1024 / 1024).toFixed(0)} MB. ` +
          `Refusing to import (huge-XML safeguard).`,
      ],
    };
  }

  let rawProject: RawProject;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: true,
      parseAttributeValue: true,
      // Disable entity expansion to remove the billion-laughs DoS vector.
      // The five named XML entities used by real MS Project XML files are
      // decoded manually in `toString` via decodeXmlEntities().
      processEntities: false,
      // fast-xml-parser strips the root namespace — we access nested Project directly
    });
    const doc = parser.parse(xml) as Record<string, unknown>;
    // MS Project XML root is <Project> (with optional ns prefix stripped by fxp)
    const root = (doc['Project'] ?? doc['msp:Project'] ?? doc) as Record<string, unknown>;
    rawProject = root as RawProject;
  } catch (e) {
    return { ok: false, errors: [`XML parse error: ${String(e)}`] };
  }

  const tasks = toArray(rawProject.Task);
  const resources = toArray(rawProject.Resource);
  const assignments = toArray(rawProject.Assignment);

  const nodes: ImportedNode[] = [];
  const edges: ImportedEdge[] = [];
  const importedResources: ImportedResource[] = [];
  const ambiguities: AmbiguityItem[] = [];

  // ── Resources ──────────────────────────────────────────────────────────────

  // UID 0 is the MS Project "unassigned" pseudo-resource — skip it.
  for (const r of resources) {
    const uid = toString(r.UID);
    if (!uid || uid === '0') continue;
    // Skip non-work resources (material/cost)
    const type = r.Type !== undefined ? Number(r.Type) : 0;
    if (type !== 0) continue;
    const capacity = r.MaxUnits !== undefined ? Math.round(Number(r.MaxUnits)) : 1;
    importedResources.push({
      id: `r${uid}`,
      name: r.Name !== undefined ? decodeXmlEntities(String(r.Name)) : `Resource ${uid}`,
      capacity: Math.max(1, capacity),
    });
  }

  const resourceIdSet = new Set(importedResources.map((r) => r.id));

  // ── Task → resource assignments (keyed by task UID) ────────────────────────

  const taskAssignments = new Map<string, Array<{ resourceId: string; count: number }>>();
  for (const a of assignments) {
    const taskUid = toString(a.TaskUID);
    const resUid = toString(a.ResourceUID);
    if (!taskUid || !resUid || resUid === '0') continue;
    const resourceId = `r${resUid}`;
    if (!resourceIdSet.has(resourceId)) continue;
    const count = a.Units !== undefined ? Math.max(1, Math.round(Number(a.Units))) : 1;
    const existing = taskAssignments.get(taskUid);
    if (existing) {
      existing.push({ resourceId, count });
    } else {
      taskAssignments.set(taskUid, [{ resourceId, count }]);
    }
  }

  // ── Tasks → nodes + edges ──────────────────────────────────────────────────

  // Track which UIDs become milestone nodes for edge rewiring
  const milestoneUids = new Set<string>();
  let edgeCounter = 0;
  let xOffset = 0;

  for (const task of tasks) {
    const uid = toString(task.UID);
    if (!uid || uid === '0') continue; // UID 0 = project summary

    const isMilestone = toBoolean(task.Milestone);
    const isSummary = toBoolean(task.Summary);

    // Summary tasks are rolled-up parents — skip to avoid double-counting
    if (isSummary) continue;

    const nodeId = `n${uid}`;
    const name = task.Name !== undefined ? decodeXmlEntities(String(task.Name)) : `Task ${uid}`;

    if (isMilestone) {
      milestoneUids.add(uid);
      nodes.push({
        id: nodeId,
        name,
        nodeType: 'start', // LLM may reclassify end milestones
        duration: { value: 0, unit: 'hours' },
        position: { x: xOffset, y: 100 },
        consumesResources: false,
        resourceAssignments: [],
        ...(task.Notes !== undefined ? { notes: decodeXmlEntities(String(task.Notes)) } : {}),
      });
    } else {
      const rawDur = task.Duration;
      const hours = parseDurationToHours(rawDur);
      let duration: ImportedDuration;
      if (hours === null || hours <= 0) {
        duration = { value: 8, unit: 'hours' }; // default: 1 day
        ambiguities.push({
          code: 'MISSING_DURATION',
          message: `Task "${name}" (UID ${uid}) has no parseable duration; defaulted to 8 hours.`,
          affectedIds: [nodeId],
        });
      } else {
        duration = hoursToImportedDuration(hours);
      }

      const asgns = taskAssignments.get(uid) ?? [];
      nodes.push({
        id: nodeId,
        name,
        nodeType: 'activity',
        duration,
        position: { x: xOffset, y: 100 },
        consumesResources: asgns.length > 0,
        resourceAssignments: asgns.map((a) => ({
          resourceId: a.resourceId,
          count: a.count,
          calendarPolicy: 'intersection' as const,
        })),
        ...(task.Notes !== undefined ? { notes: decodeXmlEntities(String(task.Notes)) } : {}),
      });
    }

    xOffset += 220;

    // ── Predecessor links → edges ────────────────────────────────────────────

    const links = toArray(task.PredecessorLink);
    for (const link of links) {
      const predUid = toString(link.PredecessorUID);
      if (!predUid) continue;

      const typeNum = link.Type !== undefined ? Number(link.Type) : 0;
      const edgeType: ImportedEdgeType = TYPE_MAP[typeNum] ?? 'FS';

      // LinkLag is in tenths of a minute in MS Project XML
      const lagTenthMinutes = link.LinkLag !== undefined ? Number(link.LinkLag) : 0;
      const lagHours = lagTenthMinutes / 600; // tenths-of-min → hours

      edges.push({
        id: `e${++edgeCounter}`,
        from: `n${predUid}`,
        to: nodeId,
        type: edgeType,
        lag:
          Math.abs(lagHours) < 0.001
            ? { value: 0, unit: 'hours' }
            : { value: Math.round(lagHours * 4) / 4, unit: 'hours' },
      });
    }
  }

  // ── Reclassify milestone nodes: last one in topological order → 'end' ──────
  // Simple heuristic: a milestone with no successors is likely the project end.
  const hasSuccessor = new Set(edges.map((e) => e.from));
  for (const node of nodes) {
    if (node.nodeType === 'start' && !hasSuccessor.has(node.id)) {
      node.nodeType = 'end';
    }
  }

  // ── Project-level metadata ─────────────────────────────────────────────────

  let startDate: string | undefined;
  const rawStart = rawProject.StartDate;
  if (rawStart) {
    // MS Project may give "2025-01-06T00:00:00" — take the date part
    const dateMatch = String(rawStart).match(/^(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) startDate = dateMatch[1];
  }

  const draft: ImportDraft = {
    ...(rawProject.Name !== undefined
      ? { projectName: decodeXmlEntities(String(rawProject.Name)) }
      : {}),
    ...(startDate !== undefined ? { startDate } : {}),
    nodes,
    edges,
    resources: importedResources,
  };

  return { ok: true, draft, ambiguities };
}
