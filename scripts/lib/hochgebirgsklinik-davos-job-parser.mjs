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
import { assertJsonListShape } from './assert-json-list-shape.mjs';
import {
  fetchJson,
  fetchWithRetry,
  RETRYABLE_STATUS,
  slugify,
  stripHtml,
  warnIfListingAtCap,
} from './crawler-template.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const HOCHGEBIRGSKLINIK_DAVOS_KEY = 'hochgebirgsklinik-davos';
export const HOCHGEBIRGSKLINIK_DAVOS_COMPANY_NAME = 'Hochgebirgsklinik Davos';
export const HOCHGEBIRGSKLINIK_DAVOS_COMPANY_DOMAIN = 'hochgebirgsklinik.ch';

const CAREER_URL = 'https://karriere.hochgebirgsklinik.ch/';
const TYPESENSE_API_KEY_URL = 'https://api.my-job-shop.com/api/offer/v1/search/api-key';
const TYPESENSE_PROXY_URL = 'https://api.my-job-shop.com/api/typesense/multi_search';
const JOB_SHOP_ID = '9c3b04cb-7265-5acb-a208-199c8a9d547a';
const TYPESENSE_PAGE_CAP = 250;

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
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti|forschungspraktik)/.test(t)) return 'intern';
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
 * Nuxt serialises reactive values as a flat array of references. Newer
 * job-shop pages sometimes wrap a value in more than one reference (or in a
 * small tagged array), so a one-level `nuxtArr[index]` lookup is not enough.
 * Resolve references without assuming that every object is a key container.
 */
function resolveNuxtReference(value, nuxtArr, stack = new Set()) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value < 0 || value >= nuxtArr.length || stack.has(value)) return null;
    const nextStack = new Set(stack);
    nextStack.add(value);
    return resolveNuxtReference(nuxtArr[value], nuxtArr, nextStack);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveNuxtReference(item, nuxtArr, stack));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveNuxtReference(item, nuxtArr, stack)]),
    );
  }
  return value;
}

function findNuxtPropertyValue(nuxtArr, property) {
  if (!Array.isArray(nuxtArr)) return null;
  for (const entry of nuxtArr) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !(property in entry)) continue;
    const value = resolveNuxtReference(entry[property], nuxtArr);
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function findEncodedTypesenseKey(value, seen = new Set()) {
  if (typeof value === 'string') {
    if (value.length <= 100 || !/^[A-Za-z0-9+/=]+$/.test(value)) return null;
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      if (decoded.includes('filter_by') && decoded.includes(JOB_SHOP_ID.split('-')[0])) return value;
    } catch {
      // Not a base64 value; keep searching the rest of the payload.
    }
    return null;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = findEncodedTypesenseKey(item, seen);
      if (candidate) return candidate;
    }
    return null;
  }
  for (const item of Object.values(value)) {
    const candidate = findEncodedTypesenseKey(item, seen);
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Extract the scoped key from a Nuxt payload. Exported so the live payload
 * shape can be regression-tested without making the unit suite call the ATS.
 */
export function extractTypesenseApiKeyFromNuxtData(nuxtArr) {
  if (!Array.isArray(nuxtArr)) return null;
  const keyProp = `typesenseApiKey-${JOB_SHOP_ID}`;

  for (const entry of nuxtArr) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !(keyProp in entry)) continue;
    const candidate = resolveNuxtReference(entry[keyProp], nuxtArr);
    if (typeof candidate === 'string' && candidate.length >= 20) return candidate;
  }

  return findEncodedTypesenseKey(nuxtArr);
}

async function fetchTypesenseApiKeyFromSearchApi(nuxtArr) {
  const jobShopData = findNuxtPropertyValue(nuxtArr, 'jobShopData');
  const companyVanity = jobShopData?.jobShopCompanyVanity
    || findNuxtPropertyValue(nuxtArr, 'jobShopVanity')
    || findNuxtPropertyValue(nuxtArr, 'jobShopCompanyVanity');
  const tenantId = findNuxtPropertyValue(nuxtArr, 'tenantId') || companyVanity;
  if (!companyVanity || !tenantId) return null;

  const url = new URL(TYPESENSE_API_KEY_URL);
  url.searchParams.set('filter', `backoffice_vanity:${companyVanity}`);
  const response = await fetchJson(url.href, {
    headers: {
      Accept: 'application/json',
      'X-Tenant-Id': String(tenantId),
    },
    label: `${HOCHGEBIRGSKLINIK_DAVOS_KEY} Typesense key`,
  });
  const apiKey = response?.key;
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('Hochgebirgsklinik Davos: search/api-key endpoint returned no Typesense API key');
  }
  return apiKey;
}

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
export async function fetchTypesenseApiKey() {
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
    if (!res.ok) throw new Error(`HTTP ${res.status} from career page`);
    const html = await res.text();

    // Extract __NUXT_DATA__ JSON array
    const nuxtMatch = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!nuxtMatch) throw new Error('__NUXT_DATA__ not found in career page HTML');

    const nuxtArr = JSON.parse(nuxtMatch[1]);

    const apiKey = extractTypesenseApiKeyFromNuxtData(nuxtArr);

    if (apiKey) {
      console.log(`  🔑 Extracted Typesense API key (${apiKey.length} chars)`);
      return apiKey;
    }

    // The current job-shop Nuxt client refreshes the key through this endpoint
    // when the SSR payload contains a null ref. Follow the same public client
    // contract instead of treating a valid-but-keyless page as a parser break.
    console.warn('  ⚠️ Nuxt payload has no usable Typesense key; refreshing it through the public job-shop API');
    const refreshedKey = await fetchTypesenseApiKeyFromSearchApi(nuxtArr);
    if (refreshedKey) {
      console.log(`  🔑 Refreshed Typesense API key (${refreshedKey.length} chars)`);
      return refreshedKey;
    }

    const keyProp = `typesenseApiKey-${JOB_SHOP_ID}`;
    throw new Error(`NUXT_DATA: ${keyProp} not found and public key refresh metadata is unavailable (array has ${nuxtArr.length} entries)`);
  } finally {
    clearTimeout(timer);
  }
}

/* ── Typesense Search ────────────────────────────────────── */

/**
 * Query the Typesense "offers" collection via the job-shop.com proxy.
 * Returns an array of Typesense document objects.
 */
async function fetchJobListings(apiKey) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  return fetchWithRetry(async () => {
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
            per_page: TYPESENSE_PAGE_CAP,
          }],
        }),
      });

      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from Typesense API`);
        err.status = res.status;
        err.retryable = RETRYABLE_STATUS.has(res.status);
        throw err;
      }

      const data = await res.json();
      const results = data?.results?.[0];
      if (!results) throw new Error('No results in Typesense response');

      const hits = assertJsonListShape(results, { key: 'hits', source: HOCHGEBIRGSKLINIK_DAVOS_KEY });
      console.log(`  📊 Typesense found: ${results.found} jobs, returned: ${hits.length}`);
      warnIfListingAtCap({ label: 'Hochgebirgsklinik Davos listing', count: hits.length, cap: TYPESENSE_PAGE_CAP, total: results.found });
      return hits.map((h) => h.document);
    } finally {
      clearTimeout(timer);
    }
  }, { label: `${HOCHGEBIRGSKLINIK_DAVOS_KEY} Typesense search` });
}

/**
 * Run the offer search, refreshing the scoped Typesense API key once on an
 * HTTP 401 before giving up — same vendor (`api.my-job-shop.com`) and same
 * failure class as Hornbach's crawler (#4556, recurring: #3688/#3940/#4319).
 * Mirrors the retry-once-on-401 idiom in `microsoft-job-parser.mjs`'s
 * `pcsGetJson` and `hornbach-job-parser.mjs`'s `fetchOfferDocumentsWithKeyRetry`.
 *
 * @param {string} apiKey
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function fetchJobListingsWithKeyRetry(apiKey) {
  try {
    return await fetchJobListings(apiKey);
  } catch (err) {
    if (err?.status !== 401) throw err;
    console.warn('⚠️ Hochgebirgsklinik Davos Typesense search got HTTP 401 (stale scoped key) — refreshing key and retrying once');
    const freshKey = await fetchTypesenseApiKey();
    return fetchJobListings(freshKey);
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
  const documents = await fetchJobListingsWithKeyRetry(apiKey);
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
    const canton = inferAnyCanton(location) || 'GR';

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
