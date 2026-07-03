#!/usr/bin/env node
/**
 * ANYbotics job parser — Fetcher and job builder.
 *
 * Source: https://jobs.lever.co/anybotics
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllAnyboticsJobs()  — Fetch and parse all jobs
 *   - isAnyboticsJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import {
  fetchLeverJobs,
  extractLeverCompanySlug,
} from './ats-clients/lever-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const ANYBOTICS_KEY = 'anybotics';
export const ANYBOTICS_COMPANY_NAME = 'ANYbotics';
export const ANYBOTICS_COMPANY_DOMAIN = 'anybotics.com';

const CAREER_URL = 'https://jobs.lever.co/anybotics';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to ANYbotics.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isAnyboticsJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === ANYBOTICS_KEY ||
    key.startsWith('anybotics') ||
    company.includes('anybotics') ||
    url.includes('anybotics.com') ||
    url.includes('jobs.lever.co/anybotics')
  );
}

/**
 * Validate that a URL belongs to ANYbotics's domain.
 *
 * ANYbotics hosts its ATS on Lever (jobs.lever.co/anybotics/...) — the
 * apply URL never resolves under anybotics.com, so both hosts are trusted
 * (scoped to this company's Lever posting-board slug, not lever.co at large).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'anybotics.com' || host.endsWith('.anybotics.com')) return true;
    if (host === 'jobs.lever.co') {
      return url.pathname.toLowerCase().startsWith(`/${ANYBOTICS_KEY}/`) ||
        url.pathname.toLowerCase() === `/${ANYBOTICS_KEY}`;
    }
    return false;
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

/* ── Lever fetcher ────────────────────────────────────────────
 * Pass either a jobs.lever.co URL (auto-extracts company slug) or
 * override LEVER_COMPANY_SLUG below.
 */
const LEVER_COMPANY_SLUG =
  extractLeverCompanySlug(CAREER_URL) || ANYBOTICS_KEY;
// ANYbotics posts globally (Zurich HQ + Barcelona hub + regional sales roles
// in Dubai/US). This site targets Swiss jobs only — keep Zurich/Switzerland
// postings, drop the rest.
const LEVER_LOCATION_CONTAINS = ['zurich', 'switzerland'];

async function fetchJobListings() {
  const jobs = await fetchLeverJobs(LEVER_COMPANY_SLUG, {
    company: ANYBOTICS_COMPANY_NAME,
    locationContains: LEVER_LOCATION_CONTAINS,
  });
  return jobs.map((j) => ({
    title: j.title,
    location: j.location,
    url: j.applyUrl,
    postedAt: j.postedAt,
    description: j.descriptionHtml || '',
    jobReqId: j.jobReqId,
  }));
}

/**
 * Fetch all ANYbotics jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllAnyboticsJobs() {
  console.log(`🔍 Fetching ANYbotics jobs`);
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

    const location = listing.location || 'Zurich'; // ANYbotics HQ (postings pre-filtered to CH)
    const canton = inferAnyCanton(location) || 'ZH';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} anybotics ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `anybotics-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ANYBOTICS_COMPANY_NAME,
      companyKey: ANYBOTICS_KEY,
      companyDomain: ANYBOTICS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — ANYbotics`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — ANYbotics` },
      location,
      canton,
      url: publicUrl,
      source: 'ANYbotics Dedicated Parser',
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
      sector: 'Robotica / Automazione',
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

  console.log(`\n📋 Total ANYbotics jobs discovered: ${jobs.length}`);
  return jobs;
}
