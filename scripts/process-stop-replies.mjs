#!/usr/bin/env node
/**
 * process-stop-replies.mjs — auto-suppress employer-outreach recipients who reply
 * "STOP" / "UNSUBSCRIBE" to a cold email (follow-up #2620, item 2).
 *
 * The cold-email footer (scripts/lib/cold-email-sequence.mjs) tells recipients
 * they can reply "STOP" to be removed. Until now the operator had to set
 * `suppressed:true` in the send-log by hand — fragile: an unprocessed STOP risks
 * a CAN-SPAM / nDSG violation and burns the sending domain's reputation. This
 * script processes inbound replies and writes the suppression the SAME way the
 * one-click unsubscribe Cloud Function does:
 *   1. Firestore `employer_outreach_suppression/{companyKey}` (read by
 *      send-cold-emails.mjs → loadFirestoreSuppression) — best-effort, skipped
 *      with a warning if no service-account creds are present.
 *   2. The local send-log.json (`suppressed:true` + reason) so a dry-run / local
 *      send honours it even without Firestore.
 *
 * Inbound source (one of):
 *   --queue <path>   JSONL/JSON queue of inbound replies, each
 *                    { from, subject, body } — written by the Cloudflare Email
 *                    Worker (infra/cloudflare-email-worker/stop-reply-handler.js)
 *                    or any inbound-route webhook. Default:
 *                    data/employer-outreach/inbound-replies.jsonl
 *   --from <addr> --subject <s> --body <s>
 *                    Process a SINGLE reply from the CLI (manual entry).
 *
 * The sender address is reverse-mapped to a companyKey via contacts.json (the
 * same registry send-cold-emails.mjs sends to). An unknown sender is reported and
 * skipped (we never suppress a key we can't identify).
 *
 * Default = DRY-RUN (prints what it WOULD suppress). Pass --apply to write.
 *
 * Examples:
 *   # dry-run the queue the email worker has accumulated
 *   node scripts/process-stop-replies.mjs
 *   # apply suppression from the queue, then truncate the processed queue
 *   node scripts/process-stop-replies.mjs --apply
 *   # process a single manual STOP
 *   node scripts/process-stop-replies.mjs --apply \
 *     --from "denise@casale.ch" --subject "Re: candidati inviati" --body "STOP"
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStopReply, extractSenderEmail } from './lib/stop-reply-detect.mjs';
import {
  resolveCompanyKeyByEmail,
  writeSuppression,
} from './lib/outreach-suppression.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  const n = process.argv[i + 1];
  return n && !n.startsWith('--') ? n : true;
}
const has = (name) => process.argv.includes(name);

function loadJson(p, def) {
  try { return JSON.parse(fs.readFileSync(path.resolve(p), 'utf8')); } catch { return def; }
}

/**
 * Read the inbound-reply queue. Accepts either a JSON array or JSONL (one object
 * per line). Each entry: { from, subject, body }. Missing/empty → [].
 */
export function loadInboundQueue(queuePath) {
  let raw;
  try { raw = fs.readFileSync(path.resolve(queuePath), 'utf8'); } catch { return []; }
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // JSON array form.
  if (trimmed.startsWith('[')) {
    try { const arr = JSON.parse(trimmed); return Array.isArray(arr) ? arr : []; } catch { return []; }
  }
  // JSONL form: one object per non-empty line; skip unparseable lines.
  const out = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* skip malformed line */ }
  }
  return out;
}

// ── Send-log suppression (local, mirrors send-cold-emails.mjs shape) ──────────

function loadSendLog(logPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(logPath), 'utf8'));
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch { return {}; }
}

function saveSendLog(logPath, log) {
  const p = path.resolve(logPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(log, null, 2), 'utf8');
}

/** Mark a company suppressed in the local send-log (shape parity with the sender). */
export function suppressInSendLog(log, companyKey, reason) {
  if (!log[companyKey]) log[companyKey] = { touches: [], suppressed: false, suppressedReason: '' };
  log[companyKey].suppressed = true;
  log[companyKey].suppressedReason = reason;
  return log;
}

/**
 * Classify a queue of inbound replies into the companyKeys to suppress.
 * Pure (no IO) so it is unit-testable. Returns { toSuppress, skipped } where
 * toSuppress is [{ companyKey, fromEmail }] and skipped is [{ reason, ... }].
 */
export function classifyReplies(replies, contacts) {
  const toSuppress = [];
  const skipped = [];
  const seen = new Set();
  for (const r of replies || []) {
    const fromEmail = extractSenderEmail(r?.from);
    if (!isStopReply({ subject: r?.subject, body: r?.body, text: r?.text })) {
      skipped.push({ reason: 'not-a-stop', fromEmail, subject: r?.subject || '' });
      continue;
    }
    if (!fromEmail) {
      skipped.push({ reason: 'no-sender', subject: r?.subject || '' });
      continue;
    }
    const companyKey = resolveCompanyKeyByEmail(fromEmail, contacts);
    if (!companyKey) {
      skipped.push({ reason: 'unknown-sender', fromEmail });
      continue;
    }
    if (seen.has(companyKey)) continue;
    seen.add(companyKey);
    toSuppress.push({ companyKey, fromEmail });
  }
  return { toSuppress, skipped };
}

async function run() {
  const contactsPath = arg('--contacts', path.join(ROOT, 'data/employer-outreach/contacts.json'));
  const logPath = arg('--log', path.join(ROOT, 'data/employer-outreach/send-log.json'));
  const queuePath = arg('--queue', path.join(ROOT, 'data/employer-outreach/inbound-replies.jsonl'));
  const apply = has('--apply');

  // Inbound replies: either a single CLI reply or the accumulated queue.
  const cliFrom = arg('--from', '');
  let replies;
  if (cliFrom && cliFrom !== true) {
    replies = [{ from: cliFrom, subject: arg('--subject', '') || '', body: arg('--body', '') || '' }];
  } else {
    replies = loadInboundQueue(queuePath);
  }

  if (!replies.length) {
    console.log(`Nessuna reply da processare (queue: ${path.relative(ROOT, path.resolve(queuePath))}).`);
    return;
  }

  const contacts = loadJson(contactsPath, {});
  const { toSuppress, skipped } = classifyReplies(replies, contacts);

  console.log(`${replies.length} reply lette — ${toSuppress.length} STOP da sopprimere, ${skipped.length} saltate.`);
  for (const s of skipped) {
    console.log(`  ↷ skip [${s.reason}] ${s.fromEmail || s.subject || ''}`);
  }
  for (const t of toSuppress) {
    console.log(`  ⛔ ${t.companyKey}  ←  ${t.fromEmail}`);
  }

  if (!apply) {
    console.log('\nDRY-RUN — nessuna scrittura. Usa --apply per sopprimere.');
    return;
  }
  if (!toSuppress.length) {
    console.log('\nNiente da applicare.');
    return;
  }

  // 1) Local send-log (always — works without Firestore).
  const sendLog = loadSendLog(logPath);
  for (const t of toSuppress) {
    suppressInSendLog(sendLog, t.companyKey, `STOP reply da ${t.fromEmail}`);
  }
  saveSendLog(logPath, sendLog);
  console.log(`\n✅ send-log aggiornato (${toSuppress.length} suppressed): ${path.relative(ROOT, path.resolve(logPath))}`);

  // 2) Firestore (best-effort, mirrors the one-click write).
  let db = null;
  let serverTimestamp = new Date().toISOString();
  try {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath || !fs.existsSync(credPath)) {
      console.warn('↷ Firestore: GOOGLE_APPLICATION_CREDENTIALS non impostato — suppression scritta solo nel send-log locale.');
    } else {
      const { getFirestoreDb } = await import('./lib/firestore-admin.mjs');
      const adminMod = await import('firebase-admin');
      const admin = adminMod.default || adminMod;
      db = await getFirestoreDb();
      serverTimestamp = admin.firestore.FieldValue.serverTimestamp();
    }
  } catch (err) {
    console.warn(`↷ Firestore non disponibile (${err.message}) — suppression scritta solo nel send-log locale.`);
    db = null;
  }
  if (db) {
    let written = 0;
    for (const t of toSuppress) {
      try {
        await writeSuppression({ db, companyKey: t.companyKey, serverTimestamp, source: 'stop-reply', fromEmail: t.fromEmail });
        written++;
      } catch (err) {
        console.warn(`↷ Firestore write fallita per ${t.companyKey}: ${err.message}`);
      }
    }
    console.log(`✅ Firestore employer_outreach_suppression aggiornato (${written}/${toSuppress.length}).`);
  }

  // 3) Truncate the processed queue (only when we read it from disk, applied OK).
  if (!(cliFrom && cliFrom !== true)) {
    try {
      fs.writeFileSync(path.resolve(queuePath), '', 'utf8');
      console.log(`🧹 Coda inbound svuotata: ${path.relative(ROOT, path.resolve(queuePath))}`);
    } catch { /* queue file may not exist on disk — fine */ }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((err) => { console.error(err); process.exitCode = 1; });
}
