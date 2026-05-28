/**
 * @procsim/importers — browser-safe parsers for AI-guided import (Phase 13).
 *
 * Three parsers, each returning an ImportResult:
 *   parseMsProjectXml(xml: string)         — MS Project XML export
 *   parseExcelGantt(buffer: ArrayBuffer)   — Excel tabular or visual Gantt
 *   parsePptxDiagram(buffer: ArrayBuffer)  — PowerPoint diagram (async)
 *
 * All parsers are pure, framework-free, and produce an ImportDraft +
 * AmbiguityList for the LLM authoring-skill step.
 */

export { parseMsProjectXml } from './msproject.js';
export { parseExcelGantt } from './excel.js';
export { parsePptxDiagram } from './pptx.js';

export type {
  ImportResult,
  ImportDraft,
  ImportedNode,
  ImportedEdge,
  ImportedResource,
  ImportedResourceAssignment,
  ImportedDuration,
  ImportedNodeType,
  ImportedEdgeType,
  AmbiguityItem,
  DurationUnit,
} from './types.js';
