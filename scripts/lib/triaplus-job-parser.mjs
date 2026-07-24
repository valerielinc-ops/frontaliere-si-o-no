#!/usr/bin/env node
/**
 * Triaplus AG job parser — custom WordPress career site.
 *
 * Public career site: https://karriere.triaplus.ch/freie-stellen/
 *   → paginated WP listing (`/freie-stellen/page/{N}/`) of job pages at
 *     `/jobs/{slug}/`.
 *
 * Triaplus AG (formerly Psychiatrische Klinik Zugersee) is an integrated
 * psychiatric provider ("Integrierte Psychiatrie Uri, Schwyz und Zug")
 * operating outpatient/inpatient sites across those three cantons — head
 * office Oberwil-Zug (ZG), plus Baar (ZG); Goldau, Pfäffikon SZ,
 * Einsiedeln, Lachen, Steinen (SZ); Altdorf (UR). Confirmed live 2026-07
 * against https://www.triaplus.ch/ueber-uns/triaplus-ag/standorte-und-bereiche
 * (issue #4418 — CORRECTION: an earlier header version here claimed a
 * "4 clinics incl. Klinik Meissenberg sister entity + Lucerne outpatient"
 * model; no live page, the standorte list above, nor any job's own
 * "Kantonen Uri, Schwyz und Zug" text mentions either, so that claim was
 * wrong and has been dropped). The career portal serves the whole group
 * from a single WordPress install.
 *
 * Each job page is a server-rendered `<article>` of type `single-jobs`.
 * The title block renders the REAL per-job location right after the H2:
 * `<span class="ort">in  Pfäffikon (SZ)</span>` / `in  Oberwil-Zug` /
 * `in  Baar` / `in  Altdorf` — confirmed live against 20 sample listings
 * spanning all three cantons (see `parseJobLocation` / `KNOWN_LOCATIONS`
 * below; issue #4418 fix — do NOT reintroduce a single hardcoded city for
 * every job). H3 sections ("Ihre Aufgaben beinhalten", "Sie bringen dafür
 * mit", "Wir bieten Ihnen") are concatenated into the description.
 *
 * Modelled on `scripts/lib/uroviva-job-parser.mjs` (multi-site Dualoo) and
 * `scripts/lib/spital-affoltern-job-parser.mjs` (multi-portal listing).
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripScriptsAndStyles } from './crawler-template.mjs';
import { normalizeCantonCode } from './target-swiss-locations.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  htmlToText,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

export const TRIAPLUS_KEY = 'triaplus';
export const TRIAPLUS_COMPANY_NAME = 'Triaplus AG';
export const TRIAPLUS_COMPANY_DOMAIN = 'triaplus.ch';

const BASE_URL = 'https://karriere.triaplus.ch';
const LISTING_URL = `${BASE_URL}/freie-stellen/`;
const PUBLIC_CAREER_URL = LISTING_URL;
const DETAIL_DELAY_MS = 250;
const MAX_PAGES = 10; // safety cap

// Head clinic is Klinik Zugersee in Oberwil-Zug (ZG). Used as the
// LAST-RESORT fallback only, when a job's own detail page doesn't carry a
// parsable `<span class="ort">` (see `parseJobLocation` below) — issue
// #4418, do not use this as the primary per-job location.
const DEFAULT_CITY = 'Oberwil';
const DEFAULT_POSTAL_CODE = '6317';
const DEFAULT_CANTON = 'ZG';

/**
 * Real Triaplus AG sites across cantons UR/SZ/ZG (confirmed live 2026-07
 * against https://www.triaplus.ch/ueber-uns/triaplus-ag/standorte-und-bereiche,
 * postal codes read from that page's address list; head-office postal code
 * cross-checked against the group's own "Widenstrasse 55, 6317 Oberwil-Zug"
 * address). Keyed by lowercased, diacritic-stripped city name so both
 * "Pfäffikon" and an ASCII-decoded "Pfaffikon" resolve. "oberwil-zug" (the
 * exact string the site renders) normalizes to the pre-existing
 * `DEFAULT_CITY` ('Oberwil') so head-clinic jobs keep the same city label
 * whether resolved via this table or via the fallback.
 */
const KNOWN_LOCATIONS = {
  'oberwil-zug': { city: DEFAULT_CITY, canton: DEFAULT_CANTON, postalCode: DEFAULT_POSTAL_CODE },
  oberwil: { city: DEFAULT_CITY, canton: DEFAULT_CANTON, postalCode: DEFAULT_POSTAL_CODE },
  baar: { city: 'Baar', canton: 'ZG', postalCode: '6340' },
  altdorf: { city: 'Altdorf', canton: 'UR', postalCode: '6460' },
  goldau: { city: 'Goldau', canton: 'SZ', postalCode: '6410' },
  pfaffikon: { city: 'Pfäffikon', canton: 'SZ', postalCode: '8808' },
  einsiedeln: { city: 'Einsiedeln', canton: 'SZ', postalCode: '8840' },
  lachen: { city: 'Lachen', canton: 'SZ', postalCode: '8853' },
  steinen: { city: 'Steinen', canton: 'SZ', postalCode: '6422' },
};

function stripDiacritics(s = '') {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Extract the REAL per-job location from a Triaplus job detail page.
 * Every job's title block renders
 * `<span class="ort">in  <City>[ (<CANTON>)]</span>` right after the
 * `<h2 class="… jobtitel">` — e.g. "in  Pfäffikon (SZ)", "in  Oberwil-Zug",
 * "in  Baar", "in  Altdorf". Confirmed live against 20 sample job pages
 * spanning all three cantons the group operates in (every page's own
 * "Integrierte Psychiatrie Uri, Schwyz und Zug" / "Kantonen Uri, Schwyz und
 * Zug" text agrees — issue #4418, replaces the previous hardcoded
 * `DEFAULT_CITY` used for every job regardless of clinic).
 *
 * Looks the extracted city up in `KNOWN_LOCATIONS` for the correct canton +
 * postal code (the span itself only sometimes carries a canton
 * abbreviation, and never a postal code). Falls back to a best-effort
 * `{ city, canton: <from span>, postalCode: DEFAULT_POSTAL_CODE }` for an
 * unrecognised-but-parsed city, and returns `null` only when the span
 * itself is missing/unparsable — callers then fall back to `DEFAULT_CITY`.
 */
export function parseJobLocation(html) {
  const m = String(html || '').match(/<span class="ort">\s*in\s+([^<(]+?)(?:\s*\(([A-Za-z]{2})\))?\s*<\/span>/i);
  if (!m) return null;
  const rawCity = normalizeSpace(decodeEntities(m[1]));
  if (!rawCity) return null;
  const known = KNOWN_LOCATIONS[stripDiacritics(rawCity).toLowerCase()];
  if (known) return known;
  // Validate against the real 26-canton registry — a well-formed-but-wrong
  // 2-letter code in the span must not be trusted verbatim (AGENTS.md #6
  // sibling class shared with pallas-kliniken/sodexo/mcdonalds/vitrea).
  const cantonFromSpan = normalizeCantonCode(m[2] || '');
  if (cantonFromSpan) return { city: rawCity, canton: cantonFromSpan, postalCode: DEFAULT_POSTAL_CODE };
  return null;
}

export function isTriaplusJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return job?.companyKey === TRIAPLUS_KEY
    || url.includes('triaplus.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'triaplus.ch'
      || host.endsWith('.triaplus.ch');
  } catch {
    return false;
  }
}

/**
 * Pull all `/jobs/{slug}/` hrefs from one listing page.
 */
export function parseListingPage(html) {
  const out = new Set();
  const rx = /href="(https:\/\/karriere\.triaplus\.ch\/jobs\/[a-z0-9-]+\/?)"/g;
  let m;
  while ((m = rx.exec(html))) {
    let url = m[1];
    if (!url.endsWith('/')) url += '/';
    out.add(url);
  }
  return [...out];
}

/**
 * Extract title + structured description sections from a job detail page.
 */
function parseJobDetail(html) {
  // Title comes from the H1 (`<h1 class="… jobtitel">…</h1>`) or the <title>.
  let title = '';
  const h1Match = stripScriptsAndStyles(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    title = normalizeSpace(decodeEntities(htmlToText(h1Match[1])));
  }
  if (!title) {
    const titleMatch = stripScriptsAndStyles(html).match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
      title = normalizeSpace(decodeEntities(titleMatch[1]))
        .replace(/\s*\|\s*Triaplus AG\s*$/i, '');
    }
  }

  // The H3 sections of interest — each followed by a <ul>/<p> block of
  // bullets/paragraphs. We capture everything between an H3 and the next
  // H3 / closing block. Triaplus uses H2 for the page title only and H3
  // for each content section.
  const SECTION_LABELS = [
    /ihre aufgaben/i,
    /sie bringen/i,
    /wir bieten/i,
    /das erwartet sie/i,
    /das bringen sie mit/i,
    /unser angebot/i,
    /viele gr[uü]nde/i,
  ];

  const sectionRx = /<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3[^>]*>|<div[^>]*class="[^"]*(?:cta-content|job-footer|person-item|brlbs)|<footer)/gi;
  const sections = [];
  let mm;
  while ((mm = sectionRx.exec(html))) {
    const headRaw = normalizeSpace(decodeEntities(htmlToText(mm[1])));
    if (!SECTION_LABELS.some((re) => re.test(headRaw))) continue;
    const bodyHtml = mm[2];
    const bullets = [];
    const liRx = /<li[^>]*>([\s\S]*?)<\/li>/g;
    let lm;
    while ((lm = liRx.exec(bodyHtml))) {
      const t = normalizeSpace(decodeEntities(htmlToText(lm[1])));
      if (t && t.length > 4) bullets.push(`• ${t}`);
    }
    let bodyText = '';
    if (bullets.length) {
      bodyText = bullets.join('\n');
    } else {
      bodyText = normalizeSpace(decodeEntities(htmlToText(bodyHtml)));
    }
    if (bodyText) sections.push(`${headRaw}\n${bodyText}`);
  }

  return { title, sections };
}

export async function fetchAllTriaplusJobs() {
  console.log(`🏥 Fetching ${TRIAPLUS_COMPANY_NAME} jobs`);
  console.log(`   Listing: ${LISTING_URL}`);
  console.log(`   Public:  ${PUBLIC_CAREER_URL}\n`);

  // Walk pagination until a page returns 0 new URLs.
  const allUrls = new Set();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = page === 1 ? LISTING_URL : `${LISTING_URL}page/${page}/`;
    let html = '';
    try {
      html = await fetchHtml(url);
    } catch (err) {
      if (page === 1) throw err;
      break;
    }
    const before = allUrls.size;
    parseListingPage(html).forEach((u) => allUrls.add(u));
    const added = allUrls.size - before;
    console.log(`  ✓ page ${page}: ${added} new job URLs (total ${allUrls.size})`);
    if (added === 0) break;
  }

  const detailUrls = [...allUrls];
  if (!detailUrls.length) return [];

  console.log(`  📄 Fetching ${detailUrls.length} job detail pages...`);

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;
  const seenIds = new Set();

  for (let i = 0; i < detailUrls.length; i += 1) {
    const detailUrl = detailUrls[i];
    if (i > 0) await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));

    let html = '';
    try {
      html = await fetchHtml(detailUrl);
    } catch {
      continue;
    }

    const { title, sections } = parseJobDetail(html);
    if (!title || title.length < 3) continue;

    // Real per-job location (issue #4418) — falls back to the head-clinic
    // default only when this specific job's `<span class="ort">` is
    // missing/unparsable, not as the primary path.
    const loc = parseJobLocation(html)
      || { city: DEFAULT_CITY, canton: DEFAULT_CANTON, postalCode: DEFAULT_POSTAL_CODE };

    const rich = sections.join('\n\n').trim();
    if (rich) detailHits += 1;

    const description = [
      rich,
      `${TRIAPLUS_COMPANY_NAME} — Psychiatrische Klinik, ${loc.city} (${loc.canton}), Schweiz.`,
      `Bewerbung über das Karriereportal: ${detailUrl}`,
    ].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || title, 'de');
    const slugFromUrl = (detailUrl.match(/\/jobs\/([a-z0-9-]+)\/?$/) || [])[1] || '';
    const jobSlug = slugify(`${title} ${TRIAPLUS_KEY} ${slugFromUrl || loc.city}`);
    const urlHash = createHash('sha1').update(detailUrl).digest('hex').slice(0, 12);
    const id = `${TRIAPLUS_KEY}-${urlHash}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    jobs.push({
      id,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: TRIAPLUS_COMPANY_NAME,
      companyKey: TRIAPLUS_KEY,
      companyDomain: TRIAPLUS_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band. Without this
      // flag the locale-completeness gate trips before translation can run.
      needsRetranslation: true,
      location: loc.city,
      canton: loc.canton,
      url: detailUrl,
      source: `${TRIAPLUS_COMPANY_NAME} Dedicated Parser (WordPress career site)`,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: loc.city,
      addressRegion: loc.canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: loc.postalCode,
      category: detectHealthcareCategory(title),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(title),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: detailUrl,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(
    `📋 Total ${TRIAPLUS_COMPANY_NAME} jobs discovered: ${jobs.length} `
    + `(${detailHits}/${detailUrls.length} with rich detail content)`,
  );
  return jobs;
}

export { LISTING_URL, PUBLIC_CAREER_URL };
