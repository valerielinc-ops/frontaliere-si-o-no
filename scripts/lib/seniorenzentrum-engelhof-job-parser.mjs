#!/usr/bin/env node
/**
 * Seniorenzentrum Engelhof job parser.
 *
 * The official career page links to a dedicated EmployerBoard tenant. The
 * promoted spec reads that official page and the linked tenant listing; this
 * parser keeps only source titles relevant to the oss:SZ coverage unit.
 */
import { createHash } from 'node:crypto';
import { mergeSourcePostingDates } from './source-posting-date.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { matchProfessionTitle, normalizeText } from './profession-taxonomy.mjs';
import { loadSpec, runSpecInProduction } from './prospector/spec-crawler.mjs';
import {
  resolveSourceBackedSwissGeography,
  sourceBackedSwissGeographyFields,
} from './prospector/location-evidence.mjs';
import {
  detectHealthcareEmploymentType,
  detectHealthcareExperienceLevel,
} from './hospital-custom-html-helpers.mjs';

export const SENIORENZENTRUM_ENGELHOF_KEY = 'seniorenzentrum-engelhof';
export const SENIORENZENTRUM_ENGELHOF_COMPANY_NAME = 'Seniorenzentrum Engelhof';
export const SENIORENZENTRUM_ENGELHOF_COMPANY_DOMAIN = 'seniorenzentrum-engelhof.ch';

const CAREER_URL = 'https://seniorenzentrum-engelhof.ch/arbeiten-im-engelhof/freie-stellen';
const EMPLOYER_BOARD_HOST = 'seniorenzentrum-engelhof.employerboard.ch';

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/**
 * EmployerBoard does not use the exact "OSS" label for every Swiss care
 * qualification. The shared title taxonomy maps Pflegehelfer/in to
 * assistente-cura, while the canton profession matcher includes that same
 * role in its OSS surface. Keep both IDs, plus the source's explicit EBA
 * qualification, and do not classify a neighbouring nursing/management role.
 */
export function isSeniorenzentrumEngelhofOssJob(job = {}) {
  const title = normalizeSpace(job?.title || '');
  if (!title) return false;

  const professionId = matchProfessionTitle(title);
  if (professionId === 'oss' || professionId === 'assistente-cura') return true;

  const sourceTitle = normalizeText(title);
  return sourceTitle.includes('gesundheit')
    && sourceTitle.includes('soziales')
    && sourceTitle.includes('eba');
}

export function isSeniorenzentrumEngelhofJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');

  return (
    key === SENIORENZENTRUM_ENGELHOF_KEY
    || company.includes(normalize(SENIORENZENTRUM_ENGELHOF_COMPANY_NAME))
    || isTrustedDomain(job?.url || '')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === SENIORENZENTRUM_ENGELHOF_COMPANY_DOMAIN
      || host.endsWith('.' + SENIORENZENTRUM_ENGELHOF_COMPANY_DOMAIN)
      || host === EMPLOYER_BOARD_HOST;
  } catch {
    return false;
  }
}

function normalizedEmploymentType(listing, title) {
  const raw = normalize(listing?.employmentType || '');
  if (['full_time', 'part_time', 'contractor', 'intern', 'other'].includes(raw)) {
    return raw.toUpperCase();
  }
  return detectHealthcareEmploymentType(
    title + ' ' + (listing?.timeType || '') + ' ' + (listing?.employmentType || ''),
  );
}

function buildJob(listing = {}) {
  const title = normalizeSpace(listing.title || '');
  if (!isSeniorenzentrumEngelhofOssJob({ title })) return null;
  if (!listing.url) return null;

  const sourceGeographyEvidence = {
    location: listing.location,
    addressLocality: listing.addressLocality,
    addressRegion: listing.addressRegion,
    addressCountry: listing.addressCountry,
    country: listing.country,
    postalCode: listing.postalCode,
    streetAddress: listing.streetAddress,
  };
  const resolvedGeography = resolveSourceBackedSwissGeography(listing);
  const geography = resolvedGeography
    && sourceBackedSwissGeographyFields(sourceGeographyEvidence, resolvedGeography);
  // A missing or ambiguous source workplace is a drop, never an Engelhof HQ
  // fallback. The job page must prove its own Swiss location.
  if (!geography) return null;

  const descriptionText = stripHtml(listing.description || '');
  if (!meetsSourceBodyFloor(descriptionText)) return null;

  const {
    location,
    canton,
    addressLocality,
    addressRegion,
    addressCountry,
    postalCode,
    streetAddress,
  } = geography;
  const publicUrl = String(listing.url);
  const sourceLang = detectLang(title + '\n' + descriptionText, 'de');
  const jobSlug = slugify(title + ' ' + location + ' ' + SENIORENZENTRUM_ENGELHOF_KEY);
  const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
  const employmentType = normalizedEmploymentType(listing, title);

  return {
    id: SENIORENZENTRUM_ENGELHOF_KEY + '-' + urlHash,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: SENIORENZENTRUM_ENGELHOF_COMPANY_NAME,
    companyKey: SENIORENZENTRUM_ENGELHOF_KEY,
    companyDomain: SENIORENZENTRUM_ENGELHOF_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description: descriptionText,
    descriptionByLocale: { [sourceLang]: descriptionText },
    location,
    canton,
    url: publicUrl,
    source: 'Seniorenzentrum Engelhof Dedicated Parser (official career board)',
    sourceLang,
    crawledAt: new Date().toISOString(),
    addressLocality: normalizeSpace(addressLocality || location),
    addressRegion: normalizeSpace(addressRegion || canton),
    addressCountry: normalizeSpace(addressCountry || 'CH'),
    country: normalizeSpace(addressCountry || 'CH'),
    postalCode: normalizeSpace(postalCode || ''),
    streetAddress: normalizeSpace(streetAddress || ''),
    baseSalary: null,
    category: 'Sanità / Ospedali',
    contract: employmentType === 'PART_TIME'
      ? 'part-time'
      : employmentType === 'FULL_TIME' ? 'full-time' : 'other',
    employmentType,
    experienceLevel: detectHealthcareExperienceLevel(title),
    sector: 'Sanità / Ospedali',
    currency: 'CHF',
    featured: false,
    ...mergeSourcePostingDates({}, listing),
    applyUrl: listing.applyUrl || publicUrl,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
  };
}

async function fetchJobListings() {
  const spec = loadSpec(SENIORENZENTRUM_ENGELHOF_KEY);
  return runSpecInProduction(spec);
}

export async function fetchAllSeniorenzentrumEngelhofJobs() {
  console.log('🔍 Fetching ' + SENIORENZENTRUM_ENGELHOF_COMPANY_NAME + ' jobs');
  console.log('   Source: ' + CAREER_URL + '\n');

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log('  📋 Source listings found: ' + listings.length);
  const jobs = listings.map(buildJob).filter(Boolean);

  console.log('\n📋 Total ' + SENIORENZENTRUM_ENGELHOF_COMPANY_NAME + ' OSS jobs discovered: ' + jobs.length);
  return jobs;
}
