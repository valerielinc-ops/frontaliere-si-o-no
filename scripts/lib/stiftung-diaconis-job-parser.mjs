#!/usr/bin/env node
/**
 * Stiftung Diaconis (Bern) — palliative care + Wohnen im Alter + Arbeitsintegration.
 *
 * The public site diaconis.ch funnels every opening through the Abacus City
 * Bewerberportal hosted at:
 *   https://diaconis.abacuscity.ch/
 *
 * Listing structure:
 *   <a href="https://diaconis.abacuscity.ch/de/job_{INSTANCE}_{ID}/{title-slug}">
 *     {ENCODED_TITLE}
 *   </a>
 *
 * "Spontanbewerbung", "Spontananfrage", "Berufswahlpraktikum (Schnuppern)" and
 * "Freiwillig Engagierte/r" entries are dropped — they are not real openings.
 *
 * Detail page is a static HTML form. Visible content lives in a series of
 * `<div class="col-xs-12 {section}">` blocks (introduction / jobtitle / tasks
 * / benefits / requirements / contact / closure). We grab every such block
 * inside <main>, strip HTML, and concatenate.
 *
 * Address: Schönburgstrasse 25, 3000 Bern 25 (BE).
 */
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

/* ── Constants ─────────────────────────────────────────────── */

export const STIFTUNG_DIACONIS_KEY = 'stiftung-diaconis';
export const STIFTUNG_DIACONIS_COMPANY_NAME = 'Stiftung Diaconis';
export const STIFTUNG_DIACONIS_COMPANY_DOMAIN = 'diaconis.ch';

const LISTING_URL = 'https://diaconis.abacuscity.ch/';
const PUBLIC_CAREER_URL = 'https://diaconis.ch/karriere/offene-stellen/';

const HQ_CITY = 'Bern';
const HQ_POSTAL_CODE = '3000';
const HQ_CANTON = 'BE';

const DETAIL_DELAY_MS = 350;

/* ── Matchers ──────────────────────────────────────────────── */

export function isStiftungDiaconisJob(job) {
  if (job?.companyKey === STIFTUNG_DIACONIS_KEY) return true;
  const company = String(job?.company || '').toLowerCase();
  if (company.includes('diaconis') || company.includes('stiftung diaconis')) return true;
  const url = String(job?.url || '').toLowerCase();
  return url.includes('diaconis.ch') || url.includes('diaconis.abacuscity.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'diaconis.ch' || host.endsWith('.diaconis.ch')) return true;
    if (host === 'diaconis.abacuscity.ch') return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Listing parser ────────────────────────────────────────── */

const SPONTANEOUS_RE = /(spontan|berufswahlpraktikum|freiwillig\s+engagier|schnupper|praktikums-?anfrage)/i;

/**
 * Parse the Abacus City landing page and return one row per real opening.
 * Dedupes by job ID (numeric segment after `job_{instance}_`).
 *
 * @param {string} html
 * @returns {Array<{ url: string, jobId: string, title: string }>}
 */
export function parseListing(html = '') {
  const out = [];
  const seen = new Set();
  // <a href="https://diaconis.abacuscity.ch/de/job_1_86/Köchin-Koch-100%">Köchin / Koch 100%</a>
  const re = /<a[^>]+href="(https:\/\/diaconis\.abacuscity\.ch\/[a-z]{2,3}\/job_\d+_(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    const jobId = m[2];
    const titleRaw = normalizeSpace(decodeEntities(m[3].replace(/<[^>]+>/g, ' ')));
    if (!titleRaw || titleRaw.length < 4) continue;
    if (SPONTANEOUS_RE.test(titleRaw)) continue;
    if (seen.has(jobId)) continue;
    seen.add(jobId);
    out.push({ url, jobId, title: titleRaw });
  }
  return out;
}

/* ── Detail parser ─────────────────────────────────────────── */

const DETAIL_SECTIONS = ['introduction', 'jobtitle', 'tasks', 'benefits', 'requirements', 'contact', 'closure'];

/**
 * Concatenate every `<div class="col-xs-12 {section}">…</div>` block in the
 * order they appear. Strip HTML and produce a single trimmed body text.
 */
export function parseDetailDescription(html = '') {
  const parts = [];
  for (const section of DETAIL_SECTIONS) {
    const re = new RegExp(
      `<div\\s+class="[^"]*\\bcol-xs-12\\s+${section}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`,
      'gi',
    );
    let m;
    while ((m = re.exec(html)) !== null) {
      const inner = m[1].trim();
      if (inner) parts.push(inner);
    }
  }
  if (parts.length === 0) {
    const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (main) parts.push(main[1]);
  }
  if (parts.length === 0) return '';
  return normalizeSpace(htmlToText(parts.join('\n\n')).replace(/\n+/g, ' ')).slice(0, 6000);
}

/* ── Fetch + build ─────────────────────────────────────────── */

async function fetchDetail(url) {
  try {
    const html = await fetchHtml(url);
    return parseDetailDescription(html);
  } catch (err) {
    console.warn(`  ⚠️ Detail fetch failed (${url}): ${err?.message || err}`);
    return '';
  }
}

export async function fetchAllStiftungDiaconisJobs() {
  console.log(`🏥 Fetching ${STIFTUNG_DIACONIS_COMPANY_NAME} jobs`);
  console.log(`   Listing: ${LISTING_URL}`);
  console.log(`   Public:  ${PUBLIC_CAREER_URL}\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(LISTING_URL);
  } catch (err) {
    console.warn(`⚠️ Listing fetch failed: ${err?.message || err}`);
    return [];
  }
  const rows = parseListing(listingHtml);
  console.log(`  ✓ ${rows.length} real openings (spontaneous/Schnupper/freiwillig rows dropped)`);
  if (rows.length === 0) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, DETAIL_DELAY_MS));
    const description = await fetchDetail(r.url);
    const fallback = `${r.title} bei der ${STIFTUNG_DIACONIS_COMPANY_NAME}, ${HQ_CITY} (${HQ_CANTON}). Stiftung Diaconis betreibt Palliative Care, Wohnen im Alter sowie Arbeitsintegration in Bern.`;
    const safeDescription =
      description && description.split(/\s+/).length >= 30
        ? description
        : [fallback, description].filter(Boolean).join('\n\n');

    const sourceLang = detectLang(safeDescription || r.title, 'de');
    const jobSlug = slugify(`${r.title} ${STIFTUNG_DIACONIS_KEY} ${HQ_CITY}`);

    jobs.push({
      id: `${STIFTUNG_DIACONIS_KEY}-${r.jobId}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: STIFTUNG_DIACONIS_COMPANY_NAME,
      companyKey: STIFTUNG_DIACONIS_KEY,
      companyDomain: STIFTUNG_DIACONIS_COMPANY_DOMAIN,
      title: r.title,
      titleByLocale: { [sourceLang]: r.title },
      description: safeDescription,
      descriptionByLocale: { [sourceLang]: safeDescription },
      needsRetranslation: true,
      location: HQ_CITY,
      canton: HQ_CANTON,
      url: r.url,
      source: `${STIFTUNG_DIACONIS_COMPANY_NAME} Dedicated Parser (Abacus City)`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: HQ_CITY,
      addressRegion: HQ_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ_POSTAL_CODE,
      category: detectHealthcareCategory(`${r.title} ${safeDescription.slice(0, 500)}`),
      contract: /\b\d{2,3}\s*[-–]\s*\d{2,3}\s*%\b/.test(r.title)
        ? 'part-time'
        : 'full-time',
      employmentType: detectHealthcareEmploymentType(`${r.title} ${safeDescription.slice(0, 500)}`),
      experienceLevel: detectHealthcareExperienceLevel(r.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: r.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${STIFTUNG_DIACONIS_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { LISTING_URL, PUBLIC_CAREER_URL, HQ_CITY, HQ_CANTON, HQ_POSTAL_CODE };
