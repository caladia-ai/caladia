import { describe, it, expect } from 'vitest';
import { classifyPlacementClick } from './PlacementOverlay.js';

/**
 * Phase 50 Slice 11 — placement overlay click scoping (closes C-17).
 *
 * The DOM `closest()` calls live in the React component; the policy
 * decision (passthrough vs place vs cancel) is split out so it can be
 * tested without a DOM environment.
 */
describe('classifyPlacementClick', () => {
  it('routes overlay clicks to passthrough even when they also match the canvas selector', () => {
    // A click on the SelectionToolbar lands inside `.react-flow` (the
    // toolbar is rendered inside <ReactFlow>) — without the passthrough
    // branch, this would have been treated as a place click and the
    // Align button would never have fired.
    expect(classifyPlacementClick({ passthrough: true, insideCanvas: true })).toBe('passthrough');
  });

  it('places when the click is inside the canvas and not on an overlay', () => {
    expect(classifyPlacementClick({ passthrough: false, insideCanvas: true })).toBe('place');
  });

  it('cancels when the click lands outside the canvas (rail, header, inspector)', () => {
    expect(classifyPlacementClick({ passthrough: false, insideCanvas: false })).toBe('cancel');
  });

  it('treats passthrough as winning over canvas in the degenerate both-false-but-passthrough case', () => {
    // Defends against a future overlay that's rendered outside of
    // `<ReactFlow>` (e.g. moved into AppShell) — passthrough should
    // still keep its semantic and not fall through to cancel.
    expect(classifyPlacementClick({ passthrough: true, insideCanvas: false })).toBe('passthrough');
  });
});
