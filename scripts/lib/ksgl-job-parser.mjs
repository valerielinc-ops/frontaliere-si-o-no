#!/usr/bin/env node
/**
 * Kantonsspital Glarus (KSGL) job parser — Prospective.ch careercenter SSR
 * (tenant 1000665, directlink 1002312002).
 *
 * Public career site: https://www.ksgl.ch/karriere
 *   → published listing platform: https://jobs.ksgl.ch/ (Prospective careercenter
 *     served via https://ohws.prospective.ch/public/v1/careercenter/1000665/)
 *
 * IMPORTANT: KSGL uses Prospective's "careercenter" product, NOT the standard
 * v1 "medium" JSON listing. The `/public/v1/medium/1000665/jobs` endpoint
 * returns HTTP 400, and `/public/v1/careercenter/1000665?lang=...` 301-redirects
 * to an S3 bucket that returns AccessDenied. The ONLY public surface is the
 * server-rendered HTML at `/public/v1/careercenter/1000665/`, which posts back
 * to itself for pagination/filtering (12 jobs per page by default; sending
 * `limit=100` via POST returns all jobs in one page).
 *
 * Strategy:
 *   1. POST `/public/v1/careercenter/1000665/` with `offset=0&limit=200&lang=de`
 *      and parse the resulting HTML for `<a class="platform-item item-N" href="...">`
 *      entries → list of (title, url) pairs.
 *   2. For each detail URL on `jobs.ksgl.ch`, GET the page and extract:
 *      - <script type="application/ld+json"> with `@type: "JobPosting"`
 *        (schema.org gives us location, description, qualifications,
 *        responsibilities, employmentType, datePosted, validThrough, industry)
 *      - <h1 id="title"> as a title fallback
 *
 * Notes:
 *   - The KSGL HTML uses class="platform-item item-N" (different from LUPS which
 *     uses class="job job-N").
 *   - Polite 250ms delay between detail fetches.
 *   - Every ParsedJob carries `needsRetranslation: true` so the AI localization
 *     step fills in fr/it/en.
 */
import { createHash } from 'node:crypto';
import { slugify, stripHtml } from './crawler-template.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const KSGL_KEY = 'ksgl';
export const KSGL_COMPANY_NAME = 'Kantonsspital Glarus (KSGL)';
export const KSGL_COMPANY_DOMAIN = 'ksgl.ch';

const CAREER_URL = 'https://www.ksgl.ch/karriere';
const PROSPECTIVE_TENANT = '1000665';
const LISTING_URL = `https://ohws.prospective.ch/public/v1/careercenter/${PROSPECTIVE_TENANT}/`;
const JOBS_HOST = 'jobs.ksgl.ch';

const DEFAULT_CANTON = 'GL';
const DEFAULT_CITY = 'Glarus';
const DEFAULT_POSTAL = '8750';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';
const FETCH_TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;
const DETAIL_DELAY_MS = 250;

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

async function safeFetch(url, { method = 'GET', body = null, accept = 'text' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: accept === 'json'
      ? 'application/json'
      : 'text/html,application/xhtml+xml,*/*',
  };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    if (!res.ok) {
      console.warn(`   ⚠️ ${method} ${url} → HTTP ${res.status}`);
      return null;
    }
    return accept === 'json' ? await res.json() : await res.text();
  } catch (err) {
    console.warn(`   ⚠️ fetch failed (${method} ${url}): ${err && err.message ? err.message : err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ── Listing parse (HTML → [{title, url}]) ────────────────── */

const LISTING_ITEM_RE =
  /<a\s+class="platform-item item-\d+"\s+href="([^"]+)"\s+title="([^"]+)"/g;

function parseListingHtml(html = '') {
  const items = [];
  const seen = new Set();
  for (const m of html.matchAll(LISTING_ITEM_RE)) {
    const url = normalizeSpace(decodeHtmlEntities(m[1] || ''));
    const title = normalizeSpace(decodeHtmlEntities(m[2] || ''));
    if (!url || !title) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    items.push({ url, title });
  }
  return items;
}

/* ── JSON-LD JobPosting parse ──────────────────────────────── */

const LD_JSON_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function extractJobPostingLd(html = '') {
  for (const m of html.matchAll(LD_JSON_RE)) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Some Prospective pages embed bare-key JSON; skip if it isn't strict JSON.
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of candidates) {
      if (node && (node['@type'] === 'JobPosting' || (Array.isArray(node['@type']) && node['@type'].includes('JobPosting')))) {
        return node;
      }
    }
  }
  return null;
}

function buildDescriptionFromLd(ld = {}) {
  const parts = [];
  const desc = ld.description ? stripHtml(ld.description) : '';
  if (desc) parts.push(desc);
  const resp = ld.responsibilities ? stripHtml(ld.responsibilities) : '';
  if (resp) parts.push(`Aufgaben:\n${resp}`);
  const qual = ld.qualifications ? stripHtml(ld.qualifications) : '';
  if (qual) parts.push(`Anforderungen:\n${qual}`);
  return parts.join('\n\n').trim();
}

/* ── Detail-page title fallback ───────────────────────────── */

const H1_TITLE_RE = /<h1[^>]+id=["']title["'][^>]*>([\s\S]*?)<\/h1>/i;

function extractH1Title(html = '') {
  const m = html.match(H1_TITLE_RE);
  if (!m) return '';
  return normalizeSpace(decodeHtmlEntities(stripHtml(m[1] || '')));
}

/* ── Category & seniority ─────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(pflege|pflegefach|stationsleitung|fage|spitex|nachtwache|geburts|hebamme)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|chirurg|anästhes|onkolog|kardiolog|neurolog|pädiatr|gynäk|psychi|geriatr|radiolog|dermatolog)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse|röntgen|mtra|mrt|physiother|ergo|logopäd|rehabilit|apothek|pharma|ernähr)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa|mfa|fage)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance|elektr)/.test(t)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(t)) return 'IT';
  if (/\b(admin|sekret|buchhalt|sachbearbeiter|finanz|controll|account)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie)/.test(t)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(t)) return 'Logistica';
  if (/\b(market|kommunik)/.test(t)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|werkstudent|studierend)/.test(t)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|intern|lehrling|lernend|apprenti|studierend|unterassist)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent|assistenz)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|chefarzt)/.test(t)) return 'senior';
  return 'mid';
}

function pickEmploymentTypeFromLd(ld = {}, title = '') {
  const raw = String(ld.employmentType || '').trim().toUpperCase();
  if (raw === 'FULL_TIME' || raw === 'PART_TIME' || raw === 'CONTRACTOR'
      || raw === 'TEMPORARY' || raw === 'INTERN' || raw === 'OTHER') {
    return raw;
  }
  const t = normalize(`${ld.employmentType || ''} ${title}`);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein|100\s*%)/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Public matchers ──────────────────────────────────────── */

const TRUSTED_HOSTS = new Set([
  'ksgl.ch',
  'jobs.ksgl.ch',
  'www.ksgl.ch',
]);

export function isKsglJob(job) {
  const key = normalize(job?.companyKey || '');
  const url = normalize(job?.url || '');
  if (key === KSGL_KEY) return true;
  if (url.includes('ksgl.ch')) return true;
  if (url.includes(`/careercenter/${PROSPECTIVE_TENANT}/`)) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (TRUSTED_HOSTS.has(host)) return true;
    if (host.endsWith('.ksgl.ch')) return true;
    if (host === 'ohws.prospective.ch' && rawUrl.includes(`/careercenter/${PROSPECTIVE_TENANT}/`)) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Main entry ───────────────────────────────────────────── */

/**
 * Fetch all Kantonsspital Glarus (KSGL) jobs via Prospective.ch careercenter SSR.
 * Returns ParsedJob[] (source-locale only, needsRetranslation: true).
 */
export async function fetchAllKsglJobs() {
  console.log('🏥 Fetching Kantonsspital Glarus (KSGL) jobs');
  console.log(`   Listing: ${LISTING_URL} (Prospective careercenter ${PROSPECTIVE_TENANT})`);
  console.log(`   Public:  ${CAREER_URL}\n`);

  // Step 1: POST listing with limit=200 to grab every advert in one page.
  const html = await safeFetch(LISTING_URL, {
    method: 'POST',
    body: 'offset=0&limit=200&lang=de',
    accept: 'text',
  });
  if (!html) {
    console.warn('⚠️ Could not fetch KSGL listing — returning [].');
    return [];
  }
  const listings = parseListingHtml(html);
  console.log(`   ✓ Discovered ${listings.length} advert links in listing`);
  if (listings.length === 0) return [];

  // Step 2: fetch each detail page and extract JSON-LD JobPosting.
  const jobs = [];
  for (let i = 0; i < listings.length; i++) {
    const { url, title: listingTitle } = listings[i];
    console.log(`   📄 [${i + 1}/${listings.length}] ${listingTitle.slice(0, 70)}`);
    const detailHtml = await safeFetch(url, { accept: 'text' });
    if (i < listings.length - 1) {
      await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    }
    if (!detailHtml) continue;

    const ld = extractJobPostingLd(detailHtml) || {};
    const rawTitle = String(ld.title || '').trim()
      || extractH1Title(detailHtml)
      || listingTitle;
    const title = normalizeSpace(decodeHtmlEntities(stripHtml(rawTitle)));
    if (!title || title.length < 3) continue;

    const loc = ld.jobLocation?.address || {};
    const location = normalizeSpace(loc.addressLocality || '') || DEFAULT_CITY;
    const postalCode = String(loc.postalCode || '').trim() || DEFAULT_POSTAL;
    const canton = inferSwissTargetCanton(location) || DEFAULT_CANTON;

    const descriptionText = buildDescriptionFromLd(ld) || `${title} — ${KSGL_COMPANY_NAME}`;
    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} ${KSGL_KEY} ${location}`);
    const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);

    const postedDate = (() => {
      const raw = ld.datePosted || ld.validThrough || '';
      const d = new Date(String(raw || ''));
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      return new Date().toISOString().slice(0, 10);
    })();

    jobs.push({
      id: `${KSGL_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KSGL_COMPANY_NAME,
      companyKey: KSGL_KEY,
      companyDomain: KSGL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      // AI localization fills fr/it/en; without this flag the locale-completeness
      // gate trips before translate-pending can catch up.
      needsRetranslation: true,
      location,
      canton,
      url,
      source: `Kantonsspital Glarus (KSGL) Dedicated Parser (Prospective careercenter ${PROSPECTIVE_TENANT})`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: pickEmploymentTypeFromLd(ld, title),
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate,
      applyUrl: url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`\n📋 Total Kantonsspital Glarus (KSGL) jobs discovered: ${jobs.length}`);
  return jobs;
}
