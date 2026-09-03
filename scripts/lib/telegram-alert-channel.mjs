/**
 * Telegram as a PER-READER notification channel for job alerts (issue #6594,
 * "Fase 3 canali notifica" of #5314).
 *
 * ── WHY TELEGRAM, AND WHY IT WAS NOT ACTUALLY BLOCKED ─────────────────────
 * The issue was filed as "provider e credenziali mancanti": no provider chosen
 * for any of push / WhatsApp / Telegram, and no credential for any of them.
 * That premise holds for two of the three and NOT for Telegram:
 *
 *   - WhatsApp Business API needs a Meta/Twilio business account with a
 *     billed message tier. No credential exists and none can be minted from
 *     inside a CI run — that one is a real capability block.
 *   - Web Push needs no third party (VAPID keys are self-generated), but it
 *     needs a service worker + a subscription store + a key pair published to
 *     Remote Config, which is its own vertical.
 *   - Telegram's Bot API is FREE, needs no account creation, and the
 *     credential ALREADY EXISTS: `TELEGRAM_BOT_TOKEN` is in Remote Config and
 *     scripts/lib/telegram-client.mjs has been sending with it for the
 *     broadcast channel. VISION.md D7 ("free-tier prima") picks it.
 *
 * So the provider decision for the Telegram channel is: the native Bot API,
 * with the bot that already exists. No new credential, no new vendor.
 *
 * ── THE CONSENT MODEL ─────────────────────────────────────────────────────
 * A Telegram bot cannot message someone who has not written to it first —
 * the platform enforces the opt-in, which is the strongest consent primitive
 * of the three channels. What the platform does NOT do is tell us WHICH
 * subscriber a chat belongs to, and an unverified "reply with your email"
 * would let anyone route another reader's alerts to their own chat.
 *
 * The link is therefore a one-shot capability token:
 *
 *   1. the sender mints a token bound to the recipient address and renders
 *      `https://t.me/<bot>?start=<token>` in the email that address receives;
 *   2. the reader taps it and presses Start — Telegram delivers
 *      `/start <token>` to the bot from THEIR chat id;
 *   3. scripts/link-telegram-alert-chats.mjs redeems the token (single use,
 *      TTL-bounded) and stamps the chat id on the subscriber document.
 *
 * Possession of the token proves possession of the mailbox, so the binding is
 * as strong as the email channel it rides on. `/stop` clears the binding —
 * withdrawal has to be available from inside the channel itself, not only on
 * a web page the reader would have to go find.
 *
 * Everything here is PURE except the four small Firestore helpers at the
 * bottom, which take `db` as an argument so the tests can hand them a fake.
 */

import { randomBytes } from 'node:crypto';

/** Firestore collection holding un-redeemed link tokens. */
export const LINK_TOKENS_COLLECTION = 'telegram_link_tokens';

/** Subscriber collection the chat id is stamped on (same doc the digest reads). */
export const SUBSCRIBERS_COLLECTION = 'job_alert_subscribers';

/**
 * How long a minted link stays redeemable. Long enough that an alert read a
 * few days late still links, short enough that a forwarded old email is not a
 * standing capability on someone else's alerts.
 */
export const LINK_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Telegram's `?start=` payload accepts at most 64 characters from
 * `[A-Za-z0-9_-]`. 32 hex chars (128 bits) is well inside that and leaves no
 * room for a guessing attack.
 */
export const LINK_TOKEN_BYTES = 16;

/** @returns {string} a fresh, URL-safe link token. */
export function newLinkToken() {
  return randomBytes(LINK_TOKEN_BYTES).toString('hex');
}

/**
 * The bot that owns the ALERT conversations. Defaults to the broadcast bot's
 * username when no dedicated one is configured — same token, same bot, so a
 * single BotFather registration serves both surfaces.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string} username without the leading `@`, or '' when unset.
 */
export function resolveAlertBotUsername(env = process.env) {
  const raw = String(env.TELEGRAM_ALERT_BOT_USERNAME || env.TELEGRAM_BOT_USERNAME || '').trim();
  return raw.replace(/^@/, '');
}

/**
 * The deep link a reader taps to bind their chat to their address.
 * Returns '' when either half is missing so callers can simply omit the CTA
 * rather than render a broken `t.me//?start=` link.
 *
 * @param {string} botUsername
 * @param {string} token
 * @returns {string}
 */
export function buildTelegramLinkUrl(botUsername, token) {
  const user = String(botUsername || '').replace(/^@/, '').trim();
  const tok = String(token || '').trim();
  if (!user || !tok) return '';
  return `https://t.me/${user}?start=${encodeURIComponent(tok)}`;
}

/**
 * Extract the command a reader sent from a raw getUpdates entry.
 *
 * Only `message` updates matter: edited messages, channel posts and callback
 * queries cannot carry a `/start` payload from a private chat. Returns null
 * for anything unrecognised so the caller can skip without branching.
 *
 * @param {object} update
 * @returns {{ updateId: number, chatId: string, command: string, payload: string }|null}
 */
export function parseBotCommand(update) {
  const updateId = Number(update?.update_id);
  const message = update?.message;
  const chatId = message?.chat?.id;
  const text = String(message?.text || '').trim();
  if (!Number.isFinite(updateId) || chatId == null || !text.startsWith('/')) return null;

  // `/start@mybot payload` is what Telegram delivers in groups; strip the
  // @mention so the same handler serves both chat kinds.
  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand.split('@')[0].toLowerCase();
  return { updateId, chatId: String(chatId), command, payload: rest.join(' ').trim() };
}

/**
 * Whether a subscriber document may receive Telegram alerts.
 *
 * Three conditions, all of them explicit rather than inferred: a chat id was
 * bound, the reader has not sent `/stop` since, and the channel was not
 * disabled from the preference centre. Missing field = not opted in, never
 * "opted in by default" — the whole point of the flow above.
 *
 * @param {object} subscriber Firestore data of job_alert_subscribers/{email}
 * @returns {boolean}
 */
export function isTelegramAlertRecipient(subscriber) {
  const data = subscriber || {};
  const chatId = String(data.telegramChatId || '').trim();
  if (!chatId) return false;
  if (data.telegramOptOut === true) return false;
  if (data.channels && data.channels.telegram === false) return false;
  return true;
}

const STRINGS = {
  it: {
    heroOne: (company) => `Nuovi annunci da ${company}`,
    heroMany: (n) => `Nuovi annunci da ${n} aziende che segui`,
    sectionNew: (n) => (n === 1 ? '1 nuovo annuncio' : `${n} nuovi annunci`),
    manage: 'Gestisci le aziende seguite',
    stop: 'Scrivi /stop per non ricevere più queste notifiche su Telegram.',
    linked: 'Fatto! Riceverai qui gli avvisi per le aziende che segui. Scrivi /stop per fermarli.',
    unlinked: 'Ok, non riceverai più avvisi su Telegram. Continuerai a riceverli via email.',
    unknownToken: 'Questo link non è più valido. Aprine uno nuovo dall’ultima email di avviso.',
  },
  en: {
    heroOne: (company) => `New openings at ${company}`,
    heroMany: (n) => `New openings at ${n} companies you follow`,
    sectionNew: (n) => (n === 1 ? '1 new opening' : `${n} new openings`),
    manage: 'Manage followed companies',
    stop: 'Send /stop to stop receiving these notifications on Telegram.',
    linked: 'Done! You will get alerts for the companies you follow here. Send /stop to stop them.',
    unlinked: 'Okay, no more Telegram alerts. You will keep receiving them by email.',
    unknownToken: 'This link is no longer valid. Open a fresh one from your latest alert email.',
  },
  de: {
    heroOne: (company) => `Neue Stellen bei ${company}`,
    heroMany: (n) => `Neue Stellen bei ${n} Unternehmen, denen Sie folgen`,
    sectionNew: (n) => (n === 1 ? '1 neue Stelle' : `${n} neue Stellen`),
    manage: 'Gefolgte Unternehmen verwalten',
    stop: 'Senden Sie /stop, um diese Telegram-Benachrichtigungen zu beenden.',
    linked: 'Fertig! Sie erhalten hier Benachrichtigungen zu Ihren Unternehmen. /stop beendet sie.',
    unlinked: 'In Ordnung, keine Telegram-Benachrichtigungen mehr. Per E-Mail erhalten Sie sie weiterhin.',
    unknownToken: 'Dieser Link ist nicht mehr gültig. Öffnen Sie einen neuen aus Ihrer letzten E-Mail.',
  },
  fr: {
    heroOne: (company) => `Nouvelles offres chez ${company}`,
    heroMany: (n) => `Nouvelles offres chez ${n} entreprises que vous suivez`,
    sectionNew: (n) => (n === 1 ? '1 nouvelle offre' : `${n} nouvelles offres`),
    manage: 'Gérer les entreprises suivies',
    stop: 'Envoyez /stop pour ne plus recevoir ces notifications sur Telegram.',
    linked: 'C’est fait ! Vous recevrez ici les alertes des entreprises suivies. /stop pour les arrêter.',
    unlinked: 'D’accord, plus d’alertes Telegram. Vous continuerez à les recevoir par e-mail.',
    unknownToken: 'Ce lien n’est plus valide. Ouvrez-en un nouveau depuis votre dernier e-mail d’alerte.',
  },
};

/**
 * @param {string} locale
 * @returns {typeof STRINGS.it}
 */
export function telegramStrings(locale) {
  const key = String(locale || 'it').slice(0, 2).toLowerCase();
  return STRINGS[key] || STRINGS.it;
}

/**
 * Render the Telegram twin of a CompanyAlert email.
 *
 * Deliberately NOT a port of the HTML template: Telegram gives ~4k characters
 * and no layout, so the useful message is the list of links, one line each,
 * plus the way out. The card budget the email applies upstream already picked
 * WHICH jobs matter; this only has to not exceed the wire limit, which
 * `sendMessage` would otherwise truncate mid-tag and render as literal markup.
 *
 * Every dynamic value goes through `escapeHtml` — a job title containing `&`
 * or `<` is the ordinary case, not the attack case, and Telegram rejects the
 * whole message when the HTML does not parse.
 *
 * Pure.
 *
 * @param {{ sections: Array<{companyName: string, jobs: Array<object>, hubUrl?: string}>, locale?: string, manageUrl?: string, maxLength?: number, escape?: (s: unknown) => string }} opts
 * @returns {string} '' when there is nothing to say.
 */
export function renderCompanyAlertTelegram({
  sections,
  locale = 'it',
  manageUrl = '',
  maxLength = 4096,
  escape = defaultEscapeHtml,
} = {}) {
  const list = (sections || []).filter((s) => s && Array.isArray(s.jobs) && s.jobs.length > 0);
  if (list.length === 0) return '';

  const s = telegramStrings(locale);
  const hero = list.length === 1 ? s.heroOne(list[0].companyName) : s.heroMany(list.length);
  const lines = [`<b>${escape(hero)}</b>`, ''];

  for (const section of list) {
    if (list.length > 1) lines.push(`<b>${escape(section.companyName)}</b> — ${escape(s.sectionNew(section.jobs.length))}`);
    for (const job of section.jobs) {
      const place = [job.location, job.canton].filter(Boolean).join(', ');
      const label = escape(job.title || section.companyName);
      const url = String(job.url || section.hubUrl || '');
      lines.push(url ? `• <a href="${escape(url)}">${label}</a>${place ? ` — ${escape(place)}` : ''}` : `• ${label}`);
    }
    lines.push('');
  }

  if (manageUrl) lines.push(`<a href="${escape(manageUrl)}">${escape(s.manage)}</a>`);
  lines.push(escape(s.stop));

  const text = lines.join('\n');
  if (text.length <= maxLength) return text;
  // Drop whole trailing job lines rather than cutting a tag in half: the
  // footer (manage + /stop) is the part a truncated message must never lose,
  // because it carries the way out.
  const footer = lines.slice(manageUrl ? -2 : -1).join('\n');
  const kept = [];
  let used = footer.length + 1;
  for (const line of lines.slice(0, manageUrl ? -2 : -1)) {
    if (used + line.length + 1 > maxLength) break;
    used += line.length + 1;
    kept.push(line);
  }
  return [...kept, footer].join('\n');
}

function defaultEscapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Mint a single-use link token for an address. Idempotence is NOT wanted here:
 * every email may carry a fresh token, and an unredeemed older one simply
 * expires. Returns the token so the caller can build the deep link.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} email
 * @param {{ now?: number, ttlMs?: number, token?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function mintLinkToken(db, email, { now = Date.now(), ttlMs = LINK_TOKEN_TTL_MS, token = newLinkToken() } = {}) {
  const address = String(email || '').toLowerCase().trim();
  if (!address) return '';
  await db.collection(LINK_TOKENS_COLLECTION).doc(token).set({
    email: address,
    createdAt: now,
    expiresAt: now + ttlMs,
  });
  return token;
}

/**
 * Redeem a `/start` payload: bind the chat id to the address the token was
 * minted for, then delete the token so it cannot bind a second chat.
 *
 * Expiry is checked in code rather than trusted to a TTL policy: Firestore TTL
 * deletion is best-effort and can lag by days, which would leave a stale
 * capability live exactly as long as we were not looking.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ token: string, chatId: string, now?: number }} opts
 * @returns {Promise<{ ok: boolean, email: string|null, reason: string|null }>}
 */
export async function redeemLinkToken(db, { token, chatId, now = Date.now() }) {
  const tok = String(token || '').trim();
  const chat = String(chatId || '').trim();
  if (!tok || !chat) return { ok: false, email: null, reason: 'missing token or chat id' };

  const ref = db.collection(LINK_TOKENS_COLLECTION).doc(tok);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, email: null, reason: 'unknown token' };

  const data = snap.data() || {};
  if (Number(data.expiresAt) < now) {
    await ref.delete();
    return { ok: false, email: null, reason: 'expired token' };
  }

  const email = String(data.email || '').toLowerCase().trim();
  if (!email) return { ok: false, email: null, reason: 'token has no address' };

  await db.collection(SUBSCRIBERS_COLLECTION).doc(email).set({
    telegramChatId: chat,
    telegramLinkedAt: now,
    telegramOptOut: false,
  }, { merge: true });
  await ref.delete();
  return { ok: true, email, reason: null };
}

/**
 * Withdraw consent for a chat id (`/stop`). Clears the binding on every
 * subscriber it is stamped on — a reader who linked twice from two addresses
 * expects one /stop to silence the bot, not one per address.
 *
 * The chat id is NOT deleted but flagged: keeping `telegramOptOut` means a
 * later re-link is a deliberate act, and means the preference centre can show
 * "you turned this off" rather than "never connected".
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ chatId: string, now?: number }} opts
 * @returns {Promise<number>} how many subscriber documents were updated.
 */
export async function unlinkChat(db, { chatId, now = Date.now() }) {
  const chat = String(chatId || '').trim();
  if (!chat) return 0;
  const snap = await db.collection(SUBSCRIBERS_COLLECTION).where('telegramChatId', '==', chat).get();
  let updated = 0;
  for (const doc of snap.docs || []) {
    await doc.ref.set({ telegramOptOut: true, telegramOptOutAt: now }, { merge: true });
    updated += 1;
  }
  return updated;
}

/**
 * Chat ids for a batch of addresses, keyed by lowercase address.
 * Addresses with no binding, or an opted-out one, are simply absent — the
 * caller iterates what it got rather than re-checking consent per recipient.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string[]} emails
 * @param {{ chunkSize?: number }} [opts]
 * @returns {Promise<Map<string, string>>}
 */
export async function loadTelegramChatIds(db, emails, { chunkSize = 200 } = {}) {
  const out = new Map();
  const list = [...new Set((emails || []).map((e) => String(e || '').toLowerCase().trim()).filter(Boolean))];
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    try {
      const snaps = await db.getAll(...chunk.map((e) => db.collection(SUBSCRIBERS_COLLECTION).doc(e)));
      chunk.forEach((email, idx) => {
        const doc = snaps[idx];
        if (!doc?.exists) return;
        const data = doc.data() || {};
        if (isTelegramAlertRecipient(data)) out.set(email, String(data.telegramChatId));
      });
    } catch (err) {
      // Fail-open on the EMAIL channel: a read blip must never turn into a
      // missed alert. It only costs the Telegram copy of this run's message.
      console.warn(`   ⚠️  Telegram chat lookup failed for ${chunk.length} address(es): ${err?.message || err}`);
    }
  }
  return out;
}
