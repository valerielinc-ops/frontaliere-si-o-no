#!/usr/bin/env node
/**
 * Climeworks job parser — Recruitee API fetcher and job builder.
 *
 * Climeworks (direct air capture climate tech, Opfikon/Zürich) uses Recruitee.
 * API endpoint: https://climeworks.recruitee.com/api/offers/
 * Careers page: https://climeworks.com/careers (Cloudflare-challenge gated;
 *   the Recruitee-hosted board is the real, scrapeable source of truth).
 *
 * Each offer has flat location fields (city/country/state_name — no nested
 * `locations[]` array like some other Recruitee tenants) and the actual
 * description/requirements HTML live under `translations.<lang>`.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllClimeworksJobs()  — Fetch and parse all Swiss jobs
 *   - isClimeworksJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()         — Validate URLs belong to this company
 *   - slugify() / stripHtml()   — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferAnyCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CLIMEWORKS_KEY = 'climeworks';
export const CLIMEWORKS_COMPANY_NAME = 'Climeworks';
export const CLIMEWORKS_COMPANY_DOMAIN = 'climeworks.com';

const CAREER_URL = 'https://climeworks.com/careers';
const API_URL = 'https://climeworks.recruitee.com/api/offers/';
const CAREERS_HOST = 'climeworks.recruitee.com';
const DEFAULT_CITY = 'Opfikon';
const DEFAULT_CANTON = 'ZH';
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
 * Check if a job belongs to Climeworks.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isClimeworksJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CLIMEWORKS_KEY ||
    key.startsWith('climeworks') ||
    company.includes('climeworks') ||
    url.includes('climeworks.com') ||
    url.includes(CAREERS_HOST)
  );
}

/**
 * Validate that a URL belongs to Climeworks's domain (either the corporate
 * site or the Recruitee-hosted job board).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'climeworks.com' ||
      host.endsWith('.climeworks.com') ||
      host === CAREERS_HOST
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '', department = '') {
  const t = normalize(`${title} ${department}`);
  if (/\b(ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|chemist|sorbent|piping|plant)/.test(t)) return 'Tecnica';
  if (/\b(admin|segret|contab|buchhalt|account)/.test(t)) return 'Amministrazione';
  if (/\b(vendita|sales|verkauf|commerce|partnership|growth|commercial)/.test(t)) return 'Commerciale';
  if (/\b(logist|magazz|lager|warehouse)/.test(t)) return 'Logistica';
  if (/\b(produz|operat|operator|manufactur|facility|hse)/.test(t)) return 'Produzione';
  if (/\b(qualit|qa|qc|quality)/.test(t)) return 'Qualità';
  if (/\b(it\b|software|develop|programm|monitoring|alerting)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht|counsel|compliance)/.test(t)) return 'Legale';
  return 'Altro';
}

function detectExperienceLevel(title = '', experienceCode = '') {
  const t = normalize(`${title} ${experienceCode}`);
  if (/\b(intern|student_college|apprendist|lehrling|lernend|apprenti|stage)/.test(t)) return 'intern';
  if (/\b(junior|jr|entry)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|manager|principal|experienced|senior_manager)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Map Recruitee employment_type_code values to schema.org EmploymentType.
 */
function mapEmploymentType(apiType = '') {
  const t = normalize(apiType);
  if (t.includes('parttime') || t.includes('part_time') || t.includes('part-time')) return 'PART_TIME';
  if (t.includes('fulltime') || t.includes('full_time') || t.includes('full-time')) return 'FULL_TIME';
  if (t.includes('freelance') || t.includes('contract')) return 'CONTRACTOR';
  if (t.includes('intern')) return 'INTERN';
  return 'OTHER';
}

/**
 * Map Recruitee employment_type_code to a human-readable contract string.
 */
function mapContract(apiType = '') {
  const t = normalize(apiType);
  if (t.includes('freelance')) return 'freelance';
  if (t.includes('parttime') || t.includes('part_time')) return 'part-time';
  if (t.includes('fixed_term')) return 'fixed-term';
  if (t.includes('fulltime') || t.includes('permanent')) return 'full-time';
  return 'full-time';
}

/**
 * Check whether a Recruitee offer is located in Switzerland.
 * Climeworks posts a handful of roles in Calgary, Canada too — those must
 * be excluded from a Ticino/Switzerland-focused job board.
 */
function isSwissOffer(offer = {}) {
  if (normalize(offer.country) === 'switzerland') return true;
  if (String(offer.country_code || '').toUpperCase() === 'CH') return true;
  const combined = normalize([offer.city, offer.state_name, offer.country].filter(Boolean).join(' '));
  return /switzerland|svizzera|schweiz|suisse|zurich|zürich|opfikon/.test(combined);
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

async function fetchOffers() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(API_URL, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from Climeworks Recruitee API`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract requirements as a list of strings from the HTML requirements field.
 */
function parseRequirements(html = '') {
  if (!html) return [];
  const text = stripHtml(html);
  return text
    .split('\n')
    .map((line) => normalizeSpace(line.replace(/^[-•*]\s*/, '')))
    .filter((line) => line.length > 5);
}

/**
 * Build a combined plain-text description from the offer's translated
 * description + requirements HTML fields.
 */
function buildDescription(translation = {}) {
  const parts = [];
  const descText = stripHtml(translation.description || '');
  if (descText) parts.push(descText);
  const reqText = stripHtml(translation.requirements || '');
  if (reqText) parts.push(`Requirements:\n${reqText}`);
  return parts.join('\n\n');
}

/**
 * Fetch all Climeworks jobs (Swiss offers only — Calgary/Canada roles are
 * excluded since this board is Switzerland/Ticino-focused).
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllClimeworksJobs() {
  console.log(`🔍 Fetching Climeworks jobs`);
  console.log(`   API: ${API_URL}`);
  console.log(`   Source: ${CAREER_URL}\n`);

  const apiData = await fetchOffers();
  const allOffers = assertJsonListShape(apiData, { key: 'offers', source: CLIMEWORKS_KEY });

  const swissOffers = allOffers.filter(isSwissOffer);
  console.log(`  📋 Offers found: ${allOffers.length} (Swiss: ${swissOffers.length})`);

  if (swissOffers.length === 0) {
    console.warn('⚠️ No Swiss job listings returned.');
    return [];
  }

  const jobs = [];
  for (const offer of swissOffers) {
    const title = normalizeSpace(offer.title || '');
    if (!title || title.length < 3) continue;

    const translations = offer.translations || {};
    const lang = Object.keys(translations)[0] || 'en';
    const translation = translations[lang] || {};

    const city = normalizeSpace(offer.city || '') || DEFAULT_CITY;
    const stateName = normalizeSpace(offer.state_name || '');
    const canton = inferAnyCanton(city) || inferAnyCanton(stateName) || DEFAULT_CANTON;
    // Recruitee's `city` field sometimes already embeds the state (e.g.
    // "Opfikon, Zurich"), so only append `state_name` when it isn't already
    // present in `city` (accent/case-insensitive) to avoid "X, Zurich, Zürich".
    const cityFold = city.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const stateFold = stateName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const location = stateName && stateFold && !cityFold.includes(stateFold)
      ? `${city}, ${stateName}`
      : city;

    const description = buildDescription(translation) || `${title} — Climeworks`;
    const requirements = parseRequirements(translation.requirements || '');

    const sourceLang = detectLang(description || title, 'en');

    const publicUrl = offer.careers_url || `https://${CAREERS_HOST}/o/${offer.slug || ''}`;
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    const jobSlug = slugify(`${title} climeworks ${city}`);

    const postedDate = offer.created_at
      ? String(offer.created_at).slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    const apiEmploymentType = offer.employment_type_code || '';

    const job = {
      // ── Required fields ──
      id: `climeworks-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: CLIMEWORKS_COMPANY_NAME,
      companyKey: CLIMEWORKS_KEY,
      companyDomain: CLIMEWORKS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Climeworks Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: city,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, offer.department || ''),
      contract: mapContract(apiEmploymentType),
      employmentType: mapEmploymentType(apiEmploymentType),
      experienceLevel: detectExperienceLevel(title, offer.experience_code || ''),
      sector: 'Clima e Sostenibilità',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: publicUrl,
      requirements,
      requirementsByLocale: { [sourceLang]: requirements },
      remote: !!offer.hybrid && !offer.on_site,
    };

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 60)} — ${location}`);
  }

  console.log(`\n📋 Total Climeworks jobs discovered: ${jobs.length}`);
  return jobs;
}
