import { useEffect, useRef, useState } from 'react';
import type { ProjectFile } from '@procsim/file-format';
import { QUICK_START_TEMPLATES, loadTemplateBySlug } from '../lib/templates.js';
import { TemplateThumbnail } from './TemplatePickerModal.js';

/**
 * First-run quick-start box, shown beside the onboarding welcome card on
 * desktop. Each curated starter shows a live schematic thumbnail (the same
 * one the full picker draws); one click loads it. The full library is a click
 * away via the card's "Browse all templates".
 *
 * `active` gates the batch fetch so returning users — who never see the
 * overlay — don't pull the template files on every page load.
 */
export function QuickStartTemplates({
  active,
  onPick,
}: {
  active: boolean;
  onPick: (project: ProjectFile) => void;
}) {
  const [loaded, setLoaded] = useState<Record<string, ProjectFile>>({});
  const startedRef = useRef(false);

  useEffect(() => {
    if (!active || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    void (async () => {
      const results = await Promise.all(
        QUICK_START_TEMPLATES.map(async (t) => {
          try {
            return [t.slug, await loadTemplateBySlug(t.slug)] as const;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const map: Record<string, ProjectFile> = {};
      for (const r of results) if (r) map[r[0]] = r[1];
      setLoaded(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  return (
    <div className="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl p-4">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Quick start</h3>
      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Open a ready-made example.</p>
      <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
        {QUICK_START_TEMPLATES.map((t) => {
          const project = loaded[t.slug];
          return (
            <button
              key={t.slug}
              type="button"
              disabled={!project}
              onClick={() => project && onPick(project)}
              className="shrink-0 w-44 flex flex-col gap-1 rounded-md p-1 text-left hover:bg-gray-100 dark:hover:bg-gray-800 disabled:cursor-progress transition-colors"
            >
              <div className="aspect-[16/9] overflow-hidden rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60">
                {project ? (
                  <TemplateThumbnail
                    nodes={project.nodes}
                    edges={project.edges}
                    subsystems={project.subsystems}
                  />
                ) : null}
              </div>
              <div className="text-xs text-gray-700 dark:text-gray-300">{t.title}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
