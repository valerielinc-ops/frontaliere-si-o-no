/**
 * Mailtrap Suppressions API client.
 *
 * Used ONLY to look up + remove a suppression for one address we already
 * know is suppressed (from our own Firestore data) — never to enumerate or
 * classify the backlog. Live testing 2026-07-22 showed the bulk list does
 * not paginate (`?page=1/2/100`, `?per_page=100` all return the identical
 * fixed ~8 records) and the `?email=` filter itself sometimes misses
 * addresses that are, at that exact moment, genuinely suppressed — so
 * `findSuppression()` result is used opportunistically (delete it if found,
 * proceed anyway if not) rather than as a gate. See
 * scripts/lib/mailtrapSuppressionRetry.mjs for the eligibility policy this
 * unreliability led to.
 *
 * Docs: https://docs.mailtrap.io/developers/email-sending/suppressions.md
 * Observed rate limit: `x-ratelimit-limit: 150` header on every response
 * (window not specified) — callers MUST pace calls; see MIN_API_CALL_INTERVAL_MS.
 */

const BASE = 'https://mailtrap.io/api';

// Observed 429 after ~10 rapid unfiltered-list calls; `x-ratelimit-limit: 150`
// on every response since. Pace comfortably under either reading.
export const MIN_API_CALL_INTERVAL_MS = 6000;

export async function fetchMailtrapAccountId(token) {
  const res = await fetch(`${BASE}/accounts`, { headers: { 'Api-Token': token } });
  if (!res.ok) return null;
  const accounts = await res.json();
  return accounts[0]?.id ?? null;
}

/**
 * Look up the current suppression record for one address, if any. May
 * return null for an address that IS actually suppressed (see module
 * docstring) — callers must not treat null as proof the address is clear.
 * @returns {Promise<{id:string, type:string, email:string, created_at:string, message_bounce_category:string|null}|null>}
 */
export async function findSuppression(token, accountId, email) {
  const res = await fetch(
    `${BASE}/accounts/${accountId}/suppressions?email=${encodeURIComponent(email)}`,
    { headers: { 'Api-Token': token } },
  );
  if (!res.ok) throw new Error(`Mailtrap suppression lookup for ${email} → HTTP ${res.status}`);
  const records = await res.json();
  if (!Array.isArray(records) || records.length === 0) return null;
  // Most recent first, in case an address was suppressed more than once.
  records.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return records[0];
}

/**
 * Remove an address from Mailtrap's suppression list so the cascade can
 * genuinely retry delivery to it (leaving the provider-side entry in place
 * would silently drop any future send routed back through Mailtrap).
 * @returns {Promise<boolean>} true if removed (or already gone/not found)
 */
export async function deleteSuppression(token, accountId, suppressionId) {
  const res = await fetch(`${BASE}/accounts/${accountId}/suppressions/${suppressionId}`, {
    method: 'DELETE',
    headers: { 'Api-Token': token },
  });
  // 404 = already removed (e.g. a prior run raced with us) — treat as success.
  return res.ok || res.status === 404;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
