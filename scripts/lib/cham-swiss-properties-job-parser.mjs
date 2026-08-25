#!/usr/bin/env node
/**
 * Cham Swiss Properties AG job parser — jobs.ch public search API + JSON-LD detail.
 *
 * Source: https://www.jobs.ch/en/companies/142189-cham-swiss-properties-ag/
 * (public company profile page; the jobs.ch API discovery below is what
 * actually feeds this parser — see ./jobs-ch-search-common.mjs)
 *
 * @outsourced-ats-needs-migration: champroperties.ch's own careers page
 * (https://champroperties.ch/en/company/karriere, re-checked live
 * 2026-08-25) links its "Jetzt bewerben" CTA to jobs.dualoo.com — its actual
 * chosen outsourced ATS is Dualoo, not jobs.ch/jobup.ch. This parser sources
 * from the wrong third party entirely (an aggregator this employer does not
 * even use for applications), not merely a suboptimal-but-genuine one.
 * Dualoo is already a known shared-host platform elsewhere in this repo's
 * crawler fleet (see the `own` prospector discovery source in
 * `scripts/lib/prospector/sources/known-crawlers.mjs`) — migrate this
 * parser to source from the employer's Dualoo tenant directly instead of
 * jobs.ch.
 *
 * Cham Swiss Properties AG (SIX: CHAM) is a listed Swiss real-estate
 * development / project-management company headquartered in Cham (ZG),
 * formed in 2025 through the merger of Ina Invest AG and Cham Group AG
 * (itself tracing back to the historic 1657 Cham paper-mill site). It
 * develops residential/mixed-use urban quarters (Papieri-Areal Cham,
 * Bredella Pratteln, plus projects in Zurich and Geneva) on a CHF ~1.7bn
 * portfolio. Confirmed GENUINE DIRECT EMPLOYER, not a staffing/placement
 * agency:
 *   - own company careers page (champroperties.ch/en/company/karriere)
 *     lists open positions as its own headcount, with an in-house HR
 *     contact (Fachverantwortliche Personaladministration) — not a
 *     third-party recruiter.
 *   - jobs.ch company profile posts directly under "Cham Swiss
 *     Properties AG" as `hiringOrganization`, no client/mandate framing.
 *   - Small (~50 employee) in-house team; postings are corporate/real-
 *     estate development roles (contract management, project management,
 *     IT), consistent with an owner-developer, not a placement agency.
 *
 * jobs.ch company profile id: 142189.
 *
 * IMPORTANT — re-verified 2026-07-06 (follow-up #3637, item 2) whether this
 * numeric id risks going stale the way DIC SA's did (see ./dic-sa-job-parser.mjs:
 * that company had a duplicate legacy numeric profile with jobCount: 0,
 * requiring a switch to its separate active UUID profile). Cham Swiss
 * Properties AG has NO such duplicate:
 *   - `job-search-api.jobs.ch/search?companyIds=142189` → totalHits: 1
 *     (confirmed live, same posting as at crawler creation).
 *   - the profile's own React state carries `"id":"142189"`,
 *     `"redirectToCompanyId":null`, `"redirectToCompanySlug":null` — i.e.
 *     jobs.ch itself does not consider 142189 superseded/redirected.
 *   - a jobs.ch company-name search for "Cham Swiss Properties" returns
 *     exactly one record (142189, jobCount: 1) — no second/UUID-only entry
 *     exists to migrate to (unlike DIC SA, which had two distinct company
 *     records for the same employer).
 * Conclusion: 142189 is the sole, active, stable id — no UUID migration
 * applies here. Keep as-is; re-check only if the search API starts
 * returning 0 hits for it.
 *
 * HQ fallback address (confirmed via jobs.ch company profile JSON-LD,
 * company website imprint and LinkedIn): Fabrikstrasse 5, 6330 Cham, ZG.
 *
 * Exports the 3 functions used by the crawler template:
 *   - fetchAllChamSwissPropertiesJobs()  — Fetch and parse all Swiss jobs
 *   - isChamSwissPropertiesJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()                  — Validate URLs belong to this company
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferAnyCanton, normalizeCantonCode } from './target-swiss-locations.mjs';
import { detectEmploymentTypeFromOccupation } from './jobup-ch-feed-common.mjs';
import {
  fetchJobsChCompanyListings,
  fetchJobsChJobPostingLd,
  jobsChDetailUrl,
} from './jobs-ch-search-common.mjs';

/* Constants ─────────────────────────────────────────────── */

export const CHAM_SWISS_PROPERTIES_KEY = 'cham-swiss-properties';
export const CHAM_SWISS_PROPERTIES_COMPANY_NAME = 'Cham Swiss Properties';
export const CHAM_SWISS_PROPERTIES_COMPANY_DOMAIN = 'champroperties.ch';

const COMPANY_IDS = ['142189'];
const CAREER_URL = 'https://www.jobs.ch/en/companies/142189-cham-swiss-properties-ag/';

/* HQ fallback: Fabrikstrasse 5, 6330 Cham (jobs.ch company profile + LinkedIn). */
const HQ = {
  city: 'Cham',
  canton: 'ZG',
  postalCode: '6330',
  streetAddress: 'Fabrikstrasse 5',
};

const SECTOR = 'Immobiliare / Project Management';

/* Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isChamSwissPropertiesJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CHAM_SWISS_PROPERTIES_KEY ||
    key.startsWith('cham-swiss-properties') ||
    company.includes('cham swiss properties') ||
    url.includes('champroperties.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'champroperties.ch' || host.endsWith('.champroperties.ch')) return true;
    if (host === 'jobs.ch' || host.endsWith('.jobs.ch')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(vertrag|contract|contrat|contratt)/.test(t)) return 'Contract Management';
  if (/\b(projekt|project|projet|progetto|bauherr|entwickl|develop)/.test(t)) return 'Project Management';
  if (/\b(it|software|digital|system)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|ressources)/.test(t)) return 'Risorse Umane';
  if (/\b(immobil|liegenschaft|real estate|property|portfolio)/.test(t)) return 'Immobiliare';
  if (/\b(admin|segret|contab|buchhalt|account|assistant)/.test(t)) return 'Amministrazione';
  if (/\b(marketing|communication|kommunikation|comunicaz)/.test(t)) return 'Marketing';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Map jobs.ch's free-text `employmentType` (JSON-LD) + posting workload
 * grades to the schema.org employmentType enum consumed downstream.
 */
function resolveEmploymentType(ldEmploymentType = '', grades = []) {
  const t = normalize(ldEmploymentType);
  if (/\b(intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ]))/.test(t)) return 'INTERN';
  if (/temporary|fixed.term|contract/.test(t)) return 'TEMPORARY';
  if (/supplementary/.test(t)) return 'PER_DIEM';
  const nums = (Array.isArray(grades) ? grades : []).map(Number).filter(Number.isFinite);
  const min = nums.length ? Math.min(...nums) : 0;
  const max = nums.length ? Math.max(...nums) : 100;
  return detectEmploymentTypeFromOccupation(min, max) === 'PART_TIME' ? 'PART_TIME' : 'FULL_TIME';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all Cham Swiss Properties jobs. Returns an array of ParsedJob
 * objects (source-locale only — other locales are filled by the AI
 * localization step and translate-pending pipeline).
 */
export async function fetchAllChamSwissPropertiesJobs() {
  console.log(`🔍 Fetching ${CHAM_SWISS_PROPERTIES_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobsChCompanyListings({ companyIds: COMPANY_IDS });
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  const seen = new Set();
  const seenSlugs = new Set();

  for (const listing of listings) {
    const title = normalizeSpace(listing.title || '');
    if (!title || title.length < 3) continue;
    if (seen.has(listing.id)) continue;
    seen.add(listing.id);

    let ld = null;
    let detailUrl = jobsChDetailUrl(listing.id, 'en');
    try {
      const detail = await fetchJobsChJobPostingLd(listing.id, { locale: 'en' });
      ld = detail.ld;
      detailUrl = detail.url;
    } catch (err) {
      console.warn(`⚠️ Failed to fetch detail for ${listing.id}: ${err?.message || err}`);
    }

    const loc0 = Array.isArray(listing.locations) ? listing.locations[0] : null;
    const place = normalizeSpace(listing.place || loc0?.city || '');
    const canton =
      normalizeCantonCode(loc0?.cantonCode || '') ||
      inferAnyCanton(place) ||
      HQ.canton;

    const descriptionHtml = ld?.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const description = descriptionText || `${title} presso ${CHAM_SWISS_PROPERTIES_COMPANY_NAME} a ${place || HQ.city}.`;
    // No hardcoded language fallback: Cham Swiss Properties develops projects
    // in Cham/Zug (DE) AND Geneva (FR) — a single-locale default would
    // silently mistag an ambiguous FR posting as 'de', freezing the wrong
    // locale key in slugByLocale/descriptionByLocale downstream. `null` on a
    // genuinely ambiguous/short text is handled gracefully: mergeLocaleTextMap()
    // treats a falsy sourceLocale as "unknown" (symmetric merge, no forced
    // locale overwrite) and hardenJobLocaleFields() re-derives + backfills the
    // real source locale from the job's own title/description on the very
    // next pipeline step.
    const sourceLang = detectLang(descriptionText || title, null);

    const urlHash = createHash('sha1').update(listing.id).digest('hex').slice(0, 12);

    // Two distinct postings can legitimately share title+location —
    // disambiguate in-run collisions with a short id suffix so both jobs
    // keep a stable, unique slug instead of silently colliding.
    let jobSlug = slugify(`${title} cham-swiss-properties ${place || HQ.city}`);
    if (seenSlugs.has(jobSlug)) {
      jobSlug = slugify(`${title} cham-swiss-properties ${place || HQ.city} ${urlHash.slice(0, 6)}`);
    }
    seenSlugs.add(jobSlug);

    const employmentType = resolveEmploymentType(ld?.employmentType || '', listing.employmentGrades);
    const postedDate = (listing.publicationDate && String(listing.publicationDate).slice(0, 10))
      || (listing.initialPublicationDate && String(listing.initialPublicationDate).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const hiringOrganizationName = ld?.hiringOrganization?.name || listing.company?.name || CHAM_SWISS_PROPERTIES_COMPANY_NAME;

    const job = {
      // ── Required fields ──
      id: `${CHAM_SWISS_PROPERTIES_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CHAM_SWISS_PROPERTIES_COMPANY_NAME,
      companyKey: CHAM_SWISS_PROPERTIES_KEY,
      companyDomain: CHAM_SWISS_PROPERTIES_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: place || HQ.city,
      canton,
      url: detailUrl,
      source: 'Cham Swiss Properties Dedicated Parser (jobs.ch)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: loc0?.city || place || HQ.city,
      addressRegion: canton,
      streetAddress: normalizeSpace(loc0?.street || '') || (canton === HQ.canton ? HQ.streetAddress : ''),
      postalCode: normalizeSpace(loc0?.postalCode || '') || (canton === HQ.canton ? HQ.postalCode : ''),
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: detailUrl,
      hiringOrganizationName,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${CHAM_SWISS_PROPERTIES_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
