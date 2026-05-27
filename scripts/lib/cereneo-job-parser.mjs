#!/usr/bin/env node
/**
 * Cereneo (Centre for Neurology & Rehabilitation) job parser — Dualoo ATS
 * (portal `muy5swcr`).
 *
 * Public career site: https://cereneo.ch/jobs-and-careers/open-positions/
 *   → embeds Dualoo portal https://jobs.dualoo.com/portal/muy5swcr
 *
 * Cereneo is a premium Swiss neurorehabilitation clinic group with sites
 * in Vitznau (LU, head office and head clinic) and Weggis/Hertenstein (LU,
 * Hotel Hertenstein medical residency). Single Dualoo portal serves all
 * legal entities:
 *   - cereneo Schweiz AG (Vitznau / Weggis-Hertenstein clinic)
 *   - cereneo International AG (corporate, Vitznau)
 *   - cereneo Prevention AG (Vitznau, executive-prevention clinic)
 *   - cereneo Home B.V. (mobile therapy unit — Amsterdam, NL: excluded as
 *     not a Swiss-based opening)
 *
 * The portal mixes German and English postings; the listing rows expose
 * the `lang` query in the `href` (e.g. `…/detail?lang=EN` vs `?lang=DE`),
 * which we read to set `sourceLang`. Foreign-country sites are skipped
 * upstream so this parser only emits CH-based vacancies.
 *
 * Modelled on `scripts/lib/uroviva-job-parser.mjs`.
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

export const CERENEO_KEY = 'cereneo';
export const CERENEO_COMPANY_NAME = 'Cereneo';
export const CERENEO_COMPANY_DOMAIN = 'cereneo.ch';

const DUALOO_PORTAL = 'muy5swcr';
const PORTAL_URL = `https://jobs.dualoo.com/portal/${DUALOO_PORTAL}?lang=DE`;
const DETAIL_BASE = `https://jobs.dualoo.com/portal/${DUALOO_PORTAL}`;
const PUBLIC_CAREER_URL = 'https://cereneo.ch/jobs-and-careers/open-positions/';
const DETAIL_DELAY_MS = 250;

// Default to the head clinic in Vitznau (LU) when location can't be parsed.
const DEFAULT_CITY = 'Vitznau';
const DEFAULT_POSTAL_CODE = '6354';
const DEFAULT_CANTON = 'LU';

// Known Cereneo sites → city + postal. All locations are in Lucerne canton.
const SITE_LOCATION_MAP = new Map([
  ['vitznau', { city: 'Vitznau', postal: '6354', canton: 'LU' }],
  ['weggis', { city: 'Weggis', postal: '6353', canton: 'LU' }],
  ['hertenstein', { city: 'Weggis', postal: '6353', canton: 'LU' }],
]);

// Non-CH operating entities — skip these from the Swiss-jobs feed.
const FOREIGN_COUNTRY_HINTS = [
  'amsterdam', 'netherlands', 'nederland', 'home b.v.',
  'london', 'united kingdom', 'germany', 'deutschland', 'usa',
];

export function isCereneoJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === CERENEO_KEY
    || url.includes('cereneo.ch')
    || url.includes(`/${DUALOO_PORTAL}/`);
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'cereneo.ch'
      || host.endsWith('.cereneo.ch')
      || host === 'jobs.dualoo.com';
  } catch {
    return false;
  }
}

/**
 * Parse the Dualoo portal HTML listing.
 *
 * Each card uses `<a class="row jobElement">` with a `data-eventData` JSON blob
 * carrying `jobName` and `location` (entity + city).
 */
export function parseDualooPortal(html) {
  const out = [];
  const seen = new Set();
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
    // Lang hint from the URL query (?lang=DE / ?lang=EN)
    const langMatch = url.match(/[?&]lang=([A-Za-z]{2,3})/i);
    const linkLang = langMatch ? langMatch[1].toLowerCase() : '';
    out.push({
      uuid,
      url,
      title,
      location: normalizeSpace(decodeEntities(String(meta.location || ''))),
      startDate: normalizeSpace(decodeEntities(String(meta.startDate || ''))),
      linkLang,
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
 * Parse a "entity - city" location string. Cereneo formats it as
 *   "cereneo Schweiz AG - Weggis"
 *   "cereneo Home B.V. - Amsterdam"  (foreign — skipped)
 */
function parseLocation(rawLocation) {
  if (!rawLocation) {
    return { city: DEFAULT_CITY, postal: DEFAULT_POSTAL_CODE, canton: DEFAULT_CANTON, isForeign: false };
  }
  const lower = rawLocation.toLowerCase();
  const isForeign = FOREIGN_COUNTRY_HINTS.some((h) => lower.includes(h));
  if (isForeign) {
    return { city: '', postal: '', canton: '', isForeign: true };
  }
  const parts = rawLocation.split(/\s*-\s*/).map((s) => s.trim()).filter(Boolean);
  const last = (parts[parts.length - 1] || DEFAULT_CITY).toLowerCase();
  const match = SITE_LOCATION_MAP.get(last)
    || [...SITE_LOCATION_MAP.entries()].find(([k]) => last.includes(k));
  if (Array.isArray(match)) {
    return { ...match[1], isForeign: false };
  }
  if (match && typeof match === 'object' && !Array.isArray(match)) {
    return { ...match, isForeign: false };
  }
  return { city: DEFAULT_CITY, postal: DEFAULT_POSTAL_CODE, canton: DEFAULT_CANTON, isForeign: false };
}

export async function fetchAllCereneoJobs() {
  console.log(`🏥 Fetching ${CERENEO_COMPANY_NAME} jobs`);
  console.log(`   Portal: ${PORTAL_URL}`);
  console.log(`   Public: ${PUBLIC_CAREER_URL}\n`);

  const html = await fetchHtml(PORTAL_URL);
  const items = parseDualooPortal(html);
  console.log(`  ✓ ${items.length} Dualoo job cards parsed (raw)`);

  // Filter out foreign-country listings (e.g. cereneo Home B.V. - Amsterdam)
  const chItems = items.filter((it) => !parseLocation(it.location).isForeign);
  const droppedForeign = items.length - chItems.length;
  if (droppedForeign > 0) {
    console.log(`  ✓ ${chItems.length} CH-located jobs after filtering ${droppedForeign} foreign listings`);
  }
  if (!chItems.length) return [];

  console.log(`  📄 Fetching detail pages for rich descriptions...`);

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;
  for (let i = 0; i < chItems.length; i += 1) {
    const it = chItems[i];
    if (i > 0) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    const detailContent = await fetchDualooDetail(it.url);
    if (detailContent) detailHits += 1;

    const loc = parseLocation(it.location);
    const description = [
      detailContent,
      it.location ? `Standort: ${it.location}` : '',
      it.startDate ? `Eintritt: ${it.startDate}` : '',
      `${CERENEO_COMPANY_NAME} — Centre for Neurology & Rehabilitation, ${loc.city} (${loc.canton}), Schweiz.`,
    ].filter(Boolean).join('\n\n');

    // The Dualoo detail page URL exposes a `lang=` query that mirrors the
    // posting language. Use it as a fallback for short titles where
    // automatic detection misfires.
    const linkLangHint = it.linkLang === 'en' ? 'en' : (it.linkLang === 'fr' ? 'fr' : (it.linkLang === 'it' ? 'it' : 'de'));
    const sourceLang = detectLang(description || it.title, linkLangHint);
    const jobSlug = slugify(`${it.title} ${CERENEO_KEY} ${loc.city}`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${CERENEO_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CERENEO_COMPANY_NAME,
      companyKey: CERENEO_KEY,
      companyDomain: CERENEO_COMPANY_DOMAIN,
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
      location: loc.city,
      canton: loc.canton,
      url: it.url,
      source: `${CERENEO_COMPANY_NAME} Dedicated Parser (Dualoo)`,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: loc.city,
      addressRegion: loc.canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: loc.postal,
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
    `📋 Total ${CERENEO_COMPANY_NAME} jobs discovered: ${jobs.length} `
    + `(${detailHits}/${chItems.length} with rich detail content)`,
  );
  return jobs;
}

export { PUBLIC_CAREER_URL, PORTAL_URL, DUALOO_PORTAL };
