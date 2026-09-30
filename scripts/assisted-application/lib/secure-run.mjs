/**
 * Personal data in a PUBLIC repository's Actions run (owner decision
 * 2026-09-30, all five layers):
 *   1. the workflow receives only the order id (workflow inputs are public);
 *   2. every personal value read at runtime is masked with `::add-mask::`
 *      before anything could print it (plus its common variants);
 *   3. nothing is uploaded as an artifact: evidence (answers sent, portal
 *      screenshots, the agent's notes) is encrypted with AES-256-GCM under
 *      the Remote Config key ASSISTED_APPLICATION_RUN_KEY and stored in the
 *      order's private Storage folder, which the 90-day retention deletes;
 *   4. assisted-application-log-janitor.yml deletes the run's logs when it
 *      completes;
 *   5. scripts/assisted-application/decrypt-run.mjs decrypts evidence locally
 *      with the same key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ENVELOPE_VERSION = 1;

function variantsOf(value) {
  const text = String(value ?? '').trim();
  if (text.length < 3) return [];
  const out = new Set([text, text.toLowerCase()]);
  const digits = text.replace(/\D/g, '');
  if (digits.length >= 7) {
    out.add(digits);
    out.add(digits.slice(-9));
  }
  if (/\s/.test(text) && !/@/.test(text)) {
    for (const part of text.split(/\s+/)) if (part.length >= 3) out.add(part);
  }
  return [...out];
}

/**
 * Register values with the Actions log masker. Returns how many strings were
 * registered (for the run summary; never the values).
 * @param {Array<unknown>} values
 * @param {(line:string)=>void} [write]
 */
export function maskValues(values, write = (line) => process.stdout.write(line)) {
  const all = new Set();
  for (const value of values.flat(Infinity)) {
    for (const variant of variantsOf(value)) {
      // A newline inside a mask command would end it early and print the rest.
      if (!/[\r\n]/.test(variant)) all.add(variant);
    }
  }
  for (const value of all) write(`::add-mask::${value}\n`);
  return all.size;
}

/** Everything personal an order and its profile carry. */
export function personalValuesOf(order = {}, profile = {}) {
  return [
    order.applicantName, order.applicantEmail, order.applicantPhone, order.customerEmail,
    profile.fullName, profile.email, profile.phone, profile.location, profile.linkedin, profile.website,
  ].filter(Boolean);
}

export function runKeyFrom(raw = process.env.ASSISTED_APPLICATION_RUN_KEY) {
  const key = Buffer.from(String(raw || '').trim(), 'base64');
  if (key.length !== 32) throw new Error('assisted_application_run_key_missing');
  return key;
}

export function encryptJson(payload, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    v: ENVELOPE_VERSION,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decryptJson(envelope, key) {
  if (envelope?.v !== ENVELOPE_VERSION || envelope?.alg !== 'aes-256-gcm') throw new Error('unsupported_envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/**
 * Store encrypted evidence next to the order's files. Flat file names only:
 * the retention job deletes the whole `assisted-application-uploads/<order>/`
 * folder, and its key check accepts no sub-folders.
 */
export async function storeEvidence({ bucket, orderId, name, payload, key, nowMs = Date.now() }) {
  const safeName = String(name).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60);
  const path = `assisted-application-uploads/${orderId}/run-${nowMs}-${safeName}.json.enc`;
  await bucket.file(path).save(JSON.stringify(encryptJson(payload, key)), {
    contentType: 'application/octet-stream',
    resumable: false,
  });
  return path;
}
