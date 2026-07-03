import { describe, expect, it } from 'vitest';
import {
  ALERT_ID,
  buildAlertPayload,
  MAX_ALERTS_PER_USER,
  normalizeEmail,
  shouldSkipSubscriber,
} from '../scripts/backfill-jobalerts-from-newsletter.mjs';

describe('backfill-jobalerts-from-newsletter — shouldSkipSubscriber', () => {
  it('is eligible when job_category is present', () => {
    expect(shouldSkipSubscriber('a@b.ch', { job_category: 'tech' })).toBeNull();
  });

  it('is eligible when only job_location is present', () => {
    expect(shouldSkipSubscriber('a@b.ch', { job_location: 'Lugano' })).toBeNull();
  });

  it('skips an invalid/missing email', () => {
    expect(shouldSkipSubscriber('', { job_category: 'tech' })).toBe('invalid-email');
    expect(shouldSkipSubscriber('not-an-email', { job_category: 'tech' })).toBe('invalid-email');
  });

  it('skips a bounced/complained/suppressed/unsubscribed subscriber', () => {
    expect(shouldSkipSubscriber('a@b.ch', { job_category: 'tech', status: 'bounced' })).toBe('suppressed');
    expect(shouldSkipSubscriber('a@b.ch', { job_category: 'tech', status: 'unsubscribed' })).toBe('suppressed');
  });

  it('skips a subscriber with neither job_category nor job_location', () => {
    expect(shouldSkipSubscriber('a@b.ch', { job_slug: 'some-job-abc123' })).toBe('no-signal');
    expect(shouldSkipSubscriber('a@b.ch', {})).toBe('no-signal');
  });
});

describe('backfill-jobalerts-from-newsletter — buildAlertPayload', () => {
  it('builds a near-empty alert that leans on the linked newsletter_subscribers doc for matching', () => {
    const payload = buildAlertPayload(
      'a@b.ch',
      { job_category: 'tech', job_slug: 'dev-abc123', locale: 'it', source_channel: 'job_gate' },
      null,
    );
    expect(payload.keywords).toEqual([]);
    expect(payload.locations).toEqual([]);
    expect(payload.cantonFilter).toBeNull();
    expect(payload.frequency).toBe('daily');
    expect(payload.sourceJobSlug).toBe('dev-abc123');
    expect(payload.active).toBe(true);
    expect(payload.backfilled_from).toBe('newsletter_subscribers:job_gate');
  });

  it('records the actual source_channel in backfilled_from, not just job_gate', () => {
    const payload = buildAlertPayload('a@b.ch', { job_category: 'tech', source_channel: 'auth_google' }, null);
    expect(payload.backfilled_from).toBe('newsletter_subscribers:auth_google');
  });

  it('falls back to "unknown" in backfilled_from when source_channel is missing', () => {
    const payload = buildAlertPayload('a@b.ch', { job_category: 'tech' }, null);
    expect(payload.backfilled_from).toBe('newsletter_subscribers:unknown');
  });

  it('defaults locale to it when the subscriber has none', () => {
    const payload = buildAlertPayload('a@b.ch', { job_category: 'tech' }, null);
    expect(payload.locale).toBe('it');
  });

  it('prefers preferred_locale over locale', () => {
    const payload = buildAlertPayload('a@b.ch', { job_category: 'tech', locale: 'it', preferred_locale: 'de' }, null);
    expect(payload.locale).toBe('de');
  });

  it('is idempotent — preserves matchCount/lastMatchedAt from an existing backfilled alert instead of resetting them', () => {
    const payload = buildAlertPayload(
      'a@b.ch',
      { job_category: 'tech' },
      { matchCount: 7, lastMatchedAt: 'sentinel-timestamp' },
    );
    expect(payload.matchCount).toBe(7);
    expect(payload.lastMatchedAt).toBe('sentinel-timestamp');
  });

  it('starts matchCount/lastMatchedAt fresh when no prior backfill exists', () => {
    const payload = buildAlertPayload('a@b.ch', { job_category: 'tech' }, null);
    expect(payload.matchCount).toBe(0);
    expect(payload.lastMatchedAt).toBeNull();
  });

  it('defaults active to true on first creation', () => {
    const payload = buildAlertPayload('a@b.ch', { job_category: 'tech' }, null);
    expect(payload.active).toBe(true);
  });

  it('never reactivates an alert the user explicitly disabled (deleteAlert sets active:false)', () => {
    const payload = buildAlertPayload('a@b.ch', { job_category: 'tech' }, { active: false, matchCount: 3 });
    expect(payload.active).toBe(false);
  });

  it('keeps active true when the existing backfill doc never set it to false', () => {
    const payload = buildAlertPayload('a@b.ch', { job_category: 'tech' }, { matchCount: 3 });
    expect(payload.active).toBe(true);
  });
});

describe('backfill-jobalerts-from-newsletter — normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  A@B.CH  ')).toBe('a@b.ch');
  });
});

describe('backfill-jobalerts-from-newsletter — constants', () => {
  it('uses a stable, deterministic alert id for idempotent re-runs', () => {
    expect(ALERT_ID).toBe('backfill-newsletter');
  });

  it('matches the client-side active-alerts cap (services/jobAlertService.ts)', () => {
    expect(MAX_ALERTS_PER_USER).toBe(3);
  });
});
