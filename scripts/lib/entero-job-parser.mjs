#!/usr/bin/env node
/**
 * entero (Stiftung entero) — dedicated parser.
 *
 * Listing: https://www.entero.ch/de/karriere
 *   Each open position appears in the listing as
 *
 *     <h3>JOB TITLE …</h3>
 *     <a href="/de/karriere/{slug}">…</a>
 *
 *   Detail pages render the body inside `<main>` with sections:
 *     - "Wir bieten" intro
 *     - "Arbeitsort: Entwöhnung Egliswil/Niederlenz/Entzug Neuenhof" — site marker
 *     - "Deine Aufgaben"
 *     - "Anforderungsprofil"
 *
 * Stiftung entero runs 3 addiction-treatment sites in canton Aargau:
 *   Egliswil (5704), Niederlenz (5702), Neuenhof (5432).
 */
import { sourcePostingDateFields } from './source-posting-date.mjs';
import { extractJobPostingLd } from './jsonld-jobposting.mjs';
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify, stripScriptsAndStyles } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';
import { htmlToTextLines } from './html-to-text-lines.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const ENTERO_KEY = 'entero';
export const ENTERO_COMPANY_NAME = 'entero';
export const ENTERO_COMPANY_DOMAIN = 'entero.ch';
export const ENTERO_CAREERS_URL = 'https://www.entero.ch/de/karriere';

const DETAIL_DELAY_MS = 450;

function canonicalPostingUrl(rawUrl = '', baseUrl = '') {
  try {
    const parsed = new URL(rawUrl, baseUrl || undefined);
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.href;
  } catch {
    return '';
  }
}

const ENTERO_SITES = [
  { match: /egliswil/i, city: 'Egliswil', postalCode: '5704' },
  { match: /niederlenz/i, city: 'Niederlenz', postalCode: '5702' },
  { match: /neuenhof/i, city: 'Neuenhof', postalCode: '5432' },
];

function resolveSite(text = '') {
  for (const site of ENTERO_SITES) {
    if (site.match.test(text)) return site;
  }
  return { city: 'Egliswil', postalCode: '5704' };
}

/* ── Company matchers ──────────────────────────────────────── */

export function isEnteroJob(job) {
  if (job?.companyKey === ENTERO_KEY) return true;
  const company = String(job?.company || '').toLowerCase();
  if (company === 'entero' || company.startsWith('stiftung entero')) return true;
  const url = String(job?.url || '').toLowerCase();
  return url.includes('entero.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'entero.ch' || host.endsWith('.entero.ch');
  } catch {
    return false;
  }
}

/* ── Listing parsing ──────────────────────────────────────── */

/**
 * Parse the karriere HTML and return one row per posting.
 *
 * Strategy: each posting is a `<a href="/de/karriere/{slug}">` anchor.
 * For human title, prefer the nearest preceding `<h3>` (single-job card
 * heading); fall back to the slug humanized form.
 *
 * @param {string} html
 * @returns {Array<{ url: string, title: string, slug: string }>}
 */
export function parseListing(html = '') {
  const out = [];
  const seen = new Set();
  // Skip the menu anchor at "/de/karriere" (the careers page itself).
  const re = /<a[^>]*href="(\/de\/karriere\/([a-z0-9-]+))"[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const slug = m[2];
    if (seen.has(slug)) continue;
    seen.add(slug);
    // Walk back from this anchor's index to find the nearest preceding <h3>.
    const before = html.slice(0, m.index);
    const headings = [...before.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)];
    let title = '';
    if (headings.length > 0) {
      title = normalizeSpace(
        decodeEntities(headings[headings.length - 1][1].replace(/<[^>]+>/g, ' '))
      );
    }
    if (!title || title.length < 5) {
      title = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
    out.push({ url: `https://www.entero.ch${href}`, title, slug });
  }
  return out;
}

/* ── Detail parsing ───────────────────────────────────────── */

/**
 * The posting part of a detail page: intro block (`jobs-show-intro`: lead
 * paragraphs + "Arbeitsort"), `jobs-content-description` (Deine Aufgaben) and
 * `jobs-content-profile` (Anforderungsprofil). It ends where the contact
 * card (`jobs-contact`, "Fragen zur Bewerbung"), the overview/apply buttons and
 * the application form begin. Pages without that markup fall back to `<main>`.
 */
function postingHtml(html) {
  const introAt = html.search(/<div\b[^>]*\bclass="[^"]*\bjobs-show-intro\b/i);
  let scope = '';
  if (introAt >= 0) {
    scope = html.slice(introAt);
  } else {
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    scope = mainMatch ? mainMatch[1] : '';
  }
  const stopAt = scope.search(
    /<div\b[^>]*\bclass="[^"]*\b(?:jobs-contact|button-wrapper|jobs-form|jobs-similar)\b|<h2[^>]*>\s*Fragen zur Bewerbung/i,
  );
  if (stopAt > 0) return scope.slice(0, stopAt);
  // From the intro there is no closing tag to rely on: without a stop marker,
  // stop at the page footer/main end, or give no body — the text has no length
  // cap (issue 5253), so the page tail is never published. The <main> scope
  // above is already closed by </main>.
  if (introAt < 0) return scope;
  const pageEnd = scope.search(/<footer\b|<\/main>/i);
  return pageEnd > 0 ? scope.slice(0, pageEnd) : '';
}

export function parseDetail(html = '') {
  if (!html) return { title: '', body: '', siteText: '' };
  const titleSource = stripScriptsAndStyles(html);
  const titleMatch = titleSource.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch
    ? normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ' ')))
    : '';
  // Keep the posting's sections and bullet lists: the previous whole-`<main>`
  // flatten turned "Deine Aufgaben"/"Anforderungsprofil" and their `<li>`
  // items into one run-on paragraph.
  let body = htmlToTextLines(
    stripScriptsAndStyles(postingHtml(html)).replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, ''),
  );
  // Safety net for markup without the section classes.
  const cutMarkers = ['Fragen zur Bewerbung', 'Jetzt bewerben!', 'zur Übersicht'];
  for (const marker of cutMarkers) {
    const idx = body.indexOf(marker);
    if (idx > 200) body = body.slice(0, idx).trim();
  }
  // Site marker: the intro renders `<span>Arbeitsort: </span><span>{site}</span>`,
  // which becomes one "Arbeitsort: {site}" line.
  const siteMatch = body.match(/Arbeitsort\s*[:：]\s*([^\n.]+)/i);
  const siteText = siteMatch ? siteMatch[1].trim() : '';
  return { title, body, siteText };
}

/**
 * The "Arbeitsort" marker names THE site of this vacancy. The intro prose
 * lists all three ("mit den Standorten Niederlenz, Neuenhof und Egliswil"), so
 * resolving from the first 300 body chars picked Egliswil — first in the table
 * — for a Niederlenz posting. Body/title text is only the fallback.
 */
export function resolveDetailSite(detail = {}, title = '') {
  const siteText = String(detail?.siteText || '');
  return ENTERO_SITES.find((site) => site.match.test(siteText))
    || resolveSite(`${String(detail?.body || '').slice(0, 300)} ${title}`);
}

/* ── Fetcher ───────────────────────────────────────────────── */

export async function fetchAllEnteroJobs() {
  console.log(`🏥 Fetching ${ENTERO_COMPANY_NAME} jobs`);
  console.log(`   Listing: ${ENTERO_CAREERS_URL}\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(ENTERO_CAREERS_URL);
  } catch (err) {
    console.warn(`⚠️ Listing fetch failed: ${err?.message || err}`);
    throw err;
  }
  const rows = parseListing(listingHtml);
  console.log(`  ✓ ${rows.length} listing rows parsed`);
  if (rows.length === 0) return [];

  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    let detail = { title: '', body: '', siteText: '' };
    let posting = null;
    try {
      const html = await fetchHtml(row.url);
      detail = parseDetail(html);
      posting = extractJobPostingLd(html);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${row.url}: ${err?.message || err}`);
    }
    const title = detail.title || row.title;
    const sameTitle = normalizeSpace(posting?.title || '').toLowerCase() === title.toLowerCase();
    let sameUrl = !posting?.url;
    if (posting?.url) {
      sameUrl = canonicalPostingUrl(posting.url, row.url) === canonicalPostingUrl(row.url, row.url);
    }
    const site = resolveDetailSite(detail, title);
    // Our own foundation summary only stands in when the page gave no body;
    // it is not part of the posting and must not pad a real description.
    const intro = `Stiftung entero — Klinik und Therapiezentrum für Suchtbehandlung im Kanton Aargau. Standorte: Entzug Neuenhof, Entwöhnung Egliswil, Entwöhnung Niederlenz. Stelle: ${title} (${site.city}, AG).`;
    const description = (detail.body && detail.body.length > 200)
      ? detail.body
      : intro;

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${ENTERO_KEY} ${site.city}`);
    const urlHash = createHash('sha1').update(row.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${ENTERO_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ENTERO_COMPANY_NAME,
      companyKey: ENTERO_KEY,
      companyDomain: ENTERO_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: site.city,
      canton: 'AG',
      url: row.url,
      source: `${ENTERO_COMPANY_NAME} Dedicated Parser`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: site.city,
      addressRegion: 'AG',
      addressCountry: 'CH',
      country: 'CH',
      postalCode: site.postalCode,
      category: detectHealthcareCategory(`${title} ${description.slice(0, 500)}`),
      contract: /\b\d{2,3}\s*[-–]\s*\d{2,3}\s*%\b/.test(title) ? 'part-time' : 'full-time',
      employmentType: detectHealthcareEmploymentType(
        `${title} ${description.slice(0, 500)}`
      ),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Suchtmedizin / Psychiatrie',
      currency: 'CHF',
      featured: false,
      ...sourcePostingDateFields(sameTitle && sameUrl ? posting?.datePosted : ''),
      applyUrl: row.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${ENTERO_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { ENTERO_SITES, resolveSite };
