// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://frontaliereticino.ch/" }

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import { SEO_TRACKING_PUSH_EVENT, SEO_TRACKING_REPLACE_EVENT } from '@/hooks/useSeoPageTracking';
import { useMetaPixelPageView } from '@/hooks/useMetaPixelPageView';
import { setAdsConsent } from '@/services/adsConsent';

const LANDING_PATH = '/automatizza-ricerca-lavoro-svizzera/';
const META_PIXEL_SRC = 'https://connect.facebook.net/en_US/fbevents.js';
const META_PIXEL_ID = '1090503593451766';

type PixelFunction = ((...args: string[]) => void) & { queue: string[][] };
type PixelWindow = Window & {
  fbq?: PixelFunction;
  _fbq?: PixelFunction;
  __ftMetaPixelInitialized?: boolean;
  __ftMetaPixelLastTrackedPath?: string | null;
  __ftAdsConsentDecision?: string;
  __FT_META_PIXEL_DISABLED__?: boolean;
};

function pixelQueue(): string[][] {
  return (window as PixelWindow).fbq?.queue ?? [];
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  document.querySelectorAll('script[data-ft-meta-pixel]').forEach((script) => script.remove());
  const pixelWindow = window as PixelWindow;
  delete pixelWindow.fbq;
  delete pixelWindow._fbq;
  delete pixelWindow.__ftMetaPixelInitialized;
  delete pixelWindow.__ftMetaPixelLastTrackedPath;
  delete pixelWindow.__ftAdsConsentDecision;
  delete pixelWindow.__FT_META_PIXEL_DISABLED__;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  const pixelWindow = window as PixelWindow;
  delete pixelWindow.fbq;
  delete pixelWindow._fbq;
  delete pixelWindow.__ftMetaPixelInitialized;
  delete pixelWindow.__ftMetaPixelLastTrackedPath;
  delete pixelWindow.__ftAdsConsentDecision;
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
    const queue: string[][] = [
      ['init', META_PIXEL_ID],
      ['consent', 'grant'],
      ['track', 'PageView'],
    ];
    const stub = ((...args: string[]) => queue.push(args)) as PixelFunction;
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

    act(() => {
      window.history.pushState({}, '', LANDING_PATH);
      window.dispatchEvent(new Event(SEO_TRACKING_PUSH_EVENT));
    });

    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'PageView')).toHaveLength(0);
  });

  it('revokes Pixel consent and waits for a new grant before tracking again', () => {
    act(() => setAdsConsent('granted'));
    renderHook(() => useMetaPixelPageView());
    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'PageView')).toHaveLength(1);

    act(() => setAdsConsent('denied'));
    expect(pixelQueue()).toContainEqual(['consent', 'revoke']);

    act(() => {
      window.history.pushState({}, '', '/privacy/');
      window.dispatchEvent(new Event(SEO_TRACKING_PUSH_EVENT));
    });

    act(() => setAdsConsent('granted'));
    expect(pixelQueue().filter((call) => call[0] === 'track' && call[1] === 'PageView')).toHaveLength(2);
    expect(document.querySelectorAll(`script[src="${META_PIXEL_SRC}"]`)).toHaveLength(1);
  });
});
