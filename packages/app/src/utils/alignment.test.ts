import { describe, it, expect } from 'vitest';
import type { AlignableNode } from './alignment.js';
import {
  alignBottom,
  alignCenter,
  alignLeft,
  alignMiddle,
  alignRight,
  alignTop,
  distributeHorizontally,
  distributeVertically,
} from './alignment.js';

// Minimal factory — the helpers only need id, position, width, height.
// The caller (SelectionToolbar) resolves real dimensions via React Flow's
// measured store; here we just hand-pick them.
function mk(id: string, x: number, y: number, width = 160, height = 60): AlignableNode {
  return { id, position: { x, y }, width, height };
}

describe('alignLeft — Phase 49 Slice 5', () => {
  it('returns empty for fewer than 2 nodes', () => {
    expect(alignLeft([])).toEqual({});
    expect(alignLeft([mk('a', 10, 20)])).toEqual({});
  });

  it("snaps every node's x to the minimum left x; preserves y", () => {
    const nodes = [mk('a', 100, 10), mk('b', 40, 20), mk('c', 80, 30)];
    expect(alignLeft(nodes)).toEqual({
      a: { x: 40, y: 10 },
      c: { x: 40, y: 30 },
      // 'b' is already at min — omitted (no-op detection).
    });
  });

  it('already-aligned input returns empty (no-op)', () => {
    const nodes = [mk('a', 50, 0), mk('b', 50, 100), mk('c', 50, 200)];
    expect(alignLeft(nodes)).toEqual({});
  });
});

describe('alignRight — Phase 49 Slice 5', () => {
  it("snaps every node's right edge to the max right; respects per-node width", () => {
    // Right edges: a=180, b=300, c=210. Max = 300.
    // New x: a = 300-100 = 200, c = 300-50 = 250. b unchanged.
    const nodes = [mk('a', 80, 0, 100), mk('b', 200, 0, 100), mk('c', 160, 0, 50)];
    expect(alignRight(nodes)).toEqual({
      a: { x: 200, y: 0 },
      c: { x: 250, y: 0 },
    });
  });
});

describe('alignCenter — Phase 49 Slice 5', () => {
  it("centres every node's horizontal midpoint on the bbox centre", () => {
    // bbox: minLeft = 0, maxRight = 200. centerX = 100.
    // a width 100 → new x = 100 - 50 = 50.
    // b width 50 → new x = 100 - 25 = 75.
    const nodes = [mk('a', 0, 0, 100), mk('b', 150, 0, 50)];
    expect(alignCenter(nodes)).toEqual({
      a: { x: 50, y: 0 },
      b: { x: 75, y: 0 },
    });
  });

  it('preserves y for each node', () => {
    const nodes = [mk('a', 0, 50, 100), mk('b', 200, 75, 100)];
    const out = alignCenter(nodes);
    expect(out.a?.y).toBe(50);
    expect(out.b?.y).toBe(75);
  });
});

describe('alignTop — Phase 49 Slice 5', () => {
  it("snaps every node's y to the min top; preserves x", () => {
    const nodes = [mk('a', 10, 100), mk('b', 20, 40), mk('c', 30, 80)];
    expect(alignTop(nodes)).toEqual({
      a: { x: 10, y: 40 },
      c: { x: 30, y: 40 },
    });
  });
});

describe('alignBottom — Phase 49 Slice 5', () => {
  it("snaps every node's bottom edge to the max bottom; respects per-node height", () => {
    // Bottom edges: a = 0+60 = 60, b = 50+40 = 90, c = 30+60 = 90.
    // Max = 90. New y: a = 90-60 = 30. b unchanged. c unchanged.
    const nodes = [mk('a', 0, 0, 100, 60), mk('b', 0, 50, 100, 40), mk('c', 0, 30, 100, 60)];
    expect(alignBottom(nodes)).toEqual({
      a: { x: 0, y: 30 },
    });
  });

  it('handles mixed real heights (Start 56, Activity 64, End 56)', () => {
    // Bottoms: start = 100+56 = 156. activity = 110+64 = 174. end = 90+56 = 146.
    // Max = 174. New y: start = 174-56 = 118. end = 174-56 = 118. activity unchanged.
    const nodes = [
      mk('start', 0, 100, 108, 56),
      mk('activity', 200, 110, 144, 64),
      mk('end', 400, 90, 56, 56),
    ];
    expect(alignBottom(nodes)).toEqual({
      start: { x: 0, y: 118 },
      end: { x: 400, y: 118 },
    });
  });
});

describe('alignMiddle — Phase 49 Slice 5', () => {
  it("centres every node's vertical midpoint on the bbox centre", () => {
    // bbox: minTop = 0, maxBottom = 200. centerY = 100.
    // a height 100 → new y = 100 - 50 = 50.
    // b height 50 → new y = 100 - 25 = 75.
    const nodes = [mk('a', 0, 0, 100, 100), mk('b', 0, 150, 100, 50)];
    expect(alignMiddle(nodes)).toEqual({
      a: { x: 0, y: 50 },
      b: { x: 0, y: 75 },
    });
  });

  it('Start + Activity at different heights: centres line up by real height (not a fixed fallback)', () => {
    // The bug that motivated the v2 refactor — alignMiddle with mixed
    // heights MUST use the actual rendered height of each node, not a
    // uniform fallback. Otherwise Start (56 px) ends up a few pixels
    // off from Activity (64 px) when both are "middle-aligned".
    //
    // bbox: minTop = 100, maxBottom = max(100+56, 110+64) = 174.
    // centerY = (100 + 174) / 2 = 137.
    // start (h 56): new y = 137 - 28 = 109. visual mid = 109 + 28 = 137. ✓
    // activity (h 64): new y = 137 - 32 = 105. visual mid = 105 + 32 = 137. ✓
    const nodes = [mk('start', 0, 100, 108, 56), mk('activity', 200, 110, 144, 64)];
    expect(alignMiddle(nodes)).toEqual({
      start: { x: 0, y: 109 },
      activity: { x: 200, y: 105 },
    });
  });
});

describe('alignment — cross-cutting properties', () => {
  it('horizontal helpers never touch y; vertical helpers never touch x', () => {
    const nodes = [mk('a', 100, 200, 50, 30), mk('b', 300, 50, 50, 30), mk('c', 50, 350, 50, 30)];
    const orig = new Map(nodes.map((n) => [n.id, n]));

    for (const out of [alignLeft(nodes), alignCenter(nodes), alignRight(nodes)]) {
      for (const [id, pos] of Object.entries(out)) {
        expect(pos.y).toBe(orig.get(id)!.position.y);
      }
    }
    for (const out of [alignTop(nodes), alignMiddle(nodes), alignBottom(nodes)]) {
      for (const [id, pos] of Object.entries(out)) {
        expect(pos.x).toBe(orig.get(id)!.position.x);
      }
    }
  });

  it('node order does not affect the result', () => {
    const a = mk('a', 100, 50);
    const b = mk('b', 40, 75);
    const c = mk('c', 80, 90);
    const out1 = alignLeft([a, b, c]);
    const out2 = alignLeft([c, b, a]);
    expect(out1).toEqual(out2);
  });
});

describe('distributeHorizontally — Phase 49 Slice 8', () => {
  it('returns empty for fewer than 3 nodes', () => {
    expect(distributeHorizontally([])).toEqual({});
    expect(distributeHorizontally([mk('a', 0, 0)])).toEqual({});
    expect(distributeHorizontally([mk('a', 0, 0), mk('b', 100, 0)])).toEqual({});
  });

  it('equal widths: 3 nodes get equal edge-to-edge gaps; first + last stay put', () => {
    // a, b, c all 100 wide. a.left=0, c.right=400. Span=400. Σwidths=300.
    // Gap = (400 − 300) / 2 = 50. b lands at a.right + 50 = 150.
    const nodes = [
      mk('a', 0, 10, 100, 50),
      mk('b', 80, 10, 100, 50), // intentionally off-position
      mk('c', 300, 10, 100, 50),
    ];
    expect(distributeHorizontally(nodes)).toEqual({
      b: { x: 150, y: 10 },
    });
  });

  it('mixed widths: gap is computed against per-node widths', () => {
    // a width 100 starts at 0 (left edge 0, right 100).
    // d width 60 ends at 360 (left 300, right 360).
    // Σwidths = 100 + 80 + 40 + 60 = 280. Span = 360. Free = 80. Gap = 80/3.
    // b right of a + gap = 100 + 80/3.
    // c right of b + gap = (100 + 80/3) + 80 + 80/3 = 180 + 160/3.
    const nodes = [
      mk('a', 0, 0, 100, 30),
      mk('b', 200, 0, 80, 30),
      mk('c', 250, 0, 40, 30),
      mk('d', 300, 0, 60, 30),
    ];
    const out = distributeHorizontally(nodes);
    const gap = 80 / 3;
    expect(out.b?.x).toBeCloseTo(100 + gap);
    expect(out.c?.x).toBeCloseTo(100 + gap + 80 + gap);
    // a + d stay put → not in payload.
    expect(out.a).toBeUndefined();
    expect(out.d).toBeUndefined();
  });

  it('already evenly distributed → empty payload (no-op)', () => {
    // Equal widths, equal gaps.
    const nodes = [
      mk('a', 0, 0, 100, 30),
      mk('b', 150, 0, 100, 30), // 50px gap after a
      mk('c', 300, 0, 100, 30), // 50px gap after b
    ];
    expect(distributeHorizontally(nodes)).toEqual({});
  });

  it('preserves y for each node', () => {
    const nodes = [mk('a', 0, 10, 100, 30), mk('b', 80, 50, 100, 30), mk('c', 300, 90, 100, 30)];
    const out = distributeHorizontally(nodes);
    expect(out.b?.y).toBe(50);
  });
});

describe('distributeVertically — Phase 49 Slice 8', () => {
  it('returns empty for fewer than 3 nodes', () => {
    expect(distributeVertically([])).toEqual({});
    expect(distributeVertically([mk('a', 0, 0), mk('b', 0, 100)])).toEqual({});
  });

  it('equal heights: 3 nodes get equal edge-to-edge gaps; first + last stay put', () => {
    // Heights 50 each. Span = 0 + 50 to 400 + 50 = ... wait:
    // a.top=0, a.bottom=50; c.top=400, c.bottom=450. Span = 450 − 0 = 450.
    // Σheights = 150. Gap = (450 − 150) / 2 = 150. b at a.bottom + 150 = 200.
    const nodes = [mk('a', 10, 0, 100, 50), mk('b', 10, 80, 100, 50), mk('c', 10, 400, 100, 50)];
    expect(distributeVertically(nodes)).toEqual({
      b: { x: 10, y: 200 },
    });
  });

  it('preserves x for each node', () => {
    const nodes = [mk('a', 10, 0, 100, 30), mk('b', 50, 80, 100, 30), mk('c', 90, 300, 100, 30)];
    const out = distributeVertically(nodes);
    expect(out.b?.x).toBe(50);
  });
});
