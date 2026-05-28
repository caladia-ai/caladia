import { describe, it, expect, beforeEach } from 'vitest';
import type { ProjectNode } from '@procsim/file-format';
import { useDomainStore } from '../store/domainStore.js';
import {
  ANCHOR_OFFSET_Y,
  DEFAULT_NODE_H,
  DEFAULT_NODE_W,
  closestSourceWithin,
  placeNode,
  PICKUP_RADIUS,
  placeNodeWithIncomingEdges,
  sourceHandleWorldPos,
} from './placement.js';

function resetStore() {
  const fresh = useDomainStore.getState().project;
  useDomainStore.temporal.getState().clear();
  useDomainStore.setState({ project: fresh, lastIntent: null });
  useDomainStore.temporal.getState().clear();
}

describe('placeNode — anchor offset (Phase 45 Slice 5)', () => {
  beforeEach(() => {
    resetStore();
  });

  it('Activity: top-left lands at (cursor.x, cursor.y − GHOST_H/2) and returns id', () => {
    const before = useDomainStore.getState().project.nodes.length;
    const id = placeNode('activity', { x: 400, y: 250 });
    expect(typeof id).toBe('string');

    const nodes = useDomainStore.getState().project.nodes;
    expect(nodes.length).toBe(before + 1);
    const dropped = nodes[nodes.length - 1]!;
    expect(dropped.id).toBe(id);
    expect(dropped.position.x).toBe(400);
    expect(dropped.position.y).toBe(250 - ANCHOR_OFFSET_Y);
  });

  it('Decision uses the same anchor offset', () => {
    placeNode('decision', { x: 100, y: 200 });
    const dropped = useDomainStore.getState().project.nodes.at(-1)!;
    expect(dropped.nodeType).toBe('decision');
    expect(dropped.position).toEqual({ x: 100, y: 200 - ANCHOR_OFFSET_Y });
  });

  it('Start uses the same anchor offset', () => {
    placeNode('start', { x: 0, y: 60 });
    const dropped = useDomainStore.getState().project.nodes.at(-1)!;
    expect(dropped.nodeType).toBe('start');
    expect(dropped.position).toEqual({ x: 0, y: 60 - ANCHOR_OFFSET_Y });
  });
});

describe('placeNode — end-node single-cardinality guard', () => {
  beforeEach(() => {
    resetStore();
  });

  it('refuses to add a second End and returns null', () => {
    // First End is allowed and returns the new id.
    const first = placeNode('end', { x: 500, y: 100 });
    expect(typeof first).toBe('string');
    const afterFirst = useDomainStore.getState().project.nodes.length;

    // Second End: guard kicks in.
    const second = placeNode('end', { x: 600, y: 200 });
    expect(second).toBe(null);
    expect(useDomainStore.getState().project.nodes.length).toBe(afterFirst);
  });
});

// ── Phase 49 Slice 4 ─────────────────────────────────────────────────────────

function mkNode(
  id: string,
  nodeType: 'activity' | 'decision' | 'start' | 'end',
  x: number,
  y: number,
  width?: number,
  height?: number,
): ProjectNode {
  const base = {
    id,
    name: id,
    duration: { value: 8, unit: 'hours' } as const,
    durationSemantic: 'effort' as const,
    position: { x, y },
    calendarId: null,
    consumesResources: nodeType !== 'start' && nodeType !== 'end',
    resourceAssignments: [],
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
  if (nodeType === 'decision') {
    return {
      ...base,
      nodeType: 'decision',
      durationSemantic: 'time',
      passProbability: 0.5,
      failureDelay: { value: 0, unit: 'hours' },
    };
  }
  if (nodeType === 'start') {
    return {
      ...base,
      nodeType: 'start',
      durationSemantic: 'time',
      duration: { value: 0, unit: 'hours' },
      consumesResources: false,
      anchorDate: '2026-01-01',
    };
  }
  if (nodeType === 'end') {
    return {
      ...base,
      nodeType: 'end',
      durationSemantic: 'time',
      duration: { value: 0, unit: 'hours' },
      consumesResources: false,
    };
  }
  return { ...base, nodeType: 'activity' };
}

describe('sourceHandleWorldPos — Phase 49 Slice 4', () => {
  it('activity: right-mid of bounding rect using stored width / height', () => {
    const n = mkNode('a', 'activity', 100, 200, 160, 60);
    expect(sourceHandleWorldPos(n)).toEqual({ x: 260, y: 230 });
  });

  it('activity: falls back to DEFAULT_NODE_W / H when width / height are absent', () => {
    const n = mkNode('a', 'activity', 0, 0);
    expect(sourceHandleWorldPos(n)).toEqual({
      x: DEFAULT_NODE_W,
      y: DEFAULT_NODE_H / 2,
    });
  });

  it('decision: same right-mid geometry as activity', () => {
    const n = mkNode('d', 'decision', 50, 50, 144, 60);
    expect(sourceHandleWorldPos(n)).toEqual({ x: 194, y: 80 });
  });

  it('start: source on the right (start nodes are roots; the source is downstream)', () => {
    const n = mkNode('s', 'start', 0, 100, 100, 40);
    expect(sourceHandleWorldPos(n)).toEqual({ x: 100, y: 120 });
  });

  it('end: returns null — no source handle', () => {
    const n = mkNode('e', 'end', 500, 500);
    expect(sourceHandleWorldPos(n)).toBe(null);
  });
});

describe('closestSourceWithin — Phase 49 Slice 4', () => {
  it('returns null when no candidate is within radius', () => {
    const nodes = [mkNode('a', 'activity', 0, 0, 160, 60)];
    // Cursor far away in every direction.
    expect(closestSourceWithin({ x: 1000, y: 1000 }, nodes, PICKUP_RADIUS)).toBe(null);
  });

  it('picks the single in-range source', () => {
    const nodes = [
      mkNode('far', 'activity', 0, 0, 160, 60), // right-mid (160, 30)
      mkNode('near', 'activity', 300, 300, 160, 60), // right-mid (460, 330)
    ];
    // Cursor near "near"'s right-mid handle.
    const r = closestSourceWithin({ x: 462, y: 332 }, nodes, PICKUP_RADIUS);
    expect(r?.id).toBe('near');
    expect(r?.dist).toBeLessThan(PICKUP_RADIUS);
  });

  it('picks the closest when multiple are in range', () => {
    const nodes = [
      // Both within hit radius of cursor (200, 100); B is closer.
      mkNode('A', 'activity', 30, 70, 160, 60), // right-mid (190, 100) → dist 10
      mkNode('B', 'activity', 40, 70, 160, 60), // right-mid (200, 100) → dist 0
    ];
    const r = closestSourceWithin({ x: 200, y: 100 }, nodes, PICKUP_RADIUS);
    expect(r?.id).toBe('B');
  });

  it('skips End nodes (no source handle)', () => {
    const nodes = [
      mkNode('end', 'end', 100, 100, 60, 60),
      mkNode('a', 'activity', 0, 200, 160, 60), // right-mid (160, 230)
    ];
    // Cursor right at the End node's center: would be a hit if End had a source.
    // It doesn't, so the activity is the only candidate — and it's far away.
    const cursor = { x: 130, y: 130 };
    const r = closestSourceWithin(cursor, nodes, PICKUP_RADIUS);
    expect(r).toBe(null);
  });
});

describe('placeNodeWithIncomingEdges — wire-on-place', () => {
  beforeEach(() => {
    resetStore();
  });

  it('Activity: drops at the anchor offset AND connects from each source', () => {
    const srcA = useDomainStore.getState().addNode({ x: 0, y: 0 });
    const srcB = useDomainStore.getState().addNode({ x: 0, y: 100 });
    const id = placeNodeWithIncomingEdges('activity', { x: 400, y: 250 }, [srcA, srcB]);
    const project = useDomainStore.getState().project;
    const dropped = project.nodes.find((n) => n.id === id)!;
    expect(dropped.nodeType).toBe('activity');
    expect(dropped.position).toEqual({ x: 400, y: 250 - ANCHOR_OFFSET_Y });
    const edgesIn = project.edges.filter((e) => e.to === id);
    expect(edgesIn.map((e) => e.from).sort()).toEqual([srcA, srcB].sort());
    expect(edgesIn.every((e) => e.type === 'FS' && e.lag.value === 0)).toBe(true);
  });

  it('Decision: same drop offset, no edges when sources is empty', () => {
    const id = placeNodeWithIncomingEdges('decision', { x: 100, y: 200 }, []);
    const project = useDomainStore.getState().project;
    const dropped = project.nodes.find((n) => n.id === id)!;
    expect(dropped.nodeType).toBe('decision');
    expect(dropped.position).toEqual({ x: 100, y: 200 - ANCHOR_OFFSET_Y });
    expect(project.edges.filter((e) => e.to === id)).toEqual([]);
  });
});
