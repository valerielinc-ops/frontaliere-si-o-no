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

// ── Forensics on the write ───────────────────────────────────────────────────
//
// A bare GET unsubscribes immediately and always will (RFC 8058 + footer links,
// and a non-200 to a provider costs sender reputation). What changed is that the
// write now records WHO asked: measured on production 2026-08-10, 73 of 845
// deactivated alerts (8.6%) flipped <60s after the delivery event — the window
// automated link-fetchers land in — and nothing stored could tell those apart
// from a fast human click.

/** Captures the exact payloads handed to Firestore so assertions can read them. */
function capturingDb(alertData: Record<string, unknown> | null) {
  const updates: Record<string, any>[] = [];
  const batchUpdates: Record<string, any>[] = [];
  const exists = alertData !== null;
  const db = {
    updates,
    batchUpdates,
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists, data: () => alertData || {} }),
            update: async (payload: Record<string, any>) => { updates.push(payload); },
          }),
          where: () => ({
            get: async () => ({
              empty: !exists,
              size: exists ? 1 : 0,
              docs: exists ? [{ ref: { id: 'alert-ref' } }] : [],
            }),
          }),
        }),
      }),
    }),
    batch: () => ({
      update: (_ref: unknown, payload: Record<string, any>) => { batchUpdates.push(payload); },
      commit: async () => {},
    }),
  };
  return db;
}

describe('handleJobAlertUnsubscribe — forensics', () => {
  it('records a GET on the single-alert write', async () => {
    const db = capturingDb({ active: true });
    const result = await handleJobAlertUnsubscribe({
      alertId: ALERT_ID,
      email: EMAIL,
      token: validToken(),
      secret: SECRET,
      action: '',
      forensics: {
        unsubscribe_method: 'GET',
        unsubscribe_user_agent: 'Mozilla/5.0 (corporate-link-checker)',
        unsubscribe_ip: '203.0.113.0',
      },
      db: db as any,
    });

    expect(result.status).toBe(200);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toMatchObject({
      active: false,
      unsubscribe_source: 'email_link',
      unsubscribe_method: 'GET',
      unsubscribe_user_agent: 'Mozilla/5.0 (corporate-link-checker)',
      unsubscribe_ip: '203.0.113.0',
    });
  });

  it('records a POST — the RFC 8058 one-click verb, the high-signal discriminator', async () => {
    const db = capturingDb({ active: true });
    await handleJobAlertUnsubscribe({
      alertId: ALERT_ID,
      email: EMAIL,
      token: validToken(),
      secret: SECRET,
      action: '',
      forensics: { unsubscribe_method: 'POST' },
      db: db as any,
    });
    expect(db.updates[0].unsubscribe_method).toBe('POST');
  });

  it('records forensics on the unsubscribe_all batch too', async () => {
    const db = capturingDb({ active: true });
    const result = await handleJobAlertUnsubscribe({
      alertId: '',
      email: EMAIL,
      token: generateAllAlertsUnsubToken(EMAIL, SECRET),
      secret: SECRET,
      action: 'unsubscribe_all',
      forensics: { unsubscribe_method: 'POST', unsubscribe_ip: '203.0.113.0' },
      db: db as any,
    });

    expect(result.status).toBe(200);
    expect(db.batchUpdates).toHaveLength(1);
    expect(db.batchUpdates[0]).toMatchObject({
      active: false,
      unsubscribe_source: 'email_link_all',
      unsubscribe_method: 'POST',
      unsubscribe_ip: '203.0.113.0',
    });
  });

  it('tolerates a missing user-agent — the other fields are still stored', async () => {
    const db = capturingDb({ active: true });
    await handleJobAlertUnsubscribe({
      alertId: ALERT_ID,
      email: EMAIL,
      token: validToken(),
      secret: SECRET,
      action: '',
      forensics: { unsubscribe_method: 'GET' },
      db: db as any,
    });
    expect(db.updates[0].unsubscribe_method).toBe('GET');
    expect(db.updates[0]).not.toHaveProperty('unsubscribe_user_agent');
  });

  it('unsubscribes exactly as before when no forensics are passed at all', async () => {
    const db = capturingDb({ active: true });
    const result = await handleJobAlertUnsubscribe({
      alertId: ALERT_ID,
      email: EMAIL,
      token: validToken(),
      secret: SECRET,
      action: '',
      db: db as any,
    });
    expect(result.status).toBe(200);
    expect(db.updates[0]).toMatchObject({ active: false, unsubscribe_source: 'email_link' });
    expect(db.updates[0]).not.toHaveProperty('unsubscribe_method');
  });

  it('still unsubscribes when the forensics object itself throws on read', async () => {
    // The capture must never be able to fail the unsubscribe: a provider that
    // retries a non-200 POST is a sender-reputation cost, and the user asked to
    // be removed regardless of whether we can say who they are.
    const hostile = {
      unsubscribe_method: 'GET',
      get unsubscribe_user_agent(): string { throw new Error('boom'); },
    };
    const db = capturingDb({ active: true });
    const result = await handleJobAlertUnsubscribe({
      alertId: ALERT_ID,
      email: EMAIL,
      token: validToken(),
      secret: SECRET,
      action: '',
      forensics: hostile as any,
      db: db as any,
    });

    expect(result.status).toBe(200);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toMatchObject({ active: false, unsubscribe_source: 'email_link' });
    // Partial capture is discarded rather than half-written.
    expect(db.updates[0]).not.toHaveProperty('unsubscribe_user_agent');
  });

  it('ignores non-allowlisted keys smuggled into the forensics object', async () => {
    const db = capturingDb({ active: true });
    await handleJobAlertUnsubscribe({
      alertId: ALERT_ID,
      email: EMAIL,
      token: validToken(),
      secret: SECRET,
      action: '',
      forensics: { unsubscribe_method: 'GET', active: true, unsubscribe_source: 'spoofed' } as any,
      db: db as any,
    });
    expect(db.updates[0].active).toBe(false);
    expect(db.updates[0].unsubscribe_source).toBe('email_link');
  });
});
