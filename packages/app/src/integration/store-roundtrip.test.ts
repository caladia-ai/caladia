/**
 * Audit N-21 — store-mutation → save → reload roundtrip integration test.
 *
 * The existing roundtrip tests (`import-roundtrip.test.ts`,
 * `multi-resource-roundtrip.test.ts`) construct ProjectFile values
 * directly and verify serialization. This file covers the OTHER
 * direction: real domain-store actions (the same code paths the UI
 * drives) producing schema-valid output that survives a full save →
 * load cycle.
 *
 * The catch-set for these tests:
 *   - Mutations that leak ephemeral / view-state fields into the project
 *   - Mutations that produce values just-barely-violating the schema
 *     (caught at load, not save)
 *   - Default fields drifting between `makeDefaultProject()` and the
 *     post-load shape
 *   - Future schema-additions that an action forgot to populate
 *
 * Each test follows the same pattern:
 *   1. Reset the store to a fresh default project.
 *   2. Apply a sequence of domain-store actions.
 *   3. Capture the resulting project value.
 *   4. Serialize via saveProjectFile.
 *   5. Parse back via loadProjectFile (full schema validation).
 *   6. Assert the reloaded project deep-equals the captured pre-save value.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { saveProjectFile, loadProjectFile, type ProjectFile } from '@procsim/file-format';
import {
  useDomainStore,
  abortEdit,
  makeDefaultProject,
  type WorkingDaysUI,
} from '../store/domainStore.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetStore(): void {
  abortEdit();
  useDomainStore.setState({ project: makeDefaultProject(), lastIntent: null });
  useDomainStore.temporal.getState().clear();
}

interface RoundtripOutcome {
  before: ProjectFile;
  result: ReturnType<typeof loadProjectFile>;
}

function roundtrip(): RoundtripOutcome {
  const before = useDomainStore.getState().project;
  const serialized = saveProjectFile(before);
  const result = loadProjectFile(serialized);
  return { before, result };
}

function assertRoundtripEquality(outcome: RoundtripOutcome): void {
  expect(outcome.result.ok).toBe(true);
  if (!outcome.result.ok) {
    // Surface the validation errors in the test output so failures are
    // diagnosable; the `expect.fail` is unreachable on the happy path.
    throw new Error(
      `loadProjectFile failed:\n${outcome.result.errors
        .map((e) => `  - ${e.path ? `${e.path}: ` : ''}${e.message}`)
        .join('\n')}`,
    );
  }
  expect(outcome.result.project).toEqual(outcome.before);
}

const MON_FRI: WorkingDaysUI = [false, true, true, true, true, true, false];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('store-mutation → save → reload roundtrip (audit N-21)', () => {
  beforeEach(() => {
    resetStore();
  });

  it('default project roundtrips without mutations', () => {
    assertRoundtripEquality(roundtrip());
  });

  it('basic node + edge mutations survive roundtrip', () => {
    const s = useDomainStore.getState();
    const aId = s.addNode({ x: 100, y: 100 });
    const bId = s.addNode({ x: 300, y: 100 });
    s.updateNodeName(aId, 'Spec');
    s.updateNodeName(bId, 'Build');
    s.updateNodeDuration(aId, 16, 'hours');
    s.updateNodeDuration(bId, 40, 'hours');
    s.connectNodes(aId, bId);
    assertRoundtripEquality(roundtrip());
  });

  it('start + end + decision anchor nodes survive roundtrip', () => {
    const s = useDomainStore.getState();
    const startId = s.addStartNode({ x: 0, y: 0 }, '2026-06-01');
    const decisionId = s.addDecisionNode({ x: 200, y: 0 });
    const endId = s.addEndNode({ x: 400, y: 0 });
    s.updateNodeName(startId, 'Kick-off');
    s.updateNodeName(decisionId, 'Go / no-go');
    s.updateNodeName(endId, 'Launch');
    s.updateNodePassProbability(decisionId, 0.7);
    s.updateNodeFailureDelay(decisionId, { value: 8, unit: 'hours' });
    s.connectNodes(startId, decisionId);
    s.connectNodes(decisionId, endId);
    assertRoundtripEquality(roundtrip());
  });

  it('activity with distribution + fixedCost survives roundtrip', () => {
    const s = useDomainStore.getState();
    const id = s.addNode({ x: 100, y: 100 });
    s.updateNodeDistribution(id, { type: 'triangular', min: 4, mode: 8, max: 16 });
    s.updateNodeFixedCost(id, {
      value: 1000,
      distribution: { type: 'normal', mean: 1000, stddev: 200 },
    });
    assertRoundtripEquality(roundtrip());
  });

  it('resource + single assignment survives roundtrip (percentage mode)', () => {
    const s = useDomainStore.getState();
    s.addResource({
      name: 'Lead Engineer',
      capacity: 1,
      workingDays: MON_FRI,
      hoursPerDay: 8,
      costRate: 150,
    });
    const aId = s.addNode({ x: 100, y: 100 });
    const resourceId = useDomainStore.getState().project.resources.at(-1)!.id;
    s.addResourceAssignment(aId, {
      resourceId,
      count: 1,
      // In percentage mode (the default), share must sum to 100 across all
      // a node's assignments. One assignment with share=100 satisfies that.
      share: 100,
      calendarPolicy: 'resourceWins',
    });
    assertRoundtripEquality(roundtrip());
  });

  it('group colors survive roundtrip (V8 addition — audit I-18)', () => {
    const s = useDomainStore.getState();
    const aId = s.addNode({ x: 100, y: 100 });
    const bId = s.addNode({ x: 300, y: 100 });
    s.updateNodeGroup(aId, 'Phase 1');
    s.updateNodeGroup(bId, 'Phase 2');
    s.updateGroupColor('Phase 1', '#6366f1');
    s.updateGroupColor('Phase 2', '#10b981');
    assertRoundtripEquality(roundtrip());
  });

  it('comment lifecycle survives roundtrip (Phase 49)', () => {
    const s = useDomainStore.getState();
    const cId = s.addComment({ x: 200, y: 200 });
    s.updateComment(cId, 'Watch for vendor delays during the rainy season.');
    s.moveComment(cId, { x: 250, y: 250 });
    assertRoundtripEquality(roundtrip());
  });

  it('project-level settings (start date + currency) survive roundtrip', () => {
    const s = useDomainStore.getState();
    s.updateProjectStartDate('2027-03-15');
    s.updateProjectCurrency('EUR');
    assertRoundtripEquality(roundtrip());
  });

  it('delete operations leave a roundtrip-clean project', () => {
    const s = useDomainStore.getState();
    const aId = s.addNode({ x: 100, y: 100 });
    const bId = s.addNode({ x: 300, y: 100 });
    const cId = s.addNode({ x: 500, y: 100 });
    s.connectNodes(aId, bId);
    s.connectNodes(bId, cId);
    // Delete the middle node — should clean up incident edges.
    s.deleteNodes([bId]);
    const after = useDomainStore.getState().project;
    expect(after.nodes.map((n) => n.id)).not.toContain(bId);
    expect(after.edges.some((e) => e.from === bId || e.to === bId)).toBe(false);
    assertRoundtripEquality(roundtrip());
  });

  it('kitchen sink: many mutation classes together survive roundtrip', () => {
    const s = useDomainStore.getState();
    // Project-level
    s.updateProjectStartDate('2026-09-01');
    s.updateProjectCurrency('GBP');

    // Resources
    s.addResource({
      name: 'Designer',
      capacity: 2,
      workingDays: MON_FRI,
      hoursPerDay: 8,
      costRate: 120,
    });
    s.addResource({
      name: 'Engineer',
      capacity: 3,
      workingDays: MON_FRI,
      hoursPerDay: 8,
      costRate: 180,
      hourlyRateDistribution: { type: 'normal', mean: 180, stddev: 20 },
    });

    // Topology
    const designId = s.addNode({ x: 100, y: 100 });
    const buildId = s.addNode({ x: 300, y: 100 });
    const reviewId = s.addDecisionNode({ x: 500, y: 100 });
    const shipId = s.addEndNode({ x: 700, y: 100 });
    s.connectNodes(designId, buildId);
    s.connectNodes(buildId, reviewId);
    s.connectNodes(reviewId, shipId);

    // Node detail
    s.updateNodeName(designId, 'Design');
    s.updateNodeName(buildId, 'Build');
    s.updateNodeName(reviewId, 'QA review');
    s.updateNodeName(shipId, 'Ship');
    s.updateNodeDuration(designId, 24, 'hours');
    s.updateNodeDuration(buildId, 80, 'hours');
    s.updateNodeDistribution(buildId, { type: 'pert-beta', min: 60, mode: 80, max: 120 });
    s.updateNodeFixedCost(designId, { value: 500 });
    s.updateNodePassProbability(reviewId, 0.85);
    s.updateNodeFailureDelay(reviewId, { value: 16, unit: 'hours' });

    // Resource assignments (single per node — keeps percentage-mode invariant trivial)
    const resources = useDomainStore.getState().project.resources;
    const designerId = resources.find((r) => r.name === 'Designer')!.id;
    const engineerId = resources.find((r) => r.name === 'Engineer')!.id;
    s.addResourceAssignment(designId, {
      resourceId: designerId,
      count: 1,
      share: 100,
      calendarPolicy: 'resourceWins',
    });
    s.addResourceAssignment(buildId, {
      resourceId: engineerId,
      count: 2,
      share: 100,
      calendarPolicy: 'resourceWins',
    });

    // Groups + colors
    s.updateNodeGroup(designId, 'Discovery');
    s.updateNodeGroup(buildId, 'Delivery');
    s.updateGroupColor('Discovery', '#f59e0b');
    s.updateGroupColor('Delivery', '#3b82f6');

    // Comment
    const cId = s.addComment({ x: 400, y: 300 });
    s.updateComment(cId, 'Stakeholder review on Friday before sign-off.');

    assertRoundtripEquality(roundtrip());
  });

  it('two save → load cycles in a row stay stable (idempotent)', () => {
    // After one roundtrip, a SECOND save → load cycle should produce the
    // same value. Catches subtle migration drift that only fires on
    // not-quite-canonical inputs.
    const s = useDomainStore.getState();
    s.addNode({ x: 100, y: 100 });
    s.addNode({ x: 300, y: 100 });
    const groupOf = useDomainStore.getState().project.nodes[0]!.id;
    s.updateNodeGroup(groupOf, 'Phase 1');
    s.updateGroupColor('Phase 1', '#6366f1');

    const before = useDomainStore.getState().project;
    const r1 = loadProjectFile(saveProjectFile(before));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = loadProjectFile(saveProjectFile(r1.project));
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.project).toEqual(r1.project);
    expect(r1.project).toEqual(before);
  });
});
