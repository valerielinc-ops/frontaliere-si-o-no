#!/usr/bin/env node
/**
 * Novartis job parser — Fetcher and job builder.
 *
 * Source: https://novartis.ch/careers
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllNovartisJobs()  — Fetch and parse all jobs
 *   - isNovartisJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {
  isWorkModeLocationLabel,
  swissCityFromLocationField,
} from './target-swiss-locations.mjs';
import {
  buildWorkdayApiBase,
  fetchWorkdayJobs,
  fetchWorkdayJobDetailParts,
  workdayPostingDateFields,
  extractWorkdayJobIdentity,
  WorkdayAuthError,
} from './ats-clients/workday-client.mjs';
import { fetchWorkdayPrimarySwissLocation, fetchWorkdaySwissCanton } from './workday-swiss-job-parser-common.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { mergeSourcePostingDates } from './source-posting-date.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const NOVARTIS_KEY = 'novartis';
export const NOVARTIS_COMPANY_NAME = 'Novartis';
export const NOVARTIS_COMPANY_DOMAIN = 'novartis.com';
export const NOVARTIS_HOST = 'novartis.wd3.myworkdayjobs.com';

const WORKDAY_TENANT_HOST = 'novartis.wd3.myworkdayjobs.com';
const WORKDAY_SITE_PATH = 'Novartis_Careers';
const WORKDAY_API_BASE = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
const WORKDAY_PUBLIC_BASE = `https://${WORKDAY_TENANT_HOST}/en/${WORKDAY_SITE_PATH}`;
// Workday `locationCountry` facet ID for Switzerland (shared across most tenants).
const SWISS_LOCATION_IDS = ['187134fccb084a0ea9b4b95f23890dbe'];

const CAREER_URL = WORKDAY_PUBLIC_BASE;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Novartis.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isNovartisJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === NOVARTIS_KEY ||
    key.startsWith('novartis') ||
    company.includes('novartis') ||
    url.includes('novartis.wd3.myworkdayjobs.com') ||
    url.includes('novartis.com') ||
    url.includes('novartis.ch')
  );
}

/**
 * Validate that a URL belongs to Novartis's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === NOVARTIS_HOST ||
      host.endsWith('.novartis.com') ||
      host === 'novartis.com' ||
      host.endsWith('.novartis.ch') ||
      host === 'novartis.ch' ||
      host.endsWith('.myworkdayjobs.com')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Workday fetcher ──────────────────────────────────────────
 * Novartis Workday tenant: novartis.wd3.myworkdayjobs.com / Novartis_Careers
 * Switzerland filter uses the shared `locationCountry` facet ID.
 */
async function fetchJobListings() {
  const out = [];
  try {
    for await (const posting of fetchWorkdayJobs(WORKDAY_API_BASE, {
      locationFilters: SWISS_LOCATION_IDS,
      maxPages: 100000,
    })) {
      const id = extractWorkdayJobIdentity(posting, { apiBase: WORKDAY_API_BASE, company: NOVARTIS_COMPANY_NAME });
      out.push({
        title: id.title,
        location: id.location,
        locationRaw: posting.locationsText || '',
        url: id.applyUrl,
        ...workdayPostingDateFields(posting),
        externalPath: id.externalPath,
        jobReqId: id.jobReqId,
      });
    }
  } catch (err) {
    if (err instanceof WorkdayAuthError) {
      console.error(`❌ Workday anti-bot block: ${err.message}`);
      return [];
    }
    throw err;
  }
  return out;
}

/**
 * Fetch all Novartis jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllNovartisJobs() {
  console.log(`🔍 Fetching Novartis jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  let withoutBody = 0;
  for (const listing of listings) {
    // TODO: Extract fields from each listing.
    // Adapt these field names to match the actual API response.
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    // `listing.location` is '' for an "N Locations" roll-up: only the req's own
    // primary workplace may place it in Switzerland, never the Basel HQ
    // (issue 9842).
    // Workday's first segment of `Remote - Zurich` is the work mode: the place
    // is read from the whole label, and a work mode with no municipality
    // (`Remote`, `Hybrid (ZH)`, `Telelavoro - Ticino`) leaves no location.
    const listingLocation = isWorkModeLocationLabel(listing.location)
      ? swissCityFromLocationField(listing.locationRaw)
      : normalizeSpace(listing.location || '');
    const location = listing.location
      ? listingLocation
      : await fetchWorkdayPrimarySwissLocation(WORKDAY_API_BASE, listing.externalPath);
    const canton = location && !isWorkModeLocationLabel(location)
      ? await fetchWorkdaySwissCanton(WORKDAY_API_BASE, listing.externalPath, location)
      : '';
    if (!location || !canton) {
      console.log(`  ⏭️  Skipped location without a Swiss canton: ${listing.location || '(roll-up without Swiss primary)'} — ${title}`);
      continue;
    }
    const publicUrl = listing.url || CAREER_URL;

    // Workday listing endpoint NEVER returns the job body — see workday-client.mjs.
    // One detail request: the body, and the `timeType` the CXS listing row
    // never carries.
    const { text: detailDescription, info: detailInfo } = await fetchWorkdayJobDetailParts(
      WORKDAY_API_BASE,
      listing.externalPath,
      stripHtml,
    );
    const employmentType = detectEmploymentType(listing.timeType || detailInfo.timeType || title);
    await new Promise((r) => setTimeout(r, 400));

    // Only the posting's own text is published (issue 5253): a req whose
    // Workday detail has no body used to go out as a synthetic "Key details"
    // stub (location, employer, "apply on the portal"); it is not published
    // any more.
    if (!meetsSourceBodyFloor(detailDescription)) {
      console.log(`  ⏭️  No vacancy text in the Workday detail, not published: ${title}`);
      withoutBody += 1;
      continue;
    }
    const descriptionText = detailDescription;

    const sourceLang = detectLang(descriptionText || title, 'it');
    const jobSlug = slugify(`${title} novartis ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `novartis-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: NOVARTIS_COMPANY_NAME,
      companyKey: NOVARTIS_KEY,
      companyDomain: NOVARTIS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Novartis Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Farmaceutica / Biotecnologia',
      currency: 'CHF',
      featured: false,
      ...mergeSourcePostingDates(listing, workdayPostingDateFields({ jobPostingInfo: detailInfo })),
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  if (withoutBody > 0) {
    console.log(`  ⏭️  ${withoutBody} req(s) without vacancy text in the Workday detail — not published.`);
  }
  console.log(`\n📋 Total Novartis jobs discovered: ${jobs.length}`);
  return jobs;
}
