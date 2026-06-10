#!/usr/bin/env node
/**
 * Duferco job parser — Fetcher and job builder.
 *
 * Source: https://duferco.talentics.ai/api/public/t/duferco/jobs
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllDufercoJobs()  — Fetch and parse all jobs
 *   - isDufercoJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchJson, normalizeSpace } from './crawler-template.mjs';
import { inferSwissTargetCanton, findSwissCityInText, canonicalSwissCityName } from './target-swiss-locations.mjs';
import { assertJsonListShapeMultiKey } from './assert-json-list-shape.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const DUFERCO_KEY = 'duferco';
export const DUFERCO_COMPANY_NAME = 'Duferco';
export const DUFERCO_COMPANY_DOMAIN = 'duferco.talentics.ai';

const CAREER_URL = 'https://duferco.talentics.ai/api/public/t/duferco/jobs';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Duferco.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isDufercoJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === DUFERCO_KEY ||
    key.startsWith('duferco') ||
    company.includes('duferco') ||
    url.includes('duferco.talentics.ai')
  );
}

/**
 * Validate that a URL belongs to Duferco's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'duferco.talentics.ai' || host.endsWith('.duferco.talentics.ai');
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

/**
 * Map a Talentics `department` / role title into the site sector taxonomy.
 * Engineering/innovation roles (the only kind Duferco currently posts) map to
 * the tech bucket; everything else falls back to a generic label.
 */
function detectSector(department = '', category = '') {
  const d = normalize(department);
  if (/innovation|engineer|software|platform|it|data|tech/.test(d)) return 'Tecnologia & IT';
  if (['IT', 'Ingegneria'].includes(category)) return 'Tecnologia & IT';
  return 'Altro';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch the public Talentics job board for the Duferco tenant.
 *
 * Endpoint (reverse-engineered from the SPA bundle): the careers app reads
 * `${apiBase}/public/t/${subdomain}/jobs`, where `apiBase` is the same-origin
 * `/api` path. It returns a flat JSON array of public job objects — no
 * pagination, no auth. See `data/jobs-crawler-config.json` for the contract.
 */
async function fetchJobListings() {
  console.log(`   Fetching from: ${CAREER_URL}`);
  const data = await fetchJson(CAREER_URL, {
    headers: { Accept: 'application/json' },
  });
  // The endpoint returns a flat top-level array (no envelope); a non-array is an
  // error/challenge body → warn loudly rather than silently yielding 0 jobs.
  return assertJsonListShapeMultiKey(data, {
    keys: [],
    allowBareArray: true,
    source: DUFERCO_KEY,
  });
}

/**
 * Fetch all Duferco jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllDufercoJobs() {
  console.log(`🔍 Fetching Duferco jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  let skippedNonSwiss = 0;
  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;

    // Only public, active postings are surfaced. The board occasionally returns
    // drafts/closed roles with non-public visibility — never index those.
    const status = normalize(listing.status || 'active');
    if (status && status !== 'active') continue;
    const visibility = normalize(listing.visibility || 'public_main');
    if (visibility && !visibility.startsWith('public')) continue;

    // Duferco's board mixes Swiss (Lugano) and Italian (Milan) postings. Index
    // only roles with a REAL Swiss municipality in the location string.
    //
    // We require BOTH a target canton AND a resolved Swiss city — never a
    // fallback to the raw location. `inferSwissTargetCanton` alone is not
    // CH-only: its border-proximity keywords (como/varese/novara/…) return a
    // canton for Italian border cities too. Without a genuine CH municipality
    // from `findSwissCityInText`, the row would emit an Italian addressLocality
    // under addressCountry:CH — geographically contradictory JSON-LD (de-index
    // risk). Milan/Remote/Switzerland-only postings are dropped here as well.
    const rawLocation = normalizeSpace(listing.location || '');
    const canton = inferSwissTargetCanton(rawLocation);
    // Canonical BFS display name — preserves hyphens for composite municipalities
    // (e.g. "La Chaux-de-Fonds"), which the space-normalized token from
    // findSwissCityInText would otherwise drop, malforming the addressLocality.
    const swissCity = canonicalSwissCityName(findSwissCityInText(rawLocation));
    if (!canton || !swissCity) {
      skippedNonSwiss += 1;
      continue;
    }

    const descriptionHtml = listing.description || '';
    const descriptionText = stripHtml(descriptionHtml);

    // Public apply/detail page on the careers SPA (route `/job/:jobId`).
    const jobId = String(listing.id || '').trim();
    if (!jobId) continue;
    const publicUrl = `https://duferco.talentics.ai/job/${jobId}`;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} duferco ${swissCity}`);
    const category = detectCategory(title);
    const postedDate = String(listing.created_at || '').slice(0, 10) ||
      new Date().toISOString().split('T')[0];
    // Derive `contract` from `employmentType` so the two never diverge —
    // jobsSeoPagesPlugin/mobileActionBlock read `job.contract` directly.
    const employmentType = detectEmploymentType(listing.type || title);
    const contract = employmentType === 'PART_TIME' ? 'part-time' : 'full-time';

    const job = {
      // ── Required fields ──
      id: `duferco-${jobId}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: DUFERCO_COMPANY_NAME,
      companyKey: DUFERCO_KEY,
      companyDomain: DUFERCO_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — Duferco`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — Duferco` },
      location: swissCity,
      canton,
      url: publicUrl,
      source: 'Duferco Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: swissCity,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      category,
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: detectSector(listing.department, category),
      department: normalizeSpace(listing.department || ''),
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  if (skippedNonSwiss > 0) {
    console.log(`  ⏭️  Skipped ${skippedNonSwiss} non-Swiss (e.g. Milan-only) postings.`);
  }
  console.log(`\n📋 Total Duferco jobs discovered: ${jobs.length}`);
  return jobs;
}
