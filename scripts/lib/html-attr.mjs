/*
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
 */
/**
 * Tokenize attribute assignments while respecting quoted and unquoted value
 * boundaries, so attribute-shaped text inside a value is never rediscovered.
 *
 * @param {string} input Attribute soup, a start tag, or raw HTML.
 * @returns {Array<{name: string, value: string}>}
 */
function scanAttributes(input = '') {
  const source = String(input || '');
  const out = [];
  let i = 0;

  while (i < source.length) {
    // Attribute names are delimiter-based in HTML, not ASCII identifiers:
    // framework markup legitimately uses `[action]`, `(click)`, `@submit`, …
    // Consume the full token so attribute-shaped text inside its value stays
    // inside that value instead of being rediscovered as a sibling attribute.
    if (/[\s=\/<>"'`]/.test(source[i])) {
      i += 1;
      continue;
    }

    const nameStart = i;
    i += 1;
    while (i < source.length && !/[\s=\/<>"'`]/.test(source[i])) i += 1;
    const name = source.slice(nameStart, i);
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source[i] !== '=') continue;

    i += 1;
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (i >= source.length) break;

    const quote = source[i] === '"' || source[i] === "'" ? source[i] : '';
    if (quote) {
      i += 1;
      const valueStart = i;
      while (i < source.length && source[i] !== quote && source[i] !== '<') i += 1;
      if (source[i] !== quote) continue;
      out.push({ name: name.toLowerCase(), value: source.slice(valueStart, i) });
      i += 1;
      continue;
    }

    const valueStart = i;
    // HTML tokenizers keep `=` inside an unquoted value (as a parse error), and
    // real SME pages rely on that for query strings such as `href=/jobs?a=1`.
    while (i < source.length && !/[\s"'<>`]/.test(source[i])) i += 1;
    if (i > valueStart) {
      out.push({ name: name.toLowerCase(), value: source.slice(valueStart, i) });
    }
  }

  return out;
}

/**
 * Scan HTML tags without treating `>` inside a quoted attribute as the end of
 * a start tag. Malformed tags containing a new `<` before their close are
 * abandoned rather than allowed to consume the following element. The result
 * is ordered, so callers can build balanced-container indexes in one pass.
 *
 * @param {string} html
 * @returns {Array<{
 *   raw: string,
 *   name: string,
 *   index: number,
 *   end: number,
 *   closing: boolean,
 *   selfClosing: boolean,
 * }>}
 */
export function scanHtmlTags(html = '') {
  const source = String(html || '');
  const out = [];
  let cursor = 0;

  while (cursor < source.length) {
    const index = source.indexOf('<', cursor);
    if (index === -1) break;
    let i = index + 1;
    const closing = source[i] === '/';
    if (closing) i += 1;
    if (!/[a-z]/i.test(source[i] || '')) {
      cursor = i;
      continue;
    }
    const nameStart = i;
    i += 1;
    while (i < source.length && /[a-z0-9:-]/i.test(source[i])) i += 1;
    const name = source.slice(nameStart, i).toLowerCase();
    let quote = '';
    let end = -1;
    let recovery = -1;
    for (; i < source.length; i += 1) {
      const char = source[i];
      if (quote) {
        if (char === quote) quote = '';
        else if (char === '<') {
          // Browsers abandon a malformed start tag when a new element begins.
          // Recover at that delimiter even when the author forgot to close an
          // attribute quote; otherwise the valid following JobPosting can be
          // swallowed until an unrelated quote much later in the document.
          recovery = i;
          break;
        }
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '<') break;
      if (char === '>') {
        end = i + 1;
        break;
      }
    }
    if (end === -1) {
      cursor = recovery >= 0 ? recovery : Math.max(index + 1, i);
      continue;
    }
    const raw = source.slice(index, end);
    out.push({ raw, name, index, end, closing, selfClosing: !closing && /\/\s*>$/.test(raw) });
    cursor = end;
  }

  return out;
}

/**
 * @param {string} html
 * @param {string} [tagName]
 * @returns {ReturnType<typeof scanHtmlTags>}
 */
export function scanStartTags(html = '', tagName = '') {
  const target = String(tagName || '').toLowerCase();
  return scanHtmlTags(html).filter((tag) => !tag.closing && (!target || tag.name === target));
}

/**
 * Read the first requested HTML attribute without crossing another value.
 *
 * @param {string} attrs Attribute soup (the inside of a start tag) or raw HTML.
 * @param {string|string[]} names Attribute name(s), tried in order; first hit wins.
 * @returns {string} The raw (still entity-encoded) value, or '' when absent.
 */
export function readAttr(attrs = '', names = []) {
  const values = scanAttributes(attrs);
  const list = (Array.isArray(names) ? names : [names]).map((name) => String(name).toLowerCase());
  for (const name of list) {
    const hit = values.find((attr) => attr.name === name);
    if (hit) return hit.value;
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
  const target = String(value).toLowerCase();
  return scanStartTags(html).find(({ raw }) => readAttr(raw, name).toLowerCase() === target)?.raw ?? '';
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
  const target = String(name).toLowerCase();
  return scanAttributes(html)
    .filter((attr) => attr.name === target)
    .map((attr) => attr.value);
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
  const target = String(key).toLowerCase();
  const tag = scanStartTags(html, 'meta').find(({ raw }) => {
    const declaredKeys = [readAttr(raw, 'property'), readAttr(raw, 'name')];
    return declaredKeys.some((declaredKey) => declaredKey.toLowerCase() === target);
  });
  return tag ? readAttr(tag.raw, 'content') : '';
}
