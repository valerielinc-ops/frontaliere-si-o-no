#!/usr/bin/env node
/**
 * Spital Uster job parser — Prospective.ch API.
 *
 * Public career site: https://www.spitaluster.ch/Karriere-und-Jobs/Offene-Stellen.41.html
 *   - The page embeds an iframe to https://jobs.spitaluster.ch/ which is the
 *     Prospective career-center SPA (`/careercenter/1000910/...`).
 * API: https://ohws.prospective.ch/public/v1/medium/1000910/jobs?lang=de&offset=0&limit=100
 *   Same JSON shape as USZ / KSGR / Agroscope / Jumbo:
 *     { medium_id, total, jobs: [{ id, hk_id, viewkey, title, attributes, szas, links }] }
 *
 * Detail page: `links.directlink` returns an HTTPS URL on `jobs.spitaluster.ch/...`
 * that hydrates client-side. We don't fetch detail pages (the API ships
 * the full description in `szas.*`).
 *
 * Spital Uster HQ: Brunnenstrasse 42, 8610 Uster, ZH.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSpitalUsterJobs() — Fetch and parse all jobs across pages
 *   - isSpitalUsterJob()        — Match jobs belonging to Spital Uster
 *   - isTrustedDomain()         — Validate URLs belong to Spital Uster / Prospective tenant
 *   - SPITAL_USTER_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SPITAL_USTER_KEY = 'spital-uster';
export const SPITAL_USTER_COMPANY_NAME = 'Spital Uster';
export const SPITAL_USTER_COMPANY_DOMAIN = 'spitaluster.ch';

const PROSPECTIVE_TENANT = '1000910';
const API_BASE = `https://ohws.prospective.ch/public/v1/medium/${PROSPECTIVE_TENANT}/jobs`;
const API_LANG = 'de';
const PAGE_SIZE = 100;
const CAREER_URL = 'https://jobs.spitaluster.ch/?lang=de';

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

export function isSpitalUsterJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SPITAL_USTER_KEY ||
    key.startsWith('spital-uster') ||
    company.includes('spital uster') ||
    url.includes('spitaluster.ch') ||
    url.includes('jobs.spitaluster.ch') ||
    url.includes(`/${PROSPECTIVE_TENANT}/`)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'spitaluster.ch' || host.endsWith('.spitaluster.ch')) return true;
    if (host === 'jobs.spitaluster.ch') return true;
    if (host === 'ohws.prospective.ch' && rawUrl.includes(`/${PROSPECTIVE_TENANT}/`)) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics ─────────── */

function detectCategory(title = '', department = '') {
  const t = normalize(title);
  const d = normalize(department);
  const signal = `${t} ${d}`;

  if (/\b(pflege|pflegefach|stationsleitung|fage|fachperson gesundheit|spitex|hebamme|nachtwache)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|chirurg|anästhes|notfall|onkolog|kardiolog|neurolog)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(ops|operation|lagerung)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(apothek|pharma)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(radiolog|röntgen|mtra|mrt)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(physiother|ergo|logopäd|rehabilit)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance)/.test(signal)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(signal)) return 'IT';
  if (/\b(admin|segret|buchhalt|sachbearbeiter|account|finanz|controll)/.test(signal)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(signal)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie|haus.?dienst)/.test(signal)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(signal)) return 'Logistica';
  if (/\b(market|kommunik)/.test(signal)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|doktorand)/.test(signal)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|doktorand|phd)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitend|stationsleitung|oberarzt|chefarzt|executive)/.test(t)) return 'senior';
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
  // Spital Uster ships a single campus — keep the city stable but accept
  // any explicit `sza_location.city` override (e.g. "8610 Uster").
  const szas = job?.szas || {};
  const cityRaw = String(szas['sza_location.city'] || '').trim();
  if (cityRaw) {
    const m = cityRaw.match(/\b(\d{4})\s+([^\n,]+)/);
    if (m) return normalizeSpace(m[2]);
  }
  return 'Uster';
}

function pickPostalCode(job = {}) {
  const cityRaw = String(job?.szas?.['sza_location.city'] || '').trim();
  const m = cityRaw.match(/\b(\d{4})\s+/);
  return m ? m[1] : '8610';
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
  const attrPensum = (job?.attributes?.['30'] || []).join(' ').toLowerCase();
  if (/teilzeit|part/i.test(attrPensum)) return 'PART_TIME';
  if (/vollzeit|full/i.test(attrPensum)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Main Fetch Function ──────────────────────────────────── */

export async function fetchAllSpitalUsterJobs() {
  console.log(`🏥 Fetching ${SPITAL_USTER_COMPANY_NAME} jobs`);
  console.log(`   Source: ${API_BASE} (Prospective tenant ${PROSPECTIVE_TENANT})\n`);

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
    const canton = inferSwissTargetCanton(location) || 'ZH';
    const descriptionText = buildDescription(listing);
    const department = Array.isArray(listing?.attributes?.['20']) ? listing.attributes['20'][0] : '';

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} ${SPITAL_USTER_KEY} ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const postedDate = (() => {
      const raw = listing?.start_date || listing?.last_modification_timestamp || '';
      const d = new Date(String(raw || ''));
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      return new Date().toISOString().slice(0, 10);
    })();

    const job = {
      id: `${SPITAL_USTER_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SPITAL_USTER_COMPANY_NAME,
      companyKey: SPITAL_USTER_KEY,
      companyDomain: SPITAL_USTER_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — ${SPITAL_USTER_COMPANY_NAME}`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — ${SPITAL_USTER_COMPANY_NAME}` },
      location,
      canton,
      url: publicUrl,
      source: `${SPITAL_USTER_COMPANY_NAME} Dedicated Parser (Prospective tenant ${PROSPECTIVE_TENANT})`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: pickPostalCode(listing),
      category: detectCategory(title, department),
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

    if (department) {
      job.department = normalizeSpace(department);
    }

    jobs.push(job);
  }

  console.log(`\n📋 Total ${SPITAL_USTER_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
