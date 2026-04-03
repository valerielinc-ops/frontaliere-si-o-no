#!/usr/bin/env node
/**
 * Validate Amazon affiliate product links and images.
 *
 * Checks every ASIN in data/amazon-products.json:
 *   1. Product page (amazon.it/dp/{ASIN}) returns HTTP 200
 *   2. CDN image URL returns HTTP 200
 *
 * Exit codes:
 *   0 — all products valid
 *   1 — one or more products broken (details on stdout as JSON)
 *
 * Usage:
 *   node scripts/validate-amazon-products.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'data', 'amazon-products.json');

const CONCURRENCY = 5;
const TIMEOUT_MS = 15_000;

async function checkUrl(url, label) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FrontaliereBot/1.0)' },
    });
    return { url, label, status: res.status, ok: res.status >= 200 && res.status < 400 };
  } catch (err) {
    return { url, label, status: 'ERROR', ok: false, error: err.message };
  }
}

async function main() {
  if (!fs.existsSync(DATA_PATH)) {
    console.error('❌ data/amazon-products.json not found');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const products = data.products || [];

  if (products.length === 0) {
    console.error('❌ No products found in data file');
    process.exit(1);
  }

  console.log(`🔍 Validating ${products.length} Amazon products...\n`);

  const results = [];

  // Process in batches to avoid hammering Amazon
  for (let i = 0; i < products.length; i += CONCURRENCY) {
    const batch = products.slice(i, i + CONCURRENCY);
    const checks = batch.flatMap((p) => [
      checkUrl(`https://www.amazon.it/dp/${p.asin}`, `product:${p.asin}`),
      ...(p.imageUrl ? [checkUrl(p.imageUrl, `image:${p.asin}`)] : []),
    ]);
    const batchResults = await Promise.all(checks);
    results.push(...batchResults);

    // Rate limit between batches
    if (i + CONCURRENCY < products.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const broken = results.filter((r) => !r.ok);
  const brokenProducts = broken.filter((r) => r.label.startsWith('product:'));
  const brokenImages = broken.filter((r) => r.label.startsWith('image:'));

  console.log(`✅ Valid: ${results.length - broken.length}/${results.length}`);

  if (broken.length > 0) {
    console.log(`\n❌ Broken product pages: ${brokenProducts.length}`);
    for (const b of brokenProducts) {
      console.log(`   ${b.label} → ${b.status} ${b.error || ''}`);
    }
    console.log(`❌ Broken images: ${brokenImages.length}`);
    for (const b of brokenImages) {
      console.log(`   ${b.label} → ${b.status} ${b.error || ''}`);
    }
  }

  // Output structured JSON for the workflow to parse
  const output = {
    total: products.length,
    checkedAt: new Date().toISOString(),
    brokenProducts: brokenProducts.map((b) => ({
      asin: b.label.replace('product:', ''),
      status: b.status,
      error: b.error || null,
    })),
    brokenImages: brokenImages.map((b) => ({
      asin: b.label.replace('image:', ''),
      status: b.status,
      error: b.error || null,
    })),
  };

  // Write to stdout for workflow consumption
  console.log(`\n::set-output name=result::${JSON.stringify(output)}`);

  if (broken.length > 0) {
    process.exit(1);
  }

  console.log('\n✅ All Amazon products and images are valid');
}

main();
