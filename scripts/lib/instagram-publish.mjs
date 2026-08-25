/**
 * instagram-publish.mjs — the Instagram Graph API carousel publish layer,
 * extracted from scripts/post-to-instagram.mjs for the same reason as its
 * TikTok twin (scripts/lib/tiktok-publish.mjs): the poster calls main() and
 * process.exit(0) at module scope, so importing it from a test killed the test
 * process, and the request/response shape had therefore never been exercised —
 * not against a live token (no App Review yet) and not even against a mock.
 *
 * The three-step flow is the part worth pinning, because none of its steps is
 * guessable from the others:
 *
 *   1. one child container per image   POST {ig-user-id}/media
 *                                      image_url + is_carousel_item=true
 *   2. every child polled to FINISHED  GET  {container-id}?fields=status_code
 *   3. carousel container, then publish POST {ig-user-id}/media
 *                                      media_type=CAROUSEL + children=…
 *                                      POST {ig-user-id}/media_publish
 *
 * Step 2 is the one that bites: Meta returns a container id immediately and
 * rejects it at publish time if it is not FINISHED yet, so skipping the poll
 * produces an error that reads like a permissions problem. The poll budget
 * (5 attempts × 2s) is deliberately short and is the thing to re-measure
 * against a real token — see the issue this file's PR reclassified.
 *
 * Everything is fail-soft: every Graph error is returned as `{ok:false,reason}`
 * and never thrown, matching the poster's own posture.
 */
import { fetchRetry, sleep } from './ga4-service-account.mjs';
import { GRAPH_API, GRAPH_API_VERSION } from './social-post-utils.mjs';

// Re-exported so the contract test and the poster read the base from here
// without a second literal: the single definition lives in social-post-utils.
export { GRAPH_API, GRAPH_API_VERSION };
export const CONTAINER_STATUS_MAX_ATTEMPTS = 5;
export const CONTAINER_STATUS_DELAY_MS = 2000;

/**
 * One form-encoded POST against the Graph API.
 *
 * Note the verdict rule differs from TikTok's: Meta signals failure with a
 * non-2xx AND an `error` object, so the presence of `error` alone is enough.
 */
export async function graphPost(pathSuffix, params, accessToken, { fetchImpl = fetchRetry } = {}) {
  const body = new URLSearchParams({ ...params, access_token: accessToken });
  const res = await fetchImpl(`${GRAPH_API}/${pathSuffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res?.ok || data.error) {
    return { ok: false, status: res?.status, error: data.error || { message: 'no response body' } };
  }
  return { ok: true, data };
}

export async function waitForContainerReady(containerId, accessToken, opts = {}) {
  const { fetchImpl = fetchRetry, sleepImpl = sleep, maxAttempts = CONTAINER_STATUS_MAX_ATTEMPTS, delayMs = CONTAINER_STATUS_DELAY_MS } = opts;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetchImpl(
      `${GRAPH_API}/${containerId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`,
    );
    const data = await res?.json().catch(() => ({}));
    const status = data?.status_code;
    if (status === 'FINISHED') return true;
    if (status === 'ERROR' || status === 'EXPIRED') return false;
    await sleepImpl(delayMs);
  }
  return false;
}

/**
 * Full carousel publish: child containers → poll → carousel container →
 * publish. Returns `{ok:true, mediaId}` or `{ok:false, reason}`. Never throws.
 */
export async function publishCarousel({ igUserId, accessToken, imageUrls, caption, ...opts }) {
  const { fetchImpl = fetchRetry } = opts;
  const childIds = [];
  for (const imageUrl of imageUrls) {
    const res = await graphPost(`${igUserId}/media`, { image_url: imageUrl, is_carousel_item: 'true' }, accessToken, { fetchImpl });
    if (!res.ok) return { ok: false, reason: `child container failed: ${res.error?.message || res.status}` };
    childIds.push(res.data.id);
  }

  for (const id of childIds) {
    const ready = await waitForContainerReady(id, accessToken, opts);
    if (!ready) return { ok: false, reason: `child container ${id} never reached FINISHED` };
  }

  const containerRes = await graphPost(
    `${igUserId}/media`,
    { media_type: 'CAROUSEL', children: childIds.join(','), caption },
    accessToken,
    { fetchImpl },
  );
  if (!containerRes.ok) {
    return { ok: false, reason: `carousel container failed: ${containerRes.error?.message || containerRes.status}` };
  }

  const publishRes = await graphPost(`${igUserId}/media_publish`, { creation_id: containerRes.data.id }, accessToken, { fetchImpl });
  if (!publishRes.ok) {
    return { ok: false, reason: `publish failed: ${publishRes.error?.message || publishRes.status}` };
  }
  return { ok: true, mediaId: publishRes.data.id };
}
