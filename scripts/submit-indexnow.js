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

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CORE_SITEMAPS } from './lib/sitemap-files.mjs';
import {
  changedUrls,
  crawlSitemaps,
  snapshotFromCrawl,
  snapshotUrls,
} from './lib/sitemap-crawl.mjs';
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
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(parsed) || (parsed && typeof parsed === 'object' && parsed.perSitemap)) return parsed;
  } catch {
    // A malformed/partial artifact is treated as an absent baseline below.
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

function changedOrAllUrls(current, previous) {
  if (!previous) {
    return [...snapshotUrls(current)].sort();
  }
  // Reconcile removals within a sitemap that this build actually owns, but do
  // not treat an edge-owned sitemap absent from dist/ as deleted. The live
  // daily graph is authoritative for those external surfaces.
  return changedUrls(current, previous, {
    includeRemoved: true,
    includeRemovedFromMissingSitemaps: false,
  });
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

async function submitToIndexNow() {
  const current = await currentSnapshot();
  const previous = parseSnapshotFile(PRE_DEPLOY_SNAPSHOT);
  const urls = new Set(changedOrAllUrls(current, previous));
  const alternateCount = publicRegistryAlternates(urls);
  if (alternateCount > 0) console.log(`🌍 ${alternateCount} hreflang alternate aggiunti dal registry public/`);

  const currentCount = snapshotUrls(current).size;
  console.log(`📊 ${currentCount} URLs nel grafo sitemap; ${urls.size} URLs cambiati da inviare`);
  if (previous) {
    console.log(`📸 Baseline pre-deploy presente: ${PRE_DEPLOY_SNAPSHOT}`);
  } else {
    console.log('⚠️ Baseline pre-deploy assente o non valida — invio l’intero snapshot corrente');
  }

  if (urls.size === 0) {
    console.log('✅ Nessun URL cambiato — nessuna submission necessaria');
    return;
  }

  const key = await verifyIndexNowKey({ attempts: 5, delayMs: 1500 });
  if (!key.ok) {
    throw new Error(`IndexNow key verification failed after ${key.attempts} attempts: ${key.reason}`);
  }
  console.log(`✅ Key file verificato: ${KEY_LOCATION}`);

  const summary = await submitIndexNowUrlsStreaming([...urls], {
    endpoints: INDEXNOW_ENDPOINTS,
    batchSize: BATCH_SIZE,
    delayMs: 500,
  });
  const failed = summary.results.filter((result) => !result.ok);
  console.log(`📨 IndexNow: ${summary.submitted} URL in ${summary.batches} batch`);
  if (failed.length > 0) {
    const details = failed.slice(0, 3).map((result) => `${result.engine || 'endpoint'}:${result.status || result.error || 'failed'}`).join(', ');
    throw new Error(`${failed.length} IndexNow batch(es) were not accepted (${details})`);
  }
  await submitToBingContentApi();
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
})();

if (invokedDirectly) {
  submitToIndexNow().catch((error) => {
    console.error(`❌ IndexNow submission failed: ${error.message}`);
    process.exitCode = 1;
  });
}
