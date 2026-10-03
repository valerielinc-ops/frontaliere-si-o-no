/**
 * THE INVARIANT: the record the saved-jobs digest creates for an account that
 * has no `newsletter_subscribers` row gives that account the digest and
 * NOTHING else (owner decision 2026-10-03, "includili al salvataggio").
 *
 * scripts/send-saved-jobs-digest.mjs creates `newsletter_subscribers/{email}`
 * with the address, the uid and the digest's own marker, because that row is
 * where the provider webhooks record a bounce or a complaint. Every other
 * sender reads the same collection. This file proves, sender by sender, that
 * none of them treats that row as a subscription — not when it is fresh, and
 * not after the machines wrote on it: a webhook complaint, bounce or
 * suppression, the recovery a late delivery applies (`status: 'active'`), the
 * suppression decay and the Mailtrap retry (`status: 'pending'`), the account
 * tombstone. Each of those writes a `status`, and a `status` alone used to be
 * a relationship (`hasSubscriptionBasis`).
 *
 * Same shape as tests/no-channel-mails-opted-out.test.ts: the sender population
 * comes from disk (tests/helpers/senders.ts) and every sender must declare how
 * it keeps this row out, so a new channel fails this file the day it is
 * written. The behavioural half drives the real predicates with the real row.
 *
 * Every address here is on example.invalid (the repo is public).
 */
import { describe, expect, it } from 'vitest';
import { buildSavedJobsDigestAnchor } from '../scripts/send-saved-jobs-digest.mjs';
import {
  hasSubscriptionBasis,
  isSavedJobsDigestAnchorOnly,
  SAVED_JOBS_DIGEST_ANCHOR_FIELD,
} from '../services/subscriberConsent.mjs';
import { isCrossChannelStop } from '../services/emailSuppression.mjs';
import {
  evaluateJobAlertConsent,
  hasNewsletterSubscriberRecord,
} from '../functions/src/jobAlertBackfillCore.js';
import { positiveEventRecoveryFields } from '../functions/src/lib/subscriberReactivation.js';
import { bounceUpdateFields } from '../functions/src/lib/bounceClassification.js';
import { recoveredStatus } from '../scripts/lib/suppressionDecay.mjs';
import { classifySunset } from '../scripts/lib/subscriberSunset.mjs';
import { classifyDormantWinback } from '../scripts/lib/dormantWinback.mjs';
import { matchSubscribersForAd } from '../services/publisherBlastMatch.mjs';
import { dedupeRecipients } from '../scripts/send-daily-brief.mjs';
import { planConfirmationFollowups } from '../scripts/newsletter-confirmation-followups.mjs';
import { DEFAULT_CONFIRMATION_FOLLOWUP_EPOCH } from '../functions/src/lib/confirmationFollowup.js';
import { runBackfill } from '../scripts/backfill-jobalerts-from-newsletter.mjs';
import { read, stripComments, discoverSenders } from './helpers/senders';

const EMAIL = 'saver@example.invalid';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

const ANCHOR: Record<string, unknown> = buildSavedJobsDigestAnchor({
  uid: 'uid-saver',
  email: EMAIL,
  activationSource: 'saved_job',
  now: new Date(Date.now() - DAY),
});
const SUPPRESSED = { ...ANCHOR, status: 'suppressed', isActive: false, active: false };

/** The row, as each machine writer can leave it. None of them is a person asking for mail. */
const ANCHOR_SHAPES: Array<[string, Record<string, unknown>]> = [
  ['the fresh record', ANCHOR],
  ['after a spam complaint (webhook)', { ...ANCHOR, status: 'complained', isActive: false, active: false, last_complained_at: daysAgo(1) }],
  ['after a hard bounce (webhook)', { ...ANCHOR, ...bounceUpdateFields({ severity: 'hard', reason: 'mailbox unknown' }), isActive: false, active: false }],
  ['after a provider suppression (webhook)', SUPPRESSED],
  ['after a late delivery recovered it (webhook)', {
    ...SUPPRESSED,
    ...positiveEventRecoveryFields({ currentStatus: 'suppressed', event: 'delivered', subscriber: SUPPRESSED }),
  }],
  ['after the suppression decay restored it', {
    ...SUPPRESSED,
    status: recoveredStatus('newsletter_subscribers', SUPPRESSED),
    isActive: false,
    active: false,
  }],
  // scripts/mailtrap-suppression-retry.mjs writeReactivation(): not importable
  // (it runs main() at load), the three fields are copied from it.
  ['after the Mailtrap retry reactivated it', { ...SUPPRESSED, status: 'pending', isActive: true, active: true }],
  ['after the account was deleted (tombstone)', {
    ...ANCHOR, status: 'unsubscribed', isActive: false, account_deleted_at: daysAgo(1), unsubscribed_at: daysAgo(1),
  }],
];

/**
 * The control: the same row once the person DID register (a sign-in under the
 * terms, which writes a source channel, a creation stamp and the terms). It
 * must be a subscription again, or every refusal below would be vacuous.
 */
const REGISTERED_LATER = {
  ...ANCHOR,
  status: 'confirmed',
  isActive: true,
  active: true,
  source_channel: 'auth_google',
  created_at: daysAgo(1),
  confirmed_at: daysAgo(1),
  registration_terms_accepted: true,
  consent_basis: 'registration_terms',
  consent_text: 'Registrandomi accetto i termini.',
  consent_text_displayed: true,
  consent_act: 'registration_terms_acceptance',
  consent_method: 'terms_and_conditions',
};

describe('the record the digest writes', () => {
  it('is exactly the address, the uid and the marker — nothing a reader takes for a subscription', () => {
    expect(Object.keys(ANCHOR).sort()).toEqual(['auth_uid', 'email', SAVED_JOBS_DIGEST_ANCHOR_FIELD].sort());
    expect(isSavedJobsDigestAnchorOnly(ANCHOR)).toBe(true);
  });

  it.each(ANCHOR_SHAPES)('%s: no subscription basis, no subscriber record', (_label, row) => {
    expect(isSavedJobsDigestAnchorOnly(row)).toBe(true);
    expect(hasSubscriptionBasis(row)).toBe(false);
    expect(hasSubscriptionBasis({ email: EMAIL, status: row.status, doc: row })).toBe(false);
    expect(hasNewsletterSubscriberRecord(row)).toBe(false);
  });

  it('becomes a subscription the moment the person registers, and not before', () => {
    expect(isSavedJobsDigestAnchorOnly(REGISTERED_LATER)).toBe(false);
    expect(hasSubscriptionBasis(REGISTERED_LATER)).toBe(true);
    expect(hasNewsletterSubscriberRecord(REGISTERED_LATER)).toBe(true);
    // Each act alone is enough: a capture, the terms, a consent record.
    expect(hasSubscriptionBasis({ ...SUPPRESSED, source_channel: 'job_gate' })).toBe(true);
    expect(hasSubscriptionBasis({ ...SUPPRESSED, registration_terms_accepted: true })).toBe(true);
    expect(hasSubscriptionBasis({ ...ANCHOR, consent_text: 'Iscrivo il mio indirizzo.' })).toBe(true);
  });

  it('a marker on a row that already holds a relationship changes nothing', () => {
    const legacy = { email: EMAIL, status: 'confirmed', isActive: true, subscribed_at: daysAgo(400) };
    expect(hasSubscriptionBasis({ ...legacy, [SAVED_JOBS_DIGEST_ANCHOR_FIELD]: { created_at: daysAgo(1) } })).toBe(true);
  });

  it('only the Admin SDK can write the marker: the rules list it among the subscription-state fields', () => {
    const rules = read('firestore.rules');
    const start = rules.indexOf('function newsletterStateFieldsTouched');
    const body = rules.slice(start, rules.indexOf('}', start));
    expect(stripComments(body)).toContain(`'${SAVED_JOBS_DIGEST_ANCHOR_FIELD}'`);
  });

  it('the digest keeps its own stops on the record', () => {
    // The point of the record: a complaint or a hard bounce on it stops the
    // digest, a recovered address lets it resume.
    expect(isCrossChannelStop(ANCHOR)).toBe(false);
    expect(isCrossChannelStop(ANCHOR_SHAPES[1][1])).toBe(true);
    expect(isCrossChannelStop(ANCHOR_SHAPES[2][1])).toBe(true);
    expect(isCrossChannelStop(SUPPRESSED)).toBe(true);
    expect(isCrossChannelStop(ANCHOR_SHAPES[4][1])).toBe(false);
  });
});

describe('the senders, driven', () => {
  const now = Date.now();

  it.each(ANCHOR_SHAPES)('send-daily-brief leaves out %s', (_label, row) => {
    const nl = (doc: Record<string, unknown>) => ({ email: EMAIL, status: String(doc.status ?? ''), locale: 'it', doc });
    expect(dedupeRecipients([nl(row)], []).recipients).toEqual([]);
    expect(dedupeRecipients([nl(REGISTERED_LATER)], []).recipients.map((r: { email: string }) => r.email)).toEqual([EMAIL]);
  });

  it.each(ANCHOR_SHAPES)('blast-publisher-ads leaves out %s', (_label, row) => {
    const ad = { title: 'Test', locations: [], keywords: [] };
    const control = { ...REGISTERED_LATER, email: 'registered@example.invalid', consent_advertising: true };
    const audience = matchSubscribersForAd(ad, [{ ...row, email: EMAIL }, control], { minScore: 0 });
    expect(audience.map((a: { email: string }) => a.email)).toEqual(['registered@example.invalid']);
  });

  it.each(ANCHOR_SHAPES)('newsletter-sunset and the win-back leave out %s', (_label, row) => {
    const lapsed = { ...row, send_count: 99, open_count: 0, click_count: 0, engagement_level: 'dormant' };
    expect(classifySunset(lapsed, now).action).toBe('none');
    expect(classifyDormantWinback(lapsed, now).action).toBe('none');
  });

  it.each(ANCHOR_SHAPES)('newsletter-confirmation-followups never asks %s to confirm', (_label, row) => {
    const ctx = { now, epochMs: Date.parse(DEFAULT_CONFIRMATION_FOLLOWUP_EPOCH) };
    expect(planConfirmationFollowups([{ id: EMAIL, data: row }], ctx).send).toEqual([]);
  });

  it.each(ANCHOR_SHAPES)('send-job-alerts refuses a backfilled alert on %s', (_label, row) => {
    const alert = { id: 'backfill-newsletter', active: true, backfilled_from: 'newsletter_subscribers:unknown' };
    expect(evaluateJobAlertConsent({ alert, subscriber: row }).allowed).toBe(false);
  });

  it('the batch backfill manufactures no alert on the record, as the live trigger does not', async () => {
    const recovered = ANCHOR_SHAPES[4][1];
    const docs = [
      { id: 'saver@example.invalid', data: () => ANCHOR },
      { id: 'recovered@example.invalid', data: () => ({ ...recovered, email: 'recovered@example.invalid' }) },
      { id: 'registered@example.invalid', data: () => ({ ...REGISTERED_LATER, email: 'registered@example.invalid' }) },
    ];
    const db = {
      collection: (name: string) => {
        if (name !== 'newsletter_subscribers') throw new Error(`unexpected collection ${name}`);
        return {
          get: async () => ({ size: docs.length, docs }),
          doc: () => ({
            collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }),
          }),
        };
      },
    };
    const result = await runBackfill({ db: db as any, write: false, log: () => {} });
    expect(result.counts['no-subscriber-record']).toBe(2);
    expect(result.counts.wouldWrite).toBe(1);
  });
});

/**
 * How each sender keeps the record out. `gateIn` names the module holding the
 * gate when the sender delegates it.
 */
type Verdict =
  /** Picks recipients from newsletter_subscribers and refuses a row with no relationship. */
  | { verdict: 'subscription-basis'; why: string; gateIn?: string }
  /** Enrols only rows carrying a confirmation stamp, which no machine writes on the record. */
  | { verdict: 'confirmation-anchor'; why: string }
  /** The double opt-in reminders: only a captured `pending` row, dated by its creation stamp. */
  | { verdict: 'consent-request'; why: string; gateIn: string }
  /** Recipients are alerts; the paths that manufacture alerts from a newsletter row refuse the record. */
  | { verdict: 'requested-alerts'; why: string }
  /** Recipients come from the account (users/{uid}); the newsletter row is read only as a stop. */
  | { verdict: 'account-keyed'; why: string }
  | { verdict: 'not-a-broadcast'; why: string };

const VERDICTS: Record<string, Verdict> = {
  'scripts/send-newsletter.mjs': {
    verdict: 'subscription-basis',
    why: 'both the bulk scan and the --target path refuse a row without a basis (#9734)',
  },
  'scripts/send-daily-brief.mjs': {
    verdict: 'subscription-basis',
    why: 'dedupeRecipients refuses the newsletter side without a basis; the job-alert side needs an alert',
  },
  'scripts/blast-publisher-ads.mjs': {
    verdict: 'subscription-basis',
    why: 'isAdvertisingSuppressed starts from hasSubscriptionBasis',
    gateIn: 'services/publisherBlastMatch.mjs',
  },
  'scripts/newsletter-sunset.mjs': {
    verdict: 'subscription-basis',
    why: 'classifySunset: no basis, not a lifecycle candidate',
    gateIn: 'scripts/lib/subscriberSunset.mjs',
  },
  'scripts/newsletter-winback-campaign.mjs': {
    verdict: 'subscription-basis',
    why: 'classifyDormantWinback: no basis, not a win-back candidate',
    gateIn: 'scripts/lib/dormantWinback.mjs',
  },
  'scripts/send-onboarding-drip.mjs': {
    verdict: 'confirmation-anchor',
    why: 'enrolment needs confirmed_at; no webhook, decay or retry writes it',
  },
  'scripts/newsletter-confirmation-followups.mjs': {
    verdict: 'consent-request',
    why: 'status pending AND a creation stamp: the record never has the stamp (no-creation-stamp)',
    gateIn: 'functions/src/lib/confirmationFollowup.js',
  },
  'scripts/send-job-alerts.mjs': {
    verdict: 'requested-alerts',
    why: 'alerts only; backfilled ones pass evaluateJobAlertConsent, and the triggers/batch that manufacture them gate on hasNewsletterSubscriberRecord',
  },
  'scripts/send-company-alerts.mjs': {
    verdict: 'requested-alerts',
    why: 'alerts with a specificCompanyKey, created by an explicit follow only',
  },
  'scripts/send-saved-jobs-digest.mjs': {
    verdict: 'account-keyed',
    why: 'the channel this record exists for',
  },
  'scripts/send-application-intent-reminders.mjs': {
    verdict: 'account-keyed',
    why: 'recipients are Apply clicks of verified accounts; the row only contributes its stop',
  },
  'scripts/send-cold-emails.mjs': { verdict: 'not-a-broadcast', why: 'employer outreach over employer_contacts' },
  'scripts/preview-welcome-email.mjs': { verdict: 'not-a-broadcast', why: 'single --email preview' },
  'scripts/monitor-gsc-job-indexation.mjs': { verdict: 'not-a-broadcast', why: 'ops alert to the owner' },
  'scripts/notify-journalist-article-live.mjs': { verdict: 'not-a-broadcast', why: 'internal notification' },
};

describe('every sender declares how it keeps the record out', () => {
  const senders = discoverSenders();

  it('the discovery found the senders at all', () => {
    expect(senders.length).toBeGreaterThan(8);
    expect(senders).toContain('scripts/send-newsletter.mjs');
  });

  it('no sender is missing a verdict — a new channel must declare one here', () => {
    expect(senders.filter((s) => !(s in VERDICTS))).toEqual([]);
  });

  it('no verdict is stale', () => {
    expect(Object.keys(VERDICTS).filter((s) => !senders.includes(s))).toEqual([]);
  });

  const entries = Object.entries(VERDICTS);

  it.each(entries.filter(([, v]) => v.verdict === 'subscription-basis'))('%s refuses a row without a basis', (file, v) => {
    const where = ('gateIn' in v && v.gateIn) || file;
    expect(stripComments(read(where))).toMatch(/hasSubscriptionBasis\s*\(/);
    // From the shared module, the one that knows the record.
    expect(read(where)).toMatch(/from '[^']*subscriberConsent\.(mjs|js)'/);
    expect(stripComments(read(where))).not.toMatch(/function hasSubscriptionBasis/);
  });

  it.each(entries.filter(([, v]) => v.verdict === 'confirmation-anchor'))('%s enrols on the confirmation stamp only', (file) => {
    expect(stripComments(read(file))).toMatch(/toDate\(data\.confirmed_at\)\s*\|\|\s*toDate\(data\.confirmedAt\)/);
  });

  it.each(entries.filter(([, v]) => v.verdict === 'consent-request'))('%s needs a creation stamp', (_file, v) => {
    const where = (v as Extract<Verdict, { verdict: 'consent-request' }>).gateIn;
    expect(stripComments(read(where))).toMatch(/skip\('no-creation-stamp'\)/);
  });

  it.each(entries.filter(([, v]) => v.verdict === 'requested-alerts'))('%s selects alerts, never the newsletter collection', (file) => {
    const src = stripComments(read(file));
    expect(src).toMatch(/collectionGroup\('alerts'\)/);
    expect(src).not.toMatch(/collection\('newsletter_subscribers'\)\s*\.\s*get\(\)/);
  });

  it('the alert manufacturing paths share the gate that refuses the record', () => {
    const index = stripComments(read('functions/index.js'));
    expect(index).toMatch(/if \(!hasNewsletterSubscriberRecord\(afterData\)\) return;/);
    expect(index).toMatch(/if \(!hasNewsletterSubscriberRecord\(parentData\)\) return;/);
    expect(stripComments(read('scripts/backfill-jobalerts-from-newsletter.mjs')))
      .toMatch(/if \(!hasNewsletterSubscriberRecord\(data\)\)/);
  });

  it.each(entries.filter(([, v]) => v.verdict === 'account-keyed' || v.verdict === 'not-a-broadcast'))(
    '%s does not scan the newsletter collection',
    (file) => {
      expect(stripComments(read(file))).not.toMatch(/collection\('newsletter_subscribers'\)\s*\.\s*get\(\)/);
    },
  );
});

describe('the Cloud Function mailers that select on the row', () => {
  it('the welcome needs a confirmation stamp the record never has', () => {
    const src = stripComments(read('functions/src/newsletterWelcomeEmail.js'));
    expect(src).toMatch(/const anchor = toDate\(data\?\.confirmed_at\) \|\| toDate\(data\?\.confirmedAt\);/);
    expect(stripComments(read('functions/src/lib/welcomeTriggerEligibility.js'))).toMatch(/confirmationMillis\(after\)/);
  });

  it('the double opt-in request needs `pending`, which only a capture or the decay writes', () => {
    // A decay-restored record IS `pending`; the request still needs a person to
    // type the address into a form (newsletterConfirmationEmail is an HTTP
    // endpoint, not a scan), and the reminders above need a creation stamp.
    expect(stripComments(read('functions/src/newsletterConfirmationEmail.js'))).toMatch(/status === 'pending' \? null : 'confirmation_not_pending'/);
  });

  it('the preference centre shows the newsletter off and advertising off for the record, in both modes', () => {
    const auth = stripComments(read('components/preferences/SubscriptionPreferencesController.tsx'));
    expect(auth).toMatch(/!accountDeleted && !optOutBinding && hasSubscriptionBasis\(data\)/);
    expect(auth).toContain('advertisingEnabled: !isAdvertisingSuppressed(data)');
    const token = stripComments(read('functions/src/newsletterSubscriptionManagement.js'));
    expect(token).toMatch(/const subscribed = !optOutBinding && hasSubscriptionBasis\(data\)/);
    const advertising = token.slice(token.indexOf('function isAdvertisingPreferenceEnabled'));
    expect(advertising.slice(0, 400)).toMatch(/if \(!hasSubscriptionBasis\(data\)\) return false;/);
  });
});
