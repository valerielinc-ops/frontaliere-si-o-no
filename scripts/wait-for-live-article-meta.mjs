#!/usr/bin/env node
/**
 * Poll the live article URL until the deployed HTML exposes the expected OG metadata.
 *
 * Usage:
 *   node scripts/wait-for-live-article-meta.mjs <article-url> <expected-og-title> [expected-og-image]
 *
 * Exit codes:
 *   0 = live page matches expected metadata
 *   1 = timeout or hard validation failure
 */

const [, , rawUrl, expectedOgTitle = '', expectedOgImage = ''] = process.argv;

if (!rawUrl || !expectedOgTitle) {
  console.error('Usage: node scripts/wait-for-live-article-meta.mjs <article-url> <expected-og-title> [expected-og-image]');
  process.exit(1);
}

const url = rawUrl.trim();
const timeoutMs = Number(process.env.LIVE_ARTICLE_WAIT_TIMEOUT_MS || 12 * 60 * 1000);
const intervalMs = Number(process.env.LIVE_ARTICLE_WAIT_INTERVAL_MS || 15 * 1000);
const deadline = Date.now() + timeoutMs;

function extractMeta(html, selector) {
  const propertyRx = new RegExp(`<meta\\s+property=["']${selector}["']\\s+content=["']([^"']*)["']`, 'i');
  const nameRx = new RegExp(`<meta\\s+name=["']${selector}["']\\s+content=["']([^"']*)["']`, 'i');
  return html.match(propertyRx)?.[1] || html.match(nameRx)?.[1] || '';
}

function extractTitle(html) {
  return html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() || '';
}

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const expectedPath = new URL(url).pathname;

while (Date.now() < deadline) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'FrontaliereTicinoMetaWait/1.0 (+https://www.frontaliereticino.ch)',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
    });

    const html = await res.text();
    const title = normalize(extractTitle(html));
    const ogTitle = normalize(extractMeta(html, 'og:title'));
    const ogImage = normalize(extractMeta(html, 'og:image'));
    const ogUrl = normalize(extractMeta(html, 'og:url'));

    const titleMatches = ogTitle === normalize(expectedOgTitle);
    const imageMatches = !expectedOgImage || ogImage === normalize(expectedOgImage);
    const pathMatches = !!ogUrl && new URL(ogUrl).pathname === expectedPath;

    if (res.ok && titleMatches && imageMatches && pathMatches) {
      console.log(`✅ Live article metadata ready: ${url}`);
      console.log(`   og:title = ${ogTitle}`);
      console.log(`   og:image = ${ogImage}`);
      process.exit(0);
    }

    console.log(`⏳ Waiting for deployed article metadata...`);
    console.log(`   status   = ${res.status}`);
    console.log(`   <title>  = ${title || '(missing)'}`);
    console.log(`   og:title = ${ogTitle || '(missing)'}`);
    console.log(`   og:image = ${ogImage || '(missing)'}`);
    console.log(`   og:url   = ${ogUrl || '(missing)'}`);
  } catch (error) {
    console.log(`⏳ Live article not ready yet: ${error instanceof Error ? error.message : String(error)}`);
  }

  await sleep(intervalMs);
}

console.error(`❌ Timed out waiting for live article metadata at ${url}`);
process.exit(1);
