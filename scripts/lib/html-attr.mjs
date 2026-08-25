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
    const quoted = new RegExp(`(?<![\\w-])${n}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
    const hit = quoted.exec(hay);
    if (hit) return hit[2];
    const bare = new RegExp(`(?<![\\w-])${n}\\s*=\\s*([^\\s"'>\`=]+)`, 'i');
    const hitBare = bare.exec(hay);
    if (hitBare) return hitBare[1];
  }
  return '';
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
