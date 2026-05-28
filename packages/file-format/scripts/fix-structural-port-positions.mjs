#!/usr/bin/env node
/**
 * One-shot position fixup — Phase 50 Slice 3.5b follow-up.
 *
 * The first pass of `migrate-templates.mjs` ran with a buggy position
 * formula for structural Exit nodes: it added a fixed `+140` offset to
 * the natural exit's top-left, ignoring the natural exit's own width
 * (~160 px). That landed the Exit wedge INSIDE the natural exit's
 * rectangle on the canvas (visual overlap).
 *
 * This script reads every V7 `.cala` template, walks each subsystem,
 * derives the natural entry/exit from each structural port's bookend
 * internal edge, and rewrites the port's position with the corrected
 * width-aware formula. Structural node IDs are preserved, so the
 * existing snapshot fixtures stay valid.
 *
 * Safe to re-run: a second pass produces no changes.
 *
 * Run from the repo root:
 *   node packages/file-format/scripts/fix-structural-port-positions.mjs
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', '..', 'app', 'public', 'templates');

// Must match the constants in migrateV6ToV7 / wrapSelectedAsSubsystem.
const STRUCTURAL_PORT_WIDTH = 44;
const STRUCTURAL_PORT_GAP = 60;
const NATURAL_NODE_DEFAULT_WIDTH = 160;

const files = (await readdir(TEMPLATES_DIR)).filter((f) => f.endsWith('.cala'));
console.log(`Scanning ${files.length} template files in ${TEMPLATES_DIR}`);

let updatedFiles = 0;
let unchangedFiles = 0;
let totalPortsFixed = 0;

for (const file of files) {
  const path = join(TEMPLATES_DIR, file);
  const contents = await readFile(path, 'utf8');
  const project = JSON.parse(contents);
  if (project.version !== 7) {
    console.log(`  · ${file}: not V7 (${project.version}); skipping`);
    unchangedFiles++;
    continue;
  }
  if (!Array.isArray(project.subsystems) || project.subsystems.length === 0) {
    console.log(`  · ${file}: no subsystems`);
    unchangedFiles++;
    continue;
  }

  const nodeById = new Map(project.nodes.map((n) => [n.id, n]));
  let touchedHere = 0;

  for (const sub of project.subsystems) {
    const structuralEntry = nodeById.get(sub.entryNodeId);
    const structuralExit = nodeById.get(sub.exitNodeId);
    if (!structuralEntry || !structuralExit) {
      console.warn(`  ! ${file}: subsystem ${sub.id} missing structural port refs; skipping`);
      continue;
    }

    // Bookend edges: structuralEntry → naturalEntry, naturalExit → structuralExit.
    const entryBookend = project.edges.find((e) => e.from === sub.entryNodeId);
    const exitBookend = project.edges.find((e) => e.to === sub.exitNodeId);
    if (!entryBookend || !exitBookend) {
      console.warn(`  ! ${file}: subsystem ${sub.id} missing bookend edge(s); skipping`);
      continue;
    }
    const naturalEntry = nodeById.get(entryBookend.to);
    const naturalExit = nodeById.get(exitBookend.from);
    if (!naturalEntry || !naturalExit) {
      console.warn(`  ! ${file}: subsystem ${sub.id} dangling bookend; skipping`);
      continue;
    }

    const newEntryX = naturalEntry.position.x - STRUCTURAL_PORT_WIDTH - STRUCTURAL_PORT_GAP;
    const newEntryY = naturalEntry.position.y;
    const newExitX =
      naturalExit.position.x +
      (typeof naturalExit.width === 'number' ? naturalExit.width : NATURAL_NODE_DEFAULT_WIDTH) +
      STRUCTURAL_PORT_GAP;
    const newExitY = naturalExit.position.y;

    if (structuralEntry.position.x !== newEntryX || structuralEntry.position.y !== newEntryY) {
      structuralEntry.position = { x: newEntryX, y: newEntryY };
      touchedHere++;
    }
    if (structuralExit.position.x !== newExitX || structuralExit.position.y !== newExitY) {
      structuralExit.position = { x: newExitX, y: newExitY };
      touchedHere++;
    }
  }

  if (touchedHere > 0) {
    await writeFile(path, JSON.stringify(project, null, 2) + '\n', 'utf8');
    console.log(`  ✓ ${file}: ${touchedHere} port position(s) corrected`);
    updatedFiles++;
    totalPortsFixed += touchedHere;
  } else {
    unchangedFiles++;
    console.log(`  · ${file}: already correct`);
  }
}

console.log('');
console.log(
  `Updated ${updatedFiles} files, ${unchangedFiles} unchanged, ${totalPortsFixed} ports fixed total.`,
);
