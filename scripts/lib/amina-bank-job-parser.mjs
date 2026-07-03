#!/usr/bin/env node
/**
 * AMINA Bank (Zug) — regulated Swiss crypto bank, Personio ATS.
 *
 * Source:
 *   - Career site: https://amina.jobs.personio.com/
 *   - JSON feed:   https://amina.jobs.personio.com/search.json?language=en
 *   - Detail:      https://amina.jobs.personio.com/job/{id}
 *
 * Re-discovery note: the researched `aminahub.com` domain 404s (unrelated
 * Wix parked page). The real career site is AMINA's Personio tenant at
 * `amina.jobs.personio.com` (found via web search). Personio ships an
 * unauthenticated `/search.json` endpoint that returns the same payload the
 * careers SPA hydrates from — same pattern as the Sune-Egge parser.
 *
 * AMINA posts jobs for both its Swiss HQ (Zug) and its India subsidiary
 * (AMINA India, a wholly-owned back-office/tech extension). Each listing
 * carries an `office` field ("Switzerland" | "India") and an `offices[]`
 * array (can list more than one location). We gate on `isChCountry` against
 * `offices[]` when present (more granular — surfaces a CH entry even if a
 * different value sits in `office`), falling back to the singular `office`
 * field otherwise (shared CH guard, AGENTS.md #6), so India-only postings
 * don't get mis-claimed as Swiss jobs while multi-office CH postings aren't
 * silently dropped.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllAminaBankJobs()  — Fetch and parse all jobs
 *   - isAminaBankJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { isChCountry } from './ch-country-guard.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const AMINA_BANK_KEY = 'amina-bank';
export const AMINA_BANK_COMPANY_NAME = 'AMINA Bank';
export const AMINA_BANK_COMPANY_DOMAIN = 'amina.jobs.personio.com';

const PERSONIO_API_URL = 'https://amina.jobs.personio.com/search.json?language=en';
const CAREER_URL = 'https://amina.jobs.personio.com/';
const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

const DEFAULT_CITY = 'Zug';
const DEFAULT_CANTON = 'ZG';
const DEFAULT_POSTAL = '6300';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to AMINA Bank.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isAminaBankJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === AMINA_BANK_KEY ||
    key.startsWith('amina-bank') ||
    company.includes('amina bank') ||
    url.includes('amina.jobs.personio.com')
  );
}

/**
 * Validate that a URL belongs to AMINA Bank's domain.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'amina.jobs.personio.com' || host.endsWith('.amina.jobs.personio.com');
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

/* ── Fetch + Parse ─────────────────────────────────────────── */

async function fetchJobListings() {
  console.log(`   Fetching from: ${PERSONIO_API_URL}`);

  const res = await fetch(PERSONIO_API_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Personio search.json`);

  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Unexpected Personio search.json shape (not an array)');
  return data;
}

/**
 * Fetch all AMINA Bank jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllAminaBankJobs() {
  console.log(`🔍 Fetching AMINA Bank jobs`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned.');
    return [];
  }

  console.log(`  📋 Listings found (all offices): ${listings.length}`);

  const jobs = [];
  for (const rec of listings) {
    const officesList = Array.isArray(rec.offices) && rec.offices.length
      ? rec.offices
      : [rec.office];
    const isCh = officesList.some((o) => isChCountry(o));
    if (!isCh) continue; // skip AMINA India (and any other non-CH office)

    const title = normalizeSpace(rec.name || '');
    if (!title || title.length < 3) continue;

    const descriptionHtml = rec.description || '';
    const descriptionText = stripHtml(descriptionHtml);
    const publicUrl = `${CAREER_URL}job/${rec.id}`;

    const sourceLang = detectLang(descriptionText || title, 'en');
    const jobSlug = slugify(`${title} amina bank zug`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const fallbackDesc =
      `${title} — posizione presso AMINA Bank a ${DEFAULT_CITY} (${DEFAULT_CANTON}), Svizzera. ` +
      'AMINA Bank è una banca svizzera regolamentata FINMA, pioniera nei servizi finanziari digitali e crypto.';
    const desc = descriptionText.length >= 80 ? descriptionText : fallbackDesc;

    const employmentBasis = `${title} ${rec.schedule || ''} ${rec.employment_type || ''}`;

    const job = {
      // ── Required fields ──
      id: `amina-bank-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: AMINA_BANK_COMPANY_NAME,
      companyKey: AMINA_BANK_KEY,
      companyDomain: AMINA_BANK_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: desc,
      descriptionByLocale: { [sourceLang]: desc },
      location: DEFAULT_CITY,
      canton: DEFAULT_CANTON,
      url: publicUrl,
      source: 'AMINA Bank Dedicated Parser (Personio JSON)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: DEFAULT_CITY,
      postalCode: DEFAULT_POSTAL,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(employmentBasis),
      experienceLevel: detectExperienceLevel(`${title} ${rec.seniority || ''}`),
      sector: 'Finanza',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total AMINA Bank (Swiss) jobs discovered: ${jobs.length}`);
  return jobs;
}
