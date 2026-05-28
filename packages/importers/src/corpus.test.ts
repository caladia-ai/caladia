/**
 * Corpus snapshot harness — walks every file in `fixtures/corpus/<parser>/`,
 * runs the matching parser on it, and asserts the result matches the
 * checked-in `<file>.expected.json` snapshot.
 *
 * Adding a new fixture:
 *   1. Drop the file into `fixtures/corpus/{msproject|excel|pptx}/`
 *   2. Run `pnpm --filter @procsim/importers fixtures:update`
 *   3. Review the generated `<file>.expected.json` diff
 *   4. Commit both files together
 *
 * If a fixture is added without a snapshot, this test fails with a clear
 * message pointing at `fixtures:update`. That's intentional — we never want
 * to silently miss a fixture.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runParser, isFixtureFile, PARSER_NAMES, type ParserName } from './corpus-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(__dirname, '..', 'fixtures', 'corpus');

function listFixtures(parser: ParserName): string[] {
  const dir = resolve(CORPUS, parser);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => isFixtureFile(parser, f))
    .sort();
}

for (const parser of PARSER_NAMES) {
  const files = listFixtures(parser);

  describe(`corpus: ${parser}`, () => {
    if (files.length === 0) {
      // Empty subdir is OK — Mac Studio fixture authoring may not have started
      // for this parser yet. Surface as a skipped test so the count is visible.
      it.skip(`(no fixtures yet — add files to fixtures/corpus/${parser}/)`, () => {});
      return;
    }
    for (const f of files) {
      it(`matches snapshot: ${f}`, async () => {
        const filePath = resolve(CORPUS, parser, f);
        const result = await runParser(parser, filePath);
        const stem = basename(f, extname(f));
        const expectedPath = resolve(CORPUS, parser, `${stem}.expected.json`);
        if (!existsSync(expectedPath)) {
          throw new Error(
            `Missing snapshot: fixtures/corpus/${parser}/${stem}.expected.json\n` +
              `Run: pnpm --filter @procsim/importers fixtures:update`,
          );
        }
        const expected = JSON.parse(readFileSync(expectedPath, 'utf-8')) as unknown;
        expect(result).toEqual(expected);
      });
    }
  });
}
