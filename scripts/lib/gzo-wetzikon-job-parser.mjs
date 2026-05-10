#!/usr/bin/env node
/**
 * GZO Spital Wetzikon job parser — PastaHR / publicjobs.ch widget API.
 *
 * The career page https://www.gzo.ch/karriere/offene-stellen embeds a
 * PastaHR job widget (publicjobs.ch). The widget POSTs to:
 *   https://www.publicjobs.ch/widget
 * with a form-encoded payload that includes `searchHash` (the per-channel
 * filter), `page`, `limit`, and a few presentation flags. The endpoint
 * returns JSON of the form:
 *   {
 *     success: true,
 *     next_limit_from: <int>,
 *     previous_limit_from: <int|"">,
 *     data: [
 *       {
 *         job_detail_url: "https://www.publicjobs.ch/jobs/.../~jobNNNNNN?ext",
 *         job_title: "...",
 *         job_booking_start: "DD.MM.YYYY",
 *         job_start_date: "...",
 *         org_name: "GZO Spital Wetzikon",
 *         org_city: "Wetzikon ZH",
 *         org_logo_url: "..."
 *       }, ...
 *     ]
 *   }
 *
 * Channel hash for GZO is sourced from the widget config inline-script in
 * /karriere/offene-stellen (`searchHash : "channela19f8a4ce869a1e524b201490cb11b6e"`).
 *
 * Listings ship only the title + city + detail URL — descriptions live on
 * publicjobs.ch detail pages and we keep this parser to listing-only data
 * (consistent with KSW / Inselspital where detail pages also need scraping
 * we deliberately defer). The detail URL is included so users can click
 * through to publicjobs.ch.
 *
 * GZO HQ: Spitalstrasse 66, 8620 Wetzikon, ZH.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllGzoWetzikonJobs() — Fetch all jobs (paginated)
 *   - isGzoWetzikonJob()        — Match jobs belonging to GZO
 *   - isTrustedDomain()         — Validate URLs belong to GZO / publicjobs.ch
 *   - GZO_WETZIKON_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { slugify, stripHtml } from './crawler-template.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const GZO_WETZIKON_KEY = 'gzo-wetzikon';
export const GZO_WETZIKON_COMPANY_NAME = 'GZO Spital Wetzikon';
export const GZO_WETZIKON_COMPANY_DOMAIN = 'gzo.ch';

const PASTAHR_ENDPOINT = 'https://www.publicjobs.ch/widget';
const PASTAHR_SEARCH_HASH = 'channela19f8a4ce869a1e524b201490cb11b6e';
const PASTAHR_REFERER = 'https://www.gzo.ch/';

const PAGE_SIZE = 50;
const MAX_PAGES = 10;

const PUBLIC_CAREER_URL = 'https://www.gzo.ch/karriere/offene-stellen';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(html = '') {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&uuml;/g, 'ü')
    .replace(/&ouml;/g, 'ö')
    .replace(/&auml;/g, 'ä')
    .replace(/&Uuml;/g, 'Ü')
    .replace(/&Ouml;/g, 'Ö')
    .replace(/&Auml;/g, 'Ä')
    .replace(/&eacute;/g, 'é')
    .replace(/&egrave;/g, 'è')
    .replace(/&szlig;/g, 'ß')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—');
}

/* ── Company Matchers ──────────────────────────────────────── */

export function isGzoWetzikonJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === GZO_WETZIKON_KEY ||
    key.startsWith('gzo') ||
    company.includes('gzo') ||
    company.includes('spital wetzikon') ||
    url.includes('gzo.ch') ||
    (url.includes('publicjobs.ch') && url.includes('wetzikon'))
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'gzo.ch' ||
      host.endsWith('.gzo.ch') ||
      host === 'www.publicjobs.ch' ||
      host === 'publicjobs.ch' ||
      host.endsWith('.publicjobs.ch')
    );
  } catch {
    return false;
  }
}

/* ── Category / experience / employment heuristics ─────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(pflege|pflegefach|stationsleitung|fage|fachperson gesundheit|spitex|hebamme|nachtwache)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|chirurg|anästhes|notfall|onkolog|kardiolog|neurolog|gastroenterolog)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(ops|operation|lagerung)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(apothek|pharma)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(radiolog|röntgen|mtra|mrt)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(physiother|ergo|logopäd|rehabilit)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa|check-?in|empfang|notfallaufnahme)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance)/.test(t)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(t)) return 'IT';
  if (/\b(admin|segret|buchhalt|sachbearbeiter|account|finanz|controll)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie|haus.?dienst)/.test(t)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(t)) return 'Logistica';
  if (/\b(market|kommunik)/.test(t)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|doktorand)/.test(t)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|doktorand|phd)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|chefarzt)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(title = '') {
  const t = normalize(title);
  if (/teilzeit/.test(t)) return 'PART_TIME';
  if (/vollzeit/.test(t)) return 'FULL_TIME';
  const pctMatch = t.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2], 10) : parseInt(pctMatch[1], 10);
    return maxPct < 80 ? 'PART_TIME' : 'FULL_TIME';
  }
  return 'OTHER';
}

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

/* ── PastaHR / publicjobs.ch widget client ─────────────────── */

async function fetchPastaHrPage(page = 1) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // PastaHR widget POST contract — keys are the same the in-browser
  // `buildRequestData()` sends. Empty fields are tolerated.
  const params = new URLSearchParams();
  params.set('searchHash', PASTAHR_SEARCH_HASH);
  params.set('page', String(page));
  params.set('limit', String(PAGE_SIZE));
  params.set('language', 'de');
  params.set('dateFormat', 'DD.MM.YYYY');
  params.set('searchQuery', '');

  try {
    const res = await fetch(PASTAHR_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': USER_AGENT,
        'X-Requested-With': 'XMLHttpRequest',
        Referer: PASTAHR_REFERER,
        Origin: 'https://www.gzo.ch',
      },
      body: params.toString(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${PASTAHR_ENDPOINT}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Walk PastaHR pages until either:
 *   - the response yields fewer rows than `limit` (last page), or
 *   - we hit MAX_PAGES (safety cap).
 */
async function fetchAllPastaHrJobs() {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    console.log(`  📄 Fetching page=${page} (limit=${PAGE_SIZE})...`);
    const data = await fetchPastaHrPage(page);
    const items = Array.isArray(data?.data) ? data.data : [];
    if (items.length === 0) break;
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, 350));
  }
  console.log(`  ✓ Total PastaHR rows: ${all.length}`);
  return all;
}

/* ── Date helper ──────────────────────────────────────────── */

function parseSwissDate(raw = '') {
  // Listings carry "DD.MM.YYYY" (and a stray leading "1" we observed —
  // e.g. "129.05.2026"). Be defensive: strip anything that isn't
  // \d{1,2}.\d{1,2}.\d{2,4}, then parse.
  const trimmed = String(raw || '').trim().replace(/^1(\d{2}\.)/, '$1');
  const m = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (!m) return null;
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${yyyy}-${mm}-${dd}`;
}

/* ── Main Fetch Function ──────────────────────────────────── */

export async function fetchAllGzoWetzikonJobs() {
  console.log(`🏥 Fetching ${GZO_WETZIKON_COMPANY_NAME} jobs`);
  console.log(`   Source:        ${PASTAHR_ENDPOINT} (channel ${PASTAHR_SEARCH_HASH})`);
  console.log(`   Public career: ${PUBLIC_CAREER_URL}\n`);

  const rows = await fetchAllPastaHrJobs();
  if (!rows || rows.length === 0) {
    console.warn('⚠️ No job listings returned from PastaHR widget API.');
    return [];
  }

  const jobs = [];
  const seenUrls = new Set();

  for (const row of rows) {
    const titleRaw = String(row?.job_title || '').trim();
    const title = normalizeSpace(decodeEntities(stripHtml(titleRaw)));
    if (!title || title.length < 3) continue;

    const detailUrl = String(row?.job_detail_url || '').trim();
    if (!detailUrl) continue;
    if (seenUrls.has(detailUrl)) continue;
    seenUrls.add(detailUrl);

    // Filter to GZO postings only — the channel hash *should* already
    // restrict to GZO, but defensive matching keeps cross-tenant
    // contamination out (`org_name` is the authoritative source).
    const orgName = normalizeSpace(decodeEntities(String(row?.org_name || '')));
    if (orgName && !/gzo|wetzikon/i.test(orgName)) continue;

    const orgCity = normalizeSpace(decodeEntities(String(row?.org_city || '')));
    const location = orgCity.replace(/\s+ZH$/i, '').trim() || 'Wetzikon';
    const canton = 'ZH';

    const sourceLang = 'de';
    const jobSlug = slugify(`${title} ${GZO_WETZIKON_KEY} ch`);
    const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);

    const pensum = extractPensum(title);
    const employmentType = detectEmploymentType(title);
    const contract = pensum && pensum.max < 80 ? 'part-time' : 'full-time';

    const postedDate = parseSwissDate(row?.job_booking_start || '')
      || new Date().toISOString().split('T')[0];

    const fallbackDesc = `${title} — ${GZO_WETZIKON_COMPANY_NAME}, ${location}`;

    const job = {
      // ── Required fields ──
      id: `${GZO_WETZIKON_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: GZO_WETZIKON_COMPANY_NAME,
      companyKey: GZO_WETZIKON_KEY,
      companyDomain: GZO_WETZIKON_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: fallbackDesc,
      descriptionByLocale: { [sourceLang]: fallbackDesc },
      location,
      canton,
      url: detailUrl,
      source: `${GZO_WETZIKON_COMPANY_NAME} Dedicated Parser (PastaHR / publicjobs.ch)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      postalCode: '8620',
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title),
      contract,
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (pensum) {
      job.pensumMin = pensum.min;
      job.pensumMax = pensum.max;
      job.pensum = pensum.min === pensum.max
        ? `${pensum.min}%`
        : `${pensum.min} - ${pensum.max}%`;
    }

    jobs.push(job);
  }

  console.log(`\n📋 Total ${GZO_WETZIKON_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
