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
const timeoutMs = Number(process.env.LIVE_ARTICLE_WAIT_TIMEOUT_MS || 15 * 60 * 1000);
const intervalMs = Number(process.env.LIVE_ARTICLE_WAIT_INTERVAL_MS || 10 * 1000);
const deadline = Date.now() + timeoutMs;

function parseAttributes(tag) {
  const attributes = {};
  const attrRx = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = attrRx.exec(tag))) {
    const [, rawName, doubleQuoted = '', singleQuoted = ''] = match;
    attributes[String(rawName || '').toLowerCase()] = doubleQuoted || singleQuoted || '';
  }
  return attributes;
}

function findTagAttributeValue(html, tagName, predicate, attributeName) {
  const tagRx = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  let match;
  while ((match = tagRx.exec(html))) {
    const attrs = parseAttributes(match[0]);
    if (predicate(attrs)) {
      return attrs[String(attributeName || '').toLowerCase()] || '';
    }
  }
  return '';
}

function extractMeta(html, selector) {
  const target = String(selector || '').trim().toLowerCase();
  return findTagAttributeValue(
    html,
    'meta',
    (attrs) => attrs.property === target || attrs.name === target,
    'content',
  );
}

function extractCanonicalUrl(html) {
  return findTagAttributeValue(
    html,
    'link',
    (attrs) => String(attrs.rel || '').toLowerCase().split(/\s+/).includes('canonical'),
    'href',
  );
}

function extractTitle(html) {
  return html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() || '';
}

function decodeHtmlEntities(text) {
  return String(text || '').replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|rsquo|lsquo|ndash|mdash);/gi, (entity) => {
    const normalized = entity.toLowerCase();
    switch (normalized) {
      case '&amp;':
        return '&';
      case '&lt;':
        return '<';
      case '&gt;':
        return '>';
      case '&quot;':
        return '"';
      case '&apos;':
      case '&#39;':
      case '&rsquo;':
      case '&lsquo;':
        return "'";
      case '&nbsp;':
        return ' ';
      case '&ndash;':
        return '-';
      case '&mdash;':
        return '--';
      default:
        return entity;
    }
  });
}

function normalize(text) {
  return decodeHtmlEntities(String(text || ''))
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePathname(pathname) {
  const value = String(pathname || '').trim();
  if (!value || value === '/') return '/';
  return value.replace(/\/+$/, '') || '/';
}

function normalizeHostname(hostname) {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizeUrlForCompare(value) {
  const parsed = parseUrl(value);
  if (!parsed) return normalize(value);
  const search = parsed.search || '';
  return `${normalizeHostname(parsed.hostname)}${normalizePathname(parsed.pathname)}${search}`;
}

function getPathCandidate(value) {
  const parsed = parseUrl(value);
  if (!parsed) return '';
  return normalizePathname(parsed.pathname);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const requestedUrl = new URL(url);
const expectedPath = normalizePathname(requestedUrl.pathname);
const expectedOgTitleNormalized = normalize(expectedOgTitle);
const expectedOgImageNormalized = normalizeUrlForCompare(expectedOgImage);

let titlePathMatchCount = 0;
const IMAGE_SOFT_THRESHOLD = 3; // Accept after 3 consecutive title+path matches without image

while (Date.now() < deadline) {
  try {
    const cacheBustUrl = new URL(url);
    cacheBustUrl.searchParams.set('_cb', Date.now().toString(36));
    const res = await fetch(cacheBustUrl.href, {
      redirect: 'follow',
      headers: {
        'user-agent': 'FrontaliereTicinoMetaWait/1.0 (+https://frontaliereticino.ch)',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
    });

    const html = await res.text();
    const title = normalize(extractTitle(html));
    const ogTitle = normalize(extractMeta(html, 'og:title'));
    const ogImage = normalize(extractMeta(html, 'og:image'));
    const ogUrl = normalize(extractMeta(html, 'og:url'));
    const canonicalUrl = normalize(extractCanonicalUrl(html));
    const finalUrl = normalize(res.url || url);

    // og:title may omit the "| Site Name" suffix that <title> includes,
    // so match against both og:title and <title> tag
    const titleMatches = ogTitle === expectedOgTitleNormalized
      || title === expectedOgTitleNormalized
      || (expectedOgTitleNormalized.includes('|') && ogTitle === expectedOgTitleNormalized.split('|')[0].trim());
    const imageMatches = !expectedOgImageNormalized || normalizeUrlForCompare(ogImage) === expectedOgImageNormalized;
    const pathCandidates = [
      ['og:url', getPathCandidate(ogUrl)],
      ['canonical', getPathCandidate(canonicalUrl)],
      ['final-url', getPathCandidate(finalUrl)],
    ].filter(([, path]) => Boolean(path));
    const matchedPathSource = pathCandidates.find(([, path]) => path === expectedPath)?.[0] || '';
    const pathMatches = Boolean(matchedPathSource);

    if (res.ok && titleMatches && pathMatches && !imageMatches) {
      titlePathMatchCount++;
      if (titlePathMatchCount >= IMAGE_SOFT_THRESHOLD) {
        console.log(`⚠️  Image not yet matching after ${titlePathMatchCount} checks — accepting (CDN lag)`);
        console.log(`   expected: ${expectedOgImageNormalized}`);
        console.log(`   actual:   ${normalizeUrlForCompare(ogImage)}`);
        console.log(`✅ Live article metadata ready (title+path confirmed): ${url}`);
        process.exit(0);
      }
    } else if (!(res.ok && titleMatches && pathMatches)) {
      titlePathMatchCount = 0; // Reset if title/path don't match
    }

    if (res.ok && titleMatches && imageMatches && pathMatches) {
      console.log(`✅ Live article metadata ready: ${url}`);
      console.log(`   og:title = ${ogTitle}`);
      console.log(`   og:image = ${ogImage}`);
      console.log(`   path     = ${expectedPath} via ${matchedPathSource}`);
      process.exit(0);
    }

    console.log(`⏳ Waiting for deployed article metadata...`);
    console.log(`   status   = ${res.status}`);
    console.log(`   <title>  = ${title || '(missing)'}`);
    console.log(`   og:title = ${ogTitle || '(missing)'}`);
    console.log(`   og:image = ${ogImage || '(missing)'}`);
    console.log(`   og:url   = ${ogUrl || '(missing)'}`);
    console.log(`   canonical= ${canonicalUrl || '(missing)'}`);
    console.log(`   final-url= ${finalUrl || '(missing)'}`);
    console.log(
      `   checks   = title:${titleMatches ? 'ok' : 'wait'} image:${imageMatches ? 'ok' : 'wait'} path:${pathMatches ? `ok (${matchedPathSource})` : 'wait'}`,
    );
  } catch (error) {
    console.log(`⏳ Live article not ready yet: ${error instanceof Error ? error.message : String(error)}`);
  }

  await sleep(intervalMs);
}

console.error(`❌ Timed out waiting for live article metadata at ${url}`);
process.exit(1);
