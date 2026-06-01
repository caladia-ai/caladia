import { loadProjectFile } from '@procsim/file-format';
import type { ProjectFile } from '@procsim/file-format';

/**
 * A curated subset of the template library for the first-run quick-start box —
 * two domain-neutral starters + two popular verticals. The full set lives in
 * `TemplatePickerModal` (reachable via the welcome card's "Browse templates").
 * Titles mirror that manifest.
 */
export const QUICK_START_TEMPLATES: ReadonlyArray<{ slug: string; title: string }> = [
  { slug: 'simple-sequential', title: 'Simple Sequential Workflow' },
  { slug: 'iterative-cycle', title: 'Iterative Cycle' },
  { slug: 'software-feature-release', title: 'Software Feature Release' },
  { slug: 'marketing-campaign', title: 'Marketing Campaign' },
];

/**
 * Fetch + validate a starter template by slug (served from `public/templates/`),
 * returning the parsed project. Throws on network / validation failure. Mirrors
 * the load path in `TemplatePickerModal.handlePick`.
 */
export async function loadTemplateBySlug(slug: string): Promise<ProjectFile> {
  const res = await fetch(`/templates/${slug}.cala`);
  if (!res.ok) {
    throw new Error(`Could not load template (HTTP ${res.status})`);
  }
  const json = await res.text();
  const parsed = loadProjectFile(json);
  if (!parsed.ok) {
    throw new Error('Template file failed validation');
  }
  return parsed.project;
}
