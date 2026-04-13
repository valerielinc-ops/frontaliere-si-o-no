#!/usr/bin/env node
/**
 * Center da Sanadad Engiadina Bassa (CSEB) job parser — Abacus Job Portal API.
 *
 * Source: https://jobs.cseb.ch/job-overview/CSEB
 *
 * The career portal is an Abacus Job Portal SPA (Vue.js). Authenticated API
 * calls go through Keycloak, but the publication endpoint is publicly
 * accessible without auth:
 *
 *   GET https://api.jobportal.abaservices.ch/api/publication/publications
 *       ?job-portal-id={portalId}
 *
 * Returns a flat JSON array of publication objects with all job details
 * (title, description sections, location, company info, URLs).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllCsebJobs()    — Fetch and parse all jobs
 *   - isCsebJob()           — Match jobs belonging to this company
 *   - isTrustedDomain()     — Validate URLs belong to this company
 *   - parseCsebPublication() — Parse a single API publication into a job (testable)
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const CSEB_KEY = 'cseb';
export const CSEB_COMPANY_NAME = 'Center da Sanadad Engiadina Bassa';
export const CSEB_COMPANY_DOMAIN = 'cseb.ch';

const PORTAL_ID = 'd9c5a048-f665-4e64-a2c7-cdd8231bac77';
const API_URL = `https://api.jobportal.abaservices.ch/api/publication/publications?job-portal-id=${PORTAL_ID}`;
const CAREER_URL = 'https://jobs.cseb.ch/job-overview/CSEB';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Decode HTML entities and strip tags from an HTML string.
 * The Abacus API double-encodes HTML: entity-encoded tags inside JSON strings.
 */
function decodeAndStrip(html = '') {
  if (!html) return '';
  // First decode HTML entities to get actual HTML tags
  const decoded = html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&#171;/g, '\u00AB')
    .replace(/&#187;/g, '\u00BB')
    .replace(/&#8211;/g, '\u2013')
    .replace(/&#8212;/g, '\u2014')
    .replace(/&#8216;/g, '\u2018')
    .replace(/&#8217;/g, '\u2019')
    .replace(/&#8220;/g, '\u201C')
    .replace(/&#8222;/g, '\u201E')
    .replace(/&#43;/g, '+')
    .replace(/&agrave;/g, '\u00E0')
    .replace(/&auml;/g, '\u00E4')
    .replace(/&ouml;/g, '\u00F6')
    .replace(/&uuml;/g, '\u00FC')
    .replace(/&eacute;/g, '\u00E9');
  // Then strip remaining HTML tags
  return stripHtml(decoded);
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Center da Sanadad Engiadina Bassa.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isCsebJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === CSEB_KEY ||
    key.startsWith('cseb') ||
    company.includes('center da sanadad engiadina bassa') ||
    company.includes('gesundheitszentrum unterengadin') ||
    url.includes('cseb.ch') ||
    url.includes('jobs.cseb.ch')
  );
}

/**
 * Validate that a URL belongs to CSEB's domain.
 * Trusts cseb.ch and abaservices.ch (Abacus Job Portal API).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'cseb.ch' ||
      host.endsWith('.cseb.ch') ||
      host.endsWith('.abaservices.ch')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

/**
 * Detect category from the job title.
 * CSEB is a healthcare center: hospital (Ospidal), long-term care (Chüra),
 * home care (Spitex), wellness (Bogn Engiadina), and support services.
 */
function detectCategory(title = '') {
  const t = normalize(title);

  if (/\b(pflege|fachfrau.*gesundheit|fachmann.*gesundheit|fage|pflegehelfer|pflegefach|sozialbetreuer)/.test(t)) return 'Infermieristica';
  if (/\b(arzt|ärztin|ober[aä]rzt|facharzt|medizin|assistenzarzt|assistenzärztin|leitend.*arzt|leitend.*ärztin|unterassistent|famulant|famulatur)/.test(t)) return 'Medicina';
  if (/\b(gynäkologie|geburtshilfe)/.test(t)) return 'Ginecologia';
  if (/\b(rettungssanitäter|rettung|notfall|ambulanz)/.test(t)) return 'Emergenza';
  if (/\b(therapeut|therapie|ergo|physio|logo)/.test(t)) return 'Terapia';
  if (/\b(koch|köch|küche|gastro|service|bad|römisch)/.test(t)) return 'Ristorazione';
  if (/\b(hauswirtschaft|reinigung|lingerie|raumpflege|wäscherei)/.test(t)) return 'Servizi';
  if (/\b(admin|verwaltung|sachbearbeiter|sekretär|kauffrau|kaufmann)/.test(t)) return 'Amministrazione';
  if (/\b(lehrling|lernend|lehrstelle|lehrperson|ausbildung|praktik|ags|efz|eba)/.test(t)) return 'Formazione';
  if (/\b(labor|analytik|bma|mtl)/.test(t)) return 'Laboratorio';
  if (/\b(pharma|drogist|apothek)/.test(t)) return 'Farmacia';
  if (/\b(techni|it|informatik|software)/.test(t)) return 'Tecnica';
  return 'Sanità';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|forschungspraktik|famulant|famulatur|unterassistent|lehrstelle|ags|eba|efz)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitend|oberarzt|oberärztin)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Detect employment type from title percentage patterns and PositionLevelOfEmployment.
 */
function detectEmploymentType(title = '', levelOfEmployment = '0') {
  // Check title percentage patterns
  const rangeMatch = title.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (rangeMatch) {
    const maxPct = parseInt(rangeMatch[2], 10);
    return maxPct >= 80 ? 'FULL_TIME' : 'PART_TIME';
  }
  const singleMatch = title.match(/(\d{2,3})\s*%/);
  if (singleMatch) {
    const pct = parseInt(singleMatch[1], 10);
    return pct >= 80 ? 'FULL_TIME' : 'PART_TIME';
  }

  // Check PositionLevelOfEmployment from API
  const level = parseInt(levelOfEmployment, 10);
  if (level > 0) {
    return level >= 80 ? 'FULL_TIME' : 'PART_TIME';
  }

  return 'OTHER';
}

/**
 * Extract pensum percentage from the title string.
 * Examples: "80-100%", "60 - 100 %", "40%", "50–100 %", "(25-50%)"
 */
function extractPensum(title = '') {
  const rangeMatch = title.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (rangeMatch) {
    return { min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) };
  }
  const singleMatch = title.match(/(\d{2,3})\s*%/);
  if (singleMatch) {
    const val = parseInt(singleMatch[1], 10);
    return { min: val, max: val };
  }
  return null;
}

/* ── Description Builder ──────────────────────────────────── */

/**
 * Build a rich description from the Abacus API publication fields.
 * Available sections: Introduction, Tasks, Requirements, Benefits, Organization, Closure.
 */
function buildDescription(pub) {
  const parts = [];

  if (pub.Introduction) {
    const intro = normalizeSpace(decodeAndStrip(pub.Introduction));
    if (intro.length > 10) parts.push(intro);
  }

  if (pub.Tasks) {
    const tasks = normalizeSpace(decodeAndStrip(pub.Tasks));
    if (tasks.length > 10) parts.push(`Aufgaben: ${tasks}`);
  }

  if (pub.Requirements) {
    const reqs = normalizeSpace(decodeAndStrip(pub.Requirements));
    if (reqs.length > 10) parts.push(`Anforderungen: ${reqs}`);
  }

  if (pub.Benefits) {
    const benefits = normalizeSpace(decodeAndStrip(pub.Benefits));
    if (benefits.length > 10) parts.push(`Wir bieten: ${benefits}`);
  }

  if (pub.Organization) {
    const org = normalizeSpace(decodeAndStrip(pub.Organization));
    if (org.length > 10) parts.push(org);
  }

  if (pub.Closure) {
    const closure = normalizeSpace(decodeAndStrip(pub.Closure));
    if (closure.length > 10) parts.push(closure);
  }

  return parts.join(' | ');
}

/* ── Parse a Single Publication ──────────────────────────── */

/**
 * Parse a single Abacus Job Portal publication into a ParsedJob object.
 * Exported for unit testing.
 *
 * @param {object} pub - A publication object from the Abacus API
 * @returns {object|null} - A ParsedJob object or null if the publication is invalid
 */
export function parseCsebPublication(pub) {
  const title = normalizeSpace(pub.JobTitle || pub.Designation01 || '');
  if (!title || title.length < 3) return null;

  // Skip spontaneous application placeholders
  if (/^spontanbewerbung$/i.test(title.trim())) return null;

  // Location from API
  const location = normalizeSpace(pub.PlaceOfWorkCity || pub.CompanyCity || 'Scuol');
  const canton = inferAnyCanton(location) || pub.CompanyState || 'GR';

  // Build full description from sections
  const descriptionText = buildDescription(pub);
  const fallbackDesc = `${title} — Center da Sanadad Engiadina Bassa, ${location}`;

  // URLs
  const publicUrl = pub.PublicationUrlAbacusJobPortal || CAREER_URL;
  const applyUrl = pub.ApplicationUrl || publicUrl;

  // Generate stable ID from JobId (UUID)
  const jobId = pub.JobId || pub.PublicationId || '';
  const urlHash = createHash('sha1').update(jobId || publicUrl).digest('hex').slice(0, 12);

  const sourceLang = pub.PublicationLanguage || 'de';
  const jobSlug = slugify(`${title} cseb ch`);

  // Category and experience
  const category = detectCategory(title);
  const experienceLevel = detectExperienceLevel(title);

  // Pensum and employment type
  const pensum = extractPensum(title);
  const employmentType = detectEmploymentType(title, pub.PositionLevelOfEmployment);
  const contract = pensum && pensum.max < 80 ? 'part-time' : 'full-time';

  // Dates
  const postedDate = pub.PublicationStartDate || new Date().toISOString().split('T')[0];

  // Address
  const postalCode = pub.PlaceOfWorkZip || pub.CompanyZip || '7550';
  const street = pub.PlaceOfWorkStreet || pub.CompanyStreet || '';
  const houseNumber = pub.PlaceOfWorkHouseNumber || pub.CompanyHouseNumber || '';
  const streetAddress = houseNumber ? `${street} ${houseNumber}`.trim() : street;

  const job = {
    // ── Required fields ──
    id: `cseb-${urlHash}`,
    slug: jobSlug,
    slugByLocale: { [sourceLang]: jobSlug },
    company: CSEB_COMPANY_NAME,
    companyKey: CSEB_KEY,
    companyDomain: CSEB_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description: descriptionText || fallbackDesc,
    descriptionByLocale: { [sourceLang]: descriptionText || fallbackDesc },
    location,
    canton,
    url: publicUrl,
    source: 'Center da Sanadad Engiadina Bassa Dedicated Parser (Abacus Job Portal)',
    sourceLang,
    crawledAt: new Date().toISOString(),

    // ── Recommended fields ──
    addressLocality: location,
    postalCode,
    addressCountry: 'CH',
    country: 'CH',
    category,
    contract,
    employmentType,
    experienceLevel,
    sector: 'Sanità / Assistenza',
    currency: 'CHF',
    featured: false,
    postedDate,
    applyUrl,
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
  };

  // Optional enrichment
  if (streetAddress) {
    job.streetAddress = streetAddress;
  }
  if (pensum) {
    job.pensumMin = pensum.min;
    job.pensumMax = pensum.max;
    job.pensum = pensum.min === pensum.max
      ? `${pensum.min}%`
      : `${pensum.min} - ${pensum.max}%`;
  }

  // HR contact
  const hrFirst = normalizeSpace(pub.HrResponsibleFirstName || '');
  const hrLast = normalizeSpace(pub.HrResponsibleLastName || '');
  if (hrFirst || hrLast) {
    job.contactPerson = normalizeSpace(`${hrFirst} ${hrLast}`);
  }

  return job;
}

/* ── API Client ───────────────────────────────────────────── */

/**
 * Fetch all publications from the Abacus Job Portal API.
 * The endpoint is publicly accessible (no auth required).
 */
async function fetchPublications() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(API_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from Abacus API`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Main Fetch Function ──────────────────────────────────── */

/**
 * Fetch all CSEB jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Call the Abacus Job Portal publications API (public, no auth)
 *   2. Parse each publication into a ParsedJob
 */
export async function fetchAllCsebJobs() {
  console.log(`🏥 Fetching Center da Sanadad Engiadina Bassa jobs`);
  console.log(`   Source: ${CAREER_URL}`);
  console.log(`   API: ${API_URL}\n`);

  const publications = await fetchPublications();
  if (!Array.isArray(publications) || publications.length === 0) {
    console.warn('⚠️ No publications returned from Abacus API.');
    return [];
  }

  console.log(`  📊 Publications returned: ${publications.length}\n`);

  const jobs = [];
  for (const pub of publications) {
    const job = parseCsebPublication(pub);
    if (!job) continue;

    jobs.push(job);
    console.log(`  ✅ ${job.title.substring(0, 65)} — ${job.location} (${job.category})`);
  }

  console.log(`\n📋 Total CSEB jobs discovered: ${jobs.length}`);
  return jobs;
}
