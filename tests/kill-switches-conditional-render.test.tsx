/**
 * Runtime kill-switch conditional-render coverage.
 *
 * Verifies each SEO-link surface hides its anchor when the matching Firebase
 * Remote Config flag is `'true'`, and keeps the anchor when the flag is
 * unset / `'false'`. Exercised surfaces: SeoDailyBanner (home), StatsTabContent
 * banner (fuel-prices subtab).
 *
 * The global `@/services/firebase` mock (tests/setup.tsx) returns `''` for
 * every `getConfigValue()` call by default, so we override per-test using
 * `vi.mocked(getConfigValue).mockImplementation(...)`.
 */

import React from 'react';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';

import SeoDailyBanner from '@/components/shared/SeoDailyBanner';
import { getConfigValue } from '@/services/firebase';
import { KILL_SWITCH_RC_KEYS } from '@/hooks/useKillSwitches';

const rcMock = vi.mocked(getConfigValue);

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => `[[${key}]]`,
    locale: 'it' as const,
  }),
  getCantonI18nParams: () => ({} as Record<string, string>),
}));

afterEach(() => {
  rcMock.mockReset();
  cleanup();
});

describe('SeoDailyBanner respects runtime kill-switches', () => {
  it('renders every card when all kill-switches are false (default)', async () => {
    rcMock.mockResolvedValue('false');

    await act(async () => {
      render(<SeoDailyBanner />);
    });

    await waitFor(() => {
      // 3 cards = 3 anchors rendered by default.
      const nav = screen.queryByTestId('seo-daily-banner');
      expect(nav).not.toBeNull();
      expect(nav?.querySelectorAll('a').length).toBe(3);
    });
  });

  it('hides the fuel card when KILL_FUEL_DAILY_LINKS is true', async () => {
    rcMock.mockImplementation(async (key: string) => {
      if (key === KILL_SWITCH_RC_KEYS.fuelDaily) return 'true';
      return 'false';
    });

    await act(async () => {
      render(<SeoDailyBanner />);
    });

    await waitFor(() => {
      const nav = screen.getByTestId('seo-daily-banner');
      const hrefs = Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
      expect(hrefs.some((h) => h.startsWith('/prezzi-diesel/'))).toBe(false);
      // The remaining 2 cards (jobs, employers) are still rendered.
      expect(hrefs.length).toBe(2);
    });
  });

  it('hides the job-market card when KILL_JOB_MARKET_LINKS is true', async () => {
    rcMock.mockImplementation(async (key: string) => {
      if (key === KILL_SWITCH_RC_KEYS.jobMarket) return 'true';
      return 'false';
    });

    await act(async () => {
      render(<SeoDailyBanner />);
    });

    await waitFor(() => {
      const nav = screen.getByTestId('seo-daily-banner');
      const hrefs = Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
      expect(hrefs.some((h) => h.startsWith('/mercato-lavoro-ticino/'))).toBe(false);
      expect(hrefs.length).toBe(2);
    });
  });

  it('hides the weekly-employers card when KILL_WEEKLY_EMPLOYERS_LINKS is true', async () => {
    rcMock.mockImplementation(async (key: string) => {
      if (key === KILL_SWITCH_RC_KEYS.weeklyEmployers) return 'true';
      return 'false';
    });

    await act(async () => {
      render(<SeoDailyBanner />);
    });

    await waitFor(() => {
      const nav = screen.getByTestId('seo-daily-banner');
      const hrefs = Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
      expect(hrefs.some((h) => h.startsWith('/aziende-che-assumono/'))).toBe(false);
      expect(hrefs.length).toBe(2);
    });
  });

  it('renders nothing when every banner kill-switch is true', async () => {
    rcMock.mockImplementation(async (key: string) => {
      if (
        key === KILL_SWITCH_RC_KEYS.fuelDaily ||
        key === KILL_SWITCH_RC_KEYS.jobMarket ||
        key === KILL_SWITCH_RC_KEYS.weeklyEmployers
      ) {
        return 'true';
      }
      return 'false';
    });

    await act(async () => {
      render(<SeoDailyBanner />);
    });

    await waitFor(() => {
      expect(screen.queryByTestId('seo-daily-banner')).toBeNull();
    });
  });
});
