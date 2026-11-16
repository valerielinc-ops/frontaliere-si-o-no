#!/usr/bin/env node
/**
 * Submit URLs changed by a verified deploy to IndexNow.
 *
 * The sitemap graph is the source of truth. We crawl every sitemap reachable
 * from sitemap.xml, robots.txt, sitemap-news.xml and sitemap-cantons.xml. The
 * deploy snapshot carries per-sitemap digests and lastmod values, so this path
 * submits additions, removals and existing URLs whose XML/content changed.
 *
 * The batch endpoints are centralized in lib/indexnow-submit.mjs:
 * api.indexnow.org/indexnow, www.bing.com/indexnow and yandex.com/indexnow.
 * The sitemap parser consumes `<loc>` plus `<xhtml:link hreflang>` entries.
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CORE_SITEMAPS } from './lib/sitemap-files.mjs';
import {
  changedUrlTiers,
  crawlSitemaps,
  readSitemapSnapshot,
  snapshotFromCrawl,
  snapshotUrls,
} from './lib/sitemap-crawl.mjs';
import { isExpiredJobSitemapKey } from './lib/sitemap-family-coverage.mjs';
import {
  HOST,
  INDEXNOW_ENDPOINTS,
  INDEXNOW_KEY,
  KEY_LOCATION,
  submitIndexNowUrlsStreaming,
  verifyIndexNowKey,
} from './lib/indexnow-submit.mjs';

// Kept as a compatibility export for the fast-publish and SEO coverage tests.
// Runtime discovery is recursive and is not limited to this list.
// The legacy registry still covers sitemap-pages.xml and the other core files;
// the graph crawler below is what makes generated families discoverable too.
export const INDEXNOW_SITEMAPS = [...CORE_SITEMAPS, 'sitemap-farmacie.xml'];

const BATCH_SIZE = 500;
const PRE_DEPLOY_SNAPSHOT = '/tmp/pre-deploy-sitemap-urls.json';
const CURRENT_SNAPSHOT_FILES = [
  '/tmp/sitemaps-bundle/new-sitemap-urls.json',
  '/tmp/new-sitemap-urls.json',
];
const DEFAULT_INDEXNOW_BUDGET_MS = 780_000;

function toBase64Utf8(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64');
}

/** Backward-compatible helper used by source-level SEO tests and callers. */
export function extractUrls(xml, urls) {
  let count = 0;
  for (const match of String(xml || '').matchAll(/<loc\b[^>]*>([^<]+)<\/loc>/gi)) {
    urls.add(match[1].trim().replace(/&amp;/g, '&'));
    count += 1;
  }
  for (const match of String(xml || '').matchAll(/hreflang="[^"]*"\s+href="([^"]+)"/gi)) {
    urls.add(match[1].trim().replace(/&amp;/g, '&'));
    count += 1;
  }
  return count;
}

function projectRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function parseSnapshotFile(file) {
  if (!existsSync(file)) return null;
  try {
    const parsed = readSitemapSnapshot(file);
    if (Array.isArray(parsed) || (parsed && typeof parsed === 'object' && parsed.perSitemap)) return parsed;
  } catch (error) {
    // A malformed/partial artifact is treated as an absent baseline below.
    console.warn(`⚠️ Snapshot ${file} ignored: ${error.message}`);
  }
  return null;
}

function publicRegistryAlternates(urls) {
  const publicDir = resolve(projectRoot(), 'public');
  if (!existsSync(publicDir)) return 0;
  const targets = new Set(urls);
  let added = 0;
  const files = readdirSync(publicDir).filter((file) => /^sitemap(?:-[^/]+)?\.xml$/i.test(file));
  for (const file of files) {
    let xml;
    try {
      xml = readFileSync(resolve(publicDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const blockMatch of xml.matchAll(/<url\b[^>]*>[\s\S]*?<\/url>/gi)) {
      const block = blockMatch[0];
      const blockUrls = [...block.matchAll(/(?:<loc\b[^>]*>|href=")([^<"]+)(?:<\/loc>|")/gi)]
        .map((match) => match[1].trim().replace(/&amp;/g, '&'));
      if (!blockUrls.some((url) => targets.has(url))) continue;
      for (const url of blockUrls) {
        if (!urls.has(url)) {
          urls.add(url);
          added += 1;
        }
      }
    }
  }
  return added;
}

async function currentSnapshot() {
  for (const file of CURRENT_SNAPSHOT_FILES) {
    const snapshot = parseSnapshotFile(file);
    if (snapshot) {
      console.log(`📦 Using build sitemap snapshot: ${file}`);
      return snapshot;
    }
  }

  const root = projectRoot();
  const sitemapDir = existsSync(resolve(root, 'dist', 'sitemap.xml'))
    ? resolve(root, 'dist')
    : resolve(root, 'public');
  const crawl = await crawlSitemaps({
    host: HOST,
    baseUrl: `https://${HOST}`,
    source: 'local',
    rootDir: sitemapDir,
    strict: false,
  });
  console.log(`📂 Crawled local sitemap graph from ${sitemapDir}`);
  return snapshotFromCrawl(crawl);
}

async function submitToBingContentApi() {
  const apiKey = process.env.BING_API_KEY;
  if (!apiKey) {
    console.log('ℹ️ BING_API_KEY non configurata — skip Bing Content Submission API');
    return;
  }
  const root = projectRoot();
  let llmsContent;
  try {
    llmsContent = readFileSync(resolve(root, 'public', 'llms-full.txt'), 'utf8');
  } catch {
    console.warn('⚠️ llms-full.txt non trovato — skip Bing Content Submission');
    return;
  }
  const endpoint = `https://ssl.bing.com/webmaster/api.svc/json/SubmitContent?apikey=${encodeURIComponent(apiKey)}`;
  const siteUrl = `https://${HOST}`;
  const submitDocument = async (name, content) => {
    const body = content.slice(0, 100_000);
    const httpMessage = `HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        siteUrl,
        url: `${siteUrl}/${name}`,
        httpMessage: toBase64Utf8(httpMessage),
        structuredData: '',
        dynamicServing: 0,
      }),
    });
    if (response.ok || response.status === 200 || response.status === 202) {
      console.log(`✅ Bing Content Submission API: ${name} inviato`);
    } else {
      console.warn(`⚠️ Bing Content API (${name}): ${response.status}`);
    }
  };
  try {
    await submitDocument('llms-full.txt', llmsContent);
    try {
      await submitDocument('llms.txt', readFileSync(resolve(root, 'public', 'llms.txt'), 'utf8'));
    } catch {
      // The short document is optional.
    }
  } catch (error) {
    console.warn(`⚠️ Bing Content API errore: ${error.message}`);
  }
}

function digestUrlsByPriority(digestBySitemap) {
  return [...new Set(Object.keys(digestBySitemap).sort().flatMap((key) => digestBySitemap[key]))].sort();
}

function appendIndexNowStepSummary(summary) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const rows = [
    ['Grafo', summary.graph],
    ['Added', summary.added],
    ['Removed', summary.removed],
    ['Moved into archive', summary.movedIntoArchive],
    ['Moved out of archive', summary.movedOutOfArchive],
    ['Lastmod', summary.lastmod],
    ['Digest', summary.digest],
    ['Digest archivio ignorato', `${summary.suppressedArchiveDigest.sitemaps} sitemap, ${summary.suppressedArchiveDigest.urls} URL`],
    ['Accepted', summary.accepted],
    ['Remaining', summary.remaining],
    ['Elapsed ms', summary.elapsedMs],
    ['Stopped by deadline', summary.stoppedByDeadline],
  ];
  appendFileSync(file, `\n### IndexNow\n\n| Metrica | Valore |\n| --- | ---: |\n${rows.map(([name, value]) => `| ${name} | ${value} |`).join('\n')}\n`);
}

function logIndexNowSummary(summary) {
  console.log(`📨 IndexNow: accepted ${summary.accepted} di ${summary.accepted + summary.remaining}; residuo ${summary.remaining}`);
  console.log(`[indexnow-summary] ${JSON.stringify(summary)}`);
  appendIndexNowStepSummary(summary);
}

export async function submitToIndexNow(overrides = {}) {
  const startedAt = Date.now();
  const budgetValue = process.env.INDEXNOW_BUDGET_MS;
  const budgetMs = budgetValue === undefined ? DEFAULT_INDEXNOW_BUDGET_MS : Number(budgetValue);
  if (!Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new Error('INDEXNOW_BUDGET_MS must be a non-negative finite number');
  }
  const deadlineMs = startedAt + budgetMs;
  const hasCurrentOverride = Object.prototype.hasOwnProperty.call(overrides, 'current');
  const hasPreviousOverride = Object.prototype.hasOwnProperty.call(overrides, 'previous');
  const current = hasCurrentOverride ? overrides.current : await currentSnapshot();
  const previous = hasPreviousOverride ? overrides.previous : parseSnapshotFile(PRE_DEPLOY_SNAPSHOT);
  const tiers = changedUrlTiers(current, previous, {
    includeRemoved: true,
    includeRemovedFromMissingSitemaps: false,
    digestIgnoredSitemap: isExpiredJobSitemapKey,
  });
  const graph = snapshotUrls(current).size;
  const digestUrls = digestUrlsByPriority(tiers.digestBySitemap);
  const urls = new Set([
    ...tiers.added,
    ...tiers.removed,
    ...tiers.movedIntoArchive,
    ...tiers.movedOutOfArchive,
    ...tiers.lastmod,
    ...digestUrls,
  ]);
  const classifiedUrls = new Set(urls);
  const alternateCount = publicRegistryAlternates(urls);
  const alternateUrls = [...urls].filter((url) => !classifiedUrls.has(url)).sort();
  if (alternateCount > 0) console.log(`🌍 ${alternateCount} hreflang alternate aggiunti dal registry public/`);

  const sendTiers = [
    ['added', tiers.added],
    ['removed', tiers.removed],
    ['moved into archive', tiers.movedIntoArchive],
    ['moved out of archive', tiers.movedOutOfArchive],
    ['lastmod', tiers.lastmod],
    ['digest', digestUrls],
    ['alternate', alternateUrls],
  ];
  const total = urls.size;
  const summary = {
    graph,
    added: tiers.added.length,
    removed: tiers.removed.length,
    movedIntoArchive: tiers.movedIntoArchive.length,
    movedOutOfArchive: tiers.movedOutOfArchive.length,
    lastmod: tiers.lastmod.length,
    digest: digestUrls.length,
    suppressedArchiveDigest: tiers.suppressedDigest,
    accepted: 0,
    remaining: total,
    elapsedMs: 0,
    stoppedByDeadline: false,
  };

  console.log(`📊 ${graph} URL nel grafo; added=${summary.added} removed=${summary.removed} movedIn=${summary.movedIntoArchive} movedOut=${summary.movedOutOfArchive} lastmod=${summary.lastmod} digest=${summary.digest} (digest archivio ignorato: ${tiers.suppressedDigest.sitemaps} sitemap, ${tiers.suppressedDigest.urls} URL)`);
  if (previous) {
    console.log(`📸 Baseline pre-deploy presente: ${PRE_DEPLOY_SNAPSHOT}`);
  } else {
    console.log('⚠️ Baseline pre-deploy assente o non valida — invio l’intero snapshot corrente');
  }

  try {
    if (total === 0) {
      console.log('✅ Nessun URL cambiato — nessuna submission necessaria');
    } else if (Date.now() >= deadlineMs) {
      summary.stoppedByDeadline = true;
      throw new Error('IndexNow budget expired before any URL was attempted');
    } else {
      const key = await verifyIndexNowKey({ attempts: 5, delayMs: 1500 });
      if (!key.ok) {
        throw new Error(`IndexNow key verification failed after ${key.attempts} attempts: ${key.reason}`);
      }
      console.log(`✅ Key file verificato: ${KEY_LOCATION}`);

      let attempted = 0;
      const failed = [];
      for (const [level, levelUrls] of sendTiers) {
        if (levelUrls.length === 0) continue;
        let levelAccepted = 0;
        const result = await submitIndexNowUrlsStreaming(levelUrls, {
          endpoints: INDEXNOW_ENDPOINTS,
          batchSize: BATCH_SIZE,
          delayMs: 500,
          deadlineMs,
          onBatch: ({ index, accepted, acceptedUrls }) => {
            if (accepted) levelAccepted += acceptedUrls.length;
            if (index % 10 === 0) {
              const elapsedSeconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
              console.log(`⏳ IndexNow ${level}: ${levelAccepted}/${levelUrls.length} URL, ${elapsedSeconds}s`);
            }
          },
        });
        attempted += result.attempted;
        summary.accepted += result.accepted;
        failed.push(...result.results.filter((item) => !item.ok));
        if (result.stoppedByDeadline) {
          summary.stoppedByDeadline = true;
          break;
        }
      }
      summary.remaining = total - summary.accepted;
      if (failed.length > 0) {
        const details = failed.slice(0, 3).map((result) => `${result.engine || 'endpoint'}:${result.status || result.error || 'failed'}`).join(', ');
        throw new Error(`${failed.length} IndexNow batch(es) were not accepted (${details})`);
      }
      if (summary.stoppedByDeadline || (attempted < total && Date.now() >= deadlineMs)) {
        summary.stoppedByDeadline = true;
        throw new Error('IndexNow budget expired before all URLs were attempted');
      }
      await submitToBingContentApi();
    }
  } finally {
    summary.elapsedMs = Date.now() - startedAt;
    summary.remaining = total - summary.accepted;
    if (summary.remaining > 0 && Date.now() >= deadlineMs) summary.stoppedByDeadline = true;
    logIndexNowSummary(summary);
  }

  return summary;
}

export async function runSubmitToIndexNow(overrides = {}) {
  try {
    await submitToIndexNow(overrides);
    return 0;
  } catch (error) {
    console.error(`❌ IndexNow submission failed: ${error.message}`);
    return 1;
  }
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
})();

if (invokedDirectly) {
  runSubmitToIndexNow().then((exitCode) => {
    if (exitCode !== 0) process.exitCode = exitCode;
  });
}
