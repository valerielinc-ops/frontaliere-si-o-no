#!/usr/bin/env node
import { sourcePostingDateFields } from './source-posting-date.mjs';
import { extractJobPostingLd } from './jsonld-jobposting.mjs';
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
import { classAttrRx, slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import { fetchDualooDetail } from './dualoo-detail.mjs';

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
  // Dualoo has kept the `jobElement` card contract, but its attribute order
  // and utility classes are not stable. Keep each card as the parsing unit so
  // a harmless markup reorder cannot turn a live portal into a false empty.
  const blockRe = new RegExp(
    `<a\\b[^>]*${classAttrRx('jobElement')}[^>]*>[\\s\\S]*?<\\/a>`,
    'gi',
  );
  const spanMatch = (block, className) => block.match(new RegExp(
    `<span\\b[^>]*${classAttrRx(className)}[^>]*>([\\s\\S]*?)<\\/span>`,
    'i',
  ));
  const attributeValue = (source, name) => {
    const match = String(source || '').match(
      new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'),
    );
    return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
  };
  let m;
  while ((m = blockRe.exec(html))) {
    const block = m[0];
    const href = attributeValue(block, 'href');
    if (!href) continue;
    const eventData = attributeValue(block, 'data-eventData');
    let meta = {};
    if (eventData) {
      try {
        meta = JSON.parse(decodeEntities(eventData));
      } catch {
        meta = {};
      }
    }
    const titleMatch = spanMatch(block, 'jobName');
    const cityMatch = spanMatch(block, 'cityName');
    const categoryMatch = spanMatch(block, 'jobCategory');
    const dateTagMatch = block.match(new RegExp(
      `<span\\b[^>]*${classAttrRx('jobDate')}[^>]*>`,
      'i',
    ));
    const dateMatch = spanMatch(block, 'jobDate');
    const spanTitle = titleMatch
      ? normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ' ')))
      : '';
    const eventTitle = normalizeSpace(decodeEntities(String(meta.jobName || '')));
    const title = spanTitle || eventTitle;
    const cityName = cityMatch
      ? normalizeSpace(decodeEntities(cityMatch[1].replace(/<[^>]+>/g, ' ')))
      : '';
    const category = categoryMatch
      ? normalizeSpace(decodeEntities(categoryMatch[1].replace(/<[^>]+>/g, ' ')))
      : '';
    const startDateMachine = normalizeSpace(decodeEntities(
      attributeValue(dateTagMatch?.[0], 'data-date') || String(meta.startDate || ''),
    ));
    const startDateHuman = dateMatch
      ? normalizeSpace(decodeEntities(dateMatch[1].replace(/<[^>]+>/g, ' ')))
      : '';
    if (!title || title.length < 3) continue;
    // UUID is in the href path: /s60emmh3/{UUID}/detail?lang=DE
    const uuidMatch = href.match(/\/([a-f0-9-]{36})\/detail/);
    const uuid = uuidMatch ? uuidMatch[1] : href;
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    const normalizedHref = href.replace(/^\/+/, '');
    const detailPath = normalizedHref.replace(new RegExp(`^${DUALOO_PORTAL}/`), '');
    const url = href.startsWith('http') ? href : `${DETAIL_BASE}/${detailPath}`;
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
  console.log(`  📄 Fetching detail pages for rich descriptions...`);

  const jobs = [];
  let detailHits = 0;
  for (const it of items) {
    const title = it.title;
    let publication = sourcePostingDateFields('');
    const detailContent = await fetchDualooDetail(it.url, { fetchPage: async (url) => {
      const detailHtml = await fetchHtml(url);
      publication = sourcePostingDateFields(extractJobPostingLd(detailHtml)?.datePosted);
      return detailHtml;
    } });
    if (detailContent) detailHits++;
    await new Promise((r) => setTimeout(r, 200));
    const description = [
      detailContent,
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
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
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
      ...publication,
      applyUrl: it.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }
  console.log(`📋 Total ${KLINIK_ARLESHEIM_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${items.length} with rich detail content)`);
  return jobs;
}
