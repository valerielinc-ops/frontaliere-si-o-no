#!/usr/bin/env node
/**
 * Sulzer job parser — Fetcher and job builder.
 *
 * Source: https://sulzer.wd502.myworkdayjobs.com/SulzerJobs
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSulzerJobs()  — Fetch and parse all jobs
 *   - isSulzerJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
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

export const SULZER_KEY = 'sulzer';
export const SULZER_COMPANY_NAME = 'Sulzer';
export const SULZER_COMPANY_DOMAIN = 'sulzer.com';

const CAREER_URL = 'https://sulzer.wd502.myworkdayjobs.com/SulzerJobs';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Sulzer.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSulzerJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SULZER_KEY ||
    key.startsWith('sulzer') ||
    company.includes('sulzer') ||
    url.includes('sulzer.com')
  );
}

/**
 * Validate that a URL belongs to Sulzer's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'sulzer.com' || host.endsWith('.sulzer.com');
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

/* ── Workday fetcher ──────────────────────────────────────────
 * The career URL must point to a Workday CXS site, e.g.:
 *   https://{tenant}.wd3.myworkdayjobs.com/{site}
 * Switzerland location filter ID varies per tenant — inspect the network
 * tab on the live site to find the correct facet value.
 */
const _WORKDAY_URL = new URL(CAREER_URL);
const WORKDAY_TENANT_HOST = _WORKDAY_URL.hostname;
const WORKDAY_SITE_PATH = (_WORKDAY_URL.pathname.replace(/^\/+|\/+$/g, '').split('/').pop()) || 'External';
// Sulzer Workday CXS exposes ~361 jobs globally. We don't apply a Workday-side
// location facet (the tenant uses plain `locationsText` city strings like
// "Winterthur" / "Zurich") — instead we let `inferSwissTargetCanton` filter
// the post list to CH-only entries downstream. If a stable CH location UUID
// surfaces during a future probe, plug it in here for a smaller payload.
const WORKDAY_LOCATION_FILTERS = [];
const WORKDAY_API_BASE = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);

async function fetchJobListings() {
  const apiBase = WORKDAY_API_BASE;
  const out = [];
  try {
    for await (const posting of fetchWorkdayJobs(apiBase, {
      locationFilters: WORKDAY_LOCATION_FILTERS,
      maxPages: 10,
    })) {
      const id = extractWorkdayJobIdentity(posting, { apiBase, company: SULZER_COMPANY_NAME });
      out.push({
        title: id.title,
        location: id.location,
        url: id.applyUrl,
        postedAt: id.postedAt || (posting.postedOn ? parseWorkdayPostedDate(posting.postedOn) : null),
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
 * Fetch all Sulzer jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSulzerJobs() {
  console.log(`🔍 Fetching Sulzer jobs`);
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

    const location = listing.location || 'Winterthur'; // Sulzer HQ
    const canton = inferSwissTargetCanton(location) || 'ZH';
    const publicUrl = listing.url || CAREER_URL;

    // Workday listing endpoint NEVER returns the job body — see workday-client.mjs.
    const detailDescription = await fetchWorkdayJobDescriptionText(
      WORKDAY_API_BASE,
      listing.externalPath,
      stripHtml,
    );
    await new Promise((r) => setTimeout(r, 400));

    const fallbackDescription = [
      `${title} — ${SULZER_COMPANY_NAME}, ${location}.`,
      '',
      'Key details:',
      `• Location: ${location}${canton ? `, ${canton} canton` : ''}, Switzerland`,
      '• Employer: Sulzer — global pumping, mixing and flow control technology',
      '• Apply on: Sulzer careers portal',
    ].join('\n');
    const descriptionText = detailDescription.length >= 100 ? detailDescription : fallbackDescription;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} sulzer ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `sulzer-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SULZER_COMPANY_NAME,
      companyKey: SULZER_KEY,
      companyDomain: SULZER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Sulzer Dedicated Parser',
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
      sector: 'Industria', // Industrial flow control / pumps / services
      currency: 'CHF',
      featured: false,
      postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total Sulzer jobs discovered: ${jobs.length}`);
  return jobs;
}
