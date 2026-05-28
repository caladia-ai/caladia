#!/usr/bin/env tsx
/**
 * Phase 19 slice 4 — FX snapshot refresh stub.
 *
 * The full implementation will:
 *   1. Pull daily mid-market rates from a public reference source (ECB
 *      reference rates is the leading candidate — they're stable, free,
 *      well-documented, and ship as XML or CSV).
 *   2. Average the daily rates across a 4- to 6-month trailing window
 *      ending on the snapshot date so day-to-day noise doesn't show up
 *      in re-pin diffs.
 *   3. Re-base the rates to USD (ECB ships them relative to EUR).
 *   4. Write a new versioned JSON file at
 *      `packages/file-format/src/fx-snapshots/<version>.json`.
 *   5. Update the `BUNDLED_SNAPSHOTS` list in
 *      `packages/file-format/src/fx.ts` to put the new file first.
 *
 * Steps 1-3 are out of scope for slice 4 (they involve a real HTTP
 * dependency); the slice ships the bundled `2026.1.json` snapshot with
 * rates supplied by hand. This script exists so the entry point and
 * intent are tracked alongside the rest of the FX infrastructure.
 *
 * Run via `pnpm exec tsx scripts/refresh-fx.ts <version>`. NOT in CI —
 * snapshot versions are a release-time decision.
 */

function main(): void {
  console.error(
    [
      'refresh-fx: not yet implemented.',
      '',
      'For now, edit packages/file-format/src/fx-snapshots/<version>.json',
      'by hand and add an entry to BUNDLED_SNAPSHOTS in',
      'packages/file-format/src/fx.ts (newest-first).',
      '',
      'See the file header for the planned full implementation.',
    ].join('\n'),
  );
  process.exit(2);
}

main();
