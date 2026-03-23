#!/usr/bin/env node
/**
 * FRO-335: Fetch Amazon product data via Creators API (build-time).
 *
 * Authenticates with OAuth 2.0 client_credentials flow, fetches product data
 * (images, prices, availability) for the 8 curated ASINs, and writes the
 * result to data/amazon-products.json for the Vite build to consume.
 *
 * Environment variables:
 *   AMAZON_CREATOR_ID     — OAuth client ID
 *   AMAZON_CREATOR_SECRET — OAuth client secret
 *
 * Usage:
 *   node scripts/fetch-amazon-products.mjs
 *
 * Graceful fallback: if the API is unreachable or credentials are missing,
 * writes a fallback JSON so the build always succeeds.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(ROOT, 'data', 'amazon-products.json');

// ── Curated ASINs (from creatorProductsService.ts) ───────────
const ASINS = [
  '8820383550',
  '8891657401',
  '8869875968',
  'B0CKN3TNM3',
  'B0CF9YV5SL',
  'B09YVCSLSN',
  'B0BGQ7KHYH',
  'B0B9S4Y4RN',
];

const PARTNER_TAG = 'luigi066-21';
const MARKETPLACE = 'www.amazon.it';

// ── OAuth 2.0 client_credentials flow ────────────────────────

async function getAccessToken(clientId, clientSecret) {
  const tokenUrl = 'https://api.amazon.com/auth/o2/token';
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'ProductAdvertisingAPI',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OAuth token request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.access_token;
}

// ── Fetch product data via Creators API ──────────────────────

async function fetchProducts(accessToken) {
  const url = new URL('https://api.amazon.it/creatorsapi/v1/items');
  url.searchParams.set('itemIds', ASINS.join(','));
  url.searchParams.set('resources', [
    'Images.Primary.Medium',
    'Offers.Listings.Price',
    'ItemInfo.Title',
  ].join(','));
  url.searchParams.set('partnerTag', PARTNER_TAG);
  url.searchParams.set('marketplace', MARKETPLACE);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Creators API request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return data;
}

// ── Transform API response to our schema ─────────────────────

function transformProducts(apiResponse) {
  const items = apiResponse?.ItemsResult?.Items || apiResponse?.items || [];
  return items.map((item) => {
    const asin = item.ASIN || item.asin || '';
    const title = item.ItemInfo?.Title?.DisplayValue || item.title || '';
    const imageUrl = item.Images?.Primary?.Medium?.URL || '';
    const price = item.Offers?.Listings?.[0]?.Price?.DisplayAmount || '';
    const priceAmount = item.Offers?.Listings?.[0]?.Price?.Amount || 0;
    const available = !!item.Offers?.Listings?.length;
    const affiliateUrl = `https://${MARKETPLACE}/dp/${asin}?tag=${PARTNER_TAG}&linkCode=ll1`;

    return { asin, title, imageUrl, price, priceAmount, available, affiliateUrl };
  });
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const clientId = process.env.AMAZON_CREATOR_ID;
  const clientSecret = process.env.AMAZON_CREATOR_SECRET;

  if (!clientId || !clientSecret) {
    console.warn('⚠️  AMAZON_CREATOR_ID or AMAZON_CREATOR_SECRET not set — writing fallback JSON');
    writeFallback('credentials_missing');
    return;
  }

  try {
    console.log('🔑 Authenticating with Amazon Creators API...');
    const token = await getAccessToken(clientId, clientSecret);

    console.log(`📦 Fetching ${ASINS.length} products...`);
    const apiResponse = await fetchProducts(token);

    const products = transformProducts(apiResponse);
    const output = {
      fetchedAt: new Date().toISOString(),
      source: 'creators_api',
      products,
    };

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');
    console.log(`✅ Wrote ${products.length} products to ${path.relative(ROOT, OUTPUT_PATH)}`);
  } catch (err) {
    console.error(`❌ Amazon Creators API failed: ${err.message}`);
    writeFallback('api_error');
  }
}

function writeFallback(reason) {
  const output = {
    fetchedAt: new Date().toISOString(),
    source: 'fallback',
    reason,
    products: [],
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`📄 Wrote fallback JSON to ${path.relative(ROOT, OUTPUT_PATH)} (reason: ${reason})`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  writeFallback('fatal_error');
});
