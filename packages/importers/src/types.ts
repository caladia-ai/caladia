/**
 * Shared types for the importers package.
 *
 * An ImportResult is the output of any parser (parseMsProjectXml,
 * parseExcelGantt, parsePptxDiagram). It contains:
 *   - A typed ImportDraft that maps closely to the Caladia schema but
 *     allows partial/optional fields wherever the source is ambiguous.
 *   - An AmbiguityList that names every field or record that could not
 *     be resolved deterministically. The LLM step resolves these.
 *
 * The importers are pure functions — no DOM, no Node.js fs, no network.
 * They accept raw bytes (string or ArrayBuffer) and return plain data.
 */

// ── Duration ──────────────────────────────────────────────────────────────────

export type DurationUnit = 'hours' | 'days' | 'weeks';

export interface ImportedDuration {
  value: number;
  unit: DurationUnit;
}

// ── Resource assignment ───────────────────────────────────────────────────────

export interface ImportedResourceAssignment {
  resourceId: string;
  count: number;
  calendarPolicy?: 'intersection' | 'resourceWins' | 'activityWins';
}

// ── Node ──────────────────────────────────────────────────────────────────────

export type ImportedNodeType = 'activity' | 'start' | 'end' | 'decision';

export interface ImportedNode {
  id: string;
  name: string;
  nodeType: ImportedNodeType;
  duration: ImportedDuration;
  /** Canvas position hint (may be 0,0 if source has no layout info) */
  position: { x: number; y: number };
  consumesResources: boolean;
  resourceAssignments: ImportedResourceAssignment[];
  /** Only for decision nodes */
  passProbability?: number;
  /** Only for decision nodes */
  failureDelay?: ImportedDuration;
  /** Raw notes / description from the source for LLM context */
  notes?: string;
}

// ── Edge ─────────────────────────────────────────────────────────────────────

export type ImportedEdgeType = 'FS' | 'SS' | 'FF' | 'SF';

export interface ImportedEdge {
  id: string;
  from: string;
  to: string;
  type: ImportedEdgeType;
  lag: ImportedDuration;
}

// ── Resource ─────────────────────────────────────────────────────────────────

export interface ImportedResource {
  id: string;
  name: string;
  capacity: number;
}

// ── Draft ─────────────────────────────────────────────────────────────────────

/**
 * Partial representation of a Caladia project extracted from a source file.
 * Fields that could not be resolved are either absent or set to a safe default.
 * The LLM step (guided by caladia-authoring-skill.md) fills in any gaps.
 */
export interface ImportDraft {
  /** Suggested project name from source metadata */
  projectName?: string;
  /** Suggested start date in YYYY-MM-DD, if found in source */
  startDate?: string;
  nodes: ImportedNode[];
  edges: ImportedEdge[];
  resources: ImportedResource[];
}

// ── Ambiguities ───────────────────────────────────────────────────────────────

/**
 * A single ambiguity or information gap in the parsed draft.
 * These are bundled into the skill prompt so the LLM can resolve them.
 */
export interface AmbiguityItem {
  /** Short machine-readable code, e.g. 'MISSING_DURATION' */
  code: string;
  /** Human-readable description for the LLM */
  message: string;
  /** IDs of affected nodes/edges */
  affectedIds: string[];
}

// ── Result ────────────────────────────────────────────────────────────────────

export type ImportResult =
  | { ok: true; draft: ImportDraft; ambiguities: AmbiguityItem[] }
  | { ok: false; errors: string[] };
