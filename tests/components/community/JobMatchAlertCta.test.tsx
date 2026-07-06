/**
 * UI tests for `components/community/JobMatchAlertCta.tsx` (issue #3650).
 *
 * Verifies:
 *  - idle state renders the localized CTA copy.
 *  - a click calls `subscribe` with the category label, locale, no source,
 *    and the canton code — pre-filling from the job-match profile instead of
 *    asking the user to re-enter filters.
 *  - success / error states and their callbacks.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import JobMatchAlertCta from '@/components/community/JobMatchAlertCta';
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
}

function renderCta(opts: RenderOpts = {}) {
  const onSubscribed = vi.fn();
  const onErrored = vi.fn();
  const subscribe = opts.subscribe ?? vi.fn<SubscribeFn>(async () => baseAlert());
  const cantonCode = 'cantonCode' in opts ? opts.cantonCode : 'TI';
  render(
    <JobMatchAlertCta
      userId="user-1"
      email="foo@example.com"
      locale="it"
      categoryLabel="💻 Tecnologia"
      cantonCode={cantonCode}
      onSubscribed={onSubscribed}
      onErrored={onErrored}
      subscribe={subscribe}
    />,
  );
  return { onSubscribed, onErrored, subscribe };
}

describe('JobMatchAlertCta', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the idle CTA copy', () => {
    renderCta();
    expect(screen.getByText(/Avvisami per ruoli come questo/)).toBeTruthy();
  });

  it('calls subscribe with category, locale, no source, and the canton code', async () => {
    const { onSubscribed, subscribe } = renderCta({ cantonCode: 'TI' });
    await act(async () => {
      fireEvent.click(screen.getByText(/Avvisami per ruoli come questo/));
    });
    expect(subscribe).toHaveBeenCalledWith('user-1', 'foo@example.com', '💻 Tecnologia', 'it', undefined, 'TI');
    expect(onSubscribed).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText(/Alert attivato/)).toBeTruthy();
    });
  });

  it('passes null canton when the profile has no validated canton code', async () => {
    const { subscribe } = renderCta({ cantonCode: null });
    await act(async () => {
      fireEvent.click(screen.getByText(/Avvisami per ruoli come questo/));
    });
    expect(subscribe).toHaveBeenCalledWith('user-1', 'foo@example.com', '💻 Tecnologia', 'it', undefined, null);
  });

  it('transitions to error when subscribe rejects', async () => {
    const subscribe = vi.fn<SubscribeFn>().mockRejectedValueOnce(new Error('boom'));
    const { onErrored } = renderCta({ subscribe });
    await act(async () => {
      fireEvent.click(screen.getByText(/Avvisami per ruoli come questo/));
    });
    await waitFor(() => {
      expect(screen.getByText(/Non sono riuscito a creare l'alert/)).toBeTruthy();
    });
    expect(onErrored).toHaveBeenCalledTimes(1);
  });
});
