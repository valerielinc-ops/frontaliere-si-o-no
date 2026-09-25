/**
 * onboardingDrip — post-signup drip sequence (#4451).
 *
 * Guards:
 *  - 4 touches at day 0/3/7/14;
 *  - segment-aware ordering (jobs-arrivals get the calculator first, everyone
 *    else gets the job alert first);
 *  - due-step math never double-sends and stops when complete;
 *  - every email is locale-correct, trailing-slashed, carries the revenue block
 *    + an unsubscribe link, and never AdSense.
 */
import { describe, expect, it } from 'vitest';
import {
  DRIP_GAP_DAYS,
  DRIP_STEP_COUNT,
  resolveDripCards,
  resolveDripSegment,
  computeNextStep,
  buildDripEmail,
} from '../services/newsletter/onboardingDrip.mjs';

const DAY = 86400000;

describe('drip sequence shape', () => {
  it('has 4 touches at day 0/3/7/14', () => {
    expect(DRIP_STEP_COUNT).toBe(4);
    expect(DRIP_GAP_DAYS).toEqual([0, 3, 7, 14]);
  });

  it('orders the middle by segment', () => {
    // arrived from jobs → calculator first, job alert second
    expect(resolveDripCards('jobs')).toEqual(['guide', 'calculator', 'jobalert', 'comparators']);
    // arrived from the calculator/comparators (utility) → job alert first
    expect(resolveDripCards('utility')).toEqual(['guide', 'jobalert', 'calculator', 'comparators']);
    // unknown/general default to jobs first
    expect(resolveDripCards(null)).toEqual(['guide', 'jobalert', 'calculator', 'comparators']);
  });

  it('labels the segment', () => {
    expect(resolveDripSegment('jobs')).toBe('jobs-first');
    expect(resolveDripSegment('utility')).toBe('utility-first');
    expect(resolveDripSegment(null)).toBe('utility-first');
  });
});

describe('computeNextStep (no double sends, stops when complete)', () => {
  const started = Date.UTC(2026, 0, 1);

  it('sends step 0 immediately on enrollment', () => {
    expect(computeNextStep({ startedAtMs: started, lastStep: -1, nowMs: started })).toBe(0);
  });

  it('does not send step 1 before day 3', () => {
    expect(computeNextStep({ startedAtMs: started, lastStep: 0, nowMs: started + 2 * DAY })).toBeNull();
    expect(computeNextStep({ startedAtMs: started, lastStep: 0, nowMs: started + 3 * DAY })).toBe(1);
  });

  it('respects the day-7 and day-14 gaps', () => {
    expect(computeNextStep({ startedAtMs: started, lastStep: 1, nowMs: started + 6 * DAY })).toBeNull();
    expect(computeNextStep({ startedAtMs: started, lastStep: 1, nowMs: started + 7 * DAY })).toBe(2);
    expect(computeNextStep({ startedAtMs: started, lastStep: 2, nowMs: started + 13 * DAY })).toBeNull();
    expect(computeNextStep({ startedAtMs: started, lastStep: 2, nowMs: started + 14 * DAY })).toBe(3);
  });

  it('returns null once the sequence is complete', () => {
    expect(computeNextStep({ startedAtMs: started, lastStep: 3, nowMs: started + 100 * DAY })).toBeNull();
  });
});

describe('buildDripEmail', () => {
  it('builds a valid, unsubscribe-bearing, monetized email for every step', () => {
    for (let step = 0; step < DRIP_STEP_COUNT; step++) {
      const { subject, html, cardId } = buildDripEmail({
        step,
        locale: 'it',
        interest: 'utility',
        acquisitionSource: 'weather-hub',
        unsubscribeUrl: 'https://frontaliereticino.ch/?action=unsubscribe&email=a@b.com',
      });
      expect(subject).toBeTruthy();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('action=unsubscribe');
      expect(cardId).toBeTruthy();
      // revenue block present (routes through /go/ or a sponsor link)
      expect(html).toContain('Consigliato per te');
      expect(html).toContain('/go/');
      // never AdSense in email
      expect(html).not.toMatch(/adsbygoogle|googlesyndication|adsense/i);
    }
  });

  it('uses locale-correct copy and localized, trailing-slashed CTA URLs', () => {
    const en = buildDripEmail({ step: 0, locale: 'en', interest: null, unsubscribeUrl: 'https://frontaliereticino.ch/?action=unsubscribe' });
    expect(en.html).toContain('start');
    expect(en.html).not.toContain('Calcola il tuo netto'); // IT copy must not leak
    // day-3 job-alert card for an EN utility subscriber → /en/find-jobs-switzerland/
    const enJobs = buildDripEmail({ step: 1, locale: 'en', interest: 'utility', unsubscribeUrl: 'https://frontaliereticino.ch/?action=unsubscribe' });
    expect(enJobs.cardId).toBe('jobalert');
    expect(enJobs.html).toMatch(/href="https:\/\/frontaliereticino\.ch\/en\/find-jobs-switzerland\/"/);
  });

  it('swaps the day-3 card for a jobs-arrival subscriber', () => {
    const jobsArrival = buildDripEmail({ step: 1, locale: 'it', interest: 'jobs', unsubscribeUrl: 'https://frontaliereticino.ch/?action=unsubscribe' });
    expect(jobsArrival.cardId).toBe('calculator');
  });
});
