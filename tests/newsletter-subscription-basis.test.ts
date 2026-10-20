/**
 * Profile-only documents are not subscriptions (hasSubscriptionBasis).
 *
 * #8341 separated consent from login. From 12/09/2026 a generic sign-in could
 * write a document into `newsletter_subscribers` carrying only profile fields
 * (name, photo, `auth_uid`, `lastLoginAt`): no status, no registration terms,
 * no consent, no confirmation. Every ordinary sender read the missing status
 * as the legacy mailable `''`, so those rows joined the audience. Measured on
 * production on 24/09/2026: 235 such rows among 13.064, every one of them in
 * the resume logs of `weekly_2026-09-14` and `weekly_2026-09-21`.
 *
 * The fix is a floor under the #8754 policy, NOT a return of the double
 * opt-in: registration terms alone still suffice, `pending` still receives,
 * a missing `confirmed_at` still does not block. These tests pin both halves,
 * plus a scan that every sender drawing from `newsletter_subscribers` routes
 * its population through the one shared predicate.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { hasSubscriptionBasis } from '../services/subscriberConsent.mjs';
// @ts-expect-error — .mjs module without type declarations
import { dedupeRecipients } from '../scripts/send-daily-brief.mjs';
import { classifyDormantWinback, MIN_SENDS_BEFORE_WINBACK } from '../scripts/lib/dormantWinback.mjs';
import { classifySunset, SUNSET_MIN_SENDS, SUNSET_MIN_AGE_DAYS } from '../scripts/lib/subscriberSunset.mjs';
import { isAdvertisingSuppressed } from '../services/publisherBlastMatch.mjs';
import { ROOT, read, stripComments } from './helpers/senders';

const STAMP = '2026-09-01T10:00:00.000Z';

/**
 * The measured production shape of the 235 rows: profile and delivery
 * bookkeeping written by sign-in and by the sends themselves, nothing else.
 */
const PROFILE_ONLY = Object.freeze({
  auth_uid: 'uid-123',
  auth_provider: 'google',
  lastLoginAt: STAMP,
  name: 'Mario Rossi',
  firstName: 'Mario',
  lastName: 'Rossi',
  photoURL: 'https://example.com/p.png',
  updatedAt: STAMP,
  updated_at: STAMP,
  engagement_score: 0,
  engagement_level: 'new',
  engagement_updated_at: STAMP,
  last_sent_at: STAMP,
  send_count: 2,
  last_delivered_at: STAMP,
  soft_bounce_count: 0,
});

const TERMS = { registration_terms_accepted: true, consent_basis: 'registration_terms' };

describe('hasSubscriptionBasis', () => {
  it('a profile-only sign-in document has no basis', () => {
    expect(hasSubscriptionBasis({ ...PROFILE_ONLY })).toBe(false);
    expect(hasSubscriptionBasis({ ...PROFILE_ONLY, status: '   ' })).toBe(false);
    expect(hasSubscriptionBasis(null)).toBe(false);
    expect(hasSubscriptionBasis(undefined)).toBe(false);
  });

  it('registration terms alone are a basis — no confirmation required (#8754)', () => {
    expect(hasSubscriptionBasis({ ...PROFILE_ONLY, registration_terms_accepted: true })).toBe(true);
    expect(hasSubscriptionBasis({ ...PROFILE_ONLY, consent_basis: 'registration_terms' })).toBe(true);
  });

  it('a confirmed subscriber is included, with or without the status', () => {
    expect(hasSubscriptionBasis({ status: 'confirmed', confirmed_at: STAMP })).toBe(true);
    expect(hasSubscriptionBasis({ ...PROFILE_ONLY, confirmed_at: STAMP })).toBe(true);
    expect(hasSubscriptionBasis({ ...PROFILE_ONLY, confirmedAt: STAMP })).toBe(true);
  });

  it('any status is a basis, pending included; exclusion is not this predicate\'s job', () => {
    for (const status of ['pending', 'confirmed', 'active', 'subscribed', 'unsubscribed', 'inactive']) {
      expect(hasSubscriptionBasis({ ...PROFILE_ONLY, status }), status).toBe(true);
    }
  });

  it('a recorded consent act is a basis (communications banner click, consent_given)', () => {
    expect(hasSubscriptionBasis({
      ...PROFILE_ONLY,
      consent_act: 'communications_banner_confirm_click',
      consent_text_displayed: true,
      consent_text: 'Voglio ricevere comunicazioni',
    })).toBe(true);
    expect(hasSubscriptionBasis({ ...PROFILE_ONLY, consent_given: true })).toBe(true);
  });

  it('the legacy subscription shape is a basis', () => {
    expect(hasSubscriptionBasis({ ...PROFILE_ONLY, isActive: true })).toBe(true);
    expect(hasSubscriptionBasis({ ...PROFILE_ONLY, active: false })).toBe(true);
    expect(hasSubscriptionBasis({ ...PROFILE_ONLY, preferences: { weekly: true } })).toBe(true);
    expect(hasSubscriptionBasis({ ...PROFILE_ONLY, subscribedAt: STAMP })).toBe(true);
  });

  it('reads the raw row carried on `.doc` too', () => {
    expect(hasSubscriptionBasis({ email: 'x@example.com', doc: { ...PROFILE_ONLY } })).toBe(false);
    expect(hasSubscriptionBasis({ email: 'x@example.com', doc: { ...PROFILE_ONLY, ...TERMS } })).toBe(true);
  });
});

describe('daily brief: the newsletter side needs a basis', () => {
  const row = (email: string, doc: Record<string, unknown>) => ({
    email, status: doc.status, locale: 'it', name: null, doc,
  });

  it('profile-only out and counted; terms-only, confirmed and pending in; opt-out out as before', () => {
    const { recipients, stats } = dedupeRecipients(
      [
        row('profile@example.com', { ...PROFILE_ONLY }),
        row('terms@example.com', { ...PROFILE_ONLY, ...TERMS }),
        row('conf@example.com', { status: 'confirmed', confirmed_at: STAMP }),
        row('pend@example.com', { status: 'pending', ...TERMS }),
        row('unsub@example.com', { status: 'unsubscribed', ...TERMS }),
      ],
      [],
    );
    expect(recipients.map((r: { email: string }) => r.email)).toEqual([
      'conf@example.com', 'pend@example.com', 'terms@example.com',
    ]);
    expect(stats.excludedNoBasis).toBe(1);
    expect(stats.newsletterExcluded).toBe(1);
    expect(stats.newsletterRegistered).toBe(3);
  });

  it('an eligible job-alert membership is its own basis for the same address', () => {
    const { recipients, stats } = dedupeRecipients(
      [row('both@example.com', { ...PROFILE_ONLY })],
      [{ email: 'both@example.com', status: 'active', doc: { status: 'active' } }],
    );
    expect(stats.excludedNoBasis).toBe(1);
    expect(recipients.map((r: { email: string; source: string }) => [r.email, r.source]))
      .toEqual([['both@example.com', 'job-alert']]);
  });
});

describe('lifecycle and advertising senders apply the same floor', () => {
  const NOW = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  it('dormant win-back: profile-only is never a candidate; the same row with terms still is', () => {
    const dormant = {
      ...PROFILE_ONLY,
      send_count: MIN_SENDS_BEFORE_WINBACK + 2,
      open_count: 0,
      click_count: 0,
      created_at: NOW - 30 * DAY,
    };
    const verdict = classifyDormantWinback(dormant, NOW);
    expect(verdict.action).toBe('none');
    expect(verdict.reason).toMatch(/no subscription basis/);
    expect(classifyDormantWinback({ ...dormant, ...TERMS }, NOW).action).toBe('stage1');
  });

  it('sunset: profile-only gets neither a win-back email nor a status write', () => {
    const zombie = {
      ...PROFILE_ONLY,
      send_count: SUNSET_MIN_SENDS + 5,
      open_count: 0,
      click_count: 0,
      created_at: NOW - (SUNSET_MIN_AGE_DAYS + 30) * DAY,
    };
    const verdict = classifySunset(zombie, NOW);
    expect(verdict.action).toBe('none');
    expect(verdict.reason).toMatch(/no subscription basis/);
    expect(classifySunset({ ...zombie, ...TERMS }, NOW).action).toBe('winback');
  });

  it('advertising blast: profile-only is suppressed; terms-only is not', () => {
    expect(isAdvertisingSuppressed({ ...PROFILE_ONLY })).toBe(true);
    expect(isAdvertisingSuppressed({ ...PROFILE_ONLY, ...TERMS })).toBe(false);
  });
});

describe('every newsletter_subscribers sender routes through the one predicate', () => {
  const CALLS = /hasSubscriptionBasis\s*\(/;
  const IMPORTS = /import \{[^}]*\bhasSubscriptionBasis\b[^}]*\} from '[^']*subscriberConsent\.(mjs|js)'/;

  /**
   * Sender -> module that selects its population. A sender that draws an
   * ordinary audience from `newsletter_subscribers` must appear here (or be
   * listed as gated by construction below), so a new one cannot quietly
   * re-admit profile-only rows.
   */
  const ROUTES: Record<string, string> = {
    'scripts/send-newsletter.mjs': 'scripts/send-newsletter.mjs',
    'scripts/send-daily-brief.mjs': 'scripts/send-daily-brief.mjs',
    'scripts/newsletter-winback-campaign.mjs': 'scripts/lib/dormantWinback.mjs',
    'scripts/newsletter-sunset.mjs': 'scripts/lib/subscriberSunset.mjs',
    'scripts/blast-publisher-ads.mjs': 'services/publisherBlastMatch.mjs',
  };
  /** Senders whose own gate already excludes a row with no status/terms/stamp. */
  const BY_CONSTRUCTION: Record<string, RegExp> = {
    // Enrolment requires a fresh `confirmed_at` anchor.
    'scripts/send-onboarding-drip.mjs': /toDate\(data\.confirmed_at\)/,
    // The double opt-in reminder: its population is `pending` rows by definition.
    'scripts/newsletter-confirmation-followups.mjs': /planConfirmationFollowups/,
  };

  it.each(Object.entries(ROUTES))('%s -> %s calls hasSubscriptionBasis from the shared module', (_sender, where) => {
    expect(stripComments(read(where))).toMatch(CALLS);
    expect(read(where)).toMatch(IMPORTS);
  });

  it.each(Object.entries(BY_CONSTRUCTION))('%s excludes profile-only rows by construction', (sender, pattern) => {
    expect(stripComments(read(sender))).toMatch(pattern);
  });

  it('send-newsletter guards both recipient paths, bulk and --test/--dry-run', () => {
    const src = stripComments(read('scripts/send-newsletter.mjs'));
    const body = (name: string) => {
      const start = src.indexOf(`async function ${name}(`);
      const rest = src.slice(start + 1);
      const next = rest.search(/\n(?:async )?function \w+\(/);
      return next < 0 ? rest : rest.slice(0, next);
    };
    expect(body('fetchSubscribers')).toMatch(CALLS);
    expect(body('fetchSubscribers')).toMatch(/excludedNoBasis/);
    expect(body('fetchTargetSubscriber')).toMatch(CALLS);
  });

  it('no top-level script scans newsletter_subscribers for mail without a declared route', () => {
    const scripts = readdirSync(path.join(ROOT, 'scripts'), { withFileTypes: true })
      .filter((e) => e.isFile() && /\.mjs$/.test(e.name))
      .map((e) => `scripts/${e.name}`)
      .filter((rel) => {
        const src = stripComments(read(rel));
        return /collection\(\s*['"]newsletter_subscribers['"]\s*\)\s*\.get\(\)/.test(src)
          && /sendEmailCascade|sendEmail\s*\(/.test(src);
      });
    // Guards the scan itself: a broken filter would pass vacuously.
    expect(scripts).toEqual(expect.arrayContaining([
      'scripts/send-newsletter.mjs',
      'scripts/send-daily-brief.mjs',
      'scripts/newsletter-winback-campaign.mjs',
      'scripts/blast-publisher-ads.mjs',
    ]));
    const undeclared = scripts.filter((s) => !(s in ROUTES) && !(s in BY_CONSTRUCTION));
    expect(undeclared, 'a sender drawing from newsletter_subscribers must declare how it excludes profile-only rows').toEqual([]);
  });

  it('the predicate has exactly one definition', () => {
    const dirs = ['services', 'scripts', 'scripts/lib', 'functions/src/lib'];
    const definers = dirs.flatMap((dir) =>
      readdirSync(path.join(ROOT, dir), { withFileTypes: true })
        .filter((e) => e.isFile() && /\.(mjs|js|ts)$/.test(e.name))
        .map((e) => `${dir}/${e.name}`)
        .filter((rel) => /function hasSubscriptionBasis/.test(stripComments(read(rel)))),
    );
    expect(definers).toEqual(['functions/src/lib/subscriberConsent.js']);
  });
});
