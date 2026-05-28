import { describe, it, expect } from 'vitest';
import { expandDropTargets } from './resourcePaletteDrop.js';

describe('expandDropTargets', () => {
  it('returns just the drop target when nothing is selected', () => {
    const r = expandDropTargets({
      dropTargetId: 'a',
      selectedNodeIds: [],
      activityNodeIds: new Set(['a', 'b', 'c']),
    });
    expect(r).toEqual(['a']);
  });

  it('returns just the drop target when the target is not in the selection', () => {
    // Drag onto a node that the user did not have selected — strict drag-
    // target mental model wins over bulk.
    const r = expandDropTargets({
      dropTargetId: 'a',
      selectedNodeIds: ['b', 'c'],
      activityNodeIds: new Set(['a', 'b', 'c']),
    });
    expect(r).toEqual(['a']);
  });

  it('returns just the drop target when the target is in a singleton selection', () => {
    const r = expandDropTargets({
      dropTargetId: 'a',
      selectedNodeIds: ['a'],
      activityNodeIds: new Set(['a', 'b']),
    });
    expect(r).toEqual(['a']);
  });

  it('returns all selected activity nodes when the target is in a multi-selection', () => {
    const r = expandDropTargets({
      dropTargetId: 'b',
      selectedNodeIds: ['a', 'b', 'c'],
      activityNodeIds: new Set(['a', 'b', 'c']),
    });
    expect(r).toEqual(['b', 'a', 'c']);
  });

  it('places the drop target first regardless of selection order', () => {
    // Caller's "primary" target for inspector-nav decisions is the drop
    // target, so the helper guarantees it lands at index 0.
    const r = expandDropTargets({
      dropTargetId: 'c',
      selectedNodeIds: ['a', 'b', 'c'],
      activityNodeIds: new Set(['a', 'b', 'c']),
    });
    expect(r[0]).toBe('c');
    expect(new Set(r)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('filters out non-activity nodes from a multi-selection', () => {
    // The user may have a Start anchor + Decision node + activity in the
    // selection; pool assignment only applies to activities.
    const r = expandDropTargets({
      dropTargetId: 'act1',
      selectedNodeIds: ['act1', 'start1', 'decision1', 'act2'],
      activityNodeIds: new Set(['act1', 'act2']),
    });
    expect(r).toEqual(['act1', 'act2']);
  });

  it('de-duplicates the drop target if it appears multiple times in the selection', () => {
    // Selection arrays shouldn't normally contain duplicates, but be
    // defensive — the result must list each id at most once.
    const r = expandDropTargets({
      dropTargetId: 'a',
      selectedNodeIds: ['a', 'a', 'b'],
      activityNodeIds: new Set(['a', 'b']),
    });
    expect(r).toEqual(['a', 'b']);
  });

  it('returns empty when the drop target is not an activity', () => {
    // Defensive — the drop handler only wires onDrop on ActivityNode, so
    // this branch is theoretical, but the helper still returns a safe
    // no-op shape that the caller can early-return on.
    const r = expandDropTargets({
      dropTargetId: 'start1',
      selectedNodeIds: ['start1', 'act1'],
      activityNodeIds: new Set(['act1']),
    });
    expect(r).toEqual([]);
  });
});
