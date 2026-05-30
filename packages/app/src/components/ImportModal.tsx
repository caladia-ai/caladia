/**
 * ImportModal — shown after parsing an external project file (MS Project XML,
 * Excel Gantt, or PPTX diagram).
 *
 * Displays:
 *  • Parse summary (node / edge / resource counts)
 *  • Ambiguity list (items the LLM authoring skill should resolve)
 *  • "Copy AI Prompt" button — copies a ready-to-paste AI prompt to the
 *    clipboard that includes the ImportDraft JSON and asks an AI assistant
 *    to produce a valid Caladia project file.
 */

import { useState } from 'react';
import type { ImportResult, ImportDraft, AmbiguityItem } from '@procsim/importers';
import { useModalEscape } from '../hooks/useModalEscape.js';

interface ImportModalProps {
  result: ImportResult;
  fileName: string;
  onClose: () => void;
}

// ── AI prompt builder ─────────────────────────────────────────────────────────

function buildAIPrompt(draft: ImportDraft, ambiguities: AmbiguityItem[]): string {
  const ambigSection =
    ambiguities.length === 0
      ? '(none — all fields were parsed successfully)'
      : ambiguities
          .map(
            (a, i) =>
              `${i + 1}. [${a.code}] ${a.message}${
                a.affectedIds.length ? ` (affected: ${a.affectedIds.join(', ')})` : ''
              }`,
          )
          .join('\n');

  return `\
You are helping import a project plan into Caladia, a business-process simulation tool.

Your task:
1. Review the ImportDraft JSON below (produced by automatic file parsing).
2. Resolve every ambiguity listed in the "Ambiguities" section.
3. Produce a complete, valid Caladia project file JSON (version 3).

─── Layout convention ────────────────────────────────────────────────────────
Positions are React Flow canvas pixels, given as the node's TOP-LEFT corner.
Node types render at different heights, so to make a horizontal chain look
straight, compute \`y\` so every node's VISUAL CENTER lands on the same spine:

  nodeType    rendered height
  start         56 px
  end           56 px
  activity      60 px
  subsystem     64 px
  decision     120 px   ← twice as tall — needs y = spine_center − 60

For a spine centered at y = 250, set:
  start/end y = 222   activity y = 220   subsystem y = 218   decision y = 190

For branches fanning out from one parent, distribute them symmetrically
above and below the spine center with AT LEAST 200-px spacing between
adjacent branch rows. The same spacing applies on the FAN-IN side: when
multiple branches converge back into a single merge node, keep each
branch at its row position all the way through the merge — don't squeeze
the rows closer as they approach the merge point. (Tighter spacing —
e.g. 150 px — leaves only a 90-px gap between 60-px activity boxes and
reads as cramped on wide canvases, especially with three or more
branches converging.)

  Two branches  → centers at spine ±200 (activity y = 20 above,
                   y = 420 below for spine 250).
  Four branches → ±300 outer, ±100 inner (centers e.g. 50/250/450/650
                   for spine 350).

The activity y for a branch whose center is at C is y = C − 30. Negative
y is fine — React Flow coordinates are unbounded and fitView handles
off-origin nodes.

Horizontal: ~180 px between sequential spine nodes for purely horizontal
flow. Siblings that share a parent (fan-out) share the same x.

At FAN-OUT or FAN-IN points, the horizontal gap between the fan node
and the branch column must scale with the branch column's VERTICAL
extent — otherwise edges go nearly vertical. Aim for slope ≤ 1:1 on
the longest edge (vertical_jump ÷ horizontal_gap ≤ 1):

  2 branches at spine ±200 (vertical extent 400 px) → 200-px gap
  4 branches at ±300/±100 (vertical extent 600 px) → 300-px gap
  Asymmetric fan-in with one 300-px-drop arm     → 300-px gap

When a loop wraps body nodes, leave a 60-px gap between the body and
its non-loop neighbour (use 220 instead of 180 across the loop
boundary) — the rendered loop frame extends ~28 px past the body
bounding rect.

─── Output format (version 3) ─────────────────────────────────────────────────
{
  "kind": "caladia-project",
  "version": 3,
  "currency": "USD",                    // 3-letter ISO 4217 code (required)
  "fxSnapshotVersion": "2026.1",        // pinned FX snapshot version (required)
  "project": {
    "name": "<string>",
    "startDate": "YYYY-MM-DD",          // ISO date, local time
    "defaultCalendarId": "cal-default", // must match a calendar id below
    "displayUnit": "hours" | "days" | "weeks"
  },
  "calendars": [                        // at least one calendar required
    {
      "id": "cal-default",
      "name": "Mon–Fri 8h",
      "workingDays": [false, true, true, true, true, true, false],  // Sun…Sat
      "hoursPerDay": 8,
      "daysPerWeek": 5,
      "holidayPreset": "NONE",          // or "US_FEDERAL" / "CANADA_FEDERAL" / "EU_COMMON"
      "holidayPresetVersion": "1.0",    // any string when preset is NONE
      "exceptions": []                  // per-date overrides {date, type, name}
    }
  ],
  "resources": [
    {
      "id": "<string>",
      "name": "<string>",
      "capacity": <integer ≥ 1>,        // simultaneous-unit limit
      "calendarId": "cal-default",      // must reference a calendar
      "costRate": <number ≥ 0>          // optional: per working hour
    }
  ],
  "nodes": [
    {
      "id": "<string>",
      "name": "<string>",
      "nodeType": "activity" | "decision" | "start" | "end" | "subsystem",
      "duration": { "value": <number ≥ 0>, "unit": "hours" | "days" | "weeks" },
      // activity / decision: value > 0.  start / end / subsystem: value === 0.
      "position": { "x": <number>, "y": <number> },  // see Layout convention
      "calendarId": null,               // null = inherit project default
      "consumesResources": <boolean>,   // false for wait-states (approval, delivery)
      "resourceAssignments": [
        {
          "resourceId": "<string>",     // must reference a resource id
          "count": <integer ≥ 1>,
          "calendarPolicy": "intersection" | "resourceWins" | "activityWins",
          "parallelism": <0..1>         // optional: 0 = independent, 1 = perfect parallel
        }
      ],
      // Optional Monte Carlo duration distribution:
      "distribution": { "type": "triangular", "min": <num>, "mode": <num>, "max": <num> },
      //   or { "type": "pert-beta", "min", "mode", "max" }
      //   or { "type": "normal", "mean": <num>, "stddev": <num > 0> }
      // Decision-only:
      "passProbability": <0..1>,        // omit on non-decision nodes
      "failureDelay": { "value": <num ≥ 0>, "unit": "hours" }  // decision-only
    }
  ],
  "edges": [
    {
      "id": "<string>",
      "from": "<node id>",
      "to": "<node id>",
      "type": "FS" | "SS" | "FF" | "SF",      // FS is by far the most common
      "lag": { "value": <number>, "unit": "hours" }  // signed: + gap, − overlap
    }
  ],
  "loops": [],          // optional — see docs/caladia-authoring-skill.md
  "subsystems": [],     // optional — see docs/caladia-authoring-skill.md
  "scenarios": []       // optional — leave empty
}

─── ImportDraft ───────────────────────────────────────────────────────────────
${JSON.stringify(draft, null, 2)}

─── Ambiguities ───────────────────────────────────────────────────────────────
${ambigSection}

Please return ONLY the complete Caladia project JSON (no commentary, no markdown fences).
`;
}

// ── Modal component ───────────────────────────────────────────────────────────

export function ImportModal({ result, fileName, onClose }: ImportModalProps) {
  const [copied, setCopied] = useState(false);

  if (!result.ok) {
    return (
      <ModalShell title="Import Failed" onClose={onClose}>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
          Could not parse <code className="font-mono text-xs">{fileName}</code>:
        </p>
        <ul className="text-sm text-red-600 dark:text-red-400 space-y-1 list-disc list-inside">
          {result.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
        <div className="mt-5 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            Close
          </button>
        </div>
      </ModalShell>
    );
  }

  const { draft, ambiguities } = result;
  const nodeCount = draft.nodes.length;
  const edgeCount = draft.edges.length;
  const resCount = draft.resources.length;

  async function handleCopy() {
    const prompt = buildAIPrompt(draft, ambiguities);
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  return (
    <ModalShell title="Import Complete" onClose={onClose}>
      {/* Summary row */}
      <div className="flex gap-4 mb-4 text-sm">
        <Stat label="Nodes" value={nodeCount} />
        <Stat label="Edges" value={edgeCount} />
        <Stat label="Resources" value={resCount} />
      </div>

      {/* Ambiguities */}
      {ambiguities.length > 0 ? (
        <div className="mb-4">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide mb-2">
            {ambiguities.length} ambiguit{ambiguities.length === 1 ? 'y' : 'ies'} to resolve
          </p>
          <ul className="max-h-52 overflow-y-auto space-y-1.5 text-xs text-gray-600 dark:text-gray-400 pr-1">
            {ambiguities.map((a, i) => (
              <li
                key={i}
                className="rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-100 dark:border-amber-900/40 px-2 py-1.5"
              >
                <span className="font-mono text-amber-700 dark:text-amber-400 mr-1.5">
                  [{a.code}]
                </span>
                {a.message}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-green-600 dark:text-green-400 mb-4">
          ✓ No ambiguities — all fields parsed cleanly.
        </p>
      )}

      {/* Instructions */}
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 leading-relaxed">
        Copy the AI prompt below and paste it into an AI assistant (ChatGPT, Claude, Gemini, etc.).
        It will resolve the ambiguities and produce a ready-to-open Caladia project file.
      </p>

      {/* Actions */}
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          Close
        </button>
        <button
          onClick={() => void handleCopy()}
          className={[
            'px-4 py-2 text-sm rounded-md font-medium transition-colors',
            copied ? 'bg-green-600 text-white' : 'bg-blue-600 text-white hover:bg-blue-700',
          ].join(' ')}
        >
          {copied ? '✓ Copied!' : 'Copy AI Prompt'}
        </button>
      </div>
    </ModalShell>
  );
}

// ── ValidateModal ─────────────────────────────────────────────────────────────

interface ValidateModalProps {
  /** null = loading, string[] = errors (empty = valid) */
  errors: string[] | null;
  fileName: string;
  onClose: () => void;
}

export function ValidateModal({ errors, fileName, onClose }: ValidateModalProps) {
  const isValid = errors !== null && errors.length === 0;
  const isLoading = errors === null;

  return (
    <ModalShell title="Validate .cala File" onClose={onClose}>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-3 truncate">
        File: <code className="font-mono text-xs">{fileName}</code>
      </p>

      {isLoading && <p className="text-sm text-gray-500 dark:text-gray-400">Validating…</p>}

      {!isLoading && isValid && (
        <p className="text-sm font-medium text-green-600 dark:text-green-400">
          ✓ Valid Caladia project file
        </p>
      )}

      {!isLoading && !isValid && errors && errors.length > 0 && (
        <ul className="text-sm text-red-600 dark:text-red-400 space-y-1 list-disc list-inside max-h-52 overflow-y-auto">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      <div className="mt-5 flex justify-end">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          Close
        </button>
      </div>
    </ModalShell>
  );
}

// ── Shared primitives ─────────────────────────────────────────────────────────

function ModalShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  // Audit I-21 — Esc closes the modal. Covers both ImportModal and
  // ValidateModal since both render through this shell. Routed through
  // modalStack so only the top-most modal responds when layered.
  useModalEscape(onClose);
  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg max-md:max-w-none mx-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none max-md:w-11 max-md:h-11 max-md:inline-flex max-md:items-center max-md:justify-center"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col items-center rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 px-4 py-2 min-w-[5rem]">
      <span className="text-lg font-bold text-gray-900 dark:text-gray-100">{value}</span>
      <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
    </div>
  );
}
