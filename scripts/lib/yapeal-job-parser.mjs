#!/usr/bin/env node
/**
 * Yapeal job parser — Personio ATS (subdomain "yapeal-ag").
 *
 * Source: https://yapeal.ch/en/careers (public career page; the actual feed
 * is the Personio public XML export below)
 *
 * Yapeal is a Swiss mobile banking / neobank company headquartered in
 * Zürich (Max-Högger-Strasse 6, 8048 Zürich ZH — confirmed via the
 * company's legal notice at https://yapeal.ch/en/private/legal-notice and
 * cross-checked against Moneyhouse/LEI registry entries).
 *
 * ATS discovery: Yapeal uses Personio, tenant subdomain "yapeal-ag". The
 * free, unauthenticated XML feed at
 *   https://yapeal-ag.jobs.personio.de/xml
 * returns every open position (confirmed live, currently a single position —
 * low volume, but built per the issue #3337 backlog since the feed exists
 * and is stable regardless of headcount).
 *
 * XML fetching/parsing/normalization is fully delegated to the shared
 * Personio client (`./ats-clients/personio-client.mjs`) — this parser only
 * owns Yapeal-specific concerns: canton/city inference from the Personio
 * `office` field (falling back to the Zürich HQ when unset/unrecognized),
 * category/employment-type detection, and slug/id construction.
 *
 * Public posting URLs are https://yapeal-ag.jobs.personio.de/job/{id}.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllYapealJobs()   — Fetch and parse all Yapeal jobs
 *   - isYapealJob()          — Match jobs belonging to this company
 *   - isTrustedDomain()      — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchPersonioJobs } from './ats-clients/personio-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const YAPEAL_KEY = 'yapeal';
export const YAPEAL_COMPANY_NAME = 'Yapeal';
export const YAPEAL_COMPANY_DOMAIN = 'yapeal.ch';

const PERSONIO_SUBDOMAIN = 'yapeal-ag';
const CAREER_URL = 'https://yapeal.ch/en/careers';

/* ── HQ fallback (Max-Högger-Strasse 6, 8048 Zürich, ZH) ─────── */
/* Confirmed via https://yapeal.ch/en/private/legal-notice (own legal */
/* notice), cross-checked against Moneyhouse/LEI registry — not a guess. */

const HQ = {
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8048',
  streetAddress: 'Max-Högger-Strasse 6',
  region: 'ZH',
};

const SECTOR = 'Finanza / Banche digitali';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Yapeal.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isYapealJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === YAPEAL_KEY ||
    key.startsWith('yapeal') ||
    company.includes('yapeal') ||
    url.includes('yapeal.ch') ||
    url.includes('yapeal-ag.jobs.personio.de')
  );
}

/**
 * Validate that a URL belongs to Yapeal's domain OR the Personio ATS host
 * that actually serves the postings (yapeal-ag.jobs.personio.de).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'yapeal.ch' || host.endsWith('.yapeal.ch')) return true;
    if (host === 'yapeal-ag.jobs.personio.de') return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl|software|develop|devops|backend|frontend|full.?stack)/.test(t)) return 'IT';
  if (/\b(compliance|legal|giurid|recht|risk|risiko)/.test(t)) return 'Legale';
  if (/\b(finanz|finance|financ|controll|treasury|account)/.test(t)) return 'Finanza';
  if (/\b(market|kommunik|comunicaz|brand|growth)/.test(t)) return 'Marketing';
  if (/\b(hr|human|risorse|personal|recruit|talent)/.test(t)) return 'Risorse Umane';
  if (/\b(vendita|sales|verkauf|commerce|business.?develop)/.test(t)) return 'Commerciale';
  if (/\b(support|servizio.?client|kundenservice|customer)/.test(t)) return 'Assistenza clienti';
  if (/\b(design|ux|ui|product)/.test(t)) return 'Design';
  if (/\b(admin|segret|contab|buchhalt|office)/.test(t)) return 'Amministrazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
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

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Pick the best city / postal code / street / region from the Personio
 * `office` field, falling back to the documented HQ address (Zürich) when
 * the office is empty or doesn't map to a recognized Swiss canton. A job is
 * never dropped just because its office string is unmapped — it always
 * falls back to HQ.
 */
function resolveAddress(officeRaw = '') {
  const office = normalizeSpace(officeRaw);
  const canton = office ? inferSwissTargetCanton(office) : null;

  if (office && canton) {
    const isHqCity = /z[üu]rich/i.test(office);
    return {
      city: office,
      canton,
      postalCode: isHqCity ? HQ.postalCode : '',
      streetAddress: isHqCity ? HQ.streetAddress : '',
      region: canton,
    };
  }

  // Unmapped/empty office string → safe HQ fallback, never dropped.
  return {
    city: HQ.city,
    canton: HQ.canton,
    postalCode: HQ.postalCode,
    streetAddress: HQ.streetAddress,
    region: HQ.region,
  };
}

/**
 * Fetch all Yapeal jobs (Personio feed, single request, no pagination).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllYapealJobs() {
  console.log(`🔍 Fetching ${YAPEAL_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL} (Personio subdomain "${PERSONIO_SUBDOMAIN}")\n`);

  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  let listings = [];
  try {
    listings = await fetchPersonioJobs(PERSONIO_SUBDOMAIN, { timeoutMs });
  } catch (err) {
    console.warn(`⚠️ Personio fetch failed: ${err?.message || err}`);
    throw err;
  }

  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const publicUrl = listing.applyUrl || CAREER_URL;
    if (seen.has(publicUrl)) continue;
    seen.add(publicUrl);

    const { city, canton, postalCode, streetAddress, region } = resolveAddress(listing.location);
    const location = normalizeSpace(city || HQ.city);

    const descriptionHtml = listing.descriptionHtml || '';
    const descriptionText = stripHtml(descriptionHtml);
    const description = descriptionText || `${title} bei ${YAPEAL_COMPANY_NAME} in ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} yapeal ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(`${listing.employmentType || ''} ${listing.schedule || ''} ${title}`);
    const postedDate = (listing.postedAt && String(listing.postedAt).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${YAPEAL_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: YAPEAL_COMPANY_NAME,
      companyKey: YAPEAL_KEY,
      companyDomain: YAPEAL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Yapeal Dedicated Parser (Personio)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      jobReqId: listing.jobReqId || null,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${YAPEAL_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
