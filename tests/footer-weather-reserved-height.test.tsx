// @vitest-environment jsdom
/**
 * Footer weather strip reserves the same height empty and loaded (CLS tracker
 * 20414, 103 GA4 events 17-23/11). It used to render an empty <div/> until the
 * weather arrived, then a `flex flex-wrap` strip that pushed the footer down.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

import FooterWeather, { FOOTER_WEATHER_RESERVE_CLASS } from '@/components/shared/FooterWeather';
import { userLocationCacheKey, userWeatherCacheKey } from '@/services/userProfileStorage';

const weather = vi.hoisted(() => ({ result: null as null | { temperature: number; weatherCode: number; isDay: boolean } }));

vi.mock('@/services/i18n', () => ({ useTranslation: () => ({ t: (k: string) => k, locale: 'it' }) }));
vi.mock('@/services/authService', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/services/weatherService', () => ({ fetchRuntimeWeather: async () => weather.result }));

const FRESH = { temperature: 12, weatherCode: 0, isDay: true };

function seed(key: string, data: unknown): void {
  localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
}

function minHeights(cls: string): Record<string, number> {
  return Object.fromEntries(
    cls.split(/\s+/).filter((c) => c.includes('min-h-[')).map((c) => {
      const m = c.match(/^(?:min-\[(\d+)px\]:)?min-h-\[(\d+)px\]$/);
      return [m?.[1] ?? 'base', Number(m?.[2])];
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  weather.result = null;
});
afterEach(cleanup);

describe('FooterWeather reserved height', () => {
  it('reserves two pill rows below 480px and one row from 480px', () => {
    const h = minHeights(FOOTER_WEATHER_RESERVE_CLASS);
    expect(h.base).toBe(32 + 8 + 32); // third (user) pill wraps on narrow viewports
    expect(h['480']).toBe(36); // one row, same box as the SkeletonFooterSlot fallback
  });

  it('empty state (no data yet) already carries the reservation', () => {
    const { container } = render(<FooterWeather />);
    expect((container.firstElementChild as HTMLElement).className).toContain(FOOTER_WEATHER_RESERVE_CLASS);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('loaded with Lugano + Como keeps the same reservation', async () => {
    seed(userWeatherCacheKey(null), {
      lugano: { current: { temperature: 10, weatherCode: 0, isDay: true } },
      como: { current: { temperature: 11, weatherCode: 3, isDay: true } },
    });
    const { container } = render(<FooterWeather />);
    await waitFor(() => expect(container.querySelectorAll('button')).toHaveLength(2));
    expect((container.firstElementChild as HTMLElement).className).toContain(FOOTER_WEATHER_RESERVE_CLASS);
  });

  it('loaded with the visitor city as a third pill keeps the same reservation', async () => {
    weather.result = FRESH;
    seed(userLocationCacheKey(null), { lat: 47.37, lng: 8.54, city: 'Zurigo' });
    const { container } = render(<FooterWeather />);
    await waitFor(() => expect(container.querySelectorAll('button')).toHaveLength(3));
    expect((container.firstElementChild as HTMLElement).className).toContain(FOOTER_WEATHER_RESERVE_CLASS);
  });
});
