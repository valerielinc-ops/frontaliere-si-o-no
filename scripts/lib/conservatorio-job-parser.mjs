#!/usr/bin/env node
/**
 * Conservatorio della Svizzera italiana job parser.
 *
 * The Conservatorio does not expose an ATS. It publishes vacancies as news
 * articles and places the official notice in a PDF attached to each article.
 * This parser follows that boundary deliberately:
 *
 *   1. walk every page of the official "Il CSI informa" archive;
 *   2. keep only article titles that describe a hiring notice;
 *   3. open the article and discover trusted PDF attachments;
 *   4. extract the PDF text and emit one job for each role in the notice;
 *   5. use the notice deadline to retire historical positions.
 *
 * A PDF is the source body and the stable URL identity. No crawler-written
 * description is added around it, so a change in the official notice remains
 * visible to the normal source-body and locale pipelines.
 */
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';

import { buildPdfBackedDescription, extractPdfJobContentFromUrl } from './pdf-job-content.mjs';
import { detectLang } from './dedicated-crawler-common.mjs';
import { SOURCE_BODY_FAILURE_REASON } from './source-body-failure.mjs';
import { fetchHtml, slugify, stripHtml } from './crawler-template.mjs';
import { sourcePostingDateFields } from './source-posting-date.mjs';
import { markAuthoritativeEmptySnapshot } from './authoritative-empty-snapshot.mjs';

export { slugify, stripHtml };

export const CONSERVATORIO_KEY = 'conservatorio';
export const CONSERVATORIO_COMPANY_NAME = 'Conservatorio della Svizzera italiana';
export const CONSERVATORIO_COMPANY_DOMAIN = 'conservatorio.ch';
export const CAREERS_URL =
  'https://www.conservatorio.ch/it/fondazione/il-csi-informa';
export const CONSERVATORIO_CAREER_URL = CAREERS_URL;
export const CONSERVATORIO_CITY = 'Lugano';
export const CONSERVATORIO_CANTON = 'TI';
export const CONSERVATORIO_POSTAL_CODE = '6900';
export const CONSERVATORIO_STREET = 'Via Soldino 9';

export const MAX_LISTING_PAGES = 40;
export const MAX_NO_DEADLINE_AGE_DAYS = 180;
const FALLBACK_ROLE_TITLE = 'Posizione presso il Conservatorio';

const ITALIAN_MONTHS = {
  gennaio: '01',
  febbraio: '02',
  marzo: '03',
  aprile: '04',
  maggio: '05',
  giugno: '06',
  luglio: '07',
  agosto: '08',
  settembre: '09',
  ottobre: '10',
  novembre: '11',
  dicembre: '12',
};
const ITALIAN_MONTH_PATTERN = Object.keys(ITALIAN_MONTHS).join('|');
const DETAIL_PATH_RE = /^\/it\/fondazione\/il-csi-informa\/dettaglio\/id\/\d+(?:\/[^/?#]+)?$/i;
const MEDIA_PDF_PATH_RE = /^\/media\/\d+\/[^/]+\.pdf$/i;
const VACANCY_TITLE_RE = /\b(?:cerca(?:no|si)?|bando\s+di\s+concorso|posti?\s+vacanti|posizioni?\s+aperte?|specialista\s+del\s+personale|responsabile\s+della|assistente|segretar(?:ia|io)|docent[ei]|dirett(?:ore|rice)|professor[ei]|insegnante)\b/i;
const ROLE_TITLE_RE = /\b(?:docent[ei]|dirett(?:ore|rice)|professor[ei]|insegnante|specialista|responsabile|assistente|segretar(?:ia|io)|corno|trombone|flauto|violino|fisarmonica|arpa|basso\s+tuba|fagotto)\b/i;

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}
function normalizeSpace(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
function normalizeDocumentText(value = '') {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map(normalizeSpace)
    .filter(Boolean)
    .join('\n');
}

function normalizeSearchText(value = '') {
  return normalizeDocumentText(value).replace(/\s+/g, ' ').trim();
}

function validIsoDate(year, month, day) {
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? '' : iso;
}

/** Parse the dd.mm.yy date used by the official archive. */
export function parseConservatorioDate(value = '') {
  const match = String(value || '').match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})\b/);
  if (!match) return '';
  const year = match[3].length === 2
    ? (Number(match[3]) < 70 ? 2000 + Number(match[3]) : 1900 + Number(match[3]))
    : Number(match[3]);
  return validIsoDate(year, Number(match[2]), Number(match[1]));
}

function italianDate(day, monthName, year) {
  const month = ITALIAN_MONTHS[normalize(monthName)];
  if (!month || !/^\d{4}$/.test(String(year)) || !/^\d{1,2}$/.test(String(day))) return '';
  return validIsoDate(Number(year), Number(month), Number(day));
}

function italianDateFromNumeric(day, month, year) {
  return validIsoDate(Number(year), Number(month), Number(day));
}

function dayString(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

function dayAgeInDays(isoDate, now = new Date()) {
  const published = new Date(`${isoDate}T00:00:00.000Z`);
  const today = new Date(`${dayString(now)}T00:00:00.000Z`);
  return (today.getTime() - published.getTime()) / 86_400_000;
}

function assertConservatorioUrl(rawUrl, { allowPdf = false } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Conservatorio: invalid source URL (${rawUrl})`);
  }

  const host = url.hostname.toLowerCase();
  const trustedHost = host === CONSERVATORIO_COMPANY_DOMAIN
    || host.endsWith(`.${CONSERVATORIO_COMPANY_DOMAIN}`);
  const sourcePage = url.pathname === new URL(CONSERVATORIO_CAREER_URL).pathname;
  const detailPage = DETAIL_PATH_RE.test(url.pathname);
  const pdf = MEDIA_PDF_PATH_RE.test(url.pathname);

  if (
    url.protocol !== 'https:'
    || !trustedHost
    || url.username
    || url.password
    || url.hash
    || (!sourcePage && !detailPage && !(allowPdf && pdf))
  ) {
    throw new Error(`Conservatorio: source URL escaped the approved boundary (${url.href})`);
  }
  return url;
}

/** Validate that a stored source URL belongs to the Conservatorio domain. */
export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === CONSERVATORIO_COMPANY_DOMAIN
      || host.endsWith(`.${CONSERVATORIO_COMPANY_DOMAIN}`);
  } catch {
    return false;
  }
}

/** Match current and legacy jobs belonging to this dedicated crawler. */
export function isConservatorioJob(job = {}) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = normalize(job?.url || '');
  return key === CONSERVATORIO_KEY
    || key.startsWith(`${CONSERVATORIO_KEY}-`)
    || company.includes('conservatorio della svizzera italiana')
    || isTrustedDomain(job?.url || '');
}

function isVacancyArticleTitle(title = '') {
  return VACANCY_TITLE_RE.test(normalizeSpace(title));
}

function cleanArticleTitle(title = '') {
  return normalizeSpace(title).replace(/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\s+/, '').trim();
}

/**
 * Parse one archive page. The news-list boundary is checked positively so a
 * redesigned or challenge page cannot become an authoritative empty snapshot.
 */
export function parseConservatorioListingPage(html = '', pageUrl = CONSERVATORIO_CAREER_URL) {
  assertConservatorioUrl(pageUrl);
  const dom = new JSDOM(String(html || ''));
  try {
    const { document } = dom.window;
    const newsList = document.querySelector('.list-events.list-news');
    if (!newsList) {
      throw new Error('Conservatorio: official news-list boundary missing');
    }

    const listings = [];
    const seen = new Set();
    for (const anchor of newsList.querySelectorAll('a[href]')) {
      let detailUrl;
      try {
        detailUrl = new URL(anchor.getAttribute('href') || '', pageUrl);
        assertConservatorioUrl(detailUrl.href);
      } catch {
        continue;
      }
      if (!DETAIL_PATH_RE.test(detailUrl.pathname) || seen.has(detailUrl.href)) continue;

      const title = cleanArticleTitle(
        anchor.querySelector('strong')?.textContent
          || anchor.textContent
          || '',
      );
      if (!isVacancyArticleTitle(title)) continue;
      seen.add(detailUrl.href);
      listings.push({
        detailUrl: detailUrl.href,
        title,
        publishedDate: parseConservatorioDate(anchor.querySelector('time')?.textContent || ''),
      });
    }
    return listings;
  } finally {
    dom.window.close();
  }
}

/** Read the highest archive page advertised by the official pagination. */
export function discoverConservatorioPageNumbers(html = '', pageUrl = CONSERVATORIO_CAREER_URL) {
  assertConservatorioUrl(pageUrl);
  const dom = new JSDOM(String(html || ''));
  try {
    const { document } = dom.window;
    if (!document.querySelector('.list-events.list-news')) {
      throw new Error('Conservatorio: official news-list boundary missing');
    }
    const pages = new Set([1]);
    for (const anchor of document.querySelectorAll('a[href]')) {
      let href;
      try {
        href = new URL(anchor.getAttribute('href') || '', pageUrl);
        assertConservatorioUrl(href.href);
      } catch {
        continue;
      }
      if (href.pathname !== new URL(CONSERVATORIO_CAREER_URL).pathname) continue;
      const page = Number(href.searchParams.get('page'));
      if (Number.isInteger(page) && page > 0) pages.add(page);
    }
    return [...pages].sort((a, b) => a - b);
  } finally {
    dom.window.close();
  }
}

function splitHeadingRoles(element) {
  const strongs = [...element.querySelectorAll('strong')]
    .map((node) => normalizeSpace(node.textContent || ''))
    .filter(Boolean);
  if (strongs.length > 1) return strongs;
  const text = normalizeSpace(element.textContent || '');
  return text ? [text] : [];
}

function cleanRoleTitle(title = '') {
  return normalizeSpace(title)
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/[.;]+$/, '')
    .trim();
}

function roleTitleFromArticle(title = '') {
  const cleaned = cleanArticleTitle(title);
  const afterSearch = cleaned.match(/\bcerca(?:no|si)?\s+(?:un\/?a|un|una|dei|delle|degli|del|della)?\s*(.+)$/i);
  if (afterSearch) {
    return cleanRoleTitle(afterSearch[1].replace(/^la posizione di\s+/i, ''));
  }
  return cleanRoleTitle(cleaned.replace(/^.*?\bbando(?:\s+di\s+concorso)?\s*[:–-]?\s*/i, ''));
}

function roleTitlesFromText(pdfText = '', articleTitle = '') {
  const lines = normalizeDocumentText(pdfText).split('\n');
  const roles = lines
    .map(cleanRoleTitle)
    .filter((line) => line.length >= 4 && line.length <= 180 && ROLE_TITLE_RE.test(line));
  const unique = [...new Map(roles.map((role) => [normalizeSearchText(role).toLowerCase(), role])).values()];
  return unique.length > 0 ? unique : [roleTitleFromArticle(articleTitle)].filter(Boolean);
}

/** Parse one official article and its trusted PDF attachments. */
export function parseConservatorioDetailPage(html = '', detailUrl) {
  assertConservatorioUrl(detailUrl);
  const dom = new JSDOM(String(html || ''));
  try {
    const { document } = dom.window;
    const title = cleanArticleTitle(document.querySelector('h1')?.textContent || '');
    const publishedDate = parseConservatorioDate(document.querySelector('.box.box-1 h4')?.textContent || '');
    const content = document.querySelector('.box.box-3') || document.body;
    const roleTitles = [];
    for (const heading of content.querySelectorAll('h2, h3, h4')) {
      for (const role of splitHeadingRoles(heading)) {
        const cleaned = cleanRoleTitle(role);
        if (cleaned && ROLE_TITLE_RE.test(cleaned)) roleTitles.push(cleaned);
      }
    }
    const uniqueRoles = [...new Map(roleTitles.map((role) => [normalizeSearchText(role).toLowerCase(), role])).values()];

    const pdfs = [];
    const seen = new Set();
    for (const anchor of content.querySelectorAll('a[href]')) {
      let pdfUrl;
      try {
        pdfUrl = new URL(anchor.getAttribute('href') || '', detailUrl);
        assertConservatorioUrl(pdfUrl.href, { allowPdf: true });
      } catch {
        continue;
      }
      if (!MEDIA_PDF_PATH_RE.test(pdfUrl.pathname) || seen.has(pdfUrl.href)) continue;
      seen.add(pdfUrl.href);
      pdfs.push({ pdfUrl: pdfUrl.href, roleTitles: uniqueRoles });
    }
    return {
      detailUrl: new URL(detailUrl).href,
      title,
      publishedDate,
      roleTitles: uniqueRoles,
      pdfs,
    };
  } finally {
    dom.window.close();
  }
}

function extractDeadlineFromText(text = '') {
  const normalized = normalizeSearchText(text);
  const prefix = `(?:entro|scadenza|termine(?:\s+per\s+la\s+candidatura)?|candidature[^.]{0,80}\bentro)`;
  const monthDate = new RegExp(
    `${prefix}[^.!?]{0,160}?\\b(\\d{1,2})\\s+(${ITALIAN_MONTH_PATTERN})\\s+(\\d{4})\\b`,
    'i',
  ).exec(normalized);
  if (monthDate) return italianDate(monthDate[1], monthDate[2], monthDate[3]);

  const numericDate = new RegExp(
    `${prefix}[^.!?]{0,160}?\\b(\\d{1,2})[./-](\\d{1,2})[./-](\\d{2}|\\d{4})\\b`,
    'i',
  ).exec(normalized);
  if (numericDate) {
    const year = numericDate[3].length === 2
      ? 2000 + Number(numericDate[3])
      : Number(numericDate[3]);
    return italianDateFromNumeric(numericDate[1], numericDate[2], year);
  }
  return '';
}

function roleKeywordCandidates(roleTitle = '') {
  const generic = new Set([
    'docente', 'docenti', 'direttore', 'direttrice', 'professore', 'professoressa',
    'responsabile', 'specialista', 'assistente', 'segretario', 'segretaria',
    'insegnante', 'scuola', 'universitaria', 'universitario', 'musica', 'sum',
    'della', 'delle', 'degli', 'dello', 'del', 'di', 'dei', 'una', 'uno', 'un',
  ]);
  const words = normalizeSearchText(roleTitle)
    .toLocaleLowerCase('it-CH')
    .replace(/[^a-zà-ÿ0-9]+/gi, ' ')
    .split(' ')
    .filter((word) => word.length >= 4 && !generic.has(word));
  return [...new Set(words)].sort((a, b) => b.length - a.length);
}

function extractRoleSpecificDeadline(pdfText, roleTitle) {
  const text = normalizeSearchText(pdfText);
  for (const keyword of roleKeywordCandidates(roleTitle)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...text.matchAll(new RegExp(`\\b${escaped}\\b`, 'gi'))];
    // The final occurrence is normally the one in the sentence that names the
    // audition/application deadline (the heading often names every role once).
    for (const match of [...matches].reverse()) {
      const candidate = extractDeadlineFromText(text.slice(match.index, match.index + 420));
      if (candidate) return candidate;
    }
  }
  return '';
}

function roleSection(pdfText, roleTitle, roleTitles = []) {
  const text = normalizeSearchText(pdfText);
  if (!roleTitle || roleTitles.length < 2) return text;
  const lower = text.toLocaleLowerCase('it-CH');
  const start = lower.indexOf(normalizeSearchText(roleTitle).toLocaleLowerCase('it-CH'));
  if (start < 0) return text;
  let end = text.length;
  for (const otherRole of roleTitles) {
    if (otherRole === roleTitle) continue;
    const other = lower.indexOf(normalizeSearchText(otherRole).toLocaleLowerCase('it-CH'), start + 1);
    if (other >= 0 && other < end) end = other;
  }
  return text.slice(start, end);
}

/** Extract the application deadline, scoped to one role in multi-role PDFs. */
export function extractConservatorioValidThrough(pdfText = '', { roleTitle = '', roleTitles = [] } = {}) {
  const roleSpecific = roleTitle ? extractRoleSpecificDeadline(pdfText, roleTitle) : '';
  if (roleSpecific) return roleSpecific;
  const scoped = roleSection(pdfText, roleTitle, roleTitles);
  const scopedDeadline = extractDeadlineFromText(scoped);
  if (scopedDeadline) return scopedDeadline;

  // Some role headings are intentionally generic (for example "Docente di
  // musica") and have no unique keyword to anchor a role-specific sentence.
  // In that case, fall back to a deadline stated for the whole notice rather
  // than silently publishing a multi-role posting without its expiry date.
  return roleTitles.length > 1 ? extractDeadlineFromText(pdfText) : '';
}

/** Return whether a fully parsed notice should be published on this run. */
export function isCurrentConservatorioListing({ validThrough = '', publishedDate = '' } = {}, now = new Date()) {
  const today = dayString(now);
  if (validThrough) return validThrough >= today;
  if (!publishedDate || publishedDate > today) return false;
  const age = dayAgeInDays(publishedDate, now);
  return age >= 0 && age <= MAX_NO_DEADLINE_AGE_DAYS;
}

function detectCategory(title = '', pdfText = '') {
  const value = normalize(`${title} ${pdfText}`);
  if (/risorse\s+umane|personale|human\s+resources|hr\b/.test(value)) return 'Risorse Umane';
  return 'Istruzione / Musica';
}

function detectEmploymentType(title = '', pdfText = '') {
  const value = normalize(`${title} ${pdfText}`);
  const percentages = [...value.matchAll(/(\d{2,3})\s*%/g)].map((match) => Number(match[1]));
  if (/tempo\s+parziale|part.?time|teilzeit/.test(value)) return 'PART_TIME';
  if (/tempo\s+pieno|full.?time|vollzeit/.test(value)) return 'FULL_TIME';
  if (percentages.length > 0) return Math.max(...percentages) >= 90 ? 'FULL_TIME' : 'PART_TIME';
  return 'OTHER';
}

function contractForEmploymentType(type) {
  if (type === 'FULL_TIME') return 'full-time';
  if (type === 'PART_TIME') return 'part-time';
  return 'other';
}

function experienceLevel(title = '') {
  return /dirett(?:ore|rice)|responsabile|specialista/i.test(title) ? 'senior' : 'mid';
}

/** Build a source-locale job from one official PDF and one role title. */
export function buildConservatorioJob({
  listing = {},
  roleTitle = '',
  roleTitles = [],
  pdfUrl = '',
  pdfText = '',
  now = new Date(),
} = {}) {
  const sourceUrl = assertConservatorioUrl(pdfUrl, { allowPdf: true }).href;
  const title = cleanRoleTitle(roleTitle || roleTitleFromArticle(listing.title) || 'Posizione presso il Conservatorio');
  const description = buildPdfBackedDescription({ pdfText });
  const sourceLang = detectLang(description || title, 'it');
  const roleText = roleSection(pdfText, title, roleTitles);
  const employmentType = detectEmploymentType(title, roleText);
  const slug = slugify(`${title} conservatorio ${CONSERVATORIO_CITY}`);
  const idHash = createHash('sha1').update(`${sourceUrl}|${normalizeSearchText(title).toLowerCase()}`).digest('hex').slice(0, 12);
  const validThrough = extractConservatorioValidThrough(pdfText, { roleTitle: title, roleTitles });

  return {
    id: `${CONSERVATORIO_KEY}-${idHash}`,
    slug,
    slugByLocale: { [sourceLang]: slug },
    company: CONSERVATORIO_COMPANY_NAME,
    companyKey: CONSERVATORIO_KEY,
    companyDomain: CONSERVATORIO_COMPANY_DOMAIN,
    title,
    titleByLocale: { [sourceLang]: title },
    description,
    descriptionByLocale: { [sourceLang]: description },
    location: CONSERVATORIO_CITY,
    canton: CONSERVATORIO_CANTON,
    url: sourceUrl,
    pdfUrl: sourceUrl,
    applyUrl: listing.detailUrl || CONSERVATORIO_CAREER_URL,
    source: 'Conservatorio della Svizzera italiana Dedicated Parser (news + PDF)',
    sourceLang,
    crawledAt: new Date().toISOString(),

    addressLocality: CONSERVATORIO_CITY,
    addressRegion: CONSERVATORIO_CANTON,
    addressCountry: 'CH',
    country: 'CH',
    postalCode: CONSERVATORIO_POSTAL_CODE,
    streetAddress: CONSERVATORIO_STREET,
    category: detectCategory(title, pdfText),
    contract: contractForEmploymentType(employmentType),
    employmentType,
    experienceLevel: experienceLevel(title),
    sector: 'Istruzione / Cultura',
    currency: 'CHF',
    featured: false,
    ...sourcePostingDateFields(listing.publishedDate || '', now),
    ...(validThrough ? { validThrough } : {}),
    requirements: [],
    requirementsByLocale: { [sourceLang]: [] },
  };
}

async function fetchConservatorioPage(url, { fetchPage = fetchHtml, timeoutMs } = {}) {
  const expected = assertConservatorioUrl(url);
  return fetchPage(expected.href, {
    timeoutMs,
    headers: { Accept: 'text/html,application/xhtml+xml' },
    validateRedirectUrl: (redirectUrl) => assertConservatorioUrl(redirectUrl),
  });
}

/**
 * Fetch and parse the complete official archive. The dependencies and clock
 * are injectable so tests never need to hit the public site or wait for PDFs.
 */
export async function fetchAllConservatorioJobs({
  fetchPage = fetchHtml,
  extractPdfText = extractPdfJobContentFromUrl,
  timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000,
  now = new Date(),
} = {}) {
  console.log(`🔍 Fetching ${CONSERVATORIO_COMPANY_NAME} jobs`);
  console.log(`   Source: ${CONSERVATORIO_CAREER_URL}\n`);

  const firstHtml = await fetchConservatorioPage(CONSERVATORIO_CAREER_URL, { fetchPage, timeoutMs });
  const pageNumbers = discoverConservatorioPageNumbers(firstHtml, CONSERVATORIO_CAREER_URL);
  const maxPage = Math.max(...pageNumbers);
  if (maxPage > MAX_LISTING_PAGES) {
    throw new Error(`Conservatorio: archive advertises ${maxPage} pages, above safety cap ${MAX_LISTING_PAGES}`);
  }

  const listings = parseConservatorioListingPage(firstHtml, CONSERVATORIO_CAREER_URL);
  for (const page of pageNumbers.filter((value) => value > 1)) {
    const pageUrl = new URL(CONSERVATORIO_CAREER_URL);
    pageUrl.searchParams.set('page', String(page));
    const html = await fetchConservatorioPage(pageUrl.href, { fetchPage, timeoutMs });
    listings.push(...parseConservatorioListingPage(html, pageUrl.href));
  }

  const uniqueListings = [...new Map(listings.map((listing) => [listing.detailUrl, listing])).values()];
  console.log(`  📋 Vacancy articles found in archive: ${uniqueListings.length}`);

  const jobs = [];
  const sourceBodyFailures = [];
  let pdfCandidateCount = 0;

  for (const listing of uniqueListings) {
    const detailHtml = await fetchConservatorioPage(listing.detailUrl, { fetchPage, timeoutMs });
    const detail = parseConservatorioDetailPage(detailHtml, listing.detailUrl);
    const detailListing = {
      ...listing,
      title: detail.title || listing.title,
      publishedDate: listing.publishedDate || detail.publishedDate,
    };
    if (detail.pdfs.length === 0) continue;

    for (const pdfListing of detail.pdfs) {
      pdfCandidateCount += 1;
      const roleTitles = pdfListing.roleTitles.length > 0
        ? pdfListing.roleTitles
        : roleTitlesFromText('', detailListing.title);
      const pdf = await extractPdfText(pdfListing.pdfUrl, { timeoutMs });
      const pdfText = String(pdf?.text || '').trim();
      const pdfFailed = Boolean(pdf?.error || pdf?.extractionFailed || pdf?.thin || !pdfText);

      if (pdfFailed) {
        const message = pdf?.error || pdf?.warning || 'official PDF has no usable text layer';
        console.warn(`  ⚠️ Conservatorio: ${pdfListing.pdfUrl}: ${message}`);
        const failureRoles = roleTitles.length > 0 ? roleTitles : [FALLBACK_ROLE_TITLE];
        sourceBodyFailures.push({
          title: failureRoles[0],
          url: pdfListing.pdfUrl,
          reason: SOURCE_BODY_FAILURE_REASON,
          message,
        });
        for (const roleTitle of failureRoles) {
          const failedJob = buildConservatorioJob({
            listing: detailListing,
            roleTitle,
            roleTitles,
            pdfUrl: pdfListing.pdfUrl,
            pdfText: '',
            now,
          });
          jobs.push({
            ...failedJob,
            sourceBodyFailureReason: SOURCE_BODY_FAILURE_REASON,
            sourceBodyFailureMessage: message,
            sourceBodyFailureKeepsStoredRecord: true,
          });
        }
        continue;
      }

      const roles = roleTitles.length > 0 ? roleTitles : roleTitlesFromText(pdfText, detailListing.title);
      for (const roleTitle of roles) {
        const job = buildConservatorioJob({
          listing: detailListing,
          roleTitle,
          roleTitles: roles,
          pdfUrl: pdfListing.pdfUrl,
          pdfText,
          now,
        });
        if (!isCurrentConservatorioListing(job, now)) {
          console.log(`  ⏭️ Expired/historical: ${job.title} (${job.validThrough || job.postedDate || 'no date'})`);
          continue;
        }
        jobs.push(job);
        console.log(`  ✅ ${job.title} (${job.validThrough || 'recent notice'})`);
      }
    }
  }

  if (jobs.length === 0 && sourceBodyFailures.length === 0) {
    markAuthoritativeEmptySnapshot(
      jobs,
      `scanned ${maxPage} official archive page(s), ${uniqueListings.length} vacancy article(s), and ${pdfCandidateCount} trusted PDF attachment(s)`,
    );
  }

  console.log(`\n📋 Total ${CONSERVATORIO_COMPANY_NAME} jobs discovered: ${jobs.length}`);
  return {
    jobs,
    discoveredCount: pdfCandidateCount,
    fetchOutcome: 'ok',
    sourceBodyFailures,
  };
}
