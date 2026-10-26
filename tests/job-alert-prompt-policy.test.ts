// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DISMISSED_KEY, canShowJobAlertPrompt } from '@/services/jobAlertPromptPolicy';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-26T12:00:00.000Z');

describe('canShowJobAlertPrompt', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.setSystemTime(NOW);
  });

  it('stores the parsed millisecond value for an ISO dismissal', () => {
    localStorage.setItem(DISMISSED_KEY, new Date(NOW - DAY_MS).toISOString());

    expect(canShowJobAlertPrompt(NOW)).toBe(false);
    expect(canShowJobAlertPrompt(NOW + 8 * DAY_MS)).toBe(true);
  });
});
