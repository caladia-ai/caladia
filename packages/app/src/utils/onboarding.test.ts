import { describe, it, expect } from 'vitest';
import { shouldShowOnboarding } from './onboarding.js';

describe('shouldShowOnboarding', () => {
  // A fresh visitor on an empty canvas, picker not open.
  const base = {
    isCanvas: true,
    hasSeenOnboarding: false,
    templatePickerOpen: false,
    hasContent: false,
  };

  it('shows on a fresh, empty canvas (first run)', () => {
    expect(shouldShowOnboarding(base)).toBe(true);
  });

  it('hides once dismissed', () => {
    expect(shouldShowOnboarding({ ...base, hasSeenOnboarding: true })).toBe(false);
  });

  it('hides while the template picker is open', () => {
    expect(shouldShowOnboarding({ ...base, templatePickerOpen: true })).toBe(false);
  });

  it('hides once the canvas has user content', () => {
    expect(shouldShowOnboarding({ ...base, hasContent: true })).toBe(false);
  });

  it('hides off the canvas tab', () => {
    expect(shouldShowOnboarding({ ...base, isCanvas: false })).toBe(false);
  });
});
