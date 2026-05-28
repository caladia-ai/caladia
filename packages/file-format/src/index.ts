export {
  CURRENT_VERSION,
  EFFORT_HOURS_PER_DAY,
  EFFORT_DAYS_PER_WEEK,
  SCHEMA_LIMITS,
} from './schema.js';
export {
  ProjectFileV1,
  ProjectFileV2,
  ProjectFileV3,
  ProjectFileV4,
  ProjectFileV5,
  ProjectFileV6,
  ProjectFileV7,
  ProjectFileV8,
  SubsystemFileV1,
  SubsystemFileV2,
  SubsystemFileV3,
  SubsystemFileV4,
  CommentSchema,
  FixedCostSchema,
  CrashOptionSchema,
  DurationSemanticSchema,
  NodeSchema,
  ShareModeSchema,
} from './schema.js';
export type {
  ProjectFile,
  Calendar,
  Resource,
  ProjectNode,
  ProjectEdge,
  Loop,
  Subsystem,
  SubsystemSource,
  SubsystemFile,
  Scenario,
  Duration,
  LagDuration,
  DurationUnit,
  DurationSemantic,
  Distribution,
  CalendarPolicy,
  HolidayPresetId,
  ResourceAssignment,
  EdgeType,
  NodeType,
  FixedCost,
  CrashOption,
  ShareMode,
  Comment,
} from './schema.js';

export {
  loadProjectFile,
  saveProjectFile,
  migrateIfNeeded,
  migrateV1ToV2,
  migrateV2ToV3,
  migrateV3ToV4,
  migrateV4ToV5,
  migrateV5ToV6,
  migrateV6ToV7,
  migrateV7ToV8,
  migrateSubsystemV1ToV2,
  migrateSubsystemV2ToV3,
  migrateSubsystemV3ToV4,
  loadSubsystemFile,
  saveSubsystemFile,
} from './load.js';
export { truncateOversizedStrings } from './load.js';
export type {
  LoadResult,
  LoadSubsystemResult,
  ValidationError,
  PresetUpdate,
  FxSnapshotUpdate,
  TruncationWarning,
} from './load.js';

export { getPreset, latestPresetVersion } from './presets.js';
export type { HolidayPreset, HolidayEntry } from './presets.js';

export { CALENDAR_TEMPLATES, getCalendarTemplate } from './calendar-templates.js';
export type { CalendarTemplate, WorkScheduleFields } from './calendar-templates.js';

export { CURRENCY_GLYPHS, currencyGlyph, LATEST_FX_SNAPSHOT_VERSION } from './currency.js';

export {
  convertAmount,
  convertResourceCostsToProjectCurrency,
  loadFxSnapshot,
  listAvailableTargetCurrencies,
  listBundledSnapshotVersions,
  applyFxOverrides,
  LATEST_BUNDLED_SNAPSHOT,
} from './fx.js';
export type { FxSnapshot } from './fx.js';
