import { describe, it, expect } from 'vitest';
import type { Calendar, Loop, ProjectEdge, ProjectNode, Subsystem } from '@procsim/file-format';
import { flattenSubsystems } from './flatten.js';
import { schedule } from './cpm.js';
import type { ScheduleInput } from './types.js';

// ── Shared fixtures ───────────────────────────────────────────────────────────

const MON_FRI: Calendar = {
  id: 'cal-default',
  name: 'Mon–Fri 8 h',
  workingDays: [false, true, true, true, true, true, false],
  hoursPerDay: 8,
  daysPerWeek: 5,
  holidayPreset: 'NONE',
  holidayPresetVersion: '1.0',
  exceptions: [],
};

const START_DATE = '2026-01-05'; // Monday

// ── Node / edge helpers ───────────────────────────────────────────────────────

function activityNode(id: string, hours: number): ProjectNode {
  return {
    id,
    nodeType: 'activity',
    name: id,
    duration: { value: hours, unit: 'hours' },
    durationSemantic: 'time',
    position: { x: 0, y: 0 },
    calendarId: null,
    consumesResources: false,
    resourceAssignments: [],
  };
}

function anchorNode(id: string, nodeType: 'start' | 'end' | 'subsystem'): ProjectNode {
  return {
    id,
    nodeType,
    name: id,
    duration: { value: 0, unit: 'hours' },
    durationSemantic: 'time',
    position: { x: 0, y: 0 },
    calendarId: null,
    consumesResources: false,
    resourceAssignments: [],
  };
}

function fs(id: string, from: string, to: string): ProjectEdge {
  return { id, from, to, type: 'FS', lag: { value: 0, unit: 'hours' } };
}

function makeInput(
  nodes: ProjectNode[],
  edges: ProjectEdge[],
  subsystems?: Subsystem[],
  loops?: Loop[],
): ScheduleInput {
  return {
    project: {
      name: 'Test',
      startDate: START_DATE,
      defaultCalendarId: 'cal-default',
      displayUnit: 'days',
      shareMode: 'percentage',
    },
    nodes,
    edges,
    resources: [],
    calendars: [MON_FRI],
    loops: loops ?? [],
    // exactOptionalPropertyTypes: omit the key rather than setting it to undefined
    ...(subsystems !== undefined ? { subsystems } : {}),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('flattenSubsystems', () => {
  // ── Fast-path guards ─────────────────────────────────────────────────────

  it('returns the same reference when subsystems field is absent', () => {
    const input = makeInput(
      [anchorNode('S', 'start'), activityNode('A', 8), anchorNode('E', 'end')],
      [fs('e1', 'S', 'A'), fs('e2', 'A', 'E')],
    );
    expect(flattenSubsystems(input)).toBe(input);
  });

  it('returns the same reference when subsystems is an empty array', () => {
    const input = makeInput(
      [anchorNode('S', 'start'), activityNode('A', 8), anchorNode('E', 'end')],
      [fs('e1', 'S', 'A'), fs('e2', 'A', 'E')],
      [],
    );
    expect(flattenSubsystems(input)).toBe(input);
  });

  // ── Single sub-system ────────────────────────────────────────────────────

  it('removes the container node from the nodes array', () => {
    const subsystem: Subsystem = {
      id: 'sub1',
      containerNodeId: 'CTR',
      bodyNodeIds: ['ENTRY', 'ACT', 'EXIT'],
      entryNodeId: 'ENTRY',
      exitNodeId: 'EXIT',
    };

    const input = makeInput(
      [
        anchorNode('S', 'start'),
        anchorNode('CTR', 'subsystem'),
        anchorNode('E', 'end'),
        activityNode('ENTRY', 8),
        activityNode('ACT', 16),
        activityNode('EXIT', 8),
      ],
      [
        fs('e1', 'S', 'CTR'),
        fs('e2', 'CTR', 'E'),
        fs('e3', 'ENTRY', 'ACT'),
        fs('e4', 'ACT', 'EXIT'),
      ],
      [subsystem],
    );

    const flat = flattenSubsystems(input);
    const ids = flat.nodes.map((n) => n.id);
    expect(ids).not.toContain('CTR');
    expect(ids).toContain('ENTRY');
    expect(ids).toContain('ACT');
    expect(ids).toContain('EXIT');
  });

  it('rewrites inbound edges to the entry node and outbound edges from the exit node', () => {
    const subsystem: Subsystem = {
      id: 'sub1',
      containerNodeId: 'CTR',
      bodyNodeIds: ['ENTRY', 'ACT', 'EXIT'],
      entryNodeId: 'ENTRY',
      exitNodeId: 'EXIT',
    };

    const input = makeInput(
      [
        anchorNode('S', 'start'),
        anchorNode('CTR', 'subsystem'),
        anchorNode('E', 'end'),
        activityNode('ENTRY', 8),
        activityNode('ACT', 16),
        activityNode('EXIT', 8),
      ],
      [
        fs('e1', 'S', 'CTR'), // inbound → should point to ENTRY
        fs('e2', 'CTR', 'E'), // outbound → should come from EXIT
        fs('e3', 'ENTRY', 'ACT'),
        fs('e4', 'ACT', 'EXIT'),
      ],
      [subsystem],
    );

    const flat = flattenSubsystems(input);

    // No edge should reference the removed container
    expect(flat.edges.find((e) => e.from === 'CTR' || e.to === 'CTR')).toBeUndefined();

    // e1: was S→CTR, should now be S→ENTRY
    const e1 = flat.edges.find((e) => e.id === 'e1')!;
    expect(e1.from).toBe('S');
    expect(e1.to).toBe('ENTRY');

    // e2: was CTR→E, should now be EXIT→E
    const e2 = flat.edges.find((e) => e.id === 'e2')!;
    expect(e2.from).toBe('EXIT');
    expect(e2.to).toBe('E');

    // Internal edges unchanged
    const e3 = flat.edges.find((e) => e.id === 'e3')!;
    expect(e3.from).toBe('ENTRY');
    expect(e3.to).toBe('ACT');
  });

  // ── Schedule equivalence ─────────────────────────────────────────────────

  it('produces the same schedule as the equivalent inlined graph', () => {
    // Sub-system version: Start → CTR(body=[EN,ACT,EX]) → End
    const subsystem: Subsystem = {
      id: 'sub1',
      containerNodeId: 'CTR',
      bodyNodeIds: ['EN', 'ACT', 'EX'],
      entryNodeId: 'EN',
      exitNodeId: 'EX',
    };
    const subsystemInput = makeInput(
      [
        anchorNode('S', 'start'),
        anchorNode('CTR', 'subsystem'),
        anchorNode('E', 'end'),
        activityNode('EN', 8),
        activityNode('ACT', 16),
        activityNode('EX', 8),
      ],
      [fs('e1', 'S', 'CTR'), fs('e2', 'CTR', 'E'), fs('e3', 'EN', 'ACT'), fs('e4', 'ACT', 'EX')],
      [subsystem],
    );

    // Inlined version: Start → EN → ACT → EX → End (no container)
    const inlinedInput = makeInput(
      [
        anchorNode('S', 'start'),
        activityNode('EN', 8),
        activityNode('ACT', 16),
        activityNode('EX', 8),
        anchorNode('E', 'end'),
      ],
      [fs('e1', 'S', 'EN'), fs('e2', 'EN', 'ACT'), fs('e3', 'ACT', 'EX'), fs('e4', 'EX', 'E')],
    );

    const subsystemResult = schedule(subsystemInput);
    const inlinedResult = schedule(inlinedInput);

    expect(subsystemResult.ok).toBe(true);
    expect(inlinedResult.ok).toBe(true);
    if (!subsystemResult.ok || !inlinedResult.ok) return;

    // Project end must match
    expect(subsystemResult.result.projectEnd.getTime()).toBe(
      inlinedResult.result.projectEnd.getTime(),
    );

    // Each body node's schedule must match the inlined node's schedule
    for (const nid of ['EN', 'ACT', 'EX']) {
      const ss = subsystemResult.result.nodes[nid]!;
      const is = inlinedResult.result.nodes[nid]!;
      expect(ss.earliestStart.getTime()).toBe(is.earliestStart.getTime());
      expect(ss.earliestFinish.getTime()).toBe(is.earliestFinish.getTime());
    }
  });

  // ── Three-deep nesting ───────────────────────────────────────────────────

  it('processes three-deep nested subsystems in correct post-order', () => {
    // Structure:
    //   Outer:  S → O_CTR → E  (body = [O_EN, M_CTR, O_EX])
    //   Middle: O_EN → M_CTR → O_EX  (body = [M_EN, I_CTR, M_EX])
    //   Inner:  M_EN → I_CTR → M_EX  (body = [I_EN, I_ACT, I_EX])
    //   Inner body: I_EN → I_ACT → I_EX

    const innerSub: Subsystem = {
      id: 'inner',
      containerNodeId: 'I_CTR',
      bodyNodeIds: ['I_EN', 'I_ACT', 'I_EX'],
      entryNodeId: 'I_EN',
      exitNodeId: 'I_EX',
    };
    const middleSub: Subsystem = {
      id: 'middle',
      containerNodeId: 'M_CTR',
      bodyNodeIds: ['M_EN', 'I_CTR', 'M_EX'],
      entryNodeId: 'M_EN',
      exitNodeId: 'M_EX',
    };
    const outerSub: Subsystem = {
      id: 'outer',
      containerNodeId: 'O_CTR',
      bodyNodeIds: ['O_EN', 'M_CTR', 'O_EX'],
      entryNodeId: 'O_EN',
      exitNodeId: 'O_EX',
    };

    const input = makeInput(
      [
        anchorNode('S', 'start'),
        anchorNode('O_CTR', 'subsystem'),
        anchorNode('E', 'end'),
        activityNode('O_EN', 4),
        anchorNode('M_CTR', 'subsystem'),
        activityNode('O_EX', 4),
        activityNode('M_EN', 4),
        anchorNode('I_CTR', 'subsystem'),
        activityNode('M_EX', 4),
        activityNode('I_EN', 4),
        activityNode('I_ACT', 8),
        activityNode('I_EX', 4),
      ],
      [
        // Outer frame
        fs('e1', 'S', 'O_CTR'),
        fs('e2', 'O_CTR', 'E'),
        // Outer body
        fs('e3', 'O_EN', 'M_CTR'),
        fs('e4', 'M_CTR', 'O_EX'),
        // Middle body
        fs('e5', 'M_EN', 'I_CTR'),
        fs('e6', 'I_CTR', 'M_EX'),
        // Inner body
        fs('e7', 'I_EN', 'I_ACT'),
        fs('e8', 'I_ACT', 'I_EX'),
      ],
      [outerSub, middleSub, innerSub],
    );

    const flat = flattenSubsystems(input);

    // All three container nodes must be gone
    const ids = flat.nodes.map((n) => n.id);
    expect(ids).not.toContain('O_CTR');
    expect(ids).not.toContain('M_CTR');
    expect(ids).not.toContain('I_CTR');

    // No edge should reference any container
    for (const e of flat.edges) {
      expect(['O_CTR', 'M_CTR', 'I_CTR']).not.toContain(e.from);
      expect(['O_CTR', 'M_CTR', 'I_CTR']).not.toContain(e.to);
    }

    // e1: S→O_CTR → S→O_EN
    const e1 = flat.edges.find((e) => e.id === 'e1')!;
    expect(e1.to).toBe('O_EN');

    // e2: O_CTR→E → O_EX→E
    const e2 = flat.edges.find((e) => e.id === 'e2')!;
    expect(e2.from).toBe('O_EX');

    // e3: O_EN→M_CTR → O_EN→M_EN
    const e3 = flat.edges.find((e) => e.id === 'e3')!;
    expect(e3.to).toBe('M_EN');

    // e4: M_CTR→O_EX → M_EX→O_EX
    const e4 = flat.edges.find((e) => e.id === 'e4')!;
    expect(e4.from).toBe('M_EX');

    // e5: M_EN→I_CTR → M_EN→I_EN
    const e5 = flat.edges.find((e) => e.id === 'e5')!;
    expect(e5.to).toBe('I_EN');

    // e6: I_CTR→M_EX → I_EX→M_EX
    const e6 = flat.edges.find((e) => e.id === 'e6')!;
    expect(e6.from).toBe('I_EX');

    // The three-deep schedule should be schedulable
    const result = schedule(flat);
    expect(result.ok).toBe(true);
  });

  // ── Loop inside a sub-system ─────────────────────────────────────────────

  it('preserves loop body nodes inside a sub-system after flattening', () => {
    // Sub-system with a loop: EN → L1 → L2 → EX
    // Loop body = [L1, L2]
    const loop: Loop = {
      id: 'loop1',
      bodyNodeIds: ['L1', 'L2'],
      kickout: { type: 'maxIterations', value: 5 },
      expectedIterations: { type: 'triangular', min: 2, mode: 2, max: 2 },
    };

    const subsystem: Subsystem = {
      id: 'sub1',
      containerNodeId: 'CTR',
      bodyNodeIds: ['EN', 'L1', 'L2', 'EX'],
      entryNodeId: 'EN',
      exitNodeId: 'EX',
    };

    const input = makeInput(
      [
        anchorNode('S', 'start'),
        anchorNode('CTR', 'subsystem'),
        anchorNode('E', 'end'),
        activityNode('EN', 8),
        activityNode('L1', 8),
        activityNode('L2', 8),
        activityNode('EX', 8),
      ],
      [
        fs('e1', 'S', 'CTR'),
        fs('e2', 'CTR', 'E'),
        fs('e3', 'EN', 'L1'),
        fs('e4', 'L1', 'L2'),
        fs('e5', 'L2', 'EX'),
      ],
      [subsystem],
      [loop],
    );

    const flat = flattenSubsystems(input);

    // Container removed; loop body nodes preserved
    const ids = flat.nodes.map((n) => n.id);
    expect(ids).not.toContain('CTR');
    expect(ids).toContain('L1');
    expect(ids).toContain('L2');
    expect(ids).toContain('EN');
    expect(ids).toContain('EX');

    // Loops must be unchanged
    expect(flat.loops).toEqual(input.loops);

    // The flattened + looped graph should schedule without errors
    const result = schedule(flat);
    expect(result.ok).toBe(true);
  });
});
