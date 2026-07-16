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
}

function renderCta(opts: RenderOpts = {}) {
  const onSubscribed = vi.fn();
  const onErrored = vi.fn();
  const subscribe = opts.subscribe ?? vi.fn<SubscribeFn>(async () => baseAlert());
  const cantonCode = 'cantonCode' in opts ? opts.cantonCode : 'TI';
  const keywordLabel = opts.keywordLabel ?? 'Tecnologia';
  render(
    <JobBoardFilterAlertCta
      userId="user-1"
      email="foo@example.com"
      locale="it"
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
  });

  it('renders the idle CTA copy', () => {
    renderCta();
    expect(screen.getByText(/Avvisami per questa ricerca/)).toBeTruthy();
  });

  it('calls subscribe with the keyword label, locale, no source, and the canton code', async () => {
    const { onSubscribed, subscribe } = renderCta({ keywordLabel: 'Tecnologia', cantonCode: 'TI' });
    await act(async () => {
      fireEvent.click(screen.getByText(/Avvisami per questa ricerca/));
    });
    expect(subscribe).toHaveBeenCalledWith('user-1', 'foo@example.com', 'Tecnologia', 'it', undefined, 'TI');
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
    expect(subscribe).toHaveBeenCalledWith('user-1', 'foo@example.com', 'Tecnologia', 'it', undefined, null);
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
});
