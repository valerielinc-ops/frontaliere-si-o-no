#!/usr/bin/env node
/**
 * Ergolz Klinik (Liestal, BL) — dedicated parser.
 *
 * Listing: https://ergolz.cardiance.com/karriere/
 *   WordPress + Elementor. Each open position is rendered as a sequence of
 *   sibling `elementor-widget` blocks: an `<h4>` heading with the job title,
 *   a small `<p>Veröffentlicht vor …</p>` date, and a final
 *   `<a class="elementor-button" href="…/wp-content/uploads/…pdf">` PDF link.
 *
 *   The H4 immediately preceding each PDF link is the authoritative job
 *   title (the PDF filename is not always representative — e.g. file
 *   "Stellenausschreibung-Physiotherapie_TM.pdf" carries the title
 *   "Herztherapeut/in 40-60%").
 *
 * Each PDF is the source of truth for the job description. We download and
 * parse it via `extractPdfJobContentFromUrl`.
 *
 * Clinic HQ: Liestal (BL), 4410. Cardiance Group member, internal medicine
 * / cardiology / surgery / anaesthesia.
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

export const ERGOLZ_KLINIK_KEY = 'ergolz-klinik';
export const ERGOLZ_KLINIK_COMPANY_NAME = 'Ergolz Klinik';
export const ERGOLZ_KLINIK_COMPANY_DOMAIN = 'ergolz.cardiance.com';
export const ERGOLZ_KLINIK_CAREERS_URL = 'https://ergolz.cardiance.com/karriere/';

const HQ_CITY = 'Liestal';
const HQ_POSTAL_CODE = '4410';
const HQ_CANTON = 'BL';

const PDF_DELAY_MS = 400;

/* ── Company matchers ──────────────────────────────────────── */

export function isErgolzKlinikJob(job) {
  if (job?.companyKey === ERGOLZ_KLINIK_KEY) return true;
  const company = String(job?.company || '').toLowerCase();
  if (company.includes('ergolz')) return true;
  const url = String(job?.url || '').toLowerCase();
  return url.includes('ergolz.cardiance.com');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'ergolz.cardiance.com' || host.endsWith('.ergolz.cardiance.com');
  } catch {
    return false;
  }
}

/* ── Title extraction ──────────────────────────────────────── */

export function cleanErgolzKlinikTitle(raw = '') {
  let text = decodeEntities(String(raw || '')).replace(/<[^>]+>/g, ' ');
  text = normalizeSpace(text);
  // Strip "(m/w/d)" if present.
  text = text.replace(/\(\s*m\s*\/\s*w\s*\/\s*d\s*\)/gi, '').trim();
  return text;
}

/* ── Listing parsing ──────────────────────────────────────── */

/**
 * Parse the Ergolz karriere HTML and return one row per PDF posting.
 *
 * Strategy: locate every PDF anchor, then walk backwards in the source to
 * find the most recent <h1>…<h6> heading. That heading is the job title.
 *
 * @param {string} html
 * @returns {Array<{ pdfUrl: string, title: string, identifier: string }>}
 */
export function parseListing(html = '') {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="(https?:\/\/(?:[a-z0-9.-]*\.)?ergolz\.cardiance\.com\/[^"]+\.pdf)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const pdfUrl = m[1];
    const identifier = decodeURIComponent(pdfUrl.split('/').pop().replace(/\.pdf$/i, ''));
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    const before = html.slice(0, m.index);
    // Find the last <h1>..<h6> heading in source order before this PDF link.
    const headings = [...before.matchAll(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi)];
    let title = '';
    if (headings.length > 0) {
      const last = headings[headings.length - 1];
      title = cleanErgolzKlinikTitle(last[2]);
    }
    if (!title || title.length < 3) {
      // Fallback: humanize the filename.
      title = identifier.replace(/[_-]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    }
    // Skip the page H1 "Karriere bei der Ergolz Klinik" if it bled into a row.
    if (/^karriere\b/i.test(title)) {
      title = identifier.replace(/[_-]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    }
    out.push({ pdfUrl, title, identifier });
  }
  return out;
}

/* ── Description builder ───────────────────────────────────── */

export function buildErgolzKlinikDescription({ title, pdfText = '', pdfUrl = '' }) {
  return buildPdfBackedDescription({
    introLines: [
      `Die Ergolz Klinik in Liestal (BL) ist Teil der Cardiance Group und bietet ein professionelles Umfeld in Medizin, Pflege, Therapie, Administration und Service.`,
      `Stelle: ${title}.`,
    ],
    pdfText,
    fallbackText: `Stelle "${title}" an der Ergolz Klinik Liestal. Aufgaben, Anforderungen und Bewerbungsmodalitäten sind dem offiziellen PDF zu entnehmen.`,
    footerLines: [
      `Quelle (PDF): ${pdfUrl}`,
      `Karriereseite: ${ERGOLZ_KLINIK_CAREERS_URL}`,
      `Klinik: Ergolz Klinik, Liestal (BL)`,
    ],
  });
}

/* ── Fetcher ───────────────────────────────────────────────── */

export async function fetchAllErgolzKlinikJobs() {
  console.log(`🏥 Fetching ${ERGOLZ_KLINIK_COMPANY_NAME} jobs`);
  console.log(`   Listing: ${ERGOLZ_KLINIK_CAREERS_URL}\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(ERGOLZ_KLINIK_CAREERS_URL);
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
    const description = buildErgolzKlinikDescription({
      title: row.title,
      pdfText,
      pdfUrl: row.pdfUrl,
    });
    if (!description || description.length < 200) {
      console.warn(`     ⚠️ Description too short (${description.length} chars) — skipping`);
      continue;
    }

    const sourceLang = detectLang(description || row.title, 'de');
    const jobSlug = slugify(`${row.title} ${ERGOLZ_KLINIK_KEY} liestal`);
    const urlHash = createHash('sha1').update(row.pdfUrl).digest('hex').slice(0, 12);

    jobs.push({
      id: `${ERGOLZ_KLINIK_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: ERGOLZ_KLINIK_COMPANY_NAME,
      companyKey: ERGOLZ_KLINIK_KEY,
      companyDomain: ERGOLZ_KLINIK_COMPANY_DOMAIN,
      title: row.title,
      titleByLocale: { [sourceLang]: row.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: HQ_CITY,
      canton: HQ_CANTON,
      url: row.pdfUrl,
      source: `${ERGOLZ_KLINIK_COMPANY_NAME} Dedicated Parser`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: HQ_CITY,
      addressRegion: HQ_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ_POSTAL_CODE,
      category: detectHealthcareCategory(`${row.title} ${description.slice(0, 500)}`),
      contract: /\b\d{2,3}\s*[-–%]\s*\d{2,3}\s*%\b/.test(row.title)
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
      applyUrl: ERGOLZ_KLINIK_CAREERS_URL,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${ERGOLZ_KLINIK_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { HQ_CITY, HQ_CANTON, HQ_POSTAL_CODE };
