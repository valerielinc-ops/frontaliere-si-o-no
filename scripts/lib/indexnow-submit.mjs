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

import { DEFAULT_LIVE_CHECK_USER_AGENT } from './live-link-check.mjs';

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
 * Verify ownership before sending a batch. CDN propagation can briefly serve
 * 403/old content immediately after a Pages or edge publish, so one request is
 * not enough to decide that IndexNow is unavailable. The caller still receives
 * false after bounded retries and can fail the workflow visibly.
 */
export async function verifyIndexNowKey({ attempts = 4, delayMs = 2000 } = {}) {
  let lastReason = 'unknown error';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(KEY_LOCATION, {
        headers: {
          Accept: 'text/plain',
          'User-Agent': DEFAULT_LIVE_CHECK_USER_AGENT,
        },
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.text()).trim();
      if (response.ok && body === INDEXNOW_KEY) {
        return { ok: true, attempts: attempt, status: response.status };
      }
      lastReason = response.ok
        ? `content mismatch (${body.slice(0, 60)})`
        : `HTTP ${response.status} ${response.statusText}`;
    } catch (error) {
      lastReason = error?.message || String(error);
    }
    if (attempt < attempts && delayMs > 0) await sleep(delayMs * attempt);
  }
  return { ok: false, attempts, reason: lastReason };
}

/**
 * POST one batch of URLs to one endpoint, with bounded retry.
 * Never throws — returns a result object so a caller can keep going.
 */
export async function submitIndexNowBatch(endpoint, urlBatch, attempt = 1, { deadlineMs } = {}) {
  const engineName = new URL(endpoint).hostname;
  const payload = { host: HOST, key: INDEXNOW_KEY, keyLocation: KEY_LOCATION, urlList: urlBatch };
  const deadlineResult = () => ({
    ok: false,
    engine: engineName,
    error: 'deadline exceeded',
    deadlineExceeded: true,
    count: urlBatch.length,
  });
  const retry = async () => {
    if (attempt > MAX_RETRIES) return null;
    const waitMs = Number.isFinite(deadlineMs)
      ? Math.min(1000 * attempt, Math.max(0, deadlineMs - Date.now()))
      : 1000 * attempt;
    if (waitMs > 0) await sleep(waitMs);
    if (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs) return deadlineResult();
    return submitIndexNowBatch(endpoint, urlBatch, attempt + 1, { deadlineMs });
  };

  try {
    const remainingMs = Number.isFinite(deadlineMs) ? deadlineMs - Date.now() : 30_000;
    if (Number.isFinite(deadlineMs) && remainingMs <= 0) return deadlineResult();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': DEFAULT_LIVE_CHECK_USER_AGENT,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, remainingMs))),
    });

    if (response.ok || response.status === 202) {
      return { ok: true, engine: engineName, status: response.status, count: urlBatch.length };
    }

    // 429/5xx are worth another attempt; 4xx (bad key, bad host) never is.
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable) {
      const retried = await retry();
      if (retried) return retried;
      return { ok: false, engine: engineName, status: response.status, count: urlBatch.length };
    }
    return { ok: false, engine: engineName, status: response.status, count: urlBatch.length };
  } catch (err) {
    if (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs) return deadlineResult();
    const retried = await retry();
    if (retried) return retried;
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

/**
 * Submit URLs in bounded, ordered chunks rather than one full sitemap-sized
 * payload. The default is one URL per request for remediation loops, while a
 * caller may raise batchSize for a small deploy delta. Each batch stops at the
 * first endpoint that accepts it; IndexNow shares accepted submissions across
 * participating engines, so later endpoints are fallbacks, not extra required
 * deliveries. A batch remains failed if no endpoint accepts it.
 */
export async function submitIndexNowUrlsStreaming(
  urls,
  { endpoints = INDEXNOW_ENDPOINTS, batchSize = 1, delayMs = 750, deadlineMs, onBatch } = {},
) {
  const clean = [...new Set((urls || []).map((u) => String(u || '').trim()).filter(Boolean))];
  if (clean.length === 0) {
    return {
      submitted: 0,
      batches: 0,
      accepted: 0,
      attempted: 0,
      remaining: 0,
      failed: [],
      notAttempted: [],
      stoppedByDeadline: false,
      results: [],
    };
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new TypeError('batchSize deve essere un intero positivo');
  }

  const batches = [];
  for (let index = 0; index < clean.length; index += batchSize) {
    batches.push(clean.slice(index, index + batchSize));
  }

  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new TypeError('serve almeno un endpoint IndexNow');
  }

  const results = [];
  let accepted = 0;
  let attempted = 0;
  let attemptedBatches = 0;
  const failed = [];
  let stoppedByDeadline = false;
  for (let index = 0; index < batches.length; index += 1) {
    if (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs) {
      stoppedByDeadline = true;
      break;
    }

    const batch = batches[index];
    const attempts = [];
    let batchResult;

    for (const endpoint of endpoints) {
      if (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs) {
        stoppedByDeadline = true;
        break;
      }
      const attempt = await submitIndexNowBatch(endpoint, batch, 1, { deadlineMs });
      attempts.push(attempt);
      batchResult = attempt;
      if (attempt.ok) break;
      if (attempt.deadlineExceeded) {
        stoppedByDeadline = true;
        break;
      }
    }

    if (!batchResult) break;
    results.push({ ...batchResult, attempts });
    attempted += batch.length;
    attemptedBatches += 1;
    const acceptedUrls = batchResult.ok ? batch : [];
    if (batchResult.ok) accepted += batch.length;
    else failed.push(...batch);
    await onBatch?.({
      index: index + 1,
      total: batches.length,
      accepted: Boolean(batchResult.ok),
      attemptedUrls: batch,
      acceptedUrls,
    });

    if (stoppedByDeadline) break;
    if (index < batches.length - 1 && delayMs > 0) {
      const waitMs = Number.isFinite(deadlineMs)
        ? Math.min(delayMs, Math.max(0, deadlineMs - Date.now()))
        : delayMs;
      if (waitMs > 0) await sleep(waitMs);
    }
  }
  const hasDeadline = Number.isFinite(deadlineMs);
  const notAttempted = clean.slice(attempted);
  return {
    submitted: hasDeadline ? attempted : clean.length,
    batches: hasDeadline ? attemptedBatches : batches.length,
    accepted,
    attempted,
    remaining: failed.length + notAttempted.length,
    failed,
    notAttempted,
    stoppedByDeadline,
    results,
  };
}
