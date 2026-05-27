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
 * Collapse runs of horizontal whitespace but preserve newlines, then trim
 * leading/trailing whitespace and cap consecutive blank lines.
 *
 * The original parser used `normalizeSpace` (which collapses every \s+ run
 * to a single space) on each section AFTER stripping HTML, so list items
 * like `<ul><li>A</li><li>B</li></ul>` \u2014 which `decodeAndStrip` now turns
 * into `\n\u2022 A\n\u2022 B\n` \u2014 were folded into `\u2022 A \u2022 B`. The audit's
 * `hasStructuredContent` check uses a multiline anchor (`/^\s*[-\u2022*]\s/m`),
 * so mid-line bullets failed the bullet-detection and the no-structure
 * ratchet escalated cseb to CRITICAL.
 */
function normalizeBlock(s = '') {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')      // collapse spaces/tabs only
    .replace(/[ \t]*\n[ \t]*/g, '\n') // trim around newlines
    .replace(/\n{3,}/g, '\n\n')   // cap blank-line runs
    .trim();
}

/**
 * Decode HTML entities and strip tags from an HTML string while preserving
 * paragraph + list structure as plain-text bullets and line breaks.
 *
 * The Abacus API double-encodes HTML (entity-encoded tags inside JSON
 * strings). Both passes need to happen here:
 *   1. Decode entities (`&lt;li&gt;` \u2192 `<li>`).
 *   2. Convert structural tags to plain-text equivalents BEFORE we strip
 *      the rest of the HTML, so `<li>` items become `\n\u2022 ` bullets that
 *      survive into the final string. Without this, the no-structure
 *      ratchet kept tripping on cseb because every job's tasks/requirements
 *      were rendered as one long inline run.
 */
function decodeAndStrip(html = '') {
  if (!html) return '';
  let decoded = html
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

  // Convert structural HTML to newline/bullet markers before stripping tags.
  // Order matters: <li> first so we don't drop list boundaries when <ul>/<ol>
  // wrappers get removed.
  decoded = decoded
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n\u2022 ')
    .replace(/<\s*\/\s*li\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol)\s*>/gi, '\n')
    .replace(/<\s*(p|div|h[1-6])[^>]*>/gi, '\n');

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

  // Use normalizeBlock (preserves \n) instead of normalizeSpace so the
  // bullets/newlines emitted by decodeAndStrip survive into the final
  // string. Sections are joined with a blank line so each shows up as a
  // distinct paragraph block to the audit and to AI translation.
  const section = (label, html) => {
    const text = normalizeBlock(decodeAndStrip(html));
    if (text.length <= 10) return null;
    return label ? `${label}:\n${text}` : text;
  };

  if (pub.Introduction)  { const s = section('', pub.Introduction);   if (s) parts.push(s); }
  if (pub.Tasks)         { const s = section('Aufgaben', pub.Tasks);  if (s) parts.push(s); }
  if (pub.Requirements)  { const s = section('Anforderungen', pub.Requirements); if (s) parts.push(s); }
  if (pub.Benefits)      { const s = section('Wir bieten', pub.Benefits); if (s) parts.push(s); }
  if (pub.Organization)  { const s = section('', pub.Organization);   if (s) parts.push(s); }
  if (pub.Closure)       { const s = section('', pub.Closure);        if (s) parts.push(s); }

  return parts.join('\n\n');
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
