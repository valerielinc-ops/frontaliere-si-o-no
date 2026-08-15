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
 * ── The three ad_* signals are DERIVED, not stored here (#5893) ───────
 *
 * They do NOT come from `ConsentState.advertising` any more. That flag is
 * written `true` by `setDefaultConsent()` on the first page load of every
 * visitor, silently, with no UI ever shown — so reading it would announce
 * "advertising granted" to Google for essentially the whole audience, while
 * `services/adsConsent.ts` (the opt-in gate shipped in #5842) is at the very
 * same moment refusing to load a single ad script. Two sources of truth that
 * contradict each other, and the wrong one talking to Google.
 *
 * So `ad_storage` / `ad_personalization` / `ad_user_data` are now computed from
 * `getAdsConsent() === 'granted'` — the same three-valued, fail-closed reading
 * the gate itself uses. No decision and an explicit refusal both publish
 * `denied`. `ConsentState.advertising` stays in the localStorage blob for
 * backwards compatibility with `getConsent()`/`isAdvertisingGranted()` readers,
 * but it no longer feeds the Consent Mode signal.
 *
 * A module-scope `onAdsConsentChange` subscription re-publishes a
 * `('consent', 'update', …)` whenever the decision changes — from the banner,
 * from the privacy page, or from another tab — so Google learns about an
 * acceptance or a revocation without a page reload.
 *
 * ── Why analytics_storage is deliberately NOT gated ───────────────────
 *
 * `analytics_storage` stays `granted` by default. That is an explicit owner
 * decision (#5842, on top of the honest disclosure shipped in #5832): the
 * opt-in gate covers ADVERTISING scripts only, and GA4 / PostHog / Clarity
 * remain active from the first page load. Do not widen the derivation above to
 * analytics without a new owner decision.
 *
 * Flow:
 * 1. On load, setDefaultConsent() publishes the stored analytics preference
 *    (granted by default) plus the ad_* trio derived from the ads gate
 * 2. If user previously had stored preferences, those are applied instead
 * 3. The ads banner (#5842) is the only consent UI; analytics is not gated
 */

import { getAdsConsent, onAdsConsentChange, ADS_CONSENT_GRANTED } from './adsConsent';

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

/**
 * The Consent Mode v2 payload. `analytics_storage` follows the stored blob;
 * the ad_* trio follows the opt-in gate, never the blob — see the file header.
 */
function consentPayload(state: ConsentState) {
 const ads = getAdsConsent() === ADS_CONSENT_GRANTED ? 'granted' : 'denied';
 return {
 analytics_storage: state.analytics ? 'granted' : 'denied',
 ad_storage: ads,
 ad_personalization: ads,
 ad_user_data: ads,
 functionality_storage: 'granted',
 security_storage: 'granted',
 };
}

function gtagConsent(command: 'default' | 'update', state: ConsentState) {
 const w = window as any;
 const payload = consentPayload(state);

 // Consent Mode v2: use gtag() when available (defined in index.html).
 // This is the authoritative path — gtag pushes to dataLayer internally.
 if (typeof w.gtag === 'function') {
 w.gtag('consent', command, payload);
 return;
 }

 // Fallback: gtag() not yet defined (shouldn't happen — index.html defines it).
 // Push directly to dataLayer in the format Google Tag expects.
 if (!w.dataLayer) w.dataLayer = [];
 w.dataLayer.push('consent', command, payload);
}

// ─── Ads gate → Consent Mode bridge ─────────────────────────
//
// Installed once, at module scope, guarded for SSR/prerender where there is no
// `window` (and therefore no localStorage and no listener target). Without this
// subscription a visitor who accepts from the banner — or revokes from the
// privacy page — would keep the `denied` trio published at page load until the
// next full reload, i.e. Google would be told the opposite of what the gate is
// actually doing for the rest of the session.

if (typeof window !== 'undefined') {
 onAdsConsentChange(() => {
 gtagConsent('update', loadState() || DEFAULT_STATE);
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

/**
 * Legacy blob flag. NOT the ad gate and NOT what Consent Mode publishes: it is
 * `true` for every visitor since their first page load. For "may we load an ad
 * script / what did the visitor answer", use `isAdsConsentGranted()` from
 * `services/adsConsent.ts`.
 */
export function isAdvertisingGranted(): boolean {
 return loadState()?.advertising ?? false;
}

/**
 * Set default consent on page load.
 * Analytics is granted by default (owner decision, #5842); the ad_* trio is
 * derived from the ads gate inside `gtagConsent`, so a visitor who has not
 * answered the banner gets `denied` published for advertising regardless of
 * what the blob below says.
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
