#!/usr/bin/env node
/**
 * Klinik Arlesheim job parser — Dualoo ATS (portal s60emmh3).
 *
 * Public career site: https://jobs.dualoo.com/portal/s60emmh3?lang=DE
 *
 * Anthroposophic acute & psychiatric hospital in Arlesheim (BL), ~600
 * employees. Uses Dualoo — a Swiss recruiting SaaS — with a hosted portal
 * subdomain. Cards are server-rendered with `class="row jobElement"`.
 *
 * Each card exposes:
 *   - data-eventData JSON: { jobName, startDate, location }
 *   - href: portal-relative path to the detail page (UUID-based)
 *   - <span class="jobName">{TITLE}</span>
 *   - <span class="cityName">{LOCATION}</span>
 *   - <span class="badge ... jobCategory">{CATEGORY}</span>
 *   - <span class="badge ... jobDate" data-date="...">{START_DATE_HUMAN}</span>
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

export const KLINIK_ARLESHEIM_KEY = 'klinik-arlesheim';
export const KLINIK_ARLESHEIM_COMPANY_NAME = 'Klinik Arlesheim';
export const KLINIK_ARLESHEIM_COMPANY_DOMAIN = 'klinik-arlesheim.ch';

const DUALOO_PORTAL = 's60emmh3';
const PORTAL_URL = `https://jobs.dualoo.com/portal/${DUALOO_PORTAL}?lang=DE`;
const DETAIL_BASE = `https://jobs.dualoo.com/portal/${DUALOO_PORTAL}`;

export function isKlinikArlesheimJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === KLINIK_ARLESHEIM_KEY
    || url.includes('klinik-arlesheim.ch')
    || url.includes(`/${DUALOO_PORTAL}/`);
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'klinik-arlesheim.ch'
      || host.endsWith('.klinik-arlesheim.ch')
      || host === 'jobs.dualoo.com';
  } catch {
    return false;
  }
}

export function parseDualooPortal(html) {
  const out = [];
  const seen = new Set();
  const rx = /<a\s+class="row jobElement[^"]*"\s+data-eventData="([^"]+)"\s+href="([^"]+)"[\s\S]*?<span class="jobName">([\s\S]*?)<\/span>[\s\S]*?<span class="cityName">([\s\S]*?)<\/span>[\s\S]*?<span class="badge[^"]*jobCategory">([\s\S]*?)<\/span>[\s\S]*?<span class="badge[^"]*jobDate"\s+data-date="([^"]*)">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = rx.exec(html))) {
    const eventData = m[1];
    const href = m[2];
    const title = normalizeSpace(decodeEntities(m[3].replace(/<[^>]+>/g, '')));
    const cityName = normalizeSpace(decodeEntities(m[4].replace(/<[^>]+>/g, '')));
    const category = normalizeSpace(decodeEntities(m[5].replace(/<[^>]+>/g, '')));
    const startDateMachine = normalizeSpace(decodeEntities(m[6]));
    const startDateHuman = normalizeSpace(decodeEntities(m[7].replace(/<[^>]+>/g, '')));
    if (!title || title.length < 3) continue;
    // UUID is in the href path: /s60emmh3/{UUID}/detail?lang=DE
    const uuidMatch = href.match(/\/([a-f0-9-]{36})\/detail/);
    const uuid = uuidMatch ? uuidMatch[1] : href;
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    const url = href.startsWith('http') ? href : `${DETAIL_BASE}/${href.replace(new RegExp(`^${DUALOO_PORTAL}/`), '')}`;
    out.push({ uuid, url, title, cityName, category, startDateMachine, startDateHuman });
  }
  return out;
}

export async function fetchAllKlinikArlesheimJobs() {
  console.log(`🏥 Fetching ${KLINIK_ARLESHEIM_COMPANY_NAME} jobs`);
  console.log(`   Portal: ${PORTAL_URL}\n`);
  const html = await fetchHtml(PORTAL_URL);
  const items = parseDualooPortal(html);
  console.log(`  ✓ ${items.length} Dualoo job cards parsed`);
  if (!items.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const it of items) {
    const title = it.title;
    const description = [
      it.cityName,
      it.category ? `Kategorie: ${it.category}` : '',
      it.startDateHuman ? `Eintritt: ${it.startDateHuman}` : '',
      'Klinik Arlesheim — anthroposophische Akut- und psychiatrische Klinik, Arlesheim (BL).',
    ].filter(Boolean).join('\n\n');
    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${KLINIK_ARLESHEIM_KEY} arlesheim`);
    const urlHash = createHash('sha1').update(it.url).digest('hex').slice(0, 12);
    jobs.push({
      id: `${KLINIK_ARLESHEIM_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KLINIK_ARLESHEIM_COMPANY_NAME,
      companyKey: KLINIK_ARLESHEIM_KEY,
      companyDomain: KLINIK_ARLESHEIM_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: 'Arlesheim',
      canton: 'BL',
      url: it.url,
      source: 'Klinik Arlesheim Dedicated Parser (Dualoo)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: 'Arlesheim',
      addressRegion: 'BL',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '4144',
      category: detectHealthcareCategory(title + ' ' + it.category),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(title),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: it.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  console.log(`📋 Total ${KLINIK_ARLESHEIM_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
