import {
  ProjectFileV1,
  ProjectFileV2,
  ProjectFileV3,
  ProjectFileV4,
  ProjectFileV5,
  ProjectFileV6,
  ProjectFileV7,
  ProjectFileV8,
  SCHEMA_LIMITS,
  SubsystemFileV1,
  SubsystemFileV2,
  SubsystemFileV3,
  SubsystemFileV4,
  type ProjectFile,
  type SubsystemFile,
  type HolidayPresetId,
} from './schema.js';
import { latestPresetVersion } from './presets.js';
import { LATEST_FX_SNAPSHOT_VERSION } from './currency.js';
import { LATEST_BUNDLED_SNAPSHOT, listBundledSnapshotVersions } from './fx.js';

export interface ValidationError {
  path: string;
  message: string;
}

export interface PresetUpdate {
  calendarId: string;
  calendarName: string;
  presetId: HolidayPresetId;
  currentVersion: string;
  latestVersion: string;
}

/**
 * Emitted on load when a free-text field exceeded its configured cap and
 * was silently truncated to the cap length. Identifiers and structural
 * references are never truncated — the schema hard-rejects oversized ones.
 *
 * Surfaced via LoadResult.truncationWarnings so the UI can show a
 * non-blocking notice ("3 fields were truncated on load"). The data is
 * still loaded; only the contents of the named fields are clipped.
 */
export interface TruncationWarning {
  /** Human-readable path to the offending field, e.g. "nodes[3].description". */
  path: string;
  /** Short field name for sorting / grouping in the UI, e.g. "description". */
  field: string;
  /** Length of the value as received on disk. */
  originalLength: number;
  /** Length the value was truncated to. */
  truncatedTo: number;
}

/**
 * Phase 19 — set on a successful load when the project's pinned
 * `fxSnapshotVersion` is older than the latest bundled snapshot. The UI
 * surfaces a non-intrusive banner ("Currency rates have a newer snapshot
 * — review and re-pin?") with a diff view + Accept button.
 *
 * Absent when:
 *   - the project is pinned to the latest version,
 *   - the project's version is unknown to this build (forward-compat —
 *     don't suggest downgrading),
 *   - the project pins to `'NONE'` (user explicitly opted out).
 */
export interface FxSnapshotUpdate {
  currentVersion: string;
  latestVersion: string;
}

export type LoadResult =
  | {
      ok: true;
      project: ProjectFile;
      presetUpdatesAvailable: PresetUpdate[];
      fxUpdatesAvailable?: FxSnapshotUpdate;
      /** Present (and non-empty) when one or more free-text fields were
       *  truncated to fit their configured cap. Absent when no truncation
       *  happened. See TruncationWarning for the field shape. */
      truncationWarnings?: TruncationWarning[];
    }
  | { ok: false; errors: ValidationError[] };

export type LoadSubsystemResult =
  | {
      ok: true;
      subsystem: SubsystemFile;
      truncationWarnings?: TruncationWarning[];
    }
  | { ok: false; errors: ValidationError[] };

// Re-export the inferred v1 / v2 types only inside this module — we don't
// want zod leaking into the public surface, and callers always receive the
// current ProjectFile type (v3) regardless of what was on disk.
import type { z } from 'zod';

// ── Migration ─────────────────────────────────────────────────────────────────

/**
 * Migrate a v1 project to v2 in-memory. Adds the `subsystems: []` array that
 * Phase 12 introduces. No semantic change for projects without sub-systems.
 * Idempotent under chained migration (v2 → v3 happens separately via
 * `migrateV2ToV3`).
 */
export function migrateV1ToV2(v1: z.infer<typeof ProjectFileV1>): z.infer<typeof ProjectFileV2> {
  return { ...v1, kind: 'caladia-project' as const, version: 2 as const, subsystems: [] };
}

/**
 * Migrate a v2 project to v3 in-memory. Stamps `version: 3`, sets
 * `currency: 'USD'` (the most-common default; users change it in Settings),
 * and pins `fxSnapshotVersion` to the latest bundled snapshot at the time
 * the migration ran. Resource cost fields and node `fixedCost` are absent
 * on legacy data → engine treats both as zero, no behavioural change.
 */
export function migrateV2ToV3(v2: z.infer<typeof ProjectFileV2>): z.infer<typeof ProjectFileV3> {
  return {
    ...v2,
    version: 3 as const,
    currency: 'USD',
    fxSnapshotVersion: LATEST_FX_SNAPSHOT_VERSION,
  };
}

/**
 * Migrate a v3 project to v4 in-memory. Stamps `version: 4`. The
 * `durationSemantic` field on every node has already been filled in by
 * NodeSchema's .default('time') during the v3 parse, so the migration is
 * a pure version-stamp bump — no per-node walk needed, and pre-Phase-40
 * scheduling stays byte-for-byte identical.
 */
export function migrateV3ToV4(v3: z.infer<typeof ProjectFileV3>): z.infer<typeof ProjectFileV4> {
  return { ...v3, version: 4 as const };
}

/**
 * Migrate a v4 project to v5 in-memory. Stamps `version: 5`. The
 * `shareMode` field on `project` has already been filled in by
 * ProjectSettingsSchema's .default('percentage') during the v4 parse, so
 * this is a pure version-stamp bump — no per-assignment walk needed.
 * No `share` values are introduced; the share invariants in v5's
 * superRefine are vacuously satisfied for any legacy file (no shares =
 * legacy mode for every node).
 */
export function migrateV4ToV5(v4: z.infer<typeof ProjectFileV4>): z.infer<typeof ProjectFileV5> {
  return { ...v4, version: 5 as const };
}

/**
 * Migrate a v5 project to v6 in-memory. Stamps `version: 6` and seeds
 * `comments: []`. V5 files have no comment data — pre-Phase-49 builds
 * never produced any — so the empty array exactly matches what a v6
 * file looks like for a project the user hasn't annotated.
 */
export function migrateV5ToV6(v5: z.infer<typeof ProjectFileV5>): z.infer<typeof ProjectFileV6> {
  return { ...v5, version: 6 as const, comments: [] };
}

/**
 * Migrate a v6 project to v7 in-memory. Phase 50 Slice 3.5b — for every
 * subsystem in the input, auto-injects a Simulink-style structural pair:
 * a `subsystemEntry` node just upstream of the current entry and a
 * `subsystemExit` node just downstream of the current exit. The pair is
 * spliced into `bodyNodeIds`; bookend internal edges (structuralEntry →
 * currentEntry, currentExit → structuralExit) keep timing identical
 * (both new nodes are zero-duration anchors). External edges still
 * attach to the container — the structural nodes are pure-internal.
 *
 * After migration, `sub.entryNodeId` and `sub.exitNodeId` reference the
 * structural nodes; the original "natural" entry/exit are derivable from
 * the structural node's single outgoing/incoming internal edge.
 *
 * Deterministic when `idSource` is supplied (tests pass a counter). In
 * production the default source uses `crypto.randomUUID()`.
 */
export function migrateV6ToV7(
  v6: z.infer<typeof ProjectFileV6>,
  idSource: () => string = () => crypto.randomUUID(),
): z.infer<typeof ProjectFileV7> {
  if (v6.subsystems.length === 0) {
    // Common path for projects without subsystems — pure version stamp.
    return { ...v6, version: 7 as const };
  }

  // Build a map for quick position lookup.
  const nodeById = new Map(v6.nodes.map((n) => [n.id, n]));
  // Track structural nodes / edges to append; mutate copies of the
  // original arrays.
  const addedNodes: z.infer<typeof ProjectFileV6>['nodes'] = [];
  const addedEdges: z.infer<typeof ProjectFileV6>['edges'] = [];

  const newSubsystems = v6.subsystems.map((sub) => {
    const naturalEntry = nodeById.get(sub.entryNodeId);
    const naturalExit = nodeById.get(sub.exitNodeId);

    // Compute structural-node positions. The structural port wedge is
    // 44 px wide (see SubsystemEntryNode / SubsystemExitNode). We want
    // ~60 px clear space between the wedge and the natural entry/exit.
    //   Entry  = naturalEntry.x - PORT_WIDTH - GAP
    //   Exit   = naturalExit.x + naturalExit.width + GAP
    // The exit side uses the natural node's WIDTH so the wedge clears
    // the rectangle (an earlier formula used a fixed +140 offset; that
    // ignored the natural exit's width and the wedge landed inside the
    // activity rectangle — see Slice 3.5b screenshot fix). Falls back
    // to the placement.ts default node width when the schema's optional
    // `width` field is absent. Position-y left at the natural node's
    // top so the wedge sits at the same baseline as the body activities.
    const STRUCTURAL_PORT_WIDTH = 44;
    const STRUCTURAL_PORT_GAP = 60;
    const NATURAL_NODE_DEFAULT_WIDTH = 160;
    const entryPos = naturalEntry
      ? {
          x: naturalEntry.position.x - STRUCTURAL_PORT_WIDTH - STRUCTURAL_PORT_GAP,
          y: naturalEntry.position.y,
        }
      : { x: 0, y: 0 };
    const exitPos = naturalExit
      ? {
          x:
            naturalExit.position.x +
            (naturalExit.width ?? NATURAL_NODE_DEFAULT_WIDTH) +
            STRUCTURAL_PORT_GAP,
          y: naturalExit.position.y,
        }
      : { x: 0, y: 0 };

    const structuralEntryId = idSource();
    const structuralExitId = idSource();

    addedNodes.push(
      {
        id: structuralEntryId,
        nodeType: 'subsystemEntry',
        name: 'Entry',
        duration: { value: 0, unit: 'hours' },
        durationSemantic: 'time',
        position: entryPos,
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      },
      {
        id: structuralExitId,
        nodeType: 'subsystemExit',
        name: 'Exit',
        duration: { value: 0, unit: 'hours' },
        durationSemantic: 'time',
        position: exitPos,
        calendarId: null,
        consumesResources: false,
        resourceAssignments: [],
      },
    );
    addedEdges.push(
      {
        id: idSource(),
        from: structuralEntryId,
        to: sub.entryNodeId,
        type: 'FS',
        lag: { value: 0, unit: 'hours' },
      },
      {
        id: idSource(),
        from: sub.exitNodeId,
        to: structuralExitId,
        type: 'FS',
        lag: { value: 0, unit: 'hours' },
      },
    );

    return {
      ...sub,
      // Prepend / append structural nodes so the migrated body reads
      // [structuralEntry, ...legacyBody, structuralExit] left-to-right.
      bodyNodeIds: [structuralEntryId, ...sub.bodyNodeIds, structuralExitId],
      entryNodeId: structuralEntryId,
      exitNodeId: structuralExitId,
    };
  });

  return {
    ...v6,
    version: 7 as const,
    nodes: [...v6.nodes, ...addedNodes],
    edges: [...v6.edges, ...addedEdges],
    subsystems: newSubsystems,
  };
}

/**
 * Migrate a v7 project to v8 in-memory. Backlog Slice 6 / audit I-18 —
 * `groupColors` moves from `viewStore` (transient, lost on reload) to the
 * project schema (persisted, undoable, file-saved). Pre-V8 saves never had
 * a place to store these, so the migration starts with an empty map. Users
 * who'd set custom group colors before this PR keep the auto-palette
 * fallback until they re-pick — that's expected, the pre-migration data was
 * ephemeral by design.
 */
export function migrateV7ToV8(v7: z.infer<typeof ProjectFileV7>): ProjectFile {
  return { ...v7, version: 8 as const, groupColors: {} };
}

/**
 * Migrate a v1 subsystem file to v2 in-memory. The cost-bearing schema
 * additions are all optional, so a v1 body without cost data is byte-equal
 * to a v2 body apart from the version stamp.
 */
export function migrateSubsystemV1ToV2(
  v1: z.infer<typeof SubsystemFileV1>,
): z.infer<typeof SubsystemFileV2> {
  return { ...v1, version: 2 as const };
}

/**
 * Migrate a v2 subsystem file to v3 in-memory. NodeSchema's .default('time')
 * on `durationSemantic` populates the new field at parse time, so the
 * migration only re-stamps the version.
 */
export function migrateSubsystemV2ToV3(
  v2: z.infer<typeof SubsystemFileV2>,
): z.infer<typeof SubsystemFileV3> {
  return { ...v2, version: 3 as const };
}

/**
 * Migrate a v3 subsystem file to v4 in-memory. Pure version-stamp bump —
 * `share` is optional on every ResourceAssignmentSchema and absent on
 * legacy bodies; no shareMode invariants apply at the subsystem level
 * (that's a project-level concern).
 */
export function migrateSubsystemV3ToV4(v3: z.infer<typeof SubsystemFileV3>): SubsystemFile {
  return { ...v3, version: 4 as const };
}

// ── String-truncation preprocessor ────────────────────────────────────────────

/**
 * Walk a parsed-JSON project file and truncate every free-text field whose
 * length exceeds its configured SCHEMA_LIMITS cap. Identifiers and arrays
 * are NOT touched — those are handled by Zod's hard-reject `.max()` on the
 * schema. Truncating an ID would break references; truncating an array
 * would drop project semantics. Free-text strings (names, descriptions,
 * notes, group labels) are safe to clip — the user gets a recognizable
 * artifact they can edit.
 *
 * Returns the (possibly modified) parsed input and a warnings list. The
 * function is purely a pre-Zod pass; it does NOT validate types — Zod
 * does that next. Anything that doesn't match the expected shape is
 * skipped so a malformed file still flows through to Zod for the real
 * error report.
 *
 * The walk is V7-shaped, but the field names it visits also exist in
 * older versions, so legacy files benefit from the same truncation
 * without per-version code.
 */
export function truncateOversizedStrings(parsed: unknown): {
  processed: unknown;
  warnings: TruncationWarning[];
} {
  const warnings: TruncationWarning[] = [];
  if (!isPlainObject(parsed)) return { processed: parsed, warnings };

  const root = { ...parsed };

  // project.name (project settings)
  if (isPlainObject(root.project)) {
    const proj = { ...root.project };
    clipField(proj, 'name', SCHEMA_LIMITS.projectName, 'project.name', warnings);
    root.project = proj;
  }

  // calendars[].name + calendars[].exceptions[].name
  if (Array.isArray(root.calendars)) {
    root.calendars = root.calendars.map((cal, i) => {
      if (!isPlainObject(cal)) return cal;
      const next = { ...cal };
      clipField(next, 'name', SCHEMA_LIMITS.calendarName, `calendars[${i}].name`, warnings);
      if (Array.isArray(next.exceptions)) {
        next.exceptions = next.exceptions.map((ex, j) => {
          if (!isPlainObject(ex)) return ex;
          const e = { ...ex };
          clipField(
            e,
            'name',
            SCHEMA_LIMITS.calendarExceptionName,
            `calendars[${i}].exceptions[${j}].name`,
            warnings,
          );
          return e;
        });
      }
      return next;
    });
  }

  // resources[].name
  if (Array.isArray(root.resources)) {
    root.resources = root.resources.map((res, i) => {
      if (!isPlainObject(res)) return res;
      const next = { ...res };
      clipField(next, 'name', SCHEMA_LIMITS.resourceName, `resources[${i}].name`, warnings);
      return next;
    });
  }

  // nodes[].name + .description + .group
  if (Array.isArray(root.nodes)) {
    root.nodes = root.nodes.map((node, i) => {
      if (!isPlainObject(node)) return node;
      const next = { ...node };
      clipField(next, 'name', SCHEMA_LIMITS.nodeName, `nodes[${i}].name`, warnings);
      clipField(
        next,
        'description',
        SCHEMA_LIMITS.nodeDescription,
        `nodes[${i}].description`,
        warnings,
      );
      clipField(next, 'group', SCHEMA_LIMITS.nodeGroup, `nodes[${i}].group`, warnings);
      return next;
    });
  }

  // loops[].group + .description + .kickout.description (externalTrigger variant)
  if (Array.isArray(root.loops)) {
    root.loops = root.loops.map((loop, i) => {
      if (!isPlainObject(loop)) return loop;
      const next = { ...loop };
      clipField(next, 'group', SCHEMA_LIMITS.loopGroup, `loops[${i}].group`, warnings);
      clipField(
        next,
        'description',
        SCHEMA_LIMITS.loopDescription,
        `loops[${i}].description`,
        warnings,
      );
      if (isPlainObject(next.kickout) && next.kickout.type === 'externalTrigger') {
        const kick = { ...next.kickout };
        clipField(
          kick,
          'description',
          SCHEMA_LIMITS.loopExitConditionDescription,
          `loops[${i}].kickout.description`,
          warnings,
        );
        next.kickout = kick;
      }
      return next;
    });
  }

  // subsystems[].group  (note: subsystem name/notes live on the SubsystemFile
  // root, not on per-project Subsystem entries — handled in the .calasub path)
  if (Array.isArray(root.subsystems)) {
    root.subsystems = root.subsystems.map((sub, i) => {
      if (!isPlainObject(sub)) return sub;
      const next = { ...sub };
      clipField(next, 'group', SCHEMA_LIMITS.nodeGroup, `subsystems[${i}].group`, warnings);
      if (isPlainObject(next.source)) {
        const src = { ...next.source };
        clipField(
          src,
          'fileName',
          SCHEMA_LIMITS.fileName,
          `subsystems[${i}].source.fileName`,
          warnings,
        );
        clipField(
          src,
          'sourceName',
          SCHEMA_LIMITS.subsystemName,
          `subsystems[${i}].source.sourceName`,
          warnings,
        );
        next.source = src;
      }
      return next;
    });
  }

  // scenarios[].name
  if (Array.isArray(root.scenarios)) {
    root.scenarios = root.scenarios.map((sc, i) => {
      if (!isPlainObject(sc)) return sc;
      const next = { ...sc };
      clipField(next, 'name', SCHEMA_LIMITS.scenarioName, `scenarios[${i}].name`, warnings);
      return next;
    });
  }

  // .calasub root-level name + (future) notes
  if (typeof root.name === 'string') {
    clipField(root, 'name', SCHEMA_LIMITS.subsystemName, 'name', warnings);
  }

  return { processed: root, warnings };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clipField(
  obj: Record<string, unknown>,
  field: string,
  cap: number,
  path: string,
  warnings: TruncationWarning[],
): void {
  const v = obj[field];
  if (typeof v !== 'string') return;
  if (v.length <= cap) return;
  warnings.push({ path, field, originalLength: v.length, truncatedTo: cap });
  obj[field] = v.slice(0, cap);
}

// ── Load / Save ───────────────────────────────────────────────────────────────

/**
 * Load and validate a .cala (or legacy .procsim) project file.
 * Accepts v1 through v7 files. Older versions are migrated forward in
 * memory; callers always receive a v7 ProjectFile regardless of disk
 * format.
 */
export function loadProjectFile(contents: string): LoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return {
      ok: false,
      errors: [{ path: '', message: 'Invalid JSON: file contents could not be parsed.' }],
    };
  }

  // Soft-cap free-text strings before Zod parse. Identifiers and arrays
  // are still hard-capped by the Zod `.max()` rules in schema.ts.
  const { processed, warnings: truncationWarnings } = truncateOversizedStrings(parsed);

  // Try v8 first (current schema for new saves).
  const v8Result = ProjectFileV8.safeParse(processed);
  if (v8Result.success) {
    return successResult(v8Result.data, truncationWarnings);
  }

  // Try v7 and migrate to v8.
  const v7Result = ProjectFileV7.safeParse(processed);
  if (v7Result.success) {
    return successResult(migrateV7ToV8(v7Result.data), truncationWarnings);
  }

  // Try v6 and migrate v6 → v7 → v8.
  const v6Result = ProjectFileV6.safeParse(processed);
  if (v6Result.success) {
    return successResult(migrateV7ToV8(migrateV6ToV7(v6Result.data)), truncationWarnings);
  }

  // Try v5 and migrate v5 → v6 → v7 → v8.
  const v5Result = ProjectFileV5.safeParse(processed);
  if (v5Result.success) {
    return successResult(
      migrateV7ToV8(migrateV6ToV7(migrateV5ToV6(v5Result.data))),
      truncationWarnings,
    );
  }

  // Try v4 and migrate v4 → v5 → v6 → v7 → v8.
  const v4Result = ProjectFileV4.safeParse(processed);
  if (v4Result.success) {
    return successResult(
      migrateV7ToV8(migrateV6ToV7(migrateV5ToV6(migrateV4ToV5(v4Result.data)))),
      truncationWarnings,
    );
  }

  // Try v3 and migrate v3 → v4 → v5 → v6 → v7 → v8.
  const v3Result = ProjectFileV3.safeParse(processed);
  if (v3Result.success) {
    return successResult(
      migrateV7ToV8(migrateV6ToV7(migrateV5ToV6(migrateV4ToV5(migrateV3ToV4(v3Result.data))))),
      truncationWarnings,
    );
  }

  // Try v2 and migrate v2 → v3 → v4 → v5 → v6 → v7 → v8.
  const v2Result = ProjectFileV2.safeParse(processed);
  if (v2Result.success) {
    return successResult(
      migrateV7ToV8(
        migrateV6ToV7(migrateV5ToV6(migrateV4ToV5(migrateV3ToV4(migrateV2ToV3(v2Result.data))))),
      ),
      truncationWarnings,
    );
  }

  // Try v1 (legacy .procsim and early .cala files) and migrate all the way.
  const v1Result = ProjectFileV1.safeParse(processed);
  if (v1Result.success) {
    return successResult(
      migrateV7ToV8(
        migrateV6ToV7(
          migrateV5ToV6(migrateV4ToV5(migrateV3ToV4(migrateV2ToV3(migrateV1ToV2(v1Result.data))))),
        ),
      ),
      truncationWarnings,
    );
  }

  // Audit I-5 — nothing parsed. Pick the most informative error set:
  //   1. If `processed` declares a numeric `version` 1..8, surface that
  //      version's issues — the author's own discriminator is the
  //      strongest signal of which schema they intended.
  //   2. Otherwise (missing / malformed version field) fall back to the
  //      candidate with the fewest issues. For a legacy v3 file with a
  //      single typo this is the v3 errors, not v8's wall of
  //      "version: literal must be 8" + "required field X missing" noise
  //      from fields that didn't exist back then.
  // Previously always returned v7's issues regardless, which made
  // legacy-file errors unreadable.
  const candidates = [
    { version: 8, error: v8Result.error },
    { version: 7, error: v7Result.error },
    { version: 6, error: v6Result.error },
    { version: 5, error: v5Result.error },
    { version: 4, error: v4Result.error },
    { version: 3, error: v3Result.error },
    { version: 2, error: v2Result.error },
    { version: 1, error: v1Result.error },
  ];
  const declaredVersion =
    typeof processed === 'object' &&
    processed !== null &&
    typeof (processed as { version?: unknown }).version === 'number'
      ? (processed as { version: number }).version
      : null;
  const chosen =
    (declaredVersion !== null
      ? candidates.find((c) => c.version === declaredVersion)
      : undefined) ??
    candidates.reduce((best, c) => (c.error.issues.length < best.error.issues.length ? c : best));
  const errors: ValidationError[] = chosen.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  return { ok: false, errors };
}

export function saveProjectFile(project: ProjectFile): string {
  return JSON.stringify(project, null, 2);
}

/**
 * Bring any older project file up to the current schema version.
 * Throws for unrecognisable input — use `loadProjectFile` for user-facing
 * validation with structured errors.
 */
export function migrateIfNeeded(parsed: unknown): ProjectFile {
  const v8Result = ProjectFileV8.safeParse(parsed);
  if (v8Result.success) return v8Result.data;

  const v7Result = ProjectFileV7.safeParse(parsed);
  if (v7Result.success) return migrateV7ToV8(v7Result.data);

  const v6Result = ProjectFileV6.safeParse(parsed);
  if (v6Result.success) return migrateV7ToV8(migrateV6ToV7(v6Result.data));

  const v5Result = ProjectFileV5.safeParse(parsed);
  if (v5Result.success) return migrateV7ToV8(migrateV6ToV7(migrateV5ToV6(v5Result.data)));

  const v4Result = ProjectFileV4.safeParse(parsed);
  if (v4Result.success)
    return migrateV7ToV8(migrateV6ToV7(migrateV5ToV6(migrateV4ToV5(v4Result.data))));

  const v3Result = ProjectFileV3.safeParse(parsed);
  if (v3Result.success)
    return migrateV7ToV8(migrateV6ToV7(migrateV5ToV6(migrateV4ToV5(migrateV3ToV4(v3Result.data)))));

  const v2Result = ProjectFileV2.safeParse(parsed);
  if (v2Result.success)
    return migrateV7ToV8(
      migrateV6ToV7(migrateV5ToV6(migrateV4ToV5(migrateV3ToV4(migrateV2ToV3(v2Result.data))))),
    );

  const v1Result = ProjectFileV1.safeParse(parsed);
  if (v1Result.success) {
    return migrateV7ToV8(
      migrateV6ToV7(
        migrateV5ToV6(migrateV4ToV5(migrateV3ToV4(migrateV2ToV3(migrateV1ToV2(v1Result.data))))),
      ),
    );
  }

  throw new Error(
    `Cannot migrate project file: ${v8Result.error.issues.map((i) => i.message).join('; ')}`,
  );
}

// ── Sub-system file I/O ───────────────────────────────────────────────────────

/**
 * Load and validate a .calasub (stand-alone sub-system) file.
 * Accepts v1, v2, v3, and v4 files; v1 / v2 / v3 files migrate forward.
 */
export function loadSubsystemFile(contents: string): LoadSubsystemResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return {
      ok: false,
      errors: [{ path: '', message: 'Invalid JSON: file contents could not be parsed.' }],
    };
  }

  // Same soft-cap preprocessing as loadProjectFile — the field-name walk in
  // truncateOversizedStrings covers .calasub's nested arrays too.
  const { processed, warnings } = truncateOversizedStrings(parsed);
  const withWarnings = (subsystem: SubsystemFile): LoadSubsystemResult =>
    warnings.length > 0
      ? { ok: true, subsystem, truncationWarnings: warnings }
      : { ok: true, subsystem };

  const v4Result = SubsystemFileV4.safeParse(processed);
  if (v4Result.success) {
    return withWarnings(v4Result.data);
  }

  const v3Result = SubsystemFileV3.safeParse(processed);
  if (v3Result.success) {
    return withWarnings(migrateSubsystemV3ToV4(v3Result.data));
  }

  const v2Result = SubsystemFileV2.safeParse(processed);
  if (v2Result.success) {
    return withWarnings(migrateSubsystemV3ToV4(migrateSubsystemV2ToV3(v2Result.data)));
  }

  const v1Result = SubsystemFileV1.safeParse(processed);
  if (v1Result.success) {
    return withWarnings(
      migrateSubsystemV3ToV4(migrateSubsystemV2ToV3(migrateSubsystemV1ToV2(v1Result.data))),
    );
  }

  const errors: ValidationError[] = v4Result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  return { ok: false, errors };
}

export function saveSubsystemFile(subsystem: SubsystemFile): string {
  return JSON.stringify(subsystem, null, 2);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Assemble a successful `LoadResult` with both update flags applied. Factored
 * out so the v1 / v2 / v3 success branches stay one-liners. `fxUpdatesAvailable`
 * is omitted (not set to `undefined`) so the field is absent under
 * `exactOptionalPropertyTypes`.
 */
function successResult(project: ProjectFile, truncationWarnings: TruncationWarning[]): LoadResult {
  const fxUpdate = collectFxUpdate(project);
  return {
    ok: true,
    project,
    presetUpdatesAvailable: collectPresetUpdates(project),
    ...(fxUpdate !== null ? { fxUpdatesAvailable: fxUpdate } : {}),
    ...(truncationWarnings.length > 0 ? { truncationWarnings } : {}),
  };
}

/**
 * Compare the project's pinned `fxSnapshotVersion` against
 * `LATEST_BUNDLED_SNAPSHOT.version`. Returns `null` when no banner should
 * surface — either the pin is current, the pin is `'NONE'` (user opted
 * out), or the pin is a version unknown to this build (forward-compat).
 */
function collectFxUpdate(project: ProjectFile): FxSnapshotUpdate | null {
  const current = project.fxSnapshotVersion;
  if (current === 'NONE') return null;
  const latest = LATEST_BUNDLED_SNAPSHOT.version;
  if (current === latest) return null;
  // Unknown / forward versions: don't suggest downgrading. (E.g. a project
  // saved with a future 2026.2 build loaded into this build that only
  // knows 2026.0 / 2026.1 — banner would suggest going backwards.)
  if (!listBundledSnapshotVersions().includes(current)) return null;
  return { currentVersion: current, latestVersion: latest };
}

function collectPresetUpdates(project: ProjectFile): PresetUpdate[] {
  const updates: PresetUpdate[] = [];
  for (const cal of project.calendars) {
    if (cal.holidayPreset === 'NONE') continue;
    const latest = latestPresetVersion(cal.holidayPreset);
    if (cal.holidayPresetVersion !== latest) {
      updates.push({
        calendarId: cal.id,
        calendarName: cal.name,
        presetId: cal.holidayPreset,
        currentVersion: cal.holidayPresetVersion,
        latestVersion: latest,
      });
    }
  }
  return updates;
}
