// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://frontaliereticino.ch/" }

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import { SEO_TRACKING_PUSH_EVENT, SEO_TRACKING_REPLACE_EVENT } from '@/hooks/useSeoPageTracking';
import { useMetaPixelPageView } from '@/hooks/useMetaPixelPageView';
import { captureMetaAdsAttribution, trackMetaPixelEvent } from '@/services/metaPixel';
import {
  ADS_CONSENT_DECISION_AT_STORAGE_KEY,
  ADS_CONSENT_STORAGE_KEY,
  getAdsConsentDecisionAt,
  onAdsConsentChange,
  setAdsConsent,
} from '@/services/adsConsent';
import { SYNC_APPLICATION_CONCIERGE_META_CONSENT_URL } from '@/services/functionsBase';

const LANDING_PATH = '/automatizza-ricerca-lavoro-svizzera/';
const AD_FALLBACK_PATH = '/cerca-lavoro-ticino/?application_concierge=1';
const META_PIXEL_SRC = 'https://connect.facebook.net/en_US/fbevents.js';
const META_PIXEL_ID = '1090503593451766';
const appCheckMocks = vi.hoisted(() => ({
  appCheck: { app: 'test-app' },
  ensureAppCheck: vi.fn(async () => {}),
  getToken: vi.fn(async () => ({ token: 'firebase-app-check-token' })),
}));

vi.mock('@/services/firebase', () => ({
  ensureAppCheck: appCheckMocks.ensureAppCheck,
  get appCheck() { return appCheckMocks.appCheck; },
}));

vi.mock('firebase/app-check', () => ({ getToken: appCheckMocks.getToken }));

type PixelFunction = ((...args: unknown[]) => void) & { queue: unknown[][] };
type PixelWindow = Window & {
  fbq?: PixelFunction;
  _fbq?: PixelFunction;
  __ftMetaPixelInitialized?: boolean;
  __ftMetaPixelLastTrackedPath?: string | null;
  __ftAdsConsentDecision?: string;
  __ftAdsConsentDecisionAt?: number;
  __FT_META_PIXEL_DISABLED__?: boolean;
};

function pixelQueue(): unknown[][] {
  return (window as PixelWindow).fbq?.queue ?? [];
}

function clearMetaCookies(): void {
  document.cookie = '_fbp=; Max-Age=0; path=/';
  document.cookie = '_fbc=; Max-Age=0; path=/';
}

beforeEach(() => {
  appCheckMocks.ensureAppCheck.mockClear();
  appCheckMocks.getToken.mockClear();
  localStorage.clear();
  clearMetaCookies();
  window.history.replaceState({}, '', '/');
  document.querySelectorAll('script[data-ft-meta-pixel]').forEach((script) => script.remove());
  const pixelWindow = window as PixelWindow;
  delete pixelWindow.fbq;
  delete pixelWindow._fbq;
  delete pixelWindow.__ftMetaPixelInitialized;
  delete pixelWindow.__ftMetaPixelLastTrackedPath;
  delete pixelWindow.__ftAdsConsentDecision;
  delete pixelWindow.__ftAdsConsentDecisionAt;
  delete pixelWindow.__FT_META_PIXEL_DISABLED__;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  clearMetaCookies();
  const pixelWindow = window as PixelWindow;
  delete pixelWindow.fbq;
  delete pixelWindow._fbq;
  delete pixelWindow.__ftMetaPixelInitialized;
  delete pixelWindow.__ftMetaPixelLastTrackedPath;
  delete pixelWindow.__ftAdsConsentDecision;
  delete pixelWindow.__ftAdsConsentDecisionAt;
  delete pixelWindow.__FT_META_PIXEL_DISABLED__;
});

describe('useMetaPixelPageView', () => {
  it('waits for advertising consent before loading Meta Pixel and sending PageView', () => {
    renderHook(() => useMetaPixelPageView());

    expect(document.querySelector(`script[src="${META_PIXEL_SRC}"]`)).toBeNull();
    expect((window as PixelWindow).fbq).toBeUndefined();

    act(() => setAdsConsent('granted'));

    expect(document.querySelector(`script[src="${META_PIXEL_SRC}"]`)).not.toBeNull();
    expect(pixelQueue()).toContainEqual(['init', META_PIXEL_ID]);
    expect(pixelQueue()).toContainEqual(['track', 'PageView']);
    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'ViewContent')).toHaveLength(0);

    act(() => setAdsConsent('granted'));
    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'PageView')).toHaveLength(1);
  });

  it('tracks the initial page and every SPA page once across the site', () => {
    act(() => setAdsConsent('granted'));
    renderHook(() => useMetaPixelPageView());
    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'PageView')).toHaveLength(1);

    act(() => {
      window.history.pushState({}, '', LANDING_PATH);
      window.dispatchEvent(new Event(SEO_TRACKING_PUSH_EVENT));
    });
    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'PageView')).toHaveLength(2);
    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'ViewContent')).toHaveLength(1);

    act(() => {
      window.history.pushState({}, '', '/privacy/');
      window.dispatchEvent(new Event(SEO_TRACKING_PUSH_EVENT));
    });
    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'PageView')).toHaveLength(3);

    act(() => {
      window.history.replaceState({}, '', '/en/automate-job-search-switzerland/');
      window.dispatchEvent(new Event(SEO_TRACKING_REPLACE_EVENT));
    });
    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'PageView')).toHaveLength(4);

    act(() => {
      window.history.replaceState({}, '', '/de/arbeitssuche-schweiz-automatisieren/');
      window.dispatchEvent(new Event('popstate'));
    });
    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'PageView')).toHaveLength(5);

    act(() => window.dispatchEvent(new Event(SEO_TRACKING_PUSH_EVENT)));
    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'PageView')).toHaveLength(5);
  });

  it('does not duplicate the initial PageView already sent by the static loader', () => {
    act(() => setAdsConsent('granted'));
    const queue: unknown[][] = [
      ['init', META_PIXEL_ID],
      ['consent', 'grant'],
      ['track', 'PageView'],
    ];
    const stub = ((...args: unknown[]) => queue.push(args)) as PixelFunction;
    stub.queue = queue;
    const pixelWindow = window as PixelWindow;
    pixelWindow.fbq = stub;
    pixelWindow.__ftMetaPixelInitialized = true;
    pixelWindow.__ftMetaPixelLastTrackedPath = '/';

    renderHook(() => useMetaPixelPageView());

    expect(queue.filter((call) => call[0] === 'track' && call[1] === 'PageView')).toHaveLength(1);
  });

  it('suppresses PageViews for credential-bearing documents and keeps the document blocked', () => {
    act(() => setAdsConsent('granted'));
    window.history.replaceState({}, '', '/newsletter-login/?ne=candidate%40example.test&ac=synthetic-code');
    renderHook(() => useMetaPixelPageView());

    expect(document.querySelector(`script[src="${META_PIXEL_SRC}"]`)).toBeNull();
    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'PageView')).toHaveLength(0);
    expect((window as PixelWindow).__FT_META_PIXEL_DISABLED__).toBe(true);
    expect(captureMetaAdsAttribution()).toEqual({ metaAdsConsent: false });

    act(() => {
      window.history.pushState({}, '', LANDING_PATH);
      window.dispatchEvent(new Event(SEO_TRACKING_PUSH_EVENT));
    });

    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'PageView')).toHaveLength(0);
    expect(captureMetaAdsAttribution()).toEqual({ metaAdsConsent: false });
  });

  it('captures Meta attribution cookies only after explicit advertising consent', () => {
    window.history.replaceState({}, '', AD_FALLBACK_PATH);
    document.cookie = '_fbp=fb.1.1700000000000.1234567890; path=/';
    document.cookie = '_fbc=fb.1.1700000000000.ABC_def-123; path=/';
    expect(captureMetaAdsAttribution()).toEqual(expect.objectContaining({ metaAdsConsent: false }));
    expect(captureMetaAdsAttribution()).not.toHaveProperty('metaEventSourceUrl');

    act(() => setAdsConsent('granted'));
    expect(captureMetaAdsAttribution()).toEqual(expect.objectContaining({
      metaAdsConsent: true,
      metaAdsConsentAtMs: expect.any(Number),
      metaEventSourceUrl: 'https://frontaliereticino.ch/cerca-lavoro-ticino/?application_concierge=1',
      metaFbp: 'fb.1.1700000000000.1234567890',
      metaFbc: 'fb.1.1700000000000.ABC_def-123',
    }));

    act(() => setAdsConsent('denied'));
    expect(captureMetaAdsAttribution()).toEqual(expect.objectContaining({
      metaAdsConsent: false,
      metaAdsConsentAtMs: expect.any(Number),
    }));
    expect(captureMetaAdsAttribution()).not.toHaveProperty('metaEventSourceUrl');
  });

  it('migrates a stored legacy explicit grant into a timestamped consent', () => {
    window.history.replaceState({}, '', LANDING_PATH);
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, 'granted');
    document.cookie = '_fbp=fb.1.1700000000000.1234567890; path=/';

    expect(getAdsConsentDecisionAt()).toBeGreaterThan(0);
    expect(captureMetaAdsAttribution()).toEqual(expect.objectContaining({
      metaAdsConsent: true,
      metaAdsConsentAtMs: expect.any(Number),
      metaEventSourceUrl: 'https://frontaliereticino.ch/automatizza-ricerca-lavoro-svizzera/',
    }));
  });

  it('refreshes the consent timestamp when another tab changes the stored decision', () => {
    const previousAt = Date.now() - 10_000;
    const latestAt = Date.now() - 5_000;
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, 'granted');
    localStorage.setItem(ADS_CONSENT_DECISION_AT_STORAGE_KEY, String(previousAt));
    const unsubscribe = onAdsConsentChange(() => {});

    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, 'denied');
    window.dispatchEvent(new StorageEvent('storage', { key: ADS_CONSENT_STORAGE_KEY }));
    localStorage.setItem(ADS_CONSENT_DECISION_AT_STORAGE_KEY, String(latestAt));
    window.dispatchEvent(new StorageEvent('storage', { key: ADS_CONSENT_DECISION_AT_STORAGE_KEY }));

    expect(getAdsConsentDecisionAt()).toBe(latestAt);
    unsubscribe();
  });

  it('notifies consent listeners once when another tab updates both consent keys', () => {
    const previousAt = Date.now() - 10_000;
    const latestAt = Date.now() - 5_000;
    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, 'granted');
    localStorage.setItem(ADS_CONSENT_DECISION_AT_STORAGE_KEY, String(previousAt));
    getAdsConsentDecisionAt();
    const listener = vi.fn();
    const unsubscribe = onAdsConsentChange(listener);

    localStorage.setItem(ADS_CONSENT_STORAGE_KEY, 'denied');
    localStorage.setItem(ADS_CONSENT_DECISION_AT_STORAGE_KEY, String(latestAt));
    window.dispatchEvent(new StorageEvent('storage', { key: ADS_CONSENT_STORAGE_KEY, newValue: 'denied' }));
    window.dispatchEvent(new StorageEvent('storage', {
      key: ADS_CONSENT_DECISION_AT_STORAGE_KEY,
      newValue: String(latestAt),
    }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getAdsConsentDecisionAt()).toBe(latestAt);
    unsubscribe();
  });

  it('sends checkout events only on the initialized, consented concierge route', () => {
    window.history.replaceState({}, '', AD_FALLBACK_PATH);
    act(() => setAdsConsent('granted'));
    renderHook(() => useMetaPixelPageView());

    expect(trackMetaPixelEvent('InitiateCheckout', { value: 39.99, currency: 'EUR' }, 'checkout-1')).toBe(true);
    expect(pixelQueue()).toContainEqual([
      'track', 'InitiateCheckout', { value: 39.99, currency: 'EUR' }, { eventID: 'checkout-1' },
    ]);

    act(() => window.history.pushState({}, '', '/lavoro/'));
    expect(trackMetaPixelEvent('InitiateCheckout', { value: 39.99, currency: 'EUR' }, 'checkout-2')).toBe(false);
  });

  it('sends ViewContent only on service landing routes while keeping sitewide PageViews', () => {
    act(() => setAdsConsent('granted'));
    renderHook(() => useMetaPixelPageView());

    act(() => {
      window.history.pushState({}, '', '/cerca-lavoro-ticino/');
      window.dispatchEvent(new Event(SEO_TRACKING_PUSH_EVENT));
    });
    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'ViewContent')).toHaveLength(0);

    act(() => {
      window.history.pushState({}, '', AD_FALLBACK_PATH);
      window.dispatchEvent(new Event(SEO_TRACKING_PUSH_EVENT));
    });
    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'ViewContent')).toHaveLength(1);
  });

  it('revokes Pixel consent and waits for a new grant before tracking again', () => {
    window.history.replaceState({}, '', LANDING_PATH);
    document.cookie = '_fbp=fb.1.1700000000000.1234567890; path=/';
    document.cookie = '_fbc=fb.1.1700000000000.ABC_def-123; path=/';
    act(() => setAdsConsent('granted'));
    renderHook(() => useMetaPixelPageView());
    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'PageView')).toHaveLength(1);

    act(() => setAdsConsent('denied'));
    expect(pixelQueue()).toContainEqual(['consent', 'revoke']);
    expect(pixelQueue().filter((call) => call[0] === 'track')).toHaveLength(0);
    expect(document.cookie).not.toContain('_fbp=');
    expect(document.cookie).not.toContain('_fbc=');

    act(() => {
      window.history.pushState({}, '', '/privacy/');
      window.dispatchEvent(new Event(SEO_TRACKING_PUSH_EVENT));
    });

    act(() => setAdsConsent('granted'));
    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'PageView')).toHaveLength(1);
    expect(document.querySelectorAll(`script[src="${META_PIXEL_SRC}"]`)).toHaveLength(1);
  });

  it('synchronizes consent grants and withdrawals for the signed-in user', async () => {
    window.history.replaceState({}, '', AD_FALLBACK_PATH);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    const user = { uid: 'user-1', getIdToken: vi.fn(async () => 'firebase-id-token') };
    act(() => setAdsConsent('granted'));
    renderHook(() => useMetaPixelPageView(user));

    act(() => setAdsConsent('denied'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(fetchSpy).toHaveBeenNthCalledWith(1, SYNC_APPLICATION_CONCIERGE_META_CONSENT_URL, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer firebase-id-token' }),
      body: expect.stringContaining('"decision":"granted"'),
    }));
    expect(fetchSpy).toHaveBeenNthCalledWith(2, SYNC_APPLICATION_CONCIERGE_META_CONSENT_URL, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer firebase-id-token' }),
      body: expect.stringContaining('"decision":"denied"'),
    }));
  });

  it('does not resend a saved consent decision on focus when no retry is pending', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    const user = { uid: 'user-1', getIdToken: vi.fn(async () => 'firebase-id-token') };
    act(() => setAdsConsent('granted'));
    renderHook(() => useMetaPixelPageView(user));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event('focus')));
    await act(async () => Promise.resolve());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not turn an unanswered consent state into a server-side denial', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    const user = { uid: 'user-1', getIdToken: vi.fn(async () => 'firebase-id-token') };

    renderHook(() => useMetaPixelPageView(user));
    await act(async () => Promise.resolve());

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores malformed saved consent decisions instead of retrying untyped data', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    localStorage.setItem('frontaliere_meta_ads_consent_pending', '{"decision":[],"decisionAtMs":"bad"}');
    const user = { uid: 'user-1', getIdToken: vi.fn(async () => 'firebase-id-token') };

    renderHook(() => useMetaPixelPageView(user));
    await act(async () => Promise.resolve());

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps a withdrawal pending and retries it after sign-in', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    let user: { uid: string; getIdToken: () => Promise<string> } | null = null;
    const { rerender } = renderHook(() => useMetaPixelPageView(user));

    act(() => setAdsConsent('denied'));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem('frontaliere_meta_ads_consent_pending')).toContain('"decision":"denied"');
    const anonymousRequest = vi.mocked(fetchSpy).mock.calls[0][1];
    expect(anonymousRequest?.headers).not.toHaveProperty('Authorization');

    user = { uid: 'user-1', getIdToken: vi.fn(async () => 'firebase-id-token') };
    rerender();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fetchSpy).mock.calls[1][1]?.headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer firebase-id-token',
    }));
    await waitFor(() => expect(localStorage.getItem('frontaliere_meta_ads_consent_pending')).toBeNull());
  });

  it('sends anonymous Meta consent withdrawals with a Firebase App Check token', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    appCheckMocks.ensureAppCheck.mockRejectedValueOnce(new Error('temporary App Check startup failure'));
    act(() => setAdsConsent('denied'));
    renderHook(() => useMetaPixelPageView());

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(appCheckMocks.ensureAppCheck).toHaveBeenCalledTimes(2);
    expect(appCheckMocks.getToken).toHaveBeenCalledWith(appCheckMocks.appCheck);
    expect(vi.mocked(fetchSpy).mock.calls[0][1]?.headers).toEqual(expect.objectContaining({
      'X-Firebase-AppCheck': 'firebase-app-check-token',
    }));
  });
});
