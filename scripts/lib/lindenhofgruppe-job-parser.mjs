#!/usr/bin/env node
/**
 * Lindenhofgruppe Bern job parser — Prospective.ch API.
 *
 * Public career site:
 *   - Hub: https://www.lindenhofgruppe.ch/jobs
 *   - The page embeds the Prospective career-center bundle for tenant 1002129
 *     (`https://ohws.prospective.ch/public/v1/careercenter/1002129/`).
 *
 * Listing JSON endpoint (same shape as USZ / Spital STS / KSGR):
 *   https://ohws.prospective.ch/public/v1/medium/1002129/jobs?lang=de&offset=0&limit=100
 *   { medium_id, total, jobs: [{ id, hk_id, viewkey, title, attributes, szas, links }] }
 *
 * The Lindenhofgruppe operates three sites in canton Bern:
 *   - Lindenhofspital (Bern, 3012)
 *   - Engeriedspital (Bern, 3012)
 *   - Sonnenhofspital (Bern, 3006)
 * The campus is signalled in the listing's `szas.sza_location.city` field.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllLindenhofgruppeJobs()  — Fetch and parse all jobs across pages
 *   - isLindenhofgruppeJob()         — Match jobs belonging to Lindenhofgruppe
 *   - isTrustedDomain()              — Validate URLs belong to Lindenhofgruppe
 *   - LINDENHOFGRUPPE_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const LINDENHOFGRUPPE_KEY = 'lindenhofgruppe';
export const LINDENHOFGRUPPE_COMPANY_NAME = 'Lindenhofgruppe';
export const LINDENHOFGRUPPE_COMPANY_DOMAIN = 'lindenhofgruppe.ch';

const PROSPECTIVE_TENANT = '1002129';
const API_BASE = `https://ohws.prospective.ch/public/v1/medium/${PROSPECTIVE_TENANT}/jobs`;
const API_LANG = 'de';
const PAGE_SIZE = 100;
const CAREER_URL = 'https://www.lindenhofgruppe.ch/jobs';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isLindenhofgruppeJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === LINDENHOFGRUPPE_KEY ||
    key.startsWith('lindenhof') ||
    company.includes('lindenhof') ||
    company.includes('engeried') ||
    company.includes('sonnenhof') ||
    url.includes('lindenhofgruppe.ch') ||
    url.includes(`/${PROSPECTIVE_TENANT}/`)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'lindenhofgruppe.ch' || host.endsWith('.lindenhofgruppe.ch')) return true;
    if (host === 'ohws.prospective.ch' && rawUrl.includes(`/${PROSPECTIVE_TENANT}/`)) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(pflege|pflegefach|stationsleitung|fage|spitex|nachtwache|geburts|hebamme)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|chirurg|anästhes|onkolog|kardiolog|neurolog|pädiatr|gynäk)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse|radiolog|röntgen|mtra|physiother|ergo|logopäd|rehabilit|apothek|pharma)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance)/.test(t)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(t)) return 'IT';
  if (/\b(admin|segret|buchhalt|sachbearbeiter|finanz|controll|account)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie)/.test(t)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(t)) return 'Logistica';
  if (/\b(market|kommunik)/.test(t)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti)/.test(t)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|intern|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|chefarzt)/.test(t)) return 'senior';
  return 'mid';
}

/* ── Prospective API Client ────────────────────────────────── */

async function fetchProspectivePage(offset = 0) {
  const url = `${API_BASE}?lang=${API_LANG}&offset=${offset}&limit=${PAGE_SIZE}`;
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchJobListings() {
  const all = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    console.log(`  📄 Fetching offset=${offset} (limit=${PAGE_SIZE})...`);
    const data = await fetchProspectivePage(offset);
    const items = Array.isArray(data?.jobs) ? data.jobs : [];
    if (Number.isFinite(Number(data?.total))) total = Number(data.total);
    if (items.length === 0) break;
    all.push(...items);
    offset += items.length;
    if (items.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, 350));
  }
  console.log(`  ✓ Total Prospective jobs (raw): ${all.length} (API total=${total})`);
  return all;
}

/* ── Prospective record helpers ───────────────────────────── */

function pickLocation(job = {}) {
  const szas = job?.szas || {};
  const cityRaw = String(szas['sza_location.city'] || '').trim();
  if (cityRaw) {
    const m = cityRaw.match(/\b(\d{4})\s+([^\n,]+)/);
    if (m) return normalizeSpace(m[2]);
    return normalizeSpace(cityRaw);
  }
  return 'Bern';
}

function pickPostalCode(job = {}) {
  const cityRaw = String(job?.szas?.['sza_location.city'] || '').trim();
  const m = cityRaw.match(/\b(\d{4})\s+/);
  return m ? m[1] : '3012';
}

function buildDescription(job = {}) {
  const szas = job?.szas || {};
  const parts = [];
  const intro = normalizeSpace(szas.sza_introduction || '');
  if (intro) parts.push(intro);
  const tasks = stripHtml(szas.sza_tasks || '');
  if (tasks) parts.push(`Aufgaben:\n${tasks}`);
  const reqs = stripHtml(szas.sza_requirements || '');
  if (reqs) parts.push(`Anforderungen:\n${reqs}`);
  const benefits = stripHtml(szas.sza_benefits || '');
  if (benefits) parts.push(`Wir bieten:\n${benefits}`);
  return parts.join('\n\n');
}

function pickEmploymentType(job = {}) {
  const min = Number(job?.szas?.['sza_pensum.min'] || 0);
  const max = Number(job?.szas?.['sza_pensum.max'] || 0);
  if (max > 0 && max < 90) return 'PART_TIME';
  if (min >= 90 || max >= 90) return 'FULL_TIME';
  return 'OTHER';
}

/**
 * Fetch all Lindenhofgruppe jobs.
 * Returns an array of ParsedJob objects (source-locale = de).
 */
export async function fetchAllLindenhofgruppeJobs() {
  console.log(`🏥 Fetching ${LINDENHOFGRUPPE_COMPANY_NAME} jobs`);
  console.log(`   Source: ${API_BASE} (Prospective tenant ${PROSPECTIVE_TENANT})`);
  console.log(`   Public: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned from Prospective API.');
    return [];
  }

  const jobs = [];
  for (const listing of listings) {
    const szas = listing?.szas || {};
    const title = normalizeSpace(szas.sza_title || listing.title || '');
    if (!title || title.length < 3) continue;

    const directLink = normalizeSpace(listing?.links?.directlink || '');
    const applyLink = normalizeSpace(szas.sza_apply_link || '');
    const publicUrl = directLink || applyLink || CAREER_URL;
    const location = pickLocation(listing);
    const canton = inferSwissTargetCanton(location) || 'BE';
    const descriptionText = buildDescription(listing);

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} ${LINDENHOFGRUPPE_KEY} ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const postedDate = (() => {
      const raw = listing?.start_date || listing?.last_modification_timestamp || '';
      const d = new Date(String(raw || ''));
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      return new Date().toISOString().slice(0, 10);
    })();

    const job = {
      id: `${LINDENHOFGRUPPE_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: LINDENHOFGRUPPE_COMPANY_NAME,
      companyKey: LINDENHOFGRUPPE_KEY,
      companyDomain: LINDENHOFGRUPPE_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — ${LINDENHOFGRUPPE_COMPANY_NAME}`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — ${LINDENHOFGRUPPE_COMPANY_NAME}` },
      location,
      canton,
      url: publicUrl,
      source: 'Lindenhofgruppe Dedicated Parser (Prospective API)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: pickPostalCode(listing),
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: pickEmploymentType(listing),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: applyLink || publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total ${LINDENHOFGRUPPE_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
