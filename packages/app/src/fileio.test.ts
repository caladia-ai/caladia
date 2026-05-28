import { describe, it, expect } from 'vitest';
import { MAX_TEXT_FILE_BYTES, MAX_BINARY_FILE_BYTES, validateFileSize } from './fileio.js';

// ── validateFileSize ─────────────────────────────────────────────────────────
//
// Pure predicate the picker layer uses before invoking FileReader. Tested
// directly so we don't need a jsdom environment just to exercise the size
// guard.

describe('validateFileSize', () => {
  it('returns null when size is exactly at the limit', () => {
    expect(validateFileSize({ size: MAX_TEXT_FILE_BYTES }, MAX_TEXT_FILE_BYTES)).toBeNull();
  });

  it('returns null when size is below the limit', () => {
    expect(validateFileSize({ size: 0 }, MAX_TEXT_FILE_BYTES)).toBeNull();
    expect(validateFileSize({ size: 1 }, MAX_TEXT_FILE_BYTES)).toBeNull();
    expect(validateFileSize({ size: 1024 }, MAX_TEXT_FILE_BYTES)).toBeNull();
  });

  it('returns an error string when size exceeds the limit', () => {
    const err = validateFileSize({ size: MAX_TEXT_FILE_BYTES + 1 }, MAX_TEXT_FILE_BYTES);
    expect(err).not.toBeNull();
    expect(err).toMatch(/too large/i);
    expect(err).toMatch(/50 MB/);
  });

  it('formats the actual and limit sizes in MB', () => {
    const err = validateFileSize({ size: 200 * 1024 * 1024 }, 100 * 1024 * 1024);
    expect(err).toBe('File too large (200 MB). Maximum is 100 MB.');
  });

  it('uses the limit passed in (not a global)', () => {
    // A small custom cap still works — confirms the function is pure on its args.
    const err = validateFileSize({ size: 1000 }, 500);
    expect(err).toBe('File too large (0 MB). Maximum is 0 MB.');
    // (Rounding to 0 MB is acceptable — the picker never uses sub-MB caps,
    // and the error string is a defensive guard, not a precision display.)
  });
});

describe('size limit constants', () => {
  it('MAX_TEXT_FILE_BYTES is 50 MB', () => {
    expect(MAX_TEXT_FILE_BYTES).toBe(50 * 1024 * 1024);
  });

  it('MAX_BINARY_FILE_BYTES is 100 MB', () => {
    expect(MAX_BINARY_FILE_BYTES).toBe(100 * 1024 * 1024);
  });

  it('binary limit is at least as large as text limit', () => {
    expect(MAX_BINARY_FILE_BYTES).toBeGreaterThanOrEqual(MAX_TEXT_FILE_BYTES);
  });
});
