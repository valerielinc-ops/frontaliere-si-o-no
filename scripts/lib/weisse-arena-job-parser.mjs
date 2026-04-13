#!/usr/bin/env node
/**
 * Weisse Arena Gruppe job parser — Cegid TalentLink REST API.
 *
 * Source: https://www.weissearena.com/jobs/
 *
 * The career page embeds a Cegid TalentLink (formerly Lumesse) widget that
 * calls a REST API at emea3.recruitmentplatform.com. The API uses custom
 * auth headers (guest credentials baked into the widget JS) and returns
 * paginated JSON with job listings including full HTML descriptions via
 * customFields.
 *
 * API:
 *   POST /fo/rest/jobs?firstResult={offset}&maxResults={limit}
 *        &sortBy=DPOSTINGSTART&sortOrder=desc
 *   Headers: username, password, lumesse-language
 *   Body: { "searchCriteria": {} }
 *
 * Site tech ID: PD6FK026203F3VBQBLO8NV79D
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllWeisseArenaJobs()  — Fetch and parse all jobs
 *   - isWeisseArenaJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()          — Validate URLs belong to this company
 *   - slugify() / stripHtml()    — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml, normalizeSpace } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const WEISSE_ARENA_KEY = 'weisse-arena';
export const WEISSE_ARENA_COMPANY_NAME = 'Weisse Arena Gruppe';
export const WEISSE_ARENA_COMPANY_DOMAIN = 'weissearena.com';

const SITE_TECH_ID = 'PD6FK026203F3VBQBLO8NV79D';
const API_BASE = 'https://emea3.recruitmentplatform.com/fo/rest/jobs';
const DETAIL_BASE = 'https://www.weissearena.com/jobs/details.html';
const PAGE_SIZE = 50;

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Weisse Arena Gruppe.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isWeisseArenaJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === WEISSE_ARENA_KEY ||
    key.startsWith('weisse-arena') ||
    company.includes('weisse arena gruppe') ||
    company.includes('weisse arena') ||
    url.includes('weissearena.com') ||
    (url.includes('recruitmentplatform.com') && url.includes(SITE_TECH_ID.toLowerCase()))
  );
}

/**
 * Validate that a URL belongs to Weisse Arena Gruppe's domain.
 * Trusts both weissearena.com and recruitmentplatform.com (TalentLink ATS).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'weissearena.com' ||
      host.endsWith('.weissearena.com') ||
      host.endsWith('.recruitmentplatform.com')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

/**
 * Detect job category from title and department.
 * Tailored to Weisse Arena Gruppe's departments:
 *   - Gastronomie, Hotellerie, Skischule, Marketing, Technik, etc.
 */
export function detectCategory(title = '', department = '') {
  const t = normalize(title);
  const d = normalize(department);
  const combined = `${t} ${d}`;

  // Gastronomy / Restaurant
  if (/\b(koch|küche|k[oö]chin|pizzaiolo|spülküche|restaurant|gastro|bar|service.*mitarbeit|frühstück|kellner|buffet)/.test(combined)) return 'Ristorazione';
  // Hospitality / Hotel
  if (/\b(hotel|housekeep|rezeption|empfang|ferienwohn|concierge|room)/.test(combined)) return 'Hotellerie';
  // Ski / Sport / Outdoor
  if (/\b(ski|snowboard|bike|sport|piste|rettung|bergbahn|rental|schule)/.test(combined)) return 'Sport';
  // Marketing / Communication / Sales
  if (/\b(market|kommunik|content|growth|crm|lifecycle|sales|event|customer experience)/.test(combined)) return 'Marketing';
  // Tech / ICT / Engineering
  if (/\b(techni|unterhalt|sicherheit|ict|it\b|software|develop|ingenieur|engineer|bahnbetrieb|bahn.*technik)/.test(combined)) return 'Tecnica';
  // Finance / Administration
  if (/\b(admin|finan|buchhalt|hr\b|personal|verwaltung|controlling)/.test(combined)) return 'Amministrazione';
  // Ticket / Guest services
  if (/\b(ticket|gäste.*info|kasse|verkauf)/.test(combined)) return 'Commerciale';
  // Data / Digital
  if (/\b(data|digital|analy)/.test(combined)) return 'IT';

  return 'Turismo';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|supervisor|stellvertretend)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Map TalentLink CONTRACTTYPLABEL to employmentType.
 * Known values: Festanstellung, Saisonanstellung, Kaderanstellung,
 *               Lehranstellung, Praktikumsanstellung
 */
export function mapContractType(label = '') {
  const l = normalize(label);
  if (l.includes('fest') || l.includes('kader')) return 'FULL_TIME';
  if (l.includes('saison')) return 'CONTRACTOR';
  if (l.includes('lehr') || l.includes('praktikum')) return 'INTERN';
  return 'OTHER';
}

/**
 * Parse pensum string like "80%-100%" into { min, max }.
 */
export function parsePensum(pensum = '') {
  const match = String(pensum || '').match(/(\d+)\s*%?\s*-\s*(\d+)\s*%?/);
  if (match) return { min: parseInt(match[1], 10), max: parseInt(match[2], 10) };
  const single = String(pensum || '').match(/(\d+)\s*%/);
  if (single) {
    const v = parseInt(single[1], 10);
    return { min: v, max: v };
  }
  return { min: 100, max: 100 };
}

/* ── TalentLink API Client ────────────────────────────────── */

/**
 * Call the TalentLink REST API with proper auth headers.
 */
async function callTalentLinkApi(url, body = null) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        username: `${SITE_TECH_ID}:guest:FO`,
        password: 'guest',
        'lumesse-language': 'DE',
      },
      signal: controller.signal,
      body: body ? JSON.stringify(body) : undefined,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from TalentLink API`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Fetch all job listings from the TalentLink API.
 * Returns the full API response with { globals, jobs }.
 */
async function fetchJobListings() {
  const allJobs = [];
  let offset = 0;

  while (true) {
    console.log(`  📄 Fetching jobs at offset ${offset}...`);
    const url = `${API_BASE}?firstResult=${offset}&maxResults=${PAGE_SIZE}&sortBy=DPOSTINGSTART&sortOrder=desc`;
    const data = await callTalentLinkApi(url, { searchCriteria: {} });

    const jobs = data?.jobs || [];
    if (jobs.length === 0) break;

    allJobs.push(...jobs);

    const totalCount = data?.globals?.jobsCount || 0;
    if (allJobs.length >= totalCount || jobs.length < PAGE_SIZE) break;

    offset += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, 500));
  }

  return allJobs;
}

/* ── Description Builder ──────────────────────────────────── */

/**
 * Build a plain-text description from TalentLink customFields.
 *
 * customFields is an array of { title, content } objects.
 * Titled sections (e.g. "Was du bewegst", "Was dich ausmacht") contain
 * the actual job responsibilities and requirements. Untitled sections
 * (title=" ") contain company intro and benefits boilerplate.
 */
function buildDescription(customFields = []) {
  const sections = [];

  for (const field of customFields) {
    const title = (field.title || '').trim();
    const content = normalizeSpace(stripHtml(field.content || ''));
    if (!content || content.length < 10) continue;

    if (title && title.length > 1) {
      sections.push(`${title}: ${content}`);
    } else {
      sections.push(content);
    }
  }

  return sections.join(' | ');
}

/**
 * Build the public detail URL for a job on weissearena.com.
 */
export function buildDetailUrl(jobId, jobTitle = '') {
  const params = new URLSearchParams({ jobId: String(jobId) });
  if (jobTitle) params.set('jobTitle', jobTitle);
  return `${DETAIL_BASE}?${params.toString()}`;
}

/* ── Main Fetch Function ──────────────────────────────────── */

/**
 * Fetch all Weisse Arena Gruppe jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllWeisseArenaJobs() {
  console.log(`🔍 Fetching Weisse Arena Gruppe jobs`);
  console.log(`   Source: ${DETAIL_BASE}\n`);

  const listings = await fetchJobListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No job listings returned from TalentLink API.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];

  for (const listing of listings) {
    const fields = listing.jobFields || {};
    const title = normalizeSpace(fields.jobTitle || fields.sJobTitle || '');
    if (!title || title.length < 3) continue;

    const jobId = fields.id || listing.id;
    const department = normalizeSpace(fields.SLOVLIST10 || '');
    const pensumStr = fields.SLOVLIST17 || '100%';
    const contractLabel = fields.CONTRACTTYPLABEL || '';
    const jobNumber = fields.jobNumber || '';
    const applicationUrl = fields.applicationUrl || '';
    const postingTimestamp = fields.DPOSTINGSTART;

    // All Weisse Arena jobs are in Laax, GR
    const location = 'Laax';
    const canton = 'GR';
    const postalCode = '7031';

    // Build description from customFields
    const descriptionText = buildDescription(listing.customFields || []);

    // Public detail URL on weissearena.com
    const publicUrl = buildDetailUrl(jobId, title);

    // ID: use jobNumber for stability (e.g. "WAG02350")
    const idSource = jobNumber || String(jobId);
    const urlHash = createHash('sha1').update(idSource).digest('hex').slice(0, 12);

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} weisse-arena ch`);

    // Parse pensum for contract type inference
    const pensum = parsePensum(pensumStr);
    const employmentType = mapContractType(contractLabel);
    const contract = pensum.max < 80 ? 'part-time' : 'full-time';

    // Posted date from timestamp
    const postedDate = postingTimestamp
      ? new Date(postingTimestamp).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];

    const description = descriptionText || `${title} — Weisse Arena Gruppe, ${department}`;

    const job = {
      // ── Required fields ──
      id: `weisse-arena-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: WEISSE_ARENA_COMPANY_NAME,
      companyKey: WEISSE_ARENA_KEY,
      companyDomain: WEISSE_ARENA_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: publicUrl,
      source: 'Weisse Arena Gruppe Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, department),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Turismo / Sport',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: applicationUrl || publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    // Optional enrichment
    if (department) job.department = department;
    if (jobNumber) job.jobNumber = jobNumber;
    if (pensum.min !== pensum.max) {
      job.pensum = `${pensum.min} - ${pensum.max}%`;
    } else {
      job.pensum = `${pensum.min}%`;
    }
    if (contractLabel) job.contractLabel = contractLabel;

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 55)} — ${department} (${pensumStr})`);
  }

  console.log(`\n📋 Total Weisse Arena Gruppe jobs discovered: ${jobs.length}`);
  return jobs;
}
