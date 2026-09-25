#!/usr/bin/env node
/**
 * Privatklinik Wyss — psychiatric private clinic in Münchenbuchsee (BE).
 *
 * Public career site: https://www.privatklinik-wyss.ch/jobs-und-karriere/stellen
 *
 * Privatklinik Wyss AG is a leading specialty hospital for Psychiatry &
 * Psychotherapy, with sites in Münchenbuchsee, Bern, and Biel (~340 staff).
 * Listed standalone in the 2026-05 welches-spital inventory (BE, Psichiatria).
 *
 * The careers section is a custom CMS — no third-party ATS. Listings live
 * under category index pages:
 *   /jobs-und-karriere/stellen/fachbereich-pflege-1
 *   /jobs-und-karriere/stellen/fachbereich-medizin
 *   /jobs-und-karriere/stellen/fachbereich-psychologie
 *   …(plus ausbildung-praktika, administration, hotellerie-und-gastronomie,
 *      technischer-dienst-und-park, fachbereich-spezialtherapie,
 *      fachbereich-kliniksozialdienst)
 *
 * Each category page lists job permalinks of the form
 *   /jobs-und-karriere/stellen/{category}/{slug}
 *
 * Detail pages ship rich text content with Beschäftigungsgrad, Standort,
 * Arbeitsbeginn structured fields and a multi-section narrative.
 */
import { createHash } from 'node:crypto';
import { slugify } from './crawler-template.mjs';
import {
  decodeEntities,
  fetchHtml,
  htmlToText,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareEmploymentType,
  detectHealthcareExperienceLevel,
} from './hospital-custom-html-helpers.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const PRIVATKLINIK_WYSS_KEY = 'privatklinik-wyss';
export const PRIVATKLINIK_WYSS_COMPANY_NAME = 'Privatklinik Wyss';
export const PRIVATKLINIK_WYSS_COMPANY_DOMAIN = 'privatklinik-wyss.ch';

const BASE_URL = 'https://www.privatklinik-wyss.ch';
const CATEGORY_INDEX = `${BASE_URL}/jobs-und-karriere/stellen`;

const CATEGORIES = [
  'fachbereich-pflege-1',
  'fachbereich-medizin',
  'fachbereich-psychologie',
  'fachbereich-spezialtherapie',
  'fachbereich-kliniksozialdienst',
  'hotellerie-und-gastronomie',
  'technischer-dienst-und-park',
  'administration',
  'ausbildung-praktika',
];

// Pages NOT to follow (spontaneous application, policy, hub pages)
const SKIP_SLUGS = new Set([
  'spontanbewerbung',
  'richtlinie-fuer-personalvermittlungen-und-dritte',
]);

const POSTAL_CODE_BY_CITY = {
  munchenbuchsee: '3053',
  münchenbuchsee: '3053',
  bern: '3000',
  biel: '2502',
  bienne: '2502',
};

/* ── Company Matchers ──────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function isPrivatklinikWyssJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  return (
    key === PRIVATKLINIK_WYSS_KEY ||
    key.startsWith('privatklinik-wyss') ||
    company.includes('privatklinik wyss') ||
    url.includes('privatklinik-wyss.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'privatklinik-wyss.ch' || host.endsWith('.privatklinik-wyss.ch');
  } catch {
    return false;
  }
}

/* ── Listing parser ────────────────────────────────────────── */

function parseListingHtml(html = '', categorySlug = '') {
  const out = [];
  const seen = new Set();
  // Job hrefs are relative or absolute paths under the category slug
  const re = new RegExp(
    `href="((?:https://www\\.privatklinik-wyss\\.ch)?/jobs-und-karriere/stellen/${categorySlug}/([^"#?]+))"`,
    'gi',
  );
  let m;
  while ((m = re.exec(html)) !== null) {
    const path = m[1];
    const slug = m[2].split('/')[0];
    if (!slug || SKIP_SLUGS.has(slug)) continue;
    if (slug.startsWith('fachbereich-') || slug === categorySlug) continue;
    const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, category: categorySlug, slug });
  }
  return out;
}

/* ── Detail extraction ─────────────────────────────────────── */

function extractDetail(html = '') {
  if (!html) return { title: '', description: '', location: '', pensum: '', startDate: '' };
  const noScripts = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  // Title comes from <title> / og:title — the <h1> on every Wyss job page is
  // just the generic "Offene Stelle" eyebrow. Pattern: "{Job Title} | Privatklinik Wyss"
  let title = '';
  const ogMatch = noScripts.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
  const titleTag = noScripts.match(/<title>([^<]+)<\/title>/i);
  const raw = (ogMatch && ogMatch[1]) || (titleTag && titleTag[1]) || '';
  if (raw) {
    // Strip the " | Privatklinik Wyss" / " - Privatklinik Wyss" suffix
    title = normalizeSpace(decodeEntities(raw))
      .replace(/\s*[|\-–—]\s*Privatklinik Wyss( AG)?\s*$/i, '')
      .replace(/\s*\|\s*Karriere\s*$/i, '')
      .trim();
  }
  if (!title) {
    const h1 = noScripts.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1) title = normalizeSpace(decodeEntities(h1[1].replace(/<[^>]+>/g, ' ')));
  }

  // Find main content area. Privatklinik Wyss uses TYPO3 style layout.
  let body = noScripts;
  const mainMatch = noScripts.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || noScripts.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || noScripts.match(/<div[^>]*id="main-content"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i);
  if (mainMatch) body = mainMatch[1];

  const text = normalizeSpace(htmlToText(body));

  // Extract structured fields
  let location = '';
  const locMatch = text.match(/Standort[: ]+([^.]{3,80}?)(?:\s+Beschäftigungsgrad|\s+Arbeitsbeginn|\s+Anstellungsverhältnis|\s+Stellenantritt|\.|$)/i)
    || text.match(/Arbeitsort[: ]+([^.]{3,80}?)(?:\s+Beschäftigungsgrad|\s+Arbeitsbeginn|\.|$)/i);
  if (locMatch) {
    location = normalizeSpace(locMatch[1]).replace(/Privatklinik Wyss( AG)?,?\s*/i, '').trim();
  }

  let pensum = '';
  const pensumMatch = text.match(/Beschäftigungsgrad[: ]+([\d\s\-–%]{3,30})/i);
  if (pensumMatch) pensum = normalizeSpace(pensumMatch[1]);

  let startDate = '';
  const startMatch = text.match(/Arbeitsbeginn[: ]+([^.]{3,60}?)(?:\s+Privatklinik|\s+Beschäftigungsgrad|\s+Standort|\.|$)/i);
  if (startMatch) startDate = normalizeSpace(startMatch[1]);

  return {
    title,
    description: text.slice(0, 6000),
    location,
    pensum,
    startDate,
  };
}

/* ── Pensum / helpers ─────────────────────────────────────── */

function extractPensum(s = '') {
  const rangeMatch = String(s).match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (rangeMatch) {
    return { min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) };
  }
  const singleMatch = String(s).match(/(\d{2,3})\s*%/);
  if (singleMatch) {
    const val = parseInt(singleMatch[1], 10);
    return { min: val, max: val };
  }
  return null;
}

function postalCodeFor(city = '') {
  const key = normalize(city);
  for (const k of Object.keys(POSTAL_CODE_BY_CITY)) {
    if (key.includes(k)) return POSTAL_CODE_BY_CITY[k];
  }
  return '3053'; // default Münchenbuchsee HQ
}

/* ── Main Fetch Function ──────────────────────────────────── */

export async function fetchAllPrivatklinikWyssJobs() {
  console.log(`🏥 Fetching ${PRIVATKLINIK_WYSS_COMPANY_NAME} jobs`);
  console.log(`   Category index: ${CATEGORY_INDEX}\n`);

  const tiles = [];
  const seen = new Set();
  for (const cat of CATEGORIES) {
    const url = `${CATEGORY_INDEX}/${cat}`;
    let html = '';
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.warn(`  ⚠️ Category fetch failed (${cat}): ${err?.message || err}`);
      continue;
    }
    const found = parseListingHtml(html, cat);
    for (const t of found) {
      if (seen.has(t.url)) continue;
      seen.add(t.url);
      tiles.push(t);
    }
    console.log(`  📂 ${cat}: ${found.length} listings`);
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`\n  📋 Total unique listings: ${tiles.length}`);

  const jobs = [];

  for (const tile of tiles) {
    let detailHtml = '';
    try {
      detailHtml = await fetchHtml(tile.url);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed (${tile.url}): ${err?.message || err}`);
    }
    if (jobs.length > 0) await new Promise((r) => setTimeout(r, 350));

    const detail = extractDetail(detailHtml);
    const title = normalizeSpace(detail.title || tile.slug.replace(/-/g, ' '));
    if (!title || title.length < 3) continue;

    const location = detail.location || 'Münchenbuchsee';

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} ${PRIVATKLINIK_WYSS_KEY} ch`);
    const urlHash = createHash('sha1').update(tile.url).digest('hex').slice(0, 12);

    const pensumSource = `${detail.pensum} ${title}`;
    const pensum = extractPensum(pensumSource);
    const employmentType = detectHealthcareEmploymentType(pensumSource);
    const contract = pensum && pensum.max < 80 ? 'part-time' : 'full-time';

    const fallbackDesc = `${title} — ${PRIVATKLINIK_WYSS_COMPANY_NAME}, ${location}. Fachklinik für Psychiatrie und Psychotherapie.`;
    const description = detail.description && detail.description.split(/\s+/).length >= 30
      ? detail.description
      : fallbackDesc;

    const job = {
      id: `${PRIVATKLINIK_WYSS_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: PRIVATKLINIK_WYSS_COMPANY_NAME,
      companyKey: PRIVATKLINIK_WYSS_KEY,
      companyDomain: PRIVATKLINIK_WYSS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location,
      canton: 'BE',
      url: tile.url,
      source: `${PRIVATKLINIK_WYSS_COMPANY_NAME} Dedicated Parser (custom HTML)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      postalCode: postalCodeFor(location),
      addressCountry: 'CH',
      country: 'CH',
      category: detectHealthcareCategory(title),
      contract,
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: tile.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (pensum) {
      job.pensumMin = pensum.min;
      job.pensumMax = pensum.max;
      job.pensum = pensum.min === pensum.max ? `${pensum.min}%` : `${pensum.min} - ${pensum.max}%`;
    }

    jobs.push(job);
  }

  console.log(`\n📋 Total ${PRIVATKLINIK_WYSS_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
