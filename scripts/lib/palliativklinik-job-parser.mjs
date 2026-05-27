#!/usr/bin/env node
/**
 * Palliativklinik im Park (Arlesheim, BL) — dedicated parser.
 *
 * Listing: https://palliativklinik.ch/offene-stellen/
 *   WordPress (FelicityPro theme). Each open position is a `<p>` block of the
 *   form:
 *
 *     <p>… "Wir suchen / Wir bieten" {TITLE_IN_CAPS} {pct?}<br>
 *       <a href="…/wp-content/uploads/.../PKiP_…pdf" target="_blank">Mehr Information siehe PDF</a>
 *     </p>
 *
 * Each PDF on `palliativklinik.ch/wordpress/wp-content/uploads/…` is the source
 * of truth for the job description. We:
 *   1. Parse the listing for each `<p>` containing a PKiP PDF link
 *   2. Extract a clean job title from the leading text of the paragraph
 *   3. Download and parse the PDF via `extractPdfJobContentFromUrl`
 *   4. Build a description with intro + PDF text + footer
 *
 * Clinic HQ: Stollenrain 12, 4144 Arlesheim (BL). Palliative Care centre.
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
import {
  extractPdfJobContentFromUrl,
  buildPdfBackedDescription,
} from './pdf-job-content.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const PALLIATIVKLINIK_KEY = 'palliativklinik';
export const PALLIATIVKLINIK_COMPANY_NAME = 'Palliativklinik im Park';
export const PALLIATIVKLINIK_COMPANY_DOMAIN = 'palliativklinik.ch';
export const PALLIATIVKLINIK_CAREERS_URL = 'https://palliativklinik.ch/offene-stellen/';

const HQ_CITY = 'Arlesheim';
const HQ_POSTAL_CODE = '4144';
const HQ_CANTON = 'BL';

const PDF_DELAY_MS = 400;

/* ── Company matchers ──────────────────────────────────────── */

export function isPalliativklinikJob(job) {
  if (job?.companyKey === PALLIATIVKLINIK_KEY) return true;
  const company = String(job?.company || '').toLowerCase();
  if (company.includes('palliativklinik im park') || company === 'palliativklinik') return true;
  const url = String(job?.url || '').toLowerCase();
  return url.includes('palliativklinik.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'palliativklinik.ch' ||
      host.endsWith('.palliativklinik.ch') ||
      host === 'asafafuc.myhostpoint.ch' // legacy WP host occasionally referenced
    );
  } catch {
    return false;
  }
}

/* ── Title extraction ──────────────────────────────────────── */

/**
 * Clean a raw title fragment from the FelicityPro paragraph.
 * Strip leading "Wir suchen / Wir bieten / ab 2026 …" prefix, collapse to
 * a properly-cased German job title.
 */
export function cleanPalliativklinikTitle(raw = '') {
  let text = decodeEntities(String(raw || '')).replace(/<[^>]+>/g, ' ');
  text = normalizeSpace(text);
  // Strip recruiting preambles in several passes.
  // 1. Leading "Wir suchen wir / Wir suchen / Wir bieten" + optional "ab YEAR"
  //    (only strip "ab \d{4}" — never eat "ab sofort", that's handled below).
  text = text.replace(/^\s*(?:Wir\s+suchen(?:\s+wir)?|Wir\s+bieten)(?:\s+ab\s+\d{4})?\s+/i, '');
  // 2. "per sofort / ab sofort (oder nach Vereinbarung)" availability phrase.
  text = text.replace(
    /^\s*(?:per|ab)\s+sofort(?:\s+oder\s+nach\s+Vereinbarung)?\s+/i,
    ''
  );
  // 3. "für unseren / für unsere X(-Pool)" team-prefix phrase (Ärzte-Pool, Pflege-Pool, …).
  text = text.replace(/^\s*für\s+unsere[nr]?\s+\S+\s+/i, '');
  // 4. Stray leading conjunctions left from previous passes.
  text = text.replace(/^\s*(?:wir|für|oder|und|nach)\s+/i, '');
  text = text.replace(/[­​]/g, '').trim();
  if (!text) return '';
  // Title-case any ALL-CAPS words (German-aware), leave mixed-case alone.
  text = text
    .split(/(\s+|[\/,-])/g)
    .map((token) => {
      if (!/^[A-ZÄÖÜẞ]{2,}([:.\d%]+)?$/.test(token) && !/^[A-ZÄÖÜẞ][A-ZÄÖÜẞ\d:]+$/.test(token)) {
        return token;
      }
      // Preserve known acronyms (HF, FAGE).
      if (/^(HF|FAGE|FaGe|MPA|CAS|DAS|EMBA|FMH)$/i.test(token)) return token.toUpperCase();
      const lower = token.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text;
}

/* ── Listing parsing ──────────────────────────────────────── */

/**
 * Parse the offene-stellen HTML and return one row per PDF posting.
 * @param {string} html
 * @returns {Array<{ pdfUrl: string, rawTitle: string, title: string, identifier: string }>}
 */
export function parseListing(html = '') {
  const out = [];
  const seen = new Set();
  // Each posting is in its own <p>…PDF link…</p>. Iterate paragraphs and pick
  // those that hold a PKiP_*.pdf href.
  const pBlock = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pBlock.exec(html)) !== null) {
    const inner = m[1];
    const pdfMatch = inner.match(
      /href="(https?:\/\/(?:[a-z0-9.-]*\.)?palliativklinik\.ch\/[^"]*?PKiP[^"]*?\.pdf)"/i
    );
    if (!pdfMatch) continue;
    const pdfUrl = pdfMatch[1].replace(/^http:\/\//i, 'https://');
    const identifier = pdfUrl.split('/').pop().replace(/\.pdf$/i, '');
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    // Take the text before the first <a> tag — that's the job title intro.
    const titleSlice = inner.split(/<a\b/i)[0];
    const rawTitle = normalizeSpace(decodeEntities(titleSlice.replace(/<[^>]+>/g, ' ')));
    const title = cleanPalliativklinikTitle(rawTitle);
    if (!title || title.length < 3) continue;
    out.push({ pdfUrl, rawTitle, title, identifier });
  }
  return out;
}

/* ── Description builder ───────────────────────────────────── */

export function buildPalliativklinikDescription({ title, pdfText = '', pdfUrl = '' }) {
  const description = buildPdfBackedDescription({
    introLines: [
      `Die Palliativklinik im Park in Arlesheim (BL) ist ein spezialisiertes Zentrum für Palliative Care in der Region Nordwestschweiz.`,
      `Stelle: ${title}.`,
    ],
    pdfText,
    fallbackText: `Stelle "${title}" an der Palliativklinik im Park. Vollständige Anforderungen, Aufgaben und Bewerbungsmodalitäten siehe offizielles PDF.`,
    footerLines: [
      `Quelle (PDF): ${pdfUrl}`,
      `Karriereseite: ${PALLIATIVKLINIK_CAREERS_URL}`,
      `Fachbereich: Palliative Care`,
    ],
  });
  return description;
}

/* ── Fetcher ───────────────────────────────────────────────── */

export async function fetchAllPalliativklinikJobs() {
  console.log(`🏥 Fetching ${PALLIATIVKLINIK_COMPANY_NAME} jobs`);
  console.log(`   Listing: ${PALLIATIVKLINIK_CAREERS_URL}\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(PALLIATIVKLINIK_CAREERS_URL);
  } catch (err) {
    console.warn(`⚠️ Listing fetch failed: ${err?.message || err}`);
    return [];
  }
  const rows = parseListing(listingHtml);
  console.log(`  ✓ ${rows.length} PDF postings detected`);
  if (rows.length === 0) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, PDF_DELAY_MS));
    console.log(`  📄 Extracting PDF for "${row.title}" (${row.identifier})`);
    let pdfText = '';
    try {
      const pdf = await extractPdfJobContentFromUrl(row.pdfUrl);
      if (pdf?.error) console.warn(`     ⚠️ PDF error: ${pdf.error}`);
      pdfText = pdf?.text || '';
    } catch (err) {
      console.warn(`     ⚠️ PDF fetch failed: ${err?.message || err}`);
    }
    const description = buildPalliativklinikDescription({
      title: row.title,
      pdfText,
      pdfUrl: row.pdfUrl,
    });
    if (!description || description.length < 200) {
      console.warn(`     ⚠️ Description too short (${description.length} chars) — skipping`);
      continue;
    }

    const sourceLang = detectLang(description || row.title, 'de');
    const jobSlug = slugify(`${row.title} ${PALLIATIVKLINIK_KEY} arlesheim`);
    const urlHash = createHash('sha1').update(row.pdfUrl).digest('hex').slice(0, 12);

    jobs.push({
      id: `${PALLIATIVKLINIK_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: PALLIATIVKLINIK_COMPANY_NAME,
      companyKey: PALLIATIVKLINIK_KEY,
      companyDomain: PALLIATIVKLINIK_COMPANY_DOMAIN,
      title: row.title,
      titleByLocale: { [sourceLang]: row.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: HQ_CITY,
      canton: HQ_CANTON,
      url: row.pdfUrl,
      source: `${PALLIATIVKLINIK_COMPANY_NAME} Dedicated Parser`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: HQ_CITY,
      addressRegion: HQ_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ_POSTAL_CODE,
      category: detectHealthcareCategory(`${row.title} ${description.slice(0, 500)}`),
      contract: /\b\d{2,3}\s*[-–]\s*\d{2,3}\s*%\b/.test(row.title)
        ? 'part-time'
        : 'full-time',
      employmentType: detectHealthcareEmploymentType(
        `${row.title} ${description.slice(0, 500)}`
      ),
      experienceLevel: detectHealthcareExperienceLevel(row.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: PALLIATIVKLINIK_CAREERS_URL,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${PALLIATIVKLINIK_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { HQ_CITY, HQ_CANTON, HQ_POSTAL_CODE };
