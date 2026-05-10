#!/usr/bin/env node
/**
 * Zurich Insurance Group job parser — Fetcher and job builder.
 *
 * Source: https://zurichinsurance.ch/careers
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllZurichInsuranceJobs()  — Fetch and parse all jobs
 *   - isZurichInsuranceJob()         — Match jobs belonging to this company
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
  parseWorkdayPostedDate,
  extractWorkdayJobIdentity,
  WorkdayAuthError,
} from './ats-clients/workday-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const ZURICH_INSURANCE_KEY = 'zurich-insurance';
export const ZURICH_INSURANCE_COMPANY_NAME = 'Zurich Insurance Group';
export const ZURICH_INSURANCE_COMPANY_DOMAIN = 'zurichinsurance.ch';

const CAREER_URL = 'https://zurich.wd3.myworkdayjobs.com/Zurich_Careers';
const WORKDAY_TENANT = 'zurich.wd3.myworkdayjobs.com';
const WORKDAY_SITE = 'Zurich_Careers';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Zurich Insurance Group.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isZurichInsuranceJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ZURICH_INSURANCE_KEY ||
    key.startsWith('zurich-insurance') ||
    company.includes('zurich insurance group') ||
    url.includes('zurichinsurance.ch')
  );
}

/**
 * Validate that a URL belongs to Zurich Insurance Group's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'zurichinsurance.ch' ||
      host.endsWith('.zurichinsurance.ch') ||
      host === 'zurich.com' ||
      host.endsWith('.zurich.com') ||
      host === 'zurich.wd3.myworkdayjobs.com' ||
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
const WORKDAY_TENANT_HOST = WORKDAY_TENANT;
const WORKDAY_SITE_PATH = WORKDAY_SITE;
const WORKDAY_LOCATION_FILTERS = []; // TODO: inspect live site facets to find CH location filter ID

async function fetchJobListings() {
  const apiBase = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
  const out = [];
  try {
    for await (const posting of fetchWorkdayJobs(apiBase, {
      locationFilters: WORKDAY_LOCATION_FILTERS,
      maxPages: 10,
    })) {
      const id = extractWorkdayJobIdentity(posting, { apiBase, company: ZURICH_INSURANCE_COMPANY_NAME });
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
 * Fetch all Zurich Insurance Group jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllZurichInsuranceJobs() {
  console.log(`🔍 Fetching Zurich Insurance Group jobs`);
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

    const location = listing.location || 'Zürich';
    const canton = inferSwissTargetCanton(location) || 'ZH';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'it');
    const jobSlug = slugify(`${title} zurich-insurance ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `zurich-insurance-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ZURICH_INSURANCE_COMPANY_NAME,
      companyKey: ZURICH_INSURANCE_KEY,
      companyDomain: ZURICH_INSURANCE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Zurich Insurance Group`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Zurich Insurance Group` },
      location,
      canton,
      url: publicUrl,
      source: 'Zurich Insurance Group Dedicated Parser',
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
      sector: 'Assicurazioni',
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

  console.log(`\n📋 Total Zurich Insurance Group jobs discovered: ${jobs.length}`);
  return jobs;
}
