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

// ── Curated ASINs with CDN image IDs (from creatorProductsService.ts) ───────────
// imageId: the Amazon CDN image identifier from m.media-amazon.com/images/I/{imageId}
const PRODUCTS = [
  // Fisco & Finanza
  { asin: '8820396246', imageId: '61T4a87qvXL' },
  { asin: 'B0F7DS11QM', imageId: '71EXhOHXu8L' },
  { asin: 'B0DMVCCQVR', imageId: '51mDwIbT31L' },
  { asin: 'B005D7H39G', imageId: '61Mhyvb0TfL' },
  { asin: 'B0GPRG8139', imageId: '61XBQ8fh7VL' },
  { asin: 'B07RQWZY34', imageId: '61pwfbAqa4L' },
  // Trasporto & Pendolarismo
  { asin: 'B0CVXDGNWP', imageId: '71hjyQv4u3L' },
  { asin: 'B0FMRG6J3T', imageId: '81xjrTmX5SL' },
  { asin: 'B0F21QKF44', imageId: '613hCCJGB3L' },
  { asin: 'B096RRKV2Y', imageId: '71OqETd1iDL' },
  { asin: 'B0FF4X2JB9', imageId: '61n+148j0uL' },
  { asin: 'B01BNITJOU', imageId: '21MjMFj7JAL' },
  // Lavoro & Carriera
  { asin: '8858345258', imageId: '51R75cc+GuL' },
  { asin: 'B0C5BCCCVG', imageId: '71PsXIVtmXL' },
  { asin: 'B09ZKXV1MY', imageId: '610JhJ3RWuL' },
  { asin: 'B0F12Q56RZ', imageId: '71n1M3fhlJL' },
  { asin: 'B08PV7XY8M', imageId: '616MA59OzuL' },
  { asin: 'B0CCNQP9F2', imageId: '61lKZJiIyVL' },
  // Casa & Risparmio
  { asin: 'B072QR1S3T', imageId: '71Y2r1pgBkL' },
  { asin: 'B0GG3RXDML', imageId: '71KneLITCuL' },
  { asin: 'B0D8KH4LNB', imageId: '51IqMiHCMQL' },
  { asin: 'B0CH4WGRQQ', imageId: '61MFmJpKvuL' },
  { asin: 'B0DFC7Q2GK', imageId: '71dbom9FTrL' },
  // Salute & Benessere
  { asin: 'B0F6NDGT7W', imageId: '61FwkENkulL' },
  { asin: 'B0CKF3PGDV', imageId: '61NaavrxwVL' },
  { asin: 'B0GF1RX5RK', imageId: '615TKlZZ4hL' },
  { asin: 'B07FRPXF44', imageId: '61mSrFlJh8L' },
  // Produttività & Smart Working (extra)
  { asin: 'B0FCS3SX38', imageId: '71Bzz-P3oDL' },
  { asin: 'B0DP4VYQ9N', imageId: '61XXU2vYucL' },
  { asin: 'B0F1CN972G', imageId: '61DFtmDd6gL' },
  { asin: 'B018INW0ZI', imageId: '71tIA7Z3y0L' },
  { asin: 'B07ZCYS2LJ', imageId: '51YklVyO9-L' },
  // Viaggio & Frontiera (extra)
  { asin: 'B0DTHW2PPQ', imageId: '61xb3t+4c0L' },
  { asin: 'B0FMRTXDHH', imageId: '81FgqqI9EML' },
  { asin: 'B0DMVVMF2C', imageId: '71INVW4QIRL' },
  { asin: 'B07Q72ZQGG', imageId: '81qEnzfwvPL' },
];
const ASINS = PRODUCTS.map(p => p.asin);
const IMAGE_BY_ASIN = Object.fromEntries(PRODUCTS.map(p => [p.asin, p.imageId]));

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
  // Use Amazon CDN image URLs (m.media-amazon.com/images/I/) — stable, fast, no auth.
  // _AC_UL320_ = auto-crop, 320px height (4x resolution at 72px display).
  return PRODUCTS.map(({ asin, imageId }) => ({
    asin,
    title: '',
    imageUrl: imageId ? `https://m.media-amazon.com/images/I/${imageId}._AC_UL320_.jpg` : '',
    price: '',
    priceAmount: 0,
    available: true,
    affiliateUrl: `https://www.amazon.it/dp/${asin}?tag=${PARTNER_TAG}&linkCode=ll1`,
  }));
}

function writeFallback(reason) {
  // Always emit static products with CDN image URLs so cards render in articles.
  // Even without API credentials, the hardcoded imageIds provide reliable images.
  const products = buildStaticProducts();
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
