import { describe, expect, it } from 'vitest';
import {
  ALERT_ID,
  buildAlertPayload,
  getSignalTier,
  MAX_ALERTS_PER_USER,
  normalizeEmail,
  resolveSignalTier,
  shouldSkipSubscriber,
} from '../scripts/backfill-jobalerts-from-newsletter.mjs';

describe('backfill-jobalerts-from-newsletter — getSignalTier stays URL-blind', () => {
  // main()'s lazy `private/personalization` fetch is gated on
  // `getSignalTier(data) === 'none'`, NOT on `shouldSkipSubscriber`/
  // `resolveSignalTier` — those also resolve the URL-derived tier 4 from
  // the same flat data, and tier 4 finding a canton must never skip the
  // read: a subscriber landing on a job-board page may ALSO have richer
  // tier-3 browsing data (job_category/sector, not just canton), which
  // resolveSignalTier is supposed to prefer over tier 4 — but only gets
  // the chance to if the caller actually fetches personalization first.
  it('is "none" for a subscriber whose only signal is a job-board consent URL', () => {
    expect(getSignalTier({ consent_source_url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/some-job/' })).toBe(
      'none',
    );
  });
});

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

  it('is eligible via the location-fallback tier when only location_interest is present', () => {
    expect(shouldSkipSubscriber('a@b.ch', { location_interest: 'Lugano' })).toBeNull();
  });

  it('is eligible via the location-fallback tier when only geo_city is present', () => {
    expect(shouldSkipSubscriber('a@b.ch', { geo_city: 'Bellinzona' })).toBeNull();
  });

  it('stays no-signal when no personalization arg is passed, even with a viewedJobs-worthy history (flat-field callers unaffected)', () => {
    expect(shouldSkipSubscriber('a@b.ch', {})).toBe('no-signal');
  });

  it('is eligible via the personalization-fallback tier when browsing data has real signal', () => {
    expect(
      shouldSkipSubscriber('a@b.ch', {}, { viewedJobs: [{ location: 'Mendrisio', category: 'IT / Tecnologia' }] }),
    ).toBeNull();
  });

  it('stays no-signal when personalization has nothing usable either', () => {
    expect(shouldSkipSubscriber('a@b.ch', {}, { viewedJobs: [], filterUsage: {} })).toBe('no-signal');
  });
});

describe('backfill-jobalerts-from-newsletter — resolveSignalTier tier-3', () => {
  it('derives personalization-fallback from browsing data when flat fields are empty', () => {
    const result = resolveSignalTier({}, { viewedJobs: [{ location: 'Mendrisio', category: 'IT / Tecnologia' }] });
    expect(result.tier).toBe('personalization-fallback');
    expect(result.patch).toMatchObject({ location_interest: 'Mendrisio', job_category: 'IT / Tecnologia' });
  });

  it('never consults personalization when a flat-field tier already resolves (patch stays null)', () => {
    const result = resolveSignalTier({ job_category: 'tech' }, { viewedJobs: [{ location: 'Lugano' }] });
    expect(result).toEqual({ tier: 'signal', patch: null });
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

  it('tags backfilled_from with :location-fallback when built from the location-only tier', () => {
    const payload = buildAlertPayload('a@b.ch', { location_interest: 'Lugano', source_channel: 'popup' }, null);
    expect(payload.backfilled_from).toBe('newsletter_subscribers:popup:location-fallback');
    expect(payload.cantonFilter).toBeNull();
    expect(payload.keywords).toEqual([]);
  });

  it('tags backfilled_from with :personalization-fallback when built from browsing data', () => {
    const payload = buildAlertPayload(
      'a@b.ch',
      { source_channel: 'popup' },
      null,
      { viewedJobs: [{ location: 'Mendrisio', category: 'IT / Tecnologia' }] },
    );
    expect(payload.backfilled_from).toBe('newsletter_subscribers:popup:personalization-fallback');
    expect(payload.cantonFilter).toBeNull();
    expect(payload.keywords).toEqual([]);
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
