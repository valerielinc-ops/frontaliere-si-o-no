import { describe, expect, it, beforeEach, vi } from 'vitest';

const { getDocMock, setDocMock } = vi.hoisted(() => ({
 getDocMock: vi.fn(),
 setDocMock: vi.fn(async () => undefined),
}));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})),
  doc: vi.fn(() => ({})),
  getDoc: getDocMock,
  setDoc: setDocMock,
  addDoc: vi.fn(async () => ({ id: 'event-1' })),
  increment: vi.fn((value: number) => ({ __increment: value })),
  serverTimestamp: vi.fn(() => '__server_timestamp__'),
  deleteField: vi.fn(() => '__delete_field__'),
}));

import {
 calculateEngagementScore,
 checkSubscriptionRateLimit,
 recordSubscriptionAttempt,
 upsertNewsletterSubscriber,
} from '@/services/newsletterSubscribers';

describe('calculateEngagementScore (FRO-17)', () => {
  it('returns hot for high open+click rates with recent activity', () => {
    const result = calculateEngagementScore({
      send_count: 10,
      open_count: 9,
      click_count: 5,
      last_click_at: new Date().toISOString(),
    });
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.level).toBe('hot');
  });

  it('returns warm for moderate engagement', () => {
    const result = calculateEngagementScore({
      send_count: 20,
      open_count: 6,
      click_count: 1,
      last_open_at: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(result.score).toBeGreaterThanOrEqual(30);
    expect(result.score).toBeLessThan(70);
    expect(['warm', 'cool']).toContain(result.level);
  });

  it('returns dormant for zero engagement', () => {
    const result = calculateEngagementScore({
      send_count: 20,
      open_count: 0,
      click_count: 0,
    });
    expect(result.score).toBe(0);
    expect(result.level).toBe('dormant');
  });

  it('returns cold for old engagement', () => {
    const result = calculateEngagementScore({
      send_count: 10,
      open_count: 2,
      click_count: 0,
      last_open_at: new Date(Date.now() - 70 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(result.level).toBe('cold');
  });

  it('handles missing data gracefully', () => {
    const result = calculateEngagementScore({});
    expect(result.score).toBe(0);
    expect(result.level).toBe('dormant');
  });

  it('caps score at 100', () => {
    const result = calculateEngagementScore({
      send_count: 1,
      open_count: 1,
      click_count: 1,
      last_click_at: new Date().toISOString(),
    });
    expect(result.score).toBeLessThanOrEqual(100);
  });

  // #5767 — same anti-pattern the job-alert channel had: an opt-out click
  // must never read as engagement.
  it('does not let a fresh opt-out click buy recency or click-rate points', () => {
    const withOptOut = calculateEngagementScore({
      send_count: 20,
      open_count: 0,
      click_count: 1,
      last_click_at: new Date().toISOString(),
      last_clicked_url: 'https://frontaliereticino.ch/disiscriviti/?id=abc',
    });
    expect(withOptOut.score).toBe(0);
    expect(withOptOut.level).toBe('dormant');
  });

  it('falls back to last_open_at recency when the last click was opt-out', () => {
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const result = calculateEngagementScore({
      send_count: 10,
      open_count: 1,
      click_count: 1,
      last_open_at: past,
      last_click_at: new Date().toISOString(),
      last_clicked_url: 'https://frontaliereticino.ch/disiscriviti/',
    });
    // openScore 8 (1/10 open rate) + recency 30, no click contribution.
    expect(result.score).toBe(38);
    expect(result.level).toBe('cool');
  });

  it('recognizes the alert-suffix and unsubscribe_all opt-out forms too', () => {
    const alertSuffix = calculateEngagementScore({
      send_count: 10,
      open_count: 5,
      click_count: 3,
      last_click_at: new Date().toISOString(),
      last_clicked_url: '/disiscrivi-alert/?id=x',
    });
    const unsubAll = calculateEngagementScore({
      send_count: 10,
      open_count: 5,
      click_count: 3,
      last_click_at: new Date().toISOString(),
      last_clicked_url: '/preferenze/?action=unsubscribe_all',
    });
    const genuine = calculateEngagementScore({
      send_count: 10,
      open_count: 5,
      click_count: 3,
      last_click_at: new Date().toISOString(),
      last_clicked_url: '/lavoro/qualche-annuncio/',
    });
    expect(alertSuffix.score).toBeLessThan(genuine.score);
    expect(unsubAll.score).toBeLessThan(genuine.score);
  });

  it('a genuine click still counts as engagement', () => {
    const result = calculateEngagementScore({
      send_count: 10,
      open_count: 0,
      click_count: 1,
      last_click_at: new Date().toISOString(),
      last_clicked_url: '/lavoro/qualche-annuncio/',
    });
    expect(result.score).toBeGreaterThan(0);
    expect(result.level).not.toBe('dormant');
  });
});

describe('checkSubscriptionRateLimit (FRO-19)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('allows first attempt', () => {
    const result = checkSubscriptionRateLimit();
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });

  it('allows up to 3 attempts', () => {
    recordSubscriptionAttempt();
    recordSubscriptionAttempt();
    const result = checkSubscriptionRateLimit();
    expect(result.allowed).toBe(true);
  });

  it('blocks after 3 rapid attempts', () => {
    recordSubscriptionAttempt();
    recordSubscriptionAttempt();
    recordSubscriptionAttempt();
    const result = checkSubscriptionRateLimit();
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('resets after the time window expires', () => {
    // Manually set expired state
    window.sessionStorage.setItem(
      'newsletter_rate_limit',
      JSON.stringify({ attempts: 5, windowStart: Date.now() - 60_000 }),
    );
    const result = checkSubscriptionRateLimit();
    expect(result.allowed).toBe(true);
 });
});

describe('explicit subscription actions and FRO-19', () => {
 beforeEach(() => {
  window.sessionStorage.clear();
  getDocMock.mockReset();
  setDocMock.mockClear();
 });

 it('does not block an explicit authenticated action after the session bucket is full', async () => {
  getDocMock.mockResolvedValue({
   exists: () => true,
   data: () => ({
    email: 'owner@example.com',
    status: 'confirmed',
    isActive: true,
    active: true,
    registration_terms_accepted: true,
    consent_text: 'Comunicazioni di Frontaliere Ticino',
    consent_text_displayed: true,
    consent_act: 'email_submit',
    consent_method: 'email_submit',
    confirmed_at: '2026-09-25T12:00:00.000Z',
   }),
  });
  recordSubscriptionAttempt();
  recordSubscriptionAttempt();
  recordSubscriptionAttempt();

  const result = await upsertNewsletterSubscriber({} as any, {
   email: 'owner@example.com',
   userId: 'user-1',
   registrationMethod: 'authenticated',
   source: 'company_follow',
   sourceChannel: 'company_follow_unified',
   explicitConsentAction: true,
   locale: 'it',
  });

  expect(result.status).toBe('confirmed');
  expect(setDocMock).toHaveBeenCalled();
 });

 it('keeps blocking an implicit capture after the session bucket is full', async () => {
  recordSubscriptionAttempt();
  recordSubscriptionAttempt();
  recordSubscriptionAttempt();

  await expect(upsertNewsletterSubscriber({} as any, {
   email: 'background@example.com',
   source: 'session_restore',
  })).rejects.toThrow('Rate limited');
  expect(getDocMock).not.toHaveBeenCalled();
 });
});
