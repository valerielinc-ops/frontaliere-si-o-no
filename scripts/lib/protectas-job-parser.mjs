#!/usr/bin/env node
/**
 * Protectas SA job parser — official career-page inventory and JSON-LD detail
 * parser.
 *
 * The source is deliberately scoped to physical-security vacancies in Ticino.
 * Protectas also publishes cyber/security-technology roles; importing those
 * into the same source would make the physical-security landing ambiguous.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { fetchHtml, slugify, stripHtml } from './crawler-template.mjs';
import { readAttr, scanStartTags } from './html-attr.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const PROTECTAS_KEY = 'protectas';
export const PROTECTAS_COMPANY_NAME = 'Protectas SA';
export const PROTECTAS_COMPANY_DOMAIN = 'protectas.com';
export const PROTECTAS_TARGET_CANTON = 'TI';
export const PROTECTAS_CAREER_URL = 'https://www.protectas.com/it-ch/carriere/offerte-di-lavoro/';

const DETAIL_PATH_RE = /\/(?:offerte-di-lavoro|offres-d-emploi|stellenangebote)\/\d{8,}(?:\/|$)/i;
const LISTING_PATH_RE = /\/(?:it-ch\/carriere\/offerte-di-lavoro|fr-ch\/carriere\/offres-d-emploi|de-ch\/karriere\/stellenangebote)\/?$/i;
const SWISS_COUNTRIES = new Set(['ch', 'switzerland', 'schweiz', 'suisse', 'svizzera']);
const PHYSICAL_SECURITY_TITLE_RE = /\b(?:agente(?:\s+di)?\s+sicurezza|guardia(?:\s+giurata)?|security\s+(?:guard|officer)|security\s+agent|sicherheitsdienst|sicherheitsmitarbeiter|wachmann|agent(?:e)?\s+de\s+s[ée]curit(?:e|é)|surveill(?:ance|ant)|vigilanz|ronde|gardien)\b/i;
const CYBER_OR_TECH_SECURITY_RE = /\b(?:cyber|cybers[eé]curit|sicurezza\s+informatica|s[ée]curit[ée]\s+informatique|information\s+security|it[-\s]?security|it[-\s]?sicherheitsmitarbeiter|infosec|security\s+(?:engineer|architect|analyst|specialist|consultant)|soc\s+analyst|penetration\s+test|application\s+security|cloud\s+security|network\s+security|gouvernance\s+(?:de\s+la\s+)?s[eé]curit)\b/i;
const MAX_LISTING_PAGES = 12;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeHtml(value = '') {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x2f;|&#47;/gi, '/')
    .replace(/&nbsp;/gi, ' ');
}

function firstText(...values) {
  return values.map((value) => normalizeSpace(value)).find(Boolean) || '';
}

function asArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function scalarText(value) {
  if (typeof value === 'string' || typeof value === 'number') return normalizeSpace(value);
  if (value && typeof value === 'object') return firstText(value.name, value.value, value['@id']);
  return '';
}

function toProtectasUrl(rawUrl, baseUrl = PROTECTAS_CAREER_URL) {
  const candidate = decodeHtml(rawUrl).replace(/\\u002f/gi, '/').replace(/\\u0026/gi, '&').trim();
  if (!candidate) return '';
  try {
    const url = new URL(candidate, baseUrl);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function isVacancyUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return isTrustedDomain(url.toString()) && DETAIL_PATH_RE.test(url.pathname);
  } catch {
    return false;
  }
}

function isListingUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return isTrustedDomain(url.toString()) && LISTING_PATH_RE.test(url.pathname);
  } catch {
    return false;
  }
}

function readMetaContent(html, key) {
  const target = normalize(key);
  for (const tag of scanStartTags(html, 'meta')) {
    const name = normalize(readAttr(tag.raw, ['property', 'name']));
    if (name === target) return decodeHtml(readAttr(tag.raw, 'content'));
  }
  return '';
}

function extractMainHtml(html = '') {
  return String(html).match(/<(?:main|article)\b[^>]*>[\s\S]*?<\/(?:main|article)>/i)?.[0]
    || String(html).match(/<body\b[^>]*>[\s\S]*?<\/body>/i)?.[0]
    || '';
}

/* ── Company Matchers ──────────────────────────────────────── */

/** Check if a job belongs to Protectas SA. */
export function isProtectasJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === PROTECTAS_KEY ||
    key.startsWith('protectas-') ||
    company.includes('protectas') ||
    Boolean(url && isTrustedDomain(url))
  );
}

/** Validate that a URL belongs to Protectas SA's domain. */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'protectas.com' || host.endsWith('.protectas.com');
  } catch {
    return false;
  }
}

/* ── Physical/cyber boundary ───────────────────────────────── */

/**
 * Return true only for a vacancy whose title identifies physical guarding.
 * A title-level signal prevents a generic company description mentioning
 * security from creating a false physical-security match.
 */
export function isPhysicalSecurityVacancy(title = '', description = '') {
  const titleText = normalizeSpace(title);
  const haystack = `${titleText}\n${normalizeSpace(description)}`;
  return PHYSICAL_SECURITY_TITLE_RE.test(titleText) && !CYBER_OR_TECH_SECURITY_RE.test(haystack);
}

/* ── Category and field detection ──────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (PHYSICAL_SECURITY_TITLE_RE.test(t)) return 'Sicurezza';
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(value = '') {
  const t = normalize(asArray(value).join(' '));
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Listing inventory ─────────────────────────────────────── */

/** Extract official numeric Protectas vacancy URLs from an HTML page. */
export function extractProtectasVacancyUrls(html = '', baseUrl = PROTECTAS_CAREER_URL) {
  const found = new Set();
  const add = (raw) => {
    const url = toProtectasUrl(raw, baseUrl);
    if (url && isVacancyUrl(url)) found.add(url);
  };

  for (const tag of scanStartTags(html, 'a')) {
    add(readAttr(tag.raw, ['href', 'data-href', 'data-url', 'data-job-url']));
  }

  // Some career-page widgets keep the same links in a JSON state blob rather
  // than in anchors. Keep the host/path allow-list identical to the anchor path.
  for (const match of String(html).matchAll(/(?:https?:)?\/\/[^"'<>\\\s]+/gi)) add(match[0]);
  return [...found];
}

/** Extract bounded pagination links for the same official career listing. */
export function extractProtectasListingUrls(html = '', baseUrl = PROTECTAS_CAREER_URL) {
  const found = new Set();
  for (const tag of scanStartTags(html, 'a')) {
    const raw = readAttr(tag.raw, ['href', 'data-href', 'data-url']);
    const url = toProtectasUrl(raw, baseUrl);
    if (!url || !isListingUrl(url)) continue;
    if (/[?&](?:page|p|offset|start|from)=\d+/i.test(url)
      || /\/page\/\d+\/?$/i.test(new URL(url).pathname)) {
      found.add(url);
    }
  }
  return [...found];
}

async function fetchJobListings() {
  console.log(`   Fetching from: ${PROTECTAS_CAREER_URL}`);
  const queue = [PROTECTAS_CAREER_URL];
  const visited = new Set();
  const vacancyUrls = new Set();
  let primaryPageFetched = false;

  while (queue.length > 0) {
    if (visited.size >= MAX_LISTING_PAGES) {
      throw new Error(
        `Protectas pagination exceeded the safety limit of ${MAX_LISTING_PAGES} pages before traversal completed`,
      );
    }
    const pageUrl = queue.shift();
    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);

    let html;
    try {
      html = await fetchHtml(pageUrl, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'it-CH,it;q=0.9',
        },
      });
      if (pageUrl === PROTECTAS_CAREER_URL) primaryPageFetched = true;
    } catch (error) {
      throw new Error(
        `Protectas pagination page failed: ${pageUrl} — ${error?.message || error}`,
        { cause: error },
      );
    }

    for (const url of extractProtectasVacancyUrls(html, pageUrl)) vacancyUrls.add(url);
    for (const url of extractProtectasListingUrls(html, pageUrl)) {
      if (!visited.has(url)) queue.push(url);
    }
  }

  if (!primaryPageFetched) throw new Error('Protectas primary career page was not fetched');
  if (vacancyUrls.size === 0) {
    throw new Error('Protectas career page exposed no official vacancy detail links');
  }

  return [...vacancyUrls].map((url) => ({ url }));
}

/* ── Detail JSON-LD parsing ────────────────────────────────── */

function findJobPosting(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJobPosting(item, seen);
      if (found) return found;
    }
    return null;
  }
  const types = asArray(value['@type']).map((type) => normalize(type));
  if (types.includes('jobposting')) return value;
  for (const child of Object.values(value)) {
    const found = findJobPosting(child, seen);
    if (found) return found;
  }
  return null;
}

/** Parse the first JobPosting object from JSON-LD script blocks. */
export function parseProtectasJobPostingJsonLd(html = '') {
  const blocks = [...String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    const raw = block[1].trim().replace(/^<!--|-->$/g, '').trim();
    try {
      const posting = findJobPosting(JSON.parse(raw));
      if (posting) return posting;
    } catch {
      // A malformed JSON-LD block must not make a valid later block unusable.
    }
  }
  return null;
}

function extractDescription(jsonLd, html) {
  const parts = [];
  const add = (label, value) => {
    const text = stripHtml(value || '');
    if (!text) return;
    const lower = text.toLowerCase();
    if (parts.some((part) => part.toLowerCase().includes(lower.slice(0, 60)))) return;
    parts.push(label ? `${label}:\n${text}` : text);
  };

  add('', jsonLd?.description);
  add('Responsabilità', jsonLd?.responsibilities);
  add('Requisiti', jsonLd?.qualifications);
  add('Vantaggi', jsonLd?.jobBenefits);
  if (parts.length === 0) add('', extractMainHtml(html));
  return parts.join('\n\n').trim();
}

function extractRequirements(jsonLd = {}) {
  return asArray(jsonLd.qualifications)
    .flatMap((value) => [...String(value || '').matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)])
    .map((match) => stripHtml(match[1]))
    .map(normalizeSpace)
    .filter((value) => value.length > 3);
}

/** Extract a physical address from a schema.org JobPosting object. */
export function extractProtectasLocation(jsonLd = {}) {
  for (const place of asArray(jsonLd.jobLocation)) {
    const address = Array.isArray(place?.address) ? place.address[0] : place?.address;
    if (typeof address === 'string') {
      const location = normalizeSpace(address);
      if (location) return { locality: location, postalCode: '', streetAddress: '', region: '', country: '' };
      continue;
    }
    if (!address || typeof address !== 'object') continue;
    const result = {
      locality: scalarText(address.addressLocality),
      postalCode: scalarText(address.postalCode),
      streetAddress: scalarText(address.streetAddress),
      region: scalarText(address.addressRegion),
      country: scalarText(address.addressCountry),
    };
    if (result.locality || result.postalCode || result.region) return result;
  }
  return { locality: '', postalCode: '', streetAddress: '', region: '', country: '' };
}

function resolveCanton(location) {
  return inferAnyCanton(location.locality)
    || inferAnyCanton(location.region)
    || inferAnyCanton(`${location.postalCode} ${location.locality}`)
    || inferAnyCanton(`${location.locality} ${location.region}`)
    || '';
}

function isSwissLocation(location) {
  const country = normalize(location.country);
  return !country || SWISS_COUNTRIES.has(country) || country === 'ch';
}

/** Parse and validate one official Protectas vacancy detail page. */
export function parseProtectasJobDetail(html = '', detailUrl = '') {
  const jsonLd = parseProtectasJobPostingJsonLd(html);
  if (!jsonLd) return null;

  const title = firstText(
    jsonLd.title,
    stripHtml(String(html).match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i)?.[0] || ''),
    stripHtml(readMetaContent(html, 'og:title')),
  );
  const location = extractProtectasLocation(jsonLd);
  const canton = resolveCanton(location);
  const description = extractDescription(jsonLd, html);
  if (!title || title.length < 3 || !description || description.length < 80) return null;
  if (!isSwissLocation(location) || canton !== PROTECTAS_TARGET_CANTON) return null;
  if (!isPhysicalSecurityVacancy(title, description)) return null;

  const jsonLdUrl = toProtectasUrl(jsonLd.url, detailUrl);
  const publicUrl = isVacancyUrl(jsonLdUrl) ? jsonLdUrl : detailUrl;
  if (!isVacancyUrl(publicUrl)) return null;

  const locationLabel = [location.locality, location.region].filter(Boolean).join(', ')
    || [location.postalCode, location.country].filter(Boolean).join(' ');
  return {
    title,
    description,
    location: locationLabel,
    canton,
    publicUrl,
    sourceLang: detectLang(description || title, 'it'),
    addressLocality: location.locality,
    addressRegion: location.region || canton,
    addressCountry: location.country || 'CH',
    postalCode: location.postalCode,
    streetAddress: location.streetAddress,
    postedAt: normalizeSpace(jsonLd.datePosted || '').slice(0, 10),
    validThrough: normalizeSpace(jsonLd.validThrough || '').slice(0, 10),
    employmentType: detectEmploymentType(jsonLd.employmentType || `${title} ${description}`),
    requirements: extractRequirements(jsonLd),
  };
}

async function fetchProtectasJobDetail(url) {
  const html = await fetchHtml(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'it-CH,it;q=0.9',
    },
  });
  return parseProtectasJobDetail(html, url);
}

function toParsedJob(detail) {
  const sourceLang = detail.sourceLang || 'it';
  const jobSlug = slugify(`${detail.title} ${detail.location} protectas ch`);
  const urlHash = createHash('sha1').update(detail.publicUrl).digest('hex').slice(0, 12);
  const description = detail.description;
  const postedDate = detail.postedAt || new Date().toISOString().slice(0, 10);

  return {
    id: `protectas-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: PROTECTAS_COMPANY_NAME,
    companyKey: PROTECTAS_KEY,
    companyDomain: PROTECTAS_COMPANY_DOMAIN,
    title: detail.title,
    titleByLocale: { [sourceLang]: detail.title },
    description,
    descriptionByLocale: { [sourceLang]: description },
    location: detail.location,
    canton: detail.canton,
    url: detail.publicUrl,
    source: 'Protectas SA Dedicated Parser',
    sourceLang,
    crawledAt: new Date().toISOString(),
    addressLocality: detail.addressLocality,
    addressRegion: detail.addressRegion,
    addressCountry: detail.addressCountry,
    country: detail.addressCountry,
    ...(detail.postalCode ? { postalCode: detail.postalCode } : {}),
    ...(detail.streetAddress ? { streetAddress: detail.streetAddress } : {}),
    category: detectCategory(detail.title),
    contract: detail.employmentType === 'PART_TIME'
      ? 'part-time'
      : detail.employmentType === 'FULL_TIME' ? 'full-time' : 'other',
    employmentType: detail.employmentType,
    experienceLevel: detectExperienceLevel(detail.title),
    sector: 'Sicurezza fisica',
    currency: 'CHF',
    featured: false,
    postedDate,
    ...(detail.validThrough ? { validThrough: detail.validThrough } : {}),
    applyUrl: detail.publicUrl,
    requirements: detail.requirements,
    requirementsByLocale: { [sourceLang]: detail.requirements },
  };
}

/**
 * Fetch all qualifying Protectas vacancies from the official source.
 * Source drift is fail-closed: an empty inventory or empty qualifying result
 * never silently deletes the existing crawler slice.
 */
export async function fetchAllProtectasJobs() {
  console.log('🔍 Fetching Protectas SA physical-security jobs');
  console.log(`   Source: ${PROTECTAS_CAREER_URL}\n`);

  const listings = await fetchJobListings();
  console.log(`  📋 Official vacancy links found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    try {
      const detail = await fetchProtectasJobDetail(listing.url);
      if (!detail) {
        console.warn(`  ⚠️ Skipping non-physical/non-TI or incomplete vacancy: ${listing.url}`);
        continue;
      }
      jobs.push(toParsedJob(detail));
    } catch (error) {
      console.warn(`  ⚠️ Protectas detail failed: ${listing.url} — ${error?.message || error}`);
    }
  }

  if (jobs.length === 0) {
    throw new Error('Protectas inventory yielded no complete physical-security vacancy in Ticino');
  }

  console.log(`\n📋 Total Protectas SA TI physical-security jobs discovered: ${jobs.length}`);
  return jobs;
}
