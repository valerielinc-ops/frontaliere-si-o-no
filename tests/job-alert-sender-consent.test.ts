import { afterEach, describe, expect, it } from 'vitest';
import { read } from './helpers/senders';
import {
  __setFirestoreAdminForTest,
  ensureJobAlertConsentProof,
  persistJobAlertDelivery,
} from '../scripts/send-job-alerts.mjs';
import { readDeliveryConsentEvidence } from '../scripts/ci/export-loop-outcomes.mjs';
import {
  evaluateJobAlertConsent,
  hasStoredJobAlertConsent,
} from '../functions/src/jobAlertBackfillCore.js';

function createDeliveryFakeDb() {
  const sets: Array<{ path: string; data: Record<string, unknown>; merge: boolean }> = [];
  const docNode = (path: string): any => ({
    collection: (name: string) => collectionNode(`${path}/${name}`),
    set: (data: Record<string, unknown>, opts: { merge?: boolean }) => {
      sets.push({ path, data, merge: opts?.merge === true });
      return Promise.resolve();
    },
  });
  const collectionNode = (path: string): any => ({ doc: (id: string) => docNode(`${path}/${id}`) });
  return { db: { collection: (name: string) => collectionNode(name) }, sets };
}

function createConsentRevalidationFakeDb({ root = {}, newsletter = {}, alert = {} } = {}) {
  const email = 'seeker@example.test';
  const docs = new Map<string, Record<string, unknown>>([
    [`job_alert_subscribers/${email}`, root],
    [`newsletter_subscribers/${email}`, newsletter],
    [`job_alert_subscribers/${email}/alerts/alert-1`, alert],
  ]);
  let getAllCalls = 0;
  const snapshot = (path: string) => ({
    exists: docs.has(path),
    data: () => docs.get(path),
  });
  const ref = (path: string): any => ({
    path,
    collection: (name: string) => ({ doc: (id: string) => ref(`${path}/${name}/${id}`) }),
    get: async () => snapshot(path),
  });
  const db = {
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    getAll: async (...refs: any[]) => {
      getAllCalls += 1;
      return refs.map((entry) => snapshot(entry.path));
    },
  };
  return { db, getAllCalls: () => getAllCalls };
}

afterEach(() => {
  __setFirestoreAdminForTest(null);
});

const SILENT_AUTH_SUBSCRIBER = {
  status: 'confirmed',
  isActive: true,
  source: 'signup',
  source_channel: 'auth_google',
  consent_given: false,
  consent_act: 'authentication',
  consent_text_displayed: false,
  confirmed_at: '2026-09-07T18:18:41.277Z',
};

const BACKFILLED_ALERT = {
  id: 'backfill-newsletter',
  active: true,
  backfilled_from: 'newsletter_subscribers:calculator_paywall',
};

describe('job-alert sender base-relationship and suppression boundary', () => {
  it('keeps an explicit user-created alert independent from newsletter proof', () => {
    expect(evaluateJobAlertConsent({
      alert: { id: 'user-created', active: true, specificCompanyKey: 'acme' },
      subscriber: SILENT_AUTH_SUBSCRIBER,
    })).toEqual({ allowed: true, reason: 'explicit-alert' });
  });

  it('allows a historical backfill for a terms-based silent authentication subscriber', () => {
    expect(evaluateJobAlertConsent({
      alert: BACKFILLED_ALERT,
      subscriber: SILENT_AUTH_SUBSCRIBER,
    })).toEqual({ allowed: true, reason: 'backfill-newsletter-registration' });
  });

  it('keeps explicit job-alert proof as historical metadata without requiring it', () => {
    expect(evaluateJobAlertConsent({
      alert: BACKFILLED_ALERT,
      subscriber: {
        consent_given: true,
        consent_text_displayed: true,
        consent_act: 'typed_email_submit',
        consent_text: 'Chiedo di ricevere gli avvisi di lavoro quotidiani.',
      },
    })).toEqual({ allowed: true, reason: 'backfill-newsletter-registration' });
  });

  it('allows a backfill explicitly upgraded from the site', () => {
    const alert = {
      ...BACKFILLED_ALERT,
      consent_text: 'Iscrivo il mio indirizzo alle comunicazioni. Vai a frontaliereticino.ch/comunicazioni.',
      consent_text_displayed: true,
      consent_act: 'job_alert_activation_click',
      consent_origin: 'backfill_upgraded_by_explicit_act',
      consent_upgraded_at: '2026-09-08T10:00:00.000Z',
    };
    expect(hasStoredJobAlertConsent(alert)).toBe(true);
    expect(evaluateJobAlertConsent({ alert, subscriber: SILENT_AUTH_SUBSCRIBER })).toEqual({
      allowed: true,
      reason: 'backfill-newsletter-registration',
    });
  });

  it('does not treat a bare or undisclosed text as job-alert consent', () => {
    expect(hasStoredJobAlertConsent({
      ...BACKFILLED_ALERT,
      consent_text: 'Accetto le comunicazioni.',
      consent_act: 'typed_email_submit',
      consent_text_displayed: false,
    })).toBe(false);
    expect(evaluateJobAlertConsent({
      alert: { ...BACKFILLED_ALERT, consent_text: 'Accetto le comunicazioni.' },
      subscriber: SILENT_AUTH_SUBSCRIBER,
    }).allowed).toBe(true);
  });

  it('does not turn a missing profile into a consent gate', () => {
    expect(evaluateJobAlertConsent({ alert: BACKFILLED_ALERT, subscriber: null })).toEqual({
      allowed: true,
      reason: 'backfill-newsletter-registration',
    });
  });

  it('refuses a backfilled alert whose newsletter document carries no relationship (profile-only)', () => {
    // The shape of the 235 documents measured on 2026-09-25: login/profile
    // fields only. 226 of them held an alert backfilled from
    // `newsletter_subscribers:unknown`; 108 received job alerts after 17/09.
    const profileOnly = { auth_uid: 'uid', name: 'Profile Only', lastLoginAt: 'ts', send_count: 2 };
    expect(evaluateJobAlertConsent({
      alert: { ...BACKFILLED_ALERT, backfilled_from: 'newsletter_subscribers:unknown' },
      subscriber: profileOnly,
    })).toEqual({ allowed: false, reason: 'no-subscription-basis' });
  });

  it('keeps an explicit company-follow alert on a profile-only document (the follow is its own basis)', () => {
    expect(evaluateJobAlertConsent({
      alert: {
        id: 'follow',
        active: true,
        specificCompanyKey: 'migros',
        consent_act: 'company_follow_activation',
        consent_purpose: 'companyFollow',
      },
      subscriber: { auth_uid: 'uid', lastLoginAt: 'ts' },
    })).toEqual({ allowed: true, reason: 'explicit-alert' });
  });

  it('keeps a backfilled alert that an explicit act upgraded, even on a profile-only document', () => {
    expect(evaluateJobAlertConsent({
      alert: {
        ...BACKFILLED_ALERT,
        consent_text: 'Iscrivo il mio indirizzo alle comunicazioni. Vai a frontaliereticino.ch/comunicazioni.',
        consent_text_displayed: true,
        consent_act: 'communications_banner_confirm_click',
        consent_origin: 'communications_consent_banner',
      },
      subscriber: { auth_uid: 'uid', lastLoginAt: 'ts' },
    }).allowed).toBe(true);
  });

  it('applies the same predicate in the sender and in its retry queue', () => {
    const source = read('scripts/send-job-alerts.mjs');
    expect(source).toMatch(/import \{ evaluateJobAlertConsent \} from '\.\/lib\/jobalert-backfill-core\.mjs'/);
    const main = source.slice(source.indexOf('async function main('));
    expect(main).toMatch(/evaluateJobAlertConsent\(\{\s*alert: a,\s*subscriber: subscriberProfiles\.get/);
    const start = source.indexOf('async function processRetryQueue(');
    const retryBody = source.slice(start, source.indexOf('\n// ── Main ─────────────────────────────────────────────────────', start));
    expect(retryBody).toMatch(/const consent = evaluateJobAlertConsent\(\{ alert, subscriber: newsletter \}\)/);
    expect(retryBody).toMatch(/if \(!consent\.allowed\)/);
    expect(source).toMatch(/beforeProviderAttempt: beforeJobAlertProviderAttempt/);
    expect(retryBody).toMatch(/beforeJobAlertProviderAttempt\(item, provider\)/);
  });

  it('refreshes only an aged proof at the provider boundary and keeps the exporter contract measurable', async () => {
    const nowMs = Date.parse('2026-11-26T08:00:00.000Z');
    const oldProof = {
      allowed: true,
      basis: 'explicit-alert',
      checkedAt: new Date(nowMs - 21 * 60_000).toISOString(),
    };
    const { db, getAllCalls } = createConsentRevalidationFakeDb({
      root: { status: 'active' },
      newsletter: { status: 'confirmed' },
      alert: { active: true, email: 'seeker@example.test' },
    });
    const item = {
      recipient: { email: 'Seeker@Example.test' },
      meta: { alertId: 'alert-1', consentProof: oldProof },
    };

    expect(await ensureJobAlertConsentProof(item, { db, nowMs })).toBe(true);
    expect(getAllCalls()).toBe(1);
    expect(item.meta.consentProof).toEqual({
      allowed: true,
      basis: 'explicit-alert',
      checkedAt: new Date(nowMs).toISOString(),
    });

    const sentAt = new Date(nowMs);
    expect(readDeliveryConsentEvidence({
      consent_checked: true,
      consent_allowed: true,
      consent_basis: item.meta.consentProof.basis,
      consent_checked_at: item.meta.consentProof.checkedAt,
      outcome_contract_version: 1,
    }, sentAt)).toMatchObject({ status: 'valid', basis: 'explicit-alert' });

    const freshItem = {
      recipient: { email: 'seeker@example.test' },
      meta: {
        alertId: 'alert-1',
        consentProof: {
          ...item.meta.consentProof,
          checkedAt: new Date(nowMs - 60_000).toISOString(),
        },
      },
    };
    expect(await ensureJobAlertConsentProof(freshItem, { db, nowMs })).toBe(true);
    expect(getAllCalls()).toBe(1);
  });

  it('fails closed when a stale proof meets a current cross-channel stop', async () => {
    const nowMs = Date.parse('2026-11-26T08:00:00.000Z');
    const oldProof = {
      allowed: true,
      basis: 'explicit-alert',
      checkedAt: new Date(nowMs - 21 * 60_000).toISOString(),
    };
    const { db } = createConsentRevalidationFakeDb({
      root: { status: 'active' },
      newsletter: { global_email_opt_out: true },
      alert: { active: true, email: 'seeker@example.test' },
    });
    const item = {
      recipient: { email: 'seeker@example.test' },
      meta: { alertId: 'alert-1', consentProof: oldProof },
    };

    expect(await ensureJobAlertConsentProof(item, { db, nowMs })).toBe(false);
    expect(item.meta.consentProof).toBe(oldProof);
  });

  it('persists filter-time consent proof with every job-alert delivery record', () => {
    const source = read('scripts/send-job-alerts.mjs');
    expect(source).toMatch(/const consentProof = item\.meta\?\.consentProof \|\| null/);
    expect(source).toMatch(/consent_checked:\s*consentProof \? true : null/);
    expect(source).toMatch(/consent_allowed:\s*consentProof \? consentProof\.allowed === true : null/);
    expect(source).toMatch(/const consentCheckedAt = consentProof\?\.checkedAt \|\| null/);
    expect(source).not.toMatch(/consentProof \? sentAt\.toISOString\(\)/);
    expect(source).toMatch(/consent_checked_at:\s*consentCheckedAt/);
    expect(source).toMatch(/outcome_contract_version:\s*1/);
    expect(source).toMatch(/consentProof:\s*e\.consentProof/);
  });

  it('retains a delayed audience proof at the persisted send boundary', async () => {
    const { db, sets } = createDeliveryFakeDb();
    __setFirestoreAdminForTest(db);
    const checkedAt = new Date(Date.now() - 60_000).toISOString();

    await persistJobAlertDelivery({
      recipient: { email: 'seeker@example.test' },
      meta: {
        alertId: 'alert-1',
        consentProof: {
          allowed: true,
          basis: 'subscription',
          checkedAt,
        },
      },
    }, { provider: 'maileroo', messageId: 'ref-delayed' });

    const written = sets[0].data;
    expect(written.consent_checked_at).toBe(checkedAt);
    expect(written.consent_checked_at).not.toBe((written.sent_at as Date).toISOString());
    expect(readDeliveryConsentEvidence(written, written.sent_at)).toMatchObject({
      status: 'valid',
      basis: 'subscription',
    });
  });

  it('still blocks an explicit cross-channel stop', () => {
    expect(evaluateJobAlertConsent({
      alert: BACKFILLED_ALERT,
      subscriber: { ...SILENT_AUTH_SUBSCRIBER, global_email_opt_out: true },
    })).toEqual({ allowed: false, reason: 'cross-channel-stop' });
  });

  it('re-validates the retry queue instead of sending its old rendered payload blindly', () => {
    const source = read('scripts/send-job-alerts.mjs');
    const start = source.indexOf('async function processRetryQueue(');
    const end = source.indexOf('\n// ── Main ─────────────────────────────────────────────────────', start);
    const retryBody = source.slice(start, end);
    expect(retryBody).toMatch(/isCrossChannelStop\s*\(/);
    expect(retryBody).toMatch(/isJobAlertExcluded\s*\(/);
    expect(retryBody).toMatch(/alert\.active !== true/);
    expect(retryBody).toMatch(/await item\.doc\.ref\.delete\(\)/);
  });

  it('keeps non-target retry items untouched during an operator verification run', () => {
    const source = read('scripts/send-job-alerts.mjs');
    const start = source.indexOf('async function processRetryQueue(');
    const end = source.indexOf('\n// ── Main ─────────────────────────────────────────────────────', start);
    const retryBody = source.slice(start, end);
    expect(retryBody).toMatch(/ALLOWED_EMAILS\s*&&\s*!ALLOWED_EMAILS\.has\(email\)\)\s*continue/);
    expect(retryBody).toMatch(/finalisation[\s\S]*ALLOWED_EMAILS\s*&&\s*!ALLOWED_EMAILS\.has\(email\)/);
  });
});
