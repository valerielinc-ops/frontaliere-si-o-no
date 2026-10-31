import { TextDecoder } from 'node:util';
import { parseCodexLogin } from '../../../functions/src/codexFallback.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const optionalString = value => value == null || typeof value === 'string';
const invalid = () => { throw new Error('darwin_broker_subscription_auth_unavailable'); };
function nativeTimestampValid(value) {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day] = parts.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

// codex-rs rust-v0.153.4, login/src/token_data.rs: IdClaims and
// decode_jwt_payload. Validate deserializability, not JWT authenticity: the
// existing provider verifies the original, unmodified token.
function nativeIdTokenValid(token) {
  if (typeof token !== 'string') return false;
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature || !/^[A-Za-z0-9_-]+$/.test(payload)) return false;
  try {
    const bytes = Buffer.from(payload, 'base64url');
    if (bytes.toString('base64url') !== payload) return false;
    const claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(claims) || !optionalString(claims.email)) return false;
    const profile = claims['https://api.openai.com/profile'];
    if (profile != null && (!object(profile) || !optionalString(profile.email))) return false;
    const auth = claims['https://api.openai.com/auth'];
    if (auth != null && (!object(auth)
      || !['chatgpt_plan_type', 'chatgpt_user_id', 'user_id', 'chatgpt_account_id'].every(key => optionalString(auth[key]))
      || (auth.chatgpt_account_is_fedramp !== undefined && typeof auth.chatgpt_account_is_fedramp !== 'boolean'))) return false;
    return true;
  } catch { return false; }
}

/** Darwin concierge only: translate managed RC login into native external auth.
 * manager.rs AuthDotJson::from_external_access_token uses chatgptAuthTokens
 * with an empty required refresh_token. That variant never performs refresh.
 * No source token, account, timestamp or claim is generated or changed.
 */
export function nativeConciergeAuth(raw, { nowMs = Date.now() } = {}) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 256 * 1024 || !Number.isFinite(nowMs)) invalid();
  const login = parseCodexLogin(raw);
  if (!login.ok || login.expiresAt - nowMs < 30 * 60_000) invalid();
  const source = JSON.parse(raw);
  if (!nativeIdTokenValid(source.tokens.id_token)) invalid();
  if (!nativeTimestampValid(source.last_refresh)) invalid();
  return JSON.stringify({ auth_mode: 'chatgptAuthTokens', tokens: {
    id_token: source.tokens.id_token, access_token: source.tokens.access_token,
    account_id: source.tokens.account_id, refresh_token: '',
  }, ...(Object.hasOwn(source, 'last_refresh') ? { last_refresh: source.last_refresh } : {}) });
}
