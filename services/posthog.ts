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
 before_send: (event) => {
 if (!event || event.event !== '$exception') return event;
 const props = event.properties || {};
 const msgs: string[] = [];
 const rawValues = props.$exception_values || props.$exception_list;
 if (Array.isArray(rawValues)) {
 for (const v of rawValues) {
 if (typeof v === 'string') msgs.push(v);
 else if (v && typeof v === 'object' && typeof v.value === 'string') msgs.push(v.value);
 }
 }
 const blob = msgs.join(' | ');
 if (!blob) return event;
 // Benign browser noise — drop.
 if (/ResizeObserver loop/i.test(blob)) return null;
 if (/Non-Error promise rejection captured with value: undefined/i.test(blob)) return null;
 // Cross-origin scripts with no stack info — useless to track.
 if (/^Script error\.?$/i.test(blob.trim())) return null;
 return event;
 },
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
