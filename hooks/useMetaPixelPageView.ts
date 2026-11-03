import { useEffect, useRef } from 'react';

import {
  ADS_CONSENT_GRANTED,
  isAdsConsentGranted,
  onAdsConsentChange,
  type AdsConsentValue,
} from '@/services/adsConsent';
import { sanitizeTelemetryProperties } from '@/services/analyticsUrlPrivacy.js';
import { isSensitiveThirdPartyDocument } from '@/services/thirdPartyDocumentPrivacy.js';
import { SEO_TRACKING_PUSH_EVENT, SEO_TRACKING_REPLACE_EVENT } from './useSeoPageTracking';

const META_PIXEL_ID = '1090503593451766';
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
  __ftMetaPixelLastTrackedPath?: string | null;
  __FT_META_PIXEL_DISABLED__?: boolean;
};

function isMetaPixelSite(): boolean {
  return window.location.hostname === 'frontaliereticino.ch';
}

function initializeAndTrackPageView(): void {
  const pixelWindow = window as MetaPixelWindow;
  let fbq = pixelWindow.fbq;

  if (!fbq) {
    // A static noscript beacon cannot read adsConsent and would bypass the
    // site's fail-closed advertising-consent gate.
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
  pixelWindow.__ftMetaPixelLastTrackedPath = null;
  if (pixelWindow.__ftMetaPixelInitialized && pixelWindow.fbq) {
    pixelWindow.fbq('consent', 'revoke');
  }
}

function canTrackCurrentDocument(): boolean {
  const pixelWindow = window as MetaPixelWindow;
  if (pixelWindow.__FT_META_PIXEL_DISABLED__) return false;
  try {
    if (isSensitiveThirdPartyDocument(sanitizeTelemetryProperties, pixelWindow, document, false)) {
      pixelWindow.__FT_META_PIXEL_DISABLED__ = true;
      return false;
    }
  } catch {
    // Keep the advertising SDK blocked when the page privacy context is unreadable.
    pixelWindow.__FT_META_PIXEL_DISABLED__ = true;
    return false;
  }
  return true;
}

/** Load Meta Pixel across the canonical site after explicit advertising
 * consent, then send one PageView for each page reached through SPA routing. */
export function useMetaPixelPageView(): void {
  const lastTrackedPath = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const syncRoute = (): void => {
      if (!isMetaPixelSite() || !isAdsConsentGranted()) return;
      if (!canTrackCurrentDocument()) return;

      const pixelWindow = window as MetaPixelWindow;
      const currentPath = window.location.pathname.replace(/\/+$/, '') || '/';
      if (lastTrackedPath.current === currentPath) return;
      if (pixelWindow.__ftMetaPixelLastTrackedPath === currentPath) {
        lastTrackedPath.current = currentPath;
        return;
      }

      try {
        initializeAndTrackPageView();
        lastTrackedPath.current = currentPath;
        pixelWindow.__ftMetaPixelLastTrackedPath = currentPath;
      } catch {
        // Pixel failures must not affect page rendering or navigation.
      }
    };

    const onConsentChange = (decision: AdsConsentValue | null): void => {
      if (decision !== ADS_CONSENT_GRANTED) {
        lastTrackedPath.current = null;
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
