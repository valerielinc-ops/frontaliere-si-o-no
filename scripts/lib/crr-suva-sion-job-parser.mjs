#!/usr/bin/env node
/**
 * Clinique romande de réadaptation (CRR) — Suva-operated reference rehab
 * clinic in Sion (VS). Specialised in trauma rehabilitation and
 * reintegration of accident victims; ~580 collaborators. The Sion site
 * sits in the French-speaking Valais and is the Romandie counterpart of
 * Rehab Bellikon (AG).
 *
 * Public career page:
 *   https://www.crr-suva.ch/fr/la-clinique/carriere/offres-d-emploi-1999/
 *
 * The current TYPO3 listing renders employer-selected Jobup cards. Each
 * opening is linked from the CRR page as:
 *
 *   <a class="post-link" href="https://www.jobup.ch/en/jobs/detail/{uuid}/…">
 *     <h3 class="post-title …">{TITLE}</h3>
 *     <span class="post-resume-wrapper">Sion · {WORKLOAD}</span>
 *   </a>
 *
 * Jobup detail pages expose a schema.org JobPosting JSON-LD block containing
 * the source description, publication date, employment type and workplace
 * address. The CRR listing remains the company-association boundary: Jobup is
 * a shared board and must never be scanned globally for this employer.
 *
 * Polite delay: 250 ms between detail-page fetches.
 */
import { createHash } from 'node:crypto';
import { sourcePostingDateFields } from './source-posting-date.mjs';
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
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import {
  extractJobPostingLd,
  jobPostingAddress,
  jobPostingDescriptionText,
} from './jsonld-jobposting.mjs';

export const CRR_KEY = 'crr-suva-sion';
export const CRR_COMPANY_NAME = 'Clinique romande de réadaptation (CRR Suva)';
export const CRR_COMPANY_DOMAIN = 'crr-suva.ch';

const LISTING_URL = 'https://www.crr-suva.ch/fr/la-clinique/carriere/offres-d-emploi-1999/';
const DETAIL_DELAY_MS = 250;
const JOBUP_DETAIL_PATH_RE = /^\/(?:[a-z]{2}\/)?(?:jobs|emplois)\/detail\/[0-9a-f-]{36}\/?$/i;

export function isCrrJob(job) {
  const url = String(job?.url || '').toLowerCase();
  if (job?.companyKey === CRR_KEY) return true;
  return url.includes('crr-suva.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'crr-suva.ch'
      || host.endsWith('.crr-suva.ch')
      || host === 'jobup.ch'
      || host.endsWith('.jobup.ch');
  } catch {
    return false;
  }
}

function anchorAttribute(attributes = '', name = '') {
  const match = String(attributes).match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match?.[2] || '';
}

function elementTextByClass(html = '', tag = '', classToken = '') {
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let match;
  while ((match = re.exec(html))) {
    const classes = anchorAttribute(match[1], 'class').split(/\s+/).filter(Boolean);
    if (!classes.includes(classToken)) continue;
    return normalizeSpace(decodeEntities(match[2].replace(/<[^>]+>/g, ' ')));
  }
  return '';
}

function canonicalJobupDetailUrl(rawUrl = '') {
  try {
    const url = new URL(decodeEntities(rawUrl), LISTING_URL);
    const host = url.hostname.toLowerCase();
    if (!(host === 'jobup.ch' || host.endsWith('.jobup.ch'))) return '';
    if (!JOBUP_DETAIL_PATH_RE.test(url.pathname)) return '';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

export function parseListing(html = '') {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const className = anchorAttribute(m[1], 'class');
    if (!/(?:^|\s)post-link(?:\s|$)/i.test(className)) continue;
    const url = canonicalJobupDetailUrl(anchorAttribute(m[1], 'href'));
    if (!url) continue;
    if (seen.has(url)) continue;

    const title = elementTextByClass(m[2], 'h3', 'post-title');
    if (!title) continue;

    const resume = elementTextByClass(m[2], 'span', 'post-resume-wrapper');
    const [location = '', ...workloadParts] = resume.split(/\s*·\s*/);

    seen.add(url);
    out.push({
      url,
      title,
      location: normalizeSpace(location),
      workload: normalizeSpace(workloadParts.join(' · ')),
    });
  }
  return out;
}

export function extractDetailBody(html) {
  return parseCrrDetail(html)?.body || '';
}

export function parseCrrDetail(html = '') {
  const posting = extractJobPostingLd(html);
  if (!posting) return null;

  const title = normalizeSpace(decodeEntities(String(posting.title || '')));
  if (!title) return null;
  const hiringOrganizationName = normalizeSpace(decodeEntities(
    String(posting.hiringOrganization?.name || ''),
  ));
  const normalizedOrganization = hiringOrganizationName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (!/clinique romande de readaptation|(?:^|\W)crr(?:\W|$)/.test(normalizedOrganization)) {
    return null;
  }

  const address = jobPostingAddress(posting);
  const addressLocality = address.addressLocality
    || (/^sion$/i.test(address.addressRegion) ? address.addressRegion : '');
  const rawLocation = Array.isArray(posting.jobLocation)
    ? posting.jobLocation[0]
    : posting.jobLocation;
  const addressCountry = normalizeSpace(String(rawLocation?.address?.addressCountry || ''));
  const employmentType = normalizeSpace(
    (Array.isArray(posting.employmentType) ? posting.employmentType : [posting.employmentType])
      .filter(Boolean)
      .join(' '),
  );

  return {
    title,
    hiringOrganizationName,
    body: jobPostingDescriptionText(posting.description || ''),
    datePosted: typeof posting.datePosted === 'string' ? posting.datePosted : '',
    employmentType,
    addressLocality: normalizeSpace(addressLocality),
    streetAddress: address.streetAddress,
    postalCode: address.postalCode,
    addressCountry,
  };
}

async function fetchDetail(url, fetchPage = fetchHtml) {
  try {
    const html = await fetchPage(url);
    return parseCrrDetail(html);
  } catch (err) {
    console.warn(`  ⚠️ Detail fetch failed (${url}): ${err?.message || err}`);
    return null;
  }
}

export async function fetchAllCrrJobs({
  fetchPage = fetchHtml,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  console.log(`🏥 Fetching ${CRR_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}\n`);

  let html;
  try {
    html = await fetchPage(LISTING_URL);
  } catch (err) {
    console.warn(`⚠️ Listing fetch failed: ${err?.message || err}`);
    throw err;
  }
  const rows = parseListing(html);
  console.log(`  ✓ ${rows.length} Jobup openings discovered`);
  if (!rows.length) return [];

  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (i > 0) await sleep(DETAIL_DELAY_MS);
    const detail = await fetchDetail(r.url, fetchPage);
    if (!detail) {
      console.warn(`  ⚠️ Skipping ${r.url} — no CRR JobPosting JSON-LD found`);
      continue;
    }
    const title = detail.title;
    if (!title || title.length < 3) continue;

    // Only source text (issue 5253): no "<title> à la Clinique romande de
    // réadaptation…" paragraph in place of, or in front of, a thin body. A
    // body under the common 50-word floor gives no description (the shared
    // pipeline's thin-source path).
    const description = meetsSourceBodyFloor(detail.body) ? detail.body : '';

    const sourceLang = detectLang(description || title, 'fr');
    const jobSlug = slugify(`${title} ${CRR_KEY} sion`);
    const urlHash = createHash('sha1').update(r.url).digest('hex').slice(0, 12);
    const location = detail.addressLocality || r.location || 'Sion';
    const isSion = /^sion$/i.test(location);
    const employmentType = detectHealthcareEmploymentType(
      `${title} ${description} ${detail.employmentType}`,
      r.workload,
    );
    const contract = /\b(?:internship|apprenticeship|stage|stagiaire|apprenti)/i
      .test(`${detail.employmentType} ${title}`)
      ? 'internship'
      : employmentType === 'PART_TIME' ? 'part-time' : 'full-time';

    jobs.push({
      id: `${CRR_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CRR_COMPANY_NAME,
      companyKey: CRR_KEY,
      companyDomain: CRR_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band.
      needsRetranslation: true,
      location,
      canton: 'VS',
      url: r.url,
      source: `${CRR_COMPANY_NAME} Dedicated Parser (CRR listing + Jobup JobPosting JSON-LD)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: 'VS',
      streetAddress: detail.streetAddress || (isSion ? 'Avenue Grand Champsec 90' : ''),
      addressCountry: detail.addressCountry || 'CH',
      country: 'CH',
      postalCode: detail.postalCode || (isSion ? '1950' : ''),
      category: detectHealthcareCategory(`${title} ${description.slice(0, 600)}`),
      contract,
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      ...sourcePostingDateFields(detail.datePosted),
      applyUrl: r.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${CRR_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { LISTING_URL };
