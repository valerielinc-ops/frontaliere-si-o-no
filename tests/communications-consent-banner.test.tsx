// @vitest-environment jsdom
/**
 * CommunicationsConsentBanner — the consent slot's second panel (#5842).
 *
 * What matters here, in order:
 *  1. the ads panel OWNS the slot until it is answered — the two dialogs must
 *     never be on screen together, and answering ads must free the slot
 *     without a reload;
 *  2. once per device, either answer retires it — a consent prompt that
 *     returns on people who closed it is the invasiveness #5876 was trimmed
 *     to avoid;
 *  3. declining writes NOTHING — "not now" is not an opt-out, and no service
 *     call may fire;
 *  4. accepting records the banner's own act on the travaso alerts — not
 *     `job_alert_activation_click`, which did not happen;
 *  5. the sentence on screen is the register's, byte-identical to what gets
 *     stored;
 *  6. accepting tries the SERVER first (#5928): when it takes the write
 *     (`email_verified === true`) the client-side write must NOT also run;
 *     when it refuses (the shell cohort) the client-side write is the
 *     unchanged fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';
import CommunicationsConsentBanner from '@/components/shared/CommunicationsConsentBanner';
import {
  ADS_CONSENT_STORAGE_KEY,
  ADS_CONSENT_GRANTED,
  ADS_CONSENT_DENIED,
  setAdsConsent,
} from '@/services/adsConsent';
import {
  COMMS_CONSENT_PROMPT_STORAGE_KEY,
  COMMUNICATIONS_BANNER_CONSENT_ACT,
} from '@/services/newsletterConsentUpgrade';
import { consentDisplayText } from '@/services/consentTexts';

const EMAIL = 'persona@example.com';

function makeDeps() {
  return {
    checkEligibility: vi.fn(async (_email: string) => true),
    // Default: the server REFUSES (the shell-account cohort, the banner's
    // majority) so the base assertions exercise the client-side fallback. The
    // verified path is opted into per-test.
    recordViaServer: vi.fn(async (_email: string, _locale?: string | null) => ({
      serverHandled: false as const,
    })),
    recordConsent: vi.fn(async (_email: string, _locale?: string | null) => ({
      recorded: true as const,
    })),
    upgradeConsent: vi.fn(async () => ({ upgraded: 1, skipped: {}, failed: 0 })),
  };
}

function renderBanner(deps: ReturnType<typeof makeDeps>, email: string | null = EMAIL) {
  return render(
    <CommunicationsConsentBanner
      email={email}
      checkEligibility={deps.checkEligibility}
      recordViaServer={deps.recordViaServer}
      recordConsent={deps.recordConsent}
      upgradeConsent={deps.upgradeConsent}
    />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('when it may NOT appear', () => {
  it('renders nothing for an anonymous visitor, and never reads Firestore for one', async () => {
    window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    const deps = makeDeps();
    const view = renderBanner(deps, null);
    // Give any stray async work a tick to surface.
    await act(async () => {});
    expect(view.queryByRole('dialog')).toBeNull();
    expect(deps.checkEligibility).not.toHaveBeenCalled();
  });

  it('stays hidden while the ads decision is pending — the ads panel owns the slot', async () => {
    const deps = makeDeps();
    const view = renderBanner(deps);
    await act(async () => {});
    expect(view.queryByRole('dialog')).toBeNull();
  });

  it('renders nothing when the document is not eligible (no doc / proof present / opt-out)', async () => {
    window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    const deps = makeDeps();
    deps.checkEligibility.mockResolvedValue(false);
    const view = renderBanner(deps);
    await waitFor(() => expect(deps.checkEligibility).toHaveBeenCalledWith(EMAIL));
    expect(view.queryByRole('dialog')).toBeNull();
  });
});

describe('the sequential slot', () => {
  it('appears without a reload the moment the ads panel is answered', async () => {
    const deps = makeDeps();
    const view = renderBanner(deps);
    await act(async () => {});
    expect(view.queryByRole('dialog')).toBeNull();

    await act(async () => {
      setAdsConsent(ADS_CONSENT_GRANTED);
    });
    await waitFor(() => expect(view.getByRole('dialog')).toBeTruthy());
  });

  it('a DENIED ads decision frees the slot too — refusing ads must not cost the comms prompt', async () => {
    // The guard is "the ads decision exists", not "ads were granted": a
    // mutation to needsAdsConsentDecision() === granted-only would silently
    // suppress this panel for the whole ads-declining cohort.
    window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_DENIED);
    const deps = makeDeps();
    const view = renderBanner(deps);
    await waitFor(() => expect(view.getByRole('dialog')).toBeTruthy());
  });

  it('shows the register sentence, byte-identical to what would be stored', async () => {
    window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    const deps = makeDeps();
    const view = renderBanner(deps);
    const dialog = await waitFor(() => view.getByRole('dialog'));
    expect(dialog.textContent).toContain(consentDisplayText('communicationsOptIn', 'it'));
  });
});

describe('accepting', () => {
  it('falls back to the client-side write when the server refuses, and upgrades the alerts with the BANNER act', async () => {
    // Default deps: `serverHandled: false` (the shell-account cohort). The
    // client-side `recordConsent` is the unchanged behaviour for them.
    window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    const deps = makeDeps();
    const view = renderBanner(deps);
    const acceptButton = await waitFor(() => view.getByRole('button', { name: /sì, confermo/i }));

    await act(async () => {
      acceptButton.click();
    });

    await waitFor(() => expect(deps.recordViaServer).toHaveBeenCalledTimes(1));
    expect(deps.recordViaServer.mock.calls[0][0]).toBe(EMAIL);
    // The server refused → the client-side write runs.
    await waitFor(() => expect(deps.recordConsent).toHaveBeenCalledTimes(1));
    expect(deps.recordConsent.mock.calls[0][0]).toBe(EMAIL);

    expect(deps.upgradeConsent).toHaveBeenCalledTimes(1);
    const [upgradeEmail, , upgradeOpts] = deps.upgradeConsent.mock.calls[0] as unknown as [
      string,
      unknown,
      { act?: string } | undefined,
    ];
    expect(upgradeEmail).toBe(EMAIL);
    expect(upgradeOpts?.act).toBe(COMMUNICATIONS_BANNER_CONSENT_ACT);

    expect(window.localStorage.getItem(COMMS_CONSENT_PROMPT_STORAGE_KEY)).toBe('accepted');
  });

  it('when the server TAKES the write (verified), the client-side write does NOT run', async () => {
    // `email_verified === true`: the proof and the network of origin are
    // written server-side. A second client-side write would be redundant and,
    // worse, would land without the IP — so it must be skipped entirely.
    window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    const deps = makeDeps();
    deps.recordViaServer.mockResolvedValue({ serverHandled: true, recorded: true } as never);
    const view = renderBanner(deps);
    const acceptButton = await waitFor(() => view.getByRole('button', { name: /sì, confermo/i }));

    await act(async () => {
      acceptButton.click();
    });

    await waitFor(() => expect(deps.recordViaServer).toHaveBeenCalledTimes(1));
    expect(deps.recordConsent).not.toHaveBeenCalled();
    // The travaso-alert upgrade still runs — it stamps a different document.
    expect(deps.upgradeConsent).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(COMMS_CONSENT_PROMPT_STORAGE_KEY)).toBe('accepted');
  });

  it('a verified server SKIP (already has proof) is still owned by the server — no client write', async () => {
    // 200 with `recorded: false`: the server's plan decided not to write
    // (opt-out or existing proof). The client must not write either, or it
    // would race the same decision from the browser.
    window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    const deps = makeDeps();
    deps.recordViaServer.mockResolvedValue({
      serverHandled: true,
      recorded: false,
      reason: 'already-has-proof',
    } as never);
    const view = renderBanner(deps);
    const acceptButton = await waitFor(() => view.getByRole('button', { name: /sì, confermo/i }));

    await act(async () => {
      acceptButton.click();
    });

    await waitFor(() => expect(deps.recordViaServer).toHaveBeenCalledTimes(1));
    expect(deps.recordConsent).not.toHaveBeenCalled();
  });

  it('a device that answered never sees the panel again', async () => {
    window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    window.localStorage.setItem(COMMS_CONSENT_PROMPT_STORAGE_KEY, 'accepted');
    const deps = makeDeps();
    const view = renderBanner(deps);
    await act(async () => {});
    expect(view.queryByRole('dialog')).toBeNull();
    expect(deps.checkEligibility).not.toHaveBeenCalled();
  });
});

describe('declining', () => {
  it('writes NOTHING, retires the prompt on this device, and never returns', async () => {
    window.localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    const deps = makeDeps();
    const view = renderBanner(deps);
    const declineButton = await waitFor(() => view.getByRole('button', { name: /non ora/i }));

    await act(async () => {
      declineButton.click();
    });

    expect(view.queryByRole('dialog')).toBeNull();
    expect(deps.recordViaServer).not.toHaveBeenCalled();
    expect(deps.recordConsent).not.toHaveBeenCalled();
    expect(deps.upgradeConsent).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(COMMS_CONSENT_PROMPT_STORAGE_KEY)).toBe('dismissed');

    cleanup();
    const deps2 = makeDeps();
    const remount = renderBanner(deps2);
    await act(async () => {});
    expect(remount.queryByRole('dialog')).toBeNull();
    expect(deps2.checkEligibility).not.toHaveBeenCalled();
  });
});
