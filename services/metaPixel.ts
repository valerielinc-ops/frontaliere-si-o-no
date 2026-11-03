import {
  ADS_CONSENT_GRANTED,
  ADS_CONSENT_DENIED,
  getAdsConsent,
  getAdsConsentDecisionAt,
  isAdsConsentGranted,
} from './adsConsent';

export const META_PIXEL_ID = '1090503593451766';
export const META_PIXEL_CANONICAL_PATH = '/automatizza-ricerca-lavoro-svizzera';
export const META_PIXEL_AD_FALLBACK_PATH = '/cerca-lavoro-ticino';

const META_COOKIE_VALUE_RE = /^fb\.[0-9]{1,4}\.[0-9]{1,16}\.[A-Za-z0-9_-]{1,200}$/;

export type MetaPixelFunction = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[][];
  push: (...args: unknown[]) => void;
  loaded: boolean;
  version: string;
};

type MetaPixelWindow = Window & {
  fbq?: MetaPixelFunction;
  __ftMetaPixelInitialized?: boolean;
};

export type MetaAdsAttribution = {
  metaAdsConsent: boolean;
  metaAdsConsentAtMs?: number;
  metaEventSourceUrl?: string;
  metaFbp?: string;
  metaFbc?: string;
};

function metaEventSourceUrl(): string | undefined {
  if (!isMetaPixelTargetPage()) return undefined;
  const path = window.location.pathname.replace(/\/+$/, '');
  if (path === META_PIXEL_CANONICAL_PATH) {
    return 'https://frontaliereticino.ch/automatizza-ricerca-lavoro-svizzera/';
  }
  return 'https://frontaliereticino.ch/cerca-lavoro-ticino/?application_concierge=1';
}

export function isMetaPixelTargetPage(): boolean {
  if (typeof window === 'undefined' || window.location.hostname !== 'frontaliereticino.ch') return false;

  const path = window.location.pathname.replace(/\/+$/, '');
  if (path === META_PIXEL_CANONICAL_PATH) return true;

  return path === META_PIXEL_AD_FALLBACK_PATH
    && new URLSearchParams(window.location.search).get('application_concierge') === '1';
}

function readMetaCookie(name: '_fbp' | '_fbc'): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const prefix = `${name}=`;
  const raw = document.cookie.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(prefix))?.slice(prefix.length);
  if (!raw) return undefined;

  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return META_COOKIE_VALUE_RE.test(value) ? value : undefined;
}

/** Clear browser attribution after an explicit withdrawal or an unanswered reset. */
export function clearMetaAttributionCookies(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined'
    || window.location.hostname !== 'frontaliereticino.ch') return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  for (const name of ['_fbp', '_fbc']) {
    for (const domain of ['', '; domain=frontaliereticino.ch', '; domain=.frontaliereticino.ch']) {
      document.cookie = `${name}=; Max-Age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}; SameSite=Lax${secure}`;
    }
  }
}

/** Capture only consented Meta attribution cookies for the verified checkout request. */
export function captureMetaAdsAttribution(): MetaAdsAttribution {
  if (!isMetaPixelTargetPage()) return { metaAdsConsent: false };

  const consent = getAdsConsent();
  const storedDecisionAtMs = getAdsConsentDecisionAt();
  const metaAdsConsentAtMs = consent === ADS_CONSENT_GRANTED || consent === ADS_CONSENT_DENIED
    ? storedDecisionAtMs
    : 0;
  if (!isAdsConsentGranted() || !metaAdsConsentAtMs) {
    return {
      metaAdsConsent: false,
      ...(consent === ADS_CONSENT_DENIED && metaAdsConsentAtMs ? { metaAdsConsentAtMs } : {}),
    };
  }
  const metaFbp = readMetaCookie('_fbp');
  const metaFbc = readMetaCookie('_fbc');
  return {
    metaAdsConsent: true,
    metaAdsConsentAtMs,
    metaEventSourceUrl: metaEventSourceUrl(),
    ...(metaFbp ? { metaFbp } : {}),
    ...(metaFbc ? { metaFbc } : {}),
  };
}

export function trackMetaPixelEvent(
  eventName: 'ViewContent' | 'InitiateCheckout',
  parameters: Record<string, unknown>,
  eventId?: string,
): boolean {
  if (!isMetaPixelTargetPage() || !isAdsConsentGranted()) return false;
  const pixelWindow = window as MetaPixelWindow;
  if (!pixelWindow.__ftMetaPixelInitialized || !pixelWindow.fbq) return false;
  pixelWindow.fbq('track', eventName, parameters, ...(eventId ? [{ eventID: eventId }] : []));
  return true;
}
