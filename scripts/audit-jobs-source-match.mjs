#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { extractPdfJobContentFromUrl } from './lib/pdf-job-content.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JOBS_PATH = path.resolve(ROOT, 'data', 'jobs.json');
const OUTPUT_PATH = path.resolve(ROOT, 'data', 'jobs-source-match-audit.json');

const USER_AGENT =
  process.env.JOBS_CRAWLER_USER_AGENT ||
  'Mozilla/5.0 (compatible; FrontaliereTicinoAudit/1.0; +https://frontaliereticino.ch/)';

const LOCALES = ['it', 'en', 'de', 'fr'];
const SITE_ROOTS = {
  it: 'https://frontaliereticino.ch/cerca-lavoro-ticino',
  en: 'https://frontaliereticino.ch/en/find-jobs-ticino',
  de: 'https://frontaliereticino.ch/de/jobs-im-tessin',
  fr: 'https://frontaliereticino.ch/fr/trouver-emploi-tessin',
};

const STOPWORDS = new Set([
  'a', 'about', 'after', 'agli', 'alla', 'alle', 'allo', 'also', 'an', 'and', 'auf', 'au',
  'aux', 'avec', 'be', 'bei', 'ben', 'bene', 'between', 'but', 'che', 'chi', 'con', 'come',
  'como', 'dans', 'das', 'dei', 'degli', 'del', 'della', 'delle', 'dello', 'dem', 'den', 'der',
  'des', 'di', 'die', 'du', 'ein', 'eine', 'einer', 'einem', 'el', 'en', 'entre', 'et', 'for',
  'from', 'gli', 'hanno', 'hat', 'have', 'ihr', 'il', 'im', 'in', 'into', 'is', 'it', 'its',
  'job', 'jobs', 'la', 'las', 'le', 'les', 'li', 'lo', 'mais', 'mit', 'nel', 'nella', 'nelle',
  'of', 'on', 'or', 'our', 'per', 'pour', 'pro', 'role', 'se', 'sie', 'sono', 'sur', 'the',
  'this', 'to', 'tra', 'un', 'una', 'und', 'une', 'uno', 'with', 'you', 'your',
  'stelle', 'stellen', 'emploi', 'lavoro', 'offerta', 'position', 'poste', 'candidate',
  'candidati', 'bewerbung', 'candidature', 'application', 'apply', 'benefits', 'team', 'company',
]);

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    offset: 0,
    limit: Number.POSITIVE_INFINITY,
    concurrency: 8,
    siteConcurrency: 20,
    timeoutMs: 16000,
    siteTimeoutMs: 12000,
    browserFallback: true,
    maxBrowserFallbacks: 120,
    companyKey: '',
    slug: '',
    output: OUTPUT_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--offset' && next) opts.offset = Number(next);
    if (arg === '--limit' && next) opts.limit = Number(next);
    if (arg === '--concurrency' && next) opts.concurrency = Number(next);
    if (arg === '--site-concurrency' && next) opts.siteConcurrency = Number(next);
    if (arg === '--timeout' && next) opts.timeoutMs = Number(next);
    if (arg === '--site-timeout' && next) opts.siteTimeoutMs = Number(next);
    if (arg === '--company-key' && next) opts.companyKey = String(next).trim();
    if (arg === '--slug' && next) opts.slug = String(next).trim();
    if (arg === '--output' && next) opts.output = path.resolve(process.cwd(), String(next));
    if (arg === '--no-browser-fallback') opts.browserFallback = false;
    if (arg === '--max-browser-fallbacks' && next) opts.maxBrowserFallbacks = Number(next);
  }

  opts.offset = clampInt(opts.offset, 0, 100000, 0);
  opts.limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : Number.POSITIVE_INFINITY;
  opts.concurrency = clampInt(opts.concurrency, 1, 20, 8);
  opts.siteConcurrency = clampInt(opts.siteConcurrency, 1, 40, 20);
  opts.timeoutMs = clampInt(opts.timeoutMs, 4000, 60000, 16000);
  opts.siteTimeoutMs = clampInt(opts.siteTimeoutMs, 4000, 30000, 12000);
  opts.maxBrowserFallbacks = clampInt(opts.maxBrowserFallbacks, 0, 500, 120);
  return opts;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function readJobs() {
  return JSON.parse(fs.readFileSync(JOBS_PATH, 'utf-8'));
}

function normalizeSpace(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripDiacritics(value = '') {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeForCompare(value = '') {
  return stripDiacritics(normalizeSpace(value))
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value = '') {
  return normalizeForCompare(value)
    .split(' ')
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function uniqueTokens(value = '') {
  return new Set(tokenize(value));
}

function overlapStats(aValue = '', bValue = '') {
  const a = uniqueTokens(aValue);
  const b = uniqueTokens(bValue);
  if (a.size === 0 || b.size === 0) {
    return { overlap: 0, recall: 0, precision: 0, jaccard: 0, overlapTokens: [] };
  }
  const overlapTokens = [];
  for (const token of a) {
    if (b.has(token)) overlapTokens.push(token);
  }
  const overlap = overlapTokens.length;
  const union = a.size + b.size - overlap;
  return {
    overlap,
    recall: overlap / a.size,
    precision: overlap / b.size,
    jaccard: union > 0 ? overlap / union : 0,
    overlapTokens: overlapTokens.slice(0, 20),
  };
}

function countInformativeTokens(value = '') {
  return tokenize(value).length;
}

function pickNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeSpace(value);
    if (normalized) return normalized;
  }
  return '';
}

function dedupeChunks(chunks = []) {
  const seen = new Set();
  const output = [];
  for (const chunk of chunks) {
    const normalized = normalizeSpace(chunk);
    if (normalized.length < 20) continue;
    const key = normalizeForCompare(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function textLength(value = '') {
  return normalizeSpace(value).length;
}

function safeJsonParse(raw = '') {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectLdJobText(node, chunks = [], titles = []) {
  if (!node) return;
  if (Array.isArray(node)) {
    node.forEach((item) => collectLdJobText(item, chunks, titles));
    return;
  }
  if (typeof node !== 'object') return;

  const typeValue = Array.isArray(node['@type']) ? node['@type'].join(' ') : String(node['@type'] || '');
  const looksLikeJobPosting = /jobposting/i.test(typeValue) ||
    ['title', 'description', 'responsibilities', 'qualifications', 'skills', 'experienceRequirements'].some((key) => key in node);

  if (looksLikeJobPosting) {
    if (typeof node.title === 'string') titles.push(node.title);
    const preferredKeys = [
      'title',
      'description',
      'responsibilities',
      'qualifications',
      'skills',
      'experienceRequirements',
      'educationRequirements',
      'incentiveCompensation',
      'jobBenefits',
      'employmentType',
      'validThrough',
      'industry',
      'occupationalCategory',
    ];
    for (const key of preferredKeys) {
      const value = node[key];
      if (typeof value === 'string') chunks.push(value);
      if (Array.isArray(value)) {
        value.forEach((item) => {
          if (typeof item === 'string') chunks.push(item);
          else if (item && typeof item === 'object' && typeof item.name === 'string') chunks.push(item.name);
        });
      }
      if (value && typeof value === 'object') {
        if (typeof value.name === 'string') chunks.push(value.name);
        if (typeof value.text === 'string') chunks.push(value.text);
      }
    }
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') collectLdJobText(value, chunks, titles);
  }
}

const jsdomVirtualConsole = new VirtualConsole();
jsdomVirtualConsole.on('jsdomError', () => {});

function extractHtmlDocument(html = '', pageUrl = '') {
  const dom = new JSDOM(html, {
    url: pageUrl || 'https://frontaliereticino.ch/',
    virtualConsole: jsdomVirtualConsole,
  });
  const { document } = dom.window;

  const ldChunks = [];
  const ldTitles = [];
  for (const script of document.querySelectorAll('script[type*="ld+json"]')) {
    const parsed = safeJsonParse(script.textContent || '');
    if (parsed) collectLdJobText(parsed, ldChunks, ldTitles);
  }

  const h1 = normalizeSpace(document.querySelector('h1')?.textContent || '');
  const titleTag = normalizeSpace(document.querySelector('title')?.textContent || '');
  const metaTitle = pickNonEmpty(
    document.querySelector('meta[property="og:title"]')?.getAttribute('content'),
    document.querySelector('meta[name="twitter:title"]')?.getAttribute('content'),
  );
  const metaDescription = pickNonEmpty(
    document.querySelector('meta[name="description"]')?.getAttribute('content'),
    document.querySelector('meta[property="og:description"]')?.getAttribute('content'),
  );

  const chunkSelectors = [
    '[itemprop="description"]',
    '[itemprop="responsibilities"]',
    '[itemprop="qualifications"]',
    '[itemprop="jobBenefits"]',
    '[itemprop="skills"]',
    'main',
    'article',
  ];

  const chunks = [];
  for (const selector of chunkSelectors) {
    document.querySelectorAll(selector).forEach((node) => {
      chunks.push(node.textContent || '');
    });
  }

  const bodyClone = document.body?.cloneNode(true);
  if (bodyClone) {
    bodyClone.querySelectorAll('script, style, noscript, svg, canvas').forEach((node) => node.remove());
    chunks.push(bodyClone.textContent || '');
  }

  const deduped = dedupeChunks([
    ...ldChunks,
    h1,
    titleTag,
    metaTitle,
    metaDescription,
    ...chunks,
  ]);

  const text = deduped.join('\n\n');
  return {
    title: pickNonEmpty(h1, ldTitles[0], metaTitle, titleTag),
    text,
    metaDescription,
    titleTag,
    h1,
    chunkCount: deduped.length,
  };
}

async function fetchWithTimeout(url, { timeoutMs = 15000, headers = {}, redirect = 'follow' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...headers,
      },
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

let playwrightModulePromise = null;
let browserPromise = null;

async function getBrowser() {
  if (!playwrightModulePromise) playwrightModulePromise = import('playwright');
  if (!browserPromise) {
    browserPromise = playwrightModulePromise.then(({ chromium }) =>
      chromium.launch({ headless: true }).catch(() => null)
    );
  }
  return browserPromise;
}

async function extractViaBrowser(url, timeoutMs) {
  const browser = await getBrowser();
  if (!browser) return { title: '', text: '', error: 'Browser launch failed' };

  const page = await browser.newPage({ userAgent: USER_AGENT });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(1000);
    const title = normalizeSpace(await page.title().catch(() => ''));
    const html = await page.content();
    const extracted = extractHtmlDocument(html, url);
    if (!extracted.text) {
      extracted.text = normalizeSpace(await page.locator('body').textContent().catch(() => ''));
    }
    return {
      title: pickNonEmpty(extracted.title, title),
      text: extracted.text,
      method: 'browser',
    };
  } catch (error) {
    return {
      title: '',
      text: '',
      error: error instanceof Error ? error.message : String(error || 'Browser extraction failed'),
      method: 'browser',
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function extractSource(job, opts, state) {
  const sourceUrl = String(job.url || '').trim();
  if (!sourceUrl) {
    return {
      status: 'unreachable',
      sourceUrl: '',
      finalUrl: '',
      method: 'none',
      httpStatus: 0,
      title: '',
      text: '',
      reason: 'missing_source_url',
    };
  }

  if (/\.pdf(?:$|[?#])/i.test(sourceUrl)) {
    const pdf = await extractPdfJobContentFromUrl(sourceUrl, { timeoutMs: opts.timeoutMs });
    return {
      status: pdf.text ? 'ok' : 'unreachable',
      sourceUrl,
      finalUrl: sourceUrl,
      method: 'pdf',
      httpStatus: pdf.text ? 200 : 0,
      title: normalizeSpace(job.title || ''),
      text: normalizeSpace(pdf.text || ''),
      reason: pdf.error || '',
    };
  }

  try {
    const response = await fetchWithTimeout(sourceUrl, { timeoutMs: opts.timeoutMs });
    const html = await response.text();
    const extracted = extractHtmlDocument(html, response.url || sourceUrl);
    let text = normalizeSpace(extracted.text || '');
    let title = normalizeSpace(extracted.title || '');
    let method = 'fetch';
    let reason = '';

    const needsBrowserFallback =
      opts.browserFallback &&
      state.browserFallbacks < opts.maxBrowserFallbacks &&
      response.ok &&
      (text.length < 350 || countInformativeTokens(text) < 40);

    if (needsBrowserFallback) {
      const browserExtracted = await extractViaBrowser(response.url || sourceUrl, Math.max(25000, opts.timeoutMs));
      if (textLength(browserExtracted.text) > textLength(text)) {
        text = normalizeSpace(browserExtracted.text);
        title = pickNonEmpty(browserExtracted.title, title);
        method = browserExtracted.method || method;
        state.browserFallbacks += 1;
      } else if (browserExtracted.error) {
        reason = browserExtracted.error;
      }
    }

    return {
      status: response.ok && text ? 'ok' : 'unreachable',
      sourceUrl,
      finalUrl: response.url || sourceUrl,
      method,
      httpStatus: response.status,
      title,
      text,
      reason,
    };
  } catch (error) {
    return {
      status: 'unreachable',
      sourceUrl,
      finalUrl: sourceUrl,
      method: 'fetch',
      httpStatus: 0,
      title: '',
      text: '',
      reason: error instanceof Error ? error.message : String(error || 'Unknown fetch error'),
    };
  }
}

function buildSiteUrl(job, locale) {
  const slug = normalizeSpace(job.slugByLocale?.[locale] || '');
  if (!slug) return '';
  return `${SITE_ROOTS[locale]}/${slug}/`;
}

async function checkLocalePage(job, locale, opts) {
  const url = buildSiteUrl(job, locale);
  const expectedTitle = pickNonEmpty(job.titleByLocale?.[locale], job.title);
  if (!url) {
    return { locale, url: '', status: 'missing_slug', title: '', titleScore: 0 };
  }

  try {
    const response = await fetchWithTimeout(url, { timeoutMs: opts.siteTimeoutMs });
    const html = await response.text();
    const extracted = extractHtmlDocument(html, response.url || url);
    const pageTitle = pickNonEmpty(extracted.title, extracted.titleTag);
    const titleStats = overlapStats(expectedTitle, pageTitle || extracted.text.slice(0, 200));
    const ok = response.ok && titleStats.recall >= 0.5;
    return {
      locale,
      url,
      status: ok ? 'ok' : (response.ok ? 'title_mismatch' : `http_${response.status}`),
      title: pageTitle,
      titleScore: round(titleStats.recall),
      httpStatus: response.status,
    };
  } catch (error) {
    return {
      locale,
      url,
      status: 'fetch_error',
      title: '',
      titleScore: 0,
      httpStatus: 0,
      reason: error instanceof Error ? error.message : String(error || 'Unknown locale fetch error'),
    };
  }
}

function buildPublishedText(job) {
  const sourceLang = normalizeSpace(job.sourceLang || 'it') || 'it';
  return {
    sourceLang,
    title: pickNonEmpty(job.titleByLocale?.[sourceLang], job.title),
    description: pickNonEmpty(job.descriptionByLocale?.[sourceLang], job.description),
  };
}

function classifyAudit({ titleRecall, descRecall, lengthRatio, sourceLen, publishedLen, sourceTokenCount, publishedTokenCount }) {
  if (sourceLen < 80 || sourceTokenCount < 12) {
    return { status: 'unknown', severity: 'info', reasons: ['source_too_thin'] };
  }
  if (publishedLen < 80 || publishedTokenCount < 12) {
    return { status: 'review', severity: 'high', reasons: ['published_description_too_thin'] };
  }
  if (descRecall >= 0.9 && lengthRatio >= 0.6) {
    return { status: 'ok', severity: 'low', reasons: [] };
  }
  if (titleRecall < 0.45 && descRecall < 0.85) {
    return { status: 'review', severity: 'high', reasons: ['title_mismatch'] };
  }
  if (titleRecall >= 0.8 && descRecall >= 0.75) {
    return { status: 'ok', severity: 'low', reasons: [] };
  }
  if (sourceLen >= 900 && lengthRatio < 0.2) {
    return { status: 'review', severity: 'medium', reasons: ['published_description_far_shorter_than_source'] };
  }
  if (descRecall < 0.25 && lengthRatio < 0.45) {
    return { status: 'review', severity: 'high', reasons: ['low_content_overlap'] };
  }
  if (descRecall < 0.4 && lengthRatio < 0.25) {
    return { status: 'review', severity: 'medium', reasons: ['weak_overlap_and_short_summary'] };
  }
  if (descRecall < 0.5 || lengthRatio < 0.3) {
    return { status: 'watch', severity: 'medium', reasons: ['borderline_match'] };
  }
  return { status: 'ok', severity: 'low', reasons: [] };
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function analyzeJob(job, sourceResult, localeChecks) {
  const published = buildPublishedText(job);
  const publishedText = published.description;
  const sourceText = normalizeSpace(sourceResult.text || '');
  const publishedTitle = published.title;
  const sourceTitle = pickNonEmpty(sourceResult.title, sourceText.slice(0, 160));
  const titleStats = overlapStats(publishedTitle, sourceTitle);
  const descStats = overlapStats(publishedText, sourceText);
  const sourceLen = textLength(sourceText);
  const publishedLen = textLength(publishedText);
  const classification = sourceResult.status !== 'ok'
    ? { status: 'unknown', severity: 'info', reasons: ['source_unreachable'] }
    : classifyAudit({
      titleRecall: titleStats.recall,
      descRecall: descStats.recall,
      lengthRatio: sourceLen > 0 ? publishedLen / sourceLen : 0,
      sourceLen,
      publishedLen,
      sourceTokenCount: countInformativeTokens(sourceText),
      publishedTokenCount: countInformativeTokens(publishedText),
    });

  const localeIssues = localeChecks.filter((check) => check.status !== 'ok');

  return {
    jobId: job.id || '',
    slug: job.slug,
    company: job.company,
    companyKey: job.companyKey,
    sourceLang: published.sourceLang,
    publishedTitle,
    sourceTitle,
    status: classification.status,
    severity: classification.severity,
    reasons: classification.reasons,
    sourceUrl: sourceResult.sourceUrl,
    finalSourceUrl: sourceResult.finalUrl,
    sourceMethod: sourceResult.method,
    sourceHttpStatus: sourceResult.httpStatus,
    sourceReason: sourceResult.reason || '',
    titleRecall: round(titleStats.recall),
    descRecall: round(descStats.recall),
    descJaccard: round(descStats.jaccard),
    lengthRatio: round(sourceLen > 0 ? publishedLen / sourceLen : 0),
    publishedChars: publishedLen,
    sourceChars: sourceLen,
    overlapTokens: descStats.overlapTokens,
    localeIssues,
    localeStatus: localeIssues.length === 0 ? 'ok' : 'review',
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await mapper(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function summarizeByCompany(jobResults = []) {
  const byCompany = new Map();
  for (const result of jobResults) {
    const key = result.companyKey || 'unknown';
    if (!byCompany.has(key)) {
      byCompany.set(key, {
        companyKey: key,
        company: result.company,
        jobs: 0,
        ok: 0,
        watch: 0,
        review: 0,
        unknown: 0,
        localeIssues: 0,
        examples: [],
      });
    }
    const entry = byCompany.get(key);
    entry.jobs += 1;
    entry[result.status] = (entry[result.status] || 0) + 1;
    if (result.localeIssues.length > 0) entry.localeIssues += 1;
    if ((result.status === 'review' || result.localeIssues.length > 0) && entry.examples.length < 5) {
      entry.examples.push({
        slug: result.slug,
        status: result.status,
        reasons: result.reasons,
        sourceUrl: result.sourceUrl,
        localeIssues: result.localeIssues.map((issue) => `${issue.locale}:${issue.status}`),
      });
    }
  }

  return [...byCompany.values()]
    .map((entry) => ({
      ...entry,
      crawlerStatus: entry.review > 0 ? 'review' : (entry.watch > 0 ? 'watch' : 'ok'),
    }))
    .sort((a, b) => {
      if (b.review !== a.review) return b.review - a.review;
      if (b.watch !== a.watch) return b.watch - a.watch;
      return b.jobs - a.jobs;
    });
}

function printProgress(index, total, result) {
  const marker = result.status === 'review' ? '⚠️' : result.status === 'watch' ? '△' : result.status === 'ok' ? '✓' : '?';
  console.log(
    `${marker} [${index + 1}/${total}] ${result.companyKey} :: ${result.slug} :: ${result.status} ` +
    `(title ${result.titleRecall}, desc ${result.descRecall}, ratio ${result.lengthRatio})`
  );
}

async function closeBrowser() {
  const browser = await browserPromise?.catch(() => null);
  await browser?.close().catch(() => {});
}

async function main() {
  const opts = parseArgs();
  const state = { browserFallbacks: 0 };
  const allJobs = readJobs();

  const filteredJobs = allJobs
    .filter((job) => !opts.companyKey || job.companyKey === opts.companyKey)
    .filter((job) => !opts.slug || job.slug === opts.slug)
    .slice(opts.offset, Number.isFinite(opts.limit) ? opts.offset + opts.limit : allJobs.length);

  console.log(`Auditing ${filteredJobs.length} published jobs...`);

  const auditResults = await mapWithConcurrency(filteredJobs, opts.concurrency, async (job, index) => {
    const source = await extractSource(job, opts, state);
    const localeChecks = await mapWithConcurrency(LOCALES, opts.siteConcurrency, (locale) => checkLocalePage(job, locale, opts));
    const result = analyzeJob(job, source, localeChecks);
    printProgress(index, filteredJobs.length, result);
    return result;
  });

  const byCompany = summarizeByCompany(auditResults);
  const totals = {
    jobs: auditResults.length,
    ok: auditResults.filter((result) => result.status === 'ok').length,
    watch: auditResults.filter((result) => result.status === 'watch').length,
    review: auditResults.filter((result) => result.status === 'review').length,
    unknown: auditResults.filter((result) => result.status === 'unknown').length,
    localeIssues: auditResults.filter((result) => result.localeIssues.length > 0).length,
    browserFallbacksUsed: state.browserFallbacks,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      limit: Number.isFinite(opts.limit) ? opts.limit : null,
      offset: opts.offset,
      concurrency: opts.concurrency,
      siteConcurrency: opts.siteConcurrency,
      timeoutMs: opts.timeoutMs,
      siteTimeoutMs: opts.siteTimeoutMs,
      browserFallback: opts.browserFallback,
      maxBrowserFallbacks: opts.maxBrowserFallbacks,
      companyKey: opts.companyKey || null,
      slug: opts.slug || null,
      output: opts.output,
    },
    totals,
    flaggedCompanies: byCompany.filter((entry) => entry.crawlerStatus === 'review'),
    watchCompanies: byCompany.filter((entry) => entry.crawlerStatus === 'watch'),
    byCompany,
    jobs: auditResults,
  };

  fs.writeFileSync(opts.output, JSON.stringify(report, null, 2));

  console.log('\n=== Audit Summary ===');
  console.log(JSON.stringify(totals, null, 2));
  console.log(`Flagged crawlers: ${report.flaggedCompanies.length}`);
  if (report.flaggedCompanies.length > 0) {
    report.flaggedCompanies.slice(0, 15).forEach((entry) => {
      console.log(`- ${entry.companyKey}: ${entry.review}/${entry.jobs} review, ${entry.watch} watch, localeIssues ${entry.localeIssues}`);
    });
  }
  console.log(`\nSaved report to ${opts.output}`);

  await closeBrowser();
}

main().catch(async (error) => {
  console.error(error);
  await closeBrowser();
  process.exit(1);
});
