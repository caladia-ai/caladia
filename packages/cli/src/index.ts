#!/usr/bin/env node
/**
 * `caladia` CLI entry point.
 *
 * Thin Commander wrapper around the pure functions in `simulate.ts`
 * and `validate.ts`. Reads the .cala file from disk, calls the right
 * pure function, writes the result, and exits with the documented
 * status code.
 *
 * Exit codes:
 *   0  — success
 *   1  — parse error (bad .cala file) or file-read error
 *   2  — simulate-only: engine error (zero successful iterations, etc.)
 *   any other — Commander argument-parsing error (defaults to 1)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { runSimulate } from './simulate.js';
import {
  runValidate,
  formatSummaryLine,
  formatTruncationWarnings,
  formatErrors,
} from './validate.js';

function readContentsOrExit(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    process.stderr.write(`Failed to read ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

const program = new Command();

program
  .name('caladia')
  .description('Caladia CLI — run process simulations from the command line')
  .version('0.0.1');

program
  .command('simulate <file>')
  .description('Run a Monte Carlo simulation against a .cala project file')
  .option('-i, --iters <n>', 'iteration count (default: 1000)', (v) => parseInt(v, 10))
  .option('-s, --seed <n>', 'RNG seed (default: 42)', (v) => parseInt(v, 10))
  .option('-o, --out <file>', 'write JSON to <file> instead of stdout')
  .action((file: string, options: { iters?: number; seed?: number; out?: string }) => {
    const contents = readContentsOrExit(file);

    const result = runSimulate({
      contents,
      ...(options.iters !== undefined ? { iterations: options.iters } : {}),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
    });

    if (!result.ok) {
      process.stderr.write(`${result.message}\n`);
      process.exit(result.exitCode);
    }

    if (options.out) {
      try {
        writeFileSync(options.out, result.json, 'utf8');
      } catch (e) {
        process.stderr.write(
          `Failed to write ${options.out}: ${e instanceof Error ? e.message : String(e)}\n`,
        );
        process.exit(1);
      }
    } else {
      process.stdout.write(result.json + '\n');
    }
  });

program
  .command('validate <file>')
  .description('Parse a .cala project file and report whether it is schema-valid')
  .option('--json', 'emit a machine-readable JSON report on stdout instead of human text')
  .action((file: string, options: { json?: boolean }) => {
    const contents = readContentsOrExit(file);
    const result = runValidate({ contents });

    if (options.json) {
      // Machine-readable mode — emit a stable JSON shape on stdout
      // regardless of outcome; exit code still encodes pass/fail so
      // CI scripts can branch on `$?` without parsing.
      const payload = result.ok
        ? {
            ok: true,
            summary: result.summary,
            truncationWarnings: result.truncationWarnings,
          }
        : {
            ok: false,
            errors: result.errors,
          };
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      if (!result.ok) process.exit(result.exitCode);
      return;
    }

    if (!result.ok) {
      process.stderr.write(formatErrors(result.errors) + '\n');
      process.exit(result.exitCode);
    }

    process.stdout.write(formatSummaryLine(result.summary) + '\n');
    if (result.truncationWarnings.length > 0) {
      process.stderr.write(formatTruncationWarnings(result.truncationWarnings) + '\n');
    }
  });

program.parse();
