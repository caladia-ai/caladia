import { describe, it, expect } from 'vitest';
import { parseClipboardPayload } from './useKeyboard.js';

// ── parseClipboardPayload ────────────────────────────────────────────────────
//
// Same-origin code (extensions, future XSS) can write anything to the
// caladia:clipboard:v1 key. parseClipboardPayload is the schema-validated
// gate every paste goes through; nothing reaches the domain store without
// first matching NodeSchema.

const VALID_NODE = {
  id: 'n1',
  nodeType: 'activity',
  name: 'Step',
  duration: { value: 1, unit: 'hours' },
  position: { x: 0, y: 0 },
  calendarId: null,
  consumesResources: false,
  resourceAssignments: [],
};

describe('parseClipboardPayload', () => {
  it('returns parsed nodes when the payload is a valid node array', () => {
    const raw = JSON.stringify([VALID_NODE]);
    const result = parseClipboardPayload(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('n1');
    expect(result[0]?.name).toBe('Step');
  });

  it('returns an empty array on invalid JSON', () => {
    expect(parseClipboardPayload('not json')).toEqual([]);
    expect(parseClipboardPayload('{')).toEqual([]);
  });

  it('returns an empty array when the payload is not an array', () => {
    expect(parseClipboardPayload(JSON.stringify({ id: 'oops' }))).toEqual([]);
    expect(parseClipboardPayload(JSON.stringify('string'))).toEqual([]);
    expect(parseClipboardPayload(JSON.stringify(42))).toEqual([]);
    expect(parseClipboardPayload(JSON.stringify(null))).toEqual([]);
  });

  it('returns an empty array when any element fails schema validation', () => {
    // Mixed payload: one valid node + one obviously bogus entry.
    // All-or-nothing — we never want a partial paste reaching the store.
    const raw = JSON.stringify([VALID_NODE, { id: 'broken' /* missing required fields */ }]);
    expect(parseClipboardPayload(raw)).toEqual([]);
  });

  it('rejects attempts at prototype pollution via crafted keys', () => {
    // A malicious entry trying to slip __proto__ into a node. NodeSchema's
    // .strip default drops unknown keys; the entry is still missing the
    // required fields, so the whole paste rejects safely.
    const malicious = JSON.stringify([
      { __proto__: { polluted: true }, id: 'x', constructor: { prototype: { polluted: true } } },
    ]);
    const result = parseClipboardPayload(malicious);
    expect(result).toEqual([]);
    // Sanity: prototype was not polluted by the act of validating.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects a JSON array of primitives', () => {
    expect(parseClipboardPayload(JSON.stringify([1, 2, 3]))).toEqual([]);
    expect(parseClipboardPayload(JSON.stringify(['a', 'b']))).toEqual([]);
  });

  it('returns an empty array for an empty array payload (legitimate empty clipboard)', () => {
    expect(parseClipboardPayload('[]')).toEqual([]);
  });

  it('applies schema defaults (nodeType, durationSemantic) when absent', () => {
    // NodeSchema defaults nodeType='activity' and durationSemantic='time'.
    // The returned value should have both fields populated even if the raw
    // payload omitted them.
    const minimal = {
      id: 'n2',
      name: 'Bare',
      duration: { value: 2, unit: 'hours' },
      position: { x: 5, y: 5 },
      calendarId: null,
      consumesResources: true,
      resourceAssignments: [],
    };
    const result = parseClipboardPayload(JSON.stringify([minimal]));
    expect(result).toHaveLength(1);
    expect(result[0]?.nodeType).toBe('activity');
    expect(result[0]?.durationSemantic).toBe('time');
  });
});
