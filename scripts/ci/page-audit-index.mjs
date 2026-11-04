#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PAGE_AUDIT_INDEX_VERSION = 1;

function readJsonFiles(directory) {
  if (!directory || !fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function pageFamily(entry) {
  const value = `${entry.section ?? ''}/${entry.path ?? ''}`.toLowerCase();
  if (/articol|article|blog|journal|actualit/.test(value)) return 'articles';
  if (/event|evento|manifestazione/.test(value)) return 'events';
  if (/farmacie|pharmacy|pharmacies|apotheken/.test(value)) return 'pharmacies';
  if (/domande-frequenti|frequently-asked|questions-frequentes|haeufig-gestellte/.test(value)) return 'faq';
  if (/glossar|glossaire/.test(value)) return 'glossary';
  if (/cerca-lavoro|find-jobs|jobs-im|trouver-emploi/.test(value)) return 'jobs';
  if (/calcola-stipendio|calculate-salary|gehalt-berechnen|calculer-salaire/.test(value)) return 'salary';
  return 'static';
}

/**
 * Merge the immutable page index with final shard digests. The publisher's
 * provenance gate validates identity, artifact digests and exact URL sets;
 * this consumer only builds the bounded audit work index from those receipts.
 */
export function loadPublisherPageIndex({ pageManifestDir, sectionManifestDir }) {
  const byUrl = new Map();
  for (const manifest of readJsonFiles(pageManifestDir)) {
    if (manifest?.kind !== 'publisher-page-manifest' || manifest.schemaVersion !== 2 || !Array.isArray(manifest.entries)) {
      throw new Error(`invalid publisher page manifest: ${manifest?.kind ?? 'unknown'}`);
    }
    for (const entry of manifest.entries) {
      const url = String(entry.url ?? '');
      const pagePath = String(entry.path ?? '');
      const sha256 = String(entry.sha256 ?? '').toLowerCase();
      if (!url || !pagePath || !/^[0-9a-f]{64}$/u.test(sha256)) throw new Error(`incomplete page index entry: ${url || pagePath || 'unknown'}`);
      if (byUrl.has(url)) throw new Error(`duplicate URL in page index: ${url}`);
      byUrl.set(url, {
        url,
        path: pagePath,
        sha256,
        locale: String(entry.locale ?? manifest.locale),
        section: entry.section ? String(entry.section) : null,
      });
    }
  }
  if (byUrl.size === 0) throw new Error(`no publisher page entries found in ${pageManifestDir}`);

  const finalDigestByUrl = new Set();
  for (const manifest of readJsonFiles(sectionManifestDir)) {
    if (manifest?.kind !== 'publisher-section-manifest' || manifest.schemaVersion !== 2 || !Array.isArray(manifest.shards)) {
      throw new Error(`invalid publisher section manifest: ${manifest?.kind ?? 'unknown'}`);
    }
    if (!['it', 'en', 'de', 'fr'].includes(manifest.locale)) {
      throw new Error(`invalid locale in publisher section manifest: ${manifest.locale ?? 'unknown'}`);
    }
    for (const shard of manifest.shards) {
      if (shard.locale !== manifest.locale || typeof shard.section !== 'string' || !shard.section) {
        throw new Error(`invalid shard identity in publisher section manifest: ${manifest.locale}/${shard.section ?? 'unknown'}`);
      }
      for (const page of shard.pages ?? []) {
        const indexed = byUrl.get(String(page.url ?? ''));
        if (!indexed) throw new Error(`section page is absent from source page index: ${page.url ?? 'unknown'}`);
        if (finalDigestByUrl.has(indexed.url)) throw new Error(`duplicate section page receipt: ${indexed.url}`);
        if (page.path !== indexed.path || page.locale !== indexed.locale || page.section !== indexed.section) {
          throw new Error(`section page identity differs from source page index: ${page.url}`);
        }
        const finalDigest = String(page.sha256 ?? '').toLowerCase();
        if (!/^[0-9a-f]{64}$/u.test(finalDigest)) throw new Error(`section page digest is invalid: ${page.url}`);
        indexed.sha256 = finalDigest;
        finalDigestByUrl.add(indexed.url);
      }
    }
  }

  return [...byUrl.values()].map((entry) => ({ ...entry, family: pageFamily(entry) }))
    .sort((a, b) => a.url.localeCompare(b.url));
}

function loadReceipt(file, name, validatorVersion) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (receipt?.schemaVersion !== PAGE_AUDIT_INDEX_VERSION || receipt?.name !== name
      || receipt?.validatorVersion !== validatorVersion || !receipt?.buckets) return null;
    return receipt;
  } catch {
    return null;
  }
}

/**
 * Run one bucket per stratum and reuse every other bucket only when both its
 * exact URL/path/page-digest set and the validator version still match.
 * Missing or malformed receipts force a complete indexed scan.
 */
export function executeIncrementalPageAudit({
  name,
  validatorVersion,
  entries,
  receiptFile,
  sampleRate = 0.25,
  sampleSalt = 0,
  forceFull = false,
  scanBucket,
}) {
  if (typeof scanBucket !== 'function') throw new TypeError('scanBucket must be a function');
  const safeRate = Number.isFinite(sampleRate) && sampleRate > 0 && sampleRate <= 1 ? sampleRate : 1;
  const bucketCount = Math.max(1, Math.round(1 / safeRate));
  const activeBucket = ((Math.trunc(Number(sampleSalt) || 0) % bucketCount) + bucketCount) % bucketCount;
  const oldReceipt = loadReceipt(receiptFile, name, validatorVersion);
  const groups = new Map();

  for (const entry of entries) {
    const stratum = `${entry.locale}|${entry.section ?? 'root'}|${entry.family ?? pageFamily(entry)}`;
    const bucket = Number.parseInt(digest(`${stratum}\0${entry.url}`).slice(0, 8), 16) % bucketCount;
    const key = `${stratum}|bucket-${bucket}`;
    if (!groups.has(key)) groups.set(key, { key, stratum, bucket, entries: [] });
    groups.get(key).entries.push(entry);
  }

  const nextBuckets = {};
  const results = [];
  let scannedPages = 0;
  let reusedPages = 0;
  let sampledBucketPages = 0;
  for (const group of [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    group.entries.sort((a, b) => a.url.localeCompare(b.url));
    const contentDigest = digest(group.entries.map((entry) => `${entry.url}\0${entry.path}\0${entry.sha256}`).join('\n'));
    const old = oldReceipt?.buckets?.[group.key];
    const canReuse = !forceFull
      && group.bucket !== activeBucket
      && old?.validatorVersion === validatorVersion
      && old?.contentDigest === contentDigest
      && Object.hasOwn(old, 'result');
    if (canReuse) {
      results.push(old.result);
      reusedPages += group.entries.length;
      nextBuckets[group.key] = old;
      continue;
    }
    const result = scanBucket(group.entries);
    results.push(result);
    scannedPages += group.entries.length;
    if (group.bucket === activeBucket) sampledBucketPages += group.entries.length;
    nextBuckets[group.key] = { validatorVersion, contentDigest, result };
  }

  if (receiptFile) {
    fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
    const temp = `${receiptFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({
      schemaVersion: PAGE_AUDIT_INDEX_VERSION,
      name,
      validatorVersion,
      activeBucket,
      bucketCount,
      updatedAt: new Date().toISOString(),
      buckets: nextBuckets,
    })}\n`);
    fs.renameSync(temp, receiptFile);
  }

  return {
    results,
    population: entries.length,
    scannedPages,
    reusedPages,
    sampledBucketPages,
    sampleRate: entries.length === 0 ? 0 : scannedPages / entries.length,
    activeBucket,
    bucketCount,
    receiptReused: reusedPages > 0,
  };
}
