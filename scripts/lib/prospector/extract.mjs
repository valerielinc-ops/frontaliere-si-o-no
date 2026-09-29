/**
 * Generic vacancy extraction — the part that lets a crawler exist before anyone
 * has written a parser for it.
 *
 * A cascade, best evidence first. Every rung yields the same normalised shape,
 * so the caller never branches on which one fired:
 *
 *   1. JSON-LD `JobPosting`        — schema.org, authored by the site itself.
 *   2. Microdata `itemtype=JobPosting` — same contract, older syntax.
 *   3. Path-template clustering    — no structured data at all: infer the
 *      listing from the shape of the links. This is the rung that reads the
 *      long tail, where a micro-employer's ATS emits plain HTML.
 *
 * Rung 3 is the interesting one. On a vacancy index every job link shares a URL
 * template (`/annunci-lavoro/<slug>-<id>.htm`) while navigation links do not, so
 * clustering links by template and taking the largest job-ish cluster recovers
 * the listing without knowing anything about the vendor. It degrades honestly:
 * a page with no repeated template yields nothing rather than yielding noise.
 */
import { createHash } from 'node:crypto';
import { normalizeHost, safeDecodePath } from './registrable.mjs';
import { decodeEntities } from './entities.mjs';
import { readAttr, scanHtmlTags } from '../html-attr.mjs';
import {
  evaluateSourceBackedSwissGeography,
  locationEvidenceCandidates,
  schemaJobLocationCandidates,
} from './location-evidence.mjs';

/**
 * Tokens that mark a URL path or heading as vacancy-related on their own, in
 * all four locales. Everything listed here means "vacancy" and nothing else.
 */
const VACANCY_PATH_STRONG_RX =
  /(annunci|posizioni|lavoro|lavora|carrier|jobs?|stellen|karriere|vacan|emploi|poste|career|opportunit|apply|bewerb|candidat|recruit|ausschreib|offene)/i;

/**
 * Tokens that mean "vacancy" only next to a job word, and something else
 * entirely on their own — the ambiguity is real and it has already cost us a
 * live crawler.
 *
 * `offerte` was in the strong list. Hotel International au Lac serves a
 * `/it/jobs/` page that today carries NO vacancy at all (it says applications
 * are welcome by post in January/February) but does carry the site's promo
 * carousel: nine `/it/offerte/<slug>/` links. With no real vacancy cluster to
 * compete against, `/it/offerte/*​/` scored the `jobish` bonus below, won as
 * best cluster, and four room-rate promos ("Offerta speciale 3 notti",
 * "Prenota SENZA carta di credito!") shipped as job listings.
 *
 * Same shape for the others: `posti` is parking spaces and theatre seats as
 * often as "posti vacanti"; `stelle` is an Italian hotel's star rating, while
 * the German vacancy sense is always the plural `stellen`, which stays strong
 * above. They only count when the same path also carries a job word.
 */
const VACANCY_PATH_WEAK_RX = /(offert[ae]|posti|stelle)/i;

/** Job words that disambiguate a weak token appearing in the same path. */
const VACANCY_PATH_QUALIFIER_RX =
  /(lavoro|lavori|impieg\w*|occupazion\w*|assunzion|jobs?|work|emploi|travail|arbeit|beruf|stellen|karriere|career|vacan|candidat|recruit|hiring)/i;

/**
 * Whether a URL path (or heading) reads as vacancy-related.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isVacancyPath(value = '') {
  const s = String(value || '');
  if (VACANCY_PATH_STRONG_RX.test(s)) return true;
  return VACANCY_PATH_WEAK_RX.test(s) && VACANCY_PATH_QUALIFIER_RX.test(s);
}

/** Words that appear on a page listing vacancies but rarely elsewhere. */
const VACANCY_TEXT_RX =
  /(posizioni aperte|offerte di lavoro|annunci di lavoro|lavora con noi|posti vacanti|candidati ora|invia (?:il tuo )?cv|offene stellen|stellenangebote|jetzt bewerben|freie stellen|offres d'emploi|postes vacants|postuler|rejoignez|open positions|current openings|apply now|job openings|we are hiring)/i;

/**
 * Strip tags and collapse whitespace.
 * @param {string} html
 * @returns {string}
 */
export function textOf(html = '') {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Text of a vacancy body with its structure kept: one line per block
 * (paragraph, heading, table row, `<br>`), list items as `- item` lines.
 * `textOf` collapses everything to one line, and every description read from
 * a detail page lost its lists that way: anker-swiss published 179 of its 209
 * vacancies as one paragraph although each page lists its tasks, profile and
 * benefits as `<ul>` (parser-quality run 36571839273: no-structured-content).
 * Plain text with its own line breaks (a JSON-LD `description` written as
 * `\r\n- item` lines, grischapersonal) keeps them too. Whitespace inside a line
 * is collapsed as by `textOf`, so a comparison that normalises whitespace sees
 * the same words.
 *
 * @param {string} html
 * @returns {string}
 */
export function bodyTextOf(html = '') {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|ul|ol|h[1-6]|tr|section|article|header|footer|table|tbody|thead|dl|dt|dd|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    // An item whose text sits in a nested block (`<li><p>…</p></li>`) starts
    // on the next line: join it back to its marker.
    .replace(/\n- ?\n+/g, '\n- ')
    .replace(/\n- (?:- ?)+/g, '\n- ')
    .replace(/\n(?:- ?)?(?=\n)/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * All JSON-LD blocks in a document, flattened through `@graph`.
 * Malformed blocks are skipped — SME sites ship broken JSON-LD routinely and one
 * bad block must not cost the whole page.
 *
 * @param {string} html
 * @returns {any[]}
 */
/**
 * Escape U+0000-U+001F inside a string literal, where JSON forbids them, and
 * leave every byte outside a string exactly as it is. Outside a string, tab,
 * CR and LF are the whitespace that formats the document and must survive
 * verbatim — escaping them would corrupt valid JSON-LD (`{\n"a":1}` with a
 * literal backslash-n outside a string no longer parses). The remaining
 * control characters are invalid out there whatever this function does, so
 * they are left for `JSON.parse` to reject rather than rewritten into
 * something that parses. Hence the scan tracks string state and honours
 * backslash escapes instead of doing a blanket replace.
 *
 * Deliberately NOT a full JSON parser, and not a specification of one: it only
 * makes an otherwise-valid document parseable, and anything still malformed is
 * left to `JSON.parse` to reject, so a genuinely broken block keeps being
 * discarded.
 *
 * @param {string} raw
 * @returns {string}
 */
export function escapeControlCharsInJsonStrings(raw = '') {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const char of String(raw)) {
    if (escaped) { out += char; escaped = false; continue; }
    if (inString && char === '\\') { out += char; escaped = true; continue; }
    if (char === '"') { inString = !inString; out += char; continue; }
    const code = char.codePointAt(0);
    if (inString && code < 0x20) {
      if (code === 0x0a) out += '\\n';
      else if (code === 0x0d) out += '\\r';
      else if (code === 0x09) out += '\\t';
      else out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += char;
  }
  return out;
}

export function jsonLdBlocks(html = '') {
  const out = [];
  const rx = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html))) {
    const raw = m[1].trim().replace(/^\uFEFF/, '');
    if (!raw) continue;
    // Two independent defects can afflict one block, so BOTH repairs must be
    // tried against BOTH representations — four combinations, not a chain.
    //
    //   entity-escaped JSON-LD, which CMS-generated pages emit routinely (the
    //     retry this inherits from scripts/lib/shared-jobs-crawler.mjs, whose
    //     extractor is module-private);
    //   raw control characters inside a string literal, which a CMS emits
    //     whenever it interpolates a textarea/rich-text field without
    //     escaping — `JSON.parse` rejects any U+0000-U+001F there ("Bad
    //     control character in string literal").
    //
    // Chaining them (escape only the raw text, after entity-decoding failed)
    // left a block that needs BOTH still discarded — the gap the review of
    // PR #9161 caught. A block is dropped only when all four attempts fail.
    //
    // Why this matters more than a parse statistic: every miss used to be a
    // silent `continue`, and a caller that then falls back to synthesizing
    // content turns the loss into plausible-looking data. On jobs.csd.ch this
    // exact path produced descriptions that were just `<title> — CSD
    // ENGINEERS, <city>` (6-11 unique words) while the page carried a
    // 2595-char JobPosting description, and the boilerplate guard in
    // assemble-jobs-dataset.mjs only caught it afterwards, by failing the
    // whole crawler.
    let parsed;
    let didParse = false;
    for (const candidate of [raw, decodeEntities(raw)]) {
      for (const repaired of [candidate, escapeControlCharsInJsonStrings(candidate)]) {
        try {
          parsed = JSON.parse(repaired);
          didParse = true;
          break;
        } catch { /* try the next representation */ }
      }
      if (didParse) break;
    }
    if (!didParse) continue;
    const push = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(push); return; }
      out.push(node);
      if (Array.isArray(node['@graph'])) node['@graph'].forEach(push);
    };
    push(parsed);
  }
  return out;
}

/**
 * @param {any} node
 * @returns {boolean}
 */
function isJobPostingNode(node) {
  const t = node?.['@type'];
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => String(x || '').toLowerCase() === 'jobposting');
}

/** @param {any} v @returns {string} */
function firstString(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return firstString(v[0]);
  if (v && typeof v === 'object') return firstString(v.name || v['@value'] || v.value || '');
  return '';
}

// These fields describe freshness/expiry of a posting, not its identity. They
// are allowed to change while the same vacancy remains live. Every other
// structured field stays in the payload: in particular `identifier`,
// `employmentType` and `hiringOrganization` can distinguish two URL-less
// postings that happen to share the same title, date, description and place.
const JSONLD_IDENTITY_VOLATILE_KEYS = new Set([
  'dateModified',
  'validThrough',
]);

/**
 * Canonicalise a JSON-LD node without depending on source object key order.
 * Arrays retain their order because it can itself be meaningful (for example
 * an ordered list of locations or identifiers).
 *
 * @param {any} value
 * @param {string} [key]
 * @returns {any}
 */
function canonicalJsonLdIdentity(value, key = '') {
  if (JSONLD_IDENTITY_VOLATILE_KEYS.has(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => canonicalJsonLdIdentity(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().flatMap((childKey) => {
    const canonical = canonicalJsonLdIdentity(value[childKey], childKey);
    return canonical === undefined ? [] : [[childKey, canonical]];
  }));
}

/**
 * Normalised vacancy record. Field names mirror the ones the site's job
 * pipeline already uses, so a synthesised crawler needs no translation layer.
 *
 * @typedef {Object} Vacancy
 * @property {string} title
 * @property {string} url
 * @property {string} [sourceUrl] The fetched page when `url` is an inline-posting identity
 * @property {boolean} [urlExplicit] Whether the structured record itself named the URL
 * @property {string} [company]
 * @property {string} [location]
 * @property {string} [addressCountry]
 * @property {Array<{
 *   location: string,
 *   addressCountry: string,
 *   addressLocality?: string,
 *   addressRegion?: string,
 *   postalCode?: string,
 *   streetAddress?: string,
 * }>} [locationCandidates]
 * @property {string} [description]
 * @property {string} [postedDate]
 * @property {string} [employmentType]
 * @property {'jsonld'|'microdata'|'template'|'known-template'} via
 */

/**
 * JobPosting properties that carry part of the vacancy body. schema.org lets a
 * publisher split the ad: Dualoo puts only the intro in `description` and the
 * tasks, profile and offer in `responsibilities`, `qualifications` and
 * `jobBenefits`, so reading `description` alone measured a 600-character
 * intro against a complete published body.
 */
const JOB_POSTING_BODY_PROPERTIES = [
  'responsibilities',
  'qualifications',
  'skills',
  'educationRequirements',
  'experienceRequirements',
  'jobBenefits',
];

/** Prose values of a JobPosting property: strings only, never typed nodes. */
function proseValues(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => (typeof item === 'string' ? [item] : []));
  return [];
}

/**
 * Text of a structured prose value. Some CMSs entity-escape the HTML they put
 * in JSON-LD (`&lt;p&gt;…`), so the tags survive `textOf` as words and one
 * posting measured 8000 characters of markup (tally-weijl, omega). Escaped
 * tags are decoded and then stripped like real ones; a value without escaped
 * tags is left exactly as it was.
 *
 * @param {string} value
 * @returns {string}
 */
export function structuredProseText(value = '') {
  let raw = String(value || '');
  // Escaped once (`&lt;p&gt;`) or twice (`&amp;lt;p&amp;gt;`): decode until
  // no escaped tag is left, at most three rounds.
  for (let round = 0; round < 3 && /&(?:amp;)*lt;\/?[a-z][a-z0-9-]*(?:\s|&(?:amp;)*gt;|\/)/i.test(raw); round++) {
    raw = decodeEntities(raw);
  }
  return bodyTextOf(raw);
}

/**
 * The vacancy body of one JobPosting node: `description`, then every other
 * body property whose text `description` does not already contain.
 * Structured values (an `EducationalOccupationalCredential`, a `DefinedTerm`)
 * are enumerations, not prose, and stay out.
 *
 * @param {any} node
 * @returns {string}
 */
function jobPostingBodyText(node) {
  const parts = [];
  const identities = [];
  const add = (value) => {
    const text = structuredProseText(value);
    const identity = identityText(text);
    if (!text || !identity || identities.some((known) => known.includes(identity))) return;
    identities.push(identity);
    parts.push(text);
  };
  add(firstString(node?.description));
  for (const property of JOB_POSTING_BODY_PROPERTIES) {
    for (const value of proseValues(node?.[property])) add(value);
  }
  return parts.join('\n');
}

/**
 * @param {string} html
 * @param {string} pageUrl
 * @returns {Vacancy[]}
 */
export function extractJsonLd(html, pageUrl) {
  /** @type {Vacancy[]} */
  const out = [];
  const postingNodes = jsonLdBlocks(html).filter(isJobPostingNode);
  const urlLessPostingCount = postingNodes.filter((node) => !firstString(node.url) && !firstString(node.sameAs)).length;
  for (const node of postingNodes) {
    const locationCandidates = schemaJobLocationCandidates(node.jobLocation);
    const primaryLocation = locationCandidates[0] || { location: '', addressCountry: '' };
    const rawExplicitUrl = firstString(node.url) || firstString(node.sameAs);
    let explicitUrl = rawExplicitUrl;
    try { if (rawExplicitUrl) explicitUrl = new URL(rawExplicitUrl, pageUrl).toString(); } catch { /* retain raw evidence */ }
    // Some listing pages (notably Grischa Personal) publish many independent
    // JobPosting nodes inline but omit `url` from every node. Using the seed
    // URL for all of them makes the production Map collapse the whole page to
    // one vacancy. A deterministic fragment preserves the fetched source page
    // for transport while giving each distinct inline posting a stable
    // identity. Exact duplicate nodes still collapse by content fingerprint.
    const title = firstString(node.title) || firstString(node.name);
    const sourceUrl = !rawExplicitUrl && urlLessPostingCount > 1 ? pageUrl : undefined;
    let inlineIdentityUrl = pageUrl;
    if (sourceUrl) {
      const fingerprint = JSON.stringify(canonicalJsonLdIdentity(node));
      const digest = createHash('sha1').update(fingerprint).digest('hex').slice(0, 12);
      try {
        const identity = new URL(pageUrl);
        identity.hash = `job-${digest}`;
        inlineIdentityUrl = identity.toString();
      } catch {
        inlineIdentityUrl = `${pageUrl}#job-${digest}`;
      }
    }
    out.push({
      title,
      url: explicitUrl || inlineIdentityUrl,
      ...(sourceUrl ? { sourceUrl } : {}),
      urlExplicit: Boolean(rawExplicitUrl),
      company: firstString(node.hiringOrganization),
      location: primaryLocation.location || '',
      addressCountry: primaryLocation.addressCountry || '',
      locationCandidates,
      description: jobPostingBodyText(node).slice(0, 8000),
      postedDate: firstString(node.datePosted),
      employmentType: firstString(node.employmentType),
      via: 'jsonld',
    });
  }
  return out.filter((v) => v.title);
}

/** A shared floor for deciding whether a structured listing can skip detail. */
export function isSufficientVacancyDescription(value = '') {
  const description = textOf(value);
  return description.length >= 80 && description.split(/\s+/).filter(Boolean).length >= 12;
}

const identityText = (value = '') => textOf(value).toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function canonicalIdentityUrl(value = '') {
  try {
    const url = new URL(value);
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Select only structured records describing the current detail page. Sibling
 * JobPosting nodes are common in "recommended jobs" widgets and must never be
 * folded into the primary vacancy's geography.
 *
 * @param {Partial<Vacancy>[]} records
 * @param {string} pageUrl
 * @param {string} renderedTitle
 * @param {string} [recordUrl] inline identity URL from the listing row
 */
export function selectDetailStructuredRecords(records, pageUrl, renderedTitle, recordUrl = '') {
  // A URL-less listing row carries a deterministic `#job-…` fragment. The
  // detail request necessarily fetches the shared source page, so title-based
  // selection would merge every inline JobPosting into every row. Select the
  // one structured record carrying the requested fragment before applying the
  // ordinary URL/title compatibility rules. A complementary representation
  // from another format is safe only when it has the same title.
  let requestedHash = '';
  try { requestedHash = new URL(recordUrl).hash; } catch { /* no inline target */ }
  if (requestedHash.startsWith('#job-')) {
    const fragmentMatches = records.filter((record) => {
      try { return new URL(record.url).hash === requestedHash; } catch { return false; }
    });
    if (fragmentMatches.length === 1) {
      const [selected] = fragmentMatches;
      const selectedTitleIdentity = identityText(selected.title);
      const complementaryByFormat = new Map();
      for (const record of records) {
        if (record === selected
          || record.urlExplicit
          || record.via === selected.via
          || identityText(record.title) !== selectedTitleIdentity) continue;
        const matches = complementaryByFormat.get(record.via) || [];
        matches.push(record);
        complementaryByFormat.set(record.via, matches);
      }
      const complementary = [];
      for (const matches of complementaryByFormat.values()) {
        if (matches.length === 1) complementary.push(matches[0]);
      }
      return [selected, ...complementary];
    }
    // A fragment that no longer maps to exactly one source record is an
    // identity mismatch, not permission to fall back to page-wide evidence.
    return [];
  }
  if (records.length <= 1) return records;
  const pageIdentity = canonicalIdentityUrl(pageUrl);
  const explicitUrlMatches = records.filter(
    (record) => record.urlExplicit && canonicalIdentityUrl(record.url) === pageIdentity,
  );
  // An exact structured URL is stronger identity than a rendered heading: the
  // heading can belong to a recommendation widget or otherwise be stale. Keep
  // URL-less structured evidence only when its title independently agrees with
  // the exact record, and only as a unique complementary representation.
  if (explicitUrlMatches.length) {
    const exactTitleIdentities = new Set(explicitUrlMatches
      .map((record) => identityText(record.title))
      .filter(Boolean));
    if (exactTitleIdentities.size !== 1) return [];
    const [exactTitleIdentity] = exactTitleIdentities;
    const exactFormats = new Set(explicitUrlMatches.map((record) => record.via));
    const compatibleByFormat = new Map();
    for (const record of records) {
      if (record.urlExplicit
        || identityText(record.title) !== exactTitleIdentity
        || exactFormats.has(record.via)) continue;
      const matches = compatibleByFormat.get(record.via) || [];
      matches.push(record);
      compatibleByFormat.set(record.via, matches);
    }
    const complementary = [];
    for (const matches of compatibleByFormat.values()) {
      if (matches.length === 1) complementary.push(matches[0]);
    }
    return [...explicitUrlMatches, ...complementary];
  }
  const titleIdentity = identityText(renderedTitle);
  if (titleIdentity) {
    const titleMatches = records.filter((record) => identityText(record.title) === titleIdentity
      && (!record.urlExplicit || canonicalIdentityUrl(record.url) === pageIdentity));
    // This retains complementary URL-less microdata for the current JSON-LD
    // record while excluding explicitly different recommended-job URLs. Two
    // same-format URL-less records remain indistinguishable siblings even when
    // their titles happen to match, so fail closed instead of merging them.
    if (titleMatches.length === 1) return titleMatches;
    const titleMatchFormats = new Set(titleMatches.map((record) => record.via));
    if (titleMatches.length === 2
      && titleMatchFormats.has('jsonld')
      && titleMatchFormats.has('microdata')) return titleMatches;
    if (titleMatches.length > 1) return [];
  }
  // Multiple records with neither a current URL nor a matching rendered title
  // are indistinguishable siblings. Returning none is the only fail-closed
  // choice; callers may still use an independently valid listing location.
  return records.length === 1 ? records : [];
}

/**
 * Class vocabulary of a rendered vacancy body container. Vendor-neutral:
 * Fachkraft's `ff-detail-*`, SuccessFactors' `jobdescription`, eRecruiter's
 * `jobAdContent` are spellings of the same idea.
 */
const DETAIL_BODY_CLASS_VOCABULARY = /job[-_ ]?(?:description|details?|content|tasks?|profile|perspective)|job[-_ ]?ad[-_ ]?(?:content|text|body)|vacancy[-_ ]?(?:description|details?)|position[-_ ]?description|detail[-_ ]{1,2}text|detail[-_ ]?intro|description/i;

/** The same vocabulary minus the bare word `description`. */
const QUALIFIED_BODY_CLASS_VOCABULARY = /job[-_ ]?(?:description|details?|content|tasks?|profile|perspective)|job[-_ ]?ad[-_ ]?(?:content|text|body)|vacancy[-_ ]?(?:description|details?)|position[-_ ]?description|detail[-_ ]{1,2}text|detail[-_ ]?intro/i;

/**
 * Name parts of a UI component that carries its own `…description` caption.
 * The bare word `description` names a vacancy body only when nothing in the
 * same class token says it is the caption of something else: a picture
 * (`picture-description__slider`, the application-process carousel on
 * hornbach.ch), a slide (`process-slide__description`, abraxas.ch), a
 * definition-list term (`desfinition-list__description`), a button or a link
 * (`mobi-custom-link-button-description`). Those captions repeat on every
 * vacancy of the site, so reading them as the body measured one carousel
 * against every published job.
 */
const UI_COMPONENT_CLASS_PARTS = new Set([
  'picture', 'image', 'img', 'photo', 'media', 'video', 'gallery',
  'slide', 'slides', 'slider', 'carousel', 'swiper', 'slick',
  'process', 'step', 'steps', 'list', 'term', 'definition',
  'button', 'btn', 'link', 'card', 'teaser', 'tile', 'tooltip', 'modal', 'dialog',
  'category', 'icon', 'logo', 'component', 'blurb',
]);

/**
 * Whether a class attribute marks a vacancy body rather than a component
 * caption. A token qualified by the vacancy vocabulary (`job-description`,
 * `cmp-job-details__description`, `jobAdContent`) always counts; a token that
 * only says `description` counts unless it also names a UI component.
 *
 * @param {string} classValue
 * @returns {boolean}
 */
function isVacancyBodyClass(classValue = '') {
  let vocabularyTokens = 0;
  for (const token of String(classValue).split(/\s+/).filter(Boolean)) {
    if (!DETAIL_BODY_CLASS_VOCABULARY.test(token)) continue;
    vocabularyTokens++;
    if (QUALIFIED_BODY_CLASS_VOCABULARY.test(token)) return true;
    const parts = token.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().split(/[-_]+/);
    if (!parts.some((part) => UI_COMPONENT_CLASS_PARTS.has(part))) return true;
  }
  // The vocabulary can span two tokens (`class="job description"`): no single
  // token carries it, so there is no component caption to reject either.
  return vocabularyTokens === 0;
}

/**
 * Whether an element id names a vacancy body: an id with `description` as a
 * word of its own (`description__body`, `jobDescription`,
 * `job-description`) and no UI component name. Never the word inside another
 * one — the SAP cookie manager's `<div id="reqdescription">` («Ces cookies
 * sont obligatoires…») is not an ad — and not the `…details` spellings, which
 * ids use for the contact and metadata boxes around an ad (iPersonal's
 * `VacancyDetails`: «Schriftliche Bewerbung», address and phone).
 *
 * @param {string} id
 * @returns {boolean}
 */
function isVacancyBodyId(id = '') {
  const value = String(id || '').trim();
  if (!value || /\s/.test(value)) return false;
  const parts = value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().split(/[-_]+/).filter(Boolean);
  if (parts.some((part) => UI_COMPONENT_CLASS_PARTS.has(part))) return false;
  return parts.includes('description');
}

/**
 * @typedef {{ start: number, contentStart: number, contentEnd: number }} BodyRange
 */

/** Elements whose text is a form's option list or input, never vacancy prose. */
const FORM_CONTROL_TAGS = new Set(['select', 'datalist', 'textarea']);

/**
 * Share of the structured body's words the rendered text must repeat to be
 * read as the same text. Half is deliberately lenient: a rendered body
 * re-flows, re-punctuates and extends the structured one.
 */
const STRUCTURED_BODY_MIN_RECALL = 0.5;

/** Class tokens that hide an element at every breakpoint. */
const HIDDEN_CLASS_TOKENS = new Set(['hide', 'hidden', 'd-none', 'is-hidden']);

/**
 * A token that shows the element again at some breakpoint or container size:
 * `md:block`, `@md:flex` (Tailwind), `d-lg-flex` (Bootstrap), `visible-md`.
 */
const RESPONSIVE_SHOW_TOKEN_RX = /:(?:block|flex|grid|inline|inline-block|inline-flex|inline-grid|table|contents|flow-root)$|^d-(?:sm|md|lg|xl|xxl)-(?!none)|^visible-/;

/**
 * Whether an element is hidden from every reader: the boolean `hidden`
 * attribute, `aria-hidden="true"`, or a hiding class that no responsive class
 * undoes (`hidden md:block` is visible on desktop and stays).
 *
 * @param {string} raw opening tag
 * @returns {boolean}
 */
function isHiddenElement(raw = '') {
  if (/\shidden(?=[\s=/>])/i.test(String(raw).replace(/"[^"]*"|'[^']*'/g, '""'))) return true;
  if (readAttr(raw, 'aria-hidden').toLowerCase() === 'true') return true;
  const tokens = readAttr(raw, 'class').split(/\s+/).filter(Boolean);
  return tokens.some((token) => HIDDEN_CLASS_TOKENS.has(token))
    && !tokens.some((token) => RESPONSIVE_SHOW_TOKEN_RX.test(token));
}

/**
 * Whether an element's inline style hides it (`display: none`,
 * `visibility: hidden`). Used for vacancy-body CANDIDATES only: a container
 * that names itself a description but is not displayed is a form's help text
 * or a script-toggled message, not the rendered ad — InRecruiting (a-group)
 * ships `<div class="geolocation-description text-danger" style="display:
 * none">Select a data item from the drop-down list…</div>` in its application
 * form, 212 characters that won on a page whose ad has no such class. Inline
 * `display: none` also hides collapsed tabs and «read more» parts of real ads,
 * so it is NOT applied to the descendants of a displayed body.
 *
 * @param {string} raw opening tag
 * @returns {boolean}
 */
function isStyleHidden(raw = '') {
  const style = readAttr(raw, 'style').toLowerCase().replace(/\s+/g, '');
  return /(?:^|;)display:none(?:!important)?(?:;|$)/.test(style)
    || /(?:^|;)visibility:hidden(?:!important)?(?:;|$)/.test(style);
}

/**
 * id/class spelling of a block that lists OTHER postings: srg-ssr's
 * `<section id="similar-jobs">`, a `similar-jobs-slider`, `related-jobs`,
 * `job-recommendations`, `weitere-stellen`, `offres-similaires`.
 */
const RELATED_POSTINGS_NAME_RX = /(?:^|[-_ ])(?:similar|related|recommended|recommendations?|other|more|further|weitere|aehnliche|ähnliche|andere|autres|altre|simili|similaires|ulteriuras)[-_ ]?(?:jobs?|stellen(?:angebote)?|vacanc(?:y|ies)|positions?|openings?|offers?|offres|offerte|postings?|annunci|emplois|plazzas)(?:$|[-_ ])|(?:^|[-_ ])(?:jobs?|stellen|offres|emplois)[-_ ](?:similaires|simili|similar|related|recommendations?)(?:$|[-_ ])/i;

/**
 * Heading of a block that lists OTHER postings: kronenhof's
 * `<section class="entry …"><h2>Similar jobs</h2>` carries the complete
 * bodies of three more vacancies under that heading; srg-ssr's RTR pages
 * title it «Ulteriuras plazzas».
 */
const RELATED_POSTINGS_HEADING_RX = /^(?:similar|related|recommended|other|more|further)\s+(?:jobs?|positions?|vacancies|openings|offers)\b|^(?:you might also like|this might also interest you)\b|^(?:ähnliche|aehnliche|weitere|andere)\s+(?:jobs?|stellen(?:angebote)?|stellen\s?inserate|angebote)\b|^(?:offres|postes|emplois)\s+similaires\b|^(?:autres|d'autres)\s+(?:offres|postes|emplois)\b|^(?:offerte|posizioni|annunci)\s+simili\b|^altre\s+(?:offerte|posizioni|opportunità)\b|^ulteriuras\s+plazzas\b/i;

const RELATED_POSTINGS_CONTAINER_TAGS = new Set(['section', 'aside', 'div', 'ul', 'nav']);

/**
 * Whether an element is a block of OTHER postings (see the two spellings
 * above): never part of this vacancy's body. A block that carries this
 * vacancy's own title as a heading is not one, whatever it is called.
 *
 * @param {string} html
 * @param {{ name: string, raw: string, end: number }} opening
 * @param {{ contentEnd: number }} bounds
 * @param {string[]} titles
 * @returns {boolean}
 */
function isRelatedPostingsBlock(html, opening, bounds, titles) {
  if (!RELATED_POSTINGS_CONTAINER_TAGS.has(opening.name)) return false;
  const named = [readAttr(opening.raw, 'id'), ...readAttr(opening.raw, 'class').split(/\s+/)]
    .some((token) => token && RELATED_POSTINGS_NAME_RX.test(token));
  let headed = false;
  if (!named && opening.name !== 'ul') {
    const inner = html.slice(opening.end, Math.min(bounds.contentEnd, opening.end + 4000));
    const first = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/i.exec(inner);
    // The heading has to open the block, not sit deep inside a body.
    headed = Boolean(first) && textOf(inner.slice(0, first.index)).length < 200
      && RELATED_POSTINGS_HEADING_RX.test(textOf(first[2]));
  }
  if (!named && !headed) return false;
  const own = titles.map((title) => textOf(title).toLowerCase()).filter(Boolean);
  if (!own.length) return true;
  const content = html.slice(opening.end, bounds.contentEnd);
  for (const heading of content.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)) {
    if (own.includes(textOf(heading[1]).toLowerCase())) return false;
  }
  return true;
}

/**
 * Whether a listing row is identified by an inline `#job-…` fragment (see
 * `extractJsonLd`): the detail request then fetches a page shared by every
 * posting on it.
 *
 * @param {string} [recordUrl]
 * @returns {boolean}
 */
function isInlineRecordUrl(recordUrl = '') {
  try { return new URL(recordUrl).hash.startsWith('#job-'); } catch { return false; }
}

/** Words of 4+ letters, accent-folded, as the audit compares them. */
function comparableWords(value = '') {
  return new Set(textOf(decodeEntities(String(value || ''))).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4));
}

/**
 * Share of `reference` words that also appear in `candidate`.
 *
 * @param {string} reference
 * @param {string} candidate
 * @returns {number}
 */
function wordRecall(reference, candidate) {
  const wanted = comparableWords(reference);
  if (!wanted.size) return 1;
  const have = comparableWords(candidate);
  let hit = 0;
  for (const word of wanted) if (have.has(word)) hit++;
  return hit / wanted.size;
}

const TITLE_ELEMENT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * Whether a print-only region is this vacancy's own rendering: one of its
 * title elements (a heading, or an `itemprop="title"` element) reads exactly
 * as a vacancy title once normalized. Containing the title is not enough — a
 * sample ad for "Senior Engineer" printed on the page of an "Engineer"
 * vacancy contains "engineer" and is still another vacancy's text.
 *
 * @param {string} html
 * @param {HtmlTagIndex} index tag index of `html`
 * @param {number} from start of the region's content
 * @param {number} to end of the region's content
 * @param {string[]} titles candidate vacancy titles
 * @returns {boolean}
 */
function printRegionCarriesTitle(html, index, from, to, titles) {
  const wanted = new Set(titles.map((title) => identityText(title)).filter(Boolean));
  if (!wanted.size) return false;
  for (const opening of index.openings) {
    if (opening.index < from || opening.index >= to) continue;
    const isTitleElement = TITLE_ELEMENT_TAGS.has(opening.name)
      || readAttr(opening.raw, 'itemprop').split(/\s+/).includes('title');
    if (!isTitleElement) continue;
    const bounds = index.boundsByStart.get(opening.index);
    if (!bounds || bounds.contentEnd > to) continue;
    if (wanted.has(identityText(html.slice(opening.end, bounds.contentEnd)))) return true;
  }
  return false;
}

/**
 * A whole print-only rendering of the page (`<article id="printLayout"
 * class="print-page">`). Some SuccessFactors tenants print the real ad there;
 * others fill it client-side and ship a static sample ad in the meantime.
 * Only a print LAYOUT/PAGE/VERSION counts: `printColumn`, `printOnly` or a
 * `print` button are parts of an ordinary page (Spital Uster's body column
 * is `printColumn`).
 *
 * @param {string} raw opening tag
 * @returns {boolean}
 */
function isPrintLayout(raw = '') {
  return [readAttr(raw, 'id'), readAttr(raw, 'class')]
    .join(' ')
    .split(/\s+/)
    .some((token) => /^print[-_]?(?:layout|page|version|view|template)$/i.test(token));
}

/** Whether a start tag carries the boolean `itemscope` attribute. */
function hasItemscope(raw = '') {
  return /\sitemscope(?=[\s=/>])/i.test(String(raw).replace(/"[^"]*"|'[^']*'/g, '""'));
}

/**
 * Top-level `itemprop="description"` elements of a document, in document
 * order. SuccessFactors jobs2web splits one vacancy into several sibling
 * description spans (intro, body, closing), so all of them are the body.
 * When there are several, only those whose microdata scope is a JobPosting
 * count — an `Organization` nested in the posting, or one in the page chrome,
 * describes the employer, not the vacancy. A page with no such scope keeps
 * the single first element it was always read from.
 *
 * @param {string} html
 * @param {HtmlTagIndex} index
 * @returns {BodyRange[]}
 */
function vacancyDescriptionItempropRanges(html, index, { selectedTitle = null } = {}) {
  /** @type {BodyRange[]} */
  const all = [];
  let consumedUntil = 0;
  for (const opening of index.openings) {
    if (opening.index < consumedUntil || opening.selfClosing || VOID_HTML_TAGS.has(opening.name)) continue;
    if (!readAttr(opening.raw, 'itemprop').split(/\s+/).includes('description')) continue;
    const bounds = index.boundsByStart.get(opening.index);
    if (!bounds) continue;
    consumedUntil = bounds.end;
    // A hidden description element, and everything in it, is not the
    // rendered page.
    if (isHiddenElement(opening.raw)) continue;
    all.push({ start: opening.index, contentStart: opening.end, contentEnd: bounds.contentEnd });
  }
  if (!all.length) return all;
  const scopes = [];
  const itemscopes = [];
  for (const opening of index.openings) {
    if (!hasItemscope(opening.raw)) continue;
    const bounds = index.boundsByStart.get(opening.index);
    if (!bounds) continue;
    const scope = { start: opening.index, end: bounds.contentEnd, title: '' };
    itemscopes.push(scope);
    if (readAttr(opening.raw, 'itemtype').split(/\s+/).some((type) => /schema\.org\/JobPosting\/?$/i.test(type))) {
      scopes.push(scope);
    }
  }
  const inside = (range, scope) => range.start > scope.start && range.start < scope.end;
  const ownedBy = (range, scope) => inside(range, scope)
    && !itemscopes.some((inner) => inner.start > scope.start && inner.start < scope.end && inside(range, inner));
  // Sibling JobPostings on one page (a vacancy plus "similar jobs"): only the
  // posting the structured selection chose is this vacancy, and when none was
  // chosen the siblings are indistinguishable, so none of their descriptions
  // is read.
  if (scopes.length > 1 && selectedTitle !== null) {
    const wanted = identityText(selectedTitle);
    const selectedScopes = wanted
      ? scopes.filter((scope) => identityText(jobPostingScopeTitle(html, index, scope, itemscopes)) === wanted)
      : [];
    return all.filter((range) => selectedScopes.some((scope) => ownedBy(range, scope)));
  }
  if (all.length <= 1) return all;
  const owned = all.filter((range) => scopes.some((scope) => ownedBy(range, scope)));
  return owned.length ? owned : all.slice(0, 1);
}

/** Words a layout token needs to read as prose, not a field value. */
const JOB_LAYOUT_TOKEN_MIN_WORDS = 40;

/**
 * Body ranges of a SuccessFactors Career Site Builder (jobs2web) ad: the
 * prose `<span class="rtltextaligneligible">` of its `joblayouttoken` blocks.
 * The layout splits one posting into a token per field — title, percentages,
 * workplace, dates, salary, the vacancy text, the contact card — and marks
 * only some of them `itemprop="description"`: on PostFinance and Mobiliar the
 * only one is the recruiter's contact card (419 and 398 characters, with
 * unresolved `[[cust_…]]` placeholders), while the vacancy text (1 431 and
 * 3 600 characters) sits in a token without it. Field tokens are a few words
 * each, so the prose floor keeps them out; the itemprop tokens are read as
 * before and a token read twice is deduplicated by its range.
 *
 * @param {string} html
 * @param {HtmlTagIndex} index
 * @returns {BodyRange[]}
 */
function jobLayoutTokenBodyRanges(html, index) {
  /** @type {BodyRange[]} */
  const ranges = [];
  const tokens = [];
  for (const opening of index.openings) {
    if (opening.name !== 'div' || !/\bjoblayouttoken\b/.test(readAttr(opening.raw, 'class'))) continue;
    const bounds = index.boundsByStart.get(opening.index);
    if (bounds && !isHiddenElement(opening.raw)) tokens.push({ start: opening.index, end: bounds.contentEnd });
  }
  if (!tokens.length) return ranges;
  let consumedUntil = 0;
  for (const opening of index.openings) {
    if (opening.index < consumedUntil || opening.name !== 'span') continue;
    if (!readAttr(opening.raw, 'class').split(/\s+/).includes('rtltextaligneligible')) continue;
    if (!tokens.some((token) => opening.index > token.start && opening.index < token.end)) continue;
    const bounds = index.boundsByStart.get(opening.index);
    if (!bounds) continue;
    consumedUntil = bounds.end;
    if (isHiddenElement(opening.raw)) continue;
    const text = textOf(html.slice(opening.end, bounds.contentEnd));
    if (text.split(/\s+/).filter((word) => /\p{L}{2,}/u.test(word)).length < JOB_LAYOUT_TOKEN_MIN_WORDS) continue;
    ranges.push({ start: opening.index, contentStart: opening.end, contentEnd: bounds.contentEnd });
  }
  return ranges;
}

/**
 * Body ranges of a BrassRing (Kenexa) job detail page: the answers of its
 * `jobDetailTextArea` question/answer pairs («Your role», «Your team», «Your
 * expertise», «About us»…), server-rendered as `<p class="… jobDetailTextArea
 * answer">`. The rest of the page is an Angular application whose templates
 * (`{{LimitExceededMessage}}`, «You have already applied for this job»…) are
 * static text too: on UBS's `HomeWithPreLoad?…&jobid=…` pages they were read
 * as an 8 000-character «body» around a 1 200-character ad.
 *
 * @param {HtmlTagIndex} index
 * @returns {BodyRange[]}
 */
function jobDetailAnswerRanges(index) {
  /** @type {BodyRange[]} */
  const ranges = [];
  for (const opening of index.openings) {
    if (opening.name !== 'p') continue;
    const classes = readAttr(opening.raw, 'class').split(/\s+/);
    if (!classes.includes('jobDetailTextArea') || !classes.includes('answer')) continue;
    const bounds = index.boundsByStart.get(opening.index);
    if (!bounds || isHiddenElement(opening.raw)) continue;
    ranges.push({ start: opening.index, contentStart: opening.end, contentEnd: bounds.contentEnd });
  }
  return ranges;
}

/**
 * The `title` (or `name`) a JobPosting microdata scope states for itself,
 * ignoring properties of items nested in it.
 *
 * @param {string} html
 * @param {HtmlTagIndex} index
 * @param {{ start: number, end: number }} scope
 * @param {Array<{ start: number, end: number }>} itemscopes
 * @returns {string}
 */
function jobPostingScopeTitle(html, index, scope, itemscopes) {
  for (const property of ['title', 'name']) {
    const opening = index.openings.find((candidate) => candidate.index > scope.start
      && candidate.index < scope.end
      && readAttr(candidate.raw, 'itemprop').split(/\s+/).includes(property)
      && !itemscopes.some((inner) => inner.start > scope.start && inner.start < scope.end
        && candidate.index > inner.start && candidate.index < inner.end));
    if (!opening) continue;
    const content = readAttr(opening.raw, 'content');
    if (content) return content;
    const bounds = index.boundsByStart.get(opening.index);
    if (bounds) return textOf(html.slice(opening.end, bounds.contentEnd));
  }
  return '';
}

/**
 * Text of the vacancy body ranges, each counted once. Candidate containers
 * nest (`jobcontent` ⊃ `jobcontent_left` ⊃ `description`, five Marriott
 * wrappers of one body): only the outermost one of each chain is read, so the
 * joined candidate is the body, not the body four times over. Chrome ranges
 * inside a kept container are cut out of its text, and a container whose text
 * repeats an earlier one (the desktop and mobile copies of one SuccessFactors
 * layout) is read once.
 *
 * @param {string} html
 * @param {BodyRange[]} bodyRanges
 * @param {Array<{start: number, end: number}>} [chromeRanges]
 * @returns {string[]} texts in document order
 */
function distinctBodyTexts(html, bodyRanges, chromeRanges = []) {
  const ordered = [...bodyRanges].sort((a, b) => a.start - b.start || b.contentEnd - a.contentEnd);
  /** @type {BodyRange[]} */
  const outermost = [];
  for (const range of ordered) {
    if (outermost.some((outer) => range.start >= outer.start && range.start < outer.contentEnd)) continue;
    outermost.push(range);
  }
  const cuts = [...chromeRanges].sort((a, b) => a.start - b.start);
  const texts = [];
  const seen = new Set();
  for (const range of outermost) {
    // A candidate that sits inside chrome is chrome: the `description`
    // teasers of a «similar jobs» slider, a body inside a hidden block.
    if (cuts.some((cut) => range.start >= cut.start && range.contentEnd <= cut.end)) continue;
    let cursor = range.contentStart;
    let raw = '';
    for (const cut of cuts) {
      if (cut.start < range.contentStart || cut.start >= range.contentEnd || cut.end <= cursor) continue;
      raw += `${html.slice(cursor, cut.start)} `;
      cursor = Math.max(cursor, cut.end);
    }
    raw += html.slice(cursor, range.contentEnd);
    const text = bodyTextOf(raw);
    const key = text.replace(/\s+/g, ' ').toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    texts.push(text);
  }
  return texts;
}

/**
 * Read authoritative fields from a vacancy detail page. JSON-LD often contains
 * only a teaser; the rendered detail body is therefore preferred when it is
 * richer than the structured description.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @param {{ recordUrl?: string }} [opts]
 * @returns {{
 *   title: string,
 *   company: string,
 *   location: string,
 *   addressCountry: string,
 *   locationCandidates: Array<{
 *     location: string,
 *     addressCountry: string,
 *     addressLocality?: string,
 *     addressRegion?: string,
 *     postalCode?: string,
 *     streetAddress?: string,
 *   }>,
 *   authoritativeLocationConflict: boolean,
 *   workplaceLabels: string[],
 *   description: string,
 *   postedDate: string,
 *   employmentType: string,
 *   hasStructuredVacancy: boolean,
 * }}
 */
export function extractDetailFields(html = '', pageUrl = '', opts = {}) {
  // A detail page can expose JSON-LD and microdata simultaneously, sometimes
  // with complementary or conflicting locations. Preserve every candidate so
  // authoritative foreign evidence cannot disappear merely because the other
  // format (or rendered text) names a Swiss homonym.
  const allStructuredRecords = /** @type {Partial<Vacancy>[]} */ ([
    ...extractJsonLd(html, pageUrl),
    ...extractMicrodata(html, pageUrl),
  ]);
  const renderedTitle = textOf(/<h1\b[^>]*>([\s\S]{0,1000}?)<\/h1>/i.exec(html)?.[1] || '');
  const structuredRecords = selectDetailStructuredRecords(
    allStructuredRecords,
    pageUrl,
    renderedTitle,
    opts.recordUrl,
  );
  const ambiguousStructuredSiblings = allStructuredRecords.length > 1 && !structuredRecords.length;
  const structured = structuredRecords[0] || {};
  // The first H1 can be the employer or brand while the selected JobPosting
  // carries the vacancy title. Prefer the page-scoped structured record and
  // use the rendered heading only when no structured title is available.
  const title = structured.title || renderedTitle || '';
  const renderedLocation = ambiguousStructuredSiblings ? '' : textOf(
    /<(?:div|span|p|li)[^>]*(?:class|itemprop)\s*=\s*["'][^"']*(?:job[-_ ]?region|job[-_ ]?location|location|addressLocality)[^"']*["'][^>]*>([\s\S]{0,500}?)<\//i.exec(html)?.[1] || '',
  );
  const locationCandidates = [];
  const locationCandidateKeys = new Set();
  for (const record of structuredRecords) {
    const candidates = Array.isArray(record.locationCandidates)
      ? record.locationCandidates
      : (record.location || record.addressCountry
        ? [{ location: record.location || '', addressCountry: record.addressCountry || '' }]
        : []);
    for (const candidate of candidates) {
      const key = JSON.stringify(candidate);
      if (locationCandidateKeys.has(key)) continue;
      locationCandidateKeys.add(key);
      locationCandidates.push(candidate);
    }
  }
  if (!locationCandidates.length && renderedLocation) {
    locationCandidates.push({ location: renderedLocation, addressCountry: '' });
  }
  // Last resort: the vacancy address rendered as a postal block. arsante.ch
  // (gmo) publishes a JobPosting with title/description/datePosted and no
  // jobLocation at all, while every detail page carries the workplace as
  // `<div class="contact-info">… <p>1201 Genève</p>`. No class name in the
  // cascade above spells "location", so the row lost its only geography
  // evidence and the source-backed gate dropped all 10 vacancies — the crawler
  // reported 0 jobs from a perfectly healthy page (#7322). The candidate stays
  // evidence, not a default: `resolveSourceBackedSwissGeography` still has to
  // recognise the municipality, and the employer address in header/footer/nav
  // is out of scope by construction so an HQ cannot stand in for a workplace.
  if (!locationCandidates.length && !ambiguousStructuredSiblings) {
    for (const candidate of renderedPostalAddressCandidates(html, title)) locationCandidates.push(candidate);
  }
  const primaryLocation = /** @type {any} */ (locationCandidates[0] || {});
  const company = structuredRecords.find((record) => record.company)?.company || '';
  const structuredLocationClasses = structuredRecords.map((record) => {
    const decisions = locationEvidenceCandidates(record)
      .map((candidate) => evaluateSourceBackedSwissGeography([candidate]));
    return {
      swiss: decisions.some((decision) => Boolean(decision.geography)),
      foreign: decisions.some((decision) => decision.explicitlyForeign),
    };
  });
  // A single JobPosting may legitimately advertise multiple locations. A
  // conflict across separate JSON-LD/microdata representations of the current
  // job is different: do not let a Swiss secondary representation erase an
  // authoritative foreign primary one.
  const authoritativeLocationConflict = structuredRecords.length > 1
    && structuredLocationClasses.some((entry) => entry.swiss)
    && structuredLocationClasses.some((entry) => entry.foreign);
  const location = primaryLocation.location || structured.location || renderedLocation;
  /** @type {BodyRange[]} */
  const bodyRanges = [];
  /** @type {Array<{start: number, end: number}>} */
  const chromeRanges = [];
  // Extract balanced containers so nested lists/divs do not truncate the
  // vacancy at the first inner closing tag. The vocabulary is vendor-neutral;
  // Fachkraft's ff-detail-* classes are just one supported spelling.
  // The vocabulary names the body in a class or, as often, in an id
  // (InRecruiting's `<div id="description__body">` inside
  // `class="card-body vacancy__sections"`, next to an application form that
  // is three times longer than the ad).
  const openingRx = new RegExp(
    `<(div|section|article)\\b([^>]*(?:\\bclass|\\sid)\\s*=\\s*["'][^"']*(?:${DETAIL_BODY_CLASS_VOCABULARY.source})[^"']*["'][^>]*)>`,
    'gi',
  );
  // Markup quoted inside a script is not rendered: Marriott's JSON-LD string
  // `"description":"<div class='description'>…"` is the structured record,
  // already read as such, not a second rendered body, and a client-side
  // template is not the page either. `textOf` drops scripts for the same
  // reason; a container that merely STARTS inside one escaped it.
  const scriptRanges = [...html.matchAll(/<script\b[\s\S]*?<\/script>/gi)]
    .map((script) => ({ start: script.index, end: script.index + script[0].length }));
  let match;
  while ((match = openingRx.exec(html))) {
    const at = match.index;
    if (scriptRanges.some((script) => at > script.start && at < script.end)) continue;
    const detailClassAttr = match[2];
    const tag = match[1];
    const tags = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
    tags.lastIndex = openingRx.lastIndex;
    let depth = 1;
    let end;
    let detailTagMatch;
    while ((detailTagMatch = tags.exec(html))) {
      if (new RegExp(`^<\\/${tag}\\b`, 'i').test(detailTagMatch[0])) depth--;
      else if (!/\/\\s*>$/.test(detailTagMatch[0])) depth++;
      if (depth === 0) { end = detailTagMatch.index; break; }
    }
    if (end === undefined) continue;
    // A consent banner, a meta line, or a UI component whose own caption is
    // spelled `…description` (a picture/slide/list-term/button caption) is
    // page chrome. It is not a candidate, and its text is cut out of any
    // vacancy container that happens to wrap it.
    // A hidden candidate (`class="job-description hidden"`) is not the
    // rendered page either.
    const classValue = readAttr(match[0], 'class');
    const classNamed = DETAIL_BODY_CLASS_VOCABULARY.test(classValue);
    const idNamed = isVacancyBodyId(readAttr(match[0], 'id'));
    // An id spelling that names no body (`VacancyDetails`) makes the element
    // neither a candidate nor chrome: it is read, or cut, as before.
    if (!classNamed && !idNamed) continue;
    if (/\b(?:cookie|cmplz|consent|meta)\b/i.test(detailClassAttr)
      || (!idNamed && !isVacancyBodyClass(classValue))
      || isHiddenElement(match[0])
      || isStyleHidden(match[0])) {
      chromeRanges.push({ start: match.index, end });
      continue;
    }
    bodyRanges.push({ start: match.index, contentStart: openingRx.lastIndex, contentEnd: end });
  }
  // Read every description element to its matching close tag. SuccessFactors
  // nests many same-name spans inside itemprop="description" (the former
  // non-greedy regex stopped at the first inner </span>), and its jobs2web
  // layout splits ONE vacancy into several sibling itemprop="description"
  // spans — intro, body, closing — so reading only the first one measured a
  // teaser against a complete published body.
  const semanticIndex = indexHtmlTags(html);
  const selectedTitle = structuredRecords.length ? (structured.title || '') : '';
  const itempropRanges = vacancyDescriptionItempropRanges(html, semanticIndex, { selectedTitle });
  for (const range of itempropRanges) bodyRanges.push(range);
  for (const range of jobLayoutTokenBodyRanges(html, semanticIndex)) {
    if (!bodyRanges.some((known) => known.start === range.start)) bodyRanges.push(range);
  }
  // BrassRing's question/answer pairs are the whole ad; the containers its
  // Angular templates share a vocabulary with (`jobDetails…`) are not.
  const answerRanges = jobDetailAnswerRanges(semanticIndex);
  if (answerRanges.length) bodyRanges.splice(0, bodyRanges.length, ...answerRanges);
  // Form controls are never vacancy prose: an application form embedded in
  // the body (Jobalino ships one as a nested document) carries a nationality
  // select of ~250 country names that outweighed the vacancy itself.
  // Hidden elements are not the rendered page either: Phenom ships every
  // vacancy with a `hide job-expired-view` block saying the job "has been
  // filled", shown only once it really is.
  // A block listing OTHER postings («Similar jobs», `#similar-jobs`) carries
  // their titles and often their whole bodies (kronenhof: three complete ads
  // under the one being read); it is never this vacancy's text.
  // A print-only rendering whose title element does not read exactly as this
  // vacancy's title is another ad (job.post.ch serves the same sample in
  // `printLayout` on every page), wherever it sits — also inside the <main>
  // the fallback reads.
  const titles = [title, renderedTitle];
  for (const opening of semanticIndex.openings) {
    if (opening.selfClosing || VOID_HTML_TAGS.has(opening.name)) continue;
    const bounds = semanticIndex.boundsByStart.get(opening.index);
    if (!bounds) continue;
    const isChrome = FORM_CONTROL_TAGS.has(opening.name)
      || isHiddenElement(opening.raw)
      || (isPrintLayout(opening.raw)
        && !printRegionCarriesTitle(html, semanticIndex, opening.end, bounds.contentEnd, titles))
      || isRelatedPostingsBlock(html, opening, bounds, titles);
    if (isChrome) chromeRanges.push({ start: opening.index, end: bounds.end });
  }
  let blocks = distinctBodyTexts(html, bodyRanges, chromeRanges);
  // A detail page with no useful class still commonly puts the vacancy body
  // in its main/article container. Use it only when it is materially larger
  // than the page's structured teaser, avoiding a navigation-only shell.
  // Chrome recognised above is cut out of it too: without the cut, rejecting
  // a carousel as a candidate would hand the whole <main> — the same carousel
  // included — to this fallback. When no container carries the title (it
  // sits above them), every top-level container is read, not only the first:
  // the See-Spital ad is seven sibling <article> sections. A print-only
  // rendering counts only when it is this vacancy's: jobs.fr.ch prints the
  // real ad there, while job.post.ch fills its `printLayout` article
  // client-side and serves the same 2240-character sample ad (another
  // vacancy) in it on every page.
  const main = vacancyContainerRegion(html, title);
  if (!blocks.length && main) {
    const isThisVacancy = (region) => !isPrintLayout(region.raw)
      || printRegionCarriesTitle(html, semanticIndex, region.start, region.end, titles);
    const regions = (main.owned ? [main] : main.outermost).filter(isThisVacancy);
    const mainText = distinctBodyTexts(
      html,
      regions.map((region) => ({ start: region.start, contentStart: region.start, contentEnd: region.end })),
      chromeRanges,
    ).join('\n');
    if (mainText) blocks.push(mainText);
  }
  const structuredDescriptions = structuredRecords.map((record) => record.description || '');
  const [structuredBody = ''] = [...structuredDescriptions].sort((a, b) => b.length - a.length);
  // A row identified by an inline `#job-…` fragment lives on a page that
  // lists many vacancies: its rendered text is every posting at once, and only
  // the selected structured record is this one.
  if (isInlineRecordUrl(opts.recordUrl) && structuredBody) blocks = [];
  // Rendered text that repeats almost none of a sufficient structured body is
  // not the same text: either it is something else (a branding banner, a
  // generic careers block) or it holds the part of the ad the structured data
  // leaves out (a benefits grid next to a JSON-LD intro). Neither may win on
  // length alone, and neither may be thrown away, so the two are read
  // together.
  // A rendered block the structured body already says is not added twice.
  const complementary = blocks.length > 0
    && isSufficientVacancyDescription(structuredBody)
    && wordRecall(structuredBody, blocks.join(' ')) < STRUCTURED_BODY_MIN_RECALL
    ? [...blocks.filter((block) => wordRecall(block, structuredBody) < STRUCTURED_BODY_MIN_RECALL), structuredBody]
    : [];
  const descriptions = [
    ...blocks,
    blocks.length > 1 ? blocks.join('\n') : '',
    complementary.join('\n'),
    ...structuredDescriptions,
  ].filter(Boolean);
  descriptions.sort((a, b) => b.length - a.length);
  return {
    title,
    company,
    location,
    addressCountry: primaryLocation.addressCountry || structured.addressCountry || '',
    locationCandidates,
    authoritativeLocationConflict,
    description: descriptions[0] || '',
    workplaceLabels: renderedWorkplaceLabelValues(html, title),
    postedDate: structuredRecords.find((record) => record.postedDate)?.postedDate || '',
    employmentType: structuredRecords.find((record) => record.employmentType)?.employmentType || '',
    // Whether THIS response carried a structured vacancy at all. Both readers
    // above gate on the JobPosting type (`isJobPostingNode`, the
    // `schema.org/JobPosting` itemtype), so an empty `allStructuredRecords`
    // means the page served none. Measured shapes behind that: one Ticino bank
    // publishes `WebPage`, `ImageObject`, `BreadcrumbList`, `WebSite` and
    // `Organization` and no vacancy node at all; `galenica` only `WebPage`;
    // `triaplus` an empty array. A source with nothing to read
    // cannot be read wrong, and the audit needs to tell that apart from a
    // parser that failed to read what WAS there. Computed per fetch and never
    // a per-crawler allowlist: 4 of 21 sampled crawlers flip between runs, so a
    // hand-written list would silence a real mismatch for good.
    hasStructuredVacancy: allStructuredRecords.length > 0,
  };
}

/**
 * Rendered field labels that introduce the vacancy's workplace, in the three
 * national languages. This is a LABEL vocabulary, not the CSS-class one of
 * {@link ADDRESS_BLOCK_CLASS_RX}: `jobs.admin.ch` writes the workplace as
 * `<label>Arbeitsort:</label><span>Reckenholzstrasse 191, 8046 Zürich</span>`,
 * a node pair no class name marks and no structured record carries.
 */
const WORKPLACE_LABEL_RX = /^(?:arbeitsorte?|lieux? de travail|luog(?:o|hi) di lavoro)\s*:?\s*/i;

/** A workplace is an address, not a paragraph: longer values are prose. */
const MAX_WORKPLACE_LABEL_VALUE = 120;

/**
 * Values of a labelled workplace field rendered in the vacancy body, in
 * document order. The federal portal states the real workplace only there —
 * its JobPosting JSON-LD carries the publishing office's seat (Wädenswil) for
 * an Agroscope vacancy worked at `Reckenholzstrasse 191, 8046 Zürich` — so
 * without this the page corroborates nothing and the audit reads a parser
 * defect where the source merely disagrees with itself (#7711).
 *
 * The bare label is never a value: `Arbeitsort:` with nothing after it, or
 * followed by another label, yields nothing and the caller keeps its finding.
 *
 * @param {string} html
 * @param {string} [title] vacancy title, to pick its own content region
 * @returns {string[]}
 */
export function renderedWorkplaceLabelValues(html = '', title = '') {
  const segments = vacancyContentRegion(html, title)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .split(/<[^>]*>/)
    .map((part) => textOf(part))
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < segments.length; i++) {
    if (!WORKPLACE_LABEL_RX.test(segments[i])) continue;
    // `Arbeitsort: <value>` in one text node, or the label alone with the
    // value in the next one (the `<label>`/`<span>` pair the portal renders).
    const inline = segments[i].replace(WORKPLACE_LABEL_RX, '').trim();
    const value = inline || (segments[i + 1] || '').trim();
    if (!value || value.length > MAX_WORKPLACE_LABEL_VALUE) continue;
    if (WORKPLACE_LABEL_RX.test(value) || value.endsWith(':')) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Class names that mark a rendered address block. Vendor-neutral: arsante.ch
 * spells it `contact-info`, other sites `standort` / `lieu-de-travail` /
 * `job-address`. A bare `<address>` element counts by its own semantics.
 */
const ADDRESS_BLOCK_CLASS_RX = /(?:^|[\s_-])(?:contact|address|adresse|indirizzo|standort|arbeitsort|workplace|lieu|luogo|sede|ort)(?:$|[\s_-])/i;

/**
 * `1201 Genève`, `CH-8003 Zürich`: a Swiss postal code immediately followed by
 * a capitalised municipality. The postal code is what makes the pair an
 * address rather than a sentence, so it is required, never inferred.
 */
const SWISS_POSTAL_ADDRESS_RX = /(?:^|[\s,;(])(?:CH[\s-]?)?(\d{4})\s+(\p{Lu}[\p{L}'\u2019.-]*(?:[ -]\p{L}[\p{L}'\u2019.-]*){0,3})/gu;

/**
 * The main/article container that holds THIS vacancy — its content and its
 * content offsets in `html` — or null when the page has none. The title is
 * what identifies it: a detail page routinely carries more than one such
 * container — a related-positions block rendered as a second `<article>`, or
 * a list of other openings inside the same `<main>` — and taking the first
 * one in document order reads another vacancy's body.
 * That is worse than reading nothing: the workplace corroborated from the
 * wrong ad silences the mismatch exactly where the published seat is really
 * wrong, and the job page stays indexed with the wrong `jobLocation` (#7772).
 *
 * Among the containers that do carry the title, only NESTING breaks the tie:
 * when a `<main>` wraps both the vacancy `<article>` and a related-jobs one,
 * both contain the title and only the inner one excludes the neighbours. Two
 * SIBLINGS instead keep document order, because the match is a substring one:
 * a teaser whose own title is a superset (`Pflegefachfrau` in a card for
 * `Pflegefachfrau HF 80%`) also `includes()` the title and, being a card, is
 * shorter than the real vacancy — picking the shortest would hand the
 * workplace to the neighbouring ad, the very defect this selection closes.
 *
 * @param {string} html
 * @param {string} [title] vacancy title as rendered/structured on the page
 * @returns {{
 *   raw: string, start: number, end: number, content: string,
 *   owned: boolean,
 *   outermost: Array<{ raw: string, start: number, end: number, content: string }>,
 * } | null}
 */
function vacancyContainerRegion(html = '', title = '') {
  const source = String(html);
  const index = indexHtmlTags(source);
  const regions = [];
  // Print-only renderings of another vacancy, and every container inside them.
  const foreignPrint = [];
  for (const opening of index.openings) {
    if (opening.name !== 'main' && opening.name !== 'article') continue;
    if (opening.selfClosing) continue;
    const bounds = index.boundsByStart.get(opening.index);
    if (!bounds) continue;
    if (foreignPrint.some((range) => opening.index >= range.start && opening.index < range.end)) continue;
    // A print-only rendering is a container of THIS vacancy only when its
    // title element reads exactly as the title: a "Senior Engineer" sample
    // printed on an "Engineer" page contains the title and would otherwise
    // be chosen as the vacancy's own container.
    if (isPrintLayout(opening.raw)
      && !printRegionCarriesTitle(source, index, opening.end, bounds.contentEnd, [title])) {
      foreignPrint.push({ start: opening.index, end: bounds.end });
      continue;
    }
    regions.push({
      raw: opening.raw,
      start: opening.end,
      end: bounds.contentEnd,
      content: source.slice(opening.end, bounds.contentEnd),
    });
  }
  const wanted = textOf(title).toLowerCase();
  const owning = wanted
    ? regions.filter((region) => textOf(region.content).toLowerCase().includes(wanted))
    : [];
  // Document order first (`index.openings` is scan order), then descend the
  // nesting chain of that first owner: a region that starts after it and ends
  // within it is an ancestor's child, a region that ends outside it is a
  // sibling and never displaces it.
  let chosen = owning[0];
  for (const region of owning) {
    if (chosen && region.start > chosen.start && region.end <= chosen.end) chosen = region;
  }
  const picked = chosen ?? regions[0];
  if (!picked) return null;
  // The containers no other container wraps, for a caller that has to read a
  // vacancy split across sibling <article> sections when none of them carries
  // the title (the heading sits above them).
  const outermost = regions.filter((region) => !regions.some((other) => other !== region
    && other.start <= region.start && region.end <= other.end && (other.start < region.start || other.end > region.end)));
  return { ...picked, owned: Boolean(chosen), outermost };
}

/**
 * Content of the main/article container that holds THIS vacancy, or '' when
 * the page has none. See {@link vacancyContainerRegion}.
 *
 * @param {string} html
 * @param {string} [title]
 * @returns {string}
 */
function vacancyContainerContent(html = '', title = '') {
  return vacancyContainerRegion(html, title)?.content ?? '';
}

/**
 * The part of a detail page that describes the vacancy. The employer's own
 * address lives in the site chrome (arsante.ch repeats `CH-1213 Petit-Lancy`
 * in every page footer); reading it as the workplace would publish one
 * fabricated employer default for every vacancy, which is exactly what the
 * source-backed gate exists to prevent.
 *
 * @param {string} html
 * @param {string} [title]
 * @returns {string}
 */
function vacancyContentRegion(html = '', title = '') {
  return (vacancyContainerContent(html, title) || String(html))
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header\b[\s\S]*?<\/header>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ');
}

/**
 * Location evidence read from a rendered postal address inside the vacancy
 * body, in document order. Returns [] when the page carries none — an empty
 * result must stay empty so the caller keeps dropping the row.
 *
 * @param {string} html
 * @param {string} [title] vacancy title, to pick its own content region
 * @returns {Array<{location: string, addressCountry: string, addressLocality: string, postalCode: string}>}
 */
export function renderedPostalAddressCandidates(html = '', title = '') {
  const scope = vacancyContentRegion(html, title);
  const index = indexHtmlTags(scope);
  const containers = readAttributeContainers(
    scope,
    'class',
    (value) => ADDRESS_BLOCK_CLASS_RX.test(value),
    index,
  );
  for (const opening of index.openings) {
    if (opening.name !== 'address') continue;
    const bounds = index.boundsByStart.get(opening.index);
    if (bounds) containers.push(scope.slice(opening.index, bounds.end));
  }
  const out = [];
  const seen = new Set();
  // Match inside a single text node: flattening the container first glues
  // `<p>1201 Genève</p><p>Postuler</p>` into one string and the municipality
  // swallows the words that follow it.
  for (const container of containers) {
    for (const node of container.split(/<[^>]*>/).map((part) => textOf(part))) {
      for (const match of node.matchAll(SWISS_POSTAL_ADDRESS_RX)) {
        const postalCode = match[1];
        const addressLocality = match[2].replace(/\s+/g, ' ').trim();
        const location = `${postalCode} ${addressLocality}`;
        const key = location.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        // No addressCountry: the country is not written on the page, and the
        // canton has to come from recognising the municipality, not from us.
        out.push({ location, addressCountry: '', addressLocality, postalCode });
      }
    }
  }
  return out;
}

/**
 * @typedef {{
 *   raw: string,
 *   name: string,
 *   index: number,
 *   end: number,
 *   closing: boolean,
 *   selfClosing: boolean,
 * }} HtmlTag
 * @typedef {{
 *   openings: HtmlTag[],
 *   boundsByStart: Map<number, {contentEnd: number, end: number}>,
 *   tagCount: number,
 * }} HtmlTagIndex
 */
const VOID_HTML_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr',
]);

/** @param {string} block @returns {HtmlTagIndex} */
function indexHtmlTags(block) {
  const tags = scanHtmlTags(block);
  /** @type {HtmlTag[]} */
  const openings = [];
  /** @type {Map<string, HtmlTag[]>} */
  const pendingByName = new Map();
  /** @type {Map<number, {contentEnd: number, end: number}>} */
  const boundsByStart = new Map();
  for (const tag of tags) {
    if (!tag.closing) {
      openings.push(tag);
      if (!tag.selfClosing && !VOID_HTML_TAGS.has(tag.name)) {
        if (!pendingByName.has(tag.name)) pendingByName.set(tag.name, []);
        pendingByName.get(tag.name).push(tag);
      }
      continue;
    }
    const pending = pendingByName.get(tag.name);
    const opening = pending?.pop();
    if (opening) {
      boundsByStart.set(opening.index, { contentEnd: tag.index, end: tag.end });
    }
  }
  return { openings, boundsByStart, tagCount: tags.length };
}

/**
 * Text of an `itemprop` element that has no `content` attribute — i.e. the
 * value lives in the element's rendered body, not a meta-style attribute.
 * Matching to the itemprop element's own balanced closing tag reads the whole
 * subtree regardless of how deep the rendered value sits.
 *
 * @param {string} block
 * @param {HtmlTag} opening
 * @param {HtmlTagIndex} index
 * @returns {string}
 */
function readItempropBody(block, opening, index) {
  const bounds = index.boundsByStart.get(opening.index);
  const contentEnd = bounds?.contentEnd ?? Math.min(block.length, opening.end + 2000);
  return textOf(block.slice(opening.end, contentEnd));
}

/**
 * Return balanced element containers selected by one attribute. The same
 * scanner protects both the outer JobPosting and its jobLocation subtrees
 * from premature closure on nested elements with the same tag name.
 *
 * @param {string} block
 * @param {string} attribute
 * @param {(value: string) => boolean} matches
 * @param {HtmlTagIndex} index
 * @returns {string[]}
 */
function readAttributeContainers(block, attribute, matches, index) {
  const containers = [];
  let consumedUntil = 0;
  for (const opening of index.openings) {
    if (opening.index < consumedUntil || !matches(readAttr(opening.raw, attribute))) continue;
    if (opening.selfClosing || VOID_HTML_TAGS.has(opening.name)) {
      containers.push(opening.raw);
      continue;
    }
    const bounds = index.boundsByStart.get(opening.index);
    if (!bounds) continue;
    containers.push(block.slice(opening.index, bounds.end));
    consumedUntil = bounds.end;
  }
  return containers;
}

function readItempropContainers(block, property, index) {
  return readAttributeContainers(
    block,
    'itemprop',
    (value) => value.split(/\s+/).filter(Boolean).includes(property),
    index,
  );
}

/**
 * @param {string} html
 * @param {string} pageUrl
 * @param {{onIndex?: (metrics: {sourceLength: number, tagCount: number}) => void}} [diagnostics]
 * @returns {Vacancy[]}
 */
export function extractMicrodata(html, pageUrl, diagnostics = {}) {
  /** @type {Vacancy[]} */
  const out = [];
  /** @type {Map<string, HtmlTagIndex>} */
  const indexCache = new Map();
  /** @param {string} source @returns {HtmlTagIndex} */
  const indexFor = (source) => {
    let index = indexCache.get(source);
    if (!index) {
      index = indexHtmlTags(source);
      indexCache.set(source, index);
      diagnostics.onIndex?.({ sourceLength: source.length, tagCount: index.tagCount });
    }
    return index;
  };
  const jobPostingBlocks = readAttributeContainers(
    html,
    'itemtype',
    (value) => value.split(/\s+/).some((itemtype) => /schema\.org\/JobPosting\/?$/i.test(itemtype)),
    indexFor(html),
  );
  for (const block of jobPostingBlocks) {
    const blockIndex = indexFor(block);
    const propFrom = (source, name, sourceIndex = indexFor(source)) => {
      // #6480: reading `itemprop=X ... content=Y` with one glued regex let the
      // `[^"']` class run through an apostrophe between the two attributes and
      // truncate the value. Locate the tag, then read its attributes.
      const opening = sourceIndex.openings.find(
        (candidate) => readAttr(candidate.raw, 'itemprop').toLowerCase() === name.toLowerCase(),
      );
      const content = opening ? readAttr(opening.raw, 'content') : '';
      return (content || (opening ? readItempropBody(source, opening, sourceIndex) : '')).trim();
    };
    const prop = (name) => propFrom(block, name, blockIndex);
    const title = prop('title') || prop('name');
    if (!title) continue;
    const anchor = blockIndex.openings.find((candidate) => candidate.name === 'a')?.raw;
    const href = anchor ? readAttr(anchor, 'href') : '';
    let url = pageUrl;
    try { if (href) url = new URL(href, pageUrl).toString(); } catch { /* keep page url */ }
    const locationCandidates = readItempropContainers(block, 'jobLocation', blockIndex)
      .map((container) => {
        const containerIndex = indexFor(container);
        const locality = propFrom(container, 'addressLocality', containerIndex);
        const region = propFrom(container, 'addressRegion', containerIndex);
        const addressCountry = propFrom(container, 'addressCountry', containerIndex);
        const postalCode = propFrom(container, 'postalCode', containerIndex);
        const streetAddress = propFrom(container, 'streetAddress', containerIndex);
        const directLocation = !locality && !region ? propFrom(container, 'jobLocation', containerIndex) : '';
        return {
          location: [locality || directLocation, region].filter(Boolean).join(', '),
          addressCountry,
          ...(locality ? { addressLocality: locality } : {}),
          ...(region ? { addressRegion: region } : {}),
          ...(postalCode ? { postalCode } : {}),
          ...(streetAddress ? { streetAddress } : {}),
        };
      })
      .filter((candidate) => candidate.location || candidate.addressCountry);
    if (!locationCandidates.length) {
      const location = [prop('addressLocality') || prop('jobLocation'), prop('addressRegion')]
        .filter(Boolean)
        .join(', ');
      const addressCountry = prop('addressCountry');
      const addressLocality = prop('addressLocality');
      const addressRegion = prop('addressRegion');
      const postalCode = prop('postalCode');
      const streetAddress = prop('streetAddress');
      if (location || addressCountry) locationCandidates.push({
        location,
        addressCountry,
        ...(addressLocality ? { addressLocality } : {}),
        ...(addressRegion ? { addressRegion } : {}),
        ...(postalCode ? { postalCode } : {}),
        ...(streetAddress ? { streetAddress } : {}),
      });
    }
    const primaryLocation = locationCandidates[0] || { location: '', addressCountry: '' };
    // Every description element of this posting, not only the first: the
    // SuccessFactors jobs2web layout splits one vacancy into sibling spans.
    // A `content="…"` attribute (a `<meta>` description) stays readable
    // through `prop()`, and whichever reading is richer wins.
    const unitedDescription = distinctBodyTexts(
      block,
      vacancyDescriptionItempropRanges(block, blockIndex),
    ).join('\n');
    const firstDescription = structuredProseText(prop('description'));
    out.push({
      title,
      url,
      urlExplicit: Boolean(href),
      company: prop('hiringOrganization'),
      location: primaryLocation.location || '',
      addressCountry: primaryLocation.addressCountry || '',
      locationCandidates,
      description: (unitedDescription.length > firstDescription.length
        ? unitedDescription
        : firstDescription).slice(0, 8000),
      postedDate: prop('datePosted'),
      employmentType: prop('employmentType'),
      via: 'microdata',
    });
  }
  return out;
}

/**
 * Collapse a URL path into a template: digits -> `#`, long slug segments -> `*`.
 * Two vacancy URLs from the same listing collapse to the same template; a
 * vacancy URL and an "About us" URL do not.
 *
 * @param {string} pathname
 * @returns {string}
 */
export function pathTemplate(pathname = '') {
  return pathname
    .split('/')
    .map((seg) => {
      if (!seg) return '';
      if (/^\d+$/.test(seg)) return '#';
      // A segment mixing words and a long number is a slug+id — the dominant
      // vacancy-URL shape (`Ocean-Freight-Operations-662670289.htm`).
      if (/\d{4,}/.test(seg)) return '*';
      if (seg.length > 24 || (seg.match(/-/g) || []).length >= 3) return '*';
      return seg.toLowerCase();
    })
    .join('/');
}

/**
 * Infer a vacancy listing from link shape alone.
 *
 * @param {{ url: string, text: string }[]} links
 * @param {string} pageUrl
 * @returns {Vacancy[]}
 */
export function extractByTemplate(links, pageUrl) {
  const host = normalizeHost(new URL(pageUrl).hostname);
  /** @type {Map<string, { url: string, text: string }[]>} */
  const clusters = new Map();
  for (const l of links) {
    let u;
    try { u = new URL(l.url); } catch { continue; }
    if (normalizeHost(u.hostname) !== host) continue;
    const path = safeDecodePath(u);
    if (path === '/' || path.length < 4) continue;
    const tpl = pathTemplate(path);
    // A template with no variable part is navigation, not a listing.
    if (!tpl.includes('*') && !tpl.includes('#')) continue;
    if (!clusters.has(tpl)) clusters.set(tpl, []);
    clusters.get(tpl).push(l);
  }
  let best = null;
  for (const [tpl, items] of clusters) {
    if (items.length < 2) continue;
    const jobish = isVacancyPath(tpl) ? 2 : 0;
    const titled = items.filter((i) => i.text && i.text.length > 8).length / items.length;
    const score = jobish + titled + Math.min(items.length, 30) / 30;
    if (!best || score > best.score) best = { tpl, items, score, jobish };
  }
  // Without a vacancy-ish path token the cluster is just as likely to be a news
  // archive, so refuse it rather than publish a blog as jobs.
  if (!best || !best.jobish) return [];
  /** @type {Vacancy[]} */
  const vacancies = best.items.map((i) => ({
    title: (i.text || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    url: i.url,
    via: /** @type {'template'} */ ('template'),
  })).filter((v) => v.title.length > 3);
  return vacancies;
}

/**
 * How strongly does this page read as a vacancy page?
 * Used to verify a third-party host really is where the vacancies live before
 * the registry records it as a platform.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @param {{ url: string, text: string }[]} [links]
 * @returns {{ score: number, signals: string[], vacancies: Vacancy[] }}
 */
export function scoreVacancyPage(html, pageUrl, links = []) {
  const signals = [];
  let score = 0;
  const jsonld = extractJsonLd(html, pageUrl);
  if (jsonld.length) { score += 5; signals.push(`jsonld:${jsonld.length}`); }
  const micro = jsonld.length ? [] : extractMicrodata(html, pageUrl);
  if (micro.length) { score += 4; signals.push(`microdata:${micro.length}`); }
  const tpl = jsonld.length || micro.length ? [] : extractByTemplate(links, pageUrl);
  if (tpl.length) { score += 2 + Math.min(tpl.length, 10) / 10; signals.push(`template:${tpl.length}`); }

  const text = textOf(html);
  if (VACANCY_TEXT_RX.test(text)) { score += 2; signals.push('vacancy-copy'); }
  let p = '';
  p = safeDecodePath(pageUrl);
  if (isVacancyPath(p)) { score += 1; signals.push('vacancy-path'); }
  if (/<form\b[^>]*>[\s\S]{0,4000}?(cv|curriculum|bewerbung|candidatur|resume)/i.test(html)) {
    score += 1; signals.push('apply-form');
  }
  return { score, signals, vacancies: jsonld.length ? jsonld : (micro.length ? micro : tpl) };
}

/**
 * Full cascade against a fetched page.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @param {{ url: string, text: string }[]} links
 * @returns {{ vacancies: Vacancy[], via: string }}
 */
export function extractVacancies(html, pageUrl, links = []) {
  const jsonld = extractJsonLd(html, pageUrl);
  if (jsonld.length) return { vacancies: jsonld, via: 'jsonld' };
  const micro = extractMicrodata(html, pageUrl);
  if (micro.length) return { vacancies: micro, via: 'microdata' };
  const tpl = extractByTemplate(links, pageUrl);
  return { vacancies: tpl, via: tpl.length ? 'template' : 'none' };
}
