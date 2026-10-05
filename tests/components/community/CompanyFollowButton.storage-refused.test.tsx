/**
 * Issue 9575 (PR 9731 review): when storage refuses to park the anonymous
 * company follow, the confirmation link will replay nothing. The parent's
 * `onOptInRequested` is its "accept" signal (email flow continues, funnel
 * counts an accept), so it must fire only after a successful park; a refused
 * park surfaces as an error instead.
 *
 * Since 2026-10-05 the follow is ALSO recorded server-side (the confirmation
 * endpoint completes it from any device), so "parked" means: in the browser
 * OR on the server. Only when both refuse is the flow stopped.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CompanyFollowButton from '@/components/community/CompanyFollowButton';
import { readPendingCompanyFollows } from '@/services/companyFollowIntent';

const EMAIL = 'company-follow-storage@example.test';

async function submitAnonymousFollow(props: {
  onOptInRequested: (email: string) => void;
  onErrored: (error: unknown) => void;
  recordIntent?: (intent: unknown) => Promise<boolean>;
  company?: string;
  companyKey?: string | null;
}) {
  const recordIntent = props.recordIntent || vi.fn(async () => false);
  const captureEmail = vi.fn(async () => undefined);
  const subscribe = vi.fn(async () => ({ id: 'unexpected' }) as never);
  const company = props.company || 'Acme';
  const companyKey = props.companyKey === undefined ? 'acme' : props.companyKey;
  render(
    <CompanyFollowButton
      company={company}
      companyKey={companyKey}
      userId={null}
      email={null}
      locale="it"
      subscribe={subscribe as never}
      captureEmail={captureEmail}
      onOptInRequested={props.onOptInRequested}
      onErrored={props.onErrored}
      recordIntent={recordIntent as never}
    />,
  );
  const followButton = await waitFor(() => screen.getByRole('button', { name: /Segui questa azienda/i }));
  fireEvent.click(followButton);
  const emailInput = await waitFor(() => {
    const input = document.querySelector('#signup-prompt-email-follow');
    if (!input) throw new Error('shared follow prompt input was not mounted');
    return input as HTMLInputElement;
  });
  fireEvent.change(emailInput, { target: { value: EMAIL } });
  await act(async () => {
    fireEvent.submit(emailInput.closest('form') as HTMLFormElement);
  });
  await waitFor(() => {
    if (captureEmail.mock.calls.length !== 1) throw new Error('capture seam was not called');
  });
  return { subscribe, recordIntent };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('CompanyFollowButton: parked follow gates the opt-in callback', () => {
  it('does not signal opt-in when storage refuses to park the follow', async () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const onOptInRequested = vi.fn();
    const onErrored = vi.fn();

    const { subscribe } = await submitAnonymousFollow({ onOptInRequested, onErrored });

    await waitFor(() => expect(onErrored).toHaveBeenCalledTimes(1));
    expect((onErrored.mock.calls[0][0] as Error).message).toBe('pending_follow_storage_unavailable');
    expect(onOptInRequested).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    // The prompt must not show the "open the link to follow" success card for
    // a follow that will never replay: it stays on the form with an error.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('signals opt-in once the follow is parked', async () => {
    const onOptInRequested = vi.fn();
    const onErrored = vi.fn();

    await submitAnonymousFollow({ onOptInRequested, onErrored });

    await waitFor(() => expect(onOptInRequested).toHaveBeenCalledWith(EMAIL));
    expect(onErrored).not.toHaveBeenCalled();
    expect(readPendingCompanyFollows()).toHaveLength(1);
  });

  it('records the follow server-side with the canonical company key', async () => {
    const onOptInRequested = vi.fn();
    const onErrored = vi.fn();
    const recordIntent = vi.fn(async () => true);

    await submitAnonymousFollow({ onOptInRequested, onErrored, recordIntent });

    await waitFor(() => expect(onOptInRequested).toHaveBeenCalledWith(EMAIL));
    expect(recordIntent).toHaveBeenCalledTimes(1);
    expect(recordIntent.mock.calls[0][0]).toMatchObject({
      email: EMAIL,
      companyKey: 'acme',
      company: 'Acme',
      locale: 'it',
    });
  });

  it('keeps a crawler company key distinct from the public profile slug', async () => {
    const onOptInRequested = vi.fn();
    const onErrored = vi.fn();
    const recordIntent = vi.fn(async () => true);

    await submitAnonymousFollow({
      onOptInRequested,
      onErrored,
      recordIntent,
      company: 'Route Co',
      companyKey: 'canonical-co',
    });

    await waitFor(() => expect(onOptInRequested).toHaveBeenCalledWith(EMAIL));
    expect(recordIntent.mock.calls[0][0]).toMatchObject({
      company: 'Route Co',
      companyKey: 'canonical-co',
    });
  });

  it('continues when only the server holds the follow (storage refused)', async () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const onOptInRequested = vi.fn();
    const onErrored = vi.fn();
    const recordIntent = vi.fn(async () => true);

    await submitAnonymousFollow({ onOptInRequested, onErrored, recordIntent });

    await waitFor(() => expect(onOptInRequested).toHaveBeenCalledWith(EMAIL));
    expect(onErrored).not.toHaveBeenCalled();
  });
});
