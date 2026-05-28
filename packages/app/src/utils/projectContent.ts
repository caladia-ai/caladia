import type { ProjectFile } from '@procsim/file-format';

/**
 * Returns true when the project has user-authored content worth
 * warning about before a destructive replace (Open / New / New from
 * template / Import).
 *
 * `makeDefaultProject()` ships with exactly one placeholder activity
 * node and empty arrays for everything else. So "user content" =
 * more than one node, OR any edges / loops / subsystems / scenarios
 * / comments / resources. We intentionally don't count edits to the
 * single placeholder (name / duration tweaks) — they're trivial
 * enough that warning the user every time would be more friction
 * than safety.
 */
export function hasUserContent(project: ProjectFile): boolean {
  return (
    project.nodes.length > 1 ||
    project.edges.length > 0 ||
    project.loops.length > 0 ||
    project.subsystems.length > 0 ||
    project.scenarios.length > 0 ||
    project.comments.length > 0 ||
    project.resources.length > 0
  );
}
