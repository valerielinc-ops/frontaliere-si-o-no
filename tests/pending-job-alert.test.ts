import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  savePendingJobAlert,
  consumePendingJobAlert,
  clearPendingJobAlert,
} from '@/services/pendingJobAlert';
import type { JobAlertConfig } from '@/services/jobAlertService';

const config: JobAlertConfig = {
  keywords: ['infermiere'],
  locations: ['Lugano'],
  contractTypes: [],
  sectors: [],
  cantonFilter: null,
  frequency: 'daily',
  locale: 'it',
};

describe('pendingJobAlert', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips a saved config', () => {
    savePendingJobAlert(config);
    expect(consumePendingJobAlert()).toEqual(config);
  });

  it('consumes once — a second consume returns null', () => {
    savePendingJobAlert(config);
    expect(consumePendingJobAlert()).toEqual(config);
    expect(consumePendingJobAlert()).toBeNull();
  });

  it('returns null when nothing is pending', () => {
    expect(consumePendingJobAlert()).toBeNull();
  });

  it('expires entries older than the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T10:00:00Z'));
    savePendingJobAlert(config);
    // 16 minutes later — past the 15-minute TTL.
    vi.setSystemTime(new Date('2026-06-22T10:16:00Z'));
    expect(consumePendingJobAlert()).toBeNull();
  });

  it('honours a config saved just within the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T10:00:00Z'));
    savePendingJobAlert(config);
    vi.setSystemTime(new Date('2026-06-22T10:14:00Z'));
    expect(consumePendingJobAlert()).toEqual(config);
  });

  it('clear removes a pending entry', () => {
    savePendingJobAlert(config);
    clearPendingJobAlert();
    expect(consumePendingJobAlert()).toBeNull();
  });

  it('returns null on malformed storage', () => {
    localStorage.setItem('pending_job_alert', '{not json');
    expect(consumePendingJobAlert()).toBeNull();
  });

  it('persists in localStorage (survives a new tab / autologin redirect), not sessionStorage', () => {
    // Regression guard for #2730: sessionStorage is per-tab, so a logged-out
    // user who filled the form in tab A and opened the newsletter-autologin
    // email link in tab B lost the intent. localStorage is shared across tabs +
    // persists across reloads, so the replay fires on every sign-in surface.
    savePendingJobAlert(config);
    expect(localStorage.getItem('pending_job_alert')).not.toBeNull();
    expect(sessionStorage.getItem('pending_job_alert')).toBeNull();
    // A fresh page context (new tab / post-redirect reload) reads the same
    // shared localStorage and recovers the config.
    expect(consumePendingJobAlert()).toEqual(config);
  });
});
