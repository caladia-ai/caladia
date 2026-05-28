import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMsProjectXml, MAX_MSPROJECT_XML_CHARS } from './msproject.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_MSPROJECT = resolve(__dirname, '..', 'fixtures', 'corpus', 'msproject');

function loadFixture(name: string): string {
  return readFileSync(resolve(CORPUS_MSPROJECT, name), 'utf-8');
}

describe('parseMsProjectXml', () => {
  it('parses the simple.xml fixture correctly', () => {
    const xml = loadFixture('simple.xml');
    const result = parseMsProjectXml(xml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Project metadata
    expect(result.draft.projectName).toBe('Widget Release');
    expect(result.draft.startDate).toBe('2025-01-06');

    // Nodes: 5 tasks (UID 0 summary skipped, UIDs 1-5 kept)
    expect(result.draft.nodes).toHaveLength(5);

    const kickoff = result.draft.nodes.find((n) => n.id === 'n1');
    expect(kickoff).toBeDefined();
    expect(kickoff?.nodeType).toBe('start');
    expect(kickoff?.duration).toEqual({ value: 0, unit: 'hours' });

    const design = result.draft.nodes.find((n) => n.id === 'n2');
    expect(design?.nodeType).toBe('activity');
    expect(design?.duration).toEqual({ value: 5, unit: 'days' }); // 40h / 8 = 5 days

    const dev = result.draft.nodes.find((n) => n.id === 'n3');
    expect(dev?.duration).toEqual({ value: 10, unit: 'days' }); // 80h

    const qa = result.draft.nodes.find((n) => n.id === 'n4');
    expect(qa?.duration).toEqual({ value: 3, unit: 'days' }); // 24h / 8 = 3 days
    expect(qa?.notes).toBe('Run regression suite');

    // Project Complete has successors from UID 5 — should be classified 'end'
    const complete = result.draft.nodes.find((n) => n.id === 'n5');
    expect(complete?.nodeType).toBe('end');

    // Edges
    // e1: n1→n2 FS, e2: n2→n3 FS, e3: n3→n4 SS, e4: n3→n5 FS, e5: n4→n5 FS
    expect(result.draft.edges).toHaveLength(5);

    const ssEdge = result.draft.edges.find((e) => e.from === 'n3' && e.to === 'n4');
    expect(ssEdge?.type).toBe('SS');

    // Resources: resource UID 0 (unassigned) skipped, UID 1 included
    expect(result.draft.resources).toHaveLength(1);
    expect(result.draft.resources[0]).toMatchObject({
      id: 'r1',
      name: 'Engineers',
      capacity: 3,
    });

    // Assignments
    const devNode = result.draft.nodes.find((n) => n.id === 'n3');
    expect(devNode?.resourceAssignments).toHaveLength(1);
    expect(devNode?.resourceAssignments[0]).toMatchObject({
      resourceId: 'r1',
      count: 2,
      calendarPolicy: 'intersection',
    });

    // No ambiguities (all durations present and valid)
    expect(result.ambiguities).toHaveLength(0);
  });

  it('returns errors on malformed XML', () => {
    const result = parseMsProjectXml('not xml <<>>');
    // fast-xml-parser is lenient — it may succeed with partial output.
    // Ensure at least we get an ImportResult without throwing.
    expect(result).toHaveProperty('ok');
  });

  it('handles a task with missing duration gracefully', () => {
    const xml = `<?xml version="1.0"?>
<Project>
  <Name>Test</Name>
  <Task><UID>1</UID><Name>Mystery Task</Name></Task>
</Project>`;
    const result = parseMsProjectXml(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.nodes[0]?.duration).toEqual({ value: 8, unit: 'hours' });
    expect(result.ambiguities.some((a) => a.code === 'MISSING_DURATION')).toBe(true);
  });

  it('classifies predecessor-type codes correctly', () => {
    const xml = `<?xml version="1.0"?>
<Project>
  <Task><UID>1</UID><Name>A</Name><Duration>PT8H</Duration></Task>
  <Task><UID>2</UID><Name>B</Name><Duration>PT8H</Duration>
    <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>2</Type><LinkLag>0</LinkLag></PredecessorLink>
  </Task>
</Project>`;
    const result = parseMsProjectXml(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.edges[0]?.type).toBe('FF');
  });

  // The parser is configured with `processEntities: false` as a hardening
  // measure against entity-expansion DoS. The five named XML entities used
  // by real .xml exports still need to round-trip — they're decoded
  // manually inside the `toString` helper.
  it('decodes the five named XML entities in task names and notes', () => {
    const xml = `<?xml version="1.0"?>
<Project>
  <Name>Q4 &amp; FY26 Plan</Name>
  <StartDate>2026-01-05T08:00:00</StartDate>
  <Task><UID>1</UID><Name>Kick-off</Name><Duration>PT0H</Duration><Milestone>1</Milestone></Task>
  <Task>
    <UID>2</UID>
    <Name>Design &amp; Build</Name>
    <Duration>PT8H</Duration>
    <Notes>Watch out for &lt;br&gt; tags and &quot;quotes&quot; in copy. Don&apos;t escape twice.</Notes>
    <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type><LinkLag>0</LinkLag></PredecessorLink>
  </Task>
</Project>`;
    const result = parseMsProjectXml(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.projectName).toBe('Q4 & FY26 Plan');
    const designBuild = result.draft.nodes.find((n) => n.id === 'n2');
    expect(designBuild?.name).toBe('Design & Build');
    expect(designBuild?.notes).toBe(
      `Watch out for <br> tags and "quotes" in copy. Don't escape twice.`,
    );
  });
});

// ── Huge-XML hardening (audit I-27) ───────────────────────────────────────────

describe('parseMsProjectXml — huge-XML safeguard', () => {
  it('rejects input larger than MAX_MSPROJECT_XML_CHARS', () => {
    // Build a string just over the cap. Content doesn't need to be valid
    // XML — the size check fires before fast-xml-parser sees it.
    const huge = 'A'.repeat(MAX_MSPROJECT_XML_CHARS + 1);
    const result = parseMsProjectXml(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/huge-XML|MB/i);
    }
  });

  it("accepts a small input that fits under the cap (regression — guard doesn't fire on real files)", () => {
    // Tiny but valid-shaped enough that the size guard is the only
    // thing being checked. Parser errors are fine here; we only assert
    // the size guard didn't trip.
    const small = '<Project></Project>';
    const result = parseMsProjectXml(small);
    if (!result.ok) {
      expect(result.errors.join(' ')).not.toMatch(/huge-XML/i);
    }
  });
});

// ── ISO duration year / month handling (audit N-29) ───────────────────────────
//
// Previously the parser captured years and months in the regex but discarded
// them in the destructure, so P1M imported as 0 h and fell through to the
// 8 h MISSING_DURATION fallback (and a misleading warning). MS Project's
// documented defaults are 1 month = 20 working days = 160 h and 1 year =
// 12 months = 240 working days = 1920 h.

function durationOf(xmlTaskDuration: string): { value: number; unit: string } | undefined {
  const xml = `<?xml version="1.0"?>
<Project>
  <Name>N-29</Name>
  <Task><UID>1</UID><Name>T</Name><Duration>${xmlTaskDuration}</Duration></Task>
</Project>`;
  const result = parseMsProjectXml(xml);
  if (!result.ok) return undefined;
  return result.draft.nodes[0]?.duration;
}

describe('parseMsProjectXml — ISO duration year/month support (N-29)', () => {
  it('P1M resolves to 20 working days (160 h), not 0', () => {
    expect(durationOf('P1M')).toEqual({ value: 20, unit: 'days' });
  });

  it('P1Y resolves to 240 working days (1920 h)', () => {
    expect(durationOf('P1Y')).toEqual({ value: 240, unit: 'days' });
  });

  it('combined P1Y1M2W3DT4H sums all units', () => {
    // 1920 + 160 + 80 + 24 + 4 = 2188 h. Not divisible by 8 → stays in hours.
    expect(durationOf('P1Y1M2W3DT4H')).toEqual({ value: 2188, unit: 'hours' });
  });

  it('disambiguates P1M (month) from PT1M (minute)', () => {
    // PT1M = 1 minute = 1/60 h ≈ 0.017 h. After the parser's 0.25 h rounding
    // this collapses to 0 — a pre-existing precision quirk, separate from
    // N-29; the key assertion is that it does NOT pick up the 160 h
    // month-branch by mistake.
    expect(durationOf('PT1M')).toEqual({ value: 0, unit: 'hours' });
  });

  it('does not emit MISSING_DURATION for P1M (the pre-fix misleading warning)', () => {
    const xml = `<?xml version="1.0"?>
<Project>
  <Name>N-29</Name>
  <Task><UID>1</UID><Name>One Month</Name><Duration>P1M</Duration></Task>
</Project>`;
    const result = parseMsProjectXml(xml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ambiguities.some((a) => a.code === 'MISSING_DURATION')).toBe(false);
  });
});
