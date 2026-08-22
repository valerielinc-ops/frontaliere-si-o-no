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
 *   2. Ensures an Email Routing rule per address in ROUTING_RULES below → "send
 *      to worker" frontaliere-stop-reply-handler. Idempotent (updates an
 *      existing rule by matcher, else creates one).
 *
 * Env (hydrated by scripts/load-rc-env.mjs in CI):
 *   CF_API_TOKEN      — needs Workers Scripts:Edit (secrets) + Email Routing:Edit (rule)
 *   CF_ACCOUNT_ID
 *   NEWSLETTER_SECRET — becomes the worker's STOP_SECRET
 *
 * Failure policy: secrets are essential → fail the job if they can't be set.
 * Each Email Routing rule is best-effort → on error (e.g. token missing the
 * Email Routing:Edit scope) it warns and exits 0, so the worker still deploys
 * and the rule can be bound once.
 *
 * Zone-id resolution delegates to scripts/lib/cf-analytics.mjs's resolveZoneId
 * (AGENTS.md #6 — no inline copy of that fetch+parse construct); this file's
 * own resolveZoneId() wrapper only translates a failure into this script's
 * fail() convention.
 */

import { resolveZoneId as resolveZoneIdShared } from './lib/cf-analytics.mjs';
import { BOUNCE_ADDRESS, MAIL_DOMAIN, EMAIL_WORKER_NAME } from './lib/bounce-return-path.mjs';

const ZONE_NAME = MAIL_DOMAIN;
const WORKER_NAME = EMAIL_WORKER_NAME;
// Recipient addresses that must route to the worker, and the routing-rule name
// for each. stop-reply-handler.js branches on `message.to` against the
// OUTREACH_ADDRESS / NEWSLETTER_ADDRESS vars in wrangler.toml (keep the two
// lists in lockstep); every other address below is forward-only and is bound
// purely so the worker's isAutoReply filter can drop out-of-office replies
// before they reach the human inbox.
const OUTREACH_ADDRESS = 'valerie@frontaliereticino.ch';
const NEWSLETTER_ADDRESS = 'newsletter@frontaliereticino.ch';
// The addresses our outbound mail is sent FROM — an autoresponder answers to
// one of these, so this is the whole surface an out-of-office can land on.
// Sources: scripts/send-job-alerts.mjs + scripts/send-saved-jobs-digest.mjs +
// scripts/monitor-gsc-job-indexation.mjs (alerts@), blast-publisher-ads.mjs
// (confirmation@), notify-journalist-article-live.mjs (redazione@),
// probe-mailgun-scheduled.mjs (notifiche@), lib/mymemory-translate.mjs (info@),
// functions/src/sendCalculatorReport.js (report@). Plus the two inbound-only
// role addresses: abuse@ (RFC 2142 — where the incident's automatic response
// actually landed) and consulenza@, published in the site copy and the internal
// lead notification target (functions/src/consultingCore.js).
//
// The first sweep only covered scripts/functions/services/workflows and so
// missed the addresses published in the UI layer, added here after review:
// stampa@ (press-kit mailto, components/pages/PressKit.tsx) and the two author
// bylines (data/authors.ts, mailto in components/pages/AutorePage.tsx). The zone
// catch-all forwards every address, so a published mailto is a live inbound
// surface whether or not a dedicated mailbox exists behind it.
//
// Deliberately NOT bound: the *-bot@ addresses (git commit identities in
// workflows, they never receive mail) and preview@/qa-preview@ (local
// newsletter preview/QA placeholders, never a real recipient).
//
// `bounce@` is different in kind from the addresses below: nothing is sent FROM
// it. It exists to be the Maileroo return_path, i.e. the envelope sender our
// outbound mail carries, so the delivery reports an ISP sends back land on an
// address bound to the worker instead of on abuse@ (a role mailbox meant for
// complaints, RFC 2142). The rule must exist BEFORE the return_path is moved
// there — a report arriving at an unbound address falls into the zone
// catch-all, which forwards straight to the inbox WITHOUT passing through the
// worker, and the bounce would silently stop being recorded again.
// `scripts/set-maileroo-return-path.mjs` enforces that order: it refuses to
// move the field until this rule is live.
const AUTO_REPLY_SINK_ADDRESSES = [
  BOUNCE_ADDRESS,
  'alerts@frontaliereticino.ch',
  'abuse@frontaliereticino.ch',
  'confirmation@frontaliereticino.ch',
  'redazione@frontaliereticino.ch',
  'notifiche@frontaliereticino.ch',
  'info@frontaliereticino.ch',
  'report@frontaliereticino.ch',
  'consulenza@frontaliereticino.ch',
  'stampa@frontaliereticino.ch',
  'marco.ferrari@frontaliereticino.ch',
  'laura.bianchi@frontaliereticino.ch',
];
const ROUTING_RULES = [
  { address: OUTREACH_ADDRESS, name: 'cold-email reply → stop-reply-handler' },
  { address: NEWSLETTER_ADDRESS, name: 'newsletter unsubscribe reply → stop-reply-handler' },
  ...AUTO_REPLY_SINK_ADDRESSES.map((address) => ({
    address,
    name: `${address.split('@')[0]} auto-reply filter → stop-reply-handler`,
  })),
];

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
  try {
    return await resolveZoneIdShared(TOKEN, ZONE_NAME, process.env.CF_ZONE_ID);
  } catch {
    fail(`zone ${ZONE_NAME} not found (token Zone:Read scope?)`);
  }
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

async function ensureRoutingRule(zoneId, address, ruleName) {
  const desired = {
    name: ruleName,
    enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: address }],
    actions: [{ type: 'worker', value: [WORKER_NAME] }],
  };
  const list = await cf(`/zones/${zoneId}/email/routing/rules`);
  if (!list.ok) {
    console.log(`::warning::could not list Email Routing rules (status ${list.status}) — bind ${address} → ${WORKER_NAME} manually.`);
    return;
  }
  const existing = (list.json.result || []).find((rule) =>
    (rule.matchers || []).some((m) => m.type === 'literal' && (m.value || '').toLowerCase() === address.toLowerCase()));
  const target = existing
    ? { method: 'PUT', path: `/zones/${zoneId}/email/routing/rules/${existing.tag}` }
    : { method: 'POST', path: `/zones/${zoneId}/email/routing/rules` };
  const r = await cf(target.path, { method: target.method, body: desired });
  if (!r.ok) {
    console.log(`::warning::could not ${existing ? 'update' : 'create'} the Email Routing rule for ${address} (status ${r.status}: ${JSON.stringify(r.json.errors || r.json).slice(0, 200)}). Bind ${address} → ${WORKER_NAME} manually (token Email Routing:Edit scope?).`);
    return;
  }
  console.log(`✓ Email Routing rule ${existing ? 'updated' : 'created'}: ${address} → worker ${WORKER_NAME}`);
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

  // Best-effort: the inbound bindings (one per address the worker branches on).
  for (const rule of ROUTING_RULES) {
    await ensureRoutingRule(zoneId, rule.address, rule.name);
  }

  console.log('Email worker setup complete.');
}

main().catch((err) => fail(err?.message || String(err)));
