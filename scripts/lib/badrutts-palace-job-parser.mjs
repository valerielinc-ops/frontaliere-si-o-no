#!/usr/bin/env node
/**
 * Badrutt's Palace Hotel job parser — Teamtailor RSS feed.
 *
 * Source: https://jobs.badruttscareers.com/en-GB/jobs.rss
 *
 * Badrutt's Palace Hotel is a luxury hotel in St. Moritz, Graubünden.
 * Their career portal runs on Teamtailor, which provides an RSS feed
 * with all active job listings. Each <item> contains title, link,
 * description (HTML), and pubDate.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllBadruttsPalaceJobs()  — Fetch and parse all jobs
 *   - isBadruttsPalaceJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()             — Validate URLs belong to this company
 *   - parseRssItems()               — Parse RSS XML into structured items (exported for testing)
 */
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const BADRUTTS_PALACE_KEY = 'badrutts-palace';
export const BADRUTTS_PALACE_COMPANY_NAME = "Badrutt's Palace Hotel";
export const BADRUTTS_PALACE_COMPANY_DOMAIN = 'badruttscareers.com';

const CAREER_URL = 'https://jobs.badruttscareers.com/en-GB/jobs.rss';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Default Location ─────────────────────────────────────── */

const DEFAULT_LOCATION = 'St. Moritz';
const DEFAULT_CANTON = 'GR';
const DEFAULT_POSTAL_CODE = '7500';

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Badrutt's Palace Hotel.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isBadruttsPalaceJob(job) {
  const key = String(job?.companyKey || job?.company || '')
    .trim().toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();

  return (
    key === BADRUTTS_PALACE_KEY ||
    key.startsWith('badrutts-palace') ||
    company.includes("badrutt's palace") ||
    company.includes('badrutts palace') ||
    url.includes('badruttscareers.com') ||
    url.includes('badruttspalace.com')
  );
}

/**
 * Validate that a URL belongs to Badrutt's Palace Hotel's domain.
 * Trusts both the Teamtailor-powered careers subdomain and teamtailor.com itself.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'badruttscareers.com' ||
      host.endsWith('.badruttscareers.com') ||
      host === 'badruttspalace.com' ||
      host.endsWith('.badruttspalace.com') ||
      host === 'teamtailor.com' ||
      host.endsWith('.teamtailor.com')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

/**
 * Detect job category from title — tuned for luxury hotel roles.
 */
function detectCategory(title = '') {
  const t = String(title || '').toLowerCase();

  // Kitchen / Culinary
  if (/\b(chef|cook|kitchen|culinary|pastry|bäcker|küche|cuisine|pâtissier|commis|demi.?chef|sous.?chef)\b/.test(t)) return 'Ristorazione';
  // F&B / Bar / Service
  if (/\b(barman|barmaid|bartender|sommelier|waiter|waitress|f\s*&\s*b|food.*beverage|service|kellner|serveur|maitre)\b/.test(t)) return 'Ristorazione';
  // Housekeeping
  if (/\b(housekeep|room\s*attend|minibar|laundry|linen|housekeeper|gouvernant|valet)\b/.test(t)) return 'Ospitalità';
  // Front office / Reception / Concierge
  if (/\b(reception|front\s*office|concierge|guest\s*relation|night\s*audit|portier)\b/.test(t)) return 'Ospitalità';
  // Spa / Wellness
  if (/\b(spa|wellness|therapist|masseur|masseuse|beauty|estetist)\b/.test(t)) return 'Salute / Benessere';
  // Maintenance / Engineering / Technical
  if (/\b(engineer|maintenance|techni|mecanic|elektr|install|facility|haustechnik)\b/.test(t)) return 'Tecnica';
  // Admin / Finance / HR
  if (/\b(admin|accounting|finance|controller|hr|human\s*resource|personal|payroll|buchhalt)\b/.test(t)) return 'Amministrazione';
  // Sales / Marketing / Revenue
  if (/\b(sales|marketing|revenue|reservat|ecommerce|digital|kommunik)\b/.test(t)) return 'Commerciale';
  // IT
  if (/\b(it\b|software|develop|programm|system)/.test(t)) return 'IT';
  // Management / Director
  if (/\b(manager|director|head\s*of|leiter|responsab|directeur)\b/.test(t)) return 'Management';
  // Apprentice / Intern
  if (/\b(apprenti|lehrling|lernend|intern|praktik|stage|stagiair)\b/.test(t)) return 'Formazione';

  return 'Ospitalità';
}

function detectExperienceLevel(title = '') {
  const t = String(title || '').toLowerCase();
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)\b/.test(t)) return 'intern';
  if (/\b(junior|jr)\b/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|manager)\b/.test(t)) return 'senior';
  return 'mid';
}

/* ── RSS Parsing ──────────────────────────────────────────── */

/**
 * Parse RSS XML into structured job items.
 * Exported for testing.
 *
 * Teamtailor RSS structure:
 *   <rss><channel>
 *     <item>
 *       <title>Job Title</title>
 *       <link>https://jobs.badruttscareers.com/en-GB/jobs/12345-slug</link>
 *       <description><![CDATA[HTML description]]></description>
 *       <pubDate>Mon, 01 Apr 2026 12:00:00 +0000</pubDate>
 *     </item>
 *   </channel></rss>
 */
export function parseRssItems(xml = '') {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    trimValues: false,
    processEntities: false,
  });

  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item || [];
  const normalizedItems = Array.isArray(items) ? items : [items];

  return normalizedItems
    .map((item) => ({
      title: normalizeSpace(item?.title || ''),
      url: normalizeSpace(item?.link || ''),
      descriptionHtml: String(item?.description || ''),
      pubDate: normalizeSpace(item?.pubDate || ''),
    }))
    .filter((item) => item.title && item.url);
}

/**
 * Parse an RSS pubDate string into YYYY-MM-DD format.
 * Input: "Mon, 01 Apr 2026 12:00:00 +0000"
 * Output: "2026-04-01"
 */
export function parseRssDate(raw = '') {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().split('T')[0];
}

/* ── Fetch RSS Feed ───────────────────────────────────────── */

async function fetchRssFeed() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(CAREER_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from RSS feed`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Main Fetch Function ──────────────────────────────────── */

/**
 * Fetch all Badrutt's Palace Hotel jobs from the Teamtailor RSS feed.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllBadruttsPalaceJobs() {
  console.log(`🏨 Fetching Badrutt's Palace Hotel jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const xml = await fetchRssFeed();
  const items = parseRssItems(xml);

  if (!items || items.length === 0) {
    console.warn('⚠️ No job items found in RSS feed.');
    return [];
  }

  console.log(`  📋 RSS items found: ${items.length}`);

  const jobs = [];

  for (const item of items) {
    const title = item.title;
    if (!title || title.length < 3) continue;

    const descriptionText = stripHtml(item.descriptionHtml);
    const publicUrl = item.url;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} badrutts-palace ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const location = DEFAULT_LOCATION;
    const canton = inferAnyCanton(location) || DEFAULT_CANTON;
    const postedDate = parseRssDate(item.pubDate) || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `badrutts-palace-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: BADRUTTS_PALACE_COMPANY_NAME,
      companyKey: BADRUTTS_PALACE_KEY,
      companyDomain: BADRUTTS_PALACE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Badrutt's Palace Hotel, St. Moritz`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Badrutt's Palace Hotel, St. Moritz` },
      location,
      canton,
      url: publicUrl,
      source: "Badrutt's Palace Hotel Dedicated Parser",
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode: DEFAULT_POSTAL_CODE,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: 'FULL_TIME',
      experienceLevel: detectExperienceLevel(title),
      sector: 'Ospitalità / Hotellerie',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 70)}`);
  }

  console.log(`\n📋 Total Badrutt's Palace Hotel jobs discovered: ${jobs.length}`);
  return jobs;
}
