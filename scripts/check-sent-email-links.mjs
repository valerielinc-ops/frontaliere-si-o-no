#!/usr/bin/env node
/**
 * check-sent-email-links.mjs — audit the links of an email we actually sent
 * (issue #5682).
 *
 * The senders run this audit themselves, post-send, through the wrapper in
 * scripts/lib/email-cascade.mjs. This CLI is the manual/scheduled entry point
 * for the two things that wrapper cannot do:
 *
 *   1. `--html <file>` — audit the message as the RECIPIENT received it,
 *      saved out of the canary mailbox ("show original" → save). That body
 *      carries the provider's click-tracking rewrites
 *      (click.frontaliereticino.ch/v2/redirect/<base64>), which exist only in
 *      the delivered copy: nothing in this repo produces them, so no test
 *      could have covered them and the tracker→destination hop was never
 *      checked by anything before this.
 *
 *   2. `--endpoints` — probe the routes every email depends on, without any
 *      email: the one-click unsubscribe endpoint and the four
 *      newsletter-preferences pages. Cheap enough to schedule.
 *
 * Read-only, always. The one-click probe deliberately sends an INVALID token
 * so the Cloud Function refuses it at the signature check; nothing is read or
 * written on any subscriber. Auditing must never be able to unsubscribe
 * somebody.
 *
 * Usage:
 *   node scripts/check-sent-email-links.mjs --html <file> [--channel <id>] [--no-live] [--json]
 *   node scripts/check-sent-email-links.mjs --endpoints [--json]
 *   node scripts/check-sent-email-links.mjs --url <url>
 *
 * Exit code: 1 when any finding has severity `error`, 0 otherwise.
 */
import fs from 'node:fs';
import {
  auditSentEmail,
  formatAuditReport,
  probeOneClickUnsubscribe,
  resolveRedirectChain,
  redactEmails,
  SITE_HOST,
  ONE_CLICK_UNSUBSCRIBE_PATHS,
  SPA_FALLTHROUGH_MARKER,
  preferencesPaths,
} from './lib/email-link-audit.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

async function checkEndpoints() {
  const findings = [];

  // One-click unsubscribe: the List-Unsubscribe target of every channel. A 4xx
  // to an invalid token is the PASS — it proves the CF Worker still proxies the
  // path and the function still verifies signatures. All four proxied paths are
  // probed, not just the newsletter's: the job-alert, outreach and saved-jobs
  // endpoints can rot independently.
  for (const base of ONE_CLICK_UNSUBSCRIBE_PATHS) {
    const url = `https://${SITE_HOST}${base}/?action=unsubscribe&email=link-audit%40example.com&uid=link-audit&token=placeholder`;
    findings.push(...await probeOneClickUnsubscribe(url));
  }

  // Preferences pages. These answer 404 BY DESIGN — they are not prerendered
  // (build-plugins/legacyRedirectsPlugin.ts) and the built 404.html boots the
  // SPA back onto the route. So the assertion is on the BODY, not the status:
  // a 404 that carries the fallthrough marker works for a human, a 404 without
  // it is a dead end.
  for (const p of preferencesPaths()) {
    const url = `https://${SITE_HOST}${p}`;
    const chain = await resolveRedirectChain(url);
    if (chain.status === null) {
      findings.push({ severity: 'warn', code: 'preferences_probe_network', detail: chain.error, url });
      continue;
    }
    if (chain.status >= 200 && chain.status < 300) continue;
    let body = '';
    try { body = await chain.response.text(); } catch { /* strict verdict below */ }
    if (body.includes(SPA_FALLTHROUGH_MARKER)) {
      findings.push({ severity: 'info', code: 'preferences_spa_fallthrough', detail: `${chain.status} from the origin, SPA restores the route`, url });
    } else {
      findings.push({ severity: 'error', code: 'preferences_dead', detail: `${chain.status} and no SPA fallthrough marker — every "gestisci preferenze" link in every email is a dead end`, url });
    }
  }
  return findings;
}

async function main() {
  if (flag('--help') || args.length === 0) {
    console.log([
      'check-sent-email-links.mjs — audit the links of an email we actually sent (#5682)',
      '',
      '  --html <file> [--channel <id>] [--no-live] [--json]',
      '      Audit a delivered message body (saved from the canary mailbox).',
      '  --endpoints [--json]',
      '      Probe the one-click unsubscribe endpoint and the 4 preferences pages.',
      '  --url <url>',
      '      Print the redirect chain of one URL, tracker hops included.',
      '',
      'Read-only: the one-click probe uses a deliberately invalid token, so it is',
      'refused at the signature check and can never unsubscribe anybody.',
    ].join('\n'));
    process.exit(0);
  }

  const live = !flag('--no-live');
  const asJson = flag('--json');

  if (flag('--url')) {
    const url = value('--url');
    const chain = await resolveRedirectChain(url);
    console.log(JSON.stringify({ hops: chain.hops, finalUrl: chain.finalUrl, status: chain.status, error: chain.error }, null, 2));
    process.exit(chain.status && chain.status < 400 ? 0 : 1);
  }

  if (flag('--endpoints')) {
    const findings = await checkEndpoints();
    const errors = findings.filter((f) => f.severity === 'error');
    if (asJson) console.log(JSON.stringify({ findings, ok: errors.length === 0 }, null, 2));
    else {
      console.log(errors.length === 0 ? '✅ email route endpoints: alive' : `❌ email route endpoints: ${errors.length} error(s)`);
      for (const f of findings) console.log(`  ${f.severity === 'error' ? '✗' : f.severity === 'warn' ? '⚠️' : 'ℹ️'} ${f.code}: ${redactEmails(f.detail)}\n      ${f.url}`);
    }
    process.exit(errors.length ? 1 : 0);
  }

  const file = value('--html');
  if (!file) {
    console.error('❌ --html <file>, --endpoints or --url <url> required. --help for usage.');
    process.exit(2);
  }
  const html = fs.readFileSync(file, 'utf8');
  const channel = value('--channel', 'delivered-message');
  const result = await auditSentEmail(html, { channel, live });
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else console.log(formatAuditReport(result));
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`❌ ${e?.message || e}`);
  process.exit(2);
});
