#!/usr/bin/env node
/**
 * iGroove AG job parser — Personio (subdomain "igroove") ATS.
 *
 * iGroove AG is a Swiss digital music distribution/services company.
 * Registered legal seat per commercial register (Northdata, company
 * impressum) is Churerstrasse 135, 8808 Pfäffikon SZ (canton Schwyz) — NOT
 * Zürich. However the company's public Personio feed
 * (https://igroove.jobs.personio.de/xml, verified live) lists its current
 * open position's office as "Zürich Hybrid", so this crawler treats Zürich
 * ZH as the operational HQ fallback (see `scripts/lib/crawler-location-config.mjs`
 * `COMPANY_HQ.igroove` for the documented rationale). Volume is low (single
 * digit open positions observed) but built per issue #3337 backlog anyway.
 *
 * All XML fetch/parse/normalization is delegated to the shared Personio
 * client (`./ats-clients/personio-client.mjs`) — this file only owns
 * company-specific concerns: matching, canton inference, category/
 * employment-type detection and mapping to this repo's job shape.
 *
 * Public posting URL: https://igroove.jobs.personio.de/job/{id}
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllIgrooveJobs()  — Fetch and parse all iGroove jobs
 *   - isIgrooveJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()      — Validate URLs belong to this company's ATS
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchPersonioJobs } from './ats-clients/personio-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const IGROOVE_KEY = 'igroove';
export const IGROOVE_COMPANY_NAME = 'iGroove AG';
export const IGROOVE_COMPANY_DOMAIN = 'igroovemusic.com';

const PERSONIO_SUBDOMAIN = 'igroove';
const CAREER_URL = 'https://igroove.jobs.personio.de/';

/* ── HQ fallback (Zürich operational office; see crawler-location-config.mjs
 * for the documented street/registered-seat discrepancy) ─────────────── */

const HQ = {
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8001',
  streetAddress: '', // no confirmed street address for the Zürich office
  region: 'Zürich',
};

const SECTOR = 'Media / Musica digitale';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to iGroove AG.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isIgrooveJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === IGROOVE_KEY ||
    key.startsWith('igroove') ||
    company.includes('igroove') ||
    url.includes('igroovemusic.com') ||
    url.includes('igroove.jobs.personio.de')
  );
}

/**
 * Validate that a URL belongs to iGroove's domain OR the Personio ATS host
 * that actually serves the postings (igroove.jobs.personio.de).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === IGROOVE_COMPANY_DOMAIN || host.endsWith(`.${IGROOVE_COMPANY_DOMAIN}`)) return true;
    if (host === 'igroove.jobs.personio.de') return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(data|pipeline|ai|machine learning|ml engineer)/.test(t)) return 'IT';
  if (/\b(ingegner|engineer|entwickl|software|develop|programm)/.test(t)) return 'IT';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce)/.test(t)) return 'Commerciale';
  if (/\b(market|kommunik|comunicaz|social media|content)/.test(t)) return 'Marketing';
  if (/\b(hr|human|risorse|personal)/.test(t)) return 'Risorse Umane';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht)/.test(t)) return 'Legale';
  if (/\b(a&r|artist|label|music|musica|distribution)/.test(t)) return 'Media / Musica';
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
  if (/\b(intern|praktik|apprend|lehrling|trainee)/.test(t)) return 'INTERN';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein|permanent)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/**
 * Resolve the best city / postal code / street / region / canton from the
 * Personio `office` free-text field, falling back to the documented Zürich
 * HQ default when the field is empty or doesn't match a known Swiss target
 * location. Never drops a job just because the office string is unmapped.
 */
function resolveLocation(officeText = '') {
  const office = normalizeSpace(officeText);
  const canton = inferSwissTargetCanton(office) || HQ.canton;
  const isHqCity = !office || /z[uü]rich/i.test(office);

  return {
    location: office || HQ.city,
    city: isHqCity ? HQ.city : office,
    canton,
    postalCode: isHqCity ? HQ.postalCode : '',
    streetAddress: isHqCity ? HQ.streetAddress : '',
    region: isHqCity ? HQ.region : canton,
  };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all iGroove jobs from the shared Personio client.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllIgrooveJobs() {
  console.log(`🔍 Fetching ${IGROOVE_COMPANY_NAME} jobs`);
  console.log(`   Source: Personio subdomain "${PERSONIO_SUBDOMAIN}" (${CAREER_URL})\n`);

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

    const { location, city, canton, postalCode, streetAddress, region } = resolveLocation(listing.location);

    const descriptionHtml = listing.descriptionHtml || '';
    const descriptionText = stripHtml(descriptionHtml);
    const description = descriptionText || `${title} bei ${IGROOVE_COMPANY_NAME} in ${location}.`;
    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} igroove ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(`${listing.employmentType || ''} ${listing.schedule || ''}`);
    const postedDate = (listing.postedAt && String(listing.postedAt).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const job = {
      // ── Required fields ──
      id: `${IGROOVE_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: IGROOVE_COMPANY_NAME,
      companyKey: IGROOVE_KEY,
      companyDomain: IGROOVE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'iGroove Dedicated Parser (Personio)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields (structured-data completeness, Non-Negotiable #3) ──
      addressLocality: city || location,
      addressRegion: region || canton,
      streetAddress: streetAddress || HQ.streetAddress,
      postalCode: postalCode || (canton === HQ.canton ? HQ.postalCode : ''),
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

  console.log(`\n📋 Total ${IGROOVE_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
