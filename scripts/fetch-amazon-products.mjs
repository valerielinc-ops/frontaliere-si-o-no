#!/usr/bin/env node
/**
 * FRO-335: Fetch Amazon product data via Creators API (build-time).
 *
 * Authenticates with OAuth 2.0 client_credentials flow (v3.x LwA credentials),
 * fetches product data (images, prices, availability) for the curated ASINs,
 * and writes the result to data/amazon-products.json for the Vite build to consume.
 *
 * Environment variables (loaded from Firebase Remote Config via load-rc-env.mjs):
 *   AMAZON_CREATOR_ID     — LwA client ID (amzn1.application-oa2-client.xxx)
 *   AMAZON_CREATOR_SECRET — LwA client secret (amzn1.oa2-cs.v1.xxx)
 *
 * Auth docs: https://programma-affiliazione.amazon.it/creatorsapi/docs/en-us/introduction
 *   - EU v3.x token endpoint: api.amazon.co.uk/auth/o2/token
 *   - Scope: creatorsapi::default
 *   - Content-Type: application/json (not form-encoded)
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

// ── Load RC env vars if not already present ──────────────────
// In CI, load-rc-env.mjs runs as a prior step and exports to $GITHUB_ENV.
// For local runs, try to load them inline.
async function ensureEnvVars() {
  if (process.env.AMAZON_CREATOR_ID && process.env.AMAZON_CREATOR_SECRET) {
    return; // already set (CI or manual export)
  }
  // Try loading from Firebase RC via load-rc-env.mjs (local dev)
  try {
    const loadRcEnv = path.join(ROOT, 'scripts', 'load-rc-env.mjs');
    if (fs.existsSync(loadRcEnv)) {
      console.log('🔄 Loading env vars from Firebase Remote Config...');
      const { execSync } = await import('node:child_process');
      const output = execSync(`node "${loadRcEnv}"`, {
        encoding: 'utf-8',
        env: { ...process.env },
        timeout: 30_000,
      });
      // Parse export lines from stdout (local mode outputs "export KEY=VALUE")
      for (const line of output.split('\n')) {
        const match = line.match(/^export\s+(\w+)=(.*)$/);
        if (match) {
          const [, key, value] = match;
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️  Failed to load RC env vars: ${err.message}`);
  }
}

// ── Curated ASINs (from creatorProductsService.ts) ───────────
const ASINS = [
  // Fisco & Finanza
  '8820383550',
  '8891657401',
  'B0BGQ7KHYH',
  'B00004UFNR',
  '8891425065',
  'B0BN2YRQJL',
  // Trasporto & Pendolarismo
  'B0CF9YV5SL',
  'B0CXKZ98QP',
  'B0B6QFFTMR',
  'B01M0QFWFH',
  'B08SBR4GRG',
  'B01M3TIVPW',
  // Lavoro & Carriera
  '8869875968',
  '3038810371',
  'B09B8DWL3S',
  'B0C8PSQWB4',
  'B08CKGH98Z',
  'B0CKN3TNM3',
  // Casa & Risparmio
  'B0B9S4Y4RN',
  '8804734019',
  'B0BVD1B58J',
  'B07FDFSK1Q',
  'B09YVCSLSN',
  // Salute & Benessere
  '3038811622',
  'B071V2F8WS',
  'B07D5HKRXS',
  'B0716G63BQ',
];

const PARTNER_TAG = 'luigi066-21';
const MARKETPLACE = 'www.amazon.it';

// ── OAuth 2.0 client_credentials flow (v3.x LwA, EU endpoint) ────────────────

async function getAccessToken(clientId, clientSecret) {
  // EU v3.x token endpoint (for IT, UK, DE, FR, ES, NL, etc.)
  const tokenUrl = 'https://api.amazon.co.uk/auth/o2/token';
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'creatorsapi::default',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OAuth token request failed (${res.status}): ${body.slice(0, 2000)}`);
  }
  const data = await res.json();
  return data.access_token;
}

// ── Fetch product data via Creators API ──────────────────────

async function fetchProducts(accessToken) {
  const res = await fetch('https://creatorsapi.amazon/catalog/v1/getItems', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'x-marketplace': MARKETPLACE,
    },
    body: JSON.stringify({
      itemIds: ASINS,
      itemIdType: 'ASIN',
      marketplace: MARKETPLACE,
      partnerTag: PARTNER_TAG,
      resources: [
        'images.primary.medium',
        'itemInfo.title',
        'offersV2.listings.price',
      ],
    }),
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
  const items = apiResponse?.itemsResult?.items || [];
  return items.map((item) => {
    const asin = item.asin || '';
    const title = item.itemInfo?.title?.displayValue || '';
    const imageUrl = item.images?.primary?.medium?.url || '';
    const listing = item.offersV2?.listings?.[0];
    const price = listing?.price?.displayAmount || '';
    const priceAmount = listing?.price?.amount || 0;
    const available = !!item.offersV2?.listings?.length;
    const affiliateUrl = item.detailPageURL
      || `https://${MARKETPLACE}/dp/${asin}?tag=${PARTNER_TAG}&linkCode=ll1`;

    return { asin, title, imageUrl, price, priceAmount, available, affiliateUrl };
  });
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  await ensureEnvVars();

  const clientId = process.env.AMAZON_CREATOR_ID;
  const clientSecret = process.env.AMAZON_CREATOR_SECRET;

  if (!clientId || !clientSecret) {
    console.warn('⚠️  AMAZON_CREATOR_ID or AMAZON_CREATOR_SECRET not set — writing fallback JSON');
    writeFallback('credentials_missing');
    return;
  }

  try {
    console.log('🔑 Authenticating with Amazon Creators API (EU v3.x)...');
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

function buildStaticProducts() {
  // Associates image widget — publicly accessible for any Amazon affiliate,
  // no API credentials required. Shows product image from Amazon CDN.
  return ASINS.map((asin) => ({
    asin,
    title: '',
    imageUrl: `https://images-na.ssl-images-amazon.com/images/P/${asin}.01._SL160_.jpg`,
    price: '',
    priceAmount: 0,
    available: true,
    affiliateUrl: `https://www.amazon.it/dp/${asin}?tag=${PARTNER_TAG}&linkCode=ll1`,
  }));
}

function writeFallback(reason) {
  // For API errors (credentials exist but API unavailable), still emit static
  // products with Associates image URLs so cards render in articles.
  const products = reason === 'credentials_missing' ? [] : buildStaticProducts();
  const output = {
    fetchedAt: new Date().toISOString(),
    source: 'fallback',
    reason,
    products,
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`📄 Wrote fallback JSON to ${path.relative(ROOT, OUTPUT_PATH)} (reason: ${reason}, products: ${products.length})`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  writeFallback('fatal_error');
});
