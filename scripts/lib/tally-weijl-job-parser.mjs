#!/usr/bin/env node
/**
 * TALLY WEiJL job parser — Fetcher and job builder.
 *
 * Source: https://www.tally-weijl.com/jobs
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllTallyWeijlJobs()  — Fetch and parse all jobs
 *   - isTallyWeijlJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const TALLY_WEIJL_KEY = 'tally-weijl';
export const TALLY_WEIJL_COMPANY_NAME = 'TALLY WEiJL';
export const TALLY_WEIJL_COMPANY_DOMAIN = 'tally-weijl.com';

const CAREER_URL = 'https://www.tally-weijl.com/jobs';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to TALLY WEiJL.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isTallyWeijlJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === TALLY_WEIJL_KEY ||
    key.startsWith('tally-weijl') ||
    company.includes('tally weijl') ||
    url.includes('tally-weijl.com')
  );
}

/**
 * Validate that a URL belongs to TALLY WEiJL's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'tally-weijl.com' || host.endsWith('.tally-weijl.com');
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

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * TALLY WEiJL uses Trakstar Hire (formerly Recruiterbox) as its ATS.
 * Career portal: https://tallyweijl.hire.trakstar.com/
 * The page is server-rendered HTML with job data embedded in RB.init_data.
 * We filter by country=Switzerland to get Swiss jobs only.
 * Valais jobs are in Sion / Conthey.
 *
 * URL pattern: https://tallyweijl.hire.trakstar.com/jobs/{id}/
 */

const TRAKSTAR_BASE = 'https://tallyweijl.hire.trakstar.com';

/**
 * Fetch and parse the Trakstar Hire HTML listing page.
 * Filters to Switzerland only (both "Switzerland" and "Schweiz" filters).
 * Returns raw extracted listings with title, location, url, etc.
 *
 * Trakstar HTML structure per job card:
 *   <div class="js-card list-item..." data-href="/jobs/{id}/">
 *     <a href="/jobs/{id}/">
 *       <h3 class="...js-job-list-opening-name..." title="TITLE">TITLE</h3>
 *       <div class="...js-job-list-opening-loc..." title="City, State, Country">
 *         <span class="meta-job-location-city">City</span>,
 *         <span class="meta-job-location-state">State</span>,
 *         <span class="meta-job-location-country">Country</span>
 *       </div>
 *       <span data-time="...">Date</span>
 *       <span class="...meta-job-type...">Full-time</span>
 *     </a>
 *   </div>
 */
async function fetchJobListings() {
  const allListings = [];
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  // Trakstar uses two different country names for Switzerland
  for (const country of ['Switzerland', 'Schweiz']) {
    let page = 1;
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const url = `${TRAKSTAR_BASE}/jobs?country=${encodeURIComponent(country)}&page=${page}`;
      console.log(`  📄 Fetching ${country} page ${page}: ${url}`);

      try {
        const res = await fetch(url, {
          headers: {
            Accept: 'text/html',
            'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
              'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
          },
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();

        // Parse job cards: each card is a <div class="js-card..." data-href="/jobs/{id}/">
        const cardPattern = /<div\s+class="js-card\s+list-item[^"]*"[^>]*data-href="(\/jobs\/[^"]+\/)"[^>]*>([\s\S]*?)(?=<div\s+class="js-card\s+list-item|<nav\b|<footer\b)/gi;
        let match;
        let foundOnPage = 0;

        while ((match = cardPattern.exec(html)) !== null) {
          const jobPath = match[1];
          const cardHtml = match[2];

          // Extract title from <h3 title="..."> attribute
          const titleAttrMatch = cardHtml.match(/<h3[^>]+title="([^"]+)"/i);
          const rawTitle = titleAttrMatch
            ? normalizeSpace(titleAttrMatch[1])
            : '';
          if (!rawTitle || rawTitle.length < 3) continue;

          // Extract location from <div class="...js-job-list-opening-loc..." title="City, State, Country">
          const locAttrMatch = cardHtml.match(/js-job-list-opening-loc[^"]*"[^>]*title="([^"]+)"/i);
          const locString = locAttrMatch ? locAttrMatch[1].trim() : '';
          const locParts = locString.split(',').map(s => s.trim());
          const city = locParts[0] || '';
          const state = locParts[1] || '';

          // Extract date from data-time span or visible text
          const dateAttrMatch = cardHtml.match(/title="Apply by:\s*([^"]+)"/i) ||
            cardHtml.match(/data-time="[^"]*"[^>]*>\s*(\w+\.\s*\d+,\s*\d{4})/i);
          const postedDateRaw = dateAttrMatch ? dateAttrMatch[1].trim() : '';

          // Extract employment type
          const typeMatch = cardHtml.match(/meta-job-type[^"]*"[^>]*>([^<]+)/i) ||
            cardHtml.match(/(full.?time|part.?time|contract)/i);
          const empType = typeMatch ? typeMatch[1].trim() : 'Full-time';

          allListings.push({
            title: rawTitle,
            city,
            state,
            country,
            url: `${TRAKSTAR_BASE}${jobPath}`,
            postedDate: postedDateRaw,
            employmentType: /part.?time/i.test(empType) ? 'PART_TIME' : 'FULL_TIME',
          });
          foundOnPage++;
        }

        console.log(`  📦 Found ${foundOnPage} jobs on page ${page}`);

        // Check for next page link
        if (!html.includes(`page=${page + 1}`) || foundOnPage === 0) break;
        page++;
        await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
        clearTimeout(timer);
        console.warn(`  ⚠️ Error fetching ${country} page ${page}: ${err.message}`);
        break;
      }
    }
  }

  // Deduplicate by URL (some jobs may appear under both country names)
  const seen = new Set();
  return allListings.filter(l => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });
}

/**
 * Fetch detail page for a single job to get a richer description.
 */
async function fetchJobDetail(jobUrl) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(jobUrl, {
      headers: {
        Accept: 'text/html',
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    const html = await res.text();

    // Extract the job description from the detail page
    // Trakstar uses a div with class containing "description" or main content area
    const descMatch = html.match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
      html.match(/<div[^>]*class="[^"]*job[_-]?detail[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
      html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

    return descMatch ? stripHtml(descMatch[1]).trim() : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Parse Trakstar date string "Jan. 1, 2027" → "2027-01-01".
 */
function parseTrakstarDate(raw = '') {
  const months = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  const m = String(raw).trim().match(/^(\w+)\.?\s*(\d+),\s*(\d{4})$/);
  if (!m) return '';
  const mon = months[m[1].toLowerCase().slice(0, 3)] || '';
  if (!mon) return '';
  return `${m[3]}-${mon}-${m[2].padStart(2, '0')}`;
}

/**
 * Fetch all TALLY WEiJL jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllTallyWeijlJobs() {
  console.log(`🔍 Fetching TALLY WEiJL jobs`);
  console.log(`   Platform: Trakstar Hire (Recruiterbox)`);
  console.log(`   Source: ${TRAKSTAR_BASE}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`\n  📋 Total Swiss listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title);
    if (!title || title.length < 3) continue;

    const city = normalizeSpace(listing.city) || 'Sion';
    const canton = inferSwissTargetCanton(city) || inferSwissTargetCanton(listing.state || '') || 'VS';
    const publicUrl = listing.url;

    // Fetch detail page for description
    const detailDesc = await fetchJobDetail(publicUrl);
    const descriptionText = detailDesc || `${title} — ${TALLY_WEIJL_COMPANY_NAME}, ${city}`;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} tally-weijl ${city || 'ch'}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const postedDate = parseTrakstarDate(listing.postedDate) ||
      new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `tally-weijl-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: TALLY_WEIJL_COMPANY_NAME,
      companyKey: TALLY_WEIJL_KEY,
      companyDomain: TALLY_WEIJL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: city,
      canton,
      url: publicUrl,
      source: 'TALLY WEiJL Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: listing.employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType: listing.employmentType || 'OTHER',
      experienceLevel: detectExperienceLevel(title),
      sector: 'Moda / Abbigliamento',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    console.log(`  ✅ ${title} — ${city}`);
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  console.log(`\n📋 Total TALLY WEiJL jobs discovered: ${jobs.length}`);
  return jobs;
}
