import { describe, it, expect } from 'vitest';
import { makeDefaultProject } from '../store/domainStore.js';
import { hasUserContent } from './projectContent.js';

describe('hasUserContent', () => {
  it('returns false for the freshly-defaulted project (one placeholder node, everything else empty)', () => {
    expect(hasUserContent(makeDefaultProject())).toBe(false);
  });

  it('returns true once a second node is added', () => {
    const p = makeDefaultProject();
    expect(
      hasUserContent({
        ...p,
        nodes: [...p.nodes, { ...p.nodes[0]!, id: 'activity-2' }],
      }),
    ).toBe(true);
  });

  it('returns true when an edge exists', () => {
    const p = makeDefaultProject();
    expect(
      hasUserContent({
        ...p,
        edges: [
          {
            id: 'e1',
            from: 'activity-1',
            to: 'activity-1',
            type: 'FS',
            lag: { value: 0, unit: 'hours' },
          },
        ],
      }),
    ).toBe(true);
  });

  it('returns true when a comment exists', () => {
    const p = makeDefaultProject();
    expect(
      hasUserContent({
        ...p,
        comments: [{ id: 'c1', x: 0, y: 0, text: 'note' }],
      }),
    ).toBe(true);
  });

  it('returns true when a resource pool exists', () => {
    const p = makeDefaultProject();
    expect(
      hasUserContent({
        ...p,
        resources: [{ id: 'r1', name: 'Devs', capacity: 1, calendarId: 'cal-default' }],
      }),
    ).toBe(true);
  });

  it('returns true when a loop / subsystem / scenario exists', () => {
    const p = makeDefaultProject();
    expect(
      hasUserContent({
        ...p,
        loops: [
          {
            id: 'l1',
            bodyNodeIds: [],
            kickout: { type: 'maxIterations', value: 1 },
            expectedIterations: { type: 'triangular', min: 1, mode: 1, max: 1 },
          },
        ],
      }),
    ).toBe(true);
    expect(
      hasUserContent({
        ...p,
        subsystems: [
          {
            id: 's1',
            bodyNodeIds: [],
            containerNodeId: 'activity-1',
            entryNodeId: 'activity-1',
            exitNodeId: 'activity-1',
          },
        ],
      }),
    ).toBe(true);
    expect(
      hasUserContent({
        ...p,
        scenarios: [{ id: 'sc1', name: 'baseline', seed: 0, nodeOverrides: {} }],
      }),
    ).toBe(true);
  });

  it('returns false for placeholder-only edits (rename the single node, change project name)', () => {
    const p = makeDefaultProject();
    expect(
      hasUserContent({
        ...p,
        nodes: [{ ...p.nodes[0]!, name: 'Renamed' }],
        project: { ...p.project, name: 'Renamed project' },
      }),
    ).toBe(false);
  });
});
