#!/usr/bin/env node
/**
 * Therapiezentrum Meggen (TZM) — small psychotherapy / rehab centre in Meggen (LU).
 *
 * Public career page (Jimdo-hosted, German only):
 *   https://www.tzm.ch/offene-stellen/
 *   (also reachable via https://www.therapiezentrum-meggen.ch/offene-stellen/)
 *
 * Open positions are published as PDF Stellenausschreibungen hosted under
 * /app/download/<id>/<filename>.pdf?t=<ts>. The anchor text carries the full job
 * title (e.g. "Psychologische Psychotherapeutin, Psychologischer Psychotherapeut
 * (60-100%)") while the filename is short.
 *
 * Strategy:
 *   1. Fetch /offene-stellen/
 *   2. Match every <a href="/app/download/...*.pdf?...">…</a>
 *   3. Title preference: bold text inside the anchor → filename fallback
 *   4. Skip stale/anchor-only links that wrap pure text (e.g. internal nav).
 *
 * Inventory note: 2 PDF Stellenausschreibungen at probe time. Ship anyway.
 */
import { createHash } from 'node:crypto';
import { buildPdfBackedDescription, extractPdfJobContentFromUrl } from './pdf-job-content.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { readAttr } from './html-attr.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const TZM_KEY = 'therapiezentrum-meggen';
export const TZM_COMPANY_NAME = 'Therapiezentrum Meggen';
export const TZM_COMPANY_DOMAIN = 'tzm.ch';
export const TZM_ALT_DOMAIN = 'therapiezentrum-meggen.ch';

const PUBLIC_CAREER_URL = 'https://www.tzm.ch/offene-stellen/';
const DEFAULT_CITY = 'Meggen';
const DEFAULT_CANTON = 'LU';
const DEFAULT_POSTAL = '6045';

export const MIN_TZM_DESC_LENGTH = 350;

/* ── Company matchers ──────────────────────────────────────── */

export function isTzmJob(job = {}) {
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return (
    key === TZM_KEY ||
    key.startsWith('therapiezentrum-meggen') ||
    company.includes('therapiezentrum meggen') ||
    company.includes('tzm') && company.length < 40 ||
    url.includes('tzm.ch') ||
    url.includes('therapiezentrum-meggen.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === TZM_COMPANY_DOMAIN ||
      host === `www.${TZM_COMPANY_DOMAIN}` ||
      host === TZM_ALT_DOMAIN ||
      host === `www.${TZM_ALT_DOMAIN}` ||
      host.endsWith(`.${TZM_COMPANY_DOMAIN}`) ||
      host.endsWith(`.${TZM_ALT_DOMAIN}`)
    );
  } catch {
    return false;
  }
}

/* ── Parser ────────────────────────────────────────────────── */

function stripTags(html = '') {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ''));
}

/**
 * Extract job listings from the Jimdo-hosted TZM careers page.
 *
 * Each anchor has the form:
 *   <a href="/app/download/<id>/<filename>.pdf?t=<ts>" title="<full job title> (<filename>)">
 *     <b><span ...>Title text</span></b>
 *   </a>
 *
 * We prefer the anchor text (which carries the role + percentage), then the
 * "title" attribute (strip the trailing "(filename.pdf)") as a fallback.
 */
export function parseTzmListing(html = '') {
  if (!html || typeof html !== 'string') return [];

  const out = [];
  const seen = new Set();

  // Capture the attribute soup independently from its order, then select PDF
  // anchors through the quote-balanced reader.
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const attrs = m[1] || '';
    let href = readAttr(attrs, 'href');
    const inner = m[2] || '';

    if (!/\/app\/download\/[^?#]+?\.pdf(?:[?#]|$)/i.test(href)) continue;
    // Normalise to absolute https.
    if (href.startsWith('//')) href = `https:${href}`;
    else if (href.startsWith('/')) href = `https://www.tzm.ch${href}`;
    // Percent-encode spaces (Jimdo filenames contain literal spaces).
    href = href.replace(/ /g, '%20');

    const innerText = normalizeSpace(stripTags(inner));
    let titleFromAttr = decodeEntities(readAttr(attrs, 'title'));
    // Trim " (<filename>.pdf)" suffix that Jimdo appends.
    titleFromAttr = titleFromAttr.replace(/\s*\([^)]*\.pdf\)\s*$/i, '').trim();

    const title = innerText && innerText.length >= 5 ? innerText : titleFromAttr;
    if (!title || title.length < 5) continue;
    // Reject pure-text anchors (no real job hint).
    if (!/(therapeut|psycholog|pflege|sozial|leit|fachperson|hausdienst|sekret|administration|reinigung|nacht|stelle|prakt)/i.test(title) &&
        !/(therapeut|psycholog|pflege|stelle|prakt)/i.test(href)) {
      continue;
    }

    // Stable id from filename (drop query string).
    const filename = decodeURIComponent((href.split('?')[0].split('/').pop() || ''));
    const id = slugify(filename.replace(/\.pdf$/i, '')).slice(0, 50);
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    out.push({ id, title, pdfUrl: href, filename });
  }
  return out;
}

/* ── Description builder ───────────────────────────────────── */

function buildTzmDescription({ title, pdfText = '', pdfUrl = '' }) {
  const description = buildPdfBackedDescription({
    introLines: [
      `${TZM_COMPANY_NAME} sucht eine engagierte Persönlichkeit für die Position: ${title}.`,
      'Das Therapiezentrum Meggen (TZM) ist eine sozialpsychiatrische Therapiestation in Meggen am Vierwaldstättersee (Kanton Luzern). Die Institution bietet stationäre und ambulante Behandlungen, integrative Psychotherapie und Milieutherapie für Erwachsene an.',
    ],
    pdfText,
    fallbackText: `Stellenausschreibung ${title} im ${TZM_COMPANY_NAME}. Die vollständigen Angaben zu Aufgaben, Anforderungen, Pensum und Bewerbungsweg entnehmen Sie dem offiziellen PDF.`,
    footerLines: [
      `Stellenausschreibung (PDF): ${pdfUrl}`,
      `Karriereseite: ${PUBLIC_CAREER_URL}`,
      'Sektor: Gesundheitswesen / Psychotherapie / Sozialpsychiatrie',
    ],
  });
  const warnings = [];
  if (pdfText && description.length < MIN_TZM_DESC_LENGTH) {
    warnings.push(
      `TZM description too short (${description.length} chars < ${MIN_TZM_DESC_LENGTH}) for "${title}" — PDF may have changed.`
    );
  }
  return { description, warnings };
}

/* ── Main fetch ────────────────────────────────────────────── */

export async function fetchAllTzmJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  console.log(`🏥 Fetching ${TZM_COMPANY_NAME} jobs`);
  console.log(`   Source: ${PUBLIC_CAREER_URL} (Jimdo HTML + PDF Stellenausschreibungen)\n`);

  let html;
  try {
    html = await fetchHtml(PUBLIC_CAREER_URL, { timeoutMs });
  } catch (err) {
    throw new Error(`Failed to fetch TZM page: ${err?.message || err}`);
  }

  const listings = parseTzmListing(html);
  console.log(`  📋 Stellenausschreibung PDFs found: ${listings.length}\n`);
  if (listings.length === 0) {
    console.warn('⚠️ No Stellenausschreibungen parsed from TZM page.');
    return [];
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  for (const listing of listings) {
    console.log(`  📄 Processing: ${listing.filename}`);
    const pdf = await extractPdfJobContentFromUrl(listing.pdfUrl, { timeoutMs });
    if (pdf.error) console.warn(`     ⚠️ PDF error: ${pdf.error}`);
    const pdfText = pdf.thin ? '' : (pdf.rawText || pdf.text || '');

    const { description, warnings } = buildTzmDescription({
      title: listing.title,
      pdfText,
      pdfUrl: listing.pdfUrl,
    });
    for (const w of warnings) console.warn(`     ⚠️ ${w}`);

    const sourceLang = 'de';
    const haystack = `${listing.title} ${description}`;
    const employmentType = detectHealthcareEmploymentType(haystack);
    const jobSlug = slugify(`${listing.title} ${TZM_KEY} ${DEFAULT_CITY}`);
    const urlHash = createHash('sha1')
      .update(`${listing.pdfUrl}|${listing.id}`)
      .digest('hex')
      .slice(0, 12);

    jobs.push({
      id: `${TZM_KEY}-${listing.id}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: TZM_COMPANY_NAME,
      companyKey: TZM_KEY,
      companyDomain: TZM_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: DEFAULT_CITY,
      canton: DEFAULT_CANTON,
      url: listing.pdfUrl,
      applyUrl: PUBLIC_CAREER_URL,
      source: 'Therapiezentrum Meggen Dedicated Parser (Jimdo HTML + PDF)',
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: DEFAULT_CITY,
      addressRegion: DEFAULT_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: DEFAULT_POSTAL,
      category: detectHealthcareCategory(haystack),
      contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(haystack),
      sector: 'Gesundheitswesen / Psychotherapie',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
    console.log(`  ✅ ${listing.title.substring(0, 70)} (${listing.id})`);
  }

  for (const j of jobs) {
    const detected = detectLang(j.description || j.title, 'de');
    if (detected !== j.sourceLang) {
      j.sourceLang = detected;
      j.titleByLocale = { [detected]: j.title };
      j.descriptionByLocale = { [detected]: j.description };
      j.slugByLocale = { [detected]: j.slug };
      j.requirementsByLocale = { [detected]: [] };
    }
  }

  console.log(
    `\n📋 Total ${TZM_COMPANY_NAME} jobs discovered: ${jobs.length}`
  );
  return jobs;
}
