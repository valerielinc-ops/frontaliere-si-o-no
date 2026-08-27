#!/usr/bin/env node
/**
 * DIC SA (ingénieurs) job parser — own WordPress REST API (job-offers CPT).
 *
 * Public listing: https://www.dic-ing.ch/team/ ("Nos offres" grid)
 * Structured source: https://www.dic-ing.ch/wp-json/wp/v2/job-offers
 *   (public, unauthenticated WordPress REST API for the site's own
 *   "job-offers" custom post type — confirmed live 2026-08-25, returns
 *   clean JSON with rendered title/content/link, no scraping needed)
 *
 * @outsourced-ats-confirmed: this is the migration promised by the
 * @outsourced-ats-needs-migration tag this file previously carried.
 * dic-ing.ch's own "Rejoignez-nous" section on /team/ links directly to a
 * job-offers detail page ON dic-ing.ch itself (confirmed live 2026-08-25:
 * https://www.dic-ing.ch/team/job-offers/un%c2%b7e-ingenieur%c2%b7e-civil%c2%b7e-epf-chef%c2%b7fe-de-projet-3/,
 * matching the same posting jobup.ch carried) — this parser used to source
 * from jobup.ch instead of the employer's own, richer, always-authoritative
 * WordPress source. Applications go to job@dic-ing.ch per the detail page,
 * confirming dic-ing.ch (not jobup.ch) is the real, intended destination.
 *
 * DIC SA ingénieurs is a small civil-engineering consultancy ("bureau
 * d'ingénieur-conseil") headquartered in Aigle (VD), with branch offices in
 * Sion and Martigny (VS). Founded 1982, incorporated as SA in 1991
 * (CHE-105.986.545), ISO 9001 certified since 1998. Confirmed GENUINE DIRECT
 * EMPLOYER, not a staffing/placement agency — own postings use first-person
 * "notre équipe à taille humaine" language, never third-party-placement
 * phrasing, and applications go directly to the firm's own email.
 *
 * HQ fallback: Les Glariers, 1860 Aigle (unaffected by the source migration).
 *
 * Exports the 3 functions used by the crawler template:
 *   - fetchAllDicSaJobs()  — Fetch and parse all open job-offers posts
 *   - isDicSaJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()    — Validate URLs belong to this company
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, fetchJson } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';
import { detectEmploymentTypeFromOccupation } from './jobup-ch-feed-common.mjs';
import { decodeEntities } from './hospital-custom-html-helpers.mjs';

/* Constants ─────────────────────────────────────────────── */

export const DIC_SA_KEY = 'dic-sa';
export const DIC_SA_COMPANY_NAME = 'DIC SA';
export const DIC_SA_COMPANY_DOMAIN = 'dic-ing.ch';

const WP_API_URL = 'https://www.dic-ing.ch/wp-json/wp/v2/job-offers?per_page=100';
const PUBLIC_CAREER_URL = 'https://www.dic-ing.ch/team/';

/* HQ fallback: Les Glariers, 1860 Aigle. */
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
    return host === DIC_SA_COMPANY_DOMAIN || host.endsWith(`.${DIC_SA_COMPANY_DOMAIN}`);
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
 * DIC SA's own job-offers posts open with a "City | XX–YY% | <start date>"
 * header line (confirmed live 2026-08-25: "Aigle | 80–100% | Entrée en
 * fonction : de suite ou à convenir") — there is no separate structured
 * location/workload field on this WordPress CPT, unlike jobup.ch's JSON-LD.
 */
function parseHeaderLine(text = '') {
  const firstLine = normalizeSpace(text.split('\n')[0] || '');
  const parts = firstLine.split('|').map((s) => s.trim()).filter(Boolean);
  const city = parts[0] || '';
  const pctSource = parts[1] || firstLine;
  const pctMatch = pctSource.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || pctSource.match(/(\d{2,3})\s*%/);
  const min = pctMatch ? Number(pctMatch[1]) : 100;
  const max = pctMatch && pctMatch[2] ? Number(pctMatch[2]) : min;
  return { city, min, max };
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

/**
 * Fetch all open DIC SA job-offers posts from the firm's own WordPress REST
 * API. Returns an array of ParsedJob objects (source-locale only — other
 * locales are filled by the AI localization step and translate-pending
 * pipeline).
 */
export async function fetchAllDicSaJobs() {
  console.log(`🔍 Fetching ${DIC_SA_COMPANY_NAME} jobs`);
  console.log(`   Source: ${WP_API_URL}`);
  console.log(`   Public: ${PUBLIC_CAREER_URL}\n`);

  let posts;
  try {
    posts = await fetchJson(WP_API_URL, { label: 'dic-ing.ch WordPress REST API' });
  } catch (err) {
    console.warn(`⚠️ Failed to fetch job-offers: ${err?.message || err}`);
    return [];
  }
  if (!Array.isArray(posts) || posts.length === 0) {
    console.warn('⚠️ No job-offers posts returned.');
    return [];
  }

  console.log(`  📋 Posts found: ${posts.length}`);

  const jobs = [];
  const seenSlugs = new Set();

  for (const post of posts) {
    const title = normalizeSpace(decodeEntities(post?.title?.rendered || ''));
    if (!title || title.length < 3) continue;

    const contentText = stripHtml(decodeEntities(post?.content?.rendered || ''));
    const { city: headerCity, min, max } = parseHeaderLine(contentText);
    const city = headerCity || HQ.city;
    const canton = inferAnyCanton(city) || HQ.canton;

    const description = contentText || `${title} presso ${DIC_SA_COMPANY_NAME} a ${city}.`;
    const sourceLang = detectLang(description || title, 'fr');

    const url = String(post?.link || '');
    const urlHash = createHash('sha1').update(String(post?.id ?? url)).digest('hex').slice(0, 12);

    let jobSlug = slugify(`${title} dic sa ${city}`);
    if (seenSlugs.has(jobSlug)) {
      jobSlug = slugify(`${title} dic sa ${city} ${urlHash.slice(0, 6)}`);
    }
    seenSlugs.add(jobSlug);

    const employmentType = detectEmploymentTypeFromOccupation(min, max) === 'PART_TIME' ? 'PART_TIME' : 'FULL_TIME';
    const postedDate = String(post?.date || '').slice(0, 10) || new Date().toISOString().split('T')[0];

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
      location: city,
      canton,
      url,
      source: `${DIC_SA_COMPANY_NAME} Dedicated Parser (dic-ing.ch)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      addressRegion: canton,
      streetAddress: canton === HQ.canton && city === HQ.city ? HQ.streetAddress : '',
      postalCode: canton === HQ.canton && city === HQ.city ? HQ.postalCode : '',
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
      applyUrl: url,
      hiringOrganizationName: DIC_SA_COMPANY_NAME,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${DIC_SA_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
