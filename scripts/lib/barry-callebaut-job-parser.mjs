#!/usr/bin/env node
/**
 * Barry Callebaut job parser — Fetcher and job builder.
 *
 * Source: https://jobs.barry-callebaut.com
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBarryCallebautJobs()  — Fetch and parse all jobs
 *   - isBarryCallebautJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { decodeHtmlEntities } from './decode-html-entities.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BARRY_CALLEBAUT_KEY = 'barry-callebaut';
export const BARRY_CALLEBAUT_COMPANY_NAME = 'Barry Callebaut';
export const BARRY_CALLEBAUT_COMPANY_DOMAIN = 'barry-callebaut.com';

const CAREER_URL = 'https://jobs.barry-callebaut.com';

// Barry Callebaut runs SAP SuccessFactors Career Site Builder (jobs2web) on a
// fully custom domain (jobs.barry-callebaut.com). Two reasons this does NOT
// go through the shared `ats-clients/successfactors-client.mjs`:
//  1. Its `detectSuccessFactorsKind()` host allowlist doesn't recognise this
//     domain (would return null → zero jobs).
//  2. Its generic jobs2web table-row parser assumes a Title|Department|
//     Location|Date column order; this tenant's `/search/` table is
//     Title|Location|Department (no Date column) — wiring it in would
//     silently swap location↔department instead of failing loudly.
// The site DOES expose a public Google-Jobs-style RSS/XML feed with every
// open requisition (title, full HTML description, canonical link,
// g:location, g:job_function) — confirmed live: 170 items total, 8 in
// Zurich (ZH). That feed is far more reliable than scraping the paginated
// HTML table, so we fetch it directly instead.
const FEED_URL = 'https://jobs.barry-callebaut.com/sitemap.xml';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Barry Callebaut's global feed returns jobs from every country it operates
 * in; filter client-side for Switzerland.
 */
function isSwissLocation(locationText = '') {
  const loc = normalize(locationText);
  return (
    loc.includes('switzerland') ||
    loc.includes('schweiz') ||
    loc.includes('suisse') ||
    loc.includes('svizzera') ||
    loc.includes(', ch,') ||
    loc.endsWith(', ch') ||
    loc.includes('zurich') ||
    loc.includes('zürich') ||
    loc.includes('zug') ||
    loc.includes('basel') ||
    loc.includes('bern') ||
    loc.includes('geneva') ||
    loc.includes('genève') ||
    loc.includes('lausanne') ||
    loc.includes('lugano')
  );
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Barry Callebaut.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBarryCallebautJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === BARRY_CALLEBAUT_KEY ||
    key.startsWith('barry-callebaut') ||
    company.includes('barry callebaut') ||
    url.includes('barry-callebaut.com')
  );
}

/**
 * Validate that a URL belongs to Barry Callebaut's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'barry-callebaut.com' || host.endsWith('.barry-callebaut.com');
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
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
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── RSS feed fetcher ─────────────────────────────────────────
 * Parses the jobs2web Google-Jobs-style feed. Each <item> looks like:
 *   <item>
 *     <title>Sales support (Mexico City, MX, 11250)</title>
 *     <description><![CDATA[&lt;p&gt;...HTML (double entity-encoded)...&lt;/p&gt;]]></description>
 *     <link>https://jobs.barry-callebaut.com/job/Mexico-City-Sales-support-11250/1403328200/</link>
 *     <guid isPermaLink="false">1403328200</guid>
 *     <g:id>1403328200</g:id>
 *     <g:expiration_date>2026-08-02</g:expiration_date>
 *     <g:employer>Barry Callebaut </g:employer>
 *     <g:job_function>Sales and Commercial</g:job_function>
 *     <g:location>Mexico City, MX, 11250</g:location>
 *   </item>
 * Title carries the location suffix `(City, Country, Zip)` — stripped below
 * since `g:location` already carries it cleanly.
 */
function extractTag(itemXml, tag) {
  const m = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : '';
}

function extractCdataOrText(itemXml, tag) {
  const cdata = itemXml.match(
    new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i')
  );
  if (cdata) return cdata[1];
  return extractTag(itemXml, tag);
}

function parseFeedItems(xml = '') {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const itemXml = m[1];
    const rawTitle = decodeHtmlEntities(normalizeSpace(extractCdataOrText(itemXml, 'title')));
    const title = rawTitle.replace(/\s*\([^()]*\)\s*$/, '').trim() || rawTitle;
    const descriptionHtml = decodeHtmlEntities(extractCdataOrText(itemXml, 'description'));
    const url = normalizeSpace(extractTag(itemXml, 'link'));
    const jobId = normalizeSpace(extractTag(itemXml, 'g:id')) || normalizeSpace(extractTag(itemXml, 'guid'));
    const location = decodeHtmlEntities(normalizeSpace(extractTag(itemXml, 'g:location')));
    const jobFunction = decodeHtmlEntities(normalizeSpace(extractTag(itemXml, 'g:job_function')));
    if (!title || !url) continue;
    items.push({ title, descriptionHtml, url, jobId, location, jobFunction });
  }
  return items;
}

async function fetchJobListings() {
  const xml = await fetchHtml(FEED_URL, { headers: { Accept: 'application/rss+xml,text/xml,*/*' } });
  const all = parseFeedItems(xml);
  return all.filter((job) => isSwissLocation(job.location));
}

/**
 * Fetch all Barry Callebaut jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllBarryCallebautJobs() {
  console.log(`🔍 Fetching Barry Callebaut jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    // `g:location` format: "Zurich, CH, 8005" — city is the first segment.
    const locationCity = (listing.location || '').split(',')[0].trim() || 'Zurich';
    const canton = inferSwissTargetCanton(listing.location) || 'ZH';
    const descriptionHtml = listing.descriptionHtml || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} barry-callebaut ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `barry-callebaut-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BARRY_CALLEBAUT_COMPANY_NAME,
      companyKey: BARRY_CALLEBAUT_KEY,
      companyDomain: BARRY_CALLEBAUT_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Barry Callebaut`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Barry Callebaut` },
      location: locationCity,
      canton,
      url: publicUrl,
      source: 'Barry Callebaut Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: locationCity,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(listing.jobFunction || title),
      contract: 'full-time',
      employmentType: detectEmploymentType(title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Alimentare', // Global chocolate/cocoa manufacturer
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Barry Callebaut jobs discovered: ${jobs.length}`);
  return jobs;
}
