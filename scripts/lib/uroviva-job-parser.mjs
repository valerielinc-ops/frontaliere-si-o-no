#!/usr/bin/env node
/**
 * Uroviva job parser — Dualoo ATS (portal nthmjmb4).
 *
 * Public career site: https://www.uroviva.ch/de/ueber-uns/offene-stellen
 *   → embeds Dualoo portal https://jobs.dualoo.com/portal/nthmjmb4
 *
 * Uroviva AG is a Swiss specialist for urology with locations in
 * Bülach (head office, Klinik für Urologie), Zürich (Stadelhofen,
 * Andrologiezentrum, Wengistrasse), Horgen (See-Spital), and
 * Schlieren (Spital Limmattal). Single Dualoo portal serves all sites.
 *
 * Modelled on `klinik-arlesheim-job-parser.mjs`.
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

export const UROVIVA_KEY = 'uroviva';
export const UROVIVA_COMPANY_NAME = 'Uroviva';
export const UROVIVA_COMPANY_DOMAIN = 'uroviva.ch';

const DUALOO_PORTAL = 'nthmjmb4';
const PORTAL_URL = `https://jobs.dualoo.com/portal/${DUALOO_PORTAL}?lang=DE`;
const DETAIL_BASE = `https://jobs.dualoo.com/portal/${DUALOO_PORTAL}`;
const PUBLIC_CAREER_URL = 'https://www.uroviva.ch/de/ueber-uns/offene-stellen';
const DETAIL_DELAY_MS = 250;

// Most Uroviva positions are at the head clinic in Bülach (8180).
const DEFAULT_CITY = 'Bülach';
const DEFAULT_POSTAL_CODE = '8180';

// City → postal code mapping for known Uroviva sites (best-effort defaults;
// the AI translation step does not need this to be exact, but it improves
// JSON-LD `jobLocation` quality on the static-page side).
const CITY_POSTAL_MAP = new Map([
  ['Bülach', '8180'],
  ['Zürich', '8001'],
  ['Stadelhofen', '8001'],
  ['Horgen', '8810'],
  ['Schlieren', '8952'],
]);

export function isUrovivaJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === UROVIVA_KEY
    || url.includes('uroviva.ch')
    || url.includes(`/${DUALOO_PORTAL}/`);
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'uroviva.ch'
      || host.endsWith('.uroviva.ch')
      || host === 'jobs.dualoo.com';
  } catch {
    return false;
  }
}

/**
 * Parse the Dualoo portal HTML listing.
 *
 * Each card uses `<a class="row jobElement">` with a `data-eventData` JSON blob
 * carrying `jobName`, `startDate`, and `location` (city + entity).
 */
export function parseDualooPortal(html) {
  const out = [];
  const seen = new Set();
  // Match the entire anchor block so we can extract jobName SPAN (which carries
  // the workload percentage, e.g. "… 40-50%") along with the data-eventData
  // JSON (which carries location and startDate).
  const blockRe = /<a[^>]*class="[^"]*\bjobElement\b[^"]*"[^>]*>[\s\S]*?<\/a>/g;
  let m;
  while ((m = blockRe.exec(html))) {
    const block = m[0];
    const hrefMatch = block.match(/\shref="([^"]+)"/);
    const evMatch = block.match(/\sdata-eventData="([^"]+)"/);
    const spanMatch = block.match(/<span[^>]*class="jobName"[^>]*>([\s\S]*?)<\/span>/i);
    if (!hrefMatch) continue;
    const rel = hrefMatch[1];
    let meta = {};
    if (evMatch) {
      const evRaw = evMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      try { meta = JSON.parse(evRaw); } catch { meta = {}; }
    }
    const spanTitle = spanMatch
      ? normalizeSpace(decodeEntities(spanMatch[1].replace(/<[^>]+>/g, ' ')))
      : '';
    const evTitle = normalizeSpace(decodeEntities(String(meta.jobName || '')));
    const title = spanTitle || evTitle;
    if (!title || title.length < 3) continue;
    const uuidMatch = rel.match(/([a-f0-9-]{36})\/detail/);
    const uuid = uuidMatch ? uuidMatch[1] : rel;
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    const url = rel.startsWith('http')
      ? rel
      : `${DETAIL_BASE}/${rel.replace(new RegExp(`^${DUALOO_PORTAL}/`), '')}`;
    out.push({
      uuid,
      url,
      title,
      location: normalizeSpace(decodeEntities(String(meta.location || ''))),
      startDate: normalizeSpace(decodeEntities(String(meta.startDate || ''))),
    });
  }
  return out;
}

async function fetchDualooDetail(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    const sections = [];
    const grab = (cls, label) => {
      const rx = new RegExp(`class="${cls}"[^>]*>([\\s\\S]*?)</div>`, 'i');
      const mm = html.match(rx);
      if (!mm) return;
      const text = mm[1]
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/li>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/\s+\n/g, '\n')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (text) sections.push(`${label}\n${text}`);
    };
    grab('advertisementResponsibilitiesText', 'Aufgaben:');
    grab('advertisementRequirementsText', 'Anforderungen:');
    grab('advertisementBenefitsText', 'Wir bieten:');
    return sections.join('\n\n');
  } catch {
    return '';
  }
}

/**
 * Extract a clean city name from the Dualoo `location` field which is shaped
 * like "Uroviva AG - Stadelhofen" or "Uroviva Klinik AG - Bülach".
 */
function extractCity(rawLocation) {
  if (!rawLocation) return DEFAULT_CITY;
  // Last "- xxx" segment is the city
  const parts = rawLocation.split(/\s*-\s*/).map((s) => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1] || DEFAULT_CITY;
  // Strip site prefixes like "See-Spital Horgen" → keep last token (city)
  const tokens = last.split(/\s+/);
  return tokens[tokens.length - 1] || DEFAULT_CITY;
}

function postalFor(city) {
  return CITY_POSTAL_MAP.get(city) || DEFAULT_POSTAL_CODE;
}

export async function fetchAllUrovivaJobs() {
  console.log(`🏥 Fetching ${UROVIVA_COMPANY_NAME} jobs`);
  console.log(`   Portal: ${PORTAL_URL}`);
  console.log(`   Public: ${PUBLIC_CAREER_URL}\n`);

  const html = await fetchHtml(PORTAL_URL);
  const items = parseDualooPortal(html);
  console.log(`  ✓ ${items.length} Dualoo job cards parsed`);
  if (!items.length) return [];
  console.log(`  📄 Fetching detail pages for rich descriptions...`);

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (i > 0) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    const detailContent = await fetchDualooDetail(it.url);
    if (detailContent) detailHits += 1;

    const city = extractCity(it.location);
    const description = [
      detailContent,
      it.location ? `Standort: ${it.location}` : '',
      it.startDate ? `Eintritt: ${it.startDate}` : '',
      `${UROVIVA_COMPANY_NAME} — Schweizer Spezialist für Urologie mit Sitz in Bülach.`,
    ].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || it.title, 'de');
    const jobSlug = slugify(`${it.title} ${UROVIVA_KEY} ${city}`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${UROVIVA_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: UROVIVA_COMPANY_NAME,
      companyKey: UROVIVA_KEY,
      companyDomain: UROVIVA_COMPANY_DOMAIN,
      title: it.title,
      titleByLocale: { [sourceLang]: it.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
      location: city,
      canton: 'ZH',
      url: it.url,
      source: `${UROVIVA_COMPANY_NAME} Dedicated Parser (Dualoo)`,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: city,
      addressRegion: 'ZH',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: postalFor(city),
      category: detectHealthcareCategory(it.title),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(it.title),
      experienceLevel: detectHealthcareExperienceLevel(it.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: it.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(
    `📋 Total ${UROVIVA_COMPANY_NAME} jobs discovered: ${jobs.length} `
    + `(${detailHits}/${items.length} with rich detail content)`,
  );
  return jobs;
}

export { PUBLIC_CAREER_URL, PORTAL_URL, DUALOO_PORTAL };
