#!/usr/bin/env node
/**
 * Lombard Odier job parser — Fetcher and job builder.
 *
 * Source: https://lombardodier.wd3.myworkdayjobs.com/Lombard_Odier_Careers
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllLombardOdierJobs()  — Fetch and parse all jobs
 *   - isLombardOdierJob()         — Match jobs belonging to this company
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

export const LOMBARD_ODIER_KEY = 'lombard-odier';
export const LOMBARD_ODIER_COMPANY_NAME = 'Lombard Odier';
export const LOMBARD_ODIER_COMPANY_DOMAIN = 'lombardodier.com';

const CAREER_URL = 'https://lombardodier.wd3.myworkdayjobs.com/Lombard_Odier_Careers';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Lombard Odier.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isLombardOdierJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === LOMBARD_ODIER_KEY ||
    key.startsWith('lombard-odier') ||
    company.includes('lombard odier') ||
    url.includes('lombardodier.com')
  );
}

/**
 * Validate that a URL belongs to Lombard Odier's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'lombardodier.com' ||
      host.endsWith('.lombardodier.com') ||
      host === 'lombardodier.wd3.myworkdayjobs.com' ||
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
const _WORKDAY_URL = new URL(CAREER_URL);
const WORKDAY_TENANT_HOST = _WORKDAY_URL.hostname;
const WORKDAY_SITE_PATH = (_WORKDAY_URL.pathname.replace(/^\/+|\/+$/g, '').split('/').pop()) || 'External';
const WORKDAY_LOCATION_FILTERS = []; // TODO: e.g. ['187134fccb084a0ea9b4b95f23890dbe'] for CH on most tenants

async function fetchJobListings() {
  const apiBase = buildWorkdayApiBase(WORKDAY_TENANT_HOST, WORKDAY_SITE_PATH);
  const out = [];
  try {
    for await (const posting of fetchWorkdayJobs(apiBase, {
      locationFilters: WORKDAY_LOCATION_FILTERS,
      maxPages: 10,
    })) {
      const id = extractWorkdayJobIdentity(posting, { apiBase, company: LOMBARD_ODIER_COMPANY_NAME });
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
 * Fetch all Lombard Odier jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllLombardOdierJobs() {
  console.log(`🔍 Fetching Lombard Odier jobs`);
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

    const location = listing.location || 'Geneva'; // HQ: Geneva
    const canton = inferSwissTargetCanton(location) || 'GE';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} lombard-odier ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `lombard-odier-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: LOMBARD_ODIER_COMPANY_NAME,
      companyKey: LOMBARD_ODIER_KEY,
      companyDomain: LOMBARD_ODIER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Lombard Odier`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Lombard Odier` },
      location,
      canton,
      url: publicUrl,
      source: 'Lombard Odier Dedicated Parser',
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
      sector: 'Banking', // Private banking / wealth management (Geneva HQ)
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

  console.log(`\n📋 Total Lombard Odier jobs discovered: ${jobs.length}`);
  return jobs;
}
