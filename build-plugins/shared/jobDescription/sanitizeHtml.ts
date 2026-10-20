/**
 * Allowlist sanitizer for third-party job-description HTML (crawler / ATS).
 *
 * ONE sanitizer for both places that put this markup into a page:
 *   - the static job pages, through `jobDescriptionTextToHtml` /
 *     `inlineTextToHtml` (`./toHtml.ts`), used by every job/archive emitter in
 *     `build-plugins/jobsSeoPagesPlugin.ts`;
 *   - the SPA, through the same `jobDescriptionTextToHtml`
 *     (`components/community/JobExpiredView.tsx`).
 * Pure string code, no DOM and no Node API, so it runs unchanged in the build
 * and in the browser bundle.
 *
 * Why it exists (2026-10-02). The passthrough branches of `toHtml.ts` returned
 * the employer's HTML almost verbatim: `<p onmouseover="…">`, `<div onclick>`,
 * `<svg onload>` and `<a href="javascript:…">` reached the static pages
 * unchanged, and `JobExpiredView` injected the raw `descriptionByLocale` with
 * `dangerouslySetInnerHTML`. The only defences were per-tag regexes
 * (`stripExternalHtmlAttributes`, `stripEmbeddedMedia`) that each knew a few
 * tag names; anything they did not name went through.
 *
 * Why not DOMPurify. It is only a transitive dependency here (posthog-js, an
 * optional dep of jspdf), and in the build it needs a DOM (jsdom) for every
 * one of ~300k pages. A DOM parser would also re-balance malformed ATS markup
 * and change the visible text flow, which is why `toHtml.ts` was regex-based
 * in the first place.
 *
 * How it is safe by construction. The input is scanned once, left to right.
 * Every `<` either starts something the scanner recognises (a tag, a comment,
 * a declaration) or is emitted as `&lt;`. Recognised tags are never copied:
 * an allowlisted tag is REBUILT from its lowercase name, with no attributes
 * except `href` on `<a>`, whose scheme is allowlisted after decoding entities
 * and removing control characters. Everything else is dropped — with its
 * content for executable or embedded elements (`script`, `iframe`, `svg`,
 * media, form controls…), tag only otherwise, so the text survives. The
 * output therefore contains no attribute and no tag the code did not write,
 * whatever the browser would have made of the input.
 *
 * Also covered: the Teamtailor `<figure><img>` that was the only
 * `audit:all/page-weight` offender of validate-dist run 36922718485 (images
 * without width/height hotlinked from the ATS CDN).
 */

/** Tags rebuilt as-is (no attributes, except `a[href]`). */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'div', 'span',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'small', 'mark', 'sub', 'sup',
  'blockquote', 'q', 'cite', 'abbr', 'code', 'pre', 'del', 'ins',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'a',
]);

/** Void elements: rebuilt without a closing tag, and a stray `</br>` is dropped. */
const VOID_TAGS = new Set(['br', 'hr']);

/**
 * Elements dropped TOGETHER WITH their content: executable, embedded, or
 * markup whose content is not readable text (form controls, raw-text
 * elements). Any other non-allowlisted tag is unwrapped (tag dropped, text
 * kept), e.g. `figure`, `font`, `section`, `main`, `button`.
 */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset',
  'object', 'applet', 'svg', 'math', 'canvas', 'video', 'audio', 'picture',
  'map', 'textarea', 'select', 'option', 'datalist', 'title', 'head',
  'xmp', 'noembed', 'noframes', 'plaintext',
]);

/** Allowed `href` forms: http(s), mailto, tel, same-site path, fragment. */
const SAFE_HREF_RE = /^(?:https?:|mailto:|tel:|\/|#)/i;

/** Tag at the current position. Lenient on attributes (MS-Word pastes put
 *  unescaped quotes inside `style="…"`): everything up to the first `>`. */
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:\s|\/)[^>]*)?>/y;

/** One attribute inside a tag's attribute string. */
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"?|'([^']*)'?|([^\s>]+)))?/g;

function decodeHrefEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_m, dec: string) => String.fromCodePoint(Math.min(parseInt(dec, 10), 0x10ffff)))
    .replace(/&colon;?/gi, ':')
    .replace(/&tab;?/gi, '\t')
    .replace(/&newline;?/gi, '\n')
    .replace(/&amp;/gi, '&');
}

/**
 * The `href` to keep, or `null`. The scheme check runs on the value as the
 * browser would resolve it: entities decoded, ASCII whitespace and control
 * characters removed (`java\tscript:` and `&#106;avascript:` are the same
 * URL to a browser).
 */
export function safeHref(raw: string): string | null {
  const resolved = decodeHrefEntities(String(raw || '')).replace(/[\u0000- \u007f-\u009f]/g, '');
  if (!resolved || !SAFE_HREF_RE.test(resolved)) return null;
  return resolved
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function rebuildAnchor(attrs: string): string {
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrs)) !== null) {
    if (m[1].toLowerCase() !== 'href') continue;
    const href = safeHref(m[2] ?? m[3] ?? m[4] ?? '');
    return href ? `<a href="${href}">` : '<a>';
  }
  return '<a>';
}

/** Position just past `</name …>` from `from`, or -1. */
function findClosingTag(html: string, name: string, from: number): number {
  const re = new RegExp(`</${name}(?:\\s[^>]*)?>`, 'gi');
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? re.lastIndex : -1;
}

/**
 * Sanitize third-party HTML to the allowlist above. Text, entities and the
 * order of allowed tags are kept as they are; nothing is re-balanced.
 */
export function sanitizeJobDescriptionHtml(input: string): string {
  const html = String(input ?? '');
  if (!html.includes('<')) return html;
  let out = '';
  let i = 0;
  const len = html.length;
  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? len : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end < 0 ? len : end + 1;
      continue;
    }
    TAG_RE.lastIndex = lt;
    const tag = TAG_RE.exec(html);
    if (!tag) {
      out += '&lt;';
      i = lt + 1;
      continue;
    }
    i = TAG_RE.lastIndex;
    const closing = tag[1] === '/';
    const name = tag[2].toLowerCase();
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing) {
        // Unclosed: drop the tag alone. The rest is still scanned, so it can
        // only come out as text or as rebuilt allowlisted tags.
        const end = findClosingTag(html, name, i);
        if (end >= 0) i = end;
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue;
    if (closing) {
      if (!VOID_TAGS.has(name)) out += `</${name}>`;
      continue;
    }
    out += name === 'a' ? rebuildAnchor(tag[3] ?? '') : `<${name}>`;
  }
  return out;
}
