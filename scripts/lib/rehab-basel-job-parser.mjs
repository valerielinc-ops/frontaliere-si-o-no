#!/usr/bin/env node
/**
 * REHAB Basel — Klinik für Neurorehabilitation und Paraplegiologie.
 *
 * Public career site: https://www.rehab.ch/karriere
 * Talentsoft career portal: https://rehabbasel-career.talent-soft.com/
 * All-jobs listing:    /stelle/liste-aller-stellen.aspx?all=1&mode=list
 *
 * Talentsoft (Cegid) ATS. Job entries are server-rendered as `<li class="ts-offer-list-item">`
 * with the title link, posted date, and reference number.
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

export const REHAB_BASEL_KEY = 'rehab-basel';
export const REHAB_BASEL_COMPANY_NAME = 'REHAB Basel';
export const REHAB_BASEL_COMPANY_DOMAIN = 'rehab.ch';

const PORTAL_BASE = 'https://rehabbasel-career.talent-soft.com';
const LISTING_URL = `${PORTAL_BASE}/stelle/liste-aller-stellen.aspx?all=1&mode=list`;

export function isRehabBaselJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === REHAB_BASEL_KEY
    || url.includes('rehab.ch')
    || url.includes('rehabbasel-career.talent-soft.com');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'rehab.ch' || host.endsWith('.rehab.ch') || host === 'rehabbasel-career.talent-soft.com';
  } catch {
    return false;
  }
}

export function parseTalentsoftListing(html) {
  const out = [];
  const seen = new Set();
  const rx = /<li class="ts-offer-list-item[^"]*"\s+title="[^"]*"\s+onclick="location\.href='([^']+)';">[\s\S]*?<a class="ts-offer-list-item__title-link[^"]*"\s+href="([^"]+)"\s+title="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<ul class="ts-offer-list-item__description[^"]*">\s*<li>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = rx.exec(html))) {
    const href = m[1];
    const detailUrl = href.startsWith('http') ? href : `${PORTAL_BASE}${href}`;
    const fullTitle = normalizeSpace(decodeEntities(m[3]));
    const title = normalizeSpace(decodeEntities(m[4].replace(/<[^>]+>/g, '')));
    const dateText = normalizeSpace(decodeEntities(m[5].replace(/<[^>]+>/g, '')));
    if (!title || title.length < 3) continue;
    // Extract Ref number from full title (e.g. "(Ref. : 2026-282)")
    const refMatch = fullTitle.match(/Ref\.\s*:\s*([0-9-]+)/i);
    const ref = refMatch ? refMatch[1] : '';
    const key = ref || detailUrl;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ detailUrl, title, ref, dateText, fullTitle });
  }
  return out;
}

function parseSwissDate(raw) {
  const m = String(raw || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return '';
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

export async function fetchAllRehabBaselJobs() {
  console.log(`🏥 Fetching ${REHAB_BASEL_COMPANY_NAME} jobs`);
  console.log(`   Portal: ${LISTING_URL}\n`);
  const html = await fetchHtml(LISTING_URL);
  const items = parseTalentsoftListing(html);
  console.log(`  ✓ ${items.length} Talentsoft offers parsed`);
  if (!items.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const it of items) {
    const title = it.title;
    const description = [
      it.fullTitle,
      it.ref ? `Referenz: ${it.ref}` : '',
      'REHAB Basel — Klinik für Neurorehabilitation und Paraplegiologie.',
    ].filter(Boolean).join('\n\n');
    const postedDate = parseSwissDate(it.dateText) || todayIso;
    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${REHAB_BASEL_KEY} basel`);
    const urlHash = createHash('sha1').update(it.detailUrl).digest('hex').slice(0, 12);
    jobs.push({
      id: `${REHAB_BASEL_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: REHAB_BASEL_COMPANY_NAME,
      companyKey: REHAB_BASEL_KEY,
      companyDomain: REHAB_BASEL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: 'Basel',
      canton: 'BS',
      url: it.detailUrl,
      source: 'REHAB Basel Dedicated Parser (Talentsoft)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: 'Basel',
      addressRegion: 'BS',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: '4055',
      category: detectHealthcareCategory(title),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(title),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: it.detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  console.log(`📋 Total ${REHAB_BASEL_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
