/**
 * meta-description-extract.mjs — single source of truth for reading
 * `<meta name=description>` out of an emitted `dist/` HTML page.
 *
 * WHY THIS EXISTS (and why it is a shared module, not three regexes)
 *
 * PR #478 baked html-minifier's `removeAttributeQuotes` into the build, so in
 * `dist/` any single-token attribute value loses its quotes. The description
 * tag on a minified page is emitted as:
 *
 *     <meta name=description content="Guida 2026 …">
 *
 * — `name` unquoted (single token), `content` still quoted (it has spaces).
 * Every reader that matched `name\s*=\s*["']description["']` therefore saw
 * NOTHING on those pages and reported them as "missing description" while the
 * description was right there. Measured on production HTML (2026-08-11): the
 * whole job funnel — `/lavoro-<cantone>-<professione>/`, the cross-canton job
 * search hubs, `/mercato-lavoro-ticino/`, `/aziende…`, `/calcola-stipendio…` — is emitted
 * unquoted, i.e. exactly the highest-CPC family was invisible, while the
 * quoted families (home, the Ticino job hub, sectors, guides) passed.
 *
 * `hasNoindex()` in scripts/validate-page-seo-quality.mjs was already made
 * quote-flexible when #478 landed, and carries a comment saying so; the
 * description reader three lines above it was not. That is the whole defect
 * class: a per-call-site regex that drifts. Hence one module, five call
 * sites — scripts/seo/meta-description-audit.mjs,
 * scripts/validate-page-seo-quality.mjs and
 * tests/dist-duplicate-meta-description.test.ts on our own `dist/`, plus
 * scripts/lib/kispi-job-parser.mjs and scripts/lib/solina-job-parser.mjs on
 * EXTERNAL job HTML.
 *
 * The two parsers are here for the same reason with the risk inverted: their
 * input is someone else's build (stellen.kispi-jobs.ch, jobs.solina.ch), so
 * the day it starts minifying its head nobody tells us — the reader just
 * returns '' and the job description (kispi) or the pensum + city (solina)
 * quietly degrade. They call `extractMetaDescriptionRaw` and keep their own
 * `decodeEntities`, which resolves numeric entities this module deliberately
 * does not: decoding twice would corrupt the double-encoded values Solina
 * actually serves (`ab&amp;nbsp;60%`).
 *
 * The parser is attribute-based rather than one big regex: with unquoted
 * attributes a `[^>]*`-style pattern either stops too early or swallows the
 * neighbouring attributes, and the value of an unquoted attribute has to end
 * at whitespace / `>` / `/`. Parsing the tag's attribute list makes that
 * boundary explicit and makes attribute ORDER irrelevant for free.
 */

/**
 * A whole `<meta …>` tag. The alternation skips over quoted segments so a
 * literal `>` inside `content="…"` cannot truncate the tag.
 */
const META_TAG_RE = /<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;

/**
 * One attribute inside a tag: a name, then optionally `=` and a value that is
 * double-quoted, single-quoted, or bare. A bare value ends at the first
 * whitespace (the `>` is already excluded by META_TAG_RE's capture).
 */
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]*)))?/g;

function parseAttributes(rawAttrs) {
  const attrs = Object.create(null);
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(rawAttrs)) !== null) {
    // `([^\s"'>/=]+)` needs at least one character, so a zero-length match is
    // impossible — but guard anyway so a future edit can't spin forever.
    if (m[0] === '') { ATTR_RE.lastIndex += 1; continue; }
    const key = m[1].toLowerCase();
    // First occurrence wins, like every HTML parser.
    if (!(key in attrs)) attrs[key] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

/**
 * Raw `content` of the first `<meta name=description>` tag, exactly as it
 * appears in the HTML (entities NOT decoded, whitespace NOT collapsed),
 * trimmed. Returns `null` when the tag is absent or its content is empty.
 *
 * Quote-agnostic on BOTH attributes and order-agnostic:
 *   <meta name="description" content="…">
 *   <meta name='description' content='…'>
 *   <meta name=description content="…">
 *   <meta content="…" name=description>
 * and correctly does NOT match `og:description`, `twitter:description`,
 * `property=description` or an unquoted `name=descriptionX`.
 */
export function extractMetaDescriptionRaw(html) {
  if (typeof html !== 'string' || html === '') return null;
  META_TAG_RE.lastIndex = 0;
  let tag;
  while ((tag = META_TAG_RE.exec(html)) !== null) {
    const attrs = parseAttributes(tag[1]);
    if (attrs.name === undefined) continue;
    if (attrs.name.trim().toLowerCase() !== 'description') continue;
    const content = (attrs.content ?? '').trim();
    if (content === '') continue; // keep looking: an empty tag is not a description
    return content;
  }
  return null;
}

const ENTITIES = [
  [/&amp;/g, '&'],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#0?39;/g, "'"],
  [/&#x27;/gi, "'"],
  [/&nbsp;/g, ' '],
];

/**
 * Human-readable description: `extractMetaDescriptionRaw` with the handful of
 * entities the emitters actually produce decoded and whitespace collapsed.
 * Returns `null` when absent or empty after normalisation. This is the shape
 * length/keyword audits want; use the Raw variant when you need byte parity
 * with what is on the page.
 */
export function extractMetaDescription(html) {
  const raw = extractMetaDescriptionRaw(html);
  if (raw === null) return null;
  let out = raw;
  for (const [re, to] of ENTITIES) out = out.replace(re, to);
  out = out.replace(/\s+/g, ' ').trim();
  return out === '' ? null : out;
}
