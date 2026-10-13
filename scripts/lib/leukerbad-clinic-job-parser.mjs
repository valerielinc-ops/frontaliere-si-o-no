#!/usr/bin/env node
/**
 * Leukerbad Clinic (RZL Rehabilitationszentrum Leukerbad AG) — Astro HTML.
 *
 * Official listings:
 *   https://leukerbadclinic.ch/de/karriere/offene-stellen
 *   https://leukerbadclinic.ch/fr/carriere/postes-vacants
 *
 * The clinic replaced its Nuxt/Prismic site in October 2026. The former
 * `leukerbad-clinic.cdn.prismic.io/api/v2` repository now returns HTTP 404,
 * while the old `/de/page/jobs/` route permanently redirects to the first
 * listing above. The replacement is server-rendered: each listing exposes
 * stable detail links and each detail exposes the vacancy body plus a
 * source-owned application URL. This crawler therefore follows the public
 * HTML contract instead of guessing a new private CMS endpoint.
 */
import { createHash } from 'node:crypto';
import { slugify } from './crawler-template.mjs';
import {
  decodeEntities,
  detectHealthcareCategory,
  detectHealthcareEmploymentType,
  detectHealthcareExperienceLevel,
  extractBalancedTagBlock,
  fetchHtml,
  htmlToText,
  locateTagByAttribute,
  normalizeSpace,
} from './hospital-custom-html-helpers.mjs';
import { sourcePostingDateFields } from './source-posting-date.mjs';

export const LEUKERBAD_CLINIC_KEY = 'leukerbad-clinic';
export const LEUKERBAD_CLINIC_COMPANY_NAME = 'Leukerbad Clinic';
export const LEUKERBAD_CLINIC_COMPANY_DOMAIN = 'leukerbadclinic.ch';

const BASE_URL = 'https://leukerbadclinic.ch';
const LISTINGS = [
  { lang: 'de', url: `${BASE_URL}/de/karriere/offene-stellen` },
  { lang: 'fr', url: `${BASE_URL}/fr/carriere/postes-vacants` },
];
const DEFAULT_CITY = 'Leukerbad';
const DEFAULT_POSTAL_CODE = '3954';

export function isLeukerbadClinicJob(job) {
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return (
    key === LEUKERBAD_CLINIC_KEY ||
    company.includes('leukerbad clinic') ||
    company.includes('rehabilitationszentrum leukerbad') ||
    url.includes('leukerbadclinic.ch') ||
    // Keep recognizing records emitted by the retired producer so the
    // standard pipeline can remove/replace them during this migration.
    url.includes('leukerbad-clinic.prismic.io') ||
    url.includes('leukerbad-clinic.cdn.prismic.io')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === LEUKERBAD_CLINIC_COMPANY_DOMAIN || host.endsWith(`.${LEUKERBAD_CLINIC_COMPANY_DOMAIN}`);
  } catch {
    return false;
  }
}

export function leukerbadClinicMatchKey(job = {}) {
  return String(job?.id || job?.url || '');
}

function innerHtmlByAttribute(html, attrMatcher, scanCap = 200_000) {
  const located = locateTagByAttribute(String(html || ''), attrMatcher, { skipVoidTags: true });
  return located ? extractBalancedTagBlock(located.rest, located.tagName, scanCap) : '';
}

function expectedDetailPrefix(lang) {
  return lang === 'fr' ? '/fr/carriere/postes-vacants/' : '/de/karriere/offene-stellen/';
}

/**
 * Parse only the source-owned vacancy list, never navigation/footer links.
 */
export function parseLeukerbadClinicListing(html, listingUrl, lang) {
  const listingHtml = innerHtmlByAttribute(html, 'data-testid=["\']liste-offres["\']');
  if (!listingHtml) throw new Error(`Leukerbad Clinic ${lang} listing contract missing: data-testid=liste-offres`);

  const expectedPrefix = expectedDetailPrefix(lang);
  const rows = [];
  const seen = new Set();
  const itemRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let itemMatch;
  while ((itemMatch = itemRe.exec(listingHtml)) !== null) {
    const block = itemMatch[1];
    const linkMatch = block.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    let detailUrl;
    try {
      detailUrl = new URL(decodeEntities(linkMatch[1]), listingUrl);
    } catch {
      continue;
    }
    if (!isTrustedDomain(detailUrl.href) || !detailUrl.pathname.startsWith(expectedPrefix)) continue;

    const title = normalizeSpace(htmlToText(linkMatch[2]));
    if (!title || title.length < 3 || seen.has(detailUrl.href)) continue;

    const conditionsMatch = block.match(/<p\b[^>]*class=["'][^"']*\bconditions\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
    const conditions = conditionsMatch ? normalizeSpace(htmlToText(conditionsMatch[1])) : '';
    seen.add(detailUrl.href);
    rows.push({ detailUrl: detailUrl.href, title, conditions, sourceLang: lang });
  }

  if (rows.length === 0) throw new Error(`Leukerbad Clinic ${lang} listing parsed zero source-owned vacancy links`);
  return rows;
}

function parseConditionFields(conditions = '') {
  const parts = String(conditions || '').split(/\s*·\s*/).map(normalizeSpace).filter(Boolean);
  const timePct = parts.find((part) => /\d\s*%/.test(part)) || '';
  const startingDate = parts.filter((part) => part !== timePct).join(' · ');
  return { timePct, startingDate };
}

/**
 * Read a detail page's source body and its explicit application handoff.
 */
export function parseLeukerbadClinicDetail(html, row) {
  const rawHtml = String(html || '');
  const h1Match = rawHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const title = normalizeSpace(htmlToText(h1Match?.[1] || '')) || row.title;

  const bodyHtml = innerHtmlByAttribute(rawHtml, 'class=["\'][^"\']*corps-page--colonne[^"\']*["\']');
  const description = normalizeSpace(htmlToText(bodyHtml));
  if (!title || title.length < 3) throw new Error(`Leukerbad Clinic detail has no title: ${row.detailUrl}`);
  if (!description || description.split(/\s+/).length < 50) {
    throw new Error(`Leukerbad Clinic detail body is below the 50-word source floor: ${row.detailUrl}`);
  }

  const applyMatch = rawHtml.match(/<a\b[^>]*href=["']([^"']*\?offre=[^"']+)["'][^>]*>/i);
  if (!applyMatch) throw new Error(`Leukerbad Clinic detail has no source application handoff: ${row.detailUrl}`);
  const applyUrl = new URL(decodeEntities(applyMatch[1]), row.detailUrl).href;
  if (!isTrustedDomain(applyUrl)) throw new Error(`Leukerbad Clinic application handoff is off-domain: ${applyUrl}`);

  return { title, description, applyUrl };
}

function buildJob(row, detail) {
  const { timePct, startingDate } = parseConditionFields(row.conditions);
  const identity = new URL(row.detailUrl).pathname.replace(/\/$/, '');
  const urlHash = createHash('sha1').update(identity).digest('hex').slice(0, 12);
  const slug = slugify(`${detail.title} ${LEUKERBAD_CLINIC_COMPANY_NAME} ${DEFAULT_CITY}`);
  const employmentType = detectHealthcareEmploymentType(`${timePct} ${detail.title}`);

  return {
    id: `${LEUKERBAD_CLINIC_KEY}-${urlHash}`,
    slug,
    slugByLocale: { [row.sourceLang]: slug },
    company: LEUKERBAD_CLINIC_COMPANY_NAME,
    companyKey: LEUKERBAD_CLINIC_KEY,
    companyDomain: LEUKERBAD_CLINIC_COMPANY_DOMAIN,
    title: detail.title,
    titleByLocale: { [row.sourceLang]: detail.title },
    description: detail.description,
    descriptionByLocale: { [row.sourceLang]: detail.description },
    location: DEFAULT_CITY,
    canton: 'VS',
    addressLocality: DEFAULT_CITY,
    addressRegion: 'VS',
    addressCountry: 'CH',
    country: 'CH',
    postalCode: DEFAULT_POSTAL_CODE,
    category: detectHealthcareCategory(`${detail.title} ${detail.description}`),
    sector: 'Salute / Riabilitazione',
    contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
    employmentType,
    experienceLevel: detectHealthcareExperienceLevel(detail.title),
    currency: 'CHF',
    featured: false,
    ...sourcePostingDateFields(''),
    url: row.detailUrl,
    applyUrl: detail.applyUrl,
    source: 'Leukerbad Clinic Dedicated Parser (official Astro HTML)',
    sourceLang: row.sourceLang,
    crawledAt: new Date().toISOString(),
    needsRetranslation: true,
    sourceConditions: [timePct, startingDate].filter(Boolean).join(' · '),
  };
}

export async function fetchAllLeukerbadClinicJobs() {
  console.log('🏥 Fetching Leukerbad Clinic jobs from official server-rendered HTML');
  const rows = [];
  for (const listing of LISTINGS) {
    console.log(`   Listing (${listing.lang}): ${listing.url}`);
    const html = await fetchHtml(listing.url);
    rows.push(...parseLeukerbadClinicListing(html, listing.url, listing.lang));
  }

  const jobs = [];
  const seenDetails = new Set();
  for (const row of rows) {
    if (seenDetails.has(row.detailUrl)) continue;
    seenDetails.add(row.detailUrl);
    const detailHtml = await fetchHtml(row.detailUrl);
    jobs.push(buildJob(row, parseLeukerbadClinicDetail(detailHtml, row)));
  }

  if (jobs.length === 0) throw new Error('Leukerbad Clinic official listings yielded no complete vacancies');
  console.log(`\n📋 Total unique Leukerbad Clinic jobs: ${jobs.length}`);
  return jobs;
}
