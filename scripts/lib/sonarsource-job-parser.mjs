#!/usr/bin/env node
/**
 * SonarSource (Sonar) job parser — Fetcher and job builder.
 *
 * Source: https://jobs.lever.co/sonarsource
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSonarsourceJobs()  — Fetch and parse all jobs
 *   - isSonarsourceJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import {
  fetchLeverJobs,
  extractLeverCompanySlug,
} from './ats-clients/lever-client.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SONARSOURCE_KEY = 'sonarsource';
export const SONARSOURCE_COMPANY_NAME = 'SonarSource (Sonar)';
export const SONARSOURCE_COMPANY_DOMAIN = 'sonarsource.com';

const CAREER_URL = 'https://jobs.lever.co/sonarsource';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to SonarSource (Sonar).
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isSonarsourceJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SONARSOURCE_KEY ||
    key.startsWith('sonarsource') ||
    company.includes('sonarsource (sonar)') ||
    url.includes('sonarsource.com')
  );
}

/**
 * Validate that a URL belongs to SonarSource (Sonar)'s domain.
 *
 * Applicant-facing URLs are served from Lever's own hosted domain
 * (jobs.lever.co/sonarsource/...), not sonarsource.com — accept both.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'sonarsource.com' ||
      host.endsWith('.sonarsource.com') ||
      host === 'jobs.lever.co'
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

/* ── Lever fetcher ────────────────────────────────────────────
 * Pass either a jobs.lever.co URL (auto-extracts company slug) or
 * override LEVER_COMPANY_SLUG below.
 */
const LEVER_COMPANY_SLUG =
  extractLeverCompanySlug(CAREER_URL) || SONARSOURCE_KEY;
// Sonar posts globally (San Mateo, Austin, Singapore, London, Bochum, …) but
// only the Geneva hub is a Swiss role — restrict to that location.
const LEVER_LOCATION_CONTAINS = ['geneva'];

async function fetchJobListings() {
  const jobs = await fetchLeverJobs(LEVER_COMPANY_SLUG, {
    company: SONARSOURCE_COMPANY_NAME,
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
 * Fetch all SonarSource (Sonar) jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllSonarsourceJobs() {
  console.log(`🔍 Fetching SonarSource (Sonar) jobs`);
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

    const location = listing.location || 'Vernier';
    const canton = inferSwissTargetCanton(location) || 'GE';
    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = listing.url || CAREER_URL;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} sonarsource ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `sonarsource-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SONARSOURCE_COMPANY_NAME,
      companyKey: SONARSOURCE_KEY,
      companyDomain: SONARSOURCE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — SonarSource (Sonar)`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — SonarSource (Sonar)` },
      location,
      canton,
      url: publicUrl,
      source: 'SonarSource (Sonar) Dedicated Parser',
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
      sector: 'Software / Dev Tools',
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

  console.log(`\n📋 Total SonarSource (Sonar) jobs discovered: ${jobs.length}`);
  return jobs;
}
