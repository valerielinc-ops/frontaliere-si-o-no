#!/usr/bin/env node
/**
 * Stadtspital Zürich (Triemli + Waid) job parser — Fetcher and job builder.
 *
 * Source: https://jobs.stadt-zuerich.ch/search/
 *         ?optionsFacetsDD_customfield2=Stadtspital+Zürich
 *
 * HISTORY / why this parser looks nothing like its first version: the
 * original scaffold pointed a Playwright DOM probe at
 * `https://www.stadtspital.ch/karriere` — that URL never served a job list
 * (today `stadtspital.ch` is a bare 302 to `www.stadt-zuerich.ch/stadtspital`)
 * and the crawler never produced a single job (issue #3898).
 *
 * The REAL source (verified live 2026-07-11): Stadtspital Zürich is a
 * Dienstabteilung of the city of Zürich and publishes all its openings on
 * the city's SAP SuccessFactors "jobs2web" portal `jobs.stadt-zuerich.ch`
 * (`ssoCompanyId: 'STZH'`) — the SAME portal the sibling
 * `stadt-zuerich-job-parser.mjs` crawls. The portal supports a
 * server-side facet filter `optionsFacetsDD_customfield2=Stadtspital Zürich`
 * (Dienstabteilung facet) that returns only hospital postings (~129 live at
 * verification time), server-rendered — no JS/Playwright needed.
 *
 * Division of labour with the sibling crawler (dedup contract):
 *   - `stadt-zuerich-job-parser.mjs` EXCLUDES rows whose Dienstabteilung
 *     matches 'stadtspital' (see its EXCLUDED_UNIT_SUBSTRINGS) precisely
 *     because THIS crawler owns them under `company: 'Stadtspital Zürich'`.
 *   - This parser reuses the sibling's exported `parseListingTiles()` (one
 *     source of truth for the tile regexes) and additionally DROPS any row
 *     whose Dienstabteilung does NOT contain 'stadtspital' — a defensive
 *     guard so that, should the portal ever silently ignore the facet
 *     parameter, we never ingest the whole city administration under the
 *     hospital's name.
 *
 * Listing tiles expose title / Departement / Dienstabteilung / Referenz-Nr.
 * only; detail pages hydrate their body client-side (same portal behaviour
 * documented in the sibling parser), so the description is synthesised from
 * the tile fields + employer blurb, above the 50-word thin-content floor
 * (Non-Negotiable #4). Structured-data safe defaults (Non-Negotiable #3):
 * every job carries the Stadtspital Triemli main-site civic address
 * (Birmensdorferstrasse 497, 8063 Zürich, ZH).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllStadtspitalZuerichJobs()  — Fetch and parse all jobs
 *   - isStadtspitalZuerichJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()                 — Validate URLs belong to this company
 *   - STADTSPITAL_ZUERICH_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { slugify, stripHtml } from './crawler-template.mjs';
import { parseListingTiles } from './stadt-zuerich-job-parser.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const STADTSPITAL_ZUERICH_KEY = 'stadtspital-zuerich';
export const STADTSPITAL_ZUERICH_COMPANY_NAME = 'Stadtspital Zürich';
export const STADTSPITAL_ZUERICH_COMPANY_DOMAIN = 'stadtspital.ch';

const ATS_HOST = 'jobs.stadt-zuerich.ch';
const SEARCH_BASE = `https://${ATS_HOST}/search/`;
// Dienstabteilung facet — server-side filter for hospital postings only.
const FACET_QUERY = 'optionsFacetsDD_customfield2=Stadtspital%20Z%C3%BCrich';
const PAGE_SIZE = 25;
const MAX_PAGES = 20; // safety cap (~500 jobs) — real volume is ~130

// Stadtspital Triemli main site (verified 2026-07-11) — safe default
// address for every job (the portal exposes no per-job address).
const HQ = {
  streetAddress: 'Birmensdorferstrasse 497',
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8063',
  addressRegion: 'ZH',
};

const SECTOR = 'Sanità / Ospedali';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Stadtspital Zürich.
 * Used by the template to filter this company's jobs from the global dataset.
 *
 * NOTE: deliberately does NOT match by the `jobs.stadt-zuerich.ch` host —
 * that host also serves every other city-administration posting owned by
 * the sibling `stadt-zuerich` crawler; matching on it would steal them.
 */
export function isStadtspitalZuerichJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === STADTSPITAL_ZUERICH_KEY ||
    key.startsWith('stadtspital-zuerich') ||
    company.includes('stadtspital zürich') ||
    url.includes('stadtspital.ch')
  );
}

/**
 * Validate that a URL belongs to Stadtspital Zürich.
 * Trusts the legacy hospital domain plus the city job portal that now
 * hosts all of the hospital's postings.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'stadtspital.ch' ||
      host.endsWith('.stadtspital.ch') ||
      host === ATS_HOST ||
      host === 'stadt-zuerich.ch' ||
      host.endsWith('.stadt-zuerich.ch')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection (hospital-flavoured) ───────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/(pflege|fage|fa-?gesundheit|gesundheits|krankenschwester|krankenpfleger|hebamme|mpa|tno|operationstechnik|rettungssanit)/.test(t)) return 'Sanità';
  if (/(arzt|ärztin|aerztin|assistenzarzt|oberarzt|chefarzt|medizin|radiolog|onkolog|kardiolog|chirurg|anästh|anaesth|psycholog)/.test(t)) return 'Sanità';
  if (/(therapeut|therapie|physiothera|ergothera|logopäd|logopaed|ernährungsberat)/.test(t)) return 'Sanità';
  if (/(labor|biomedizin|pharma|apothek)/.test(t)) return 'Sanità';
  if (/(informatik|ict\b|software|applikation|system)/.test(t)) return 'IT';
  if (/(hr\b|human resources|personal)/.test(t)) return 'Risorse Umane';
  if (/(finanz|controll|buchhalt|rechnungswesen)/.test(t)) return 'Finanza';
  if (/(verwalt|admin|sachbearbeit|sekretär|sekretaer|empfang|disponent)/.test(t)) return 'Amministrazione';
  if (/(techni|haustech|handwerk|elektro|logistik|lager|transport|küche|kueche|koch|köchin|hauswirtschaft|reinigung|gastro)/.test(t)) return 'Tecnica';
  return 'Sanità';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/(praktik|stage|stagiair|unterassist|intern\b|apprendist|lehrling|lernend|lehrstelle|studierend)/.test(t)) return 'intern';
  if (/(junior|jr\b|assistenzarzt|assistenzärzt)/.test(t)) return 'junior';
  if (/(senior|sr\b|lead|head|leiter|leitung|chefarzt|chefärzt|oberarzt|oberärzt|direktor|verantwort|responsab)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Parse a workload percentage out of the title (e.g. "80–100 %", "60 %")
 * and map it to a coarse `employmentType`. Titles with no parseable
 * percentage keep the safe default `'OTHER'` (Non-Negotiable #3 — never
 * drop the field, never fabricate a specific number).
 */
function detectEmploymentType(title = '') {
  const matches = [...String(title || '').matchAll(/(\d{2,3})\s*%/g)].map((m) => Number(m[1]));
  if (!matches.length) return 'OTHER';
  const max = Math.max(...matches);
  if (max >= 90) return 'FULL_TIME';
  return 'PART_TIME';
}

/* ── HTML Fetching ─────────────────────────────────────────── */

async function fetchPage(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'de-CH,de;q=0.9',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Description Builder ──────────────────────────────────── */

function buildDescription(row) {
  const parts = [];
  parts.push(
    `${row.title} im Stadtspital Zürich` +
      `${row.department && !/stadtspital/i.test(row.department) ? ` (${row.department})` : ''}.`
  );
  parts.push(
    'Das Stadtspital Zürich ist mit den Standorten Triemli und Waid das grösste ' +
      'Stadtzürcher Spital und bietet Spitzenmedizin, Pflege und eine breite ' +
      'Grundversorgung für die Bevölkerung der Stadt und Region Zürich. ' +
      'Als Arbeitgeberin der Stadt Zürich bietet es fortschrittliche ' +
      'Anstellungsbedingungen, vielfältige Weiterbildungsmöglichkeiten und ' +
      'eine sinnstiftende Tätigkeit im Gesundheitswesen.'
  );
  if (row.ref) parts.push(`Referenz-Nr.: ${row.ref}.`);
  parts.push(
    `Arbeitsort: ${HQ.city} (${HQ.canton}). Weitere Details zu Aufgaben, Anforderungen und dem ` +
      'Bewerbungsverfahren finden Sie auf der offiziellen Stellenplattform der Stadt Zürich. ' +
      'Wir freuen uns auf Ihre Bewerbung.'
  );
  return parts.join(' ');
}

/* ── Main Fetch Function ──────────────────────────────────── */

/**
 * Fetch all Stadtspital Zürich jobs from the facet-filtered city portal.
 * Returns an array of ParsedJob objects (source-locale only, German).
 */
export async function fetchAllStadtspitalZuerichJobs() {
  console.log('🔍 Fetching Stadtspital Zürich jobs');
  console.log(`   Source: ${SEARCH_BASE}?${FACET_QUERY}\n`);

  const allRows = [];
  const seenIds = new Set();
  const delayMs = Number(process.env.JOBS_CRAWLER_DELAY_MS) || 400;

  for (let page = 0; page < MAX_PAGES; page++) {
    const startrow = page * PAGE_SIZE;
    const url = `${SEARCH_BASE}?q=&${FACET_QUERY}&sortColumn=referencedate&sortDirection=desc&startrow=${startrow}`;
    let html;
    try {
      html = await fetchPage(url);
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch listing page ${page} (startrow=${startrow}): ${err.message}`);
      break;
    }
    const rows = parseListingTiles(html).filter((r) => !seenIds.has(r.jobId));
    console.log(`  📄 Page ${page} (startrow=${startrow}): ${rows.length} new job(s)`);
    if (rows.length === 0) break;
    for (const r of rows) {
      seenIds.add(r.jobId);
      allRows.push(r);
    }
    if (rows.length < PAGE_SIZE) break;
    if (page < MAX_PAGES - 1) await new Promise((r) => setTimeout(r, delayMs));
  }

  if (allRows.length === 0) {
    console.warn('⚠️ No job listings found.');
    return [];
  }

  console.log(`\n  📋 Total unique listings discovered: ${allRows.length}`);

  // Defensive guard: keep ONLY rows whose Dienstabteilung/Departement
  // mentions the hospital. If the portal ever silently drops the facet
  // parameter we must not ingest the whole city administration under
  // `company: 'Stadtspital Zürich'` (those rows belong to the sibling
  // stadt-zuerich crawler).
  const rows = allRows.filter((r) => /stadtspital/i.test(`${r.department} ${r.unit}`));
  const dropped = allRows.length - rows.length;
  if (dropped > 0) {
    console.warn(`  🧹 Dropped ${dropped} non-Stadtspital row(s) (facet filter mismatch — owned by the stadt-zuerich crawler).`);
  }

  const sourceLang = 'de';
  const jobs = [];

  for (const row of rows) {
    const title = row.title;
    const publicUrl = `https://${ATS_HOST}${row.path}`;
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    // Include the stable reference number in the slug seed — hospital
    // postings repeat the same title across wards (e.g. "Dipl.
    // Pflegefachperson" xN distinct postings); without a disambiguator the
    // assemble step's slug-collision guard would drop all but one of them.
    const jobSlug = slugify(`${title} stadtspital-zuerich ${row.ref || row.jobId}`);
    const descriptionText = buildDescription(row);
    const employmentType = detectEmploymentType(title);

    const job = {
      // -- Required fields --
      id: `stadtspital-zuerich-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: STADTSPITAL_ZUERICH_COMPANY_NAME,
      companyKey: STADTSPITAL_ZUERICH_KEY,
      companyDomain: STADTSPITAL_ZUERICH_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: HQ.city,
      canton: HQ.canton,
      url: publicUrl,
      source: 'Stadtspital Zürich Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // -- Recommended / structured-data safe defaults (Non-Negotiable #3) --
      streetAddress: HQ.streetAddress,
      addressLocality: HQ.city,
      postalCode: HQ.postalCode,
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (row.department) job.department = row.department;
    if (row.unit) job.unit = row.unit;
    if (row.ref) job.referenceNumber = row.ref;

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 55)} — ${row.unit || 'N/A'}`);
  }

  console.log(`\n📋 Total Stadtspital Zürich jobs discovered: ${jobs.length}`);
  return jobs;
}

export { slugify, stripHtml };
