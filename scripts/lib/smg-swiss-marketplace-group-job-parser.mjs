#!/usr/bin/env node
/**
 * SMG Swiss Marketplace Group job parser — SmartRecruiters API consumer.
 *
 * Source: https://api.smartrecruiters.com/v1/companies/SMGSwissMarketplaceGroup/postings?limit=100&offset=0
 *
 * Pagination + detail-fetch concurrency delegated to the shared
 * SmartRecruiters client (`scripts/lib/ats-clients/smartrecruiters-client.mjs`).
 * This file only owns SMG-specific concerns:
 * - Nationwide CH location filter (SMG is a Zürich HQ / Fribourg BlueFactory
 *   digital-marketplace group — AutoScout24, Homegate, ImmoScout24, JobCloud,
 *   etc. — with roles across both offices; foreign postings, e.g. Belgrade,
 *   Ho Chi Minh City, Valbonne, are excluded).
 * - Markdown-formatted description (jobAd → markdown "## Qualifiche" /
 *   "## Informazioni aggiuntive" section headings — same convention as
 *   sibling SmartRecruiters crawlers, e.g. Avaloq / Migros HQ).
 * - Canton inference + ParsedJob assembly.
 *
 * NOTE: Distinct from the pre-existing `tsmg` crawler (scripts/update-tsmg-jobs.mjs),
 * an unrelated company (Lever ATS, Ticino/Grigioni filter). "SMG" here is
 * SMG Swiss Marketplace Group (swissmarketplace.group) — no relation.
 *
 * Exports the 4 required functions for the crawler template:
 * - fetchAllSmgSwissMarketplaceGroupJobs() — Fetch and parse all jobs
 * - isSmgSwissMarketplaceGroupJob()         — Match jobs belonging to this company
 * - isTrustedDomain()                       — Validate URLs belong to this company
 * - slugify() / stripHtml()                 — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import {
  fetchSmartRecruitersJobs,
  SmartRecruitersApiError,
} from './ats-clients/smartrecruiters-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SMG_SWISS_MARKETPLACE_GROUP_KEY = 'smg-swiss-marketplace-group';
export const SMG_SWISS_MARKETPLACE_GROUP_COMPANY_NAME = 'SMG Swiss Marketplace Group';
export const SMG_SWISS_MARKETPLACE_GROUP_COMPANY_DOMAIN = 'swissmarketplace.group';

const SR_TENANT = 'SMGSwissMarketplaceGroup';
const SR_API = `https://api.smartrecruiters.com/v1/companies/${SR_TENANT}/postings`;
const CAREER_URL = `${SR_API}?limit=100&offset=0`;
const SR_FETCH_TIMEOUT_MS = 20000;
const SR_DETAIL_CONCURRENCY = 5;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to SMG Swiss Marketplace Group.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSmgSwissMarketplaceGroupJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SMG_SWISS_MARKETPLACE_GROUP_KEY ||
    key.startsWith('smg-swiss-marketplace-group') ||
    company.includes('swiss marketplace group') ||
    url.includes('swissmarketplace.group') ||
    url.includes('jobs.smartrecruiters.com/smgswissmarketplacegroup') ||
    url.includes('api.smartrecruiters.com/v1/companies/smgswissmarketplacegroup')
  );
}

/**
 * Validate that a URL belongs to SMG Swiss Marketplace Group's domain.
 * SMG is published via the SmartRecruiters tenant
 * (jobs.smartrecruiters.com/SMGSwissMarketplaceGroup).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'jobs.smartrecruiters.com' ||
      host === 'api.smartrecruiters.com' ||
      host === 'swissmarketplace.group' ||
      host.endsWith('.swissmarketplace.group')
    );
  } catch {
    return false;
  }
}

/* ── Location Filter ───────────────────────────────────────── */

/**
 * Keep every posting located in Switzerland (nationwide crawl — Zürich HQ
 * and Fribourg BlueFactory office both included). Foreign postings (SMG
 * also staffs Belgrade / Ho Chi Minh City / Valbonne engineering hubs) are
 * dropped; the canton is not restricted to a single city.
 *
 * Used as the `options.filter` predicate passed to the shared SR client.
 */
function isHqLocation(loc = {}) {
  const country = normalize(loc.country || '');
  if (country && country !== 'ch' && country !== 'switzerland' && country !== 'svizzera') return false;
  const city = normalize(loc.city || '');
  const region = normalize(loc.region || '');
  if (!city && !region) return false;
  return true;
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
  if (/\b(senior|sr|staff|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Description Formatting ────────────────────────────────── */

/**
 * Convert SmartRecruiters HTML section content into compact markdown.
 *
 * Same convention as the sibling SmartRecruiters crawlers (Avaloq / Migros
 * HQ): the shared client offers a concatenated `descriptionHtml` field, but
 * this parser keeps its own markdown formatter so "## Qualifiche" /
 * "## Informazioni aggiuntive" section headings stay consistent with
 * downstream localisation.
 */
function htmlToMarkdown(html = '') {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|li|h2|h3|h4)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, '\'')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Map a SmartRecruiters posting into the loose listing shape consumed by the
 * loop below.
 */
function postingToListing(posting) {
  const loc = posting?.location || {};
  const sections = [];
  const jobDesc = (posting?.jobAd?.sections?.jobDescription?.text || '').trim();
  const qualif = (posting?.jobAd?.sections?.qualifications?.text || '').trim();
  const addInfo = (posting?.jobAd?.sections?.additionalInformation?.text || '').trim();
  if (jobDesc) sections.push(htmlToMarkdown(jobDesc));
  if (qualif) sections.push(`## Qualifiche\n\n${htmlToMarkdown(qualif)}`);
  if (addInfo) sections.push(`## Informazioni aggiuntive\n\n${htmlToMarkdown(addInfo)}`);
  return {
    id: posting?.id || '',
    title: normalizeSpace(posting?.name || ''),
    description: sections.join('\n\n').trim(),
    location: normalizeSpace(loc.city || ''),
    region: normalizeSpace(loc.region || ''),
    postalCode: normalizeSpace(loc.postalCode || ''),
    country: normalizeSpace(loc.country || 'CH'),
    url: posting?.applyUrl || (posting?.id ? `https://jobs.smartrecruiters.com/${SR_TENANT}/${posting.id}` : CAREER_URL),
    timeType: posting?.typeOfEmployment?.label || '',
    postedDate: (posting?.releasedDate || posting?.createdOn || '').slice(0, 10),
  };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all SMG Swiss Marketplace Group jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSmgSwissMarketplaceGroupJobs() {
  console.log(`🔍 Fetching SMG Swiss Marketplace Group jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);
  console.log(`   Fetching from: ${CAREER_URL}`);

  const jobs = [];
  let yielded = 0;

  try {
    // Filter at the SR-client level: built-in `locationCountryCodes` is too
    // coarse when we also want to keep the Fribourg (BlueFactory) office
    // alongside the Zürich HQ; `isHqLocation` is the custom predicate
    // applied per-posting BEFORE the optional detail-fetch — so we save
    // detail calls on out-of-scope (foreign-office) postings.
    const iter = fetchSmartRecruitersJobs(SR_TENANT, {
      company: SMG_SWISS_MARKETPLACE_GROUP_COMPANY_NAME,
      filter: (posting) => isHqLocation(posting?.location || {}),
      fetchDetail: true,
      detailConcurrency: SR_DETAIL_CONCURRENCY,
      minDelayMs: 0,
      maxPages: 100000,
      timeoutMs: SR_FETCH_TIMEOUT_MS,
      userAgent: 'FrontaliereTicino-JobCrawler/2.0',
    });

    for await (const normalized of iter) {
      yielded += 1;
      const posting = normalized.rawPosting || {};
      const listing = postingToListing(posting);

      const title = normalizeSpace(listing.title || '');
      if (!title || title.length < 3) continue;

      // Location-first: resolve the specific location before the broader region.
      // inferAnyCanton already checks target cantons first internally, so a
      // separate inferSwissTargetCanton pass is redundant; splitting the fields
      // keeps the specific location winning over array-order sensitivity.
      const realLocationText = normalizeSpace(listing.location || '');
      const realRegionText = normalizeSpace(listing.region || '');
      const inferredCanton = inferAnyCanton(realLocationText) || inferAnyCanton(realRegionText) || null;
      if ((realLocationText || realRegionText) && !inferredCanton) {
        console.warn(`  ⚠️ SMG: skipping unresolvable location "${realLocationText || realRegionText}" (${title})`);
        continue;
      }
      // Default to Zürich (SMG HQ) only when SR returned no location text at all.
      const location = realLocationText || 'Zürich';
      const canton = inferredCanton || 'ZH';
      const descriptionText = stripHtml(listing.description || '');
      const publicUrl = listing.url || CAREER_URL;

      const sourceLang = detectLang(descriptionText || title, 'en');
      const jobSlug = slugify(`${title} smg-swiss-marketplace-group ch`);
      const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

      const job = {
        // ── Required fields ──
        id: `smg-swiss-marketplace-group-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: SMG_SWISS_MARKETPLACE_GROUP_COMPANY_NAME,
        companyKey: SMG_SWISS_MARKETPLACE_GROUP_KEY,
        companyDomain: SMG_SWISS_MARKETPLACE_GROUP_COMPANY_DOMAIN,
        title,
        titleByLocale: { [sourceLang]: title },
        description: descriptionText || `${title} — SMG Swiss Marketplace Group`,
        descriptionByLocale: { [sourceLang]: descriptionText || `${title} — SMG Swiss Marketplace Group` },
        needsRetranslation: true,
        location,
        canton,
        url: publicUrl,
        source: 'SMG Swiss Marketplace Group Dedicated Parser',
        sourceLang,
        crawledAt: new Date().toISOString(),

        // ── Recommended fields ──
        addressLocality: location,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: listing.postalCode || '',
        category: detectCategory(title),
        contract: 'full-time',
        employmentType: detectEmploymentType(listing.timeType || title),
        experienceLevel: detectExperienceLevel(title),
        sector: 'Marketplace digitale / Tecnologia',
        currency: 'CHF',
        featured: false,
        postedDate: listing.postedDate || new Date().toISOString().split('T')[0],
        applyUrl: publicUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      };

      jobs.push(job);
    }
  } catch (err) {
    if (err instanceof SmartRecruitersApiError) {
      console.warn(`  ⚠️ SmartRecruiters API error: ${err.message} (status=${err.statusCode ?? 'n/a'})`);
    }
    throw err;
  }

  console.log(`   CH-scoped postings: ${yielded}`);
  console.log(`  📋 Listings (post-filter): ${yielded}`);
  console.log(`\n📋 Total SMG Swiss Marketplace Group jobs discovered: ${jobs.length}`);
  return jobs;
}
