import { describe, it, expect, beforeEach } from 'vitest';
import {
  useDomainStore,
  beginEdit,
  commitEdit,
  abortEdit,
  redoWithFeedback,
  undoWithFeedback,
  makeDefaultProject,
  __hasActiveEditSession,
} from './domainStore.js';
import { useViewStore } from './viewStore.js';

function resetStore() {
  abortEdit();
  const fresh = useDomainStore.getState().project;
  useDomainStore.temporal.getState().clear();
  // Also reset lastIntent — it's a partialized field too, so it can leak
  // between tests just like project would.
  useDomainStore.setState({ project: fresh, lastIntent: null });
  useDomainStore.temporal.getState().clear();
}

function history() {
  const t = useDomainStore.temporal.getState();
  return { past: t.pastStates.length, future: t.futureStates.length };
}

describe('domainStore — undo/redo discipline', () => {
  beforeEach(() => {
    resetStore();
  });

  it('addNode → one undo step', () => {
    expect(history().past).toBe(0);
    useDomainStore.getState().addNode({ x: 10, y: 20 });
    expect(history().past).toBe(1);
    const afterAdd = useDomainStore.getState().project.nodes.length;

    useDomainStore.temporal.getState().undo();
    expect(useDomainStore.getState().project.nodes.length).toBe(afterAdd - 1);
    expect(history().past).toBe(0);
    expect(history().future).toBe(1);
  });

  it('edit session: every keystroke within focus→blur is one history entry', () => {
    const id = useDomainStore.getState().project.nodes[0]!.id;
    const originalName = useDomainStore.getState().project.nodes[0]!.name;

    beginEdit();
    useDomainStore.getState().updateNodeName(id, 'A');
    useDomainStore.getState().updateNodeName(id, 'Ab');
    useDomainStore.getState().updateNodeName(id, 'Abc');
    useDomainStore.getState().updateNodeName(id, 'Abcd');
    useDomainStore.getState().updateNodeName(id, 'Abcde');
    // Still inside the session: history not yet committed.
    expect(history().past).toBe(0);
    commitEdit();

    expect(history().past).toBe(1);
    expect(useDomainStore.getState().project.nodes[0]!.name).toBe('Abcde');

    // One undo rewinds to the pre-session value (not to 'Abcd').
    useDomainStore.temporal.getState().undo();
    expect(useDomainStore.getState().project.nodes[0]!.name).toBe(originalName);
  });

  it('edit session with corrections (typo then fix) is still one entry', () => {
    const id = useDomainStore.getState().project.nodes[0]!.id;
    const originalName = useDomainStore.getState().project.nodes[0]!.name;

    beginEdit();
    useDomainStore.getState().updateNodeName(id, 'H');
    useDomainStore.getState().updateNodeName(id, 'He');
    useDomainStore.getState().updateNodeName(id, 'Hel');
    useDomainStore.getState().updateNodeName(id, 'Helo'); // typo
    useDomainStore.getState().updateNodeName(id, 'Hel'); // backspace
    useDomainStore.getState().updateNodeName(id, 'Hell');
    useDomainStore.getState().updateNodeName(id, 'Hello');
    commitEdit();

    expect(history().past).toBe(1);
    useDomainStore.temporal.getState().undo();
    expect(useDomainStore.getState().project.nodes[0]!.name).toBe(originalName);
  });

  it('each focus→blur session yields a separate history entry', () => {
    const id = useDomainStore.getState().project.nodes[0]!.id;

    beginEdit();
    useDomainStore.getState().updateNodeName(id, 'first');
    commitEdit();

    beginEdit();
    useDomainStore.getState().updateNodeName(id, 'second');
    commitEdit();

    expect(history().past).toBe(2);

    useDomainStore.temporal.getState().undo();
    expect(useDomainStore.getState().project.nodes[0]!.name).toBe('first');
    useDomainStore.temporal.getState().undo();
    expect(useDomainStore.getState().project.nodes[0]!.name).toBe('Activity 1');
  });

  it('structural action flushes an in-flight edit (edit + add = 2 entries)', () => {
    const id = useDomainStore.getState().project.nodes[0]!.id;

    // User focuses the name field, types — but clicks "Add Node" before blur.
    beginEdit();
    useDomainStore.getState().updateNodeName(id, 'Renamed');
    // Simulate addNode being triggered without the input's onBlur firing first.
    useDomainStore.getState().addNode({ x: 200, y: 200 });

    // Both actions should land in history as separate entries.
    expect(history().past).toBe(2);
    expect(__hasActiveEditSession()).toBe(false);

    // Undo peels back the add, then the rename.
    useDomainStore.temporal.getState().undo();
    expect(useDomainStore.getState().project.nodes[0]!.name).toBe('Renamed');
    useDomainStore.temporal.getState().undo();
    expect(useDomainStore.getState().project.nodes[0]!.name).toBe('Activity 1');
  });

  it('empty edit session (focus then blur without typing) pushes nothing', () => {
    beginEdit();
    commitEdit();
    expect(history().past).toBe(0);
  });

  // Phase 50 Slice 16 — audit row I-17. The "structural action flushes an
  // in-flight edit" test above covers `addNode`; these cover the
  // discrete-event actions that were previously skipping `commitEdit()` at
  // their top and so were folding sibling-field edits into the same undo
  // step. Pattern: open a session on field A, fire the discrete action
  // for field B, ⌘Z → only B reverts; A's change is preserved as a
  // separate entry.
  describe('I-17 — discrete actions flush in-flight edit sessions', () => {
    it('updateNodeColor (audit-named)', () => {
      const id = useDomainStore.getState().project.nodes[0]!.id;
      beginEdit();
      useDomainStore.getState().updateNodeName(id, 'Renamed');
      useDomainStore.getState().updateNodeColor(id, '#ff0000');

      expect(history().past).toBe(2);
      expect(__hasActiveEditSession()).toBe(false);

      useDomainStore.temporal.getState().undo();
      expect(useDomainStore.getState().project.nodes[0]!.name).toBe('Renamed');
      expect(useDomainStore.getState().project.nodes[0]!.color).toBeUndefined();
    });

    it('updateNodeDistribution (audit-named)', () => {
      const id = useDomainStore.getState().project.nodes[0]!.id;
      beginEdit();
      useDomainStore.getState().updateNodeName(id, 'Renamed');
      useDomainStore
        .getState()
        .updateNodeDistribution(id, { type: 'triangular', min: 1, mode: 2, max: 3 });

      expect(history().past).toBe(2);

      useDomainStore.temporal.getState().undo();
      expect(useDomainStore.getState().project.nodes[0]!.name).toBe('Renamed');
      expect(useDomainStore.getState().project.nodes[0]!.distribution).toBeUndefined();
    });

    it('updateNodeFixedCost (audit-named)', () => {
      const id = useDomainStore.getState().project.nodes[0]!.id;
      beginEdit();
      useDomainStore.getState().updateNodeName(id, 'Renamed');
      useDomainStore.getState().updateNodeFixedCost(id, { value: 100 });

      expect(history().past).toBe(2);

      useDomainStore.temporal.getState().undo();
      expect(useDomainStore.getState().project.nodes[0]!.name).toBe('Renamed');
      expect(useDomainStore.getState().project.nodes[0]!.fixedCost).toBeUndefined();
    });

    it('updateProjectBudget (audit-named)', () => {
      const id = useDomainStore.getState().project.nodes[0]!.id;
      beginEdit();
      useDomainStore.getState().updateNodeName(id, 'Renamed');
      useDomainStore.getState().updateProjectBudget(50_000);

      expect(history().past).toBe(2);

      useDomainStore.temporal.getState().undo();
      expect(useDomainStore.getState().project.nodes[0]!.name).toBe('Renamed');
      expect(useDomainStore.getState().project.budget).toBeUndefined();
    });

    it('updateNodeGroup', () => {
      const id = useDomainStore.getState().project.nodes[0]!.id;
      beginEdit();
      useDomainStore.getState().updateNodeName(id, 'Renamed');
      useDomainStore.getState().updateNodeGroup(id, 'planning');

      expect(history().past).toBe(2);

      useDomainStore.temporal.getState().undo();
      expect(useDomainStore.getState().project.nodes[0]!.name).toBe('Renamed');
      expect(useDomainStore.getState().project.nodes[0]!.group).toBeUndefined();
    });

    it('moveComment', () => {
      const commentId = useDomainStore.getState().addComment({ x: 0, y: 0 });
      // addComment is structural; gives us a comment to move.
      const id = useDomainStore.getState().project.nodes[0]!.id;
      const baseline = history().past;

      beginEdit();
      useDomainStore.getState().updateNodeName(id, 'Renamed');
      useDomainStore.getState().moveComment(commentId, { x: 100, y: 100 });

      // Two new entries on top of the baseline (the rename, then the move).
      expect(history().past).toBe(baseline + 2);

      useDomainStore.temporal.getState().undo();
      const c = useDomainStore.getState().project.comments.find((c) => c.id === commentId);
      expect(c?.x).toBe(0);
      expect(c?.y).toBe(0);
      expect(useDomainStore.getState().project.nodes[0]!.name).toBe('Renamed');
    });
  });

  it('pasteNodes → one undo step for N pasted nodes', () => {
    const existing = useDomainStore.getState().project.nodes;
    useDomainStore.getState().pasteNodes(existing, { x: 40, y: 40 });

    expect(history().past).toBe(1);
    useDomainStore.temporal.getState().undo();
    expect(useDomainStore.getState().project.nodes.length).toBe(existing.length);
  });

  it('deleteNodes removes incident edges atomically', () => {
    const a = useDomainStore.getState().project.nodes[0]!.id;
    useDomainStore.getState().addNode({ x: 100, y: 100 });
    const b = useDomainStore.getState().project.nodes.at(-1)!.id;
    useDomainStore.getState().connectNodes(a, b);
    expect(useDomainStore.getState().project.edges.length).toBe(1);

    useDomainStore.getState().deleteNodes([a]);
    expect(useDomainStore.getState().project.edges.length).toBe(0);
    expect(useDomainStore.getState().project.nodes.find((n) => n.id === a)).toBeUndefined();
  });

  it('edge type update produces a history entry', () => {
    const a = useDomainStore.getState().project.nodes[0]!.id;
    useDomainStore.getState().addNode({ x: 100, y: 100 });
    const b = useDomainStore.getState().project.nodes.at(-1)!.id;
    useDomainStore.getState().connectNodes(a, b);
    const edgeId = useDomainStore.getState().project.edges[0]!.id;

    const before = history().past;
    useDomainStore.getState().updateEdgeType(edgeId, 'SS');
    expect(useDomainStore.getState().project.edges[0]!.type).toBe('SS');
    expect(history().past).toBe(before + 1);
  });

  // ── Phase 17 slice 2 — capacity + reassign ────────────────────────────────

  it('setResourceCapacity bumps capacity as one undo step', () => {
    // Seed: add a resource so we have something to bump.
    useDomainStore.getState().addResource({
      name: 'Dev',
      capacity: 2,
      workingDays: [true, true, true, true, true, false, false],
      hoursPerDay: 8,
    });
    const resId = useDomainStore.getState().project.resources.at(-1)!.id;
    const before = history().past;

    useDomainStore.getState().setResourceCapacity(resId, 5);
    expect(useDomainStore.getState().project.resources.find((r) => r.id === resId)!.capacity).toBe(
      5,
    );
    expect(history().past).toBe(before + 1);

    useDomainStore.temporal.getState().undo();
    expect(useDomainStore.getState().project.resources.find((r) => r.id === resId)!.capacity).toBe(
      2,
    );
  });

  it('setResourceCapacity rejects capacities < 1', () => {
    useDomainStore.getState().addResource({
      name: 'Dev',
      capacity: 2,
      workingDays: [true, true, true, true, true, false, false],
      hoursPerDay: 8,
    });
    const resId = useDomainStore.getState().project.resources.at(-1)!.id;

    useDomainStore.getState().setResourceCapacity(resId, 0);
    // Capacity unchanged
    expect(useDomainStore.getState().project.resources.find((r) => r.id === resId)!.capacity).toBe(
      2,
    );
  });

  // ── Phase 18 slice 1 — multi-resource assignment actions ────────────────
  //
  // resetStore() preserves project state across tests (it only clears the
  // temporal stack), so each test below starts by zeroing out the target
  // node's resourceAssignments and adding its own two fresh resources.
  // Asserting on resourceAssignments[index] is unsafe when stale entries
  // could be present; tests look up by resourceId instead.

  function freshNodeAndTwoResources(): {
    nodeId: string;
    devId: string;
    ovfId: string;
  } {
    const nodeId = useDomainStore.getState().project.nodes[0]!.id;
    // Clear any assignments left over from earlier tests so each test
    // starts from a known empty-assignments state on this node.
    useDomainStore.getState().setNodeResourceAssignments(nodeId, []);
    useDomainStore.getState().addResource({
      name: 'Dev',
      capacity: 2,
      workingDays: [true, true, true, true, true, false, false],
      hoursPerDay: 8,
    });
    useDomainStore.getState().addResource({
      name: 'Overflow',
      capacity: 2,
      workingDays: [true, true, true, true, true, false, false],
      hoursPerDay: 8,
    });
    const resources = useDomainStore.getState().project.resources;
    // Reset the temporal stack so the setup actions don't count toward
    // the history-length assertions in each test.
    useDomainStore.temporal.getState().clear();
    return {
      nodeId,
      devId: resources.at(-2)!.id,
      ovfId: resources.at(-1)!.id,
    };
  }

  function findAssignment(nodeId: string, resourceId: string) {
    return useDomainStore
      .getState()
      .project.nodes.find((n) => n.id === nodeId)!
      .resourceAssignments.find((a) => a.resourceId === resourceId);
  }

  it('addResourceAssignment → one undo step; undo restores prior assignments', () => {
    const { nodeId, devId } = freshNodeAndTwoResources();
    expect(history().past).toBe(0);

    useDomainStore.getState().addResourceAssignment(nodeId, {
      resourceId: devId,
      count: 2,
      calendarPolicy: 'activityWins',
    });

    expect(findAssignment(nodeId, devId)?.count).toBe(2);
    expect(history().past).toBe(1);

    useDomainStore.temporal.getState().undo();
    expect(findAssignment(nodeId, devId)).toBeUndefined();
  });

  it('addResourceAssignment rejects a duplicate resourceId on the same node', () => {
    const { nodeId, devId } = freshNodeAndTwoResources();

    useDomainStore.getState().addResourceAssignment(nodeId, {
      resourceId: devId,
      count: 1,
      calendarPolicy: 'activityWins',
    });
    const before = history().past;

    // Second add for the same resource is a silent no-op.
    useDomainStore.getState().addResourceAssignment(nodeId, {
      resourceId: devId,
      count: 5,
      calendarPolicy: 'intersection',
    });
    expect(findAssignment(nodeId, devId)?.count).toBe(1);
    expect(history().past).toBe(before);
  });

  it('updateResourceAssignmentCount: per-keystroke edits coalesce within an edit session', () => {
    const { nodeId, devId } = freshNodeAndTwoResources();
    useDomainStore.getState().addResourceAssignment(nodeId, {
      resourceId: devId,
      count: 1,
      calendarPolicy: 'activityWins',
    });
    const before = history().past;

    beginEdit();
    useDomainStore.getState().updateResourceAssignmentCount(nodeId, devId, 2);
    useDomainStore.getState().updateResourceAssignmentCount(nodeId, devId, 3);
    useDomainStore.getState().updateResourceAssignmentCount(nodeId, devId, 4);
    // No history entries while still inside the session.
    expect(history().past).toBe(before);
    commitEdit();
    expect(history().past).toBe(before + 1);

    expect(findAssignment(nodeId, devId)?.count).toBe(4);

    // One undo rewinds to the pre-session value (count 1), not to 3.
    useDomainStore.temporal.getState().undo();
    expect(findAssignment(nodeId, devId)?.count).toBe(1);
  });

  it('updateResourceAssignmentCount rejects count < 1', () => {
    const { nodeId, devId } = freshNodeAndTwoResources();
    useDomainStore.getState().addResourceAssignment(nodeId, {
      resourceId: devId,
      count: 2,
      calendarPolicy: 'activityWins',
    });

    useDomainStore.getState().updateResourceAssignmentCount(nodeId, devId, 0);
    expect(findAssignment(nodeId, devId)?.count).toBe(2);
  });

  it('updateResourceAssignmentPolicy → one undo step; undo restores prior policy', () => {
    const { nodeId, devId } = freshNodeAndTwoResources();
    useDomainStore.getState().addResourceAssignment(nodeId, {
      resourceId: devId,
      count: 1,
      calendarPolicy: 'intersection',
    });
    const before = history().past;

    useDomainStore.getState().updateResourceAssignmentPolicy(nodeId, devId, 'resourceWins');
    expect(findAssignment(nodeId, devId)?.calendarPolicy).toBe('resourceWins');
    expect(history().past).toBe(before + 1);

    useDomainStore.temporal.getState().undo();
    expect(findAssignment(nodeId, devId)?.calendarPolicy).toBe('intersection');
  });

  it('updateResourceAssignmentPolicy is a silent no-op for unknown resourceId', () => {
    const { nodeId, devId, ovfId } = freshNodeAndTwoResources();
    useDomainStore.getState().addResourceAssignment(nodeId, {
      resourceId: devId,
      count: 1,
      calendarPolicy: 'intersection',
    });
    const before = history().past;

    useDomainStore.getState().updateResourceAssignmentPolicy(nodeId, ovfId, 'resourceWins');
    expect(findAssignment(nodeId, devId)?.calendarPolicy).toBe('intersection');
    expect(history().past).toBe(before);
  });

  it('removeResourceAssignment → one undo step; undo restores it', () => {
    const { nodeId, devId, ovfId } = freshNodeAndTwoResources();
    useDomainStore.getState().addResourceAssignment(nodeId, {
      resourceId: devId,
      count: 2,
      calendarPolicy: 'activityWins',
    });
    useDomainStore.getState().addResourceAssignment(nodeId, {
      resourceId: ovfId,
      count: 1,
      calendarPolicy: 'activityWins',
    });
    const before = history().past;

    useDomainStore.getState().removeResourceAssignment(nodeId, ovfId);
    expect(findAssignment(nodeId, devId)).toBeDefined();
    expect(findAssignment(nodeId, ovfId)).toBeUndefined();
    expect(history().past).toBe(before + 1);

    useDomainStore.temporal.getState().undo();
    expect(findAssignment(nodeId, ovfId)?.count).toBe(1);
  });

  it('splitResourceAssignment: moves N units from one resource to another in one undo step', () => {
    const { nodeId, devId, ovfId } = freshNodeAndTwoResources();
    useDomainStore.getState().addResourceAssignment(nodeId, {
      resourceId: devId,
      count: 4,
      calendarPolicy: 'activityWins',
    });
    const before = history().past;

    useDomainStore.getState().splitResourceAssignment(nodeId, devId, ovfId, 2);

    expect(findAssignment(nodeId, devId)?.count).toBe(2);
    const ovf = findAssignment(nodeId, ovfId);
    expect(ovf?.count).toBe(2);
    // New `to` inherits the from assignment's calendarPolicy.
    expect(ovf?.calendarPolicy).toBe('activityWins');
    expect(history().past).toBe(before + 1);

    // Single undo restores both sides — Dev back to 4, Overflow removed.
    useDomainStore.temporal.getState().undo();
    expect(findAssignment(nodeId, devId)?.count).toBe(4);
    expect(findAssignment(nodeId, ovfId)).toBeUndefined();
  });

  it('splitResourceAssignment removes the from-assignment when its count hits 0', () => {
    const { nodeId, devId, ovfId } = freshNodeAndTwoResources();
    useDomainStore.getState().addResourceAssignment(nodeId, {
      resourceId: devId,
      count: 3,
      calendarPolicy: 'intersection',
    });

    useDomainStore.getState().splitResourceAssignment(nodeId, devId, ovfId, 3);

    expect(findAssignment(nodeId, devId)).toBeUndefined();
    const ovf = findAssignment(nodeId, ovfId);
    expect(ovf?.count).toBe(3);
    expect(ovf?.calendarPolicy).toBe('intersection');
  });

  it('splitResourceAssignment grows an existing to-assignment instead of creating a duplicate', () => {
    const { nodeId, devId, ovfId } = freshNodeAndTwoResources();
    useDomainStore.getState().addResourceAssignment(nodeId, {
      resourceId: devId,
      count: 4,
      calendarPolicy: 'activityWins',
    });
    useDomainStore.getState().addResourceAssignment(nodeId, {
      resourceId: ovfId,
      count: 1,
      calendarPolicy: 'resourceWins',
    });

    useDomainStore.getState().splitResourceAssignment(nodeId, devId, ovfId, 2);

    expect(findAssignment(nodeId, devId)?.count).toBe(2);
    const ovf = findAssignment(nodeId, ovfId);
    expect(ovf?.count).toBe(3);
    // Existing to-assignment's policy is preserved — not overwritten by from.
    expect(ovf?.calendarPolicy).toBe('resourceWins');
  });

  it('splitResourceAssignment: invalid arguments are silent no-ops', () => {
    const { nodeId, devId, ovfId } = freshNodeAndTwoResources();
    useDomainStore.getState().addResourceAssignment(nodeId, {
      resourceId: devId,
      count: 2,
      calendarPolicy: 'activityWins',
    });
    const before = history().past;
    const snapshot = JSON.stringify(
      useDomainStore.getState().project.nodes.find((n) => n.id === nodeId)!.resourceAssignments,
    );

    // from === to
    useDomainStore.getState().splitResourceAssignment(nodeId, devId, devId, 1);
    // count <= 0
    useDomainStore.getState().splitResourceAssignment(nodeId, devId, ovfId, 0);
    // count > from.count
    useDomainStore.getState().splitResourceAssignment(nodeId, devId, ovfId, 5);
    // from not on this node
    useDomainStore.getState().splitResourceAssignment(nodeId, ovfId, devId, 1);

    expect(history().past).toBe(before);
    expect(
      JSON.stringify(
        useDomainStore.getState().project.nodes.find((n) => n.id === nodeId)!.resourceAssignments,
      ),
    ).toBe(snapshot);
  });
});

// ── Phase 28: Risk register actions ────────────────────────────────────────

// ── Phase 33: Manual leveling priority ─────────────────────────────────────

describe('domainStore — Phase 33 leveling priority', () => {
  beforeEach(() => {
    resetStore();
  });

  it('setNodeLevelPriority writes a positive integer to an activity', () => {
    const activityId = useDomainStore.getState().project.nodes[0]!.id;
    useDomainStore.getState().setNodeLevelPriority(activityId, 7);
    const node = useDomainStore.getState().project.nodes.find((n) => n.id === activityId);
    expect(node!.levelPriority).toBe(7);
  });

  it('setNodeLevelPriority(undefined) strips the field', () => {
    const activityId = useDomainStore.getState().project.nodes[0]!.id;
    useDomainStore.getState().setNodeLevelPriority(activityId, 5);
    useDomainStore.getState().setNodeLevelPriority(activityId, undefined);
    const node = useDomainStore.getState().project.nodes.find((n) => n.id === activityId);
    // exactOptionalPropertyTypes — must be absent, not `undefined`.
    expect('levelPriority' in node!).toBe(false);
  });

  it('setNodeLevelPriority(0) also strips the field (engine treats 0 ≡ absent)', () => {
    const activityId = useDomainStore.getState().project.nodes[0]!.id;
    useDomainStore.getState().setNodeLevelPriority(activityId, 5);
    useDomainStore.getState().setNodeLevelPriority(activityId, 0);
    const node = useDomainStore.getState().project.nodes.find((n) => n.id === activityId);
    expect('levelPriority' in node!).toBe(false);
  });

  it('writes to a decision node', () => {
    useDomainStore.getState().addDecisionNode({ x: 0, y: 0 });
    const decisionId = useDomainStore
      .getState()
      .project.nodes.find((n) => n.nodeType === 'decision')!.id;
    useDomainStore.getState().setNodeLevelPriority(decisionId, 3);
    const node = useDomainStore.getState().project.nodes.find((n) => n.id === decisionId);
    expect(node!.levelPriority).toBe(3);
  });
});

describe('domainStore — applyCalendarTemplate', () => {
  beforeEach(() => {
    resetStore();
  });

  it('overwrites workingDays / hoursPerDay / daysPerWeek on the target calendar', () => {
    const before = useDomainStore.getState().project.calendars[0]!;
    // Sanity check the seed — the test depends on the M-F 8h default.
    expect(before.hoursPerDay).toBe(8);
    expect(before.daysPerWeek).toBe(5);

    useDomainStore.getState().applyCalendarTemplate(before.id, 'compressed-4day');
    const after = useDomainStore.getState().project.calendars.find((c) => c.id === before.id);
    expect(after).toBeDefined();
    expect(after!.hoursPerDay).toBe(10);
    expect(after!.daysPerWeek).toBe(4);
    // [Sun, Mon, Tue, Wed, Thu, Fri, Sat] — Mon–Thu only.
    expect(after!.workingDays).toEqual([false, true, true, true, true, false, false]);
  });

  it("renames the calendar to the template's label", () => {
    // The calendar's displayed name must stay in sync with its actual
    // schedule — otherwise the Resource / Node calendar pickers show e.g.
    // "Mon–Fri 8h" for a calendar that the user just switched to a
    // 24/7 pattern.
    const before = useDomainStore.getState().project.calendars[0]!;
    expect(before.name).not.toBe('24/7 continuous'); // sanity: it's something else first

    useDomainStore.getState().applyCalendarTemplate(before.id, 'continuous-24-7');
    const after = useDomainStore.getState().project.calendars.find((c) => c.id === before.id);
    expect(after!.name).toBe('24/7 continuous');
  });

  it('leaves holidayPreset / holidayPresetVersion / exceptions alone', () => {
    const before = useDomainStore.getState().project.calendars[0]!;
    const originalPreset = before.holidayPreset;
    const originalVersion = before.holidayPresetVersion;
    const originalExceptions = before.exceptions;

    useDomainStore.getState().applyCalendarTemplate(before.id, 'continuous-24-7');
    const after = useDomainStore.getState().project.calendars.find((c) => c.id === before.id);
    expect(after!.holidayPreset).toBe(originalPreset);
    expect(after!.holidayPresetVersion).toBe(originalVersion);
    expect(after!.exceptions).toEqual(originalExceptions);
  });

  it("preserves the calendar's id (so any binding pointing at it still resolves)", () => {
    // The actual binding-preservation guarantee: applying a template
    // doesn't mint a new calendar id. Whatever pointed at this calendar
    // (project.defaultCalendarId, node.calendarId, resource.calendarId)
    // continues to find it after the apply.
    const before = useDomainStore.getState().project.calendars[0]!;
    const defaultIdBefore = useDomainStore.getState().project.project.defaultCalendarId;
    expect(defaultIdBefore).toBe(before.id);

    useDomainStore.getState().applyCalendarTemplate(before.id, 'sun-thu-8h');
    const after = useDomainStore.getState().project.calendars.find((c) => c.id === before.id);
    expect(after).toBeDefined();
    expect(after!.id).toBe(before.id);
    // The project default still resolves to it.
    expect(useDomainStore.getState().project.project.defaultCalendarId).toBe(after!.id);
  });

  it('is a no-op when the calendar id is unknown', () => {
    const before = useDomainStore.getState().project.calendars[0]!;
    useDomainStore.getState().applyCalendarTemplate('does-not-exist', 'mf-7h');
    const after = useDomainStore.getState().project.calendars[0]!;
    expect(after.hoursPerDay).toBe(before.hoursPerDay);
    expect(after.daysPerWeek).toBe(before.daysPerWeek);
  });

  it('is a no-op when the template id is unknown', () => {
    const before = useDomainStore.getState().project.calendars[0]!;
    useDomainStore.getState().applyCalendarTemplate(before.id, 'no-such-template');
    const after = useDomainStore.getState().project.calendars[0]!;
    expect(after.hoursPerDay).toBe(before.hoursPerDay);
    expect(after.daysPerWeek).toBe(before.daysPerWeek);
  });
});

describe('domainStore — per-node + per-resource calendar overrides', () => {
  beforeEach(() => {
    resetStore();
  });

  it('updateNodeCalendarId sets a non-null override and clears it via null', () => {
    useDomainStore.getState().addNode({ x: 0, y: 0 });
    const nodeId = useDomainStore.getState().project.nodes.at(-1)!.id;
    // Seed has 'cal-default' and 'cal-weekend' — point a node at weekend.
    useDomainStore.getState().updateNodeCalendarId(nodeId, 'cal-weekend');
    expect(useDomainStore.getState().project.nodes.find((n) => n.id === nodeId)!.calendarId).toBe(
      'cal-weekend',
    );
    useDomainStore.getState().updateNodeCalendarId(nodeId, null);
    expect(
      useDomainStore.getState().project.nodes.find((n) => n.id === nodeId)!.calendarId,
    ).toBeNull();
  });

  it('updateNodeCalendarId is a no-op on unknown calendar ids', () => {
    useDomainStore.getState().addNode({ x: 0, y: 0 });
    const nodeId = useDomainStore.getState().project.nodes.at(-1)!.id;
    const before = useDomainStore.getState().project.nodes.find((n) => n.id === nodeId)!.calendarId;
    useDomainStore.getState().updateNodeCalendarId(nodeId, 'cal-no-such-thing');
    const after = useDomainStore.getState().project.nodes.find((n) => n.id === nodeId)!.calendarId;
    expect(after).toBe(before);
  });

  it('updateResourceCalendarId switches the binding without mutating either calendar', () => {
    useDomainStore.getState().addResource({
      name: 'Designer',
      capacity: 1,
      workingDays: [true, true, true, true, true, false, false],
      hoursPerDay: 8,
    });
    const resource = useDomainStore.getState().project.resources.at(-1)!;
    // The resource was auto-bound to a freshly-minted private calendar.
    const privateCalId = resource.calendarId;
    expect(privateCalId).not.toBe('cal-default');

    const privateCalBefore = useDomainStore
      .getState()
      .project.calendars.find((c) => c.id === privateCalId)!;
    const defaultCalBefore = useDomainStore
      .getState()
      .project.calendars.find((c) => c.id === 'cal-default')!;

    useDomainStore.getState().updateResourceCalendarId(resource.id, 'cal-default');
    const after = useDomainStore.getState().project.resources.find((r) => r.id === resource.id)!;
    expect(after.calendarId).toBe('cal-default');

    // Neither calendar was mutated by the binding swap.
    const privateCalAfter = useDomainStore
      .getState()
      .project.calendars.find((c) => c.id === privateCalId)!;
    const defaultCalAfter = useDomainStore
      .getState()
      .project.calendars.find((c) => c.id === 'cal-default')!;
    expect(privateCalAfter).toEqual(privateCalBefore);
    expect(defaultCalAfter).toEqual(defaultCalBefore);
  });

  it('updateResourceCalendarId is a no-op on unknown calendar ids', () => {
    useDomainStore.getState().addResource({
      name: 'Tester',
      capacity: 1,
      workingDays: [true, true, true, true, true, false, false],
      hoursPerDay: 8,
    });
    const resource = useDomainStore.getState().project.resources.at(-1)!;
    const before = resource.calendarId;
    useDomainStore.getState().updateResourceCalendarId(resource.id, 'cal-no-such-thing');
    const after = useDomainStore.getState().project.resources.find((r) => r.id === resource.id)!;
    expect(after.calendarId).toBe(before);
  });
});

describe('domainStore — undo / redo feedback wrappers', () => {
  beforeEach(() => {
    resetStore();
    useViewStore.getState().clearAllToasts();
  });

  it('undoWithFeedback emits a toast naming the action that just ran', () => {
    // Slice 3 labels every authored action, so addNode now self-labels as
    // 'Added activity' and the toast reads back through to that label
    // rather than the generic "Last action" fallback.
    useDomainStore.getState().addNode({ x: 0, y: 0 });
    expect(useDomainStore.temporal.getState().pastStates.length).toBe(1);

    undoWithFeedback();

    const toasts = useViewStore.getState().notifications;
    expect(toasts.length).toBe(1);
    expect(toasts[0]?.kind).toBe('info');
    expect(toasts[0]?.text).toBe('Undone: Added activity');
    expect(useDomainStore.temporal.getState().pastStates.length).toBe(0);
  });

  it('falls back to "Last action" when an unlabelled state push is undone', () => {
    // Defensive coverage for the fallback path. Bulk replacements via
    // setState that don't carry a label can land in history (e.g. a hand-
    // written extension that forgets to set lastIntent). Confirm the
    // wrapper still produces a usable toast.
    useDomainStore.setState((s) => ({
      ...s,
      project: { ...s.project, project: { ...s.project.project, name: 'X' } },
    }));
    expect(useDomainStore.temporal.getState().pastStates.length).toBe(1);
    undoWithFeedback();
    const toasts = useViewStore.getState().notifications;
    expect(toasts[0]?.text).toBe('Undone: Last action');
  });

  it('undoWithFeedback surfaces the labelled action when lastIntent is set', () => {
    // Simulate a Slice-3-style labelled action by setting lastIntent
    // inside the action's set() call. The seed project starts with
    // lastIntent: null; this set bumps it.
    useDomainStore.setState((s) => ({
      ...s,
      lastIntent: 'Renamed node',
      project: {
        ...s.project,
        nodes: s.project.nodes.map((n, i) => (i === 0 ? { ...n, name: 'Renamed' } : n)),
      },
    }));
    expect(useDomainStore.temporal.getState().pastStates.length).toBe(1);

    undoWithFeedback();

    const toasts = useViewStore.getState().notifications;
    expect(toasts[0]?.text).toBe('Undone: Renamed node');
    // After undo, lastIntent should be restored to the pre-action value (null).
    expect(useDomainStore.getState().lastIntent).toBeNull();
  });

  it('redoWithFeedback names the action being re-applied', () => {
    useDomainStore.setState((s) => ({
      ...s,
      lastIntent: 'Switched currency USD → EUR',
      project: { ...s.project, currency: 'EUR' },
    }));
    undoWithFeedback();
    useViewStore.getState().clearAllToasts();

    expect(useDomainStore.temporal.getState().futureStates.length).toBe(1);
    redoWithFeedback();

    const toasts = useViewStore.getState().notifications;
    expect(toasts.length).toBe(1);
    expect(toasts[0]?.text).toBe('Redone: Switched currency USD → EUR');
    expect(useDomainStore.getState().lastIntent).toBe('Switched currency USD → EUR');
  });

  it('undoWithFeedback is a no-op (no toast) when there is nothing to undo', () => {
    expect(useDomainStore.temporal.getState().pastStates.length).toBe(0);
    undoWithFeedback();
    expect(useViewStore.getState().notifications).toEqual([]);
  });

  it('redoWithFeedback is a no-op (no toast) when there is nothing to redo', () => {
    expect(useDomainStore.temporal.getState().futureStates.length).toBe(0);
    redoWithFeedback();
    expect(useViewStore.getState().notifications).toEqual([]);
  });

  it('a representative sample of actions self-label via lastIntent', () => {
    // Phase 37 Slice 3 — spot-check the labelling discipline by running
    // a handful of unrelated actions and asserting the resulting toast
    // text. Catches regressions where an action's set() forgets to
    // include `lastIntent`.
    const cases: Array<{ run: () => void; expected: string }> = [
      {
        run: () => useDomainStore.getState().addNode({ x: 0, y: 0 }),
        expected: 'Undone: Added activity',
      },
      {
        run: () => useDomainStore.getState().addDecisionNode({ x: 0, y: 0 }),
        expected: 'Undone: Added decision',
      },
      {
        run: () => useDomainStore.getState().addStartNode({ x: 0, y: 0 }),
        expected: 'Undone: Added start',
      },
      {
        run: () => useDomainStore.getState().addEndNode({ x: 0, y: 0 }),
        expected: 'Undone: Added end',
      },
      {
        run: () => useDomainStore.getState().updateProjectName('Test Project'),
        expected: 'Undone: Renamed project',
      },
      {
        run: () =>
          useDomainStore
            .getState()
            .applyCalendarTemplate(
              useDomainStore.getState().project.project.defaultCalendarId,
              'msat-8h',
            ),
        expected: "Undone: Applied schedule 'M–Sat 8h'",
      },
      {
        run: () =>
          useDomainStore
            .getState()
            .updateCalendarHolidayPreset(
              useDomainStore.getState().project.project.defaultCalendarId,
              'JAPAN_NATIONAL',
            ),
        expected: 'Undone: Changed holidays',
      },
    ];

    for (const { run, expected } of cases) {
      resetStore();
      useViewStore.getState().clearAllToasts();
      run();
      undoWithFeedback();
      const toasts = useViewStore.getState().notifications;
      expect(toasts[0]?.text, `expected toast '${expected}' after action`).toBe(expected);
    }
  });

  it('commitEdit pushes a snapshot that includes lastIntent (undo restores both)', () => {
    // Edit-session discipline: any text-input edit goes through
    // beginEdit/commitEdit, which snapshots the BEFORE-state including
    // lastIntent. Undo of an edit session must roll back both project AND
    // the intent label, otherwise the toast text drifts.
    const initialIntent = useDomainStore.getState().lastIntent;
    expect(initialIntent).toBeNull();

    beginEdit();
    // Simulate a labelled mid-edit mutation (Slice 3 will produce these
    // from `updateNodeName` and friends).
    useDomainStore.setState((s) => ({
      ...s,
      lastIntent: 'Renamed node',
      project: {
        ...s.project,
        nodes: s.project.nodes.map((n, i) => (i === 0 ? { ...n, name: 'TempName' } : n)),
      },
    }));
    commitEdit();

    // After commit, the temporal stack should have one push and lastIntent
    // should remain 'Renamed node'.
    expect(useDomainStore.temporal.getState().pastStates.length).toBe(1);
    expect(useDomainStore.getState().lastIntent).toBe('Renamed node');

    // Undo must restore both fields together.
    useDomainStore.temporal.getState().undo();
    expect(useDomainStore.getState().lastIntent).toBe(initialIntent);
  });
});

// ── Phase 40 — durationSemantic actions + calendar-swap toast ────────────────

describe('domainStore — Phase 40 durationSemantic', () => {
  beforeEach(() => {
    resetStore();
    useViewStore.getState().clearAllToasts();
  });

  it('addNode creates an effort-based activity (smart default)', () => {
    useDomainStore.getState().addNode({ x: 0, y: 0 });
    const created = useDomainStore.getState().project.nodes.at(-1)!;
    expect(created.nodeType).toBe('activity');
    expect(created.durationSemantic).toBe('effort');
  });

  it('addDecisionNode creates a time-based decision (smart default)', () => {
    useDomainStore.getState().addDecisionNode({ x: 0, y: 0 });
    const created = useDomainStore.getState().project.nodes.at(-1)!;
    expect(created.nodeType).toBe('decision');
    expect(created.durationSemantic).toBe('time');
  });

  it('addStartNode / addEndNode stay time-based (anchors are zero-duration; semantic is moot)', () => {
    useDomainStore.getState().addStartNode({ x: 0, y: 0 });
    useDomainStore.getState().addEndNode({ x: 0, y: 0 });
    const nodes = useDomainStore.getState().project.nodes;
    const start = nodes.find((n) => n.nodeType === 'start')!;
    const end = nodes.find((n) => n.nodeType === 'end')!;
    expect(start.durationSemantic).toBe('time');
    expect(end.durationSemantic).toBe('time');
  });

  it('updateNodeDurationSemantic time → effort preserves underlying hours; value rebases on canonical 8h/day', () => {
    // Seed: a time-based activity, 5 days, on the project's default (8h/day) calendar.
    useDomainStore.getState().addNode({ x: 0, y: 0 });
    const created = useDomainStore.getState().project.nodes.at(-1)!;
    useDomainStore.getState().updateNodeDurationSemantic(created.id, 'time');
    useDomainStore.getState().updateNodeDuration(created.id, 5, 'days');

    // Sanity: 5 days × 8h/day = 40 hours under both semantics on this calendar.
    // Flipping to effort with same unit must produce a value that *also* gives 40h
    // under canonical 8h/day — i.e. still 5 days.
    useDomainStore.getState().updateNodeDurationSemantic(created.id, 'effort');
    const after = useDomainStore.getState().project.nodes.find((n) => n.id === created.id)!;
    expect(after.durationSemantic).toBe('effort');
    expect(after.duration.unit).toBe('days');
    expect(after.duration.value).toBeCloseTo(5, 10);
  });

  it('updateNodeDurationSemantic on a non-default-8h calendar rebases the value across the flip', () => {
    // Build a 12h/day calendar (e.g. 996-ish) and assign an activity to it.
    useDomainStore.setState((s) => ({
      ...s,
      project: {
        ...s.project,
        calendars: [
          ...s.project.calendars,
          {
            id: 'cal-intense',
            name: '12h/day',
            workingDays: [true, true, true, true, true, true, true],
            hoursPerDay: 12,
            daysPerWeek: 6,
            holidayPreset: 'NONE',
            holidayPresetVersion: '1.0',
            exceptions: [],
          },
        ],
      },
    }));
    useDomainStore.getState().addNode({ x: 0, y: 0 });
    const created = useDomainStore.getState().project.nodes.at(-1)!;
    useDomainStore.getState().updateNodeCalendarId(created.id, 'cal-intense');
    useDomainStore.getState().updateNodeDurationSemantic(created.id, 'time');
    useDomainStore.getState().updateNodeDuration(created.id, 5, 'days');

    // Time-based 5 days on 12h/day = 60h. Flipping to effort must preserve 60h.
    // canonical: 1 effort-day = 8h, so 60h = 7.5 effort-days.
    useDomainStore.getState().updateNodeDurationSemantic(created.id, 'effort');
    const afterEffort = useDomainStore.getState().project.nodes.find((n) => n.id === created.id)!;
    expect(afterEffort.durationSemantic).toBe('effort');
    expect(afterEffort.duration.unit).toBe('days');
    expect(afterEffort.duration.value).toBeCloseTo(7.5, 10);

    // Flipping back to time on the same 12h calendar must round-trip to 5 days.
    useDomainStore.getState().updateNodeDurationSemantic(created.id, 'time');
    const afterTime = useDomainStore.getState().project.nodes.find((n) => n.id === created.id)!;
    expect(afterTime.durationSemantic).toBe('time');
    expect(afterTime.duration.unit).toBe('days');
    expect(afterTime.duration.value).toBeCloseTo(5, 10);
  });

  it('updateNodeDurationSemantic also converts failureDelay on decision nodes', () => {
    useDomainStore.getState().addDecisionNode({ x: 0, y: 0 });
    const created = useDomainStore.getState().project.nodes.at(-1)!;
    useDomainStore.getState().updateNodeFailureDelay(created.id, { value: 2, unit: 'days' });
    useDomainStore.getState().updateNodeDurationSemantic(created.id, 'time'); // explicit
    // Now flip the decision to effort on the default 8h/day calendar.
    // 2 time-days × 8h = 16h ; canonical effort-days = 16/8 = 2. No change in value.
    useDomainStore.getState().updateNodeDurationSemantic(created.id, 'effort');
    const after = useDomainStore.getState().project.nodes.find((n) => n.id === created.id)!;
    expect(after.failureDelay?.unit).toBe('days');
    expect(after.failureDelay?.value).toBeCloseTo(2, 10);
  });

  it('updateNodeDurationSemantic is no-op (no history push) when semantic is unchanged', () => {
    useDomainStore.getState().addNode({ x: 0, y: 0 });
    const created = useDomainStore.getState().project.nodes.at(-1)!;
    const pastBefore = useDomainStore.temporal.getState().pastStates.length;
    // addNode already set semantic to 'effort'; setting it again should be a no-op.
    useDomainStore.getState().updateNodeDurationSemantic(created.id, 'effort');
    const pastAfter = useDomainStore.temporal.getState().pastStates.length;
    expect(pastAfter).toBe(pastBefore);
  });

  it('switching default calendar warns when calendar-sensitive time-based nodes inherit it', () => {
    // Add a 12h/day calendar and a time-based, days-unit activity that uses
    // the project default. This is the node that will silently inflate.
    useDomainStore.setState((s) => ({
      ...s,
      project: {
        ...s.project,
        calendars: [
          ...s.project.calendars,
          {
            id: 'cal-12h',
            name: '12h/day',
            workingDays: [true, true, true, true, true, true, true],
            hoursPerDay: 12,
            daysPerWeek: 6,
            holidayPreset: 'NONE',
            holidayPresetVersion: '1.0',
            exceptions: [],
          },
        ],
      },
    }));
    useDomainStore.getState().addNode({ x: 0, y: 0 });
    const n = useDomainStore.getState().project.nodes.at(-1)!;
    useDomainStore.getState().updateNodeDurationSemantic(n.id, 'time');
    useDomainStore.getState().updateNodeDuration(n.id, 5, 'days');

    useViewStore.getState().clearAllToasts();
    useDomainStore.getState().updateProjectDefaultCalendarId('cal-12h');

    const toasts = useViewStore.getState().notifications;
    expect(toasts.length).toBe(1);
    expect(toasts[0]?.kind).toBe('warn');
    expect(toasts[0]?.text).toContain('1 time-based node');
    expect(toasts[0]?.text).toContain('12h/day');
  });

  it('switching default calendar is silent when no time-based node would scale', () => {
    // Same calendar swap, but the only activity is effort-based — should NOT
    // produce a warn toast.
    useDomainStore.setState((s) => ({
      ...s,
      project: {
        ...s.project,
        calendars: [
          ...s.project.calendars,
          {
            id: 'cal-12h',
            name: '12h/day',
            workingDays: [true, true, true, true, true, true, true],
            hoursPerDay: 12,
            daysPerWeek: 6,
            holidayPreset: 'NONE',
            holidayPresetVersion: '1.0',
            exceptions: [],
          },
        ],
      },
    }));
    useDomainStore.getState().addNode({ x: 0, y: 0 });
    const n = useDomainStore.getState().project.nodes.at(-1)!;
    expect(n.durationSemantic).toBe('effort'); // smart default

    useViewStore.getState().clearAllToasts();
    useDomainStore.getState().updateProjectDefaultCalendarId('cal-12h');
    const toasts = useViewStore.getState().notifications;
    expect(toasts.filter((t) => t.kind === 'warn').length).toBe(0);
  });

  it('applying a schedule template to an in-use calendar warns when time-based nodes are bound to it', () => {
    // Hermetic setup: prior tests in this block can mutate the project's
    // default calendar, so we don't rely on the seed. Instead we inject a
    // fresh 8h/5d calendar, bind a time-based node directly to it, and
    // apply the '996' template (12h/6d) — the shape change is unambiguous.
    useDomainStore.setState((s) => ({
      ...s,
      project: {
        ...s.project,
        calendars: [
          ...s.project.calendars,
          {
            id: 'cal-toast-victim',
            name: 'Standard',
            workingDays: [false, true, true, true, true, true, false],
            hoursPerDay: 8,
            daysPerWeek: 5,
            holidayPreset: 'NONE',
            holidayPresetVersion: '1.0',
            exceptions: [],
          },
        ],
      },
    }));
    useDomainStore.getState().addNode({ x: 0, y: 0 });
    const n = useDomainStore.getState().project.nodes.at(-1)!;
    useDomainStore.getState().updateNodeCalendarId(n.id, 'cal-toast-victim');
    useDomainStore.getState().updateNodeDurationSemantic(n.id, 'time');
    useDomainStore.getState().updateNodeDuration(n.id, 1, 'weeks');

    useViewStore.getState().clearAllToasts();
    useDomainStore.getState().applyCalendarTemplate('cal-toast-victim', '996');

    const toasts = useViewStore.getState().notifications;
    const warnings = toasts.filter((t) => t.kind === 'warn');
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.text).toContain('time-based node');
  });
});

// ── Phase 41 Slice 1 — setNodeCalendarFromTemplate ────────────────────────────

describe('domainStore — Phase 41 setNodeCalendarFromTemplate', () => {
  beforeEach(() => {
    // Full project reset to the seed default — earlier describe blocks add
    // their own calendars (e.g. cal-12h, cal-toast-victim with a 996 shape
    // after applyCalendarTemplate), which would silently make the
    // "materialise" tests reuse-instead-of-create. Force a clean slate.
    abortEdit();
    useDomainStore.temporal.getState().clear();
    useDomainStore.setState({ project: makeDefaultProject(), lastIntent: null });
    useDomainStore.temporal.getState().clear();
  });

  it('materialises a new calendar on first pick and assigns it to the node', () => {
    useDomainStore.getState().addNode({ x: 0, y: 0 });
    const node = useDomainStore.getState().project.nodes.at(-1)!;
    const calendarsBefore = useDomainStore.getState().project.calendars.length;

    useDomainStore.getState().setNodeCalendarFromTemplate(node.id, '996');

    const after = useDomainStore.getState().project;
    expect(after.calendars.length).toBe(calendarsBefore + 1);
    const newCal = after.calendars.at(-1)!;
    expect(newCal.hoursPerDay).toBe(12);
    expect(newCal.daysPerWeek).toBe(6);
    expect(newCal.holidayPreset).toBe('NONE');
    expect(newCal.exceptions).toEqual([]);
    expect(newCal.name).toBe('996 (M–Sat 12h)');
    // The node now references the new calendar by id.
    const updated = after.nodes.find((n) => n.id === node.id)!;
    expect(updated.calendarId).toBe(newCal.id);
  });

  it('reuses a shape-matching calendar instead of creating a duplicate', () => {
    // Pick the same template on two different nodes — should produce one
    // materialised calendar that both nodes share.
    useDomainStore.getState().addNode({ x: 0, y: 0 });
    const n1 = useDomainStore.getState().project.nodes.at(-1)!;
    useDomainStore.getState().setNodeCalendarFromTemplate(n1.id, '996');
    const calsAfterFirst = useDomainStore.getState().project.calendars.length;

    useDomainStore.getState().addNode({ x: 0, y: 0 });
    const n2 = useDomainStore.getState().project.nodes.at(-1)!;
    useDomainStore.getState().setNodeCalendarFromTemplate(n2.id, '996');

    const after = useDomainStore.getState().project;
    // Calendar count is unchanged from the first materialisation — the
    // second pick re-used the existing entry.
    expect(after.calendars.length).toBe(calsAfterFirst);
    const updated1 = after.nodes.find((n) => n.id === n1.id)!;
    const updated2 = after.nodes.find((n) => n.id === n2.id)!;
    expect(updated1.calendarId).toBe(updated2.calendarId);
  });

  it('reuses an existing project calendar when its shape already matches the template', () => {
    // The seed project ships with a Mon–Fri 8h calendar — picking the
    // 'mf-8h' template (Standard M–F 8h) should reuse it, not create a new
    // one named 'Standard M–F 8h'.
    const calsBefore = useDomainStore.getState().project.calendars.length;
    const existing = useDomainStore
      .getState()
      .project.calendars.find((c) => c.hoursPerDay === 8 && c.daysPerWeek === 5)!;
    expect(existing).toBeDefined();

    useDomainStore.getState().addNode({ x: 0, y: 0 });
    const node = useDomainStore.getState().project.nodes.at(-1)!;
    useDomainStore.getState().setNodeCalendarFromTemplate(node.id, 'mf-8h');

    const after = useDomainStore.getState().project;
    expect(after.calendars.length).toBe(calsBefore);
    const updated = after.nodes.find((n) => n.id === node.id)!;
    expect(updated.calendarId).toBe(existing.id);
  });

  it('is a no-op when the template id is unknown', () => {
    useDomainStore.getState().addNode({ x: 0, y: 0 });
    const node = useDomainStore.getState().project.nodes.at(-1)!;
    const before = useDomainStore.getState().project;

    useDomainStore.getState().setNodeCalendarFromTemplate(node.id, 'not-a-template');

    const after = useDomainStore.getState().project;
    expect(after.calendars.length).toBe(before.calendars.length);
    const updated = after.nodes.find((n) => n.id === node.id)!;
    expect(updated.calendarId).toBeNull();
  });

  it('updateNodeCalendarId(null) clears a template-assigned override; the calendar entry stays on the project', () => {
    // Materialise a calendar, then drop the override. The calendar should
    // stay in `project.calendars` (orphan-cleanup is a separate concern;
    // the user may want to re-use it elsewhere).
    useDomainStore.getState().addNode({ x: 0, y: 0 });
    const node = useDomainStore.getState().project.nodes.at(-1)!;
    useDomainStore.getState().setNodeCalendarFromTemplate(node.id, '996');
    const calsAfterMaterialise = useDomainStore.getState().project.calendars.length;

    useDomainStore.getState().updateNodeCalendarId(node.id, null);

    const after = useDomainStore.getState().project;
    expect(after.calendars.length).toBe(calsAfterMaterialise);
    const updated = after.nodes.find((n) => n.id === node.id)!;
    expect(updated.calendarId).toBeNull();
  });

  it('the action is one undoable history entry; undo restores both the node and any newly added calendar', () => {
    useDomainStore.getState().addNode({ x: 0, y: 0 });
    const node = useDomainStore.getState().project.nodes.at(-1)!;
    const calsBefore = useDomainStore.getState().project.calendars.length;
    const pastBefore = useDomainStore.temporal.getState().pastStates.length;

    useDomainStore.getState().setNodeCalendarFromTemplate(node.id, '996');
    expect(useDomainStore.temporal.getState().pastStates.length).toBe(pastBefore + 1);
    expect(useDomainStore.getState().project.calendars.length).toBe(calsBefore + 1);

    useDomainStore.temporal.getState().undo();
    expect(useDomainStore.getState().project.calendars.length).toBe(calsBefore);
    const restored = useDomainStore.getState().project.nodes.find((n) => n.id === node.id)!;
    expect(restored.calendarId).toBeNull();
  });
});

// ── Phase 42 — updateProjectShareMode conversion ─────────────────────────────

describe('domainStore — Phase 42 updateProjectShareMode', () => {
  beforeEach(() => {
    abortEdit();
    useDomainStore.temporal.getState().clear();
    useDomainStore.setState({ project: makeDefaultProject(), lastIntent: null });
    useDomainStore.temporal.getState().clear();
  });

  it('is a no-op when target mode equals current mode', () => {
    const before = useDomainStore.temporal.getState().pastStates.length;
    useDomainStore.getState().updateProjectShareMode('percentage');
    const after = useDomainStore.temporal.getState().pastStates.length;
    expect(after).toBe(before);
  });

  it('percentage → weight is identity for the share values', () => {
    // Seed a node with percentage shares [40, 60].
    useDomainStore.setState((s) => ({
      ...s,
      project: {
        ...s.project,
        nodes: s.project.nodes.map((n, i) =>
          i === 0
            ? {
                ...n,
                resourceAssignments: [
                  { resourceId: 'r1', count: 1, calendarPolicy: 'intersection', share: 40 },
                  { resourceId: 'r2', count: 1, calendarPolicy: 'intersection', share: 60 },
                ],
              }
            : n,
        ),
      },
    }));

    useDomainStore.getState().updateProjectShareMode('weight');

    const p = useDomainStore.getState().project;
    expect(p.project.shareMode).toBe('weight');
    const asgns = p.nodes[0]!.resourceAssignments;
    expect(asgns[0]!.share).toBe(40);
    expect(asgns[1]!.share).toBe(60);
  });

  it('weight → percentage normalises to integer percentages summing to 100', () => {
    // Seed weights [3, 7] → expect [30, 70] post-conversion.
    useDomainStore.setState((s) => ({
      ...s,
      project: {
        ...s.project,
        project: { ...s.project.project, shareMode: 'weight' },
        nodes: s.project.nodes.map((n, i) =>
          i === 0
            ? {
                ...n,
                resourceAssignments: [
                  { resourceId: 'r1', count: 1, calendarPolicy: 'intersection', share: 3 },
                  { resourceId: 'r2', count: 1, calendarPolicy: 'intersection', share: 7 },
                ],
              }
            : n,
        ),
      },
    }));

    useDomainStore.getState().updateProjectShareMode('percentage');

    const p = useDomainStore.getState().project;
    expect(p.project.shareMode).toBe('percentage');
    const asgns = p.nodes[0]!.resourceAssignments;
    expect(asgns[0]!.share).toBe(30);
    expect(asgns[1]!.share).toBe(70);
    expect((asgns[0]!.share ?? 0) + (asgns[1]!.share ?? 0)).toBe(100);
  });

  it('weight → percentage absorbs rounding remainder to keep sum = 100', () => {
    // Weights [1, 1, 1] would naively round to [33, 33, 33] = 99; the
    // remainder is distributed so the sum equals 100 exactly.
    useDomainStore.setState((s) => ({
      ...s,
      project: {
        ...s.project,
        project: { ...s.project.project, shareMode: 'weight' },
        nodes: s.project.nodes.map((n, i) =>
          i === 0
            ? {
                ...n,
                resourceAssignments: [
                  { resourceId: 'r1', count: 1, calendarPolicy: 'intersection', share: 1 },
                  { resourceId: 'r2', count: 1, calendarPolicy: 'intersection', share: 1 },
                  { resourceId: 'r3', count: 1, calendarPolicy: 'intersection', share: 1 },
                ],
              }
            : n,
        ),
      },
    }));

    useDomainStore.getState().updateProjectShareMode('percentage');

    const p = useDomainStore.getState().project;
    const shares = p.nodes[0]!.resourceAssignments.map((a) => a.share ?? 0);
    expect(shares.reduce((s, v) => s + v, 0)).toBe(100);
  });

  it('leaves nodes without shares alone during conversion', () => {
    // A node with no shares stays as-is regardless of which mode we
    // switch to — there's nothing to convert.
    useDomainStore.setState((s) => ({
      ...s,
      project: {
        ...s.project,
        nodes: s.project.nodes.map((n, i) =>
          i === 0
            ? {
                ...n,
                resourceAssignments: [
                  { resourceId: 'r1', count: 1, calendarPolicy: 'intersection' },
                  { resourceId: 'r2', count: 1, calendarPolicy: 'intersection' },
                ],
              }
            : n,
        ),
      },
    }));

    useDomainStore.getState().updateProjectShareMode('weight');

    const asgns = useDomainStore.getState().project.nodes[0]!.resourceAssignments;
    expect(asgns[0]!.share).toBeUndefined();
    expect(asgns[1]!.share).toBeUndefined();
  });

  it('the action is one undoable history entry; undo restores both the mode and the prior shares', () => {
    useDomainStore.setState((s) => ({
      ...s,
      project: {
        ...s.project,
        project: { ...s.project.project, shareMode: 'weight' },
        nodes: s.project.nodes.map((n, i) =>
          i === 0
            ? {
                ...n,
                resourceAssignments: [
                  { resourceId: 'r1', count: 1, calendarPolicy: 'intersection', share: 3 },
                  { resourceId: 'r2', count: 1, calendarPolicy: 'intersection', share: 7 },
                ],
              }
            : n,
        ),
      },
    }));
    useDomainStore.temporal.getState().clear();

    useDomainStore.getState().updateProjectShareMode('percentage');
    expect(useDomainStore.temporal.getState().pastStates.length).toBe(1);
    expect(useDomainStore.getState().project.project.shareMode).toBe('percentage');

    useDomainStore.temporal.getState().undo();
    const after = useDomainStore.getState().project;
    expect(after.project.shareMode).toBe('weight');
    expect(after.nodes[0]!.resourceAssignments[0]!.share).toBe(3);
    expect(after.nodes[0]!.resourceAssignments[1]!.share).toBe(7);
  });
});

// ── Phase 42 Slice 2 — share-edit actions + add/remove rebalance ─────────────

describe('domainStore — Phase 42 Slice 2 share-edit actions', () => {
  let testNodeId: string;
  let testResources: string[];

  beforeEach(() => {
    abortEdit();
    useDomainStore.temporal.getState().clear();
    useDomainStore.setState({ project: makeDefaultProject(), lastIntent: null });

    // Seed: add three resources and a single activity with all three assigned.
    useDomainStore.getState().addResource({
      name: 'R1',
      capacity: 1,
      workingDays: [true, true, true, true, true, false, false],
      hoursPerDay: 8,
    });
    useDomainStore.getState().addResource({
      name: 'R2',
      capacity: 1,
      workingDays: [true, true, true, true, true, false, false],
      hoursPerDay: 8,
    });
    useDomainStore.getState().addResource({
      name: 'R3',
      capacity: 1,
      workingDays: [true, true, true, true, true, false, false],
      hoursPerDay: 8,
    });
    testResources = useDomainStore
      .getState()
      .project.resources.slice(-3)
      .map((r) => r.id);
    useDomainStore.getState().addNode({ x: 0, y: 0 });
    testNodeId = useDomainStore.getState().project.nodes.at(-1)!.id;
    for (const rid of testResources) {
      useDomainStore.getState().addResourceAssignment(testNodeId, {
        resourceId: rid,
        count: 1,
        calendarPolicy: 'intersection',
      });
    }
    useDomainStore.temporal.getState().clear();
  });

  function getAssignments() {
    return useDomainStore.getState().project.nodes.find((n) => n.id === testNodeId)!
      .resourceAssignments;
  }

  describe('initialiseEqualShares', () => {
    it('seeds [33, 33, 34] (sum=100) on three pools in percentage mode', () => {
      useDomainStore.getState().initialiseEqualShares(testNodeId);
      const shares = getAssignments().map((a) => a.share);
      expect(shares.every((s) => s !== undefined)).toBe(true);
      expect((shares as number[]).reduce((s, v) => s + v, 0)).toBe(100);
    });

    it('seeds [1, 1, 1] in weight mode', () => {
      useDomainStore.getState().updateProjectShareMode('weight');
      useDomainStore.getState().initialiseEqualShares(testNodeId);
      const shares = getAssignments().map((a) => a.share);
      expect(shares).toEqual([1, 1, 1]);
    });

    it('is a no-op when every assignment already has a share', () => {
      useDomainStore.getState().initialiseEqualShares(testNodeId);
      const past = useDomainStore.temporal.getState().pastStates.length;
      useDomainStore.getState().initialiseEqualShares(testNodeId);
      expect(useDomainStore.temporal.getState().pastStates.length).toBe(past);
    });
  });

  describe('clearAllShares', () => {
    it('drops share from every assignment, returning to legacy mode', () => {
      useDomainStore.getState().initialiseEqualShares(testNodeId);
      useDomainStore.getState().clearAllShares(testNodeId);
      const shares = getAssignments().map((a) => a.share);
      expect(shares.every((s) => s === undefined)).toBe(true);
    });

    it('is a no-op when no assignment has a share', () => {
      const past = useDomainStore.temporal.getState().pastStates.length;
      useDomainStore.getState().clearAllShares(testNodeId);
      expect(useDomainStore.temporal.getState().pastStates.length).toBe(past);
    });
  });

  describe('setAssignmentShare', () => {
    it('updates the named pool without auto-rebalancing peers', () => {
      useDomainStore.getState().initialiseEqualShares(testNodeId);
      const seeded = getAssignments().map((a) => a.share) as number[];
      // Pool 0 → 60. Pools 1 and 2 untouched (whatever the seeded values
      // were; rounding-remainder distribution may give [34, 33, 33] or
      // [33, 33, 34] depending on tie-breaks, so we read the seed values).
      useDomainStore.getState().setAssignmentShare(testNodeId, testResources[0]!, 60);
      const shares = getAssignments().map((a) => a.share);
      expect(shares[0]).toBe(60);
      // Peers carry their seed value untouched (no auto-rebalance on edit).
      expect(shares[1]).toBe(seeded[1]);
      expect(shares[2]).toBe(seeded[2]);
      // Sum is intentionally off-100; the inspector flags it.
      const sum = (shares as number[]).reduce((s, v) => s + v, 0);
      expect(sum).toBe(60 + seeded[1]! + seeded[2]!);
      expect(sum).not.toBe(100);
    });

    it('silently rejects negative or non-finite values', () => {
      useDomainStore.getState().initialiseEqualShares(testNodeId);
      const before = getAssignments().map((a) => a.share);
      useDomainStore.getState().setAssignmentShare(testNodeId, testResources[0]!, -5);
      useDomainStore.getState().setAssignmentShare(testNodeId, testResources[0]!, NaN);
      const after = getAssignments().map((a) => a.share);
      expect(after).toEqual(before);
    });

    // ── 2-pool auto-rebalance (PR #113 follow-up) ────────────────────────────

    it('auto-rebalances the peer in a 2-pool percentage-mode activity', () => {
      // Drop to two pools so the 2-pool case applies.
      useDomainStore.getState().removeResourceAssignment(testNodeId, testResources[2]!);
      useDomainStore.getState().initialiseEqualShares(testNodeId);
      // Edit pool 0 → 10. Peer should auto-set to 90; sum stays 100.
      useDomainStore.getState().setAssignmentShare(testNodeId, testResources[0]!, 10);
      const shares = getAssignments().map((a) => a.share) as number[];
      expect(shares[0]).toBe(10);
      expect(shares[1]).toBe(90);
      expect(shares.reduce((s, v) => s + v, 0)).toBe(100);
    });

    it('clamps the user value to 100 and zeroes the peer when the input exceeds 100', () => {
      useDomainStore.getState().removeResourceAssignment(testNodeId, testResources[2]!);
      useDomainStore.getState().initialiseEqualShares(testNodeId);
      useDomainStore.getState().setAssignmentShare(testNodeId, testResources[0]!, 150);
      const shares = getAssignments().map((a) => a.share) as number[];
      expect(shares[0]).toBe(100);
      expect(shares[1]).toBe(0);
    });

    it('does NOT auto-rebalance peers in a 3-pool activity (under-determined)', () => {
      useDomainStore.getState().initialiseEqualShares(testNodeId);
      const seeded = getAssignments().map((a) => a.share) as number[];
      useDomainStore.getState().setAssignmentShare(testNodeId, testResources[0]!, 60);
      const shares = getAssignments().map((a) => a.share) as number[];
      expect(shares[0]).toBe(60);
      expect(shares[1]).toBe(seeded[1]);
      expect(shares[2]).toBe(seeded[2]);
    });

    it('does NOT auto-rebalance in weight mode even on a 2-pool activity', () => {
      useDomainStore.getState().updateProjectShareMode('weight');
      useDomainStore.getState().removeResourceAssignment(testNodeId, testResources[2]!);
      useDomainStore.getState().initialiseEqualShares(testNodeId);
      // weights [1, 1]; setting pool 0 to 5 leaves pool 1 at 1.
      useDomainStore.getState().setAssignmentShare(testNodeId, testResources[0]!, 5);
      const shares = getAssignments().map((a) => a.share);
      expect(shares).toEqual([5, 1]);
    });
  });

  describe('distributeSharesEvenly', () => {
    it('resets every assignment to an equal share even when shares are set', () => {
      useDomainStore.getState().initialiseEqualShares(testNodeId);
      useDomainStore.getState().setAssignmentShare(testNodeId, testResources[0]!, 80);
      useDomainStore.getState().distributeSharesEvenly(testNodeId);
      const shares = getAssignments().map((a) => a.share);
      expect((shares as number[]).reduce((s, v) => s + v, 0)).toBe(100);
      // All three entries within 1 of each other (rounding-remainder bias).
      const max = Math.max(...(shares as number[]));
      const min = Math.min(...(shares as number[]));
      expect(max - min).toBeLessThanOrEqual(1);
    });
  });

  describe('addResourceAssignment — rebalance on add', () => {
    it('rebalances existing percentage shares when a new pool is added', () => {
      // Seed [50, 25, 25]. Remove R3 so we're at two pools [50, 25] that
      // sum to 75 — but the rebalance-on-remove also fires. Easier:
      // start fresh with two pools, set shares, then add a third.
      useDomainStore.getState().clearAllShares(testNodeId);
      useDomainStore.getState().removeResourceAssignment(testNodeId, testResources[2]!);
      useDomainStore.getState().initialiseEqualShares(testNodeId);
      // Two-pool seed: [50, 50]. Add a fourth resource to add as third pool.
      useDomainStore.getState().addResource({
        name: 'R4',
        capacity: 1,
        workingDays: [true, true, true, true, true, false, false],
        hoursPerDay: 8,
      });
      const r4 = useDomainStore.getState().project.resources.at(-1)!.id;
      useDomainStore.getState().addResourceAssignment(testNodeId, {
        resourceId: r4,
        count: 1,
        calendarPolicy: 'intersection',
      });
      const shares = getAssignments().map((a) => a.share);
      expect(shares.every((s) => s !== undefined)).toBe(true);
      // Sum after rebalance must be exactly 100.
      expect((shares as number[]).reduce((s, v) => s + v, 0)).toBe(100);
    });

    it('weight-mode add seeds the new entry with weight 1 and leaves peers untouched', () => {
      useDomainStore.getState().updateProjectShareMode('weight');
      useDomainStore.getState().initialiseEqualShares(testNodeId);
      // Existing weights are [1, 1, 1]. Add a new pool — it gets 1; others unchanged.
      useDomainStore.getState().addResource({
        name: 'R5',
        capacity: 1,
        workingDays: [true, true, true, true, true, false, false],
        hoursPerDay: 8,
      });
      const r5 = useDomainStore.getState().project.resources.at(-1)!.id;
      useDomainStore.getState().addResourceAssignment(testNodeId, {
        resourceId: r5,
        count: 1,
        calendarPolicy: 'intersection',
      });
      const shares = getAssignments().map((a) => a.share);
      expect(shares).toEqual([1, 1, 1, 1]);
    });

    it('add into a legacy-mode (no-shares) activity does not introduce shares', () => {
      // Default state has no shares set. Add a fourth pool.
      useDomainStore.getState().addResource({
        name: 'R6',
        capacity: 1,
        workingDays: [true, true, true, true, true, false, false],
        hoursPerDay: 8,
      });
      const r6 = useDomainStore.getState().project.resources.at(-1)!.id;
      useDomainStore.getState().addResourceAssignment(testNodeId, {
        resourceId: r6,
        count: 1,
        calendarPolicy: 'intersection',
      });
      const shares = getAssignments().map((a) => a.share);
      expect(shares.every((s) => s === undefined)).toBe(true);
    });
  });

  describe('removeResourceAssignment — rebalance on remove', () => {
    it('redistributes the freed share across remaining pools in percentage mode', () => {
      useDomainStore.getState().initialiseEqualShares(testNodeId);
      // Seed [33, 33, 34]. Remove the middle pool.
      useDomainStore.getState().removeResourceAssignment(testNodeId, testResources[1]!);
      const shares = getAssignments().map((a) => a.share);
      expect(shares.length).toBe(2);
      // Both remaining shares are defined and sum to exactly 100.
      expect(shares.every((s) => s !== undefined)).toBe(true);
      expect((shares as number[]).reduce((s, v) => s + v, 0)).toBe(100);
    });

    it('weight-mode remove leaves remaining weights untouched', () => {
      useDomainStore.getState().updateProjectShareMode('weight');
      useDomainStore.getState().initialiseEqualShares(testNodeId);
      useDomainStore.getState().setAssignmentShare(testNodeId, testResources[0]!, 5);
      useDomainStore.getState().setAssignmentShare(testNodeId, testResources[1]!, 3);
      // weights [5, 3, 1] — remove the last (weight 1).
      useDomainStore.getState().removeResourceAssignment(testNodeId, testResources[2]!);
      const shares = getAssignments().map((a) => a.share);
      expect(shares).toEqual([5, 3]);
    });

    it('remove from a legacy-mode activity is unchanged from pre-Phase-42 behaviour', () => {
      // No shares; just verify that removal doesn't introduce them.
      useDomainStore.getState().removeResourceAssignment(testNodeId, testResources[1]!);
      const shares = getAssignments().map((a) => a.share);
      expect(shares.every((s) => s === undefined)).toBe(true);
      expect(shares.length).toBe(2);
    });
  });
});

describe('domainStore — Phase 49 Slice 4 addNodeWithIncomingEdges', () => {
  beforeEach(() => {
    resetStore();
  });

  it('empty sourceNodeIds is equivalent to a plain addNode (activity)', () => {
    const beforeNodeCount = useDomainStore.getState().project.nodes.length;
    const beforeEdgeCount = useDomainStore.getState().project.edges.length;
    const id = useDomainStore.getState().addNodeWithIncomingEdges('activity', { x: 10, y: 20 }, []);
    const project = useDomainStore.getState().project;
    expect(project.nodes.length).toBe(beforeNodeCount + 1);
    expect(project.edges.length).toBe(beforeEdgeCount);
    const added = project.nodes.find((n) => n.id === id);
    expect(added?.nodeType).toBe('activity');
    expect(added?.name).toBe('New Activity');
    expect(history().past).toBe(1);
  });

  it('empty sourceNodeIds is equivalent to a plain addDecisionNode', () => {
    const id = useDomainStore.getState().addNodeWithIncomingEdges('decision', { x: 30, y: 40 }, []);
    const added = useDomainStore.getState().project.nodes.find((n) => n.id === id);
    expect(added?.nodeType).toBe('decision');
    expect(added?.name).toBe('Decision');
  });

  it('node + N edges commit as a single undo step', () => {
    // Seed two source nodes first.
    const srcA = useDomainStore.getState().addNode({ x: 0, y: 0 });
    const srcB = useDomainStore.getState().addNode({ x: 100, y: 0 });
    const baselineEdges = useDomainStore.getState().project.edges.length;
    const baselineNodes = useDomainStore.getState().project.nodes.length;
    const baselinePast = history().past;

    const newId = useDomainStore
      .getState()
      .addNodeWithIncomingEdges('activity', { x: 200, y: 0 }, [srcA, srcB]);

    expect(useDomainStore.getState().project.nodes.length).toBe(baselineNodes + 1);
    expect(useDomainStore.getState().project.edges.length).toBe(baselineEdges + 2);
    expect(history().past).toBe(baselinePast + 1);

    // One undo reverts BOTH the node and the edges.
    useDomainStore.temporal.getState().undo();
    expect(useDomainStore.getState().project.nodes.length).toBe(baselineNodes);
    expect(useDomainStore.getState().project.edges.length).toBe(baselineEdges);
    expect(useDomainStore.getState().project.nodes.some((n) => n.id === newId)).toBe(false);
  });

  it('edges have the same shape as connectNodes (FS, lag 0h, target = new id)', () => {
    const src = useDomainStore.getState().addNode({ x: 0, y: 0 });
    const newId = useDomainStore
      .getState()
      .addNodeWithIncomingEdges('decision', { x: 200, y: 0 }, [src]);
    const edge = useDomainStore
      .getState()
      .project.edges.find((e) => e.from === src && e.to === newId);
    expect(edge).toBeDefined();
    expect(edge?.type).toBe('FS');
    expect(edge?.lag.value).toBe(0);
    expect(edge?.lag.unit).toBe('hours');
  });

  it('lastIntent reflects the edge count for the toast', () => {
    const src = useDomainStore.getState().addNode({ x: 0, y: 0 });
    useDomainStore.getState().addNodeWithIncomingEdges('activity', { x: 200, y: 0 }, []);
    expect(useDomainStore.getState().lastIntent).toBe('Added activity');

    useDomainStore.getState().addNodeWithIncomingEdges('activity', { x: 300, y: 0 }, [src]);
    expect(useDomainStore.getState().lastIntent).toBe('Added activity + 1 edge');

    const src2 = useDomainStore.getState().addNode({ x: 0, y: 100 });
    useDomainStore.getState().addNodeWithIncomingEdges('decision', { x: 400, y: 0 }, [src, src2]);
    expect(useDomainStore.getState().lastIntent).toBe('Added decision + 2 edges');
  });
});

// ── Phase 50 Slice 3 — delete hygiene (audit C-4, C-5) ────────────────────────

describe('domainStore — deleteNodes subsystem hygiene (audit C-4)', () => {
  beforeEach(() => {
    // The shared `resetStore()` keeps the *current* project; my tests need
    // a truly fresh `makeDefaultProject()` so subsystems / resources from
    // an earlier spec don't leak in. (Same shape as resetStore otherwise.)
    abortEdit();
    useDomainStore.temporal.getState().clear();
    useDomainStore.setState({ project: makeDefaultProject(), lastIntent: null });
    useDomainStore.temporal.getState().clear();
    useViewStore.getState().clearAllToasts();
  });

  /**
   * Seed a subsystem wrapping user nodes `[a → b → c]`. After 3.5b, wrap
   * auto-injects structural Entry/Exit nodes — they're the subsystem's
   * entry/exit refs (the user nodes are just body members). Returns
   * both natural and structural ids so tests can target either.
   */
  function seedSubsystem(): {
    a: string;
    b: string;
    c: string;
    structuralEntryId: string;
    structuralExitId: string;
    subId: string;
    subName: string;
  } {
    const a = useDomainStore.getState().project.nodes[0]!.id;
    const b = useDomainStore.getState().addNode({ x: 300, y: 150 });
    const c = useDomainStore.getState().addNode({ x: 500, y: 150 });
    useDomainStore.getState().connectNodes(a, b);
    useDomainStore.getState().connectNodes(b, c);

    const err = useDomainStore.getState().wrapSelectedAsSubsystem([a, b, c]);
    expect(err).toBeNull();

    const sub = useDomainStore.getState().project.subsystems[0]!;
    const subName =
      useDomainStore.getState().project.nodes.find((n) => n.id === sub.containerNodeId)?.name ??
      'Sub-system';
    return {
      a,
      b,
      c,
      structuralEntryId: sub.entryNodeId,
      structuralExitId: sub.exitNodeId,
      subId: sub.id,
      subName,
    };
  }

  it('deleting a body node succeeds and strips the id from bodyNodeIds', () => {
    const { a, b, c, structuralEntryId, structuralExitId, subId } = seedSubsystem();
    // V7 — bodyNodeIds is [structuralEntry, a, b, c, structuralExit].
    const subBefore = useDomainStore.getState().project.subsystems.find((s) => s.id === subId)!;
    expect(subBefore.bodyNodeIds).toEqual([structuralEntryId, a, b, c, structuralExitId]);
    expect(subBefore.entryNodeId).toBe(structuralEntryId);
    expect(subBefore.exitNodeId).toBe(structuralExitId);

    // Delete a body-only user node (b is interior, not a structural port).
    useDomainStore.getState().deleteNodes([b]);

    const sub = useDomainStore.getState().project.subsystems.find((s) => s.id === subId)!;
    expect(sub.bodyNodeIds).toEqual([structuralEntryId, a, c, structuralExitId]);
    expect(useDomainStore.getState().project.nodes.find((n) => n.id === b)).toBeUndefined();
    expect(useViewStore.getState().notifications).toHaveLength(0);
  });

  it('deleting the structural entry port refuses the batch and pushes a warn toast', () => {
    const { structuralEntryId, subId, subName } = seedSubsystem();
    const nodesBefore = useDomainStore.getState().project.nodes.length;
    const subBefore = useDomainStore.getState().project.subsystems.find((s) => s.id === subId)!;

    useDomainStore.getState().deleteNodes([structuralEntryId]);

    // State unchanged.
    expect(useDomainStore.getState().project.nodes.length).toBe(nodesBefore);
    expect(useDomainStore.getState().project.subsystems.find((s) => s.id === subId)).toEqual(
      subBefore,
    );

    // Toast names the role ("entry port") and the subsystem.
    const toasts = useViewStore.getState().notifications;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.kind).toBe('warn');
    expect(toasts[0]!.text).toContain('entry port');
    expect(toasts[0]!.text).toContain(subName);
    expect(toasts[0]!.text).toContain('Unwrap');
  });

  it('deleting the structural exit port refuses with role="exit port" in the message', () => {
    const { structuralExitId, subId, subName } = seedSubsystem();
    useDomainStore.getState().deleteNodes([structuralExitId]);

    expect(useDomainStore.getState().project.subsystems.find((s) => s.id === subId)).toBeDefined();
    const toasts = useViewStore.getState().notifications;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.text).toContain('exit port');
    expect(toasts[0]!.text).toContain(subName);
  });

  it('multi-node delete refuses ATOMICALLY when one node is a structural port', () => {
    const { structuralEntryId } = seedSubsystem();
    const orphan = useDomainStore.getState().addNode({ x: 800, y: 150 });
    const nodesBefore = useDomainStore.getState().project.nodes.length;

    useDomainStore.getState().deleteNodes([structuralEntryId, orphan]);

    expect(useDomainStore.getState().project.nodes.length).toBe(nodesBefore);
    expect(useDomainStore.getState().project.nodes.find((n) => n.id === orphan)).toBeDefined();
    expect(useViewStore.getState().notifications).toHaveLength(1);
  });

  it('the post-delete project passes the V7 schema (subsystem invariants intact)', async () => {
    const { b } = seedSubsystem();
    useDomainStore.getState().deleteNodes([b]);

    const { saveProjectFile, loadProjectFile } = await import('@procsim/file-format');
    const serialized = saveProjectFile(useDomainStore.getState().project);
    const result = loadProjectFile(serialized);
    expect(result.ok).toBe(true);
  });
});

describe('domainStore — deleteResource share rebalance (audit C-5)', () => {
  beforeEach(() => {
    // Same full-reset rationale as the C-4 block above — resources / nodes
    // leak between specs if we re-use whatever the previous test left.
    abortEdit();
    useDomainStore.temporal.getState().clear();
    useDomainStore.setState({ project: makeDefaultProject(), lastIntent: null });
    useDomainStore.temporal.getState().clear();
  });

  function addResourceAndGetId(name: string): string {
    useDomainStore.getState().addResource({
      name,
      capacity: 2,
      workingDays: [false, true, true, true, true, true, false],
      hoursPerDay: 8,
    });
    // addResource returns void; the new resource is appended to the array.
    return useDomainStore.getState().project.resources.at(-1)!.id;
  }

  function seedThreeResourceActivity(): {
    activityId: string;
    r1: string;
    r2: string;
    r3: string;
  } {
    const r1 = addResourceAndGetId('Eng A');
    const r2 = addResourceAndGetId('Eng B');
    const r3 = addResourceAndGetId('Eng C');

    const activityId = useDomainStore.getState().project.nodes[0]!.id;
    // Use setNodeResourceAssignments to plant a tested-shape input. The
    // default project is in percentage shareMode (see makeDefaultProject).
    // calendarPolicy is schema-required (see ResourceAssignmentSchema).
    useDomainStore.getState().setNodeResourceAssignments(activityId, [
      { resourceId: r1, count: 1, share: 40, calendarPolicy: 'intersection' },
      { resourceId: r2, count: 1, share: 30, calendarPolicy: 'intersection' },
      { resourceId: r3, count: 1, share: 30, calendarPolicy: 'intersection' },
    ]);
    return { activityId, r1, r2, r3 };
  }

  it('deleting the 40% resource leaves the surviving shares summing to 100', async () => {
    const { activityId, r1 } = seedThreeResourceActivity();
    useDomainStore.getState().deleteResource(r1);

    const node = useDomainStore.getState().project.nodes.find((n) => n.id === activityId)!;
    expect(node.resourceAssignments).toHaveLength(2);
    const sum = node.resourceAssignments.reduce((s, a) => s + (a.share ?? 0), 0);
    expect(sum).toBe(100);

    // The project must also pass schema validation post-delete — the C-5
    // canary that the invariant break is closed.
    const { saveProjectFile, loadProjectFile } = await import('@procsim/file-format');
    const result = loadProjectFile(saveProjectFile(useDomainStore.getState().project));
    expect(result.ok).toBe(true);
  });

  it('does not touch shares on nodes that had no assignment to the deleted resource', () => {
    const { r1, r2 } = seedThreeResourceActivity();
    // Add a second activity with its own (different) assignment to r2 only —
    // deleting r1 should leave this activity untouched.
    const otherId = useDomainStore.getState().addNode({ x: 400, y: 200 });
    useDomainStore
      .getState()
      .setNodeResourceAssignments(otherId, [
        { resourceId: r2, count: 1, share: 100, calendarPolicy: 'intersection' },
      ]);

    useDomainStore.getState().deleteResource(r1);

    const other = useDomainStore.getState().project.nodes.find((n) => n.id === otherId)!;
    expect(other.resourceAssignments).toHaveLength(1);
    expect(other.resourceAssignments[0]!.share).toBe(100);
  });

  it('leaves weight-mode shares untouched (no sum constraint)', () => {
    // Switch to weight mode BEFORE seeding so the default-shape inputs we
    // pass to setNodeResourceAssignments don't trip the percentage-sum
    // refine on the way in.
    useDomainStore.getState().updateProjectShareMode('weight');

    const r1 = addResourceAndGetId('A');
    const r2 = addResourceAndGetId('B');
    const r3 = addResourceAndGetId('C');
    const activityId = useDomainStore.getState().project.nodes[0]!.id;
    useDomainStore.getState().setNodeResourceAssignments(activityId, [
      { resourceId: r1, count: 1, share: 2, calendarPolicy: 'intersection' },
      { resourceId: r2, count: 1, share: 3, calendarPolicy: 'intersection' },
      { resourceId: r3, count: 1, share: 5, calendarPolicy: 'intersection' },
    ]);

    useDomainStore.getState().deleteResource(r1);

    const node = useDomainStore.getState().project.nodes.find((n) => n.id === activityId)!;
    // Surviving weights are unchanged — no rebalance in weight mode.
    expect(node.resourceAssignments.map((a) => a.share)).toEqual([3, 5]);
  });

  it('handles legacy assignments (no shares set) — strip only, no rebalance', () => {
    const r1 = addResourceAndGetId('A');
    const r2 = addResourceAndGetId('B');
    const activityId = useDomainStore.getState().project.nodes[0]!.id;
    // Legacy shape: no `share` field on either assignment.
    useDomainStore.getState().setNodeResourceAssignments(activityId, [
      { resourceId: r1, count: 1, calendarPolicy: 'intersection' },
      { resourceId: r2, count: 1, calendarPolicy: 'intersection' },
    ]);

    useDomainStore.getState().deleteResource(r1);

    const node = useDomainStore.getState().project.nodes.find((n) => n.id === activityId)!;
    expect(node.resourceAssignments).toHaveLength(1);
    expect(node.resourceAssignments[0]!.resourceId).toBe(r2);
    expect(node.resourceAssignments[0]!.share).toBeUndefined();
  });
});

// ── Phase 50 Slice 3 — drill-in add hygiene (audit C-18) ──────────────────────

describe('domainStore — add-actions extend drilled-in subsystem bodyNodeIds (audit C-18)', () => {
  beforeEach(() => {
    abortEdit();
    useDomainStore.temporal.getState().clear();
    useDomainStore.setState({ project: makeDefaultProject(), lastIntent: null });
    useDomainStore.temporal.getState().clear();
    // Reset drill-in state too; otherwise a previous test's `drillIntoSubsystem`
    // leaks into this one and addNode lands in the (now-deleted) old subsystem.
    useViewStore.getState().drillOutTo(-1);
  });

  /** Same 3-node subsystem seed as the C-4 block, but returns the subsystem id too. */
  function seedAndDrillIn(): { a: string; b: string; c: string; subId: string } {
    const a = useDomainStore.getState().project.nodes[0]!.id;
    const b = useDomainStore.getState().addNode({ x: 300, y: 150 });
    const c = useDomainStore.getState().addNode({ x: 500, y: 150 });
    useDomainStore.getState().connectNodes(a, b);
    useDomainStore.getState().connectNodes(b, c);
    const err = useDomainStore.getState().wrapSelectedAsSubsystem([a, b, c]);
    expect(err).toBeNull();
    const sub = useDomainStore.getState().project.subsystems[0]!;
    useViewStore.getState().drillIntoSubsystem(sub.id, 'Test Sub');
    return { a, b, c, subId: sub.id };
  }

  it('addNode while drilled in extends the active subsystem bodyNodeIds', () => {
    const { subId } = seedAndDrillIn();
    const bodyBefore = useDomainStore.getState().project.subsystems.find((s) => s.id === subId)!
      .bodyNodeIds.length;

    const newId = useDomainStore.getState().addNode({ x: 700, y: 150 });

    const sub = useDomainStore.getState().project.subsystems.find((s) => s.id === subId)!;
    expect(sub.bodyNodeIds.length).toBe(bodyBefore + 1);
    expect(sub.bodyNodeIds).toContain(newId);
    expect(useDomainStore.getState().project.nodes.find((n) => n.id === newId)).toBeDefined();
  });

  it('addNode at the top level (no drill) does NOT touch any subsystem', () => {
    const { subId } = seedAndDrillIn();
    useViewStore.getState().drillOutTo(-1); // drill back to root
    const subsystemsBefore = useDomainStore.getState().project.subsystems;

    const newId = useDomainStore.getState().addNode({ x: 700, y: 150 });

    const subsystemsAfter = useDomainStore.getState().project.subsystems;
    // Reference equality: identity-preserved when not drilled in.
    expect(subsystemsAfter).toBe(subsystemsBefore);
    // And the new node is NOT in the body.
    const sub = subsystemsAfter.find((s) => s.id === subId)!;
    expect(sub.bodyNodeIds).not.toContain(newId);
  });

  it('addDecisionNode while drilled in extends bodyNodeIds', () => {
    const { subId } = seedAndDrillIn();
    const newId = useDomainStore.getState().addDecisionNode({ x: 700, y: 150 });
    expect(
      useDomainStore.getState().project.subsystems.find((s) => s.id === subId)!.bodyNodeIds,
    ).toContain(newId);
  });

  it('addStartNode while drilled in extends bodyNodeIds', () => {
    const { subId } = seedAndDrillIn();
    const newId = useDomainStore.getState().addStartNode({ x: 700, y: 150 });
    expect(
      useDomainStore.getState().project.subsystems.find((s) => s.id === subId)!.bodyNodeIds,
    ).toContain(newId);
  });

  it('addEndNode while drilled in extends bodyNodeIds', () => {
    const { subId } = seedAndDrillIn();
    const newId = useDomainStore.getState().addEndNode({ x: 700, y: 150 });
    expect(
      useDomainStore.getState().project.subsystems.find((s) => s.id === subId)!.bodyNodeIds,
    ).toContain(newId);
  });

  it('addNodeWithIncomingEdges (wire-on-place) while drilled in extends bodyNodeIds', () => {
    const { a, subId } = seedAndDrillIn();
    const newId = useDomainStore
      .getState()
      .addNodeWithIncomingEdges('activity', { x: 700, y: 150 }, [a]);
    const sub = useDomainStore.getState().project.subsystems.find((s) => s.id === subId)!;
    expect(sub.bodyNodeIds).toContain(newId);
    // And the wire-on-place edge from `a` to the new node was created.
    expect(
      useDomainStore.getState().project.edges.some((e) => e.from === a && e.to === newId),
    ).toBe(true);
  });

  it('the add + membership update reverts in a single undo step', () => {
    const { subId } = seedAndDrillIn();
    const nodesBefore = useDomainStore.getState().project.nodes.length;
    const bodyBefore = useDomainStore.getState().project.subsystems.find((s) => s.id === subId)!
      .bodyNodeIds.length;

    useDomainStore.getState().addNode({ x: 700, y: 150 });
    expect(useDomainStore.getState().project.nodes.length).toBe(nodesBefore + 1);
    expect(
      useDomainStore.getState().project.subsystems.find((s) => s.id === subId)!.bodyNodeIds.length,
    ).toBe(bodyBefore + 1);

    useDomainStore.temporal.getState().undo();
    expect(useDomainStore.getState().project.nodes.length).toBe(nodesBefore);
    expect(
      useDomainStore.getState().project.subsystems.find((s) => s.id === subId)!.bodyNodeIds.length,
    ).toBe(bodyBefore);
  });

  it('post-add project passes V7 schema validation', async () => {
    seedAndDrillIn();
    useDomainStore.getState().addNode({ x: 700, y: 150 });
    const { saveProjectFile, loadProjectFile } = await import('@procsim/file-format');
    const result = loadProjectFile(saveProjectFile(useDomainStore.getState().project));
    expect(result.ok).toBe(true);
  });
});

// ── Phase 50 Slice 4 — ID generation hygiene (audit C-6) ──────────────────────

describe('domainStore — id generation uses UUIDs, not Date.now() (audit C-6)', () => {
  beforeEach(() => {
    abortEdit();
    useDomainStore.temporal.getState().clear();
    useDomainStore.setState({ project: makeDefaultProject(), lastIntent: null });
    useDomainStore.temporal.getState().clear();
    useViewStore.getState().drillOutTo(-1);
  });

  it('two consecutive wraps under frozen time produce distinct ids', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
    try {
      // Seed 4 nodes — two pairs, each wrappable into its own subsystem.
      const a1 = useDomainStore.getState().addNode({ x: 100, y: 100 });
      const b1 = useDomainStore.getState().addNode({ x: 300, y: 100 });
      const a2 = useDomainStore.getState().addNode({ x: 500, y: 100 });
      const b2 = useDomainStore.getState().addNode({ x: 700, y: 100 });

      // Wrap each pair WITHOUT advancing the clock — Date.now() returns the
      // same frozen value across both wraps. The old `sub-ctr-${Date.now()}`
      // / `sub-${Date.now()}` formula would collide here; UUIDs do not.
      expect(useDomainStore.getState().wrapSelectedAsSubsystem([a1, b1])).toBeNull();
      expect(useDomainStore.getState().wrapSelectedAsSubsystem([a2, b2])).toBeNull();

      const [sub1, sub2] = useDomainStore.getState().project.subsystems;
      expect(sub1).toBeDefined();
      expect(sub2).toBeDefined();
      expect(sub1!.id).not.toBe(sub2!.id);
      expect(sub1!.containerNodeId).not.toBe(sub2!.containerNodeId);
      expect(sub1!.entryNodeId).not.toBe(sub2!.entryNodeId);
      expect(sub1!.exitNodeId).not.toBe(sub2!.exitNodeId);
      expect(sub1!.entryNodeId).not.toBe(sub1!.exitNodeId);
      expect(sub2!.entryNodeId).not.toBe(sub2!.exitNodeId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('two consecutive imports under frozen time produce distinct ids across every remapped element', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
    try {
      // Minimal SubsystemFile fixture. The contents don't matter — only
      // that the importer re-IDs every node, edge, and container per call.
      const subsystemFile = {
        kind: 'caladia-subsystem' as const,
        version: 4 as const,
        name: 'Imported sub',
        nodes: [
          {
            id: 'src-a',
            nodeType: 'subsystemEntry' as const,
            name: 'Entry',
            duration: { value: 0, unit: 'hours' as const },
            durationSemantic: 'time' as const,
            position: { x: 0, y: 0 },
            calendarId: null,
            consumesResources: false,
            resourceAssignments: [],
          },
          {
            id: 'src-b',
            nodeType: 'activity' as const,
            name: 'Work',
            duration: { value: 4, unit: 'hours' as const },
            durationSemantic: 'time' as const,
            position: { x: 100, y: 0 },
            calendarId: null,
            consumesResources: true,
            resourceAssignments: [],
          },
          {
            id: 'src-c',
            nodeType: 'subsystemExit' as const,
            name: 'Exit',
            duration: { value: 0, unit: 'hours' as const },
            durationSemantic: 'time' as const,
            position: { x: 200, y: 0 },
            calendarId: null,
            consumesResources: false,
            resourceAssignments: [],
          },
        ],
        edges: [
          {
            id: 'e1',
            from: 'src-a',
            to: 'src-b',
            type: 'FS' as const,
            lag: { value: 0, unit: 'hours' as const },
          },
          {
            id: 'e2',
            from: 'src-b',
            to: 'src-c',
            type: 'FS' as const,
            lag: { value: 0, unit: 'hours' as const },
          },
        ],
        resources: [],
        calendars: [],
        loops: [],
        subsystems: [],
        entryNodeId: 'src-a',
        exitNodeId: 'src-c',
      };

      const err1 = useDomainStore.getState().importSubsystemFromFile(subsystemFile, { x: 0, y: 0 });
      const err2 = useDomainStore
        .getState()
        .importSubsystemFromFile(subsystemFile, { x: 500, y: 0 });
      expect(err1).toBeNull();
      expect(err2).toBeNull();

      const subs = useDomainStore.getState().project.subsystems;
      const nodes = useDomainStore.getState().project.nodes;
      expect(subs).toHaveLength(2);
      const sub1 = subs[0]!;
      const sub2 = subs[1]!;

      // Subsystem and container distinct.
      expect(sub1.id).not.toBe(sub2.id);
      expect(sub1.containerNodeId).not.toBe(sub2.containerNodeId);
      expect(sub1.entryNodeId).not.toBe(sub2.entryNodeId);
      expect(sub1.exitNodeId).not.toBe(sub2.exitNodeId);

      // Every remapped body node id across both imports is distinct (UUIDs
      // satisfy this even under frozen time; the old `imp-${Date.now()}-N`
      // formula collided whenever Date.now() returned the same ms).
      const allBodyIds = [...sub1.bodyNodeIds, ...sub2.bodyNodeIds];
      expect(new Set(allBodyIds).size).toBe(allBodyIds.length);

      // Spot-check: every new id is a UUID (36-char hex with dashes),
      // not the legacy `imp-<ms>-N` shape.
      const newNodeIds = nodes.filter((n) => allBodyIds.includes(n.id)).map((n) => n.id);
      for (const id of newNodeIds) {
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('domainStore — addScenario seed is passed in, not generated inside (audit I-12)', () => {
  beforeEach(() => {
    useDomainStore.setState({ project: makeDefaultProject() });
  });

  it('writes the caller-supplied seed verbatim into the new scenario', () => {
    const id = useDomainStore.getState().addScenario('S1', 12345);
    const scenario = useDomainStore.getState().project.scenarios.find((s) => s.id === id);
    expect(scenario).toBeDefined();
    expect(scenario!.seed).toBe(12345);
  });

  it('two calls with identical (name, seed) produce identical seeds in store', () => {
    useDomainStore.getState().addScenario('A', 777);
    useDomainStore.getState().addScenario('A', 777);
    const seeds = useDomainStore.getState().project.scenarios.map((s) => s.seed);
    expect(seeds).toEqual([777, 777]);
  });
});

describe('domainStore — updateGroupColor writes to project.groupColors (audit I-18)', () => {
  beforeEach(() => {
    useDomainStore.setState({ project: makeDefaultProject() });
    useDomainStore.temporal.getState().clear();
  });

  it('starts empty on a default project (matches schema migration)', () => {
    expect(useDomainStore.getState().project.groupColors).toEqual({});
  });

  it('writes a (name, color) pair into project.groupColors', () => {
    useDomainStore.getState().updateGroupColor('Finance', '#6366f1');
    expect(useDomainStore.getState().project.groupColors).toEqual({
      Finance: '#6366f1',
    });
  });

  it('preserves existing entries when adding a new group', () => {
    useDomainStore.getState().updateGroupColor('Finance', '#6366f1');
    useDomainStore.getState().updateGroupColor('Engineering', '#10b981');
    expect(useDomainStore.getState().project.groupColors).toEqual({
      Finance: '#6366f1',
      Engineering: '#10b981',
    });
  });

  it('overwrites an existing entry for the same group name', () => {
    useDomainStore.getState().updateGroupColor('Finance', '#6366f1');
    useDomainStore.getState().updateGroupColor('Finance', '#ef4444');
    expect(useDomainStore.getState().project.groupColors).toEqual({
      Finance: '#ef4444',
    });
  });

  it('lands as an undoable history entry (not transient)', () => {
    useDomainStore.getState().updateGroupColor('Finance', '#6366f1');
    expect(useDomainStore.temporal.getState().pastStates).toHaveLength(1);
    useDomainStore.temporal.getState().undo();
    expect(useDomainStore.getState().project.groupColors).toEqual({});
  });
});
