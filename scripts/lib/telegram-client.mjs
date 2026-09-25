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

// Telegram hard limit on a single sendMessage `text` (UTF-16 code units).
export const TELEGRAM_MESSAGE_MAX = 4096;

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

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
 * catches and returns `{ ok:false, error }`. Truncates over-long text to the
 * API's hard limit so a big digest can't be rejected outright.
 *
 * @param {{ token: string, chatId: string|number, text: string, parseMode?: string, disablePreview?: boolean, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ok:boolean, messageId:number|null, error:string|null}>}
 */
export async function sendMessage({
  token,
  chatId,
  text,
  parseMode = 'HTML',
  disablePreview = true,
  fetchImpl = globalThis.fetch,
} = {}) {
  const fail = (error) => ({ ok: false, messageId: null, error });

  if (typeof fetchImpl !== 'function') return fail('no fetch impl available');
  if (!token) return fail('missing bot token');
  if (!chatId) return fail('missing chat id');
  if (!text) return fail('missing text');

  const body = text.length > TELEGRAM_MESSAGE_MAX ? text.slice(0, TELEGRAM_MESSAGE_MAX) : text;
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
      return { ok: true, messageId: data.result.message_id ?? null, error: null };
    }
    const desc = data?.description || `HTTP ${res?.status ?? '?'}`;
    return fail(`telegram error: ${desc}`);
  } catch (err) {
    return fail(err?.message || String(err));
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
    if (data?.ok && typeof data.result === 'number') {
      return { ok: true, count: data.result, error: null };
    }
    const desc = data?.description || `HTTP ${res?.status ?? '?'}`;
    return fail(`telegram error: ${desc}`);
  } catch (err) {
    return fail(err?.message || String(err));
  }
}
