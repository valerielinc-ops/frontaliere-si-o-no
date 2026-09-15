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
 * Legacy mode (known-company-slugs.json + latest history) remains available:
 *
 *   node scripts/download-missing-company-logos.mjs --from-audit
 *   node scripts/download-missing-company-logos.mjs --from-audit --dry-run
 *   node scripts/download-missing-company-logos.mjs --from-audit --force
 *   node scripts/download-missing-company-logos.mjs
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isGreyGlobe, LOGO_BOT_USER_AGENT } from './lib/google-favicon.mjs';

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
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const CONCURRENCY = 6;

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

// These are publishing platforms, not the employer's brand domains. A
// companyDomain on one of them must not be sent to Google as the logo source.
const ATS_HOST_MARKERS = [
  'allibo.com',
  'altamiraweb.com',
  'apps.be.ch',
  'arca24.careers',
  'careers.softgarden.de',
  'softgarden.de',
  'csod.com',
  'concludis.de',
  'dualoo.com',
  'greenhouse.io',
  'icims.com',
  'intervieweb.it',
  'jobcloud.ch',
  'jobs.ch',
  'jobup.ch',
  'jobalino.ch',
  'myworkdayjobs.com',
  'ncoreplat.com',
  'oraclecloud.com',
  'personio.',
  'prospective.ch',
  'refline.ch',
  'reflinejobs.io',
  'recruitee.com',
  'recruitingapp-',
  'salesforce-sites.com',
  'smartrecruiters.com',
  'solique.ch',
  'successfactors.',
  'talent-soft.com',
  'talentics.ai',
  'teamtailor.com',
  'umantis.com',
  'workable.com',
  'zohorecruit.com',
];

// Names with a crawler/ATS key that does not identify the corporate domain.
const DOMAIN_OVERRIDES = {
  'amina-bank': ['amina.ch'],
  'apleona-schweiz-ag': ['apleona.com'],
  'badrutts-palace': ['badruttspalace.com'],
  'cippatrasporti': ['cippatrasporti.ch', 'cippa.ch'],
  'ferrovia-retica': ['rhb.ch'],
  'fisiocare-sagl': ['fisiocare.ch', 'fisiocare.com'],
  'gmo': ['gmo.ch'],
  'gz-dielsdorf': ['gzdielsdorf.ch'],
  'elettra-1938': ['elettra1938.ch', 'elettra.ch'],
  'impresa-pizzarotti': ['pizzarotti.it'],
  'jsafrasarasin': ['jsafrasarasin.ch', 'jsafrasarasin.com'],
  'kanton-aargau': ['ag.ch'],
  'lonza': ['lonza.com'],
  'michaelpage': ['michaelpage.ch', 'michaelpage.com'],
  'matterhorn-gotthard-bahn': ['mgb.ch'],
  'recruitingapp-1154': ['sgkb.ch'],
};

function slugify(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeDomain(value) {
  let raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    raw = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    return '';
  }
  return raw.replace(/^www\./, '').replace(/\.$/, '');
}

function isAtsDomain(domain) {
  const value = normalizeDomain(domain);
  return !value
    || value === 'frontaliereticino.ch'
    || ATS_HOST_MARKERS.some((marker) => value === marker || value.endsWith(`.${marker}`) || value.includes(marker));
}

function addUnique(list, seen, value) {
  const domain = normalizeDomain(value);
  if (!domain || seen.has(domain)) return;
  seen.add(domain);
  list.push(domain);
}

const STRIP_SUFFIXES = [
  '-ag', '-sa', '-spa', '-gmbh', '-ltd', '-inc', '-llc', '-plc', '-nv', '-bv',
  '-co-kg', '-co', '-srl', '-sarl', '-sas', '-sagl',
  '-svizzera', '-suisse', '-schweiz', '-switzerland', '-svizzero',
  '-ticino', '-lugano', '-bellinzona', '-locarno', '-chiasso', '-mendrisio',
  '-italia', '-italy', '-france', '-germany', '-deutschland',
  '-group', '-groups', '-holding', '-international', '-global', '-europe', '-world',
];

function stripSuffixes(slug) {
  let value = slug;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of STRIP_SUFFIXES) {
      if (value.endsWith(suffix) && value.length > suffix.length) {
        value = value.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  return value || slug;
}

function domainCandidates(key, metadata = {}) {
  const candidates = [];
  const seen = new Set();
  const add = (value) => addUnique(candidates, seen, value);

  for (const domain of DOMAIN_OVERRIDES[key] || []) add(domain);
  for (const domain of metadata.companyDomains || []) {
    if (!isAtsDomain(domain)) add(domain);
  }
  for (const domain of metadata.urlHosts || []) {
    if (!isAtsDomain(domain)) add(domain);
  }

  const stripped = stripSuffixes(key);
  const firstWord = key.split('-')[0];
  add(`${key}.ch`);
  add(`${key}.com`);
  if (stripped !== key) {
    add(`${stripped}.ch`);
    add(`${stripped}.com`);
  }
  if (firstWord.length > 1 && firstWord !== key && firstWord !== stripped) {
    add(`${firstWord}.ch`);
    add(`${firstWord}.com`);
  }
  return candidates;
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
    };
    const name = String(job.company || job.employer || '').trim();
    if (name) current.names.add(name);
    const companyDomain = normalizeDomain(job.companyDomain);
    if (companyDomain) current.companyDomains.add(companyDomain);
    try {
      const host = normalizeDomain(new URL(job.url).hostname);
      if (host) current.urlHosts.add(host);
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
  for (const entry of entries) {
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
    };
    if (entry.companyName) current.names.add(String(entry.companyName));
    targets.push({
      key,
      name: [...current.names][0] || entry.companyName || key,
      metadata: current,
      manifestAliases: [key],
      status: entry.status || 'missing',
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
    const current = metadata.get(key) || { names: new Set(), companyDomains: new Set(), urlHosts: new Set() };
    targets.push({
      key,
      name: [...current.names][0] || key,
      metadata: current,
      manifestAliases: [key, slug],
      status: 'missing',
    });
  }
  return targets;
}

function detectExtFromBytes(buf) {
  if (!buf || buf.length < 4) return null;
  const sig = buf.subarray(0, 8);
  if (sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47) return 'png';
  if (sig[0] === 0xff && sig[1] === 0xd8) return 'jpg';
  if (sig[0] === 0x47 && sig[1] === 0x49 && sig[2] === 0x46) return 'gif';
  if (sig[0] === 0x52 && sig[1] === 0x49 && sig[2] === 0x46 && sig[3] === 0x46) return 'webp';
  if (sig[0] === 0x00 && sig[1] === 0x00 && sig[2] === 0x01 && sig[3] === 0x00) return 'ico';
  const head = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg';
  return null;
}

function looksLikeImage(buf) {
  // Do not trust a server that labels an HTML error page as image/x-icon.
  // A valid signature is required for every saved asset.
  return Boolean(detectExtFromBytes(buf));
}

async function fetchTimeout(url, accept = 'image/*,*/*;q=0.8') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': LOGO_BOT_USER_AGENT, Accept: accept },
      redirect: 'follow',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readImageResponse(response, source, sourceDomain) {
  if (!response.ok) return null;
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) return null;
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_BODY_BYTES) return null;
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (isGreyGlobe(buf) || !looksLikeImage(buf)) return null;
  const ext = MIME_EXT[contentType] || detectExtFromBytes(buf) || 'png';
  return { buf, ext, size: buf.length, contentType, source, sourceDomain, url: response.url || source };
}

async function tryDirectFavicon(domain) {
  const urls = [`https://${domain}/favicon.ico`];
  if (!domain.startsWith('www.')) urls.push(`https://www.${domain}/favicon.ico`);
  for (const url of urls) {
    try {
      const result = await readImageResponse(await fetchTimeout(url), 'official-favicon', domain);
      if (result) return result;
    } catch { /* try the next official URL */ }
  }
  return null;
}

function extractIconLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (!/(?:^|\s)(?:icon|shortcut|apple-touch-icon)(?:\s|$)/i.test(rel)) continue;
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

async function tryHtmlIcon(domain) {
  const pageUrl = `https://${domain}/`;
  try {
    const response = await fetchTimeout(pageUrl, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
    if (!response.ok) return null;
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_BODY_BYTES) return null;
    const html = await response.text();
    if (html.length > MAX_BODY_BYTES) return null;
    for (const url of extractIconLinks(html, response.url || pageUrl)) {
      try {
        const result = await readImageResponse(await fetchTimeout(url), 'official-html-icon', domain);
        if (result) return result;
      } catch { /* try the next declared icon */ }
    }
  } catch { /* Google/favicon fallback may still work */ }
  return null;
}

async function tryGoogleFavicon(domain) {
  const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
  try {
    return await readImageResponse(await fetchTimeout(url), 'google-favicon-proxy', domain);
  } catch {
    return null;
  }
}

async function downloadForKey(key, metadata) {
  const domains = domainCandidates(key, metadata);
  for (const domain of domains) {
    const google = await tryGoogleFavicon(domain);
    if (google) return google;
    const declared = await tryHtmlIcon(domain);
    if (declared) return declared;
    const direct = await tryDirectFavicon(domain);
    if (direct) return direct;
  }
  return null;
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
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') options.dryRun = true;
    else if (argv[i] === '--force') options.force = true;
    else if (argv[i] === '--from-audit') options.fromAudit = true;
    else if (argv[i] === '--report' && argv[i + 1]) options.reportPath = path.resolve(ROOT, argv[++i]);
    else if (argv[i] === '--jobs-file' && argv[i + 1]) options.jobsPath = path.resolve(ROOT, argv[++i]);
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
  const toDownload = targets.filter(({ key, manifestAliases = [key] }) => (
    options.force || !manifestAliases.some((alias) => manifest[alias])
  ));

  console.log(`[download-missing] Mode: ${options.fromAudit ? 'canonical audit' : 'legacy known slugs'}`);
  console.log(`[download-missing] Targets: ${targets.length}`);
  console.log(`[download-missing] Already in manifest: ${targets.length - toDownload.length}`);
  console.log(`[download-missing] To download: ${toDownload.length}${options.dryRun ? ' (DRY RUN)' : ''}`);

  if (options.dryRun) {
    for (const { key, name, metadata, status } of toDownload) {
      console.log(`  ${key} [${status}] ("${name}") → ${domainCandidates(key, metadata).join(', ')}`);
    }
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  let downloaded = 0;
  let failed = 0;
  const results = await runConcurrent(toDownload, async ({ key, name, metadata, status }) => {
    const result = await downloadForKey(key, metadata);
    if (!result) {
      failed += 1;
      process.stdout.write(`  ✗ ${key} [${status}] — no verified official icon\n`);
      return { key, name, status: 'failed' };
    }
    const safeKey = slugify(key) || key;
    const filename = `${safeKey}.${result.ext}`;
    await writeFile(path.join(OUT_DIR, filename), result.buf);
    await removeStaleVariants(safeKey, filename);
    const publicPath = `/images/brands/${filename}`;
    manifest[key] = publicPath;
    downloaded += 1;
    process.stdout.write(`  ✓ ${key} (${result.sourceDomain}, ${result.source}, ${result.size}B)\n`);
    return {
      key,
      name,
      status: 'downloaded',
      source: result.source,
      sourceDomain: result.sourceDomain,
      path: publicPath,
    };
  }, CONCURRENCY);

  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(MANIFEST_PATH, `${JSON.stringify(sorted, null, 2)}\n`);

  console.log(`\n[download-missing] Done. downloaded=${downloaded} failed=${failed}`);
  console.log(`[download-missing] Manifest: ${MANIFEST_PATH}`);
  if (failed > 0) {
    console.log('\nNo verified logo found:');
    for (const result of results.filter((item) => item.status === 'failed')) {
      console.log(`  ✗ ${result.key} ("${result.name}")`);
    }
    if (options.fromAudit) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[download-missing-company-logos] Fatal:', error);
  process.exit(1);
});
