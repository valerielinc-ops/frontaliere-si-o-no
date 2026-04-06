#!/usr/bin/env node
/**
 * Dedicated SUPSI crawler runner.
 *
 * Source:
 *   https://www.supsi.ch/lavora-con-noi
 *
 * This script:
 *   1. Fetches the SUPSI jobs listing page and pagination action endpoint.
 *   2. Crawls listing pages (page 1 + pagination via POST).
 *   3. Extracts canonical SUPSI job detail URLs.
 *   4. Updates adapter seed URLs + seedMetaByUrl.
 *   5. Runs shared crawler scoped to SUPSI company key.
 *   6. Post-processes SUPSI rows for canonical consistency + dedupe.
 *   7. Enforces locale coverage in strict mode.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  validateDedicatedLocaleCoverage,
  detectLang,
  deriveLocalizedSlug,
  normalize,
  normalizeKey,
  isSlugStable,
} from './lib/dedicated-crawler-common.mjs';
import { parseSupsiJobDetail } from './lib/supsi-job-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');

const SUPSI_KEY = 'supsi-dti';
const SUPSI_COMPANY_NAME = 'SUPSI / DTI';
const SUPSI_COMPANY_DOMAIN = 'supsi.ch';
const SUPSI_HOST = 'www.supsi.ch';
const SUPSI_LISTING_URL = 'https://www.supsi.ch/lavora-con-noi';
const SUPSI_LOCALES = ['it', 'en', 'de', 'fr'];
const execFileAsync = promisify(execFile);

const PAGINATION_NAMESPACE = '_com_supsi_research_SupsiResearchPortlet_INSTANCE_lsai_';
const PAGINATION_PARAM_CURRENTCALL = `${PAGINATION_NAMESPACE}currentcall`;
const PAGINATION_PARAM_TOTAL = `${PAGINATION_NAMESPACE}total`;
const PAGINATION_PARAM_CUR_PAGE = `${PAGINATION_NAMESPACE}cur_page`;
const PAGINATION_FORM_DATE = `${PAGINATION_NAMESPACE}formDate`;

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .trim();
}

function stripTags(html = '') {
  return decodeHtmlEntities(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toAbsoluteSupsiUrl(rawUrl = '') {
  const value = decodeHtmlEntities(rawUrl);
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      url.hash = '';
      return url.href;
    } catch {
      return value;
    }
  }
  const pathname = value.startsWith('/') ? value : `/${value}`;
  return `https://${SUPSI_HOST}${pathname}`;
}

function canonicalizeSupsiUrl(rawUrl = '') {
  const absolute = toAbsoluteSupsiUrl(rawUrl);
  if (!absolute) return '';
  try {
    const url = new URL(absolute);
    url.hash = '';
    url.search = '';
    return url.href;
  } catch {
    return absolute;
  }
}

function extractPaginationActionUrl(html = '') {
  const m = String(html || '').match(
    /<form[^>]+id="_com_supsi_research_SupsiResearchPortlet_INSTANCE_lsai_course-research-filter-form"[^>]+action="([^"]+)"/i
  );
  if (!m) return '';
  return decodeHtmlEntities(m[1] || '');
}

/**
 * Extract pagination page URLs from <a href="..."> in the pagination block.
 * Returns a Map<pageNumber, url> for pages 2+.
 */
function extractPaginationLinks(html = '') {
  const blockMatch = String(html || '').match(/<div class="pagination"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/i);
  if (!blockMatch) return new Map();
  const block = blockMatch[0];
  const links = new Map();
  const re = /<a\s+href="(https?:\/\/[^"]+_cur_page=(\d+)[^"]*)"[^>]*>(\d+)<\/a>/gi;
  let m;
  while ((m = re.exec(block)) !== null) {
    const pageNum = Number(m[2]);
    const url = decodeHtmlEntities(m[1]);
    if (pageNum >= 2 && url) links.set(pageNum, url);
  }
  return links;
}

function extractTotalResults(html = '') {
  const m = String(html || '').match(
    /id="_com_supsi_research_SupsiResearchPortlet_INSTANCE_lsai_searchResultValue"[^>]*>\s*(\d+)\s*</i
  );
  return m ? Number(m[1]) : 0;
}

function extractFormDate(html = '') {
  const m = String(html || '').match(
    /id="_com_supsi_research_SupsiResearchPortlet_INSTANCE_lsai_formDate"[^>]*value="(\d+)"/i
  );
  return m ? m[1] : '';
}

function extractMaxPage(html = '') {
  const blockMatch = String(html || '').match(/<div class="pagination"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/i);
  const source = blockMatch ? blockMatch[0] : String(html || '');
  const numbers = [...source.matchAll(/>(\d+)<\/a>/gi)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  if (!numbers.length) return 1;
  return Math.max(...numbers, 1);
}

function parseContract(summary = '') {
  const txt = normalize(summary);
  if (!txt) return '';
  if (txt.includes('tempo pieno') || txt.includes('(100%)')) return 'Full-time';
  if (txt.includes('tempo parziale') || txt.includes('grado di occupazione')) return 'Part-time';
  if (txt.includes('stage') || txt.includes('tirocin')) return 'Stage';
  return '';
}

function inferLocation(summary = '') {
  const cleaned = stripTags(summary);
  if (!cleaned) return 'Ticino';
  const explicitSeat =
    cleaned.match(/\b(?:con sede a|sede a)\s+([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ'(). -]{1,60})/i)?.[1] ||
    cleaned.match(/\b(?:site in|based in)\s+([A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ'(). -]{1,60})/i)?.[1] ||
    '';
  if (explicitSeat) {
    return explicitSeat.replace(/[.,;:]+$/g, '').trim();
  }
  const firstLine = cleaned.split('\n').map((line) => line.trim()).find(Boolean) || '';
  if (firstLine) {
    const parts = firstLine.split(',').map((part) => part.trim()).filter(Boolean);
    const candidate = parts.length > 1 ? parts[parts.length - 1] : firstLine;
    if (
      candidate &&
      candidate.length <= 60 &&
      !/^(data|grado|entrata|concorso|supsi)\b/i.test(candidate) &&
      !/\d{4}/.test(candidate)
    ) {
      return candidate;
    }
  }
  return 'Ticino';
}

function parseTeasersFromHtml(html = '') {
  const source = String(html || '');
  const out = [];
  const articleRe = /<article class="teaser inline image">([\s\S]*?)<\/article>/gi;
  let match = null;
  while ((match = articleRe.exec(source)) !== null) {
    const block = match[1] || '';
    const href = block.match(/<a[^>]+href="([^"]+)"/i)?.[1] || '';
    const titleRaw = block.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i)?.[1] || '';
    const summaryRaw = block.match(/<div class="col-12 col-lg-6">\s*<p>([\s\S]*?)<\/p>\s*<\/div>/i)?.[1] || '';
    const expiry = block.match(/<time[^>]*datetime="([^"]+)"/i)?.[1] || '';

    const canonicalUrl = canonicalizeSupsiUrl(href);
    if (!canonicalUrl) continue;

    const title = stripTags(titleRaw);
    const summary = stripTags(summaryRaw);
    const location = inferLocation(summaryRaw);
    const contract = parseContract(summaryRaw);
    out.push({
      url: canonicalUrl,
      title,
      summary,
      expiry,
      location,
      contract,
    });
  }
  return out;
}

/** @type {string} Cookies captured from the first SUPSI request, forwarded to subsequent ones. */
let _supsiCookies = '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchSupsiPageViaCurl(url, { method = 'GET', body = '', timeoutMs = 30000, userAgent = '', cookies = '' } = {}) {
  const args = [
    '--silent',
    '--show-error',
    '--location',
    '--max-time',
    String(Math.max(5, Math.ceil(timeoutMs / 1000))),
    '--user-agent',
    userAgent || 'Mozilla/5.0',
    '--header',
    `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`,
    '--header',
    `Referer: ${SUPSI_LISTING_URL}`,
  ];
  if (cookies || _supsiCookies) {
    args.push('--header', `Cookie: ${cookies || _supsiCookies}`);
  }
  if (method === 'POST') {
    args.push('--request', 'POST', '--header', 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8');
    if (body) args.push('--data', body);
  }
  args.push(url);
  const { stdout } = await execFileAsync('curl', args, { maxBuffer: 15 * 1024 * 1024 });
  return stdout;
}

async function fetchSupsiPage(url, { method = 'GET', body = '', timeoutMs = 30000, userAgent = '', cookies = '' } = {}) {
  const attempts = [0, 1, 2];
  let lastErr;
  for (const attempt of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const cookieHeader = cookies || _supsiCookies;
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'User-Agent': userAgent,
          Referer: SUPSI_LISTING_URL,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(method === 'POST'
            ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
            : {}),
        },
        body: method === 'POST' ? body : undefined,
      });
      const setCookies = res.headers.getSetCookie?.() || [];
      if (setCookies.length > 0) {
        _supsiCookies = setCookies.map((c) => c.split(';')[0]).join('; ');
      }
      const html = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return html;
    } catch (err) {
      lastErr = err;
      if (attempt < attempts.length - 1) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    return await fetchSupsiPageViaCurl(url, { method, body, timeoutMs, userAgent, cookies });
  } catch (curlErr) {
    const fetchMsg = lastErr?.message || String(lastErr || 'unknown fetch error');
    const curlMsg = curlErr?.message || String(curlErr || 'unknown curl error');
    throw new Error(`fetch failed (${fetchMsg}); curl fallback failed (${curlMsg})`);
  }
}

function buildPaginationActionUrl(baseActionUrl, total, page) {
  const url = new URL(baseActionUrl);
  url.searchParams.set(PAGINATION_PARAM_CURRENTCALL, 'pagination');
  url.searchParams.set(PAGINATION_PARAM_TOTAL, String(total));
  url.searchParams.set(PAGINATION_PARAM_CUR_PAGE, String(page));
  return url.href;
}

/**
 * Load previously discovered SUPSI seed URLs + metadata from the adapter file.
 * Used as a graceful-degradation fallback when the SUPSI listing page is
 * temporarily unreachable from CI runners — lets the shared crawler re-verify
 * known jobs instead of crashing the whole pipeline on transient network issues.
 * Returns null when no cached adapter exists or the cache is empty.
 *
 * Exported for unit tests. The optional `adapterPath` parameter allows tests
 * to inject a fixture file; production code uses the default SUPSI adapter path.
 */
export function loadCachedSupsiSeeds(adapterPath = path.resolve(ADAPTERS_DIR, `${SUPSI_KEY}.json`)) {
  if (!fs.existsSync(adapterPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(adapterPath, 'utf-8')) || {};
    const cachedSeedUrls = Array.isArray(parsed.seedDetailUrls)
      ? parsed.seedDetailUrls.filter((u) => typeof u === 'string' && u.trim())
      : [];
    if (cachedSeedUrls.length === 0) return null;
    const cachedMeta = parsed.seedMetaByUrl && typeof parsed.seedMetaByUrl === 'object'
      ? parsed.seedMetaByUrl
      : {};
    return { seedUrls: cachedSeedUrls, seedMetaByUrl: { ...cachedMeta } };
  } catch {
    return null;
  }
}

async function fetchSupsiJobDetailUrls() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 30000;
  const userAgent =
    process.env.JOBS_CRAWLER_USER_AGENT ||
    'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

  const byUrl = new Map();
  const seedMetaByUrl = {};

  console.log('🔍 Fetching SUPSI jobs from listing...');
  let listingHtml = '';
  let lastListingErr = null;
  try {
    const html = await fetchSupsiPage(SUPSI_LISTING_URL, { timeoutMs, userAgent });
    if (/Page not found - SUPSI/i.test(html) || /<title>\s*404/i.test(html)) {
      throw new Error('HTML 404 page');
    }
    listingHtml = html;
  } catch (err) {
    lastListingErr = err;
  }

  if (!listingHtml) {
    // Graceful degradation: SUPSI's website is occasionally unreachable from GH
    // runners (no HTTP response, TCP-level timeout). Rather than crashing the
    // whole pipeline, fall back to the adapter's previously-discovered detail
    // URLs so the shared crawler can re-verify known jobs. Stale/expired jobs
    // still get cleaned up in the scoped housekeeping step.
    const cached = loadCachedSupsiSeeds();
    if (!cached) {
      throw lastListingErr || new Error('Unable to fetch SUPSI listing page');
    }
    const errMsg = lastListingErr?.message || String(lastListingErr || 'unknown error');
    console.warn(
      `  ⚠️ SUPSI listing unreachable (${errMsg}) — falling back to ${cached.seedUrls.length} cached detail URL(s) from adapter.`
    );
    return { seedUrls: cached.seedUrls, seedMetaByUrl: cached.seedMetaByUrl, fromCache: true };
  }

  const paginationLinks = extractPaginationLinks(listingHtml);
  const maxPage = Math.max(1, extractMaxPage(listingHtml));

  const page1 = parseTeasersFromHtml(listingHtml);
  console.log(`  📄 page 1: ${page1.length} teaser(s)`);
  for (const teaser of page1) {
    byUrl.set(teaser.url, teaser);
  }

  if (paginationLinks.size > 0 && maxPage > 1) {
    for (let page = 2; page <= maxPage; page += 1) {
      const pageUrl = paginationLinks.get(page);
      if (!pageUrl) {
        console.warn(`  ⚠️ page ${page}: no pagination link found`);
        break;
      }

      let pageHtml = '';
      try {
        // Liferay action URLs (p_p_lifecycle=1) require POST — GET returns 403
        pageHtml = await fetchSupsiPage(pageUrl, {
          method: 'POST',
          timeoutMs,
          userAgent,
        });
      } catch (err) {
        console.warn(`  ⚠️ page ${page} fetch failed: ${err?.message || err}`);
        break;
      }

      const teasers = parseTeasersFromHtml(pageHtml);
      console.log(`  📄 page ${page}: ${teasers.length} teaser(s)`);
      if (teasers.length === 0) break;

      let pageNew = 0;
      for (const teaser of teasers) {
        if (!byUrl.has(teaser.url)) {
          byUrl.set(teaser.url, teaser);
          pageNew += 1;
        }
      }
      if (pageNew === 0) break;
    }
  }

  for (const teaser of byUrl.values()) {
    seedMetaByUrl[teaser.url] = {
      location: teaser.location || 'Ticino',
      canton: 'TI',
      country: 'CH',
      company: SUPSI_COMPANY_NAME,
      companyDomain: SUPSI_COMPANY_DOMAIN,
      ...(teaser.contract ? { contract: teaser.contract } : {}),
      ...(teaser.expiry ? { expiresAt: teaser.expiry } : {}),
    };
  }

  const seedUrls = [...byUrl.keys()];
  console.log(`✅ Found ${seedUrls.length} unique SUPSI detail URL(s).`);
  return { seedUrls, seedMetaByUrl };
}

function updateSupsiAdapter({ seedUrls, seedMetaByUrl, fromCache = false }) {
  const adapterPath = path.resolve(ADAPTERS_DIR, `${SUPSI_KEY}.json`);
  const nextSeedUrls = Array.isArray(seedUrls) && seedUrls.length > 0 ? seedUrls : [SUPSI_LISTING_URL];

  // Cache-fallback mode: the listing was unreachable, so the seedUrls/meta we
  // have are unchanged snapshots from the previous successful run. Skip the
  // adapter rewrite to avoid bumping `updatedAt` and leave the on-disk adapter
  // byte-identical — this keeps git clean and avoids spurious commits.
  if (fromCache) {
    console.log('🧩 Adapter unchanged (using cached seeds — listing unreachable).');
    return;
  }

  let current = {};
  if (fs.existsSync(adapterPath)) {
    try {
      current = JSON.parse(fs.readFileSync(adapterPath, 'utf-8')) || {};
    } catch {
      current = {};
    }
  }

  const next = {
    ...current,
    companyKey: SUPSI_KEY,
    companyName: SUPSI_COMPANY_NAME,
    companyHost: SUPSI_HOST,
    enabled: true,
    priority: 10,
    crawlerModes: ['generic_ats', 'html', 'jsonld'],
    seedUrls: [SUPSI_LISTING_URL],
    seedDetailUrls: nextSeedUrls,
    seedMetaByUrl,
    notes:
      'Dedicated SUPSI crawler seeds from lavora-con-noi (including pagination via POST) and canonicalizes job URLs under supsi.ch.',
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(adapterPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  console.log(`🧩 Adapter updated: ${adapterPath}`);
}

function isSupsiJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').trim();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return (
    key === SUPSI_KEY ||
    key.includes('supsi') ||
    company.includes('supsi') ||
    host.endsWith('supsi.ch')
  );
}

function isTrustedSupsiDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('supsi.ch');
  } catch {
    return false;
  }
}

function scoreSupsiCandidate(job) {
  const url = String(job?.url || '').trim();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  const lang = detectLang(`${job?.title || ''} ${job?.description || ''}`, 'it');
  const descLen = String(job?.description || '').trim().length;
  const titleLen = String(job?.title || '').trim().length;

  let score = 0;
  if (host === SUPSI_HOST) score += 20000;
  else if (host.endsWith('supsi.ch')) score += 15000;
  if (isSupsiDescriptionNoisy(job?.description || '')) score -= 12000;
  if (lang === 'it') score += 4000;
  else if (lang === 'en') score += 1500;
  else if (lang === 'de') score += 1100;
  else if (lang === 'fr') score += 900;
  score += Math.min(8000, descLen);
  score += Math.min(2000, titleLen * 20);
  if (job?.titleByLocale?.it) score += 500;
  if (job?.descriptionByLocale?.it) score += 500;
  if (job?.slugByLocale?.it) score += 500;
  return score;
}

function buildSupsiDedupeKey(job) {
  const canonical = canonicalizeSupsiUrl(job?.url || '');
  if (canonical) return `url:${canonical.toLowerCase()}`;
  const slug = String(job?.slug || '').trim().toLowerCase();
  if (slug) return `slug:${slug}`;
  return `title:${normalize(job?.title || '')}`;
}

function ensureLocaleFields(job) {
  const title = String(job?.title || '').trim();
  const description = String(job?.description || '').trim();

  const titleByLocale = { ...(job?.titleByLocale || {}) };
  const descriptionByLocale = { ...(job?.descriptionByLocale || {}) };
  const slugByLocale = { ...(job?.slugByLocale || {}) };

  for (const locale of SUPSI_LOCALES) {
    if (!String(titleByLocale[locale] || '').trim() && title) {
      titleByLocale[locale] = title;
    }
    if (!String(descriptionByLocale[locale] || '').trim() && description) {
      descriptionByLocale[locale] = description;
    }
    if (!String(slugByLocale[locale] || '').trim()) {
      const candidate = deriveLocalizedSlug(job, locale) || job?.slug || '';
      if (candidate) slugByLocale[locale] = candidate;
    }
  }

  return { titleByLocale, descriptionByLocale, slugByLocale };
}

function cleanSupsiTitle(rawTitle = '') {
  return String(rawTitle || '')
    // Remove bando reference patterns: "(SUPSI / 26_XXXX)" or "(SUPSI 26_XXXX)" or "(26_XXXX)"
    .replace(/\s*\((?:SUPSI\s*\/?\s*)?2\d_\d+\)\s*/gi, ' ')
    // Remove trailing "- SUPSI"
    .replace(/\s*-\s*SUPSI\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSupsiLocation(rawLocation = '', seedMetaLocation = '') {
  const loc = String(rawLocation || '').trim();
  // If location contains garbage (share buttons text, long descriptions,
  // year-only values like "2026 (da concordare)"), use seed meta or fallback.
  if (!loc || loc.length > 60 || /condividi|share|fb\s+x\s+li/i.test(loc)
      || /^\d{4}\b/.test(loc)) {
    return seedMetaLocation || 'Ticino';
  }
  if (/\b(?:grado di occupazione|entrata in funzione|data inizio|concorso annuale)\b/i.test(loc)) {
    const trimmed = loc.split(/\b(?:grado di occupazione|entrata in funzione|data inizio|concorso annuale)\b/i)[0].trim();
    if (trimmed) return trimmed.replace(/[.,;:]+$/g, '').trim();
    return seedMetaLocation || 'Ticino';
  }
  return loc;
}

function isSupsiDescriptionNoisy(desc = '') {
  const text = String(desc || '');
  return /fragment_\d+|metaShareInit|const configuration\s*=|docuware-document|condividi\s*-\s*fb\s*-\s*x\s*-\s*li|lavora con noi - assistente/i.test(text);
}

function extractAlternateLocaleUrls(html = '', currentUrl = '') {
  const out = {};
  // Match <link> tags with rel="alternate" — attributes can appear in any order
  const rx = /<link\b[^>]*\brel=["']alternate["'][^>]*\/?>/gi;
  const rxAlt = /<link\b[^>]*\bhreflang=["'][^"']+["'][^>]*\brel=["']alternate["'][^>]*\/?>/gi;
  for (const pattern of [rx, rxAlt]) {
    let match = null;
    while ((match = pattern.exec(String(html || ''))) !== null) {
      const tag = match[0];
      const hreflangMatch = tag.match(/\bhreflang=["']([^"']+)["']/i);
      const hrefMatch = tag.match(/\bhref=["']([^"']+)["']/i);
      if (!hreflangMatch || !hrefMatch) continue;
      const lang = String(hreflangMatch[1]).trim().toLowerCase().slice(0, 2);
      if (!SUPSI_LOCALES.includes(lang) || out[lang]) continue;
      try {
        out[lang] = new URL(hrefMatch[1], currentUrl).href;
      } catch {
        // ignore malformed alternate URLs
      }
    }
  }
  return out;
}

async function repairSupsiJobFromSource(job) {
  const canonicalUrl = canonicalizeSupsiUrl(job?.url || '');
  if (!canonicalUrl) return normalizeSupsiRow(job);

  const userAgent =
    process.env.JOBS_CRAWLER_USER_AGENT ||
    'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 30000;

  let html = '';
  try {
    html = await fetchSupsiPage(canonicalUrl, { timeoutMs, userAgent });
  } catch {
    return normalizeSupsiRow(job);
  }

  const parsed = parseSupsiJobDetail(html, job?.title || '');
  const seedMetaLocation = String(job?._targetScope?.location || '').trim();
  const titleByLocale = { ...(job?.titleByLocale || {}) };
  const descriptionByLocale = { ...(job?.descriptionByLocale || {}) };
  const requirementsByLocale = { ...(job?.requirementsByLocale || {}) };

  if (parsed.title) titleByLocale.it = parsed.title;
  if (parsed.description) descriptionByLocale.it = parsed.description;
  if (parsed.requirements?.length) requirementsByLocale.it = parsed.requirements;

  const altUrls = extractAlternateLocaleUrls(html, canonicalUrl);
  for (const locale of SUPSI_LOCALES) {
    if (locale === 'it') continue;
    const altUrl = altUrls[locale];
    if (!altUrl) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const altHtml = await fetchSupsiPage(altUrl, { timeoutMs, userAgent });
      const altParsed = parseSupsiJobDetail(altHtml, titleByLocale[locale] || parsed.title || job?.title || '');
      if (altParsed.title) titleByLocale[locale] = altParsed.title;
      if (altParsed.description) descriptionByLocale[locale] = altParsed.description;
      if (altParsed.requirements?.length) requirementsByLocale[locale] = altParsed.requirements;
    } catch {
      // ignore locale-specific failures and keep current values
    }
  }

  return normalizeSupsiRow({
    ...job,
    url: canonicalUrl,
    title: parsed.title || job?.title || '',
    location: cleanSupsiLocation(parsed.location || job?.location || '', seedMetaLocation),
    description: parsed.description || job?.description || '',
    requirements: parsed.requirements?.length ? parsed.requirements : (Array.isArray(job?.requirements) ? job.requirements : []),
    titleByLocale,
    descriptionByLocale,
    requirementsByLocale,
  });
}

function slugifySupsi(input = '') {
  return String(input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
}

function normalizeSupsiRow(job) {
  const canonicalUrl = canonicalizeSupsiUrl(job?.url || '');
  const seedMetaLocation = String(job?._targetScope?.location || '').trim();
  const cleanedTitle = cleanSupsiTitle(job?.title || '');
  const cleanedLocation = cleanSupsiLocation(job?.location || '', seedMetaLocation);

  // Clean locale title variants
  const localeFields = ensureLocaleFields(job);
  const cleanedLocaleFields = { ...localeFields };
  if (cleanedLocaleFields.titleByLocale) {
    for (const locale of SUPSI_LOCALES) {
      if (cleanedLocaleFields.titleByLocale[locale]) {
        cleanedLocaleFields.titleByLocale[locale] = cleanSupsiTitle(cleanedLocaleFields.titleByLocale[locale]);
      }
    }
  }

  // Rebuild slug and slugByLocale from cleaned data.
  // Use Jaccard token similarity via isSlugStable: minor title wording changes
  // (capitalisation, preposition swaps) should not generate new slugs.
  const newSlug = slugifySupsi(`${cleanedTitle}-${SUPSI_COMPANY_NAME}-${cleanedLocation}`);
  const slugByLocale = { ...(cleanedLocaleFields.slugByLocale || {}) };
  for (const locale of SUPSI_LOCALES) {
    const localeTitle = cleanedLocaleFields.titleByLocale?.[locale] || cleanedTitle;
    const candidate = slugifySupsi(`${localeTitle}-${SUPSI_COMPANY_NAME}-${cleanedLocation}`);
    const existing = String(slugByLocale[locale] || '').trim();
    if (!isSlugStable(existing, candidate)) slugByLocale[locale] = candidate;
  }
  cleanedLocaleFields.slugByLocale = slugByLocale;

  return {
    ...job,
    url: canonicalUrl || job?.url || '',
    title: cleanedTitle,
    slug: newSlug,
    company: SUPSI_COMPANY_NAME,
    companyKey: SUPSI_KEY,
    companyDomain: SUPSI_COMPANY_DOMAIN,
    source: 'Company Careers Crawler',
    location: cleanedLocation,
    canton: String(job?.canton || '').trim() || 'TI',
    country: String(job?.country || '').trim() || 'CH',
    ...cleanedLocaleFields,
  };
}

function writeJobsFiles(jobs) {
  const payload = `${JSON.stringify(jobs, null, 2)}\n`;
  fs.writeFileSync(DATA_JOBS, payload, 'utf-8');
  fs.writeFileSync(PUBLIC_DATA_JOBS, payload, 'utf-8');
}

// ── Translation safety net ──────────────────────────────────────────────
// Direct DeepL + Google Translate fallback for any locale descriptions
// still missing after the shared crawler's AI localization pipeline.

const DEEPL_LANG_MAP = { it: 'IT', en: 'EN', de: 'DE', fr: 'FR' };

async function translateWithDeepLDirect(text, sourceLang, targetLang) {
  const apiKey = (process.env.DEEPL_API_KEY || '').trim();
  if (!apiKey) return '';
  const srcCode = DEEPL_LANG_MAP[sourceLang] || sourceLang?.toUpperCase() || '';
  const tgtCode = DEEPL_LANG_MAP[targetLang] || targetLang?.toUpperCase() || '';
  if (!tgtCode) return '';
  const body = new URLSearchParams();
  body.append('text', text);
  if (srcCode) body.append('source_lang', srcCode);
  body.append('target_lang', tgtCode);
  try {
    const res = await fetch('https://api-free.deepl.com/v2/translate', {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return data?.translations?.[0]?.text || '';
  } catch {
    return '';
  }
}

async function translateWithGoogleDirect(text, sourceLang, targetLang) {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return '';
    const data = await res.json();
    if (!Array.isArray(data?.[0])) return '';
    return data[0].map((s) => s?.[0] || '').join('');
  } catch {
    return '';
  }
}

async function translateTextDirect(text, sourceLang, targetLang) {
  if (!text || sourceLang === targetLang) return text || '';
  const deepl = await translateWithDeepLDirect(text, sourceLang, targetLang);
  if (deepl && deepl.length > 40) return deepl;
  const google = await translateWithGoogleDirect(text, sourceLang, targetLang);
  if (google && google.length > 40) return google;
  return '';
}

async function fillMissingLocaleDescriptions() {
  if (!fs.existsSync(DATA_JOBS)) return 0;
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(raw)) return 0;

  const MIN_DESC_CHARS = 120;
  let filled = 0;
  let changed = false;

  for (const job of raw) {
    if (!isSupsiJob(job)) continue;
    const sourceDesc = String(job?.description || '').trim();
    if (sourceDesc.length < MIN_DESC_CHARS) continue;
    const sourceLang = detectLang(`${job?.title || ''} ${sourceDesc}`, 'it');
    const descByLocale = job.descriptionByLocale || {};

    for (const locale of SUPSI_LOCALES) {
      if (locale === sourceLang) continue;
      const current = String(descByLocale[locale] || '').trim();
      const isIdenticalToSource = current && normalize(current) === normalize(sourceDesc);
      if (current.length >= MIN_DESC_CHARS && !isIdenticalToSource) continue;

      // eslint-disable-next-line no-await-in-loop
      const translated = await translateTextDirect(sourceDesc, sourceLang, locale);
      if (translated && translated.length >= MIN_DESC_CHARS && normalize(translated) !== normalize(sourceDesc)) {
        if (!job.descriptionByLocale) job.descriptionByLocale = {};
        job.descriptionByLocale[locale] = translated;
        filled += 1;
        changed = true;
      }
    }
  }

  if (changed) {
    writeJobsFiles(raw);
  }
  return filled;
}

async function postProcessSupsiJobs() {
  if (!fs.existsSync(DATA_JOBS)) return { total: 0, supsi: 0, deduped: 0 };
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(raw)) return { total: 0, supsi: 0, deduped: 0 };
  const repaired = [];

  for (const job of raw) {
    if (!isSupsiJob(job)) {
      repaired.push(job);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    repaired.push(await repairSupsiJobFromSource(job));
  }

  const bestByKey = new Map();
  for (const job of repaired) {
    if (!isSupsiJob(job)) continue;
    const normalizedRow = normalizeSupsiRow(job);
    const dedupeKey = buildSupsiDedupeKey(normalizedRow);
    const current = bestByKey.get(dedupeKey);
    if (!current || scoreSupsiCandidate(normalizedRow) > scoreSupsiCandidate(current)) {
      bestByKey.set(dedupeKey, normalizedRow);
    }
  }

  const seen = new Set();
  const next = [];
  let supsiCount = 0;
  let droppedDuplicates = 0;

  for (const job of repaired) {
    if (!isSupsiJob(job)) {
      next.push(job);
      continue;
    }
    const normalizedRow = normalizeSupsiRow(job);
    const dedupeKey = buildSupsiDedupeKey(normalizedRow);
    if (seen.has(dedupeKey)) {
      droppedDuplicates += 1;
      continue;
    }
    seen.add(dedupeKey);
    const best = bestByKey.get(dedupeKey) || normalizedRow;
    next.push(best);
    supsiCount += 1;
  }

  writeJobsFiles(next);
  return {
    total: next.length,
    supsi: supsiCount,
    deduped: droppedDuplicates,
  };
}

function loadSupsiJobs() {
  if (!fs.existsSync(DATA_JOBS)) return [];
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(raw)) return [];
  return raw.filter(isSupsiJob);
}

async function runDedicatedSupsiCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: [SUPSI_KEY],
    disableWorkdayForce: true,
    forceLocalizationWhenAiEnabledOnly: true,
  });
}

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(SUPSI_KEY, 'SUPSI');
  console.log('🚀 SUPSI dedicated crawler start');
  const beforeSnapshot = snapshotJobSlugs(loadSupsiJobs());

  const { seedUrls, seedMetaByUrl, fromCache = false } = await fetchSupsiJobDetailUrls();
  updateSupsiAdapter({ seedUrls, seedMetaByUrl, fromCache });

  await runDedicatedSupsiCrawler();
  const post = await postProcessSupsiJobs();
  console.log(`🧹 Post-process SUPSI: ${post.supsi} active, ${post.deduped} duplicate(s) removed.`);

  // Safety net: fill any locale descriptions still missing after enrichment + post-processing
  const safetyFilled = await fillMissingLocaleDescriptions();
  if (safetyFilled > 0) {
    console.log(`🔄 Translation safety net: filled ${safetyFilled} missing locale description(s) via DeepL/Google Translate.`);
  }

  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_SUPSI_STRICT',
    label: 'SUPSI',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isSupsiJob,
    detectSourceLang: (text) => detectLang(text, 'it'),
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedSupsiDomain,
    untrustedDomainReason: 'untrusted_supsi_domain',
    failOnMissingJobsFile: true,
    failWhenNoJobs: false,
    noJobsMessage: 'No SUPSI jobs found after crawl — university may have no openings.',
    // SUPSI serves identical Italian content under all locale URLs (no real translations).
    // Translations use the fallback chain: DeepL → MyMemory → Lingva → Google Translate.
    maxToleratedMissingDescriptions: 0,
  });

  const afterSnapshot = snapshotJobSlugs(loadSupsiJobs());
  const diff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(diff, 'SUPSI');
  writeCrawlChangeSummaryToGH(diff, 'SUPSI');

  console.log('✅ SUPSI dedicated crawler completed');

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isSupsiJob) : [];
  writeJobsCrawlerSlice(SUPSI_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: SUPSI_KEY,
    label: 'SUPSI',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: diff.newJobs.length,
    updatedCount: diff.updatedJobs.length,
    removedCount: diff.removedJobs.length,
    unchangedCount: diff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: diff.newJobs.slice(0, 30),
    updatedJobs: diff.updatedJobs.slice(0, 30),
    removedJobs: diff.removedJobs.slice(0, 30),
    unchangedJobs: (diff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

// Only run the crawler pipeline when invoked directly from the CLI
// (not when imported by tests or other modules that want helper exports).
const _isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (_isMain) {
  main().catch((err) => {
    console.error(`❌ SUPSI crawler failed: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
}
