#!/usr/bin/env node
/**
 * AMEOS Schweiz — dedicated parser.
 *
 * Group portal: https://karriere.ameos.eu/offene-stellen
 *   TYPO3 + ext_solr listing of ~770 jobs across DE/CH. AMEOS group has 2
 *   Swiss sites — AMEOS Seeklinik Brunnen (SZ) and AMEOS Spital Einsiedeln
 *   (SZ) — plus a Zürich corporate office. Group-wide search has no
 *   "country" facet (regions are Nord/Ost/Süd/West, all in DE-DACH).
 *
 *   Strategy: query `searchWords=<CH city>` for each known Swiss site, union
 *   the results, dedupe by numeric job ID, then keep only jobs whose slug
 *   ends with `-in-{ch-city}` (drops German false positives that contain
 *   "Zürich" only in the body but are based elsewhere).
 *
 * Detail: https://karriere.ameos.eu/offene-stellen/stelle/{id}-{slug}
 *   Body lives in <div class="frame-type-ameosjobs">. H1 is the clean title.
 *
 * Swiss sites covered:
 *   - Brunnen (SZ), PC 6440 — AMEOS Seeklinikum, psychiatry + addiction
 *   - Einsiedeln (SZ), PC 8840 — AMEOS Spital, ambulance training site
 *   - Zürich (ZH), PC 8001 — AMEOS Holding corporate office
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const AMEOS_CH_KEY = 'ameos-ch';
export const AMEOS_CH_COMPANY_NAME = 'AMEOS Schweiz';
export const AMEOS_CH_COMPANY_DOMAIN = 'karriere.ameos.eu';
export const AMEOS_CH_CAREERS_URL = 'https://karriere.ameos.eu/offene-stellen';

const DETAIL_DELAY_MS = 450;

// City → fixed metadata for AMEOS Swiss sites. The key is the lowercase
// city token that must appear in the slug suffix (`-in-{city}`).
const AMEOS_CH_SITES = [
  { match: /-in-brunnen($|[/-])/i,    city: 'Brunnen',    postalCode: '6440', canton: 'SZ' },
  { match: /-in-einsiedeln($|[/-])/i, city: 'Einsiedeln', postalCode: '8840', canton: 'SZ' },
  { match: /-in-z(uerich|%c3%bcrich)($|[/-])/i, city: 'Zürich', postalCode: '8001', canton: 'ZH' },
];

const CH_SEARCH_TERMS = ['Brunnen', 'Einsiedeln', 'Zürich'];

/* ── Company matchers ──────────────────────────────────────── */

export function isAmeosChJob(job) {
  if (job?.companyKey === AMEOS_CH_KEY) return true;
  const company = String(job?.company || '').toLowerCase();
  if (company.includes('ameos')) return true;
  const url = String(job?.url || '').toLowerCase();
  return url.includes('karriere.ameos.eu');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'karriere.ameos.eu' || host.endsWith('.ameos.eu');
  } catch {
    return false;
  }
}

/* ── Site routing ──────────────────────────────────────────── */

export function resolveAmeosChSite(slug = '') {
  for (const site of AMEOS_CH_SITES) {
    if (site.match.test(slug)) return site;
  }
  return null;
}

/* ── Listing parsing ──────────────────────────────────────── */

/**
 * Parse a single AMEOS search HTML payload and return /stelle/{id}-{slug}
 * rows. The caller is responsible for unioning multi-term searches and
 * deduping by jobId.
 *
 * @param {string} html
 * @returns {Array<{ url: string, slug: string, jobId: string }>}
 */
export function parseListing(html = '') {
  const out = [];
  const re = /href="(\/offene-stellen\/stelle\/(\d+)-([^"?#]+))"/gi;
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const jobId = m[2];
    const slug = m[3];
    if (seen.has(jobId)) continue;
    seen.add(jobId);
    out.push({ url: `https://karriere.ameos.eu${href}`, jobId, slug });
  }
  return out;
}

/**
 * Filter listing rows to keep only the ones whose slug suffix points to a
 * known Swiss AMEOS site (Brunnen / Einsiedeln / Zürich).
 */
export function filterChJobs(rows = []) {
  return rows.filter((row) => resolveAmeosChSite(row.slug));
}

/* ── Detail parsing ───────────────────────────────────────── */

export function parseDetail(html = '') {
  if (!html) return { title: '', body: '' };
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch
    ? normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ' ')))
    : '';
  // Body container: <div class="… frame-type-ameosjobs_jobshow …">…</div>
  // followed by another frame-type-* sibling (back-link). We slice from the
  // opening tag to that next sibling, strip tags, and drop the leading
  // inline CSS that TYPO3 prepends.
  const openRe = /<div[^>]*class="[^"]*\bframe-type-ameosjobs[a-z_]*\b[^"]*"[^>]*>/i;
  const openMatch = html.match(openRe);
  let body = '';
  if (openMatch) {
    const start = openMatch.index + openMatch[0].length;
    // Strip <script>/<style>/<noscript> on the full tail FIRST. The next-frame
    // search and the 16000-char fallback would otherwise truncate INSIDE an
    // inline script block, leaving an unclosed `<script>` whose closing tag
    // sits past the slice — the strip regex can't match it, and the keSearch
    // autocomplete JS leaks into the job body as plain text.
    const tail = html
      .slice(start)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ');
    // Bound by `</section>` when present (the ameosjobs frame lives inside a
    // <section> that closes before the global footer); fall back to next
    // non-ameosjobs frame-type, then to a 16k cap.
    const sectionCloseIdx = tail.search(/<\/section\s*>/i);
    const nextFrame = tail.search(/<div[^>]*class="[^"]*\bframe-type-(?!ameosjobs)/i);
    const bounds = [sectionCloseIdx, nextFrame].filter((n) => n > 0);
    const cut = bounds.length > 0 ? Math.min(...bounds) : 16000;
    const inner = tail.slice(0, cut);
    let text = decodeEntities(inner.replace(/<[^>]+>/g, ' '));
    text = normalizeSpace(text);
    // TYPO3 sometimes inlines a CSS rule block before the body content; if
    // the text starts with selectors ending in `} text`, drop everything up
    // to (and including) the last `}` before the actual job heading.
    if (text.startsWith('main ') || text.startsWith('section ') || /^[a-z0-9.#: ,>*\[\]\-=":!{}]+\}/i.test(text)) {
      const idx = text.lastIndexOf('}');
      if (idx > 0 && idx < 1500) text = text.slice(idx + 1).trim();
    }
    body = text.slice(0, 6000);
  }
  return { title, body };
}

/* ── Fetcher ───────────────────────────────────────────────── */

async function fetchSearchTerm(term) {
  const url = `${AMEOS_CH_CAREERS_URL}?tx_ameosjobs_jobslist%5Bdemand%5D%5BsearchWords%5D=${encodeURIComponent(term)}`;
  try {
    return await fetchHtml(url);
  } catch (err) {
    console.warn(`  ⚠️ Search "${term}" failed: ${err?.message || err}`);
    return '';
  }
}

export async function fetchAllAmeosChJobs() {
  console.log(`🏥 Fetching ${AMEOS_CH_COMPANY_NAME} jobs`);
  console.log(`   Search terms: ${CH_SEARCH_TERMS.join(', ')}\n`);

  // Union search results across CH search terms.
  const merged = new Map();
  for (const term of CH_SEARCH_TERMS) {
    const html = await fetchSearchTerm(term);
    const rows = parseListing(html);
    for (const row of rows) merged.set(row.jobId, row);
  }
  const allRows = [...merged.values()];
  console.log(`  ✓ ${allRows.length} unique rows across CH search terms`);
  const chRows = filterChJobs(allRows);
  console.log(`  ✓ ${chRows.length} rows match an AMEOS Swiss site slug`);
  if (chRows.length === 0) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (let i = 0; i < chRows.length; i += 1) {
    const row = chRows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    const site = resolveAmeosChSite(row.slug);
    let detail = { title: '', body: '' };
    try {
      const html = await fetchHtml(row.url);
      detail = parseDetail(html);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${row.url}: ${err?.message || err}`);
    }
    const title = detail.title || decodeURIComponent(row.slug).replace(/-/g, ' ');
    const intro = `AMEOS Schweiz — Teil der AMEOS-Gruppe (Spitäler, Polikliniken, Reha- und Pflegeeinrichtungen). Schweizer Standorte: AMEOS Seeklinikum Brunnen (SZ), AMEOS Spital Einsiedeln (SZ), AMEOS Holding Zürich. Stelle: ${title} (${site.city}, ${site.canton}).`;
    const description = (detail.body && detail.body.length > 200)
      ? `${intro}\n\n${detail.body}`
      : intro;

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ameos ${site.city}`);
    const urlHash = createHash('sha1').update(row.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${AMEOS_CH_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: AMEOS_CH_COMPANY_NAME,
      companyKey: AMEOS_CH_KEY,
      companyDomain: AMEOS_CH_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: site.city,
      canton: site.canton,
      url: row.url,
      source: `${AMEOS_CH_COMPANY_NAME} Dedicated Parser`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: site.city,
      addressRegion: site.canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: site.postalCode,
      category: detectHealthcareCategory(`${title} ${description.slice(0, 500)}`),
      contract: /\b\d{2,3}\s*[-–]\s*\d{2,3}\s*%\b/.test(title) ? 'part-time' : 'full-time',
      employmentType: detectHealthcareEmploymentType(
        `${title} ${description.slice(0, 500)}`
      ),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: site.city === 'Zürich' ? 'Verwaltung / Holding' : 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: row.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${AMEOS_CH_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { AMEOS_CH_SITES, CH_SEARCH_TERMS };
