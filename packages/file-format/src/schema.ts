import { z } from 'zod';

export const CURRENT_VERSION = 8 as const;

// ── Schema limits ─────────────────────────────────────────────────────────────
//
// Generous upper bounds applied at parse time. Two purposes:
//
//   1. Defence-in-depth alongside the 50 MB file-size guard in `fileio.ts`.
//      A file that slips past the upload cap (e.g. via a future ingestion
//      path) still can't OOM the loader.
//   2. Sanity rails on real projects. A 600-char node name or a 50 K-edge
//      project is almost certainly an attack or a bug, not a real plan.
//
// Two enforcement modes:
//
//   - Free-text strings (`name`, `description`, `notes`, `group`) — soft
//     limit. `load.ts` pre-processes the parsed JSON, truncates over-cap
//     values, and surfaces a TruncationWarning to the caller. The user
//     keeps a recognizable, editable artifact.
//   - Identifiers, structural references, and arrays — hard limit on the
//     Zod schema. Truncating an ID would break references; truncating an
//     array would drop nodes/edges/etc. silently. A precise rejection
//     error is safer than corrupting project semantics.
//
// The values are an order of magnitude above any realistic project — real
// decks have a few hundred nodes, real node names are <80 chars, real AI-
// generated descriptions are a few thousand chars. Hitting these limits in
// the wild should be near-zero; the 2026-05-22 security audit shipped them
// to bound the worst case.
export const SCHEMA_LIMITS = {
  // Free-text strings (truncated by load.ts preprocessor).
  projectName: 500,
  nodeName: 500,
  nodeDescription: 50_000,
  nodeGroup: 200,
  calendarName: 500,
  calendarExceptionName: 200,
  resourceName: 500,
  subsystemName: 500,
  subsystemNotes: 50_000,
  loopGroup: 200,
  loopDescription: 50_000,
  loopExitConditionDescription: 5_000,
  scenarioName: 500,
  fileName: 1_000,
  // Phase 49 Slice 3 — free-floating canvas comments. Matches the
  // other free-text limits (nodeDescription / subsystemNotes /
  // loopDescription); users can write paragraph-length annotations
  // without bumping the cap.
  commentText: 50_000,

  // Identifiers (Zod hard-reject).
  id: 200,

  // Arrays (Zod hard-reject).
  calendars: 1_000,
  calendarExceptions: 10_000,
  resources: 10_000,
  nodes: 50_000,
  edges: 200_000,
  loops: 5_000,
  subsystems: 5_000,
  scenarios: 1_000,
  resourceAssignments: 1_000,
  crashOptions: 100,
  bodyNodeIds: 50_000,
  comments: 10_000,
} as const;

function tooManyMsg(field: string, max: number): string {
  return `${field}: at most ${max} entries allowed (received too many).`;
}

// Phase 40 — fixed canonical conversion constants for effort-semantic
// durations. A `value: 5, unit: 'days'` duration on an effort-semantic node
// always means 40 hours, independent of the node's effective calendar. The
// numbers match MS Project / Primavera "person-day" / "person-week"
// conventions; a user who needs a different effort-per-day model expresses
// their durations in hours.
export const EFFORT_HOURS_PER_DAY = 8 as const;
export const EFFORT_DAYS_PER_WEEK = 5 as const;

// ── Primitives ────────────────────────────────────────────────────────────────

export const HolidayPresetIdSchema = z.enum([
  'US_FEDERAL',
  'CANADA_FEDERAL',
  'EU_COMMON',
  'BRAZIL_FEDERAL',
  'MEXICO_FEDERAL',
  'JAPAN_NATIONAL',
  'AUSTRALIA_NATIONAL',
  'NONE',
]);

export const DurationUnitSchema = z.enum(['hours', 'days', 'weeks']);

// Phase 40 — per-node interpretation of a duration's days/weeks units.
//   'effort' → calendar-independent. `1 day = 8h`, `1 week = 40h` (the
//              EFFORT_* constants above). Switching the node's effective
//              calendar does NOT change the effort hours. Models labour
//              that compresses when the team adopts a more intense
//              schedule.
//   'time'   → calendar-dependent (legacy / pre-Phase-40 semantics). Days
//              and weeks are multiplied by the effective calendar's
//              `hoursPerDay` / `daysPerWeek`. Models elapsed periods
//              (regulatory waits, gate-review windows) where the
//              underlying clock is the calendar.
export const DurationSemanticSchema = z.enum(['effort', 'time']);

// Activity/node duration: non-negative effort (not elapsed time).
// Activity / decision nodes must have value > 0 (enforced by NodeSchema.refine below).
// Start / End / Subsystem nodes carry value === 0 (zero-duration anchors / containers).
export const DurationSchema = z.object({
  value: z.number().nonnegative(),
  unit: DurationUnitSchema,
});

// Edge lag: signed — positive = gap, negative = overlap, 0 = no gap.
export const LagDurationSchema = z.object({
  value: z.number().finite(),
  unit: DurationUnitSchema,
});

export const DistributionSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('triangular'),
      min: z.number(),
      mode: z.number(),
      max: z.number(),
    }),
    z.object({
      type: z.literal('pert-beta'),
      min: z.number(),
      mode: z.number(),
      max: z.number(),
    }),
    z.object({
      type: z.literal('normal'),
      mean: z.number(),
      stddev: z.number().positive(),
    }),
  ])
  // Phase 50 Slice 5 / audit C-3 — shape invariants for the bounded
  // distributions. The samplers in `packages/simulation/src/index.ts`
  // and `drawsPerIter.ts` assume `min ≤ mode ≤ max` and `min < max`;
  // a malformed input (e.g. `{type:'triangular', min:10, mode:5, max:20}`
  // or reversed bounds) used to flow through Zod cleanly and produce
  // `NaN` finish times via `Math.sqrt(negative)`. The UI clamps inputs
  // to valid ranges, so the only realistic source of malformed
  // distributions is hand-edited JSON — failing loud at load time
  // beats silent NaN propagation through the schedule.
  //
  // Path is relative to the distribution object; Zod's path mechanism
  // composes the full dotted path (e.g. `nodes.3.duration.distribution.mode`)
  // when this union appears as a property of NodeSchema / EdgeSchema /
  // ResourceSchema / LoopSchema / etc.
  .superRefine((d, ctx) => {
    if (d.type === 'triangular' || d.type === 'pert-beta') {
      if (!(d.min < d.max)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${d.type} distribution requires min < max (got min=${d.min}, max=${d.max})`,
          path: ['min'],
        });
      }
      if (!(d.min <= d.mode)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${d.type} distribution requires mode ≥ min (got mode=${d.mode}, min=${d.min})`,
          path: ['mode'],
        });
      }
      if (!(d.mode <= d.max)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${d.type} distribution requires mode ≤ max (got mode=${d.mode}, max=${d.max})`,
          path: ['mode'],
        });
      }
    }
    // Normal: `stddev > 0` already enforced by `.positive()` on the field.
  });

export const CalendarPolicySchema = z.enum(['intersection', 'resourceWins', 'activityWins']);

// ── Calendar ──────────────────────────────────────────────────────────────────

const CalendarExceptionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  type: z.enum(['holiday', 'working']),
  name: z.string(),
});

export const CalendarSchema = z.object({
  id: z.string().min(1).max(SCHEMA_LIMITS.id),
  // Free-text — soft cap applied via load.ts preprocessor truncation.
  name: z.string().min(1),
  // Index 0 = Sunday, 1 = Monday, …, 6 = Saturday — matches JS Date.getDay()
  workingDays: z.tuple([
    z.boolean(),
    z.boolean(),
    z.boolean(),
    z.boolean(),
    z.boolean(),
    z.boolean(),
    z.boolean(),
  ]),
  hoursPerDay: z.number().positive(),
  daysPerWeek: z.number().int().min(1).max(7),
  holidayPreset: HolidayPresetIdSchema,
  holidayPresetVersion: z.string(),
  exceptions: z.array(CalendarExceptionSchema).max(SCHEMA_LIMITS.calendarExceptions, {
    message: tooManyMsg('calendar.exceptions', SCHEMA_LIMITS.calendarExceptions),
  }),
});

// ── Resource ──────────────────────────────────────────────────────────────────

export const ResourceSchema = z.object({
  id: z.string().min(1).max(SCHEMA_LIMITS.id),
  // Free-text — soft cap applied via load.ts preprocessor truncation.
  name: z.string().min(1),
  capacity: z.number().int().positive(),
  calendarId: z.string().min(1).max(SCHEMA_LIMITS.id),
  // Phase 19 — Cost modelling (V0.8). Both optional; absent ≡ zero. The
  // cost engine treats unset / zero values identically and skips emitting
  // any cost contribution. Cost is computed from the plan, never tracked.
  // When `currencyOverride` is set, these values are denominated in that
  // currency, NOT the project currency — see the field below.
  costRate: z.number().nonnegative().optional(), // per working hour, in this resource's currency
  costPerUse: z.number().nonnegative().optional(), // one-time per resource assignment instance
  // Phase 29 — Per-resource rate uncertainty. When present, Monte Carlo
  // samples the hourly rate from this distribution per iteration via a
  // dedicated per-resource RNG sub-stream (parallel to the Phase 19
  // per-node cost stream — see ARCHITECTURE.md "Per-resource sub-stream
  // for hourly-rate uncertainty"). The deterministic schedule continues
  // to use `costRate`; the two fields coexist (same pattern as
  // `fixedCost.value` + `fixedCost.distribution` on NodeSchema). Reuses
  // the full `DistributionSchema` so adding normal / PERT-beta to the
  // resource UI later doesn't require a schema migration; the slice-1 UI
  // exposes triangular only. Negative samples (possible for normal
  // centred near zero) are clamped to 0 at sample time. Distribution
  // samples are in the same currency as `costRate` (override or project).
  hourlyRateDistribution: DistributionSchema.optional(),
  // Phase 33 — Per-resource currency override. When set, this resource's
  // `costRate` / `costPerUse` / `hourlyRateDistribution` are denominated
  // in the override currency, NOT the project currency. The display
  // shows the stored numbers verbatim with the override's glyph — no
  // FX math is applied at display time. The conversion from override
  // currency to project currency happens at the engine boundary via
  // `convertResourceCostsToProjectCurrency` so the cost engine remains
  // pure (project-currency in, project-currency out). Absent on legacy
  // files; the existing project-level `currency` field is the implicit
  // default.
  currencyOverride: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, 'currencyOverride must be a 3-letter ISO 4217 code')
    .optional(),
});

// ── Cost ──────────────────────────────────────────────────────────────────────

// Phase 19 — node-level fixed cost. Only meaningful on activity / decision
// nodes (the project-file superRefine and NodeSchema refine below enforce
// this). When `distribution` is set, the static `value` is the central point
// used for the deterministic schedule; Monte Carlo (slice 2) samples around
// it, drawing AFTER the duration and bernoulli draws from the same per-node
// sub-stream — so adding a cost distribution never perturbs the node's
// duration / pass samples.
//
// When a node with `fixedCost.distribution` is inside a loop body, the
// sampler draws ONCE per Monte Carlo iteration and multiplies by the sampled
// loop count (matches user intent: "the permit costs ~$5k per attempt and
// we attempt N times"). Cheaper than per-iteration sampling.
export const FixedCostSchema = z
  .object({
    value: z.number().nonnegative(),
    distribution: DistributionSchema.optional(),
  })
  .refine(
    // A zero-value cost with a distribution is meaningless — the engine would
    // never sample anything > 0. Reject explicitly so users get a clear error
    // instead of a silently-disabled distribution.
    (fc) => fc.distribution === undefined || fc.value > 0,
    { message: 'fixedCost.value must be > 0 when a distribution is set', path: ['value'] },
  );

// Phase 25 — Activity crashing (time-cost trade-off).
//
// A `crashOption` describes one way to compress this node: pay the extra
// `additionalCost` to shrink the activity's duration to `duration`. The
// engine reads `node.selectedCrashIndex` (also optional on NodeSchema); when
// set it swaps the nominal duration for the selected option's duration and
// adds `additionalCost` to the node's cost via a separate `fromCrash` bucket
// on `NodeCost`. When unset the node behaves identically to a node without
// crash options — the engine is byte-equal with the pre-Phase-25 behaviour.
//
// Cross-field validation lives on NodeSchema's refines:
//   - each option must use the same unit as `node.duration` and a strictly
//     smaller value (compress, not extend). Same-unit keeps the comparison
//     unambiguous without a calendar at parse time; the Inspector UI only
//     exposes a value input per row and inherits the node's unit.
//   - crashOptions / selectedCrashIndex are only valid on activity / decision
//     nodes (anchors and subsystem containers are zero-duration).
//   - selectedCrashIndex must reference a valid entry in crashOptions.
export const CrashOptionSchema = z.object({
  duration: DurationSchema,
  additionalCost: z.number().nonnegative(),
  // Phase 26 follow-up — resource rate multiplier when this option is
  // selected. Applies to each `resourceAssignment`'s rate × hours × count
  // contribution (the `fromResources` bucket). Does NOT scale `costPerUse`
  // (per-use fees are mobilisation charges, independent of duration) nor
  // `additionalCost` (that's the one-time `fromCrash` bucket).
  //
  // Captures the missing real-world cases the linear-scale default doesn't:
  //   - `1.0` (default, absent ≡ 1.0): pure expedite — resource cost
  //     shrinks linearly with the compressed duration. Models a vendor
  //     expedite fee where your team's hours go down.
  //   - `1.5`: time-and-a-half overtime.
  //   - `2.0`: double-time / weekend OT, or premium contractor at 2× rate.
  //   - `nominal / compressed`: "preserve effort" — total resource cost
  //     stays at the nominal level (work is the same, you're just packing
  //     it into less wall-clock at a higher rate).
  //
  // Must be > 0. Absent ≡ 1.0 means files saved during Phase 25 Slice 1
  // load and behave identically (byte-equal with the pre-multiplier
  // engine). Same additive-optional precedent as Phase 23's
  // `parallelism` — no schema migration.
  resourceCostMultiplier: z.number().positive().optional(),
});

// ── Node ──────────────────────────────────────────────────────────────────────

export const ResourceAssignmentSchema = z.object({
  resourceId: z.string().min(1).max(SCHEMA_LIMITS.id),
  count: z.number().int().positive(),
  calendarPolicy: CalendarPolicySchema,
  // Phase 23 — Parallelism coefficient (0..1).
  // 0 = independent labour: more units → more cost, no duration change.
  // 1 = perfect parallel: more units → shorter duration, same total cost.
  // Anything in between is Amdahl-style. Optional for backwards-
  // compatibility; absent on legacy files (treated as 0 by the engine
  // in slice 2). New assignments default to 1 (added in domainStore).
  parallelism: z.number().min(0).max(1).optional(),
  // Phase 42 — this pool's share of the activity's total effort.
  // Optional; when absent on every assignment of a node the engine falls
  // back to legacy "each pool does the full baseHours" behaviour
  // (preserves pre-Phase-42 scheduling byte-for-byte). When present, the
  // engine normalises across the node's assignments — see
  // ProjectFileV5.superRefine for the cross-field invariants. Zero is
  // legal and means "pool is present (calendar still gates timing) but
  // contributes no labour" — useful for observer / approver pools.
  share: z.number().nonnegative().optional(),
});

// Phase 42 — `share` rendering and validation mode. `'percentage'` (default)
// enforces sum=100 across a node's set shares and renders the inspector
// editor in 0–100 % terms. `'weight'` keeps the looser sum > 0 invariant
// and renders raw weights with computed percentages alongside. The engine
// itself is mode-agnostic — it always normalises by sum at compute time.
export const ShareModeSchema = z.enum(['percentage', 'weight']);

// Node typology:
//   activity  → normal work step (positive duration, may consume resources)
//   start     → zero-duration process anchor; signals "begin here"         [Phase 10 Tier 1]
//   end       → zero-duration process terminus; signals "complete here"    [Phase 10 Tier 1]
//   decision  → review/quality gate; positive duration like an activity,   [Phase 11]
//               plus `passProbability` and `failureDelay`. On failure the
//               chain doesn't branch — it just takes longer.
//   subsystem → zero-duration container wrapping a set of body nodes.      [Phase 12]
//               The scheduler flattens these before CPM; they don't appear
//               in ScheduleResult.nodes. Editing is via drill-in canvas.
// `.default('activity')` keeps pre-Phase-10 `.procsim`/`.cala` files loading cleanly.
export const NodeTypeSchema = z.enum([
  'start',
  'activity',
  'end',
  'decision',
  'subsystem',
  // Phase 50 Slice 3.5 / V7 — structural ports auto-injected as a
  // subsystem's entry and exit. Treated as zero-duration anchors by the
  // engine (like start/end), but distinct so UI can render them as
  // ports and the V7 superRefine can enforce subsystem-boundary
  // invariants. Auto-injected by V6→V7 migration for legacy files; new
  // subsystems created in V7+ builds always include them. Not user-
  // creatable directly — only emitted by wrapSelectedAsSubsystem.
  'subsystemEntry',
  'subsystemExit',
]);

export const NodeSchema = z
  .object({
    id: z.string().min(1).max(SCHEMA_LIMITS.id),
    // Node typology — see NodeTypeSchema for semantics. Default keeps legacy files valid.
    nodeType: NodeTypeSchema.default('activity'),
    // Free-text — soft cap applied via load.ts preprocessor truncation
    // (SCHEMA_LIMITS.nodeName). The schema itself stays open so a paste of a
    // long sentence doesn't reject on load.
    name: z.string(),
    // Phase 35 — optional free-text notes (assumptions, references, the
    // reasoning behind an estimate). The Inspector surfaces it on activity /
    // decision / subsystem-container nodes; start / end nodes don't render
    // the field but the schema doesn't forbid it (legacy / external editors
    // may set it harmlessly). The UI shows a soft 2000-char counter; the
    // schema is generously capped via SCHEMA_LIMITS.nodeDescription and the
    // load.ts preprocessor truncates anything over that cap, so AI-generated
    // content isn't silently rejected.
    description: z.string().optional(),
    duration: DurationSchema,
    // Phase 40 — how to convert this node's duration (and its `failureDelay`
    // and `crashOptions[].duration`) to hours. See DurationSemanticSchema.
    // `.default('time')` keeps pre-Phase-40 files loading byte-for-byte
    // identically — every legacy node parses as time-semantic, which is the
    // calendar-dependent behaviour the engine has always had.
    durationSemantic: DurationSemanticSchema.default('time'),
    position: z.object({ x: z.number(), y: z.number() }),
    // Optional canvas size (set when user resizes the node)
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    // Optional hex border color, e.g. "#6366f1"
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    // Optional swimlane group label — free-form string, e.g. "Design Phase".
    // Soft cap via load.ts preprocessor (SCHEMA_LIMITS.nodeGroup).
    group: z.string().optional(),
    // null = inherit project default calendar
    calendarId: z.string().min(1).max(SCHEMA_LIMITS.id).nullable(),
    // false = wait state (approval, delivery); contributes to timing but not resource histogram
    consumesResources: z.boolean(),
    resourceAssignments: z.array(ResourceAssignmentSchema).max(SCHEMA_LIMITS.resourceAssignments, {
      message: tooManyMsg('node.resourceAssignments', SCHEMA_LIMITS.resourceAssignments),
    }),
    distribution: DistributionSchema.optional(),
    // Phase 10 Tier 1 — only meaningful for `nodeType: 'start'`. Pins the
    // chain anchored at this Start node to the given calendar date instead
    // of `project.startDate`. Stored as YYYY-MM-DD (date-only, local time).
    // Ignored for activity/end/decision/subsystem nodes; absent on legacy files.
    anchorDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'anchorDate must be YYYY-MM-DD')
      .optional(),
    // Phase 11 — only meaningful for `nodeType: 'decision'`. Probability
    // the gate passes on first attempt; ∈ [0, 1]. Default 1.0 (always
    // passes) makes a decision with default values behave like an activity.
    passProbability: z.number().min(0).max(1).optional(),
    // Phase 11 — only meaningful for `nodeType: 'decision'`. Extra effort
    // consumed when the gate fails. Default 0 hours = no delay. Resources
    // are held for the full effective duration in both deterministic and
    // Monte Carlo paths.
    failureDelay: DurationSchema.optional(),
    // Phase 46 — the Phase 28 `isRisk` field was removed. Risks are now
    // purely derived (any decision with passProbability < 1, plus loops
    // with iteration variance and activities with high duration spread).
    // Legacy files with `isRisk: true` parse cleanly — Zod's default
    // `.strip()` silently drops the unknown key.
    // Phase 19 — only meaningful for `nodeType: 'activity' | 'decision'`.
    // One-time charge associated with the node itself (permits, materials,
    // license-per-run fees). The schema refine below rejects it on start /
    // end / subsystem nodes. See FixedCostSchema for distribution semantics.
    fixedCost: FixedCostSchema.optional(),
    // Phase 19 — only meaningful when the node is inside a loop body. Default
    // `false` (per-iteration charge — matches re-permit / re-test / repeated-
    // certification realities). Set to `true` when an iterative activity
    // legitimately re-uses a paid asset across iterations. The project-file
    // superRefine rejects `fixedCostOnce` on nodes that aren't a member of
    // any loop's bodyNodeIds.
    fixedCostOnce: z.boolean().optional(),
    // Phase 25 — only meaningful on activity / decision nodes. See
    // CrashOptionSchema for cross-field validation rules. Absent on legacy
    // files (engine treats absent identically to "no crash selected").
    crashOptions: z
      .array(CrashOptionSchema)
      .max(SCHEMA_LIMITS.crashOptions, {
        message: tooManyMsg('node.crashOptions', SCHEMA_LIMITS.crashOptions),
      })
      .optional(),
    // Phase 25 — index into `crashOptions` selecting the active crash. Absent
    // (the default) means "no crash applied — use nominal duration". Must
    // reference a valid entry; enforced by the NodeSchema refine below.
    selectedCrashIndex: z.number().int().nonnegative().optional(),
    // Phase 33 — Manual resource-leveling priority. Only meaningful on
    // activity / decision nodes (the only ones the leveler ever shifts).
    // The auto-leveler picks the LOWEST priority node to move when
    // resolving an over-capacity day, so higher values mean "less likely
    // to be moved" — a soft hard-escape-hatch. Default (absent) ≡ 0;
    // any non-negative integer is accepted. Absent on legacy files; the
    // schema refine below rejects it on start / end / subsystem.
    levelPriority: z.number().int().nonnegative().optional(),
  })
  .refine(
    // Activity / decision nodes must do real work; start/end/subsystem are zero-duration.
    (n) => (n.nodeType !== 'activity' && n.nodeType !== 'decision') || n.duration.value > 0,
    { message: 'activity / decision node duration must be positive', path: ['duration', 'value'] },
  )
  .refine(
    // Subsystem container nodes are zero-duration wrappers — the scheduler
    // flattens them; their effective timing comes from their body nodes.
    (n) => n.nodeType !== 'subsystem' || n.duration.value === 0,
    { message: 'subsystem node duration must be zero', path: ['duration', 'value'] },
  )
  .refine(
    // `passProbability` and `failureDelay` are only meaningful on
    // decision nodes. Reject them on other types so we don't silently accept
    // ambiguous data.
    (n) =>
      n.nodeType === 'decision' ||
      (n.passProbability === undefined && n.failureDelay === undefined),
    {
      message: 'passProbability / failureDelay are only valid on decision nodes',
      path: ['nodeType'],
    },
  )
  .refine(
    // Phase 19 — fixedCost / fixedCostOnce are only meaningful on activity /
    // decision nodes. Anchor nodes (start / end) and subsystem containers
    // never charge; rejecting at parse time prevents silent data loss when
    // a node type is changed after a cost was authored.
    (n) =>
      n.nodeType === 'activity' ||
      n.nodeType === 'decision' ||
      (n.fixedCost === undefined && n.fixedCostOnce === undefined),
    {
      message: 'fixedCost / fixedCostOnce are only valid on activity / decision nodes',
      path: ['nodeType'],
    },
  )
  .refine(
    // Phase 25 — crashOptions / selectedCrashIndex are only meaningful on
    // activity / decision nodes. Anchors are zero-duration; subsystems are
    // zero-duration containers — neither can be "compressed."
    (n) =>
      n.nodeType === 'activity' ||
      n.nodeType === 'decision' ||
      (n.crashOptions === undefined && n.selectedCrashIndex === undefined),
    {
      message: 'crashOptions / selectedCrashIndex are only valid on activity / decision nodes',
      path: ['nodeType'],
    },
  )
  .refine(
    // Phase 33 — levelPriority is only meaningful on activity / decision
    // nodes (the only types the auto-leveler ever shifts). Reject on
    // start / end / subsystem to prevent silent data loss when a node
    // type is changed after a priority was authored.
    (n) => n.nodeType === 'activity' || n.nodeType === 'decision' || n.levelPriority === undefined,
    {
      message: 'levelPriority is only valid on activity / decision nodes',
      path: ['nodeType'],
    },
  )
  .refine(
    // Phase 25 — every crash option must use the same unit as the node's
    // duration AND be strictly smaller. Same-unit keeps the comparison
    // unambiguous at parse time (no calendar context here). The Inspector
    // UI never exposes a unit picker on crash rows; it inherits the node's
    // unit. Compress, not extend.
    (n) =>
      !n.crashOptions ||
      n.crashOptions.every(
        (opt) => opt.duration.unit === n.duration.unit && opt.duration.value < n.duration.value,
      ),
    {
      message:
        'each crashOptions[i].duration must use the same unit as node.duration and be strictly shorter',
      path: ['crashOptions'],
    },
  )
  .refine(
    // Phase 25 — selectedCrashIndex must reference a valid entry. The
    // engine reads `crashOptions[selectedCrashIndex]`; rejecting at parse
    // time prevents the engine from silently ignoring a dangling pointer
    // after a row removal.
    (n) =>
      n.selectedCrashIndex === undefined ||
      (n.crashOptions !== undefined && n.selectedCrashIndex < n.crashOptions.length),
    {
      message: 'selectedCrashIndex must reference a valid crashOptions entry',
      path: ['selectedCrashIndex'],
    },
  );

// ── Edge ──────────────────────────────────────────────────────────────────────

export const EdgeTypeSchema = z.enum(['FS', 'SS', 'FF', 'SF']);

export const EdgeSchema = z.object({
  id: z.string().min(1).max(SCHEMA_LIMITS.id),
  from: z.string().min(1).max(SCHEMA_LIMITS.id),
  to: z.string().min(1).max(SCHEMA_LIMITS.id),
  type: EdgeTypeSchema,
  // signed lag: positive = gap, negative = overlap, 0 = no gap
  lag: LagDurationSchema,
});

// ── Loop ──────────────────────────────────────────────────────────────────────

const KickoutConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('maxIterations'), value: z.number().int().positive() }),
  z.object({ type: z.literal('timeBudget'), value: z.number().positive() }),
  z.object({ type: z.literal('convergenceCriterion'), threshold: z.number().positive() }),
  z.object({ type: z.literal('externalTrigger'), description: z.string() }),
]);

export const LoopSchema = z.object({
  id: z.string().min(1).max(SCHEMA_LIMITS.id),
  bodyNodeIds: z
    .array(z.string().min(1).max(SCHEMA_LIMITS.id))
    .min(1)
    .max(SCHEMA_LIMITS.bodyNodeIds, {
      message: tooManyMsg('loop.bodyNodeIds', SCHEMA_LIMITS.bodyNodeIds),
    }),
  kickout: KickoutConditionSchema,
  expectedIterations: DistributionSchema,
  // Optional swimlane group label — same concept as NodeSchema.group.
  // Soft cap via load.ts preprocessor (SCHEMA_LIMITS.loopGroup).
  group: z.string().optional(),
  // Phase 35 — optional free-text notes (purpose of the loop, kickout
  // rationale, real-world cycle the loop models). Same semantics as
  // NodeSchema.description: surfaced in LoopPanel, soft 2000-char counter
  // in the UI, generously capped via SCHEMA_LIMITS.loopDescription and the
  // load.ts preprocessor truncates anything over that cap.
  description: z.string().optional(),
});

// ── Scenario ──────────────────────────────────────────────────────────────────

const ScenarioNodeOverrideSchema = z.object({
  duration: DurationSchema.optional(),
  distribution: DistributionSchema.optional(),
});

export const ScenarioSchema = z.object({
  id: z.string().min(1).max(SCHEMA_LIMITS.id),
  // Free-text — soft cap via load.ts preprocessor (SCHEMA_LIMITS.scenarioName).
  name: z.string(),
  seed: z.number().int(),
  nodeOverrides: z.record(z.string(), ScenarioNodeOverrideSchema),
});

// ── Project settings ──────────────────────────────────────────────────────────

const ProjectSettingsSchema = z.object({
  // Free-text — soft cap via load.ts preprocessor (SCHEMA_LIMITS.projectName).
  name: z.string(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD'),
  defaultCalendarId: z.string().min(1).max(SCHEMA_LIMITS.id),
  displayUnit: DurationUnitSchema,
  // Phase 42 — `shareMode` controls how resource-assignment shares are
  // rendered / validated. `.default('percentage')` keeps pre-Phase-42
  // files loading without explicit migration: every legacy file parses
  // as if it had shareMode set to the default. Engine doesn't read this
  // field — it only affects schema validation and inspector UX.
  shareMode: ShareModeSchema.default('percentage'),
});

// ── Sub-system (Phase 12) ─────────────────────────────────────────────────────

// Provenance record stored when a sub-system was imported from a .calasub file.
// The embed-with-provenance model: the body is deep-copied into the parent
// project; no path is stored (paths break on file moves and cross-machine
// sharing). Content hash enables the "out of date?" check.
export const SubsystemSourceSchema = z.object({
  // Display name of the source file at import time (not used for resolution)
  fileName: z.string(),
  // SHA-256 hex digest of the .calasub file contents at import time
  contentHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'contentHash must be a 64-char SHA-256 hex string'),
  // ISO 8601 timestamp of the import
  importedAt: z.string().datetime(),
  // Sub-system name from the source file at import time
  sourceName: z.string(),
});

export const SubsystemSchema = z.object({
  id: z.string().min(1).max(SCHEMA_LIMITS.id),
  // ID of the node with nodeType: 'subsystem' on the parent canvas
  containerNodeId: z.string().min(1).max(SCHEMA_LIMITS.id),
  // IDs of all body nodes (live as ordinary nodes in the same ProjectFile)
  bodyNodeIds: z
    .array(z.string().min(1).max(SCHEMA_LIMITS.id))
    .min(1)
    .max(SCHEMA_LIMITS.bodyNodeIds, {
      message: tooManyMsg('subsystem.bodyNodeIds', SCHEMA_LIMITS.bodyNodeIds),
    }),
  // The body node that external predecessor edges lead into
  entryNodeId: z.string().min(1).max(SCHEMA_LIMITS.id),
  // The body node that external successor edges leave from
  exitNodeId: z.string().min(1).max(SCHEMA_LIMITS.id),
  // Optional swimlane group label (orthogonal to sub-system membership).
  // Soft cap via load.ts preprocessor (SCHEMA_LIMITS.nodeGroup).
  group: z.string().optional(),
  // Populated when this sub-system was imported from a .calasub file
  source: SubsystemSourceSchema.optional(),
});

// ── Comment (Phase 49 Slice 3) ────────────────────────────────────────────────
//
// Free-floating canvas annotations. Not attached to nodes — they live in
// flow-space (x, y) and the canvas combines them with project.nodes when
// rendering. The scheduler never sees comments. Plain text only for v1
// (no rich text, no threading, no node attachment).

export const CommentSchema = z.object({
  id: z.string().min(1).max(SCHEMA_LIMITS.id),
  // Flow-space coordinates (same coordinate system React Flow uses for
  // node positions — pan/zoom apply uniformly).
  x: z.number(),
  y: z.number(),
  // Free-text — soft cap applied via load.ts preprocessor truncation.
  text: z.string(),
});

// ── Shared cross-field invariant helpers (audit I-13) ─────────────────────────
// The V2..V8 ProjectFile schemas share large blocks of `.superRefine`
// validation. Before this slice each version inlined the full block,
// producing ~440 LOC of near-verbatim duplication across V5/V6 and
// V7/V8 (and partial duplication V2→V5). The helpers below own each
// invariant family once; each version's superRefine composes only
// the helpers that apply to it. Adding a new invariant in the future
// is one helper + one call site, not five.
//
// Helpers accept *structural* subsets of the project-file shape so
// any `ProjectFileVN` (each is a distinct Zod-inferred type) can be
// passed in without generics or casts.

type SubsystemShape = {
  id: string;
  containerNodeId: string;
  entryNodeId: string;
  exitNodeId: string;
  bodyNodeIds: ReadonlyArray<string>;
};

/**
 * V2+: subsystem container / entry / exit / body sanity checks +
 * multi-body-membership detection.
 */
function checkSubsystemBasics(
  file: {
    nodes: ReadonlyArray<{ id: string; nodeType: string }>;
    subsystems: ReadonlyArray<SubsystemShape>;
  },
  ctx: z.RefinementCtx,
): void {
  const nodeIds = new Set(file.nodes.map((n) => n.id));
  const subsystemNodeIds = new Set(
    file.nodes.filter((n) => n.nodeType === 'subsystem').map((n) => n.id),
  );
  const bodyMembership = new Map<string, string>();

  for (const sub of file.subsystems) {
    if (!subsystemNodeIds.has(sub.containerNodeId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `subsystem "${sub.id}": containerNodeId "${sub.containerNodeId}" must reference a node with nodeType 'subsystem'`,
        path: ['subsystems'],
      });
    }
    if (!sub.bodyNodeIds.includes(sub.entryNodeId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `subsystem "${sub.id}": entryNodeId "${sub.entryNodeId}" is not in bodyNodeIds`,
        path: ['subsystems'],
      });
    }
    if (!sub.bodyNodeIds.includes(sub.exitNodeId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `subsystem "${sub.id}": exitNodeId "${sub.exitNodeId}" is not in bodyNodeIds`,
        path: ['subsystems'],
      });
    }
    for (const nodeId of sub.bodyNodeIds) {
      if (!nodeIds.has(nodeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `subsystem "${sub.id}": bodyNodeId "${nodeId}" references a non-existent node`,
          path: ['subsystems'],
        });
      }
      const existing = bodyMembership.get(nodeId);
      if (existing !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `node "${nodeId}" belongs to both subsystem "${existing}" and subsystem "${sub.id}"`,
          path: ['subsystems'],
        });
      } else {
        bodyMembership.set(nodeId, sub.id);
      }
    }
  }
}

/**
 * V3+ (Phase 19): `fixedCostOnce` is only meaningful on nodes that belong
 * to some loop's bodyNodeIds. The domain store keeps this invariant on
 * every mutation (drops the field when a node leaves a loop); the schema
 * check is defence-in-depth for loaded files.
 */
function checkFixedCostOnceInLoop(
  file: {
    nodes: ReadonlyArray<{ id: string; fixedCostOnce?: unknown }>;
    loops: ReadonlyArray<{ bodyNodeIds: ReadonlyArray<string> }>;
  },
  ctx: z.RefinementCtx,
): void {
  const loopBodyNodeIds = new Set<string>(file.loops.flatMap((l) => l.bodyNodeIds));
  for (const node of file.nodes) {
    if (node.fixedCostOnce !== undefined && !loopBodyNodeIds.has(node.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `node "${node.id}": fixedCostOnce is only valid on nodes inside a loop body. ` +
          `Either remove fixedCostOnce, or add this node to a loop's bodyNodeIds.`,
        path: ['nodes'],
      });
    }
  }
}

/**
 * V5+ (Phase 42): resource-assignment share invariants. Lives at the
 * project superRefine because the percentage-mode sum constraint depends
 * on `project.shareMode`. All-or-none + sum > 0 are also enforced here
 * (rather than on NodeSchema) so error messages can name the node by id
 * and the mode-dependent percentage rule lives next to its peers.
 */
function checkShareInvariants(
  file: {
    project: { shareMode: string };
    nodes: ReadonlyArray<{
      id: string;
      resourceAssignments: ReadonlyArray<{ share?: number | undefined }>;
    }>;
  },
  ctx: z.RefinementCtx,
): void {
  const PERCENTAGE_SUM_TOLERANCE = 0.01;
  const isPercentageMode = file.project.shareMode === 'percentage';
  for (const node of file.nodes) {
    const shares = node.resourceAssignments.map((a) => a.share);
    const anySet = shares.some((s) => s !== undefined);
    if (!anySet) continue; // legacy mode for this node — nothing to check
    const allSet = shares.every((s) => s !== undefined);
    if (!allSet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `node "${node.id}": resource-assignment shares must be set on every ` +
          `assignment or none — partial share configurations are not allowed.`,
        path: ['nodes'],
      });
      continue;
    }
    const sum = (shares as number[]).reduce((s, v) => s + v, 0);
    if (sum <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `node "${node.id}": resource-assignment shares sum to 0 — at least ` +
          `one pool must have a positive share.`,
        path: ['nodes'],
      });
      continue;
    }
    if (isPercentageMode && Math.abs(sum - 100) > PERCENTAGE_SUM_TOLERANCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `node "${node.id}": resource-assignment shares sum to ${sum.toFixed(2)}, ` +
          `but project.shareMode is 'percentage' which requires sum = 100 ` +
          `(±${PERCENTAGE_SUM_TOLERANCE}). Either fix the shares or switch ` +
          `to weight mode in Project Settings.`,
        path: ['nodes'],
      });
    }
  }
}

/**
 * V7+ (Phase 50 Slice 3.5): every subsystem's entry/exit must reference
 * dedicated `subsystemEntry`/`subsystemExit` nodes; structural nodes
 * belong to exactly one subsystem; entry !== exit. Includes the orphan
 * pass (a `subsystemEntry`/`Exit` node that no subsystem claims) since
 * the claim maps are built here.
 */
function checkSubsystemStructuralPorts(
  file: {
    nodes: ReadonlyArray<{ id: string; nodeType: string }>;
    subsystems: ReadonlyArray<SubsystemShape>;
  },
  ctx: z.RefinementCtx,
): void {
  const nodeById = new Map(file.nodes.map((n) => [n.id, n]));
  const claimedAsEntry = new Map<string, string>();
  const claimedAsExit = new Map<string, string>();

  for (const sub of file.subsystems) {
    const entryNode = nodeById.get(sub.entryNodeId);
    if (entryNode && entryNode.nodeType !== 'subsystemEntry') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `subsystem "${sub.id}": entryNodeId "${sub.entryNodeId}" must reference a node with nodeType 'subsystemEntry' (got '${entryNode.nodeType}')`,
        path: ['subsystems'],
      });
    }
    const exitNode = nodeById.get(sub.exitNodeId);
    if (exitNode && exitNode.nodeType !== 'subsystemExit') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `subsystem "${sub.id}": exitNodeId "${sub.exitNodeId}" must reference a node with nodeType 'subsystemExit' (got '${exitNode.nodeType}')`,
        path: ['subsystems'],
      });
    }
    if (sub.entryNodeId === sub.exitNodeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `subsystem "${sub.id}": entryNodeId and exitNodeId must be distinct (a structural port can't double as both)`,
        path: ['subsystems'],
      });
    }
    const priorEntryClaim = claimedAsEntry.get(sub.entryNodeId);
    if (priorEntryClaim !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `subsystemEntry "${sub.entryNodeId}" is the entry of both subsystem "${priorEntryClaim}" and subsystem "${sub.id}"`,
        path: ['subsystems'],
      });
    } else {
      claimedAsEntry.set(sub.entryNodeId, sub.id);
    }
    const priorExitClaim = claimedAsExit.get(sub.exitNodeId);
    if (priorExitClaim !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `subsystemExit "${sub.exitNodeId}" is the exit of both subsystem "${priorExitClaim}" and subsystem "${sub.id}"`,
        path: ['subsystems'],
      });
    } else {
      claimedAsExit.set(sub.exitNodeId, sub.id);
    }
  }

  // Orphan pass: a structural node not claimed by any subsystem.
  for (const node of file.nodes) {
    if (node.nodeType === 'subsystemEntry' && !claimedAsEntry.has(node.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `orphan subsystemEntry "${node.id}": no subsystem claims it as entryNodeId. Either remove the node or attach it to a subsystem.`,
        path: ['nodes'],
      });
    }
    if (node.nodeType === 'subsystemExit' && !claimedAsExit.has(node.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `orphan subsystemExit "${node.id}": no subsystem claims it as exitNodeId. Either remove the node or attach it to a subsystem.`,
        path: ['nodes'],
      });
    }
  }
}

/**
 * V7+ (Phase 50 Slice 18 / audit I-3): a subsystem A nests subsystem B
 * when B's containerNodeId appears in A.bodyNodeIds. Cycles ("A contains
 * B contains A") are nonsensical: downstream `flatten.ts`'s
 * `nestingDepth` silently returns 0 via its visited guard, producing
 * non-deterministic schedules. Reject at parse time with a clear cycle
 * path. Standard DFS with WHITE / GREY / BLACK coloring; a grey
 * neighbour is a back-edge → cycle.
 */
function checkSubsystemNestingCycles(
  file: { subsystems: ReadonlyArray<SubsystemShape> },
  ctx: z.RefinementCtx,
): void {
  const containerToSubsystemId = new Map<string, string>();
  for (const sub of file.subsystems) {
    containerToSubsystemId.set(sub.containerNodeId, sub.id);
  }
  const childSubsystems = new Map<string, string[]>();
  for (const sub of file.subsystems) {
    const kids: string[] = [];
    for (const bodyId of sub.bodyNodeIds) {
      const childId = containerToSubsystemId.get(bodyId);
      if (childId !== undefined && childId !== sub.id) kids.push(childId);
    }
    childSubsystems.set(sub.id, kids);
  }
  const WHITE = 0,
    GREY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const sub of file.subsystems) color.set(sub.id, WHITE);
  const stack: string[] = [];
  const reportedCycles = new Set<string>();
  function visitForCycles(subId: string): void {
    color.set(subId, GREY);
    stack.push(subId);
    for (const childId of childSubsystems.get(subId) ?? []) {
      const c = color.get(childId);
      if (c === GREY) {
        const idx = stack.indexOf(childId);
        const cyclePath = [...stack.slice(idx), childId];
        // De-dupe cycle reports by canonical rotation (cycles are
        // unordered loops; reporting the same loop entered from a
        // different starting point would be noise).
        const minIdx = cyclePath.indexOf(
          cyclePath.slice(0, -1).reduce((m, v) => (v < m ? v : m), cyclePath[0]!),
        );
        const key = [...cyclePath.slice(minIdx, -1), ...cyclePath.slice(0, minIdx)].join('->');
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `subsystem nesting cycle: ${cyclePath.join(' → ')}. ` +
              `A subsystem can't contain itself (directly or transitively) — ` +
              `remove one of the containerNodeId references from a bodyNodeIds list.`,
            path: ['subsystems'],
          });
        }
      } else if (c === WHITE) {
        visitForCycles(childId);
      }
    }
    stack.pop();
    color.set(subId, BLACK);
  }
  for (const sub of file.subsystems) {
    if (color.get(sub.id) === WHITE) visitForCycles(sub.id);
  }
}

// ── Root schema (v1 — legacy) ─────────────────────────────────────────────────
// Kept for reading files written by Phase 11 and earlier builds.
// loadProjectFile migrates v1 → v2 in memory; no data is lost.

export const ProjectFileV1 = z.object({
  version: z.literal(1),
  project: ProjectSettingsSchema,
  calendars: z
    .array(CalendarSchema)
    .max(SCHEMA_LIMITS.calendars, { message: tooManyMsg('calendars', SCHEMA_LIMITS.calendars) }),
  resources: z
    .array(ResourceSchema)
    .max(SCHEMA_LIMITS.resources, { message: tooManyMsg('resources', SCHEMA_LIMITS.resources) }),
  nodes: z
    .array(NodeSchema)
    .max(SCHEMA_LIMITS.nodes, { message: tooManyMsg('nodes', SCHEMA_LIMITS.nodes) }),
  edges: z
    .array(EdgeSchema)
    .max(SCHEMA_LIMITS.edges, { message: tooManyMsg('edges', SCHEMA_LIMITS.edges) }),
  loops: z
    .array(LoopSchema)
    .max(SCHEMA_LIMITS.loops, { message: tooManyMsg('loops', SCHEMA_LIMITS.loops) }),
  scenarios: z
    .array(ScenarioSchema)
    .max(SCHEMA_LIMITS.scenarios, { message: tooManyMsg('scenarios', SCHEMA_LIMITS.scenarios) }),
});

// ── Root schema (v2) ──────────────────────────────────────────────────────────
// New saves write v2. v1 files are migrated on load (migrateV1ToV2).
// Phase 13 adds `kind` as a top-level discriminator so JSON Schema tooling
// can distinguish project files from subsystem files. Old v2 files without
// the field are accepted — .default() fills it in transparently on parse.

export const ProjectFileV2 = z
  .object({
    kind: z.literal('caladia-project').default('caladia-project'),
    version: z.literal(2),
    project: ProjectSettingsSchema,
    calendars: z
      .array(CalendarSchema)
      .max(SCHEMA_LIMITS.calendars, { message: tooManyMsg('calendars', SCHEMA_LIMITS.calendars) }),
    resources: z
      .array(ResourceSchema)
      .max(SCHEMA_LIMITS.resources, { message: tooManyMsg('resources', SCHEMA_LIMITS.resources) }),
    nodes: z
      .array(NodeSchema)
      .max(SCHEMA_LIMITS.nodes, { message: tooManyMsg('nodes', SCHEMA_LIMITS.nodes) }),
    edges: z
      .array(EdgeSchema)
      .max(SCHEMA_LIMITS.edges, { message: tooManyMsg('edges', SCHEMA_LIMITS.edges) }),
    loops: z
      .array(LoopSchema)
      .max(SCHEMA_LIMITS.loops, { message: tooManyMsg('loops', SCHEMA_LIMITS.loops) }),
    subsystems: z.array(SubsystemSchema).max(SCHEMA_LIMITS.subsystems, {
      message: tooManyMsg('subsystems', SCHEMA_LIMITS.subsystems),
    }),
    scenarios: z
      .array(ScenarioSchema)
      .max(SCHEMA_LIMITS.scenarios, { message: tooManyMsg('scenarios', SCHEMA_LIMITS.scenarios) }),
  })
  .superRefine((file, ctx) => {
    // Cross-field validation for subsystems.
    checkSubsystemBasics(file, ctx);
  });

// ── Root schema (v3) ──────────────────────────────────────────────────────────
// Phase 19 — Cost modelling (V0.8). Adds project-level `currency` and a
// pinned `fxSnapshotVersion` (both required on v3; the v2 → v3 migration
// fills them in for legacy files) plus the optional `budget` consumed by
// the Verdict-bar Budget tile. Cost-bearing fields on Resource and Node
// are shared across schemas (older versions never wrote them; new saves
// may set them when authoring against v3).
//
// New saves write v3. v2 / v1 files are migrated forward on load.

export const ProjectFileV3 = z
  .object({
    kind: z.literal('caladia-project').default('caladia-project'),
    version: z.literal(3),
    project: ProjectSettingsSchema,
    // ISO 4217 alphabetic currency code (3 uppercase letters). Required on v3
    // — engine and UI assume it's always present post-parse. The migration
    // from v2 fills in 'USD' for legacy files.
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code'),
    // Pinned FX snapshot version for Slice-4 display-conversion. v3 files
    // carry this even when the user never enables conversion; pinning at
    // save time is the same pattern as holiday presets — files never
    // auto-upgrade on load.
    fxSnapshotVersion: z.string().min(1).max(200),
    // Optional project budget (in project currency). Consumed by the
    // Verdict-bar Budget tile and the "% chance of meeting budget" probability.
    budget: z.number().nonnegative().optional(),
    // Phase 19 slice 4 follow-up — user-edited overrides applied on top of
    // the pinned FX snapshot. Same shape and convention as the snapshot's
    // `rates` field: ISO code → foreign-per-1-USD-base. A sparse map; absent
    // entries fall through to the snapshot. Stored on the project so user
    // edits travel with the .cala file.
    fxRateOverrides: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive()).optional(),
    calendars: z
      .array(CalendarSchema)
      .max(SCHEMA_LIMITS.calendars, { message: tooManyMsg('calendars', SCHEMA_LIMITS.calendars) }),
    resources: z
      .array(ResourceSchema)
      .max(SCHEMA_LIMITS.resources, { message: tooManyMsg('resources', SCHEMA_LIMITS.resources) }),
    nodes: z
      .array(NodeSchema)
      .max(SCHEMA_LIMITS.nodes, { message: tooManyMsg('nodes', SCHEMA_LIMITS.nodes) }),
    edges: z
      .array(EdgeSchema)
      .max(SCHEMA_LIMITS.edges, { message: tooManyMsg('edges', SCHEMA_LIMITS.edges) }),
    loops: z
      .array(LoopSchema)
      .max(SCHEMA_LIMITS.loops, { message: tooManyMsg('loops', SCHEMA_LIMITS.loops) }),
    subsystems: z.array(SubsystemSchema).max(SCHEMA_LIMITS.subsystems, {
      message: tooManyMsg('subsystems', SCHEMA_LIMITS.subsystems),
    }),
    scenarios: z
      .array(ScenarioSchema)
      .max(SCHEMA_LIMITS.scenarios, { message: tooManyMsg('scenarios', SCHEMA_LIMITS.scenarios) }),
  })
  .superRefine((file, ctx) => {
    checkSubsystemBasics(file, ctx);
    // Phase 19 — `fixedCostOnce` cross-field check added in V3.
    checkFixedCostOnceInLoop(file, ctx);
  });

// ── Root schema (v4) ──────────────────────────────────────────────────────────
// Phase 40 — adds `durationSemantic` to every node so duration's days/weeks
// units can be calendar-independent ("effort") or calendar-relative ("time").
// V3 files migrate forward on load: the .default('time') on NodeSchema fills
// in 'time' for every legacy node before the version stamp is bumped, which
// preserves pre-Phase-40 scheduling byte-for-byte. NodeSchema is shared with
// V1 / V2 / V3 — the only difference at the root level is the version literal.

export const ProjectFileV4 = z
  .object({
    kind: z.literal('caladia-project').default('caladia-project'),
    version: z.literal(4),
    project: ProjectSettingsSchema,
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code'),
    fxSnapshotVersion: z.string().min(1).max(200),
    budget: z.number().nonnegative().optional(),
    fxRateOverrides: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive()).optional(),
    calendars: z
      .array(CalendarSchema)
      .max(SCHEMA_LIMITS.calendars, { message: tooManyMsg('calendars', SCHEMA_LIMITS.calendars) }),
    resources: z
      .array(ResourceSchema)
      .max(SCHEMA_LIMITS.resources, { message: tooManyMsg('resources', SCHEMA_LIMITS.resources) }),
    nodes: z
      .array(NodeSchema)
      .max(SCHEMA_LIMITS.nodes, { message: tooManyMsg('nodes', SCHEMA_LIMITS.nodes) }),
    edges: z
      .array(EdgeSchema)
      .max(SCHEMA_LIMITS.edges, { message: tooManyMsg('edges', SCHEMA_LIMITS.edges) }),
    loops: z
      .array(LoopSchema)
      .max(SCHEMA_LIMITS.loops, { message: tooManyMsg('loops', SCHEMA_LIMITS.loops) }),
    subsystems: z.array(SubsystemSchema).max(SCHEMA_LIMITS.subsystems, {
      message: tooManyMsg('subsystems', SCHEMA_LIMITS.subsystems),
    }),
    scenarios: z
      .array(ScenarioSchema)
      .max(SCHEMA_LIMITS.scenarios, { message: tooManyMsg('scenarios', SCHEMA_LIMITS.scenarios) }),
  })
  .superRefine((file, ctx) => {
    // Cross-field invariants carried over from V3 verbatim.
    checkSubsystemBasics(file, ctx);
    checkFixedCostOnceInLoop(file, ctx);
  });

// ── Root schema (v5) ──────────────────────────────────────────────────────────
// Phase 42 — adds per-resource-assignment `share` (split an activity's effort
// across pools) and a project-level `shareMode` controlling validation +
// inspector UX. V4 files migrate forward on load: the .default('percentage')
// on ProjectSettingsSchema.shareMode fills in 'percentage' for legacy files,
// and the cross-field invariants are vacuously satisfied when no assignment
// has `share` set. Pre-Phase-42 scheduling stays byte-for-byte identical.
//
// Cross-field invariants (per node, when any of its assignments has `share`
// set):
//   1. All-or-none — partial shares (some set, some absent) are rejected.
//   2. Sum > 0 — schema rejects all-zero share configurations.
//   3. When project.shareMode === 'percentage', |sum − 100| < 0.01 (float
//      tolerance for hand-authored decimals like 33.33).

export const ProjectFileV5 = z
  .object({
    kind: z.literal('caladia-project').default('caladia-project'),
    version: z.literal(5),
    project: ProjectSettingsSchema,
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code'),
    fxSnapshotVersion: z.string().min(1).max(200),
    budget: z.number().nonnegative().optional(),
    fxRateOverrides: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive()).optional(),
    calendars: z
      .array(CalendarSchema)
      .max(SCHEMA_LIMITS.calendars, { message: tooManyMsg('calendars', SCHEMA_LIMITS.calendars) }),
    resources: z
      .array(ResourceSchema)
      .max(SCHEMA_LIMITS.resources, { message: tooManyMsg('resources', SCHEMA_LIMITS.resources) }),
    nodes: z
      .array(NodeSchema)
      .max(SCHEMA_LIMITS.nodes, { message: tooManyMsg('nodes', SCHEMA_LIMITS.nodes) }),
    edges: z
      .array(EdgeSchema)
      .max(SCHEMA_LIMITS.edges, { message: tooManyMsg('edges', SCHEMA_LIMITS.edges) }),
    loops: z
      .array(LoopSchema)
      .max(SCHEMA_LIMITS.loops, { message: tooManyMsg('loops', SCHEMA_LIMITS.loops) }),
    subsystems: z.array(SubsystemSchema).max(SCHEMA_LIMITS.subsystems, {
      message: tooManyMsg('subsystems', SCHEMA_LIMITS.subsystems),
    }),
    scenarios: z
      .array(ScenarioSchema)
      .max(SCHEMA_LIMITS.scenarios, { message: tooManyMsg('scenarios', SCHEMA_LIMITS.scenarios) }),
  })
  .superRefine((file, ctx) => {
    // Subsystem + fixedCostOnce invariants carried from V3/V4 verbatim.
    checkSubsystemBasics(file, ctx);
    checkFixedCostOnceInLoop(file, ctx);
    // Phase 42 — share invariants introduced in V5.
    checkShareInvariants(file, ctx);
  });

// ── Root schema (v6) ──────────────────────────────────────────────────────────
// Phase 49 Slice 3 — adds the `comments` array for free-floating canvas
// annotations. V5 files migrate forward on load: migrateV5ToV6 re-stamps
// the version and seeds `comments: []`. Pre-Phase-49 behaviour stays
// byte-for-byte identical for projects with no comments.
//
// Cross-field invariants are inherited verbatim from V5 (subsystem,
// fixedCostOnce-in-loop, share-sum). Comments have no cross-field
// invariants — they're decoupled from nodes / edges / scheduling.

export const ProjectFileV6 = z
  .object({
    kind: z.literal('caladia-project').default('caladia-project'),
    version: z.literal(6),
    project: ProjectSettingsSchema,
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code'),
    fxSnapshotVersion: z.string().min(1).max(200),
    budget: z.number().nonnegative().optional(),
    fxRateOverrides: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive()).optional(),
    calendars: z
      .array(CalendarSchema)
      .max(SCHEMA_LIMITS.calendars, { message: tooManyMsg('calendars', SCHEMA_LIMITS.calendars) }),
    resources: z
      .array(ResourceSchema)
      .max(SCHEMA_LIMITS.resources, { message: tooManyMsg('resources', SCHEMA_LIMITS.resources) }),
    nodes: z
      .array(NodeSchema)
      .max(SCHEMA_LIMITS.nodes, { message: tooManyMsg('nodes', SCHEMA_LIMITS.nodes) }),
    edges: z
      .array(EdgeSchema)
      .max(SCHEMA_LIMITS.edges, { message: tooManyMsg('edges', SCHEMA_LIMITS.edges) }),
    loops: z
      .array(LoopSchema)
      .max(SCHEMA_LIMITS.loops, { message: tooManyMsg('loops', SCHEMA_LIMITS.loops) }),
    subsystems: z.array(SubsystemSchema).max(SCHEMA_LIMITS.subsystems, {
      message: tooManyMsg('subsystems', SCHEMA_LIMITS.subsystems),
    }),
    scenarios: z
      .array(ScenarioSchema)
      .max(SCHEMA_LIMITS.scenarios, { message: tooManyMsg('scenarios', SCHEMA_LIMITS.scenarios) }),
    comments: z
      .array(CommentSchema)
      .max(SCHEMA_LIMITS.comments, { message: tooManyMsg('comments', SCHEMA_LIMITS.comments) }),
  })
  .superRefine((file, ctx) => {
    // Cross-field invariants — identical to V5.
    checkSubsystemBasics(file, ctx);
    checkFixedCostOnceInLoop(file, ctx);
    checkShareInvariants(file, ctx);
  });

// ── Root schema (v7 — Phase 50 Slice 3.5) ───────────────────────────────────
//
// V7 introduces Simulink-style structural ports for subsystems:
//   - `NodeTypeSchema` carries new `subsystemEntry` / `subsystemExit` values.
//   - Every subsystem owns exactly one `subsystemEntry` node and one
//     `subsystemExit` node, both in its `bodyNodeIds`. The subsystem's
//     `entryNodeId` / `exitNodeId` always reference those structural nodes.
//   - The structural Entry has a single outgoing edge to the "natural"
//     entry of the body (the first user activity); the structural Exit
//     has a single incoming edge from the natural exit. External edges
//     still attach to the container node on the parent canvas — the
//     structural nodes are pure-internal.
//   - Structural Entry / Exit are NOT user-deletable (delete refusal in
//     `deleteNodes` blocks them with a role-named toast).
//
// Auto-migrated from V6 by `migrateV6ToV7` (loads any legacy subsystem
// and injects the structural pair with bookend edges so the on-disk
// shape is consistent). V6 files round-trip cleanly through this V7
// schema after migration.

export const ProjectFileV7 = z
  .object({
    kind: z.literal('caladia-project').default('caladia-project'),
    version: z.literal(7),
    project: ProjectSettingsSchema,
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code'),
    fxSnapshotVersion: z.string().min(1).max(200),
    budget: z.number().nonnegative().optional(),
    fxRateOverrides: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive()).optional(),
    calendars: z
      .array(CalendarSchema)
      .max(SCHEMA_LIMITS.calendars, { message: tooManyMsg('calendars', SCHEMA_LIMITS.calendars) }),
    resources: z
      .array(ResourceSchema)
      .max(SCHEMA_LIMITS.resources, { message: tooManyMsg('resources', SCHEMA_LIMITS.resources) }),
    nodes: z
      .array(NodeSchema)
      .max(SCHEMA_LIMITS.nodes, { message: tooManyMsg('nodes', SCHEMA_LIMITS.nodes) }),
    edges: z
      .array(EdgeSchema)
      .max(SCHEMA_LIMITS.edges, { message: tooManyMsg('edges', SCHEMA_LIMITS.edges) }),
    loops: z
      .array(LoopSchema)
      .max(SCHEMA_LIMITS.loops, { message: tooManyMsg('loops', SCHEMA_LIMITS.loops) }),
    subsystems: z.array(SubsystemSchema).max(SCHEMA_LIMITS.subsystems, {
      message: tooManyMsg('subsystems', SCHEMA_LIMITS.subsystems),
    }),
    scenarios: z
      .array(ScenarioSchema)
      .max(SCHEMA_LIMITS.scenarios, { message: tooManyMsg('scenarios', SCHEMA_LIMITS.scenarios) }),
    comments: z
      .array(CommentSchema)
      .max(SCHEMA_LIMITS.comments, { message: tooManyMsg('comments', SCHEMA_LIMITS.comments) }),
  })
  .superRefine((file, ctx) => {
    // V7 invariants: V6's cross-field checks plus the structural-port
    // invariants (every subsystem's entry/exit references dedicated
    // subsystemEntry/Exit nodes; orphan + double-claim detection) and
    // subsystem nesting cycle detection introduced by audit I-3.
    checkSubsystemBasics(file, ctx);
    checkSubsystemStructuralPorts(file, ctx);
    checkSubsystemNestingCycles(file, ctx);
    checkFixedCostOnceInLoop(file, ctx);
    checkShareInvariants(file, ctx);
  });

// ── Root schema (v8 — backlog Slice 6 / audit I-18) ──────────────────────────
//
// V8 adds a top-level `groupColors` map (group-name → hex color). V7 stored
// these in `viewStore` (transient session state), so they were lost on reload
// and weren't undoable. Per CLAUDE.md, group colors are a domain concern —
// they belong on the project, persist through save/load, and flow through the
// temporal-history undo stack like any other domain edit.
//
// Auto-migrated from V7 by `migrateV7ToV8` (sets `groupColors: {}`). V7 files
// round-trip cleanly through this schema after migration.

export const ProjectFileV8 = z
  .object({
    kind: z.literal('caladia-project').default('caladia-project'),
    version: z.literal(8),
    project: ProjectSettingsSchema,
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code'),
    fxSnapshotVersion: z.string().min(1).max(200),
    budget: z.number().nonnegative().optional(),
    fxRateOverrides: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive()).optional(),
    calendars: z
      .array(CalendarSchema)
      .max(SCHEMA_LIMITS.calendars, { message: tooManyMsg('calendars', SCHEMA_LIMITS.calendars) }),
    resources: z
      .array(ResourceSchema)
      .max(SCHEMA_LIMITS.resources, { message: tooManyMsg('resources', SCHEMA_LIMITS.resources) }),
    nodes: z
      .array(NodeSchema)
      .max(SCHEMA_LIMITS.nodes, { message: tooManyMsg('nodes', SCHEMA_LIMITS.nodes) }),
    edges: z
      .array(EdgeSchema)
      .max(SCHEMA_LIMITS.edges, { message: tooManyMsg('edges', SCHEMA_LIMITS.edges) }),
    loops: z
      .array(LoopSchema)
      .max(SCHEMA_LIMITS.loops, { message: tooManyMsg('loops', SCHEMA_LIMITS.loops) }),
    subsystems: z.array(SubsystemSchema).max(SCHEMA_LIMITS.subsystems, {
      message: tooManyMsg('subsystems', SCHEMA_LIMITS.subsystems),
    }),
    scenarios: z
      .array(ScenarioSchema)
      .max(SCHEMA_LIMITS.scenarios, { message: tooManyMsg('scenarios', SCHEMA_LIMITS.scenarios) }),
    comments: z
      .array(CommentSchema)
      .max(SCHEMA_LIMITS.comments, { message: tooManyMsg('comments', SCHEMA_LIMITS.comments) }),
    // Group name → hex color override. Empty by default; absent entries fall
    // through to the auto palette in `utils/groupColors.ts`. Same hex-format
    // regex as NodeSchema's `color` field.
    groupColors: z.record(
      z.string(),
      z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, 'groupColors values must be 6-digit hex (e.g. "#6366f1")'),
    ),
  })
  .superRefine((file, ctx) => {
    // V8 invariants: identical to V7. Audit I-13 dedup pass — both now
    // compose the same helpers, so adding a new invariant for V8+ is one
    // helper + one call site, not five.
    checkSubsystemBasics(file, ctx);
    checkSubsystemStructuralPorts(file, ctx);
    checkSubsystemNestingCycles(file, ctx);
    checkFixedCostOnceInLoop(file, ctx);
    checkShareInvariants(file, ctx);
  });

// ── Stand-alone sub-system file (.calasub) ────────────────────────────────────
// A stripped-down format containing a reusable sub-system body with no
// project-level settings. The `kind` discriminator prevents confusion with
// ProjectFile at parse time. On import into a parent project the body is
// deep-embedded (embed-with-provenance); no path references are stored.

export const SubsystemFileV1 = z
  .object({
    kind: z.literal('caladia-subsystem'),
    version: z.literal(1),
    name: z.string(),
    nodes: z
      .array(NodeSchema)
      .max(SCHEMA_LIMITS.nodes, { message: tooManyMsg('nodes', SCHEMA_LIMITS.nodes) }),
    edges: z
      .array(EdgeSchema)
      .max(SCHEMA_LIMITS.edges, { message: tooManyMsg('edges', SCHEMA_LIMITS.edges) }),
    loops: z
      .array(LoopSchema)
      .max(SCHEMA_LIMITS.loops, { message: tooManyMsg('loops', SCHEMA_LIMITS.loops) }),
    calendars: z
      .array(CalendarSchema)
      .max(SCHEMA_LIMITS.calendars, { message: tooManyMsg('calendars', SCHEMA_LIMITS.calendars) }),
    resources: z
      .array(ResourceSchema)
      .max(SCHEMA_LIMITS.resources, { message: tooManyMsg('resources', SCHEMA_LIMITS.resources) }),
    entryNodeId: z.string().min(1).max(SCHEMA_LIMITS.id),
    exitNodeId: z.string().min(1).max(SCHEMA_LIMITS.id),
    // Nested sub-systems inside this body (supports arbitrary nesting)
    subsystems: z.array(SubsystemSchema).max(SCHEMA_LIMITS.subsystems, {
      message: tooManyMsg('subsystems', SCHEMA_LIMITS.subsystems),
    }),
  })
  .superRefine((file, ctx) => {
    const nodeIds = new Set(file.nodes.map((n) => n.id));
    if (!nodeIds.has(file.entryNodeId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `entryNodeId "${file.entryNodeId}" does not reference a node in this file`,
        path: ['entryNodeId'],
      });
    }
    if (!nodeIds.has(file.exitNodeId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `exitNodeId "${file.exitNodeId}" does not reference a node in this file`,
        path: ['exitNodeId'],
      });
    }
  });

// ── Stand-alone sub-system file v2 (Phase 19) ────────────────────────────────
// Same shape as V1; the version bump tracks the project schema bump because
// the embedded Node / Resource schemas now carry optional cost fields. V1
// files (no cost data) remain parseable and migrate forward by re-stamping.

export const SubsystemFileV2 = z
  .object({
    kind: z.literal('caladia-subsystem'),
    version: z.literal(2),
    name: z.string(),
    nodes: z
      .array(NodeSchema)
      .max(SCHEMA_LIMITS.nodes, { message: tooManyMsg('nodes', SCHEMA_LIMITS.nodes) }),
    edges: z
      .array(EdgeSchema)
      .max(SCHEMA_LIMITS.edges, { message: tooManyMsg('edges', SCHEMA_LIMITS.edges) }),
    loops: z
      .array(LoopSchema)
      .max(SCHEMA_LIMITS.loops, { message: tooManyMsg('loops', SCHEMA_LIMITS.loops) }),
    calendars: z
      .array(CalendarSchema)
      .max(SCHEMA_LIMITS.calendars, { message: tooManyMsg('calendars', SCHEMA_LIMITS.calendars) }),
    resources: z
      .array(ResourceSchema)
      .max(SCHEMA_LIMITS.resources, { message: tooManyMsg('resources', SCHEMA_LIMITS.resources) }),
    entryNodeId: z.string().min(1).max(SCHEMA_LIMITS.id),
    exitNodeId: z.string().min(1).max(SCHEMA_LIMITS.id),
    subsystems: z.array(SubsystemSchema).max(SCHEMA_LIMITS.subsystems, {
      message: tooManyMsg('subsystems', SCHEMA_LIMITS.subsystems),
    }),
  })
  .superRefine((file, ctx) => {
    const nodeIds = new Set(file.nodes.map((n) => n.id));
    if (!nodeIds.has(file.entryNodeId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `entryNodeId "${file.entryNodeId}" does not reference a node in this file`,
        path: ['entryNodeId'],
      });
    }
    if (!nodeIds.has(file.exitNodeId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `exitNodeId "${file.exitNodeId}" does not reference a node in this file`,
        path: ['exitNodeId'],
      });
    }
  });

// ── Stand-alone sub-system file v3 (Phase 40) ────────────────────────────────
// Same shape as V2; the version bump tracks the project schema bump because
// NodeSchema now carries the `durationSemantic` field. V1 / V2 files (no
// per-node semantic) remain parseable and migrate forward by re-stamping —
// NodeSchema's .default('time') auto-fills the field at parse time.

export const SubsystemFileV3 = z
  .object({
    kind: z.literal('caladia-subsystem'),
    version: z.literal(3),
    name: z.string(),
    nodes: z
      .array(NodeSchema)
      .max(SCHEMA_LIMITS.nodes, { message: tooManyMsg('nodes', SCHEMA_LIMITS.nodes) }),
    edges: z
      .array(EdgeSchema)
      .max(SCHEMA_LIMITS.edges, { message: tooManyMsg('edges', SCHEMA_LIMITS.edges) }),
    loops: z
      .array(LoopSchema)
      .max(SCHEMA_LIMITS.loops, { message: tooManyMsg('loops', SCHEMA_LIMITS.loops) }),
    calendars: z
      .array(CalendarSchema)
      .max(SCHEMA_LIMITS.calendars, { message: tooManyMsg('calendars', SCHEMA_LIMITS.calendars) }),
    resources: z
      .array(ResourceSchema)
      .max(SCHEMA_LIMITS.resources, { message: tooManyMsg('resources', SCHEMA_LIMITS.resources) }),
    entryNodeId: z.string().min(1).max(SCHEMA_LIMITS.id),
    exitNodeId: z.string().min(1).max(SCHEMA_LIMITS.id),
    subsystems: z.array(SubsystemSchema).max(SCHEMA_LIMITS.subsystems, {
      message: tooManyMsg('subsystems', SCHEMA_LIMITS.subsystems),
    }),
  })
  .superRefine((file, ctx) => {
    const nodeIds = new Set(file.nodes.map((n) => n.id));
    if (!nodeIds.has(file.entryNodeId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `entryNodeId "${file.entryNodeId}" does not reference a node in this file`,
        path: ['entryNodeId'],
      });
    }
    if (!nodeIds.has(file.exitNodeId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `exitNodeId "${file.exitNodeId}" does not reference a node in this file`,
        path: ['exitNodeId'],
      });
    }
  });

// ── Stand-alone sub-system file v4 (Phase 42) ────────────────────────────────
// Same shape as V3; the version bump tracks the project schema bump because
// the embedded ResourceAssignmentSchema now carries the optional `share` field
// (and the project schema gains `shareMode`). V1 / V2 / V3 files (no shares)
// remain parseable and migrate forward by re-stamping the version.

export const SubsystemFileV4 = z
  .object({
    kind: z.literal('caladia-subsystem'),
    version: z.literal(4),
    name: z.string(),
    nodes: z
      .array(NodeSchema)
      .max(SCHEMA_LIMITS.nodes, { message: tooManyMsg('nodes', SCHEMA_LIMITS.nodes) }),
    edges: z
      .array(EdgeSchema)
      .max(SCHEMA_LIMITS.edges, { message: tooManyMsg('edges', SCHEMA_LIMITS.edges) }),
    loops: z
      .array(LoopSchema)
      .max(SCHEMA_LIMITS.loops, { message: tooManyMsg('loops', SCHEMA_LIMITS.loops) }),
    calendars: z
      .array(CalendarSchema)
      .max(SCHEMA_LIMITS.calendars, { message: tooManyMsg('calendars', SCHEMA_LIMITS.calendars) }),
    resources: z
      .array(ResourceSchema)
      .max(SCHEMA_LIMITS.resources, { message: tooManyMsg('resources', SCHEMA_LIMITS.resources) }),
    entryNodeId: z.string().min(1).max(SCHEMA_LIMITS.id),
    exitNodeId: z.string().min(1).max(SCHEMA_LIMITS.id),
    subsystems: z.array(SubsystemSchema).max(SCHEMA_LIMITS.subsystems, {
      message: tooManyMsg('subsystems', SCHEMA_LIMITS.subsystems),
    }),
  })
  .superRefine((file, ctx) => {
    // Audit I-4 — mirror the project-level subsystem invariants for the
    // standalone .calasub form. The top-level entry/exit (file-level)
    // are kept loose: a .calasub authored pre-V7-port-injection points
    // them at natural nodes, and the import path wraps them in structural
    // ports at embed time. The NESTED subsystems inside the body must
    // follow the same V7 rules as project subsystems — they're already
    // post-V7 by definition (V4 calasub == post-Phase-50 schema). Share
    // invariants are skipped: no `project.shareMode` exists here.
    const nodeIds = new Set(file.nodes.map((n) => n.id));
    if (!nodeIds.has(file.entryNodeId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `entryNodeId "${file.entryNodeId}" does not reference a node in this file`,
        path: ['entryNodeId'],
      });
    }
    if (!nodeIds.has(file.exitNodeId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `exitNodeId "${file.exitNodeId}" does not reference a node in this file`,
        path: ['exitNodeId'],
      });
    }

    const subsystemNodeIds = new Set(
      file.nodes.filter((n) => n.nodeType === 'subsystem').map((n) => n.id),
    );
    const nodeById = new Map(file.nodes.map((n) => [n.id, n]));
    const bodyMembership = new Map<string, string>();
    const claimedAsEntry = new Map<string, string>();
    const claimedAsExit = new Map<string, string>();

    for (const sub of file.subsystems) {
      if (!subsystemNodeIds.has(sub.containerNodeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `subsystem "${sub.id}": containerNodeId "${sub.containerNodeId}" must reference a node with nodeType 'subsystem'`,
          path: ['subsystems'],
        });
      }
      if (!sub.bodyNodeIds.includes(sub.entryNodeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `subsystem "${sub.id}": entryNodeId "${sub.entryNodeId}" is not in bodyNodeIds`,
          path: ['subsystems'],
        });
      }
      if (!sub.bodyNodeIds.includes(sub.exitNodeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `subsystem "${sub.id}": exitNodeId "${sub.exitNodeId}" is not in bodyNodeIds`,
          path: ['subsystems'],
        });
      }
      const entryNode = nodeById.get(sub.entryNodeId);
      if (entryNode && entryNode.nodeType !== 'subsystemEntry') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `subsystem "${sub.id}": entryNodeId "${sub.entryNodeId}" must reference a node with nodeType 'subsystemEntry' (got '${entryNode.nodeType}')`,
          path: ['subsystems'],
        });
      }
      const exitNode = nodeById.get(sub.exitNodeId);
      if (exitNode && exitNode.nodeType !== 'subsystemExit') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `subsystem "${sub.id}": exitNodeId "${sub.exitNodeId}" must reference a node with nodeType 'subsystemExit' (got '${exitNode.nodeType}')`,
          path: ['subsystems'],
        });
      }
      if (sub.entryNodeId === sub.exitNodeId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `subsystem "${sub.id}": entryNodeId and exitNodeId must be distinct (a structural port can't double as both)`,
          path: ['subsystems'],
        });
      }
      const priorEntryClaim = claimedAsEntry.get(sub.entryNodeId);
      if (priorEntryClaim !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `subsystemEntry "${sub.entryNodeId}" is the entry of both subsystem "${priorEntryClaim}" and subsystem "${sub.id}"`,
          path: ['subsystems'],
        });
      } else {
        claimedAsEntry.set(sub.entryNodeId, sub.id);
      }
      const priorExitClaim = claimedAsExit.get(sub.exitNodeId);
      if (priorExitClaim !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `subsystemExit "${sub.exitNodeId}" is the exit of both subsystem "${priorExitClaim}" and subsystem "${sub.id}"`,
          path: ['subsystems'],
        });
      } else {
        claimedAsExit.set(sub.exitNodeId, sub.id);
      }
      for (const nodeId of sub.bodyNodeIds) {
        if (!nodeIds.has(nodeId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `subsystem "${sub.id}": bodyNodeId "${nodeId}" references a non-existent node`,
            path: ['subsystems'],
          });
        }
        const existing = bodyMembership.get(nodeId);
        if (existing !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `node "${nodeId}" belongs to both subsystem "${existing}" and subsystem "${sub.id}"`,
            path: ['subsystems'],
          });
        } else {
          bodyMembership.set(nodeId, sub.id);
        }
      }
    }

    // Subsystem nesting cycle detection. Mirrors the project superRefine.
    const containerToSubsystemId = new Map<string, string>();
    for (const sub of file.subsystems) {
      containerToSubsystemId.set(sub.containerNodeId, sub.id);
    }
    const childSubsystems = new Map<string, string[]>();
    for (const sub of file.subsystems) {
      const kids: string[] = [];
      for (const bodyId of sub.bodyNodeIds) {
        const childId = containerToSubsystemId.get(bodyId);
        if (childId !== undefined && childId !== sub.id) kids.push(childId);
      }
      childSubsystems.set(sub.id, kids);
    }
    const WHITE = 0,
      GREY = 1,
      BLACK = 2;
    const color = new Map<string, number>();
    for (const sub of file.subsystems) color.set(sub.id, WHITE);
    const stack: string[] = [];
    const reportedCycles = new Set<string>();
    function visitForCycles(subId: string): void {
      color.set(subId, GREY);
      stack.push(subId);
      for (const childId of childSubsystems.get(subId) ?? []) {
        const c = color.get(childId);
        if (c === GREY) {
          const idx = stack.indexOf(childId);
          const cyclePath = [...stack.slice(idx), childId];
          const minIdx = cyclePath.indexOf(
            cyclePath.slice(0, -1).reduce((m, v) => (v < m ? v : m), cyclePath[0]!),
          );
          const key = [...cyclePath.slice(minIdx, -1), ...cyclePath.slice(0, minIdx)].join('->');
          if (!reportedCycles.has(key)) {
            reportedCycles.add(key);
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                `subsystem nesting cycle: ${cyclePath.join(' → ')}. ` +
                `A subsystem can't contain itself (directly or transitively) — ` +
                `remove one of the containerNodeId references from a bodyNodeIds list.`,
              path: ['subsystems'],
            });
          }
        } else if (c === WHITE) {
          visitForCycles(childId);
        }
      }
      stack.pop();
      color.set(subId, BLACK);
    }
    for (const sub of file.subsystems) {
      if (color.get(sub.id) === WHITE) visitForCycles(sub.id);
    }

    // Orphan structural port detection. A subsystemEntry / subsystemExit
    // node not claimed by any NESTED subsystem here is allowed iff it's
    // the file-level entry/exit (acting as the standalone's own port).
    // Anything else is a bug.
    for (const node of file.nodes) {
      if (
        node.nodeType === 'subsystemEntry' &&
        !claimedAsEntry.has(node.id) &&
        node.id !== file.entryNodeId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `orphan subsystemEntry "${node.id}": no nested subsystem claims it as entryNodeId. Either remove the node or attach it to a subsystem.`,
          path: ['nodes'],
        });
      }
      if (
        node.nodeType === 'subsystemExit' &&
        !claimedAsExit.has(node.id) &&
        node.id !== file.exitNodeId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `orphan subsystemExit "${node.id}": no nested subsystem claims it as exitNodeId. Either remove the node or attach it to a subsystem.`,
          path: ['nodes'],
        });
      }
    }

    // fixedCostOnce is only meaningful for nodes inside a loop body.
    const loopBodyNodeIds = new Set<string>(file.loops.flatMap((l) => l.bodyNodeIds));
    for (const node of file.nodes) {
      if (node.fixedCostOnce !== undefined && !loopBodyNodeIds.has(node.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `node "${node.id}": fixedCostOnce is only valid on nodes inside a loop body. ` +
            `Either remove fixedCostOnce, or add this node to a loop's bodyNodeIds.`,
          path: ['nodes'],
        });
      }
    }
  });

// ── Inferred TypeScript types ─────────────────────────────────────────────────
// All types flow from the Zod schema — never write parallel manual type definitions.
// `ProjectFile` is the v8 type; v1..v7 files are migrated forward on load.

export type ProjectFile = z.infer<typeof ProjectFileV8>;
export type Comment = z.infer<typeof CommentSchema>;
export type Calendar = z.infer<typeof CalendarSchema>;
export type Resource = z.infer<typeof ResourceSchema>;
export type ProjectNode = z.infer<typeof NodeSchema>;
export type NodeType = z.infer<typeof NodeTypeSchema>;
export type ProjectEdge = z.infer<typeof EdgeSchema>;
export type Loop = z.infer<typeof LoopSchema>;
export type Subsystem = z.infer<typeof SubsystemSchema>;
export type SubsystemSource = z.infer<typeof SubsystemSourceSchema>;
export type SubsystemFile = z.infer<typeof SubsystemFileV4>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type FixedCost = z.infer<typeof FixedCostSchema>;
export type CrashOption = z.infer<typeof CrashOptionSchema>;
export type Duration = z.infer<typeof DurationSchema>;
export type LagDuration = z.infer<typeof LagDurationSchema>;
export type DurationUnit = z.infer<typeof DurationUnitSchema>;
export type DurationSemantic = z.infer<typeof DurationSemanticSchema>;
export type ShareMode = z.infer<typeof ShareModeSchema>;
export type Distribution = z.infer<typeof DistributionSchema>;
export type CalendarPolicy = z.infer<typeof CalendarPolicySchema>;
export type HolidayPresetId = z.infer<typeof HolidayPresetIdSchema>;
export type ResourceAssignment = z.infer<typeof ResourceAssignmentSchema>;
export type EdgeType = z.infer<typeof EdgeTypeSchema>;
