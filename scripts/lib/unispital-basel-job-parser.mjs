#!/usr/bin/env node
/**
 * Universitätsspital Basel (USB) job parser — Prospective.ch API.
 *
 * Public career site: https://job.unispital-basel.ch/
 *   - SPA shell hydrating from Prospective tenant 1005524
 *     (`https://ohws.prospective.ch/careercenter/1005524/...`).
 * API: https://ohws.prospective.ch/public/v1/medium/1005524/jobs?lang=de&offset=0&limit=100
 *   Same JSON shape as KSGR / USZ / Agroscope:
 *     { medium_id, total, jobs: [{ id, hk_id, viewkey, title, attributes, szas, links }] }
 *   Per-job description ships in `szas.sza_introduction`, `szas.sza_tasks`,
 *   `szas.sza_requirements`, `szas.sza_benefits` (HTML chunks).
 *   `links.directlink` is the public job URL on `job.unispital-basel.ch`.
 *
 * Exports:
 *   - fetchAllUnispitalBaselJobs()  — Fetch + parse all jobs across pages
 *   - isUnispitalBaselJob()         — Match jobs belonging to USB
 *   - isTrustedDomain()             — Validate URLs (USB / Prospective tenant)
 *   - UNISPITAL_BASEL_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const UNISPITAL_BASEL_KEY = 'unispital-basel';
export const UNISPITAL_BASEL_COMPANY_NAME = 'Universitätsspital Basel';
export const UNISPITAL_BASEL_COMPANY_DOMAIN = 'unispital-basel.ch';

const PROSPECTIVE_TENANT = '1005524';
const API_BASE = `https://ohws.prospective.ch/public/v1/medium/${PROSPECTIVE_TENANT}/jobs`;
const API_LANG = 'de';
const PAGE_SIZE = 100;
const CAREER_URL = 'https://job.unispital-basel.ch/';

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

/**
 * Check if a job belongs to Universitätsspital Basel.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isUnispitalBaselJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === UNISPITAL_BASEL_KEY ||
    key === 'usb' ||
    key.startsWith('unispital-basel') ||
    company.includes('universitätsspital basel') ||
    company.includes('universitatsspital basel') ||
    url.includes('unispital-basel.ch') ||
    url.includes('job.unispital-basel.ch') ||
    url.includes(`/${PROSPECTIVE_TENANT}/`)
  );
}

/**
 * Validate that a URL belongs to Universitätsspital Basel.
 * Trusts the public domains and the Prospective career-center tenant.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'unispital-basel.ch' || host.endsWith('.unispital-basel.ch')) return true;
    if (host === 'job.unispital-basel.ch') return true;
    if (host === 'ohws.prospective.ch' && rawUrl.includes(`/${PROSPECTIVE_TENANT}/`)) return true;
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
  }
  return 'Basel';
}

function pickPostalCode(job = {}) {
  const cityRaw = String(job?.szas?.['sza_location.city'] || '').trim();
  const m = cityRaw.match(/\b(\d{4})\s+/);
  return m ? m[1] : '4031';
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

/**
 * Fetch all Universitätsspital Basel jobs.
 * Returns an array of ParsedJob objects (source-locale = de).
 */
export async function fetchAllUnispitalBaselJobs() {
  console.log(`🔍 Fetching ${UNISPITAL_BASEL_COMPANY_NAME} jobs`);
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
    const canton = inferSwissTargetCanton(location) || 'BS';
    const descriptionText = buildDescription(listing);

    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} ${UNISPITAL_BASEL_KEY} ch`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const postedDate = (() => {
      const raw = listing?.start_date || listing?.last_modification_timestamp || '';
      const d = new Date(String(raw || ''));
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      return new Date().toISOString().slice(0, 10);
    })();

    const job = {
      id: `${UNISPITAL_BASEL_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: UNISPITAL_BASEL_COMPANY_NAME,
      companyKey: UNISPITAL_BASEL_KEY,
      companyDomain: UNISPITAL_BASEL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || `${title} — ${UNISPITAL_BASEL_COMPANY_NAME}`,
      descriptionByLocale: { [sourceLang]: descriptionText || `${title} — ${UNISPITAL_BASEL_COMPANY_NAME}` },
      location,
      canton,
      url: publicUrl,
      source: 'USB Dedicated Parser (Prospective API)',
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

  console.log(`\n📋 Total ${UNISPITAL_BASEL_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
