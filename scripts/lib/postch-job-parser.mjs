/**
 * postch-job-parser.mjs
 *
 * Parses a Post.ch / job.post.ch detail page HTML and extracts
 * structured job data.
 *
 * Two detail page formats are supported:
 *
 *   Legacy /v2/ format (decommissioned, kept for fallback):
 *     https://job.post.ch/v2/job-vacancies/{slug}/{uuid}
 *     Contains <script type="application/ld+json"> with JobPosting schema.
 *
 *   Current SuccessFactors NES format:
 *     https://job.post.ch/{brand}/job/{slug}/{id}-{locale}
 *     JSON-LD is built client-side via JS — the static HTML exposes the
 *     job data inside #search-wrapper > .joblayouttoken elements (the
 *     order is documented in the inline rebuilder script):
 *       token 0 → title
 *       token 1 → workload minimum
 *       token 2 → workload maximum
 *       token 3 → jobLocationShort (pipe-separated, e.g. "Bellinzona|Ticino|TI|Svizzera|CHE")
 *       token 12 → posting start date
 *       token 13 → posting end date
 *       token 17 → jobReqId
 *       token 18 → description container (.rtltextaligneligible inside)
 *
 * `parsePostJobDetail` automatically falls back from JSON-LD to the token
 * structure so existing callers keep working.
 */
import { decode as decodeHTML } from 'html-entities';
import { stripScriptsAndStyles } from './crawler-template.mjs';
import { readMetaContent } from './html-attr.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { sourcePostingDateFields } from './source-posting-date.mjs';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Publish every physical locality declared by Post.ch, in source order.
 * This follows the repository convention used by other JSON-LD parsers:
 * multiple localities are joined with `, ` while the first place remains the
 * primary structured-data locality for canton resolution.
 */
export function formatPostJobLocation(places = [], fallback = '') {
  const seen = new Set();
  const localities = [];
  for (const place of Array.isArray(places) ? places : []) {
    const locality = normalizeSpace(place?.city || '');
    const key = locality.toLowerCase();
    if (!locality || seen.has(key)) continue;
    seen.add(key);
    localities.push(locality);
  }
  return localities.length > 0 ? localities.join(', ') : normalizeSpace(fallback);
}

function decodeHtml(value = '') {
  return decodeHTML(String(value || ''), { scope: 'strict' }).replaceAll('\u00a0', ' ');
}

function normalizeDate(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return '';
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

/**
 * Extract all JSON-LD blocks from HTML and return parsed objects.
 */
function extractJsonLd(html = '') {
  const blocks = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else blocks.push(parsed);
    } catch { /* skip malformed JSON-LD */ }
  }
  return blocks;
}

/**
 * Extract a meta tag content value from HTML.
 */
function extractMeta(html, name) {
  return decodeHtml(normalizeSpace(readMetaContent(html, name)));
}

/**
 * Extract <title> from HTML.
 */
function extractTitle(html) {
  const match = stripScriptsAndStyles(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(normalizeSpace(match[1])) : '';
}

/**
 * Derive the location / city from the JobPosting schema.
 */
function deriveCity(jobPosting = {}) {
  const loc = jobPosting.jobLocation;
  if (!loc) return '';
  // jobLocation can be a single Place or array of Places
  const places = Array.isArray(loc) ? loc : [loc];
  for (const place of places) {
    const address = place?.address;
    if (!address) continue;
    if (typeof address === 'string') return normalizeSpace(address);
    const city = address.addressLocality || address.addressRegion || '';
    if (city) return normalizeSpace(city);
  }
  return '';
}

/**
 * Flatten a JobPosting schema's `jobLocation` field into a list of
 * `{ city, region, country }` records. Used by callers that need to pick
 * a specific place from a multi-location job (e.g. "the TI one").
 */
function flattenPlaces(jobPosting = {}) {
  const loc = jobPosting.jobLocation;
  if (!loc) return [];
  const places = Array.isArray(loc) ? loc : [loc];
  return places.map((place) => {
    const address = place?.address;
    if (!address) return { city: '', region: '', country: '' };
    if (typeof address === 'string') {
      return { city: normalizeSpace(address), region: '', country: '' };
    }
    return {
      city: normalizeSpace(address.addressLocality || ''),
      region: normalizeSpace(address.addressRegion || ''),
      country: normalizeSpace(address.addressCountry || ''),
    };
  });
}

/**
 * Derive the region from the JobPosting schema.
 */
function deriveRegion(jobPosting = {}) {
  const loc = jobPosting.jobLocation;
  if (!loc) return '';
  const places = Array.isArray(loc) ? loc : [loc];
  for (const place of places) {
    const address = place?.address;
    if (!address || typeof address === 'string') continue;
    const region = address.addressRegion || '';
    if (region) return normalizeSpace(region);
  }
  return '';
}

/**
 * Derive the street address from the JobPosting schema.
 */
function deriveStreetAddress(jobPosting = {}) {
  const loc = jobPosting.jobLocation;
  if (!loc) return '';
  const places = Array.isArray(loc) ? loc : [loc];
  for (const place of places) {
    const address = place?.address;
    if (!address || typeof address === 'string') continue;
    if (address.streetAddress) return normalizeSpace(address.streetAddress);
  }
  return '';
}

/**
 * Extract description text. Prefer JSON-LD description, fall back to meta.
 */
function deriveDescription(jobPosting = {}, html = '') {
  const desc = jobPosting.description || '';
  if (desc) {
    // Preserve <li> markup as "- " line-start bullets so the audit's
    // hasStructuredContent gate (`/^\s*[-•*]\s/m`) still passes after
    // HTML-to-text conversion. Upstream JobPosting JSON-LD on post.ch
    // pages contains real <ul><li> blocks — collapsing them into plain
    // prose was the root cause of the "no structured content" regression.
    return htmlBlockToTextWithBullets(desc);
  }
  return extractMeta(html, 'description') || extractMeta(html, 'og:description') || '';
}

/**
 * Parse workload / employment type from the JSON-LD.
 */
function deriveEmploymentType(jobPosting = {}) {
  const et = jobPosting.employmentType;
  if (!et) return '';
  if (Array.isArray(et)) return et[0] || '';
  return String(et);
}

/**
 * Strip a single layer of outer wrapper element to expose inner text, then
 * collapse whitespace. Keeps inline block separations as single spaces.
 */
function htmlBlockToText(value = '') {
  return normalizeSpace(
    String(value || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/?(p|div|li|ul|ol|h[1-6])[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  );
}

/**
 * Convert HTML to plain text WHILE preserving `<li>` items as line-start
 * "- " bullet markers. The audit-parser-quality.mjs ratchet requires
 * descriptions to contain structured content (`<li>` tag OR `^\s*[-•*]\s`
 * line-start markers). Post.ch detail pages serve real `<ul><li>` blocks
 * upstream — collapsing them into a single line of prose with the generic
 * `htmlBlockToText` above produces "flat" descriptions that fail the gate.
 *
 * Strategy mirrors `innerTextWithBullets` in `lidl-job-parser.mjs`: replace
 * `<li>` with "- " and `</li>` with newline, then strip every other tag.
 * Resulting text contains line-start "- item" markers that satisfy both
 * `hasStructuredContent` (audit gate) and the existing text-to-HTML ratio
 * gate.
 *
 * Idempotent on bullet-free text.
 *
 * The SuccessFactors rich-text editor writes CRLF line endings and `&nbsp;`
 * spacer paragraphs INSIDE list items (`<li>\r\n<p>item</p></li>`). Neither
 * `\r` nor U+00A0 is matched by `[ \t]`, so before this normalisation the
 * marker came out as `- \r\n\nitem`: the "- " line was never joined to its
 * item, downstream whitespace cleaning dropped the orphan markers and the
 * published list collapsed into loose paragraphs (115/216 Post.ch vacancies
 * on 2026-09-29, e.g. every "Lehre als Logistiker:in" apprenticeship).
 */
export function htmlBlockToTextWithBullets(value = '') {
  if (!value) return '';
  const withBullets = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/?(p|div|ul|ol|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  // Collapse extra spaces but keep newlines so "- " stays line-start.
  return withBullets
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/(^|\n)-\n+/g, '$1- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract the first `.rtltextaligneligible` span while honoring nested spans.
 * Post.ch uses nested spans in the rich description token, so a non-greedy
 * closing-tag match would truncate the description at the first child span.
 */
function extractBalancedRtlTextAlignEligibleInner(block = '') {
  const rtlOpening = String(block || '').match(
    /<span[^>]*class=["'][^"']*\brtltextaligneligible\b[^"']*["'][^>]*>/i,
  );
  if (!rtlOpening || rtlOpening.index === undefined) return '';

  const rtlContentStart = rtlOpening.index + rtlOpening[0].length;
  const nestedRtlSpanTag = /<\/?span\b[^>]*>/gi;
  nestedRtlSpanTag.lastIndex = rtlContentStart;
  let rtlDepth = 1;
  let nestedRtlTagMatch;

  while ((nestedRtlTagMatch = nestedRtlSpanTag.exec(block)) !== null) {
    const nestedRtlTag = nestedRtlTagMatch[0];
    if (/^<\//.test(nestedRtlTag)) {
      rtlDepth -= 1;
    } else if (!/\/\s*>$/.test(nestedRtlTag)) {
      rtlDepth += 1;
    }
    if (rtlDepth === 0) return block.slice(rtlContentStart, nestedRtlTagMatch.index);
  }

  // Keep a partial body rather than falling back to the short first nested
  // span when a source response omits the outer closing tag.
  return block.slice(rtlContentStart);
}

/**
 * Every top-level `.rtltextaligneligible` span of a SuccessFactors NES page,
 * each read to its BALANCED closing tag (nested spans stay inside their
 * parent). PostFinance pages carry no `#search-wrapper` token list the
 * position-based reader above relies on, so their caller scans all spans; a
 * non-greedy `([\s\S]*?)<\/span>` stopped the rich body at its first inline
 * child span and published only the opening paragraph.
 */
export function extractRtlTextAlignEligibleSpans(html = '') {
  const source = String(html || '');
  const opening = /<span[^>]*class=["'][^"']*\brtltextaligneligible\b[^"']*["'][^>]*>/gi;
  const spans = [];
  let match;
  while ((match = opening.exec(source)) !== null) {
    const inner = extractBalancedRtlTextAlignEligibleInner(source.slice(match.index));
    spans.push(inner);
    opening.lastIndex = match.index + match[0].length + inner.length;
  }
  return spans;
}

const POST_DESCRIPTION_LOCALES = ['it', 'en', 'de', 'fr'];

function comparableLocaleText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Key a Post-platform description under the language it is written in.
 *
 * `job.post.ch` serves a vacancy only in the languages it was written in, so
 * a German or French body used to be stored as `descriptionByLocale.it` (and
 * re-forced there after every localization pass). The Italian site then
 * rendered German/French text, and the translation step never filled the
 * Italian slot because it looked occupied: 214/216 Post.ch and 18/19
 * PostFinance vacancies on 2026-09-29. A non-source slot that holds the
 * source text — the same text, or text `detectLanguage` reads as the source
 * language — is a mis-keyed copy, not a translation, and is dropped so the
 * localization pass can write the real one. Real translations stay.
 *
 * @param {Record<string, string>} descriptionByLocale
 * @param {string} description   the source-language body
 * @param {string} sourceLang    it | en | de | fr
 * @param {(text: string) => string} [detectLanguage]
 */
export function keyPostDescriptionBySourceLocale(
  descriptionByLocale = {},
  description = '',
  sourceLang = '',
  detectLanguage = null,
) {
  const out = { ...(descriptionByLocale && typeof descriptionByLocale === 'object' ? descriptionByLocale : {}) };
  const text = String(description || '').trim();
  const lang = String(sourceLang || '').trim().toLowerCase();
  if (!text || !POST_DESCRIPTION_LOCALES.includes(lang)) return out;
  const sourceText = comparableLocaleText(text);
  for (const locale of POST_DESCRIPTION_LOCALES) {
    if (locale === lang || !out[locale]) continue;
    const slot = String(out[locale]);
    const sameText = comparableLocaleText(slot) === sourceText;
    const sameLanguage = typeof detectLanguage === 'function' && detectLanguage(slot) === lang;
    if (sameText || sameLanguage) delete out[locale];
  }
  out[lang] = text;
  return out;
}

/**
 * Key a Post-platform title under the language its vacancy page is written
 * in, like {@link keyPostDescriptionBySourceLocale}.
 *
 * The runners used to write the German/French page title into
 * `titleByLocale.it` and force it back there after every localization pass,
 * so the Italian page showed the untranslated title and the translation step
 * saw the Italian slot as filled (66/216 Post.ch and 4/19 PostFinance
 * vacancies with `it` equal to the German/French title on 2026-09-29). An
 * `it` slot that is a copy of the source title — the current one or one a
 * previous run stored — is that stale write: it is dropped and the caller
 * flags the record for retranslation. Any other `it` title (a translation,
 * even an imperfect one) is the translation pipeline's and stays. Slugs are
 * deliberately not touched here.
 *
 * @param {Record<string, string>} titleByLocale
 * @param {string} title       the source-language title
 * @param {string} sourceLang  it | en | de | fr
 * @param {{ previousTitles?: string[] }} [context]  source titles stored by earlier runs
 * @returns {{ titleByLocale: Record<string, string>, droppedStaleItalian: boolean }}
 */
export function keyPostTitleBySourceLocale(titleByLocale = {}, title = '', sourceLang = '', { previousTitles = [] } = {}) {
  const out = { ...(titleByLocale && typeof titleByLocale === 'object' ? titleByLocale : {}) };
  const text = String(title || '').trim();
  const lang = String(sourceLang || '').trim().toLowerCase();
  if (!text || !POST_DESCRIPTION_LOCALES.includes(lang)) return { titleByLocale: out, droppedStaleItalian: false };
  let droppedStaleItalian = false;
  const italian = comparableLocaleText(out.it);
  if (lang !== 'it' && italian) {
    const sourceCopies = new Set([text, ...previousTitles].map(comparableLocaleText).filter(Boolean));
    if (sourceCopies.has(italian)) {
      delete out.it;
      droppedStaleItalian = true;
    }
  }
  out[lang] = text;
  return { titleByLocale: out, droppedStaleItalian };
}

/* ── Source-body continuity (no invented text) ─────────────── */

// The Italian texts the Post-platform runners used to invent when a vacancy
// body could not be read: update-postch-jobs.mjs's one-liner and
// update-postfinance-jobs.mjs's three-sentence buildPostFinanceFallbackDescription().
// Records written by those runs can still carry them in a locale slot.
const POST_FALLBACK_DESCRIPTION_RX = [
  /^Posizione aperta presso .+?\. Ruolo: .+?\. Sede: .+?, Svizzera\.$/,
  /^PostFinance, la sussidiaria di servizi finanziari della Posta Svizzera, ricerca attualmente la figura .+? è necessario visitare la pagina dell'annuncio collegata a questo articolo\.$/,
];

/** True when `text` is one of the invented fallback descriptions and nothing else. */
export function isPostFallbackDescription(text = '') {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return Boolean(value) && POST_FALLBACK_DESCRIPTION_RX.some((rx) => rx.test(value));
}

/**
 * The source-language body a previous run read from this vacancy, or ''.
 * Only a body that clears the shared 50-word floor (source-body-floor.mjs)
 * counts: a shorter one would be a thin page, so it is not carried either.
 */
export function previousPostSourceBody(job) {
  for (const candidate of [job?.descriptionByLocale?.[job?.sourceLang], job?.description]) {
    const text = String(candidate || '').trim();
    if (text && !isPostFallbackDescription(text) && meetsSourceBodyFloor(text)) return text;
  }
  return '';
}

/**
 * Give a freshly built vacancy a body read from the source, or none at all.
 *
 * A vacancy whose body could not be read this run (empty `description`) keeps
 * the text a previous run read from the SAME vacancy, with that run's
 * `sourceLang`. Without such text it returns `null`: the vacancy is not
 * published in this run, and the next run that reads its body publishes it
 * again. Nothing is ever written in place of the source.
 *
 * @param {object} freshJob
 * @param {object|null} previousJob  the stored record with the same stable id
 * @returns {{ job: object|null, carried: boolean }}
 */
export function carryPostSourceBody(freshJob, previousJob = null) {
  if (String(freshJob?.description || '').trim()) return { job: freshJob, carried: false };
  const body = previousJob ? previousPostSourceBody(previousJob) : '';
  if (!body) return { job: null, carried: false };
  const sourceLang = previousJob.sourceLang || freshJob?.sourceLang || '';
  return {
    job: {
      ...freshJob,
      description: body,
      ...(sourceLang ? { sourceLang, descriptionByLocale: { [sourceLang]: body } } : {}),
    },
    carried: true,
  };
}

/**
 * Remove invented fallback text from a merged record.
 *
 * The locale merge keeps every non-source slot ("existing translation
 * wins"), so a record that once published an invented text keeps it — and
 * machine translations of it — after the real body is back. When any slot
 * still carries it, every non-source slot is of that vintage: only the real
 * source slot is kept and the record is flagged for retranslation. A record
 * with no real source body left returns `null` (not publishable).
 *
 * @param {object} job merged record
 * @returns {object|null}
 */
export function stripPostFallbackSlots(job) {
  if (!job || typeof job !== 'object') return job;
  const slots = job.descriptionByLocale && typeof job.descriptionByLocale === 'object'
    ? job.descriptionByLocale
    : {};
  const invented = isPostFallbackDescription(job.description)
    || Object.values(slots).some((text) => isPostFallbackDescription(text));
  if (!invented) return job;
  const body = previousPostSourceBody(job);
  if (!body) return null;
  const sourceLang = job.sourceLang;
  return {
    ...job,
    description: body,
    descriptionByLocale: sourceLang ? { [sourceLang]: body } : {},
    needsRetranslation: true,
  };
}

/**
 * True when a parsed Post-platform detail page can be published as it is: a
 * real title (a locale the vacancy was not translated to renders the generic
 * "Stellendetails" placeholder) and a body that clears the shared 50-word
 * floor of source-body-floor.mjs. The former `> 80` characters gate let a
 * 13-49-word body through as a thin page.
 *
 * @param {{ title?: string, description?: string } | null} parsed  parsePostJobDetail() output
 */
export function isPublishablePostDetail(parsed) {
  const title = String(parsed?.title || '').trim();
  if (!title || /^stellendetails$/i.test(title)) return false;
  return meetsSourceBodyFloor(parsed?.description);
}

/**
 * Iterate `.joblayouttoken` blocks inside #search-wrapper in document order.
 * Returns an array; index N corresponds to the Nth token.
 *
 * Each entry is `{ inner: string, text: string }`. `inner` is the raw inner
 * HTML of the .rtltextaligneligible span (preserves paragraph markup for
 * the description token), `text` is the whitespace-normalised text content.
 */
function extractJobLayoutTokens(html = '') {
  const wrapperMatch = html.match(/<div\s+id=["']search-wrapper["'][^>]*>([\s\S]*)/i);
  if (!wrapperMatch) return [];
  // Cheap delimiter: split on each opening joblayouttoken div and take its body.
  // We don't need to track nesting depth — every token block ends right before
  // the next opening tag or before the wrapper's closing region.
  const wrapper = wrapperMatch[1];
  const tokenRe = /<div\s+class=["']joblayouttoken[^"']*["'][^>]*>([\s\S]*?)(?=<div\s+class=["']joblayouttoken|<div\s+id=["']page-bottom|<\/div>\s*<\/div>\s*<div\s+id=["']page-bottom|$)/gi;
  const tokens = [];
  let m;
  while ((m = tokenRe.exec(wrapper)) !== null) {
    const block = m[1];
    const inner = extractBalancedRtlTextAlignEligibleInner(block);
    tokens.push({ inner, text: htmlBlockToText(inner) });
  }
  return tokens;
}

// Localities that the SF rebuilder treats as non-physical placements (home
// office, remote, hybrid in DE/FR/IT/EN). They appear inline in the same
// pipe-separated token as physical locations and must be skipped.
const HOMEOFFICE_LOCALITIES = new Set([
  'homeoffice', 'home office', 'home-office',
  'remote', 'remotearbeit', 'travail à distance', 'lavoro a distanza', 'fernarbeit',
  'hybrid', 'hybride', 'ibrido', 'hub locations', 'siti hub',
]);

/**
 * Convert a Post.ch pipe-separated location token into a list of JSON-LD
 * Place objects. Multiple locations are concatenated in the same token,
 * separated only by pipes (e.g. "City1|Canton|CC|Country|CCC  | City2|…").
 * The format mirrors `parseJobLocations` in the page's own SF rebuilder JS.
 */
function parseLocationToken(text = '') {
  const cleaned = String(text || '').trim();
  if (!cleaned) return [];
  const parts = cleaned.split('|').map(p => p.trim()).filter(Boolean);
  const places = [];
  let i = 0;
  while (i < parts.length) {
    const current = parts[i];
    if (HOMEOFFICE_LOCALITIES.has(current.toLowerCase())) {
      // home-office entries are followed by 2 segments (country, country code).
      i += i + 2 < parts.length ? 3 : 1;
      continue;
    }
    if (i + 4 < parts.length) {
      const [locality, canton, cantonCode, country, countryCode] = parts.slice(i, i + 5);
      if (/^[A-Z]{2,3}$/.test(cantonCode) && /^[A-Z]{2,3}$/.test(countryCode)) {
        places.push({
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress',
            addressLocality: locality,
            addressRegion: cantonCode,
            addressCountry: countryCode,
          },
        });
        i += 5;
        continue;
      }
    }
    if (i + 2 < parts.length) {
      const [locality, country, countryCode] = parts.slice(i, i + 3);
      if (/^[A-Z]{2,3}$/.test(countryCode)) {
        places.push({
          '@type': 'Place',
          address: {
            '@type': 'PostalAddress',
            addressLocality: locality,
            addressCountry: countryCode,
          },
        });
        i += 3;
        continue;
      }
    }
    i += 1;
  }
  return places;
}

/**
 * Convert SuccessFactors NES date tokens ("28/04/26", "13.05.26", "5/13/26")
 * into ISO using the locale embedded in the URL. Preserve full ISO timestamps
 * for the publication validator; unknown input remains empty.
 */
function parseTokenDate(raw = '', url = '') {
  const s = String(raw || '').trim();
  if (!s) return '';
  const isUS = /-en_US\b/i.test(url);
  // Do not parse/truncate an ISO timestamp before the publication validator.
  // Locale-specific four-digit-year dates must use the same path as short years.
  if (/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(s)) return s;
  const match = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (!match) return '';
  let [, a, b, y] = match;
  if (y.length === 2) y = `20${y}`;
  const day = isUS ? Number(b) : Number(a);
  const month = isUS ? Number(a) : Number(b);
  const year = Number(y);
  if (!day || !month || !year) return '';
  const iso = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(iso.getTime())) return '';
  // Round-trip: reject calendar-impossible dates (31/04, 31/02) silently
  // overflowed by Date.UTC instead of returning empty.
  if (iso.getUTCDate() !== day || iso.getUTCMonth() !== month - 1) return '';
  return iso.toISOString().slice(0, 10);
}

/**
 * Build a JobPosting-shaped object from the token structure of a current
 * SuccessFactors NES detail page. Returns `null` if the page does not
 * contain the expected `.joblayouttoken` markup.
 *
 * Two layouts are emitted by the same template:
 *   - "Regular" (`PFCH`/professional):  description in token 18,
 *     workload in tokens 1-2, posting dates in tokens 12-13.
 *   - "Apprenticeship" (`PCH` brand):  description in token 11,
 *     duration in token 1, no posting-date tokens.
 *
 * We detect the layout by checking whether token 18 carries text — when it
 * does, it's the regular layout; otherwise we fall back to token 11.
 */
function buildJobPostingFromTokens(html = '', url = '') {
  const tokens = extractJobLayoutTokens(html);
  if (tokens.length < 4) return null;
  const title = tokens[0]?.text || '';
  if (!title) return null;
  const locationToken = tokens[3]?.text || '';
  const jobLocation = parseLocationToken(locationToken);
  if (jobLocation.length === 0) return null;

  const regularDescInner = tokens[18]?.inner || '';
  const regularDesc = htmlBlockToTextWithBullets(regularDescInner);
  const apprenticeshipDescInner = tokens[11]?.inner || '';
  const apprenticeshipDesc = htmlBlockToTextWithBullets(apprenticeshipDescInner);

  const isRegular = regularDesc.length > 40;
  const descriptionInner = isRegular ? regularDescInner : apprenticeshipDescInner;
  const description = isRegular ? regularDesc : apprenticeshipDesc;

  const datePosted = isRegular ? parseTokenDate(tokens[12]?.text || '', url) : '';
  const validThrough = isRegular ? parseTokenDate(tokens[13]?.text || '', url) : '';

  const pensumMin = tokens[1]?.text || '';
  const pensumMax = tokens[2]?.text || '';
  let employmentType = '';
  let workloadRange = '';
  if (isRegular) {
    const maxNum = Number(pensumMax);
    if (Number.isFinite(maxNum) && maxNum > 0 && maxNum < 100) employmentType = 'PART_TIME';
    else if (Number.isFinite(maxNum) && maxNum >= 100) employmentType = 'FULL_TIME';
    workloadRange = pensumMin && pensumMax && pensumMin !== pensumMax
      ? `${pensumMin}-${pensumMax}%`
      : (pensumMax ? `${pensumMax}%` : '');
  } else {
    employmentType = 'INTERN'; // apprenticeship layout
  }

  return {
    '@type': 'JobPosting',
    title,
    description,
    jobLocation,
    datePosted,
    validThrough,
    employmentType,
    _workloadRange: workloadRange,
  };
}

/**
 * Extract a stable Post.ch job ID from a detail URL.
 *
 * Handles both URL families:
 *   - Legacy:   .../v2/job-vacancies/{slug}/{uuid}            → "uuid:{uuid}"
 *   - Current:  .../{brand}/job/{slug}/{id}-{locale}          → "sfid:{id}"
 *
 * Returns '' for unrecognised URLs so callers can fall back to the URL
 * itself as a match key.
 */
export function extractPostJobIdFromUrl(url = '') {
  const u = String(url || '').trim().toLowerCase();
  if (!u) return '';
  const uuidMatch = u.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  if (uuidMatch) return `uuid:${uuidMatch[0]}`;
  // SuccessFactors NES IDs are 4-7 digit numbers immediately before the
  // locale suffix (e.g. /73503-it_IT). The legacy stable-id extractor only
  // matches ≥6 digits, but post.ch IDs are routinely 5 digits, so we have
  // our own narrower regex anchored on the locale suffix.
  const sfMatch = u.match(/\/(\d{4,7})-([a-z]{2})_([a-z]{2})(?:[\/?#]|$)/);
  if (sfMatch) return `sfid:${sfMatch[1]}`;
  return '';
}

/**
 * Parse a Post.ch job detail page and return structured data.
 *
 * @param {string} html - Raw HTML of the detail page
 * @param {string} url  - URL of the detail page (for fallback data)
 * @returns {object} Structured job detail
 */
export function parsePostJobDetail(html = '', url = '') {
  const jsonLdBlocks = extractJsonLd(html);

  // Find the JobPosting schema block
  let jobPosting = jsonLdBlocks.find(
    b => b['@type'] === 'JobPosting' || b['@type']?.includes?.('JobPosting')
  );

  // Fall back to the token structure used by current SuccessFactors NES pages.
  if (!jobPosting) {
    jobPosting = buildJobPostingFromTokens(html, url);
  }
  jobPosting = jobPosting || {};

  const hiringOrg = jobPosting.hiringOrganization;
  const hiringOrgName = typeof hiringOrg === 'string'
    ? hiringOrg
    : (hiringOrg?.name || '');

  const title = normalizeSpace(jobPosting.title || '')
    || extractMeta(html, 'og:title')
    || extractTitle(html).replace(/\s*\|\s*(?:Die\s+Post|La\s+Poste|La\s+Posta|Swiss\s+Post|Post\s*CH(?:\s+AG)?|Post)\s*$/i, '')
    || '';

  const city = deriveCity(jobPosting);
  const region = deriveRegion(jobPosting);
  const streetAddress = deriveStreetAddress(jobPosting);
  const places = flattenPlaces(jobPosting);
  const description = deriveDescription(jobPosting, html);
  const employmentType = deriveEmploymentType(jobPosting);
  const datePosted = sourcePostingDateFields(jobPosting.datePosted).datePosted;
  const validThrough = normalizeDate(jobPosting.validThrough || '');
  const industry = normalizeSpace(jobPosting.industry || jobPosting.occupationalCategory || '');

  // Workload (pensum) — Post.ch sometimes includes it in the title or description;
  // current SuccessFactors NES pages expose it as discrete tokens that
  // `buildJobPostingFromTokens` surfaces via `_workloadRange`.
  let workload = jobPosting._workloadRange || '';
  if (!workload) {
    const workloadMatch = (title + ' ' + description).match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/);
    if (workloadMatch) {
      workload = `${workloadMatch[1]}-${workloadMatch[2]}%`;
    } else {
      const singleMatch = (title + ' ' + description).match(/(\d{1,3})\s*%/);
      if (singleMatch) workload = `${singleMatch[1]}%`;
    }
  }

  return {
    title,
    description,
    hiringOrg: normalizeSpace(hiringOrgName),
    city,
    region,
    location: city || region || '',
    streetAddress,
    industry,
    datePosted,
    validThrough,
    employmentType,
    workload,
    places, // every parsed jobLocation, used by callers to pick a target city
    url,
  };
}
