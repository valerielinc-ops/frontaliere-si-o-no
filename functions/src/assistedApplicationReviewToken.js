/**
 * Signed link that lets a candidate review, approve, reject or complete the
 * application prepared in their name — no login, one click from the e-mail.
 *
 * Format  `ar1.<orderId>.<round>.<exp36>.<32 hex>`   (review of the application)
 *         `af1.<orderId>.<n>.<exp36>.<32 hex>`       (follow-up n to approve)
 *   sig = HMAC(K, "<purpose>:<orderId>:<round>:<exp36>") truncated to 128 bits
 *         purpose = assisted-review | assisted-followup
 *   K   = HMAC(secret, "assisted-application-review-v1")
 *
 * Same construction as lib/newsletterActionToken.js: the key is derived so
 * no other signer in the codebase can produce a valid signature, and the
 * signed message names its purpose — a follow-up link can never act on the
 * application review and vice versa. The ROUND is part of the signature:
 * after a rejection the draft is regenerated and a new e-mail goes out, and a
 * link from the previous round can still be opened but never approves the
 * new draft (the server compares the round with the order's current one).
 *
 * Secret: Remote Config `ASSISTED_APPLICATION_REVIEW_SECRET` (≥ 32 chars).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';

export const REVIEW_TOKEN_SECRET_KEY = 'ASSISTED_APPLICATION_REVIEW_SECRET';
export const REVIEW_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * The expiry signed in the «inviata» link of an order with the talent-pool consent (owner decision
 * 2026-10-05, «Fino a fine consenso»): the link has no end of its own, it lasts as long as the consent,
 * which the review endpoint reads at every access (assistedApplicationReview.js). The format needs an
 * expiry, so this fixed one stands for «until the consent ends»: no duration is invented, and since it is
 * signed like any other expiry a 30-day link can never be turned into one. 31 Dec 9999, whole seconds.
 */
export const CONSENT_BOUND_EXPIRES_AT = Date.UTC(9999, 11, 31, 23, 59, 59);

const ORDER_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
const TOKEN_RE = /^(ar1|af1)\.([A-Za-z0-9_-]{6,128})\.(\d{1,2})\.([0-9a-z]{1,12})\.([0-9a-f]{32})$/;
const PREFIX = { review: 'ar1', followup: 'af1' };
const KIND_OF = { ar1: 'review', af1: 'followup' };
const PURPOSE = { review: 'assisted-review', followup: 'assisted-followup' };

function derivedKey(secret) {
  return createHmac('sha256', secret).update('assisted-application-review-v1').digest();
}

function signature(secret, orderId, round, exp36, kind) {
  return createHmac('sha256', derivedKey(secret))
    .update(`${PURPOSE[kind]}:${orderId}:${round}:${exp36}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * @param {{kind?: 'review'|'followup', untilConsentEnds?: boolean}} options round = the review round, or the follow-up
 *   number; untilConsentEnds: a review link that lasts as long as the talent-pool consent (CONSENT_BOUND_EXPIRES_AT)
 */
export function mintReviewToken({ secret, orderId, round, nowMs = Date.now(), ttlMs = REVIEW_TOKEN_TTL_MS, kind = 'review', untilConsentEnds = false }) {
  if (!secret || secret.length < 32) throw new Error('review_secret_missing');
  if (!ORDER_ID_RE.test(String(orderId))) throw new Error('invalid_order_id');
  if (!PREFIX[kind] || (untilConsentEnds && kind !== 'review')) throw new Error('invalid_token_kind');
  const safeRound = Number(round);
  if (!Number.isInteger(safeRound) || safeRound < 1 || safeRound > 99) throw new Error('invalid_round');
  const exp36 = Math.floor((untilConsentEnds ? CONSENT_BOUND_EXPIRES_AT : nowMs + ttlMs) / 1000).toString(36);
  return `${PREFIX[kind]}.${orderId}.${safeRound}.${exp36}.${signature(secret, orderId, safeRound, exp36, kind)}`;
}

/**
 * @returns {{ok:true, orderId:string, round:number, expiresAt:number, kind:'review'|'followup', consentBound:boolean} | {ok:false, error:'malformed'|'bad_signature'|'expired'}}
 *   consentBound: valid only while the order's talent-pool consent lasts, which the caller checks
 */
export function verifyReviewToken({ secret, token, nowMs = Date.now() }) {
  const match = TOKEN_RE.exec(String(token || ''));
  if (!match || !secret || secret.length < 32) return { ok: false, error: 'malformed' };
  const [, prefix, orderId, roundText, exp36, sig] = match;
  const kind = KIND_OF[prefix];
  const expected = Buffer.from(signature(secret, orderId, Number(roundText), exp36, kind), 'hex');
  const given = Buffer.from(sig, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, error: 'bad_signature' };
  const expiresAt = Number.parseInt(exp36, 36) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return { ok: false, error: 'expired' };
  return { ok: true, orderId, round: Number(roundText), expiresAt, kind, consentBound: expiresAt === CONSENT_BOUND_EXPIRES_AT };
}

export async function getReviewTokenSecret(read = getRemoteConfigValue) {
  const secret = String(await read(REVIEW_TOKEN_SECRET_KEY) || '').trim();
  if (secret.length < 32) throw new Error('review_secret_missing');
  return secret;
}
