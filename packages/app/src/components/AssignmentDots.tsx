import { useMemo } from 'react';
import { useDomainStore } from '../store/domainStore.js';
import { useViewStore } from '../store/viewStore.js';
import { autoResourceColor } from '../utils/resourceColors.js';

/**
 * Phase 43 Slice 2 — per-node assignment dot caption row.
 *
 * Rendered inside ActivityNode and DecisionNode. One small color dot per
 * assigned pool; dot color matches the palette card's leading swatch via
 * `autoResourceColor`. Click a dot to jump to that row in the Inspector.
 *
 * Self-gates on `viewStore.resourcePaletteOpen` — the dots are a resource-
 * authoring affordance, useful while the palette is open and the user is
 * thinking about assignment coverage; once the palette is closed the dots
 * become decorative clutter that doesn't pay rent on the node's screen
 * real estate. Returns null when the palette is closed OR the node has no
 * assignments.
 *
 * Wraps the row in `pointer-events-auto` so it works inside parent
 * containers (e.g. DecisionNode's inner content layer) that use
 * `pointer-events-none` to keep clicks flowing to React Flow.
 */
export function AssignmentDots({ nodeId }: { readonly nodeId: string }) {
  const paletteOpen = useViewStore((s) => s.resourcePaletteOpen);
  const assignments = useDomainStore(
    (s) => s.project.nodes.find((n) => n.id === nodeId)?.resourceAssignments,
  );
  const resources = useDomainStore((s) => s.project.resources);

  const { resourceNamesSorted, resourceNamesById } = useMemo(() => {
    const byId = new Map<string, string>();
    const names: string[] = [];
    for (const r of resources) {
      byId.set(r.id, r.name);
      names.push(r.name);
    }
    names.sort();
    return { resourceNamesSorted: names, resourceNamesById: byId };
  }, [resources]);

  if (!paletteOpen) return null;
  if (!assignments || assignments.length === 0) return null;

  function handleDotClick(resourceId: string, e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    const view = useViewStore.getState();
    view.selectNodes([nodeId]);
    view.revealInspector();
    view.expandInspectorSection('resources');
    view.setInspectorScrollToAssignmentId(resourceId);
  }

  return (
    <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-1">
      {assignments.map((a) => {
        const name = resourceNamesById.get(a.resourceId) ?? a.resourceId;
        const color = autoResourceColor(name, resourceNamesSorted);
        const title = a.count > 1 ? `${name} · ×${a.count}` : name;
        return (
          <button
            key={a.resourceId}
            type="button"
            aria-label={title}
            title={title}
            // React Flow starts a node-drag on mousedown over the node
            // body — stop it here so the dot click stays a click. Pointer-
            // down stop doesn't disable the subsequent click event, only
            // the drag-start gesture.
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => handleDotClick(a.resourceId, e)}
            className="w-2 h-2 rounded-full hover:scale-125 focus:scale-125 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 transition-transform"
            style={{ backgroundColor: color }}
          />
        );
      })}
    </div>
  );
}
