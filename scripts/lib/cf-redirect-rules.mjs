/**
 * cf-redirect-rules.mjs — shared idempotent-ensure logic for Cloudflare
 * Redirect Rules (phase `http_request_dynamic_redirect`), factored out of
 * ensure-image-cdn-redirect.mjs so a second ensure-*-redirect.mjs script
 * (ensure-cdn-fonts-redirect.mjs) doesn't duplicate the read/diff/PUT
 * boilerplate. Same idempotency contract as the original: a rule is looked
 * up by its `description`, updated in place if present-but-different,
 * appended if absent, left untouched if already current — and any read
 * failure other than "phase never had a ruleset" (CF error 10003) MUST
 * propagate rather than be treated as empty, or a subsequent full-array PUT
 * would clobber other rules already in the phase (data loss).
 */
import { REST_BASE } from './cf-analytics.mjs';

export const REDIRECT_RULE_PHASE = 'http_request_dynamic_redirect';

export async function cfFetch(token, path, init = {}) {
  const res = await fetch(`${REST_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`Cloudflare returned non-JSON (HTTP ${res.status}) for ${path}`);
  if (!json.success) {
    const err = new Error(`Cloudflare API error for ${path}: ${JSON.stringify(json.errors || [])}`);
    err.cfErrors = json.errors || [];
    err.httpStatus = res.status;
    throw err;
  }
  return json.result;
}

/**
 * Read the dynamic_redirect entrypoint rules. A phase that has NEVER had a
 * ruleset returns CF error code 10003 ("could not find entrypoint ruleset …") —
 * that is the only "genuinely empty" case, treated as `[]`. EVERY other failure
 * (429/5xx/network/missing-scope) MUST propagate: swallowing it here would make
 * `existing` empty and the subsequent full-array PUT would clobber any OTHER
 * redirect rules already in the phase (data loss). Reviewer 🔴 on #2396.
 */
export async function readEntrypointRules(token, zoneId, phase = REDIRECT_RULE_PHASE) {
  try {
    const result = await cfFetch(token, `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`);
    return Array.isArray(result?.rules) ? result.rules : [];
  } catch (err) {
    const noEntrypoint =
      err.httpStatus === 404 || (err.cfErrors || []).some((e) => e?.code === 10003);
    if (noEntrypoint) return [];
    throw err; // transient / auth / other — never proceed to a truncating PUT
  }
}

/**
 * Idempotently ensure `desired` (a single Redirect Rule, matched by
 * `desired.description`) is present and current in the phase's entrypoint
 * ruleset, without disturbing any other rule already there.
 * Returns { changed: boolean, dryRun: boolean }.
 */
export async function ensureRedirectRule(token, zoneId, desired, { dryRun = false, phase = REDIRECT_RULE_PHASE } = {}) {
  const existing = await readEntrypointRules(token, zoneId, phase);

  const idx = existing.findIndex((r) => r.description === desired.description);
  const next = existing.map((r) => ({
    // Strip server-managed fields so the PUT round-trips cleanly.
    action: r.action,
    action_parameters: r.action_parameters,
    expression: r.expression,
    description: r.description,
    enabled: r.enabled,
  }));

  if (idx >= 0) {
    const cur = existing[idx];
    const curFv = cur.action_parameters?.from_value;
    const wantFv = desired.action_parameters.from_value;
    if (cur.expression === desired.expression &&
        curFv?.target_url?.expression === wantFv.target_url.expression &&
        curFv?.status_code === wantFv.status_code &&
        curFv?.preserve_query_string === wantFv.preserve_query_string &&
        cur.enabled === desired.enabled) {
      console.log('✅ Redirect Rule already present and current — no change.');
      return { changed: false, dryRun };
    }
    next[idx] = desired;
    console.log('🔁 Updating existing Redirect Rule.');
  } else {
    next.push(desired);
    console.log('➕ Appending new Redirect Rule.');
  }

  console.log(`   expr: ${desired.expression}`);
  console.log(`   →     ${desired.action_parameters.from_value.target_url.expression} (${desired.action_parameters.from_value.status_code})`);
  if (dryRun) {
    console.log('🧪 --dry-run: no write.');
    return { changed: true, dryRun: true };
  }

  await cfFetch(token, `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, {
    method: 'PUT',
    body: JSON.stringify({ rules: next }),
  });
  console.log(`✅ Redirect Rule ensured (${next.length} rule(s) in ${phase}).`);
  return { changed: true, dryRun: false };
}
