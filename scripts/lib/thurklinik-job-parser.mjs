#!/usr/bin/env node
/**
 * Thurklinik (Niederuzwil, SG) — dedicated parser.
 *
 * Listing: https://thurklinik.ch/stellen/
 *   WordPress career page. Each open position is a plain anchor whose
 *   visible text IS the job title:
 *
 *     <a href="…/wp-content/uploads/…pdf">JOB TITLE (taux%)</a>
 *
 *   The PDF is the source of truth for the job description body. We pull
 *   each anchor's text as the title and the PDF as the description.
 *
 * Clinic HQ: Niederuzwil (SG), surgical day clinic with Belegärzte
 * (Gynaecology, Urology, ENT, Orthopaedics, Visceral & Hand surgery,
 * Anaesthesia & pain therapy).
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

export const THURKLINIK_KEY = 'thurklinik';
export const THURKLINIK_COMPANY_NAME = 'Thurklinik';
export const THURKLINIK_COMPANY_DOMAIN = 'thurklinik.ch';
export const THURKLINIK_CAREERS_URL = 'https://thurklinik.ch/stellen/';

const HQ_CITY = 'Niederuzwil';
const HQ_POSTAL_CODE = '9244';
const HQ_CANTON = 'SG';

const PDF_DELAY_MS = 400;

/* ── Company matchers ──────────────────────────────────────── */

export function isThurklinikJob(job) {
  if (job?.companyKey === THURKLINIK_KEY) return true;
  const company = String(job?.company || '').toLowerCase();
  if (company.includes('thurklinik')) return true;
  const url = String(job?.url || '').toLowerCase();
  return url.includes('thurklinik.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'thurklinik.ch' || host.endsWith('.thurklinik.ch');
  } catch {
    return false;
  }
}

/* ── Title cleaner ─────────────────────────────────────────── */

export function cleanThurklinikTitle(raw = '') {
  let text = decodeEntities(String(raw || '')).replace(/<[^>]+>/g, ' ');
  text = normalizeSpace(text);
  text = text.replace(/^Spontanbewerbung:\s*/i, '');
  text = text.replace(/\s*\(\s*m\s*\/\s*[mw]\s*\/\s*d\s*\)\s*/gi, ' ').trim();
  return normalizeSpace(text);
}

/* ── Listing parsing ──────────────────────────────────────── */

/**
 * Parse the stellen/ HTML and return one row per PDF posting.
 *
 * Strategy: every `<a href="…thurklinik.ch/wp-content/uploads/…pdf">TEXT</a>`
 * is a posting. The anchor text is the job title (the PDF filename is
 * sometimes generic — e.g. "Spontanbewerbung-dipl.pdf" — so we trust the
 * anchor text first).
 *
 * @param {string} html
 * @returns {Array<{ pdfUrl: string, title: string, identifier: string, isSpontaneous: boolean }>}
 */
export function parseListing(html = '') {
  const out = [];
  const seen = new Set();
  const re =
    /<a[^>]*href="(https?:\/\/(?:[a-z0-9.-]*\.)?thurklinik\.ch\/[^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const pdfUrl = m[1];
    const identifier = decodeURIComponent(pdfUrl.split('/').pop().replace(/\.pdf$/i, ''));
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    const anchorText = normalizeSpace(decodeEntities(m[2].replace(/<[^>]+>/g, ' ')));
    const isSpontaneous = /^Spontanbewerbung/i.test(anchorText);
    const title = cleanThurklinikTitle(anchorText);
    if (!title || title.length < 5) continue;
    out.push({ pdfUrl, title, identifier, isSpontaneous });
  }
  return out;
}

/* ── Description builder ───────────────────────────────────── */

export function buildThurklinikDescription({ title, pdfText = '', pdfUrl = '' }) {
  return buildPdfBackedDescription({
    introLines: [
      `Die Thurklinik in Niederuzwil (SG) ist eine Belegspital-Tagesklinik mit Schwerpunkten Gynäkologie, Urologie, HNO, Orthopädie, Viszeral- und Handchirurgie sowie Anästhesie und Schmerztherapie.`,
      `Stelle: ${title}.`,
    ],
    pdfText,
    fallbackText: `Stelle "${title}" an der Thurklinik Niederuzwil. Vollständige Anforderungen, Aufgaben und Bewerbungsmodalitäten sind dem offiziellen PDF zu entnehmen.`,
    footerLines: [
      `Quelle (PDF): ${pdfUrl}`,
      `Karriereseite: ${THURKLINIK_CAREERS_URL}`,
      `Spital: Thurklinik, Niederuzwil (SG)`,
    ],
  });
}

/* ── Fetcher ───────────────────────────────────────────────── */

export async function fetchAllThurklinikJobs() {
  console.log(`🏥 Fetching ${THURKLINIK_COMPANY_NAME} jobs`);
  console.log(`   Listing: ${THURKLINIK_CAREERS_URL}\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(THURKLINIK_CAREERS_URL);
  } catch (err) {
    console.warn(`⚠️ Listing fetch failed: ${err?.message || err}`);
    return [];
  }
  let rows = parseListing(listingHtml);
  // Drop spontaneous-application placeholders, they are not real openings.
  rows = rows.filter((row) => !row.isSpontaneous);
  console.log(`  ✓ ${rows.length} concrete PDF postings detected`);
  if (rows.length === 0) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, PDF_DELAY_MS));
    console.log(`  📄 Extracting PDF for "${row.title.slice(0, 80)}" (${row.identifier.slice(0, 40)})`);
    let pdfText = '';
    try {
      const pdf = await extractPdfJobContentFromUrl(row.pdfUrl);
      if (pdf?.error) console.warn(`     ⚠️ PDF error: ${pdf.error}`);
      pdfText = pdf?.text || '';
    } catch (err) {
      console.warn(`     ⚠️ PDF fetch failed: ${err?.message || err}`);
    }
    const description = buildThurklinikDescription({
      title: row.title,
      pdfText,
      pdfUrl: row.pdfUrl,
    });
    if (!description || description.length < 200) {
      console.warn(`     ⚠️ Description too short (${description.length} chars) — skipping`);
      continue;
    }

    const sourceLang = detectLang(description || row.title, 'de');
    const jobSlug = slugify(`${row.title} ${THURKLINIK_KEY} ${HQ_CITY}`);
    const urlHash = createHash('sha1').update(row.pdfUrl).digest('hex').slice(0, 12);

    jobs.push({
      id: `${THURKLINIK_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: THURKLINIK_COMPANY_NAME,
      companyKey: THURKLINIK_KEY,
      companyDomain: THURKLINIK_COMPANY_DOMAIN,
      title: row.title,
      titleByLocale: { [sourceLang]: row.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: HQ_CITY,
      canton: HQ_CANTON,
      url: row.pdfUrl,
      source: `${THURKLINIK_COMPANY_NAME} Dedicated Parser`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: HQ_CITY,
      addressRegion: HQ_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ_POSTAL_CODE,
      category: detectHealthcareCategory(`${row.title} ${description.slice(0, 500)}`),
      contract: /\b\d{2,3}\s*[-–%]\s*\d{2,3}\s*%\b/.test(row.title) ? 'part-time' : 'full-time',
      employmentType: detectHealthcareEmploymentType(
        `${row.title} ${description.slice(0, 500)}`
      ),
      experienceLevel: detectHealthcareExperienceLevel(row.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: THURKLINIK_CAREERS_URL,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${THURKLINIK_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { HQ_CITY, HQ_CANTON, HQ_POSTAL_CODE };
