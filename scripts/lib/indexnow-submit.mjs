/**
 * IndexNow submission primitives — shared by the sitemap-driven post-deploy
 * submitter (`scripts/submit-indexnow.js`) and the fast-publish path
 * (`.github/workflows/fast-publish-article.yml`, issue #4837).
 *
 * Why this module exists
 * ----------------------
 * `submit-indexnow.js` discovers URLs by parsing the *deployed sitemaps*. That
 * is correct for a full deploy, but useless for a fast-published article: the
 * article is live on its section shard within minutes while the sitemap is an
 * apex-only artifact that does not change until the next full deploy
 * (`infra/cloudflare-worker/locale-router.js:57`). Without a direct URL submit,
 * Google discovery would be accelerated (Indexing API takes URLs directly) but
 * Bing/Yandex discovery would not — an asymmetry with no reason to exist.
 *
 * The key/host/endpoint constants and the POST itself are therefore defined
 * ONCE here rather than duplicated, so the two callers can never drift on the
 * key or the payload shape (AGENTS.md Non-Negotiable #6).
 */

export const INDEXNOW_KEY = '39093e02a74b4a2dbf867c74bc53a7d8';
export const HOST = 'frontaliereticino.ch';
export const KEY_LOCATION = `https://${HOST}/${INDEXNOW_KEY}.txt`;

/** Endpoints are interchangeable per the IndexNow spec — any one of them
 *  propagates to the rest. We still post to all three because a single
 *  endpoint occasionally rate-limits or sits behind a Cloudflare challenge. */
export const INDEXNOW_ENDPOINTS = [
  'https://api.indexnow.org/indexnow',
  'https://www.bing.com/indexnow',
  'https://yandex.com/indexnow',
];

const MAX_RETRIES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST one batch of URLs to one endpoint, with bounded retry.
 * Never throws — returns a result object so a caller can keep going.
 */
export async function submitIndexNowBatch(endpoint, urlBatch, attempt = 1) {
  const engineName = new URL(endpoint).hostname;
  const payload = { host: HOST, key: INDEXNOW_KEY, keyLocation: KEY_LOCATION, urlList: urlBatch };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });

    if (response.ok || response.status === 202) {
      return { ok: true, engine: engineName, status: response.status, count: urlBatch.length };
    }

    // 429/5xx are worth another attempt; 4xx (bad key, bad host) never is.
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt <= MAX_RETRIES) {
      await sleep(1000 * attempt);
      return submitIndexNowBatch(endpoint, urlBatch, attempt + 1);
    }
    return { ok: false, engine: engineName, status: response.status, count: urlBatch.length };
  } catch (err) {
    if (attempt <= MAX_RETRIES) {
      await sleep(1000 * attempt);
      return submitIndexNowBatch(endpoint, urlBatch, attempt + 1);
    }
    return { ok: false, engine: engineName, error: err?.message || String(err), count: urlBatch.length };
  }
}

/**
 * Submit an explicit URL list to every endpoint. Used by the fast-publish path,
 * which already knows exactly which URLs went live and must not wait for a
 * sitemap to catch up.
 *
 * Best-effort by contract: resolves with a per-endpoint summary and never
 * rejects, because failing to notify Bing must not fail a publish that already
 * succeeded.
 */
export async function submitIndexNowUrls(urls, { endpoints = INDEXNOW_ENDPOINTS } = {}) {
  const clean = [...new Set((urls || []).map((u) => String(u || '').trim()).filter(Boolean))];
  if (clean.length === 0) return { submitted: 0, results: [] };

  const results = [];
  for (const endpoint of endpoints) {
    results.push(await submitIndexNowBatch(endpoint, clean));
  }
  return { submitted: clean.length, results };
}
