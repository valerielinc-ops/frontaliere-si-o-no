#!/usr/bin/env node
/**
 * Clinique CIC — private surgical group operating two Romandie clinics:
 *   - Clinique CIC Saxon (1907 Saxon, VS)
 *   - Clinique CIC Clarens (1815 Clarens, VD)
 *
 * The corporate careers page now embeds the JobCloud Company Page at
 * company.jobcloud.ch. The listing and detail pages are server-rendered HTML;
 * the former jobup.ch company-mask endpoint is kept out of the discovery path
 * because it no longer reflects the live source.
 *
 * JobCloud also publishes one "Offres spontanées" page per clinic. Those are
 * application invitations, not vacancies, and are discarded after fetching the
 * detail page so a real vacancy cannot be confused with a placeholder.
 */
import { sourcePostingDateFields } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
  parseSwissShortDate,
} from './hospital-custom-html-helpers.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';

export const CIC_KEY = 'clinique-cic';
export const CIC_COMPANY_NAME = 'Clinique CIC (Saxon & Clarens)';
export const CIC_COMPANY_DOMAIN = 'cliniquecic-saxon.ch';

const ATS_HOST = 'company.jobcloud.ch';
const LISTING_SLUG = 'clinique-cic-suisse';
// locale-segment-ok: fixed external JobCloud Company Page seed; /fr/ is the portal's source route, not this site's locale path. extractListingLinks() follows the detail links returned by that seed.
const LISTING_URL = `https://${ATS_HOST}/fr/job-list/${LISTING_SLUG}`;
const PUBLIC_CAREER_URL = 'https://www.cliniquecic-saxon.ch/fr/emplois';
const DETAIL_DELAY_MS = 250;

const JOB_DETAIL_PATH_RE = new RegExp(
  `^/[a-z]{2}/jobs/(?:${LISTING_SLUG}/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/?$`,
  'i',
);
const JOBCLOUD_EMPTY_INITIAL_JOBS_RE = /\\?"initialJobs\\?"\s*:\s*\[\s*\]/;
const JOBCLOUD_NON_EMPTY_INITIAL_JOBS_RE = /\\?"initialJobs\\?"\s*:\s*\[\s*[^\]\s]/;
const JOBCLOUD_NO_POSITIONS_TEXT_RE = /Aucun poste ouvert|Aucune offre d'emploi|No open positions|Keine offenen Stellen/i;

function decodeNumericEntities(value = '') {
  return String(value || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function isCicJob(job) {
  const key = normalize(job?.companyKey);
  const company = normalize(job?.company);
  const url = normalize(job?.url);
  if (key === CIC_KEY) return true;
  if (/clinique\s+cic/.test(company)) return true;
  if (url.includes('cliniquecic-saxon.ch') || url.includes('cliniquecic.ch')) return true;
  if (url.includes(ATS_HOST) && url.includes(`/jobs/${LISTING_SLUG}/`)) return true;
  if (url.includes('jobup.ch') && /clinique[\s-]?cic/i.test(company)) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === ATS_HOST
      || host === 'cliniquecic-saxon.ch'
      || host.endsWith('.cliniquecic-saxon.ch')
      || host === 'cliniquecic.ch'
      || host.endsWith('.cliniquecic.ch')
      || host === 'jobup.ch'
      || host === 'www.jobup.ch';
  } catch {
    return false;
  }
}

/**
 * Extract the JobCloud detail links belonging to this company's listing.
 * The current source includes the company slug before the UUID; the optional
 * short form keeps the parser compatible with the earlier JobCloud URL shape.
 */
export function extractListingLinks(html = '') {
  const source = String(html || '');
  const hrefRe = /href\s*=\s*(["'])((?:https?:\/\/company\.jobcloud\.ch)?\/[a-z]{2}\/jobs\/(?:clinique-cic-suisse\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?(?:[?#][^"']*)?)\1/gi;
  const seen = new Set();
  let match;
  while ((match = hrefRe.exec(source)) !== null) {
    const rawHref = decodeNumericEntities(decodeEntities(match[2])).replace(/&amp;/g, '&');
    try {
      const parsed = new URL(rawHref, `https://${ATS_HOST}`);
      if (parsed.hostname.toLowerCase() !== ATS_HOST || !JOB_DETAIL_PATH_RE.test(parsed.pathname)) continue;
      const pathname = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
      seen.add(`https://${ATS_HOST}${pathname}`);
    } catch {
      // Ignore malformed links and keep scanning the source page.
    }
  }
  return [...seen];
}

/**
 * A zero is authoritative only when JobCloud itself renders its explicit
 * empty state. An unreadable or redesigned page remains a fail-closed zero.
 */
export function isJobCloudListingProvenEmpty(html = '') {
  const source = String(html || '');
  if (!source) return false;
  return JOBCLOUD_EMPTY_INITIAL_JOBS_RE.test(source)
    && !JOBCLOUD_NON_EMPTY_INITIAL_JOBS_RE.test(source)
    && JOBCLOUD_NO_POSITIONS_TEXT_RE.test(htmlToText(source))
    && extractListingLinks(source).length === 0;
}

function inferLocalityFromSite(site = '', title = '') {
  const text = `${site} ${title}`.toLowerCase();
  if (/clarens|montreux|1815/.test(text)) return { city: 'Clarens', postalCode: '1815', canton: 'VD' };
  if (/saxon|1907/.test(text)) return { city: 'Saxon', postalCode: '1907', canton: 'VS' };
  return { city: 'Saxon', postalCode: '1907', canton: 'VS' };
}

function extractKeyInfoValue(html, labelPattern) {
  const re = new RegExp(
    `<div[^>]*>\\s*(?:${labelPattern}):?\\s*</div>\\s*<div[^>]*class=["'][^"']*\\btext-size-small\\b[^"']*["'][^>]*>([\\s\\S]*?)</div>`,
    'i',
  );
  const match = String(html || '').match(re);
  return match ? normalizeSpace(htmlToText(match[1])) : '';
}

function extractRichTextBlock(html = '') {
  const startMatch = String(html || '').match(/class\s*=\s*(["'])[^"']*\b(?:text-rich-text[^"']*\bw-richtext|w-richtext[^"']*\btext-rich-text)[^"']*\1[^>]*>/i);
  if (!startMatch) return '';
  const contentStart = startMatch.index + startMatch[0].length;
  const endMatch = String(html).slice(contentStart).match(/<[^>]*\bjob_details_content-right\b[^>]*>/i);
  const endIdx = endMatch ? contentStart + endMatch.index : -1;
  return String(html).slice(contentStart, endIdx === -1 ? undefined : endIdx);
}

function extractApplyUrl(html = '', detailUrl = LISTING_URL) {
  const tags = String(html || '').match(/<a\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/\bid\s*=\s*(["'])job-ad-apply-btn\1/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*(["'])([^"']+)\1/i);
    if (href) {
      const value = decodeNumericEntities(decodeEntities(href[2])).replace(/&amp;/g, '&');
      try {
        return new URL(value, detailUrl).toString();
      } catch {
        return '';
      }
    }
  }
  return '';
}

const MONTHS = new Map([
  ['january', 1], ['janvier', 1], ['januar', 1], ['jan', 1],
  ['february', 2], ['fevrier', 2], ['februar', 2], ['feb', 2],
  ['march', 3], ['mars', 3], ['marz', 3], ['maerz', 3], ['mar', 3],
  ['april', 4], ['avril', 4], ['apr', 4],
  ['may', 5], ['mai', 5],
  ['june', 6], ['juin', 6], ['juni', 6], ['jun', 6],
  ['july', 7], ['juillet', 7], ['juli', 7], ['jul', 7],
  ['august', 8], ['aout', 8], ['aug', 8],
  ['september', 9], ['septembre', 9], ['sep', 9], ['sept', 9],
  ['october', 10], ['octobre', 10], ['oktober', 10], ['oct', 10],
  ['november', 11], ['novembre', 11], ['nov', 11],
  ['december', 12], ['decembre', 12], ['dezember', 12], ['dec', 12],
]);

function normalizePostedDate(rawDate = '') {
  const value = normalizeSpace(decodeNumericEntities(rawDate));
  const shortDate = parseSwissShortDate(value);
  if (shortDate) return shortDate;
  const match = value.match(/^(\d{1,2})\.\s*([\p{L}.]+)\s+(\d{4})$/u);
  if (!match) return '';
  const monthName = match[2]
    .replace(/\.$/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const month = MONTHS.get(monthName);
  if (!month) return '';
  const iso = `${match[3]}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  return sourcePostingDateFields(iso).postedDate;
}

async function fetchDetailData(detailUrl) {
  const html = await fetchHtml(detailUrl);
  const titleMatch = String(html).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? normalizeSpace(htmlToText(titleMatch[1])) : '';
  const description = normalizeSpace(htmlToText(extractRichTextBlock(html)));
  const datePosted = normalizePostedDate(extractKeyInfoValue(html, 'Date de publication|Publication date|Veröffentlichungsdatum'));
  const occupationRange = extractKeyInfoValue(html, "Taux d[’']activité|Taux d[’']occupation|Workload|Pensum");
  const contractTypeRaw = extractKeyInfoValue(html, 'Type de contrat|Contract type|Vertragsart');
  const lieuDeTravail = extractKeyInfoValue(html, 'Lieu de travail|Work location|Arbeitsort');
  const applyUrl = extractApplyUrl(html, detailUrl);
  return { title, description, datePosted, occupationRange, contractTypeRaw, lieuDeTravail, applyUrl };
}

export async function fetchAllCicJobs() {
  console.log(`🏥 Fetching ${CIC_COMPANY_NAME} jobs`);
  console.log(`   Listing: ${LISTING_URL}`);
  console.log(`   Public: ${PUBLIC_CAREER_URL}\n`);

  const listingHtml = await fetchHtml(LISTING_URL);
  const links = extractListingLinks(listingHtml);
  if (!links.length) {
    if (isJobCloudListingProvenEmpty(listingHtml)) {
      console.log('  ✅ JobCloud explicitly reports no open positions.');
      return markAuthoritativeEmptySnapshot([], 'JobCloud company page initialJobs=[] with an explicit no-open-positions message');
    }
    console.warn('⚠️ JobCloud listing exposed no recognisable job links; preserving the previous slice.');
    return [];
  }

  console.log(`  ✓ ${links.length} JobCloud detail link(s) found`);
  const jobs = [];
  let placeholderCount = 0;
  let detailFailures = 0;
  let firstDetailError = null;

  for (let i = 0; i < links.length; i += 1) {
    const detailUrl = links[i];
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, DETAIL_DELAY_MS));
    let detail;
    try {
      detail = await fetchDetailData(detailUrl);
    } catch (error) {
      detailFailures += 1;
      firstDetailError ??= error;
      console.warn(`  ⚠️ Detail fetch failed (${detailUrl}): ${error?.message || error}`);
      continue;
    }

    if (/offres?\s+spontan/i.test(detail.title)) {
      placeholderCount += 1;
      continue;
    }
    if (!detail.title || detail.title.length < 3) {
      throw new Error(`JobCloud detail has no usable title: ${detailUrl}`);
    }

    const loc = inferLocalityFromSite(detail.lieuDeTravail, detail.title);
    if (!meetsSourceBodyFloor(detail.description)) {
      throw new Error(`JobCloud detail has no source body meeting the minimum: ${detailUrl}`);
    }
    const description = detail.description;
    const sourceLang = detectLang(description || detail.title, 'fr');
    const jobSlug = slugify(`${detail.title} ${CIC_KEY} ${loc.city}`);
    const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);
    const publication = sourcePostingDateFields(detail.datePosted);

    jobs.push({
      id: `${CIC_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CIC_COMPANY_NAME,
      companyKey: CIC_KEY,
      companyDomain: CIC_COMPANY_DOMAIN,
      title: detail.title,
      titleByLocale: { [sourceLang]: detail.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: loc.city,
      canton: loc.canton,
      url: detailUrl,
      source: `${CIC_COMPANY_NAME} Dedicated Parser (JobCloud Company Page)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: loc.city,
      addressRegion: loc.canton,
      streetAddress: '',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: loc.postalCode,
      hiringOrganization: { name: CIC_COMPANY_NAME },
      category: detectHealthcareCategory(`${detail.title} ${description.slice(0, 500)}`),
      contract: /\b\d{2,3}\s*[–-]\s*\d{2,3}\s*%\b/.test(detail.occupationRange)
        ? 'part-time'
        : (/\b100\s*%\b/.test(detail.occupationRange) ? 'full-time' : 'full-time'),
      employmentType: detectHealthcareEmploymentType(`${detail.title} ${detail.occupationRange}`),
      experienceLevel: detectHealthcareExperienceLevel(detail.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      ...publication,
      applyUrl: detail.applyUrl || detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  if (detailFailures > 0) throw firstDetailError;
  if (!jobs.length && detailFailures === 0 && placeholderCount === links.length) {
    return markAuthoritativeEmptySnapshot([], 'JobCloud listing contained only explicit Offres spontanées placeholder pages');
  }

  console.log(`📋 Total ${CIC_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { LISTING_URL, PUBLIC_CAREER_URL, slugify };
