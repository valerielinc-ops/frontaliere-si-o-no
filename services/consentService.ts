/**
 * Consent Management Service — Google Consent Mode v2 + localStorage persistence
 *
 * Manages cookie/analytics consent for GDPR/ePrivacy compliance.
 * Integrates with Google Consent Mode v2 so GA4 respects user choice.
 *
 * Consent categories:
 * - analytics_storage: GA4 / Firebase Analytics / PostHog
 * - ad_storage: AdSense, remarketing
 * - ad_personalization: personalized ads
 * - ad_user_data: sending user data to Google for advertising
 * - functionality_storage: preferences (theme, locale) — always granted (essential)
 *
 * Flow:
 * 1. On load, setDefaultConsent() grants everything by default (silent activation)
 * 2. If user previously had stored preferences, those are applied instead
 * 3. No consent banner — all analytics/advertising active from first page load
 */

const STORAGE_KEY = 'frontaliere_consent';

export type ConsentCategory = 'analytics' | 'advertising';

export interface ConsentState {
  analytics: boolean;
  advertising: boolean;
  timestamp: number;
}

// ─── Default granted state (silent activation, no consent popup) ───

const DEFAULT_STATE: ConsentState = {
  analytics: true,
  advertising: true,
  timestamp: 0,
};

// ─── Google Consent Mode v2 bridge ──────────────────────────

function gtagConsent(command: 'default' | 'update', state: ConsentState) {
  const w = window as any;

  // Consent Mode v2: use gtag() when available (defined in index.html).
  // This is the authoritative path — gtag pushes to dataLayer internally.
  if (typeof w.gtag === 'function') {
    w.gtag('consent', command, {
      analytics_storage: state.analytics ? 'granted' : 'denied',
      ad_storage: state.advertising ? 'granted' : 'denied',
      ad_personalization: state.advertising ? 'granted' : 'denied',
      ad_user_data: state.advertising ? 'granted' : 'denied',
      functionality_storage: 'granted',
      security_storage: 'granted',
    });
    return;
  }

  // Fallback: gtag() not yet defined (shouldn't happen — index.html defines it).
  // Push directly to dataLayer in the format Google Tag expects.
  if (!w.dataLayer) w.dataLayer = [];
  w.dataLayer.push('consent', command, {
    analytics_storage: state.analytics ? 'granted' : 'denied',
    ad_storage: state.advertising ? 'granted' : 'denied',
    ad_personalization: state.advertising ? 'granted' : 'denied',
    ad_user_data: state.advertising ? 'granted' : 'denied',
    functionality_storage: 'granted',
    security_storage: 'granted',
  });
}

// ─── Persistence ────────────────────────────────────────────

function loadState(): ConsentState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.analytics !== 'boolean') return null;
    return parsed as ConsentState;
  } catch {
    return null;
  }
}

function saveState(state: ConsentState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* quota exceeded — degrade gracefully */ }
}

// ─── Listeners ──────────────────────────────────────────────

type ConsentListener = (state: ConsentState) => void;
const listeners: ConsentListener[] = [];

// ─── Public API ─────────────────────────────────────────────

/** Returns stored consent, or null if user hasn't decided yet */
export function getConsent(): ConsentState | null {
  return loadState();
}

/** Whether user has made any consent choice */
export function hasConsent(): boolean {
  return loadState() !== null;
}

/** Whether analytics consent is granted */
export function isAnalyticsGranted(): boolean {
  return loadState()?.analytics ?? false;
}

/** Whether advertising consent is granted */
export function isAdvertisingGranted(): boolean {
  return loadState()?.advertising ?? false;
}

/**
 * Set default consent on page load.
 * Silent activation: analytics + advertising are granted by default.
 * If no stored preference exists, persist the granted state immediately.
 */
export function setDefaultConsent() {
  const stored = loadState();
  if (stored) {
    gtagConsent('default', stored);
  } else {
    // No stored preference — activate everything silently
    const granted: ConsentState = { analytics: true, advertising: true, timestamp: Date.now() };
    saveState(granted);
    gtagConsent('default', granted);
  }
}

/**
 * User accepts all cookies
 */
export function acceptAll(): ConsentState {
  const state: ConsentState = { analytics: true, advertising: true, timestamp: Date.now() };
  saveState(state);
  gtagConsent('update', state);
  notifyListeners(state);
  return state;
}

/**
 * User rejects all non-essential cookies
 */
export function rejectAll(): ConsentState {
  const state: ConsentState = { analytics: false, advertising: false, timestamp: Date.now() };
  saveState(state);
  gtagConsent('update', state);
  notifyListeners(state);
  return state;
}

/**
 * User customizes consent
 */
export function updateConsent(categories: Partial<Pick<ConsentState, 'analytics' | 'advertising'>>): ConsentState {
  const current = loadState() || DEFAULT_STATE;
  const state: ConsentState = {
    analytics: categories.analytics ?? current.analytics,
    advertising: categories.advertising ?? current.advertising,
    timestamp: Date.now(),
  };
  saveState(state);
  gtagConsent('update', state);
  notifyListeners(state);
  return state;
}

/**
 * Revoke all consent and clear stored state
 */
export function revokeConsent() {
  const state: ConsentState = { analytics: false, advertising: false, timestamp: Date.now() };
  saveState(state);
  gtagConsent('update', state);
  notifyListeners(state);
}

/**
 * Subscribe to consent changes
 */
export function onConsentChange(listener: ConsentListener): () => void {
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function notifyListeners(state: ConsentState) {
  listeners.forEach(fn => fn(state));
}
