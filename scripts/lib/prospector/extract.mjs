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
 * All JSON-LD blocks in a document, flattened through `@graph`.
 * Malformed blocks are skipped — SME sites ship broken JSON-LD routinely and one
 * bad block must not cost the whole page.
 *
 * @param {string} html
 * @returns {any[]}
 */
export function jsonLdBlocks(html = '') {
  const out = [];
  const rx = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html))) {
    const raw = m[1].trim().replace(/^\uFEFF/, '');
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Second chance on entity-escaped JSON-LD, which CMS-generated pages emit
      // routinely. Taken from the retry in scripts/lib/shared-jobs-crawler.mjs,
      // whose extractor is module-private: without it a whole employer's
      // structured data is silently discarded and the cascade falls back to
      // link-shape inference on a page that had perfectly good data.
      try { parsed = JSON.parse(decodeEntities(raw)); } catch { continue; }
    }
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

/**
 * Normalised vacancy record. Field names mirror the ones the site's job
 * pipeline already uses, so a synthesised crawler needs no translation layer.
 *
 * @typedef {Object} Vacancy
 * @property {string} title
 * @property {string} url
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
 * @param {string} html
 * @param {string} pageUrl
 * @returns {Vacancy[]}
 */
export function extractJsonLd(html, pageUrl) {
  /** @type {Vacancy[]} */
  const out = [];
  for (const node of jsonLdBlocks(html)) {
    if (!isJobPostingNode(node)) continue;
    const locationCandidates = schemaJobLocationCandidates(node.jobLocation);
    const primaryLocation = locationCandidates[0] || { location: '', addressCountry: '' };
    const rawExplicitUrl = firstString(node.url) || firstString(node.sameAs);
    let explicitUrl = rawExplicitUrl;
    try { if (rawExplicitUrl) explicitUrl = new URL(rawExplicitUrl, pageUrl).toString(); } catch { /* retain raw evidence */ }
    out.push({
      title: firstString(node.title) || firstString(node.name),
      url: explicitUrl || pageUrl,
      urlExplicit: Boolean(rawExplicitUrl),
      company: firstString(node.hiringOrganization),
      location: primaryLocation.location || '',
      addressCountry: primaryLocation.addressCountry || '',
      locationCandidates,
      description: textOf(firstString(node.description)).slice(0, 8000),
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
 */
function selectDetailStructuredRecords(records, pageUrl, renderedTitle) {
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
 * Read authoritative fields from a vacancy detail page. JSON-LD often contains
 * only a teaser; the rendered detail body is therefore preferred when it is
 * richer than the structured description.
 *
 * @param {string} html
 * @param {string} pageUrl
 * @returns {{
 *   title: string,
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
 *   description: string,
 *   postedDate: string,
 *   employmentType: string,
 * }}
 */
export function extractDetailFields(html = '', pageUrl = '') {
  // A detail page can expose JSON-LD and microdata simultaneously, sometimes
  // with complementary or conflicting locations. Preserve every candidate so
  // authoritative foreign evidence cannot disappear merely because the other
  // format (or rendered text) names a Swiss homonym.
  const allStructuredRecords = /** @type {Partial<Vacancy>[]} */ ([
    ...extractJsonLd(html, pageUrl),
    ...extractMicrodata(html, pageUrl),
  ]);
  const renderedTitle = textOf(/<h1\b[^>]*>([\s\S]{0,1000}?)<\/h1>/i.exec(html)?.[1] || '');
  const structuredRecords = selectDetailStructuredRecords(allStructuredRecords, pageUrl, renderedTitle);
  const ambiguousStructuredSiblings = allStructuredRecords.length > 1 && !structuredRecords.length;
  const structured = structuredRecords[0] || {};
  const title = renderedTitle || structured.title || '';
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
  const primaryLocation = /** @type {any} */ (locationCandidates[0] || {});
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
  const blocks = [];
  // Extract balanced containers so nested lists/divs do not truncate the
  // vacancy at the first inner closing tag. The vocabulary is vendor-neutral;
  // Fachkraft's ff-detail-* classes are just one supported spelling.
  const openingRx = /<(div|section|article)\b([^>]*\bclass\s*=\s*["'][^"']*(?:job[-_ ]?(?:description|details?|content)|vacancy[-_ ]?(?:description|details?)|position[-_ ]?description|detail[-_ ]{1,2}text|detail[-_ ]?intro|description)[^"']*["'][^>]*)>/gi;
  let match;
  while ((match = openingRx.exec(html))) {
    const detailClassAttr = match[2];
    if (/\b(?:cookie|cmplz|consent|meta)\b/i.test(detailClassAttr)) continue;
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
    if (end !== undefined) blocks.push(textOf(html.slice(openingRx.lastIndex, end)));
  }
  // Read the description element to its matching close tag. SuccessFactors
  // nests many same-name spans inside itemprop="description"; the former
  // non-greedy regex stopped at the first inner </span>, making a correct
  // published body appear unrelated to its source in the quality audit.
  const semanticIndex = indexHtmlTags(html);
  const semanticOpening = semanticIndex.openings.find((candidate) =>
    !candidate.selfClosing
    && !VOID_HTML_TAGS.has(candidate.name)
    && readAttr(candidate.raw, 'itemprop').split(/\s+/).includes('description')
  );
  const semanticBounds = semanticOpening
    ? semanticIndex.boundsByStart.get(semanticOpening.index)
    : null;
  if (semanticOpening && semanticBounds) {
    blocks.push(textOf(html.slice(semanticOpening.end, semanticBounds.contentEnd)));
  }
  // A detail page with no useful class still commonly puts the vacancy body
  // in its main/article container. Use it only when it is materially larger
  // than the page's structured teaser, avoiding a navigation-only shell.
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(html);
  if (!blocks.length && main) blocks.push(textOf(main[2]));
  const descriptions = [
    ...blocks,
    blocks.length > 1 ? blocks.join(' ') : '',
    ...structuredRecords.map((record) => record.description || ''),
  ].filter(Boolean);
  descriptions.sort((a, b) => b.length - a.length);
  return {
    title,
    location,
    addressCountry: primaryLocation.addressCountry || structured.addressCountry || '',
    locationCandidates,
    authoritativeLocationConflict,
    description: descriptions[0] || '',
    postedDate: structuredRecords.find((record) => record.postedDate)?.postedDate || '',
    employmentType: structuredRecords.find((record) => record.employmentType)?.employmentType || '',
  };
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
    out.push({
      title,
      url,
      urlExplicit: Boolean(href),
      company: prop('hiringOrganization'),
      location: primaryLocation.location || '',
      addressCountry: primaryLocation.addressCountry || '',
      locationCandidates,
      description: textOf(prop('description')).slice(0, 8000),
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
