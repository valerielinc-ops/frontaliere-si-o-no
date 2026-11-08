import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  hasRelevantNewsletterSubscriberFieldChange,
  JOB_ALERT_BACKFILL_TRIGGER_FIELDS,
  NEWSLETTER_AUTH_TRIGGER_FIELDS,
  WELCOME_TRIGGER_FIELDS,
} from '../functions/src/lib/newsletterSubscriberTriggerDiff.js';

describe('newsletter subscriber trigger field diffs', () => {
  it('ignores engagement and preferred-hour writes for the welcome trigger', () => {
    const before = {
      confirmed_at: 'first-confirmation',
      welcome_sent_at: null,
      open_count: 3,
      engagement_score: 45,
    };
    const after = {
      ...before,
      open_count: 4,
      engagement_score: 47,
      preferred_send_hour_buffer: [{ event_type: 'open' }],
    };

    expect(hasRelevantNewsletterSubscriberFieldChange(before, after, WELCOME_TRIGGER_FIELDS)).toBe(false);
    expect(hasRelevantNewsletterSubscriberFieldChange(before, { ...after, confirmedAt: 'second-confirmation' }, WELCOME_TRIGGER_FIELDS)).toBe(true);
  });

  it('only treats account deletion lifecycle changes as auth-sync updates', () => {
    const before = { status: 'confirmed', account_deleted_at: null, open_count: 2 };
    expect(hasRelevantNewsletterSubscriberFieldChange(
      before,
      { ...before, open_count: 3 },
      NEWSLETTER_AUTH_TRIGGER_FIELDS,
    )).toBe(false);
    expect(hasRelevantNewsletterSubscriberFieldChange(
      before,
      { ...before, account_deleted_at: 'deleted-now' },
      NEWSLETTER_AUTH_TRIGGER_FIELDS,
    )).toBe(true);
  });

  it('compares backfill eligibility maps by value and catches every signal tier', () => {
    const before = {
      status: 'confirmed',
      preferences: { newsletter: true, jobs: false },
      job_category: '',
      consent_source_url: 'https://frontaliereticino.ch/newsletter/',
    };
    const equivalentAfter = {
      ...before,
      preferences: { newsletter: true, jobs: false },
      open_count: 4,
    };

    expect(hasRelevantNewsletterSubscriberFieldChange(
      before,
      equivalentAfter,
      JOB_ALERT_BACKFILL_TRIGGER_FIELDS,
    )).toBe(false);
    expect(hasRelevantNewsletterSubscriberFieldChange(
      before,
      { ...equivalentAfter, sector_interest: 'health' },
      JOB_ALERT_BACKFILL_TRIGGER_FIELDS,
    )).toBe(true);
    expect(hasRelevantNewsletterSubscriberFieldChange(
      before,
      { ...equivalentAfter, preferences: { newsletter: true, jobs: true } },
      JOB_ALERT_BACKFILL_TRIGGER_FIELDS,
    )).toBe(true);
  });

  it.each([
    'unsubscribed_at',
    'unsubscribedAt',
    'resubscribed_at',
    'resubscribedAt',
    'all_email_opted_out',
    'all_emails_opted_out',
    'global_email_opt_out',
    'global_email_opted_out',
  ])('checks backfill eligibility when %s changes', (field) => {
    expect(hasRelevantNewsletterSubscriberFieldChange(
      { [field]: null },
      { [field]: 'new-consent-state' },
      JOB_ALERT_BACKFILL_TRIGGER_FIELDS,
    )).toBe(true);
  });

  it('treats document creation and deletion as relevant edges', () => {
    expect(hasRelevantNewsletterSubscriberFieldChange(null, { status: 'confirmed' }, WELCOME_TRIGGER_FIELDS)).toBe(true);
    expect(hasRelevantNewsletterSubscriberFieldChange({ status: 'confirmed' }, null, WELCOME_TRIGGER_FIELDS)).toBe(true);
  });
});

describe('newsletter write trigger early exits', () => {
  const source = readFileSync('functions/index.js', 'utf8');

  it('checks the welcome diff before attempting email delivery', () => {
    const start = source.indexOf('export const welcomeOnConfirmation');
    const end = source.indexOf('export const newsletterSendWelcome', start);
    const trigger = source.slice(start, end);

    expect(trigger.indexOf('hasRelevantNewsletterSubscriberFieldChange')).toBeGreaterThanOrEqual(0);
    expect(trigger.indexOf('hasRelevantNewsletterSubscriberFieldChange'))
      .toBeLessThan(trigger.indexOf('sendNewsletterWelcomeEmail'));
  });

  it('checks the auth diff before reading the subscriber through the sync helper', () => {
    const start = source.indexOf('export const syncNewsletterSubscriberAuth');
    const end = source.indexOf('export const cleanupUserDataOnAccountDelete', start);
    const trigger = source.slice(start, end);

    expect(trigger.indexOf('hasRelevantNewsletterSubscriberFieldChange')).toBeGreaterThanOrEqual(0);
    expect(trigger.indexOf('hasRelevantNewsletterSubscriberFieldChange'))
      .toBeLessThan(trigger.indexOf('syncAuthAccountForSubscriber'));
  });

  it('checks the backfill diff before running the signup handler', () => {
    const start = source.indexOf('export const backfillJobAlertOnNewsletterSignup');
    const end = source.indexOf('export const backfillJobAlertOnPersonalizationSync', start);
    const trigger = source.slice(start, end);

    expect(trigger.indexOf('hasRelevantNewsletterSubscriberFieldChange')).toBeGreaterThanOrEqual(0);
    expect(trigger.indexOf('hasRelevantNewsletterSubscriberFieldChange'))
      .toBeLessThan(trigger.indexOf('handleNewsletterSubscriberCreated'));
  });
});
