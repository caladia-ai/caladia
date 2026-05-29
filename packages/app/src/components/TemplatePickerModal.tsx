import { useEffect, useState } from 'react';
import { loadProjectFile } from '@procsim/file-format';
import type { ProjectFile, ProjectNode, ProjectEdge, Subsystem } from '@procsim/file-format';
import { useModalEscape } from '../hooks/useModalEscape.js';

/**
 * Phase 27 — Template picker modal.
 *
 * Card grid of fleshed-out starter projects. Each card shows a
 * description plus a live SVG schematic rendered from the template's
 * own `nodes[].position` + `edges` — no hand-authored thumbnails. That
 * keeps the preview honest: a 30-node template literally looks busier
 * than a 12-node one, and the thumbnail can't drift from the file.
 *
 * Selecting a template fetches the `.cala` from `/templates/<slug>.cala`
 * (served by Vite from `public/`), validates it via `loadProjectFile`,
 * and passes the parsed `ProjectFile` back to the caller. The caller
 * is responsible for the dirty-check confirm + the actual
 * `setProject(...)` mutation.
 */

type TemplateCategory = 'simple' | 'project' | 'large';

interface TemplateMeta {
  /** Filename slug (no extension). */
  slug: string;
  /** Display title. */
  title: string;
  /** 1–2 sentence description shown under the title. */
  description: string;
  /** Engine features this template demonstrates. */
  demos: string[];
  /** Picker section:
   *   'simple'  — generic, domain-neutral starters.
   *   'project' — industry-specific full projects.
   *   'large'   — Phase 49 Slice 7. Templates so large that grouping
   *                them separately keeps the picker scannable and
   *                hints at their compute weight before the user
   *                commits to loading one. */
  category: TemplateCategory;
}

const TEMPLATES: TemplateMeta[] = [
  // Start-simple section — domain-neutral starting points for users who
  // don't see themselves in any of the verticals below.
  {
    slug: 'simple-sequential',
    title: 'Simple Sequential Workflow',
    description:
      'The simplest useful project shape: plan → main work → polish → review → wrap up. Two roles, one decision, no domain language.',
    demos: [
      'Sequential dependencies',
      'A decision gate',
      'A duration distribution',
      'Resource basics',
    ],
    category: 'simple',
  },
  {
    slug: 'iterative-cycle',
    title: 'Iterative Cycle',
    description:
      'A pass-and-review loop: define goals → iterate (work → review) → finalize. Maps to research, design, drafting, refinement work in any field.',
    demos: ['Loops', 'Sampled iteration count', 'Two roles in tandem'],
    category: 'simple',
  },
  // Project-templates section — fleshed-out examples for verticals.
  {
    slug: 'software-feature-release',
    title: 'Software Feature Release',
    description:
      'A typical engineering-led feature release: spec → design review → parallel frontend / backend → code review → QA loop → deploy.',
    demos: [
      'Decision nodes',
      'Loops (QA cycle)',
      'Parallel work',
      'Duration distributions',
      'Compression options',
    ],
    category: 'project',
  },
  {
    slug: 'construction-project',
    title: 'Construction Project',
    description:
      'An office build-out broken into sub-systems (Foundation, Framing, MEP, Finishing) with realistic material costs and permit gates.',
    demos: ['Sub-systems', 'Fixed-cost line items', 'Resource leveling', 'Decision gates'],
    category: 'project',
  },
  {
    slug: 'marketing-campaign',
    title: 'Marketing Campaign',
    description:
      'A product launch with parallel channel tracks (paid / organic / PR / landing) converging on a single launch date.',
    demos: [
      'Parallel tracks',
      'Multi-resource activities',
      'Fixed-cost per channel',
      'Group labels',
    ],
    category: 'project',
  },
  {
    slug: 'clinical-trial',
    title: 'Clinical Trial / R&D',
    description:
      'A Phase II clinical trial heavy on regulatory uncertainty and recruitment variance — the canonical Monte Carlo showcase.',
    demos: [
      'Heavy distributions',
      'Decision gates (IRB, interim)',
      'Loops (protocol amendment)',
      'Compression options for expedited review',
    ],
    category: 'project',
  },
  {
    slug: 'event-launch',
    title: 'Event Launch / Conference',
    description:
      'A convergent tree to a fixed event date: venue, speakers, AV, catering, marketing — all merging into dry-run and event day.',
    demos: [
      'Convergent dependencies',
      'Multi-resource activities',
      'Parallelism',
      'Compression options for late expedites',
    ],
    category: 'project',
  },
  {
    slug: 'hiring-pipeline',
    title: 'Hiring Pipeline',
    description:
      'A typical engineering req: source → phone screen → four parallel interviews → debrief → offer. Models candidate-acceptance risk via a decision gate with a re-source failure delay.',
    demos: [
      'Parallel interview tracks',
      'Multi-resource debrief',
      'Decision gate with failure delay',
      'Distribution on sourcing time',
    ],
    category: 'project',
  },
  {
    slug: 'procurement-rfp',
    title: 'Procurement / RFP Cycle',
    description:
      'A vendor selection cycle: draft RFP → issue → three parallel vendor responses → evaluation → shortlist gate → contract → delivery. Lead-time variance on every long leg.',
    demos: [
      'Parallel vendor responses',
      'Multi-resource evaluation',
      'Decision gate',
      'Fixed-cost line items',
      'Lead-time distributions',
    ],
    category: 'project',
  },
  {
    slug: 'compliance-audit',
    title: 'Compliance Audit',
    description:
      'A regulatory audit: planning → parallel fieldwork (controls / docs / interviews) → consolidation → findings gate → remediation loop → final report.',
    demos: [
      'Parallel fieldwork tracks',
      'Remediation loop',
      'Findings-severity decision gate',
      'Re-test cycle',
    ],
    category: 'project',
  },
  {
    slug: 'ma-due-diligence',
    title: 'M&A Due Diligence',
    description:
      'Four parallel workstreams (Financial, Legal, Operations, IT) — each a drill-in sub-system — gated by LOI, Confirmatory DD, Regulatory clearance, and IC close approval. Seeded with the PE/Banking calendar (M–Sat 14h) and a $2M budget.',
    demos: [
      'Sub-systems per workstream',
      'Four decision gates with realistic failure delays',
      'PE/Banking work calendar (M–Sat 14h)',
      'Project budget + fixed-cost line items per workstream',
      'Walk-away delay on Confirmatory DD gate',
    ],
    category: 'project',
  },
  {
    slug: 'mbb-engagement',
    title: 'MBB Market Research Engagement',
    description:
      'A strategy-consulting cycle: hypothesis tree → parallel primary + secondary research → synthesis → initial deck → partner-review loop → final delivery.',
    demos: [
      'Four-tier resource hierarchy',
      'Review-cycle loop',
      'Parallel research streams',
      'Distributions on long-pole activities',
    ],
    category: 'project',
  },
  {
    slug: 'restaurant-launch',
    title: 'Restaurant / Store Launch',
    description:
      'A retail buildout converging on a grand-opening date: site → lease → parallel construction / equipment / signage → permits gate → hire & train → inventory → soft open → grand open.',
    demos: [
      'Parallel buildout tracks',
      'Fixed-cost line items (build / equipment / inventory / marketing)',
      'Permits decision gate',
      'Multi-resource training',
      'Weeks-unit display',
    ],
    category: 'project',
  },
  // Large-diagram showcase templates — kept separate from the
  // industry-specific 'project' tier because they're an order of
  // magnitude bigger than anything else in the picker. The 'large'
  // section is collapsed by default (see expanded-state init below)
  // so a first-time user isn't fronted with the longest scroll.
  {
    slug: 'oncology-drug-development',
    title: 'Oncology Drug Development',
    description:
      "Full ~15-year arc from pre-clinical discovery through FDA approval, launch, and post-marketing commitments. Eight phase sub-systems, ten resource pools, four loops with iteration variance, ten decision gates with realistic oncology pass probabilities, multi-million-dollar fixed costs with cost variance, and a $500M project budget. Built to showcase Caladia's risk-assessment depth.",
    demos: [
      '8 phase sub-systems',
      '4 loops (dose escalation, protocol amendments, DSMB, AdCom prep)',
      'Decision gates with realistic oncology pass rates',
      'Pivotal CRO contract with cost distribution',
      'Manufacturing extended-shift calendar',
      'Crash option on FDA review (Priority pathway)',
      '$500M project budget',
    ],
    category: 'large',
  },
  {
    // Slug stays `tentpole-feature-film` (matches the .cala file in
    // public/templates/); only the display title is shortened.
    slug: 'tentpole-feature-film',
    title: 'Feature Film',
    description:
      'A $150M studio feature from development through awards: greenlight → pre-production → principal photography → post → marketing → release → awards & long-tail. Seven phase sub-systems, ten resource pools (talent / crew / VFX / marketing), four loops (script revisions, reshoots, VFX revision rounds, trailer cuts), and ten decision gates with realistic feature-production pass rates. Talent fee + VFX + P&A are the three big cost lines, all with distributions. $200M project budget includes negative cost + marketing contingency.',
    demos: [
      '7 phase sub-systems (dev → awards)',
      '4 loops (script / reshoots / VFX rounds / trailer cuts)',
      'Studio greenlight + lead-attachment gates with high failure delays',
      'Lead-talent + VFX + P&A fixed costs with cost variance',
      'Production set Mon–Sat 12h calendar',
      'Set-construction crash option',
      '$200M project budget',
    ],
    category: 'large',
  },
];

const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  simple: 'Start simple',
  project: 'Project templates',
  large: 'Large diagrams',
};

/** Render order for the three sections. */
const CATEGORY_ORDER: ReadonlyArray<TemplateCategory> = ['simple', 'project', 'large'];

/** Phase 49 Slice 7 — default expanded state. Only Start simple opens
 *  expanded on modal mount; the other two sections start collapsed so
 *  the first-run picker reads as a short list, not a long scroll. The
 *  state is purely local to each modal lifetime — closing and reopening
 *  resets to this default. */
const DEFAULT_EXPANDED: Record<TemplateCategory, boolean> = {
  simple: true,
  project: false,
  large: false,
};

interface TemplatePickerModalProps {
  onPick(project: ProjectFile): void;
  /**
   * Phase 38 — fires when the user picks the synthetic "Blank diagram"
   * entry. The picker stays decoupled from `makeDefaultProject` (and
   * thus from the domain store); the caller supplies the actual blank
   * project on click.
   */
  onPickBlank(): void;
  onClose(): void;
}

export function TemplatePickerModal({ onPick, onPickBlank, onClose }: TemplatePickerModalProps) {
  // Audit I-21 — Esc closes the picker (routed through modalStack so
  // only the top-most modal responds when layered).
  useModalEscape(onClose);

  const [loadingSlug, setLoadingSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Phase 49 Slice 7 — collapse state per section. Resets to
  // DEFAULT_EXPANDED every time the modal mounts (parent re-mounts
  // the modal on each open, so this useState seeds fresh) — that's
  // the behaviour the user wanted: first launch always shows Start
  // simple expanded, the other two collapsed.
  const [expanded, setExpanded] = useState<Record<TemplateCategory, boolean>>(DEFAULT_EXPANDED);
  function toggleSection(cat: TemplateCategory) {
    setExpanded((prev) => ({ ...prev, [cat]: !prev[cat] }));
  }

  // Lazy-fetch each template once when the modal opens so the live SVG
  // thumbnail has the topology to render. Templates are tiny (~5KB each),
  // so a single batch fetch is fine on modal open.
  const [parsedByslug, setParsedBySlug] = useState<Record<string, ProjectFile>>({});

  useEffect(() => {
    let cancelled = false;
    async function loadAll() {
      const entries: Array<[string, ProjectFile]> = [];
      for (const t of TEMPLATES) {
        try {
          const res = await fetch(`/templates/${t.slug}.cala`);
          if (!res.ok) continue;
          const json = await res.text();
          const parsed = loadProjectFile(json);
          if (parsed.ok) entries.push([t.slug, parsed.project]);
        } catch {
          // Best-effort — a missing thumbnail isn't fatal; the card still
          // renders with a placeholder.
        }
      }
      if (!cancelled) {
        setParsedBySlug(Object.fromEntries(entries));
      }
    }
    void loadAll();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handlePick(slug: string) {
    setError(null);
    setLoadingSlug(slug);
    try {
      // Prefer the already-parsed copy from the thumbnail fetch; fall
      // back to a fresh fetch if it somehow wasn't loaded yet.
      const existing = parsedByslug[slug];
      if (existing) {
        onPick(existing);
        return;
      }
      const res = await fetch(`/templates/${slug}.cala`);
      if (!res.ok) {
        throw new Error(`Could not load template (HTTP ${res.status})`);
      }
      const json = await res.text();
      const parsed = loadProjectFile(json);
      if (!parsed.ok) {
        throw new Error(
          'Template file failed validation: ' +
            parsed.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join(' • '),
        );
      }
      onPick(parsed.project);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingSlug(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Surface uses `dark:bg-gray-800` rather than `dark:bg-gray-900` so
          the modal sits visibly above the canvas pane (`gray-900`-ish) and
          the backdrop. With `gray-900` the modal blended into the canvas
          and looked unowned. `gray-700` border + heavier shadow give the
          card more elevation in dark mode without changing light mode. */}
      <div
        className="relative w-[min(900px,94vw)] max-h-[88vh] flex flex-col bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl dark:shadow-[0_20px_50px_-10px_rgba(0,0,0,0.7)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-700">
          <div>
            <div className="text-[15px] font-semibold text-gray-900 dark:text-gray-100">
              Start from a template
            </div>
            <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-0.5">
              Each template demonstrates a different set of features. Pick one to load it as your
              project.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-700 w-[22px] h-[22px] max-md:w-11 max-md:h-11 inline-flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            aria-label="Cancel"
          >
            ×
          </button>
        </div>

        {/* Sections: Start simple → Project templates → Large diagrams.
            Order within each section preserves TEMPLATES authoring order.
            Phase 49 Slice 7 — each heading is a button that toggles
            expand/collapse for its section; the card grid renders only
            when expanded. Default state: only Start simple expanded. */}
        <div className="flex-1 overflow-auto px-6 py-4 flex flex-col gap-5">
          {CATEGORY_ORDER.map((cat) => {
            const inCategory = TEMPLATES.filter((t) => t.category === cat);
            const isOpen = expanded[cat];
            const headingId = `template-section-${cat}`;
            const regionId = `template-section-${cat}-content`;
            return (
              <section key={cat} className="flex flex-col gap-3">
                <h3 className="text-[13px]">
                  <button
                    type="button"
                    id={headingId}
                    aria-expanded={isOpen}
                    aria-controls={regionId}
                    onClick={() => toggleSection(cat)}
                    className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 transition-colors"
                  >
                    <span
                      aria-hidden
                      className={[
                        'inline-block text-[10px] leading-none transition-transform',
                        isOpen ? 'rotate-90' : '',
                      ].join(' ')}
                    >
                      ▶
                    </span>
                    {CATEGORY_LABELS[cat]}
                  </button>
                </h3>
                {isOpen && (
                  <div
                    id={regionId}
                    role="region"
                    aria-labelledby={headingId}
                    className="grid grid-cols-1 sm:grid-cols-2 gap-3"
                  >
                    {/* Phase 38 — synthetic "Blank diagram" entry at the
                      head of the Start-simple section. No slug to fetch;
                      click delegates to the caller-supplied onPickBlank. */}
                    {cat === 'simple' && (
                      <button
                        type="button"
                        onClick={() => onPickBlank()}
                        className="flex flex-col items-stretch gap-2 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-emerald-400 dark:hover:border-emerald-500 bg-white dark:bg-gray-900 hover:bg-emerald-50/40 dark:hover:bg-emerald-950/20 p-3 text-left transition-colors"
                      >
                        <div className="rounded border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 overflow-hidden aspect-[16/9] flex items-center justify-center">
                          <span className="text-[28px] leading-none text-gray-300 dark:text-gray-700">
                            +
                          </span>
                        </div>
                        <div className="text-[13px] font-medium text-gray-900 dark:text-gray-100">
                          Blank diagram
                        </div>
                        <p className="text-[11.5px] text-gray-500 dark:text-gray-400 leading-snug">
                          Start fresh with a single placeholder activity — build the rest of the
                          project from there.
                        </p>
                        <div className="flex flex-wrap gap-1 mt-auto">
                          <span className="text-[10px] text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded px-1.5 py-0.5">
                            Empty canvas
                          </span>
                        </div>
                      </button>
                    )}
                    {inCategory.map((t) => {
                      const parsed = parsedByslug[t.slug];
                      const busy = loadingSlug === t.slug;
                      return (
                        <button
                          key={t.slug}
                          type="button"
                          disabled={busy}
                          onClick={() => void handlePick(t.slug)}
                          className="flex flex-col items-stretch gap-2 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-emerald-400 dark:hover:border-emerald-500 bg-white dark:bg-gray-900 hover:bg-emerald-50/40 dark:hover:bg-emerald-950/20 p-3 text-left transition-colors disabled:opacity-50 disabled:cursor-progress"
                        >
                          {/* Thumbnail */}
                          <div className="rounded border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 overflow-hidden aspect-[16/9]">
                            {parsed ? (
                              <TemplateThumbnail
                                nodes={parsed.nodes}
                                edges={parsed.edges}
                                subsystems={parsed.subsystems}
                              />
                            ) : (
                              <div className="h-full w-full flex items-center justify-center text-[11px] text-gray-400 dark:text-gray-600">
                                Loading…
                              </div>
                            )}
                          </div>
                          {/* Text */}
                          <div className="text-[13px] font-medium text-gray-900 dark:text-gray-100">
                            {t.title}
                          </div>
                          <p className="text-[11.5px] text-gray-500 dark:text-gray-400 leading-snug">
                            {t.description}
                          </p>
                          <div className="flex flex-wrap gap-1 mt-auto">
                            {t.demos.map((d) => (
                              <span
                                key={d}
                                className="text-[10px] text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded px-1.5 py-0.5"
                              >
                                {d}
                              </span>
                            ))}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        {error && (
          <div className="px-6 py-2 text-[11.5px] text-red-600 dark:text-red-400 border-t border-gray-100 dark:border-gray-700">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Thumbnail ────────────────────────────────────────────────────────────────

interface TemplateThumbnailProps {
  nodes: ReadonlyArray<ProjectNode>;
  edges: ReadonlyArray<ProjectEdge>;
  /**
   * Subsystems carry their body nodes' ids. Body nodes live in the
   * subsystem's internal coordinate space and are NOT visible on the
   * parent canvas — only the container (a node with `nodeType ===
   * 'subsystem'`) is. The thumbnail mirrors parent-canvas semantics by
   * filtering body nodes out before rendering, so the schematic shows
   * exactly what the user would see when they first open the project.
   */
  subsystems: ReadonlyArray<Subsystem>;
}

/**
 * Tiny schematic of a template's topology, drawn from the actual
 * `nodes[].position` + `edges`. Sized via SVG viewBox so it scales
 * uniformly inside the card's aspect-[16/9] container.
 *
 * Phase 38 — Subsystem container nodes are rendered as small shaded
 * rectangles so users can see where sub-systems sit in the topology
 * (the previous behaviour silently dropped them, which left obvious
 * gaps on diagrams like the Construction template). The body nodes
 * INSIDE each subsystem are filtered out — they live in the
 * subsystem's internal coordinate space and would otherwise float
 * above the parent-canvas layout (the regression flagged on the
 * Construction thumbnail). Edges that span body nodes drop with them.
 */
function TemplateThumbnail({ nodes, edges, subsystems }: TemplateThumbnailProps) {
  // Filter out subsystem body nodes — only the container (nodeType ===
  // 'subsystem') is visible on the parent canvas. Use the project's
  // `subsystems` array as the source of truth rather than guessing from
  // node positions; the data model is unambiguous.
  const bodyNodeIds = new Set<string>();
  for (const sub of subsystems) {
    for (const id of sub.bodyNodeIds) bodyNodeIds.add(id);
  }
  const visibleNodes = nodes.filter((n) => !bodyNodeIds.has(n.id));
  const nodeById = new Map(visibleNodes.map((n) => [n.id, n]));

  if (visibleNodes.length === 0) {
    return null;
  }

  // Compute bounds from the visible node positions.
  const xs = visibleNodes.map((n) => n.position.x);
  const ys = visibleNodes.map((n) => n.position.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // Defensive: avoid zero-range when everything is at one point.
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);

  const PAD = 20;
  const VBOX_W = 320;
  const VBOX_H = 180;
  // Scale to fit inside the viewBox padding.
  const scale = Math.min((VBOX_W - 2 * PAD) / w, (VBOX_H - 2 * PAD) / h);
  const offsetX = (VBOX_W - w * scale) / 2 - minX * scale;
  const offsetY = (VBOX_H - h * scale) / 2 - minY * scale;
  function px(n: ProjectNode): { x: number; y: number } {
    return {
      x: n.position.x * scale + offsetX,
      y: n.position.y * scale + offsetY,
    };
  }

  function dotForType(t: ProjectNode['nodeType']): { r: number; cls: string } {
    switch (t) {
      case 'start':
      case 'end':
        return { r: 4, cls: 'fill-gray-400 dark:fill-gray-500' };
      case 'decision':
        return { r: 4, cls: 'fill-amber-500 dark:fill-amber-400' };
      default:
        return { r: 3.5, cls: 'fill-emerald-500 dark:fill-emerald-400' };
    }
  }

  // Subsystem container glyph: a shaded rectangle centred at the node's
  // position, sized to be distinguishable from the activity dot without
  // dominating the thumbnail.
  const SUB_W = 14;
  const SUB_H = 9;

  return (
    <svg viewBox={`0 0 ${VBOX_W} ${VBOX_H}`} className="w-full h-full">
      {/* Edges first so they render under the nodes. */}
      {edges.map((e) => {
        const from = nodeById.get(e.from);
        const to = nodeById.get(e.to);
        if (!from || !to) return null;
        const a = px(from);
        const b = px(to);
        return (
          <line
            key={e.id}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="currentColor"
            strokeWidth={0.7}
            className="text-gray-300 dark:text-gray-700"
          />
        );
      })}
      {visibleNodes.map((n) => {
        const p = px(n);
        if (n.nodeType === 'subsystem') {
          return (
            <rect
              key={n.id}
              x={p.x - SUB_W / 2}
              y={p.y - SUB_H / 2}
              width={SUB_W}
              height={SUB_H}
              rx={1.5}
              ry={1.5}
              className="fill-gray-300 dark:fill-gray-600 stroke-gray-400 dark:stroke-gray-500"
              fillOpacity={0.55}
              strokeWidth={0.7}
            />
          );
        }
        const dot = dotForType(n.nodeType);
        return <circle key={n.id} cx={p.x} cy={p.y} r={dot.r} className={dot.cls} />;
      })}
    </svg>
  );
}
