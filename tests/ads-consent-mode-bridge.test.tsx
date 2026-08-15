// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://frontaliereticino.ch/" }
/**
 * Ads gate → Consent Mode v2 bridge, and the revocation surface (#5893).
 *
 * `tests/ads-consent-gate.test.tsx` proves no ad SCRIPT reaches the DOM without
 * consent. This file covers the two things that gate did not:
 *
 *  1. what we TELL GOOGLE. `setDefaultConsent()` used to derive
 *     `ad_storage`/`ad_personalization`/`ad_user_data` from
 *     `ConsentState.advertising`, a flag written `true` silently on the first
 *     page load of every visitor — so the site announced "advertising granted"
 *     to Google while refusing to load a single ad script. The two halves have
 *     to agree, and the agreement has to be asserted on the ad_* trio itself,
 *     not on the storage blob.
 *
 *  2. that the decision is REVOCABLE. The banner renders `null` once a decision
 *     exists, so after the first answer the privacy page is the only surface
 *     left; if it stops offering the two buttons, consent becomes permanent and
 *     nobody notices, because everything else stays green.
 *
 * `analytics_storage` is asserted to stay `granted` on purpose. That is the
 * owner decision of #5842/#5832 — the gate is advertising-only. If a future
 * change gates analytics too, this expectation is the place where the decision
 * gets re-taken explicitly instead of drifting.
 *
 * The module is re-imported per test (`vi.resetModules()`): the ads-consent
 * subscription in `services/consentService.ts` is installed at module scope,
 * and a stale instance from a previous test would keep answering with its own
 * captured state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import {
  ADS_CONSENT_STORAGE_KEY,
  ADS_CONSENT_GRANTED,
  ADS_CONSENT_DENIED,
} from '@/services/adsConsent';

/**
 * `tests/setup-common.tsx` registers a global `vi.mock('@/services/consentService')`
 * whose `setDefaultConsent` is a bare `vi.fn()`. A plain import here would
 * therefore assert nothing at all — the mock publishes no consent signal and
 * every expectation below would have to be written against the spy instead of
 * against the payload Google receives. `importActual` loads the real module
 * without unregistering the mock for anyone else.
 */
async function importConsentService() {
  return vi.importActual<typeof import('@/services/consentService')>('@/services/consentService');
}

type ConsentCall = [string, string, Record<string, string>];

/** Every `gtag('consent', …)` call, in order. */
let consentCalls: ConsentCall[] = [];

function installGtagSpy(): void {
  consentCalls = [];
  (window as unknown as { gtag: (...args: unknown[]) => void }).gtag = (...args: unknown[]) => {
    if (args[0] === 'consent') consentCalls.push(args as unknown as ConsentCall);
  };
}

const lastConsentCall = (): ConsentCall => consentCalls[consentCalls.length - 1];

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  installGtagSpy();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (window as unknown as { gtag?: unknown }).gtag;
  delete (window as unknown as { dataLayer?: unknown }).dataLayer;
});

describe('Consent Mode v2 derives ad_* from the opt-in gate', () => {
  it('publishes the ad_* trio DENIED when the visitor has made no decision', async () => {
    const { setDefaultConsent } = await importConsentService();
    setDefaultConsent();

    const [, command, payload] = lastConsentCall();
    expect(command).toBe('default');
    expect(payload.ad_storage).toBe('denied');
    expect(payload.ad_personalization).toBe('denied');
    expect(payload.ad_user_data).toBe('denied');
    // Advertising-only gate: analytics stays on by owner decision (#5842).
    expect(payload.analytics_storage).toBe('granted');
  });

  it('publishes DENIED even though the silent blob says advertising is granted', async () => {
    // The exact shape `setDefaultConsent()` writes for every visitor. Before
    // this fix it was the source of the ad_* signal, and this expectation was
    // `granted` in production for an audience that had never been asked.
    localStorage.setItem(
      'frontaliere_consent',
      JSON.stringify({ analytics: true, advertising: true, timestamp: 1 }),
    );
    const { setDefaultConsent } = await importConsentService();
    setDefaultConsent();

    const [, , payload] = lastConsentCall();
    expect(payload.ad_storage).toBe('denied');
    expect(payload.ad_personalization).toBe('denied');
    expect(payload.ad_user_data).toBe('denied');
  });

  it('publishes the ad_* trio GRANTED once the gate holds a granted decision', async () => {
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    const { setDefaultConsent } = await importConsentService();
    setDefaultConsent();

    const [, , payload] = lastConsentCall();
    expect(payload.ad_storage).toBe('granted');
    expect(payload.ad_personalization).toBe('granted');
    expect(payload.ad_user_data).toBe('granted');
    expect(payload.analytics_storage).toBe('granted');
  });

  it('fails closed on a corrupted gate value, like the script gate does', async () => {
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, 'true');
    const { setDefaultConsent } = await importConsentService();
    setDefaultConsent();

    expect(lastConsentCall()[2].ad_storage).toBe('denied');
  });

  it('re-publishes an update when the decision changes, without a reload', async () => {
    await importConsentService();
    const { setAdsConsent } = await import('@/services/adsConsent');

    act(() => setAdsConsent(ADS_CONSENT_GRANTED));

    const granted = lastConsentCall();
    expect(granted[0]).toBe('consent');
    expect(granted[1]).toBe('update');
    expect(granted[2].ad_storage).toBe('granted');
    expect(granted[2].ad_personalization).toBe('granted');
    expect(granted[2].ad_user_data).toBe('granted');

    // …and a revocation has to travel the same way, or Google keeps a consent
    // the visitor has withdrawn.
    act(() => setAdsConsent(ADS_CONSENT_DENIED));

    const denied = lastConsentCall();
    expect(denied[1]).toBe('update');
    expect(denied[2].ad_storage).toBe('denied');
    expect(denied[2].ad_user_data).toBe('denied');
    expect(denied[2].analytics_storage).toBe('granted');
  });

  it('uses the dataLayer fallback when gtag() is not defined yet', async () => {
    delete (window as unknown as { gtag?: unknown }).gtag;
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    const { setDefaultConsent } = await importConsentService();
    setDefaultConsent();

    const dataLayer = (window as unknown as { dataLayer: unknown[] }).dataLayer;
    expect(dataLayer[0]).toBe('consent');
    expect(dataLayer[1]).toBe('default');
    expect(dataLayer[2]).toMatchObject({
      ad_storage: 'granted',
      ad_personalization: 'granted',
      ad_user_data: 'granted',
    });
  });
});

describe('privacy page — the consent stays revocable', () => {
  async function renderControls() {
    const { AdsConsentControls } = await import('@/components/pages/PrivacyPolicy');
    await act(async () => {
      render(<AdsConsentControls />);
    });
  }

  it('shows "no decision" and both buttons before the visitor answers', async () => {
    await renderControls();

    expect(screen.getByTestId('ads-consent-status').textContent).toContain('nessuna decisione registrata');
    expect(screen.getByRole('button', { name: 'Attiva gli annunci' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disattiva gli annunci' })).toBeTruthy();
  });

  it('reads back an existing granted decision', async () => {
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    await renderControls();

    expect(screen.getByTestId('ads-consent-status').textContent).toContain('consenso concesso');
  });

  it('grants on click, and stores what the script gate reads', async () => {
    await renderControls();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Attiva gli annunci' }));
    });

    expect(localStorage.getItem(ADS_CONSENT_STORAGE_KEY)).toBe(ADS_CONSENT_GRANTED);
    expect(screen.getByTestId('ads-consent-status').textContent).toContain('consenso concesso');
  });

  it('REVOKES on click — the case the banner cannot serve at all', async () => {
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, ADS_CONSENT_GRANTED);
    await renderControls();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disattiva gli annunci' }));
    });

    expect(localStorage.getItem(ADS_CONSENT_STORAGE_KEY)).toBe(ADS_CONSENT_DENIED);
    expect(screen.getByTestId('ads-consent-status').textContent).toContain('consenso rifiutato');
  });

  it('follows a decision taken elsewhere (banner, other tab) while it is mounted', async () => {
    await renderControls();
    const { setAdsConsent } = await import('@/services/adsConsent');

    await act(async () => {
      setAdsConsent(ADS_CONSENT_GRANTED);
    });

    expect(screen.getByTestId('ads-consent-status').textContent).toContain('consenso concesso');
  });
});
