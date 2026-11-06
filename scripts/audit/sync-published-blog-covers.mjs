#!/usr/bin/env node
/**
 * Add newly published blog covers to the site-owned ledger and compact index.
 *
 * The corpus sync writes article registries and cover blobs before it opens its
 * stable PR. This bounded writer closes that transaction without re-auditing
 * historical covers: new covers are recorded conservatively as inferred/no-
 * credit, and generated entries are demoted if their pinned proof stops
 * matching the published asset.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  coverKey,
  validateImageCreditRecord,
} from '../../packages/articles/engine/shared/imageCredits.mjs';
import {
  GENERATED_IMAGE_LICENSE,
  validateGeneratedImageRecord,
  validateGeneratedImageRegistry,
} from '../../packages/articles/engine/shared/generatedImageRegistry.mjs';
import { isPublishedDeterministicCardRecord } from '../lib/published-blog-image-evidence.mjs';
import { readPublishedBlogCoverBytes } from '../lib/published-blog-cover-bytes.mjs';
import {
  PUBLISHED_CANTON_ARTICLES_PATH,
  readPublishedCantonArticlesArtifact,
} from '../lib/published-canton-articles.mjs';

const ROOT = process.cwd();
const LEDGER_PATH = path.join(ROOT, 'data/blog-cover-ledger.json');
const INDEX_PATH = path.join(ROOT, 'data/image-credits-blog.json');
const BASELINE_PATH = path.join(ROOT, 'data/blog-cover-corpus-baseline.json');
const GENERATED_REGISTRY_PATH = path.join(ROOT, 'data/blog-generated-image-registry.json');
const REPLACEMENTS_PATH = path.join(ROOT, 'data/blog-cover-replacements.json');
const GENERATED_EVIDENCE_PATH = path.join(ROOT, 'data/published-blog-generated-image-evidence.json');
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(new Date());
const REGISTRIES = [
  { section: 'frontaliere', file: 'packages/articles/content/blog-articles-data.ts' },
  { section: 'svizzera', file: 'packages/articles/content/swiss-articles-data.ts' },
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonIfPresent(file, fallback) {
  try {
    return readJson(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
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
  const bytes = readPublishedBlogCoverBytes(ROOT, image, { rejectInvalidPath: true });
  if (bytes) return bytes;
  throw new Error(`Published cover blob is unavailable: ${relative}`);
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

function generatedRegistryDefault() {
  return {
    schema: 1,
    cdnPrefix: '/images/blog/',
    assetCount: 0,
    assets: [],
  };
}

function replaceGeneratedRegistryAsset(registry, image, generated = null) {
  const assets = [];
  let replaced = false;
  for (const record of registry.assets || []) {
    if (record.imageUrl !== image && (!generated || record.assetId !== generated.assetId)) {
      assets.push(record);
      continue;
    }
    if (generated && !replaced) {
      assets.push(generated);
      replaced = true;
    }
  }
  if (generated && !replaced) assets.push(generated);
  const before = JSON.stringify(registry.assets || []);
  const changed = before !== JSON.stringify(assets);
  if (changed) {
    registry.assets = assets;
    registry.assetCount = assets.length;
    registry.generatedAt = new Date().toISOString();
  }
  return changed;
}

function generatedCreditRecordFromEvidence(generated, existing = null) {
  const next = {
    schema: 1,
    cover: generated.imageUrl,
    source: 'generated-provider',
    commons: {
      title: existing?.commons?.title || 'Generated editorial illustration',
      pageUrl: generated.licenseUrl,
      ...(Number.isInteger(generated.width) ? { width: generated.width } : {}),
      ...(Number.isInteger(generated.height) ? { height: generated.height } : {}),
      ...(typeof generated.generatedAt === 'string' ? { revision: generated.generatedAt } : {}),
    },
    author: existing?.author || {
      text: generated.credit || null,
      name: generated.credit || null,
      url: null,
      type: 'Organization',
    },
    attribution: existing?.attribution ?? null,
    licence: {
      ...(existing?.licence || {
        name: 'Generated media — provider terms apply',
        family: 'other-attribution',
        attributionRequired: true,
      }),
      url: generated.licenseUrl,
    },
    restrictions: Array.isArray(generated.restrictions)
      ? [...generated.restrictions]
      : [...(existing?.restrictions || [])],
    modified: existing?.modified === 'cropped' ? 'cropped' : 'resized',
    fetchedAt: String(generated.generatedAt || '').slice(0, 10),
    status: 'ok',
    curation: existing?.curation ?? null,
    generated,
  };
  const validation = validateImageCreditRecord(next);
  if (!validation.valid) {
    return { record: null, reason: `generated credit record after reconciliation is invalid: ${validation.errors.join('; ')}` };
  }
  return { record: next, reason: null };
}

function writeGeneratedCreditRecord(key, creditRecord) {
  const file = path.join(ROOT, generatedCreditRecordPath(key));
  const text = `${JSON.stringify(creditRecord, null, 2)}\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return true;
}

function removeGeneratedCreditRecord(key, image) {
  const file = path.join(ROOT, generatedCreditRecordPath(key));
  if (!fs.existsSync(file)) return false;
  const record = readJson(file);
  if (record?.cover !== image || record?.source !== 'generated-provider') return false;
  fs.unlinkSync(file);
  return true;
}

function demoteGeneratedEvidence(index, key, item, evidence, generatedRegistry) {
  const currentCover = index.covers[key];
  const generatedFiles = new Set([
    currentCover?.file,
    item.generated?.assetId ? `generated:${item.generated.assetId}` : null,
  ].filter((file) => typeof file === 'string' && file.startsWith('generated:')));

  delete index.covers[key];
  for (const file of generatedFiles) {
    const referencedElsewhere = Object.values(index.covers).some((cover) => cover?.file === file);
    if (!referencedElsewhere && index.files) delete index.files[file];
  }
  removeGeneratedCreditRecord(key, item.cover);
  replaceGeneratedRegistryAsset(generatedRegistry, item.cover);

  Object.assign(item, {
    proofLevel: 6,
    evidence: 'inferred',
    recordFile: null,
    action: 'record-inferred',
    reason: `Prova generated non verificata (${evidence.state}${evidence.reason ? `: ${evidence.reason}` : ''}); mantenuta come inferred senza credito.`,
    verifiedAt: TODAY,
    provider: null,
    status: 'no-credit',
  });
  delete item.generated;
  index.covers[key] = {
    evidence: 'inferred',
    provider: null,
    verifiedAt: TODAY,
    status: 'no-credit',
  };
}

function applyDeterministicCardEvidence(index, key, item, image, evidence, replacements) {
  const currentCover = index.covers[key];
  const generatedFiles = new Set([
    currentCover?.file,
    item.generated?.assetId ? `generated:${item.generated.assetId}` : null,
  ].filter((file) => typeof file === 'string' && file.startsWith('generated:')));
  for (const file of generatedFiles) {
    const referencedElsewhere = Object.entries(index.covers)
      .some(([otherKey, cover]) => otherKey !== key && cover?.file === file);
    if (!referencedElsewhere && index.files) delete index.files[file];
  }
  removeGeneratedCreditRecord(key, image);

  Object.assign(item, {
    cover: image,
    hash: evidence.actualSha256,
    proofLevel: 6,
    evidence: 'inferred',
    recordFile: null,
    action: 'record-inferred',
    reason: `Copertina deterministic-card site-owned dichiarata dal corpus e verificata sui byte pubblicati (${evidence.actualSha256}); nessun credito provider.`,
    verifiedAt: TODAY,
    provider: null,
    currentlyPublished: true,
    status: 'no-credit',
  });
  delete item.generated;
  delete item.replacement;
  if (replacements.items && Object.hasOwn(replacements.items, key)) delete replacements.items[key];
  index.covers[key] = {
    evidence: 'inferred',
    provider: null,
    verifiedAt: TODAY,
    status: 'no-credit',
  };
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
  if (generated.assetId !== key || generated.imageUrl !== image) {
    return { state: 'rejected', reason: 'generated record assetId or imageUrl does not match the published cover' };
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

  const recordFile = generatedCreditRecordPath(key);
  let existingCreditRecord = null;
  if (fs.existsSync(path.join(ROOT, recordFile))) {
    try {
      const candidate = readJson(path.join(ROOT, recordFile));
      const creditValidation = validateImageCreditRecord(candidate);
      if (creditValidation.valid
        && candidate.source === 'generated-provider'
        && candidate.cover === image
        && candidate.generated?.scope === 'article-hero') {
        existingCreditRecord = candidate;
      }
    } catch {
      // A stale or unreadable local record is ignored; the fresh record below
      // is rebuilt only from the declared, byte-verified evidence.
    }
  }
  if (isPublishedDeterministicCardRecord(generated)) {
    return { state: 'verified', kind: 'deterministic-card', generated, actualSha256 };
  }
  if (generated.license !== GENERATED_IMAGE_LICENSE) {
    return { state: 'rejected', reason: 'published article-hero evidence is neither a deterministic card nor a generated-provider record' };
  }
  const reconciled = generatedCreditRecordFromEvidence(generated, existingCreditRecord);
  if (!reconciled.record) return { state: 'rejected', reason: reconciled.reason };
  return {
    state: 'verified',
    kind: 'generated-provider',
    generated,
    creditRecord: reconciled.record,
    actualSha256,
  };
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

function updateReplacementQueueEntry(replacements, key, generated) {
  const replacement = replacements.items?.[key];
  if (!replacement || replacement.mode !== 'generated') return;
  Object.assign(replacement, {
    status: 'generated',
    fromCover: replacement.fromCover || generated.imageUrl,
    toCover: replacement.toCover || generated.imageUrl,
    recordFile: generatedCreditRecordPath(key),
    generatedAssetId: generated.assetId,
    provider: generated.provider,
    generatedAt: generated.generatedAt,
  });
}

function main() {
  const ledger = readJson(LEDGER_PATH);
  const index = readJson(INDEX_PATH);
  const baseline = readJson(BASELINE_PATH);
  const generatedRegistry = readJsonIfPresent(GENERATED_REGISTRY_PATH, generatedRegistryDefault());
  const replacements = readJsonIfPresent(REPLACEMENTS_PATH, { schema: 1, items: {} });
  const publishedEvidence = readJson(GENERATED_EVIDENCE_PATH);
  const beforeGeneratedRegistry = JSON.stringify(generatedRegistry);
  const beforeReplacements = JSON.stringify(replacements);
  const sourceCommit = process.env.ARTICLES_SYNC_COMMIT || null;
  if (!ledger.covers || !index.covers || !index.files || !baseline.registries) {
    throw new Error('Blog cover ledger, compact index and corpus baseline are required');
  }
  if (!Array.isArray(generatedRegistry.assets)
    || generatedRegistry.schema !== 1
    || (generatedRegistry.assetCount !== undefined
      && generatedRegistry.assetCount !== generatedRegistry.assets.length)) {
    throw new Error('Site blog generated-image registry is invalid');
  }
  const generatedRegistryValidation = validateGeneratedImageRegistry(generatedRegistry, { scope: 'article-hero' });
  if (!generatedRegistryValidation.valid) {
    throw new Error(`Site blog generated-image registry is invalid: ${generatedRegistryValidation.errors.join('; ')}`);
  }
  if (!replacements.items || typeof replacements.items !== 'object' || Array.isArray(replacements.items)) {
    throw new Error('Blog cover replacements queue is invalid');
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
  const publishedCantonArtifact = readPublishedCantonArticlesArtifact(ROOT, {
    expectedCommit: sourceCommit || publishedEvidence.commit,
  });
  const publishedArticles = [
    ...registryArticles.values(),
    publishedCantonArtifact.articles,
  ].flat();
  for (const article of publishedArticles) {
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
    if (ledger.covers[key]?.published) continue;
    const sorted = articles.slice().sort((a, b) => priority(b) - priority(a));
    const bytes = coverBytes(sorted[0].image);
    additions.push({ key, articles: sorted, bytes, hash: crypto.createHash('sha256').update(bytes).digest('hex') });
  }

  const generatedAddedKeys = [];
  const generatedBackfilledKeys = [];
  const reconciledGeneratedKeys = [];
  const demotedGeneratedKeys = [];
  const deterministicCardInferredKeys = [];
  const generatedRegistryUpdatedKeys = [];
  const generatedCreditRecordUpdatedKeys = [];
  const generatedEvidenceMissing = [];
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
      if (evidence.kind === 'deterministic-card') {
        applyDeterministicCardEvidence(index, key, item, articles[0].image, evidence, replacements);
        replaceGeneratedRegistryAsset(generatedRegistry, articles[0].image);
        deterministicCardInferredKeys.push(key);
      } else {
        const creditRecord = applyGeneratedEvidence(item, key, articles[0].image, evidence);
        updateReplacementQueueEntry(replacements, key, evidence.generated);
        writeGeneratedCreditRecord(key, creditRecord);
        setGeneratedIndex(index, key, creditRecord);
        replaceGeneratedRegistryAsset(generatedRegistry, articles[0].image, evidence.generated);
        generatedAddedKeys.push(key);
      }
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
  // wrote as inferred, repair generated entries whose proof level or compact
  // reader index predates the published evidence, and reconcile stale site
  // records when the corpus now declares the same URL differently.
  for (const key of [...byKey.keys()].sort()) {
    const item = ledger.covers[key];
    if (additions.some((entry) => entry.key === key)) continue;
    const image = byKey.get(key)?.[0]?.image || item.cover;
    if (typeof image !== 'string') continue;
    if ((recordsByImage.get(image) || []).length === 0 && item?.evidence !== 'generated-engine-record') continue;

    const beforeItem = JSON.stringify(item);
    const beforeCoverIndex = JSON.stringify(index.covers[key]);
    const evidence = inspectGeneratedEvidence(key, image, recordsByImage);
    if (evidence.state === 'verified') {
      const wasInferred = item.evidence === 'inferred';
      if (evidence.kind === 'deterministic-card') {
        applyDeterministicCardEvidence(index, key, item, image, evidence, replacements);
        if (replaceGeneratedRegistryAsset(generatedRegistry, image)) generatedRegistryUpdatedKeys.push(key);
        deterministicCardInferredKeys.push(key);
      } else {
        const creditRecord = applyGeneratedEvidence(item, key, image, evidence);
        updateReplacementQueueEntry(replacements, key, evidence.generated);
        if (writeGeneratedCreditRecord(key, creditRecord)) generatedCreditRecordUpdatedKeys.push(key);
        const indexChanged = setGeneratedIndex(index, key, creditRecord);
        if (replaceGeneratedRegistryAsset(generatedRegistry, image, evidence.generated)) generatedRegistryUpdatedKeys.push(key);
        if (wasInferred) generatedBackfilledKeys.push(key);
        else if (JSON.stringify(item) !== beforeItem) reconciledGeneratedKeys.push(key);
        if (indexChanged || JSON.stringify(index.covers[key]) !== beforeCoverIndex) repairedIndexKeys.push(key);
      }
      if (evidence.kind === 'deterministic-card'
        && (JSON.stringify(item) !== beforeItem || JSON.stringify(index.covers[key]) !== beforeCoverIndex)) {
        repairedIndexKeys.push(key);
      }
    } else if (evidence.state === 'mismatch') {
      generatedEvidenceMismatches.push({ key, ...evidence });
    } else if (evidence.state === 'rejected') {
      generatedEvidenceRejected.push({ key, reason: evidence.reason });
    }
    if (evidence.state !== 'verified' && item.evidence === 'generated-engine-record') {
      demoteGeneratedEvidence(index, key, item, evidence, generatedRegistry);
      demotedGeneratedKeys.push(key);
      if (evidence.state === 'missing') generatedEvidenceMissing.push({ key });
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
  if (baseline.publishedArtifacts !== undefined
    && (!baseline.publishedArtifacts
      || typeof baseline.publishedArtifacts !== 'object'
      || Array.isArray(baseline.publishedArtifacts))) {
    throw new Error('Corpus baseline publishedArtifacts must be an object');
  }
  baseline.publishedArtifacts ||= {};
  baseline.publishedArtifacts.cantonArticles = {
    path: PUBLISHED_CANTON_ARTICLES_PATH,
    present: true,
    sha256: crypto.createHash('sha256').update(publishedCantonArtifact.raw).digest('hex'),
    articleCount: publishedCantonArtifact.articleCount,
  };
  for (const { file } of REGISTRIES) {
    const articles = registryArticles.get(file);
    const entry = baseline.registries[file];
    if (!entry) throw new Error(`Corpus baseline is missing registry: ${file}`);
    entry.articles = articles.length;
    entry.distinctImages = new Set(articles.map(({ image }) => image)).size;
  }
  const baselineUpdated = JSON.stringify(baseline) !== beforeBaseline;
  const generatedRegistryUpdated = JSON.stringify(generatedRegistry) !== beforeGeneratedRegistry;
  const replacementsUpdated = JSON.stringify(replacements) !== beforeReplacements;

  if (additions.length || generatedBackfilledKeys.length || reconciledGeneratedKeys.length || demotedGeneratedKeys.length
    || deterministicCardInferredKeys.length || generatedRegistryUpdated || generatedCreditRecordUpdatedKeys.length
    || replacementsUpdated || repairedIndexKeys.length || baselineUpdated) {
    ledger.generatedAt = TODAY;
    generatedRegistry.assetCount = generatedRegistry.assets.length;
    refreshCounts(ledger);
    writeJson(LEDGER_PATH, ledger);
    writeJson(INDEX_PATH, index);
    writeJson(BASELINE_PATH, baseline);
    if (generatedRegistryUpdated) writeJson(GENERATED_REGISTRY_PATH, generatedRegistry);
    if (replacementsUpdated) writeJson(REPLACEMENTS_PATH, replacements);
  }

  console.log(JSON.stringify({
    added: additions.length,
    keys: additions.map(({ key }) => key),
    generatedAddedKeys,
    generatedBackfilledKeys,
    reconciledGeneratedKeys,
    demotedGeneratedKeys,
    deterministicCardInferredKeys,
    generatedRegistryUpdatedKeys,
    generatedCreditRecordUpdatedKeys,
    repairedIndexKeys,
    generatedEvidenceMissing,
    generatedEvidenceMismatches,
    generatedEvidenceRejected,
    baselineUpdated,
  }, null, 2));
}

main();
