#!/usr/bin/env node
/**
 * probe-mailgun-scheduled.mjs — Live probe for Mailgun's real scheduled-send
 * lookahead ceiling on the free/default plan (issue #3798, Phase 0 "Non
 * implementato" item).
 *
 * Why this exists: `docs/NEWSLETTER-SEND-TIME-PERSONALIZATION.md`'s provider
 * matrix clamps Mailgun's `o:deliverytime` lookahead to a conservative 3 days
 * (`scripts/lib/email-cascade.mjs` PROVIDERS.mailgun.scheduledSend.maxLookaheadMs`)
 * because Mailgun's own free-plan docs page for this limit returns 403 when
 * fetched programmatically — the real ceiling has never been confirmed
 * against the live account. This script sends (or dry-run previews) an
 * actual `o:deliverytime`-scheduled test message so the real limit can be
 * read off Mailgun's own accept/reject response instead of guessed.
 *
 * ⚠️  WARNING — `--send` fires ONE REAL EMAIL through the production Mailgun
 * account to whatever `--to` address you give it. This is a manual,
 * owner-run-only diagnostic:
 *   - NEVER wire this into CI or any automated workflow.
 *   - NEVER run `--send` without real MAILGUN_API_KEY/MAILGUN_DOMAIN
 *     credentials you control and a `--to` address you're prepared to
 *     receive test mail at.
 *   - Per `AGENTS.md` ("Mai `send-newsletter.mjs --send` locale. Usa
 *     `--preview` o `--test --target-email <email>`"): real sends are
 *     owner-triggered, never automatic. This script mirrors that rule —
 *     the default (no `--send`) is always a DRY-RUN that prints exactly
 *     what would be sent without contacting Mailgun's send endpoint at all.
 *
 * Usage:
 *   node scripts/probe-mailgun-scheduled.mjs --to you@example.com
 *                                                     # DRY-RUN, --days 3
 *   node scripts/probe-mailgun-scheduled.mjs --to you@example.com --days 7
 *                                                     # DRY-RUN, --days 7
 *   node scripts/probe-mailgun-scheduled.mjs --to you@example.com --days 3 --send
 *                                                     # REAL send, owner only
 *
 * To find the real ceiling: run with --send at a few --days values (e.g. 3,
 * 7, 4) and read Mailgun's response — accepted (200, `"id"` present) means
 * that lookahead is within the real limit; a validation error naming
 * `o:deliverytime` means it's past the ceiling. Bisect from there.
 *
 * Environment (same as scripts/lib/email-cascade.mjs):
 *   MAILGUN_API_KEY  — Mailgun API key (EU region)
 *   MAILGUN_DOMAIN   — Mailgun sending domain
 *
 * Exit codes:
 *   0 — dry-run printed successfully, or a real send completed (whatever
 *       Mailgun's response was — read the printed body for accept/reject)
 *   1 — missing required config/args, or the HTTP request itself failed
 *       (network error, non-JSON response, etc.)
 */

import { toRfc2822Utc } from './lib/email-cascade.mjs';

// ── CLI args ─────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { send: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--send') { out.send = true; continue; }
    if (a === '--to') { out.to = argv[++i]; continue; }
    if (a === '--days') { out.days = argv[++i]; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
  }
  return out;
}

function printHelp() {
  console.log(`
probe-mailgun-scheduled.mjs — verify Mailgun's real scheduled-send lookahead

Usage:
  node scripts/probe-mailgun-scheduled.mjs --to <email> [--days <N>] [--send]

Options:
  --to <email>   Required. Test recipient address.
  --days <N>     Scheduled-send offset in days from now. Default: 3.
  --send         Actually send via Mailgun. Without this flag: DRY-RUN only
                 (prints the request, never contacts Mailgun).
  --help, -h     Show this help.

⚠️  --send fires ONE REAL EMAIL. Manual owner-run only, never in CI.

To find the real free-plan ceiling, run --send at a few --days values, e.g.:
  node scripts/probe-mailgun-scheduled.mjs --to you@example.com --days 3 --send
  node scripts/probe-mailgun-scheduled.mjs --to you@example.com --days 7 --send
  node scripts/probe-mailgun-scheduled.mjs --to you@example.com --days 4 --send
Read Mailgun's response for each: accepted vs. an o:deliverytime validation
error tells you which side of the real limit that --days value falls on.
`);
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.to) {
    console.error('❌ --to <email> is required (test recipient). Run with --help for usage.');
    process.exit(1);
  }

  const days = Number.parseFloat(args.days ?? '3');
  if (!Number.isFinite(days) || days <= 0) {
    console.error(`❌ --days must be a positive number, got: ${args.days}`);
    process.exit(1);
  }

  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  if (!apiKey || !domain) {
    console.error('❌ MAILGUN_API_KEY and/or MAILGUN_DOMAIN not set in env.');
    console.error('   Run: source <(node scripts/load-rc-env.mjs)');
    process.exit(1);
  }

  const deliveryDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  // Reuse the exact same RFC 2822 formatter sendViaMailgun() uses for
  // o:deliverytime — do NOT reimplement the format here.
  const deliveryTime = toRfc2822Utc(deliveryDate);

  const endpoint = `https://api.eu.mailgun.net/v3/${domain}/messages`;
  const from = 'Frontaliere Ticino <notifiche@frontaliereticino.ch>';
  const subject = `[probe-mailgun-scheduled] lookahead test — ${days}d — ${new Date().toISOString()}`;
  const html = `<p>Mailgun scheduled-send lookahead probe (issue #3798).</p>
<p>Requested o:deliverytime offset: <strong>${days} day(s)</strong> from send time.</p>
<p>Computed o:deliverytime: <code>${deliveryTime}</code></p>`;

  console.log(`Endpoint:        ${endpoint}`);
  console.log(`Auth header:     Basic ${Buffer.from(`api:${'*'.repeat(8)}`).toString('base64')} (redacted)`);
  console.log(`from:            ${from}`);
  console.log(`to:              ${args.to}`);
  console.log(`subject:         ${subject}`);
  console.log(`o:deliverytime:  ${deliveryTime}  (requested +${days}d, now=${new Date().toISOString()})`);

  if (!args.send) {
    console.log('\n🧪 DRY-RUN — no request sent. Pass --send to actually fire this via Mailgun.');
    process.exit(0);
  }

  console.log('\n⚠️  --send set — sending ONE REAL EMAIL via Mailgun now...');

  const auth = Buffer.from(`api:${apiKey}`).toString('base64');
  // Multipart body identical in shape to sendViaMailgun() in
  // scripts/lib/email-cascade.mjs (from/to/subject/html/o:deliverytime).
  const form = new FormData();
  form.append('from', from);
  form.append('to', args.to);
  form.append('subject', subject);
  form.append('html', html);
  form.append('o:deliverytime', deliveryTime);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
      body: form,
    });

    const bodyText = await res.text();
    console.log(`\nHTTP status: ${res.status}`);
    console.log('Response body:');
    console.log(bodyText);

    if (!res.ok) {
      console.error(`\n❌ Mailgun rejected the request (HTTP ${res.status}) — see body above for the reason (may indicate the ${days}-day lookahead is past the real limit).`);
      process.exit(1);
    }

    console.log(`\n✅ Mailgun accepted the message for scheduled delivery around ${deliveryTime}.`);
    process.exit(0);
  } catch (err) {
    console.error(`❌ Request to Mailgun failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
