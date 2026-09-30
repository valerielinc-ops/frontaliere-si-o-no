#!/usr/bin/env node
/**
 * Liebherr job parser — SAP SuccessFactors / jobs2web careers portal.
 *
 * Source (canonical, scrapable): https://careers.liebherr.com/search/?locationsearch=Switzerland
 *
 * STATUS (2026-06-10):
 *   The "official" career5.successfactors.eu/career?company=LiMySLive instance
 *   is a SAPUI5 `surj` SPA and its JSON API
 *   (POST /services/recruiting/v1/jobs) returns HTTP 403 to any non-browser
 *   client — it requires the in-page minted x-ajax-token + session cookies, so
 *   it cannot be scraped server-side.
 *
 *   However, the surj job-search entry point (`portalcareer?company=LiMySLive`)
 *   302-redirects to a STANDARD jobs2web careers portal at
 *   `https://careers.liebherr.com/search`. That portal is server-rendered
 *   plain HTML (no anti-bot, no JS required): `<li class="job-tile job-id-{id}"
 *   data-url="/job/{slug}/{id}/">` rows carrying title (`.jobTitle-link`) and
 *   a `…section-location-value">{City}, CH<` cell. Adding
 *   `?locationsearch=Switzerland` applies the server-side Switzerland filter
 *   (~87 CH jobs across all Swiss Liebherr entities — Bulle FR, Nussbaumen AG,
 *   Reiden LU, Daillens VD, Baden AG — which all recruit through this one
 *   tenant). Pagination is `startrow += 25`.
 *
 *   The detail pages (`/job/{slug}/{id}/`) ARE server-rendered plain HTML on
 *   `careers.liebherr.com` (verified 2026-06-11: the page carries the full job
 *   body in an `itemprop="description"` schema.org/JobPosting microdata block,
 *   ~2.5k chars / ~385 words). We fetch each detail page to recover the REAL
 *   description (the previous title-only stub failed the assemble
 *   boilerplate-guard, #1722). A listing whose body cannot be read is not
 *   published (issue 5253); the AI-localization pipeline enriches locales.
 *
 * Liebherr Swiss HQ: Rue Hans-Liebherr 7, 1630 Bulle (FR) — default canton when
 * location extraction can't resolve one.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllLiebherrJobs()  — Fetch and parse all jobs
 *   - isLiebherrJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { extractMicrodataDescription } from './jobposting-jsonld.mjs';
import { isSuccessFactorsWidgetText, sanitizeSuccessFactorsField } from './successfactors-jobs2web-widget-guard.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { extractStableJobId } from './job-match-key.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const LIEBHERR_KEY = 'liebherr';
export const LIEBHERR_COMPANY_NAME = 'Liebherr';
export const LIEBHERR_COMPANY_DOMAIN = 'liebherr.com';

const LIEBHERR_SECTOR =
  'Manufacturing / Machinery (construction equipment, engines, hydraulics, aerospace, refrigeration)';

/** jobs2web careers portal — the scrapable, server-rendered source. */
const CAREERS_HOST = 'careers.liebherr.com';
const SEARCH_URL = `https://${CAREERS_HOST}/search/?q=&locationsearch=Switzerland`;
const PAGE_SIZE = 25;
const MAX_PAGES = 20; // 20 × 25 = 500 cap (only ~87 CH jobs as of 2026-06).

/** Realistic browser UA — jobs2web is permissive but bot UAs occasionally 403. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const LIEBHERR_SOURCE_LOCALE_TO_LANG = Object.freeze({
  DE_DE: 'de',
  EN_US: 'en',
  FR_FR: 'fr',
  IT_IT: 'it',
});
// These are the source-verified locales already present in the stored
// snapshot. Legacy rows predate `sourceLocale` and the shared source Job ID,
// so their cleanup must use the explicit evidence captured below instead of
// guessing from title or detected body language.
const LIEBHERR_VERIFIED_SOURCE_LOCALE_BY_ID = Object.freeze({
  '1378968433': 'de_DE',
  '1378968533': 'fr_FR',
  '724771801': 'de_DE',
  '724771901': 'fr_FR',
  '724772001': 'en_US',
  '1421353733': 'de_DE',
  '1421353833': 'en_US',
  '1408751433': 'fr_FR',
  '1408751533': 'en_US',
  '1364834733': 'de_DE',
  '1364834833': 'en_US',
  '1438005533': 'de_DE',
  '1438005433': 'en_US',
  '1433721633': 'de_DE',
  '1433721733': 'en_US',
  '1399715933': 'de_DE',
  '1399715833': 'en_US',
});
// The live detail pages expose this same Job ID in
// `data-careersite-propertyid="adcode"` for every language variant. This
// explicit map is only the migration proof for stored rows that predate the
// field; fresh rows read the value from the source page itself.
const LIEBHERR_VERIFIED_SOURCE_JOB_ID_BY_REQ_ID = Object.freeze({
  '1378968433': '81996',
  '1378968533': '81996',
  '724771801': '37210',
  '724771901': '37210',
  '724772001': '37210',
  '1421353733': '83959',
  '1421353833': '83959',
  '1408751433': '83305',
  '1408751533': '83305',
  '1364834733': '81356',
  '1364834833': '81356',
  '1438005533': '84657',
  '1438005433': '84657',
  '1433721633': '84459',
  '1433721733': '84459',
  '1399715933': '82589',
  '1399715833': '82589',
});

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

function sourceLangForLocale(sourceLocale = '') {
  return LIEBHERR_SOURCE_LOCALE_TO_LANG[String(sourceLocale || '').trim().toUpperCase()] || '';
}

function sourceLocaleForJob(job = {}, { legacy = false } = {}) {
  const explicit = String(job?.sourceLocale || '').trim();
  if (explicit || !legacy) return explicit;
  return LIEBHERR_VERIFIED_SOURCE_LOCALE_BY_ID[String(job?.jobReqId || '').trim()] || '';
}

function sourceJobIdForJob(job = {}, { legacy = false } = {}) {
  const explicit = String(job?.liebherrSourceJobId || '').trim();
  if (explicit || !legacy) return explicit;
  return LIEBHERR_VERIFIED_SOURCE_JOB_ID_BY_REQ_ID[String(job?.jobReqId || '').trim()] || '';
}

/**
 * Read the locale from the source's own apply link. The detail page carries
 * `locale=de_DE|en_US&jobid=<id>` even when the visible title/body is shared
 * or partly bilingual; body-language detection alone is not proof of source
 * identity for this tenant.
 */
export function extractLiebherrSourceLocale(html = '', jobReqId = '') {
  const id = String(jobReqId || '').trim();
  if (!html || !id) return '';
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(html).match(
    new RegExp(`locale=(de_DE|en_US|fr_FR|it_IT)(?:&amp;|&)jobid=${escapedId}(?:\\D|$)`, 'i'),
  );
  return match ? match[1] : '';
}

/**
 * Read Liebherr's shared source Job ID from the detail-page data attribute.
 * The page URL/apply `jobid` identifies the localized page and can differ by
 * 100; `adcode` is the common identifier for the vacancy itself.
 */
export function extractLiebherrSourceJobId(html = '') {
  if (!html) return '';
  const match = String(html).match(
    /data-careersite-propertyid=["']adcode["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
  );
  if (!match) return '';
  return normalizeSpace(decodeEntities(stripHtml(match[1])));
}

function liebherrSourceLang(job = {}, { legacy = false } = {}) {
  return sourceLangForLocale(sourceLocaleForJob(job, { legacy }))
    || String(job?.sourceLang || '').trim().toLowerCase();
}

function sourceDate(job = {}) {
  const value = job?.firstSeenAt || job?.datePosted || job?.postedDate || '';
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function isLiebherrLanguageVariantPair(a = {}, b = {}, { legacy = false } = {}) {
  const firstSourceJobId = sourceJobIdForJob(a, { legacy });
  const secondSourceJobId = sourceJobIdForJob(b, { legacy });
  if (!firstSourceJobId || firstSourceJobId !== secondSourceJobId) return false;
  const firstLocale = sourceLangForLocale(sourceLocaleForJob(a, { legacy }));
  const secondLocale = sourceLangForLocale(sourceLocaleForJob(b, { legacy }));
  return (
    ['de', 'en', 'fr', 'it'].includes(firstLocale)
    && ['de', 'en', 'fr', 'it'].includes(secondLocale)
    && firstLocale !== secondLocale
  );
}

function variantGroupKey(job = {}, { legacy = false } = {}) {
  const sourceJobId = sourceJobIdForJob(job, { legacy });
  return sourceJobId ? `source-job:${sourceJobId}` : '';
}

function primaryOrder(a = {}, b = {}) {
  const first = sourceDate(a);
  const second = sourceDate(b);
  if (first !== null && second !== null && first !== second) return first - second;
  if (first !== null && second === null) return -1;
  if (first === null && second !== null) return 1;
  return 0; // the source listing order is the only first-publication signal left
}

function addLiebherrRedirect(job, locale, slug, metrics) {
  const value = String(slug || '').trim();
  if (!value) return;
  const current = new Set([
    job?.slug,
    ...Object.values(job?.slugByLocale || {}),
  ].filter(Boolean));
  if (current.has(value)) return;

  const alreadyKnown = Boolean(
    job.previousSlugs?.includes(value)
    || Object.values(job.previousSlugsByLocale || {}).some((aliases) => Array.isArray(aliases) && aliases.includes(value)),
  );
  let added = false;
  if (!Array.isArray(job.previousSlugs)) job.previousSlugs = [];
  if (!job.previousSlugs.includes(value)) {
    job.previousSlugs.push(value);
    added = true;
  }
  if (locale) {
    if (!job.previousSlugsByLocale || typeof job.previousSlugsByLocale !== 'object') {
      job.previousSlugsByLocale = {};
    }
    if (!Array.isArray(job.previousSlugsByLocale[locale])) job.previousSlugsByLocale[locale] = [];
    if (!job.previousSlugsByLocale[locale].includes(value)) {
      job.previousSlugsByLocale[locale].push(value);
      added = true;
    }
  }
  if (added && !alreadyKnown && metrics) metrics.redirectsCreated += 1;
}

function mergeLiebherrVariantPair(primary, secondary, metrics, { legacy = false } = {}) {
  const merged = { ...primary };
  if (Array.isArray(primary.previousSlugs)) merged.previousSlugs = [...primary.previousSlugs];
  if (primary.previousSlugsByLocale && typeof primary.previousSlugsByLocale === 'object') {
    merged.previousSlugsByLocale = Object.fromEntries(
      Object.entries(primary.previousSlugsByLocale).map(([locale, slugs]) => [
        locale,
        Array.isArray(slugs) ? [...slugs] : slugs,
      ]),
    );
  }
  const titleByLocale = { ...(primary.titleByLocale || {}) };
  const descriptionByLocale = { ...(primary.descriptionByLocale || {}) };
  const slugByLocale = { ...(primary.slugByLocale || {}) };
  const requirementsByLocale = { ...(primary.requirementsByLocale || {}) };
  const sourceJobReqIds = new Set([
    ...(Array.isArray(primary.liebherrSourceJobReqIds) ? primary.liebherrSourceJobReqIds : []),
    ...(primary.jobReqId ? [String(primary.jobReqId)] : []),
  ]);
  const sourceJobReqIdByLocale = { ...(primary.liebherrSourceJobReqIdByLocale || {}) };

  for (const job of [primary, secondary]) {
    const locale = liebherrSourceLang(job, { legacy });
    if (job?.jobReqId) sourceJobReqIds.add(String(job.jobReqId));
    if (locale) {
      titleByLocale[locale] = job.titleByLocale?.[locale] || job.title || titleByLocale[locale];
      descriptionByLocale[locale] = job.descriptionByLocale?.[locale] || job.description || descriptionByLocale[locale];
      // The survivor keeps its active slug identity. The other source URL is
      // a legacy alias, even though its source title/body gets its own slot.
      if (job === primary) {
        slugByLocale[locale] = job.slugByLocale?.[locale] || job.slug || slugByLocale[locale];
      }
      if (Array.isArray(job.requirementsByLocale?.[locale])) {
        requirementsByLocale[locale] = job.requirementsByLocale[locale];
      }
      if (job.jobReqId) sourceJobReqIdByLocale[locale] = String(job.jobReqId);
    }
    if (legacy) {
      for (const [key, value] of Object.entries(job.titleByLocale || {})) {
        if (!titleByLocale[key]) titleByLocale[key] = value;
      }
      for (const [key, value] of Object.entries(job.descriptionByLocale || {})) {
        if (!descriptionByLocale[key]) descriptionByLocale[key] = value;
      }
      for (const [key, value] of Object.entries(job.requirementsByLocale || {})) {
        if (!requirementsByLocale[key]) requirementsByLocale[key] = value;
      }
    }
  }

  merged.titleByLocale = titleByLocale;
  merged.descriptionByLocale = descriptionByLocale;
  merged.slugByLocale = slugByLocale;
  merged.requirementsByLocale = requirementsByLocale;
  merged.liebherrSourceJobReqIds = [...sourceJobReqIds];
  merged.liebherrSourceJobReqIdByLocale = sourceJobReqIdByLocale;
  const sourceJobId = sourceJobIdForJob(primary, { legacy });
  merged.liebherrLanguageVariantKey = variantGroupKey(primary, { legacy });
  if (sourceJobId) merged.liebherrSourceJobId = sourceJobId;
  const primarySourceLang = liebherrSourceLang(primary, { legacy });
  if (primarySourceLang) {
    merged.sourceLang = primarySourceLang;
    merged.title = titleByLocale[primarySourceLang] || primary.title;
    merged.description = descriptionByLocale[primarySourceLang] || primary.description;
  }
  if (!merged.sourceLocale) {
    const verifiedPrimaryLocale = sourceLocaleForJob(primary, { legacy });
    if (verifiedPrimaryLocale) merged.sourceLocale = verifiedPrimaryLocale;
  }

  const secondaryLocale = liebherrSourceLang(secondary, { legacy });
  for (const [locale, slug] of Object.entries(secondary.slugByLocale || {})) {
    addLiebherrRedirect(merged, locale, slug, metrics);
  }
  addLiebherrRedirect(merged, secondaryLocale || 'it', secondary.slug, metrics);
  for (const [locale, aliases] of Object.entries(secondary.previousSlugsByLocale || {})) {
    for (const alias of Array.isArray(aliases) ? aliases : []) addLiebherrRedirect(merged, locale, alias, metrics);
  }
  for (const alias of Array.isArray(secondary.previousSlugs) ? secondary.previousSlugs : []) {
    addLiebherrRedirect(merged, secondaryLocale || 'it', alias, metrics);
  }
  return merged;
}

/**
 * Merge only Liebherr locale rows whose detail pages expose the same source
 * Job ID. `legacy: true` is used only for cleaning stored rows created before
 * the source Job ID and page-locale proof were persisted.
 */
export function mergeLiebherrLanguageVariants(jobs = [], { legacy = false } = {}) {
  const input = Array.isArray(jobs) ? jobs : [];
  const metrics = { candidatePairs: 0, fused: 0, redirectsCreated: 0 };
  const groups = new Map();
  for (const job of input) {
    const key = variantGroupKey(job, { legacy });
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }

  const consumed = new Set();
  const output = [];
  for (const job of input) {
    if (consumed.has(job)) continue;
    const candidates = groups.get(variantGroupKey(job, { legacy })) || [];
    const locales = candidates.map((candidate) => liebherrSourceLang(candidate, { legacy }));
    const canFuse = (
      candidates.length > 1
      && candidates.every((candidate) => isLiebherrLanguageVariantPair(candidates[0], candidate, { legacy }) || candidate === candidates[0])
      && locales.every((locale) => ['de', 'en', 'fr', 'it'].includes(locale))
      && new Set(locales).size === candidates.length
    );
    if (canFuse) {
      const ordered = [...candidates].sort(primaryOrder);
      let merged = ordered[0];
      for (const secondary of ordered.slice(1)) {
        metrics.candidatePairs += 1;
        merged = mergeLiebherrVariantPair(merged, secondary, metrics, { legacy });
        metrics.fused += 1;
      }
      output.push(merged);
      for (const candidate of candidates) consumed.add(candidate);
      continue;
    }
    output.push(job);
    consumed.add(job);
  }

  return { jobs: output, metrics };
}

export function prepareExistingLiebherrJobs(jobs = []) {
  const result = mergeLiebherrLanguageVariants(jobs, { legacy: true });
  console.log(
    `📊 Liebherr language variants (stored): candidates=${result.metrics.candidatePairs}, `
    + `fused=${result.metrics.fused}, redirects=${result.metrics.redirectsCreated}`,
  );
  return result.jobs;
}

/**
 * Match a source-proven Liebherr vacancy across crawler runs. Rows without
 * the source Job ID retain the normal URL identity, so arbitrary IDs never
 * collapse here.
 */
export function liebherrMatchKey(job = {}) {
  if (job?.liebherrSourceJobId) return `liebherr:source-job:${job.liebherrSourceJobId}`;
  if (String(job?.liebherrLanguageVariantKey || '').startsWith('source-job:')) {
    return `liebherr:${job.liebherrLanguageVariantKey}`;
  }
  const stableId = extractStableJobId(job?.url || '');
  if (stableId) return stableId;
  const slug = String(job?.slug || '').trim().toLowerCase();
  return slug ? `slug:${slug}` : '';
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Liebherr (covers all Swiss Liebherr entities:
 * Liebherr Machines Bulle SA, Liebherr-Aerospace, Liebherr Components
 * Nussbaumen, Liebherr-Export Reiden, Liebherr-Transportation/Daillens —
 * they all recruit through the same SuccessFactors tenant).
 */
export function isLiebherrJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === LIEBHERR_KEY ||
    key.startsWith('liebherr') ||
    company.includes('liebherr') ||
    url.includes('liebherr.com') ||
    url.includes('company=limyslive')
  );
}

/**
 * Validate that a URL belongs to Liebherr's domain or its ATS hosts.
 * The public apply destination is the jobs2web portal
 * `careers.liebherr.com` (a liebherr.com subdomain). The original
 * SuccessFactors tenant lives on `*.successfactors.eu` with
 * `company=LiMySLive` — first-party for our trust model since it is the
 * canonical apply origin.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'liebherr.com' || host.endsWith('.liebherr.com')) return true;
    if (host.endsWith('.successfactors.eu') || host.endsWith('.successfactors.com')) {
      return /company=limyslive/i.test(url.search);
    }
    return false;
  } catch {
    return false;
  }
}

/* ── Category / level / type detection ─────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl|ing[eé]nieur|konstrukt)/.test(t)) return 'Ingegneria';
  if (/\b(it|software|develop|programm|data|cloud|cyber|devops|security)/.test(t)) return 'IT';
  if (/\b(techni|tecnic|m[eé]canic|mechanic|elektr|install|wartung|maintenance|monteur)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account|sachbearbeit|assistant)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|commercial|vente)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse|supply|douani|tarification)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur|fertigung|production|usinage)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(hr|human|risorse|personal|talent|recruit|ressources humaines)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|communication|brand)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ|controll|tax)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht|juridique|compliance)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti|trainee|graduate)/.test(t)) return 'intern';
  if (/\b(junior|jr)\b/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitung)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|praktik)/.test(t)) return 'INTERN';
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(tempor|befristet|fixed.?term|cdd|temporaire)/.test(t)) return 'CONTRACTOR';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── jobs2web listing parser ───────────────────────────────── */

/**
 * @typedef {Object} LiebherrListing
 * @property {string} title
 * @property {string} location   Raw location cell, e.g. "Bulle, CH".
 * @property {string} url        Absolute detail URL.
 * @property {string} jobReqId   Numeric jobs2web job id.
 */

/**
 * Parse one jobs2web search-results page into listing rows.
 * Each job is a `<li class="job-tile job-id-{id}" data-url="/job/{slug}/{id}/">`
 * carrying the title in `<a class="jobTitle-link" …>{Title}</a>` and the
 * location in `…section-location-value">{City}, CH</…>`.
 *
 * @param {string} html
 * @returns {LiebherrListing[]}
 */
function parseSearchPage(html = '') {
  if (!html) return [];
  const out = [];
  const tileRe = /<li class="job-tile job-id-(\d+)[^"]*"[^>]*data-url="([^"]+)"[\s\S]*?(?=<li class="job-tile job-id-|<\/ul>|$)/gi;
  let m;
  while ((m = tileRe.exec(html)) !== null) {
    const jobReqId = m[1];
    const dataUrl = decodeEntities(m[2]);
    const block = m[0];

    const titleMatch =
      block.match(/<a[^>]*class="jobTitle-link[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/<a[^>]*href="[^"]*\/job\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleMatch
      ? normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ' ')))
      : '';
    if (!title || title.length < 3) continue;
    // The generic-anchor fallback above (no jobTitle-link on this tenant skin)
    // can pick up the j2w cookie-consent/keyword-search/job-alert widget as if
    // it were a job tile. A row whose title IS that widget chrome is not a
    // posting — discard it rather than clean it (a cleaned title would leave
    // an anonymous job).
    if (isSuccessFactorsWidgetText(title)) continue;

    // The location VALUE node ends `…location-value">{City}, CH<`. A separate
    // label span carries `aria-describedby="…location-value"` followed by
    // `class=…` — so we require the closing `">` immediately after
    // `location-value` to skip the label and grab the value.
    const locMatch = block.match(/section-location-value">([^<]+)</i);
    const location = locMatch ? normalizeSpace(decodeEntities(locMatch[1])) : '';

    const url = dataUrl.startsWith('http')
      ? dataUrl
      : `https://${CAREERS_HOST}${dataUrl.startsWith('/') ? '' : '/'}${dataUrl}`;

    out.push({ title, location, url, jobReqId });
  }
  return out;
}

/**
 * Fetch every Switzerland-filtered listing row across all result pages.
 * @returns {Promise<LiebherrListing[]>}
 */
async function fetchJobListings() {
  const seen = new Set();
  const listings = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const startrow = page * PAGE_SIZE;
    const pageUrl = startrow > 0 ? `${SEARCH_URL}&startrow=${startrow}` : SEARCH_URL;

    let html;
    try {
      html = await fetchHtml(pageUrl, { headers: { 'User-Agent': USER_AGENT } });
    } catch (err) {
      console.warn(`⚠️ Listing fetch failed (startrow=${startrow}): ${err?.message || err}`);
      break;
    }

    const rows = parseSearchPage(html);
    if (rows.length === 0) break;

    let added = 0;
    for (const row of rows) {
      // The same ATS id may be exposed once per locale with a different
      // locale-bearing detail URL. Exact repeated rows still dedupe, but the
      // URL must remain part of the source identity until detail-page proof
      // can fuse the variants.
      const listingIdentity = `${row.jobReqId}\u0000${row.url}`;
      if (seen.has(listingIdentity)) continue;
      seen.add(listingIdentity);
      listings.push(row);
      added++;
    }
    // Last page (partial) or no new rows → stop paginating.
    if (rows.length < PAGE_SIZE || added === 0) break;

    await new Promise((r) => setTimeout(r, 500)); // polite delay
  }

  return listings;
}

/* ── Job assembly ──────────────────────────────────────────── */

/**
 * Fetch the full job-body description from a Liebherr jobs2web detail page.
 * The page is server-rendered plain HTML carrying the body in an
 * `itemprop="description"` schema.org/JobPosting microdata block. Returns the
 * inner HTML (caller strips tags) or '' on any failure → the caller does not
 * publish the listing. fetchHtml follows the 302 to the canonical detail URL.
 */
async function fetchLiebherrDetailPage(url, jobReqId = '') {
  if (!url || !/^https?:\/\//.test(url)) {
    return { descriptionHtml: '', sourceLocale: '', sourceJobId: '' };
  }
  try {
    const html = await fetchHtml(url, {
      timeoutMs: 15000,
      headers: { 'User-Agent': USER_AGENT },
    });
    return {
      descriptionHtml: extractMicrodataDescription(html),
      sourceLocale: extractLiebherrSourceLocale(html, jobReqId),
      sourceJobId: extractLiebherrSourceJobId(html),
    };
  } catch {
    return { descriptionHtml: '', sourceLocale: '', sourceJobId: '' }; // network/timeout → the listing is not published
  }
}

/**
 * Fetch all Liebherr jobs.
 * Returns an array of ParsedJob objects (source-locale only). Other locales
 * are filled by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllLiebherrJobs() {
  console.log(`🔍 Fetching Liebherr jobs (CH-wide via jobs2web careers portal)`);
  console.log(`   Source: ${SEARCH_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  let withoutBody = 0;
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    // Location cell is "City, CH" — keep the city as the human-facing locality.
    const rawLocation = normalizeSpace(listing.location || '');
    const city = (rawLocation.split(',')[0] || '').trim() || 'Bulle';
    const canton =
      inferSwissTargetCanton(rawLocation) ||
      inferSwissTargetCanton(city) ||
      'FR'; // HQ canton (Bulle, Fribourg)

    const publicUrl = listing.url || SEARCH_URL;
    // The jobs2web detail page is server-rendered: recover the REAL job body
    // from the itemprop="description" microdata block (#1722: the previous
    // title-only stub 100%-failed the boilerplate guard).
    const detail = await fetchLiebherrDetailPage(publicUrl, listing.jobReqId);
    const detailDescHtml = detail.descriptionHtml;
    // Detail page can itself surface widget chrome as the "description" body
    // (same class of bleed as the title) — sanitize before the body check.
    const detailDescText = detailDescHtml
      ? sanitizeSuccessFactorsField(normalizeSpace(stripHtml(detailDescHtml)))
      : '';
    // Only the posting's own text is published (issue 5253): without a
    // readable body the listing used to go out as "{title} — Liebherr
    // ({city}, CH)"; it is not published any more.
    if (!meetsSourceBodyFloor(detailDescText)) {
      console.log(`  ⏭️ no vacancy text on the detail page, not published: ${title}`);
      withoutBody += 1;
      continue;
    }
    const descriptionText = detailDescText;

    const sourceLang = sourceLangForLocale(detail.sourceLocale) || detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} liebherr ${city}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `liebherr-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: LIEBHERR_COMPANY_NAME,
      companyKey: LIEBHERR_KEY,
      companyDomain: LIEBHERR_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: city,
      canton,
      url: publicUrl,
      source: 'Liebherr Dedicated Parser (jobs2web)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(title),
      experienceLevel: detectExperienceLevel(title),
      sector: LIEBHERR_SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      jobReqId: listing.jobReqId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      ...(detail.sourceLocale ? { sourceLocale: detail.sourceLocale } : {}),
      ...(detail.sourceJobId ? { liebherrSourceJobId: detail.sourceJobId } : {}),
    };

    jobs.push(job);
  }

  if (withoutBody > 0) {
    console.log(`  ⏭️ ${withoutBody} listing(s) without vacancy text on the detail page — not published.`);
  }
  const merged = mergeLiebherrLanguageVariants(jobs);
  console.log(
    `📊 Liebherr language variants: candidates=${merged.metrics.candidatePairs}, `
    + `fused=${merged.metrics.fused}, redirects=${merged.metrics.redirectsCreated}`,
  );
  Object.defineProperty(merged.jobs, 'discoveredCount', {
    value: listings.length,
    enumerable: false,
  });
  Object.defineProperty(merged.jobs, 'languageVariantStats', {
    value: merged.metrics,
    enumerable: false,
  });
  console.log(`\n📋 Total Liebherr jobs discovered: ${merged.jobs.length}`);
  return merged.jobs;
}

export { slugify, stripHtml };
