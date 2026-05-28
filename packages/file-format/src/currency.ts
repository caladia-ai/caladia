/**
 * Currency display helpers and FX snapshot identifier.
 *
 * `CURRENCY_GLYPHS` maps ISO 4217 codes to display glyphs for the few
 * currencies the UI surfaces frequently. Codes not in the table fall back to
 * the bare code (e.g. "CHF") rather than guessing.
 *
 * `LATEST_FX_SNAPSHOT_VERSION` is the version string stamped into new v3
 * project files. Slice 4 of Phase 19 ships the bundled JSON snapshots and an
 * "update available?" check; for slice 1 this is just a forward-compatible
 * pin so files saved now point at the first real snapshot when it lands.
 */

export const CURRENCY_GLYPHS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CAD: 'C$',
  AUD: 'A$',
  CHF: 'CHF',
  CNY: '¥',
  INR: '₹',
};

export function currencyGlyph(code: string): string {
  return CURRENCY_GLYPHS[code] ?? code;
}

export const LATEST_FX_SNAPSHOT_VERSION = '2026.1';
