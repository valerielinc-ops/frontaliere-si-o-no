#!/usr/bin/env node
/**
 * set-maileroo-return-path.mjs — move the Maileroo `return_path` for
 * frontaliereticino.ch from `abuse` to `bounce`, IN THE RIGHT ORDER.
 *
 * Why the order is the whole point. The return_path is a local part on our own
 * domain and our MX are Cloudflare Email Routing, so every asynchronous bounce
 * (the ISP accepts at SMTP time, then rejects and reports out-of-band) comes
 * back to that address as ordinary mail. An address BOUND to the worker gets
 * parsed and recorded by functions/src/inboundBounceReport.js; an unbound one
 * falls into the zone catch-all, which forwards straight to the human inbox
 * without ever running the worker. So moving the field before the routing rule
 * exists would silently re-open the very hole this work closed — with a green
 * CI and a plausible-looking dashboard.
 *
 * Hence this script REFUSES to write until it has verified, against the live
 * Cloudflare API, that `bounce@frontaliereticino.ch` is bound to the worker.
 * The order is enforced by the tool, not by remembering to do it.
 *
 * Run it AFTER deploy-email-worker.yml has applied the new routing rule (it
 * runs on every push to main touching infra/cloudflare-email-worker/** or
 * scripts/cf-email-worker-setup.mjs).
 *
 * Env (hydrated by bin/rc-env.sh / scripts/load-rc-env.mjs):
 *   MAILEROO_ACCOUNT_API_KEY — Maileroo Account API key (dashboard "Applications")
 *   CF_API_TOKEN             — needs Zone:Read + Email Routing:Read
 *   CF_ZONE_ID               — optional, skips zone lookup
 *
 * Usage:
 *   node scripts/set-maileroo-return-path.mjs            # dry-run (default)
 *   node scripts/set-maileroo-return-path.mjs --apply
 *   node scripts/set-maileroo-return-path.mjs --apply --local-part abuse   # rollback
 *
 * Idempotent: a field already on the target value is a no-op, exit 0.
 */

import { fileURLToPath } from 'node:url';
import { resolveZoneId } from './lib/cf-analytics.mjs';
import {
  BOUNCE_LOCAL_PART,
  BOUNCE_ADDRESS,
  MAIL_DOMAIN,
  EMAIL_WORKER_NAME,
} from './lib/bounce-return-path.mjs';

const CF_API = 'https://api.cloudflare.com/client/v4';
const MAILEROO_API = 'https://api.maileroo.com/v1';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const targetIdx = argv.indexOf('--local-part');
const TARGET_LOCAL_PART = targetIdx >= 0 && argv[targetIdx + 1] ? argv[targetIdx + 1] : BOUNCE_LOCAL_PART;
const TARGET_ADDRESS = `${TARGET_LOCAL_PART}@${MAIL_DOMAIN}`;

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function cf(path) {
  const res = await fetch(`${CF_API}${path}`, {
    headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    fail(`Cloudflare ${path} → ${res.status} ${JSON.stringify(json.errors || json).slice(0, 200)}`);
  }
  return json;
}

async function maileroo(path, init = {}) {
  const res = await fetch(`${MAILEROO_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.MAILEROO_ACCOUNT_API_KEY}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

/**
 * The guard. True only when an ENABLED Email Routing rule sends
 * `TARGET_ADDRESS` to the worker — a forward-only rule is not enough, because
 * a forward never runs the parsing code.
 */
export async function isBoundToWorker(zoneId, address) {
  const { result = [] } = await cf(`/zones/${zoneId}/email/routing/rules?per_page=200`);
  return result.some((rule) => {
    if (rule.enabled === false) return false;
    const matches = (rule.matchers || []).some((m) => String(m.value || '').toLowerCase() === address.toLowerCase());
    if (!matches) return false;
    return (rule.actions || []).some((a) => a.type === 'worker' && (a.value || []).includes(EMAIL_WORKER_NAME));
  });
}

async function resolveDomain() {
  const { json } = await maileroo('/domains?per_page=100');
  const domains = json?.data?.domains || [];
  const found = domains.find((d) => String(d.domain_name).toLowerCase() === MAIL_DOMAIN);
  if (!found) fail(`Maileroo has no domain ${MAIL_DOMAIN} (found: ${domains.map((d) => d.domain_name).join(', ') || 'none'})`);
  return found.id;
}

async function readSettings(domainId) {
  const { ok, status, json } = await maileroo(`/domains/${domainId}/settings`);
  if (!ok) fail(`could not read domain settings → ${status} ${JSON.stringify(json).slice(0, 200)}`);
  return json.data || {};
}

/**
 * Maileroo's docs do not publish the update verb; the API advertises
 * `GET, POST, PUT, PATCH, DELETE` on this resource. Try PUT, fall back to PATCH
 * on 404/405, and ALWAYS re-read afterwards — a 200 from an endpoint we
 * inferred is not proof the field changed.
 */
async function writeReturnPath(domainId, settings, localPart) {
  const body = JSON.stringify({
    interaction_tracking: settings.interaction_tracking,
    custom_hostname_tracking: settings.custom_hostname_tracking,
    return_path: localPart,
  });
  let res = await maileroo(`/domains/${domainId}/settings`, { method: 'PUT', body });
  if (!res.ok && [404, 405].includes(res.status)) {
    console.log(`   PUT → ${res.status}, retrying with PATCH`);
    res = await maileroo(`/domains/${domainId}/settings`, { method: 'PATCH', body });
  }
  if (!res.ok) fail(`update rejected → ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`);
}

async function main() {
  if (!process.env.MAILEROO_ACCOUNT_API_KEY) fail('MAILEROO_ACCOUNT_API_KEY missing (source bin/rc-env.sh)');
  if (!process.env.CF_API_TOKEN) fail('CF_API_TOKEN missing (source bin/rc-env.sh)');

  const domainId = await resolveDomain();
  const settings = await readSettings(domainId);
  const current = String(settings.return_path || '');
  console.log(`Maileroo ${MAIL_DOMAIN} (id ${domainId}) — return_path attuale: "${current}"`);

  if (current === TARGET_LOCAL_PART) {
    console.log(`✓ già "${TARGET_LOCAL_PART}" — niente da fare.`);
    return;
  }

  const zoneId = await resolveZoneId(process.env.CF_API_TOKEN, MAIL_DOMAIN, process.env.CF_ZONE_ID);
  const bound = await isBoundToWorker(zoneId, TARGET_ADDRESS);
  if (!bound) {
    fail(
      `${TARGET_ADDRESS} non è instradato al worker ${EMAIL_WORKER_NAME}.\n`
      + '   Spostare il return_path adesso manderebbe i delivery report nel catch-all,\n'
      + '   che li inoltra alla inbox SENZA passare dal worker: i bounce tornerebbero\n'
      + '   invisibili al modello di soppressione.\n'
      + `   Prima: mergia la regola (${BOUNCE_ADDRESS} in ROUTING_RULES di\n`
      + '   scripts/cf-email-worker-setup.mjs) e lascia girare deploy-email-worker.yml.',
    );
  }
  console.log(`✓ ${TARGET_ADDRESS} è instradato a ${EMAIL_WORKER_NAME}`);

  if (!APPLY) {
    console.log(`\n[dry-run] return_path: "${current}" → "${TARGET_LOCAL_PART}". Rilancia con --apply per scrivere.`);
    return;
  }

  await writeReturnPath(domainId, settings, TARGET_LOCAL_PART);

  // Verifica, non fiducia: rileggi il campo dall'API.
  const after = String((await readSettings(domainId)).return_path || '');
  if (after !== TARGET_LOCAL_PART) {
    fail(`la scrittura è passata ma il campo legge ancora "${after}" — return_path NON spostato.`);
  }
  console.log(`✅ return_path: "${current}" → "${after}"`);
  console.log('   I prossimi delivery report arriveranno su ' + TARGET_ADDRESS + '.');
}

// Esportato per i test: importare questo file non deve eseguire la migrazione.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => fail(err?.message || String(err)));
}
