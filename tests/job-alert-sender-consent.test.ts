import { describe, expect, it } from 'vitest';
import { read } from './helpers/senders';
import {
  evaluateJobAlertConsent,
  hasStoredJobAlertConsent,
} from '../functions/src/jobAlertBackfillCore.js';

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

describe('job-alert sender consent boundary', () => {
  it('keeps an explicit user-created alert independent from newsletter proof', () => {
    expect(evaluateJobAlertConsent({
      alert: { id: 'user-created', active: true, specificCompanyKey: 'acme' },
      subscriber: SILENT_AUTH_SUBSCRIBER,
    })).toEqual({ allowed: true, reason: 'explicit-alert' });
  });

  it('blocks a historical backfill for a silent authentication subscriber', () => {
    expect(evaluateJobAlertConsent({
      alert: BACKFILLED_ALERT,
      subscriber: SILENT_AUTH_SUBSCRIBER,
    })).toEqual({ allowed: false, reason: 'backfill-without-job-alert-consent' });
  });

  it('allows a backfill whose newsletter record has affirmative job-alert consent', () => {
    expect(evaluateJobAlertConsent({
      alert: BACKFILLED_ALERT,
      subscriber: {
        consent_given: true,
        consent_text_displayed: true,
        consent_act: 'typed_email_submit',
        consent_text: 'Chiedo di ricevere gli avvisi di lavoro quotidiani.',
      },
    })).toEqual({ allowed: true, reason: 'subscriber-job-alert-proof' });
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
      reason: 'alert-proof',
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
    }).allowed).toBe(false);
  });

  it('fails closed when the newsletter profile could not be read', () => {
    expect(evaluateJobAlertConsent({ alert: BACKFILLED_ALERT, subscriber: null })).toEqual({
      allowed: false,
      reason: 'backfill-without-job-alert-consent',
    });
  });

  it('re-validates the retry queue instead of sending its old rendered payload blindly', () => {
    const source = read('scripts/send-job-alerts.mjs');
    const start = source.indexOf('async function processRetryQueue(');
    const end = source.indexOf('\n// ── Main ─────────────────────────────────────────────────────', start);
    const retryBody = source.slice(start, end);
    expect(retryBody).toMatch(/evaluateJobAlertConsent\s*\(/);
    expect(retryBody).toMatch(/isCrossChannelStop\s*\(/);
    expect(retryBody).toMatch(/isJobAlertExcluded\s*\(/);
    expect(retryBody).toMatch(/alert\.active !== true/);
    expect(retryBody).toMatch(/await item\.doc\.ref\.delete\(\)/);
  });
});
