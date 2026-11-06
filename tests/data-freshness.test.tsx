import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import DataFreshness from '../components/shared/DataFreshness';
import { sourceDateIso, formatSourceDate, borderReadingState } from '../services/dataFreshness';

const state = vi.hoisted(() => ({ locale: 'it' }));
vi.mock('../services/i18n', () => ({ useTranslation: () => ({ locale: state.locale, t: (key: string) => key }) }));
afterEach(cleanup);
const now = new Date();
const daysAgo = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();

describe('data source dates', () => {
  it('rejects missing, invalid, impossible and future observations', () => {
    for (const value of [undefined, null, '', 'unknown', `${now.getUTCFullYear() - 1}-02-30`, daysAgo(-1)]) {
      expect(sourceDateIso(value, now)).toBeUndefined();
    }
  });
  it('distinguishes expired observations from unavailable dates', () => {
    expect(borderReadingState(daysAgo(1), now)).toBe('stale');
    expect(borderReadingState(daysAgo(0), now)).toBe('live');
    expect(borderReadingState(undefined, now)).toBe('unavailable');
  });
  it('accepts source timestamps with an explicit time-zone offset', () => {
    const day = daysAgo(2).slice(0, 10);
    expect(sourceDateIso(`${day}T00:30:00+02:00`, now)).toBe(new Date(`${day}T00:30:00+02:00`).toISOString());
  });
  it.each(['it', 'en', 'de', 'fr'])('formats dates for %s without inventing a day for a month-only date', (locale) => {
    state.locale = locale;
    const timestamp = daysAgo(3);
    const { container } = render(<DataFreshness lastUpdated={timestamp} dateKind="fetched" referenceYear={now.getUTCFullYear() - 1} source="Priminfo" sourceUrl="https://www.priminfo.admin.ch/" />);
    expect(container.querySelector('time')?.getAttribute('datetime')).toBe(timestamp);
    expect(container.textContent).toContain(formatSourceDate(timestamp, locale));
    expect(container.textContent).toContain('dataFreshness.fetched');
    expect(container.textContent).toContain('dataFreshness.outdatedYear');
    const month = timestamp.slice(0, 7);
    expect(formatSourceDate(month, locale)).toBe(new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(month)));
  });
  it('shows undocumented review instead of a hard-coded update date', () => {
    const { container } = render(<DataFreshness dateKind="reviewed" />);
    expect(container.textContent).toContain('dataFreshness.reviewed: dataFreshness.missing');
    expect(container.querySelector('time')).toBeNull();
  });
});
