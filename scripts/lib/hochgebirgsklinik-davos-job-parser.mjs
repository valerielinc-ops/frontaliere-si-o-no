#!/usr/bin/env node
/**
 * Hochgebirgsklinik Davos job parser — Connectoor/job-shop.com Typesense API.
 *
 * Source: https://karriere.hochgebirgsklinik.ch/
 *
 * The career portal is a Nuxt.js SPA powered by Connectoor (TalentsConnect).
 * Job data is served via a Typesense search API proxied through
 * api.my-job-shop.com. The scoped Typesense API key is embedded in
 * the page's <script id="__NUXT_DATA__"> JSON blob.
 *
 * Strategy:
 *   1. Fetch the career page HTML
 *   2. Extract the scoped Typesense API key from __NUXT_DATA__
 *   3. Query the Typesense "offers" collection via multi_search
 *   4. Build ParsedJob objects from the search results
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllHochgebirgsklinikDavosJobs()  — Fetch and parse all jobs
 *   - isHochgebirgsklinikDavosJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const HOCHGEBIRGSKLINIK_DAVOS_KEY = 'hochgebirgsklinik-davos';
export const HOCHGEBIRGSKLINIK_DAVOS_COMPANY_NAME = 'Hochgebirgsklinik Davos';
export const HOCHGEBIRGSKLINIK_DAVOS_COMPANY_DOMAIN = 'hochgebirgsklinik.ch';

const CAREER_URL = 'https://karriere.hochgebirgsklinik.ch/';
const TYPESENSE_PROXY_URL = 'https://api.my-job-shop.com/api/typesense/multi_search';
const JOB_SHOP_ID = '9c3b04cb-7265-5acb-a208-199c8a9d547a';

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
 * Check if a job belongs to Hochgebirgsklinik Davos.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isHochgebirgsklinikDavosJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === HOCHGEBIRGSKLINIK_DAVOS_KEY ||
    key.startsWith('hochgebirgsklinik-davos') ||
    company.includes('hochgebirgsklinik davos') ||
    url.includes('hochgebirgsklinik.ch') ||
    url.includes('job-shop.com')
  );
}

/**
 * Validate that a URL belongs to Hochgebirgsklinik Davos's domain.
 * Trusts both hochgebirgsklinik.ch and job-shop.com (Connectoor ATS).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'hochgebirgsklinik.ch' ||
      host.endsWith('.hochgebirgsklinik.ch') ||
      host === 'job-shop.com' ||
      host.endsWith('.job-shop.com') ||
      host.endsWith('.my-job-shop.com') ||
      host.endsWith('.umantis.com')
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

/**
 * Detect category from the Typesense department field or title.
 * Hochgebirgsklinik Davos departments:
 *   Ärztlicher/medizinischer Dienst, Pflege, Psychologie,
 *   Verwaltung, Hauswirtschaft, Ausbildung, Therapie,
 *   Eltern-Kind und Jugendliche, Küche/Service, Initiativbewerbungen
 */
function detectCategory(department = '', title = '') {
  const d = normalize(department);
  const t = normalize(title);

  if (d.includes('pflege') || /\b(pflege|fachperson gesundheit|fage|pflegehelfer)/.test(t)) return 'Infermieristica';
  if (d.includes('psycholog') || /\b(psycholog)/.test(t)) return 'Psicologia';
  if (d.includes('ärztlich') || d.includes('medizinisch') || /\b(arzt|ärztin|ober[aä]rzt|facharzt|medizin)/.test(t)) return 'Medicina';
  if (d.includes('therapie') || /\b(therapeut|therapie|ergo|physio|logo)/.test(t)) return 'Terapia';
  if (d.includes('verwaltung') || /\b(admin|verwaltung|sachbearbeiter|sekretär)/.test(t)) return 'Amministrazione';
  if (d.includes('hauswirtschaft') || /\b(hauswirtschaft|reinigung|raumpflege)/.test(t)) return 'Servizi';
  if (d.includes('küche') || d.includes('service') || /\b(koch|küche|gastro)/.test(t)) return 'Ristorazione';
  if (d.includes('ausbildung') || /\b(lehrperson|ausbildung|praktik|lernend)/.test(t)) return 'Formazione';
  if (d.includes('eltern') || d.includes('jugend') || /\b(kinder|jugend|pädiatrie)/.test(t)) return 'Pediatria';
  if (/\b(labor|analytik|bma|mtl)/.test(t)) return 'Laboratorio';
  if (/\b(pharma|drogist|apothek)/.test(t)) return 'Farmacia';
  return 'Sanità';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|forschungspraktik)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|leitend|oberarzt|oberärztin)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Detect employment type from schedule array and title.
 * Typesense document provides schema_values.working_time_types: ["FULL_TIME"] / ["PART_TIME"]
 */
function detectEmploymentType(schemaValues, schedule = [], title = '') {
  // Use structured schema values if available
  const types = schemaValues?.working_time_types || [];
  if (types.includes('FULL_TIME') && types.includes('PART_TIME')) return 'FULL_TIME';
  if (types.includes('FULL_TIME')) return 'FULL_TIME';
  if (types.includes('PART_TIME')) return 'PART_TIME';

  // Fall back to schedule text
  const sched = (schedule || []).join(' ').toLowerCase();
  if (sched.includes('vollzeit')) return 'FULL_TIME';
  if (sched.includes('teilzeit')) return 'PART_TIME';

  // Fall back to title percentage patterns
  const t = normalize(title);
  const pctMatch = t.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2], 10) : parseInt(pctMatch[1], 10);
    return maxPct < 80 ? 'PART_TIME' : 'FULL_TIME';
  }

  return 'OTHER';
}

/**
 * Extract pensum percentage from the title string.
 * Examples: "80-100%", "60 - 100 %", "40%", "50–100 %"
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

/**
 * Parse DD.MM.YYYY, HH:MM:SS → YYYY-MM-DD.
 */
function parseDate(raw = '') {
  const m = String(raw || '').match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return '';
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/* ── Typesense API Key Extraction ────────────────────────── */

/**
 * Fetch the career page and extract the scoped Typesense API key
 * from the __NUXT_DATA__ JSON blob.
 *
 * The NUXT_DATA is a flat JSON array where indices reference other indices.
 * The structure at the top level is:
 *   [1] = { data: 2, ... }
 *   [3] = { jobShopData: 4, "typesenseApiKey-{jobShopId}": <keyIndex>, ... }
 *   [keyIndex] = "<base64-encoded scoped Typesense key>"
 */
async function fetchTypesenseApiKey() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(CAREER_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'de-CH,de;q=0.9',
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from career page`);
    const html = await res.text();

    // Extract __NUXT_DATA__ JSON array
    const nuxtMatch = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!nuxtMatch) throw new Error('__NUXT_DATA__ not found in career page HTML');

    const nuxtArr = JSON.parse(nuxtMatch[1]);

    // The data structure has the key at the index stored in the top-level data object
    // under the property "typesenseApiKey-{jobShopId}"
    const dataObjIdx = nuxtArr[1]?.data;
    if (dataObjIdx === undefined) throw new Error('NUXT_DATA: data index not found');

    const dataObj = nuxtArr[dataObjIdx];
    const keyProp = `typesenseApiKey-${JOB_SHOP_ID}`;
    const keyIdx = dataObj?.[keyProp];
    if (keyIdx === undefined) throw new Error(`NUXT_DATA: ${keyProp} index not found`);

    const apiKey = nuxtArr[keyIdx];
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 20) {
      throw new Error('NUXT_DATA: invalid Typesense API key');
    }

    console.log(`  🔑 Extracted Typesense API key (${apiKey.length} chars)`);
    return apiKey;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Typesense Search ────────────────────────────────────── */

/**
 * Query the Typesense "offers" collection via the job-shop.com proxy.
 * Returns an array of Typesense document objects.
 */
async function fetchJobListings(apiKey) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${TYPESENSE_PROXY_URL}?x-typesense-api-key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        Referer: CAREER_URL,
        Origin: 'https://karriere.hochgebirgsklinik.ch',
      },
      body: JSON.stringify({
        searches: [{
          collection: 'offers',
          q: '*',
          query_by: 'title',
          per_page: 250,
        }],
      }),
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status} from Typesense API`);

    const data = await res.json();
    const results = data?.results?.[0];
    if (!results) throw new Error('No results in Typesense response');

    const hits = results.hits || [];
    console.log(`  📊 Typesense found: ${results.found} jobs, returned: ${hits.length}`);
    return hits.map((h) => h.document);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Build Job from Typesense Document ───────────────────── */

/**
 * Build a rich description from the Typesense document fields.
 * Available fields: description (tasks), expectation (requirements),
 * offering (benefits), about, introduction, additional.
 */
function buildDescription(doc) {
  const parts = [];

  if (doc.introduction) {
    const intro = normalizeSpace(stripHtml(doc.introduction));
    if (intro.length > 10) parts.push(intro);
  }

  if (doc.description) {
    const tasks = normalizeSpace(stripHtml(doc.description));
    if (tasks.length > 10) parts.push(`Aufgaben: ${tasks}`);
  }

  if (doc.expectation) {
    const reqs = normalizeSpace(stripHtml(doc.expectation));
    if (reqs.length > 10) parts.push(`Anforderungen: ${reqs}`);
  }

  if (doc.offering) {
    const benefits = normalizeSpace(stripHtml(doc.offering));
    if (benefits.length > 10) parts.push(`Wir bieten: ${benefits}`);
  }

  if (doc.about) {
    const about = normalizeSpace(stripHtml(doc.about));
    if (about.length > 10) parts.push(about);
  }

  if (doc.additional) {
    const add = normalizeSpace(stripHtml(doc.additional));
    if (add.length > 10) parts.push(add);
  }

  return parts.join(' | ');
}

/**
 * Build the public job URL.
 * The Typesense document has a redirect URL like:
 *   https://karriere.hochgebirgsklinik.ch/offer-redirect/?offerApiId=NTk1&showApplicationForm=false
 * And an application_url pointing to Umantis.
 * We prefer the career page URL since it's the public-facing page.
 */
function buildPublicUrl(doc) {
  // Use the career page redirect URL if available
  if (doc.url && doc.url.includes('karriere.hochgebirgsklinik.ch')) {
    return doc.url;
  }
  // Fall back to application URL
  if (doc.application_url) {
    return doc.application_url;
  }
  return CAREER_URL;
}

/* ── Main Fetch Function ──────────────────────────────────── */

/**
 * Fetch all Hochgebirgsklinik Davos jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * Flow:
 *   1. Fetch career page HTML → extract Typesense API key from __NUXT_DATA__
 *   2. Query Typesense "offers" collection via multi_search
 *   3. Build ParsedJob objects from search results
 */
export async function fetchAllHochgebirgsklinikDavosJobs() {
  console.log(`🏥 Fetching Hochgebirgsklinik Davos jobs`);
  console.log(`   Source: ${CAREER_URL}`);
  console.log(`   API: ${TYPESENSE_PROXY_URL}\n`);

  // Step 1: Get the Typesense API key
  const apiKey = await fetchTypesenseApiKey();

  // Step 2: Query all jobs
  const documents = await fetchJobListings(apiKey);
  if (!documents || documents.length === 0) {
    console.warn('⚠️ No job documents returned from Typesense.');
    return [];
  }

  console.log(`  📋 Documents to process: ${documents.length}\n`);

  const jobs = [];
  for (const doc of documents) {
    const title = normalizeSpace(doc.title || '');
    if (!title || title.length < 3) continue;

    // Skip "Initiativbewerbung" (spontaneous application placeholder)
    if (/^initiativbewerbung$/i.test(title.trim())) continue;

    // Location: from location array or location_objects
    const locationArr = doc.location || [];
    const location = locationArr[0] || 'Davos';
    const canton = inferSwissTargetCanton(location) || 'GR';

    // Build full description
    const descriptionText = buildDescription(doc);
    const fallbackDesc = `${title} — Hochgebirgsklinik Davos, ${location}`;

    // Public URL and apply URL
    const publicUrl = buildPublicUrl(doc);
    const applyUrl = doc.application_url || publicUrl;

    // Generate stable ID from offer UUID
    const offerUuid = doc.offer_uuid || doc.id || '';
    const urlHash = createHash('sha1').update(offerUuid || publicUrl).digest('hex').slice(0, 12);

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} hochgebirgsklinik-davos ch`);

    // Department and category
    const department = (doc.department || [])[0] || '';
    const category = detectCategory(department, title);

    // Pensum and employment type
    const pensum = extractPensum(title);
    const employmentType = detectEmploymentType(doc.schema_values, doc.schedule, title);
    const contract = pensum && pensum.max < 80 ? 'part-time' : 'full-time';

    // Dates
    const postedDate = parseDate(doc.create_date) || new Date().toISOString().split('T')[0];

    // Postal code from full_address
    const fullAddress = (doc.full_address || [])[0] || '';
    const postalMatch = fullAddress.match(/\b(7\d{3})\b/);
    const postalCode = postalMatch ? postalMatch[1] : '7270';

    // Street address from full_address
    const streetMatch = fullAddress.match(/^(.+?),\s*\d{4}/);
    const streetAddress = streetMatch ? streetMatch[1] : '';

    const job = {
      // ── Required fields ──
      id: `hochgebirgsklinik-davos-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: HOCHGEBIRGSKLINIK_DAVOS_COMPANY_NAME,
      companyKey: HOCHGEBIRGSKLINIK_DAVOS_KEY,
      companyDomain: HOCHGEBIRGSKLINIK_DAVOS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText || fallbackDesc,
      descriptionByLocale: { [sourceLang]: descriptionText || fallbackDesc },
      location,
      canton,
      url: publicUrl,
      source: 'Hochgebirgsklinik Davos Dedicated Parser (Connectoor/Typesense)',
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
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Assistenza',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    // Optional enrichment
    if (department) {
      job.department = department;
    }
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

    // Contact data
    if (doc.contact_data) {
      const c = doc.contact_data;
      if (c.first_name || c.last_name) {
        job.contactPerson = normalizeSpace(`${c.first_name || ''} ${c.last_name || ''}`);
      }
      if (c.phone) job.contactPhone = c.phone;
      if (c.email) job.contactEmail = c.email;
    }

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 65)} — ${location} (${department || 'N/A'})`);
  }

  console.log(`\n📋 Total Hochgebirgsklinik Davos jobs discovered: ${jobs.length}`);
  return jobs;
}
