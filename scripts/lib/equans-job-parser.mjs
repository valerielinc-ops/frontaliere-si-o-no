#!/usr/bin/env node
/**
 * Equans Switzerland job parser — jobs.ch public search API + JSON-LD detail.
 *
 * Source: https://www.jobs.ch/en/companies/20439-equans-switzerland-ag/
 * (public company profile page; the jobs.ch API discovery below is what
 * actually feeds this parser — see ./jobs-ch-search-common.mjs)
 *
 * Equans Switzerland is the Swiss arm of Equans (Bouygues group), a
 * facility-management / technical-services group (HVAC, electrical,
 * maintenance, energy) with ~6500 own staff in Switzerland. Confirmed
 * GENUINE DIRECT EMPLOYER, not a staffing/placement agency:
 *   - equans.ch's own careers page frames jobs.ch/jobup.ch postings as
 *     Equans's OWN openings, not third-party client mandates.
 *   - 87/91 (95.6%) live postings are "Permanent position" contracts
 *     (jobs.ch employmentType free text); the remainder is an ordinary
 *     internship / holiday-cover / hourly-role mix, not a
 *     TEMPORARY-dominated staffing profile.
 *   - Description text throughout uses first-person "our team" / "we
 *     operate" / "our company is part of the Equans Group" language
 *     (DE/FR/IT), never third-party-placement phrasing.
 *   - `hiringOrganization.name` in JSON-LD varies only across legitimate
 *     Equans-group subsidiaries (Equans Switzerland AG, Equans Switzerland
 *     Facility Management AG, Caliqua AG — an HVAC company acquired by
 *     Equans), never an unrelated third-party client name.
 *
 * jobs.ch company profile id: 20439 (all postings — Equans Switzerland,
 * Equans Switzerland AG, Equans Switzerland Facility Management AG and
 * Caliqua AG subsidiaries — share this single profile id; confirmed live
 * that no second id is needed: totalHits(20439)===totalHits(20439+other)).
 *
 * Postings span 14+ cantons (multi-cantone group, not single-site).
 *
 * HQ fallback address (confirmed via jobs.ch company profile JSON-LD):
 * Förrlibuckstrasse 150, 8005 Zürich, ZH.
 *
 * Exports the 4 functions used by the crawler template:
 *   - fetchAllEquansJobs()  — Fetch and parse all Swiss jobs
 *   - isEquansJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()     — Validate URLs belong to this company
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

/* ── Constants ─────────────────────────────────────────────── */

export const EQUANS_KEY = 'equans';
export const EQUANS_COMPANY_NAME = 'Equans Switzerland';
export const EQUANS_COMPANY_DOMAIN = 'equans.ch';

const COMPANY_IDS = ['20439'];
const CAREER_URL = 'https://www.jobs.ch/en/companies/20439-equans-switzerland-ag/';

/* HQ fallback: Förrlibuckstrasse 150, 8005 Zürich (jobs.ch company profile). */
const HQ = {
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8005',
  streetAddress: 'Förrlibuckstrasse 150',
};

const SECTOR = 'Facility Management / Impiantistica';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isEquansJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === EQUANS_KEY ||
    key.startsWith('equans') ||
    company.includes('equans') ||
    url.includes('equans.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'equans.ch' || host.endsWith('.equans.ch')) return true;
    if (host === 'jobs.ch' || host.endsWith('.jobs.ch')) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(ingegner|engineer|entwickl|ingénieur)/.test(t)) return 'Ingegneria';
  if (/\b(elektr|electric|électric)/.test(t)) return 'Elettrotecnica';
  if (/\b(lüft|hvac|climat|riscald|heizung|sanitär|sanitaire)/.test(t)) return 'Impiantistica';
  if (/\b(techni|tecnic|mecanic|meccatron|mechatron|monteur|installat|instandhalt|wartung|manuten|entretien|maintenance)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account|assistant)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|acquisiz)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(reinigung|pulizi|nettoy|conciergerie)/.test(t)) return 'Facility Management';
  if (/\b(sicherheit|sécurité|sicurezza|security)/.test(t)) return 'Sicurezza';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it|software|develop|programm|cad|cae)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|ressources)/.test(t)) return 'Risorse Umane';
  if (/\b(chef de projet|projektleiter|project manager|capo progetto)/.test(t)) return 'Project Management';
  return 'Altro';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Map jobs.ch's free-text `employmentType` (JSON-LD) + posting workload
 * grades to the schema.org employmentType enum consumed downstream.
 * Confirmed live values: "Permanent position", "Internship", "Temporary",
 * "Supplementary income" (hourly on-call role).
 */
function resolveEmploymentType(ldEmploymentType = '', grades = []) {
  const t = normalize(ldEmploymentType);
  if (/intern/.test(t)) return 'INTERN';
  if (/temporary|fixed.term|contract/.test(t)) return 'TEMPORARY';
  if (/supplementary/.test(t)) return 'PER_DIEM';
  const nums = (Array.isArray(grades) ? grades : []).map(Number).filter(Number.isFinite);
  const min = nums.length ? Math.min(...nums) : 0;
  const max = nums.length ? Math.max(...nums) : 100;
  return detectEmploymentTypeFromOccupation(min, max) === 'PART_TIME' ? 'PART_TIME' : 'FULL_TIME';
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all Equans Switzerland jobs. Returns an array of ParsedJob objects
 * (source-locale only — other locales are filled by the AI localization
 * step and translate-pending pipeline).
 */
export async function fetchAllEquansJobs() {
  console.log(`🔍 Fetching ${EQUANS_COMPANY_NAME} jobs`);
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
    const description = descriptionText || `${title} presso ${EQUANS_COMPANY_NAME} a ${place || HQ.city}.`;
    const sourceLang = detectLang(descriptionText || title, 'de');

    const urlHash = createHash('sha1').update(listing.id).digest('hex').slice(0, 12);

    // Two distinct postings can legitimately share title+location (e.g.
    // Equans opening 2 identical headcount slots at the same site) —
    // disambiguate in-run collisions with a short id suffix so both jobs
    // keep a stable, unique slug instead of silently colliding.
    let jobSlug = slugify(`${title} equans ${place || HQ.city}`);
    if (seenSlugs.has(jobSlug)) {
      jobSlug = slugify(`${title} equans ${place || HQ.city} ${urlHash.slice(0, 6)}`);
    }
    seenSlugs.add(jobSlug);

    const employmentType = resolveEmploymentType(ld?.employmentType || '', listing.employmentGrades);
    const postedDate = (listing.publicationDate && String(listing.publicationDate).slice(0, 10))
      || (listing.initialPublicationDate && String(listing.initialPublicationDate).slice(0, 10))
      || new Date().toISOString().split('T')[0];

    const hiringOrganizationName = ld?.hiringOrganization?.name || listing.company?.name || EQUANS_COMPANY_NAME;

    const job = {
      // ── Required fields ──
      id: `${EQUANS_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: EQUANS_COMPANY_NAME,
      companyKey: EQUANS_KEY,
      companyDomain: EQUANS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location: place || HQ.city,
      canton,
      url: detailUrl,
      source: 'Equans Switzerland Dedicated Parser (jobs.ch)',
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

  console.log(`\n📋 Total ${EQUANS_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
