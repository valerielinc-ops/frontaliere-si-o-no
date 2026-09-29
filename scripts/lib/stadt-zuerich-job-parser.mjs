#!/usr/bin/env node
/**
 * Stadt Zürich (City of Zürich municipal administration) job parser —
 * Fetcher and job builder.
 *
 * Source: https://jobs.stadt-zuerich.ch/search/
 *
 * The city's career portal runs on a legacy SAP SuccessFactors "jobs2web"
 * (Career Site Builder) tenant — `ssoCompanyId: 'STZH'`, `ssoUrl:
 * career2.successfactors.eu` — but on a branded host/path shape
 * (`jobs.stadt-zuerich.ch/job/{slug}/{id}/`) that the shared
 * `ats-clients/successfactors-client.mjs` detector does not recognise
 * (it only matches `/Switzerland|Schweiz|Suisse|Svizzera/job/` and a
 * handful of known hosts). Rather than widen that shared detector for a
 * one-off host pattern, this parser fetches directly — same posture as
 * `kanton-gr-job-parser.mjs` (Refline) and `heineken-ch-job-parser.mjs`
 * (post-migration Drupal): standalone fetch + regex, no ATS client.
 *
 * Listing behaviour:
 *   - `search/?q=&sortColumn=referencedate&sortDirection=desc&startrow={N}`
 *     is server-rendered HTML — 25 `<li class="job-tile job-id-{id}">`
 *     tiles per page, no JS required. Tile fields: job title (`.jobTitle-link`,
 *     href `/job/{slug}/{id}/`), Departement (`customfield1`), Dienstabteilung
 *     (`customfield2`), Referenz-Nr. (`adcode`).
 *   - Detail pages (`/job/{slug}/{id}/`) render the SAME three fields plus a
 *     `schema.org/JobPosting` microdata stub, but the actual description body
 *     (`.jobdescription`) and `jobLocation`/`streetAddress` are empty in the
 *     server HTML — the real body is injected client-side (SPA hydration)
 *     that this parser cannot execute without a browser. Detail fetches add
 *     NO signal over the listing tile (verified: identical Departement/
 *     Dienstabteilung/Referenz-Nr., no pensum, no location) — so we skip
 *     them entirely. The vacancy text comes from the city's official ad page
 *     with the same Referenz-Nr. (see OFFICIAL_HOST below); a tile without
 *     one is not published (issue 5253).
 *
 * Structured-data safe defaults (Non-Negotiable #3 — source has none of
 * these per-job): every job gets the Stadthaus Zürich civic address
 * (Stadthausquai 17, 8001 Zürich, ZH) as `streetAddress`/`postalCode`/
 * `addressLocality`, and `employmentType` heuristically parsed from a
 * workload percentage in the title when present (e.g. "60 - 80%"),
 * else `'OTHER'` (never dropped, never blank).
 *
 * Cross-crawler dedup: the portal aggregates postings from several city
 * entities that ALREADY have their own dedicated crawlers pulling from
 * their own career sites (Stadtspital Zürich, Psychiatrische
 * Universitätsklinik Zürich, Spitex Zürich, Suchtfachstelle Zürich). Jobs
 * whose Dienstabteilung/Departement matches those entities are filtered
 * out here to avoid the same posting being ingested twice under two
 * different `company` values.
 *
 * Exports the 4 required functions for the crawler template:
 *   - fetchAllStadtZuerichJobs()  — Fetch and parse all jobs
 *   - isStadtZuerichJob()         — Match jobs belonging to this company
 *   - isTrustedDomain()           — Validate URLs belong to this company
 *   - slugify() / stripHtml()     — Re-exported from crawler-template.mjs
 */
import { createHash } from 'node:crypto';
import { slugify, stripHtml, normalizeSpace, normalizeDescriptionSpace, normalizeDescriptionBullets } from './crawler-template.mjs';
import { isSuccessFactorsWidgetText } from './successfactors-jobs2web-widget-guard.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const STADT_ZUERICH_KEY = 'stadt-zuerich';
export const STADT_ZUERICH_COMPANY_NAME = 'Stadt Zürich';
export const STADT_ZUERICH_COMPANY_DOMAIN = 'stadt-zuerich.ch';

const ATS_HOST = 'jobs.stadt-zuerich.ch';
const SEARCH_BASE = `https://${ATS_HOST}/search/`;
const PAGE_SIZE = 25;
const MAX_PAGES = 30; // safety cap (~750 jobs) — real volume is ~500

// Civic HQ — Stadthaus Zürich (verified 2026-07-03), used as the safe
// default address for every job (source exposes no per-job address).
const HQ = {
  streetAddress: 'Stadthausquai 17',
  city: 'Zürich',
  canton: 'ZH',
  postalCode: '8001',
  addressRegion: 'ZH',
};

const SECTOR = 'Amministrazione Pubblica';

// The vacancy text is NOT on the jobs2web page: its `.jobdescription` holds
// only the title, even after client-side rendering (verified 2026-09-29 with
// a headless browser). The city publishes each ad on its own portal
// ("Arbeiten für Zürich", www.stadt-zuerich.ch), one page per posting,
// carrying the same Referenz-Nr. as the jobs2web tile's `adcode`. The
// portal's own search component lists every page in one JSON call.
const OFFICIAL_HOST = 'https://www.stadt-zuerich.ch';
const OFFICIAL_JOBSEARCH_URL = `${OFFICIAL_HOST}/stzh/jobsearch`;
const OFFICIAL_JOBSEARCH_COMPONENT =
  '/content/web/de/politik-und-verwaltung/arbeiten-bei-der-stadt/jobs/jcr:content/mainparsys/jobsearch';
const OFFICIAL_JOBSEARCH_LIMIT = 2000;
// A Swiss phone number: the recruiter contact block of each ad.
const CONTACT_PHONE_RE = /(?:\+41|\b0)\s?\d{2}\s?\d{3}\s?\d{2}\s?\d{2}\b/;

// Dienstabteilung/Departement substrings already covered by their own
// dedicated crawler pulling from a DIFFERENT source site — exclude here so
// the same posting is never ingested twice under two `company` values.
const EXCLUDED_UNIT_SUBSTRINGS = [
  'stadtspital',
  'psychiatrische universitätsklinik',
  'puk zürich',
  'spitex zürich',
  'suchtfachstelle zürich',
];

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Helpers ───────────────────────────────────────────────── */

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

/* ── Company Matchers ──────────────────────────────────────── */

/**
 * Check if a job belongs to Stadt Zürich (the municipal administration —
 * NOT the Zurich Insurance Group, which has its own unrelated
 * `update-zurich-jobs.mjs` crawler).
 */
export function isStadtZuerichJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');

  return (
    key === STADT_ZUERICH_KEY ||
    key.startsWith('stadt-zuerich') ||
    company === 'stadt zürich' ||
    url.includes(ATS_HOST)
  );
}

/**
 * Validate that a URL belongs to Stadt Zürich's domains.
 */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === ATS_HOST ||
      host === 'stadt-zuerich.ch' ||
      host.endsWith('.stadt-zuerich.ch')
    );
  } catch {
    return false;
  }
}

function isExcludedUnit(department = '', unit = '') {
  const hay = `${normalize(department)} ${normalize(unit)}`;
  return EXCLUDED_UNIT_SUBSTRINGS.some((needle) => hay.includes(needle));
}

/* ── Category Detection ───────────────────────────────────── */

function detectCategory(title = '', department = '', unit = '') {
  const t = normalize(title);
  const d = `${normalize(department)} ${normalize(unit)}`;

  if (/\b(lehrer|lehrperson|lernend|schul|kindergarten|hort|lehrstelle|schnupperlehre|heilpädagog)/.test(t) || d.includes('schulbehörde') || d.includes('schul')) return 'Formazione';
  if (/\b(polizei|feuerwehr|rettung|sicherheit)/.test(t) || d.includes('stadtpolizei') || d.includes('schutz & rettung')) return 'Sicurezza';
  if (/\b(pflege|fachperson gesundheit|fage|betreu|sanitä|dentalassist|arzt|ärztin|therap)/.test(t)) return 'Infermieristica';
  if (/\b(sozial|agog)/.test(t) || d.includes('soziale')) return 'Sociale';
  if (/\b(ingenieur|bauleit|tiefbau|hochbau|geomat|vermessung|strassen)/.test(t) || d.includes('tiefbau') || d.includes('städtebau')) return 'Ingegneria';
  if (/\b(it[- ]|software|informatik|develop|system|cyber|power platform|applikation)/.test(t) || d.includes('organisation und informatik')) return 'IT';
  if (/\b(jurist|recht|anwält|anwalt)/.test(t)) return 'Legale';
  if (/\b(finanz|controll|steuer|buchhalt)/.test(t) || d.includes('finanzverwaltung')) return 'Finanza';
  if (/\b(hr[- ]|personal)/.test(t) || d.includes('human resources')) return 'Risorse Umane';
  if (/\b(kultur|museum|bibliothek)/.test(t) || d.includes('kultur')) return 'Cultura';
  if (/\b(sport)/.test(t) || d.includes('sportamt')) return 'Sport';
  if (/\b(elektr|wasserversorg|entsorg|recycling|energie)/.test(t) || d.includes('elektrizitätswerk') || d.includes('entsorgung') || d.includes('wasserversorgung')) return 'Ambiente / Energia';
  if (/\b(verkehrsbetrieb|chauffeur|fahrer|tram|bus)/.test(t) || d.includes('verkehrsbetriebe')) return 'Trasporti';
  if (/\b(garten|greenkeeper|natur|grün)/.test(t) || d.includes('grün stadt')) return 'Ambiente / Energia';
  if (/\b(admin|sachbearbeit|sekretär|assistent|mitarbeit)/.test(t)) return 'Amministrazione';
  return 'Amministrazione Pubblica';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagiair|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|apprendist|lehrling|lernend|apprenti|lehrstelle|schnupperlehre|aspirant)/.test(t)) return 'intern';
  if (/\b(junior|jr)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|dirett|chef|verantwort|responsab|leiter|kommandant|bereichsleiter)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Parse a workload percentage out of the title (e.g. "60 - 80%", "100 %",
 * "50% bis 90%") and map it to a coarse `employmentType`. Titles with no
 * parseable percentage keep the safe default `'OTHER'` (Non-Negotiable #3 —
 * never drop the field, never fabricate a specific number).
 */
function detectEmploymentType(title = '') {
  const matches = [...String(title || '').matchAll(/(\d{2,3})\s*%/g)].map((m) => Number(m[1]));
  if (!matches.length) return 'OTHER';
  const max = Math.max(...matches);
  if (max >= 90) return 'FULL_TIME';
  return 'PART_TIME';
}

/* ── HTML Fetching ─────────────────────────────────────────── */

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
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ── HTML Parsing — Listing Page ──────────────────────────────
 *
 * Tile structure (one `<li>` per job, repeated 3x for desktop/tablet/mobile
 * breakpoints — we only need the first, most complete occurrence):
 *
 *   <li class="job-tile job-id-{id} ..." data-url="/job/{slug}/{id}/" ...>
 *     ...
 *     <a class="jobTitle-link ..." href="/job/{slug}/{id}/">{title}</a>
 *     ...
 *     <div id="job-{id}-desktop-section-customfield1-value">{Departement}</div>
 *     <div id="job-{id}-desktop-section-customfield2-value">{Dienstabteilung}</div>
 *     <div id="job-{id}-desktop-section-adcode-value">{Referenz-Nr.}</div>
 *   </li>
 *
 * Exported (single source of truth for the tile regexes): the same portal
 * hosts the Stadtspital Zürich postings, and
 * `stadtspital-zuerich-job-parser.mjs` reuses this function on its
 * facet-filtered listing pages instead of duplicating the regexes.
 */
export function parseListingTiles(html = '') {
  const rows = [];
  const seen = new Set();
  const tileSplits = String(html || '').split('<li class="job-tile job-id-');

  for (let i = 1; i < tileSplits.length; i++) {
    const tile = tileSplits[i];
    const idMatch = tile.match(/^(\d+)/);
    const jobId = idMatch ? idMatch[1] : '';
    if (!jobId || seen.has(jobId)) continue;

    const urlMatch = tile.match(/data-url="([^"]+)"/);
    const titleMatch = tile.match(/jobTitle-link[^>]*>\s*([\s\S]*?)\s*<\/a>/);
    const deptMatch = tile.match(/customfield1-value">([^<]*)/);
    const unitMatch = tile.match(/customfield2-value">([^<]*)/);
    const refMatch = tile.match(/adcode-value">([^<]*)/);

    const title = titleMatch ? normalizeSpace(stripHtml(titleMatch[1])) : '';
    if (!title || title.length < 3 || !urlMatch) continue;
    // The jobTitle-link anchor is sometimes the SF j2w cookie-consent or
    // search widget rather than an actual posting — not a job, discard.
    if (isSuccessFactorsWidgetText(title)) continue;

    seen.add(jobId);
    rows.push({
      jobId,
      path: urlMatch[1],
      title,
      department: deptMatch ? normalizeSpace(deptMatch[1]) : '',
      unit: unitMatch ? normalizeSpace(unitMatch[1]) : '',
      ref: refMatch ? normalizeSpace(refMatch[1]) : '',
    });
  }

  return rows;
}

/* ── Official ad pages ("Arbeiten für Zürich") ─────────────── */

function officialBlockText(blockHtml = '') {
  return normalizeDescriptionSpace(stripHtml(String(blockHtml)
    .replace(/<a\b[^>]*href="tel:[^"]*"[^>]*>[\s\S]*?<\/a>/gi, '')));
}

/**
 * Parse one official ad page (`/…/jobs/job-detailseite.{id}.html`): the
 * Referenz-Nr. and the vacancy body — every `<stzh-richtext>` section of the
 * page content in order (intro, Aufgaben, Profil, Wir bieten, Über uns),
 * headings on their own line and list items as bullets. The "Interessiert?"
 * contact block (recruiter names and direct phone numbers) is left out, as
 * is page chrome outside the sections.
 *
 * @param {string} html
 * @returns {{ ref: string, description: string } | null}
 */
export function parseOfficialAdPage(html = '') {
  if (!html || typeof html !== 'string') return null;
  const ref = (html.match(/Referenz-Nr\.?:?\s*(\d{3,})/i) || [])[1] || '';
  const content = (html.match(/<stzh-pagecontent\b[\s\S]*?<\/stzh-pagecontent>/i) || [html])[0];
  const sections = [];
  const re = /<stzh-richtext\b[^>]*>([\s\S]*?)<\/stzh-richtext>/gi;
  let m;
  while ((m = re.exec(content)) !== null) {
    if (CONTACT_PHONE_RE.test(stripHtml(m[1]))) continue;
    const text = officialBlockText(m[1]);
    if (text) sections.push(text);
  }
  const description = normalizeDescriptionBullets(sections.join('\n\n'));
  if (!ref || !description) return null;
  return { ref, description };
}

/**
 * Referenz-Nr. → full vacancy text, read from the city's official ad pages.
 * One search call lists every page; each page is then fetched politely.
 * Throws when the portal's index cannot be read: without it no posting has
 * its text, and publishing none would empty the whole board.
 *
 * Exported for `stadtspital-zuerich-job-parser.mjs`, whose tiles live on the
 * same portal: `unit` keeps only the ad pages whose Dienstabteilung (the
 * index entry's first meta value) matches, so that crawler reads its own
 * ~90 pages instead of the whole city index.
 *
 * @param {Set<string>} wantedRefs Referenz-Nr. of the tiles to fill
 * @param {number} delayMs pause between two ad pages
 * @param {{ unit?: RegExp }} [options]
 * @returns {Promise<Map<string, string>>}
 */
export async function fetchOfficialAdTexts(wantedRefs, delayMs, { unit } = {}) {
  const byRef = new Map();
  let index;
  try {
    const params = new URLSearchParams({
      q: '',
      lang: 'de',
      compResource: OFFICIAL_JOBSEARCH_COMPONENT,
      variant: 'default',
      offset: '0',
      limit: String(OFFICIAL_JOBSEARCH_LIMIT),
    });
    index = JSON.parse(await fetchPage(`${OFFICIAL_JOBSEARCH_URL}?${params}`));
  } catch (err) {
    throw new Error(`Stadt Zürich official ad index unavailable (${err?.message || err}): no posting has its vacancy text`);
  }
  const hrefs = [...new Set((Array.isArray(index?.results) ? index.results : [])
    .filter((r) => !unit || unit.test(String(Array.isArray(r?.meta) ? r.meta[0] || '' : '')))
    .map((r) => String(r?.href || ''))
    .filter((href) => /\/job-detailseite\.\d+\.html$/.test(href)))];
  console.log(`  📰 Official ad pages listed: ${hrefs.length}`);
  for (const href of hrefs) {
    if (wantedRefs.size && [...wantedRefs].every((ref) => byRef.has(ref))) break;
    try {
      const parsed = parseOfficialAdPage(await fetchPage(`${OFFICIAL_HOST}${href}`));
      if (parsed && !byRef.has(parsed.ref)) byRef.set(parsed.ref, parsed.description);
    } catch (err) {
      console.warn(`  ⚠️ Official ad page failed: ${href} — ${err?.message || err}`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return byRef;
}

/* ── Main Fetch Function ──────────────────────────────────── */

/**
 * Fetch all Stadt Zürich jobs from the public jobs2web listing.
 * Returns an array of ParsedJob objects (source-locale only, German).
 */
export async function fetchAllStadtZuerichJobs() {
  console.log('🔍 Fetching Stadt Zürich (municipal administration) jobs');
  console.log(`   Source: ${SEARCH_BASE}\n`);

  const allRows = [];
  const seenIds = new Set();
  const delayMs = Number(process.env.JOBS_CRAWLER_DELAY_MS) || 400;

  for (let page = 0; page < MAX_PAGES; page++) {
    const startrow = page * PAGE_SIZE;
    const url = `${SEARCH_BASE}?q=&sortColumn=referencedate&sortDirection=desc&startrow=${startrow}`;
    let html;
    try {
      html = await fetchPage(url);
    } catch (err) {
      console.warn(`  ⚠️ Failed to fetch listing page ${page} (startrow=${startrow}): ${err.message}`);
      break;
    }
    const rows = parseListingTiles(html).filter((r) => !seenIds.has(r.jobId));
    console.log(`  📄 Page ${page} (startrow=${startrow}): ${rows.length} new job(s)`);
    if (rows.length === 0) break;
    for (const r of rows) {
      seenIds.add(r.jobId);
      allRows.push(r);
    }
    if (rows.length < PAGE_SIZE) break;
    if (page < MAX_PAGES - 1) await new Promise((r) => setTimeout(r, delayMs));
  }

  if (allRows.length === 0) {
    console.warn('⚠️ No job listings found.');
    return [];
  }

  console.log(`\n  📋 Total unique listings discovered: ${allRows.length}`);

  // Filter out entities that already have their OWN dedicated crawler
  // pulling from a different source site (avoid double-ingesting the
  // same posting under two different `company` values).
  const excluded = allRows.filter((r) => isExcludedUnit(r.department, r.unit));
  const rows = allRows.filter((r) => !isExcludedUnit(r.department, r.unit));
  if (excluded.length > 0) {
    console.log(`  🧹 Excluded ${excluded.length} job(s) already covered by a sibling dedicated crawler (e.g. Stadtspital Zürich).`);
  }

  const sourceLang = 'de';
  const jobs = [];
  const officialTexts = await fetchOfficialAdTexts(
    new Set(rows.map((r) => r.ref).filter(Boolean)),
    Math.min(delayMs, 300),
  );
  let withoutText = 0;

  for (const row of rows) {
    const title = row.title;
    const publicUrl = `https://${ATS_HOST}${row.path}`;
    const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);
    // Include the stable reference number in the slug seed — city-admin
    // postings frequently repeat the exact same title across departments
    // (e.g. "Sozialarbeiter*in Erwachsenenprofil" x5 distinct postings), and
    // without a disambiguator the assemble step's slug-collision guard would
    // silently drop all but one of them.
    const jobSlug = slugify(`${title} stadt-zuerich zurigo ${row.ref || row.jobId}`);
    // The official ad text of this Referenz-Nr. is the vacancy text. The
    // tile summary that used to stand in for it made distinct postings with
    // the same title and unit identical (19/430 duplicate descriptions) and
    // carried no tasks/profile/offer (audit run 36528331656); a tile the
    // portal does not publish is not published here either (issue 5253).
    const officialText = row.ref ? officialTexts.get(String(row.ref)) : '';
    if (!officialText) {
      withoutText += 1;
      continue;
    }
    const descriptionText = officialText;
    const employmentType = detectEmploymentType(title);
    const expLevel = detectExperienceLevel(title);

    const job = {
      // -- Required fields --
      id: `stadt-zuerich-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: STADT_ZUERICH_COMPANY_NAME,
      companyKey: STADT_ZUERICH_KEY,
      companyDomain: STADT_ZUERICH_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description: descriptionText,
      descriptionByLocale: { [sourceLang]: descriptionText },
      location: HQ.city,
      canton: HQ.canton,
      url: publicUrl,
      source: 'Stadt Zürich Dedicated Parser',
      sourceLang,
      crawledAt: new Date().toISOString(),

      // -- Recommended / structured-data safe defaults (Non-Negotiable #3) --
      streetAddress: HQ.streetAddress,
      addressLocality: HQ.city,
      postalCode: HQ.postalCode,
      addressRegion: HQ.addressRegion,
      addressCountry: 'CH',
      country: 'CH',
      category: detectCategory(title, row.department, row.unit),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: expLevel,
      sector: SECTOR,
      currency: 'CHF',
      featured: false,
      postedDate: new Date().toISOString().split('T')[0],
      applyUrl: publicUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    };

    if (row.department) job.department = row.department;
    if (row.unit) job.unit = row.unit;
    if (row.ref) job.referenceNumber = row.ref;

    jobs.push(job);
    console.log(`  ✅ ${title.substring(0, 55)} — ${row.department || 'N/A'} / ${row.unit || 'N/A'}`);
  }

  if (withoutText > 0) {
    console.log(`  ⏭️ ${withoutText} tile(s) whose Referenz-Nr. has no official ad page — not published.`);
  }
  console.log(`\n📋 Total Stadt Zürich jobs discovered: ${jobs.length} (all with the official ad text)`);
  return jobs;
}

export { slugify, stripHtml };
