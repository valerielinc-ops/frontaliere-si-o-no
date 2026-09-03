#!/usr/bin/env node
/**
 * Redeem Telegram alert link tokens (issue #6594, "Fase 3 canali notifica").
 *
 * The inbound half of the Telegram notification channel. The senders mint a
 * one-shot token and render `https://t.me/<bot>?start=<token>` in the email;
 * this runner polls the Bot API for the `/start <token>` the reader's tap
 * produces and binds their chat id to the address the token was minted for.
 * Rationale for the whole flow — and why possession of the token is the
 * consent proof — is in scripts/lib/telegram-alert-channel.mjs.
 *
 * A cron and not a webhook: a webhook needs a public HTTPS endpoint with a
 * secret path and an always-on receiver, which is a deployment surface this
 * repo does not have for a feature whose traffic is a handful of taps a day.
 * `getUpdates` with a persisted offset delivers exactly the same updates, and
 * a poll that misses a cycle just links a few minutes later.
 *
 * Fail-soft, like every other Telegram script here: no credentials, no
 * updates, or an API error all exit 0. This must never be the reason a CI run
 * goes red — the email channel is unaffected either way.
 *
 * Usage: node scripts/link-telegram-alert-chats.mjs [--dry-run]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getUpdates, sendMessage, resolveTelegramCredentials } from './lib/telegram-client.mjs';
import {
  parseBotCommand,
  redeemLinkToken,
  unlinkChat,
  telegramStrings,
} from './lib/telegram-alert-channel.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Where the acknowledgement cursor lives. One document, one field: Telegram
 * keeps unacknowledged updates for 24h, so losing it costs a re-processing of
 * at most a day of taps — and re-linking the same chat is a no-op.
 */
export const CURSOR_DOC_PATH = ['system', 'telegram_alert_bot'];

let _db = null;

/** Test seam: inject a fake Firestore (mirrors send-company-alerts.mjs). */
export function __setFirestoreAdminForTest(fakeDb) {
  _db = fakeDb;
}

async function getFirestoreAdmin() {
  if (_db) return _db;
  const fs = await import('node:fs');
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (getApps().length === 0) {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credPath || !fs.existsSync(credPath)) {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set or file missing');
    }
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    initializeApp({ credential: cert(cred), projectId: cred.project_id });
  }
  _db = getFirestore();
  return _db;
}

/**
 * Apply one parsed command. Exported so the tests can drive the whole state
 * machine — link, withdraw, unknown token — without an API round trip.
 *
 * The reply is part of the contract, not politeness: a reader who taps a link
 * and gets silence cannot tell "linked" from "broken", and the `/stop`
 * confirmation is what makes the withdrawal verifiable to the person making
 * it.
 *
 * @param {object} db
 * @param {{ chatId: string, command: string, payload: string }} cmd
 * @param {{ now?: number, token: string, locale?: string, dryRun?: boolean, sendImpl?: typeof sendMessage }} opts
 * @returns {Promise<{ action: string, email: string|null, reply: string|null }>}
 */
export async function applyCommand(db, cmd, { now = Date.now(), token, locale = 'it', dryRun = false, sendImpl = sendMessage } = {}) {
  const s = telegramStrings(locale);
  let action = 'ignored';
  let email = null;
  let reply = null;

  if (cmd.command === '/start' && cmd.payload) {
    const result = await redeemLinkToken(db, { token: cmd.payload, chatId: cmd.chatId, now });
    if (result.ok) {
      action = 'linked';
      email = result.email;
      reply = s.linked;
    } else {
      action = `rejected:${result.reason}`;
      reply = s.unknownToken;
    }
  } else if (cmd.command === '/stop') {
    const updated = await unlinkChat(db, { chatId: cmd.chatId, now });
    action = updated > 0 ? 'unlinked' : 'unlinked:none';
    reply = s.unlinked;
  }

  if (reply && !dryRun) {
    await sendImpl({ token, chatId: cmd.chatId, text: reply });
  }
  return { action, email, reply };
}

async function main() {
  console.log('🔗 Telegram alert link — redeeming /start tokens');

  const { token } = resolveTelegramCredentials();
  if (!token) {
    console.log('   ⏭️  TELEGRAM_BOT_TOKEN not set — nothing to poll, skipping.');
    return;
  }

  const db = await getFirestoreAdmin();
  const cursorRef = db.collection(CURSOR_DOC_PATH[0]).doc(CURSOR_DOC_PATH[1]);
  const cursorSnap = await cursorRef.get();
  const lastUpdateId = Number(cursorSnap.exists ? (cursorSnap.data() || {}).lastUpdateId : NaN);
  const offset = Number.isFinite(lastUpdateId) ? lastUpdateId + 1 : null;

  const res = await getUpdates({ token, offset });
  if (!res.ok) {
    console.warn(`   ⚠️  getUpdates failed: ${res.error} — exiting clean, the next run retries.`);
    return;
  }
  console.log(`   Updates since ${offset ?? 'the beginning'}: ${res.updates.length}`);
  if (res.updates.length === 0) return;

  let highest = Number.isFinite(lastUpdateId) ? lastUpdateId : -1;
  const counts = {};
  for (const update of res.updates) {
    const cmd = parseBotCommand(update);
    if (cmd) {
      // Telegram stamps the client's UI language on every message — the
      // closest thing to a locale we have for someone who arrived from a
      // forwarded link, and better than defaulting the whole channel to it.
      const locale = update?.message?.from?.language_code || 'it';
      const { action, email } = await applyCommand(db, cmd, { token, locale, dryRun: DRY_RUN });
      counts[action] = (counts[action] || 0) + 1;
      if (email) console.log(`   ✅ ${action}: ${email} ← chat ${cmd.chatId}`);
      highest = Math.max(highest, cmd.updateId);
    } else if (Number.isFinite(Number(update?.update_id))) {
      // Not a command, but it still has to be acknowledged: leaving it
      // un-offset means every future poll re-reads it forever.
      highest = Math.max(highest, Number(update.update_id));
    }
  }

  console.log(`   ${JSON.stringify(counts)}`);
  if (DRY_RUN) {
    console.log(`   🔵 DRY RUN — cursor NOT advanced (would be ${highest})`);
    return;
  }
  if (highest >= 0) {
    await cursorRef.set({ lastUpdateId: highest, updatedAt: Date.now() }, { merge: true });
    console.log(`   📌 Cursor advanced to ${highest}`);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('❌ link-telegram-alert-chats failed:', err);
    process.exit(1);
  });
}
