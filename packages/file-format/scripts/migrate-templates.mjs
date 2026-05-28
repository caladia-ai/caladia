#!/usr/bin/env node
/**
 * One-shot template migrator — Phase 50 Slice 3.5b.
 *
 * Reads every `.cala` template under `packages/app/public/templates/`,
 * runs it through `loadProjectFile` (which migrates V6 → V7 with the
 * Simulink-style structural-port auto-injection), and writes the result
 * back. After this script has run once, the templates carry structural
 * subsystemEntry / subsystemExit nodes natively — no migration fires
 * on subsequent loads, so structural node IDs stay stable across CI
 * runs and snapshot fixtures.
 *
 * Run from the repo root:
 *   node packages/file-format/scripts/migrate-templates.mjs
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectFile, saveProjectFile } from '../dist/load.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', '..', 'app', 'public', 'templates');

const files = (await readdir(TEMPLATES_DIR)).filter((f) => f.endsWith('.cala'));
console.log(`Found ${files.length} template files in ${TEMPLATES_DIR}`);

let migratedCount = 0;
let alreadyV7Count = 0;
let errorCount = 0;

for (const file of files) {
  const path = join(TEMPLATES_DIR, file);
  const contents = await readFile(path, 'utf8');
  const before = JSON.parse(contents);
  const result = loadProjectFile(contents);
  if (!result.ok) {
    console.error(`  ✗ ${file}: load failed`);
    for (const err of result.errors) {
      console.error(`    - ${err.path}: ${err.message}`);
    }
    errorCount++;
    continue;
  }
  if (before.version === 7) {
    alreadyV7Count++;
    console.log(`  · ${file} already V7`);
    continue;
  }
  await writeFile(path, saveProjectFile(result.project) + '\n', 'utf8');
  const subCount = result.project.subsystems.length;
  const structuralEntries = result.project.nodes.filter(
    (n) => n.nodeType === 'subsystemEntry',
  ).length;
  console.log(
    `  ✓ ${file}: V${before.version} → V7 (${subCount} subsystems, ${structuralEntries} structural pairs)`,
  );
  migratedCount++;
}

console.log('');
console.log(`Migrated: ${migratedCount}, already V7: ${alreadyV7Count}, errors: ${errorCount}`);
if (errorCount > 0) process.exit(1);
