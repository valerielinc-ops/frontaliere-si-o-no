/**
 * UI tests for `components/community/JobBoardFilterAlertCta.tsx` (issue #4298).
 *
 * Verifies:
 *  - idle state renders the localized CTA copy.
 *  - a click calls `subscribe` with the board's keyword label, locale, no
 *    source (not tied to one specific job), and the canton code — the same
 *    one-tap contract `JobMatchAlertCta.tsx` already uses.
 *  - success / error states and their callbacks.
 *  - a click is a no-op when there is no keyword label to alert on.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import JobBoardFilterAlertCta from '@/components/community/JobBoardFilterAlertCta';
import type { JobAlert, subscribeJobAlertOneTap } from '@/services/jobAlertService';
import { consumeJobAlertOpen } from '@/services/jobAlertOpenSignal';

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    locale: 'it',
  }),
}));

type SubscribeFn = typeof subscribeJobAlertOneTap;

const baseAlert = (): JobAlert => ({
  id: 'alert-id',
  userId: 'user-1',
  email: 'foo@example.com',
  keywords: ['Tecnologia'],
  locations: [],
  contractTypes: [],
  sectors: [],
  cantonFilter: ['TI'],
  frequency: 'weekly',
  locale: 'it',
  active: true,
  createdAt: new Date(),
  lastMatchedAt: null,
  matchCount: 0,
});

interface RenderOpts {
  subscribe?: SubscribeFn;
  cantonCode?: string | null;
  keywordLabel?: string;
  context?: 'category' | 'sector' | 'search';
  userId?: string | null;
  email?: string | null;
}

function renderCta(opts: RenderOpts = {}) {
  const onSubscribed = vi.fn();
  const onErrored = vi.fn();
  const subscribe = opts.subscribe ?? vi.fn<SubscribeFn>(async () => baseAlert());
  const cantonCode = 'cantonCode' in opts ? opts.cantonCode : 'TI';
  const keywordLabel = opts.keywordLabel ?? 'Tecnologia';
  render(
    <JobBoardFilterAlertCta
      userId={'userId' in opts ? opts.userId : 'user-1'}
      email={'email' in opts ? opts.email : 'foo@example.com'}
      locale="it"
      context={opts.context}
      keywordLabel={keywordLabel}
      cantonCode={cantonCode}
      onSubscribed={onSubscribed}
      onErrored={onErrored}
      subscribe={subscribe}
    />,
  );
  return { onSubscribed, onErrored, subscribe };
}

describe('JobBoardFilterAlertCta', () => {
  afterEach(() => {
    cleanup();
    consumeJobAlertOpen();
    vi.restoreAllMocks();
  });

  it('renders the idle CTA copy', () => {
    renderCta();
    expect(screen.getByText(/Avvisami per questa ricerca/)).toBeTruthy();
  });

  it('calls subscribe with the keyword label, locale, canton code, and attribution metadata', async () => {
    const { onSubscribed, subscribe } = renderCta({ keywordLabel: 'Tecnologia', cantonCode: 'TI' });
    await act(async () => {
      fireEvent.click(screen.getByText(/Avvisami per questa ricerca/));
    });
    expect(subscribe).toHaveBeenCalledWith(
      'user-1', 'foo@example.com', 'Tecnologia', 'it', undefined, 'TI',
      expect.objectContaining({ source: 'job_alert_filter_cta', sourceComponent: 'JobBoardFilterAlertCta' }),
    );
    expect(onSubscribed).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText(/Alert attivato/)).toBeTruthy();
    });
  });

  it('passes null canton when the board has no canton scope (aggregate view)', async () => {
    const { subscribe } = renderCta({ cantonCode: null });
    await act(async () => {
      fireEvent.click(screen.getByText(/Avvisami per questa ricerca/));
    });
    expect(subscribe).toHaveBeenCalledWith(
      'user-1', 'foo@example.com', 'Tecnologia', 'it', undefined, null,
      expect.objectContaining({ source: 'job_alert_filter_cta', sourceComponent: 'JobBoardFilterAlertCta' }),
    );
  });

  it('transitions to error when subscribe rejects', async () => {
    const subscribe = vi.fn<SubscribeFn>().mockRejectedValueOnce(new Error('boom'));
    const { onErrored } = renderCta({ subscribe });
    await act(async () => {
      fireEvent.click(screen.getByText(/Avvisami per questa ricerca/));
    });
    await waitFor(() => {
      expect(screen.getByText(/Non sono riuscito a creare l'alert/)).toBeTruthy();
    });
    expect(onErrored).toHaveBeenCalledTimes(1);
  });

  it('does not call subscribe when there is no keyword label', async () => {
    const { subscribe } = renderCta({ keywordLabel: '' });
    await act(async () => {
      fireEvent.click(screen.getByText(/Avvisami per questa ricerca/));
    });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('uses explicit category copy and hands anonymous taps to the existing form flow', () => {
    const subscribe = vi.fn<SubscribeFn>();
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    renderCta({ context: 'category', userId: null, email: null, subscribe });

    expect(screen.getByRole('button', { name: 'Segui questa categoria' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Segui questa categoria' }));

    expect(subscribe).not.toHaveBeenCalled();
    expect(consumeJobAlertOpen()).toEqual({ keyword: 'Tecnologia' });
    expect(dispatchSpy.mock.calls.some(([event]) => {
      return event.type === 'openJobAlert'
        && (event as CustomEvent<{ keyword?: string }>).detail?.keyword === 'Tecnologia';
    })).toBe(true);
  });
});
