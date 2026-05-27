#!/usr/bin/env node
/**
 * Forel Klinik job parser — Dualoo ATS (portal w1f713hy).
 *
 * Public career site: https://www.forel-klinik.ch/jobs-und-entwicklung/stellenportal/
 *   → embeds Dualoo portal https://jobs.dualoo.com/portal/w1f713hy
 *
 * Forel Klinik AG is a specialised psychiatric / addiction-medicine
 * hospital in Ellikon an der Thur (canton Zürich) with an outpatient
 * branch in Zürich-Oerlikon. ~6 open positions across nursing,
 * therapies and medical staff.
 *
 * Modelled on `klinik-arlesheim-job-parser.mjs` (same Dualoo HTML shape).
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

export const FOREL_KLINIK_KEY = 'forel-klinik';
export const FOREL_KLINIK_COMPANY_NAME = 'Forel Klinik';
export const FOREL_KLINIK_COMPANY_DOMAIN = 'forel-klinik.ch';

const DUALOO_PORTAL = 'w1f713hy';
const PORTAL_URL = `https://jobs.dualoo.com/portal/${DUALOO_PORTAL}?lang=DE`;
const DETAIL_BASE = `https://jobs.dualoo.com/portal/${DUALOO_PORTAL}`;
const PUBLIC_CAREER_URL = 'https://www.forel-klinik.ch/jobs-und-entwicklung/stellenportal/';
const DETAIL_DELAY_MS = 250;

const DEFAULT_CITY = 'Ellikon an der Thur';
const DEFAULT_POSTAL_CODE = '8548';
const CITY_POSTAL_MAP = new Map([
  ['Ellikon an der Thur', '8548'],
  ['Zürich', '8050'],
]);

export function isForelKlinikJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === FOREL_KLINIK_KEY
    || url.includes('forel-klinik.ch')
    || url.includes(`/${DUALOO_PORTAL}/`);
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'forel-klinik.ch'
      || host.endsWith('.forel-klinik.ch')
      || host === 'jobs.dualoo.com';
  } catch {
    return false;
  }
}

export function parseDualooPortal(html) {
  const out = [];
  const seen = new Set();
  // Match the entire anchor block so we can extract the jobName SPAN (richer
  // title incl. workload %) plus the data-eventData JSON (location/startDate).
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

function extractCity(rawLocation) {
  if (!rawLocation) return DEFAULT_CITY;
  const parts = rawLocation.split(/\s*-\s*/).map((s) => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1] || DEFAULT_CITY;
  if (CITY_POSTAL_MAP.has(last)) return last;
  // Fallback: keep last token of last segment
  const tokens = last.split(/\s+/);
  return tokens.length >= 3 ? last : (tokens[tokens.length - 1] || DEFAULT_CITY);
}

function postalFor(city) {
  return CITY_POSTAL_MAP.get(city) || DEFAULT_POSTAL_CODE;
}

export async function fetchAllForelKlinikJobs() {
  console.log(`🏥 Fetching ${FOREL_KLINIK_COMPANY_NAME} jobs`);
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
      `${FOREL_KLINIK_COMPANY_NAME} — Suchtmedizinische Fachklinik in Ellikon an der Thur (Kanton Zürich).`,
    ].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || it.title, 'de');
    const jobSlug = slugify(`${it.title} ${FOREL_KLINIK_KEY} ${city}`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${FOREL_KLINIK_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: FOREL_KLINIK_COMPANY_NAME,
      companyKey: FOREL_KLINIK_KEY,
      companyDomain: FOREL_KLINIK_COMPANY_DOMAIN,
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
      source: `${FOREL_KLINIK_COMPANY_NAME} Dedicated Parser (Dualoo)`,
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
    `📋 Total ${FOREL_KLINIK_COMPANY_NAME} jobs discovered: ${jobs.length} `
    + `(${detailHits}/${items.length} with rich detail content)`,
  );
  return jobs;
}

export { PUBLIC_CAREER_URL, PORTAL_URL, DUALOO_PORTAL };
