#!/usr/bin/env node
/**
 * Thurklinik (Niederuzwil, SG) — dedicated parser.
 *
 * Listing: https://thurklinik.ch/stellen/
 *   WordPress career page. Each open position is a plain anchor whose
 *   visible text IS the job title. The source used PDF anchors until late
 *   2026, then moved to HTML detail pages under /stellen/<slug>/.
 *
 *     <a href="…/wp-content/uploads/…pdf">JOB TITLE (taux%)</a>
 *
 *   The linked PDF or detail page is the source of truth for the job
 *   description body. We pull each anchor's text as the title and the linked
 *   source body as the description.
 *
 * Clinic HQ: Niederuzwil (SG), surgical day clinic with Belegärzte
 * (Gynaecology, Urology, ENT, Orthopaedics, Visceral & Hand surgery,
 * Anaesthesia & pain therapy).
 */
import { sourcePostingDateFields } from './source-posting-date.mjs';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import {
  fetchHtml,
  decodeEntities,
  htmlToText,
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

const SOURCE_DELAY_MS = 400;
const THURKLINIK_DETAIL_PATH_RE = /^\/stellen\/[^/]+\/?$/i;
const DETAIL_ROOT_SELECTORS = [
  'main',
  '[role="main"]',
  '#content',
  'article',
  '.entry-content',
];
const DETAIL_CHROME_SELECTOR =
  'nav, header, footer, aside, form, script, style, noscript, .breadcrumb, .breadcrumbs, [aria-label="breadcrumb"]';

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

/**
 * Representation-independent vacancy identity shared by the legacy PDF and
 * current HTML rows. The listing title is the only value present in both
 * source representations, so source URLs must not participate in this key.
 */
export function buildThurklinikVacancyKey(rawTitle = '') {
  const titleKey = slugify(cleanThurklinikTitle(rawTitle), Number.MAX_SAFE_INTEGER);
  if (!titleKey) return '';
  const locationKey = slugify(HQ_CITY, Number.MAX_SAFE_INTEGER);
  return `${THURKLINIK_KEY}:title:${titleKey}:location:${locationKey}`;
}

export function buildThurklinikJobId(rawTitle = '') {
  const vacancyKey = buildThurklinikVacancyKey(rawTitle);
  if (!vacancyKey) return '';
  const hash = createHash('sha1').update(vacancyKey).digest('hex').slice(0, 12);
  return `${THURKLINIK_KEY}-${hash}`;
}

/**
 * Match legacy PDF rows to their HTML detail replacement by the shared
 * listing identity. Existing stored rows predate `sourceIdentity`, so their
 * cleaned source title is the compatibility fallback.
 */
export function thurklinikMatchKey(job = {}) {
  const sourceIdentity = normalizeSpace(job?.sourceIdentity || '');
  if (sourceIdentity.startsWith(`${THURKLINIK_KEY}:title:`)) return sourceIdentity;
  return buildThurklinikVacancyKey(job?.title || '');
}

function normalizeThurklinikDetailUrl(rawUrl = '') {
  const url = new URL(rawUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.href;
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
 * @returns {Array<{ pdfUrl?: string, detailUrl?: string, title: string, identifier: string, isSpontaneous: boolean }>}
 */
export function parseListing(html = '') {
  if (!html) return [];

  const dom = new JSDOM(html);
  const document = dom.window.document;
  const out = [];
  const seen = new Set();

  try {
    for (const anchor of document.querySelectorAll('a[href]')) {
      const rawHref = decodeEntities(anchor.getAttribute('href') || '').trim();
      if (!rawHref) continue;

      let url;
      try {
        url = new URL(rawHref, THURKLINIK_CAREERS_URL);
      } catch {
        continue;
      }
      if (!isTrustedDomain(url.href)) continue;

      const isPdf = /\.pdf$/i.test(url.pathname);
      const isDetail = THURKLINIK_DETAIL_PATH_RE.test(url.pathname)
        && url.pathname.replace(/\/+$/, '/') !== '/stellen/';
      if (!isPdf && !isDetail) continue;

      const detailUrl = isDetail ? normalizeThurklinikDetailUrl(url.href) : '';

      const anchorText = normalizeSpace(anchor.textContent || '');
      const title = cleanThurklinikTitle(anchorText);
      if (!title || title.length < 5) continue;

      const identifier = isPdf
        ? decodeURIComponent(url.pathname.split('/').pop().replace(/\.pdf$/i, ''))
        : new URL(detailUrl).pathname;
      const seenKey = isPdf ? `pdf:${identifier}` : `detail:${detailUrl}`;
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);

      const isSpontaneous = /^Spontanbewerbung/i.test(anchorText)
        || /spontanbewerbung/i.test(url.pathname);
      out.push({
        ...(isPdf ? { pdfUrl: url.href } : { detailUrl }),
        title,
        identifier,
        isSpontaneous,
      });
    }
  } finally {
    dom.window.close();
  }

  return out;
}

/**
 * Extract the source text from a Thurklinik vacancy detail page.
 *
 * The selector order is deliberately semantic and fail-closed: scraping the
 * whole document would publish navigation/footer text as a job description.
 * The caller already restricts the URL to the trusted Thurklinik vacancy path.
 *
 * @param {string} html
 * @param {string} fallbackTitle
 * @returns {{ title: string, description: string }}
 */
export function parseDetailPage(html = '', fallbackTitle = '') {
  if (!html) return { title: cleanThurklinikTitle(fallbackTitle), description: '' };

  const dom = new JSDOM(html);
  const document = dom.window.document;
  try {
    let root = null;
    for (const selector of DETAIL_ROOT_SELECTORS) {
      const candidate = document.querySelector(selector);
      if (!candidate || !candidate.querySelector('h1')) continue;
      root = candidate;
      break;
    }
    if (!root) {
      return {
        title: cleanThurklinikTitle(document.querySelector('h1')?.textContent || fallbackTitle),
        description: '',
      };
    }

    const content = root.cloneNode(true);
    content.querySelectorAll(DETAIL_CHROME_SELECTOR).forEach((node) => node.remove());
    const sourceTitle = cleanThurklinikTitle(
      content.querySelector('h1')?.textContent || fallbackTitle,
    );
    content.querySelectorAll('h1').forEach((node) => node.remove());
    content.querySelectorAll('a[href]').forEach((anchor) => {
      const text = normalizeSpace(anchor.textContent || '');
      if (/zurück\s+zu\s+allen\s+stellen|back\s+to\s+(all\s+)?jobs/i.test(text)) {
        anchor.remove();
      }
    });

    return {
      title: sourceTitle,
      description: htmlToText(content.innerHTML),
    };
  } finally {
    dom.window.close();
  }
}

/* ── Description builder ───────────────────────────────────── */

/**
 * The description of one posting is source text from its PDF or detail page
 * and nothing else. The crawler used to wrap it in lines of its own (a
 * paragraph on the Thurklinik, "Stelle: <Titel>.", "Quelle (PDF): …",
 * "Karriereseite: …", "Spital: …") and to substitute a sentence of its own
 * when the PDF had no text. An unreadable source now gives no description and
 * the job takes the pipeline's thin-source path.
 */
export function buildThurklinikDescription({ pdfText = '', detailText = '' } = {}) {
  return buildPdfBackedDescription({ pdfText: pdfText || detailText });
}

/** Fragments only the crawler's former wrapper wrote. */
export const THURKLINIK_FABRICATED_DESCRIPTION_RE =
  /ist eine Belegspital-Tagesklinik mit Schwerpunkten|sind dem offiziellen PDF zu entnehmen\.|(?:^|\n)Spital: Thurklinik, Niederuzwil \(SG\)/;

/* ── Fetcher ───────────────────────────────────────────────── */

export async function fetchAllThurklinikJobs() {
  console.log(`🏥 Fetching ${THURKLINIK_COMPANY_NAME} jobs`);
  console.log(`   Listing: ${THURKLINIK_CAREERS_URL}\n`);

  let listingHtml;
  try {
    listingHtml = await fetchHtml(THURKLINIK_CAREERS_URL);
  } catch (err) {
    console.warn(`⚠️ Listing fetch failed: ${err?.message || err}`);
    throw err;
  }
  let rows = parseListing(listingHtml);
  // Drop spontaneous-application placeholders, they are not real openings.
  rows = rows.filter((row) => !row.isSpontaneous);
  console.log(`  ✓ ${rows.length} concrete vacancy postings detected`);
  if (rows.length === 0) return [];

  const jobs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (i > 0) await new Promise((res) => setTimeout(res, SOURCE_DELAY_MS));

    const sourceUrl = row.detailUrl || row.pdfUrl;
    let title = row.title;
    let description = '';
    if (row.detailUrl) {
      console.log(`  📄 Extracting detail page for "${row.title.slice(0, 80)}" (${row.identifier.slice(0, 40)})`);
      let detailHtml;
      try {
        detailHtml = await fetchHtml(row.detailUrl);
      } catch (err) {
        console.warn(`     ⚠️ Detail page fetch failed: ${err?.message || err}`);
        throw err;
      }
      const detail = parseDetailPage(detailHtml, row.title);
      title = detail.title || row.title;
      description = buildThurklinikDescription({ detailText: detail.description });
      if (!description) {
        throw new Error(`Thurklinik detail page has no readable source body: ${row.detailUrl}`);
      }
    } else {
      console.log(`  📄 Extracting PDF for "${row.title.slice(0, 80)}" (${row.identifier.slice(0, 40)})`);
      let pdfText = '';
      try {
        const pdf = await extractPdfJobContentFromUrl(row.pdfUrl);
        if (pdf?.error) console.warn(`     ⚠️ PDF error: ${pdf.error}`);
        pdfText = pdf?.text || '';
      } catch (err) {
        console.warn(`     ⚠️ PDF fetch failed: ${err?.message || err}`);
      }
      description = buildThurklinikDescription({ pdfText });
    }

    const sourceLang = detectLang(description || title, 'de');
    const jobSlug = slugify(`${title} ${THURKLINIK_KEY} ${HQ_CITY}`);
    const vacancyKey = buildThurklinikVacancyKey(row.title);
    const jobId = buildThurklinikJobId(row.title);

    jobs.push({
      id: jobId,
      sourceIdentity: vacancyKey,
      slug: jobSlug,
      slugByLocale: { [sourceLang]: jobSlug },
      company: THURKLINIK_COMPANY_NAME,
      companyKey: THURKLINIK_KEY,
      companyDomain: THURKLINIK_COMPANY_DOMAIN,
      title,
      titleByLocale: { [sourceLang]: title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      needsRetranslation: true,
      location: HQ_CITY,
      canton: HQ_CANTON,
      url: sourceUrl,
      source: `${THURKLINIK_COMPANY_NAME} Dedicated Parser`,
      sourceLang,
      crawledAt: new Date().toISOString(),

      addressLocality: HQ_CITY,
      addressRegion: HQ_CANTON,
      addressCountry: 'CH',
      country: 'CH',
      postalCode: HQ_POSTAL_CODE,
      category: detectHealthcareCategory(`${title} ${description.slice(0, 500)}`),
      contract: /\b\d{2,3}\s*[-–%]\s*\d{2,3}\s*%\b/.test(title) ? 'part-time' : 'full-time',
      employmentType: detectHealthcareEmploymentType(
        `${title} ${description.slice(0, 500)}`
      ),
      experienceLevel: detectHealthcareExperienceLevel(title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      // The source has no verified publication metadata.
      ...sourcePostingDateFields(),
      applyUrl: row.detailUrl || THURKLINIK_CAREERS_URL,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
    });
  }

  console.log(`📋 Total ${THURKLINIK_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return jobs;
}

export { HQ_CITY, HQ_CANTON, HQ_POSTAL_CODE };
