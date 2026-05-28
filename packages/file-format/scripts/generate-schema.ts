/**
 * Generates JSON Schema files from the Zod schemas in schema.ts.
 *
 * Output files (committed to the repo root):
 *   caladia-project.schema.json   — ProjectFileV2
 *   caladia-subsystem.schema.json — SubsystemFileV1
 *
 * Usage:
 *   pnpm --filter @procsim/file-format generate-schema
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ProjectFileV2, SubsystemFileV1 } from '../src/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const projectSchema = zodToJsonSchema(ProjectFileV2, {
  name: 'CaiadiaProject',
  nameStrategy: 'title',
  $refStrategy: 'none',
});

const subsystemSchema = zodToJsonSchema(SubsystemFileV1, {
  name: 'CaladiaSubsystem',
  nameStrategy: 'title',
  $refStrategy: 'none',
});

const projectOut = resolve(REPO_ROOT, 'caladia-project.schema.json');
const subsystemOut = resolve(REPO_ROOT, 'caladia-subsystem.schema.json');

writeFileSync(projectOut, JSON.stringify(projectSchema, null, 2) + '\n');
writeFileSync(subsystemOut, JSON.stringify(subsystemSchema, null, 2) + '\n');

console.log(`Written → ${projectOut}`);
console.log(`Written → ${subsystemOut}`);
