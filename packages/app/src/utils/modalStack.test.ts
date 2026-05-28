import { describe, it, expect, beforeEach } from 'vitest';
import { pushModal, popModal, isTopModal, _resetModalStack } from './modalStack.js';

beforeEach(() => {
  _resetModalStack();
});

describe('modalStack', () => {
  it('pushModal returns increasing ids', () => {
    const a = pushModal();
    const b = pushModal();
    const c = pushModal();
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('isTopModal returns true only for the most recent push', () => {
    const a = pushModal();
    expect(isTopModal(a)).toBe(true);
    const b = pushModal();
    expect(isTopModal(a)).toBe(false);
    expect(isTopModal(b)).toBe(true);
  });

  it('popModal of top exposes the previous modal', () => {
    const a = pushModal();
    const b = pushModal();
    popModal(b);
    expect(isTopModal(a)).toBe(true);
  });

  it('popModal of a middle entry preserves order of remaining entries', () => {
    const a = pushModal();
    const b = pushModal();
    const c = pushModal();
    popModal(b);
    // a and c remain; c is top, a is below.
    expect(isTopModal(c)).toBe(true);
    expect(isTopModal(a)).toBe(false);
    popModal(c);
    expect(isTopModal(a)).toBe(true);
  });

  it('popModal of a non-existent id is a no-op', () => {
    const a = pushModal();
    popModal(9999);
    expect(isTopModal(a)).toBe(true);
  });

  it('empty stack: isTopModal returns false for any id', () => {
    expect(isTopModal(1)).toBe(false);
    expect(isTopModal(0)).toBe(false);
  });

  it('after all pops, stack is empty', () => {
    const a = pushModal();
    const b = pushModal();
    popModal(a);
    popModal(b);
    expect(isTopModal(a)).toBe(false);
    expect(isTopModal(b)).toBe(false);
  });
});
