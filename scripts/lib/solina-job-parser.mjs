#!/usr/bin/env node
/**
 * Stiftung Solina job parser — custom TYPO3 careers portal.
 *
 * Solina runs several care/rehab facilities in the Bernese Oberland —
 * Heiligenschwendi, Spiez, and other locations — under a single
 * "Stiftung Solina" foundation. The applicant funnel terminates in
 * onlyfy.jobs (tenant `stiftung-solina.onlyfy.jobs`), but the public
 * careers portal at `jobs.solina.ch` is a custom TYPO3 page with a
 * richer listing (all categories: pflege, hotellerie, ausbildung).
 *
 * Public career site:   https://jobs.solina.ch/offene-stellen
 * Apply URL pattern:    https://stiftung-solina.onlyfy.jobs/application/apply/{hash}
 *
 * Listing pages live at `https://jobs.solina.ch/offene-stellen/{category}`
 * with detail pages at  `https://jobs.solina.ch/offene-stellen/{category}/details/{slug-hash}`.
 *
 * Detail pages expose:
 *   - <h1 class="...page-title">{title}</h1>
 *   - <meta name="description" content="{pensum}, {city}, {availability}">
 *   - Structured H2 sections "Das machst du", "Das bringst du mit",
 *     "Deine Vorteile", followed by <ul><li>...</li></ul>.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSolinaJobs()
 *   - isSolinaJob()
 *   - isTrustedDomain()
 *   - SOLINA_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const SOLINA_KEY = 'solina';
export const SOLINA_COMPANY_NAME = 'Stiftung Solina';
export const SOLINA_COMPANY_DOMAIN = 'solina.ch';

const PORTAL_BASE = 'https://jobs.solina.ch';
const LISTING_PATHS = [
  '/offene-stellen/pflege-betreuung',
  '/offene-stellen/hotellerie-gastronomie',
  '/offene-stellen/ausbildung-praktika',
  '/offene-stellen/zivildienst',
];
const POLITE_DELAY_MS = 250;

const SOLINA_CONTEXT = 'Die Stiftung Solina betreibt mehrere Pflege- und Rehabilitationsstandorte im Berner Oberland, darunter Solina Heiligenschwendi und Solina Spiez.';

/* ── Matchers ─────────────────────────────────────────────── */

export function isSolinaJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === SOLINA_KEY
    || url.includes('jobs.solina.ch')
    || url.includes('solina.ch')
    || url.includes('stiftung-solina.onlyfy.jobs');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'jobs.solina.ch'
      || host === 'solina.ch'
      || host.endsWith('.solina.ch')
      || host === 'stiftung-solina.onlyfy.jobs';
  } catch {
    return false;
  }
}

/* ── HTML parsing ─────────────────────────────────────────── */

function parseSolinaListing(html) {
  const out = [];
  const seen = new Set();
  // Match category-scoped detail URLs (preserves category path)
  const rx = /href="(\/offene-stellen\/[a-z0-9-]+\/details\/[a-z0-9-]+)"/gi;
  let m;
  while ((m = rx.exec(html))) {
    const path = m[1];
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(`${PORTAL_BASE}${path}`);
  }
  return out;
}

function extractTitle(html) {
  const m = html.match(/<h1[^>]*page-title[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return '';
  return normalizeSpace(decodeEntities(m[1].replace(/<[^>]+>/g, ' ')));
}

function extractMetaDescription(html) {
  const m = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
  return m ? decodeEntities(m[1]).trim() : '';
}

/**
 * Solina meta description follows the pattern: "{pensum}, {city}, {availability}".
 * Returns { pensum, city }.
 */
function parseMetaDescription(meta) {
  if (!meta) return { pensum: '', city: '' };
  const parts = meta.split(',').map((s) => s.trim()).filter(Boolean);
  // First part is usually the pensum (e.g. "40-80%", "80-100%"), second the city
  const pensum = parts[0] && /\d{1,3}\s*(-\s*\d{1,3})?\s*%/.test(parts[0]) ? parts[0] : '';
  const city = pensum ? (parts[1] || '') : (parts[0] || '');
  return { pensum, city };
}

function extractApplyUrl(html) {
  const m = html.match(/href="(https:\/\/stiftung-solina\.onlyfy\.jobs\/application\/[^"]+)"/i);
  return m ? m[1] : '';
}

function extractMainContent(html) {
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const body = mainMatch ? mainMatch[1] : html;
  const stripped = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '');

  const parts = [];
  const seen = new Set();
  const rx = /<(p|li|h[234])[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = rx.exec(stripped))) {
    const tag = m[1].toLowerCase();
    const text = normalizeSpace(decodeEntities(m[2].replace(/<[^>]+>/g, ' ')));
    if (!text || text.length < 6) continue;
    if (/^(solina jobs|offene stellen|teilen|link in die|link kopiert|link konnte)/i.test(text)) continue;
    if (/cookie|datenschutz|impressum/i.test(text.slice(0, 40))) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    if (/^h[234]$/.test(tag)) parts.push(`## ${text}`);
    else if (tag === 'li') parts.push(`• ${text}`);
    else parts.push(text);
  }
  return parts.slice(0, 40).join('\n');
}

/* ── Canton inference ─────────────────────────────────────── */

function inferCantonFromLocation(loc) {
  const l = String(loc).toLowerCase();
  if (/heiligenschwendi|spiez|thun|bern\b|berne|burgdorf|interlaken|steffisburg|sigriswil|gunten/.test(l)) return 'BE';
  if (/zürich|zurich/.test(l)) return 'ZH';
  if (/luzern|lucerne/.test(l)) return 'LU';
  if (/basel|basilea/.test(l)) return 'BS';
  if (/wallis|valais|brig|visp/.test(l)) return 'VS';
  if (/sankt|st\.\s*gallen/.test(l)) return 'SG';
  return 'BE'; // Solina HQ is in the Berner Oberland (BE)
}

/* ── Main fetch ───────────────────────────────────────────── */

async function fetchAllListingUrls() {
  const all = new Set();
  for (const path of LISTING_PATHS) {
    try {
      const html = await fetchHtml(`${PORTAL_BASE}${path}`);
      const urls = parseSolinaListing(html);
      console.log(`  ✓ ${urls.length} job links from ${path}`);
      for (const u of urls) all.add(u);
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch ${path}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
  }
  return [...all];
}

export async function fetchAllSolinaJobs() {
  console.log(`🏥 Fetching ${SOLINA_COMPANY_NAME} jobs`);
  console.log(`   Portal: ${PORTAL_BASE}/offene-stellen\n`);

  const urls = await fetchAllListingUrls();
  console.log(`  📋 Total unique job URLs: ${urls.length}`);
  if (!urls.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];

  for (const url of urls) {
    try {
      const html = await fetchHtml(url);
      const title = extractTitle(html);
      if (!title || title.length < 3) {
        console.log(`  ⏭️  Skipped (no title): ${url}`);
        continue;
      }

      const meta = extractMetaDescription(html);
      const { pensum, city: metaCity } = parseMetaDescription(meta);
      const city = metaCity || 'Heiligenschwendi';
      const canton = inferCantonFromLocation(city);
      const applyUrl = extractApplyUrl(html) || url;

      const body = extractMainContent(html);
      const headerLine = [pensum, city].filter(Boolean).join(', ');
      const description = [
        title,
        headerLine ? `Pensum / Standort: ${headerLine}` : '',
        body,
        SOLINA_CONTEXT,
      ].filter(Boolean).join('\n\n');

      const sourceLang = detectLang(description || title, 'de');
      const jobSlug = slugify(`${title} ${SOLINA_KEY} ${city}`);
      const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);

      jobs.push({
        id: `${SOLINA_KEY}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: SOLINA_COMPANY_NAME,
        companyKey: SOLINA_KEY,
        companyDomain: SOLINA_COMPANY_DOMAIN,
        title,
        titleByLocale: { [sourceLang]: title },
        description,
        descriptionByLocale: { [sourceLang]: description },
        // Newly-discovered jobs ship with source-locale-only fields. The shared
        // AI-localization step clears this flag when it fills the remaining 3
        // locales; if it can't, `translate-pending.yml` picks the job up.
        needsRetranslation: true,
        location: city,
        canton,
        url,
        source: `${SOLINA_COMPANY_NAME} Dedicated Parser (TYPO3 + onlyfy.jobs)`,
        sourceLang,
        crawledAt: new Date().toISOString(),
        addressLocality: city,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: '',
        category: detectHealthcareCategory(title),
        contract: 'full-time',
        employmentType: detectHealthcareEmploymentType(`${pensum} ${title}`),
        experienceLevel: detectHealthcareExperienceLevel(title),
        sector: 'Sanità / Ospedali',
        currency: 'CHF',
        featured: false,
        postedDate: todayIso,
        applyUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      });
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch detail ${url}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
  }

  console.log(`\n📋 Total ${SOLINA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
