#!/usr/bin/env node
/**
 * cf-email-worker-setup.mjs — post-deploy config for the Cloudflare Email
 * Routing Worker (infra/cloudflare-email-worker), run by deploy-email-worker.yml
 * AFTER `wrangler deploy` has created/updated the worker script.
 *
 * Does, idempotently, via the Cloudflare API (so no secret/email ever lands in
 * the repo or the CI logs):
 *   1. Sets the worker secrets STOP_SECRET (= NEWSLETTER_SECRET) and FORWARD_TO.
 *      FORWARD_TO is resolved from the zone's catch-all forward target, so the
 *      worker forwards replies to the SAME inbox the catch-all already used —
 *      adding the worker rule never silently drops a reply.
 *   2. Ensures an Email Routing rule: the outreach address
 *      (valerie@frontaliereticino.ch) → "send to worker"
 *      frontaliere-stop-reply-handler. Idempotent (updates an existing rule by
 *      matcher, else creates one).
 *
 * Env (hydrated by scripts/load-rc-env.mjs in CI):
 *   CF_API_TOKEN      — needs Workers Scripts:Edit (secrets) + Email Routing:Edit (rule)
 *   CF_ACCOUNT_ID
 *   NEWSLETTER_SECRET — becomes the worker's STOP_SECRET
 *
 * Failure policy: secrets are essential → fail the job if they can't be set.
 * The Email Routing rule is best-effort → on error (e.g. token missing the
 * Email Routing:Edit scope) it warns and exits 0, so the worker still deploys
 * and the rule can be bound once.
 */

const ZONE_NAME = 'frontaliereticino.ch';
const WORKER_NAME = 'frontaliere-stop-reply-handler';
// The cold-email From / reply address. Inbound replies to it must hit the worker.
const OUTREACH_ADDRESS = 'valerie@frontaliereticino.ch';
const RULE_NAME = 'cold-email reply → stop-reply-handler';

const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const NEWSLETTER_SECRET = process.env.NEWSLETTER_SECRET;

function mask(value) {
  // GitHub Actions: scrub the value from any subsequent log line.
  if (value && process.env.GITHUB_ENV) process.stdout.write(`::add-mask::${value}\n`);
}

async function cf(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try { json = await res.json(); } catch { /* non-JSON error body */ }
  return { ok: res.ok && json.success !== false, status: res.status, json };
}

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

async function resolveZoneId() {
  const r = await cf(`/zones?name=${encodeURIComponent(ZONE_NAME)}`);
  const id = r.ok ? (r.json.result?.[0]?.id || '') : '';
  if (!id) fail(`zone ${ZONE_NAME} not found (token Zone:Read scope?)`);
  return id;
}

async function resolveForwardTarget(zoneId) {
  const r = await cf(`/zones/${zoneId}/email/routing/rules/catch_all`);
  if (!r.ok) return '';
  const forward = (r.json.result?.actions || []).find((a) => a.type === 'forward');
  return forward?.value?.[0] || '';
}

async function putSecret(name, text) {
  const r = await cf(`/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/secrets`, {
    method: 'PUT',
    body: { name, text, type: 'secret_text' },
  });
  if (!r.ok) {
    fail(`could not set worker secret ${name} (status ${r.status}: ${JSON.stringify(r.json.errors || r.json).slice(0, 200)})`);
  }
  console.log(`✓ secret ${name} set on ${WORKER_NAME}`);
}

async function ensureRoutingRule(zoneId) {
  const desired = {
    name: RULE_NAME,
    enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: OUTREACH_ADDRESS }],
    actions: [{ type: 'worker', value: [WORKER_NAME] }],
  };
  const list = await cf(`/zones/${zoneId}/email/routing/rules`);
  if (!list.ok) {
    console.log(`::warning::could not list Email Routing rules (status ${list.status}) — bind ${OUTREACH_ADDRESS} → ${WORKER_NAME} manually.`);
    return;
  }
  const existing = (list.json.result || []).find((rule) =>
    (rule.matchers || []).some((m) => m.type === 'literal' && (m.value || '').toLowerCase() === OUTREACH_ADDRESS));
  const target = existing
    ? { method: 'PUT', path: `/zones/${zoneId}/email/routing/rules/${existing.tag}` }
    : { method: 'POST', path: `/zones/${zoneId}/email/routing/rules` };
  const r = await cf(target.path, { method: target.method, body: desired });
  if (!r.ok) {
    console.log(`::warning::could not ${existing ? 'update' : 'create'} the Email Routing rule (status ${r.status}: ${JSON.stringify(r.json.errors || r.json).slice(0, 200)}). Bind ${OUTREACH_ADDRESS} → ${WORKER_NAME} manually (token Email Routing:Edit scope?).`);
    return;
  }
  console.log(`✓ Email Routing rule ${existing ? 'updated' : 'created'}: ${OUTREACH_ADDRESS} → worker ${WORKER_NAME}`);
}

async function main() {
  if (!TOKEN || !ACCOUNT_ID) fail('CF_API_TOKEN / CF_ACCOUNT_ID not set (Remote Config not hydrated).');
  if (!NEWSLETTER_SECRET) fail('NEWSLETTER_SECRET not set — cannot configure STOP_SECRET.');
  mask(NEWSLETTER_SECRET);

  const zoneId = await resolveZoneId();

  const forwardTo = await resolveForwardTarget(zoneId);
  mask(forwardTo);
  if (forwardTo) {
    console.log('✓ FORWARD_TO resolved from the zone catch-all target.');
  } else {
    console.log('::warning::no catch-all forward target found — FORWARD_TO left unset (replies are still tracked; just not forwarded to a human inbox).');
  }

  // Essential: the secrets the worker gates on.
  await putSecret('STOP_SECRET', NEWSLETTER_SECRET);
  if (forwardTo) await putSecret('FORWARD_TO', forwardTo);

  // Best-effort: the inbound binding.
  await ensureRoutingRule(zoneId);

  console.log('Email worker setup complete.');
}

main().catch((err) => fail(err?.message || String(err)));
