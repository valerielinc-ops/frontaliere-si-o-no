#!/usr/bin/env node
/**
 * EPFL job parser — Fetcher and job builder.
 *
 * Source: https://careers.epfl.ch/search/  (SAP SuccessFactors career site,
 *         backed by hcm74.sapsf.eu — same engine used by Aldi/Hugo Boss/etc.)
 *
 * The SuccessFactors careers HTML lists jobs as rows containing anchors of the
 * shape:
 *   <a href="/job/<location-slug>-<title-slug>/<jobId>/" class="jobTitle-link">Title</a>
 * Each row also exposes location ("jobShifttype"), function ("jobDepartment"),
 * and contract type ("jobFacility") in sibling spans.
 *
 * Pagination uses ?startrow=0,25,50,... (page size = 25). We walk pages until
 * a page returns no rows, capped to a reasonable upper bound to avoid runaway
 * crawls if EPFL changes the markup.
 *
 * Note: EPFL is in Lausanne (VD canton), well outside our Ticino/Grigioni
 *       scope. We still crawl and tag with VD so the quorum gate / target-canton
 *       filter applied downstream decides which jobs make it into the index.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllEpflJobs()  — Fetch and parse all jobs
 *   - isEpflJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripHtml } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const EPFL_KEY = 'epfl';
export const EPFL_COMPANY_NAME = 'EPFL';
export const EPFL_COMPANY_DOMAIN = 'epfl.ch';

const CAREER_BASE = 'https://careers.epfl.ch';
const SEARCH_URL = `${CAREER_BASE}/search/`;
const PAGE_SIZE = 25;
const MAX_PAGES = 60; // safety cap → up to 1500 listings before the loop bails
const FETCH_HEADERS = {
  'User-Agent': 'FrontaliereTicino-JobCrawler/2.0 (+https://frontaliereticino.ch)',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9,fr;q=0.6,it;q=0.4',
};

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to EPFL.
 * Used by the template to filter this company's jobs from the global dataset.
 */
export function isEpflJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === EPFL_KEY ||
    key.startsWith('epfl') ||
    company.includes('epfl') ||
    url.includes('epfl.ch')
  );
}

/**
 * Validate that a URL belongs to EPFL's domain.
 * SuccessFactors detail pages live on careers.epfl.ch (and the apply flow on
 * hcm74.sapsf.eu — accepted because EPFL hosts the SF tenant).
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'epfl.ch' ||
      host.endsWith('.epfl.ch') ||
      host === 'hcm74.sapsf.eu'
    );
  } catch {
    return false;
  }
}

/* ── Category Detection ────────────────────────────────────── */

function detectCategory(title = '', dept = '') {
  const t = normalize(`${title} ${dept}`);
  if (/\b(post.?doc|postdoc|phd|doctora|scientif|research|recherch|ricerca)/.test(t)) return 'Ricerca';
  if (/\b(profess|faculty|lecturer|enseignan|maitre)/.test(t)) return 'Accademia';
  if (/\b(ingenieur|ingegner|engineer|entwickl)/.test(t)) return 'Ingegneria';
  if (/\b(techni|tecnic|mecanic|elektr|install|laborant)/.test(t)) return 'Tecnica';
  if (/\b(admin|secret|segret|contab|buchhalt|account|gestion)/.test(t)) return 'Amministrazione';
  if (/\b(it|software|develop|programm|informatic|data)/.test(t)) return 'IT';
  if (/\b(hr|human|risorse|personal|ressources humaines)/.test(t)) return 'Risorse Umane';
  if (/\b(market|kommunik|comunicaz|communica)/.test(t)) return 'Marketing';
  if (/\b(finanz|finance|financ)/.test(t)) return 'Finanza';
  if (/\b(legal|giurid|recht|juridique)/.test(t)) return 'Legale';
  if (/\b(apprenti|stagiair|stage|intern|praktik)/.test(t)) return 'Stage';
  return 'Altro';
}

function detectExperienceLevel(title = '', dept = '') {
  const t = normalize(`${title} ${dept}`);
  if (/\b(praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(post.?doc|postdoc)/.test(t)) return 'mid';
  if (/\b(phd|doctora|doctorant)/.test(t)) return 'junior';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|directeur|dirett|chef|verantwort|responsab|profess)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(text = '') {
  const t = normalize(text);
  if (/\b(part.?time|teilzeit|tempo parziale|temps partiel)/.test(t)) return 'PART_TIME';
  if (/\b(full.?time|vollzeit|tempo pieno|temps plein|cdi|cdd)/.test(t)) return 'FULL_TIME';
  if (/\b(intern|stage|stagiair|praktik|apprenti)/.test(t)) return 'INTERN';
  return 'OTHER';
}

/* ── HTML row parsing ─────────────────────────────────────── */

/**
 * Parse a SuccessFactors search-results page and return raw listings.
 * Exported for unit testing without network access.
 *
 * @param {string} html — full HTML of /search/?startrow=N
 * @returns {Array<{title:string, jobId:string, jobUrl:string, location:string, department:string, contractType:string}>}
 */
export function parseEpflSearchPage(html = '') {
  const out = [];
  if (!html) return out;

  // Match every job-title anchor: href="/job/<slug>/<id>/" plus inner text.
  const anchorRe = /<a[^>]+href="(\/job\/[^"]+\/(\d+)\/)"[^>]*class="[^"]*jobTitle-link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set();
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1];
    const jobId = m[2];
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    const title = normalizeSpace(decodeEntities(m[3].replace(/<[^>]+>/g, ' ')));
    if (!title) continue;

    // After the anchor, the same row holds department/location/facility spans.
    // Window the next ~2500 chars and extract them lazily.
    const tail = html.slice(m.index, m.index + 2500);
    const dept = extractSpan(tail, 'jobDepartment');
    const facility = extractSpan(tail, 'jobFacility');
    const shift = extractSpan(tail, 'jobShifttype');

    // The location often appears in the URL slug as the leading segment, e.g.
    // /job/Lausanne-Postdoctoral-Position-.../1234/
    const slugLocation = (href.match(/^\/job\/([^/-]+)/) || [])[1] || '';
    const location = shift || decodeEntities(slugLocation).replace(/-/g, ' ');

    out.push({
      title,
      jobId,
      jobUrl: `${CAREER_BASE}${href}`,
      location: normalizeSpace(location),
      department: dept,
      contractType: facility,
    });
  }
  return out;
}

function extractSpan(html, className) {
  const re = new RegExp(
    `<span[^>]*class="[^"]*${className}[^"]*"[^>]*>([\\s\\S]*?)<\\/span>`,
    'i',
  );
  const m = html.match(re);
  if (!m) return '';
  return normalizeSpace(decodeEntities(m[1].replace(/<[^>]+>/g, ' ')));
}

/* ── Fetch + Parse ─────────────────────────────────────────── */

async function fetchSearchPage(startRow) {
  const url = `${SEARCH_URL}?q=&startrow=${startRow}`;
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return await res.text();
}

const DETAIL_TIMEOUT_MS = 15_000;
const DETAIL_RATE_LIMIT_MS = 400;

/**
 * Fetch the SuccessFactors detail page for an EPFL job and extract the body.
 * EPFL uses standard CSB markup: `<div id="jobdescription">` or class variants.
 * Falls back to <main>/<article>. Returns plain text with `\n• ` bullets
 * (preserved by crawler-template.stripHtml). Empty string on failure.
 */
async function fetchEpflDetailDescription(jobUrl) {
  if (!jobUrl) return '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DETAIL_TIMEOUT_MS);
  try {
    const res = await fetch(jobUrl, { headers: FETCH_HEADERS, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return '';
    const html = await res.text();
    const match =
      html.match(/<div[^>]*\bid="jobdescription"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<\/main>)/i) ||
      html.match(/<div[^>]*class="[^"]*\bjobdescription\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<\/main>)/i) ||
      html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
      html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (!match) return '';
    const text = stripHtml(decodeEntities(match[1]));
    return text
      .replace(/[ \t]+/g, ' ')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 4000);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllListings() {
  const all = [];
  const seenIds = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const startRow = page * PAGE_SIZE;
    const html = await fetchSearchPage(startRow);
    const rows = parseEpflSearchPage(html);
    if (rows.length === 0) break;

    let newCount = 0;
    for (const row of rows) {
      if (seenIds.has(row.jobId)) continue;
      seenIds.add(row.jobId);
      all.push(row);
      newCount++;
    }
    // SuccessFactors sometimes pads pagination with the same rows when no
    // more results exist; bail on a fully duplicated page.
    if (newCount === 0) break;

    await new Promise((r) => setTimeout(r, 600)); // courtesy delay
  }
  return all;
}

/**
 * Fetch all EPFL jobs.
 * Returns an array of ParsedJob objects (source-locale only).
 *
 * IMPORTANT: Only set source-locale fields. Other locales are filled
 * by the AI localization step and translate-pending pipeline.
 */
export async function fetchAllEpflJobs() {
  console.log(`🔍 Fetching EPFL jobs`);
  console.log(`   Source: ${SEARCH_URL}\n`);

  const listings = await fetchAllListings();
  if (!listings || listings.length === 0) {
    console.warn('⚠️ No EPFL job listings returned — markup may have changed.');
    return [];
  }

  console.log(`  📋 Listings found: ${listings.length}`);

  const jobs = [];
  for (const listing of listings) {
    const title = listing.title;
    if (!title || title.length < 3) continue;

    const location = listing.location || 'Lausanne';
    const canton = inferSwissTargetCanton(location) || 'VD';
    const publicUrl = listing.jobUrl;

    // Always prefer the real description from the EPFL SuccessFactors detail
    // page. Rate-limited so we don't hammer careers.epfl.ch.
    const detailDescription = await fetchEpflDetailDescription(publicUrl);
    if (publicUrl) {
      await new Promise((r) => setTimeout(r, DETAIL_RATE_LIMIT_MS));
    }

    // TEMPORARY fallback used only when the detail page is unreachable. The
    // long-term fix is upstream (anti-bot/auth blocks); <1% of fetches should
    // hit this branch in production.
    const fallbackBits = [
      `${title} — EPFL (${location}).`,
      `Posizione pubblicata sul portale carriere ufficiale EPFL (SAP SuccessFactors).`,
      '',
      'Dettagli della posizione:',
      `• Sede: ${location}, Canton ${canton}`,
      `• Funzione: ${listing.department || 'n/d'}`,
      `• Tipo contratto: ${listing.contractType || 'n/d'}`,
      `• Datore di lavoro: EPFL — École polytechnique fédérale de Lausanne`,
    ];
    const fallbackDescription = detailDescription.length >= 100 ? detailDescription : fallbackBits.join('\n');

    const sourceLang = detectLang(`${title} ${listing.department}`, 'fr');
    const jobSlug = slugify(`${title} epfl ${location}`);
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

    const job = {
      // ── Required fields ──
      id: `epfl-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: EPFL_COMPANY_NAME,
      companyKey: EPFL_KEY,
      companyDomain: EPFL_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: fallbackDescription,
      descriptionByLocale: { [sourceLang]: fallbackDescription },
      location,
      canton,
      url: publicUrl,
      source: 'EPFL Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // ── Recommended fields ──
      addressLocality: location,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, listing.department),
      contract: 'full-time',
      employmentType: detectEmploymentType(`${listing.contractType} ${title}`),
      experienceLevel: detectExperienceLevel(title, listing.department),
      sector: 'education',
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },

      // ── Extra metadata for downstream enrichment ──
      department: listing.department || '',
      contractType: listing.contractType || '',
      externalId: listing.jobId,
    };

    jobs.push(job);
  }

  console.log(`\n📋 Total EPFL jobs discovered: ${jobs.length}`);
  return jobs;
}
