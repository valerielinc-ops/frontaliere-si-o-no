#!/usr/bin/env node
/**
 * Spital Thurgau (STGAG) job parser — embedded JSON in Typo3 page.
 *
 * Public career landing: https://www.stgag.ch/karriere/bildung-karriere/
 *   The /jobs/ index page (https://www.stgag.ch/jobs/) is rendered server-side
 *   by Typo3 + an Angular frontend (`comsolit.angular.frontend`). The full
 *   list of vacancies is embedded inline as a `<script data-name="jobs"
 *   type="application/json" class="embedded-json-data">` block; the Angular
 *   bundle reads it via `getEmbeddedJson` (no API call to fetch jobs).
 *
 * Embedded JSON shape:
 *   { count: 157, jobs: "<stringified array of {id,title,workplace,...}>" }
 * Each entry has:
 *   id, title, workplace, secondWorkplace, department, departmentId,
 *   contractType ("Befristet" | "Unbefristet"), employment ("Teilzeit" |
 *   "Vollzeit"), startDate, branchId, branchName, publishDate, applicationUrl,
 *   detailUrl, onlineSince, timestamp.
 *
 * Detail/Apply URLs point to the Umantis tenant `rekrutierung.stgag.ch`
 * (private subdomain CNAME for an Umantis recruiting app — same vendor as
 * KSA, but tenant ID is hidden behind the public hostname).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSpitalThurgauJobs()  — Fetch and parse all jobs
 *   - isSpitalThurgauJob()         — Match jobs belonging to STGAG
 *   - isTrustedDomain()            — Validate URLs belong to STGAG
 *   - SPITAL_THURGAU_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { slugify, normalizeSpace } from './crawler-template.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SPITAL_THURGAU_KEY = 'spital-thurgau';
export const SPITAL_THURGAU_COMPANY_NAME = 'Spital Thurgau (STGAG)';
export const SPITAL_THURGAU_COMPANY_DOMAIN = 'stgag.ch';

const LISTING_URL = 'https://www.stgag.ch/jobs/';
const PUBLIC_CAREER_URL = 'https://www.stgag.ch/karriere/bildung-karriere/';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isSpitalThurgauJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SPITAL_THURGAU_KEY ||
    key === 'stgag' ||
    key.startsWith('spital-thurgau') ||
    company.includes('spital thurgau') ||
    company.includes('stgag') ||
    url.includes('stgag.ch') ||
    url.includes('rekrutierung.stgag.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'stgag.ch' ||
      host.endsWith('.stgag.ch') ||
      host === 'rekrutierung.stgag.ch'
    );
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics ─────────── */

function detectCategory(title = '', department = '', branchName = '') {
  const signal = `${normalize(title)} ${normalize(department)} ${normalize(branchName)}`;
  if (/\b(pflege|pflegefach|stationsleitung|fage|fachperson gesundheit|spitex|hebamme)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|chirurg|anästhes|notfall|onkolog|kardiolog|neurolog|psychiatr|psycholog)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(ops|operation|lagerung)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(apothek|pharma)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(radiolog|röntgen|mtra|mrt)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(physiother|ergo|logopäd|rehabilit)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa)/.test(signal)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance|elektr|install)/.test(signal)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(signal)) return 'IT';
  if (/\b(admin|segret|buchhalt|sachbearbeiter|account|finanz|controll)/.test(signal)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(signal)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie)/.test(signal)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(signal)) return 'Logistica';
  if (/\b(market|kommunik)/.test(signal)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|doktorand)/.test(signal)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '', contractType = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|intern|apprendist|lehrling|lernend|doktorand|ausbildung)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|chefarzt)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(employment = '', title = '') {
  const t = normalize(employment || title);
  if (/teilzeit|part.?time/.test(t)) return 'PART_TIME';
  if (/vollzeit|full.?time/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/**
 * Map STGAG `workplace` to a Swiss canton. STGAG runs sites in Münsterlingen
 * (TG), Frauenfeld (TG), Romanshorn (TG), Weinfelden (TG) and other Thurgau
 * locations — every workplace on this domain is in canton TG.
 */
function pickCanton() {
  return 'TG';
}

/**
 * Pick the best-effort city from the workplace string. STGAG returns values
 * like "Spital Münsterlingen" or "Psychiatriezentrum, Romanshorn". We try
 * the comma-separated tail first, then fall back to a known-city scan, then
 * to "Münsterlingen" (HQ).
 */
function pickCity(workplace = '') {
  const ws = String(workplace || '').trim();
  if (!ws) return 'Münsterlingen';
  const commaTail = ws.split(',').pop().trim();
  if (commaTail && /^[A-Za-zÄÖÜäöüß'\- ]{3,}$/.test(commaTail)) return commaTail;
  const cities = ['Münsterlingen', 'Frauenfeld', 'Romanshorn', 'Weinfelden', 'Kreuzlingen', 'Amriswil', 'Arbon'];
  const found = cities.find((c) => ws.includes(c));
  return found || 'Münsterlingen';
}

function pickPostalCode(city = '') {
  switch (String(city || '').toLowerCase()) {
    case 'münsterlingen': return '8596';
    case 'frauenfeld': return '8500';
    case 'romanshorn': return '8590';
    case 'weinfelden': return '8570';
    case 'kreuzlingen': return '8280';
    case 'amriswil': return '8580';
    case 'arbon': return '9320';
    default: return '8596';
  }
}

/**
 * Parse "DD.MM.YYYY" into ISO date "YYYY-MM-DD".
 * Returns today's date when input is missing or malformed.
 */
function parseSwissDate(raw = '') {
  const m = String(raw || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return new Date().toISOString().split('T')[0];
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

/* ── Embedded-JSON Parser ─────────────────────────────────── */

/**
 * Parse the embedded `<script data-name="jobs" type="application/json">`
 * block out of the Typo3 HTML and return the array of raw job records.
 */
export function parseStgagEmbeddedJson(html = '') {
  const m = html.match(
    /<script[^>]*data-name="jobs"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!m) return [];
  let outer;
  try {
    outer = JSON.parse(m[1]);
  } catch {
    return [];
  }
  // STGAG double-encodes: outer.jobs is a JSON string, not an array.
  if (typeof outer?.jobs === 'string') {
    try {
      const arr = JSON.parse(outer.jobs);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(outer?.jobs) ? outer.jobs : [];
}

/* ── HTTP Fetch ───────────────────────────────────────────── */

async function fetchPage(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
        'Accept-Language': 'de-CH,de;q=0.9',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Main Fetch Function ──────────────────────────────────── */

export async function fetchAllSpitalThurgauJobs() {
  console.log(`🏥 Fetching ${SPITAL_THURGAU_COMPANY_NAME} jobs`);
  console.log(`   Source:        ${LISTING_URL}`);
  console.log(`   Public career: ${PUBLIC_CAREER_URL}\n`);

  let html;
  try {
    html = await fetchPage(LISTING_URL);
  } catch (err) {
    console.error(`❌ Failed to fetch /jobs/ page: ${err?.message}`);
    return [];
  }

  const records = parseStgagEmbeddedJson(html);
  if (records.length === 0) {
    console.warn('⚠️ No embedded job data found in the page.');
    return [];
  }
  console.log(`  📋 Embedded jobs: ${records.length}\n`);

  const jobs = [];
  const seen = new Set();
  for (const rec of records) {
    if (rec?.type && rec.type !== 'job') continue;
    const id = String(rec?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const title = normalizeSpace(String(rec?.title || ''));
    if (!title || title.length < 3) continue;

    const workplace = normalizeSpace(String(rec?.workplace || rec?.secondWorkplace || ''));
    const department = normalizeSpace(String(rec?.department || ''));
    const branchName = normalizeSpace(String(rec?.branchName || ''));
    const employment = normalizeSpace(String(rec?.employment || ''));
    const contractType = normalizeSpace(String(rec?.contractType || ''));

    const city = pickCity(workplace);
    const canton = pickCanton();

    const detailUrl = String(rec?.detailUrl || '').trim()
      || `https://rekrutierung.stgag.ch/Vacancies/${id}/Description/1?lang=ger`;
    const applyUrl = String(rec?.applicationUrl || '').trim()
      || `https://rekrutierung.stgag.ch/Vacancies/${id}/Application/CheckLogin/1?lang=ger`;

    const descBits = [];
    if (workplace) descBits.push(`• Standort: ${workplace}`);
    if (department) descBits.push(`• Abteilung: ${department}`);
    if (branchName) descBits.push(`• Bereich: ${branchName}`);
    if (employment) descBits.push(`• Pensum: ${employment}`);
    if (contractType) descBits.push(`• Anstellungsverhältnis: ${contractType}`);
    if (rec?.startDate) descBits.push(`• Eintrittsdatum: ${rec.startDate}`);
    const descriptionText = descBits.length
      ? `${title} — ${SPITAL_THURGAU_COMPANY_NAME}.\n\n${descBits.join('\n')}`
      : `${title} — ${SPITAL_THURGAU_COMPANY_NAME}, ${city}`;

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} stgag ch`);
    const urlHash = createHash('sha1')
      .update(`stgag-vacancy-${id}`)
      .digest('hex')
      .slice(0, 12);

    const employmentType = detectEmploymentType(employment, title);
    const contract = /teilzeit/i.test(employment) ? 'part-time' : 'full-time';

    const job = {
      id: `spital-thurgau-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SPITAL_THURGAU_COMPANY_NAME,
      companyKey: SPITAL_THURGAU_KEY,
      companyDomain: SPITAL_THURGAU_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: city,
      canton,
      url: detailUrl,
      source: 'STGAG Dedicated Parser (embedded JSON @ stgag.ch/jobs/)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: city,
      addressRegion: canton,
      postalCode: pickPostalCode(city),
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, department, branchName),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title, contractType),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: parseSwissDate(rec?.publishDate || rec?.onlineSince || ''),
      applyUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (department) job.department = department;
    if (contractType) job.contractDuration = /^befristet$/i.test(contractType) ? 'fixed-term' : 'permanent';

    jobs.push(job);
  }

  console.log(`\n📋 Total ${SPITAL_THURGAU_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
