#!/usr/bin/env node
/**
 * Spital Limmattal (Schlieren ZH) job parser — Refline ATS.
 *
 * Public career site:
 *   - Hub: https://www.spital-limmattal.ch/jobs-karriere/offene-stellen/
 *   - Embedded via Refline:
 *       <script type="REFLINE/Positions" data-url="https://apply.refline.ch/486538/positions.html"></script>
 *
 * Listing endpoint (server-rendered HTML, public, no auth):
 *   https://apply.refline.ch/486538/positions.html
 *   → Returns one big HTML page with <a href="…/{posId}/pub/{rev}/index.html">title</a>
 *     rows for every active position. No pagination — Refline always returns the
 *     full active list.
 *
 * Detail page: https://apply.refline.ch/486538/{posId}/pub/{rev}/index.html
 *   - Title in <h1> / <h2>
 *   - Description in the main <body> content (Refline ships the full
 *     job text inline as HTML).
 *
 * Single physical site: Spital Limmattal, 8952 Schlieren (Kanton Zürich).
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllSpitalLimmattalJobs()  — Fetch and parse all jobs
 *   - isSpitalLimmattalJob()         — Match jobs belonging to Spital Limmattal
 *   - isTrustedDomain()              — Validate URLs belong to Spital Limmattal / Refline tenant
 *   - SPITAL_LIMMATTAL_KEY / _COMPANY_NAME / _COMPANY_DOMAIN constants
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const SPITAL_LIMMATTAL_KEY = 'spital-limmattal';
export const SPITAL_LIMMATTAL_COMPANY_NAME = 'Spital Limmattal';
export const SPITAL_LIMMATTAL_COMPANY_DOMAIN = 'spital-limmattal.ch';

const REFLINE_TENANT = '486538';
const REFLINE_LISTING_URL = `https://apply.refline.ch/${REFLINE_TENANT}/positions.html`;
const PUBLIC_CAREER_URL = 'https://www.spital-limmattal.ch/jobs-karriere/offene-stellen/';

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

export function isSpitalLimmattalJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === SPITAL_LIMMATTAL_KEY ||
    key.startsWith('spital-limmattal') ||
    company.includes('spital limmattal') ||
    company.includes('limmi') ||
    url.includes('spital-limmattal.ch') ||
    url.includes(`apply.refline.ch/${REFLINE_TENANT}`)
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'spital-limmattal.ch' || host.endsWith('.spital-limmattal.ch')) return true;
    if ((host === 'apply.refline.ch' || host === 'pub.refline.ch') && rawUrl.includes(`/${REFLINE_TENANT}/`)) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Category / level / employment-type detection ─────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(pflege|pflegefach|stationsleitung|fage|spitex|nachtwache|geburts|hebamme|operationstechnik|expert.*pflege|expertin.*pflege|notfallpflege)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|chirurg|anästhes|onkolog|kardiolog|neurolog|pädiatr|gynäk|rettungssanit)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse|radiolog|röntgen|mtra|physiother|ergo|logopäd|rehabilit|apothek|pharma)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance)/.test(t)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(t)) return 'IT';
  if (/\b(admin|segret|buchhalt|sachbearbeiter|finanz|controll|account)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie|haus.?dienst)/.test(t)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(t)) return 'Logistica';
  if (/\b(market|kommunik)/.test(t)) return 'Marketing';
  if (/\b(lehrstelle|lernend|praktik|ausbildung|apprenti|studienplatz|studierend)/.test(t)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(lehrstelle|lernend|praktik|stage|intern|apprenti|studierend|studienplatz|trainee)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|chefarzt|berufsbildner)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(title = '') {
  const t = normalize(title);
  if (/teilzeit|part[- ]?time/.test(t)) return 'PART_TIME';
  const pctMatch = t.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/) || t.match(/(\d{1,3})\s*%/);
  if (pctMatch) {
    const maxPct = pctMatch[2] ? parseInt(pctMatch[2], 10) : parseInt(pctMatch[1], 10);
    if (maxPct < 80) return 'PART_TIME';
  }
  if (/vollzeit|full[- ]?time|100\s*%/.test(t)) return 'FULL_TIME';
  return 'FULL_TIME';
}

function extractPensum(title = '') {
  const range = title.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/);
  if (range) return { min: parseInt(range[1], 10), max: parseInt(range[2], 10) };
  const single = title.match(/(\d{2,3})\s*%/);
  if (single) {
    const v = parseInt(single[1], 10);
    return { min: v, max: v };
  }
  return null;
}

/* ── HTTP fetch ────────────────────────────────────────────── */

async function fetchPage(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-CH,de;q=0.9,en;q=0.5',
        Referer: PUBLIC_CAREER_URL,
      },
      signal: controller.signal,
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

/* ── Listing parser ────────────────────────────────────────── */

/**
 * Parse Refline positions.html.
 * Each position is rendered as:
 *   <a href="https://apply.refline.ch/486538/{posId}/pub/{rev}/index.html" target="_blank">Title</a>
 *
 * Returns array of { title, url, posId, rev }.
 */
export function parseReflineListing(html = '') {
  if (!html) return [];
  const out = [];
  const seen = new Set();

  const re = new RegExp(
    `<a\\s+href="(https://apply\\.refline\\.ch/${REFLINE_TENANT}/(\\d+)/pub/(\\d+)/index\\.html)"[^>]*>([^<]+)</a>`,
    'gi',
  );
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    const posId = m[2];
    const rev = m[3];
    const title = normalizeSpace(m[4]);
    if (!title || title.length < 3) continue;
    if (seen.has(posId)) continue;
    seen.add(posId);
    out.push({ url, posId, rev, title });
  }
  return out;
}

/* ── Detail parser ─────────────────────────────────────────── */

/**
 * Parse a Refline detail page. Returns { title, description }.
 * Refline ships the full job text inline. We collect every paragraph and list
 * item from the main content area and concatenate.
 */
export function parseReflineDetail(html = '') {
  if (!html) return { title: '', description: '' };

  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
    || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';

  // Strip header/nav/footer/script/style noise
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '');

  const parts = [];
  const blockRe = /<(p|li|h3|h4)[^>]*>([\s\S]*?)<\/\1>/gi;
  let bm;
  while ((bm = blockRe.exec(cleaned)) !== null) {
    const tag = bm[1].toLowerCase();
    const text = normalizeSpace(stripHtml(bm[2]));
    if (text.length > 30 && !/cookie|datenschutz|privacy|navigation|impressum|bewerbung absenden/i.test(text)) {
      parts.push(tag === 'li' ? `• ${text}` : text);
    }
  }
  const description = parts.join('\n');
  return { title, description };
}

/* ── Fallback description ──────────────────────────────────── */

function buildFallbackDescription(title) {
  return [
    `${title} bei Spital Limmattal in Schlieren, Kanton Zürich.`,
    '',
    `Das Spital Limmattal ist das öffentliche Akutspital für die rund 150'000 Einwohnerinnen und Einwohner des Limmattals (Bezirke Dietikon und Zürich West). Das Spital ist Lehrspital der Universität Zürich und der Höheren Fachschulen für Pflege.`,
    '',
    'Das bietet «Limmi» den Mitarbeitenden:',
    '• Modernes Arbeitsumfeld in einem Neubau (Eröffnung 2018)',
    '• Breite Palette medizinischer Fachbereiche',
    '• Vielfältige Aus- und Weiterbildungsmöglichkeiten',
    '• Attraktive Anstellungsbedingungen',
    '• Rund 1\'500 Mitarbeitende in einem kollegialen Umfeld',
  ].join('\n');
}

/* ── Main fetch ────────────────────────────────────────────── */

/**
 * Fetch all Spital Limmattal jobs from Refline.
 * Returns ParsedJob[] with source-locale fields only (sourceLang='de').
 */
export async function fetchAllSpitalLimmattalJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;

  console.log(`🏥 Fetching ${SPITAL_LIMMATTAL_COMPANY_NAME} jobs`);
  console.log(`   Source: ${REFLINE_LISTING_URL} (Refline tenant ${REFLINE_TENANT})\n`);

  let listingHtml;
  try {
    listingHtml = await fetchPage(REFLINE_LISTING_URL, timeoutMs);
  } catch (err) {
    throw new Error(`Failed to fetch Refline listing: ${err?.message || err}`);
  }

  const listings = parseReflineListing(listingHtml);
  console.log(`  📋 Found ${listings.length} positions\n`);
  if (listings.length === 0) {
    console.warn('⚠️ No job listings found on Refline page.');
    return [];
  }

  const jobs = [];
  for (const listing of listings) {
    let detail = { title: '', description: '' };
    try {
      const detailHtml = await fetchPage(listing.url, timeoutMs);
      detail = parseReflineDetail(detailHtml);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${listing.title}: ${err?.message || err}`);
    }

    const title = detail.title || listing.title;
    const location = 'Schlieren';
    const canton = inferSwissTargetCanton(location) || 'ZH';
    const postalCode = '8952';

    let description = '';
    if (detail.description && detail.description.split(/\s+/).length >= 50) {
      description = detail.description;
    } else {
      description = buildFallbackDescription(title);
    }

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${SPITAL_LIMMATTAL_KEY} ch`);
    const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
    const employmentType = detectEmploymentType(title);
    const pensum = extractPensum(title);

    const job = {
      id: `${SPITAL_LIMMATTAL_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SPITAL_LIMMATTAL_COMPANY_NAME,
      companyKey: SPITAL_LIMMATTAL_KEY,
      companyDomain: SPITAL_LIMMATTAL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      location,
      canton,
      url: listing.url,
      source: 'Spital Limmattal Dedicated Parser (Refline)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectCategory(title),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().slice(0, 10),
      applyUrl: listing.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (pensum) {
      job.pensumMin = pensum.min;
      job.pensumMax = pensum.max;
      job.pensum = pensum.min === pensum.max ? `${pensum.min}%` : `${pensum.min} - ${pensum.max}%`;
    }

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 65)} (${listing.posId})`);

    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\n📋 Total ${SPITAL_LIMMATTAL_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
