#!/usr/bin/env node
/**
 * Suchtfachstelle Zürich — dedicated parser.
 *
 * Listing: https://www.suchtfachstelle.zuerich/ueber-uns/offene-stellen
 *   Single-page listing on the Craft CMS site. Each open position is a
 *   sibling anchor of the form
 *
 *     <a href="https://www.suchtfachstelle.zuerich/stellenausschreibung-{slug}">…</a>
 *
 * Detail: https://www.suchtfachstelle.zuerich/stellenausschreibung-{slug}
 *   The job body is rendered inside a section starting at the H1
 *   "Die Suchtfachstelle Zürich als Arbeitgeberin" and ending at the
 *   "Online-Bewerbung" form. The <title> tag carries the full job title
 *   ("Stellenausschreibung: …"); we strip the prefix.
 *
 * Org HQ: Josefstrasse 91, 8005 Zürich (BS-Quartier, Nähe HB Zürich).
 * Single small org, typically 0-2 open positions at a time.
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

export const SUCHTFACHSTELLE_ZUERICH_KEY = 'suchtfachstelle-zuerich';
export const SUCHTFACHSTELLE_ZUERICH_COMPANY_NAME = 'Suchtfachstelle Zürich';
export const SUCHTFACHSTELLE_ZUERICH_COMPANY_DOMAIN = 'suchtfachstelle.zuerich';
export const SUCHTFACHSTELLE_ZUERICH_CAREERS_URL =
  'https://www.suchtfachstelle.zuerich/ueber-uns/offene-stellen';

const HQ_CITY = 'Zürich';
const HQ_POSTAL_CODE = '8005';
const HQ_CANTON = 'ZH';

const DETAIL_DELAY_MS = 450;

/* ── Company matchers ──────────────────────────────────────── */

export function isSuchtfachstelleZuerichJob(job) {
  if (job?.companyKey === SUCHTFACHSTELLE_ZUERICH_KEY) return true;
  const company = String(job?.company || '').toLowerCase();
  if (company.includes('suchtfachstelle zürich') || company.includes('suchtfachstelle zuerich')) {
    return true;
  }
  const url = String(job?.url || '').toLowerCase();
  return url.includes('suchtfachstelle.zuerich');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'suchtfachstelle.zuerich' || host.endsWith('.suchtfachstelle.zuerich');
  } catch {
    return false;
  }
}

/* ── Title cleaner ─────────────────────────────────────────── */

export function cleanSfsTitle(raw = '') {
  let text = decodeEntities(String(raw || '')).replace(/<[^>]+>/g, ' ');
  text = normalizeSpace(text);
  text = text.replace(/^Stellenausschreibung\s*[:：]\s*/i, '').trim();
  return text;
}

/* ── Listing parsing ──────────────────────────────────────── */

/**
 * Parse the offene-stellen HTML and return one row per /stellenausschreibung-*
 * posting.
 *
 * @param {string} html
 * @returns {Array<{ url: string, slug: string }>}
 */
export function parseListing(html = '') {
  const out = [];
  const seen = new Set();
  const re =
    /href="(https?:\/\/(?:www\.)?suchtfachstelle\.zuerich\/stellenausschreibung-([a-z0-9-]+))"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    const slug = m[2];
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ url, slug });
  }
  return out;
}

/* ── Detail parsing ───────────────────────────────────────── */

export function parseDetail(html = '') {
  if (!html) return { title: '', body: '' };
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleRaw = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';
  const title = cleanSfsTitle(titleRaw);
  // Body: everything between the H1 "Die Suchtfachstelle Zürich als
  // Arbeitgeberin" and the "Online-Bewerbung" form. The page has no
  // <main>/<article> wrapper.
  let body = '';
  const startIdx = html.indexOf('Die Suchtfachstelle Zürich als Arbeitgeberin');
  if (startIdx > 0) {
    const chunk = html.slice(startIdx);
    const endIdx = chunk.search(/Online-Bewerbung|fui-bew/);
    const body0 = endIdx > 0 ? chunk.slice(0, endIdx) : chunk.slice(0, 12000);
    let text = decodeEntities(body0.replace(/<[^>]+>/g, ' '));
    text = normalizeSpace(text);
    body = text.slice(0, 6000);
  }
  return { title, body };
}

/* ── Fetcher ───────────────────────────────────────────────── */

export async function fetchAllSuchtfachstelleZuerichJobs() {
  console.log(`🏥 Fetching ${SUCHTFACHSTELLE_ZUERICH_COMPANY_NAME} jobs`);
  console.log(`   Listing: ${SUCHTFACHSTELLE_ZUERICH_CAREERS_URL}\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(SUCHTFACHSTELLE_ZUERICH_CAREERS_URL);
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
    let detail = { title: '', body: '' };
    try {
      const html = await fetchHtml(row.url);
      detail = parseDetail(html);
    } catch (err) {
      console.warn(`  ⚠️ Detail fetch failed for ${row.url}: ${err?.message || err}`);
    }
    const title = detail.title || row.slug.replace(/-/g, ' ');
    const intro = `Die Suchtfachstelle Zürich ist Anlauf- und Beratungsstelle für Menschen mit Suchtproblemen (Erwachsene, Jugendliche, Kinder) und deren Angehörige am Standort Josefstrasse 91, 8005 Zürich. Stelle: ${title}.`;
    const description = (detail.body && detail.body.length > 200)
      ? `${intro}\n\n${detail.body}`
      : intro;

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${SUCHTFACHSTELLE_ZUERICH_KEY}`);
    const urlHash = createHash('sha1').update(row.url).digest('hex').slice(0, 12);

    jobs.push({
      id: `${SUCHTFACHSTELLE_ZUERICH_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SUCHTFACHSTELLE_ZUERICH_COMPANY_NAME,
      companyKey: SUCHTFACHSTELLE_ZUERICH_KEY,
      companyDomain: SUCHTFACHSTELLE_ZUERICH_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: HQ_CITY,
      canton: HQ_CANTON,
      url: row.url,
      source: `${SUCHTFACHSTELLE_ZUERICH_COMPANY_NAME} Dedicated Parser`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: HQ_CITY,
      addressRegion: HQ_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ_POSTAL_CODE,
      category: detectHealthcareCategory(`${title} ${description.slice(0, 500)}`),
      contract: /\b\d{2,3}\s*%\b/.test(title) ? 'part-time' : 'full-time',
      employmentType: detectHealthcareEmploymentType(
        `${title} ${description.slice(0, 500)}`
      ),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Suchtberatung / Sozialwesen',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: row.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${SUCHTFACHSTELLE_ZUERICH_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { HQ_CITY, HQ_CANTON, HQ_POSTAL_CODE };
