#!/usr/bin/env node
/**
 * Dedicated CSC Costruzioni crawler runner.
 *
 * CSC Costruzioni SA is a construction company headquartered in Lugano (TI).
 * Their careers page is at https://csc-sa.ch/lavoro-carriera-edilizia (Drupal CMS).
 *
 * This script:
 *   1. Scrapes the careers page to discover all job detail URLs.
 *   2. Verifies every discovered response and writes the exact allowlist as
 *      explicit detail seeds in the adapter config.
 *   3. Runs the shared base crawler which fetches each detail page and
 *      parses JSON-LD JobPosting structured data.
 *   4. The shared infrastructure filters for Ticino/GR locations automatically.
 *   5. Translates missing locales and validates coverage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { exitCrawlerOnError } from './lib/crawler-template.mjs';
import { fileURLToPath } from 'node:url';
import {
  snapshotJobSlugs,
  computeCrawlDiff,
  printCrawlChangeSummary,
  writeCrawlChangeSummaryToGH,
  setCrawlerStartTime,
  getCrawlerElapsedMs,
} from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  translateMissingJobLocales,
  validateDedicatedLocaleCoverage,
  detectLang,
  normalize,
  normalizeKey,
} from './lib/dedicated-crawler-common.mjs';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { extractBalancedTagBlock } from './lib/hospital-custom-html-helpers.mjs';
import { crawlerScratchPathFor } from './lib/crawler-scratch-path.mjs';

/* ── Constants ─────────────────────────────────────────────── */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const CSC_KEY = 'csc-costruzioni';
// Per-crawler-scoped scratch path — matches what runDedicatedBaseCrawler
// defaults to internally for a single-key run, so this script's own
// pre/post-crawl reads see the shared engine's actual output instead of the
// gitignored, CI-absent, cross-process-racy shared data/jobs.json (bug class
// of #3775/#3768).
const DATA_JOBS = crawlerScratchPathFor(CSC_KEY);
const CSC_COMPANY_NAME = 'CSC Costruzioni SA';
const CSC_HOST = 'csc-sa.ch';
const CSC_CAREERS_URL = 'https://csc-sa.ch/lavoro-carriera-edilizia';

const UA =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

/* ── Matchers ──────────────────────────────────────────────── */
function isCscJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  })();
  return (
    key === CSC_KEY ||
    key === 'csc-costruzioni-sa' ||
    key.startsWith('csc-costruzion') ||
    company.includes('csc costruzioni') ||
    company.includes('csc-sa') ||
    host === CSC_HOST ||
    host.endsWith('.csc-sa.ch')
  );
}

/* ── Discovery ─────────────────────────────────────────────── */
function decodeHref(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#x2f;/gi, '/')
    .replace(/&#47;/g, '/');
}

/**
 * CSC emits three Drupal detail route families. Keep this allowlist local to
 * the adapter: broadening the shared classifier would make unrelated Drupal
 * nodes look like vacancies for every crawler.
 */
export function canonicalCscDetailUrl(value) {
  let url;
  try {
    url = new URL(decodeHref(value), CSC_CAREERS_URL);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== CSC_HOST
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
  ) return null;

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\\') || pathname.includes('//')) return null;

  const isCareersChild = /^\/lavoro-carriera-edilizia\/[^/]+\/?$/i.test(pathname);
  const isDrupalNode = /^\/node\/[1-9]\d*\/?$/i.test(pathname) && !/^\/node\/24\/?$/i.test(pathname);
  const hasOfferSegment = pathname
    .split('/')
    .filter(Boolean)
    .some((segment) => /^offert[a-z0-9-]*$/i.test(segment));
  if (!isCareersChild && !isDrupalNode && !hasOfferSegment) return null;

  url.pathname = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return url.href;
}

function cscPlainText(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse only the Drupal work-position view. A 200 WAF/error shell, truncated
 * HTML or an unrecognised empty state is not an authoritative snapshot.
 */
export function parseCscCareersPage(html) {
  const source = String(html || '');
  const viewStart = source.search(/id=["']block-views-block-work-positions-work-positions-list["']/i);
  const viewEnd = source.indexOf('<!-- Modal Work Position -->', Math.max(0, viewStart));
  if (viewStart < 0 || viewEnd < 0 || !/<\/html>\s*$/i.test(source.trim())) {
    throw new Error('CSC discovery degraded: complete Drupal work-position view not found.');
  }

  const workPositionsHtml = source.slice(viewStart, viewEnd);
  const urls = new Set();
  const cscHrefPattern = /\bhref\s*=\s*(["'])(.*?)\1/gi;
  let match;
  while ((match = cscHrefPattern.exec(workPositionsHtml)) !== null) {
    const canonical = canonicalCscDetailUrl(match[2]);
    if (canonical) urls.add(canonical);
  }

  const empty = /\bview-empty\b/i.test(workPositionsHtml)
    && /al momento non sono disponibili offerte di lavoro/i.test(cscPlainText(workPositionsHtml));
  if (empty && urls.size > 0) {
    throw new Error('CSC discovery degraded: empty marker conflicts with discovered detail URLs.');
  }
  if (!empty && urls.size === 0) {
    throw new Error('CSC discovery degraded: no detail URLs and no authoritative empty marker.');
  }

  return { urls: [...urls], authoritativeEmpty: empty };
}

function readQuotedHtmlAttr(attrs, name) {
  const match = String(attrs || '').match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match?.[2] || '';
}

function collectJobPostingNodes(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectJobPostingNodes(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  if (types.some((type) => String(type || '').toLowerCase() === 'jobposting')) out.push(value);
  if (value['@graph']) collectJobPostingNodes(value['@graph'], out);
}

function extractCscJobPostingNodes(source) {
  const nodes = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptPattern.exec(source)) !== null) {
    if (!/^application\/ld\+json(?:\s*;|$)/i.test(readQuotedHtmlAttr(match[1], 'type'))) continue;
    if (!/JobPosting/i.test(match[2])) continue;
    let parsed;
    try {
      parsed = JSON.parse(match[2].trim());
    } catch {
      throw new Error('CSC detail invariant failed: malformed JobPosting JSON-LD.');
    }
    collectJobPostingNodes(parsed, nodes);
  }
  return nodes;
}

function stableSemanticValue(value) {
  if (Array.isArray(value)) return value.map(stableSemanticValue);
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? cscPlainText(value) : value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !['@context', '@id', 'url', 'mainEntityOfPage'].includes(key))
      .sort()
      .map((key) => [key, stableSemanticValue(value[key])]),
  );
}

function explicitJobPostingIdentifier(node) {
  const identifier = node?.identifier;
  if (typeof identifier === 'string' || typeof identifier === 'number') {
    return cscPlainText(String(identifier));
  }
  if (identifier && typeof identifier === 'object') {
    return cscPlainText(String(identifier.value || identifier.name || ''));
  }
  return '';
}

function semanticJobPostingHash(node, articleText) {
  const payload = node ? {
    title: node.title,
    description: node.description,
    hiringOrganization: node.hiringOrganization,
    jobLocation: node.jobLocation,
    employmentType: node.employmentType,
    datePosted: node.datePosted,
    validThrough: node.validThrough,
  } : { articleText };
  return createHash('sha256')
    .update(JSON.stringify(stableSemanticValue(payload)))
    .digest('hex');
}

const NESTED_WIDGET_TAGS = ['article', 'aside'];

/**
 * Strip nested descendant `<article>`/`<aside>` blocks (e.g. a related-
 * vacancy widget rendered inside the primary work-position node) out of the
 * primary article's raw HTML before it is turned into text for the
 * *fallback semantic hash*. `articleText` (used unstripped for the <80-char
 * reject check) intentionally still includes this text — that check only
 * cares about "is there enough content", not identity — but the hash must
 * not: two near-identical postings whose only difference is the content of
 * a nested widget (e.g. a "related jobs" list that changes between crawls)
 * would otherwise get an unstable/colliding identity (#7065).
 */
function stripNestedWidgetBlocks(html) {
  const source = String(html || '');
  const tagPattern = new RegExp(`<(${NESTED_WIDGET_TAGS.join('|')})\\b[^>]*>`, 'i');
  let out = '';
  let cursor = 0;
  while (cursor < source.length) {
    const remainder = source.slice(cursor);
    const openMatch = tagPattern.exec(remainder);
    if (!openMatch) { out += remainder; break; }
    out += remainder.slice(0, openMatch.index);
    const tagName = openMatch[1].toLowerCase();
    const restStart = cursor + openMatch.index + openMatch[0].length;
    const inner = extractBalancedTagBlock(source.slice(restStart), tagName, 50000);
    const afterInner = restStart + inner.length;
    const closeMatch = new RegExp(`^\\s*</${tagName}\\s*>`, 'i').exec(source.slice(afterInner));
    cursor = closeMatch ? afterInner + closeMatch[0].length : afterInner;
  }
  return out;
}

/**
 * Locate the first `<article>` in `source` and its full, depth-balanced
 * content via the shared `extractBalancedTagBlock` walker (already relied
 * on by the SuccessFactors/hospital parsers for the same nested-tag class of
 * bug): a naive non-greedy `[\s\S]*?</article>` regex stops at the FIRST
 * closing tag, which belongs to a nested same-named descendant (e.g. a
 * related-vacancy widget rendered as its own <article>), silently
 * truncating the outer primary article's content.
 */
function extractPrimaryArticle(source) {
  const openMatch = /<article\b([^>]*)>/i.exec(source);
  if (!openMatch) return null;
  const rest = source.slice(openMatch.index + openMatch[0].length);
  const content = extractBalancedTagBlock(rest, 'article', 50000);
  // extractBalancedTagBlock is a best-effort walker (falls back to the full
  // scan window when no matching close is found) — fine for its existing
  // description-scraping callers, not for this fail-closed trust boundary.
  // Require a genuine closing tag right after the extracted content.
  if (!/^\s*<\/article\s*>/i.test(rest.slice(content.length))) return null;
  return { attrs: openMatch[1], content };
}

/**
 * Accept only the primary Drupal article inside <main>. A related-job widget
 * elsewhere in the page cannot promote a generic shell to a trusted detail.
 */
export function parseCscPrimaryJobDetail(html) {
  const source = String(html || '');
  if (!/<\/html>\s*$/i.test(source.trim())) return null;

  const main = source.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || '';
  const article = extractPrimaryArticle(main);
  if (!article) return null;

  const articleClass = readQuotedHtmlAttr(article.attrs, 'class');
  if (!/(?:^|\s)node--type-work-position(?:\s|$)/i.test(articleClass)) return null;

  const nodeId = readQuotedHtmlAttr(article.attrs, 'data-history-node-id');
  const jobPostings = extractCscJobPostingNodes(source);
  if (jobPostings.length > 1) {
    throw new Error(`CSC detail invariant failed: primary work-position page exposes ${jobPostings.length} JobPosting nodes.`);
  }

  const articleText = cscPlainText(article.content);
  if (jobPostings.length === 0 && articleText.length < 80) return null;

  const jobPosting = jobPostings[0] || null;
  const explicitIdentifier = explicitJobPostingIdentifier(jobPosting);
  const identity = /^\d+$/.test(nodeId)
    ? `drupal-node:${nodeId}`
    : explicitIdentifier
      ? `job-identifier:${explicitIdentifier}`
      : `semantic:${semanticJobPostingHash(jobPosting, cscPlainText(stripNestedWidgetBlocks(article.content)))}`;

  return { identity, nodeId: /^\d+$/.test(nodeId) ? nodeId : '', hasJobPosting: Boolean(jobPosting) };
}

export function isCscJobDetailHtml(html) {
  try {
    return Boolean(parseCscPrimaryJobDetail(html));
  } catch {
    return false;
  }
}

async function fetchCscHtml(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'text/html', 'User-Agent': UA },
    });
    if (!res?.ok) throw new Error(`${url} returned HTTP ${res?.status ?? 'unknown'}`);
    const contentType = res.headers?.get?.('content-type');
    if (contentType && !/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
      throw new Error(`${url} returned unexpected content-type ${contentType}`);
    }
    const responseUrl = typeof res.url === 'string' ? res.url.trim() : '';
    if (!responseUrl) throw new Error(`${url} returned no final response URL.`);
    return { html: await res.text(), responseUrl };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A direct 200 response may legitimately carry a benign query string or
 * fragment (cache-buster, session token) without being a redirect outside
 * the detail contract: strip search/hash before the canonical comparison so
 * only a genuine mismatch in host/path/route family is treated as a
 * redirect. `canonicalCscDetailUrl` itself keeps rejecting query strings on
 * *discovered* links (e.g. `?preview=1`) — that filtering is unrelated to
 * this response-side check.
 */
function cscResponseMatchesCandidate(responseUrl, candidate) {
  if (canonicalCscDetailUrl(responseUrl) === candidate) return true;
  let url;
  try {
    url = new URL(responseUrl);
  } catch {
    return false;
  }
  if (!url.search && !url.hash) return false;
  url.search = '';
  url.hash = '';
  return canonicalCscDetailUrl(url.href) === candidate;
}

export async function verifyCscDetailUrls(urls, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs) || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  const candidates = [...new Set((urls || []).map(canonicalCscDetailUrl).filter(Boolean))];
  if (candidates.length !== (urls || []).length) {
    throw new Error(`CSC detail invariant failed: ${candidates.length}/${(urls || []).length} canonical candidate URLs.`);
  }

  const verified = [];
  const identities = new Map();
  for (const candidate of candidates) {
    const { html, responseUrl } = await fetchCscHtml(candidate, { fetchImpl, timeoutMs });
    if (!cscResponseMatchesCandidate(responseUrl, candidate)) {
      throw new Error(`CSC detail invariant failed: ${candidate} redirected outside its exact detail contract to ${responseUrl}.`);
    }
    const detail = parseCscPrimaryJobDetail(html);
    if (!detail) {
      throw new Error(`CSC detail invariant failed: ${candidate} did not return a canonical work-position page.`);
    }
    const firstCandidate = identities.get(detail.identity);
    if (firstCandidate && firstCandidate !== candidate) {
      throw new Error(`CSC detail invariant failed: ${candidate} and ${firstCandidate} share semantic identity ${detail.identity}.`);
    }
    identities.set(detail.identity, candidate);
    verified.push(candidate);
  }

  if (new Set(verified).size !== candidates.length) {
    throw new Error(`CSC detail invariant failed: ${verified.length} responses collapsed to ${new Set(verified).size} canonical URLs.`);
  }
  return verified;
}

export async function fetchCscJobUrls(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs) || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 12000;
  console.log(`🔍 Fetching CSC careers page: ${CSC_CAREERS_URL}`);

  const { html, responseUrl } = await fetchCscHtml(CSC_CAREERS_URL, { fetchImpl, timeoutMs });
  if (responseUrl !== CSC_CAREERS_URL) {
    throw new Error(`CSC discovery degraded: careers page redirected to ${responseUrl}.`);
  }
  const discovery = parseCscCareersPage(html);
  if (discovery.authoritativeEmpty) {
    console.log('ℹ️ CSC careers page explicitly reports zero open positions.');
    return discovery;
  }

  const urls = await verifyCscDetailUrls(discovery.urls, { fetchImpl, timeoutMs });
  console.log(`✅ Discovered and verified ${urls.length}/${discovery.urls.length} CSC job detail URLs`);
  return { urls, authoritativeEmpty: false };
}

/* ── Adapter ───────────────────────────────────────────────── */
export function buildCscAdapterConfig(existingAdapter, seedDetailUrls, updatedAt = new Date().toISOString()) {
  const adapter = { ...(existingAdapter || {}), seedDetailUrls, updatedAt };
  delete adapter.seedUrls;
  return adapter;
}

function ensureAdapterSeedUrls(seedUrls) {
  const adapterPath = path.join(ADAPTERS_DIR, `${CSC_KEY}.json`);

  const existingAdapter = fs.existsSync(adapterPath)
    ? JSON.parse(fs.readFileSync(adapterPath, 'utf-8'))
    : {
      companyKey: CSC_KEY,
      companyName: CSC_COMPANY_NAME,
      companyHost: CSC_HOST,
      enabled: true,
      priority: 10,
      crawlerModes: ['jsonld', 'html', 'generic_ats'],
      notes: 'CSC Costruzioni SA — Lugano-based construction company (Drupal CMS). Seed URLs auto-discovered from /lavoro-carriera-edilizia.',
    };
  const adapter = buildCscAdapterConfig(existingAdapter, seedUrls);
  writeJsonAtomic(adapterPath, adapter);
  console.log(`📝 Adapter ${CSC_KEY} updated with ${seedUrls.length} explicit detail seed URLs.`);
}

/* ── Base Crawler ──────────────────────────────────────────── */
function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: CSC_KEY,
    localizeOnlyCompanyKeys: CSC_KEY,
    forceLocalizeKeys: CSC_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_MAX_JOB_LINKS: process.env.JOBS_CRAWLER_MAX_JOB_LINKS || '100000',
      JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES: process.env.JOBS_CRAWLER_MAX_GENERIC_DETAIL_PAGES || '100000',
      JOBS_CRAWLER_FETCH_RETRIES: process.env.JOBS_CRAWLER_FETCH_RETRIES || '2',
      JOBS_CRAWLER_CONCURRENCY: process.env.JOBS_CRAWLER_CONCURRENCY || '4',
    },
  });
}

/* ── Stats & Validation ────────────────────────────────────── */
function logStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json not found — no stats available.');
    return { total: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const jobs = allJobs.filter(isCscJob);
  const tiJobs = jobs.filter((j) => normalize(j?.canton) === 'ti');
  const grJobs = jobs.filter((j) => normalize(j?.canton) === 'gr');

  console.log(`\n📊 === CSC Costruzioni Job Stats ===`);
  console.log(`  🏗️ Total CSC jobs: ${jobs.length}`);
  console.log(`  ✅ Ticino: ${tiJobs.length}`);
  console.log(`  ✅ Grigioni: ${grJobs.length}`);
  console.log('');

  const afterSnapshot = snapshotJobSlugs(jobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'CSC Costruzioni');
  writeCrawlChangeSummaryToGH(crawlDiff, 'CSC Costruzioni');

  return { total: jobs.length, crawlDiff };

}

function validateLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_CSC_STRICT',
    label: 'CSC Costruzioni',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCscJob,
    noJobsMessage: 'No CSC Costruzioni jobs found after crawl.',
    maxToleratedMissingDescriptions: 5,
  });
}

/* ── Main ──────────────────────────────────────────────────── */
async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(CSC_KEY, 'CSC Costruzioni');
  console.log('🏗️ Running dedicated CSC Costruzioni jobs crawler...');
  console.log(`   Portal: ${CSC_HOST} (Drupal CMS)`);
  console.log('');

  let crawlDiff = { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] };

  // Step 1: Discover job detail URLs from the careers page
  const discovery = await fetchCscJobUrls();
  if (discovery.authoritativeEmpty) {
    // The listing was fetched and its explicit empty marker validated. Persist
    // an empty detail allowlist (never the listing URL) but do not run the base
    // crawler or touch the published/expired job slices.
    ensureAdapterSeedUrls([]);
    console.log('ℹ️ CSC authoritative source is empty; published identities remain untouched.');
    printCrawlChangeSummary({ newJobs: crawlDiff.newJobs.slice(0, 30), updatedJobs: crawlDiff.updatedJobs.slice(0, 30), removedJobs: crawlDiff.removedJobs.slice(0, 30), unchangedCount: 0 }, 'CSC Costruzioni');
    return;
  }
  const detailUrls = discovery.urls;

  // Step 2: Update the adapter with discovered seed URLs
  ensureAdapterSeedUrls(detailUrls);

  // Snapshot before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(CSC_KEY, DATA_JOBS).filter(isCscJob))

  // Step 3: Run the base crawler (fetches JSON-LD from detail pages)
  await runBaseCrawler();

  // Step 4: Translate missing locales
  await translateMissingJobLocales({
    dataJobsPath: DATA_JOBS,
    isTargetJob: isCscJob,
  });

  // Step 4b: Ensure sourceLang is set on CSC jobs
  if (fs.existsSync(DATA_JOBS)) {
    const allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
    let patched = 0;
    for (const j of allJobs) {
      if (!isCscJob(j)) continue;
      if (!j.sourceLang) {
        j.sourceLang = detectLang(j.description || j.title, 'it');
        patched++;
      }
    }
    if (patched > 0) {
      writeJsonAtomic(DATA_JOBS, allJobs);
      console.log(`📝 Set sourceLang on ${patched} CSC Costruzioni jobs.`);
    }
  }

  // Step 5: Stats + validation
  const stats = logStats(_beforeSnapshot);
  crawlDiff = stats.crawlDiff || crawlDiff;
  if (stats.total === 0) {
    console.log('ℹ️ No CSC Costruzioni jobs found after crawl. Exiting OK.');
    printCrawlChangeSummary({ newJobs: crawlDiff.newJobs.slice(0, 30), updatedJobs: crawlDiff.updatedJobs.slice(0, 30), removedJobs: crawlDiff.removedJobs.slice(0, 30), unchangedCount: 0 }, 'CSC Costruzioni');
    return;
  }

  validateLocaleCoverage();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isCscJob) : [];
  writeJobsCrawlerSlice(CSC_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: CSC_KEY,
    label: 'CSC Costruzioni',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
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

// Only run main() when invoked as a script, not when imported by tests.
const isCscInvokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isCscInvokedDirectly) {
  main().catch((err) => exitCrawlerOnError(err, 'CSC Costruzioni'));
}
