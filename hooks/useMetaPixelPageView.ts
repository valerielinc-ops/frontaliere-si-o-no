import { useEffect, useRef } from 'react';

import {
  ADS_CONSENT_GRANTED,
  isAdsConsentGranted,
  onAdsConsentChange,
  type AdsConsentValue,
} from '@/services/adsConsent';
import { SEO_TRACKING_PUSH_EVENT, SEO_TRACKING_REPLACE_EVENT } from './useSeoPageTracking';

const META_PIXEL_ID = '1090503593451766';
const META_PIXEL_PATH = '/automatizza-ricerca-lavoro-svizzera';
const ROUTE_EVENTS = ['popstate', SEO_TRACKING_PUSH_EVENT, SEO_TRACKING_REPLACE_EVENT] as const;

type MetaPixelFunction = ((...args: string[]) => void) & {
  callMethod?: (...args: string[]) => void;
  queue: string[][];
  push: (...args: string[]) => void;
  loaded: boolean;
  version: string;
};

type MetaPixelWindow = Window & {
  fbq?: MetaPixelFunction;
  _fbq?: MetaPixelFunction;
  __ftMetaPixelInitialized?: boolean;
};

function isMetaPixelPage(): boolean {
  return window.location.hostname === 'frontaliereticino.ch'
    && window.location.pathname.replace(/\/+$/, '') === META_PIXEL_PATH;
}

function initializeAndTrackPageView(): void {
  const pixelWindow = window as MetaPixelWindow;
  let fbq = pixelWindow.fbq;

  if (!fbq) {
    const stub = ((...args: string[]) => {
      if (stub.callMethod) stub.callMethod.apply(stub, args);
      else stub.queue.push(args);
    }) as MetaPixelFunction;
    stub.queue = [];
    stub.push = stub;
    stub.loaded = true;
    stub.version = '2.0';
    pixelWindow.fbq = stub;
    if (!pixelWindow._fbq) pixelWindow._fbq = stub;

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://connect.facebook.net/en_US/fbevents.js';
    script.dataset.ftMetaPixel = '1';
    const firstScript = document.getElementsByTagName('script')[0];
    if (firstScript?.parentNode) firstScript.parentNode.insertBefore(script, firstScript);
    else document.head.appendChild(script);
    fbq = stub;
  }

  if (!pixelWindow.__ftMetaPixelInitialized) {
    fbq('init', META_PIXEL_ID);
    pixelWindow.__ftMetaPixelInitialized = true;
  }
  fbq('consent', 'grant');
  fbq('track', 'PageView');
}

function revokeMetaPixelConsent(): void {
  const pixelWindow = window as MetaPixelWindow;
  if (pixelWindow.__ftMetaPixelInitialized && pixelWindow.fbq) {
    pixelWindow.fbq('consent', 'revoke');
  }
}

/** Load Meta Pixel only for the Italian application-concierge landing page and
 * only after the site's explicit advertising-consent decision is granted. */
export function useMetaPixelPageView(): void {
  const visit = useRef({ onTargetPage: false, pageViewSent: false });

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const syncRoute = (): void => {
      const onTargetPage = isMetaPixelPage();
      if (!onTargetPage) {
        visit.current.onTargetPage = false;
        visit.current.pageViewSent = false;
        return;
      }

      if (!visit.current.onTargetPage) {
        visit.current.onTargetPage = true;
        visit.current.pageViewSent = false;
      }
      if (!visit.current.pageViewSent && isAdsConsentGranted()) {
        try {
          initializeAndTrackPageView();
          visit.current.pageViewSent = true;
        } catch {
          // Pixel failures must not affect page rendering or navigation.
        }
      }
    };

    const onConsentChange = (decision: AdsConsentValue | null): void => {
      if (decision !== ADS_CONSENT_GRANTED) {
        visit.current.pageViewSent = false;
        try {
          revokeMetaPixelConsent();
        } catch {
          // A consent revocation must not affect page rendering or navigation.
        }
        return;
      }
      syncRoute();
    };

    const unsubscribe = onAdsConsentChange(onConsentChange);
    for (const eventName of ROUTE_EVENTS) window.addEventListener(eventName, syncRoute);
    syncRoute();

    return () => {
      unsubscribe();
      for (const eventName of ROUTE_EVENTS) window.removeEventListener(eventName, syncRoute);
    };
  }, []);
}
