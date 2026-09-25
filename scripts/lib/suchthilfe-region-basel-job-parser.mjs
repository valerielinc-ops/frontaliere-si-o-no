#!/usr/bin/env node
/**
 * Suchthilfe Region Basel — dedicated parser.
 *
 * Listing: https://www.suchthilfe.ch/jobs/
 *
 *   Each open position is rendered as a button-shaped anchor:
 *
 *     <a href="…/wp-content/uploads/…pdf" class="button-arrow">
 *       <span>JOB TITLE</span>
 *     </a>
 *
 *   The <span> content is the authoritative human-readable title. PDF body
 *   carries the full job description.
 *
 * Suchthilfe Region Basel runs multiple sites; jobs span:
 *   - ESTA Klinik für Suchtbehandlung (Reinach BL) — clinical Pflege roles
 *   - K+A / Beratungszentrum (Basel BS) — psychology / counselling roles
 *   - SPEKTRUM Gastfamilien program
 *   - Klinik administration / Hauswirtschaft
 *
 * For each job we tag the canton by inspecting the PDF filename and title
 * (ESTA → BL/Reinach, everything else → BS/Basel).
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

export const SUCHTHILFE_REGION_BASEL_KEY = 'suchthilfe-region-basel';
export const SUCHTHILFE_REGION_BASEL_COMPANY_NAME = 'Suchthilfe Region Basel';
export const SUCHTHILFE_REGION_BASEL_COMPANY_DOMAIN = 'suchthilfe.ch';
export const SUCHTHILFE_REGION_BASEL_CAREERS_URL = 'https://www.suchthilfe.ch/jobs/';

const PDF_DELAY_MS = 400;

const ESTA_LOCATION = {
  city: 'Reinach',
  postalCode: '4153',
  canton: 'BL',
};

const BASEL_LOCATION = {
  city: 'Basel',
  postalCode: '4051',
  canton: 'BS',
};

/* ── Company matchers ──────────────────────────────────────── */

export function isSuchthilfeRegionBaselJob(job) {
  if (job?.companyKey === SUCHTHILFE_REGION_BASEL_KEY) return true;
  const company = String(job?.company || '').toLowerCase();
  if (company.includes('suchthilfe region basel')) return true;
  const url = String(job?.url || '').toLowerCase();
  return url.includes('suchthilfe.ch');
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'suchthilfe.ch' || host.endsWith('.suchthilfe.ch');
  } catch {
    return false;
  }
}

/* ── Site/canton inference ─────────────────────────────────── */

export function inferLocationForPosting({ identifier = '', title = '' } = {}) {
  const haystack = `${identifier} ${title}`.toLowerCase();
  if (/\besta\b|pflege|klinik\b|klinikadministration|kliniksekretariat|hauswirtschaft|nachtdienst/i.test(haystack)) {
    return ESTA_LOCATION;
  }
  return BASEL_LOCATION;
}

/* ── Title cleaner ─────────────────────────────────────────── */

export function cleanSuchthilfeRegionBaselTitle(raw = '') {
  let text = decodeEntities(String(raw || '')).replace(/<[^>]+>/g, ' ');
  text = normalizeSpace(text);
  text = text.replace(/\(\s*m\s*\/\s*w\s*\/\s*d\s*\)/gi, '').trim();
  return text;
}

/* ── Listing parsing ──────────────────────────────────────── */

/**
 * Parse the /jobs/ HTML and return one row per PDF posting.
 *
 * @param {string} html
 * @returns {Array<{ pdfUrl: string, title: string, identifier: string }>}
 */
export function parseListing(html = '') {
  const out = [];
  const seen = new Set();
  // <a href="…pdf" class="button-arrow"> <span>TITLE</span> </a>
  const re =
    /<a\s+href="(https?:\/\/(?:[a-z0-9.-]*\.)?suchthilfe\.ch\/[^"]+\.pdf)"[^>]*class="[^"]*button-arrow[^"]*"[^>]*>\s*<span>([\s\S]*?)<\/span>\s*<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const pdfUrl = m[1];
    const identifier = decodeURIComponent(pdfUrl.split('/').pop().replace(/\.pdf$/i, ''));
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    const title = cleanSuchthilfeRegionBaselTitle(m[2]);
    if (!title || title.length < 3) continue;
    out.push({ pdfUrl, title, identifier });
  }
  return out;
}

/* ── Description builder ───────────────────────────────────── */

export function buildSuchthilfeRegionBaselDescription({ title, pdfText = '', pdfUrl = '', location }) {
  return buildPdfBackedDescription({
    introLines: [
      `Die Suchthilfe Region Basel betreibt unter anderem die ESTA Klinik für Suchtbehandlung (Reinach BL), Kontakt- und Anlaufstellen (K+A), Beratungszentrum und das Programm SPEKTRUM in der Region Basel.`,
      `Stelle: ${title} (${location?.city || ''} ${location?.canton ? '/ ' + location.canton : ''}).`,
    ],
    pdfText,
    fallbackText: `Stelle "${title}" bei der Suchthilfe Region Basel. Aufgaben, Anforderungen und Bewerbungsmodalitäten sind dem offiziellen PDF zu entnehmen.`,
    footerLines: [
      `Quelle (PDF): ${pdfUrl}`,
      `Karriereseite: ${SUCHTHILFE_REGION_BASEL_CAREERS_URL}`,
      `Träger: Suchthilfe Region Basel`,
    ],
  });
}

/* ── Fetcher ───────────────────────────────────────────────── */

export async function fetchAllSuchthilfeRegionBaselJobs() {
  console.log(`🏥 Fetching ${SUCHTHILFE_REGION_BASEL_COMPANY_NAME} jobs`);
  console.log(`   Listing: ${SUCHTHILFE_REGION_BASEL_CAREERS_URL}\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(SUCHTHILFE_REGION_BASEL_CAREERS_URL);
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
    const location = inferLocationForPosting(row);
    const description = buildSuchthilfeRegionBaselDescription({
      title: row.title,
      pdfText,
      pdfUrl: row.pdfUrl,
      location,
    });
    if (!description || description.length < 200) {
      console.warn(`     ⚠️ Description too short (${description.length} chars) — skipping`);
      continue;
    }

    const sourceLang = detectLang(description || row.title, 'de');
    const jobSlug = slugify(`${row.title} ${SUCHTHILFE_REGION_BASEL_KEY} ${location.city.toLowerCase()}`);
    const urlHash = createHash('sha1').update(row.pdfUrl).digest('hex').slice(0, 12);

    jobs.push({
      id: `${SUCHTHILFE_REGION_BASEL_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: SUCHTHILFE_REGION_BASEL_COMPANY_NAME,
      companyKey: SUCHTHILFE_REGION_BASEL_KEY,
      companyDomain: SUCHTHILFE_REGION_BASEL_COMPANY_DOMAIN,
      title: row.title,
      titleByLocale: { [sourceLang]: row.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: location.city,
      canton: location.canton,
      url: row.pdfUrl,
      source: `${SUCHTHILFE_REGION_BASEL_COMPANY_NAME} Dedicated Parser`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: location.city,
      addressRegion: location.canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: location.postalCode,
      category: detectHealthcareCategory(`${row.title} ${description.slice(0, 500)}`),
      contract: /\b\d{2,3}\s*[-–]\s*\d{2,3}\s*%\b/.test(row.title) ? 'part-time' : 'full-time',
      employmentType: detectHealthcareEmploymentType(
        `${row.title} ${description.slice(0, 500)}`
      ),
      experienceLevel: detectHealthcareExperienceLevel(row.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: SUCHTHILFE_REGION_BASEL_CAREERS_URL,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${SUCHTHILFE_REGION_BASEL_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}
