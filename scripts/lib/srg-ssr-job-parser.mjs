#!/usr/bin/env node
/**
 * SRG SSR job parser — HTML scraper + JSON-LD extractor.
 *
 * Source: https://jobs.srgssr.ch/
 *
 * The SRG SSR career portal is a server-side rendered page with no public
 * JSON API.  The crawler fetches the national HTML listing page (no canton
 * facet) and parses job card links.  For each job it
 * fetches the detail page and extracts the embedded JSON-LD JobPosting
 * schema, which contains title, description, qualifications, location,
 * employment type, posting date, etc.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSrgSsrJobs()  — Fetch and parse all jobs
 *   - isSrgSsrJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()     — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SRG_SSR_KEY = 'srg-ssr';
export const SRG_SSR_COMPANY_NAME = 'SRG SSR';
export const SRG_SSR_COMPANY_DOMAIN = 'srgssr.ch';

const CAREER_BASE = 'https://jobs.srgssr.ch';

/**
 * National listing — NO canton facet. SRG SSR is the national public
 * broadcaster (SRF Zürich/Basel, RTS Genève/Lausanne, RSI Lugano/Comano,
 * RTR Chur, SWI + HQ Bern, Biel/Bienne); the previous `filter_40=1137442`
 * (Wallis) facet returned ~0 jobs. Each job's real canton is inferred
 * per-record from its JSON-LD `jobLocation.address`.
 */
const LISTING_URL = `${CAREER_BASE}/?lang=de`;

/** Organisation code → human-readable sub-entity label. */
const ORG_LABELS = {
  srg: 'SRG SSR',
  srf: 'SRF',
  rts: 'RTS',
  rsi: 'RSI',
  rtr: 'RTR',
  swi: 'SWI swissinfo.ch',
  swistxt: 'SwisTXT',
};

const PUBLISHED_LOCALES = ['de', 'it', 'fr', 'en'];
const ROMANSH_DISTINCTIVE_MARKERS = [
  'emprendissadi',
  'fufragnadi',
  'infurmaziun',
  'pussaivlad',
  'spetgas',
  'cuntanschain',
];
const ROMANSH_IDENTITY_MARKERS = ['rumantsch'];
const ROMANSH_FUNCTION_MARKERS = ['ils', 'las', 'cun', 'nus', 'da', 'è'];

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function bodyTokens(value = '') {
  return new Set(String(value || '').toLowerCase().normalize('NFC').match(/\p{L}+/gu) || []);
}

function hasRomanshMarker(tokens, marker) {
  return [...tokens].some((token) => token === marker || token.startsWith(marker));
}

/**
 * Detect Romansh from the posting body only. Titles such as «Praticanta /
 * praticant» are too short and too close to Italian to be evidence. The
 * strong markers are distinctive compounds; the function-word markers only
 * corroborate them (or need four independent hits on their own), so ordinary
 * Italian prose containing «da»/«è» is not reclassified.
 */
export function detectSrgSsrBodyLanguage(description = '', fallback = 'de') {
  const tokens = bodyTokens(description);
  const distinctiveHits = ROMANSH_DISTINCTIVE_MARKERS.filter((marker) => hasRomanshMarker(tokens, marker)).length;
  const identityHits = ROMANSH_IDENTITY_MARKERS.filter((marker) => hasRomanshMarker(tokens, marker)).length;
  const functionHits = ROMANSH_FUNCTION_MARKERS.filter((marker) => tokens.has(marker)).length;
  if (distinctiveHits >= 2 || (distinctiveHits >= 1 && functionHits >= 1)
      || (identityHits >= 1 && functionHits >= 3) || functionHits >= 4) return 'rm';
  return detectLang(description, fallback);
}

/**
 * Prefer a same-ID localized body when the source exposed one. The current
 * RTR pages do not expose such a sibling (the `lang` query parameter changes
 * neither the body nor the JSON-LD), so an unpaired Romansh body remains an
 * explicitly declared `rm` source and is queued for LLM translation.
 */
export function resolveSrgSsrSourceLang({ description = '', localizedDescriptions = {}, fallback = 'de' } = {}) {
  for (const locale of PUBLISHED_LOCALES) {
    if (String(localizedDescriptions?.[locale] || '').trim()) return locale;
  }
  return detectSrgSsrBodyLanguage(description, fallback);
}

/**
 * Decode common HTML entities that appear in JSON-LD text content.
 */
function decodeEntities(value = '') {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#43;/g, '+')
    .replace(/&#8217;/g, '\u2019')
    .replace(/&#8211;/g, '\u2013');
}

/**
 * Convert HTML to plain text (for JSON-LD description fields).
 */
function htmlToText(html = '') {
  return normalizeSpace(
    decodeEntities(
      String(html || '')
        .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/(?:p|div|li|h[1-6]|ul|ol)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\u00a0/g, ' ')
        .replace(/\n{3,}/g, '\n\n'),
    ),
  );
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to SRG SSR.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSrgSsrJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SRG_SSR_KEY ||
    key.startsWith('srg-ssr') ||
    company.includes('srg ssr') ||
    url.includes('srgssr.ch')
  );
}

/**
 * Validate that a URL belongs to SRG SSR's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'srgssr.ch' || host.endsWith('.srgssr.ch');
  } catch {
    return false;
  }
}

export function isRtrJob(job) {
  return normalize(job?.url || '').includes('jobs.srgssr.ch/rtr/')
    || normalize(job?._srgMeta?.org || '') === 'rtr';
}

function normalizeComparableText(value = '') {
  return normalizeSpace(value).toLowerCase();
}

/**
 * Repair historical RTR rows whose Romansh body was stored as Italian/French.
 * Text slots that are still the source body are removed; translated slots are
 * retained for the LLM repair queue. Slugs are deliberately untouched.
 */
export function prepareSrgSsrExistingJobs(jobs) {
  if (!Array.isArray(jobs)) return jobs;
  return jobs.map((job) => {
    if (!job || !isRtrJob(job)) return job;
    const descriptions = job.descriptionByLocale && typeof job.descriptionByLocale === 'object'
      ? job.descriptionByLocale
      : {};
    const sourceBody = [job.description, ...Object.values(descriptions)]
      .map((value) => String(value || '').trim())
      .find((value) => detectSrgSsrBodyLanguage(value, 'de') === 'rm');
    if (!sourceBody) return job;

    const title = String(job.title || '').trim();
    const titleByLocale = job.titleByLocale && typeof job.titleByLocale === 'object'
      ? { ...job.titleByLocale }
      : {};
    for (const locale of PUBLISHED_LOCALES) {
      if (normalizeComparableText(titleByLocale[locale]) === normalizeComparableText(title)) {
        delete titleByLocale[locale];
      }
    }
    if (title) titleByLocale.rm = title;

    const descriptionByLocale = { ...descriptions };
    for (const locale of PUBLISHED_LOCALES) {
      const value = String(descriptionByLocale[locale] || '').trim();
      if (value && detectSrgSsrBodyLanguage(value, 'de') === 'rm') delete descriptionByLocale[locale];
    }
    descriptionByLocale.rm = sourceBody;

    const slugByLocale = job.slugByLocale && typeof job.slugByLocale === 'object'
      ? { ...job.slugByLocale }
      : {};
    const sourceSlug = String(slugByLocale.rm || job.slug || slugByLocale.it || '').trim();
    if (sourceSlug) slugByLocale.rm = sourceSlug;

    return {
      ...job,
      sourceLang: 'rm',
      sourceLangOriginal: 'rm',
      description: sourceBody,
      titleByLocale,
      descriptionByLocale,
      slugByLocale,
      needsRetranslation: true,
    };
  });
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '', description = '') {
  const t = normalize(`${title} ${description}`);
  if (/\b(journalist|redakt|moderator|reporter|correspondant|korrespondent)/.test(t)) return 'Media / Giornalismo';
  if (/\b(produz|producer|produktion|production|regisseur|réalisat)/.test(t)) return 'Produzione Media';
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|ton|kamera|camera)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account|assistente|assistant|assistent)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it\b|software|develop|programm|devops|data|product.manager)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|berater)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|kommunikation|communication)/.test(t)) return 'Marketing / Comunicazione';
  if (/\b(finanz|finance|financ|controller|controlling)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht|jurist)/.test(t)) return 'Legale';
  if (/\b(sicherheit|security|securit)/.test(t)) return 'Sicurezza';
  return 'Media';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti|praticant)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Parse employment percentage from info line, e.g. "80-100%" or "70%".
 */
function parseEmploymentPct(infoLine = '') {
  const m = String(infoLine || '').match(/(\d+)\s*[-–]\s*(\d+)\s*%/);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  const single = String(infoLine || '').match(/(\d+)\s*%/);
  if (single) return { min: Number(single[1]), max: Number(single[1]) };
  return null;
}

function deriveEmploymentType(pct) {
  if (!pct) return 'OTHER';
  if (pct.max >= 80) return 'FULL_TIME';
  return 'PART_TIME';
}

/* ── HTTP Client ───────────────────────────────────────────── */

/**
 * Fetch a URL and return the response body as text.
 */
async function fetchPage(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-CH,de;q=0.9',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ── Listing page parser ───────────────────────────────────── */

/**
 * Parse the listing page HTML and extract unique job URLs.
 * Job links follow the pattern:
 *   https://jobs.srgssr.ch/{org}/offene-stellen/{slug}/{uuid}
 *
 * Also extracts the info line (percentage + location) and description
 * snippet from the surrounding HTML for each card.
 */
function parseListingHtml(html = '') {
  const jobUrlPattern = /https:\/\/jobs\.srgssr\.ch\/([a-z]+)\/offene-stellen\/([a-z0-9-]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
  const seen = new Set();
  const listings = [];

  let match;
  while ((match = jobUrlPattern.exec(html)) !== null) {
    const fullUrl = match[0];
    const org = match[1];
    const urlSlug = match[2];
    const uuid = match[3];

    if (seen.has(uuid)) continue;
    seen.add(uuid);

    // Extract info from the surrounding HTML context
    const contextStart = Math.max(0, match.index - 200);
    const contextEnd = Math.min(html.length, match.index + fullUrl.length + 800);
    const context = html.substring(contextStart, contextEnd);

    // Extract title from <h1> within the card
    const titleMatch = context.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    const title = titleMatch ? normalizeSpace(decodeEntities(titleMatch[1])) : '';

    // Extract info line (after </a></div> comes <small>)
    const smallMatch = context.match(/<small[^>]*>([^<]+)<\/small>/i);
    const infoLine = smallMatch ? normalizeSpace(decodeEntities(smallMatch[1])) : '';

    // Extract description snippet from <p>
    const pMatch = context.match(/<p[^>]*>([^<]{10,})<\/p>/i);
    const snippet = pMatch ? normalizeSpace(decodeEntities(pMatch[1])) : '';

    listings.push({ url: fullUrl, org, urlSlug, uuid, title, infoLine, snippet });
  }

  return listings;
}

/* ── Detail page parser (JSON-LD) ──────────────────────────── */

/**
 * Extract the JobPosting JSON-LD from a detail page's HTML.
 */
function extractJsonLd(html = '') {
  const pattern = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    try {
      const payload = JSON.parse(match[1]);
      if (payload && payload['@type'] === 'JobPosting') return payload;
    } catch { /* skip malformed JSON-LD */ }
  }
  return null;
}

/**
 * Inner HTML of the detail template's `<section id="…">`, or ''. The
 * Prospective template does not nest sections, so the first closing tag ends it.
 */
function templateSectionHtml(html = '', id = '') {
  const match = new RegExp(`<section\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/section>`, 'i').exec(html);
  return match ? match[1] : '';
}

/**
 * The vacancy as the detail page renders it: `#introduction` (the unit's
 * paragraph) and `#specifications` (tasks, profile, and the `.enthusiasm`
 * block), headings kept as `##` lines and `<li>`/`<br>` as line breaks.
 *
 * The JSON-LD `description` is not the whole ad on every unit: on RTR it
 * carries only tasks + profile + a contact stub, and misses the introduction
 * and the «Per infurmaziun» block the page shows
 * (…/rtr/offene-stellen/fufragnadi-emprendissadi-da-prova/b6e22b31-…:
 * 476 published characters, issue 5253). The offer block `#benefits`
 * («Unser Versprechen» / «Nossa purschida»: teaser + the four benefits) is
 * part of the ad too and closes it (see srgSsrBenefitsText). Contact,
 * employee quote (`#slogan`) and «similar jobs» stay out.
 *
 * @param {string} html
 * @returns {string} '' when the template sections are absent
 */
export function extractSrgSsrRenderedDescription(html = '') {
  const parts = ['introduction', 'specifications']
    .map((id) => templateSectionHtml(html, id))
    .filter(Boolean)
    .map((section) => decodeEntities(stripHtml(
      section.replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, heading) => {
        const text = normalizeSpace(heading.replace(/<[^>]+>/g, ' '));
        return text ? `\n\n## ${text}\n` : '';
      }),
    )))
    .map((text) => text.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim())
    .filter(Boolean);
  const benefits = srgSsrBenefitsText(html);
  if (benefits) parts.push(benefits);
  if (!parts.length) return '';
  return parts.join('\n\n').trim();
}

/**
 * The offer block of the detail template, `<section id="benefits">`: its
 * heading, the teaser, and each benefit as `- <title>: <text>`. Each text is
 * read once from its `p.benefit-N.content`; the same text is repeated as the
 * tooltip `<title>` of the benefit's SVG icon, which is not page text.
 *
 * @param {string} html
 * @returns {string} '' when the section or its benefits are absent
 */
export function srgSsrBenefitsText(html = '') {
  const section = templateSectionHtml(html, 'benefits').replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
  if (!section) return '';
  const text = (fragment = '') => normalizeSpace(decodeEntities(stripHtml(fragment)));
  const heading = text(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(section)?.[1] || '');
  const teaser = text(/<div\b[^>]*\bclass=["'][^"']*\bteaser\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(section)?.[1] || '');
  const titles = new Map();
  for (const m of section.matchAll(/<a\b[^>]*\bclass=["'][^"']*\bbenefit\b[^"']*["'][^>]*>/gi)) {
    const n = /\bdata-benefit=["'](\d+)["']/i.exec(m[0])?.[1];
    const title = /\btitle=["']([^"']*)["']/i.exec(m[0])?.[1];
    if (n && title) titles.set(n, text(title));
  }
  const items = [];
  for (const m of section.matchAll(/<p\b[^>]*\bclass=["'][^"']*\bbenefit-(\d+)\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi)) {
    const body = text(m[2]);
    if (!body) continue;
    const title = titles.get(m[1]);
    items.push(`- ${title ? `${title}: ` : ''}${body}`);
  }
  if (!teaser && !items.length) return '';
  return [heading ? `## ${heading}` : '', teaser, items.join('\n')].filter(Boolean).join('\n');
}

/**
 * Build a structured description from JSON-LD fields.
 */
function buildDescription(jsonLd) {
  const parts = [];

  if (jsonLd.description) {
    const descText = htmlToText(jsonLd.description);
    if (descText) parts.push(descText);
  }

  // If the description already contains everything, skip separate sections
  if (parts.length === 0) {
    if (jsonLd.responsibilities) {
      const resp = htmlToText(jsonLd.responsibilities);
      if (resp) parts.push(`Mansioni:\n${resp}`);
    }
    if (jsonLd.qualifications) {
      const qual = htmlToText(jsonLd.qualifications);
      if (qual) parts.push(`Requisiti:\n${qual}`);
    }
  }

  return parts.join('\n\n').trim();
}

/**
 * Extract requirements bullet points from JSON-LD qualifications.
 */
function extractRequirements(jsonLd) {
  if (!jsonLd?.qualifications) return [];
  const html = String(jsonLd.qualifications);
  const items = [];
  const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liPattern.exec(html)) !== null) {
    const text = normalizeSpace(htmlToText(m[1]));
    if (text && text.length > 3) items.push(text);
  }
  return items;
}

/* ── Main fetch function ───────────────────────────────────── */

/**
 * Fetch all SRG SSR jobs (national, all cantons) from the career portal.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSrgSsrJobs() {
  console.log(`🔍 Fetching SRG SSR jobs (national, all cantons)`);
  console.log(`   Source: ${LISTING_URL}\n`);

  // Step 1: Fetch the national listing page (all cantons)
  const listingHtml = await fetchPage(LISTING_URL);
  const listings = parseListingHtml(listingHtml);

  if (listings.length === 0) {
    console.warn('⚠️  No job listings found on the career page.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  // Step 2: Fetch detail page for each job to get JSON-LD
  const jobs = [];
  for (const listing of listings) {
    try {
      console.log(`  📄 Fetching detail: ${listing.title || listing.urlSlug}`);
      const detailHtml = await fetchPage(listing.url);
      const jsonLd = extractJsonLd(detailHtml);

      const title = normalizeSpace(jsonLd?.title || listing.title || '');
      if (!title || title.length < 3) {
        console.warn(`  ⚠️  Skipping job with empty title: ${listing.url}`);
        continue;
      }

      // Location: prefer JSON-LD, fall back to listing info line
      const jlAddress = jsonLd?.jobLocation?.address || {};
      const addressLocality = normalizeSpace(jlAddress.addressLocality || '');
      const infoLineParts = (listing.infoLine || '').split(',').map(s => s.trim());
      const locationFromInfo = infoLineParts.length > 1 ? infoLineParts.slice(1).join(', ') : '';
      const location = addressLocality || locationFromInfo || '';
      const canton = inferAnyCanton(location) || '';
      const postalCode = String(jlAddress.postalCode || '').trim() || '';
      const streetAddress = normalizeSpace(jlAddress.streetAddress || '');

      // Description: the rendered ad (introduction + specifications); the
      // JSON-LD body only when the template sections are missing.
      const rendered = extractSrgSsrRenderedDescription(detailHtml);
      const description = (rendered.split(/\s+/).length >= 30 ? rendered : '')
        || buildDescription(jsonLd || {}) || listing.snippet || `${title} — SRG SSR`;

      // Employment type from JSON-LD or percentage parsing
      const pct = parseEmploymentPct(listing.infoLine);
      const employmentTypeRaw = String(jsonLd?.employmentType || '').trim();
      const employmentType = employmentTypeRaw || deriveEmploymentType(pct);

      // Source language detection
      const sourceLang = resolveSrgSsrSourceLang({ description });
      const sourceLocaleFields = sourceLang === 'rm'
        ? { sourceLangOriginal: 'rm', needsRetranslation: true }
        : {};

      // Posting date from JSON-LD
      const datePosted = String(jsonLd?.datePosted || '').trim() ||
        new Date().toISOString().slice(0, 10);

      // Slug and ID
      const jobSlug = slugify(`${title} srg-ssr ${location}`);
      const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);

      // Organisation sub-entity
      const orgLabel = ORG_LABELS[listing.org] || SRG_SSR_COMPANY_NAME;

      // Requirements from qualifications
      const requirements = extractRequirements(jsonLd);

      const job = {
        // ── Required fields ──
        id: `srg-ssr-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: SRG_SSR_COMPANY_NAME,
        companyKey: SRG_SSR_KEY,
        companyDomain: SRG_SSR_COMPANY_DOMAIN,
        title,
        titleByLocale: { [sourceLang]: title },
        description,
        descriptionByLocale: { [sourceLang]: description },
        location,
        canton,
        url: listing.url,
        source: 'SRG SSR Dedicated Parser',
        sourceLang,
        ...sourceLocaleFields,
        crawledAt: new Date().toISOString(),

        // ── Recommended fields ──
        addressLocality: location,
        addressCountry: 'CH',
        country: 'CH',
        ...(postalCode && { postalCode }),
        ...(streetAddress && { streetAddress }),
        category: detectCategory(title, description),
        contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
        employmentType,
        experienceLevel: detectExperienceLevel(title),
        sector: 'Media / Broadcasting',
        currency: 'CHF',
        featured: false,
        postedDate: datePosted,
        applyUrl: listing.url,
        requirements,
        requirementsByLocale: { [sourceLang]: requirements },
        _srgMeta: {
          uuid: listing.uuid,
          org: listing.org,
          orgLabel,
          ...(pct && { pensumMin: pct.min, pensumMax: pct.max }),
        },
      };

      jobs.push(job);
      console.log(`  ✅ ${title.substring(0, 60)} (${location})`);
    } catch (err) {
      console.warn(`  ⚠️  Skipping ${listing.urlSlug}: ${err?.message || err}`);
    }

    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  // Deduplicate by URL
  const seen = new Set();
  const deduped = [];
  for (const job of jobs) {
    const key = job.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(job);
  }

  console.log(`\n📋 Total SRG SSR Valais jobs discovered: ${deduped.length}`);
  return deduped;
}
