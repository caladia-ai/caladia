/**
 * Manually decode the five named XML entities that the parser leaves
 * untouched when `processEntities: false` is set on `XMLParser`.
 *
 * Disabling `processEntities` is a deliberate hardening: it removes the
 * billion-laughs DoS vector where a small XML payload defines deeply
 * nested entities that expand geometrically. fast-xml-parser does not
 * resolve external DTDs (so XXE isn't reachable) but internal entity
 * expansion is enabled by default. With expansion off we still need to
 * decode the five baseline entities that any real OOXML / MS Project
 * file uses — otherwise a shape labelled `Design & Build` would import
 * as the literal string `Design &amp; Build`.
 *
 * `&amp;` is decoded LAST so a payload that contains a literal `&amp;`
 * meant to encode `&lt;` (i.e. `&amp;lt;`) decodes to `&lt;` rather than
 * `<`. This matches XML semantics: entity references are not re-resolved.
 */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
