#!/usr/bin/env node
/**
 * Universitäts-Kinderspital beider Basel (UKBB) — dedicated job parser.
 *
 * Public career site: https://jobs.ukbb.ch/
 *
 * UKBB's career portal is powered by Concludis / my-job-shop.com (CareerRevolution).
 * The listing UI is fully JS-rendered (Nuxt + Typesense), so we cannot scrape
 * the home page directly. Instead we read the SEO sitemap, which always lists
 * every active offer:
 *
 *   https://jobs.ukbb.ch/sitemap.xml
 *     → <loc>https://jobs.ukbb.ch/offer/{slug}/{uuid}</loc>
 *
 * Each `offer/{slug}/{uuid}` page is SSR'd with a complete JSON-LD JobPosting
 * payload embedded inside `<script type="application/ld+json">`:
 *
 *   {"@context":"https://schema.org","@type":"JobPosting",
 *    "title":"...", "description":"...", "datePosted":"...",
 *    "jobLocation":{...}, "hiringOrganization":{...}, "employmentType":"...", ...}
 *
 * We fetch the sitemap → filter `/offer/` URLs → fetch each detail page →
 * extract the JSON-LD JobPosting object. This is robust against template
 * changes because we lean on schema.org rather than DOM scraping.
 *
 * UKBB is the cantonal paediatric university hospital in Basel (BS), ~1'500
 * staff, ≈20 active offers at any time. Its workforce includes frontaliere
 * commuters from neighbouring departements (Haut-Rhin, Sundgau) — relevant
 * for our IT audience.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const UKBB_KEY = 'ukbb';
export const UKBB_COMPANY_NAME = 'Universitäts-Kinderspital beider Basel';
export const UKBB_COMPANY_DOMAIN = 'ukbb.ch';

const SITEMAP_URL = 'https://jobs.ukbb.ch/sitemap.xml';
const DETAIL_DELAY_MS = 250;
const POSTAL_CODE_BASEL = '4056'; // UKBB main campus, Spitalstrasse 33
const STREET_ADDRESS = 'Spitalstrasse 33';

/* ── Company matchers ──────────────────────────────────────── */

export function isUkbbJob(job) {
  const url = String(job?.url || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const key = String(job?.companyKey || '').toLowerCase();
  return (
    key === UKBB_KEY ||
    url.includes('jobs.ukbb.ch') ||
    url.includes('ukbb.ch') ||
    company.includes('kinderspital beider basel') ||
    company.includes('ukbb')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'ukbb.ch' || host.endsWith('.ukbb.ch');
  } catch {
    return false;
  }
}

/* ── Sitemap + JSON-LD extraction ──────────────────────────── */

export function parseSitemapOfferUrls(xml = '') {
  const out = [];
  const seen = new Set();
  const rx = /<loc>(https:\/\/jobs\.ukbb\.ch\/offer\/[^<]+)<\/loc>/g;
  let m;
  while ((m = rx.exec(xml))) {
    const url = decodeEntities(m[1].trim());
    // canonical UUID lives at the tail of the URL
    const uuid = (url.match(/\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:[/?#]|$)/i) || [])[1];
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);
    out.push({ url, uuid });
  }
  return out;
}

/**
 * Extract the first JobPosting JSON-LD object embedded in an offer page.
 * Returns the parsed JSON object or `null`.
 */
export function extractJobPostingLd(html = '') {
  const rx = /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html))) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw);
      // The portal sometimes emits a @graph array
      const candidates = Array.isArray(obj?.['@graph']) ? obj['@graph'] : [obj];
      for (const c of candidates) {
        if (c?.['@type'] === 'JobPosting') return c;
      }
    } catch {
      // ignore non-JSON or partial JSON-LD blocks
    }
  }
  return null;
}

function unescapeLooseHtml(s = '') {
  // JSON-LD bodies on this portal contain `<` already decoded by JSON.parse
  // plus literal `\n` and `<br>` tags. Flatten to clean text.
  return htmlToText(String(s));
}

function pickEmploymentType(rawType, fallbackText) {
  if (typeof rawType === 'string' && rawType.trim()) {
    const t = rawType.toUpperCase();
    if (t.includes('FULL')) return 'full-time';
    if (t.includes('PART')) return 'part-time';
    if (t.includes('TEMP') || t.includes('CONTRACT')) return 'temporary';
    if (t.includes('INTERN')) return 'internship';
  }
  if (Array.isArray(rawType) && rawType.length) {
    return pickEmploymentType(rawType[0], fallbackText);
  }
  return detectHealthcareEmploymentType(fallbackText || '');
}

function pickLocation(jobLocation) {
  if (!jobLocation) return { city: 'Basel', postalCode: POSTAL_CODE_BASEL, street: STREET_ADDRESS };
  const loc = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
  const addr = loc?.address || loc || {};
  return {
    city: normalizeSpace(decodeEntities(addr.addressLocality || 'Basel')),
    postalCode: normalizeSpace(decodeEntities(addr.postalCode || POSTAL_CODE_BASEL)),
    street: normalizeSpace(decodeEntities(addr.streetAddress || STREET_ADDRESS)),
  };
}

function pickPostedDate(raw) {
  const s = typeof raw === 'string' ? raw.slice(0, 10) : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return new Date().toISOString().slice(0, 10);
}

/* ── Main entry ────────────────────────────────────────────── */

export async function fetchAllUkbbJobs() {
  console.log(`🏥 Fetching ${UKBB_COMPANY_NAME} jobs`);
  console.log(`   Source: ${SITEMAP_URL} → per-offer JSON-LD JobPosting\n`);

  let xml = '';
  try {
    xml = await fetchHtml(SITEMAP_URL);
  } catch (err) {
    console.warn(`  ⚠️ UKBB sitemap fetch failed: ${err?.message || err}. Returning [].`);
    return [];
  }

  const offers = parseSitemapOfferUrls(xml);
  console.log(`  ✓ Sitemap lists ${offers.length} offer URLs`);
  if (!offers.length) return [];

  const jobs = [];
  let ldHits = 0;
  for (let i = 0; i < offers.length; i += 1) {
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    const { url, uuid } = offers[i];

    let html = '';
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed (${url}): ${err?.message || err}`);
      continue;
    }
    const ld = extractJobPostingLd(html);
    if (!ld) {
      console.warn(`  ⚠️ No JobPosting JSON-LD on ${url}`);
      continue;
    }
    ldHits += 1;

    const title = normalizeSpace(decodeEntities(ld.title || ''));
    if (!title || title.length < 3) continue;
    // Skip non-job entries (unsolicited applications + pool-closed placeholders).
    // The portal sometimes lists a notice page as if it were a JobPosting.
    if (/^initiativbewerbung\b/i.test(title)) continue;
    if (title.length > 80 && /vielen dank|job-abo|momentan|im moment/i.test(title)) continue;

    const description = unescapeLooseHtml(ld.description || '');
    const safeDescription = description && description.split(/\s+/).length >= 30
      ? description
      : `${title} — ${UKBB_COMPANY_NAME}, Basel.\n\n${description || ''}`.trim();

    const loc = pickLocation(ld.jobLocation);
    const employmentType = pickEmploymentType(ld.employmentType, `${title} ${description}`);
    const sourceLang = detectLang(safeDescription || title, 'de');
    const jobSlug = slugify(`${title} ${UKBB_KEY} ${loc.city}`);
    const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${UKBB_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: UKBB_COMPANY_NAME,
      companyKey: UKBB_KEY,
      companyDomain: UKBB_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: safeDescription,
      descriptionByLocale: { [sourceLang]: safeDescription },
      // Source-locale-only payload. Shared AI-localize step clears the flag
      // when it fills IT/EN/FR; if it can't, translate-pending picks it up.
      needsRetranslation: true,
      location: loc.city,
      canton: 'BS',
      url,
      source: 'UKBB Dedicated Parser (sitemap + JSON-LD)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: loc.city,
      addressRegion: 'BS',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: loc.postalCode || POSTAL_CODE_BASEL,
      streetAddress: loc.street || STREET_ADDRESS,
      category: detectHealthcareCategory(`${title} ${safeDescription}`),
      contract: employmentType === 'temporary' ? 'temporary' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: pickPostedDate(ld.datePosted),
      applyUrl: url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${UKBB_COMPANY_NAME} jobs discovered: ${jobs.length} (${ldHits}/${offers.length} with rich JSON-LD)`);
  return jobs;
}
