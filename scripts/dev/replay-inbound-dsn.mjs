#!/usr/bin/env node
/**
 * replay-inbound-dsn.mjs — register delivery reports that arrived BEFORE the
 * worker learned to parse them.
 *
 * The gap this fills: until inboundBounceReport shipped, every asynchronous
 * bounce was forwarded to the human inbox and nowhere else. Those reports are
 * not on any server we control — Cloudflare Email Routing forwards without
 * storing, and Maileroo never saw them (the return_path is on our own domain).
 * The only surviving copy is in the owner's mailbox, so the only way to recover
 * them is to hand the files to this script.
 *
 * How to get the files: in Gmail, search
 *     subject:("Delivery Status Notification" OR Undeliverable OR "Mail delivery failed")
 * then, for each message, ⋮ → "Scarica messaggio" (Download message) → .eml.
 * A whole folder works too.
 *
 * The parsing is NOT re-implemented here: this imports the very functions the
 * worker runs (`isDeliveryStatusReport`, `parseDeliveryStatusReport`) and the
 * very handler the endpoint runs (`handleInboundBounceReport`), so a replay
 * cannot classify differently from the live path — the drift that would make
 * this tool worse than useless.
 *
 * Usage:
 *   node scripts/dev/replay-inbound-dsn.mjs <file.eml|dir> [...]      # dry-run
 *   node scripts/dev/replay-inbound-dsn.mjs --apply ~/Downloads/dsn/
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS / ADC (Firestore admin). The HTTP shared
 * secret is bypassed by construction — it gates the Worker→endpoint channel,
 * and this runs against Firestore directly with admin credentials.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import admin from 'firebase-admin';
// @ts-expect-error — Cloudflare Worker module, no types
import { isDeliveryStatusReport, parseDeliveryStatusReport } from '../../infra/cloudflare-email-worker/stop-reply-handler.js';
import { handleInboundBounceReport } from '../../functions/src/inboundBounceReport.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const inputs = argv.filter((a) => !a.startsWith('--'));

if (!inputs.length) {
  console.error('uso: node scripts/dev/replay-inbound-dsn.mjs [--apply] <file.eml|dir> [...]');
  process.exit(1);
}

/** Expand directories one level; .eml files only. */
function collectFiles(paths) {
  const out = [];
  for (const p of paths) {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) {
        if (extname(name).toLowerCase() === '.eml') out.push(join(p, name));
      }
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * Minimal RFC 5322 header map for the `headers.get()` shape the worker's
 * detector expects. Only the top-level headers (up to the first blank line)
 * and only the last value for a repeated field — enough for content-type,
 * subject, from and auto-submitted, which is all the detector reads.
 */
function headerMap(raw) {
  const headBlock = raw.split(/\r?\n\r?\n/)[0] || '';
  const unfolded = headBlock.replace(/\r?\n[ \t]+/g, ' ');
  const map = new Map();
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9-]+):[ \t]*(.*)$/);
    if (m) map.set(m[1].toLowerCase(), m[2].trim());
  }
  return { get: (name) => map.get(String(name).toLowerCase()) ?? '', raw: map };
}

async function main() {
  const files = collectFiles(inputs);
  console.log(`${files.length} file da esaminare — modalità ${APPLY ? 'APPLY' : 'dry-run'}\n`);

  let db = null;
  if (APPLY) {
    if (!admin.apps?.length) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: process.env.GCLOUD_PROJECT || 'frontaliere-ticino',
      });
    }
    db = admin.firestore();
  }

  const tally = { notReport: 0, unparseable: 0, applied: 0, ignored: 0, wouldApply: 0 };

  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const headers = headerMap(raw);
    const label = file.split('/').pop();

    if (!isDeliveryStatusReport(headers, headers.get('from'), headers.get('subject'))) {
      console.log(`· ${label}: non è un delivery report — saltato`);
      tally.notReport += 1;
      continue;
    }

    const report = parseDeliveryStatusReport(raw);
    if (!report.recipient) {
      // Same posture as the worker: unattributable stays a human's problem.
      console.log(`⚠ ${label}: report non attribuibile (nessun Final-Recipient né header citati)`);
      tally.unparseable += 1;
      continue;
    }

    if (!APPLY) {
      console.log(`· ${label}: ${report.recipient} — status "${report.status || '—'}", campagna ${report.campaignId || '—'}`);
      tally.wouldApply += 1;
      continue;
    }

    const res = await handleInboundBounceReport({
      ...report,
      db,
      // The secret gate protects the HTTP channel; here the authority is ADC.
      secret: 'local-replay',
      providedSecret: 'local-replay',
    });
    const applied = res.result?.applied?.length ? res.result.applied.join('+') : '—';
    console.log(`${res.result?.applied?.length ? '✓' : '·'} ${label}: ${report.recipient} → ${res.body} (${applied})`);
    if (res.result?.applied?.length) tally.applied += 1; else tally.ignored += 1;
  }

  console.log('\nRiepilogo:', tally);
  if (!APPLY && tally.wouldApply) console.log('Rilancia con --apply per registrarli.');
}

main().catch((err) => {
  console.error(`❌ ${err?.message || err}`);
  process.exit(1);
});
