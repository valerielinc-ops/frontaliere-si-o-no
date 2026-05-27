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

export const ENTERO_KEY = 'entero';
export const ENTERO_COMPANY_NAME = 'entero';
export const ENTERO_COMPANY_DOMAIN = 'entero.ch';
export const ENTERO_CAREERS_URL = 'https://www.entero.ch/de/karriere';

const DETAIL_DELAY_MS = 450;

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

export function parseDetail(html = '') {
  if (!html) return { title: '', body: '', siteText: '' };
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch
    ? normalizeSpace(decodeEntities(titleMatch[1].replace(/<[^>]+>/g, ' ')))
    : '';
  // Body lives in <main>…</main>.
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  let body = '';
  if (mainMatch) {
    let text = decodeEntities(mainMatch[1].replace(/<[^>]+>/g, ' '));
    text = normalizeSpace(text);
    // Cut trailing apply-form chatter starting at "Fragen zur Bewerbung"
    // or "Jetzt bewerben!" — that's contact + form scaffolding, not job text.
    const cutMarkers = ['Fragen zur Bewerbung', 'Jetzt bewerben!', 'zur Übersicht'];
    for (const marker of cutMarkers) {
      const idx = text.indexOf(marker);
      if (idx > 200) text = text.slice(0, idx).trim();
    }
    body = text.slice(0, 6000);
  }
  // Site marker: "Arbeitsort: …" line.
  const siteMatch = body.match(/Arbeitsort\s*[:：]\s*([^.]+?)(?=\s+(?:Deine|Anforderung|Wir|$))/i);
  const siteText = siteMatch ? siteMatch[1].trim() : '';
  return { title, body, siteText };
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
    return [];
  }
  const rows = parseListing(listingHtml);
  console.log(`  ✓ ${rows.length} listing rows parsed`);
  if (rows.length === 0) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    let detail = { title: '', body: '', siteText: '' };
    try {
      const html = await fetchHtml(row.url);
      detail = parseDetail(html);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${row.url}: ${err?.message || err}`);
    }
    const title = detail.title || row.title;
    const site = resolveSite(`${detail.siteText} ${detail.body.slice(0, 300)} ${title}`);
    const intro = `Stiftung entero — Klinik und Therapiezentrum für Suchtbehandlung im Kanton Aargau. Standorte: Entzug Neuenhof, Entwöhnung Egliswil, Entwöhnung Niederlenz. Stelle: ${title} (${site.city}, AG).`;
    const description = (detail.body && detail.body.length > 200)
      ? `${intro}\n\n${detail.body}`
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
      postedDate: todayIso,
      applyUrl: row.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${ENTERO_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { ENTERO_SITES, resolveSite };
