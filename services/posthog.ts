/**
 * PostHog Analytics — EU Cloud (Frankfurt)
 *
 * Lightweight wrapper around PostHog JS SDK.
 * Loads async, does not block page rendering.
 * All events also flow through GA4 via analytics.ts — PostHog provides
 * complementary product analytics (funnels, session replay, feature flags).
 *
 * Silent activation: no consent banner needed (see consentService.ts).
 * PostHog EU Cloud runs under legitimate interest basis (GDPR Art. 6(1)(f)).
 */

import { createExceptionFilter } from './posthog-error-filter';

const POSTHOG_KEY = 'phc_u8jsgXxFQNB6WcQt9JBcdj9tJrR4NsMws3nQoKdigjbT';
const POSTHOG_HOST = 'https://t.frontaliereticino.ch';

let _posthog: any = null;
let _loading: Promise<void> | null = null;

async function ensurePostHog(): Promise<any> {
 if (_posthog) return _posthog;
 if (_loading) {
 await _loading;
 return _posthog;
 }
 _loading = (async () => {
 try {
 const { default: posthog } = await import('posthog-js');
 posthog.init(POSTHOG_KEY, {
 api_host: POSTHOG_HOST,
 // Privacy-first defaults
 persistence: 'localStorage',
 capture_pageview: false, // We handle page_view manually via analytics.ts
 capture_pageleave: true,
 autocapture: false, // Explicit events only, reduces noise
 // Sample 30% of sessions for replay to stay under free-tier 5k/mo cap
 session_recording: { sampleRate: 0.3 },
 // Filter benign noise from exception tracking so real errors stay visible.
 // Patterns + rationale: services/posthog-error-filter.ts. The minimal
 // event shape in posthog-error-filter is a subset of posthog-js's
 // CaptureResult — cast at the boundary so the helper stays SDK-free.
 before_send: createExceptionFilter() as unknown as (event: any) => any,
 // Performance
 loaded: (ph) => { _posthog = ph; },
 });
 _posthog = posthog;
 } catch {
 // PostHog blocked by ad blocker or failed to load — silent
 }
 })();
 await _loading;
 return _posthog;
}

/**
 * Initialize PostHog on page load.
 * Called from App.tsx alongside setDefaultConsent().
 */
export function initPostHog(): void {
 ensurePostHog();
}

/**
 * Capture an event (mirrors GA4 event from analytics.ts).
 * Fire-and-forget — never blocks the caller.
 */
export function captureEvent(eventName: string, properties?: Record<string, any>): void {
 if (_posthog) {
 _posthog.capture(eventName, properties);
 return;
 }
 // PostHog not loaded yet — queue via ensurePostHog
 ensurePostHog().then(ph => {
 if (ph) ph.capture(eventName, properties);
 });
}

/**
 * Capture a page view with path and title.
 */
export function capturePageView(path: string, title?: string): void {
 captureEvent('$pageview', {
 $current_url: window.location.origin + path,
 title: title || document.title,
 });
}

/**
 * Identify a user (for future use with job alerts / newsletter).
 */
export function identifyUser(distinctId: string, properties?: Record<string, any>): void {
 if (_posthog) {
 _posthog.identify(distinctId, properties);
 return;
 }
 ensurePostHog().then(ph => {
 if (ph) ph.identify(distinctId, properties);
 });
}

/**
 * Synchronously read a feature flag's variant string. Returns null when PostHog
 * has not loaded yet or the flag is undefined — callers must handle the null
 * branch (typically by falling back to the control experience).
 */
export function getFeatureFlag(key: string): string | boolean | null {
 if (!_posthog) return null;
 const v = _posthog.getFeatureFlag(key);
 return v === undefined ? null : v;
}

/**
 * Register a callback that fires once feature flags are loaded (and on every
 * subsequent reload). Returns an unsubscribe function. The callback fires
 * immediately if flags are already loaded.
 */
export function onFeatureFlags(callback: () => void): () => void {
 let unsubscribe: (() => void) | null = null;
 let cancelled = false;
 ensurePostHog().then(ph => {
 if (cancelled || !ph) return;
 unsubscribe = ph.onFeatureFlags(() => callback());
 callback();
 });
 return () => {
 cancelled = true;
 if (unsubscribe) unsubscribe();
 };
}

/**
 * Attach a property to every subsequent PostHog event (super-property).
 * Used to tag every event with the active A/B variant once it resolves.
 */
export function registerSuperProperty(key: string, value: string | number | boolean): void {
 const apply = (ph: any) => ph.register({ [key]: value });
 if (_posthog) {
 apply(_posthog);
 return;
 }
 ensurePostHog().then(ph => { if (ph) apply(ph); });
}
