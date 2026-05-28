/**
 * Audit N-7 — smoke tests for `runValidate` and the CLI formatters.
 *
 * Pure logic (no spawned process). The Commander wrapper in `index.ts`
 * adds only file-read + stdout/stderr writes on top of these; that's
 * thin enough that smoke-testing the pure functions is the right fit.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  runValidate,
  formatSummaryLine,
  formatTruncationWarnings,
  formatErrors,
  type ProjectSummary,
} from './validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, '..', '__fixtures__', 'linear-chain.cala');

function loadFixture(): string {
  return readFileSync(FIXTURE_PATH, 'utf8');
}

describe('runValidate', () => {
  it('returns ok with a summary for the linear-chain fixture', () => {
    const result = runValidate({ contents: loadFixture() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.version).toBe(8);
    expect(result.summary.nodes).toBeGreaterThan(0);
    expect(result.summary.edges).toBeGreaterThan(0);
    expect(result.truncationWarnings).toEqual([]);
  });

  it('returns ok=false with structured errors for non-JSON input', () => {
    const result = runValidate({ contents: 'this is not json' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.path).toBeDefined();
    expect(result.errors[0]?.message).toBeDefined();
  });

  it('returns ok=false with structured errors for a schema-invalid file', () => {
    // Valid JSON shape but missing required fields — fails Zod parse.
    const invalid = JSON.stringify({ kind: 'caladia-project', version: 8 });
    const result = runValidate({ contents: invalid });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('counts in summary match the fixture content exactly', () => {
    const result = runValidate({ contents: loadFixture() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The linear-chain fixture is a small known-shape file. Reading it
    // raw and counting top-level array lengths gives the ground truth
    // for our summary projection.
    const raw = JSON.parse(loadFixture()) as {
      nodes: unknown[];
      edges: unknown[];
      resources: unknown[];
      calendars: unknown[];
      subsystems: unknown[];
      loops: unknown[];
      scenarios: unknown[];
    };
    expect(result.summary.nodes).toBe(raw.nodes.length);
    expect(result.summary.edges).toBe(raw.edges.length);
    expect(result.summary.resources).toBe(raw.resources.length);
    expect(result.summary.calendars).toBe(raw.calendars.length);
    expect(result.summary.subsystems).toBe(raw.subsystems.length);
    expect(result.summary.loops).toBe(raw.loops.length);
    expect(result.summary.scenarios).toBe(raw.scenarios.length);
  });
});

// ── Formatter tests ──────────────────────────────────────────────────────────

describe('formatSummaryLine', () => {
  it('renders singular forms for counts of 1', () => {
    const s: ProjectSummary = {
      version: 8,
      nodes: 1,
      edges: 1,
      resources: 1,
      calendars: 1,
      subsystems: 1,
      loops: 1,
      scenarios: 1,
    };
    expect(formatSummaryLine(s)).toBe(
      'Valid V8 .cala file: 1 node, 1 edge, 1 resource, 1 calendar, 1 subsystem, 1 loop, 1 scenario',
    );
  });

  it('renders plural forms for counts ≠ 1 (including 0)', () => {
    const s: ProjectSummary = {
      version: 8,
      nodes: 0,
      edges: 2,
      resources: 3,
      calendars: 4,
      subsystems: 5,
      loops: 6,
      scenarios: 7,
    };
    expect(formatSummaryLine(s)).toBe(
      'Valid V8 .cala file: 0 nodes, 2 edges, 3 resources, 4 calendars, 5 subsystems, 6 loops, 7 scenarios',
    );
  });
});

describe('formatTruncationWarnings', () => {
  it('reports a single truncated field with singular wording', () => {
    const out = formatTruncationWarnings([
      {
        path: 'nodes[3].description',
        field: 'description',
        originalLength: 60_000,
        truncatedTo: 50_000,
      },
    ]);
    expect(out).toBe('1 field truncated on load:\n  nodes[3].description: 60000 → 50000 chars');
  });

  it('reports multiple truncated fields with plural wording', () => {
    const out = formatTruncationWarnings([
      {
        path: 'nodes[3].description',
        field: 'description',
        originalLength: 60_000,
        truncatedTo: 50_000,
      },
      {
        path: 'loops[1].description',
        field: 'description',
        originalLength: 55_000,
        truncatedTo: 50_000,
      },
    ]);
    expect(out).toBe(
      [
        '2 fields truncated on load:',
        '  nodes[3].description: 60000 → 50000 chars',
        '  loops[1].description: 55000 → 50000 chars',
      ].join('\n'),
    );
  });
});

describe('formatErrors', () => {
  it('renders a header plus one indented line per error', () => {
    const out = formatErrors([
      { path: 'nodes.3.duration', message: 'must be a positive number' },
      { path: 'edges.1.from', message: 'references unknown node "abc"' },
    ]);
    expect(out).toBe(
      [
        'Invalid .cala file:',
        '  nodes.3.duration: must be a positive number',
        '  edges.1.from: references unknown node "abc"',
      ].join('\n'),
    );
  });
});
