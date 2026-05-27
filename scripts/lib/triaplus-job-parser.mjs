#!/usr/bin/env node
/**
 * Triaplus AG job parser — custom WordPress career site.
 *
 * Public career site: https://karriere.triaplus.ch/freie-stellen/
 *   → paginated WP listing (`/freie-stellen/page/{N}/`) of job pages at
 *     `/jobs/{slug}/`.
 *
 * Triaplus AG (formerly Psychiatrische Klinik Zugersee) operates four
 * psychiatric clinics across central Switzerland under one umbrella:
 *   - Klinik Zugersee, Oberwil b. Zug (ZG, head clinic)
 *   - Klinik Meissenberg (sister entity — separate site)
 *   - Outpatient centres in Zug, Lucerne, Schwyz
 * The career portal serves the whole group from a single WordPress install.
 *
 * Each job page is a server-rendered `<article>` of type `single-jobs`
 * with H2 sections ("Ihre Aufgaben beinhalten", "Sie bringen dafür mit",
 * "Wir bieten Ihnen") that we concatenate into the description.
 *
 * Modelled on `scripts/lib/uroviva-job-parser.mjs` (multi-site Dualoo) and
 * `scripts/lib/spital-affoltern-job-parser.mjs` (multi-portal listing).
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
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

// Head clinic is Klinik Zugersee in Oberwil-Zug (ZG).
const DEFAULT_CITY = 'Oberwil';
const DEFAULT_POSTAL_CODE = '6317';
const DEFAULT_CANTON = 'ZG';

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
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    title = normalizeSpace(decodeEntities(htmlToText(h1Match[1])));
  }
  if (!title) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
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

    const rich = sections.join('\n\n').trim();
    if (rich) detailHits += 1;

    const description = [
      rich,
      `${TRIAPLUS_COMPANY_NAME} — Psychiatrische Klinik (Klinik Zugersee), ${DEFAULT_CITY} (${DEFAULT_CANTON}), Schweiz.`,
      `Bewerbung über das Karriereportal: ${detailUrl}`,
    ].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(description || title, 'de');
    const slugFromUrl = (detailUrl.match(/\/jobs\/([a-z0-9-]+)\/?$/) || [])[1] || '';
    const jobSlug = slugify(`${title} ${TRIAPLUS_KEY} ${slugFromUrl || DEFAULT_CITY}`);
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
      location: DEFAULT_CITY,
      canton: DEFAULT_CANTON,
      url: detailUrl,
      source: `${TRIAPLUS_COMPANY_NAME} Dedicated Parser (WordPress career site)`,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: DEFAULT_CITY,
      addressRegion: DEFAULT_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: DEFAULT_POSTAL_CODE,
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
