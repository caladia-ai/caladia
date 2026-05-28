/**
 * Regenerate `.expected.json` snapshots for every file under
 * `fixtures/corpus/{msproject,excel,pptx}/`.
 *
 * Run:    pnpm --filter @procsim/importers fixtures:update
 * Reads:  fixtures/corpus/<parser>/<name>.{xml|xlsx|pptx}
 * Writes: fixtures/corpus/<parser>/<name>.expected.json
 *
 * Behaviour:
 *   - Files whose snapshots are byte-identical are left untouched.
 *   - Missing snapshots are created.
 *   - Stale snapshots (no matching source file) are not deleted automatically;
 *     remove them by hand when retiring fixtures.
 *
 * Review the generated diffs before committing — the snapshot is the contract.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runParser, isFixtureFile, PARSER_NAMES, type ParserName } from '../src/corpus-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(__dirname, '..', 'fixtures', 'corpus');

interface Tally {
  created: number;
  updated: number;
  unchanged: number;
}

async function processParser(parser: ParserName, tally: Tally): Promise<void> {
  const dir = resolve(CORPUS, parser);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    return;
  }
  const files = readdirSync(dir)
    .filter((f) => isFixtureFile(parser, f))
    .sort();
  if (files.length === 0) {
    console.log(`  ${parser}: (no fixtures)`);
    return;
  }
  for (const f of files) {
    const filePath = resolve(dir, f);
    const result = await runParser(parser, filePath);
    const stem = basename(f, extname(f));
    const expectedPath = resolve(dir, `${stem}.expected.json`);
    const json = JSON.stringify(result, null, 2) + '\n';
    if (!existsSync(expectedPath)) {
      writeFileSync(expectedPath, json, 'utf-8');
      console.log(`  created   ${parser}/${stem}.expected.json`);
      tally.created += 1;
      continue;
    }
    const prev = readFileSync(expectedPath, 'utf-8');
    if (prev === json) {
      tally.unchanged += 1;
      continue;
    }
    writeFileSync(expectedPath, json, 'utf-8');
    console.log(`  updated   ${parser}/${stem}.expected.json`);
    tally.updated += 1;
  }
}

async function main(): Promise<void> {
  const tally: Tally = { created: 0, updated: 0, unchanged: 0 };
  console.log('Updating corpus snapshots…\n');
  for (const parser of PARSER_NAMES) {
    await processParser(parser, tally);
  }
  console.log(
    `\nDone. ${tally.created} created · ${tally.updated} updated · ${tally.unchanged} unchanged.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
