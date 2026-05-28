import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ProjectFile } from '@procsim/file-format';

// Mock loadAutosaved before importing the unit-under-test so the import
// graph picks up the mocked module.
vi.mock('./autosave.js', () => ({
  loadAutosaved: vi.fn(),
}));

import { loadAutosaved } from './autosave.js';
import { prepareAutosaveDownload } from './errorRecovery.js';

const mockLoadAutosaved = vi.mocked(loadAutosaved);

// Minimal ProjectFile sentinel — we only assert reference equality, not shape.
const SENTINEL_PROJECT = { sentinel: true } as unknown as ProjectFile;

describe('prepareAutosaveDownload', () => {
  beforeEach(() => {
    mockLoadAutosaved.mockReset();
  });

  it('returns { kind: "ready", project } when autosave loads', async () => {
    mockLoadAutosaved.mockResolvedValueOnce(SENTINEL_PROJECT);
    const result = await prepareAutosaveDownload();
    expect(result).toEqual({ kind: 'ready', project: SENTINEL_PROJECT });
  });

  it('returns { kind: "no-snapshot" } when loadAutosaved resolves null', async () => {
    mockLoadAutosaved.mockResolvedValueOnce(null);
    const result = await prepareAutosaveDownload();
    expect(result).toEqual({ kind: 'no-snapshot' });
  });

  it('returns { kind: "error", reason } when loadAutosaved rejects with an Error', async () => {
    mockLoadAutosaved.mockRejectedValueOnce(new Error('IDB unavailable'));
    const result = await prepareAutosaveDownload();
    expect(result).toEqual({ kind: 'error', reason: 'IDB unavailable' });
  });

  it('returns a generic reason when loadAutosaved rejects with a non-Error', async () => {
    mockLoadAutosaved.mockRejectedValueOnce('string rejection');
    const result = await prepareAutosaveDownload();
    expect(result).toEqual({ kind: 'error', reason: 'Unknown error.' });
  });
});
