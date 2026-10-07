#!/usr/bin/env node
/**
 * Consume the bounded historical repair queue with the shared article-hero
 * image engine. The script is resumable: generated records and bytes are kept
 * in the cache, while the committed registry and generation queue are updated
 * after every successful asset. It never repoints an article to another
 * article's cover.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateImageFromSpec } from '../../packages/articles/engine/shared/generatedImageEngine.mjs';
import {
  validateGeneratedImageRecord,
  validateGeneratedImageRegistry,
} from '../../packages/articles/engine/shared/generatedImageRegistry.mjs';
import { validateImageCreditRecord } from '../../packages/articles/engine/shared/imageCredits.mjs';

const ROOT = process.cwd();
const QUEUE_PATH = path.join(ROOT, 'data/blog-cover-replacements.json');
const INVENTORY_PATH = path.join(ROOT, 'data/blog-cover-ledger.json');
const REGISTRY_PATH = path.join(ROOT, 'data/blog-generated-image-registry.json');
const OUTPUT_DIR = path.join(ROOT, '.cache/blog-cover-ledger/generated');
const RECORD_DIR = path.join(ROOT, 'packages/articles/content/image-credits/blog');
const MAX_TOTAL = 150;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function parseArgs(argv) {
  const args = { limit: 150, reconcileOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--reconcile-only') args.reconcileOnly = true;
    else if (argv[i] === '--help') {
      console.log('Usage: node scripts/audit/generate-blog-cover-queue.mjs [--limit 1..150] [--reconcile-only]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_TOTAL) {
    throw new Error(`--limit must be an integer from 1 to ${MAX_TOTAL}`);
  }
  return args;
}

function words(key) {
  return key.replace(/-/g, ' ').replace(/\b20\d{2}\b/g, '').replace(/\s+/g, ' ').trim();
}

function articleHeroRecord(generated) {
  const record = {
    schema: 1,
    cover: generated.imageUrl,
    source: 'generated-provider',
    commons: {
      title: 'Generated editorial illustration',
      pageUrl: generated.licenseUrl,
      width: generated.width,
      height: generated.height,
      revision: generated.generatedAt,
    },
    author: {
      text: generated.credit,
      name: generated.credit,
      url: null,
      type: 'Organization',
    },
    attribution: null,
    licence: {
      name: 'Generated media — provider terms apply',
      url: generated.licenseUrl,
      family: 'other-attribution',
      attributionRequired: true,
    },
    restrictions: [...generated.restrictions],
    modified: 'resized',
    fetchedAt: generated.generatedAt.slice(0, 10),
    status: 'ok',
    curation: null,
    generated,
  };
  const imageValidation = validateImageCreditRecord(record);
  if (!imageValidation.valid) throw new Error(`image credit invalid: ${imageValidation.errors.join('; ')}`);
  return record;
}

function ensureSparsePath(relative) {
  execFileSync('git', ['sparse-checkout', 'add', relative], { cwd: ROOT, stdio: 'ignore' });
}

function writeAssetRecord(key, record) {
  const destination = path.join(RECORD_DIR, `${key}.json`);
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return `packages/articles/content/image-credits/blog/${key}.json`;
}

function persistRegistry(assets) {
  const registry = {
    schema: 1,
    cdnPrefix: '/images/blog/',
    assetCount: assets.length,
    generatedAt: new Date().toISOString(),
    assets: assets.slice().sort((a, b) => a.assetId.localeCompare(b.assetId)),
  };
  const validation = validateGeneratedImageRegistry(registry, { scope: 'article-hero' });
  if (!validation.valid) throw new Error(`generated registry invalid: ${validation.errors.join('; ')}`);
  writeJson(REGISTRY_PATH, registry);
  return registry;
}

function updateCommittedState(queue, inventory, key, record, recordFile) {
  const replacement = queue.items[key];
  if (!replacement) throw new Error(`Generated key ${key} is not in the queue`);
  if (replacement.mode !== 'generated' || replacement.fromCover !== replacement.toCover) {
    throw new Error(`${key}: only same-URL article-hero generations are allowed`);
  }
  replacement.status = 'generated';
  replacement.recordFile = recordFile;
  replacement.generatedAssetId = record.generated.assetId;
  replacement.provider = record.generated.provider;
  replacement.generatedAt = record.generated.generatedAt;
  const inventoryItem = inventory.covers[key];
  if (inventoryItem?.replacement) {
    inventoryItem.replacement.status = 'generated';
    inventoryItem.replacement.recordFile = recordFile;
    inventoryItem.generated = {
      provider: record.generated.provider,
      assetId: record.generated.assetId,
      imageUrl: record.generated.imageUrl,
      evidence: 'generated-engine-record',
    };
  }
}

async function main() {
  const { limit, reconcileOnly } = parseArgs(process.argv.slice(2));
  const queue = readJson(QUEUE_PATH, null);
  const inventory = readJson(INVENTORY_PATH, null);
  const currentRegistry = readJson(REGISTRY_PATH, { schema: 1, cdnPrefix: '/images/blog/', assetCount: 0, assets: [] });
  if (!queue || !inventory) throw new Error('Run materialize-blog-cover-ledger.mjs first');
  const assets = new Map((currentRegistry.assets || []).map((record) => [record.assetId, record]));
  if (!validateGeneratedImageRegistry({ ...currentRegistry, assetCount: assets.size, assets: [...assets.values()] }, { scope: 'article-hero' }).valid) {
    throw new Error('Existing blog generated registry is invalid');
  }
  for (const [key, item] of Object.entries(queue.items)) {
    const existing = assets.get(key);
    const recordFile = path.join(RECORD_DIR, `${key}.json`);
    if (item.mode === 'generated' && item.status !== 'generated' && existing && fs.existsSync(recordFile)) {
      updateCommittedState(queue, inventory, key, { generated: existing }, `packages/articles/content/image-credits/blog/${key}.json`);
    }
  }
  writeJson(QUEUE_PATH, queue);
  writeJson(INVENTORY_PATH, inventory);
  const pending = Object.entries(queue.items)
    .filter(([key, item]) => {
      if (item.mode !== 'generated' || item.fromCover !== item.toCover) {
        throw new Error(`${key}: generation queue contains a cross-article replacement`);
      }
      return item.status !== 'generated' && !assets.has(key);
    })
    .sort(([, a], [, b]) => (a.proofLevel - b.proofLevel) || (b.priority - a.priority) || a.fromCover.localeCompare(b.fromCover));
  const remainingBudget = MAX_TOTAL - assets.size;
  const todo = pending.slice(0, Math.min(limit, remainingBudget));
  if (reconcileOnly) {
    const output = { requested: 0, generated: 0, completedKeys: [], failed: 0, remaining: pending.length, failures: [], reconciled: assets.size };
    writeJson(path.join(ROOT, 'data/blog-cover-generation-last-run.json'), output);
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const failures = [];
  const completedKeys = [];
  let generated = 0;
  for (const [key, item] of todo) {
    const articleId = inventory.covers[key]?.references?.[0]?.id || key;
    const subject = `Swiss border editorial illustration for article ${articleId}: ${words(key)}`;
    try {
      const result = await generateImageFromSpec({
        scope: 'article-hero',
        subject,
        area: 'Ticino, Lombardy and the Swiss Italian border region',
        season: 'all seasons',
        category: inventory.covers[key]?.references?.[0]?.category || 'editorial',
        variant: `historical-cover-repair-${key}`,
        assetId: key,
      }, {
        outputDir: OUTPUT_DIR,
        assetId: key,
        maxAttempts: 3,
      });
      const record = articleHeroRecord(result.record);
      if (record.cover !== item.toCover || record.generated.imageUrl !== item.toCover) {
        throw new Error(`${key}: generated cover must remain ${item.toCover}`);
      }
      ensureSparsePath(`public/images/blog/${key}.webp`);
      fs.copyFileSync(result.filePath, path.join(ROOT, 'public/images/blog', `${key}.webp`));
      const recordFile = writeAssetRecord(key, record);
      assets.set(record.generated.assetId, record.generated);
      persistRegistry([...assets.values()]);
      updateCommittedState(queue, inventory, key, { generated: record.generated }, recordFile);
      writeJson(QUEUE_PATH, queue);
      writeJson(INVENTORY_PATH, inventory);
      generated += 1;
      completedKeys.push(key);
      console.error(`[blog-cover-generator] ${generated}/${todo.length} ${key} (${record.generated.provider})`);
    } catch (error) {
      failures.push({ key, error: String(error?.message || error) });
      console.error(`[blog-cover-generator] failed ${key}: ${String(error?.message || error)}`);
    }
  }
  const output = { requested: todo.length, generated, completedKeys, failed: failures.length, remaining: pending.length - generated, failures };
  writeJson(path.join(ROOT, 'data/blog-cover-generation-last-run.json'), output);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
