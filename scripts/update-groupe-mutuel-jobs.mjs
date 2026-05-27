#!/usr/bin/env node
/**
 * Dedicated Groupe Mutuel crawler runner.
 *
 * Groupe Mutuel is a major Swiss insurance company headquartered in
 * Martigny (Canton Valais, VS). They operate across insurance, healthcare,
 * IT, finance, and customer service.
 *
 * The Groupe Mutuel careers site uses Cornerstone OnDemand (CSOD):
 *   - Portal: https://groupemutuel.csod.com/ux/ats/careersite/4/home?c=groupemutuel
 *   - Auth:   JWT token embedded in career portal HTML
 *   - Search: GET /rec-job-search/external?q=&c=groupemutuel&lang=fr-FR
 *
 * Discovery flow:
 *   1. Fetch career portal page to acquire JWT token + session cookies
 *   2. Query CSOD search API with JWT bearer auth (paginated)
 *   3. Build job objects with canonical CSOD URLs
 *   4. Merge into data/jobs.json (add new, update existing, prune stale)
 *   5. Run the base crawler for AI localization (4 locales)
 *   6. Post-process: fix company name, location, canton
 *   7. Validate locale coverage across IT/EN/DE/FR
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  printPublishedJobUrls,
  writeJobsSummary,
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  setCrawlerStartTime,
  getCrawlerElapsedMs,
} from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { validateJobUrls } from './lib/validate-job-url.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  mergeLocaleTextMap,
  detectLang,
} from './lib/dedicated-crawler-common.mjs';
import {  inferSwissTargetCanton, inferAnyCanton  } from './lib/target-swiss-locations.mjs';
import { isTargetCanton, TARGET_CANTONS, COMPANY_HQ } from './lib/crawler-location-config.mjs';
import { isSlugStable } from './lib/dedicated-crawler-common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const GROUPE_MUTUEL_KEY = 'groupe-mutuel';
const GROUPE_MUTUEL_COMPANY_NAME = 'Groupe Mutuel';
const GROUPE_MUTUEL_HOST = 'groupemutuel.csod.com';
const GROUPE_MUTUEL_COMPANY_DOMAIN = 'groupemutuel.ch';
const CSOD_CAREER_URL = 'https://groupemutuel.csod.com/ux/ats/careersite/4/home?c=groupemutuel&lang=fr-FR';
const CSOD_CAREER_SITE_ID = '4';
const CSOD_CULTURE_ID = 13; // fr-FR
const LOCALES = ['it', 'en', 'de', 'fr'];

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function slugify(text = '', suffix = '') {
  let s = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) s = `${s}-${suffix}`.replace(/--+/g, '-');
  return s.slice(0, 200);
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isGroupeMutuelJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === GROUPE_MUTUEL_KEY ||
    key.startsWith('groupe-mutuel') ||
    company.includes('groupe mutuel') ||
    url.includes('groupemutuel.csod.com') ||
    url.includes('groupemutuel.ch')
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === GROUPE_MUTUEL_HOST ||
      host.endsWith('.groupemutuel.ch') ||
      host === 'groupemutuel.ch' ||
      host.endsWith('.csod.com')
    );
  } catch {
    return false;
  }
}

/* ── CSOD Authentication ───────────────────────────────────── */

/**
 * Acquire JWT token and session cookies from the CSOD career portal page.
 * The JWT is embedded in the HTML response.
 */
async function acquireToken() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  console.log(`🔑 Acquiring CSOD JWT token from career portal...`);
  console.log(`   URL: ${CSOD_CAREER_URL}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(CSOD_CAREER_URL, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);
  } catch (err) {
    clearTimeout(timer);
    console.warn(`⚠️ Failed to fetch CSOD career portal: ${err.message}`);
    return null;
  }

  if (!response.ok) {
    console.warn(`⚠️ CSOD career portal returned HTTP ${response.status}`);
    return null;
  }

  // Extract cookies from response
  const setCookieHeaders = response.headers.getSetCookie?.() || [];
  const cookieString = setCookieHeaders.map(c => c.split(';')[0]).join('; ');

  const html = await response.text();

  // Primary pattern: "token":"eyJ..."
  let tokenMatch = html.match(/"token"\s*:\s*"(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/);

  // Fallback pattern: token in script data or config object
  if (!tokenMatch) {
    tokenMatch = html.match(/["']token["']\s*:\s*["'](eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)["']/);
  }

  // Fallback: look for bearer token in any context
  if (!tokenMatch) {
    tokenMatch = html.match(/Bearer\s+(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
  }

  if (!tokenMatch) {
    console.warn('⚠️ Failed to extract CSOD JWT token from career portal HTML.');
    console.warn('   The HTML may have changed format or the portal may be down.');
    return null;
  }

  const token = tokenMatch[1];
  console.log(`  ✅ JWT token acquired (${token.length} chars)`);
  if (cookieString) {
    console.log(`  🍪 Session cookies captured (${setCookieHeaders.length} cookies)`);
  }

  // Extract cloud API base from csod.context endpoints
  const cloudMatch = html.match(/"cloud"\s*:\s*"(https?:\/\/[^"]+)"/);
  const cloudApiBase = cloudMatch?.[1] || 'https://eu-fra.api.csod.com/';
  console.log(`  ☁️  Cloud API: ${cloudApiBase}`);

  return { token, cookies: cookieString, cloudApiBase };
}

/* ── CSOD Search API ───────────────────────────────────────── */

async function fetchWithAuth(url, token, cookies, options = {}) {
  const timeoutMs = options.timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'User-Agent': USER_AGENT,
        ...(cookies ? { Cookie: cookies } : {}),
        ...options.headers,
      },
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Search CSOD for all job listings using the cloud API (POST).
 * CSOD migrated from GET on the portal host to POST on the cloud API.
 * Returns null if token expired (caller should re-acquire).
 */
async function searchJobs(token, cookies, cloudApiBase = 'https://eu-fra.api.csod.com/') {
  const allJobs = [];
  let pageNumber = 1;
  const pageSize = 25;
  let retries = 0;

  // Ensure trailing slash
  const apiBase = cloudApiBase.endsWith('/') ? cloudApiBase : cloudApiBase + '/';
  const searchUrl = `${apiBase}rec-job-search/external/jobs`;

  while (true) {
    const body = JSON.stringify({
      careerSiteId: Number(CSOD_CAREER_SITE_ID),
      careerSitePageId: Number(CSOD_CAREER_SITE_ID),
      pageNumber,
      pageSize,
      cultureId: CSOD_CULTURE_ID,
      searchText: '',
      cultureName: 'fr-FR',
      states: [],
      countryCodes: [],
      cities: [],
      placeID: '',
      radius: null,
      postingsWithinDays: null,
      customFieldCheckboxKeys: [],
      customFieldDropdowns: [],
      customFieldRadios: [],
    });

    console.log(`  📄 Fetching page ${pageNumber}...`);
    let response = await fetchWithAuth(searchUrl, token, cookies, {
      method: 'POST',
      body,
      headers: {
        'csod-accept-language': 'fr-FR',
        'Referer': 'https://groupemutuel.csod.com/',
      },
    });

    if (!response) {
      console.warn('⚠️ No response from CSOD cloud API');
      break;
    }

    if (response.status === 401) {
      console.warn('⚠️ CSOD token expired (HTTP 401)');
      return null; // Signal to re-acquire
    }

    if (!response.ok) {
      console.warn(`⚠️ CSOD API returned HTTP ${response.status}`);
      if (retries < 2) {
        retries++;
        console.log(`  🔄 Retrying (${retries}/2)...`);
        await new Promise(r => setTimeout(r, 2000 * retries));
        continue;
      }
      break;
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      console.warn(`⚠️ Failed to parse JSON response: ${err.message}`);
      break;
    }

    // New CSOD API: { status, data: { totalCount, requisitions[] } }
    const innerData = data?.data || data;
    const jobs = innerData?.requisitions || innerData?.data || data?.jobPostings || data?.results || data?.items || [];
    if (!Array.isArray(jobs)) {
      console.warn('⚠️ Unexpected response format — no job array found');
      console.warn(`   Response keys: ${Object.keys(data || {}).join(', ')}`);
      if (data?.data) console.warn(`   data keys: ${Object.keys(data.data).join(', ')}`);
      break;
    }

    allJobs.push(...jobs);

    const total = innerData?.totalCount || data?.total || data?.totalCount || data?.totalResults || 0;
    console.log(`  📋 Fetched ${jobs.length} jobs (total so far: ${allJobs.length}/${total || '?'})`);

    if (total > 0 && allJobs.length >= total) break;
    if (jobs.length < pageSize) break;
    if (jobs.length === 0) break;

    pageNumber++;
    retries = 0;

    // Rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  return allJobs;
}

/* ── Location & canton mapping ─────────────────────────────── */

function parseCsodLocation(rawLocation = '') {
  const cleaned = String(rawLocation || '').trim();
  if (!cleaned) return '';

  // CSOD locations may be formatted as "City, Country" or "City - Region" or just "City"
  const parts = cleaned.split(/\s*[,\-–]\s*/);
  return parts[0].trim();
}

function inferCanton(location = '') {
  // First try the shared utility
  const canton = inferAnyCanton(location);
  if (canton) return canton;

  const loc = normalize(location);

  // Groupe Mutuel primary locations
  if (loc.includes('martigny')) return 'VS';
  if (loc.includes('sion') || loc.includes('sitten')) return 'VS';
  if (loc.includes('sierre') || loc.includes('siders')) return 'VS';
  if (loc.includes('monthey')) return 'VS';
  if (loc.includes('visp') || loc.includes('viège')) return 'VS';
  if (loc.includes('brig') || loc.includes('brigue')) return 'VS';
  if (loc.includes('naters')) return 'VS';
  if (loc.includes('valais') || loc.includes('wallis')) return 'VS';

  // Other Swiss cities
  if (loc.includes('lausanne') || loc.includes('vevey') || loc.includes('montreux') || loc.includes('nyon') || loc.includes('morges')) return 'VD';
  if (loc.includes('genev') || loc.includes('genèv') || loc.includes('genf')) return 'GE';
  if (loc.includes('fribourg') || loc.includes('freiburg') || loc.includes('bulle')) return 'FR';
  if (loc.includes('neuchâtel') || loc.includes('neuchatel') || loc.includes('neuenburg')) return 'NE';
  if (loc.includes('bern') || loc.includes('berne')) return 'BE';
  if (loc.includes('zurich') || loc.includes('zürich')) return 'ZH';
  if (loc.includes('basel') || loc.includes('bâle')) return 'BS';
  if (loc.includes('luzern') || loc.includes('lucerne')) return 'LU';
  if (loc.includes('lugano') || loc.includes('chiasso') || loc.includes('bellinzona') || loc.includes('locarno') || loc.includes('mendrisio')) return 'TI';

  return '';
}

/* ── Job building ──────────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  // Insurance-specific categories
  if (/assicuraz|versicherung|insurance|assurance|pr[ée]voyance/i.test(t)) return 'insurance';
  if (/actuari|actuar|attuari|actuaire/i.test(t)) return 'actuarial';
  if (/sinistre|claims|schaden|prestazion|leistung|prestation/i.test(t)) return 'claims';
  if (/underwrit|souscript|sottoscriz/i.test(t)) return 'underwriting';
  if (/sant[ée]|salute|health|gesundheit|m[ée]decin|m[ée]dic|medic|infirm|pflege|soins/i.test(t)) return 'healthcare';
  if (/customer|client[eè]le|kunden|servizio\s*clienti|service\s*client|beratung|conseill/i.test(t)) return 'customer-service';

  // General categories
  if (/engineer|developer|d[ée]veloppeur|software|architect|devops|cloud|data|cyber|network|infrastructure|informatiq|informatic|it\b|ict|system/i.test(t)) return 'it';
  if (/qa|quality|test|validation|qualit[ée]|qualit[aä]t/i.test(t)) return 'quality';
  if (/analyst|business\s*analyst|analyste/i.test(t)) return 'analysis';
  if (/sales|commercial|pre.?sales|account\s*exec|vente|vendita|verkauf/i.test(t)) return 'sales';
  if (/market|communication|kommunikation|comunicazione/i.test(t)) return 'marketing';
  if (/project|programme|program|scrum|agile|projet|progetto|projekt/i.test(t)) return 'project-management';
  if (/legal|counsel|lawyer|compliance|regulator|juridique|legale|recht/i.test(t)) return 'legal';
  if (/comptab|financ|controller|audit|buchhalt|contabil|tr[ée]sor/i.test(t)) return 'finance';
  if (/hr|human|recruit|people|talent|ressources\s*humaines|risorse\s*umane|personal/i.test(t)) return 'hr';
  if (/support|helpdesk|service\s*desk/i.test(t)) return 'support';
  if (/manag|director|head\b|lead\b|chief|chef\b|vp\b|directeur|direttore|leiter|responsable|responsabile/i.test(t)) return 'management';
  if (/admin|assistant|secr[ée]taire|segretari|sachbearbeit|gestionnaire/i.test(t)) return 'administration';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/junior|jr\.?|entry|intern|stage|stagiaire|stagist|apprenti|graduate|trainee|d[ée]butant|praticien/i.test(t)) return 'ENTRY';
  if (/senior|sr\.?|lead\b|head\b|director|manager|principal|chief|chef\b|vp\b|directeur|directrice|responsable/i.test(t)) return 'SENIOR';
  return 'MID';
}

function detectEmploymentType(rawType = '') {
  const t = normalize(rawType);
  if (t.includes('full') || t.includes('plein') || t.includes('vollzeit') || t.includes('tempo pieno') || t.includes('100%')) return 'FULL_TIME';
  if (t.includes('part') || t.includes('partiel') || t.includes('teilzeit') || t.includes('tempo parziale')) return 'PART_TIME';
  if (t.includes('temporary') || t.includes('temporaire') || t.includes('befristet') || t.includes('temporaneo')) return 'TEMPORARY';
  if (t.includes('intern') || t.includes('stage') || t.includes('praktik')) return 'INTERN';
  return 'FULL_TIME';
}

function buildDescription(title, descriptionText, location) {
  const base = descriptionText || `${title} position at Groupe Mutuel in ${location}, Switzerland.`;
  return `${base}\n\nGroupe Mutuel is one of Switzerland's leading insurance groups, headquartered in Martigny (Valais). The company offers a wide range of insurance and pension products for individuals and businesses across Switzerland.`.trim();
}

function buildDescriptionFr(title, location) {
  return `Poste ouvert chez Groupe Mutuel à ${location}.\nRôle : ${title}.\n\nGroupe Mutuel est l'un des principaux groupes d'assurance en Suisse, dont le siège est à Martigny (Valais). L'entreprise propose une large gamme de produits d'assurance et de prévoyance pour les particuliers et les entreprises dans toute la Suisse.`.trim();
}

function buildPublicUrl(requisitionId) {
  return `https://groupemutuel.csod.com/ux/ats/careersite/${CSOD_CAREER_SITE_ID}/home/requisition/${requisitionId}?c=groupemutuel&lang=fr-FR`;
}

/* ── Fetch and build all Groupe Mutuel jobs ────────────────── */

/**
 * Parse a raw CSOD job listing into a normalized job object.
 * CSOD response fields vary by instance — handle multiple field names.
 */
function parseCsodJob(rawJob) {
  // New CSOD API uses displayJobTitle; old used title/jobTitle
  const title = normalizeSpace(
    rawJob.displayJobTitle || rawJob.title || rawJob.jobTitle || rawJob.requisitionTitle || rawJob.name || ''
  );
  if (!title || title.length < 3) return null;

  const requisitionId = String(
    rawJob.requisitionId || rawJob.id || rawJob.jobId || rawJob.reqId || ''
  );

  // New API: locations is an array of { city, state }
  let city = '';
  if (Array.isArray(rawJob.locations) && rawJob.locations.length > 0) {
    city = rawJob.locations[0].city || '';
  }
  if (!city) {
    const locationRaw = rawJob.location || rawJob.locationName || rawJob.city || rawJob.jobLocation || '';
    city = parseCsodLocation(locationRaw) || 'Martigny';
  }
  if (!city) city = 'Martigny';

  const canton = inferCanton(city);

  // New API: externalDescription; old: description/jobDescription
  const descriptionRaw = rawJob.externalDescription || rawJob.description || rawJob.jobDescription || rawJob.shortDescription || '';
  const descriptionText = stripHtml(descriptionRaw);

  const publicUrl = requisitionId
    ? buildPublicUrl(requisitionId)
    : rawJob.url || rawJob.applyUrl || rawJob.jobDetailUrl || '';

  const descEn = buildDescription(title, descriptionText, city);
  const descFr = buildDescriptionFr(title, city);

  const slug = slugify(title, 'groupe-mutuel');
  const employmentType = detectEmploymentType(rawJob.employmentType || rawJob.timeType || rawJob.type || '');

  // New API: postingEffectiveDate in DD/MM/YYYY format
  let datePosted = rawJob.datePosted || rawJob.postingDate || rawJob.createdDate || rawJob.startDate || '';
  if (!datePosted && rawJob.postingEffectiveDate && rawJob.postingEffectiveDate !== '-') {
    // Convert DD/MM/YYYY → YYYY-MM-DD
    const parts = rawJob.postingEffectiveDate.split('/');
    if (parts.length === 3) {
      datePosted = `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
  }
  if (!datePosted) datePosted = new Date().toISOString().split('T')[0];

  const job = {
    url: publicUrl,
    applyUrl: publicUrl,
    title,
    company: GROUPE_MUTUEL_COMPANY_NAME,
    companyKey: GROUPE_MUTUEL_KEY,
    location: city,
    canton,
    country: 'CH',
    description: descEn,
    descriptionByLocale: {
      en: descEn,
      fr: descFr,
    },
    titleByLocale: {
      fr: title,
    },
    slug,
    slugByLocale: {
      fr: slug,
      en: slugify(title, 'groupe-mutuel'),
    },
    category: detectCategory(title),
    datePosted,
    source: 'groupe-mutuel-csod-crawler',
    sourceLang: detectLang(title, 'fr'),
    employmentType,
    experienceLevel: detectExperienceLevel(title),
    sector: 'Assicurazioni / Sanità',
    _targetScope: { canton, location: city },
  };

  if (requisitionId) job.jobReqId = requisitionId;

  return job;
}

async function fetchGroupeMutuelJobs() {
  console.log(`🔍 Fetching Groupe Mutuel jobs from CSOD API`);
  console.log(`   Portal: ${CSOD_CAREER_URL}`);
  console.log(`   Company: ${GROUPE_MUTUEL_COMPANY_NAME}\n`);

  // Step 1: Acquire JWT token
  let auth = await acquireToken();
  if (!auth) {
    console.warn('⚠️ Could not acquire CSOD JWT token.');
    return [];
  }

  // Step 2: Search for jobs (using cloud API)
  let rawJobs = await searchJobs(auth.token, auth.cookies, auth.cloudApiBase);

  // If token expired, try re-acquiring once
  if (rawJobs === null) {
    console.log('  🔄 Re-acquiring token after expiration...');
    auth = await acquireToken();
    if (!auth) {
      console.warn('⚠️ Token re-acquisition failed.');
      return [];
    }
    rawJobs = await searchJobs(auth.token, auth.cookies, auth.cloudApiBase);
    if (rawJobs === null) {
      console.warn('⚠️ Search failed even after token refresh.');
      return [];
    }
  }

  if (!rawJobs || rawJobs.length === 0) {
    console.warn('⚠️ No job listings returned from CSOD API.');
    return [];
  }

  console.log(`\n  📋 Raw job listings from CSOD: ${rawJobs.length}`);

  // Step 3: Parse each job
  const jobs = [];
  for (const rawJob of rawJobs) {
    const parsed = parseCsodJob(rawJob);
    if (parsed) {
      jobs.push(parsed);
    } else {
      console.log(`  ⏭️  Skipped — empty/short title`);
    }
  }

  console.log(`\n📋 Total unique Groupe Mutuel jobs discovered: ${jobs.length}`);
  return jobs;
}

/* ── Merge into data/jobs.json ─────────────────────────────── */

function canonicalizeUrl(url = '') {
  try {
    return new URL(url).href.replace(/\/$/, '').toLowerCase();
  } catch {
    return normalize(url);
  }
}

function filterEmpty(obj = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
}

async function mergeGroupeMutuelJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(GROUPE_MUTUEL_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonGmJobs = allJobs.filter((j) => !isGroupeMutuelJob(j));
  const existingGmJobs = allJobs.filter(isGroupeMutuelJob);

  const existingByUrl = new Map();
  for (const job of existingGmJobs) {
    existingByUrl.set(canonicalizeUrl(job.url), job);
  }

  const discoveredByUrl = new Map();
  for (const job of discoveredJobs) {
    discoveredByUrl.set(canonicalizeUrl(job.url), job);
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  const merged = [];

  for (const discovered of discoveredJobs) {
    const key = canonicalizeUrl(discovered.url);
    const existingJob = existingByUrl.get(key);

    if (existingJob) {
      const updatedJob = {
        ...existingJob,
        title: discovered.title || existingJob.title,
        company: GROUPE_MUTUEL_COMPANY_NAME,
        companyKey: GROUPE_MUTUEL_KEY,
        location: discovered.location || existingJob.location,
        canton: discovered.canton || existingJob.canton,
        country: 'CH',
        applyUrl: discovered.applyUrl || existingJob.applyUrl,
        category: discovered.category || existingJob.category,
        sector: discovered.sector || existingJob.sector,
        source: 'groupe-mutuel-csod-crawler',
        titleByLocale: mergeLocaleTextMap(existingJob.titleByLocale, discovered.titleByLocale, 3),
        descriptionByLocale: mergeLocaleTextMap(existingJob.descriptionByLocale, discovered.descriptionByLocale, 30),
        slugByLocale: mergeLocaleTextMap(existingJob.slugByLocale, discovered.slugByLocale, 3),
      };

      // Protect slugs from churn when job title language changes
      if (existingJob.slug && discovered.slug && existingJob.slug !== discovered.slug) {
        const locHints = {
          existingLocation: existingJob.location || '',
          newLocation: discovered.location || '',
        };
        if (isSlugStable(existingJob.slug, discovered.slug, locHints)) {
          updatedJob.slug = existingJob.slug;
        } else {
          updatedJob.slug = discovered.slug;
          updatedJob.previousSlugs = [...new Set([
            ...(existingJob.previousSlugs || []),
            existingJob.slug,
          ])];
        }
      }

      // Protect per-locale slugs
      if (existingJob.slugByLocale && updatedJob.slugByLocale) {
        for (const locale of ['it', 'en', 'de', 'fr']) {
          const oldSlug = existingJob.slugByLocale[locale];
          const newSlug = updatedJob.slugByLocale[locale];
          if (oldSlug && newSlug && oldSlug !== newSlug) {
            const locHints = {
              existingLocation: existingJob.location || '',
              newLocation: discovered.location || '',
            };
            if (isSlugStable(oldSlug, newSlug, locHints)) {
              updatedJob.slugByLocale[locale] = oldSlug;
            } else {
              updatedJob.previousSlugs = [...new Set([
                ...(updatedJob.previousSlugs || []),
                ...(existingJob.previousSlugs || []),
                oldSlug,
              ])];
            }
          }
        }
      }

      if (discovered.description && discovered.description.length > (existingJob.description || '').length) {
        updatedJob.description = discovered.description;
      }

      merged.push(updatedJob);
      updated++;
    } else {
      merged.push(discovered);
      added++;
    }
  }

  for (const [url] of existingByUrl) {
    if (!discoveredByUrl.has(url)) removed++;
  }

  const final = [...nonGmJobs, ...merged];

  fs.writeFileSync(DATA_JOBS, JSON.stringify(final, null, 2) + '\n');
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(final, null, 2) + '\n');

  console.log(`\n📦 Merge results:`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
  console.log(`  🗑️  Removed (stale): ${removed}`);
  console.log(`  📊 Total jobs in file: ${final.length}`);

  return { added, updated, removed, total: final.length };
}

/* ── Adapter management ────────────────────────────────────── */

function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${GROUPE_MUTUEL_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = GROUPE_MUTUEL_KEY;
  adapter.companyName = GROUPE_MUTUEL_COMPANY_NAME;
  adapter.companyHost = GROUPE_MUTUEL_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['api'];
  adapter.seedUrls = [CSOD_CAREER_URL];
  adapter.notes = 'Cornerstone OnDemand (CSOD) API at groupemutuel.csod.com — career site ID 4. JWT auth required.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${GROUPE_MUTUEL_KEY} updated.`);
}

/* ── Base crawler (AI localization only) ───────────────────── */

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: GROUPE_MUTUEL_KEY,
    localizeOnlyCompanyKeys: GROUPE_MUTUEL_KEY,
    forceLocalizeKeys: GROUPE_MUTUEL_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '80',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '80',
    },
  });
}

/* ── Post-processing ───────────────────────────────────────── */

function postProcessGroupeMutuelJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isGroupeMutuelJob(job)) continue;

    if (job.company !== GROUPE_MUTUEL_COMPANY_NAME) {
      job.company = GROUPE_MUTUEL_COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== GROUPE_MUTUEL_KEY) {
      job.companyKey = GROUPE_MUTUEL_KEY;
      fixed++;
    }
    job.country = 'CH';
    if (!job.canton && job.location) {
      job.canton = inferCanton(job.location);
      if (job.canton) fixed++;
    }
    if (!job.location) {
      job.location = 'Martigny';
      fixed++;
    }
  }

  if (fixed > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    fs.writeFileSync(PUBLIC_JOBS, JSON.stringify(jobs, null, 2) + '\n');
    console.log(`🔧 Post-processed ${fixed} Groupe Mutuel jobs (fixed company/location/canton).`);
  }
}

/* ── Stats & validation ────────────────────────────────────── */

function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json not found — no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const gmJobs = allJobs.filter(isGroupeMutuelJob);

  console.log(`\n📊 === Groupe Mutuel Job Stats ===`);
  console.log(`  🏢 Total Groupe Mutuel jobs: ${gmJobs.length}`);

  if (gmJobs.length > 0) {
    console.log(`  📋 Jobs:`);
    for (const job of gmJobs) {
      console.log(`     - ${job.title} (${job.location || 'unknown'}, ${job.canton || '??'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(gmJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'Groupe Mutuel');
  writeCrawlChangeSummaryToGH(crawlDiff, 'Groupe Mutuel');
  return { total: gmJobs.length, crawlDiff };
}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_GROUPE_MUTUEL_STRICT',
    label: 'Groupe Mutuel',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isGroupeMutuelJob,
    locales: LOCALES,
    isTrustedDomain: isTrustedDomain,
    untrustedDomainReason: 'url_not_groupe_mutuel_domain',
    failWhenNoJobs: false,
    noJobsMessage: 'No Groupe Mutuel jobs found — the company may not have active openings on CSOD.',
  });
}

/* ── Main ──────────────────────────────────────────────────── */

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(GROUPE_MUTUEL_KEY, 'Groupe Mutuel');
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  Groupe Mutuel — Dedicated Crawler (CSOD)');
  console.log('═══════════════════════════════════════════════');
  console.log(`  CSOD Portal: ${CSOD_CAREER_URL}\n`);

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(GROUPE_MUTUEL_KEY, DATA_JOBS).filter(isGroupeMutuelJob));

  // Phase 1: Fetch jobs from CSOD API
  const discoveredJobs = await fetchGroupeMutuelJobs();

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No Groupe Mutuel jobs discovered.');
    console.log('   The CSOD API may be unreachable or have no active openings.');
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    const _cdResult = logStats(beforeSnapshot);
    crawlDiff = _cdResult.crawlDiff || crawlDiff;
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig();

  // Phase 3: Merge into data/jobs.json
  await mergeGroupeMutuelJobs(discoveredJobs);

  // Phase 4: Run base crawler for AI localization (IT/DE translations)
  console.log('\n🌐 Running base crawler for AI localization of Groupe Mutuel jobs...');
  await runBaseCrawler();

  // Phase 5: Post-process
  postProcessGroupeMutuelJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  if (stats.total === 0) {
    console.log('ℹ️ No Groupe Mutuel jobs found after crawl. No error — exiting OK.');
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ Groupe Mutuel crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isGroupeMutuelJob) : [];
  writeJobsCrawlerSlice(GROUPE_MUTUEL_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: GROUPE_MUTUEL_KEY,
    label: 'Groupe Mutuel',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: crawlDiff.newJobs.length,
    updatedCount: crawlDiff.updatedJobs.length,
    removedCount: crawlDiff.removedJobs.length,
    unchangedCount: crawlDiff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: crawlDiff.newJobs.slice(0, 30),
    updatedJobs: crawlDiff.updatedJobs.slice(0, 30),
    removedJobs: crawlDiff.removedJobs.slice(0, 30),
    unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => {
  console.error(`❌ Groupe Mutuel crawler failed: ${err?.message || err}`);
  process.exit(1);
});
