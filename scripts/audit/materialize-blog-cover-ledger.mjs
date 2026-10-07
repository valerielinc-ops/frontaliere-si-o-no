#!/usr/bin/env node
/**
 * Turn the historical cover audit into a publishable, bounded repair plan.
 *
 * This script never checks out the historical cover archive and never changes
 * an article registry. It materializes defensible records, keeps uncertain
 * covers as explicit `inferred` no-credit records, and creates only a bounded
 * queue of article-specific generations. Every generated replacement keeps
 * the article's own cover URL.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  isAllowedAuthorUrl,
  normaliseLicenceUrl,
  validateImageCreditRecord,
} from '../../packages/articles/engine/shared/imageCredits.mjs';

const ROOT = process.cwd();
const INVENTORY_PATH = path.join(ROOT, 'data/blog-cover-ledger.json');
const RECORD_DIR = path.join(ROOT, 'packages/articles/content/image-credits/blog');
const REPLACEMENTS_PATH = path.join(ROOT, 'data/blog-cover-replacements.json');
const GENERATED_LIMIT = 150;
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(new Date());
const INFERRED_REASON = 'Copertina senza prova certa; conservata con record inferred senza credito.';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonIfPresent(file) {
  try { return readJson(file); } catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readRecord(key) {
  const file = path.join(RECORD_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeRecord(key, record) {
  const validation = validateImageCreditRecord(record);
  if (!validation.valid) {
    throw new Error(`${key}: invalid image credit record: ${validation.errors.join('; ')}`);
  }
  const file = path.join(RECORD_DIR, `${key}.json`);
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) {
    fs.mkdirSync(RECORD_DIR, { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  }
  return `packages/articles/content/image-credits/blog/${key}.json`;
}

function sourceRecord(item) {
  const proof = item.sourceProof;
  if (!proof?.commons || !proof.licence) return null;
  const title = String(proof.commons.title || '').replace(/^File:/i, '').trim();
  if (!title) return null;
  const pageUrl = `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const licenceUrl = proof.licence.url === null ? null : normaliseLicenceUrl(proof.licence.url);
  const authorName = proof.author?.name ?? null;
  const authorUrl = isAllowedAuthorUrl(proof.author?.url) ? proof.author.url : null;
  return {
    schema: 1,
    cover: item.cover,
    source: 'wikimedia-commons',
    commons: {
      title,
      pageUrl,
      ...(Number.isInteger(proof.commons.pageId) && proof.commons.pageId > 0 ? { pageId: proof.commons.pageId } : {}),
      ...(Number.isInteger(proof.commons.width) && proof.commons.width > 0 ? { width: proof.commons.width } : {}),
      ...(Number.isInteger(proof.commons.height) && proof.commons.height > 0 ? { height: proof.commons.height } : {}),
      ...(typeof proof.commons.revision === 'string' && proof.commons.revision.trim() ? { revision: proof.commons.revision } : {}),
    },
    author: {
      text: proof.author?.text ?? authorName,
      name: authorName,
      url: authorUrl,
      type: proof.author?.type === 'Organization' ? 'Organization' : 'Person',
    },
    attribution: proof.attribution ?? null,
    licence: { ...proof.licence, url: licenceUrl },
    restrictions: [],
    modified: proof.modified === 'cropped' ? 'cropped' : 'resized',
    fetchedAt: TODAY,
    status: 'ok',
    curation: null,
  };
}

function cloneInheritedRecord(item, inherited) {
  const parent = readRecord(inherited);
  if (!parent) throw new Error(`${item.key}: inherited record ${inherited} is missing`);
  return { ...parent, cover: item.cover };
}

function replacementRecord(item, previous) {
  const wasGenerated = previous?.mode === 'generated'
    && previous.fromCover === previous.toCover
    && previous.status === 'generated'
    && fs.existsSync(path.join(RECORD_DIR, `${item.key}.json`));
  return {
    mode: 'generated',
    status: wasGenerated ? 'generated' : 'queued',
    fromCover: item.cover,
    toCover: item.cover,
    recordFile: `packages/articles/content/image-credits/blog/${item.key}.json`,
    proofLevel: item.proofLevel,
    reason: item.proofLevel === 5
      ? 'Copertina del percorso redazionale senza licenza dimostrabile; sostituzione con illustrazione generata article-hero.'
      : 'Copertina inferred; generazione article-hero su misura ordinata per traffico/recenza.',
    priority: item.priority,
    references: item.references,
    ...(wasGenerated ? {
      generatedAssetId: previous.generatedAssetId,
      provider: previous.provider,
      generatedAt: previous.generatedAt,
    } : {}),
  };
}

function updateInventory(inventory, replacements) {
  let generated = 0;
  let completed = 0;
  let inferred = 0;
  const selected = new Set(Object.keys(replacements.items));

  for (const [key, item] of Object.entries(inventory.covers)) {
    if (item.replacement?.mode === 'fallback') delete item.replacement;
    if (item.proofLevel === 6 && item.published) {
      item.verifiedAt = TODAY;
      item.provider = null;
      item.status = 'no-credit';
      item.currentlyPublished = true;
      if (!selected.has(key)) {
        item.action = 'record-inferred';
        item.evidence = 'inferred';
        item.reason = INFERRED_REASON;
        delete item.replacement;
        delete item.generated;
        inferred += 1;
      }
    }
  }

  for (const [key, replacement] of Object.entries(replacements.items)) {
    const item = inventory.covers[key];
    if (!item) throw new Error(`Replacement points at a missing inventory key: ${key}`);
    if (replacement.mode !== 'generated' || replacement.fromCover !== replacement.toCover) {
      throw new Error(`${key}: replacement must be an article-specific generation at the same URL`);
    }
    item.replacement = { ...replacement };
    item.currentlyPublished = true;
    item.action = 'replace-generated';
    item.verifiedAt = TODAY;
    item.status = replacement.status === 'generated' ? 'generated' : 'no-credit';
    generated += 1;
    if (replacement.status === 'generated') completed += 1;
  }

  inventory.generatedAt = TODAY;
  inventory.repair = {
    generatedLimit: GENERATED_LIMIT,
    generatedQueued: generated - completed,
    generatedCompleted: completed,
    inferredKept: inferred,
    sourceProbe: 'data/blog-cover-wikimedia-matches.json',
    note: 'Le copertine inferred restano sul proprio URL con record senza credito; la coda contiene solo generazioni article-hero su misura ordinate per traffico/recenza.',
  };
  return { generated, completed, inferred };
}

function main() {
  const inventory = readJson(INVENTORY_PATH);
  const previousPlan = readJsonIfPresent(REPLACEMENTS_PATH);
  const previousItems = previousPlan?.items && typeof previousPlan.items === 'object'
    ? previousPlan.items
    : {};
  const items = new Map(Object.entries(inventory.covers).map(([key, item]) => [key, { ...item, key }]));

  // First materialize evidence that is already defensible. Existing records
  // are never rewritten; inherited records get only their new cover path.
  let inherited = 0;
  let source = 0;
  for (const item of items.values()) {
    if (item.proofLevel === 2 && item.inheritedFrom) {
      item.recordFile = writeRecord(item.key, cloneInheritedRecord(item, item.inheritedFrom));
      inherited += 1;
    } else if (item.proofLevel === 4) {
      const record = sourceRecord(item);
      if (!record) throw new Error(`${item.key}: source proof cannot become a record`);
      item.recordFile = writeRecord(item.key, record);
      source += 1;
    }
  }

  const pending = [...items.values()]
    .filter((item) => item.published && item.historicalPublished && item.proofLevel >= 5)
    .sort((a, b) => (a.proofLevel - b.proofLevel) || (b.priority - a.priority) || a.key.localeCompare(b.key));
  const generatedQueue = pending.slice(0, GENERATED_LIMIT);
  const replacements = { schema: 1, generatedAt: TODAY, generatedLimit: GENERATED_LIMIT, items: {} };
  for (const item of generatedQueue) {
    replacements.items[item.key] = replacementRecord(item, previousItems[item.key]);
  }

  const repairCounts = updateInventory(inventory, replacements);
  inventory.counts = {
    ...inventory.counts,
    inheritedRecordsMaterialized: inherited,
    sourceRecordsMaterialized: source,
    generatedQueued: repairCounts.generated - repairCounts.completed,
    fallbackRepointed: 0,
    publishedReplacements: repairCounts.generated,
    inferredRecords: Object.values(inventory.covers)
      .filter((item) => item.published
        && item.proofLevel === 6
        && (item.action === 'record-inferred' || item.replacement?.status !== 'generated')).length,
  };
  writeJson(REPLACEMENTS_PATH, {
    ...replacements,
    rewrittenArticles: 0,
    generatedKeys: generatedQueue.map((item) => item.key),
  });
  writeJson(INVENTORY_PATH, inventory);
  console.log(JSON.stringify({
    inherited,
    source,
    generatedQueued: repairCounts.generated - repairCounts.completed,
    generatedCompleted: repairCounts.completed,
    fallbackRepointed: 0,
    rewrittenArticles: 0,
    inferredRecords: repairCounts.inferred,
  }, null, 2));
}

main();
