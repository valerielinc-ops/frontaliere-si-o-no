#!/usr/bin/env node
/**
 * Add newly published blog covers to the site-owned ledger and compact index.
 *
 * The corpus sync writes article registries and cover blobs before it opens its
 * stable PR. This bounded writer closes that transaction without re-auditing
 * historical covers: existing entries are untouched, while a new cover is
 * recorded conservatively as inferred/no-credit until the dedicated licence
 * audit can prove a stronger source.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  coverKey,
  validateImageCreditRecord,
} from '../../packages/articles/engine/shared/imageCredits.mjs';
import { validateGeneratedImageRecord } from '../../packages/articles/engine/shared/generatedImageRegistry.mjs';

const ROOT = process.cwd();
const LEDGER_PATH = path.join(ROOT, 'data/blog-cover-ledger.json');
const INDEX_PATH = path.join(ROOT, 'data/image-credits-blog.json');
const BASELINE_PATH = path.join(ROOT, 'data/blog-cover-corpus-baseline.json');
const GENERATED_EVIDENCE_PATH = path.join(ROOT, 'data/published-blog-generated-image-evidence.json');
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(new Date());
const REGISTRIES = [
  { section: 'frontaliere', file: 'packages/articles/content/blog-articles-data.ts' },
  { section: 'svizzera', file: 'packages/articles/content/swiss-articles-data.ts' },
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseRegistry({ section, file }) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const articles = [];
  const objectRx = /\{\s*\n\s*id:\s*'([^']+)'([\s\S]*?)\n\s*\},?/g;
  let match;
  while ((match = objectRx.exec(source))) {
    const id = match[1];
    const block = match[0];
    const image = block.match(/\bimage:\s*'([^']+)'/)?.[1];
    if (!image) continue;
    articles.push({
      section,
      id,
      image,
      category: block.match(/\bcategory:\s*'([^']+)'/)?.[1] || null,
      date: block.match(/\bdate:\s*'([^']+)'/)?.[1] || null,
      updatedAt: block.match(/\bupdatedAt:\s*'([^']+)'/)?.[1] || null,
      authorSlug: block.match(/\bauthorSlug:\s*'([^']+)'/)?.[1] || null,
    });
  }
  return articles;
}

function coverBytes(image) {
  const relative = `public/${image.replace(/^\/+/, '')}`;
  const expectedRoot = path.join(ROOT, 'public/images/blog');
  const absolute = path.resolve(ROOT, relative);
  if (!absolute.startsWith(`${expectedRoot}${path.sep}`)) {
    throw new Error(`Refusing non-blog cover path: ${image}`);
  }
  if (fs.existsSync(absolute)) return fs.readFileSync(absolute);
  try {
    return execFileSync('git', ['show', `HEAD:${relative}`], {
      cwd: ROOT,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(`Published cover blob is unavailable: ${relative}`);
  }
}

function priority(article) {
  return Math.round((Date.parse(article.updatedAt || article.date || '') || 0) / 1e9);
}

function reference(article) {
  const { section, id, category, date, updatedAt, authorSlug } = article;
  return { section, id, category, date, updatedAt, authorSlug };
}

function refreshCounts(ledger) {
  const entries = Object.values(ledger.covers);
  const levels = Object.fromEntries([1, 2, 3, 4, 5, 6].map((level) => [String(level), 0]));
  for (const item of entries) {
    const level = String(item.proofLevel);
    if (Object.hasOwn(levels, level)) levels[level] += 1;
  }
  const published = entries.filter((item) => item.published);
  ledger.counts = {
    ...ledger.counts,
    allCoversByProofLevel: levels,
    publishedCovers: published.length,
    publishedWithExistingOrInheritedRecord: published.filter((item) => item.action === 'keep' || item.action === 'copy-record').length,
    publishedReplacements: published.filter((item) => String(item.action || '').startsWith('replace-')).length,
    inferredRecords: entries.filter((item) => item.published
      && item.proofLevel === 6
      && (item.action === 'record-inferred' || item.replacement?.status !== 'generated')).length,
  };
}

function compactGeneratedFile(record) {
  return {
    source: 'generated-provider',
    commons: record.commons,
    author: record.author,
    attribution: record.attribution,
    licence: record.licence,
    restrictions: record.restrictions,
    fetchedAt: record.fetchedAt,
    generated: record.generated,
  };
}

function generatedCreditRecordPath(key) {
  return `packages/articles/content/image-credits/blog/${key}.json`;
}

function setGeneratedIndex(index, key, creditRecord) {
  index.files ||= {};
  const file = `generated:${creditRecord.generated.assetId}`;
  const fileValue = compactGeneratedFile(creditRecord);
  const coverValue = { file, modified: creditRecord.modified };
  const changed = JSON.stringify(index.files[file]) !== JSON.stringify(fileValue)
    || JSON.stringify(index.covers[key]) !== JSON.stringify(coverValue);
  index.files[file] = fileValue;
  index.covers[key] = coverValue;
  return changed;
}

function inspectGeneratedEvidence(key, image, recordsByImage, knownBytes = null) {
  const records = recordsByImage.get(image) || [];
  if (records.length === 0) return { state: 'missing' };
  if (records.length !== 1) {
    return { state: 'rejected', reason: 'multiple generated registry records use this image URL' };
  }

  const generated = records[0];
  const registryValidation = validateGeneratedImageRecord(generated, { scope: 'article-hero' });
  if (!registryValidation.valid) {
    return { state: 'rejected', reason: `invalid generated registry record: ${registryValidation.errors.join('; ')}` };
  }
  if (generated.kind !== 'generated' || generated.assetId !== key || generated.imageUrl !== image) {
    return { state: 'rejected', reason: 'generated record kind, assetId or imageUrl does not match the published cover' };
  }

  const recordFile = generatedCreditRecordPath(key);
  let creditRecord;
  try {
    creditRecord = readJson(path.join(ROOT, recordFile));
  } catch (error) {
    return { state: 'rejected', reason: `generated credit record unavailable: ${error.message}` };
  }
  const creditValidation = validateImageCreditRecord(creditRecord);
  if (!creditValidation.valid) {
    return { state: 'rejected', reason: `generated credit record invalid: ${creditValidation.errors.join('; ')}` };
  }
  if (creditRecord.source !== 'generated-provider'
    || creditRecord.cover !== image
    || creditRecord.generated.scope !== 'article-hero'
    || ['assetId', 'kind', 'provider', 'model', 'promptHash', 'sha256', 'scope', 'imageUrl', 'verifiedAt']
      .some((field) => creditRecord.generated[field] !== generated[field])) {
    return { state: 'rejected', reason: 'HTTP evidence and generated credit record do not describe the same asset' };
  }

  let bytes = knownBytes;
  if (!bytes) {
    try {
      bytes = coverBytes(image);
    } catch (error) {
      return { state: 'rejected', reason: `published cover bytes unavailable for verification: ${error.message}` };
    }
  }
  const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (generated.sha256 !== actualSha256 || generated.bytes !== bytes.length) {
    return {
      state: 'mismatch',
      expectedSha256: generated.sha256,
      actualSha256,
      reason: generated.bytes !== bytes.length
        ? `recorded ${generated.bytes} bytes but received ${bytes.length}`
        : 'generated record sha256 differs from the received cover bytes',
    };
  }
  return { state: 'verified', generated, creditRecord, actualSha256 };
}

function applyGeneratedEvidence(item, key, image, evidence) {
  const { generated, actualSha256, creditRecord } = evidence;
  Object.assign(item, {
    cover: image,
    hash: actualSha256,
    proofLevel: 5,
    evidence: 'generated-engine-record',
    recordFile: generatedCreditRecordPath(key),
    action: 'generated',
    reason: 'Copertina generata con record article-hero verificato e sha256 coincidente con i byte pubblicati.',
    verifiedAt: String(generated.verifiedAt || generated.generatedAt).slice(0, 10),
    provider: generated.provider,
    currentlyPublished: true,
    status: 'generated',
    generated: {
      provider: generated.provider,
      assetId: generated.assetId,
      imageUrl: generated.imageUrl,
      evidence: 'generated-engine-record',
    },
  });
  return creditRecord;
}

function main() {
  const ledger = readJson(LEDGER_PATH);
  const index = readJson(INDEX_PATH);
  const baseline = readJson(BASELINE_PATH);
  const publishedEvidence = readJson(GENERATED_EVIDENCE_PATH);
  const sourceCommit = process.env.ARTICLES_SYNC_COMMIT || null;
  if (!ledger.covers || !index.covers || !index.files || !baseline.registries) {
    throw new Error('Blog cover ledger, compact index and corpus baseline are required');
  }
  if (publishedEvidence.schema !== 1
    || !/^[0-9a-f]{40}$/.test(String(publishedEvidence.commit || ''))
    || !publishedEvidence.generated
    || typeof publishedEvidence.generated !== 'object'
    || Array.isArray(publishedEvidence.generated)) {
    throw new Error('Published generated-image evidence snapshot is invalid');
  }
  if (sourceCommit && !/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error('ARTICLES_SYNC_COMMIT must be a full lowercase Git SHA');
  }
  if (sourceCommit && publishedEvidence.commit !== sourceCommit) {
    throw new Error(`Generated-image evidence is pinned to ${publishedEvidence.commit}, not ARTICLES_SYNC_COMMIT ${sourceCommit}`);
  }

  const byKey = new Map();
  const registryArticles = new Map(REGISTRIES.map((registry) => [registry.file, parseRegistry(registry)]));
  for (const article of [...registryArticles.values()].flat()) {
    const key = coverKey(article.image);
    if (!key) continue;
    const entries = byKey.get(key) || [];
    entries.push(article);
    byKey.set(key, entries);
  }

  const recordsByImage = new Map();
  for (const record of Object.values(publishedEvidence.generated)) {
    if (!record || typeof record !== 'object' || typeof record.imageUrl !== 'string') continue;
    const records = recordsByImage.get(record.imageUrl) || [];
    records.push(record);
    recordsByImage.set(record.imageUrl, records);
  }

  // Resolve every blob before writing either file: one unavailable cover keeps
  // the paired ledger/index update fail-closed, with no partial data rewrite.
  const additions = [];
  for (const [key, articles] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
    if (ledger.covers[key]) continue;
    const sorted = articles.slice().sort((a, b) => priority(b) - priority(a));
    const bytes = coverBytes(sorted[0].image);
    additions.push({ key, articles: sorted, bytes, hash: crypto.createHash('sha256').update(bytes).digest('hex') });
  }

  const generatedAddedKeys = [];
  const generatedBackfilledKeys = [];
  const reconciledGeneratedKeys = [];
  const generatedEvidenceMismatches = [];
  const generatedEvidenceRejected = [];
  const repairedIndexKeys = [];
  for (const { key, articles, bytes, hash } of additions) {
    const item = {
      cover: articles[0].image,
      hash,
      published: true,
      historicalPublished: true,
      references: articles.map(reference),
      proofLevel: 6,
      evidence: 'inferred',
      recordFile: null,
      inheritedFrom: null,
      action: 'record-inferred',
      reason: 'Copertina senza prova certa; conservata con record inferred senza credito.',
      priority: priority(articles[0]),
      verifiedAt: TODAY,
      provider: null,
      currentlyPublished: true,
      status: 'no-credit',
    };
    const evidence = inspectGeneratedEvidence(key, articles[0].image, recordsByImage, bytes);
    if (evidence.state === 'verified') {
      const creditRecord = applyGeneratedEvidence(item, key, articles[0].image, evidence);
      setGeneratedIndex(index, key, creditRecord);
      generatedAddedKeys.push(key);
    } else {
      index.covers[key] = {
        evidence: 'inferred',
        provider: null,
        verifiedAt: TODAY,
        status: 'no-credit',
      };
      if (evidence.state === 'mismatch') generatedEvidenceMismatches.push({ key, ...evidence });
      if (evidence.state === 'rejected') generatedEvidenceRejected.push({ key, reason: evidence.reason });
    }
    ledger.covers[key] = item;
  }

  // Backfill corpus-generated records that an earlier sync conservatively
  // wrote as inferred, and repair generated entries whose proof level or
  // compact reader index predates the published evidence.
  for (const key of [...byKey.keys()].sort()) {
    const item = ledger.covers[key];
    if (additions.some((entry) => entry.key === key)) continue;
    if (item?.evidence !== 'inferred' && item?.evidence !== 'generated-engine-record') continue;
    const image = byKey.get(key)?.[0]?.image || item.cover;
    if (typeof image !== 'string') continue;
    if ((recordsByImage.get(image) || []).length === 0) continue;

    const beforeItem = JSON.stringify(item);
    const beforeCoverIndex = JSON.stringify(index.covers[key]);
    const evidence = inspectGeneratedEvidence(key, image, recordsByImage);
    if (evidence.state === 'verified') {
      const wasInferred = item.evidence === 'inferred';
      const creditRecord = applyGeneratedEvidence(item, key, image, evidence);
      const indexChanged = setGeneratedIndex(index, key, creditRecord);
      if (wasInferred) generatedBackfilledKeys.push(key);
      else if (JSON.stringify(item) !== beforeItem) reconciledGeneratedKeys.push(key);
      if (indexChanged || JSON.stringify(index.covers[key]) !== beforeCoverIndex) repairedIndexKeys.push(key);
    } else if (evidence.state === 'mismatch') {
      generatedEvidenceMismatches.push({ key, ...evidence });
    } else if (evidence.state === 'rejected') {
      generatedEvidenceRejected.push({ key, reason: evidence.reason });
    }
  }

  // Retain the existing inferred-index repair for explicit no-credit covers.
  for (const key of [...byKey.keys()].sort()) {
    const item = ledger.covers[key];
    if (index.covers[key]
      || item?.proofLevel !== 6
      || item?.evidence !== 'inferred'
      || typeof item?.verifiedAt !== 'string') continue;
    index.covers[key] = {
      evidence: 'inferred',
      provider: null,
      verifiedAt: item.verifiedAt,
      status: 'no-credit',
    };
    repairedIndexKeys.push(key);
  }

  const beforeBaseline = JSON.stringify(baseline);
  if (sourceCommit) baseline.sourceCommit = sourceCommit;
  baseline.generatedAt = TODAY;
  for (const { file } of REGISTRIES) {
    const articles = registryArticles.get(file);
    const entry = baseline.registries[file];
    if (!entry) throw new Error(`Corpus baseline is missing registry: ${file}`);
    entry.articles = articles.length;
    entry.distinctImages = new Set(articles.map(({ image }) => image)).size;
  }
  const baselineUpdated = JSON.stringify(baseline) !== beforeBaseline;

  if (additions.length || generatedBackfilledKeys.length || reconciledGeneratedKeys.length
    || repairedIndexKeys.length || baselineUpdated) {
    ledger.generatedAt = TODAY;
    index.covers = Object.fromEntries(Object.entries(index.covers).sort(([a], [b]) => a.localeCompare(b)));
    index.files = Object.fromEntries(Object.entries(index.files).sort(([a], [b]) => a.localeCompare(b)));
    refreshCounts(ledger);
    writeJson(LEDGER_PATH, ledger);
    writeJson(INDEX_PATH, index);
    writeJson(BASELINE_PATH, baseline);
  }

  console.log(JSON.stringify({
    added: additions.length,
    keys: additions.map(({ key }) => key),
    generatedAddedKeys,
    generatedBackfilledKeys,
    reconciledGeneratedKeys,
    repairedIndexKeys,
    generatedEvidenceMismatches,
    generatedEvidenceRejected,
    baselineUpdated,
  }, null, 2));
}

main();
