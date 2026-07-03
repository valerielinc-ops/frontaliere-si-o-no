#!/usr/bin/env node
/**
 * Mistral AI job parser — Fetcher and job builder.
 *
 * Source: https://jobs.lever.co/mistral
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllMistralAiJobs()  — Fetch and parse all jobs
 *   - isMistralAiJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  buildLeverApiUrl,
  normalizeLeverJob,
  extractLeverCompanySlug,
  LeverApiError,
} from './ats-clients/lever-client.mjs';
import { fetchWithRetry } from './transient-fetch.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const MISTRAL_AI_KEY = 'mistral-ai';
export const MISTRAL_AI_COMPANY_NAME = 'Mistral AI';
export const MISTRAL_AI_COMPANY_DOMAIN = 'mistral.ai';

const CAREER_URL = 'https://jobs.lever.co/mistral';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Mistral AI.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isMistralAiJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === MISTRAL_AI_KEY ||
    key.startsWith('mistral-ai') ||
    company.includes('mistral ai') ||
    url.includes('mistral.ai')
  );
}

/**
 * Validate that a URL belongs to Mistral AI's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'mistral.ai' || host.endsWith('.mistral.ai')) return true;
    if (host === 'jobs.lever.co') {
      const path = url.pathname.toLowerCase();
      const slug = LEVER_COMPANY_SLUG.toLowerCase();
      return path.startsWith(`/${slug}/`) || path === `/${slug}`;
    }
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(scientist|research|researcher|r&d|ml|machine learning|ai\b)/.test(t)) return 'Ricerca';
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

/* ── Lever fetcher ────────────────────────────────────────────
 * Mistral AI is a global org (~175 open roles across Paris/Singapore/
 * Palo Alto/…). Only a handful target Zurich, and several of those list
 * Zurich as a SECONDARY office in `categories.allLocations` rather than
 * the primary `categories.location` (e.g. "Research Engineer, Machine
 * Learning - Paris/London/Zurich/Warsaw" has `location: "Paris"`).
 * The shared `fetchLeverJobs()` helper only filters on the primary
 * `location` field, so it would miss those multi-location postings.
 * We fetch+paginate manually here (reusing the client's URL builder /
 * normalizer / retry helper) and filter on `allLocations` instead.
 */
const LEVER_COMPANY_SLUG =
  extractLeverCompanySlug(CAREER_URL) || MISTRAL_AI_KEY;
const LEVER_LOCATION_NEEDLES = ['zurich', 'zürich', 'switzerland', 'suisse', 'schweiz'];
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const TIMEOUT_MS = 20_000;
const POLITE_UA = 'FrontaliereTicino-Bot/1.0 (+https://frontaliereticino.ch/bot)';

async function fetchLeverPage(url) {
  return fetchWithRetry(
    async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      let res;
      try {
        res = await fetch(url, {
          signal: ac.signal,
          headers: { 'User-Agent': POLITE_UA, Accept: 'application/json' },
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        const json = await res.json();
        if (!Array.isArray(json)) {
          const e = new LeverApiError(`Lever API returned non-array body for ${url}`, res.status);
          e.nonTransient = true;
          throw e;
        }
        return json;
      }
      throw new LeverApiError(`Lever API ${res.status} ${res.statusText} for ${url}`, res.status);
    },
    {
      label: `lever ${url}`,
      isTransient: (err) => {
        if (err instanceof LeverApiError) {
          if (err.nonTransient) return false;
          return err.statusCode == null || err.statusCode >= 500;
        }
        return true;
      },
    },
  );
}

async function fetchJobListings() {
  const matches = [];
  let skip = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = buildLeverApiUrl(LEVER_COMPANY_SLUG, { skip, limit: PAGE_SIZE });
    const batch = await fetchLeverPage(url);
    for (const raw of batch) {
      if (!raw || typeof raw !== 'object') continue;
      const allLocations = Array.isArray(raw?.categories?.allLocations)
        ? raw.categories.allLocations
        : [String(raw?.categories?.location || '')];
      const haystack = allLocations.join(' | ').toLowerCase();
      if (!LEVER_LOCATION_NEEDLES.some((n) => haystack.includes(n))) continue;
      matches.push(normalizeLeverJob(raw, { company: MISTRAL_AI_COMPANY_NAME }));
    }
    if (batch.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }

  return matches.map((j) => ({
    title: j.title,
    location: j.location,
    url: j.applyUrl,
    postedAt: j.postedAt,
    description: j.descriptionHtml || '',
    jobReqId: j.jobReqId,
  }));
}

/**
 * Fetch all Mistral AI jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllMistralAiJobs() {
  console.log(`🔍 Fetching Mistral AI jobs`);
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

    const location = listing.location || 'Zurich';
    const canton = inferSwissTargetCanton(location) || 'ZH';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} mistral-ai ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `mistral-ai-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: MISTRAL_AI_COMPANY_NAME,
      companyKey: MISTRAL_AI_KEY,
      companyDomain: MISTRAL_AI_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Mistral AI`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Mistral AI` },
      location,
      canton,
      url: publicUrl,
      source: 'Mistral AI Dedicated Parser',
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
      sector: 'Intelligenza Artificiale / Ricerca',
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

  console.log(`\n📋 Total Mistral AI jobs discovered: ${jobs.length}`);
  return jobs;
}
