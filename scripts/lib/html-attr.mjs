import { MID_PLUGINS_FAST } from './mid-plugins-flag.mjs';

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
 * Find the end of a tag without treating a `>` inside a quoted attribute as
 * the end of that tag.
 *
 * @param {string} source
 * @param {number} start
 * @returns {number}
 */
function findTagEnd(source, start) {
  let quote = '';
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index + 1;
  }
  return -1;
}

/**
 * Remove comments and raw-text elements while keeping source offsets stable.
 * Comment boundaries are resolved before looking for a raw-text opener; this
 * prevents `<script>` text inside a comment from swallowing live metadata.
 * Conversely, a raw-text block is consumed as one unit, so `<!--` in a
 * JavaScript or CSS string cannot terminate the block early.
 *
 * @param {string} source
 * @returns {string}
 */
function scrubMarkupForTagScan(source) {
  return MID_PLUGINS_FAST ? scrubMarkupForTagScanFast(source) : scrubMarkupForTagScanLegacy(source);
}

const RAW_TEXT_OPEN = /<(script|style)(?=[\s/>])/iy;
const RAW_TEXT_CLOSE = {
  script: /<\/script\s*>/ig,
  style: /<\/style\s*>/ig,
};

/**
 * Stesso risultato di `scrubMarkupForTagScanLegacy` (stessa stringa, stessa
 * lunghezza) senza `split('')`/`join('')`: la versione storica allocava un array
 * di un elemento per carattere (512 KB per una testa da 64 KB) per ogni
 * chiamata, ed era il 25% del tempo CPU e la maggior parte del GC del
 * controllo dist-truth delle sitemap (~330 s di GC su 670 s a gamba). Qui si
 * accumulano le fette intatte e `' '.repeat(n)` per i tratti oscurati.
 *
 * @param {string} source
 * @returns {string}
 */
function scrubMarkupForTagScanFast(source) {
  const length = source.length;
  const parts = [];
  let emitted = 0;
  const blank = (start, end) => {
    if (end <= start) return;
    if (start > emitted) parts.push(source.slice(emitted, start));
    parts.push(' '.repeat(end - start));
    emitted = end;
  };

  let cursor = 0;
  while (cursor < length) {
    if (source.startsWith('<!--', cursor)) {
      const close = source.indexOf('-->', cursor + 4);
      const end = close === -1 ? length : close + 3;
      blank(cursor, end);
      cursor = end;
      continue;
    }

    if (source[cursor] === '<') {
      RAW_TEXT_OPEN.lastIndex = cursor;
      const rawOpen = RAW_TEXT_OPEN.exec(source);
      if (rawOpen) {
        const openEnd = findTagEnd(source, cursor);
        if (openEnd === -1) {
          blank(cursor, length);
          break;
        }
        const closePattern = RAW_TEXT_CLOSE[rawOpen[1].toLowerCase()];
        closePattern.lastIndex = openEnd;
        const close = closePattern.exec(source);
        const end = close ? close.index + close[0].length : length;
        blank(cursor, end);
        cursor = end;
        continue;
      }

      const tagEnd = findTagEnd(source, cursor);
      if (tagEnd !== -1) {
        cursor = tagEnd;
        continue;
      }
    }

    cursor += 1;
  }

  if (parts.length === 0) return source;
  if (emitted < length) parts.push(source.slice(emitted));
  return parts.join('');
}

function scrubMarkupForTagScanLegacy(source) {
  const chars = source.split('');
  const blank = (start, end) => {
    for (let index = start; index < end; index += 1) chars[index] = ' ';
  };

  let cursor = 0;
  while (cursor < source.length) {
    if (source.startsWith('<!--', cursor)) {
      const close = source.indexOf('-->', cursor + 4);
      const end = close === -1 ? source.length : close + 3;
      blank(cursor, end);
      cursor = end;
      continue;
    }

    if (source[cursor] === '<') {
      const rawOpen = source.slice(cursor).match(/^<(script|style)(?=[\s/>])/i);
      if (rawOpen) {
        const openEnd = findTagEnd(source, cursor);
        if (openEnd === -1) {
          blank(cursor, source.length);
          break;
        }
        const closePattern = new RegExp(`</${rawOpen[1]}\\s*>`, 'ig');
        closePattern.lastIndex = openEnd;
        const close = closePattern.exec(source);
        const end = close ? close.index + close[0].length : source.length;
        blank(cursor, end);
        cursor = end;
        continue;
      }

      // Skip an ordinary tag as a unit so `<script>` in a quoted attribute
      // cannot be mistaken for a live raw-text opener.
      const tagEnd = findTagEnd(source, cursor);
      if (tagEnd !== -1) {
        cursor = tagEnd;
        continue;
      }
    }

    cursor += 1;
  }

  return chars.join('');
}

/**
 * Scan document markup while ignoring comments and raw-text elements.
 *
 * `scanStartTags` is intentionally a lightweight tag tokenizer and can also
 * see element-shaped text inside a script or comment. SEO metadata readers
 * must not treat that text as live document markup, so the funnel-critical
 * callers use this boundary-aware wrapper.
 *
 * @param {string} html
 * @param {string} [tagName]
 * @returns {ReturnType<typeof scanStartTags>}
 */
export function scanMarkupStartTags(html = '', tagName = '') {
  return scanStartTags(scrubMarkupForTagScan(String(html || '')), tagName);
}

/**
 * Le start tag di piu' nomi con UNA sola scrub e UNA sola tokenizzazione:
 * `scanMarkupStartTagGroups(html, ['meta','link'])` equivale, nome per nome, a
 * `scanMarkupStartTags(html, nome)`. I lettori della testa (`robots`, refresh,
 * canonical) chiamavano la funzione singola tre volte sullo stesso documento.
 *
 * @param {string} html
 * @param {string[]} tagNames
 * @returns {Record<string, ReturnType<typeof scanStartTags>>}
 */
export function scanMarkupStartTagGroups(html = '', tagNames = []) {
  const all = scanHtmlTags(scrubMarkupForTagScan(String(html || '')));
  const groups = {};
  for (const name of tagNames) {
    const target = String(name || '').toLowerCase();
    groups[name] = all.filter((tag) => !tag.closing && (!target || tag.name === target));
  }
  return groups;
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

const VACANCY_SUMMARY_START_RX = '(?:ab sofort(?:\\s+oder\\s+nach\\s+vereinbarung)?|per sofort|nach vereinbarung|d[eè]s maintenant|[àa] partir(?: de maintenant)?|da subito|su richiesta)';
const VACANCY_SUMMARY_LOCATION_RX = new RegExp(
  `^\\s*([^,]{2,80}?)\\s*,\\s*(?:(?:\\d{1,2}\\.\\d{1,2}\\.\\d{4}|${VACANCY_SUMMARY_START_RX})\\s*,\\s*)?\\d{1,3}(?:\\s*[-–]\\s*\\d{1,3})?\\s*%`,
  'iu',
);

/**
 * Read the locality from one SBB vacancy-summary string. The source uses both
 * `Olten, 01.02.2027, 60-100%` and
 * `Olten, ab sofort oder nach Vereinbarung, 60-100%`.
 *
 * @param {string} summary
 * @returns {string} Raw (still entity-encoded) vacancy locality, or ''.
 */
export function extractVacancySummaryLocation(summary = '') {
  const match = String(summary || '').match(VACANCY_SUMMARY_LOCATION_RX);
  return match?.[1]?.trim() || '';
}

/**
 * Read the locality from a job-specific social summary such as
 * `Bellinzona, 01.02.2027, 60-100%`. This narrow shape is used by SBB detail
 * pages when their generic JobPosting JSON-LD contains the Bern headquarters.
 *
 * @param {string} html
 * @returns {string} Raw (still entity-encoded) vacancy locality, or ''.
 */
export function readVacancySummaryLocation(html = '') {
  const summaries = [
    readMetaContent(html, 'twitter:description'),
    readMetaContent(html, 'og:description'),
  ];
  for (const summary of summaries) {
    const locality = extractVacancySummaryLocation(summary);
    if (locality) return locality;
  }
  return '';
}
