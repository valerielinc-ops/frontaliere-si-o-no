/**
 * newsletterActionToken.js — the `token` credential: what it may DO, and for
 * how long.
 *
 * ── The defect this exists to fix (#5704) ───────────────────────────────────
 *
 * `token` was `HMAC(secret, <email>)`. One string, derived from nothing but the
 * address, identical in every email ever sent to it, and accepted by EVERY
 * action `newsletterManageSubscription` exposes. The only thing that separated
 * "confirm my subscription" from "remove me from every list" was the
 * `action=` parameter in the query string — a value the holder of the link types
 * for themselves.
 *
 * It is also, measured against `ac` after #5685/#5719/#5726, the WIDER
 * credential of the two. `ac` opens a session; `token` is the gate on the whole
 * preferences API:
 *
 *   action                            what the holder can do
 *   ───────────────────────────────── ──────────────────────────────────────────
 *   unsubscribe                       leave every list
 *   resubscribe                       (POST, #5711) go back onto the newsletter
 *   confirm                           complete a double opt-in, and mint a
 *                                     Firebase custom token for auto-login
 *   get_full_status                   read keywords, locations, sectors,
 *                                     cadence, every alert on the address
 *   create_alert / update_alert /
 *   delete_alert                      write and destroy those alerts
 *   toggle_newsletter_subscription    subscribe / unsubscribe the newsletter
 *   set_daily_brief_frequency         change the daily-brief cadence
 *   set_advertising_opt_out           switch third-party advertising off
 *   get_autologin_status              read whether autologin is on
 *   toggle_autologin                  turn the OTHER credential on and off
 *   revoke_autologin                  revoke the other credential entirely
 *
 * So the credential that revokes `ac` was itself eternal, unrevocable, carried
 * no opt-out, and was reached by no policy parameter at all. The recipient of
 * the LPD complaint of 2026-08-12 recovered a June confirmation and a July job
 * alert from their archive and read the same 64 hex characters in both, and in
 * the August unsubscribe link: two months, three opposite actions, one string.
 *
 * ── Two things change, and one deliberately does not ────────────────────────
 *
 *   1. The signature covers the ACTION. A `confirm` token is not an
 *      `unsubscribe` token, and neither is a `preferences` token. The precedent
 *      is in the house: generateOutreachUnsubToken signs
 *      `outreach_unsub:<companyKey>` (outreachUnsubscribe.js) precisely so a
 *      token minted for one purpose cannot be replayed into another.
 *   2. The `confirm` token carries its issue date and EXPIRES. Four locales tell
 *      the recipient of an unrequested subscription "ignore this email, the link
 *      is valid for 7 days" (emailI18n.js `confirmNotYou`). That sentence had no
 *      implementation behind it: the link was armed forever. It has one now.
 *   3. The UNSUBSCRIBE token never expires, and that is not an oversight. This
 *      whole wave of work exists because somebody filed an LPD art. 25/32
 *      complaint about an unsubscribe link that did not work. An opt-out link
 *      that stops working is worse than the problem it was meant to fix, so
 *      `scope === 'unsubscribe'` is decided BEFORE any policy value is read and
 *      is never revisited — the same construction as `canOptOut` in
 *      lib/autologinCode.js, and for the same reason: no configuration value,
 *      and no later edit to the policy, can take the exit away.
 *
 * ── Format ──────────────────────────────────────────────────────────────────
 *
 *   legacy  `<64 hex>`                       HMAC(secret, "<email>")
 *   v1      `n1.<scope>.<day36>.<32 hex>`    HMAC(K, "<scope>:<day36>:<email>")
 *                                            truncated to 128 bits,
 *                                            K = HMAC(secret, "newsletter-token-v1")
 *
 * THE KEY IS DERIVED, and that is load-bearing rather than fashionable. The
 * forgery family documented in lib/autologinCode.js — sign a crafted "address"
 * that happens to spell the other scheme's message, keep the first 32 hex
 * characters of the digest, and you hold the victim's truncated signature — is
 * killed there by a domain tag that the legacy message can never reach. Here it
 * cannot be: the legacy message is the bare address, with no tag at all, so
 * ANY string is a legal legacy message, including `confirm:<stamp>:<victim>`.
 * The separation therefore has to live in the KEY. A legacy digest is
 * HMAC(secret, …); a v1 signature is HMAC(K, …); the minter below is the only
 * thing that ever signs with K, and it only ever signs well-formed triples.
 *
 * Field order matters for the same reason it does there: the only free-form
 * field, the address, is LAST, so no boundary between fields is ambiguous.
 * `scope` is drawn from a closed four-value set and contains no separator.
 *
 * `day36` is base36 days-since-epoch — the issue date, in the clear and signed.
 * The TTL is applied at VERIFICATION time and never baked into the token, so
 * changing it re-judges every token already in the wild, in both directions.
 * That is the rollback lever. Day granularity (not seconds) keeps the token
 * short: `token` rides in URLs that Mailgun silently drops click tracking for
 * past 1000 characters (see makeAuthenticatedUrl in newsletterUrls.js). A v1
 * token is 46-52 characters against legacy's 64.
 *
 * ── Backward compatibility, and its END ─────────────────────────────────────
 *
 * Every email we have ever sent carries a legacy token, and the archives that
 * hold them are the unsubscribe links of thousands of people. Refusing the old
 * format on the day this deploys would break the exit for all of them — the one
 * outcome forbidden here. So legacy is accepted, and its acceptance ends the way
 * `ac`'s does: on a date, set in Remote Config, applied at verification time.
 *
 * With ONE exception, and it is the same principle as above: the sunset does
 * not reach `unsubscribe`. A legacy token gets its holder OUT forever, whatever
 * the policy says. Honouring an old opt-out costs nothing — the only thing the
 * holder of a leaked link can do with it is remove that address from our lists,
 * which is exactly what RFC 8058's one-click token has always allowed anyone
 * holding the link to do. Refusing it is the actual harm.
 *
 * ── Policy, and why it lives outside the code ───────────────────────────────
 *
 * Three values, read at CALL TIME — never hoisted to a module const, the trap
 * newsletterUrls.js and autologinCode.js both document (scripts/ importers load
 * this module before scripts/load-rc-env.mjs populates process.env):
 *
 *   NEWSLETTER_TOKEN_SCHEME            unset (default) | 'legacy' | 'v1'
 *   NEWSLETTER_TOKEN_CONFIRM_TTL_DAYS  integer, unset = 7, explicit 0 = no expiry
 *   NEWSLETTER_TOKEN_LEGACY_SUNSET     ISO date, unset = never
 *
 * `NEWSLETTER_TOKEN_SCHEME` unset does NOT mean "legacy everywhere": it means
 * each scope gets the default in DEFAULT_MINT_SCHEME_BY_SCOPE, and those differ
 * for one reason — WHO MINTS.
 *
 *   confirm     → v1. Minted by functions/src/newsletterConfirmationEmail.js and
 *                 verified by functions/src/newsletterSubscriptionManagement.js:
 *                 the same Cloud Functions deploy, one artefact, no skew window.
 *                 Its 7 days are what makes the sentence in the email true, and
 *                 leaving them off by default would ship the fix switched off.
 *   the other 3 → legacy. Minted by the scripts/ senders (send-newsletter.mjs,
 *                 send-job-alerts.mjs, the drip and win-back runners), which
 *                 deploy on a different schedule from the Cloud Function that
 *                 verifies them. #5726 documents the cost of minting a format
 *                 the verifier does not know yet: everybody signed out, or here,
 *                 everybody unable to leave. Flip with NEWSLETTER_TOKEN_SCHEME=v1
 *                 once the Cloud Function carrying this verifier is confirmed
 *                 live.
 *
 * An explicit value overrides every scope: `legacy` is the complete rollback
 * (mint exactly what was minted before this module existed), `v1` is the
 * complete rollout. Both are a Remote Config edit, not a deploy.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const DAY_MS = 86_400_000;

/**
 * The four things a `token` can be for. A closed set: `scopeForAction` returns
 * null for anything else and every verifier below refuses a null scope, so a
 * new action added to the handler without a decision recorded HERE fails closed
 * instead of inheriting the universal credential this module exists to end.
 */
export const TOKEN_SCOPES = Object.freeze({
  UNSUBSCRIBE: 'unsubscribe',
  RESUBSCRIBE: 'resubscribe',
  CONFIRM: 'confirm',
  PREFERENCES: 'preferences',
});

const KNOWN_SCOPES = Object.freeze(Object.values(TOKEN_SCOPES));

/**
 * Which scope each action of `handleSubscriptionManagement` requires.
 *
 * `preferences` is one scope for the whole preference centre rather than one per
 * action, because that is exactly what the link in the email grants: the
 * recipient of a /preferenze-newsletter/ URL is meant to read and edit their
 * alerts. Splitting it further would need a token per button and buy nothing —
 * the page holds one link. What it must NOT be is the same string that confirms
 * a subscription or ends one.
 *
 * `exchange_auth_code` is deliberately absent: its `token` parameter carries an
 * `ac` autologin code, not this credential, and lib/autologinCode.js grades it.
 */
const SCOPE_BY_ACTION = Object.freeze({
  unsubscribe: TOKEN_SCOPES.UNSUBSCRIBE,
  resubscribe: TOKEN_SCOPES.RESUBSCRIBE,
  confirm: TOKEN_SCOPES.CONFIRM,
  get_autologin_status: TOKEN_SCOPES.PREFERENCES,
  toggle_autologin: TOKEN_SCOPES.PREFERENCES,
  revoke_autologin: TOKEN_SCOPES.PREFERENCES,
  get_full_status: TOKEN_SCOPES.PREFERENCES,
  toggle_newsletter_subscription: TOKEN_SCOPES.PREFERENCES,
  create_alert: TOKEN_SCOPES.PREFERENCES,
  update_alert: TOKEN_SCOPES.PREFERENCES,
  delete_alert: TOKEN_SCOPES.PREFERENCES,
  set_daily_brief_frequency: TOKEN_SCOPES.PREFERENCES,
  // #5759. `preferences` and not a scope of its own, for the reason above:
  // one link grants the whole centre, and this is one more control on it.
  // The decision is recorded HERE because the closed table is what stopped
  // the action from silently inheriting the universal credential — it failed
  // `tests/newsletter-action-token.test.ts` the moment it was added to the
  // handler, which is the guard working rather than an obstacle.
  set_advertising_opt_out: TOKEN_SCOPES.PREFERENCES,
});

/** @returns {string|null} the scope an action needs, or null if it takes no `token` */
export function scopeForAction(action) {
  return SCOPE_BY_ACTION[String(action || '').trim().toLowerCase()] || null;
}

export function isKnownScope(scope) {
  return KNOWN_SCOPES.includes(String(scope || ''));
}

/** Scheme tag of the versioned token. `n1` cannot collide with the `a1` of an
 * autologin code, nor with legacy (64 hex, no separator). */
export const V1_TAG = 'n1';
/** Bytes of HMAC kept in a v1 token (128-bit forgery margin, 32 hex chars). */
export const V1_SIG_BYTES = 16;
export const LEGACY_TOKEN_RE = /^[0-9a-f]{64}$/i;
const V1_TOKEN_RE = /^n1\.([a-z]{1,16})\.([0-9a-z]{1,8})\.([0-9a-f]{32})$/i;

/** The ONE normalisation. Both historical minters had their own — newsletterUrls.js
 * signed `email.toLowerCase()` and newsletterConfirmationEmail.js signed
 * `email.toLowerCase().trim()` — while the verifier trimmed. An address stored
 * with stray whitespace was therefore signed one way and verified another: a
 * link that silently answered "Link non valido", which is the exact failure the
 * LPD complaint was about. One function, imported by all three. */
export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/** Constant-time compare of two hex strings of any length. A length mismatch is
 * answered false without throwing (timingSafeEqual throws on unequal lengths,
 * and the attacker controls the length). */
function hexEquals(a, b) {
  const ab = Buffer.from(String(a || ''), 'hex');
  const bb = Buffer.from(String(b || ''), 'hex');
  if (ab.length === 0 || ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/**
 * The historical token, byte-identical to the pre-#5704 derivation. Still minted
 * by default for three of the four scopes, and still accepted for all four:
 * every email we have ever sent carries one.
 */
export function legacyEmailToken(email, secret) {
  if (!secret) return null;
  return createHmac('sha256', secret).update(normalizeEmail(email)).digest('hex');
}

/** Days since the Unix epoch, base36. The issue date carried in a v1 token. */
export function dayStamp(ms) {
  return Math.floor(ms / DAY_MS).toString(36);
}

function daysFromStamp(stamp) {
  if (!/^[0-9a-z]{1,8}$/i.test(String(stamp || ''))) return null;
  const n = parseInt(String(stamp), 36);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// The label the v1 key is derived under. Changing this string invalidates every
// v1 token in the wild at once — which is a revocation lever of last resort, not
// a thing to tidy.
const V1_KEY_LABEL = 'newsletter-token-v1';

function v1Key(secret) {
  return createHmac('sha256', secret).update(V1_KEY_LABEL).digest();
}

function v1Signature(email, scope, stamp, secret) {
  return Buffer.from(
    createHmac('sha256', v1Key(secret))
      .update(`${scope}:${stamp}:${normalizeEmail(email)}`)
      .digest()
      .subarray(0, V1_SIG_BYTES),
  ).toString('hex');
}

/** What each scope mints when the policy says nothing. See the header note on
 * why these two values differ. */
export const DEFAULT_MINT_SCHEME_BY_SCOPE = Object.freeze({
  [TOKEN_SCOPES.CONFIRM]: 'v1',
  [TOKEN_SCOPES.UNSUBSCRIBE]: 'legacy',
  [TOKEN_SCOPES.RESUBSCRIBE]: 'legacy',
  [TOKEN_SCOPES.PREFERENCES]: 'legacy',
});

/** The window the confirmation email promises, in four languages. */
export const DEFAULT_CONFIRM_TTL_DAYS = 7;

/**
 * Read the policy. Call-time only — see the header note on hoisting.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{scheme: 'auto'|'legacy'|'v1', confirmTtlDays: number, legacySunsetMs: number|null}}
 */
export function resolveNewsletterTokenPolicy(env = process.env) {
  const source = env || {};
  const scheme = String(source.NEWSLETTER_TOKEN_SCHEME || '').trim().toLowerCase();
  const ttlRaw = String(source.NEWSLETTER_TOKEN_CONFIRM_TTL_DAYS ?? '').trim();
  const ttlParsed = Number.parseInt(ttlRaw, 10);
  const sunsetRaw = String(source.NEWSLETTER_TOKEN_LEGACY_SUNSET || '').trim();
  const sunsetMs = sunsetRaw ? Date.parse(sunsetRaw) : NaN;
  return {
    // Only the two literal values mean anything; everything else — unset,
    // misspelled, half-written — is `auto`, i.e. the per-scope defaults. A typo
    // in Remote Config must not be able to switch the credential format.
    scheme: scheme === 'v1' ? 'v1' : (scheme === 'legacy' ? 'legacy' : 'auto'),
    // Absent, or unreadable, means the DEFAULT — not "off". The 7 days are a
    // statement made to recipients in four languages; a fat-fingered Remote
    // Config value must not silently turn a promise back into a falsehood.
    // Turning the expiry off is possible, but only by writing `0` and meaning it.
    confirmTtlDays: Number.isFinite(ttlParsed) && ttlParsed >= 0 ? ttlParsed : DEFAULT_CONFIRM_TTL_DAYS,
    legacySunsetMs: Number.isFinite(sunsetMs) ? sunsetMs : null,
  };
}

/**
 * Which scheme this scope mints under this policy.
 * @param {string} scope
 * @param {ReturnType<typeof resolveNewsletterTokenPolicy>} [policy]
 * @returns {'legacy'|'v1'}
 */
export function mintSchemeFor(scope, policy) {
  const pol = policy || resolveNewsletterTokenPolicy();
  if (pol.scheme === 'v1' || pol.scheme === 'legacy') return pol.scheme;
  return DEFAULT_MINT_SCHEME_BY_SCOPE[scope] || 'legacy';
}

/**
 * Mint a token for ONE action.
 *
 * @param {string} email
 * @param {string} scope one of TOKEN_SCOPES
 * @param {object} opts
 * @param {string} opts.secret
 * @param {'legacy'|'v1'} [opts.scheme] explicit override, else the policy's
 * @param {ReturnType<typeof resolveNewsletterTokenPolicy>} [opts.policy] resolved
 *   policy — REQUIRED inside Cloud Functions, where NEWSLETTER_TOKEN_* is not in
 *   process.env and an omitted policy silently means "the defaults", i.e. a
 *   Remote Config rollback that never reaches the minter.
 * @param {number} [opts.now] epoch ms, for tests and for pinning a whole send
 * @param {Record<string,string|undefined>} [opts.env]
 * @returns {string|null} null when there is no secret (the historical "degrade
 *   to an unsigned link" behaviour every builder in newsletterUrls.js relies on)
 *   or when the scope is unknown (fail closed).
 */
export function mintNewsletterActionToken(email, scope, { secret, scheme, policy, now = Date.now(), env } = {}) {
  if (!secret) return null;
  if (!isKnownScope(scope)) return null;
  const resolved = scheme || mintSchemeFor(scope, policy || resolveNewsletterTokenPolicy(env));
  if (resolved !== 'v1') return legacyEmailToken(email, secret);
  const stamp = dayStamp(now);
  return `${V1_TAG}.${scope}.${stamp}.${v1Signature(email, scope, stamp, secret)}`;
}

/**
 * The shape of a token, with no secret involved and no verdict implied.
 * @returns {{scheme: 'legacy'|'v1'|null, scope: string|null, stamp: string|null, issuedAtMs: number|null, signature: string|null}}
 */
export function parseNewsletterActionToken(token) {
  const empty = { scheme: null, scope: null, stamp: null, issuedAtMs: null, signature: null };
  const raw = String(token || '').trim();
  if (!raw) return empty;
  if (LEGACY_TOKEN_RE.test(raw)) {
    // A legacy token names no action and carries no issue date. Both are read
    // below as "the widest thing it could be, and older than anything", which is
    // the only safe reading of a credential that predates the distinction.
    return { scheme: 'legacy', scope: null, stamp: null, issuedAtMs: null, signature: raw.toLowerCase() };
  }
  const m = V1_TOKEN_RE.exec(raw);
  if (!m) return empty;
  const scope = m[1].toLowerCase();
  if (!isKnownScope(scope)) return empty;
  const days = daysFromStamp(m[2]);
  if (days === null) return empty;
  return { scheme: 'v1', scope, stamp: m[2].toLowerCase(), issuedAtMs: days * DAY_MS, signature: m[3].toLowerCase() };
}

/**
 * Grade a token AGAINST THE ACTION IT ARRIVED FOR. THE function this module
 * exists for.
 *
 * @param {string} email
 * @param {string} token the `token` string exactly as it arrived
 * @param {string} scope the scope the requested action requires (scopeForAction)
 * @param {object} opts
 * @param {string} opts.secret
 * @param {ReturnType<typeof resolveNewsletterTokenPolicy>} [opts.policy]
 * @param {number} [opts.now]
 * @returns {{
 *   authentic: boolean, scheme: 'legacy'|'v1'|null, scope: string|null,
 *   issuedAtMs: number|null, expired: boolean, futureDated: boolean,
 *   canPerform: boolean, reason: string
 * }}
 */
export function verifyNewsletterActionToken(email, token, scope, { secret, policy, now = Date.now() } = {}) {
  const deny = (reason) => ({
    authentic: false, scheme: null, scope: null, issuedAtMs: null,
    expired: false, futureDated: false, canPerform: false, reason,
  });
  if (!secret) return deny('no_secret');
  const normalized = normalizeEmail(email);
  if (!normalized) return deny('no_email');
  if (!isKnownScope(scope)) return deny('unknown_scope');

  const parsed = parseNewsletterActionToken(token);
  if (!parsed.scheme) return deny('malformed');
  // The whole point of the module, stated once: a v1 token minted for one action
  // is refused for any other. The signature covers the scope too, so a tampered
  // scope field would fail below anyway — this branch exists to answer with the
  // reason that is true rather than with `bad_signature`.
  if (parsed.scheme === 'v1' && parsed.scope !== scope) {
    // The shape IS known here, so it is reported: a refusal logged as
    // `wrong_scope` on an `unparsed` token would read as a contradiction in the
    // one line an operator has to work from.
    return { ...deny('wrong_scope'), scheme: parsed.scheme, scope: parsed.scope, issuedAtMs: parsed.issuedAtMs };
  }

  const expected = parsed.scheme === 'legacy'
    ? legacyEmailToken(normalized, secret)
    : v1Signature(normalized, scope, parsed.stamp, secret);
  if (!hexEquals(parsed.signature, expected)) return deny('bad_signature');

  // ── THE EXIT. Decided here, before a single policy value has been read, and
  // never revisited. `canOptOut` in lib/autologinCode.js is `authentic` and
  // nothing else for the same reason: no configuration value, no sunset date and
  // no future edit to the policy may reach the power to leave. An unsubscribe
  // link found in a five-year-old archive still unsubscribes.
  if (scope === TOKEN_SCOPES.UNSUBSCRIBE) {
    return {
      authentic: true, scheme: parsed.scheme, scope, issuedAtMs: parsed.issuedAtMs,
      expired: false, futureDated: false, canPerform: true, reason: 'ok',
    };
  }

  const pol = policy || resolveNewsletterTokenPolicy();
  let expired = false;
  if (parsed.scheme === 'v1') {
    // Confirm is the ONLY scope with a lifetime, and it is a literal table entry
    // rather than a parameter: nothing in Remote Config can add a second one, and
    // in particular nothing can add `unsubscribe` — which the branch above has
    // already returned for anyway. Belt and braces, deliberately.
    //
    // The `+ 1` makes the promised window a FLOOR. The stamp is day-granular, so
    // `issuedAtMs` is the UTC MIDNIGHT of the issue day, not the send instant:
    // measured from there, a confirmation sent at 23:00 would stop working after
    // 6 days and 1 hour while the email in the recipient's hand says seven. The
    // extra day is the rounding, and it rounds towards the statement being true —
    // every link lives at least the days the email claims, and at most one more.
    // Erring the other way would make the sentence false again, in the same four
    // languages, for everybody who receives an email in the evening.
    if (scope === TOKEN_SCOPES.CONFIRM && pol.confirmTtlDays > 0) {
      expired = now - parsed.issuedAtMs >= (pol.confirmTtlDays + 1) * DAY_MS;
    }
  } else if (pol.legacySunsetMs !== null) {
    // A legacy token cannot say when it was issued, so it cannot be aged
    // individually — the whole format is retired on one date instead. This is
    // the END of the compatibility phase, and the only thing that ends it.
    expired = now >= pol.legacySunsetMs;
  }

  // An UPPER bound on the issue date. Both gates above are one-sided — expiry is
  // `now - issuedAt >= ttl` (negative, so never true, for a future date) — so a
  // token stamped in the future would be immune to the only lever this design
  // has. It costs one mis-set clock on one minter. The tolerance is a full extra
  // day because the stamp is day-granular: today's token already reads as up to
  // one day ahead of the instant it is verified at.
  const futureDated = parsed.issuedAtMs !== null && parsed.issuedAtMs > now + DAY_MS;

  return {
    authentic: true,
    scheme: parsed.scheme,
    scope: parsed.scheme === 'v1' ? parsed.scope : scope,
    issuedAtMs: parsed.issuedAtMs,
    expired,
    futureDated,
    canPerform: !expired && !futureDated,
    reason: expired ? 'expired' : (futureDated ? 'future' : 'ok'),
  };
}
