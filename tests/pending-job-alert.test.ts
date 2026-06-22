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
    sessionStorage.setItem('pending_job_alert', '{not json');
    expect(consumePendingJobAlert()).toBeNull();
  });
});
