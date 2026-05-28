import { describe, it, expect, beforeEach } from 'vitest';
import { useViewStore, MAX_VISIBLE_TOASTS } from './viewStore.js';

function resetToasts(): void {
  useViewStore.getState().clearAllToasts();
}

describe('viewStore — notifications', () => {
  beforeEach(() => {
    resetToasts();
  });

  it('starts with an empty queue', () => {
    expect(useViewStore.getState().notifications).toEqual([]);
  });

  it('pushToast returns a stable id and appends to the queue', () => {
    const id = useViewStore.getState().pushToast({ kind: 'info', text: 'Hello' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    const queue = useViewStore.getState().notifications;
    expect(queue.length).toBe(1);
    expect(queue[0]?.id).toBe(id);
    expect(queue[0]?.kind).toBe('info');
    expect(queue[0]?.text).toBe('Hello');
    expect(typeof queue[0]?.createdAt).toBe('number');
  });

  it('defaults kind to "info" when omitted', () => {
    useViewStore.getState().pushToast({ text: 'No kind specified' });
    expect(useViewStore.getState().notifications[0]?.kind).toBe('info');
  });

  it('preserves push order (oldest first, newest last)', () => {
    useViewStore.getState().pushToast({ text: 'a' });
    useViewStore.getState().pushToast({ text: 'b' });
    useViewStore.getState().pushToast({ text: 'c' });
    expect(useViewStore.getState().notifications.map((t) => t.text)).toEqual(['a', 'b', 'c']);
  });

  it('caps at MAX_VISIBLE_TOASTS by dropping the oldest entries first', () => {
    // Push MAX + 2 — only the latest MAX should survive.
    const overflowBy = 2;
    const total = MAX_VISIBLE_TOASTS + overflowBy;
    for (let i = 0; i < total; i++) {
      useViewStore.getState().pushToast({ text: `t${i}` });
    }
    const queue = useViewStore.getState().notifications;
    expect(queue.length).toBe(MAX_VISIBLE_TOASTS);
    // First survivor should be t{overflowBy} (the (overflowBy)-th push).
    expect(queue[0]?.text).toBe(`t${overflowBy}`);
    expect(queue.at(-1)?.text).toBe(`t${total - 1}`);
  });

  it('dismissToast removes only the matching id', () => {
    const id1 = useViewStore.getState().pushToast({ text: 'one' });
    const id2 = useViewStore.getState().pushToast({ text: 'two' });
    useViewStore.getState().dismissToast(id1);
    const queue = useViewStore.getState().notifications;
    expect(queue.length).toBe(1);
    expect(queue[0]?.id).toBe(id2);
  });

  it('dismissToast is a no-op on an unknown id', () => {
    useViewStore.getState().pushToast({ text: 'still here' });
    useViewStore.getState().dismissToast('does-not-exist');
    expect(useViewStore.getState().notifications.length).toBe(1);
  });

  it('clearAllToasts empties the queue', () => {
    useViewStore.getState().pushToast({ text: 'a' });
    useViewStore.getState().pushToast({ text: 'b' });
    useViewStore.getState().clearAllToasts();
    expect(useViewStore.getState().notifications).toEqual([]);
  });
});

// ── Phase 41 Slice 2 — inspector section open/closed persistence ────────────

describe('viewStore — inspectorSectionsOpen', () => {
  it('seeds Identity / Duration / Resources open and Cost / Advanced collapsed', () => {
    const state = useViewStore.getState().inspectorSectionsOpen;
    expect(state.identity).toBe(true);
    expect(state.duration).toBe(true);
    expect(state.resources).toBe(true);
    expect(state.cost).toBe(false);
    expect(state.advanced).toBe(false);
  });

  it('toggleInspectorSection flips the named section without touching others', () => {
    const before = useViewStore.getState().inspectorSectionsOpen;
    useViewStore.getState().toggleInspectorSection('cost');
    const after = useViewStore.getState().inspectorSectionsOpen;
    expect(after.cost).toBe(!before.cost);
    // Other sections preserved
    expect(after.identity).toBe(before.identity);
    expect(after.duration).toBe(before.duration);
    expect(after.resources).toBe(before.resources);
    expect(after.advanced).toBe(before.advanced);
    // Restore for downstream tests
    useViewStore.getState().toggleInspectorSection('cost');
  });

  it('toggle is idempotent over an even number of flips', () => {
    const before = useViewStore.getState().inspectorSectionsOpen.identity;
    useViewStore.getState().toggleInspectorSection('identity');
    useViewStore.getState().toggleInspectorSection('identity');
    expect(useViewStore.getState().inspectorSectionsOpen.identity).toBe(before);
  });

  it('expandInspectorSection opens a collapsed section', () => {
    // Cost is collapsed by default; force the precondition explicitly so
    // the test is robust to other tests' write-through to localStorage.
    const s = useViewStore.getState();
    if (s.inspectorSectionsOpen.cost) s.toggleInspectorSection('cost');
    expect(useViewStore.getState().inspectorSectionsOpen.cost).toBe(false);
    useViewStore.getState().expandInspectorSection('cost');
    expect(useViewStore.getState().inspectorSectionsOpen.cost).toBe(true);
    // Restore for downstream tests.
    useViewStore.getState().toggleInspectorSection('cost');
  });

  it('expandInspectorSection is a no-op when the section is already open', () => {
    // Identity defaults open; expand should leave it open without
    // touching state (used by the drag-to-assign flow which fires
    // `expandInspectorSection('resources')` unconditionally).
    const before = useViewStore.getState().inspectorSectionsOpen;
    useViewStore.getState().expandInspectorSection('identity');
    const after = useViewStore.getState().inspectorSectionsOpen;
    expect(after.identity).toBe(true);
    expect(after).toBe(before); // same reference — no spurious re-render trigger
  });
});

describe('viewStore — Phase 43 palette + scroll hint', () => {
  it('resourcePaletteOpen defaults to false', () => {
    // Persisted to localStorage but defaults off so the band doesn't
    // eat vertical space on a fresh install.
    expect(useViewStore.getState().resourcePaletteOpen).toBe(false);
  });

  it('toggleResourcePalette flips the value', () => {
    const before = useViewStore.getState().resourcePaletteOpen;
    useViewStore.getState().toggleResourcePalette();
    expect(useViewStore.getState().resourcePaletteOpen).toBe(!before);
    useViewStore.getState().toggleResourcePalette();
    expect(useViewStore.getState().resourcePaletteOpen).toBe(before);
  });

  it('inspectorScrollToAssignmentId defaults to null and round-trips through the setter', () => {
    expect(useViewStore.getState().inspectorScrollToAssignmentId).toBe(null);
    useViewStore.getState().setInspectorScrollToAssignmentId('res-1');
    expect(useViewStore.getState().inspectorScrollToAssignmentId).toBe('res-1');
    useViewStore.getState().setInspectorScrollToAssignmentId(null);
    expect(useViewStore.getState().inspectorScrollToAssignmentId).toBe(null);
  });
});

describe('viewStore — Phase 45 fit-view request', () => {
  it('pendingFitView defaults to false', () => {
    useViewStore.getState().consumeFitView();
    expect(useViewStore.getState().pendingFitView).toBe(false);
  });

  it('requestFitView raises the flag', () => {
    useViewStore.getState().consumeFitView();
    useViewStore.getState().requestFitView();
    expect(useViewStore.getState().pendingFitView).toBe(true);
  });

  it('consumeFitView clears the flag', () => {
    useViewStore.getState().requestFitView();
    expect(useViewStore.getState().pendingFitView).toBe(true);
    useViewStore.getState().consumeFitView();
    expect(useViewStore.getState().pendingFitView).toBe(false);
  });

  it('consumeFitView is a no-op when the flag is already false (no spurious state churn)', () => {
    useViewStore.getState().consumeFitView();
    const before = useViewStore.getState();
    useViewStore.getState().consumeFitView();
    const after = useViewStore.getState();
    expect(after).toBe(before);
  });
});

describe('viewStore — Phase 45 Slice 5a placement mode', () => {
  it('placementType defaults to null', () => {
    useViewStore.getState().cancelPlacement();
    expect(useViewStore.getState().placementType).toBe(null);
  });

  it('startPlacement sets the type', () => {
    useViewStore.getState().startPlacement('activity');
    expect(useViewStore.getState().placementType).toBe('activity');
    useViewStore.getState().cancelPlacement();
  });

  it('startPlacement clears any in-progress selection', () => {
    // Pre-populate selection so we can verify the clearing.
    useViewStore.getState().selectNodes(['node-a', 'node-b']);
    expect(useViewStore.getState().selection.nodeIds.length).toBeGreaterThan(0);
    useViewStore.getState().startPlacement('decision');
    expect(useViewStore.getState().selection.nodeIds).toEqual([]);
    expect(useViewStore.getState().selectedLoopId).toBe(null);
    useViewStore.getState().cancelPlacement();
  });

  it('setPlacementType swaps the type without re-clearing selection', () => {
    // Start placement (selection clears as a side-effect). Then
    // populate selection AFTER placement is active; setPlacementType
    // should leave that selection alone (it's only `startPlacement`
    // that explicitly clears).
    useViewStore.getState().startPlacement('activity');
    useViewStore.getState().selectNodes(['node-x']);
    useViewStore.getState().setPlacementType('decision');
    expect(useViewStore.getState().placementType).toBe('decision');
    expect(useViewStore.getState().selection.nodeIds).toEqual(['node-x']);
    useViewStore.getState().cancelPlacement();
    useViewStore.getState().clearSelection();
  });

  it('setPlacementType is a no-op when the type is unchanged', () => {
    useViewStore.getState().startPlacement('activity');
    const before = useViewStore.getState();
    useViewStore.getState().setPlacementType('activity');
    const after = useViewStore.getState();
    expect(after).toBe(before);
    useViewStore.getState().cancelPlacement();
  });

  it('cancelPlacement clears the type and is a no-op when already null', () => {
    useViewStore.getState().startPlacement('start');
    useViewStore.getState().cancelPlacement();
    expect(useViewStore.getState().placementType).toBe(null);
    const before = useViewStore.getState();
    useViewStore.getState().cancelPlacement();
    const after = useViewStore.getState();
    expect(after).toBe(before);
  });
});

describe('viewStore — Phase 45 Slice 5b placement position', () => {
  it('placementPosition defaults to null', () => {
    useViewStore.getState().cancelPlacement();
    expect(useViewStore.getState().placementPosition).toBe(null);
  });

  it('setPlacementPosition writes the new position', () => {
    useViewStore.getState().setPlacementPosition({ x: 100, y: 200 });
    expect(useViewStore.getState().placementPosition).toEqual({ x: 100, y: 200 });
    useViewStore.getState().cancelPlacement();
  });

  it('cancelPlacement clears placementPosition along with the type', () => {
    useViewStore.getState().startPlacement('activity');
    useViewStore.getState().setPlacementPosition({ x: 50, y: 75 });
    useViewStore.getState().cancelPlacement();
    expect(useViewStore.getState().placementType).toBe(null);
    expect(useViewStore.getState().placementPosition).toBe(null);
  });

  it('startPlacement resets placementPosition so a fresh entry re-seeds', () => {
    // Simulate the user having positioned a previous (stale) ghost:
    useViewStore.getState().setPlacementPosition({ x: 999, y: 999 });
    useViewStore.getState().startPlacement('decision');
    // Without the reset, the new ghost would briefly render at (999, 999)
    // before PlacementOverlay's mount-effect / pointermove update it.
    expect(useViewStore.getState().placementPosition).toBe(null);
    useViewStore.getState().cancelPlacement();
  });

  it('setPlacementType preserves placementPosition (switch keeps position)', () => {
    useViewStore.getState().startPlacement('activity');
    useViewStore.getState().setPlacementPosition({ x: 200, y: 300 });
    useViewStore.getState().setPlacementType('decision');
    expect(useViewStore.getState().placementType).toBe('decision');
    expect(useViewStore.getState().placementPosition).toEqual({ x: 200, y: 300 });
    useViewStore.getState().cancelPlacement();
  });
});

describe('viewStore — Phase 45 Slice 5c quick-name', () => {
  it('namingNodeId defaults to null', () => {
    useViewStore.getState().endNaming();
    expect(useViewStore.getState().namingNodeId).toBe(null);
  });

  it('startNaming sets the id', () => {
    useViewStore.getState().startNaming('node-123');
    expect(useViewStore.getState().namingNodeId).toBe('node-123');
    useViewStore.getState().endNaming();
  });

  it('endNaming clears the id and is a no-op when already null', () => {
    useViewStore.getState().startNaming('node-x');
    useViewStore.getState().endNaming();
    expect(useViewStore.getState().namingNodeId).toBe(null);
    const before = useViewStore.getState();
    useViewStore.getState().endNaming();
    const after = useViewStore.getState();
    expect(after).toBe(before);
  });
});

describe('viewStore — Phase 49 Slice 4 pending placement sources', () => {
  function reset() {
    useViewStore.getState().cancelPlacement();
  }

  it('pendingPlacementSources defaults to empty', () => {
    reset();
    expect(useViewStore.getState().pendingPlacementSources).toEqual([]);
  });

  it('push adds an id; same-id pushes are idempotent', () => {
    reset();
    useViewStore.getState().pushPendingPlacementSource('node-a');
    useViewStore.getState().pushPendingPlacementSource('node-b');
    useViewStore.getState().pushPendingPlacementSource('node-a'); // dup
    expect(useViewStore.getState().pendingPlacementSources).toEqual(['node-a', 'node-b']);
    reset();
  });

  it('idempotent push is a referential no-op (subscribers do not churn)', () => {
    reset();
    useViewStore.getState().pushPendingPlacementSource('x');
    const before = useViewStore.getState();
    useViewStore.getState().pushPendingPlacementSource('x'); // dup
    const after = useViewStore.getState();
    expect(after).toBe(before);
    reset();
  });

  it('pop removes the last id (LIFO); empty-stack pop is a no-op', () => {
    reset();
    useViewStore.getState().pushPendingPlacementSource('a');
    useViewStore.getState().pushPendingPlacementSource('b');
    useViewStore.getState().pushPendingPlacementSource('c');
    useViewStore.getState().popPendingPlacementSource();
    expect(useViewStore.getState().pendingPlacementSources).toEqual(['a', 'b']);
    useViewStore.getState().popPendingPlacementSource();
    useViewStore.getState().popPendingPlacementSource();
    expect(useViewStore.getState().pendingPlacementSources).toEqual([]);
    const before = useViewStore.getState();
    useViewStore.getState().popPendingPlacementSource(); // empty
    expect(useViewStore.getState()).toBe(before);
    reset();
  });

  it('clear empties the stack; clearing already-empty is a no-op', () => {
    reset();
    useViewStore.getState().pushPendingPlacementSource('a');
    useViewStore.getState().pushPendingPlacementSource('b');
    useViewStore.getState().clearPendingPlacementSources();
    expect(useViewStore.getState().pendingPlacementSources).toEqual([]);
    const before = useViewStore.getState();
    useViewStore.getState().clearPendingPlacementSources();
    expect(useViewStore.getState()).toBe(before);
  });

  it('cancelPlacement drains the pending stack alongside type + position', () => {
    useViewStore.getState().startPlacement('activity');
    useViewStore.getState().setPlacementPosition({ x: 10, y: 20 });
    useViewStore.getState().pushPendingPlacementSource('src-1');
    useViewStore.getState().pushPendingPlacementSource('src-2');
    useViewStore.getState().cancelPlacement();
    expect(useViewStore.getState().placementType).toBe(null);
    expect(useViewStore.getState().placementPosition).toBe(null);
    expect(useViewStore.getState().pendingPlacementSources).toEqual([]);
  });

  it('startPlacement clears any stale stack from a prior placement', () => {
    useViewStore.getState().startPlacement('activity');
    useViewStore.getState().pushPendingPlacementSource('leftover');
    // Don't cancel — simulate entering a new placement without the
    // usual cleanup path. startPlacement is the defence-in-depth.
    useViewStore.getState().startPlacement('decision');
    expect(useViewStore.getState().pendingPlacementSources).toEqual([]);
    useViewStore.getState().cancelPlacement();
  });
});

// ── Phase 50 Slice 10 — comment lifecycle state (audit C-16) ─────────────────

describe('viewStore — comment selection + initial-edit gating (audit C-16)', () => {
  // Reset relevant state between tests so leakage from previous specs
  // doesn't confound assertions.
  beforeEach(() => {
    useViewStore.getState().setSelectedCommentIds([]);
    useViewStore.getState().setPendingInitialEditingCommentId(null);
    useViewStore.getState().clearSelection();
  });

  it('setSelectedCommentIds stores comment ids separately from node selection', () => {
    useViewStore.getState().setSelectedNodeIds(['n1']);
    useViewStore.getState().setSelectedCommentIds(['c1', 'c2']);
    const state = useViewStore.getState();
    expect(state.selection.nodeIds).toEqual(['n1']);
    expect(state.selectedCommentIds).toEqual(['c1', 'c2']);
  });

  it('setPendingInitialEditingCommentId sets and clears the auto-edit flag', () => {
    expect(useViewStore.getState().pendingInitialEditingCommentId).toBeNull();
    useViewStore.getState().setPendingInitialEditingCommentId('c1');
    expect(useViewStore.getState().pendingInitialEditingCommentId).toBe('c1');
    useViewStore.getState().setPendingInitialEditingCommentId(null);
    expect(useViewStore.getState().pendingInitialEditingCommentId).toBeNull();
  });

  it('clearSelection clears comment ids alongside node ids and loop selection', () => {
    useViewStore.getState().setSelectedNodeIds(['n1']);
    useViewStore.getState().setSelectedCommentIds(['c1']);
    useViewStore.getState().selectLoop('loop1');
    useViewStore.getState().clearSelection();
    const state = useViewStore.getState();
    expect(state.selection.nodeIds).toEqual([]);
    expect(state.selectedLoopId).toBeNull();
    expect(state.selectedCommentIds).toEqual([]);
  });

  it('clearSelection does NOT clear the pending-initial-editing flag (it is lifecycle, not selection)', () => {
    // The pending-edit flag is tied to "the user just placed this comment",
    // not to selection state. It clears via CommentNode commit/cancel or
    // an explicit setter call, NOT when the user clicks elsewhere.
    useViewStore.getState().setPendingInitialEditingCommentId('c1');
    useViewStore.getState().clearSelection();
    expect(useViewStore.getState().pendingInitialEditingCommentId).toBe('c1');
  });
});
