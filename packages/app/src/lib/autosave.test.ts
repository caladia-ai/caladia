/**
 * Phase 50 Slice 9 / audit C-9 — autosave error surfacing.
 *
 * Pre-Slice-9 the autosave was fire-and-forget: a rejected IDB write
 * (QuotaExceeded, Safari private-mode block, generic SecurityError)
 * silently went nowhere. Now we catch the rejection, classify it,
 * and set `viewStore.autosaveError` so the persistent banner can
 * render. On the next successful write, the banner clears.
 *
 * These tests mock `idb-keyval`'s `set` so we don't need real IDB —
 * the behaviour under test is the surfacing layer, not idb-keyval
 * itself.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock idb-keyval BEFORE importing autosave so the import graph picks
// up the mocked module.
vi.mock('idb-keyval', () => ({
  get: vi.fn().mockResolvedValue(undefined),
  set: vi.fn().mockResolvedValue(undefined),
}));

import { get as idbGet, set as idbSet } from 'idb-keyval';
import { tryAutosave, classifyAutosaveError, loadAutosaved } from './autosave.js';
import { useViewStore } from '../store/viewStore.js';
import { makeDefaultProject } from '../store/domainStore.js';
import { saveProjectFile } from '@procsim/file-format';

const mockIdbGet = vi.mocked(idbGet);
const mockIdbSet = vi.mocked(idbSet);

describe('classifyAutosaveError (audit C-9)', () => {
  it('classifies QuotaExceededError with a "storage is full" hint', () => {
    const err = new DOMException('Quota exceeded', 'QuotaExceededError');
    const msg = classifyAutosaveError(err);
    expect(msg).toMatch(/storage is full/i);
  });

  it('classifies SecurityError with a "private browsing" hint', () => {
    const err = new DOMException('Storage blocked', 'SecurityError');
    const msg = classifyAutosaveError(err);
    expect(msg).toMatch(/private browsing/i);
  });

  it('classifies InvalidStateError with the storage-unavailable hint (Safari)', () => {
    const err = new DOMException('Invalid state', 'InvalidStateError');
    const msg = classifyAutosaveError(err);
    expect(msg).toMatch(/storage is unavailable/i);
  });

  it('falls back to a generic message for unknown errors', () => {
    const err = new Error('Something else');
    const msg = classifyAutosaveError(err);
    expect(msg).toMatch(/your changes will not be retained/i);
  });
});

describe('tryAutosave (audit C-9)', () => {
  beforeEach(() => {
    mockIdbSet.mockReset();
    useViewStore.getState().setAutosaveError(null);
    // Silence the console.error logging from the failure path; we still
    // assert the banner state, but don't spam the test output.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('clears any prior autosaveError on first successful write after a failure', async () => {
    // Pre-condition: a prior failure left the banner showing.
    useViewStore.getState().setAutosaveError('stale error');
    mockIdbSet.mockResolvedValueOnce(undefined);

    await tryAutosave(makeDefaultProject());

    expect(useViewStore.getState().autosaveError).toBeNull();
  });

  it('sets a QuotaExceeded message when idbSet rejects with QuotaExceededError', async () => {
    mockIdbSet.mockRejectedValueOnce(new DOMException('Quota exceeded', 'QuotaExceededError'));

    await tryAutosave(makeDefaultProject());

    const state = useViewStore.getState().autosaveError;
    expect(state).not.toBeNull();
    expect(state!.message).toMatch(/storage is full/i);
  });

  it('sets a SecurityError message when idbSet rejects with SecurityError', async () => {
    mockIdbSet.mockRejectedValueOnce(new DOMException('Storage blocked', 'SecurityError'));

    await tryAutosave(makeDefaultProject());

    const state = useViewStore.getState().autosaveError;
    expect(state).not.toBeNull();
    expect(state!.message).toMatch(/private browsing/i);
  });

  it('falls back to a generic message for unknown rejection types', async () => {
    mockIdbSet.mockRejectedValueOnce(new Error('mystery'));

    await tryAutosave(makeDefaultProject());

    const state = useViewStore.getState().autosaveError;
    expect(state).not.toBeNull();
    expect(state!.message).toMatch(/your changes will not be retained/i);
  });

  it('successful write does NOT touch autosaveError when it was already null', async () => {
    mockIdbSet.mockResolvedValueOnce(undefined);
    // No-op spy: setAutosaveError should be called 0 times in this path.
    const setSpy = vi.spyOn(useViewStore.getState(), 'setAutosaveError');

    await tryAutosave(makeDefaultProject());

    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('loadAutosaved — invalid-blob preservation (audit I-16)', () => {
  beforeEach(() => {
    mockIdbGet.mockReset();
    mockIdbSet.mockReset();
    useViewStore.getState().setAutosaveError(null);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns the project when the stored blob is valid', async () => {
    const project = makeDefaultProject();
    mockIdbGet.mockResolvedValueOnce(saveProjectFile(project));
    const loaded = await loadAutosaved();
    expect(loaded).not.toBeNull();
    expect(loaded?.project.name).toBe(project.project.name);
    expect(useViewStore.getState().autosaveError).toBeNull();
  });

  it('returns null and does NOT touch the banner when no blob exists', async () => {
    mockIdbGet.mockResolvedValue(undefined);
    expect(await loadAutosaved()).toBeNull();
    expect(useViewStore.getState().autosaveError).toBeNull();
  });

  it('quarantines the raw blob to a separate key when validation fails', async () => {
    // First idbGet returns a bad blob; second returns undefined (no legacy
    // fallback).
    mockIdbGet.mockResolvedValueOnce('{"this":"is not a project"}');
    mockIdbSet.mockResolvedValue(undefined);

    expect(await loadAutosaved()).toBeNull();

    // Two writes: (1) the quarantine, (2) clearing the active key.
    expect(mockIdbSet).toHaveBeenCalledTimes(2);
    const calls = mockIdbSet.mock.calls.map(([key, value]) => ({ key, value }));
    expect(calls).toContainEqual({
      key: 'caladia:autosave:quarantine:v1',
      value: '{"this":"is not a project"}',
    });
    // The active key gets a sentinel write (undefined) so the next debounced
    // autosave doesn't immediately re-overwrite the quarantine with the same
    // bad blob from store memory.
    expect(calls).toContainEqual({
      key: 'caladia:autosave:v1',
      value: undefined,
    });
  });

  it('logs validation errors to console and surfaces the banner on invalid blob', async () => {
    mockIdbGet.mockResolvedValueOnce('{"this":"is not a project"}');
    mockIdbSet.mockResolvedValue(undefined);

    await loadAutosaved();

    expect(console.error).toHaveBeenCalled();
    const banner = useViewStore.getState().autosaveError;
    expect(banner).not.toBeNull();
    expect(banner!.message).toMatch(/failed validation/i);
    expect(banner!.message).toMatch(/quarantine/i);
  });

  it('still returns null + sets banner when the quarantine write itself fails', async () => {
    mockIdbGet.mockResolvedValueOnce('{"this":"is not a project"}');
    mockIdbSet.mockRejectedValueOnce(new Error('IDB unavailable'));

    const result = await loadAutosaved();

    expect(result).toBeNull();
    // Banner is still set — the user needs to know loading failed even
    // when quarantine itself was unavailable.
    expect(useViewStore.getState().autosaveError).not.toBeNull();
  });
});
