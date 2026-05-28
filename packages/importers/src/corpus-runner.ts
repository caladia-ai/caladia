/**
 * Shared corpus-walking logic used by both `corpus.test.ts` (which compares
 * parser output against checked-in `.expected.json` snapshots) and
 * `scripts/update-fixtures.ts` (which regenerates those snapshots).
 *
 * Not part of the package's public API — internal helper, Node-only
 * (uses `node:fs` for fixture reading).
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { parseMsProjectXml } from './msproject.js';
import { parseExcelGantt } from './excel.js';
import { parsePptxDiagram } from './pptx.js';
import type { ImportResult } from './types.js';

export type ParserName = 'msproject' | 'excel' | 'pptx';

export const PARSER_EXTS: Record<ParserName, string[]> = {
  msproject: ['.xml'],
  excel: ['.xlsx'],
  pptx: ['.pptx'],
};

export const PARSER_NAMES: ParserName[] = ['msproject', 'excel', 'pptx'];

/** True if `file` belongs to `parser` based on file extension (case-insensitive). */
export function isFixtureFile(parser: ParserName, file: string): boolean {
  return PARSER_EXTS[parser].includes(extname(file).toLowerCase());
}

/** Convert a Node Buffer to an ArrayBuffer the parsers accept. */
function bufToArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Run the parser identified by `parser` on a fixture file path, returning the
 * raw `ImportResult`. The result is shaped identically to what the in-app
 * import flow receives, so snapshots are an honest contract test.
 */
export async function runParser(parser: ParserName, filePath: string): Promise<ImportResult> {
  if (parser === 'msproject') {
    return parseMsProjectXml(readFileSync(filePath, 'utf-8'));
  }
  if (parser === 'excel') {
    return parseExcelGantt(bufToArrayBuffer(readFileSync(filePath)));
  }
  if (parser === 'pptx') {
    return await parsePptxDiagram(bufToArrayBuffer(readFileSync(filePath)));
  }
  // exhaustiveness check
  const _exhaustive: never = parser;
  throw new Error(`Unknown parser: ${String(_exhaustive)}`);
}
