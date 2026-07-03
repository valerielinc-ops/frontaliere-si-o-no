#!/usr/bin/env node
/**
 * Rituals Cosmetics Switzerland job parser — Workday ATS.
 *
 * Tenant host: rituals.wd3.myworkdayjobs.com
 * Site path:   Rituals
 * Career URL:  https://www.rituals.com/en-ch/careers
 *
 * Rituals is a Dutch cosmetics / home-fragrance retailer with a large Swiss
 * retail network (shop-in-shop counters inside Manor department stores plus
 * standalone boutiques). Swiss legal entity HQ: Landquart GR. At the time of
 * this parser, the Workday tenant exposed ~638 open Swiss positions (mostly
 * retail sales advisor / stockroom roles across dozens of store locations).
 *
 * Workday quirk: this tenant uses the facet parameter `Location_Country`
 * (capitalised, underscore) rather than the more common `locationCountry` —
 * same as Abbott / Stryker. The generic `createWorkdaySwissParser` shared
 * factory only knows the `locationCountry` key, so it falls back to an
 * unfiltered global-board fetch capped at Workday's 2000-result window —
 * which mostly returns non-Swiss postings and drops almost all real CH
 * roles. This bespoke parser instead applies the Swiss facet directly (like
 * `abbott-job-parser.mjs`), which correctly scopes the API to CH.
 *
 * Location text format: `{City} {Store/Mall name}` (e.g. "Basel St Jakob
 * Park", "Manor Winterthur", "Landquart Fashion Outlet") — no separator and
 * no country/canton prefix. We strip a leading department-store partner
 * name (Manor/Coop/Migros/Globus/Jelmoli) then look up a known Swiss city
 * token anywhere in the remaining text.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllRitualsCosmeticsJobs() — Fetch and parse all Swiss jobs
 *   - isRitualsCosmeticsJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()              — Validate URLs belong to Rituals / Workday tenant
 *   - RITUALS_COSMETICS_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang, isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton, findSwissCityInText, canonicalSwissCityName } from './target-swiss-locations.mjs';
import {
  buildWorkdayApiBase,
  fetchWorkdayJobs,
  fetchWorkdayJobDescriptionText,
  parseWorkdayPostedDate,
  extractWorkdayJobIdentity,
  WorkdayAuthError,
} from './ats-clients/workday-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const RITUALS_COSMETICS_KEY = 'rituals-cosmetics';
export const RITUALS_COSMETICS_COMPANY_NAME = 'Rituals Cosmetics Switzerland';
export const RITUALS_COSMETICS_COMPANY_DOMAIN = 'rituals.com';

const WORKDAY_TENANT_HOST = 'rituals.wd3.myworkdayjobs.com';
const WORKDAY_SITE_PATH = 'Rituals';
const WORKDAY_API_BASE = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
const WORKDAY_PUBLIC_BASE = `https://${WORKDAY_TENANT_HOST}/en-US/${WORKDAY_SITE_PATH}`;

const CAREER_URL = 'https://www.rituals.com/en-ch/careers';

const DEFAULT_CITY = 'Landquart';
const DEFAULT_CANTON = 'GR';

// Switzerland country UUID is consistent across most Workday tenants.
const SWISS_LOCATION_IDS = ['187134fccb084a0ea9b4b95f23890dbe'];

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Rituals location strings look like:
 *   "Basel St Jakob Park"
 *   "Manor Winterthur"
 *   "Landquart Fashion Outlet"
 *   "Zürich Bahnhofstraße 69a"
 * No country/canton prefix, no separator. Strip a leading department-store
 * partner name, then look up a known Swiss city token in the remainder
 * (falls back to the raw text, then the first word).
 */
function cleanRitualsLocation(raw = '') {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (/\d+\s+location/i.test(trimmed)) return '';
  const stripped = trimmed.replace(/^\s*(manor|coop|migros|globus|jelmoli)\s+/i, '').trim() || trimmed;
  const cityToken = findSwissCityInText(stripped) || findSwissCityInText(trimmed);
  if (cityToken) return canonicalSwissCityName(cityToken) || cityToken;
  return stripped.split(/\s+/)[0] || trimmed.split(/\s+/)[0] || '';
}

/* ── Company matchers ──────────────────────────────────────── */

export function isRitualsCosmeticsJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === RITUALS_COSMETICS_KEY ||
    key.startsWith('rituals') ||
    company.includes('rituals') ||
    url.includes('rituals.com') ||
    url.includes(WORKDAY_TENANT_HOST)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === RITUALS_COSMETICS_COMPANY_DOMAIN ||
      host.endsWith(`.${RITUALS_COSMETICS_COMPANY_DOMAIN}`) ||
      host === WORKDAY_TENANT_HOST ||
      host.endsWith('.myworkdayjobs.com')
    );
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics ─────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(store\s*manager|filialleiter|assistant\s*store|stellvertret)/.test(t)) return 'Vendite';
  if (/\b(verkauf|sales|kundenberat|beauty\s*advisor|advisor)/.test(t)) return 'Vendite';
  if (/\b(warenverr|stockroom|lager|logist|supply|magazzin)/.test(t)) return 'Logistica';
  if (/\b(market|kommunikation|brand)/.test(t)) return 'Marketing';
  if (/\b(hr|human|talent|recruit|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(finance|account|controller|controlling|buchhalt|finanz)/.test(t)) return 'Finanza';
  if (/\b(it\b|sap|cloud|cyber|data|digital)/.test(t)) return 'IT';
  return 'Vendite';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|intern|stage|lehrstelle|lernende?r?|apprenti|ausbildung|trainee|aushilfe)/.test(t)) return 'intern';
  if (/\b(junior|jr\.?|entry|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr\.?|lead|head|director|principal|manager|leiter|leitend|verantwort|filialleiter)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(timeType = '', title = '') {
  const t = normalize(`${timeType} ${title}`);
  if (/\b(part.?time|teilzeit|aushilfe|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'FULL_TIME';
}

/* ── Workday fetcher ───────────────────────────────────────── */

async function fetchJobListings() {
  const out = [];
  try {
    for await (const posting of fetchWorkdayJobs(WORKDAY_API_BASE, {
      // Rituals tenant uses 'Location_Country' rather than 'locationCountry'.
      appliedFacets: { Location_Country: SWISS_LOCATION_IDS },
      maxPages: 100000,
    })) {
      const id = extractWorkdayJobIdentity(posting, {
        apiBase: WORKDAY_API_BASE,
        publicBase: WORKDAY_PUBLIC_BASE,
        company: RITUALS_COSMETICS_COMPANY_NAME,
      });
      out.push({
        title: id.title,
        locationRaw: posting.locationsText || id.location || '',
        url: id.applyUrl,
        postedAt: id.postedAt || (posting.postedOn ? parseWorkdayPostedDate(posting.postedOn) : null),
        externalPath: id.externalPath,
        jobReqId: id.jobReqId,
        timeType: posting.timeType || '',
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

export async function fetchAllRitualsCosmeticsJobs() {
  console.log(`🏭 Fetching ${RITUALS_COSMETICS_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}`);
  console.log(`   Workday: ${WORKDAY_API_BASE}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No Swiss job listings returned from Workday API.');
    return [];
  }

  console.log(`  📋 Swiss listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const rawLocation = listing.locationRaw || DEFAULT_CITY;
    if (isLocationExplicitlyForeign(rawLocation)) {
      console.log(`  ⏭️  Skipped foreign location: ${rawLocation} — ${title}`);
      continue;
    }
    const cleaned = cleanRitualsLocation(rawLocation);
    const location = cleaned || DEFAULT_CITY;
    const canton = inferSwissTargetCanton(location) || inferSwissTargetCanton(rawLocation) || DEFAULT_CANTON;
    const publicUrl = listing.url || CAREER_URL;

    // Workday listing endpoint never returns the body — fetch detail.
    const detailDescription = await fetchWorkdayJobDescriptionText(
      WORKDAY_API_BASE,
      listing.externalPath,
      stripHtml,
    );
    await new Promise((r) => setTimeout(r, 350));

    const fallbackDescription = [
      `${title} — ${RITUALS_COSMETICS_COMPANY_NAME}, ${location}.`,
      '',
      'Key details:',
      `• Location: ${location}${canton ? `, Kanton ${canton}` : ''}, Schweiz`,
      '• Employer: Rituals Cosmetics — cosmetica / home & body / profumeria di lusso olandese.',
      `• Swiss footprint: sede legale a ${DEFAULT_CITY} (${DEFAULT_CANTON}) + rete retail in tutta la Svizzera.`,
      '• Apply: Rituals Workday careers portal.',
    ].join('\n');
    const descriptionText = detailDescription.length >= 100 ? detailDescription : fallbackDescription;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} ${RITUALS_COSMETICS_KEY} ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      id: `${RITUALS_COSMETICS_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: RITUALS_COSMETICS_COMPANY_NAME,
      companyKey: RITUALS_COSMETICS_KEY,
      companyDomain: RITUALS_COSMETICS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't, translate-pending.yml picks the job up.
      needsRetranslation: true,
      location,
      canton,
      url: publicUrl,
      source: `${RITUALS_COSMETICS_COMPANY_NAME} Dedicated Parser (Workday)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.timeType || '', title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Cosmetica / Retail',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedAt || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (listing.jobReqId) job.jobReqId = listing.jobReqId;

    jobs.push(job);
  }

  console.log(`\n📋 Total ${RITUALS_COSMETICS_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
