/**
 * PowerPoint (.pptx) diagram parser.
 *
 * A .pptx file is an OOXML ZIP archive. The relevant parts:
 *   ppt/slides/slide1.xml, slide2.xml, … — shape trees per slide
 *
 * Shape geometry → node type mapping:
 *   rect / roundRect / snip* / ellipse-like  → activity
 *   diamond                                  → decision
 *   ellipse with small area OR circular      → start/end (heuristic)
 *   connectors (freeform / straightConnector) → edges
 *
 * Text content: the inner <a:t> elements of each shape give the node name.
 * Duration hints: "2d", "40h", "1w" in parentheses at the end of shape text.
 *
 * Pure function — accepts ArrayBuffer, uses JSZip (works in browser and Node.js).
 */

import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { decodeXmlEntities } from './xml-entities.js';
import type {
  ImportResult,
  ImportDraft,
  ImportedNode,
  ImportedEdge,
  AmbiguityItem,
  ImportedDuration,
} from './types.js';

// ── Zip-bomb hardening ────────────────────────────────────────────────────────
//
// A .pptx is an OOXML zip. Zlib can compress repetitive data at ~1000:1, so a
// 100 MB upload (the upper bound from the picker layer in PR #134) could in
// theory inflate to ~100 GB if we naively call .async('text') on every slide.
// The caps below bound both per-slide and total inflated bytes; the slide-
// count cap stops degenerate-archive variants too. All limits are an order of
// magnitude above any realistic PowerPoint — real decks rarely have more than
// 200 slides, real slide XML is under 100 KB, and total slide XML is under
// 10 MB. A hit here means the input is malicious or corrupt.
const MAX_SLIDE_COUNT = 1000;
const MAX_SLIDE_INFLATED_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_INFLATED_BYTES = 50 * 1024 * 1024;

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}

/**
 * Best-effort pre-inflation size lookup. JSZip's public API doesn't expose
 * the uncompressed size that's already in the zip central directory after
 * `loadAsync`, but its internal `CompressedObject` has it as a stable field
 * across v3.x. If a future JSZip version renames or removes this, the
 * post-inflate check inside the loop is the safety net.
 */
function uncompressedSize(entry: JSZip.JSZipObject): number | undefined {
  const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
  return data?.uncompressedSize;
}

// ── Duration hint extraction ───────────────────────────────────────────────────

const DUR_HINT_RE = /\((\d+(?:\.\d+)?)\s*(h(?:ours?)?|d(?:ays?)?|w(?:eeks?)?)\)/i;

function extractDurationHint(text: string): ImportedDuration | null {
  const m = text.match(DUR_HINT_RE);
  if (!m) return null;
  const val = parseFloat(m[1]!);
  const u = m[2]!.toLowerCase();
  const unit: 'hours' | 'days' | 'weeks' = u.startsWith('h')
    ? 'hours'
    : u.startsWith('w')
      ? 'weeks'
      : 'days';
  return { value: val, unit };
}

function cleanName(text: string): string {
  return text.replace(DUR_HINT_RE, '').trim();
}

// ── OOXML shape type mapping ───────────────────────────────────────────────────

function shapeTypeToNodeType(prst: string): 'activity' | 'decision' | 'start_or_end' | null {
  const p = prst.toLowerCase();
  if (p === 'diamond') return 'decision';
  if (p === 'ellipse' || p === 'oval' || p === 'circle' || p.includes('ellipse'))
    return 'start_or_end';
  if (
    p.includes('rect') ||
    p.includes('round') ||
    p.includes('snip') ||
    p.includes('bevel') ||
    p.includes('pentagon') ||
    p.includes('chevron') ||
    p.includes('process')
  )
    return 'activity';
  // Default anything unrecognized as activity
  return 'activity';
}

// ── fast-xml-parser types (loose) ─────────────────────────────────────────────

type AnyObj = Record<string, unknown>;
type RawShape = AnyObj;

function getText(sp: AnyObj): string {
  const txBody = sp['p:txBody'] as AnyObj | undefined;
  if (!txBody) return '';
  const paras = toArray(txBody['a:p'] as AnyObj | AnyObj[]);
  const texts: string[] = [];
  for (const para of paras) {
    const runs = toArray((para as AnyObj)['a:r'] as AnyObj | AnyObj[]);
    for (const run of runs) {
      const t = (run as AnyObj)['a:t'];
      if (t !== undefined && t !== null) texts.push(String(t));
    }
  }
  // The parser is configured with `processEntities: false` (hardens against
  // entity-expansion DoS), so we decode the five named XML entities here
  // before any downstream string handling.
  return decodeXmlEntities(texts.join('').trim());
}

function getPresetShape(sp: AnyObj): string {
  const spPr = sp['p:spPr'] as AnyObj | undefined;
  if (!spPr) return '';
  const prstGeom = spPr['a:prstGeom'] as AnyObj | undefined;
  if (!prstGeom) return '';
  return String((prstGeom as AnyObj)['@_prst'] ?? '');
}

function getShapeId(sp: AnyObj): string {
  const nvSpPr = sp['p:nvSpPr'] as AnyObj | undefined;
  const cNvPr = nvSpPr?.['p:cNvPr'] as AnyObj | undefined;
  return String(cNvPr?.['@_id'] ?? '');
}

function getPosition(sp: AnyObj): { x: number; y: number } {
  try {
    const spPr = sp['p:spPr'] as AnyObj;
    const xfrm = spPr['a:xfrm'] as AnyObj;
    const off = xfrm['a:off'] as AnyObj;
    // EMUs → pixels at 96dpi (1 inch = 914400 EMU = 96px)
    const x = Math.round(Number(off['@_x'] ?? 0) / 9525);
    const y = Math.round(Number(off['@_y'] ?? 0) / 9525);
    return { x, y };
  } catch {
    return { x: 0, y: 0 };
  }
}

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// ── Connector → edge extraction ────────────────────────────────────────────────

interface RawConnector extends AnyObj {
  'p:nvCxnSpPr'?: AnyObj;
  'p:spPr'?: AnyObj;
}

function getConnectorEndpoints(cxnSp: RawConnector): {
  fromId: string | null;
  toId: string | null;
} {
  try {
    const spPr = cxnSp['p:spPr'] as AnyObj;
    const xfrm = spPr['a:xfrm'] as AnyObj;
    // stCxn = start connection, endCxn = end connection
    const stCxn = xfrm?.['a:stCxn'] as AnyObj | undefined;
    const endCxn = xfrm?.['a:endCxn'] as AnyObj | undefined;
    return {
      fromId: stCxn ? String(stCxn['@_id'] ?? '') : null,
      toId: endCxn ? String(endCxn['@_id'] ?? '') : null,
    };
  } catch {
    return { fromId: null, toId: null };
  }
}

// ── Main parser ───────────────────────────────────────────────────────────────

/**
 * Parse a .pptx file from an ArrayBuffer.
 * Extracts shapes from all slides and maps them to Caladia nodes/edges.
 */
export async function parsePptxDiagram(buffer: ArrayBuffer): Promise<ImportResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (e) {
    return { ok: false, errors: [`ZIP open error: ${String(e)}`] };
  }

  // Enumerate slides
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort();

  if (slideFiles.length === 0) {
    return { ok: false, errors: ['No slides found in .pptx file.'] };
  }

  if (slideFiles.length > MAX_SLIDE_COUNT) {
    return {
      ok: false,
      errors: [`Too many slides (${slideFiles.length}). Maximum is ${MAX_SLIDE_COUNT}.`],
    };
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: true,
    parseAttributeValue: true,
    // Disable entity expansion to remove the billion-laughs DoS vector.
    // The five named XML entities that real OOXML files use are decoded
    // manually in `getText` via decodeXmlEntities().
    processEntities: false,
    isArray: (name) => ['p:sp', 'p:cxnSp', 'a:p', 'a:r', 'p:grpSp'].includes(name),
  });

  const nodes: ImportedNode[] = [];
  const edges: ImportedEdge[] = [];
  const ambiguities: AmbiguityItem[] = [];

  // Map OOXML shape id → Caladia node id (for connector endpoint resolution)
  const shapeIdToNodeId = new Map<string, string>();
  let nodeCounter = 0;
  let edgeCounter = 0;

  // Running total of inflated XML across every slide processed so far. Bounds
  // total memory pressure even when individual slides stay under the per-slide
  // cap (the zip-bomb-by-thousand-cuts variant).
  let totalInflatedBytes = 0;

  for (const slideFile of slideFiles) {
    const entry = zip.files[slideFile]!;

    // Pre-inflation guard: read the size from the zip central directory if
    // JSZip exposes it. Skips the bombing decompression entirely for any
    // slide that wouldn't fit in MAX_SLIDE_INFLATED_BYTES.
    const declaredSize = uncompressedSize(entry);
    if (declaredSize !== undefined && declaredSize > MAX_SLIDE_INFLATED_BYTES) {
      return {
        ok: false,
        errors: [
          `Slide ${slideFile} declares ${mb(declaredSize)} MB uncompressed; ` +
            `maximum is ${mb(MAX_SLIDE_INFLATED_BYTES)} MB. ` +
            `Refusing to import (zip-bomb safeguard).`,
        ],
      };
    }

    const xmlContent = await entry.async('text');

    // Post-inflation safety net in case JSZip's internal shape changed.
    if (xmlContent.length > MAX_SLIDE_INFLATED_BYTES) {
      return {
        ok: false,
        errors: [
          `Slide ${slideFile} inflated to ${mb(xmlContent.length)} MB; ` +
            `maximum is ${mb(MAX_SLIDE_INFLATED_BYTES)} MB.`,
        ],
      };
    }

    totalInflatedBytes += xmlContent.length;
    if (totalInflatedBytes > MAX_TOTAL_INFLATED_BYTES) {
      return {
        ok: false,
        errors: [
          `Total slide content exceeds ${mb(MAX_TOTAL_INFLATED_BYTES)} MB ` +
            `(reached at ${slideFile}). Refusing to import (zip-bomb safeguard).`,
        ],
      };
    }

    let doc: AnyObj;
    try {
      doc = parser.parse(xmlContent) as AnyObj;
    } catch {
      continue; // skip unparseable slides
    }

    // Navigate: p:sld > p:cSld > p:spTree
    const sld = doc['p:sld'] as AnyObj | undefined;
    const cSld = sld?.['p:cSld'] as AnyObj | undefined;
    const spTree = cSld?.['p:spTree'] as AnyObj | undefined;
    if (!spTree) continue;

    // ── Shapes → nodes ─────────────────────────────────────────────────────

    const shapes = toArray(spTree['p:sp'] as RawShape | RawShape[]);
    for (const sp of shapes) {
      const rawText = getText(sp as AnyObj);
      if (!rawText) continue; // skip empty shapes (decorative)

      const shapeId = getShapeId(sp as AnyObj);
      const prst = getPresetShape(sp as AnyObj);
      const mapped = shapeTypeToNodeType(prst);
      if (mapped === null) continue;

      const nodeId = `n${++nodeCounter}`;
      if (shapeId) shapeIdToNodeId.set(shapeId, nodeId);

      const durationHint = extractDurationHint(rawText);
      const name = cleanName(rawText);
      let duration: ImportedDuration;

      if (durationHint) {
        duration = durationHint;
      } else {
        duration = { value: 8, unit: 'hours' };
        ambiguities.push({
          code: 'MISSING_DURATION',
          message: `Shape "${name}" has no duration hint (e.g. "(2d)"). Defaulted to 8h.`,
          affectedIds: [nodeId],
        });
      }

      const pos = getPosition(sp as AnyObj);
      const nodeType: ImportedNode['nodeType'] = mapped === 'start_or_end' ? 'start' : mapped;

      nodes.push({
        id: nodeId,
        name,
        nodeType,
        duration:
          nodeType === 'decision'
            ? duration
            : mapped === 'start_or_end'
              ? { value: 0, unit: 'hours' }
              : duration,
        position: pos,
        consumesResources: nodeType === 'activity' || nodeType === 'decision',
        resourceAssignments: [],
      });
    }

    // ── Connectors → edges ─────────────────────────────────────────────────

    const connectors = toArray(spTree['p:cxnSp'] as RawConnector | RawConnector[]);
    for (const cxnSp of connectors) {
      const { fromId, toId } = getConnectorEndpoints(cxnSp);
      const fromNodeId = fromId ? shapeIdToNodeId.get(fromId) : undefined;
      const toNodeId = toId ? shapeIdToNodeId.get(toId) : undefined;

      if (fromNodeId && toNodeId) {
        edges.push({
          id: `e${++edgeCounter}`,
          from: fromNodeId,
          to: toNodeId,
          type: 'FS',
          lag: { value: 0, unit: 'hours' },
        });
      } else {
        ambiguities.push({
          code: 'UNRESOLVED_CONNECTOR',
          message: `A connector could not be mapped to source/target nodes (fromId=${fromId ?? 'none'}, toId=${toId ?? 'none'}). LLM should infer the edge from layout.`,
          affectedIds: [],
        });
      }
    }
  }

  if (nodes.length === 0) {
    return { ok: false, errors: ['No recognisable shapes with text found in the presentation.'] };
  }

  // Heuristic: re-classify ellipses — leftmost → start, rightmost → end
  const ellipseNodes = nodes.filter((n) => n.nodeType === 'start');
  if (ellipseNodes.length >= 2) {
    const sorted = [...ellipseNodes].sort((a, b) => a.position.x - b.position.x);
    // Keep leftmost as 'start', rightmost as 'end'
    const rightmost = sorted[sorted.length - 1]!;
    const rightmostInList = nodes.find((n) => n.id === rightmost.id);
    if (rightmostInList) {
      rightmostInList.nodeType = 'end';
      rightmostInList.duration = { value: 0, unit: 'hours' };
    }
  }

  const draft: ImportDraft = { nodes, edges, resources: [] };
  return { ok: true, draft, ambiguities };
}
