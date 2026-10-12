import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { appendSlugDisambiguator } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { copySpecFetchMetadata, loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';
import { extractDetailFields } from './prospector/extract.mjs';
import { resolveSourceBackedSwissGeography } from './prospector/location-evidence.mjs';

export const LE_TEAM_KEY = 'le-team';
export const LE_TEAM_COMPANY_NAME = 'le team sa';
export const LE_TEAM_COMPANY_DOMAIN = 'team.jobs';

const CAREER_URL = 'https://team.jobs/fr/jobs?professionCategoryIds=5';

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function isLeTeamJob(job) {
  const companyKey = normalizeSpace(job?.companyKey || '').toLowerCase();
  const company = normalizeSpace(job?.company || '').toLowerCase();
  let host = '';
  try { host = new URL(job?.url || '').hostname.toLowerCase(); } catch { /* invalid URL */ }
  return companyKey === LE_TEAM_KEY
    || company.includes('le team')
    || company.includes('das team')
    || host === 'team.jobs'
    || host === 'www.team.jobs';
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'team.jobs' || host === 'www.team.jobs';
  } catch {
    return false;
  }
}

/** Extract only the employer's JobPosting record and its structured workplace. */
export function extractLeTeamDetailFields(html = '', pageUrl = '') {
  const detail = extractDetailFields(html, pageUrl);
  const structuredWorkplace = detail.hasStructuredVacancy ? detail.locationCandidates?.[0] : null;
  const geography = structuredWorkplace
    ? resolveSourceBackedSwissGeography(structuredWorkplace)
    : null;
  if (!geography) {
    return {
      ...detail,
      location: '',
      canton: '',
      addressLocality: '',
      addressRegion: '',
      addressCountry: '',
      country: '',
      postalCode: '',
      streetAddress: '',
      locationCandidates: [],
    };
  }
  return {
    ...detail,
    ...geography,
    locationCandidates: detail.locationCandidates?.length
      ? detail.locationCandidates
      : [{ location: geography.location, addressRegion: geography.canton }],
  };
}

async function fetchJobListings(runtime = {}) {
  return runSpecInProduction(loadSpec(LE_TEAM_KEY), {
    ...runtime,
    detailExtractor: extractLeTeamDetailFields,
  });
}

export async function fetchAllLeTeamJobs(runtime = {}) {
  const listings = await fetchJobListings(runtime);
  const jobs = [];

  for (const listing of listings || []) {
    const title = normalizeSpace(listing.title);
    const description = stripHtml(listing.description || '');
    const url = normalizeSpace(listing.url);
    const geography = resolveSourceBackedSwissGeography(listing.locationCandidates?.[0]
      || listing.location
      || '');
    if (title.length < 3 || !description || !url || !geography || !isTrustedDomain(url)) continue;

    const sourceLang = detectLang(`${title} ${description}`, 'fr');
    const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);
    const slugDisambiguator = urlHash.slice(0, 8);
    const slug = appendSlugDisambiguator(
      slugify(`${title} ${geography.location} le team sa`),
      slugDisambiguator,
    );
    jobs.push({
      id: `${LE_TEAM_KEY}-${urlHash}`,
      slug,
      slugByLocale: { [sourceLang]: slug },
      slugDisambiguator,
      company: LE_TEAM_COMPANY_NAME,
      companyKey: LE_TEAM_KEY,
      companyDomain: LE_TEAM_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: geography.location,
      canton: geography.canton,
      url,
      source: 'le team sa Official Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: listing.addressLocality || geography.location,
      addressRegion: geography.canton,
      ...(listing.addressCountry ? { addressCountry: listing.addressCountry, country: listing.addressCountry } : {}),
      employmentType: listing.employmentType || 'OTHER',
      contract: 'other',
      experienceLevel: 'mid',
      sector: 'Altro',
      currency: 'CHF',
      featured: false,
      ...mergeSourcePostingDates({}, listing),
      applyUrl: url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  return copySpecFetchMetadata(jobs, listings || []);
}

export { CAREER_URL as LE_TEAM_CAREER_URL };
