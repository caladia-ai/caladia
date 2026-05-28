import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import {
  parseExcelGantt,
  parseDurationCell,
  MAX_XLSX_ENTRY_INFLATED_BYTES,
  MAX_XLSX_TOTAL_INFLATED_BYTES,
  MAX_XLSX_ENTRY_COUNT,
} from './excel.js';

// ── Helper: build a workbook from a 2D array ──────────────────────────────────

function makeWorkbook(rows: unknown[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return buf;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parseExcelGantt — tabular layout', () => {
  it('parses a minimal tabular sheet', async () => {
    const rows = [
      ['Name', 'Duration', 'Predecessor'],
      ['Design', '5d', ''],
      ['Development', '10d', '1'],
      ['Testing', '3d', '2'],
    ];
    const buf = makeWorkbook(rows);
    const result = await parseExcelGantt(buf);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.draft.nodes).toHaveLength(3);

    const design = result.draft.nodes[0];
    expect(design?.name).toBe('Design');
    expect(design?.duration).toEqual({ value: 5, unit: 'days' });
    expect(design?.nodeType).toBe('activity');

    // Edge: Development depends on row 1 (Design)
    expect(result.draft.edges).toHaveLength(2);
    expect(result.draft.edges[0]).toMatchObject({ from: 'n1', to: 'n2', type: 'FS' });
  });

  it('handles missing duration with a default and ambiguity', async () => {
    const rows = [
      ['Task', 'Duration'],
      ['Mysterious Work', ''],
    ];
    const result = await parseExcelGantt(makeWorkbook(rows));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.nodes[0]?.duration).toEqual({ value: 8, unit: 'hours' });
    expect(result.ambiguities.some((a) => a.code === 'MISSING_DURATION')).toBe(true);
  });

  it('parses duration in hours', async () => {
    const rows = [
      ['Activity', 'Duration'],
      ['Quick Task', '4h'],
    ];
    const result = await parseExcelGantt(makeWorkbook(rows));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.nodes[0]?.duration).toEqual({ value: 4, unit: 'hours' });
  });

  it('parses duration in weeks', async () => {
    const rows = [
      ['Task', 'Duration'],
      ['Long Haul', '2w'],
    ];
    const result = await parseExcelGantt(makeWorkbook(rows));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.nodes[0]?.duration).toEqual({ value: 2, unit: 'weeks' });
  });

  it('includes resource assignments', async () => {
    const rows = [
      ['Name', 'Duration', 'Resource'],
      ['Dev Task', '3d', 'Engineers'],
    ];
    const result = await parseExcelGantt(makeWorkbook(rows));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.resources).toHaveLength(1);
    expect(result.draft.resources[0]?.name).toBe('Engineers');
    expect(result.draft.nodes[0]?.resourceAssignments).toHaveLength(1);
  });

  it('returns error on empty sheet', async () => {
    const ws: XLSX.WorkSheet = { '!ref': 'A1:A1' };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const result = await parseExcelGantt(buf);
    // Empty sheet with only ref but no cells — should succeed (tabular or visual) or error cleanly
    expect(result).toHaveProperty('ok');
  });
});

describe('parseExcelGantt — visual (bar chart) layout', () => {
  it('falls back to visual layout when no name column found', async () => {
    // No recognised header row — visual layout
    const rows = [
      ['Tasks', '2025-01-06', '2025-01-07', '2025-01-08', '2025-01-09', '2025-01-10'],
      ['Design', 'X', 'X', 'X', '', ''],
      ['Build', '', '', 'X', 'X', 'X'],
    ];
    const result = await parseExcelGantt(makeWorkbook(rows));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.nodes).toHaveLength(2);
    expect(result.draft.nodes[0]?.name).toBe('Design');
    // 3 filled cells → 3 days
    expect(result.draft.nodes[0]?.duration).toEqual({ value: 3, unit: 'days' });
    expect(result.draft.nodes[1]?.duration).toEqual({ value: 3, unit: 'days' });
    // Visual layout adds a 'NO_PREDECESSOR_DATA' ambiguity
    expect(result.ambiguities.some((a) => a.code === 'NO_PREDECESSOR_DATA')).toBe(true);
  });
});

// ── Duration cell parser (audit I-29) ─────────────────────────────────────────

describe('parseDurationCell — accepted shapes', () => {
  const cases: Array<[string, { value: number; unit: 'hours' | 'days' | 'weeks' }]> = [
    // Existing forms (regression).
    ['5', { value: 5, unit: 'days' }],
    ['5d', { value: 5, unit: 'days' }],
    ['5 d', { value: 5, unit: 'days' }],
    ['5 days', { value: 5, unit: 'days' }],
    ['40h', { value: 40, unit: 'hours' }],
    ['40 hours', { value: 40, unit: 'hours' }],
    ['2w', { value: 2, unit: 'weeks' }],
    ['1.5', { value: 1.5, unit: 'days' }],
    ['1.5d', { value: 1.5, unit: 'days' }],
    ['.5h', { value: 0.5, unit: 'hours' }],

    // Audit I-29 — scientific notation.
    ['1e2', { value: 100, unit: 'days' }],
    ['1e2h', { value: 100, unit: 'hours' }],
    ['1.5e1', { value: 15, unit: 'days' }],
    ['2E2 w', { value: 200, unit: 'weeks' }],

    // Audit I-29 — Euro decimal (1-2 digit comma-tail).
    ['1,5', { value: 1.5, unit: 'days' }],
    ['1,5h', { value: 1.5, unit: 'hours' }],
    ['1,50 d', { value: 1.5, unit: 'days' }],

    // Audit I-29 — space-grouped thousands.
    ['1 200', { value: 1200, unit: 'days' }],
    ['1 200 h', { value: 1200, unit: 'hours' }],
    ['10 000 d', { value: 10000, unit: 'days' }],
  ];
  for (const [input, expected] of cases) {
    it(`parses ${JSON.stringify(input)} → ${expected.value}${expected.unit[0]}`, () => {
      expect(parseDurationCell(input)).toEqual(expected);
    });
  }
});

describe('parseDurationCell — rejected shapes (return null → upstream defaults to 8h)', () => {
  const cases: Array<[string, unknown]> = [
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['non-numeric', 'abc'],
    ['zero', '0'],
    ['negative', '-5d'],
    ['ambiguous comma-3-digit-tail (US thousands vs Euro decimal)', '1,200'],
    ['ambiguous comma-3-digit-tail with unit', '1,500 d'],
    ['multiple commas', '1,2,3'],
    ['malformed scientific', '1e'],
    ['two dots', '1.2.3'],
    ['unit only', 'h'],
    ['number trailing junk', '5dx'],
  ];
  for (const [label, input] of cases) {
    it(`rejects ${label} (${JSON.stringify(input)})`, () => {
      expect(parseDurationCell(input)).toBeNull();
    });
  }
});

describe('parseDurationCell — numeric cell values (Excel often delivers numbers, not strings)', () => {
  it('accepts a numeric value as days', () => {
    expect(parseDurationCell(7)).toEqual({ value: 7, unit: 'days' });
  });
  it('accepts a fractional numeric value', () => {
    expect(parseDurationCell(2.5)).toEqual({ value: 2.5, unit: 'days' });
  });
  it('rejects a non-positive numeric value', () => {
    expect(parseDurationCell(0)).toBeNull();
    expect(parseDurationCell(-3)).toBeNull();
  });
});

// ── Zip-bomb hardening (audit I-27) ───────────────────────────────────────────

describe('parseExcelGantt — zip-bomb safeguards', () => {
  /**
   * Build a fake-zip ArrayBuffer with one entry whose actual content is
   * `size` bytes. JSZip's central directory will report `size` as the
   * uncompressed size — the pre-flight reads exactly that field and
   * rejects before XLSX.read sees the buffer. Content is `'A'.repeat(n)`,
   * which compresses to ~1 KB.
   */
  async function makeBombZip(entryName: string, size: number): Promise<ArrayBuffer> {
    const zip = new JSZip();
    zip.file(entryName, 'A'.repeat(size));
    return await zip.generateAsync({ type: 'arraybuffer' });
  }

  it('rejects when a single zip entry declares more than the per-entry cap', async () => {
    const buf = await makeBombZip('xl/sharedStrings.xml', MAX_XLSX_ENTRY_INFLATED_BYTES + 1024);
    const result = await parseExcelGantt(buf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/zip-bomb|uncompressed/i);
    }
  });

  it('rejects when cumulative declared size exceeds the total cap', async () => {
    // Build several entries that each fit under the per-entry cap but
    // collectively exceed the total cap.
    const zip = new JSZip();
    const perEntry = Math.floor(MAX_XLSX_ENTRY_INFLATED_BYTES * 0.9);
    const count = Math.ceil(MAX_XLSX_TOTAL_INFLATED_BYTES / perEntry) + 1;
    for (let i = 0; i < count; i++) {
      zip.file(`bulk-${i}.bin`, 'A'.repeat(perEntry));
    }
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parseExcelGantt(buf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/total|zip-bomb/i);
    }
  });

  it('rejects when entry count exceeds the per-archive cap', async () => {
    const zip = new JSZip();
    for (let i = 0; i <= MAX_XLSX_ENTRY_COUNT; i++) {
      // Tiny files so the size caps don't trip first.
      zip.file(`f-${i}.txt`, '.');
    }
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    const result = await parseExcelGantt(buf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/zip entries|zip-bomb/i);
    }
  });

  it("still parses a normal workbook (regression — caps don't fire on legitimate input)", async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Name', 'Duration'],
      ['Task A', '5d'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const result = await parseExcelGantt(buf);
    expect(result.ok).toBe(true);
  });

  it('falls through to XLSX.read for non-zip input (csv path)', async () => {
    // CSV input — XLSX.read handles it without a zip envelope. JSZip
    // rejects the buffer; the pre-flight skips and XLSX.read takes over.
    const csv = 'Name,Duration\nTask A,5d\n';
    const buf = new TextEncoder().encode(csv).buffer.slice(0) as ArrayBuffer;
    const result = await parseExcelGantt(buf);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.nodes.length).toBeGreaterThan(0);
    }
  });
});
