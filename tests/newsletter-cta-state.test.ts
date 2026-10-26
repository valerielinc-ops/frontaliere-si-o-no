// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NEWSLETTER_CTA_DISMISSED_KEY,
  NEWSLETTER_SUBSCRIBED_KEY,
  isDismissalActive,
  isNewsletterCtaEligible,
} from '@/services/newsletterCtaState';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-26T12:00:00.000Z');

describe('isNewsletterCtaEligible', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.setSystemTime(NOW);
  });

  it('suppresses the CTA for a valid recent dismissal', () => {
    localStorage.setItem(NEWSLETTER_CTA_DISMISSED_KEY, String(NOW - 2 * DAY_MS));

    expect(isNewsletterCtaEligible()).toBe(false);
  });

  it.each([
    ['numeric prefix with trailing text', `${NOW - DAY_MS}garbage`],
    ['non-numeric value', 'not-a-timestamp'],
    ['future timestamp', String(NOW + DAY_MS)],
  ])('does not suppress the CTA for a %s', (_label, value) => {
    localStorage.setItem(NEWSLETTER_CTA_DISMISSED_KEY, value);

    expect(isNewsletterCtaEligible()).toBe(true);
  });

  it('still gives subscription precedence over dismissal state', () => {
    localStorage.setItem(NEWSLETTER_SUBSCRIBED_KEY, 'true');
    localStorage.setItem(NEWSLETTER_CTA_DISMISSED_KEY, String(NOW - DAY_MS));

    expect(isNewsletterCtaEligible()).toBe(false);
  });

  it('shares the strict cooldown predicate with other promotional surfaces', () => {
    expect(isDismissalActive(String(NOW - 2 * DAY_MS), 7, NOW)).toBe(true);
    expect(isDismissalActive(`${NOW - DAY_MS}garbage`, 7, NOW)).toBe(false);
    expect(isDismissalActive(String(NOW + DAY_MS), 7, NOW)).toBe(false);
    expect(isDismissalActive(new Date(NOW - 2 * DAY_MS).toISOString(), 30, NOW)).toBe(true);
  });
});
