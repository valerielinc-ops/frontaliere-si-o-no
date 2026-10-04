#!/usr/bin/env node
/**
 * confirm.mjs — record a post the social robot has SEEN published.
 *
 * Run by .github/workflows/social-robot-confirm.yml, which the robot on the
 * Mac host dispatches only after the platform's confirmation was on the page
 * (scripts/social-robot/lib/robot.mjs). Moves the entry from
 * data/<channel>-queue.json into data/<channel>-posted.json — the ledger the
 * API posters write too, so their 30-day dedup sees robot posts the same way.
 * A second confirmation of the same queue id changes nothing.
 *
 *   node scripts/social-robot/confirm.mjs --channel=instagram --queue-id=article-2026-10-03 \
 *     --confirmed-at=2026-10-04T08:41:00Z [--evidence="Post condiviso"] [--ledger-entries='[...]']
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { appendLedger, loadLedger } from '../lib/social-post-utils.mjs';
import {
  SOCIAL_CHANNELS,
  confirmQueueEntry,
  ledgerPathFor,
  loadQueue,
  queuePathFor,
  saveQueue,
} from '../lib/social-publish-queue.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const POSTED_TRIM_LIMIT = 1000;
const QUEUE_ID_RE = /^(?:article|job|border)-\d{4}-\d{2}-\d{2}$/;

export function parseConfirmArgs(argv) {
  const get = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? '';
  const channel = get('channel');
  const queueId = get('queue-id');
  const confirmedAt = get('confirmed-at');
  if (!SOCIAL_CHANNELS.includes(channel)) throw new Error(`--channel must be one of ${SOCIAL_CHANNELS.join(', ')}`);
  if (!QUEUE_ID_RE.test(queueId)) throw new Error(`--queue-id must look like article-YYYY-MM-DD (got "${queueId}")`);
  if (!Number.isFinite(Date.parse(confirmedAt))) throw new Error(`--confirmed-at must be an ISO timestamp (got "${confirmedAt}")`);
  let fallbackLedgerEntries = [];
  const raw = get('ledger-entries');
  if (raw) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((e) => !e || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.kind !== 'string')) {
      throw new Error('--ledger-entries must be a JSON array of {id, kind, ...}');
    }
    fallbackLedgerEntries = parsed;
  }
  return { channel, queueId, confirmedAt, evidence: get('evidence'), fallbackLedgerEntries };
}

/** Apply the confirmation to the queue and ledger files under `root`. */
export function applyConfirmation({ root = ROOT, channel, queueId, confirmedAt, evidence, fallbackLedgerEntries }) {
  const queuePath = queuePathFor(root, channel);
  const ledgerPath = ledgerPathFor(root, channel);
  const result = confirmQueueEntry({
    queue: loadQueue(queuePath),
    ledger: loadLedger(ledgerPath),
    queueId,
    confirmedAt,
    evidence,
    fallbackLedgerEntries,
  });
  saveQueue(queuePath, result.queue);
  appendLedger(ledgerPath, result.ledgerEntries, POSTED_TRIM_LIMIT);
  return result;
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    const args = parseConfirmArgs(process.argv.slice(2));
    const res = applyConfirmation(args);
    console.log(res.alreadyConfirmed
      ? `ℹ️  ${args.channel}/${args.queueId} already in the ledger — nothing added`
      : `✅ ${args.channel}/${args.queueId}: ${res.ledgerEntries.length} ledger entr${res.ledgerEntries.length === 1 ? 'y' : 'ies'} from the ${res.source}`);
  } catch (err) {
    console.error(`❌ confirm: ${err.message}`);
    process.exit(1);
  }
}
