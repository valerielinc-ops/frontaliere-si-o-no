/**
 * Thin Reddit API client shared by the Reddit schedulers.
 *
 * Reddit specifics honored here:
 *   • OAuth2 token endpoint requires HTTP Basic auth (client_id:client_secret)
 *     and a NON-default User-Agent header — Reddit blocks generic UAs.
 *   • Two auth modes, preferred first: (1) refresh-token grant,
 *     (2) script-app password grant. Access tokens last ~1h.
 *   • Submit endpoint posts form-urlencoded with `api_type=json`; Reddit's
 *     JSON envelope `{json:{errors,data}}` carries per-request errors that
 *     must be treated as failure even on HTTP 200.
 *
 * Soft, defensive style mirroring scripts/post-to-facebook.mjs: concise
 * console logs, never throw — callers (schedulers) should never be blocked
 * by a transient API hiccup.
 */

// Reddit hard limit on submission `title` length.
export const REDDIT_TITLE_MAX = 300;

const TOKEN_ENDPOINT = 'https://www.reddit.com/api/v1/access_token';
const SUBMIT_ENDPOINT = 'https://oauth.reddit.com/api/submit';

/**
 * Return the User-Agent to send on every Reddit request. Reddit requires a
 * descriptive, app-specific UA (generic ones like the default fetch UA are
 * rate-limited / blocked). Override via REDDIT_USER_AGENT.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function userAgent(env = process.env) {
  return env.REDDIT_USER_AGENT || 'web:frontaliereticino:v1.0 (by /u/frontaliereticino)';
}

/**
 * Obtain a Reddit OAuth2 access token. Tries the refresh-token grant first,
 * then falls back to the script-app password grant. Returns null (never
 * throws) when credentials are missing or the call fails.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string|null>}
 */
export async function getAccessToken(env = process.env, fetchImpl = globalThis.fetch) {
  const clientId = env.REDDIT_CLIENT_ID;
  const clientSecret = env.REDDIT_CLIENT_SECRET;
  const refreshToken = env.REDDIT_REFRESH_TOKEN;
  const username = env.REDDIT_USERNAME;
  const password = env.REDDIT_PASSWORD;
  const ua = userAgent(env);

  if (typeof fetchImpl !== 'function') {
    console.warn('⚠️  Reddit: no fetch impl available — cannot get access token');
    return null;
  }
  if (!clientId || !clientSecret) {
    console.warn('⚠️  Reddit: REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET not set — skipping');
    return null;
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  // Helper: run one token grant and return access_token | null.
  const requestToken = async (body, label) => {
    try {
      const res = await fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': ua,
        },
        body,
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.access_token) {
        console.log(`✅ Reddit access token via ${label} (expires in ${data.expires_in || '?'}s)`);
        return data.access_token;
      }
      console.warn(`⚠️  Reddit token ${label} failed (HTTP ${res.status}): ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    } catch (err) {
      console.warn(`⚠️  Reddit token ${label} error: ${err.message}`);
      return null;
    }
  };

  // Mode 1 — refresh token (preferred; refresh tokens are long-lived).
  if (refreshToken) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const token = await requestToken(body, 'refresh_token');
    if (token) return token;
    console.warn('ℹ️  Reddit: refresh-token grant failed — trying password grant');
  }

  // Mode 2 — script-app password grant (fallback).
  if (username && password) {
    const body = new URLSearchParams({
      grant_type: 'password',
      username,
      password,
    });
    const token = await requestToken(body, 'password');
    if (token) return token;
  }

  console.warn('⚠️  Reddit: no usable auth mode (set REDDIT_REFRESH_TOKEN or REDDIT_USERNAME/REDDIT_PASSWORD) — skipping');
  return null;
}

/**
 * Submit a post to Reddit. Builds the form body, parses the Reddit JSON
 * envelope, and maps a non-empty `errors` array to a failure. Never throws —
 * catches and returns `{ok:false, error}`.
 *
 * @param {object} opts
 * @param {string} opts.token — Bearer access token from getAccessToken().
 * @param {string} opts.subreddit — subreddit name without the `r/` prefix.
 * @param {'self'|'link'} [opts.kind] — 'self' (text/markdown) or 'link'.
 * @param {string} opts.title — submission title (≤300 chars).
 * @param {string} [opts.url] — link URL (kind='link').
 * @param {string} [opts.text] — markdown body (kind='self').
 * @param {string} [opts.flairId]
 * @param {string} [opts.flairText]
 * @param {boolean} [opts.sendReplies]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.ua]
 * @returns {Promise<{ok:boolean, id:string|null, name:string|null, url:string|null, error:string|null}>}
 */
export async function submitPost({
  token,
  subreddit,
  kind = 'self',
  title,
  url,
  text,
  flairId,
  flairText,
  sendReplies = false,
  fetchImpl = globalThis.fetch,
  ua,
} = {}) {
  const fail = (error) => ({ ok: false, id: null, name: null, url: null, error });

  if (typeof fetchImpl !== 'function') return fail('no fetch impl available');
  if (!token) return fail('missing access token');
  if (!subreddit) return fail('missing subreddit');
  if (!title) return fail('missing title');
  if (kind === 'link' && !url) return fail('kind=link requires url');
  if (kind === 'self' && !text) return fail('kind=self requires text');

  const userAgentHeader = ua || userAgent();

  const body = new URLSearchParams({
    api_type: 'json',
    sr: subreddit,
    kind,
    title,
    sendreplies: sendReplies ? 'true' : 'false',
  });
  if (kind === 'link' && url) body.append('url', url);
  if (kind === 'self' && text) body.append('text', text);
  if (flairId) body.append('flair_id', flairId);
  if (flairText) body.append('flair_text', flairText);

  try {
    const res = await fetchImpl(SUBMIT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgentHeader,
      },
      body,
    });
    const data = await res.json().catch(() => null);

    // Reddit nests per-request errors under json.errors even on HTTP 200.
    const errors = data?.json?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      // errors are arrays like ["SUBREDDIT_NOTALLOWED", "you ...", "sr"].
      const msg = errors.map((e) => (Array.isArray(e) ? e.slice(0, 2).join(': ') : String(e))).join('; ');
      return fail(`reddit errors: ${msg}`);
    }
    if (!res.ok) {
      return fail(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    }

    const result = data?.json?.data || {};
    return {
      ok: true,
      id: result.id || null,
      name: result.name || null,
      url: result.url || null,
      error: null,
    };
  } catch (err) {
    return fail(err.message);
  }
}
