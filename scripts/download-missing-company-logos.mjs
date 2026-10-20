#!/usr/bin/env node
/**
 * download-missing-company-logos.mjs
 *
 * Mirrors verified icons for the companies reported by the canonical logo
 * audit. Acquisition may use Google's favicon proxy, but only with a domain
 * identified as the employer's official domain; the runtime never references
 * Google. A grey-globe response, an HTML page, and an HTTP error are all
 * rejected.
 *
 * `--from-audit` is the only mode used by the weekly workflow and accepts
 * only explicit DOMAIN_OVERRIDES domains; it never guesses from a company
 * key or job metadata. Legacy mode (known-company-slugs.json + latest history)
 * remains available for manual recovery and retains historical guesses, but
 * the workflow must never invoke it:
 *
 *   node scripts/download-missing-company-logos.mjs --from-audit
 *   node scripts/download-missing-company-logos.mjs --from-audit --dry-run
 *   node scripts/download-missing-company-logos.mjs --from-audit --force
 *   node scripts/download-missing-company-logos.mjs
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  fetchVerifiedLogo,
  MAX_LOGO_BODY_BYTES,
} from './lib/company-logo-audit.mjs';
import { readBoundedResponseBytes } from './lib/bounded-response-body.mjs';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import {
  domainCandidates,
  isAtsDomain,
  normalizeDomain,
  selectAuditCandidates,
} from './lib/company-logo-acquisition.mjs';

const ROOT = path.resolve(process.cwd());
const MANIFEST_PATH = path.join(ROOT, 'data', 'company-logos-manifest.json');
const KNOWN_SLUGS_PATH = path.join(ROOT, 'data', 'known-company-slugs.json');
const HISTORY_DIR = path.join(ROOT, 'data', 'jobs-snapshots-history');
const OUT_DIR = path.join(ROOT, 'public', 'images', 'brands');
const DEFAULT_AUDIT_REPORT = path.join(ROOT, 'data', 'company-logos-missing.json');
const DEFAULT_JOBS_FILES = [
  path.join(ROOT, 'data', 'jobs.json'),
  path.join(ROOT, 'public', 'data', 'jobs.json'),
];

const FETCH_TIMEOUT_MS = 10_000;
const CONCURRENCY = 6;

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractJobs(value, sourcePath) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.jobs)) return value.jobs;
  throw new Error(`Expected an array or { jobs: [] } in ${sourcePath}`);
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (fallback !== null && (error.code === 'ENOENT' || error instanceof SyntaxError)) return fallback;
    throw error;
  }
}

function jobKey(job) {
  return String(job?.companyKey || '').trim() || slugify(job?.company || job?.employer || '');
}

function metadataFromJobs(jobs) {
  const metadata = new Map();
  for (const job of jobs) {
    const key = jobKey(job);
    if (!key) continue;
    const current = metadata.get(key) || {
      names: new Set(),
      companyDomains: new Set(),
      urlHosts: new Set(),
      sourceUrls: new Set(),
    };
    const name = String(job.company || job.employer || '').trim();
    if (name) current.names.add(name);
    const companyDomain = normalizeDomain(job.companyDomain);
    if (companyDomain) current.companyDomains.add(companyDomain);
    try {
      const sourceUrl = String(job.url || '').trim();
      const host = normalizeDomain(new URL(sourceUrl).hostname);
      if (host) current.urlHosts.add(host);
      if (sourceUrl && host && !isAtsDomain(host)) current.sourceUrls.add(sourceUrl);
    } catch { /* a malformed job URL is irrelevant to logo source selection */ }
    metadata.set(key, current);
  }
  return metadata;
}

async function loadAuditTargets(reportPath, jobsPath) {
  if (!existsSync(reportPath)) {
    throw new Error(`Audit report not found: ${reportPath}. Run the canonical logo audit first.`);
  }
  const report = await readJson(reportPath);
  const entries = report.affectedCompanies || report.companies || [];
  if (!Array.isArray(entries)) throw new Error(`Audit report has no company list: ${reportPath}`);

  let jobs = [];
  if (jobsPath && existsSync(jobsPath)) {
    jobs = extractJobs(await readJson(jobsPath), jobsPath);
  } else {
    const candidate = DEFAULT_JOBS_FILES.find((file) => existsSync(file));
    if (candidate) jobs = extractJobs(await readJson(candidate), candidate);
    else console.warn('[download-missing] Canonical jobs file not found; using report names and manual domains only.');
  }
  const metadata = metadataFromJobs(jobs);
  const targets = [];
  const seen = new Set();
  for (const entry of selectAuditCandidates(entries)) {
    const key = String(entry?.companyKey || '').trim();
    if (!key || seen.has(key)) continue;
    // The report is refreshed from changing crawler data. If a stale report
    // still contains a company with no current job, do not guess a logo for a
    // name that has already left the canonical population.
    if (jobs.length > 0 && !metadata.has(key)) continue;
    seen.add(key);
    const current = metadata.get(key) || {
      names: new Set(),
      companyDomains: new Set(),
      urlHosts: new Set(),
      sourceUrls: new Set(),
    };
    if (entry.companyName) current.names.add(String(entry.companyName));
    targets.push({
      key,
      name: [...current.names][0] || entry.companyName || key,
      metadata: current,
      manifestAliases: [key],
      status: entry.status || 'missing',
      qualityDeficient: entry.status === 'low-quality'
        || Number(entry.lowQualityJobCount || 0) > 0,
    });
  }
  return targets;
}

async function loadLegacyTargets() {
  const companySlugs = await readJson(KNOWN_SLUGS_PATH);
  const metadata = new Map();
  const urlToKey = new Map();
  if (existsSync(HISTORY_DIR)) {
    const files = (await readdir(HISTORY_DIR)).filter((file) => file.endsWith('.json')).sort().reverse();
    if (files.length > 0) {
      const snapshot = await readJson(path.join(HISTORY_DIR, files[0]), { jobs: [] });
      const snapshotJobs = snapshot.jobs || [];
      const snapshotMetadata = metadataFromJobs(snapshotJobs);
      for (const [key, value] of snapshotMetadata) metadata.set(key, value);
      for (const job of snapshotJobs) {
        const key = jobKey(job);
        const urlSlug = slugify(job?.company || job?.employer || '');
        if (key && urlSlug && !urlToKey.has(urlSlug)) urlToKey.set(urlSlug, key);
      }
    }
  }

  const targets = [];
  const seen = new Set();
  for (const urlSlug of companySlugs) {
    const slug = String(urlSlug || '').trim();
    const key = urlToKey.get(slug) || slug;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const current = metadata.get(key) || {
      names: new Set(),
      companyDomains: new Set(),
      urlHosts: new Set(),
      sourceUrls: new Set(),
    };
    targets.push({
      key,
      name: [...current.names][0] || key,
      metadata: current,
      manifestAliases: [key, slug],
      status: 'missing',
      qualityDeficient: false,
    });
  }
  return targets;
}

async function readImageUrl(url, source, sourceDomain, accept = 'image/*,*/*;q=0.8') {
  const response = await fetchVerifiedLogo(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    accept,
  });
  if (response.status !== 'valid') {
    return {
      accepted: false,
      reason: response.reason || 'logo-non-validato',
      source,
      sourceDomain,
      url,
    };
  }
  if (!response.body || response.body.length > MAX_LOGO_BODY_BYTES) {
    return { accepted: false, reason: 'body-too-large', source, sourceDomain, url };
  }
  if (response.qualityStatus !== 'good') {
    return {
      accepted: false,
      reason: response.qualityStatus === 'unverified' ? 'quality-unverified' : 'quality-insufficient',
      source,
      sourceDomain,
      url: response.url || url,
      format: response.extension,
      width: response.width,
      height: response.height,
    };
  }
  return {
    accepted: true,
    buf: response.body,
    ext: response.extension,
    size: response.bytes,
    contentType: response.contentType,
    format: response.extension,
    width: response.width,
    height: response.height,
    qualityStatus: response.qualityStatus,
    qualityReason: response.qualityReason,
    source,
    sourceDomain,
    url: response.url || source,
  };
}

async function tryDirectFavicon(domain) {
  const urls = [`https://${domain}/favicon.ico`];
  if (!domain.startsWith('www.')) urls.push(`https://www.${domain}/favicon.ico`);
  let lastFailure = {
    accepted: false,
    reason: 'official-favicon-unavailable',
    source: 'official-favicon',
    sourceDomain: domain,
  };
  for (const url of urls) {
    try {
      const result = await readImageUrl(url, 'official-favicon', domain);
      if (result.accepted) return result;
      lastFailure = result;
    } catch { /* try the next official URL */ }
  }
  return lastFailure;
}

function extractIconLinks(html, baseUrl, { allowGenericFavicon = false } = {}) {
  const links = [];
  const seen = new Set();
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (!/(?:^|\s)(?:icon|shortcut|apple-touch-icon)(?:\s|$)/i.test(rel)) continue;
    if (!/apple-touch-icon/i.test(rel) && !allowGenericFavicon) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      const absolute = new URL(href, baseUrl).href;
      if (!/^https?:$/i.test(new URL(absolute).protocol) || seen.has(absolute)) continue;
      seen.add(absolute);
      links.push(absolute);
    } catch { /* ignore malformed markup */ }
  }
  return links.slice(0, 8);
}

export function extractOfficialLogoImages(html, baseUrl, domain) {
  const links = [];
  const seen = new Set();
  const officialHost = (value) => {
    const host = normalizeDomain(value);
    return host === domain || host.endsWith(`.${domain}`);
  };
  const addOfficial = (src) => {
    try {
      const absolute = new URL(src.replaceAll('\\/', '/').replaceAll('&amp;', '&'), baseUrl).href;
      if (!/^https?:$/i.test(new URL(absolute).protocol)
        || !officialHost(absolute)
        || seen.has(absolute)) return;
      seen.add(absolute);
      links.push(absolute);
    } catch { /* ignore malformed markup */ }
  };
  const addDeclaredLogo = (src) => {
    try {
      const absolute = new URL(src.replaceAll('\\/', '/').replaceAll('&amp;', '&'), baseUrl).href;
      if (!/^https?:$/i.test(new URL(absolute).protocol) || seen.has(absolute)) return;
      seen.add(absolute);
      links.push(absolute);
    } catch { /* ignore malformed markup */ }
  };
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    const marker = tag;
    if (!/(?:logo|brand|wordmark|logotype)/i.test(marker)) continue;
    const src = tag.match(/\b(?:src|data-src)\s*=\s*["']([^"']+)["']/i)?.[1]
      || tag.match(/\bsrcset\s*=\s*["']([^"']+)["']/i)?.[1]?.split(/\s+/)[0];
    if (!src) continue;
    addOfficial(src);
  }
  // WordPress/Yoast JSON-LD often carries the real logo while the favicon is
  // only 32px. A structured declaration is authoritative even when the
  // employer stores the asset on its official media/CDN host.
  const structuredHtml = html.replaceAll('\\"', '"');
  for (const match of structuredHtml.matchAll(/"logo"\s*:\s*"([^"]+)"/gi)) {
    addDeclaredLogo(match[1]);
  }
  for (const block of structuredHtml.matchAll(/"logo"\s*:\s*\{([\s\S]{0,1200}?)\}/gi)) {
    for (const match of block[1].matchAll(/"(?:url|contentUrl)"\s*:\s*"([^"]+)"/gi)) {
      addDeclaredLogo(match[1]);
    }
  }
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const property = tag.match(/\bproperty\s*=\s*["']([^"']+)["']/i)?.[1]
      || tag.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1]
      || '';
    if (property.toLowerCase() !== 'og:logo') continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1];
    if (content) addDeclaredLogo(content);
  }
  return links.slice(0, 8);
}

async function tryHtmlIcon(
  domain,
  pageUrl = `https://${domain}/`,
  source = 'official-html-icon',
  { allowGenericFavicon = false } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let lastFailure = {
    accepted: false,
    reason: 'official-page-no-icon',
    source,
    sourceDomain: domain,
    url: pageUrl,
  };
  try {
    const response = await fetch(pageUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereTicinoLogoBot/1.0)',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ...lastFailure,
        reason: `http-${response.status}`,
      };
    }
    // The cap is applied while the page streams: `response.text()` and a
    // length check afterwards would download a chunked page in full (#9729).
    const bytes = await readBoundedResponseBytes(response, MAX_LOGO_BODY_BYTES);
    if (bytes === null) return { ...lastFailure, reason: 'body-too-large' };
    const html = new TextDecoder().decode(bytes);
    const baseUrl = response.url || pageUrl;
    const iconUrls = [
      ...extractIconLinks(html, baseUrl, { allowGenericFavicon }),
      ...extractOfficialLogoImages(html, baseUrl, domain),
    ];
    for (const url of iconUrls) {
      try {
        const result = await readImageUrl(url, source, domain);
        if (result.accepted) return result;
        lastFailure = result;
      } catch { /* try the next declared icon */ }
    }
  } catch (error) {
    lastFailure = {
      ...lastFailure,
      reason: error?.name === 'AbortError' ? 'timeout' : 'source-unreachable',
    };
  }
  finally {
    clearTimeout(timer);
  }
  return lastFailure;
}

async function tryGoogleFavicon(domain) {
  const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
  try {
    return await readImageUrl(url, 'google-favicon-proxy', domain);
  } catch (error) {
    return {
      accepted: false,
      reason: error?.name === 'AbortError' ? 'timeout' : 'source-unreachable',
      source: 'google-favicon-proxy',
      sourceDomain: domain,
      url,
    };
  }
}

export async function downloadForKey(key, metadata, options = {}) {
  const domains = domainCandidates(key, metadata, options);
  const strictAudit = options.fromAudit === true;
  let lastFailure = {
    accepted: false,
    reason: domains.length > 0 ? 'no-verified-official-icon' : 'no-official-domain',
    source: null,
    sourceDomain: domains[0] || null,
  };
  for (const domain of domains) {
    if (!strictAudit) {
      const google = await tryGoogleFavicon(domain);
      if (google.accepted) return google;
      lastFailure = google;
    }
    for (const sourceUrl of metadata?.sourceUrls || []) {
      let sourceHost;
      try {
        sourceHost = normalizeDomain(new URL(sourceUrl).hostname);
      } catch {
        continue;
      }
      if (sourceHost !== domain && !sourceHost.endsWith(`.${domain}`)) continue;
      const careerPage = await tryHtmlIcon(domain, sourceUrl, 'official-career-page-icon', {
        allowGenericFavicon: !strictAudit,
      });
      if (careerPage.accepted) return careerPage;
      lastFailure = careerPage;
    }
    const homepageUrls = [`https://${domain}/`];
    if (!domain.startsWith('www.')) homepageUrls.push(`https://www.${domain}/`);
    for (const homepageUrl of homepageUrls) {
      const declared = await tryHtmlIcon(domain, homepageUrl, 'official-html-icon', {
        allowGenericFavicon: !strictAudit,
      });
      if (declared.accepted) return declared;
      lastFailure = declared;
    }
    if (!strictAudit) {
      const direct = await tryDirectFavicon(domain);
      if (direct.accepted) return direct;
      lastFailure = direct;
    }
  }
  return lastFailure;
}

export function shouldAcquireTarget({ manifestAliases = [], qualityDeficient = false } = {}, manifest = {}, force = false) {
  return force || qualityDeficient || !manifestAliases.some((alias) => manifest[alias]);
}

async function runConcurrent(items, worker, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

async function removeStaleVariants(safeKey, keepFilename) {
  for (const filename of await readdir(OUT_DIR)) {
    if (!filename.startsWith(`${safeKey}.`) || filename === keepFilename) continue;
    await unlink(path.join(OUT_DIR, filename)).catch(() => {});
  }
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    force: false,
    fromAudit: false,
    reportPath: process.env.COMPANY_LOGO_AUDIT_REPORT
      ? path.resolve(ROOT, process.env.COMPANY_LOGO_AUDIT_REPORT)
      : DEFAULT_AUDIT_REPORT,
    jobsPath: process.env.COMPANY_LOGO_AUDIT_JOBS_FILE
      ? path.resolve(ROOT, process.env.COMPANY_LOGO_AUDIT_JOBS_FILE)
      : null,
    resultFile: process.env.COMPANY_LOGO_ACQUISITION_RESULT
      ? path.resolve(ROOT, process.env.COMPANY_LOGO_ACQUISITION_RESULT)
      : null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') options.dryRun = true;
    else if (argv[i] === '--force') options.force = true;
    else if (argv[i] === '--from-audit') options.fromAudit = true;
    else if (argv[i] === '--report' && argv[i + 1]) options.reportPath = path.resolve(ROOT, argv[++i]);
    else if (argv[i] === '--jobs-file' && argv[i + 1]) options.jobsPath = path.resolve(ROOT, argv[++i]);
    else if (argv[i] === '--result-file' && argv[i + 1]) options.resultFile = path.resolve(ROOT, argv[++i]);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [manifestRaw, targets] = await Promise.all([
    readFile(MANIFEST_PATH, 'utf8').catch(() => '{}'),
    options.fromAudit
      ? loadAuditTargets(options.reportPath, options.jobsPath)
      : loadLegacyTargets(),
  ]);
  const manifest = JSON.parse(manifestRaw);
  const toDownload = targets.filter((target) => shouldAcquireTarget(target, manifest, options.force));

  console.log(`[download-missing] Mode: ${options.fromAudit ? 'canonical audit' : 'legacy known slugs'}`);
  console.log(`[download-missing] Targets: ${targets.length}`);
  console.log(`[download-missing] Already in manifest: ${targets.length - toDownload.length}`);
  console.log(`[download-missing] To download: ${toDownload.length}${options.dryRun ? ' (DRY RUN)' : ''}`);

  if (options.dryRun) {
    for (const { key, name, metadata, status } of toDownload) {
      console.log(`  ${key} [${status}] ("${name}") → ${domainCandidates(key, metadata, { fromAudit: options.fromAudit }).join(', ')}`);
    }
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  if (options.force && options.fromAudit) {
    // A forced audit refresh may be correcting an old guessed-domain result.
    // Remove that target's previous local candidate before the new official
    // source is tried, so a failed refresh cannot leave an unverified logo in
    // the manifest or as a stale variant on disk.
    for (const { key, manifestAliases = [key] } of toDownload) {
      for (const alias of manifestAliases) delete manifest[alias];
      await removeStaleVariants(slugify(key) || key, '');
    }
  }
  let downloaded = 0;
  let failed = 0;
  let qualityRejected = 0;
  const results = await runConcurrent(toDownload, async ({ key, name, metadata, status }) => {
    const result = await downloadForKey(key, metadata, { fromAudit: options.fromAudit });
    if (!result.accepted) {
      failed += 1;
      if (result.reason === 'quality-insufficient' || result.reason === 'quality-unverified') qualityRejected += 1;
      process.stdout.write(`  ✗ ${key} [${status}] — ${result.reason}\n`);
      return {
        companyKey: key,
        name,
        status: 'failed',
        reason: result.reason,
        source: result.source || null,
        sourceDomain: result.sourceDomain || null,
        url: result.url || null,
      };
    }
    const safeKey = slugify(key) || key;
    const filename = `${safeKey}.${result.ext}`;
    await writeFile(path.join(OUT_DIR, filename), result.buf);
    await removeStaleVariants(safeKey, filename);
    const publicPath = `/images/brands/${filename}`;
    manifest[key] = publicPath;
    downloaded += 1;
    process.stdout.write(`  ✓ ${key} (${result.sourceDomain}, ${result.source}, ${result.size}B, ${result.width || '?'}x${result.height || '?'})\n`);
    return {
      companyKey: key,
      name,
      status: 'downloaded',
      source: result.source,
      sourceDomain: result.sourceDomain,
      path: publicPath,
      format: result.format,
      size: result.size,
      width: result.width,
      height: result.height,
      qualityStatus: result.qualityStatus,
      qualityReason: result.qualityReason,
      url: result.url,
    };
  }, CONCURRENCY);

  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(MANIFEST_PATH, `${JSON.stringify(sorted, null, 2)}\n`);

  if (options.resultFile) {
    await mkdir(path.dirname(options.resultFile), { recursive: true });
    await writeFile(options.resultFile, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      reportPath: path.relative(ROOT, options.reportPath),
      targets: results,
      acquired: downloaded,
      failed,
      qualityRejected,
    }, null, 2)}\n`);
    console.log(`[download-missing] Acquisition result: ${options.resultFile}`);
  }

  console.log(`\n[download-missing] Done. downloaded=${downloaded} failed=${failed}`);
  console.log(`[download-missing] Manifest: ${MANIFEST_PATH}`);
  if (failed > 0) {
    console.log('\nNo verified logo found:');
    for (const result of results.filter((item) => item.status === 'failed')) {
      console.log(`  ✗ ${result.companyKey} ("${result.name}") — ${result.reason}`);
    }
    if (options.fromAudit) process.exitCode = 1;
  }
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error('[download-missing-company-logos] Fatal:', error);
    process.exit(1);
  });
}
