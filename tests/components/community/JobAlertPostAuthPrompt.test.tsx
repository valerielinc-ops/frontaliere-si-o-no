/**
 * UI tests for `components/community/JobAlertPostAuthPrompt.tsx`.
 *
 * Verifies the four states (idle / submitting / success / error), the
 * one-click save flow (no intermediate form), and the "Personalizza"
 * link that opens the form prefilled with the saved keyword.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import JobAlertPostAuthPrompt from '@/components/community/JobAlertPostAuthPrompt';
import type { JobAlert } from '@/services/jobAlertService';

const baseAlert = (): JobAlert => ({
  id: 'alert-id',
  userId: 'user-1',
  email: 'foo@example.com',
  keywords: ['infermiere lugano'],
  locations: [],
  contractTypes: [],
  sectors: [],
  frequency: 'weekly',
  locale: 'it',
  active: true,
  createdAt: new Date(),
  lastMatchedAt: null,
  matchCount: 0,
});

interface RenderOpts {
  subscribe?: () => Promise<JobAlert>;
}

function renderPrompt(opts: RenderOpts = {}) {
  const onClose = vi.fn();
  const onAccepted = vi.fn();
  const onDismissed = vi.fn();
  const onErrored = vi.fn();
  const onPersonalize = vi.fn();
  const subscribe = opts.subscribe ?? (async () => baseAlert());
  render(
    <JobAlertPostAuthPrompt
      keyword="infermiere lugano"
      userId="user-1"
      email="foo@example.com"
      locale="it"
      onClose={onClose}
      onAccepted={onAccepted}
      onDismissed={onDismissed}
      onErrored={onErrored}
      onPersonalize={onPersonalize}
      subscribe={subscribe}
    />,
  );
  return { onClose, onAccepted, onDismissed, onErrored, onPersonalize };
}

describe('JobAlertPostAuthPrompt', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders the idle state with substituted keyword copy', () => {
    renderPrompt();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('infermiere lugano');
    expect(screen.getByText(/Crea alert/)).toBeTruthy();
    expect(screen.getByText(/Non ora/)).toBeTruthy();
  });

  it('calls onDismissed and onClose when "Non ora" is clicked', () => {
    const { onDismissed, onClose } = renderPrompt();
    fireEvent.click(screen.getByText(/Non ora/));
    expect(onDismissed).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('treats the ✕ button as dismiss in idle state', () => {
    const { onDismissed, onClose } = renderPrompt();
    fireEvent.click(screen.getByLabelText(/Chiudi|Close/));
    expect(onDismissed).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking "Crea alert" saves directly without opening any form, then shows the success state', async () => {
    const subscribe = vi.fn<() => Promise<JobAlert>>().mockResolvedValueOnce(baseAlert());
    const { onAccepted, onPersonalize } = renderPrompt({ subscribe });

    await act(async () => {
      fireEvent.click(screen.getByText(/Crea alert/));
    });

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(onAccepted).toHaveBeenCalledTimes(1);
    // onPersonalize is NOT called by the primary click — the form does
    // not open on accept; it only opens if the user clicks "Personalizza".
    expect(onPersonalize).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText(/Alert attivato/)).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: /Personalizza/ })).toBeTruthy();
  });

  it('passes the resolved keyword as the alert keyword (not the user-typed query)', async () => {
    const subscribe = vi.fn<() => Promise<JobAlert>>().mockResolvedValueOnce(baseAlert());
    renderPrompt({ subscribe });
    await act(async () => {
      fireEvent.click(screen.getByText(/Crea alert/));
    });
    expect(subscribe).toHaveBeenCalledWith('user-1', 'foo@example.com', 'infermiere lugano', 'it');
  });

  it('transitions to error when subscribe rejects, and offers retry', async () => {
    const subscribe = vi
      .fn<() => Promise<JobAlert>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(baseAlert());
    const { onAccepted, onErrored } = renderPrompt({ subscribe });

    await act(async () => {
      fireEvent.click(screen.getByText(/Crea alert/));
    });
    await waitFor(() => {
      expect(screen.getByText(/Errore/)).toBeTruthy();
    });
    expect(onErrored).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Riprova/ }));
    });
    await waitFor(() => {
      expect(onAccepted).toHaveBeenCalledTimes(1);
    });
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('auto-dismisses after the success state timeout', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    const { onClose } = renderPrompt({ subscribe: async () => baseAlert() });
    await act(async () => {
      fireEvent.click(screen.getByText(/Crea alert/));
    });
    await waitFor(() => {
      expect(screen.getByText(/Alert attivato/)).toBeTruthy();
    });
    expect(onClose).not.toHaveBeenCalled();

    const successCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 4000);
    expect(successCall).toBeTruthy();
    const cb = successCall![0] as () => void;
    act(() => cb());
    expect(onClose).toHaveBeenCalledTimes(1);

    setTimeoutSpy.mockRestore();
  });

  it('clicking "Personalizza" calls onPersonalize and onClose', async () => {
    const { onPersonalize, onClose } = renderPrompt({ subscribe: async () => baseAlert() });
    await act(async () => {
      fireEvent.click(screen.getByText(/Crea alert/));
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Personalizza/ })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Personalizza/ }));
    expect(onPersonalize).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('exposes accessible dialog metadata', () => {
    renderPrompt();
    const dialog = screen.getByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    if (labelledBy) {
      const heading = document.getElementById(labelledBy);
      expect(heading).toBeTruthy();
      expect(heading?.tagName).toBe('H3');
    }
    expect(screen.getByLabelText(/Chiudi|Close/)).toBeTruthy();
  });
});
