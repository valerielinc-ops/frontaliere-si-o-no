/**
 * Decode HTML entities LLM output occasionally emits as literal text
 * (e.g. `&#8220;Frase citata&#8221;` instead of a real curly-quote
 * character) instead of the correct glyph. Confirmed live on article
 * `ristorni-frontalieri-pellicini-tavolo-lavoro` (title + body) and
 * three sibling articles/locales — see docs/AGENTS-HISTORY.md.
 *
 * Decodes to display-correct Unicode (curly quotes, en/em dash), not
 * ASCII fallbacks — this feeds published article title/body text.
 */
export const ENTITY_MAP = {
  '&amp;': '&',
  '&#038;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  // Curly apostrophe, not ASCII '\'' — a straight quote here would prematurely
  // close the single-quoted TS string literals these values get serialized into.
  '&apos;': '’',
  '&#39;': '’',
  '&#039;': '’',
  '&nbsp;': ' ',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&#8220;': '“',
  '&#8221;': '”',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&#8216;': '‘',
  '&#8217;': '’',
  '&ndash;': '–',
  '&#8211;': '–',
  '&mdash;': '—',
  '&#8212;': '—',
  '&hellip;': '…',
  '&#8230;': '…',
};

export const ENTITY_PATTERN = new RegExp(
  Object.keys(ENTITY_MAP)
    .map((entity) => entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g',
);

export function decodeHtmlEntities(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  // Double-encoded entities (`&amp;#8220;`) need a second pass: decoding
  // `&amp;` → `&` re-forms `&#8220;`, which the first pass can't see mid-scan.
  let decoded = text;
  for (let i = 0; i < 3; i += 1) {
    const next = decoded.replace(ENTITY_PATTERN, (entity) => ENTITY_MAP[entity] ?? entity);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}
