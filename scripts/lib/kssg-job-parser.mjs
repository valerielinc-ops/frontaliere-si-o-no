#!/usr/bin/env node
/**
 * Kantonsspital St. Gallen (KSSG, now part of HOCH Health Ostschweiz) job parser.
 *
 * Source: https://jobs.h-och.ch/search/
 *   - SAP SuccessFactors Career Site Builder (CSB), `html-jobreq` flavor.
 *   - The legacy `www.kssg.ch/karriere` redirects to `www.h-och.ch/job-karriere/`.
 *   - Same SF backend pattern as Oerlikon / Mobiliar — SSR HTML listings under
 *     `/search/` with `/job/{slug}/{id}/` detail pages.
 *   - We rely on the shared `successfactors-client.mjs` `html-jobreq` walker
 *     (host `jobs.h-och.ch` is registered in `detectSuccessFactorsKind`).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllKssgJobs()  — Fetch and parse all jobs
 *   - isKssgJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()   — Validate URLs belong to this company / HOCH portal
 *   - KSSG_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
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

export const KSSG_KEY = 'kssg';
export const KSSG_COMPANY_NAME = 'Kantonsspital St. Gallen (KSSG / HOCH)';
export const KSSG_COMPANY_DOMAIN = 'kssg.ch';

const CAREER_URL = 'https://jobs.h-och.ch/search/';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Kantonsspital St. Gallen (KSSG / HOCH).
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isKssgJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === KSSG_KEY ||
    key.startsWith('kssg') ||
    key.startsWith('hoch') ||
    company.includes('kantonsspital st. gallen') ||
    company.includes('kantonsspital sankt gallen') ||
    company.includes('hoch health ostschweiz') ||
    url.includes('kssg.ch') ||
    url.includes('h-och.ch')
  );
}

/**
 * Validate that a URL belongs to Kantonsspital St. Gallen / HOCH Ostschweiz.
 * Trusts the legacy KSSG domain plus the new HOCH umbrella domains and the
 * SuccessFactors Career Site Builder portal.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'kssg.ch' || host.endsWith('.kssg.ch')) return true;
    if (host === 'h-och.ch' || host.endsWith('.h-och.ch')) return true;
    if (host === 'jobs.h-och.ch') return true;
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

/* ── SuccessFactors fetcher ───────────────────────────────────
 * Three flavors auto-detected from CAREER_URL:
 *   - 'odata-api'    → api{N}.successfactors.com/odata/v2/...
 *   - 'html-career'  → career5.successfactors.eu/career?company=...
 *   - 'html-jobreq'  → jobs2web / SSR overlay (jobs.sbb.ch, etc.)
 * For 'html-career' listing index you typically need Playwright
 * (re-scaffold with --playwright if so).
 */
// HOCH covers KSSG (St. Gallen), Spital Linth (Uznach), Spital Walenstadt,
// Fürstenland (Wil), Rorschach. We do NOT filter by location at fetch time —
// every HOCH job is in canton SG, so canton inference happens per-listing.
const SF_LOCATION_FILTERS = [];

const FETCH_USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereTicino-JobCrawler/2.0; +https://frontaliereticino.ch)';
const DETAIL_TIMEOUT_MS = 15_000;
const DETAIL_RATE_LIMIT_MS = 400;

/**
 * Fetch the public SuccessFactors detail page for a job and extract the
 * full job description (Aufgaben / Anforderungen / Wir bieten sections).
 * Returns plain text with `<li>` items preserved as `\n• ` bullets via
 * the shared stripHtml; empty string on any failure.
 */
async function fetchKssgDetailDescription(detailUrl) {
  if (!detailUrl) return '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DETAIL_TIMEOUT_MS);
  try {
    const res = await fetch(detailUrl, {
      headers: {
        'User-Agent': FETCH_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-CH,de;q=0.9,en;q=0.6',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return '';
    const html = await res.text();
    // SuccessFactors CSB detail pages render the body inside #jobdescription
    // or a div with class "jobdescription". Fall back to <main>/<article>.
    const match =
      html.match(/<div[^>]*\bid="jobdescription"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<\/main>)/i) ||
      html.match(/<div[^>]*class="[^"]*\bjobdescription\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<\/main>)/i) ||
      html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
      html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (!match) return '';
    const text = stripHtml(match[1]);
    // Preserve newlines (and `\n• ` markers from <li> stripping); only collapse
    // intra-line whitespace runs.
    return text
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 4000);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

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
      company: KSSG_COMPANY_NAME,
    })) {
      out.push({
        title: job.title,
        location: job.location,
        url: job.applyUrl,
        postedAt: job.postedAt,
        jobReqId: job.jobReqId,
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
 * Fetch all Kantonsspital St. Gallen (KSSG / HOCH) jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllKssgJobs() {
  console.log(`🔍 Fetching Kantonsspital St. Gallen (KSSG / HOCH) jobs`);
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

    const location = listing.location || 'St. Gallen';
    const canton = inferSwissTargetCanton(location) || 'SG';
    const publicUrl = listing.url || CAREER_URL;

    // Always prefer the real description from the SuccessFactors detail page.
    // Rate-limited so we don't hammer jobs.h-och.ch.
    const detailDescription = await fetchKssgDetailDescription(publicUrl);
    if (publicUrl && publicUrl !== CAREER_URL) {
      await new Promise((r) => setTimeout(r, DETAIL_RATE_LIMIT_MS));
    }

    // TEMPORARY fallback: when the detail page is unreachable or doesn't
    // expose the body (e.g. anti-bot / login wall), keep a structured stub so
    // the page still renders. The long-term fix is upstream — make sure the
    // detail page is always reachable. <1% of crawls are expected here.
    const fallbackDescription = [
      `${title} — Kantonsspital St. Gallen (KSSG / HOCH), ${location}.`,
      '',
      'Eckdaten der Stelle:',
      `• Standort: ${location}, Kanton ${canton}`,
      `• Arbeitgeber: Kantonsspital St. Gallen (KSSG) — Teil von HOCH Health Ostschweiz`,
      `• Branche: ${listing.department || 'Spital / Gesundheitswesen'}`,
      `• Vertragsart: ${listing.contractType || 'siehe Stellenausschreibung'}`,
      '• Bewerbungsportal: jobs.h-och.ch (SAP SuccessFactors)',
    ].join('\n');
    const descriptionText = detailDescription.length >= 100 ? detailDescription : fallbackDescription;

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} kssg ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `kssg-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KSSG_COMPANY_NAME,
      companyKey: KSSG_KEY,
      companyDomain: KSSG_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location,
      canton,
      url: publicUrl,
      source: 'Kantonsspital St. Gallen (KSSG / HOCH) Dedicated Parser',
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
      sector: 'Sanità / Ospedali',
      addressRegion: canton,
      postalCode: location.toLowerCase().includes('st. gallen') || location.toLowerCase().includes('sankt gallen') ? '9007' : '9000',
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

  console.log(`\n📋 Total Kantonsspital St. Gallen (KSSG / HOCH) jobs discovered: ${jobs.length}`);
  return jobs;
}
