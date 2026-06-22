import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  handleJobAlertUnsubscribe,
  generateAlertUnsubToken,
  generateAllAlertsUnsubToken,
} from '../functions/src/jobAlertUnsubscribe.js';

const SECRET = 'test-secret-unsub-2026';
const EMAIL = 'user@example.com';
const ALERT_ID = 'alert-abc-123';

function validToken() {
  return generateAlertUnsubToken(ALERT_ID, EMAIL, SECRET);
}

function fakeDb(alertData: false | null | Record<string, unknown>) {
  // alertData=null  → doc does not exist
  // alertData=false → doc does not exist (same)
  // alertData={...} → doc exists with that data
  const exists = alertData !== null && alertData !== false;
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists, data: () => alertData || {} }),
            update: async () => {},
          }),
          where: () => ({
            get: async () => ({
              empty: !exists,
              size: exists ? 1 : 0,
              docs: exists ? [{ ref: { update: async () => {} } }] : [],
            }),
          }),
        }),
      }),
    }),
    batch: () => ({
      update: () => {},
      commit: async () => {},
    }),
  };
}

// ── Token helpers ─────────────────────────────────────────────────────────────

describe('generateAlertUnsubToken', () => {
  it('returns a hex string', () => {
    const tok = generateAlertUnsubToken(ALERT_ID, EMAIL, SECRET);
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is consistent for same inputs', () => {
    expect(generateAlertUnsubToken(ALERT_ID, EMAIL, SECRET))
      .toBe(generateAlertUnsubToken(ALERT_ID, EMAIL, SECRET));
  });

  it('differs from the all-alerts token', () => {
    expect(generateAlertUnsubToken(ALERT_ID, EMAIL, SECRET))
      .not.toBe(generateAllAlertsUnsubToken(EMAIL, SECRET));
  });
});

// ── Parameter validation ──────────────────────────────────────────────────────

describe('handleJobAlertUnsubscribe — missing params', () => {
  it('returns 400 when alertId is missing', async () => {
    const result = await handleJobAlertUnsubscribe({
      alertId: '',
      email: EMAIL,
      token: validToken(),
      secret: SECRET,
      action: '',
      db: fakeDb(null) as any,
    });
    expect(result.status).toBe(400);
  });

  it('returns 400 when email is missing', async () => {
    const result = await handleJobAlertUnsubscribe({
      alertId: ALERT_ID,
      email: '',
      token: validToken(),
      secret: SECRET,
      action: '',
      db: fakeDb(null) as any,
    });
    expect(result.status).toBe(400);
  });
});

// ── HMAC verification ─────────────────────────────────────────────────────────

describe('handleJobAlertUnsubscribe — bad HMAC', () => {
  it('returns 403 for a tampered token', async () => {
    const result = await handleJobAlertUnsubscribe({
      alertId: ALERT_ID,
      email: EMAIL,
      token: 'deadbeef'.repeat(8),
      secret: SECRET,
      action: '',
      db: fakeDb({ active: true }) as any,
    });
    expect(result.status).toBe(403);
  });
});

// ── Idempotency (core of the fix) ────────────────────────────────────────────

describe('handleJobAlertUnsubscribe — idempotency', () => {
  it('returns 200 when the alert document does not exist (RFC 8058 retry safety)', async () => {
    // Regression: was 404, degraded sender reputation on mail-provider retries.
    const result = await handleJobAlertUnsubscribe({
      alertId: ALERT_ID,
      email: EMAIL,
      token: validToken(),
      secret: SECRET,
      action: '',
      db: fakeDb(null) as any,
    });
    expect(result.status).toBe(200);
    expect(result.html).toContain('Già disiscritto');
  });

  it('returns 200 when the alert exists but is already inactive', async () => {
    const result = await handleJobAlertUnsubscribe({
      alertId: ALERT_ID,
      email: EMAIL,
      token: validToken(),
      secret: SECRET,
      action: '',
      db: fakeDb({ active: false }) as any,
    });
    expect(result.status).toBe(200);
  });
});
