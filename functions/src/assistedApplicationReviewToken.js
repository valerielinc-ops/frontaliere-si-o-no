/**
 * Signed link that lets a candidate review, approve, reject or complete the
 * application prepared in their name — no login, one click from the e-mail.
 *
 * Format  `ar1.<orderId>.<round>.<exp36>.<32 hex>`
 *   sig = HMAC(K, "assisted-review:<orderId>:<round>:<exp36>") truncated to 128 bits
 *   K   = HMAC(secret, "assisted-application-review-v1")
 *
 * Same construction as lib/newsletterActionToken.js: the key is derived so
 * no other signer in the codebase can produce a valid signature, and the
 * signed message names its purpose. The ROUND is part of the signature: after
 * a rejection the draft is regenerated and a new e-mail goes out, and a link
 * from the previous round can still be opened but never approves the new
 * draft (the server compares the round with the order's current one).
 *
 * Secret: Remote Config `ASSISTED_APPLICATION_REVIEW_SECRET` (≥ 32 chars).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';

export const REVIEW_TOKEN_SECRET_KEY = 'ASSISTED_APPLICATION_REVIEW_SECRET';
export const REVIEW_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const ORDER_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
const TOKEN_RE = /^ar1\.([A-Za-z0-9_-]{6,128})\.(\d{1,2})\.([0-9a-z]{1,12})\.([0-9a-f]{32})$/;

function derivedKey(secret) {
  return createHmac('sha256', secret).update('assisted-application-review-v1').digest();
}

function signature(secret, orderId, round, exp36) {
  return createHmac('sha256', derivedKey(secret))
    .update(`assisted-review:${orderId}:${round}:${exp36}`)
    .digest('hex')
    .slice(0, 32);
}

export function mintReviewToken({ secret, orderId, round, nowMs = Date.now(), ttlMs = REVIEW_TOKEN_TTL_MS }) {
  if (!secret || secret.length < 32) throw new Error('review_secret_missing');
  if (!ORDER_ID_RE.test(String(orderId))) throw new Error('invalid_order_id');
  const safeRound = Number(round);
  if (!Number.isInteger(safeRound) || safeRound < 1 || safeRound > 99) throw new Error('invalid_round');
  const exp36 = Math.floor((nowMs + ttlMs) / 1000).toString(36);
  return `ar1.${orderId}.${safeRound}.${exp36}.${signature(secret, orderId, safeRound, exp36)}`;
}

/**
 * @returns {{ok:true, orderId:string, round:number, expiresAt:number} | {ok:false, error:'malformed'|'bad_signature'|'expired'}}
 */
export function verifyReviewToken({ secret, token, nowMs = Date.now() }) {
  const match = TOKEN_RE.exec(String(token || ''));
  if (!match || !secret || secret.length < 32) return { ok: false, error: 'malformed' };
  const [, orderId, roundText, exp36, sig] = match;
  const expected = Buffer.from(signature(secret, orderId, Number(roundText), exp36), 'hex');
  const given = Buffer.from(sig, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, error: 'bad_signature' };
  const expiresAt = Number.parseInt(exp36, 36) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return { ok: false, error: 'expired' };
  return { ok: true, orderId, round: Number(roundText), expiresAt };
}

export async function getReviewTokenSecret(read = getRemoteConfigValue) {
  const secret = String(await read(REVIEW_TOKEN_SECRET_KEY) || '').trim();
  if (secret.length < 32) throw new Error('review_secret_missing');
  return secret;
}
