#!/usr/bin/env node
/**
 * Ostschweizer Kinderspital (Kispi SG) job parser.
 *
 * Public career site: https://www.kispisg.ch/stellen
 * ATS backend:        Umantis tenant 2979 (apply links only)
 *
 * The kispi-sg.ch/stellen page is a Pimcore CMS SSR listing — each job has:
 *   - A teaser card on the listing page (title + one-line snippet + slug)
 *   - An individual SSR page at /de/stellen/{slug}-{pimcore_id}
 *     with a full structured description (Aufgaben / Ihr Profil / …)
 *   - An Umantis Application/CheckLogin/* apply URL that embeds the
 *     Umantis vacancy ID
 *
 * The Umantis /Vacancies/{id}/Description/* URLs now 3xx-redirect cross-host
 * to https://www.kispisg.ch/stellen (issue #1245, GitHub issue #1739) so the
 * shared umantis-listing-common.mjs quarantines every job → 0 jobs emitted.
 *
 * Fix: bypass the Umantis listing entirely and scrape the public Pimcore
 * pages instead. This gives full job descriptions via plain (non-headless)
 * HTTP fetches and is unaffected by the Umantis detail-page redirect.
 *
 * Different from kispi-job-parser.mjs (Universitäts-Kinderspital beider
 * Basel) and kispi-zurich-job-parser.mjs — separate hospitals.
 */
import { createHash } from 'node:crypto';
import { detectLang, isCivilServiceListing } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchWithRetry, RETRYABLE_STATUS } from './transient-fetch.mjs';

export const KISPI_SG_KEY = 'kispi-sg';
export const KISPI_SG_COMPANY_NAME = 'Ostschweizer Kinderspital';
export const KISPI_SG_COMPANY_DOMAIN = 'kispisg.ch';

const BASE_HOST = 'https://www.kispisg.ch';
const LISTING_URL = `${BASE_HOST}/stellen`;
const COMPANY_SECTOR = 'Sanità / Ospedali';
const DEFAULT_CANTON = 'SG';
const DEFAULT_CITY = 'St. Gallen';
const DEFAULT_POSTAL_CODE = '9006';
const DEFAULT_SOURCE_LANG = 'de';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── HTTP ─────────────────────────────────────────────────── */

async function fetchHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  return fetchWithRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${url}`);
        err.status = res.status;
        err.retryable = RETRYABLE_STATUS.has(res.status);
        throw err;
      }
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }, { label: `kispi-sg ${url}` });
}

/* ── Helpers ──────────────────────────────────────────────── */

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(s = '') {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

/* ── Category / Experience detectors ────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(pflege|pflegefach|stationsleitung|fage|spitex|nachtwache|geburts|hebamme|intensiv|neonat)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|chirurg|anästhes|onkolog|kardiolog|neurolog|pädiatr|gynäk|psychiatr|geriatr|gastroenter)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|radiolog|röntgen|mtra|mrt|physiother|ergo|logopäd|rehabilit|apothek|pharma)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa|mfa)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance)/.test(t)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(t)) return 'IT';
  if (/\b(admin|sekret|buchhalt|sachbearbeiter|finanz|controll|account)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie)/.test(t)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(t)) return 'Logistica';
  if (/\b(market|kommunik)/.test(t)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|werkstudent)/.test(t)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|intern|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|chefarzt)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(title = '') {
  const t = normalize(title);
  if (/teilzeit|part.?time/.test(t)) return 'PART_TIME';
  if (/vollzeit|full.?time/.test(t)) return 'FULL_TIME';
  const pct = t.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pct) {
    const maxPct = pct[2] ? parseInt(pct[2], 10) : parseInt(pct[1], 10);
    return maxPct < 80 ? 'PART_TIME' : 'FULL_TIME';
  }
  return 'OTHER';
}

/* ── Listing page parser ──────────────────────────────────── */

/**
 * Parse the kispisg.ch/stellen listing page.
 * Returns [{title, slug, pimcoreId, snippet}].
 */
export function parseListingPage(html) {
  const out = [];
  const seen = new Set();

  // Each job card structure (Pimcore CMS):
  //   <p class="h1" data-id="{PIMCORE_ID}">{TITLE}</p>
  //   optional teaser text
  //   <a href="/de/stellen/{url-slug}"...>zu den offenen Stellen</a>
  const cardRx = /data-id="(\d+)"[^>]*>([\s\S]*?)<a\s+href="(\/de\/stellen\/[^"]+)"/g;
  let m;
  while ((m = cardRx.exec(html))) {
    const pimcoreId = m[1];
    if (seen.has(pimcoreId)) continue;

    const inner = m[2];
    const slug = m[3];

    // Extract the title from the <p class="h1" data-id="N"> element. Its inner
    // content (m[2]) runs from right after `data-id="N">` up to the closing
    // </p>. Pimcore sometimes wraps the title in a nested <span> (or similar),
    // so take the whole title block up to </p> and strip inner tags. Matching
    // only the leading plain-text node (/^([^<]{3,200})/) returned '' for a
    // wrapped title → card silently dropped, yielding fewer than the declared
    // jobs (issue #1850).
    let titleHtml;
    let snippetHtml;
    const titleBlockMatch = inner.match(/^([\s\S]*?)<\/p>/i);
    if (titleBlockMatch) {
      titleHtml = titleBlockMatch[1];
      snippetHtml = inner.slice(titleBlockMatch[0].length);
    } else {
      // No closing </p> in the captured block — fall back to the leading
      // plain-text node so a malformed card still degrades gracefully.
      const leadMatch = inner.match(/^([^<]{3,200})/);
      titleHtml = leadMatch ? leadMatch[1] : '';
      snippetHtml = inner.slice(leadMatch ? leadMatch[0].length : 0);
    }
    const title = normalizeSpace(decodeHtmlEntities(stripHtml(titleHtml))).slice(0, 200);
    if (!title || title.length < 3) continue;

    // Skip initiative applications (Initiativbewerbung)
    if (/(initiativbewerbung|spontanbewerbung|blindbewerbung)\b/i.test(title)) continue;
    if (/\binitiativ\b/i.test(title)) continue;

    // Brief teaser text following the title
    const snippet = normalizeSpace(decodeHtmlEntities(stripHtml(snippetHtml))).slice(0, 300);

    seen.add(pimcoreId);
    out.push({ title, slug, pimcoreId, snippet });
  }
  return out;
}

/* ── Detail page parser ──────────────────────────────────── */

/**
 * Extract job description and Umantis vacancy ID from an individual
 * kispisg.ch/de/stellen/{slug} page.
 *
 * Returns { description, applyUrl, umantisVacancyId }.
 */
function parseDetailPage(html, title) {
  // Strip scripts and styles
  let cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Extract sections by common DE HR headers
  const sectionHeaders = ['Ihre Aufgaben', 'Aufgaben', 'Ihr Profil', 'Wir bieten', 'Wir suchen',
    'Stellenbeschreibung', 'Was Sie erwartet', 'Was wir bieten', 'Anforderungen', 'Anforderungsprofil'];

  const parts = [];
  for (const header of sectionHeaders) {
    const rx = new RegExp(`${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s\\S]{20,1500}?)(?=<h[1-6]|Ihre Aufgaben|Aufgaben|Ihr Profil|Wir bieten|Wir suchen|Stellenbeschreibung|Was Sie|Was wir|Anforderung|jetzt bewerben|<footer|$)`, 'i');
    const mm = cleaned.match(rx);
    if (mm) {
      const text = normalizeSpace(decodeHtmlEntities(stripHtml(mm[1])));
      if (text.length > 30) parts.push(`${header}:\n${text}`);
    }
  }

  // Fallback: extract prose from <p> and <li> tags in main content area
  if (parts.length === 0) {
    const proseRx = /<(p|li)[^>]*>([\s\S]*?)<\/\1>/g;
    let pm;
    while ((pm = proseRx.exec(cleaned))) {
      const text = normalizeSpace(decodeHtmlEntities(pm[2].replace(/<[^>]+>/g, ' ')));
      if (text.length > 40 && !/cookie|datenschutz|impressum|telefon|^menu$|navigation/i.test(text.slice(0, 50))) {
        parts.push(text);
      }
    }
  }

  const description = parts.slice(0, 8).join('\n\n');

  // Extract Umantis vacancy ID from apply URL: /Vacancies/{id}/Application/
  const applyMatch = html.match(/href="(https:\/\/recruitingapp-2979\.umantis\.com\/Vacancies\/(\d+)\/Application[^"]+)"/i);
  const applyUrl = applyMatch ? applyMatch[1] : '';
  const umantisVacancyId = applyMatch ? applyMatch[2] : '';

  return { description, applyUrl, umantisVacancyId };
}

/* ── Company matchers ─────────────────────────────────────── */

export function isKispiSgJob(job) {
  const key = normalize(job?.companyKey || '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  return (
    key === KISPI_SG_KEY ||
    company.includes('ostschweizer kinderspital') ||
    company.includes('kispi') ||
    url.includes('kispisg.ch') ||
    url.includes('recruitingapp-2979.umantis.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'kispisg.ch' ||
      host.endsWith('.kispisg.ch') ||
      host === 'recruitingapp-2979.umantis.com'
    );
  } catch {
    return false;
  }
}

/* ── Main fetcher ─────────────────────────────────────────── */

export async function fetchAllKispiSgJobs() {
  console.log(`🏥 Fetching ${KISPI_SG_COMPANY_NAME} jobs`);
  console.log(`   Source: ${LISTING_URL}`);
  console.log();

  let listingHtml;
  try {
    listingHtml = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`  ⚠️  Failed to fetch kispi-sg listing: ${err?.message || err}`);
    return [];
  }

  const cards = parseListingPage(listingHtml);
  console.log(`  ✓ ${cards.length} jobs from listing`);
  if (cards.length === 0) return [];
  console.log(`  📄 Fetching individual job pages for descriptions…`);

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let descriptionHits = 0;

  for (const card of cards) {
    const { title, slug, pimcoreId, snippet } = card;

    if (isCivilServiceListing(title, snippet)) continue;

    const detailPageUrl = `${BASE_HOST}${slug}`;
    let description = '';
    let applyUrl = '';

    try {
      const detailHtml = await fetchHtml(detailPageUrl);
      const parsed = parseDetailPage(detailHtml, title);
      description = parsed.description;
      applyUrl = parsed.applyUrl;
      if (description) descriptionHits++;
    } catch (err) {
      console.warn(`  ⚠️  Failed to fetch detail page for "${title}": ${err?.message || err}`);
    }

    // Polite delay between detail page fetches
    await new Promise((r) => setTimeout(r, 300));

    // Synthesise boilerplate if description parsing failed
    if (!description) {
      if (snippet) {
        description = snippet;
      } else {
        const intro = `${title} beim ${KISPI_SG_COMPANY_NAME} in ${DEFAULT_CITY} (${DEFAULT_POSTAL_CODE}, ${DEFAULT_CANTON}), Schweiz.`;
        description = `${intro}\n\n• Standort: ${DEFAULT_CITY} (${DEFAULT_CANTON})\n• Bewerbung über das Karriereportal des Ostschweizer Kinderspitals`;
      }
    }

    const jobUrl = applyUrl || `${LISTING_URL}#job-${pimcoreId}`;
    const sourceLang = detectLang(description || title, DEFAULT_SOURCE_LANG);
    const jobSlug = slugify(`${title} ${KISPI_SG_KEY} ${DEFAULT_CITY}`);
    // Use a deterministic ID seed: pimcore page ID is stable across runs
    const urlHash = createHash('sha1').update(`kispi-sg-pimcore-${pimcoreId}`).digest('hex').slice(0, 12);

    jobs.push({
      id: `${KISPI_SG_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: KISPI_SG_COMPANY_NAME,
      companyKey: KISPI_SG_KEY,
      companyDomain: KISPI_SG_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: DEFAULT_CITY,
      canton: DEFAULT_CANTON,
      url: jobUrl,
      source: `${KISPI_SG_COMPANY_NAME} Dedicated Parser (Pimcore SSR @ kispisg.ch/stellen)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: DEFAULT_CITY,
      addressRegion: DEFAULT_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: DEFAULT_POSTAL_CODE,
      category: detectCategory(title),
      contract: 'full-time',
      employmentType: detectEmploymentType(title),
      experienceLevel: detectExperienceLevel(title),
      sector: COMPANY_SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: applyUrl || jobUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`\n📋 Total ${KISPI_SG_COMPANY_NAME} jobs discovered: ${jobs.length} (${descriptionHits}/${cards.length} with description)`);
  return jobs;
}
