/**
 * autologinCode.js — the `ac` credential: its format, its policy, and the
 * verdict that SEPARATES ITS TWO POWERS.
 *
 * ── The defect this exists to fix (#5685) ───────────────────────────────────
 *
 * `ac` was `HMAC(secret, "autologin:" + email)` — deterministic, identical in
 * every email ever sent to that address, and accepted forever by
 * `exchange_auth_code`, which answers it with a Firebase custom token. It is
 * therefore a permanent password that we mail to the recipient, and that the
 * recipient's infrastructure mails onward to everybody else:
 *
 *   - the sending provider rewrites every href to
 *     `click.frontaliereticino.ch/v2/redirect/<base64-of-the-full-URL>`, so the
 *     credential is in the provider's click log verbatim;
 *   - corporate anti-phishing scanners fetch every link (measured on this
 *     domain: 25 fetches in 7 seconds from Microsoft ranges, #5674), so it is
 *     in their logs too;
 *   - a forwarded email hands the credential to the person it was forwarded to;
 *   - mail archives keep it for the retention period.
 *
 * A code intercepted today worked in two years' time. That is what changes
 * here.
 *
 * ── Two powers, two lifetimes ───────────────────────────────────────────────
 *
 * The one thing a fix here must not do is make it harder to LEAVE. The wave
 * this belongs to exists because a recipient filed an LPD art. 25/32 complaint
 * about an unsubscribe link that did not work, and `ac` is also what makes the
 * SPA-handled unsubscribe link work (App.tsx rejects a bare email+token link
 * with "Link non valido"). An expiry bolted onto a single boolean "is this code
 * valid" would have expired the exit along with the session.
 *
 * So the code carries two powers and this module grades them separately:
 *
 *   power                       who reads it      for how long
 *   ─────────────────────────── ───────────────── ──────────────────────────
 *   mint a Firebase session     canMintSession    TTL, revocable, opt-outable
 *   record an opt-out           canOptOut         forever, unconditionally
 *
 * `canOptOut` is `authentic` and NOTHING else — no policy input reaches it, by
 * construction, so no configuration value and no later edit to the policy can
 * take the exit away. Honouring an opt-out from an old credential is not a
 * risk: the only thing the holder of a leaked link can do with it is remove
 * that address from our lists, which is exactly what the RFC 8058 one-click
 * token (an eternal HMAC over the bare email) has always allowed. Refusing it
 * is the actual harm.
 *
 * The reverse direction is deliberately NOT symmetric: an authentic-but-stale
 * code must never be able to RE-subscribe anybody. That asymmetry is what
 * closes the resurrection loop of #5672, where reading an old email signed the
 * reader back in and re-subscribed them.
 *
 * ── Format ──────────────────────────────────────────────────────────────────
 *
 *   legacy  `<64 hex>`                 HMAC(secret, "autologin:<email>")
 *   v1      `a1.<day36>.<32 hex>`      HMAC(secret, "autologin-v1:<day36>:<email>")
 *                                      truncated to 128 bits
 *
 * The two signed messages are deliberately NOT prefix-composable. An earlier
 * draft signed `autologin:v1:<email>:<stamp>`, which is a legacy message whose
 * "email" happens to be `v1:<email>:<stamp>` — so a legacy code minted over the
 * crafted address `v1:victim@example.com:<stamp>` had, as its first 32 hex
 * characters, the victim's real v1 signature. Measured on this module before the
 * fix: the forged `a1.<stamp>.<those 32 chars>` verified as the victim with
 * `canMintSession: true`. Truncation does not help — the prefix is exactly what
 * is kept. Two properties kill the whole family: the domain tag differs at a
 * character legacy can never reach (`autologin:` vs `autologin-v1:`), and the
 * free-form field (the address) is LAST, so no field boundary is ambiguous.
 *
 * `day36` is base36 days-since-epoch: the issue date, in the clear, signed. It
 * is what lets a verifier decide "too old" WITHOUT any per-recipient state and
 * without a lookup — and, because the TTL is applied at VERIFICATION time and
 * not baked into the code, changing the TTL re-judges every code already in the
 * wild, in both directions. That is the rollback lever (see below).
 *
 * v1 is ~38 characters against legacy's 64. Length matters: `ac`/`ne` are
 * deliberately short because Mailgun silently drops click tracking for href
 * values >= 1000 characters (see makeAuthenticatedUrl in newsletterUrls.js).
 * The truncation to 128 bits is a forgery margin, not a storage one — 2^128 is
 * not brute-forceable and the code is deliberately not a long-term secret.
 *
 * Day granularity, not second granularity, for two reasons: it keeps the code
 * short, and it keeps the code STABLE for a whole send — every link in one
 * message gets the same string, so `wrapAuthenticatedHrefs` still costs a
 * single HMAC per recipient regardless of link count.
 *
 * ── Revocation ──────────────────────────────────────────────────────────────
 *
 * `autologin_revoked_before` on the subscriber document is a watermark, not a
 * counter: a code is revoked when it was issued before it. #5685 suggested a
 * counter mixed into the HMAC, and a counter would work — but every one of the
 * EIGHT senders that mint a code would then have to read the counter first, and
 * any sender that did not would emit permanently-dead codes for that recipient.
 * A watermark needs no sender to know anything, so revoking is self-healing
 * instead of one-shot.
 *
 * Self-healing WITH A STATED DELAY, and the delay is not a detail. A v1 stamp is
 * day-granular, so every code minted on day D carries D's midnight; a watermark
 * anywhere inside day D therefore kills the codes minted LATER that same day
 * too. That is the fail-safe direction and it is kept — but it means the repair
 * arrives with the first email of the FOLLOWING UTC day, not with "the next
 * email". `revocationWatermarkFor` writes the boundary explicitly rather than
 * leaving it to whatever instant serverTimestamp() happened to produce, so the
 * contract is exact and testable instead of emergent.
 *
 * A legacy code has no issue date, so it cannot be graded individually: while
 * the policy mints v1, ANY watermark revokes it — the correct reading of "revoke
 * everything already sent". While the policy mints LEGACY, the watermark does
 * not touch legacy codes at all, and that is what makes the rollback complete:
 * clearing the Remote Config parameters would otherwise leave every subscriber
 * who had revoked with a permanently dead autologin, since every code they
 * would ever receive again is legacy and no legacy code can be newer than a
 * watermark. Revocation is a v1-era power; turning v1 off turns it off with it.
 * (`revoke_autologin` refuses outright under the legacy scheme — see
 * newsletterSubscriptionManagement.js — so the only way to reach that state is a
 * rollback, which is exactly when it must not lock anybody out.) The permanent,
 * user-reversible kill switch is `autologin_enabled:false`, untouched by any of
 * this.
 *
 * ── Policy, and why it lives outside the code ───────────────────────────────
 *
 * Three values, read at CALL TIME (never hoisted to a module const — the same
 * trap newsletterUrls.js documents: scripts/ importers load this module before
 * scripts/load-rc-env.mjs populates process.env):
 *
 *   NEWSLETTER_AC_SCHEME          'legacy' (default) | 'v1'   — what we MINT
 *   NEWSLETTER_AC_TTL_DAYS        integer, default 0 = no expiry — v1 lifetime
 *   NEWSLETTER_AC_LEGACY_SUNSET   ISO date, default unset = never — legacy sessions
 *
 * All three default to TODAY'S BEHAVIOUR, so merging this changes nothing about
 * what is minted or accepted. They are Remote Config parameters
 * (scripts/load-rc-env.mjs bridges them into process.env for the senders;
 * functions/src/remoteConfigSecrets.js reads them for the verifier), which makes
 * both the rollout AND the rollback a Remote Config edit rather than a deploy.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const DAY_MS = 86_400_000;

/** Scheme tag of the versioned code. Chosen so a v1 code can never be mistaken
 * for the legacy one: legacy is 64 hex characters and contains no separator. */
export const V1_TAG = 'a1';
/** Bytes of HMAC kept in a v1 code (128-bit forgery margin, 32 hex chars). */
export const V1_SIG_BYTES = 16;
export const LEGACY_CODE_RE = /^[0-9a-f]{64}$/i;
const V1_CODE_RE = /^a1\.([0-9a-z]{1,8})\.([0-9a-f]{32})$/i;

function normalizeEmail(value) {
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

/** The historical code, byte-identical to the pre-#5685 implementation. Kept as
 * a named export because it is still minted by default and still accepted:
 * every email we have ever sent carries one. */
export function legacyAutologinCode(email, secret) {
  if (!secret) return null;
  return createHmac('sha256', secret).update('autologin:' + normalizeEmail(email)).digest('hex');
}

/** Days since the Unix epoch, base36. The issue date carried in a v1 code. */
export function dayStamp(ms) {
  return Math.floor(ms / DAY_MS).toString(36);
}

function daysFromStamp(stamp) {
  if (!/^[0-9a-z]{1,8}$/i.test(String(stamp || ''))) return null;
  const n = parseInt(String(stamp), 36);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The v1 signed message. Domain-separated from the legacy one and with the
 * only free-form field (the address) in terminal position — see the header note
 * on why `autologin:v1:<email>:<stamp>` was a forgery primitive. */
function v1Signature(email, stamp, secret) {
  return Buffer.from(
    createHmac('sha256', secret)
      .update(`autologin-v1:${stamp}:${normalizeEmail(email)}`)
      .digest()
      .subarray(0, V1_SIG_BYTES),
  ).toString('hex');
}

/**
 * Read the policy. Call-time only — see the header note on hoisting.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{mintScheme: 'legacy'|'v1', ttlDays: number, legacySunsetMs: number|null}}
 */
export function resolveAutologinPolicy(env = process.env) {
  const source = env || {};
  const scheme = String(source.NEWSLETTER_AC_SCHEME || '').trim().toLowerCase();
  const ttlRaw = Number.parseInt(String(source.NEWSLETTER_AC_TTL_DAYS ?? '').trim(), 10);
  const sunsetRaw = String(source.NEWSLETTER_AC_LEGACY_SUNSET || '').trim();
  const sunsetMs = sunsetRaw ? Date.parse(sunsetRaw) : NaN;
  return {
    // Anything other than an explicit 'v1' means legacy: an unset, misspelled or
    // half-written Remote Config value must never be able to switch the
    // credential format on by accident.
    mintScheme: scheme === 'v1' ? 'v1' : 'legacy',
    // 0 or absent = no expiry. Negative and non-numeric collapse to 0 for the
    // same fail-safe reason.
    ttlDays: Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : 0,
    legacySunsetMs: Number.isFinite(sunsetMs) ? sunsetMs : null,
  };
}

/**
 * Mint a code in the scheme the policy asks for.
 *
 * @param {string} email
 * @param {object} opts
 * @param {string} opts.secret
 * @param {'legacy'|'v1'} [opts.scheme] explicit override, else the policy's
 * @param {number} [opts.now] epoch ms, for tests and for pinning a whole send
 * @param {Record<string,string|undefined>} [opts.env]
 * @returns {string|null} null when there is no secret (the historical
 *   "degrade to an unsigned link" behaviour every builder here relies on)
 */
export function mintAutologinCode(email, { secret, scheme, now = Date.now(), env } = {}) {
  if (!secret) return null;
  const resolved = scheme || resolveAutologinPolicy(env).mintScheme;
  if (resolved !== 'v1') return legacyAutologinCode(email, secret);
  const stamp = dayStamp(now);
  return `${V1_TAG}.${stamp}.${v1Signature(email, stamp, secret)}`;
}

/**
 * The shape of a code, with no secret involved and no verdict implied.
 * @returns {{scheme: 'legacy'|'v1'|null, stamp: string|null, issuedAtMs: number|null, signature: string|null}}
 */
export function parseAutologinCode(code) {
  const raw = String(code || '').trim();
  if (!raw) return { scheme: null, stamp: null, issuedAtMs: null, signature: null };
  if (LEGACY_CODE_RE.test(raw)) {
    // A legacy code carries no issue date. `issuedAtMs: null` is not "now" and
    // not "unknown, assume fresh" — every consumer below reads it as "older than
    // any watermark", which is the only safe reading.
    return { scheme: 'legacy', stamp: null, issuedAtMs: null, signature: raw.toLowerCase() };
  }
  const m = V1_CODE_RE.exec(raw);
  if (!m) return { scheme: null, stamp: null, issuedAtMs: null, signature: null };
  const days = daysFromStamp(m[1]);
  if (days === null) return { scheme: null, stamp: null, issuedAtMs: null, signature: null };
  return { scheme: 'v1', stamp: m[1].toLowerCase(), issuedAtMs: days * DAY_MS, signature: m[2].toLowerCase() };
}

/**
 * Coerce whatever `autologin_revoked_before` holds into epoch ms. Firestore
 * hands back a Timestamp, a script might write a number, a backfill might write
 * an ISO string — all three mean the same thing, and a wrong guess here would
 * silently disable revocation.
 * @returns {number|null} null when the field is absent or unreadable
 */
export function revokedBeforeMs(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value?.toMillis === 'function') {
    try {
      const ms = value.toMillis();
      return Number.isFinite(ms) ? ms : null;
    } catch { return null; }
  }
  return null;
}

/**
 * The watermark to store for a revocation happening at `ms`: the start of the
 * NEXT UTC day.
 *
 * Written explicitly instead of `serverTimestamp()` because the two quantities
 * being compared have different granularities — an instant against a day — and
 * leaving the boundary implicit made the contract unstatable. With this, the
 * rule is one sentence: a revocation kills every code stamped on its own day or
 * earlier, and the first code of the following UTC day works again.
 *
 * @param {number} ms epoch ms of the revocation
 * @returns {number} epoch ms, always a UTC midnight
 */
export function revocationWatermarkFor(ms) {
  return (Math.floor(ms / DAY_MS) + 1) * DAY_MS;
}

/**
 * Is this code revoked by the subscriber's watermark? Exported because
 * `exchange_auth_code` grades the signature BEFORE reading Firestore (so a
 * forged code costs a hash and no read) and therefore has to apply the watermark
 * separately — two call sites, one rule, no drift.
 *
 * @param {{scheme: 'legacy'|'v1'|null, issuedAtMs: number|null}} parsed
 * @param {number|null} revokedBefore already coerced by revokedBeforeMs()
 * @param {ReturnType<typeof resolveAutologinPolicy>} [policy]
 * @returns {boolean}
 */
export function isAutologinRevoked(parsed, revokedBefore, policy) {
  if (revokedBefore === null || revokedBefore === undefined) return false;
  if (parsed?.scheme === 'v1') {
    return parsed.issuedAtMs !== null && parsed.issuedAtMs < revokedBefore;
  }
  // Legacy: undatable, so it is all-or-nothing — and which of the two applies is
  // the rollback lever documented in the header.
  return (policy || resolveAutologinPolicy()).mintScheme === 'v1';
}

/**
 * Grade a code. THE function this module exists for.
 *
 * @param {string} email
 * @param {string} code the `ac` string exactly as it arrived
 * @param {object} opts
 * @param {string} opts.secret
 * @param {ReturnType<typeof resolveAutologinPolicy>} [opts.policy]
 * @param {number} [opts.now]
 * @param {number|null} [opts.revokedBefore] epoch ms watermark from the
 *   subscriber document, already coerced by revokedBeforeMs()
 * @returns {{
 *   authentic: boolean, scheme: 'legacy'|'v1'|null, issuedAtMs: number|null,
 *   expired: boolean, revoked: boolean, futureDated: boolean,
 *   canMintSession: boolean, canOptOut: boolean, reason: string
 * }}
 */
export function verifyAutologinCode(email, code, { secret, policy, now = Date.now(), revokedBefore = null } = {}) {
  const deny = (reason) => ({
    authentic: false, scheme: null, issuedAtMs: null, expired: false, revoked: false,
    futureDated: false, canMintSession: false, canOptOut: false, reason,
  });
  if (!secret) return deny('no_secret');
  const normalized = normalizeEmail(email);
  if (!normalized) return deny('no_email');

  const parsed = parseAutologinCode(code);
  if (!parsed.scheme) return deny('malformed');

  const expectedSig = parsed.scheme === 'legacy'
    ? legacyAutologinCode(normalized, secret)
    : v1Signature(normalized, parsed.stamp, secret);
  if (!hexEquals(parsed.signature, expectedSig)) return deny('bad_signature');

  // Authentic from here down. `canOptOut` is decided RIGHT HERE, before any
  // policy value is read, and is never touched again — the exit cannot be
  // configured away.
  const canOptOut = true;

  const pol = policy || resolveAutologinPolicy();
  let expired = false;
  if (parsed.scheme === 'v1') {
    // TTL applied at verification time, not baked into the code: lowering it
    // ages every code already sent, raising it (or setting 0) un-ages them.
    if (pol.ttlDays > 0) expired = now - parsed.issuedAtMs >= pol.ttlDays * DAY_MS;
  } else if (pol.legacySunsetMs !== null) {
    // A legacy code cannot say when it was issued, so it cannot be aged
    // individually — the whole scheme is retired on one date instead.
    expired = now >= pol.legacySunsetMs;
  }

  // An UPPER bound on the issue date, and it is not theoretical tidiness. Both
  // gates above are one-sided: expiry is `now - issuedAt >= ttl` (negative, so
  // never true, for a future date) and revocation is `issuedAt < watermark`
  // (false for a future date). A code stamped in the future is therefore immune
  // to BOTH — a permanent credential that revocation, the only emergency valve
  // this design has, cannot switch off. It costs one mis-set clock on one sender,
  // or one caller passing the wrong `now` to generateAutologinCode, and nothing
  // afterwards can undo it. The tolerance is a full extra day because the stamp
  // is day-granular: "today's" code already reads as up to one day ahead of the
  // instant it is verified at.
  const futureDated = parsed.issuedAtMs !== null && parsed.issuedAtMs > now + DAY_MS;

  const revoked = isAutologinRevoked(parsed, revokedBefore, pol);

  return {
    authentic: true,
    scheme: parsed.scheme,
    issuedAtMs: parsed.issuedAtMs,
    expired,
    revoked,
    futureDated,
    // Same asymmetry as everywhere else in this module: a mis-dated code is
    // still AUTHENTIC, so it still gets its holder out. Only the session goes.
    canMintSession: !expired && !revoked && !futureDated,
    canOptOut,
    reason: revoked ? 'revoked' : (expired ? 'expired' : (futureDated ? 'future' : 'ok')),
  };
}
