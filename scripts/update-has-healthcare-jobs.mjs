#!/usr/bin/env node
/**
 * Dedicated HAS Healthcare Advanced Synthesis crawler runner.
 *
 * HAS Healthcare Advanced Synthesis is a pharmaceutical company specialized
 * in high-potency Active Pharmaceutical Ingredients (HPAPIs) headquartered
 * in Biasca, Ticino, Switzerland.
 *
 * Jobs are listed on the e-lavoro.ch platform (AITI micro-site) at:
 *   https://e-lavoro.ch/node/104
 *
 * Discovery flow:
 *   1. Fetch the listing page and extract job links + titles from HTML
 *   2. Fetch each individual job detail page for full descriptions
 *   3. Build job objects with structured descriptions
 *   4. Merge into data/jobs.json (add new, update existing, prune stale)
 *   5. Run the base crawler for AI localization (4 locales)
 *   6. Post-process: fix company name, location, canton
 *   7. Validate locale coverage across IT/EN/DE/FR
 */
import { sourcePostingDateFields } from './lib/source-posting-date.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {
  exitCrawlerOnError,
  fetchHtml,
  isConnectionLevelFetchError,
  WAF_IP_BLOCK_STATUS,
} from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import {
  printPublishedJobUrls,
  writeJobsSummary,
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  setCrawlerStartTime,
  getCrawlerElapsedMs,
} from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSliceVerified,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import { validateJobUrls } from './lib/validate-job-url.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  mergePreserveLocaleData,
} from './lib/dedicated-crawler-common.mjs';
import { dropStaleLocaleDescriptions, sourceLangOfBody } from './lib/source-locale-slots.mjs';
import { extractStableJobId } from './lib/job-match-key.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';
import { truncateSlugAtWordBoundary } from './lib/slug-truncate.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { meetsSourceBodyFloor } from './lib/source-body-floor.mjs';
import { dropFabricatedDescriptions } from './lib/drop-fabricated-description.mjs';
import {
  buildThinSourceHousekeepingProof,
  collectThinSourceJobsForQuarantine,
  keepStoredSourceBodiesByKey,
  sourceBodyForJob,
} from './lib/stored-source-body.mjs';
import { rewritePreparedStoredJobs } from './lib/stored-jobs-soft-exit.mjs';
import { fetchSourceViaRelay } from './lib/source-relay-fetch.mjs';
import { isRetryBudgetExhausted } from './lib/transient-fetch.mjs';
import { CRAWLER_TRANSPORT_FAILURE_OUTCOMES } from './lib/crawler-fetch-outcome.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const COMPANY_KEY = 'has-healthcare';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(COMPANY_KEY);
const PUBLIC_JOBS = `${DATA_JOBS}.public.json`;
const COMPANY_NAME = 'HAS Healthcare Advanced Synthesis';
const HQ = getCompanyDefaults(COMPANY_KEY);
const COMPANY_HOST = 'e-lavoro.ch';
const CAREERS_URL = 'https://e-lavoro.ch/node/104';
const LOCALES = ['it', 'en', 'de', 'fr'];
const DETAIL_DELAY_MS = 1_000;
function jobMatchKey(job) {
  return extractStableJobId(job?.url)
    || String(job?.url || '').trim().replace(/\/+$/, '');
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function slugify(text = '', suffix = '') {
  let s = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (suffix) {
    s = `${s}-${suffix}`.replace(/--+/g, '-');
  }
  return truncateSlugAtWordBoundary(s, 200);
}

function stripHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    // Open each <li> as a line-start bullet so list structure survives the strip (#2476).
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|li|h[1-6]|div|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#8211;/g, '–')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isTargetJob(job) {
  const key = normalize(job?.companyKey || job?.company || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();

  return (
    key === COMPANY_KEY ||
    key === 'has-healthcare-advanced-synthesis' ||
    key.startsWith('has-healthcare') ||
    (company.includes('has') && company.includes('healthcare')) ||
    (url.includes('e-lavoro.ch') && company.includes('has'))
  );
}

function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'e-lavoro.ch' || host === 'www.e-lavoro.ch';
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// HTML fetching
// ─────────────────────────────────────────────────────────────

async function fetchPage(url, timeoutMs = 20_000) {
  try {
    // The shared helper retries transient responses and uses the Jina clean-IP
    // fallback for connection/WAF failures. The old bespoke fetch swallowed
    // both classes as `''`, turning a live source into an unexplained `[]`.
    return await fetchHtml(url, {
      timeoutMs,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; FrontaliereBot/1.0; +https://frontaliereticino.ch)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
  } catch (err) {
    console.warn(`⚠️ Fetch failed for ${url}: ${err?.message || err}`);
    // Keep the Firebase relay as a second clean-IP path for the two sources it
    // allowlists. It is deliberately optional; when unavailable the original
    // error must reach the discovery boundary instead of becoming an empty
    // source claim.
    if (isConnectionLevelFetchError(err) || WAF_IP_BLOCK_STATUS.has(err?.status)) {
      const relayed = await fetchSourceViaRelay(url);
      if (relayed?.status >= 200 && relayed.status < 300) return relayed.text;
      if (relayed) console.warn(`⚠️ Source relay returned HTTP ${relayed.status} for ${url}`);
    }
    throw err;
  }
}

function fetchOutcomeForError(error) {
  if (isRetryBudgetExhausted(error)) return 'exhausted_retry';
  if (WAF_IP_BLOCK_STATUS.has(error?.status)) return 'anti_bot_block';
  if (isConnectionLevelFetchError(error)) return 'connection_error';
  return 'feed_endpoint_unavailable';
}

function abortKindForFetchOutcome(outcome) {
  return CRAWLER_TRANSPORT_FAILURE_OUTCOMES.has(outcome)
    ? 'connection-level-fetch'
    : 'no-jobs-parsed';
}

/**
 * Keep the zero-job receipt honest at the fetch/parser boundary. A listing
 * fetch failure is transport evidence; a fetched listing whose detail pages
 * produce no source body is selector/parser evidence. Neither is a proven
 * empty source.
 */
export function classifyHasHealthcareDiscovery({
  listingFetchOutcome = null,
  discovered = 0,
  parsed = 0,
  detailFetchOutcomes = [],
} = {}) {
  if (listingFetchOutcome) {
    return {
      lastFetchOutcome: listingFetchOutcome,
      abortKind: abortKindForFetchOutcome(listingFetchOutcome),
    };
  }

  const detailOutcomes = Array.isArray(detailFetchOutcomes)
    ? detailFetchOutcomes.filter(Boolean)
    : [];
  const firstTransportFailure = detailOutcomes.find((outcome) =>
    CRAWLER_TRANSPORT_FAILURE_OUTCOMES.has(outcome)
  );
  if (firstTransportFailure) {
    return {
      lastFetchOutcome: firstTransportFailure,
      abortKind: abortKindForFetchOutcome(firstTransportFailure),
    };
  }

  if (parsed > 0) return { lastFetchOutcome: 'ok', abortKind: null };

  const firstDetailOutcome = detailOutcomes[0];
  const allDetailsFailedAtTransport =
    discovered > 0
    && detailOutcomes.length === discovered
    && CRAWLER_TRANSPORT_FAILURE_OUTCOMES.has(firstDetailOutcome)
    && detailOutcomes.every((outcome) => outcome === firstDetailOutcome);

  if (allDetailsFailedAtTransport) {
    return {
      lastFetchOutcome: firstDetailOutcome,
      abortKind: abortKindForFetchOutcome(firstDetailOutcome),
    };
  }

  return { lastFetchOutcome: 'selector_miss', abortKind: 'no-jobs-parsed' };
}

// ─────────────────────────────────────────────────────────────
// Job listing parsing
// ─────────────────────────────────────────────────────────────

export function parseListingPage(html) {
  const jobs = [];
  // The Drupal listing has this structure per job card:
  //   <span class="job-title-row">TITLE</span>  (inside a col div)
  //   ... sector icon, date, percentage ...
  //   <a href="/node/NNN" target="_self" class="w-100 p-3">  (sibling col div)
  //     <span class="... main-list-job-button-view">Visualizza annuncio</span>
  //   </a>
  // Title and link are siblings, not nested — collect each separately and zip.

  const titles = [];
  const links = [];
  const percentages = [];
  const dates = [];

  let m;
  const titleRe = /<span class="job-title-row">(.*?)<\/span>/gi;
  while ((m = titleRe.exec(html)) !== null) titles.push(m[1].trim());

  const linkRe = /<a\s+href="(\/node\/\d+)"\s+target="_self"\s+class="w-100 p-3">/gi;
  while ((m = linkRe.exec(html)) !== null) links.push(m[1].trim());

  const pctRe = /<span class="rounded-pill main-list-job-percentage">(.*?)<\/span>/gi;
  while ((m = pctRe.exec(html)) !== null) percentages.push(m[1].trim());

  const dateRe = /<time[^>]*class="datetime">([\d.]+)<\/time>/gi;
  while ((m = dateRe.exec(html)) !== null) dates.push(m[1].trim());

  for (let i = 0; i < Math.min(titles.length, links.length); i++) {
    jobs.push({
      title: titles[i],
      detailUrl: `https://e-lavoro.ch${links[i]}`,
      percentage: percentages[i] || '',
      dateStr: dates[i] || '',
    });
  }

  return jobs;
}

// ─────────────────────────────────────────────────────────────
// Job detail parsing
// ─────────────────────────────────────────────────────────────

function parseDetailPage(html) {
  // Narrow to main content area first to avoid sidebar contamination.
  const mainAreaMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*node[^"]*job[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<div[^>]*class="[^"]*job[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const searchArea = mainAreaMatch ? mainAreaMatch[1] : html;

  const sections = {};
  // The page's own heading for each section, keyed like `sections`.
  const headings = {};

  // Extract sections by <h2> headers: Info azienda, Competenze richieste,
  // Saranno richiesti i seguenti compiti, Che cosa offriamo
  const sectionRegex = /<h2>(.*?)<\/h2>([\s\S]*?)(?=<h2>|<\/div>\s*<\/div>)/gi;
  let m;
  while ((m = sectionRegex.exec(searchArea)) !== null) {
    const header = stripHtml(m[1]).replace(/\.\s*$/, '').trim();
    const content = stripHtml(m[2]).trim();
    if (content.length > 20) {
      sections[header.toLowerCase()] = content;
      headings[header.toLowerCase()] = header;
    }
  }

  // Extract language requirements
  const langMatch = html.match(
    /<h3>Lingue richieste<\/h3>[\s\S]*?<div class="view-content">([\s\S]*?)<\/div>/i
  );
  const language = langMatch ? stripHtml(langMatch[1]).trim() : '';

  // Extract education
  const eduMatch = html.match(
    /<h3>Titolo di studio<\/h3>[\s\S]*?<div class="view-content">([\s\S]*?)<\/div>/i
  );
  const education = eduMatch ? stripHtml(eduMatch[1]).trim() : '';

  return { sections, headings, language, education };
}

// Sections of the posting published under the page's own headings.
const HAS_DESCRIPTION_SECTIONS = [
  'competenze richieste',
  'saranno richiesti i seguenti compiti',
  'che cosa offriamo',
];

/**
 * The posting's own text (issue 5253): its sections under the page's
 * headings, then the "Lingue richieste" / "Titolo di studio" fields the page
 * shows. No presentation line, emoji labels or "Settore:" / "Sede:" lines of
 * the crawler's — sector and address stay in their structured fields. A body
 * under the common 50-word floor (or no section at all) gives ''.
 */
export function buildDescription(detail) {
  const parts = [];
  for (const key of HAS_DESCRIPTION_SECTIONS) {
    const content = detail.sections?.[key];
    if (content) parts.push([detail.headings?.[key], content].filter(Boolean).join('\n'));
  }
  if (parts.length === 0) return '';
  if (detail.language) parts.push(`Lingue richieste: ${detail.language}`);
  if (detail.education) parts.push(`Titolo di studio: ${detail.education}`);
  const text = parts.join('\n\n').trim();
  return meetsSourceBodyFloor(text) ? text : '';
}

// Complete lines only: the old builder's intro, emoji labels, and structured
// location/sector lines. The section bodies between them are source text.
export const HAS_FABRICATED_DESCRIPTION_RE = /^(?:HAS Healthcare Advanced Synthesis, con sede a Biasca \(TI\), è alla ricerca di: [^\r\n]+|📋 Competenze richieste:|🎯 Mansioni principali:|🎁 Cosa offriamo:|🗣️ Lingue richieste: [^\r\n]+|🎓 Titolo di studio: [^\r\n]+|Settore: Farmaceutico \/ API \(Active Pharmaceutical Ingredients\)|Sede: Via Industria 24, Biasca \(TI\), Svizzera)[ \t]*\r?$/m;
const HAS_FABRICATED_LINE_RE = /^(?:HAS Healthcare Advanced Synthesis, con sede a Biasca \(TI\), è alla ricerca di: [^\r\n]+|📋 Competenze richieste:|🎯 Mansioni principali:|🎁 Cosa offriamo:|🗣️ Lingue richieste: [^\r\n]+|🎓 Titolo di studio: [^\r\n]+|Settore: Farmaceutico \/ API \(Active Pharmaceutical Ingredients\)|Sede: Via Industria 24, Biasca \(TI\), Svizzera)[ \t]*\r?\n?/gm;

export function stripHasFabricatedDescription(text = '') {
  return String(text)
    .replace(HAS_FABRICATED_LINE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function prepareExistingHasJobs(jobs) {
  return dropFabricatedDescriptions(
    jobs,
    HAS_FABRICATED_DESCRIPTION_RE,
    COMPANY_NAME,
    { strip: stripHasFabricatedDescription },
  );
}

// ─────────────────────────────────────────────────────────────
// Category & experience detection
// ─────────────────────────────────────────────────────────────

function detectCategory(title = '') {
  const t = normalize(title);
  if (/produzion|manufactur|production/i.test(t)) return 'manufacturing';
  if (/ingegner|engineer|tecnic/i.test(t)) return 'engineering';
  if (/chimico|chimi|scien|laborat/i.test(t)) return 'science';
  if (/manager|dirett|responsabile/i.test(t)) return 'management';
  if (/qualit|quality|gmp/i.test(t)) return 'quality';
  if (/impiegat|amministrat|segretari/i.test(t)) return 'admin';
  if (/assistente/i.test(t)) return 'manufacturing';
  return 'general';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(apprendist|afc|cfp|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|stagist|junior)/i.test(t)) return 'ENTRY';
  if (/senior|responsabile|capo|dirett|manager|head/i.test(t)) return 'SENIOR';
  return 'MID';
}

function detectEmploymentType(percentage = '') {
  const p = normalize(percentage);
  if (/100%|full[\s-]?time/i.test(p)) return 'FULL_TIME';
  if (/part[\s-]?time|50%|60%|70%|80%/i.test(p)) return 'PART_TIME';
  return 'FULL_TIME';
}

function parseDate(dateStr = '') {
  // Source formats: DD.MM.YY or DD.MM.YYYY; never truncate a four-digit year.
  const m = String(dateStr).trim().match(/^(\d{2})\.(\d{2})\.(\d{4}|\d{2})$/);
  if (!m) return '';
  const day = m[1];
  const month = m[2];
  const year = m[3].length === 4 ? m[3] : `20${m[3]}`;
  return `${year}-${month}-${day}`;
}

// ─────────────────────────────────────────────────────────────
// Main discovery
// ─────────────────────────────────────────────────────────────

async function fetchJobs(counts) {
  console.log(`📡 Fetching job listing page: ${CAREERS_URL}`);
  let listingHtml;
  try {
    listingHtml = await fetchPage(CAREERS_URL);
  } catch (error) {
    const lastFetchOutcome = fetchOutcomeForError(error);
    Object.assign(counts, {
      discovered: 0,
      parsed: 0,
      lastFetchOutcome,
      abortKind: abortKindForFetchOutcome(lastFetchOutcome),
    });
    console.warn('⚠️ Failed to fetch listing page.');
    return [];
  }

  const listings = parseListingPage(listingHtml);
  counts.discovered = listings.length;
  console.log(`📋 Found ${listings.length} job listing(s) on page.`);

  const jobs = [];
  const detailFetchOutcomes = [];
  for (const listing of listings) {
    // Keep sequential relay fallbacks outside the relay's per-host 1 s window.
    await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    console.log(`  📄 Fetching detail: ${listing.title} → ${listing.detailUrl}`);
    let detailHtml;
    try {
      detailHtml = await fetchPage(listing.detailUrl);
    } catch (error) {
      detailFetchOutcomes.push(fetchOutcomeForError(error));
      console.warn(`  ⚠️ Detail fetch failed for ${listing.detailUrl} — not published in this run.`);
      continue;
    }
    const detail = detailHtml
      ? parseDetailPage(detailHtml)
      : { sections: {}, language: '', education: '' };

    const description = buildDescription(detail);
    if (!description) {
      // No source body: not published in this run (no crawler-written stand-in).
      console.warn(`  ⚠️ No posting text on ${listing.detailUrl} — not published in this run.`);
      continue;
    }
    const slug = slugify(listing.title, COMPANY_KEY);
    const postedDate = parseDate(listing.dateStr);
    // The language the body is written in, not a fixed `it` key (a title
    // such as "Production Manager" is not evidence of it).
    const sourceLang = sourceLangOfBody(description, 'it');

    const job = {
      title: listing.title,
      company: COMPANY_NAME,
      companyKey: COMPANY_KEY,
      location: 'Biasca',
      canton: HQ.canton,
      country: 'CH',
      url: listing.detailUrl,
      applyUrl: listing.detailUrl,
      description,
      category: detectCategory(listing.title),
      sector: 'Farmaceutico / Healthcare',
      employmentType: detectEmploymentType(listing.percentage),
      experienceLevel: detectExperienceLevel(listing.title),
      source: 'has-healthcare-crawler',
      sourceLang,
      ...sourcePostingDateFields(postedDate),
      titleByLocale: { [sourceLang]: listing.title },
      descriptionByLocale: { [sourceLang]: description },
      slugByLocale: { [sourceLang]: slug },
      // _targetScope tells the base crawler this job is in Ticino,
      // bypassing the non_detail_url exclusion for /node/NNN URLs.
      _targetScope: { canton: HQ.canton, location: HQ.city },
    };

    jobs.push(job);
  }

  counts.parsed = jobs.length;
  const discovery = classifyHasHealthcareDiscovery({
    discovered: listings.length,
    parsed: jobs.length,
    detailFetchOutcomes,
  });
  Object.assign(counts, discovery);
  if (discovery.abortKind === 'connection-level-fetch') {
    console.warn(
      '⚠️ A detail transport failure made this partial run unsafe to merge; preserving the existing HAS slice.',
    );
    return [];
  }
  return jobs;
}

// ─────────────────────────────────────────────────────────────
// Merge
// ─────────────────────────────────────────────────────────────

function filterEmpty(obj = {}) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && String(v).trim()) out[k] = v;
  }
  return out;
}

async function mergeJobs(discoveredJobs) {
  const existing = readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS);
  const allJobs = Array.isArray(existing) ? [...existing] : [];

  const nonTargetJobs = allJobs.filter((j) => !isTargetJob(j));
  // Stored jobs of the old builder: their crawler-written description and the
  // translations of it go before the locale-preserving merge; one left
  // without any source text is not published (issue 5253).
  const existingTargetJobs = prepareExistingHasJobs(allJobs.filter(isTargetJob))
    .filter((job) => String(job.description || '').trim() || Object.values(job.descriptionByLocale || {}).some((text) => String(text || '').trim()));

  const existingKeys = new Set(
    existingTargetJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean)
  );
  const discoveredKeys = new Set(
    discoveredJobs.map((j) => extractStableJobId(j?.url)).filter(Boolean)
  );
  const added = [...discoveredKeys].filter((k) => !existingKeys.has(k)).length;
  const updated = [...discoveredKeys].filter((k) => existingKeys.has(k)).length;
  const removed = [...existingKeys].filter((k) => !discoveredKeys.has(k)).length;

  // mergePreserveLocaleData matches on the stable trailing job id extracted
  // from the URL (falls back to the normalized full URL when no stable
  // token is found), so a vendor title/slug rewrite no longer orphans the
  // job's previousSlugs/previousSlugsByLocale/firstSeenAt history the way
  // the previous exact-URL-keyed merge did (issue #3699).
  const sourceBodyJobs = keepStoredSourceBodiesByKey(discoveredJobs, existingTargetJobs, jobMatchKey);
  const merged = mergePreserveLocaleData(existingTargetJobs, sourceBodyJobs).map((job) => ({
    ...job,
    company: COMPANY_NAME,
    companyKey: COMPANY_KEY,
    canton: HQ.canton,
    country: 'CH',
    source: 'has-healthcare-crawler',
  }));
  // Non-source slots the merge kept that are not in their own language go
  // back to the translation pipeline.
  for (const job of merged) dropStaleLocaleDescriptions(job);
  const thinSourceJobs = collectThinSourceJobsForQuarantine(
    discoveredJobs,
    merged,
    jobMatchKey,
  );
  const cleanTargetJobs = merged
    .filter((job) => meetsSourceBodyFloor(sourceBodyForJob(job)))
    .sort((a, b) => String(b.postedDate || '').localeCompare(String(a.postedDate || '')));

  const final = [...nonTargetJobs, ...cleanTargetJobs];

  writeJsonAtomic(DATA_JOBS, final);
  fs.mkdirSync(path.dirname(PUBLIC_JOBS), { recursive: true });
  writeJsonAtomic(PUBLIC_JOBS, final);

  console.log(`\n📦 Merge results:`);
  console.log(`  ➕ Added: ${added}`);
  console.log(`  🔄 Updated: ${updated}`);
  console.log(`  🗑️  Removed (stale): ${removed}`);
  console.log(`  📊 Total jobs in file: ${final.length}`);
  if (thinSourceJobs.length > 0) {
    console.warn(`  ⚠️ HAS Healthcare: quarantining ${thinSourceJobs.length} job(s) without a source body of at least 50 words.`);
  }

  return {
    added,
    updated,
    removed,
    total: final.length,
    sourceBodyJobs,
    thinSourceJobs,
    targetExisting: existingTargetJobs,
    noPublishableJobs: sourceBodyJobs.length === 0,
  };
}

async function rewriteStoredHasJobsWithoutThinSource(storedJobs) {
  return rewritePreparedStoredJobs({
    prepare: prepareExistingHasJobs,
    storedJobs,
    companyKey: COMPANY_KEY,
    companyLabel: COMPANY_NAME,
    write: (jobs, options) => writeJobsCrawlerSliceVerified(COMPANY_KEY, jobs, {
      isTargetJob,
      ...options,
    }),
    assemble: () => assembleJobsDataset(),
  });
}

// ─────────────────────────────────────────────────────────────
// Adapter management
// ─────────────────────────────────────────────────────────────

function updateAdapterConfig() {
  const adapterPath = path.join(ADAPTERS_DIR, `${COMPANY_KEY}.json`);

  const adapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {};

  adapter.companyKey = COMPANY_KEY;
  adapter.companyName = COMPANY_NAME;
  adapter.companyHost = COMPANY_HOST;
  adapter.enabled = true;
  adapter.priority = Math.max(adapter.priority || 0, 10);
  adapter.crawlerModes = ['html'];
  adapter.seedUrls = [CAREERS_URL];
  adapter.notes =
    'Drupal 10 micro-site on e-lavoro.ch (AITI) — job listings at /node/104 with detail pages at /node/NNN.';
  adapter.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
  console.log(`📝 Adapter ${COMPANY_KEY} updated.`);
}

// ─────────────────────────────────────────────────────────────
// Base crawler (AI localization only)
// ─────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: COMPANY_KEY,
    localizeOnlyCompanyKeys: COMPANY_KEY,
    forceLocalizeKeys: COMPANY_KEY,
    disableWorkdayForce: true,
    localizeExistingOnly: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: '100000',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: '100000',
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Post-processing
// ─────────────────────────────────────────────────────────────

function postProcessJobs() {
  if (!fs.existsSync(DATA_JOBS)) return;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const jobs = Array.isArray(raw) ? raw : [];
  let fixed = 0;

  for (const job of jobs) {
    if (!isTargetJob(job)) continue;

    if (job.company !== COMPANY_NAME) {
      job.company = COMPANY_NAME;
      fixed++;
    }
    if (job.companyKey !== COMPANY_KEY) {
      job.companyKey = COMPANY_KEY;
      fixed++;
    }
    job.canton = HQ.canton;
    job.country = 'CH';
    if (!job.location) {
      job.location = 'Biasca';
      fixed++;
    }
  }

  if (fixed > 0) {
    writeJsonAtomic(DATA_JOBS, jobs);
    writeJsonAtomic(PUBLIC_JOBS, jobs);
    console.log(
      `🔧 Post-processed ${fixed} HAS Healthcare jobs (fixed company/location/canton).`
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Stats & validation
// ─────────────────────────────────────────────────────────────

function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json not found — no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const targetJobs = allJobs.filter(isTargetJob);

  console.log(`\n📊 === HAS Healthcare Job Stats ===`);
  console.log(`  🏢 Total HAS Healthcare jobs: ${targetJobs.length}`);

  if (targetJobs.length > 0) {
    console.log(`  📋 Jobs:`);
    for (const job of targetJobs) {
      console.log(`     - ${job.title} (${job.location || 'Biasca'})`);
    }
  }

  const afterSnapshot = snapshotJobSlugs(targetJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'HAS Healthcare');
  writeCrawlChangeSummaryToGH(crawlDiff, 'HAS Healthcare');
  return { total: targetJobs.length, crawlDiff };

}

function validateLocales() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_HAS_HEALTHCARE_STRICT',
    label: 'HAS Healthcare',
    dataJobsPath: DATA_JOBS,
    isTargetJob,
    locales: LOCALES,
    isTrustedDomain,
    untrustedDomainReason: 'url_not_e_lavoro_domain',
    failWhenNoJobs: false,
    noJobsMessage:
      'No HAS Healthcare jobs found — the company may not have active openings.',
  });
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  const counts = { discovered: null, parsed: null, lastFetchOutcome: null, abortKind: null };
  registerCrawlerSummaryGuard(COMPANY_KEY, 'HAS Healthcare', counts);
  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };
  console.log('═══════════════════════════════════════════════');
  console.log('  HAS Healthcare Advanced Synthesis — Dedicated Crawler');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Careers page: ${CAREERS_URL}\n`);

  // Snapshot before
  const beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isTargetJob))

  // Phase 1: Fetch and parse jobs
  const discoveredJobs = await fetchJobs(counts);

  if (discoveredJobs.length === 0) {
    console.log('\n⚠️ No HAS Healthcare jobs discovered.');
    console.log(
      '   The careers page may have changed structure or have no current openings.'
    );
    console.log('   Keeping existing jobs — no changes to data/jobs.json.');
    await rewriteStoredHasJobsWithoutThinSource(
      readExistingCrawlerJobs(COMPANY_KEY, DATA_JOBS).filter(isTargetJob),
    );
    const _cdResult = logStats(beforeSnapshot);
    crawlDiff = _cdResult.crawlDiff || crawlDiff;
    return;
  }

  // Phase 2: Update adapter config
  updateAdapterConfig();

  // Phase 3: Merge into data/jobs.json
  const mergeStats = await mergeJobs(discoveredJobs);
  if (mergeStats.noPublishableJobs) {
    counts.abortKind = 'no-jobs-parsed';
    console.warn(
      `⚠️ ${COMPANY_NAME}: all ${discoveredJobs.length} source body/bodies are below the 50-word source-body floor; quarantining thin-source rows.`,
    );
    await rewriteStoredHasJobsWithoutThinSource(mergeStats.targetExisting);
    return;
  }

  // Phase 4: Run base crawler for AI localization (DE/FR translations)
  console.log(
    '\n🌐 Running base crawler for AI localization of HAS Healthcare jobs...'
  );
  await runBaseCrawler();

  // Phase 5: Post-process
  postProcessJobs();

  // Phase 6: Log stats
  const stats = logStats(beforeSnapshot);
  crawlDiff = stats.crawlDiff || crawlDiff;
  if (stats.total === 0) {
    counts.abortKind = 'no-jobs-parsed';
    console.log(
      'ℹ️ No HAS Healthcare jobs found after crawl. No error — exiting OK.'
    );
    return;
  }

  // Phase 7: Validate locale coverage
  validateLocales();

  console.log('\n✅ HAS Healthcare crawler complete.');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw)
    ? _sliceRaw.filter(isTargetJob).filter((job) => meetsSourceBodyFloor(sourceBodyForJob(job)))
    : [];
  const removedJobs = crawlDiff.removedJobs || [];
  const housekeepingProof = buildThinSourceHousekeepingProof(
    removedJobs,
    mergeStats.thinSourceJobs,
    jobMatchKey,
  );
  await writeJobsCrawlerSliceVerified(COMPANY_KEY, _sliceJobs, {
    isTargetJob,
    ...(housekeepingProof ? { housekeepingProof } : {}),
  });
  writeSummaryCrawlerSlice({
    key: COMPANY_KEY,
    label: 'HAS Healthcare',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    discovered: counts.discovered,
    parsed: counts.parsed,
    written: _sliceJobs.length,
    lastFetchOutcome: counts.lastFetchOutcome || 'ok',
    abortKind: null,
    newCount: crawlDiff.newJobs.length,
    updatedCount: crawlDiff.updatedJobs.length,
    removedCount: crawlDiff.removedJobs.length,
    unchangedCount: crawlDiff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: crawlDiff.newJobs.slice(0, 30),
    updatedJobs: crawlDiff.updatedJobs.slice(0, 30),
    removedJobs: crawlDiff.removedJobs.slice(0, 30),
    unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((err) => exitCrawlerOnError(err, 'HAS Healthcare'));
}
