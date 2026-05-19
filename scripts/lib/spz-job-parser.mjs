#!/usr/bin/env node
/**
 * Schweizer Paraplegiker-Zentrum (SPZ) job parser — Prospective.ch careercenter SSR
 * (tenant 1001777).
 *
 * Public career site: https://www.paraplegie.ch/de/karriere
 *   → published listing platform: https://jobs.paraplegie.ch/ (Prospective careercenter
 *     served via https://ohws.prospective.ch/public/v1/careercenter/1001777/)
 *
 * IMPORTANT: SPZ uses Prospective's "careercenter" product, NOT the standard
 * v1 "medium" JSON listing. The `/public/v1/medium/1001777/jobs` endpoint
 * returns HTTP 400. The ONLY public surface is the server-rendered HTML at
 * `/public/v1/careercenter/1001777/`, which posts back to itself with
 * `offset/limit` form params for pagination — sending `limit=200` via POST
 * returns every advert in one page.
 *
 * SPZ Nottwil (LU) is Switzerland's national centre for spinal cord injury
 * rehabilitation (>1500 employees). Operated by Schweizer Paraplegiker-Stiftung.
 *
 * Strategy mirrors LUPS / KSGL: POST listing → parse `<a class="job job-N">`
 * entries → fetch each detail page → extract JSON-LD JobPosting.
 */
import { createHash } from 'node:crypto';
import { slugify, stripHtml } from './crawler-template.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SPZ_KEY = 'spz';
export const SPZ_COMPANY_NAME = 'Schweizer Paraplegiker-Zentrum (SPZ)';
export const SPZ_COMPANY_DOMAIN = 'paraplegie.ch';

const CAREER_URL = 'https://www.paraplegie.ch/de/karriere';
const PROSPECTIVE_TENANT = '1001777';
const LISTING_URL = `https://ohws.prospective.ch/public/v1/careercenter/${PROSPECTIVE_TENANT}/`;

const DEFAULT_CANTON = 'LU';
const DEFAULT_CITY = 'Nottwil';
const DEFAULT_POSTAL = '6207';

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
  /<a\s+class="job job-\d+"\s+href="([^"]+)"\s+title="([^"]+)"/g;

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
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|chirurg|anästhes|onkolog|kardiolog|neurolog|pädiatr|gynäk|psychi|geriatr|radiolog|dermatolog|psycholog|psychotherap|reha)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse|röntgen|mtra|mrt|physiother|ergo|logopäd|rehabilit|apothek|pharma|ernähr|sozialpäd|feldenkrais)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa|mfa|fage)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance|elektr)/.test(t)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(t)) return 'IT';
  if (/\b(admin|sekret|buchhalt|sachbearbeiter|finanz|controll|account)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie)/.test(t)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(t)) return 'Logistica';
  if (/\b(market|kommunik|grafik|design)/.test(t)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|werkstudent|studierend|vorpraktik|postdoc|researcher)/.test(t)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|intern|lehrling|lernend|apprenti|studierend|unterassist|vorpraktik)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent|assistenz)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|chefarzt|gruppenleiter)/.test(t)) return 'senior';
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
  'paraplegie.ch',
  'www.paraplegie.ch',
  'jobs.paraplegie.ch',
]);

export function isSpzJob(job) {
  const key = normalize(job?.companyKey || '');
  const url = normalize(job?.url || '');
  if (key === SPZ_KEY) return true;
  if (url.includes('paraplegie.ch')) return true;
  if (url.includes(`/careercenter/${PROSPECTIVE_TENANT}/`)) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (TRUSTED_HOSTS.has(host)) return true;
    if (host.endsWith('.paraplegie.ch')) return true;
    if (host === 'ohws.prospective.ch' && rawUrl.includes(`/careercenter/${PROSPECTIVE_TENANT}/`)) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Main entry ───────────────────────────────────────────── */

/**
 * Fetch all Schweizer Paraplegiker-Zentrum (SPZ) jobs via Prospective.ch
 * careercenter SSR. Returns ParsedJob[] (source-locale only, needsRetranslation: true).
 */
export async function fetchAllSpzJobs() {
  console.log('🏥 Fetching Schweizer Paraplegiker-Zentrum (SPZ) jobs');
  console.log(`   Listing: ${LISTING_URL} (Prospective careercenter ${PROSPECTIVE_TENANT})`);
  console.log(`   Public:  ${CAREER_URL}\n`);

  const html = await safeFetch(LISTING_URL, {
    method: 'POST',
    body: 'offset=0&limit=200&lang=de',
    accept: 'text',
  });
  if (!html) {
    console.warn('⚠️ Could not fetch SPZ listing — returning [].');
    return [];
  }
  const listings = parseListingHtml(html);
  console.log(`   ✓ Discovered ${listings.length} advert links in listing`);
  if (listings.length === 0) return [];

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

    const descriptionText = buildDescriptionFromLd(ld) || `${title} — ${SPZ_COMPANY_NAME}`;
    const sourceLang = detectLang(descriptionText || title, 'de');
    const jobSlug = slugify(`${title} ${SPZ_KEY} ${location}`);
    const urlHash = createHash('sha1').update(url).digest('hex').slice(0, 12);

    const postedDate = (() => {
      const raw = ld.datePosted || ld.validThrough || '';
      const d = new Date(String(raw || ''));
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      return new Date().toISOString().slice(0, 10);
    })();

    jobs.push({
      id: `${SPZ_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SPZ_COMPANY_NAME,
      companyKey: SPZ_KEY,
      companyDomain: SPZ_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      needsRetranslation: true,
      location,
      canton,
      url,
      source: `Schweizer Paraplegiker-Zentrum (SPZ) Dedicated Parser (Prospective careercenter ${PROSPECTIVE_TENANT})`,
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

  console.log(`\n📋 Total Schweizer Paraplegiker-Zentrum (SPZ) jobs discovered: ${jobs.length}`);
  return jobs;
}
