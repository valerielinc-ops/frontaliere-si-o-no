#!/usr/bin/env node
import { sourcePostingDateFields } from './source-posting-date.mjs';
/**
 * Reha Andeer — small private rehabilitation clinic in Andeer (GR).
 *
 * Public career page (Drupal, German; IT mirror at
 * /it/reha-andeer/posizioni-aperte-presso-reha-andeer):
 *   https://reha-andeer.ch/de/reha-andeer/offene-stellen-reha-andeer
 *
 * The clinic replaced its WordPress site with Drupal in late September 2026:
 * the former /offene-stellen/ page now answers HTTP 404 and the sitemap
 * (https://reha-andeer.ch/sitemap.xml) advertises the page above instead.
 * Open positions ("offene Stellen") are listed as PDF Stelleninserate hosted
 * under Drupal's public files (/sites/default/files/<YYYY>-<MM>/<filename>.pdf;
 * formerly /wp-content/uploads/<YYYY>/<MM>/). Email applications.
 *
 * Strategy:
 *   1. Fetch the career page
 *   2. Match every <a href="...*.pdf"> link under a CMS uploads path
 *   3. Filter out non-job PDFs (datenschutz, agb, etc.)
 *   4. Derive title from filename, extract body from PDF
 *
 * Inventory note: 2 PDF Stelleninserate at probe time (Pflegehelferin, med.
 * Masseurin). Ship anyway.
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { buildPdfBackedDescription, extractPdfJobContentFromUrl } from './pdf-job-content.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { fetchHtmlViaJinaWithRetry } from './jina-proxy.mjs';
import { markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';
import {
  fetchHtml,
  decodeEntities,
  normalizeSpace,
  extractPdfLinks,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const REHA_ANDEER_KEY = 'reha-andeer';
export const REHA_ANDEER_COMPANY_NAME = 'Reha Andeer';
export const REHA_ANDEER_COMPANY_DOMAIN = 'reha-andeer.ch';

export const PUBLIC_CAREER_URL = 'https://reha-andeer.ch/de/reha-andeer/offene-stellen-reha-andeer';
const DEFAULT_CITY = 'Andeer';
const DEFAULT_CANTON = 'GR';
const DEFAULT_POSTAL = '7440';

export const MIN_REHA_ANDEER_DESC_LENGTH = 350;

const NON_JOB_PDF_RE =
  /(datenschutz|impressum|agb|preisliste|tarif|tarmed|broschure|broschuere|brochure|leitbild|qualitaet|qualität|formular|policy|(?:^|[\/_ .-])info(?:[\/_ .-]|$)|informations?(?:brosch|blatt|material)|initiativbewerb|spontanbewerb)/i;
// Accept any uploads PDF unless filtered above. Most are Stelleninserate by
// keyword but some carry the role name directly (e.g. "Pflegehelferin").
const ACCEPT_HINTS_RE = /(stelle|stelleninserat|inserat|bewerb|pflege|masseur|therap|köch|service|kuche|reinigung|nacht|sekret|leit)/i;
// CMS upload folders that host the Stelleninserate: Drupal public files (the
// current site) and WordPress uploads (the site until September 2026).
const UPLOADS_PATH_RE = /\/(?:sites\/default\/files|wp-content\/uploads)\//i;

function decodeFilename(raw = '') {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isRehaAndeerAnnouncementPdf({ href = '', filename = '' } = {}) {
  if (!isTrustedDomain(href)) return false;
  if (NON_JOB_PDF_RE.test(href) || NON_JOB_PDF_RE.test(filename)) return false;
  const isUploadsPath = UPLOADS_PATH_RE.test(href);
  return isUploadsPath || ACCEPT_HINTS_RE.test(filename);
}

function hasRehaAndeerAnnouncementPdfAttribute(rawValue = '') {
  // Use the same PDF shape as parseRehaAndeerListing: an informational or
  // spontaneous-application PDF must not block a structurally proven zero.
  const escaped = String(rawValue || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
  if (!escaped) return false;
  return extractPdfLinks(
    `<a href="${escaped}"></a>`,
    PUBLIC_CAREER_URL,
  ).some(isRehaAndeerAnnouncementPdf);
}

/* ── Company matchers ──────────────────────────────────────── */

export function isRehaAndeerJob(job = {}) {
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  return (
    key === REHA_ANDEER_KEY ||
    key.startsWith('reha-andeer') ||
    company.includes('reha andeer') ||
    url.includes('reha-andeer.ch')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === REHA_ANDEER_COMPANY_DOMAIN ||
      host === `www.${REHA_ANDEER_COMPANY_DOMAIN}` ||
      host.endsWith(`.${REHA_ANDEER_COMPANY_DOMAIN}`)
    );
  } catch {
    return false;
  }
}

/* ── Title derivation ─────────────────────────────────────── */

function titleCaseWord(token) {
  if (!token) return token;
  if (/^\d+$/.test(token)) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Convert "2026_Stelleninserat-med.-Masseurin.pdf" → "Med. Masseurin".
 * Strips year prefix and "Stelleninserat" marker.
 */
export function humanizeRehaAndeerFilename(filename = '') {
  let stem = String(filename || '').replace(/\.pdf$/i, '');
  // Drop YYYY prefix or suffix
  stem = stem.replace(/^(\d{4})[_\s-]+/, '').replace(/[_\s-]+(\d{4})$/, '');
  // Drop Stelleninserat marker
  stem = stem.replace(/[_\s-]*Stelleninserat[_\s-]*/i, ' ');
  stem = stem.replace(/[_-]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!stem) return 'Offene Stelle';
  return stem
    .split(/(\s+|\.\s*|-)/)
    .map((part) => (/[a-zäöüß]/i.test(part) ? titleCaseWord(part.toLowerCase()) : part))
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* ── Parser ────────────────────────────────────────────────── */

export function parseRehaAndeerListing(html = '') {
  if (!html || typeof html !== 'string') return [];

  const out = [];
  const seen = new Set();
  for (const { href, filename } of extractPdfLinks(html, PUBLIC_CAREER_URL)) {
    if (!isRehaAndeerAnnouncementPdf({ href, filename })) continue;

    if (seen.has(href)) continue;
    seen.add(href);

    const title =
      normalizeSpace(decodeEntities(humanizeRehaAndeerFilename(filename))) ||
      filename.replace(/\.pdf$/i, '');
    const id = slugify(filename.replace(/\.pdf$/i, '')).slice(0, 50);
    if (!id) continue;
    out.push({ id, title, pdfUrl: href, filename });
  }
  return out;
}

/* ── Description builder ───────────────────────────────────── */

/**
 * The description of one posting is the text of its PDF and nothing else. The
 * crawler used to wrap it in lines of its own about the clinic ("Reha Andeer
 * sucht eine engagierte Persönlichkeit…", a paragraph on the clinic),
 * "Stelleninserat (PDF): …", "Karriere-Seite: …", "Sektor: …", "Bewerbung: …",
 * and to substitute a sentence of its own when the PDF had no text. A PDF
 * without readable text now gives no description and the job takes the
 * pipeline's thin-source path.
 */
export function buildRehaAndeerDescription({ title, pdfText = '' }) {
  const description = buildPdfBackedDescription({ pdfText });
  const warnings = [];
  if (pdfText && description.length < MIN_REHA_ANDEER_DESC_LENGTH) {
    warnings.push(
      `Reha Andeer description too short (${description.length} chars < ${MIN_REHA_ANDEER_DESC_LENGTH}) for "${title}" — PDF may have changed.`
    );
  }
  return { description, warnings };
}

/** Fragments only the crawler's former intro, fallback and footer wrote (see `buildRehaAndeerDescription`). */
export const REHA_ANDEER_FABRICATED_DESCRIPTION_RE =
  /ist eine private Rehabilitationsklinik in Andeer|entnehmen Sie dem offiziellen PDF\.|(?:^|\n)Karriere-Seite: https?:|(?:^|\n)Bewerbung: per E-Mail gemäss den Hinweisen im Stelleninserat/;

function normalizeFetchedPage(result) {
  if (result && typeof result === 'object' && !Array.isArray(result) && 'body' in result) {
    return {
      status: result.status == null ? null : Number(result.status),
      body: typeof result.body === 'string' ? result.body : '',
    };
  }
  // Keep injected fetchers used by existing tests/callers source-compatible:
  // the shared helper returns a string unless includeStatus is requested.
  return { status: 200, body: typeof result === 'string' ? result : '' };
}

function rehaAndeerEmptyPageStructure(html = '') {
  const dom = new JSDOM(String(html || ''));
  try {
    const { document } = dom.window;
    const root = document.querySelector('main, [role="main"]') || document.body;
    const hasSectionHeading = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .some((heading) => /\bOffene Stellen\b/i.test(normalizeSpace(heading.textContent || '')));
    const pageText = normalizeSpace(root.textContent || '');
    const hasInitiativeMarker = /\bInitiativbewerbung(?:en)?\b/i.test(pageText);
    const hasUnparsedDocumentLink = [...root.querySelectorAll(
      '[href], [src], [data], [action], [data-href], [data-url]'
    )].some((element) => ['href', 'src', 'data', 'action', 'data-href', 'data-url']
      .map((name) => element.getAttribute(name))
      .filter(Boolean)
      .some((rawValue) => hasRehaAndeerAnnouncementPdfAttribute(decodeEntities(rawValue).trim())));
    return { hasSectionHeading, hasInitiativeMarker, hasUnparsedDocumentLink };
  } finally {
    dom.window.close();
  }
}

export function isRehaAndeerAuthoritativeEmptyPage(html = '') {
  const structure = rehaAndeerEmptyPageStructure(html);
  return structure.hasSectionHeading
    && structure.hasInitiativeMarker
    && !structure.hasUnparsedDocumentLink
    && parseRehaAndeerListing(html).length === 0;
}

function rehaAndeerEmptyEvidence(html) {
  const structure = rehaAndeerEmptyPageStructure(html);
  if (isRehaAndeerAuthoritativeEmptyPage(html)) {
    return `Reha Andeer page HTTP 200 at ${PUBLIC_CAREER_URL}: section heading "Offene Stellen" and marker "Initiativbewerbungen" present; 0 Stelleninserat PDF links.`;
  }
  const missing = [];
  if (!structure.hasSectionHeading) missing.push('heading "Offene Stellen"');
  if (!structure.hasInitiativeMarker) missing.push('marker "Initiativbewerbungen"');
  if (structure.hasUnparsedDocumentLink) missing.push('an unparsed document or announcement link');
  return `Reha Andeer page HTTP 200 at ${PUBLIC_CAREER_URL}: missing ${missing.join(' and ') || 'the empty-page structure'}; 0 Stelleninserat PDF links.`;
}

function fetchOutcomeForError(error) {
  const status = Number(error?.status);
  return [403, 406, 415, 451].includes(status) ? 'anti_bot_block' : null;
}

/**
 * Fetch the source listing. The former WordPress origin intermittently
 * returned a structural 404 to the crawler egress while a clean egress still
 * served the page. Rescue only this known source-specific 404; any other HTTP
 * error, or an unverified proxy response, remains a hard failure so the
 * crawler cannot publish a guessed empty listing.
 */
export async function fetchRehaAndeerListingHtml({ timeoutMs, fetchHtmlImpl = fetchHtml } = {}) {
  try {
    const fetched = normalizeFetchedPage(await fetchHtmlImpl(PUBLIC_CAREER_URL, {
      timeoutMs,
      includeStatus: true,
    }));
    if (fetched.status !== 200) {
      const error = new Error(`HTTP ${fetched.status || 'unknown'} from ${PUBLIC_CAREER_URL}`);
      error.status = fetched.status;
      throw error;
    }
    return fetched.body;
  } catch (err) {
    if (Number(err?.status) !== 404) throw err;
    const rescuedHtml = await fetchHtmlViaJinaWithRetry(PUBLIC_CAREER_URL, { timeoutMs });
    if (rescuedHtml != null && parseRehaAndeerListing(rescuedHtml).length > 0) {
      console.warn(
        `⚠️ Reha Andeer seed returned HTTP 404; using verified clean-egress HTML rescue.`,
      );
      return rescuedHtml;
    }
    throw err;
  }
}

/* ── Main fetch ────────────────────────────────────────────── */

export async function fetchAllRehaAndeerJobs({
  fetchListingHtmlImpl = fetchRehaAndeerListingHtml,
  extractPdfContentImpl = extractPdfJobContentFromUrl,
} = {}) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  console.log(`🏥 Fetching ${REHA_ANDEER_COMPANY_NAME} jobs`);
  console.log(`   Source: ${PUBLIC_CAREER_URL} (Drupal HTML + PDF Stelleninserate)\n`);

  let html;
  try {
    const fetched = normalizeFetchedPage(await fetchListingHtmlImpl({ timeoutMs }));
    if (fetched.status !== 200) {
      const error = new Error(`HTTP ${fetched.status || 'unknown'} from ${PUBLIC_CAREER_URL}`);
      error.status = fetched.status;
      throw error;
    }
    html = fetched.body;
  } catch (err) {
    const fetchOutcome = fetchOutcomeForError(err);
    if (fetchOutcome) {
      const fetchFailureReason = `Reha Andeer page ${err?.message || err} at ${PUBLIC_CAREER_URL}; source was not structurally observed.`;
      console.warn(`⚠️ ${fetchFailureReason}`);
      return {
        jobs: [],
        fetchOutcome,
        fetchFailureReason,
      };
    }
    throw new Error(`Failed to fetch Reha Andeer page: ${err?.message || err}`);
  }

  const listings = parseRehaAndeerListing(html);
  console.log(`  📋 Stelleninserat PDFs found: ${listings.length}\n`);
  if (listings.length === 0) {
    if (isRehaAndeerAuthoritativeEmptyPage(html)) {
      const evidence = rehaAndeerEmptyEvidence(html);
      console.log(`  🧩 Source-proven zero: ${evidence}`);
      return markAuthoritativeEmptySnapshot([], evidence);
    }
    const fetchFailureReason = rehaAndeerEmptyEvidence(html);
    console.warn(`⚠️ No Stelleninserate parsed from Reha Andeer page: ${fetchFailureReason}`);
    return {
      jobs: [],
      fetchOutcome: 'selector_miss',
      fetchFailureReason,
    };
  }

  const jobs = [];
  for (const listing of listings) {
    console.log(`  📄 Processing: ${listing.filename}`);
    const pdf = await extractPdfContentImpl(listing.pdfUrl, { timeoutMs });
    if (pdf.error) console.warn(`     ⚠️ PDF error: ${pdf.error}`);
    const pdfText = pdf.thin ? '' : (pdf.rawText || pdf.text || '');

    const { description, warnings } = buildRehaAndeerDescription({
      title: listing.title,
      pdfText,
      pdfUrl: listing.pdfUrl,
    });
    for (const w of warnings) console.warn(`     ⚠️ ${w}`);

    const sourceLang = 'de';
    const haystack = `${listing.title} ${description}`;
    const employmentType = detectHealthcareEmploymentType(haystack);
    const jobSlug = slugify(`${listing.title} ${REHA_ANDEER_KEY} ${DEFAULT_CITY}`);
    const urlHash = createHash('sha1')
      .update(`${listing.pdfUrl}|${listing.id}`)
      .digest('hex')
      .slice(0, 12);

    jobs.push({
      id: `${REHA_ANDEER_KEY}-${listing.id}-${urlHash}`,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: REHA_ANDEER_COMPANY_NAME,
      companyKey: REHA_ANDEER_KEY,
      companyDomain: REHA_ANDEER_COMPANY_DOMAIN,
      title: listing.title,
      titleByLocale: { [sourceLang]: listing.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: DEFAULT_CITY,
      canton: DEFAULT_CANTON,
      url: listing.pdfUrl,
      applyUrl: PUBLIC_CAREER_URL,
      source: 'Reha Andeer Dedicated Parser (Drupal HTML + PDF)',
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
      sector: 'Gesundheitswesen / Rehabilitation',
      currency: 'CHF',
      featured: false,
      ...sourcePostingDateFields(''),
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
    `\n📋 Total ${REHA_ANDEER_COMPANY_NAME} jobs discovered: ${jobs.length}`
  );
  return jobs;
}
