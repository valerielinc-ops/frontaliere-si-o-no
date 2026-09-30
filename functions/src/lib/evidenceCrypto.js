/**
 * AES-256-GCM envelope for the assisted application's private evidence (run
 * snapshots of the GitHub Actions agent, employer messages received on the
 * order alias). One implementation shared by the Cloud Functions and the
 * runner (scripts/assisted-application/lib/secure-run.mjs re-exports it).
 * Key: Remote Config ASSISTED_APPLICATION_RUN_KEY (base64, 32 bytes).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ENVELOPE_VERSION = 1;

export function runKeyFrom(raw) {
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
