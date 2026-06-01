/**
 * Whether the first-run onboarding overlay should be visible on the canvas.
 *
 * Shows on the canvas tab on first run (the `hasSeenOnboarding` flag is unset)
 * while the canvas is still empty and the template picker isn't open.
 */
export function shouldShowOnboarding(params: {
  isCanvas: boolean;
  hasSeenOnboarding: boolean;
  templatePickerOpen: boolean;
  hasContent: boolean;
}): boolean {
  const { isCanvas, hasSeenOnboarding, templatePickerOpen, hasContent } = params;
  return isCanvas && !hasSeenOnboarding && !templatePickerOpen && !hasContent;
}
