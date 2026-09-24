// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  savePendingSalaryAlert,
  consumePendingSalaryAlert,
  clearPendingSalaryAlert,
} from '@/services/pendingSalaryAlert';
import type { JobAlertConfig } from '@/services/jobAlertService';

const config: JobAlertConfig = {
  keywords: [],
  locations: [],
  contractTypes: [],
  sectors: [],
  cantonFilter: ['TI'],
  frequency: 'weekly',
  locale: 'it',
  minNetMonthlyCHF: 4300,
};

describe('pendingSalaryAlert', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips and consumes the calculator-specific intent once', () => {
    expect(savePendingSalaryAlert(config)).toEqual({ ok: true });
    expect(consumePendingSalaryAlert()).toEqual(config);
    expect(consumePendingSalaryAlert()).toBeNull();
  });

  it('reports when browser storage rejects the calculator intent', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    expect(savePendingSalaryAlert(config)).toEqual({
      ok: false,
      reason: 'storage_unavailable',
    });
    expect(consumePendingSalaryAlert()).toBeNull();
  });

  it('uses its own key and does not touch the generic job-alert intent', () => {
    savePendingSalaryAlert(config);
    expect(localStorage.getItem('pending_salary_alert')).not.toBeNull();
    expect(localStorage.getItem('pending_job_alert')).toBeNull();
  });

  it('expires after the shared 15-minute intent TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T10:00:00Z'));
    savePendingSalaryAlert(config);
    vi.setSystemTime(new Date('2026-06-22T10:16:00Z'));
    expect(consumePendingSalaryAlert()).toBeNull();
  });

  it('can be cleared without consuming another intent', () => {
    savePendingSalaryAlert(config);
    clearPendingSalaryAlert();
    expect(consumePendingSalaryAlert()).toBeNull();
  });
});
