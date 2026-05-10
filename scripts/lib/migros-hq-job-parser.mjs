#!/usr/bin/env node
/**
 * Migros HQ Zürich job parser — SmartRecruiters API consumer.
 *
 * Source: https://api.smartrecruiters.com/v1/companies/Migros/postings?limit=100&offset=0
 *
 * Pagination + detail-fetch concurrency are delegated to the shared
 * SmartRecruiters client (`scripts/lib/ats-clients/smartrecruiters-client.mjs`).
 * This file only owns Migros-HQ-specific concerns:
 *   - HQ-only location filter (Zürich + nearby ZH municipalities, scoping out
 *     of regional postings handled by the sibling `migros` Ticino crawler)
 *   - Markdown-formatted description (jobAd → markdown with "## Qualifiche" /
 *     "## Informazioni aggiuntive" section headings — preserved verbatim from
 *     the pre-extraction implementation for byte-identical output)
 *   - Canton inference + ParsedJob assembly
 *
 * NOTE: 'Migros' is the parent-group SR tenant. It aggregates postings from
 * all Migros group companies (Migros Industrie, Migros-Genossenschafts-Bund,
 * Denner, Migros Bank, Galaxus, etc.). This crawler scopes to HQ-relevant
 * postings via city filter (Zürich + nearby ZH municipalities) so it does
 * not collide with the existing Migros Ticino crawler (jobs.migros.ch).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllMigrosHqJobs()  — Fetch and parse all jobs
 *   - isMigrosHqJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()       — Validate URLs belong to this company
 *   - slugify() / stripHtml() — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton, inferAnyCanton } from './target-swiss-locations.mjs';
import {
  fetchSmartRecruitersJobs,
  SmartRecruitersApiError,
} from './ats-clients/smartrecruiters-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const MIGROS_HQ_KEY = 'migros-hq';
export const MIGROS_HQ_COMPANY_NAME = 'Migros HQ Zürich';
export const MIGROS_HQ_COMPANY_DOMAIN = 'migros.ch';

const SR_TENANT = 'Migros';
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
 * Check if a job belongs to Migros HQ Zürich.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isMigrosHqJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === MIGROS_HQ_KEY ||
    key.startsWith('migros-hq') ||
    company.includes('migros hq') ||
    url.includes('jobs.smartrecruiters.com/migros') ||
    url.includes('api.smartrecruiters.com/v1/companies/migros')
  );
}

/**
 * Validate that a URL belongs to Migros HQ Zürich's domain.
 * Migros HQ is published via the SmartRecruiters tenant (jobs.smartrecruiters.com/Migros)
 * — distinct from jobs.migros.ch which is the regional/Ticino portal handled by the
 * existing 'migros' crawler.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'jobs.smartrecruiters.com' ||
      host === 'api.smartrecruiters.com' ||
      host === 'migros.ch' ||
      host.endsWith('.migros.ch')
    );
  } catch {
    return false;
  }
}

/* ── Location Filter ───────────────────────────────────────── */

/**
 * Keep only postings located in Zürich (HQ) and the wider ZH canton.
 * Filtering out other cantons avoids overlap with sibling crawlers
 * (Migros Ticino) and keeps this crawler scoped to the HQ.
 *
 * Used as the `options.filter` predicate passed to the shared SR client.
 */
function isHqLocation(loc = {}) {
  const country = normalize(loc.country || '');
  if (country && country !== 'ch' && country !== 'switzerland' && country !== 'svizzera') return false;
  const city = normalize(loc.city || '');
  const region = normalize(loc.region || '');
  if (!city && !region) return false;
  const composite = [loc.city, loc.region, loc.country].filter(Boolean).join(', ');
  const canton = inferAnyCanton(composite) || inferSwissTargetCanton(composite);
  if (canton === 'ZH') return true;
  // Common ZH city names that may resolve weakly through inferAnyCanton.
  return /(zurich|zürich|zuerich|kloten|wallisellen|opfikon|dietikon|schlieren|bülach|buelach|winterthur)/.test(city);
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

/* ── Description Formatting ────────────────────────────────── */

/**
 * Convert SmartRecruiters HTML section content into compact markdown.
 *
 * Preserved verbatim from the pre-extraction implementation. The shared
 * client offers a concatenated `descriptionHtml` field, but Migros HQ uses
 * its own markdown formatter to keep "## Qualifiche" / "## Informazioni
 * aggiuntive" section headings consistent with downstream localisation.
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
 * Fetch all Migros HQ Zürich jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllMigrosHqJobs() {
  console.log(`🔍 Fetching Migros HQ Zürich jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);
  console.log(`   Fetching from: ${CAREER_URL}`);

  const jobs = [];
  let yielded = 0;

  try {
    // Filter at the SR-client level: built-in `locationCountryCodes` is too
    // coarse (we want ZH only); pass `isHqLocation` as the custom predicate
    // applied per-posting BEFORE the optional detail-fetch — so we save
    // detail calls on out-of-scope postings.
    const iter = fetchSmartRecruitersJobs(SR_TENANT, {
      company: MIGROS_HQ_COMPANY_NAME,
      filter: (posting) => isHqLocation(posting?.location || {}),
      fetchDetail: true,
      detailConcurrency: SR_DETAIL_CONCURRENCY,
      // Listing pagination: original used no inter-page delay; keep parity.
      minDelayMs: 0,
      maxPages: 50,
      timeoutMs: SR_FETCH_TIMEOUT_MS,
      // Original UA distinguished crawler version; preserve verbatim.
      userAgent: 'FrontaliereTicino-JobCrawler/2.0',
    });

    for await (const normalized of iter) {
      yielded += 1;
      const posting = normalized.rawPosting || {};
      const listing = postingToListing(posting);

      const title = normalizeSpace(listing.title || '');
      if (!title || title.length < 3) continue;

      // Default to Zürich (Migros HQ) when SR doesn't return a city; canton ZH.
      const location = listing.location || 'Zürich';
      const canton = inferSwissTargetCanton(`${location}, ${listing.region || ''}`)
        || inferAnyCanton(`${location}, ${listing.region || ''}`)
        || 'ZH';
      const descriptionText = stripHtml(listing.description || '');
      const publicUrl = listing.url || CAREER_URL;

      const sourceLang = detectLang(descriptionText || title, 'de');
      const jobSlug = slugify(`${title} migros-hq ch`);
      const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

      const job = {
        // ── Required fields ──
        id: `migros-hq-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: MIGROS_HQ_COMPANY_NAME,
        companyKey: MIGROS_HQ_KEY,
        companyDomain: MIGROS_HQ_COMPANY_DOMAIN,
        title,
        titleByLocale: { [sourceLang]: title },
        description: descriptionText || `${title} — Migros HQ Zürich`,
        descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Migros HQ Zürich` },
        location,
        canton,
        url: publicUrl,
        source: 'Migros HQ Zürich Dedicated Parser',
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
        sector: 'Retail',
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

  console.log(`   HQ-scoped postings: ${yielded}`);
  console.log(`  📋 Listings (post-filter): ${yielded}`);
  console.log(`\n📋 Total Migros HQ Zürich jobs discovered: ${jobs.length}`);
  return jobs;
}
