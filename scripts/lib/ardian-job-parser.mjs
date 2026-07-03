#!/usr/bin/env node
/**
 * Ardian job parser — Workday ATS (Swiss operations).
 *
 * Tenant host: ardian.wd103.myworkdayjobs.com
 * Site path:   ArdianCareers
 * Career URL:  https://ardian.wd103.myworkdayjobs.com/ArdianCareers
 *
 * Ardian is a global private equity / investment firm headquartered in Paris.
 * Its Swiss office is in Zurich. Ardian's Workday tenant lists roles across
 * all its global offices (Paris, London, Frankfurt, New York, Zurich, ...) —
 * we filter to Switzerland via the standard `locationCountry` facet so only
 * Zurich (and any other CH office) roles are ingested.
 *
 * Location text format observed: plain city name (e.g. "Zurich").
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllArdianJobs() — Fetch and parse all Swiss jobs
 *   - isArdianJob()        — Match jobs belonging to this company
 *   - isTrustedDomain()    — Validate URLs belong to Ardian / Workday tenant
 *   - ARDIAN_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang, isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  buildWorkdayApiBase,
  fetchWorkdayJobs,
  fetchWorkdayJobDescriptionText,
  parseWorkdayPostedDate,
  extractWorkdayJobIdentity,
  WorkdayAuthError,
} from './ats-clients/workday-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const ARDIAN_KEY = 'ardian';
export const ARDIAN_COMPANY_NAME = 'Ardian';
export const ARDIAN_COMPANY_DOMAIN = 'ardian.com';

const WORKDAY_TENANT_HOST = 'ardian.wd103.myworkdayjobs.com';
const WORKDAY_SITE_PATH = 'ArdianCareers';
const WORKDAY_API_BASE = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
const WORKDAY_PUBLIC_BASE = `https://${WORKDAY_TENANT_HOST}/en-US/${WORKDAY_SITE_PATH}`;

const CAREER_URL = 'https://ardian.wd103.myworkdayjobs.com/ArdianCareers';

// Switzerland country UUID — standard across most Workday tenants.
const SWISS_LOCATION_IDS = ['187134fccb084a0ea9b4b95f23890dbe'];

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company matchers ──────────────────────────────────────── */

export function isArdianJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ARDIAN_KEY ||
    company === 'ardian' ||
    company.startsWith('ardian ') ||
    url.includes('ardian.com') ||
    url.includes('ardian.wd103.myworkdayjobs.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'ardian.com' ||
      host.endsWith('.ardian.com') ||
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
  if (/\b(compliance|legal|counsel|regulat|juridique|droit)/.test(t)) return 'Legale';
  if (/\b(invest|secondaries|primaries|deal|transaction|infrastructure|buyout|private\s*equity|co-investment)/.test(t))
    return 'Finanza';
  if (/\b(fund\s*finance|controll|account|treasur|tax|fiscal|finance|financi)/.test(t)) return 'Finanza';
  if (/\b(investor\s*relations|client\s*solution|fundrais|relations\s*investisseurs)/.test(t)) return 'Vendite';
  if (/\b(data\s*scien|data\s*analy|développeur|developer|software|it\b|informatique|digital|technology)/.test(t))
    return 'IT';
  if (/\b(hr|human|talent|recruit|personal|ressources\s*humaines)/.test(t)) return 'Risorse Umane';
  if (/\b(market|communicat|kommunikation|brand)/.test(t)) return 'Marketing';
  if (/\b(sustainab|esg|impact|foundation|engagement)/.test(t)) return 'Altro';
  if (/\b(assistant|support|admin|secret)/.test(t)) return 'Amministrazione';
  return 'Finanza';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(intern|stage|stagiaire|apprenti|apprentice|trainee|graduate)/.test(t)) return 'intern';
  if (/\b(junior|jr\.?|analyst|associate)/.test(t)) return 'junior';
  if (/\b(senior|sr\.?|lead|head|director|principal|chief|manager|partner|managing\s*director)/.test(t))
    return 'senior';
  return 'mid';
}

function detectEmploymentType(timeType = '', title = '') {
  const t = normalize(`${timeType} ${title}`);
  if (/\b(part.?time|temps\s*partiel|teilzeit)/.test(t)) return 'PART_TIME';
  if (/\b(intern|stage|stagiaire|apprenti|apprentice)/.test(t)) return 'INTERN';
  return 'FULL_TIME';
}

/* ── Workday fetcher ───────────────────────────────────────── */

async function fetchJobListings() {
  const out = [];
  try {
    for await (const posting of fetchWorkdayJobs(WORKDAY_API_BASE, {
      // Ardian uses the standard 'locationCountry' facet.
      locationFilters: SWISS_LOCATION_IDS,
      maxPages: 100000,
    })) {
      const id = extractWorkdayJobIdentity(posting, {
        apiBase: WORKDAY_API_BASE,
        publicBase: WORKDAY_PUBLIC_BASE,
        company: ARDIAN_COMPANY_NAME,
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

export async function fetchAllArdianJobs() {
  console.log(`🏦 Fetching ${ARDIAN_COMPANY_NAME} jobs`);
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

    const rawLocation = listing.locationRaw || 'Zurich';
    if (isLocationExplicitlyForeign(rawLocation)) {
      console.log(`  ⏭️  Skipped foreign location: ${rawLocation} — ${title}`);
      continue;
    }
    const location = normalizeSpace(rawLocation) || 'Zurich';
    const canton = inferSwissTargetCanton(location) || 'ZH';
    const publicUrl = listing.url || CAREER_URL;

    // Workday listing endpoint never returns the body — fetch detail.
    const detailDescription = await fetchWorkdayJobDescriptionText(
      WORKDAY_API_BASE,
      listing.externalPath,
      stripHtml,
    );
    await new Promise((r) => setTimeout(r, 400));

    const fallbackDescription = [
      `${title} — ${ARDIAN_COMPANY_NAME}, ${location}.`,
      '',
      'Key details:',
      `• Location: ${location}${canton ? `, Kanton ${canton}` : ''}, Schweiz`,
      '• Employer: Ardian — global private equity investment firm managing secondaries & primaries, buyout, infrastructure, real estate and private credit strategies.',
      '• Swiss footprint: Zurich office covering client solutions, investor relations and investment functions.',
      '• Apply: Ardian Workday careers portal.',
    ].join('\n');
    const descriptionText = detailDescription.length >= 100 ? detailDescription : fallbackDescription;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} ${ARDIAN_KEY} ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      id: `${ARDIAN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ARDIAN_COMPANY_NAME,
      companyKey: ARDIAN_KEY,
      companyDomain: ARDIAN_COMPANY_DOMAIN,
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
      source: `${ARDIAN_COMPANY_NAME} Dedicated Parser (Workday)`,
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
      sector: 'Finanza / Private Equity',
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

  console.log(`\n📋 Total ${ARDIAN_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
