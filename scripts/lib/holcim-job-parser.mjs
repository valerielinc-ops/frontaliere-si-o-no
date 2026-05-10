#!/usr/bin/env node
/**
 * Holcim Group job parser — Fetcher and job builder.
 *
 * Source: https://careers.holcimgroup.com/
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllHolcimJobs()  — Fetch and parse all jobs
 *   - isHolcimJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  detectSuccessFactorsKind,
  fetchSuccessFactorsJobs,
  SuccessFactorsAuthError,
} from './ats-clients/successfactors-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const HOLCIM_KEY = 'holcim';
export const HOLCIM_COMPANY_NAME = 'Holcim Group';
export const HOLCIM_COMPANY_DOMAIN = 'holcim.com';

// Holcim Group runs an SF Career Site Builder front (careers.holcimgroup.com)
// backed by the classic career2.successfactors.eu tenant `holcimgrou`.
// We hit the SF host directly because detectSuccessFactorsKind only knows
// the api*.successfactors / career*.successfactors / sapsf hosts.
const CAREER_URL = 'https://career2.successfactors.eu/career?company=holcimgrou';
const PUBLIC_CAREER_URL = 'https://careers.holcimgroup.com/';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Holcim Group.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isHolcimJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === HOLCIM_KEY ||
    key.startsWith('holcim') ||
    company.includes('holcim') ||
    url.includes('holcim.com') ||
    url.includes('holcimgroup.com') ||
    (url.includes('successfactors') && url.includes('holcimgrou'))
  );
}

/**
 * Validate that a URL belongs to Holcim Group's domain or its SF tenant.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'holcim.com' ||
      host.endsWith('.holcim.com') ||
      host === 'careers.holcimgroup.com' ||
      host.endsWith('.holcimgroup.com') ||
      /\.successfactors\.(eu|com)$/.test(host) ||
      /\.sapsf\.(eu|com)$/.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * Holcim's SF tenant returns global jobs; we filter client-side for CH.
 */
function isSwissLocation(locationsText = '') {
  const loc = normalize(locationsText);
  return (
    loc.includes('switzerland') ||
    loc.includes('schweiz') ||
    loc.includes('suisse') ||
    loc.includes('svizzera') ||
    loc.startsWith('ch ') ||
    loc.startsWith('ch-') ||
    loc.includes(', ch') ||
    loc.includes('zurich') ||
    loc.includes('zürich') ||
    loc.includes('zug') ||
    loc.includes('basel') ||
    loc.includes('bern') ||
    loc.includes('geneva') ||
    loc.includes('lausanne') ||
    loc.includes('lugano') ||
    loc.includes('eclepens') ||
    loc.includes('siggenthal') ||
    loc.includes('untervaz') ||
    loc.includes('würenlingen') ||
    loc.includes('wuerenlingen')
  );
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

/* ── SuccessFactors fetcher ───────────────────────────────────
 * Three flavors auto-detected from CAREER_URL:
 *   - 'odata-api'    → api{N}.successfactors.com/odata/v2/...
 *   - 'html-career'  → career5.successfactors.eu/career?company=...
 *   - 'html-jobreq'  → jobs2web / SSR overlay (jobs.sbb.ch, etc.)
 * For 'html-career' listing index you typically need Playwright
 * (re-scaffold with --playwright if so).
 */
const SF_LOCATION_FILTERS = []; // TODO: e.g. ['Ticino', 'Lugano', 'Zurich']

async function fetchJobListings() {
  const kind = detectSuccessFactorsKind(CAREER_URL);
  if (!kind) {
    console.warn(`⚠️ URL not recognised as SuccessFactors: ${CAREER_URL}`);
    return [];
  }
  const out = [];
  try {
    for await (const job of fetchSuccessFactorsJobs(CAREER_URL, {
      locationFilters: SF_LOCATION_FILTERS,
      company: HOLCIM_COMPANY_NAME,
    })) {
      // Tenant ships listings worldwide; ship only CH-located roles to frontaliere-ticino.
      if (!isSwissLocation(job.location || '')) continue;
      out.push({
        title: job.title,
        location: job.location,
        url: job.applyUrl,
        postedAt: job.postedAt,
        jobReqId: job.jobReqId,
        description: job.description || '',
      });
    }
  } catch (err) {
    if (err instanceof SuccessFactorsAuthError) {
      console.error(`❌ SuccessFactors anti-bot block: ${err.message}`);
      return [];
    }
    throw err;
  }
  return out;
}

/**
 * Fetch all Holcim Group jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllHolcimJobs() {
  console.log(`🔍 Fetching Holcim Group jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    // TODO: Extract fields from each listing.
    // Adapt these field names to match the actual API response.
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    const location = listing.location || 'Zug';
    const canton = inferSwissTargetCanton(location) || 'ZG';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} holcim ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `holcim-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: HOLCIM_COMPANY_NAME,
      companyKey: HOLCIM_KEY,
      companyDomain: HOLCIM_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Holcim Group`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Holcim Group` },
      location,
      canton,
      url: publicUrl,
      source: 'Holcim Group Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(listing.timeType || title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Materiali da costruzione / Cemento',
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
    await new Promise((r) => setTimeout(r, 300)); // Rate limiting
  }

  console.log(`\n📋 Total Holcim Group jobs discovered: ${jobs.length}`);
  return jobs;
}
