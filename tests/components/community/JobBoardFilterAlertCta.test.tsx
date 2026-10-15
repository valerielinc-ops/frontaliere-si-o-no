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
import type { JobAlert, JobAlertOneTapFilters, subscribeJobAlertOneTap } from '@/services/jobAlertService';
import type { PendingJobAlertOrigin } from '@/services/pendingJobAlert';
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
  formOrigin?: PendingJobAlertOrigin;
  filters?: JobAlertOneTapFilters;
  onAccepted?: () => void;
}

function renderCta(opts: RenderOpts = {}) {
  const onSubscribed = vi.fn();
  const onAccepted = opts.onAccepted ?? vi.fn();
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
      formOrigin={opts.formOrigin}
      filters={opts.filters}
      onSubscribed={onSubscribed}
      onAccepted={onAccepted}
      onErrored={onErrored}
      subscribe={subscribe}
    />,
  );
  return { onSubscribed, onAccepted, onErrored, subscribe };
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
    const { onSubscribed, onAccepted, onErrored, subscribe } = renderCta({ keywordLabel: 'Tecnologia', cantonCode: 'TI' });
    await act(async () => {
      fireEvent.click(screen.getByText(/Avvisami per questa ricerca/));
    });
    expect(subscribe).toHaveBeenCalledWith(
      'user-1', 'foo@example.com', 'Tecnologia', 'it', undefined, 'TI',
      expect.objectContaining({ source: 'job_alert_filter_cta', sourceComponent: 'JobBoardFilterAlertCta' }),
      undefined,
    );
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onSubscribed).toHaveBeenCalledTimes(1);
    expect(onErrored).not.toHaveBeenCalled();
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
      undefined,
    );
  });

  it('emits one accept before the create promise settles', async () => {
    const timeline: string[] = [];
    let resolveSubscribe!: (alert: JobAlert) => void;
    const onAccepted = vi.fn(() => timeline.push('accept'));
    const subscribe = vi.fn<SubscribeFn>(() => {
      timeline.push('create');
      return new Promise((resolve) => { resolveSubscribe = resolve; });
    });
    const { onSubscribed, onErrored } = renderCta({ subscribe, onAccepted });

    fireEvent.click(screen.getByText(/Avvisami per questa ricerca/));

    expect(timeline).toEqual(['accept', 'create']);
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onSubscribed).not.toHaveBeenCalled();
    expect(onErrored).not.toHaveBeenCalled();

    await act(async () => { resolveSubscribe(baseAlert()); });
    expect(onSubscribed).toHaveBeenCalledTimes(1);
    expect(onErrored).not.toHaveBeenCalled();
  });

  it('passes active board filters through to the one-tap service', async () => {
    const filters = {
      locations: ['lugano'],
      contractTypes: ['part-time'],
      sectors: ['healthcare'],
    };
    const { subscribe } = renderCta({ filters });

    await act(async () => {
      fireEvent.click(screen.getByText(/Avvisami per questa ricerca/));
    });

    expect(subscribe).toHaveBeenCalledWith(
      'user-1', 'foo@example.com', 'Tecnologia', 'it', undefined, 'TI',
      expect.objectContaining({ source: 'job_alert_filter_cta', sourceComponent: 'JobBoardFilterAlertCta' }),
      filters,
    );
  });

  it('transitions to error when subscribe rejects', async () => {
    let subscribeStarted = false;
    const onAccepted = vi.fn(() => expect(subscribeStarted).toBe(false));
    const subscribe = vi.fn<SubscribeFn>(async () => {
      subscribeStarted = true;
      throw new Error('boom');
    });
    const { onAccepted: accepted, onErrored, onSubscribed } = renderCta({ subscribe, onAccepted });
    await act(async () => {
      fireEvent.click(screen.getByText(/Avvisami per questa ricerca/));
    });
    await waitFor(() => {
      expect(screen.getByText(/Non sono riuscito a creare l'alert/)).toBeTruthy();
    });
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(onErrored).toHaveBeenCalledTimes(1);
    expect(onSubscribed).not.toHaveBeenCalled();
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
    const { onAccepted } = renderCta({ context: 'category', userId: null, email: null, subscribe });

    expect(screen.getByRole('button', { name: 'Segui questa categoria' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Segui questa categoria' }));

    expect(subscribe).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(consumeJobAlertOpen()).toEqual({ keyword: 'Tecnologia' });
    expect(dispatchSpy.mock.calls.some(([event]) => {
      return event.type === 'openJobAlert'
        && (event as CustomEvent<{ keyword?: string }>).detail?.keyword === 'Tecnologia';
    })).toBe(true);
  });

  it('preserves the allowlisted board-filter origin for the form handoff', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    renderCta({ context: 'category', userId: null, email: null, formOrigin: 'job_board_filters' });

    fireEvent.click(screen.getByRole('button', { name: 'Segui questa categoria' }));

    expect(consumeJobAlertOpen()).toEqual({ keyword: 'Tecnologia', origin: 'job_board_filters' });
    expect(dispatchSpy.mock.calls.some(([event]) => {
      return event.type === 'openJobAlert'
        && (event as CustomEvent<{ origin?: PendingJobAlertOrigin }>).detail?.origin === 'job_board_filters';
    })).toBe(true);
  });

  it('preserves the diagnostic anonymous-detail origin for the form handoff', () => {
    renderCta({ context: 'category', userId: null, email: null, formOrigin: 'job_detail_anonymous' });

    fireEvent.click(screen.getByRole('button', { name: 'Segui questa categoria' }));

    expect(consumeJobAlertOpen()).toEqual({ keyword: 'Tecnologia', origin: 'job_detail_anonymous' });
  });
});
