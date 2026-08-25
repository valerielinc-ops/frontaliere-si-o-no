#!/usr/bin/env node
/**
 * DIC SA (ingénieurs) job parser — jobs.ch public search API + JSON-LD detail.
 *
 * Source: https://www.jobup.ch/fr/societes/ee30c164-1431-42ab-af87-d45a5dc3579f-dic-sa/
 * (public company profile; jobs.ch/jobup.ch are both operated by JobCloud AG
 * and share the same public search API — see ./jobs-ch-search-common.mjs)
 *
 * @outsourced-ats-needs-verification: dic-ing.ch's own "Rejoignez-nous" CTA
 * (re-checked live 2026-08-25) links to https://www.dic-ing.ch/team/, a team
 * page rather than a clear job listing or an explicit hand-off to
 * jobup.ch — inconclusive either way from a static fetch. Needs a real
 * browser (or an agent with one) to check whether /team/ actually lists
 * openings before this can be marked confirmed or needs-migration.
 *
 * DIC SA ingénieurs is a small civil-engineering consultancy ("bureau
 * d'ingénieur-conseil") headquartered in Aigle (VD), with branch offices in
 * Sion and Martigny (VS). Founded 1982, incorporated as SA in 1991
 * (CHE-105.986.545), ISO 9001 certified since 1998. Confirmed GENUINE DIRECT
 * EMPLOYER, not a staffing/placement agency:
 * - dic-ing.ch (own corporate site) describes itself as "un bureau reconnu
 *   pour la qualité et la précision de ses ouvrages" in civil engineering,
 *   structural works and road/rail infrastructure — a design/consulting firm
 *   with its own permanent engineering staff, not a temp-work intermediary.
 * - The single live posting's description uses first-person "notre équipe à
 *   taille humaine", "Depuis plus de 40 ans, DIC SA ingénieurs s'impose
 *   comme..." language, never third-party-placement/staffing phrasing.
 * - `hiringOrganization`/`company.name` on jobs.ch is consistently "DIC SA",
 *   matching the Aigle head-office entity (no unrelated client name).
 *
 * IMPORTANT — jobs.ch numeric company id (81584, "dic-sa-ingenieurs" slug,
 * from https://www.jobs.ch/fr/entreprises/81584-dic-sa-ingenieurs/) returns
 * jobCount: 0 and totalHits: 0 against the search API — it is a STALE/legacy
 * profile record. The company's ACTIVE profile (confirmed live) uses a UUID
 * company id under the plain name "DIC SA":
 *   ee30c164-1431-42ab-af87-d45a5dc3579f
 * (https://www.jobup.ch/fr/societes/ee30c164-1431-42ab-af87-d45a5dc3579f-dic-sa/,
 * redirects/mirrors from legacy jobup numeric id 25347). Confirmed live via
 * `job-search-api.jobs.ch/search?companyIds=ee30c164-...` → totalHits: 1,
 * job "Ingenieur civil EPF - Chef de projet (H/F)", Aigle VD, published
 * 2026-06-29. Use the UUID id, not the numeric jobs.ch id.
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

export const DIC_SA_KEY = 'dic-sa';
export const DIC_SA_COMPANY_NAME = 'DIC SA';
export const DIC_SA_COMPANY_DOMAIN = 'dic-ing.ch';

const COMPANY_IDS = ['ee30c164-1431-42ab-af87-d45a5dc3579f'];
const CAREER_URL = 'https://www.jobup.ch/fr/societes/ee30c164-1431-42ab-af87-d45a5dc3579f-dic-sa/';

/* HQ fallback: Les Glariers, 1860 Aigle (jobs.ch/jobup.ch listing address). */
const HQ = {
  city: 'Aigle',
  canton: 'VD',
  postalCode: '1860',
  streetAddress: 'Les Glariers',
};

const SECTOR = 'Ingegneria Civile / Costruzioni';

/* Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isDicSaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-');
  if (key.includes('dic-sa')) return true;

  const company = normalize(job?.company || '');
  if (/\bdic sa\b/.test(company)) return true;

  const url = normalize(job?.url || '');
  if (/dic-ing\.ch/.test(url)) return true;

  return false;
}

export function isTrustedDomain(url = '') {
  try {
    const { hostname } = new URL(url);
    const host = hostname.toLowerCase();
    return (
      host === DIC_SA_COMPANY_DOMAIN ||
      host.endsWith(`.${DIC_SA_COMPANY_DOMAIN}`) ||
      host === 'www.jobs.ch' ||
      host === 'jobs.ch' ||
      host === 'www.jobup.ch' ||
      host === 'jobup.ch'
    );
  } catch {
    return false;
  }
}

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingenieur|ingénieur|ingegnere|engineer)/.test(t)) return 'Ingegneria';
  if (/\b(dessinateur|dessinatrice|disegnatore|technical draw|drafts)/.test(t)) return 'Disegno Tecnico';
  if (/\b(chef de projet|projektleiter|project manager|capo progetto)/.test(t)) return 'Project Management';
  if (/\b(apprenti|lehrling|apprendist|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair)/.test(t)) return 'Formazione';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Map jobs.ch's free-text `employmentType` (JSON-LD) + posting workload
 * grades to the schema.org employmentType enum consumed downstream.
 * Confirmed live values (shared jobs.ch behaviour, see equans-job-parser.mjs):
 * "Permanent position", "Internship", "Temporary", "Supplementary income".
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
 * Fetch all DIC SA jobs. Returns an array of ParsedJob objects (source-locale
 * only — other locales are filled by the AI localization step and
 * translate-pending pipeline).
 */
export async function fetchAllDicSaJobs() {
  console.log(`🔍 Fetching ${DIC_SA_COMPANY_NAME} jobs`);
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

    // Detail page locale MUST be 'en' — confirmed live (curl) that jobs.ch
    // 404s on /fr/ and /de/ vacancy detail URLs for this company's posting
    // (only /en/ resolves 200); content is served in the posting's original
    // language regardless of the URL locale prefix (see jobs-ch-search-common.mjs
    // header comment). Every sibling jobs.ch/jobup.ch parser (equans,
    // city-pop, cham-swiss-properties) already uses 'en' here — this file was
    // the sole outlier passing 'fr' (matching defaultSourceLang instead of
    // the URL-prefix quirk), which made fetchJobsChJobPostingLd 404 on every
    // run, leaving `ld` null and the job falling back to the thin
    // title+company template below — the root cause of the empty by-crawler
    // slice despite a genuine, live posting.
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
    const description = descriptionText || `${title} presso ${DIC_SA_COMPANY_NAME} a ${place || HQ.city}.`;
    const sourceLang = detectLang(descriptionText || title, 'fr');

    const urlHash = createHash('sha1').update(listing.id).digest('hex').slice(0, 12);

    // Disambiguate in-run title+location collisions with a short id suffix
    // so multiple postings keep a stable, unique slug instead of colliding.
    let jobSlug = slugify(`${title} dic sa ${place || HQ.city}`);
    if (seenSlugs.has(jobSlug)) {
      jobSlug = slugify(`${title} dic sa ${place || HQ.city} ${urlHash.slice(0, 6)}`);
    }
    seenSlugs.add(jobSlug);

    const employmentType = resolveEmploymentType(ld?.employmentType || '', listing.employmentGrades);
    const postedDate = (listing.publicationDate && String(listing.publicationDate).slice(0, 10))
      || (listing.initialPublicationDate && String(listing.initialPublicationDate).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const hiringOrganizationName = ld?.hiringOrganization?.name || listing.company?.name || DIC_SA_COMPANY_NAME;

    const job = {
      // ── Required fields ──
      id: `${DIC_SA_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: DIC_SA_COMPANY_NAME,
      companyKey: DIC_SA_KEY,
      companyDomain: DIC_SA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: place || HQ.city,
      canton,
      url: detailUrl,
      source: 'DIC SA Dedicated Parser (jobs.ch)',
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

  console.log(`\n📋 Total ${DIC_SA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
