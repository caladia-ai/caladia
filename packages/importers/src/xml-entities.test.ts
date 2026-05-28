import { describe, it, expect } from 'vitest';
import { decodeXmlEntities } from './xml-entities.js';

// ── decodeXmlEntities ────────────────────────────────────────────────────────
//
// Pairs with the `processEntities: false` setting on every XMLParser
// instance in the importers package. The five named XML entities below
// are what real OOXML / MS Project XML files use; without manual
// decoding they would arrive in downstream code as literal
// `&amp;` / `&lt;` / `&gt;` / `&quot;` / `&apos;` strings.

describe('decodeXmlEntities', () => {
  it('decodes &amp; to &', () => {
    expect(decodeXmlEntities('Design &amp; Build')).toBe('Design & Build');
  });

  it('decodes &lt; to <', () => {
    expect(decodeXmlEntities('a &lt; b')).toBe('a < b');
  });

  it('decodes &gt; to >', () => {
    expect(decodeXmlEntities('b &gt; a')).toBe('b > a');
  });

  it('decodes &quot; to "', () => {
    expect(decodeXmlEntities('say &quot;hi&quot;')).toBe('say "hi"');
  });

  it("decodes &apos; to '", () => {
    expect(decodeXmlEntities('it&apos;s')).toBe("it's");
  });

  it('decodes multiple entities in one string', () => {
    expect(decodeXmlEntities('&lt;tag attr=&quot;val&quot;&gt;a &amp; b&lt;/tag&gt;')).toBe(
      '<tag attr="val">a & b</tag>',
    );
  });

  it('returns the input unchanged when no entities are present', () => {
    expect(decodeXmlEntities('plain text')).toBe('plain text');
    expect(decodeXmlEntities('')).toBe('');
  });

  it('decodes &amp; LAST to preserve double-encoded entities', () => {
    // `&amp;lt;` in XML decodes to the literal string `&lt;`, NOT to `<`.
    // Decoding &amp; last guarantees the inner &lt; isn't re-resolved.
    expect(decodeXmlEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeXmlEntities('&amp;amp;')).toBe('&amp;');
  });

  it('is a no-op on numeric and identifier-like strings', () => {
    // The importer applies this to every extracted string, including UIDs
    // and shape preset names. Those never contain entities; the decode
    // must leave them byte-identical.
    expect(decodeXmlEntities('12345')).toBe('12345');
    expect(decodeXmlEntities('rect')).toBe('rect');
    expect(decodeXmlEntities('PT8H')).toBe('PT8H');
  });
});
