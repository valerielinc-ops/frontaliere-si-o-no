/**
 * Thin Telegram Bot API client shared by the Telegram broadcast scripts.
 *
 * The Bot API is FREE (no paid tier) and needs only a bot token + a target
 * chat id. For a broadcast channel the bot must be an ADMIN of the channel;
 * the target is then the channel's `@username` (public) or numeric `-100…` id
 * (private). Both are read from the environment so no secret is ever hardcoded.
 *
 * Soft, defensive style mirroring scripts/lib/reddit-client.mjs: concise
 * console logs, never throw — callers (the poster) should never be blocked by
 * a transient API hiccup, and a run with NO credentials configured must skip
 * cleanly (exit 0) rather than fail CI.
 */

import { isAmbiguousSocialPublishResponse } from './social-publish-outcome.mjs';

// Telegram hard limit on a single sendMessage `text` (UTF-16 code units).
export const TELEGRAM_MESSAGE_MAX = 4096;

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

const TELEGRAM_HTML_TAG_RE = /<\/?[A-Za-z][^>]*>/g;
const TELEGRAM_HTML_ENTITY_RE = /^&(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);/i;

function telegramHtmlTagName(tag) {
  return tag.match(/^<\/?\s*([A-Za-z][\w-]*)/)?.[1]?.toLowerCase() || '';
}

function isTelegramHtmlSelfClosingTag(tag, name) {
  return /\/\s*>$/.test(tag) || new Set(['br', 'hr', 'img', 'input', 'meta', 'link']).has(name);
}

function closingTelegramHtmlTags(openTags) {
  return [...openTags].reverse().map((name) => `</${name}>`).join('');
}

/**
 * Take a prefix without splitting a Unicode code point or an HTML entity.
 * The returned length is measured in UTF-16 code units, matching the limit
 * used by the Bot API client and by JavaScript strings.
 */
function takeTelegramTextPrefix(value, maxLength) {
  let result = '';
  for (let offset = 0; offset < value.length;) {
    const entity = value.slice(offset).match(TELEGRAM_HTML_ENTITY_RE)?.[0];
    const unit = entity || String.fromCodePoint(value.codePointAt(offset));
    if (result.length + unit.length > maxLength) break;
    result += unit;
    offset += unit.length;
  }
  return result;
}

function truncateUnicode(value, maxLength) {
  if (value.length <= maxLength) return value;
  return takeTelegramTextPrefix(value, maxLength);
}

/**
 * Truncate Telegram HTML without leaving a partial tag behind. A raw
 * `text.slice(0, 4096)` can cut an `<a href="…">` in half, which makes the
 * Bot API reject an otherwise valid broadcast with "Unclosed start tag".
 */
export function truncateTelegramHtml(value, maxLength = TELEGRAM_MESSAGE_MAX) {
  if (value.length <= maxLength) return value;

  let output = '';
  const openTags = [];
  let cursor = 0;
  const finish = () => output + closingTelegramHtmlTags(openTags);
  const appendText = (chunk) => {
    const reservedForClosingTags = closingTelegramHtmlTags(openTags).length;
    const available = Math.max(0, maxLength - output.length - reservedForClosingTags);
    if (chunk.length <= available) {
      output += chunk;
      return true;
    }
    output += takeTelegramTextPrefix(chunk, available);
    return false;
  };

  const tags = value.matchAll(TELEGRAM_HTML_TAG_RE);
  for (const match of tags) {
    const plainText = value.slice(cursor, match.index);
    if (!appendText(plainText)) return finish();

    const tag = match[0];
    const name = telegramHtmlTagName(tag);
    const closing = /^<\//.test(tag);
    if (closing) {
      if (output.length + tag.length > maxLength) return finish();
      output += tag;
      const openIndex = openTags.lastIndexOf(name);
      if (openIndex !== -1) openTags.splice(openIndex, 1);
    } else {
      const selfClosing = isTelegramHtmlSelfClosingTag(tag, name);
      const nextOpenTags = selfClosing ? openTags : [...openTags, name];
      if (output.length + tag.length + closingTelegramHtmlTags(nextOpenTags).length > maxLength) {
        return finish();
      }
      output += tag;
      if (!selfClosing) openTags.push(name);
    }
    cursor = match.index + tag.length;
  }

  const tail = value.slice(cursor);
  if (!appendText(tail)) return finish();
  return output;
}

/**
 * Resolve the bot token + target chat id from the environment.
 *   TELEGRAM_BOT_TOKEN  — BotFather token (secret).
 *   TELEGRAM_CHANNEL_ID — channel @username or numeric -100… id.
 * `TELEGRAM_CHAT_ID` is accepted as an alias for the channel id.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ token: string, chatId: string }}
 */
export function resolveTelegramCredentials(env = process.env) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(env.TELEGRAM_CHANNEL_ID || env.TELEGRAM_CHAT_ID || '').trim();
  return { token, chatId };
}

/**
 * Whether a real send is possible (both a token AND a target are set).
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function hasTelegramCredentials(env = process.env) {
  const { token, chatId } = resolveTelegramCredentials(env);
  return Boolean(token && chatId);
}

/** Resolve @username and numeric aliases to Telegram's canonical chat ID. */
export async function getCanonicalTelegramChatId({ token, chatId, fetchImpl = globalThis.fetch } = {}) {
  const fail = (error) => ({ ok: false, chatId: null, error });
  if (typeof fetchImpl !== 'function') return fail('no fetch impl available');
  if (!token) return fail('missing bot token');
  if (!chatId) return fail('missing chat id');
  try {
    const endpoint = `${TELEGRAM_API_BASE}/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`;
    const response = await fetchImpl(endpoint);
    const data = await response.json().catch(() => null);
    const canonicalId = data?.result?.id;
    if (response.ok && data?.ok === true && Number.isSafeInteger(canonicalId)) {
      return { ok: true, chatId: String(canonicalId), error: null };
    }
    return fail(data?.description || `Telegram getChat failed (HTTP ${response.status ?? '?'})`);
  } catch (error) {
    return fail(error?.message || String(error));
  }
}

/**
 * Escape the three characters that are special in Telegram's HTML parse mode.
 * Apply to every piece of DYNAMIC text (job titles, company names, …) before
 * embedding it in an HTML message; never to the surrounding markup itself.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Post a message to a Telegram chat/channel via the Bot API. Never throws —
 * catches and returns `{ ok:false, error, deliveryUncertain }`. Explicit Bot
 * API rejections are known not to have delivered; transport or malformed
 * responses keep delivery uncertain so callers do not release reservations.
 * Truncates over-long text to the API's hard limit so a big digest can't be
 * rejected outright.
 *
 * @param {{ token: string, chatId: string|number, text: string, parseMode?: string, disablePreview?: boolean, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ok:boolean, messageId:number|null, error:string|null, deliveryUncertain:boolean}>}
 */
export async function sendMessage({
  token,
  chatId,
  text,
  parseMode = 'HTML',
  disablePreview = true,
  fetchImpl = globalThis.fetch,
} = {}) {
  const fail = (error, deliveryUncertain = false) => ({ ok: false, messageId: null, error, deliveryUncertain });

  if (typeof fetchImpl !== 'function') return fail('no fetch impl available');
  if (!token) return fail('missing bot token');
  if (!chatId) return fail('missing chat id');
  if (!text) return fail('missing text');

  const body = String(parseMode).toUpperCase() === 'HTML'
    ? truncateTelegramHtml(text, TELEGRAM_MESSAGE_MAX)
    : truncateUnicode(text, TELEGRAM_MESSAGE_MAX);
  const endpoint = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: body,
        parse_mode: parseMode,
        disable_web_page_preview: disablePreview,
      }),
    });
    const data = await res.json().catch(() => null);
    if (data?.ok && data.result) {
      if (!Number.isSafeInteger(data.result.message_id) || data.result.message_id <= 0) {
        return fail('Telegram accepted the send but did not return a valid message_id', true);
      }
      return { ok: true, messageId: data.result.message_id, error: null, deliveryUncertain: false };
    }
    const desc = data?.description || `HTTP ${res?.status ?? '?'}`;
    const explicitlyRejected = data?.ok === false
      && Number(res?.status) >= 400
      && Number(res?.status) < 500
      && !isAmbiguousSocialPublishResponse(res);
    return fail(`telegram error: ${desc}`, !explicitlyRejected);
  } catch (err) {
    return fail(err?.message || String(err), true);
  }
}

/**
 * Read the member count of a Telegram chat/channel via the Bot API. Same
 * defensive contract as sendMessage(): never throws, `{ok:false, error}` on
 * any failure (missing credentials, HTTP error, malformed envelope).
 *
 * @param {{ token: string, chatId: string|number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ok:boolean, count:number|null, error:string|null}>}
 */
export async function getChatMemberCount({ token, chatId, fetchImpl = globalThis.fetch } = {}) {
  const fail = (error) => ({ ok: false, count: null, error });

  if (typeof fetchImpl !== 'function') return fail('no fetch impl available');
  if (!token) return fail('missing bot token');
  if (!chatId) return fail('missing chat id');

  const endpoint = `${TELEGRAM_API_BASE}/bot${token}/getChatMemberCount?chat_id=${encodeURIComponent(chatId)}`;

  try {
    const res = await fetchImpl(endpoint);
    const data = await res.json().catch(() => null);
    if (data?.ok && Number.isSafeInteger(data.result) && data.result >= 0) {
      return { ok: true, count: data.result, error: null };
    }
    const desc = data?.description || (data?.ok
      ? 'member count result must be a non-negative safe integer'
      : `HTTP ${res?.status ?? '?'}`);
    return fail(`telegram error: ${desc}`);
  } catch (err) {
    return fail(err?.message || String(err));
  }
}
