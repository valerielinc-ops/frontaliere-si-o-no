#!/usr/bin/env node
/**
 * Therapiezentrum Meggen (TZM, LU) job parser.
 *
 * Public careers page: https://www.tzm.ch/offene-stellen/
 *
 * TZM is a small private addiction / psychiatric therapy centre on Lake
 * Lucerne (Meggen, LU). The site is a Jimdo CMS and lists job postings
 * as direct PDF downloads under `/app/download/...`. The PDF carries the
 * full posting; the HTML link text (or `title` attribute) carries the
 * canonical job title.
 *
 * Each posting renders as:
 *   <a href="/app/download/{id}/{Filename}.pdf?t=..." title="{ATTR_TITLE}">
 *     <span>{ANCHOR_TEXT}</span>
 *   </a>
 *
 * Where ANCHOR_TEXT may be empty (then ATTR_TITLE is the source of truth)
 * or carry the human-readable role (preferred).
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

export const THERAPIEZENTRUM_MEGGEN_KEY = 'therapiezentrum-meggen';
export const THERAPIEZENTRUM_MEGGEN_COMPANY_NAME = 'Therapiezentrum Meggen';
export const THERAPIEZENTRUM_MEGGEN_COMPANY_DOMAIN = 'tzm.ch';
export const THERAPIEZENTRUM_MEGGEN_CAREERS_URL =
  'https://www.tzm.ch/offene-stellen/';

const PDF_DELAY_MS = 350;

// HQ in Meggen (Lake Lucerne, canton Luzern).
const HQ_CITY = 'Meggen';
const HQ_POSTAL = '6045';
const HQ_CANTON = 'LU';

export function isTherapiezentrumMeggenJob(job) {
  const url = String(job?.url || '').toLowerCase();
  return (
    job?.companyKey === THERAPIEZENTRUM_MEGGEN_KEY ||
    url.includes('tzm.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === THERAPIEZENTRUM_MEGGEN_COMPANY_DOMAIN ||
      host.endsWith(`.${THERAPIEZENTRUM_MEGGEN_COMPANY_DOMAIN}`)
    );
  } catch {
    return false;
  }
}

/**
 * Clean a "title attribute" value of the form
 *   "Stellenausschreibung Psychotherapie (Stellenausschreibung Psychotherapie ab August 2026.pdf)"
 * → "Stellenausschreibung Psychotherapie"
 */
function cleanAttrTitle(raw = '') {
  return normalizeSpace(
    decodeEntities(String(raw || '').replace(/\s*\([^)]*\.pdf\)\s*$/i, '')),
  );
}

function absolutizeUrl(href = '') {
  if (!href) return '';
  let abs;
  if (/^https?:\/\//i.test(href)) abs = href;
  else if (href.startsWith('//')) abs = `https:${href}`;
  else if (href.startsWith('/')) abs = `https://www.${THERAPIEZENTRUM_MEGGEN_COMPANY_DOMAIN}${href}`;
  else abs = `https://www.${THERAPIEZENTRUM_MEGGEN_COMPANY_DOMAIN}/${href}`;
  // Jimdo PDF filenames contain literal spaces — encode them so the URL is
  // RFC-3986 compliant and survives URL validation + JSON-LD serialization.
  // Only re-encode if the URL is currently un-encoded.
  if (/ /.test(abs)) {
    try {
      const u = new URL(abs);
      u.pathname = u.pathname.split('/').map((seg) => encodeURIComponent(decodeURIComponent(seg))).join('/');
      abs = u.toString();
    } catch {
      abs = encodeURI(abs);
    }
  }
  return abs;
}

/**
 * Parse the careers page HTML for `<a>` anchors pointing to `/app/download/...pdf`.
 */
export function parseTherapiezentrumMeggenListing(html = '') {
  const out = [];
  const seen = new Set();
  // Match anchors carrying a `/app/download/.../*.pdf` href, capturing optional
  // body text. We post-process to strip nested tags.
  const rx =
    /<a[^>]*href="([^"]*\/app\/download\/[^"]+\.pdf[^"]*)"[^>]*(?:\stitle="([^"]*)")?[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = rx.exec(html))) {
    const href = m[1];
    const attrTitle = cleanAttrTitle(m[2] || '');
    const innerText = normalizeSpace(
      decodeEntities((m[3] || '').replace(/<[^>]+>/g, ' ')),
    );
    const title = innerText && innerText.length > 3 ? innerText : attrTitle;
    if (!title || title.length < 3) continue;
    const pdfUrl = absolutizeUrl(href);
    if (seen.has(pdfUrl)) continue;
    seen.add(pdfUrl);
    const filename = decodeURIComponent(
      pdfUrl.split('?')[0].split('/').pop() || '',
    );
    out.push({ pdfUrl, filename, title });
  }
  return out;
}

export async function fetchAllTherapiezentrumMeggenJobs() {
  console.log(`🏥 Fetching ${THERAPIEZENTRUM_MEGGEN_COMPANY_NAME} jobs`);
  console.log(`   Careers: ${THERAPIEZENTRUM_MEGGEN_CAREERS_URL}\n`);

  const html = await fetchHtml(THERAPIEZENTRUM_MEGGEN_CAREERS_URL);
  const items = parseTherapiezentrumMeggenListing(html);
  console.log(`  ✓ ${items.length} PDF Stellenausschreibungen parsed`);
  if (!items.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let pdfHits = 0;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (i > 0) await new Promise((r) => setTimeout(r, PDF_DELAY_MS));
    console.log(`  📄 Extracting PDF: ${it.filename}`);
    const pdf = await extractPdfJobContentFromUrl(it.pdfUrl, { timeoutMs: 30000 });
    if (pdf.error) console.warn(`     ⚠️ PDF error: ${pdf.error}`);
    const pdfText = pdf.text || '';
    if (pdfText) pdfHits += 1;

    const description = buildPdfBackedDescription({
      introLines: [
        `${THERAPIEZENTRUM_MEGGEN_COMPANY_NAME} — privates Therapiezentrum für Suchterkrankungen und psychische Gesundheit am Vierwaldstättersee, ${HQ_CITY} (${HQ_CANTON}), Schweiz.`,
        `Stelle: ${it.title}.`,
      ],
      pdfText,
      fallbackText: `Stellenausschreibung ${it.title} beim ${THERAPIEZENTRUM_MEGGEN_COMPANY_NAME}. Vollständige Angaben zu Profil und Bewerbung finden Sie im offiziellen PDF.`,
      footerLines: [
        `Quelle (PDF): ${it.pdfUrl}`,
        `Karriereseite: ${THERAPIEZENTRUM_MEGGEN_CAREERS_URL}`,
        `Sektor: Psychiatrie / Psychotherapie / Suchtmedizin`,
      ],
    });

    const sourceLang = detectLang(`${it.title} ${pdfText}`, 'de');
    const jobSlug = slugify(`${it.title} ${THERAPIEZENTRUM_MEGGEN_KEY} ${HQ_CITY}`);
    const urlHash = createHash('sha1').update(it.pdfUrl).digest('hex').slice(0, 12);

    jobs.push({
      id: `${THERAPIEZENTRUM_MEGGEN_KEY}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: THERAPIEZENTRUM_MEGGEN_COMPANY_NAME,
      companyKey: THERAPIEZENTRUM_MEGGEN_KEY,
      companyDomain: THERAPIEZENTRUM_MEGGEN_COMPANY_DOMAIN,
      title: it.title,
      titleByLocale: { [sourceLang]: it.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: HQ_CITY,
      canton: HQ_CANTON,
      url: it.pdfUrl,
      source: `${THERAPIEZENTRUM_MEGGEN_COMPANY_NAME} Dedicated Parser (PDF)`,
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: HQ_CITY,
      addressRegion: HQ_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ_POSTAL,
      category: detectHealthcareCategory(it.title),
      contract: 'full-time',
      employmentType: detectHealthcareEmploymentType(it.title),
      experienceLevel: detectHealthcareExperienceLevel(it.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: THERAPIEZENTRUM_MEGGEN_CAREERS_URL,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(
    `📋 Total ${THERAPIEZENTRUM_MEGGEN_COMPANY_NAME} jobs discovered: ${jobs.length} (${pdfHits}/${items.length} with PDF text)`,
  );
  return jobs;
}
