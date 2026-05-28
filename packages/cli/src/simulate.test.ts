import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runSimulate } from './simulate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, '..', '__fixtures__', 'linear-chain.cala');

function loadFixture(): string {
  return readFileSync(FIXTURE_PATH, 'utf8');
}

describe('runSimulate', () => {
  it('produces a valid JSON export from the linear-chain fixture', () => {
    const result = runSimulate({
      contents: loadFixture(),
      iterations: 100,
      seed: 42,
      exportedAt: new Date('2026-05-13T15:00:00.000Z'),
      runId: 'cli-test',
      runTimestamp: new Date('2026-05-13T15:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = JSON.parse(result.json);
    expect(parsed.kind).toBe('caladia.sim');
    expect(parsed.version).toBe(1);
    expect(parsed.projectName).toBe('Linear Chain');
    expect(parsed.iterations).toBe(100);
    expect(parsed.seed).toBe(42);
    expect(parsed.runId).toBe('cli-test');
    expect(parsed.target).toBe(null);
    expect(parsed.result.endDates.length).toBe(100);
    expect(parsed.result.pathPerIteration.length).toBe(100);
    // Linear A→B chain: every iteration has the same critical path.
    expect(parsed.result.pathFrequency[0].ids).toEqual(['A', 'B']);
    expect(parsed.result.pathFrequency[0].names).toEqual(['Build', 'Test']);
  });

  it('is deterministic for a fixed seed', () => {
    const opts = {
      contents: loadFixture(),
      iterations: 200,
      seed: 7,
      exportedAt: new Date('2026-05-13T15:00:00.000Z'),
      runId: 'cli-test',
      runTimestamp: new Date('2026-05-13T15:00:00.000Z'),
    };
    const r1 = runSimulate(opts);
    const r2 = runSimulate(opts);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    // Byte-identical JSON when every input (including timestamps) is fixed.
    expect(r1.json).toBe(r2.json);
  });

  it('returns exit code 1 with a descriptive message on parse failure', () => {
    const result = runSimulate({ contents: '{ this is not valid json' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('Failed to parse');
  });

  it('returns exit code 1 on schema-invalid input (e.g. missing version)', () => {
    const result = runSimulate({ contents: JSON.stringify({ kind: 'caladia-project' }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(1);
  });

  it('defaults to 1000 iterations and seed 42', () => {
    const result = runSimulate({
      contents: loadFixture(),
      exportedAt: new Date('2026-05-13T15:00:00.000Z'),
      runId: 'cli-test',
      runTimestamp: new Date('2026-05-13T15:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.json);
    expect(parsed.iterations).toBe(1000);
    expect(parsed.seed).toBe(42);
  });
});
