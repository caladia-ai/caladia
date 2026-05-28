import { describe, it, expect } from 'vitest';
import { bodyCriticalChains } from './loop.js';

/**
 * Phase 50 Slice 18 — unit tests for the pure body-critical-chain
 * traversal. The calendar-aware taut-edge detection lives in cpm.ts
 * (where the per-node calendar lookups are already in scope); these
 * tests exercise the downstream graph algorithm in isolation by
 * pre-building the `tautSuccessors` map.
 *
 * The integration test (Slice 18) in `index.test.ts` covers the
 * end-to-end path: project with a loop on the critical path →
 * `criticalPaths[][]` contains body node ids in order.
 */
describe('bodyCriticalChains (Phase 50 Slice 18 / audit I-1)', () => {
  it('linear body A → B → C: chain contains all three nodes in order', () => {
    // All three nodes are body-critical. Taut edges A→B, B→C.
    const result = bodyCriticalChains({
      bodyNodeIds: ['A', 'B', 'C'],
      offsets: new Map([
        ['A', { esHours: 0, efHours: 4 }],
        ['B', { esHours: 4, efHours: 8 }],
        ['C', { esHours: 8, efHours: 12 }],
      ]),
      cpHours: 12,
      tautSuccessors: new Map([
        ['A', ['B']],
        ['B', ['C']],
        ['C', []],
      ]),
    });

    expect(result.criticalNodes).toEqual(new Set(['A', 'B', 'C']));
    expect(result.chains).toEqual([['A', 'B', 'C']]);
  });

  it('parallel critical paths in body: both chains returned', () => {
    // A → B → D and A → C → D. Both B and C have efHours=8, both critical.
    // Both paths reach the sink D with efHours=12.
    const result = bodyCriticalChains({
      bodyNodeIds: ['A', 'B', 'C', 'D'],
      offsets: new Map([
        ['A', { esHours: 0, efHours: 4 }],
        ['B', { esHours: 4, efHours: 8 }],
        ['C', { esHours: 4, efHours: 8 }],
        ['D', { esHours: 8, efHours: 12 }],
      ]),
      cpHours: 12,
      tautSuccessors: new Map([
        ['A', ['B', 'C']],
        ['B', ['D']],
        ['C', ['D']],
        ['D', []],
      ]),
    });

    expect(result.criticalNodes).toEqual(new Set(['A', 'B', 'C', 'D']));
    // Both chains, deterministic sort by source first, then by next step.
    expect(result.chains).toEqual([
      ['A', 'B', 'D'],
      ['A', 'C', 'D'],
    ]);
  });

  it('mixed critical / non-critical body: only critical chain returned', () => {
    // A → B critical (both reach D); A → C non-critical (C.efHours=6
    // doesn't match cpHours=12). C is NOT taut-connected to D either.
    const result = bodyCriticalChains({
      bodyNodeIds: ['A', 'B', 'C', 'D'],
      offsets: new Map([
        ['A', { esHours: 0, efHours: 4 }],
        ['B', { esHours: 4, efHours: 8 }],
        ['C', { esHours: 4, efHours: 6 }], // slack of 2h vs B
        ['D', { esHours: 8, efHours: 12 }],
      ]),
      cpHours: 12,
      tautSuccessors: new Map([
        ['A', ['B', 'C']],
        ['B', ['D']],
        ['C', []], // C has no critical successor (its slack pushed it off)
        ['D', []],
      ]),
    });

    expect(result.criticalNodes).toEqual(new Set(['A', 'B', 'D']));
    expect(result.chains).toEqual([['A', 'B', 'D']]);
  });

  it('single-node body: chain is just that node', () => {
    const result = bodyCriticalChains({
      bodyNodeIds: ['only'],
      offsets: new Map([['only', { esHours: 0, efHours: 4 }]]),
      cpHours: 4,
      tautSuccessors: new Map([['only', []]]),
    });

    expect(result.criticalNodes).toEqual(new Set(['only']));
    expect(result.chains).toEqual([['only']]);
  });

  it('no sinks (degenerate; cpHours mismatches all efHours): empty chains', () => {
    // Synthetic edge case — shouldn't occur in practice but the
    // algorithm must be safe.
    const result = bodyCriticalChains({
      bodyNodeIds: ['A', 'B'],
      offsets: new Map([
        ['A', { esHours: 0, efHours: 4 }],
        ['B', { esHours: 4, efHours: 8 }],
      ]),
      cpHours: 100,
      tautSuccessors: new Map([
        ['A', ['B']],
        ['B', []],
      ]),
    });

    expect(result.criticalNodes.size).toBe(0);
    expect(result.chains).toEqual([]);
  });
});
