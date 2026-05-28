import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parsePptxDiagram } from './pptx.js';

// ── Helper: build a minimal .pptx buffer ──────────────────────────────────────
//
// A .pptx file is a ZIP (OOXML) containing several XML parts. We only need
// a minimal slide XML to exercise the parser.

async function makeMinimalPptx(
  shapes: Array<{
    id: number;
    prst: string; // preset shape name, e.g. 'rect', 'diamond', 'ellipse'
    text: string; // text content (may include duration hint)
    x?: number; // EMU offset (optional; used for start/end heuristic)
  }>,
  connectors: Array<{ fromId: number; toId: number }> = [],
): Promise<ArrayBuffer> {
  // Build shape XML
  const spXml = shapes
    .map(
      (s) => `
    <p:sp>
      <p:nvSpPr>
        <p:cNvPr id="${s.id}" name="Shape ${s.id}"/>
        <p:nvPr/>
      </p:nvSpPr>
      <p:spPr>
        <a:xfrm>
          <a:off x="${s.x ?? (s.id - 1) * 500000}" y="500000"/>
          <a:ext cx="1500000" cy="800000"/>
        </a:xfrm>
        <a:prstGeom prst="${s.prst}"><a:avLst/></a:prstGeom>
      </p:spPr>
      <p:txBody>
        <a:bodyPr/>
        <a:p><a:r><a:t>${s.text}</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>`,
    )
    .join('\n');

  const cxnXml = connectors
    .map(
      (c, i) => `
    <p:cxnSp>
      <p:nvCxnSpPr>
        <p:cNvPr id="${1000 + i}" name="Connector ${i}"/>
        <p:nvPr/>
      </p:nvCxnSpPr>
      <p:spPr>
        <a:xfrm>
          <a:stCxn id="${c.fromId}" idx="3"/>
          <a:endCxn id="${c.toId}" idx="1"/>
        </a:xfrm>
        <a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>
      </p:spPr>
    </p:cxnSp>`,
    )
    .join('\n');

  const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${spXml}
      ${cxnXml}
    </p:spTree>
  </p:cSld>
</p:sld>`;

  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', slideXml);
  // Minimal required OOXML parts (parsers checks for slide files only)
  const buf = await zip.generateAsync({ type: 'arraybuffer' });
  return buf;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parsePptxDiagram', () => {
  it('parses rect shapes as activity nodes', async () => {
    const buf = await makeMinimalPptx([
      { id: 2, prst: 'rect', text: 'Design (5d)' },
      { id: 3, prst: 'rect', text: 'Development (10d)' },
    ]);
    const result = await parsePptxDiagram(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.nodes).toHaveLength(2);
    expect(result.draft.nodes[0]?.nodeType).toBe('activity');
    expect(result.draft.nodes[0]?.name).toBe('Design');
    expect(result.draft.nodes[0]?.duration).toEqual({ value: 5, unit: 'days' });
    expect(result.draft.nodes[1]?.duration).toEqual({ value: 10, unit: 'days' });
  });

  it('classifies diamond shapes as decision nodes', async () => {
    const buf = await makeMinimalPptx([
      { id: 2, prst: 'rect', text: 'Task (8h)' },
      { id: 3, prst: 'diamond', text: 'Review Gate (4h)' },
    ]);
    const result = await parsePptxDiagram(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decision = result.draft.nodes.find((n) => n.nodeType === 'decision');
    expect(decision).toBeDefined();
    expect(decision?.name).toBe('Review Gate');
    expect(decision?.duration).toEqual({ value: 4, unit: 'hours' });
  });

  it('classifies ellipses as start/end by x-position', async () => {
    const buf = await makeMinimalPptx([
      { id: 2, prst: 'ellipse', text: 'Start', x: 0 },
      { id: 3, prst: 'rect', text: 'Work (3d)', x: 1000000 },
      { id: 4, prst: 'ellipse', text: 'End', x: 2000000 },
    ]);
    const result = await parsePptxDiagram(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const startNode = result.draft.nodes.find((n) => n.name === 'Start');
    const endNode = result.draft.nodes.find((n) => n.name === 'End');
    expect(startNode?.nodeType).toBe('start');
    expect(endNode?.nodeType).toBe('end');
  });

  it('maps connectors to edges when endpoints are present', async () => {
    const buf = await makeMinimalPptx(
      [
        { id: 2, prst: 'rect', text: 'A (1d)' },
        { id: 3, prst: 'rect', text: 'B (2d)' },
      ],
      [{ fromId: 2, toId: 3 }],
    );
    const result = await parsePptxDiagram(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.edges).toHaveLength(1);
    expect(result.draft.edges[0]).toMatchObject({ type: 'FS' });
  });

  it('adds MISSING_DURATION ambiguity for shapes without hint', async () => {
    const buf = await makeMinimalPptx([{ id: 2, prst: 'rect', text: 'Undated Task' }]);
    const result = await parsePptxDiagram(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.nodes[0]?.duration).toEqual({ value: 8, unit: 'hours' });
    expect(result.ambiguities.some((a) => a.code === 'MISSING_DURATION')).toBe(true);
  });

  it('returns error on non-pptx data', async () => {
    const buf = new TextEncoder().encode('not a zip file').buffer;
    const result = await parsePptxDiagram(buf);
    expect(result.ok).toBe(false);
  });

  // ── Zip-bomb safeguards ──────────────────────────────────────────────────
  //
  // A .pptx is an OOXML zip; without a cap, a crafted entry could inflate
  // to gigabytes. The parser refuses to import past the MAX_SLIDE_COUNT /
  // MAX_SLIDE_INFLATED_BYTES / MAX_TOTAL_INFLATED_BYTES thresholds in
  // pptx.ts. The fixtures here are sized to exercise those exact thresholds.

  it('rejects a .pptx with more than MAX_SLIDE_COUNT slides', async () => {
    // Build a zip with 1001 minimal slide XMLs. Highly compressible, so the
    // on-disk fixture is small even though slide count is large.
    const zip = new JSZip();
    const minimalSlide = `<?xml version="1.0"?><p:sld xmlns:p="x"><p:cSld><p:spTree/></p:cSld></p:sld>`;
    for (let i = 1; i <= 1001; i++) {
      zip.file(`ppt/slides/slide${i}.xml`, minimalSlide);
    }
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parsePptxDiagram(buf);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/Too many slides \(1001\)/);
  });

  it('rejects a .pptx whose slide XML inflates beyond MAX_SLIDE_INFLATED_BYTES', async () => {
    // 11 MB of repetitive content — deflates to a tiny on-disk size but
    // would inflate past the 10 MB per-slide cap if we processed it.
    const huge = 'A'.repeat(11 * 1024 * 1024);
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', huge);
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parsePptxDiagram(buf);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/declares 11 MB uncompressed|inflated to 11 MB/);
  });

  // The parser is configured with `processEntities: false` as a hardening
  // measure against entity-expansion DoS. The five named XML entities used
  // by real .pptx shape text still need to round-trip — they're decoded
  // manually inside the `getText` helper.
  it('decodes named XML entities in shape text', async () => {
    const buf = await makeMinimalPptx([
      // Real shape text in a PPTX would be stored as the encoded form below.
      { id: 2, prst: 'rect', text: 'Design &amp; Build (2d)' },
      { id: 3, prst: 'rect', text: 'a &lt; b &gt; c (1d)' },
      { id: 4, prst: 'rect', text: 'say &quot;hi&quot; (1d)' },
      { id: 5, prst: 'rect', text: 'it&apos;s done (1d)' },
    ]);
    const result = await parsePptxDiagram(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // extractDurationHint runs after the entity-decode and strips the
    // duration suffix from the node name; the leading literal text is
    // what we're asserting.
    const names = result.draft.nodes.map((n) => n.name);
    expect(names).toContain('Design & Build');
    expect(names).toContain('a < b > c');
    expect(names).toContain('say "hi"');
    expect(names).toContain("it's done");
  });
});
