#!/usr/bin/env node
/**
 * SRG SSR job parser — HTML scraper + JSON-LD extractor.
 *
 * Source: https://jobs.srgssr.ch/
 *
 * The SRG SSR career portal is a server-side rendered page with no public
 * JSON API.  The crawler fetches the HTML listing page (filtered by
 * canton Wallis, id 1137442) and parses job card links.  For each job it
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
 * Canton filter IDs used by the career portal's server-side form.
 * filter_40 = Kanton select.  1137442 = Wallis.
 */
const WALLIS_FILTER_ID = '1137442';
const LISTING_URL = `${CAREER_BASE}/?lang=de&filter_40=${WALLIS_FILTER_ID}`;

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

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
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
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|praticant)/.test(t)) return 'intern';
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
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
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
 * Fetch all SRG SSR Valais jobs from the career portal.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSrgSsrJobs() {
  console.log(`🔍 Fetching SRG SSR jobs (Wallis filter)`);
  console.log(`   Source: ${LISTING_URL}\n`);

  // Step 1: Fetch the Wallis-filtered listing page
  const listingHtml = await fetchPage(LISTING_URL);
  const listings = parseListingHtml(listingHtml);

  if (listings.length === 0) {
    console.warn('⚠️  No Wallis job listings found on the career page.');
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
      const location = addressLocality || locationFromInfo || 'Valais';
      const canton = inferAnyCanton(location) || 'VS';
      const postalCode = String(jlAddress.postalCode || '').trim() || '';
      const streetAddress = normalizeSpace(jlAddress.streetAddress || '');

      // Description from JSON-LD
      const description = buildDescription(jsonLd || {}) || listing.snippet || `${title} — SRG SSR`;

      // Employment type from JSON-LD or percentage parsing
      const pct = parseEmploymentPct(listing.infoLine);
      const employmentTypeRaw = String(jsonLd?.employmentType || '').trim();
      const employmentType = employmentTypeRaw || deriveEmploymentType(pct);

      // Source language detection
      const sourceLang = detectLang(description || title, 'de');

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
