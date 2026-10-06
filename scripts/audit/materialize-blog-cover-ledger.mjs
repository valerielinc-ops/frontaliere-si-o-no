#!/usr/bin/env node
/**
 * Turn the historical cover audit into a publishable, bounded repair plan.
 *
 * This script never checks out the historical cover archive. It writes only
 * licence records for inherited evidence, chooses a recorded fallback for the
 * rest, and rewrites the two article registries so every currently published
 * reference points at a recorded cover. The generated queue is intentionally
 * capped at 150; the scheduled workflow consumes that queue later.
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
const REGISTRIES = [
  'packages/articles/content/blog-articles-data.ts',
  'packages/articles/content/swiss-articles-data.ts',
];
const GENERATED_LIMIT = 150;
const TODAY = new Date().toISOString().slice(0, 10);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function coverKey(value) {
  const match = String(value || '').match(/\/images\/blog\/([^/?#]+)\.(?:webp|png|jpe?g|avif)(?:[?#].*)?$/i);
  return match ? match[1] : null;
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

const TOKEN_CACHE = new Map();

function tokens(value) {
  const cacheKey = String(value || '');
  const cached = TOKEN_CACHE.get(cacheKey);
  if (cached) return cached;
  const result = new Set(cacheKey.toLowerCase().split(/[^a-z0-9àèéìòùü]+/u)
    .filter((token) => token.length >= 4)
    .filter((token) => !['della', 'delle', 'degli', 'dello', 'degli', 'frontalieri', 'ticino', 'svizzera', 'svizzero', '2026', '2025'].includes(token)));
  TOKEN_CACHE.set(cacheKey, result);
  return result;
}

function candidateScore(item, candidate) {
  const sourceRef = item.references?.[0] || {};
  const targetRef = candidate.references?.[0] || {};
  let score = 0;
  if (sourceRef.category && sourceRef.category === targetRef.category) score += 1000;
  if (sourceRef.section && sourceRef.section === targetRef.section) score += 100;
  const overlap = [...tokens(sourceRef.id)].filter((token) => tokens(targetRef.id).has(token)).length;
  score += overlap * 20;
  score += Math.min(20, Number(candidate.priority || 0) / 1e12);
  return score;
}

function replacementCandidates(items) {
  return [...items.values()]
    .filter((item) => item.published && (item.proofLevel <= 4 || item.action === 'copy-record') && item.recordFile)
    .sort((a, b) => a.key.localeCompare(b.key));
}

function chooseFallback(item, candidates) {
  const eligible = candidates.filter((candidate) => candidate.key !== item.key);
  if (eligible.length === 0) throw new Error(`No recorded fallback available for ${item.key}`);
  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of eligible) {
    const score = candidateScore(item, candidate);
    if (score > bestScore || (score === bestScore && (!best || candidate.key.localeCompare(best.key) < 0))) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function rewriteRegistries(replacements) {
  const pathMap = new Map();
  const keyMap = new Map();
  for (const item of Object.values(replacements.items)) {
    if (item.mode !== 'fallback') continue;
    pathMap.set(item.fromCover, item.toCover);
    const key = coverKey(item.fromCover);
    if (key) keyMap.set(key, item.toCover);
  }
  let changed = 0;
  for (const relative of REGISTRIES) {
    const file = path.join(ROOT, relative);
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace(/(\bimage:\s*')([^']+)(')/g, (whole, prefix, image, suffix) => {
      const next = pathMap.get(image) || keyMap.get(coverKey(image));
      if (!next || next === image) return whole;
      changed += 1;
      return `${prefix}${next}${suffix}`;
    });
    if (after !== before) fs.writeFileSync(file, after, 'utf8');
  }
  return changed;
}

function updateInventory(inventory, replacements) {
  let generated = 0;
  let fallback = 0;
  for (const [key, replacement] of Object.entries(replacements.items)) {
    const item = inventory.covers[key];
    if (!item) throw new Error(`Replacement points at a missing inventory key: ${key}`);
    item.replacement = {
      mode: replacement.mode,
      status: replacement.mode === 'generated' ? 'queued' : 'applied',
      fromCover: replacement.fromCover,
      toCover: replacement.toCover,
      recordFile: replacement.recordFile,
      reason: replacement.reason,
      priority: replacement.priority,
    };
    item.currentlyPublished = replacement.mode === 'generated';
    if (replacement.mode === 'generated') generated += 1;
    else fallback += 1;
  }
  inventory.generatedAt = TODAY;
  inventory.repair = {
    generatedLimit: GENERATED_LIMIT,
    generatedQueued: generated,
    fallbackApplied: fallback,
    sourceProbe: 'data/blog-cover-wikimedia-matches.json',
    note: 'Le copertine generated restano sullo stesso URL e vengono sostituite dal workflow a PR; i fallback usano un record già verificato.',
  };
  return { generated, fallback };
}

function main() {
  const inventory = readJson(INVENTORY_PATH);
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

  const replacementPool = replacementCandidates(items);
  const repairable = [...items.values()]
    .filter((item) => item.historicalPublished && item.proofLevel >= 5 && item.action.startsWith('replace-'));
  const pending = repairable
    .filter((item) => item.published)
    .sort((a, b) => (a.proofLevel - b.proofLevel) || (b.priority - a.priority) || a.key.localeCompare(b.key));
  const generatedQueue = pending.slice(0, GENERATED_LIMIT);
  const generatedKeys = new Set(generatedQueue.map((item) => item.key));
  const replacements = { schema: 1, generatedAt: TODAY, generatedLimit: GENERATED_LIMIT, items: {} };
  for (const item of repairable) {
    if (item.published && generatedKeys.has(item.key)) {
      replacements.items[item.key] = {
        mode: 'generated',
        status: 'queued',
        fromCover: item.cover,
        toCover: item.cover,
        recordFile: `packages/articles/content/image-credits/blog/${item.key}.json`,
        proofLevel: item.proofLevel,
        reason: item.proofLevel === 5 ? 'Copertina del percorso redazionale senza licenza dimostrabile; sostituzione con illustrazione generata article-hero.' : 'Copertina storica senza prova sufficiente; priorità traffico/recenza nella coda article-hero.',
        priority: item.priority,
        references: item.references,
      };
    } else {
      const target = chooseFallback(item, replacementPool);
      replacements.items[item.key] = {
        mode: 'fallback',
        status: 'applied',
        fromCover: item.cover,
        toCover: target.cover,
        recordFile: target.recordFile,
        proofLevel: item.proofLevel,
        reason: item.proofLevel === 5 ? 'Copertina del percorso redazionale senza licenza dimostrabile; fallback immediato su copertina già registrata.' : 'Copertina storica senza prova sufficiente oltre il tetto di generazioni; fallback registrato in attesa della coda futura.',
        priority: item.priority,
        references: item.references,
        fallbackKey: target.key,
      };
    }
  }

  const rewrittenArticles = rewriteRegistries(replacements);
  const repairCounts = updateInventory(inventory, replacements);
  inventory.counts = {
    ...inventory.counts,
    inheritedRecordsMaterialized: inherited,
    sourceRecordsMaterialized: source,
    generatedQueued: repairCounts.generated,
    fallbackRepointed: repairCounts.fallback,
    publishedReplacements: repairable.length,
  };
  writeJson(REPLACEMENTS_PATH, {
    ...replacements,
    rewrittenArticles,
    generatedKeys: generatedQueue.map((item) => item.key),
    temporaryAllowlist: generatedQueue
      .filter((item) => item.proofLevel === 6)
      .map((item) => ({ key: item.key, proofLevel: item.proofLevel, reason: 'inferred historical cover queued for article-hero regeneration', createdAt: TODAY })),
  });
  writeJson(INVENTORY_PATH, inventory);
  console.log(JSON.stringify({
    inherited,
    source,
    generatedQueued: repairCounts.generated,
    fallbackRepointed: repairCounts.fallback,
    rewrittenArticles,
    replacementPool: replacementPool.length,
  }, null, 2));
}

main();
