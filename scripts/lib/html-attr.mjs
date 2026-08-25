/**
 * Quote-balanced HTML attribute reader.
 *
 * Exists because the idiom this repo had copy-pasted into a dozen parsers —
 * `/attr\s*=\s*["']([^"']+)["']/` — is **not** quote-balanced: the character
 * class `[^"']` stops at the FIRST quote of either kind, so a double-quoted
 * value containing an apostrophe is silently truncated at the apostrophe.
 *
 *   title="Collaboratrice-ore dell'economia domestica a ore"
 *                                ^ capture ends here
 *   → "Collaboratrice-ore dell"
 *
 * That is not a hypothetical. `extractLinks()` in `prospector/careers-trail.mjs`
 * appends this truncated fragment to the anchor text, producing the run-on job
 * titles reported in issue #6480 — and the run-on reached production all the way
 * into the slug:
 *
 *   "Collaboratrice-ore dell'economia domestica a ore Collaboratrice-ore dell"
 *
 * Italian and French job titles carry apostrophes constantly (`dell'`, `d'`,
 * `l'`), so on this corpus the defect is a rule, not an edge case.
 *
 * The fix is a backreference: capture the opening quote and require the SAME
 * character to close the value. Unquoted values are supported as a fallback
 * because SME markup emits them.
 *
 * @param {string} attrs   Attribute soup (the inside of a start tag) or raw HTML.
 * @param {string|string[]} names  Attribute name(s), tried in order; first hit wins.
 * @returns {string} The raw (still entity-encoded) value, or '' when absent.
 */
export function readAttr(attrs = '', names = []) {
  const list = Array.isArray(names) ? names : [names];
  const hay = String(attrs || '');
  for (const name of list) {
    const n = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // (?<![\w-]) keeps `title` from matching inside `data-title` / `x-title`.
    // `[^<]` rather than `[\s\S]`: on malformed markup with an unterminated
    // attribute, a fully permissive class would run past `>` and swallow the
    // rest of the document up to the next stray quote. An attribute value can
    // legitimately contain `>`, but never `<`, so this bounds the damage to the
    // current element without rejecting any valid value.
    const quoted = new RegExp(`(?<![\\w-])${n}\\s*=\\s*(["'])([^<]*?)\\1`, 'i');
    const hit = quoted.exec(hay);
    if (hit) return hit[2];
    const bare = new RegExp(`(?<![\\w-])${n}\\s*=\\s*([^\\s"'>\`=]+)`, 'i');
    const hitBare = bare.exec(hay);
    if (hitBare) return hitBare[1];
  }
  return '';
}

/**
 * The start tag whose `name` attribute equals `value`, quote-balanced.
 *
 * The shape `itemprop="x" ... content="y"` cannot be read with a single regex
 * without re-introducing the very bug this module exists to remove: the old
 * idiom glued the two attributes into one pattern and its `[^"']` class ran
 * straight through an apostrophe in between. Locate the tag first, then read
 * its attributes with `readAttr`.
 *
 * @param {string} html
 * @param {string} name   Attribute to match on, e.g. 'itemprop'.
 * @param {string} value  Its exact value, e.g. 'datePosted'.
 * @returns {string} The whole start tag, or '' when not found.
 */
export function readTagByAttr(html = '', name = '', value = '') {
  const n = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const v = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(`<[a-z][^>]*?(?<![\\w-])${n}\\s*=\\s*(["'])${v}\\1[^>]*>`, 'i');
  return rx.exec(String(html || ''))?.[0] ?? '';
}

/**
 * Every value of attribute `name` in the document, quote-balanced, in order.
 *
 * Use this instead of baking a substring constraint into the attribute regex
 * (`href=["']([^"']*sfcareer[^"']+)["']`): filter the returned values in JS,
 * where an apostrophe in the URL is just a character.
 *
 * @param {string} html
 * @param {string} name
 * @returns {string[]}
 */
export function readAllAttr(html = '', name = '') {
  const n = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(`(?<![\\w-])${n}\\s*=\\s*(["'])([^<]*?)\\1`, 'gi');
  const out = [];
  let m;
  while ((m = rx.exec(String(html || '')))) out.push(m[2]);
  return out;
}

/**
 * Read a `<meta>` content value by `property=` or `name=`, quote-balanced.
 *
 * Same defect as above, same corpus: `og:title` on an Italian job page routinely
 * contains an apostrophe, and the unbalanced idiom truncated it there too.
 *
 * @param {string} html
 * @param {string} key   e.g. 'og:title'
 * @returns {string} Raw (still entity-encoded) content value, or ''.
 */
export function readMetaContent(html = '', key = '') {
  const k = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = new RegExp(
    `<meta\\b[^>]*(?:property|name)\\s*=\\s*(["'])${k}\\1[^>]*>`,
    'i',
  );
  const hit = tag.exec(String(html || ''));
  if (!hit) return '';
  return readAttr(hit[0], 'content');
}
