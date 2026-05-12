/**
 * Analytics Service - Firebase Analytics (GA4)
 *
 * Usa SOLO Firebase Analytics SDK (che invia a GA4 tramite measurementId).
 * NON serve react-ga4 separato: Firebase Analytics già invia a Google Analytics 4.
 *
 * PERFORMANCE: Firebase SDK viene caricato LAZILY al primo uso,
 * non al caricamento del modulo. Questo evita di includere ~700KB
 * di Firebase nel bundle critico iniziale.
 *
 * ════════════════════════════════════════════════════════════════
 * EVENT CATALOG — Quick reference for all tracked events
 * ════════════════════════════════════════════════════════════════
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │ GA4 RECOMMENDED (auto-reported in GA4 standard reports) │
 * ├──────────────────────┬──────────────────────────────────────┤
 * │ page_view │ Page/route navigation │
 * │ select_content │ Standalone content selection │
 * │ share │ Social share (WhatsApp, copy, etc.) │
 * │ search │ Site search query │
 * │ generate_lead │ Simulation completed (core KPI) │
 * │ exception │ Error/exception (fatal or non-fatal) │
 * │ file_download │ PDF/report download │
 * ├──────────────────────┼──────────────────────────────────────┤
 * │ ENGAGEMENT │
 * ├──────────────────────┼──────────────────────────────────────┤
 * │ scroll │ Scroll depth milestones (25/50/75%) │
 * │ session_end │ Session end with engagement time │
 * │ cta_click │ Click on button/link (throttled) │
 * │ form_submit │ Form submission │
 * │ traffic_attribution │ UTM/referrer session attribution │
 * ├──────────────────────┼──────────────────────────────────────┤
 * │ APP-SPECIFIC — Core user journeys │
 * ├──────────────────────┼──────────────────────────────────────┤
 * │ simulation_complete │ Tax calculation completed │
 * │ tab_navigation │ Tab/section switch │
 * │ input_change │ Form input changed (debounced 2s) │
 * │ ui_interaction │ Structured UI interaction │
 * │ funnel_step │ Conversion funnel progression │
 * ├──────────────────────┼──────────────────────────────────────┤
 * │ APP-SPECIFIC — Feature usage │
 * ├──────────────────────┼──────────────────────────────────────┤
 * │ currency_exchange │ CHF/EUR converter actions │
 * │ health_insurance │ LAMal comparator actions │
 * │ bank_comparison │ Bank comparator actions │
 * │ mobile_operator │ Mobile plan comparator │
 * │ job_comparison │ Job offer comparator │
 * │ transport_calc │ Commute cost calculator │
 * │ pension_planner │ Pension projection actions │
 * │ pillar3_simulator │ 3rd pillar simulator │
 * │ tax_calendar │ Tax deadline calendar │
 * │ work_permits │ Permit guide interactions │
 * │ whatif_simulator │ What-if scenario simulator │
 * │ guide_interaction │ Guide section navigation │
 * │ municipality_view │ Municipality detail view │
 * │ chart_interaction │ Chart/graph interaction │
 * │ map_interaction │ Map click/pan/zoom │
 * │ border_filter │ Border crossing filter │
 * │ border_time_select │ Traffic time slot selection │
 * │ traffic_alerts │ Border traffic monitoring │
 * │ outbound_click │ External link clicked │
 * ├──────────────────────┼──────────────────────────────────────┤
 * │ APP-SPECIFIC — Meta/settings │
 * ├──────────────────────┼──────────────────────────────────────┤
 * │ settings_change │ User preference change │
 * │ toggle_focus_mode │ Focus mode on/off │
 * │ expense_action │ Expense add/edit/delete │
 * │ newsletter │ Newsletter subscribe/unsubscribe │
 * │ feedback │ User feedback submit │
 * │ consent_update │ Cookie consent change │
 * │ chatbot_funnel │ AI chatbot auth/conversion steps │
 * │ chatbot_usage │ AI chatbot usage telemetry │
 * │ chatbot_question │ AI questions (sanitized text) │
 * │ api_diagnostics │ API health check │
 * │ app_error │ App error with rich context │
 * │ error_page_view │ Error page shown (health metric) │
 * ├──────────────────────┼──────────────────────────────────────┤
 * │ RESOURCE & RELOAD HEALTH │
 * ├──────────────────────┼──────────────────────────────────────┤
 * │ force_reload │ Forced page reload (with source) │
 * │ resource_load_error │ JS/CSS resource failed to load │
 * │ css_fallback │ CSS fallback timer activated media │
 * │ chunk_retry │ Lazy chunk import retried │
 * └──────────────────────┴──────────────────────────────────────┘
 *
 * DESIGN PRINCIPLES:
 * 1. Each user action fires ONE primary event (no double-fires)
 * 2. generate_lead is reserved for simulation_complete ONLY (core KPI)
 * 3. input_change is debounced (2s) to prevent event flooding
 * 4. cta_click (global) is throttled (500ms) to reduce noise
 * 5. Composite methods (trackTabNavigation, etc.) do NOT re-fire page_view
 * — App.tsx handles page_view on navigation centrally
 * 6. Attribution is captured once per session, not on every page_view
 */

import { deriveAnalyticsPageContext } from './analyticsPageContext';
import { captureEvent as posthogCapture, capturePageView as posthogPageView } from './posthog';

// ─── Clarity Bridge ────────────────────────────────────────────
// Tag Clarity sessions with custom events for cross-tool analysis.
// Clarity's JS API: clarity('set', key, value) and clarity('event', name).
// These are no-ops if Clarity hasn't loaded (consent denied, dev, ad-blocked).

function tagClarity(key: string, value: string): void {
 try {
 const c = (window as any).clarity;
 if (typeof c === 'function') {
 c('set', key, value);
 }
 } catch { /* Clarity not available — silent */ }
}

// ─── Lazy Firebase Loading ─────────────────────────────────────

let _analytics: any = null;
let _logEvent: any = null;
let _setUserProperties: any = null;
let _firebaseLoading: Promise<void> | null = null;
const ANALYTICS_DEBUG_LOG = import.meta.env.DEV && import.meta.env.MODE !== 'test';

async function ensureFirebase(): Promise<void> {
 if (_analytics) return;
 if (_firebaseLoading) return _firebaseLoading;
 _firebaseLoading = (async () => {
 try {
 const [firebaseModule, analyticsModule] = await Promise.all([
 import('./firebase'),
 import('firebase/analytics'),
 ]);
 // Use the async getter to ensure the real analytics instance is ready
 // (the sync proxy can race and cause 'options' is undefined errors)
 const realAnalytics = await firebaseModule.getAnalytics();
 if (realAnalytics) {
 _analytics = realAnalytics;
 _logEvent = analyticsModule.logEvent;
 _setUserProperties = analyticsModule.setUserProperties;
 }
 } catch (error) {
 if (ANALYTICS_DEBUG_LOG) {
 console.warn('[Analytics] Failed to load Firebase', error);
 }
 }
 })();
 return _firebaseLoading;
}

// ─── iOS Safari IndexedDB Recovery ─────────────────────────────
// Firebase Analytics internally uses IndexedDB for event persistence.
// On iOS Safari, the WebKit networking process can crash when the page
// is suspended/resumed, leaving the IDB connection dead. This recovery
// mechanism re-creates the Analytics instance so events continue flowing.

let _idbRecoveryAttempts = 0;
const MAX_IDB_RECOVERY_ATTEMPTS = 3;

async function recoverFromIndexedDbLoss(): Promise<void> {
 if (_idbRecoveryAttempts >= MAX_IDB_RECOVERY_ATTEMPTS) {
 if (ANALYTICS_DEBUG_LOG) {
 console.warn('[Analytics] IndexedDB recovery exhausted — analytics offline for this session');
 }
 return;
 }
 _idbRecoveryAttempts++;

 try {
 const { resetAnalytics } = await import('./firebase');
 // Also reset Firestore's cached connection — the same IDB loss affects it
 const { resetFirestoreConnection } = await import('./firestoreService');
 resetFirestoreConnection();
 const newInstance = await resetAnalytics();
 if (newInstance) {
 _analytics = newInstance;
 // Re-import logEvent/setUserProperties to bind to the fresh instance
 const analyticsModule = await import('firebase/analytics');
 _logEvent = analyticsModule.logEvent;
 _setUserProperties = analyticsModule.setUserProperties;
 _firebaseReady = true;
 // Flush any events that were queued during the outage
 flushQueue();
 if (ANALYTICS_DEBUG_LOG) {
 console.info(`[Analytics] IndexedDB recovery succeeded (attempt ${_idbRecoveryAttempts})`);
 }
 }
 } catch {
 if (ANALYTICS_DEBUG_LOG) {
 console.warn(`[Analytics] IndexedDB recovery attempt ${_idbRecoveryAttempts} failed`);
 }
 }
}

// ─── Core Helper ───────────────────────────────────────────────

// Queue events that fire before Firebase is loaded
const _eventQueue: Array<{ type: 'log' | 'props'; args: any[] }> = [];
let _firebaseReady = false;

function flushQueue() {
 if (!_firebaseReady) return;
 while (_eventQueue.length > 0) {
 const event = _eventQueue.shift()!;
 if (event.type === 'log') {
 _doLog(event.args[0], event.args[1]);
 } else {
 _doSetProps(event.args[0]);
 }
 }
}

function _doLog(eventName: string, params?: Record<string, any>) {
 try {
 if (_analytics && _logEvent) {
 _logEvent(_analytics, eventName as any, params);
 }
 } catch (error) {
 const msg = error instanceof Error ? error.message : '';
 // If logEvent failed due to IndexedDB loss, re-queue the event and attempt recovery
 if (msg.includes('Indexed Database') || msg.includes('IDBDatabase') || msg.includes('IndexedDB')) {
 _eventQueue.push({ type: 'log', args: [eventName, params] });
 recoverFromIndexedDbLoss();
 return;
 }
 if (ANALYTICS_DEBUG_LOG) {
 console.warn(`[Analytics] ${eventName}`, params, error);
 }
 }
}

function _doSetProps(properties: Record<string, string>) {
 try {
 if (_analytics && _setUserProperties) {
 _setUserProperties(_analytics, properties);
 }
 } catch (error) {
 const msg = error instanceof Error ? error.message : '';
 if (msg.includes('Indexed Database') || msg.includes('IDBDatabase') || msg.includes('IndexedDB')) {
 _eventQueue.push({ type: 'props', args: [properties] });
 recoverFromIndexedDbLoss();
 }
 }
}

const log = (eventName: string, params?: Record<string, any>) => {
 // Mirror to PostHog (fire-and-forget, independent of Firebase)
 if (eventName === 'page_view') {
 posthogPageView(params?.page_path || window.location.pathname, params?.page_title);
 } else {
 posthogCapture(eventName, params);
 }

 if (_firebaseReady) {
 _doLog(eventName, params);
 } else {
 _eventQueue.push({ type: 'log', args: [eventName, params] });
 // Trigger lazy load — only mark ready when Firebase actually loaded
 ensureFirebase().then(() => {
 if (_analytics && _logEvent) {
 _firebaseReady = true;
 flushQueue();
 } else {
 // Firebase failed to load (ad blocker) — discard queued events
 // to prevent them from accumulating indefinitely.
 _eventQueue.length = 0;
 }
 });
 }
};

const setProps = (properties: Record<string, string>) => {
 if (_firebaseReady) {
 _doSetProps(properties);
 } else {
 _eventQueue.push({ type: 'props', args: [properties] });
 ensureFirebase().then(() => {
 if (_analytics && _logEvent) {
 _firebaseReady = true;
 flushQueue();
 } else {
 _eventQueue.length = 0;
 }
 });
 }
};

// ─── Engagement Tracking ────────────────────────────────────────

let sessionStartTime = Date.now();
let currentScreen = '/';
let previousScreen = '';
let lastTrackedPagePath = '';
let lastTrackedPageAt = 0;
let _maxScrollDepth = 0;
const ATTRIBUTION_KEY = 'ft_attribution_v1';
const ATTRIBUTION_LOGGED_KEY = 'ft_attribution_logged_v1';

const getEngagementTime = () => Math.round((Date.now() - sessionStartTime) / 1000);

type AttributionContext = {
 source: string;
 medium: string;
 campaign: string;
 term: string;
 content: string;
 referrer_host: string;
 landing_path: string;
 click_id: string;
};

const truncate = (v: string, max = 120): string => v.slice(0, max);

// ─── Error Tracking Helpers ────────────────────────────────────

/** Session-level error counter for detecting cascading failures */
let sessionErrorCount = 0;

/**
 * Decode React production "Minified React error" messages into human-readable form.
 * React 18/19 production builds replace error messages with codes like:
 * "Minified React error #31; visit https://react.dev/errors/31 for the full message..."
 * This map covers the most common production errors.
 */
const REACT_ERROR_CODES: Record<number, string> = {
 31: 'Objects are not valid as a React child',
 130: 'Element type is invalid: expected a string or class/function but got undefined/null',
 152: 'Nothing was returned from render',
 185: 'Maximum update depth exceeded (infinite re-render loop)',
 286: 'Component suspended while the fallback boundary was already showing',
 310: 'Rendered more hooks than during the previous render',
 321: 'useContext requires a valid React context (got undefined)',
 362: 'Hooks can only be called inside the body of a function component',
 394: 'Cannot call a class as a function',
 418: 'Hydration failed because the server-rendered HTML didn\'t match the client',
 421: 'This Suspense boundary received an update before it finished hydrating',
 422: 'Server-rendered HTML was replaced by client rendering',
 423: 'Text content mismatch between server and client',
 425: 'Entire root switched to client rendering (hydration bail-out)',
 426: 'Switched to client rendering because the server-rendered HTML was replaced',
};

/**
 * Decode a React minified error message into a human-readable version.
 * Input: "Minified React error #310; visit https://react.dev/errors/310 for the full message..."
 * Output: "React#310: Cannot update a component from inside the function body of a different component"
 * If not a React error, returns the original message unchanged.
 */
export function decodeReactError(message: string): string {
 if (!message) return message;
 const match = message.match(/Minified React error #(\d+)/);
 if (!match) return message;
 const code = parseInt(match[1], 10);
 const decoded = REACT_ERROR_CODES[code];
 return decoded
 ? `React#${code}: ${decoded}`
 : `React#${code}: (unknown — see https://react.dev/errors/${code})`;
}

/**
 * Extract meaningful app frames from a (potentially minified) stack trace.
 * Filters out node_modules, browser internals, webpack, and chunk loader frames.
 * Returns the first 3 relevant frames as "file:line:col → ..." (max 200 chars).
 */
export function extractAppFrames(stack: string): string {
 if (!stack) return '';
 const lines = stack.split('\n');
 const appFrames: string[] = [];

 // Patterns that identify our source code in the stack
 const appPatterns = [/src\//, /components\//, /services\//, /\/assets\//, /frontaliereticino\.ch/];
 // Patterns to exclude (third-party, browser internals)
 const excludePatterns = [/node_modules/, /webpack/, /chunk-[A-Za-z0-9]+\.js/, /<anonymous>/, /^Error/, /native code/];

 for (const line of lines) {
 const trimmed = line.trim();
 if (!trimmed.startsWith('at ') && !trimmed.match(/^\w+@/)) continue;
 if (excludePatterns.some(p => p.test(trimmed))) continue;
 if (!appPatterns.some(p => p.test(trimmed))) continue;

 // Extract file:line:col from formats like:
 // at functionName (file.ts:10:5)
 // at file.ts:10:5
 // functionName@file.ts:10:5
 const match = trimmed.match(/(?:at\s+)?(?:.*?\s+\()?([^()]+?):(\d+):(\d+)\)?$/);
 if (match) {
 const file = match[1].replace(/^.*\//, ''); // basename only
 appFrames.push(`${file}:${match[2]}:${match[3]}`);
 }
 if (appFrames.length >= 3) break;
 }

 return appFrames.join(' → ').slice(0, 200);
}

/**
 * Lightweight browser name + version extraction from user agent string.
 * Returns e.g. "Chrome/125", "Safari/17.5", "Firefox/126", "Edge/125".
 * No external dependency — just regex matching on the most common browsers.
 */
export function parseBrowserInfo(ua: string): string {
 if (!ua) return 'unknown';
 // Order matters: check specific browsers before generic ones
 const patterns: [RegExp, string][] = [
 [/EdgA?\/(\d+[\d.]*)/, 'Edge'],
 [/OPR\/(\d+[\d.]*)/, 'Opera'],
 [/SamsungBrowser\/(\d+[\d.]*)/, 'Samsung'],
 [/UCBrowser\/(\d+[\d.]*)/, 'UCBrowser'],
 [/CriOS\/(\d+[\d.]*)/, 'Chrome-iOS'],
 [/FxiOS\/(\d+[\d.]*)/, 'Firefox-iOS'],
 [/Chrome\/(\d+[\d.]*)/, 'Chrome'],
 [/Firefox\/(\d+[\d.]*)/, 'Firefox'],
 [/Version\/(\d+[\d.]*).*Safari/, 'Safari'],
 [/MSIE\s(\d+[\d.]*)/, 'IE'],
 [/Trident.*rv:(\d+[\d.]*)/, 'IE'],
 ];
 for (const [re, name] of patterns) {
 const m = ua.match(re);
 if (m) return `${name}/${m[1]}`;
 }
 return 'other';
}

/**
 * Get Microsoft Clarity session ID for cross-referencing with session replays.
 * Returns null if Clarity isn't loaded or the API isn't available.
 */
function getClaritySessionId(): string | null {
 try {
 const c = (window as any).clarity;
 if (typeof c !== 'function') return null;
 // Clarity v0.7+ exposes session ID via the 'get' command
 const result = c('get', 'id');
 if (typeof result === 'string' && result.length > 0) return result;
 } catch { /* Clarity not available */ }
 return null;
}

/**
 * Derive the active section/tab from the current URL path.
 * Returns a human-readable section name (e.g. "calculator", "job-board", "guide/permits").
 */
function deriveActiveSection(): string {
 try {
 const path = window.location.pathname;
 // Remove locale prefix (e.g. /en/, /de/, /fr/)
 const stripped = path.replace(/^\/(en|de|fr)\//, '/');
 // Take first 2 meaningful path segments
 const segments = stripped.split('/').filter(Boolean).slice(0, 2);
 return segments.join('/') || 'home';
 } catch {
 return 'unknown';
 }
}

function sanitizeChatbotQuestion(raw: string): string {
 return truncate(
 String(raw || '')
 .replace(/\s+/g, ' ')
 .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
 .replace(/\bhttps?:\/\/\S+/gi, '[url]')
 .replace(/\b(?:\+?\d[\s().-]?){7,}\d\b/g, '[phone]')
 .trim(),
 180
 );
}

function detectOrganicMedium(host: string): string {
 if (!host) return 'direct';
 const h = host.toLowerCase();
 // Filter self-referrals: treat our own domain and localhost as direct traffic
 if (h.includes('frontaliereticino.ch') || h === 'localhost' || h.startsWith('127.0.0.') || h.startsWith('192.168.')) return 'direct';
 if (h.includes('google.') || h.includes('bing.') || h.includes('duckduckgo.') || h.includes('yahoo.')) return 'organic';
 if (h.includes('facebook.') || h.includes('instagram.') || h.includes('t.co') || h.includes('twitter.') || h.includes('linkedin.')) return 'social';
 if (h.includes('reddit.') || h.includes('threads.')) return 'social';
 if (h.includes('chat.openai.') || h.includes('chatgpt.')) return 'ai';
 return 'referral';
}

function captureAttribution(): AttributionContext {
 const params = new URLSearchParams(window.location.search);
 const clickId = params.get('gclid')
 || params.get('fbclid')
 || params.get('msclkid')
 || params.get('ttclid')
 || params.get('wbraid')
 || params.get('gbraid')
 || '';

 const refHost = (() => {
 try {
 if (!document.referrer) return '';
 const host = new URL(document.referrer).hostname;
 // Filter self-referrals
 if (host.includes('frontaliereticino.ch') || host === 'localhost' || host.startsWith('127.0.0.') || host.startsWith('192.168.')) return '';
 return host;
 } catch { return ''; }
 })();

 const incoming: AttributionContext = {
 source: truncate(params.get('utm_source') || (refHost || 'direct'), 60),
 medium: truncate(params.get('utm_medium') || detectOrganicMedium(refHost), 40),
 campaign: truncate(params.get('utm_campaign') || '(none)', 80),
 term: truncate(params.get('utm_term') || '(none)', 80),
 content: truncate(params.get('utm_content') || '(none)', 80),
 referrer_host: truncate(refHost || 'direct', 80),
 landing_path: truncate(`${window.location.pathname}${window.location.search}`, 180),
 click_id: truncate(clickId || '(none)', 120),
 };

 try {
 const hasUtm = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']
 .some((k) => params.has(k));
 const hasClickId = Boolean(clickId);
 if (hasUtm || hasClickId) {
 sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(incoming));
 return incoming;
 }
 const raw = sessionStorage.getItem(ATTRIBUTION_KEY);
 if (raw) return JSON.parse(raw) as AttributionContext;
 } catch {
 // ignore storage issues
 }
 return incoming;
}

function getElementLabel(el: Element): string {
 const explicit = el.getAttribute('data-analytics-label');
 if (explicit) return truncate(explicit, 100);
 const aria = el.getAttribute('aria-label');
 if (aria) return truncate(aria, 100);
 const title = el.getAttribute('title');
 if (title) return truncate(title, 100);
 const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
 return truncate(text || 'unknown', 100);
}

function bindGlobalInteractionTracking() {
 // Throttle cta_click to max 1 event per 500ms to prevent event flooding
 let lastCtaAt = 0;
 const CTA_THROTTLE_MS = 500;

 const onClick = (event: Event) => {
 const now = Date.now();
 if (now - lastCtaAt < CTA_THROTTLE_MS) return;
 const target = event.target as HTMLElement | null;
 if (!target) return;
 const actionable = target.closest('a,button,[role="button"],input[type="submit"]') as HTMLElement | null;

 // Dead-click detection: user clicked on a non-interactive element
 // that visually looks clickable (has pointer cursor, card-like styling, etc.)
 if (!actionable) {
 detectDeadClick(target);
 return;
 }

 lastCtaAt = now;
 const tag = actionable.tagName.toLowerCase();
 const href = actionable instanceof HTMLAnchorElement ? actionable.href : '';
 const internal = href ? href.startsWith(window.location.origin) : false;
 const label = getElementLabel(actionable);
 const pageCtx = deriveAnalyticsPageContext(window.location.pathname);
 log('cta_click', {
 page_path: truncate(`${window.location.pathname}${window.location.search}`, 180),
 page_template: pageCtx.pageTemplate,
 content_group: pageCtx.contentGroup,
 element_tag: tag,
 element_id: truncate(actionable.id || '(none)', 80),
 element_label: label,
 target_type: href ? (internal ? 'internal_link' : 'external_link') : 'ui_action',
 link_host: href ? truncate((() => { try { return new URL(href).hostname; } catch { return ''; } })() || '(none)', 80) : '(none)',
 });
 // Bridge to Clarity
 tagClarity('cta', `${tag}_${truncate(label, 30)}`);
 };

 const onSubmit = (event: Event) => {
 const form = event.target as HTMLFormElement | null;
 if (!form || form.tagName.toLowerCase() !== 'form') return;
 log('form_submit', {
 page_path: truncate(`${window.location.pathname}${window.location.search}`, 180),
 form_id: truncate(form.id || '(none)', 80),
 form_name: truncate(form.getAttribute('name') || '(none)', 80),
 input_count: form.querySelectorAll('input,select,textarea').length,
 });
 };

 document.addEventListener('click', onClick, true);
 document.addEventListener('submit', onSubmit, true);
}

// Dead-click detection: clicks on elements that look interactive but aren't.
// Throttled to max 3 per page to avoid noise.
let _deadClickCount = 0;
function detectDeadClick(target: HTMLElement): void {
 if (_deadClickCount >= 3) return;
 // Check if the element has pointer cursor or card-like appearance
 const style = window.getComputedStyle(target);
 const looksClickable = style.cursor === 'pointer'
 || target.classList.contains('cursor-pointer')
 || target.closest('[class*="card"]') !== null
 || target.closest('[class*="banner"]') !== null;
 if (!looksClickable) return;
 _deadClickCount++;
 const pageCtx = deriveAnalyticsPageContext(window.location.pathname);
 log('dead_click', {
 page_path: truncate(`${window.location.pathname}`, 180),
 page_template: pageCtx.pageTemplate,
 element_tag: target.tagName.toLowerCase(),
 element_text: truncate((target.textContent || '').trim(), 50),
 element_classes: truncate(typeof target.className === 'string' ? target.className : '', 80),
 cursor_style: style.cursor,
 });
 tagClarity('dead_click', `${target.tagName.toLowerCase()}_${pageCtx.pageTemplate}`);
}

// ─── Main Analytics Object ──────────────────────────────────────

export const Analytics = {
 isInitialized: false,

 /**
 * Inizializza Analytics e imposta user properties base
 */
 init: () => {
 if (Analytics.isInitialized) return;
 
 Analytics.isInitialized = true;
 sessionStartTime = Date.now();
 
 // User properties automatiche
 setProps({
 app_version: '2.0',
 platform: 'web',
 locale: navigator.language || 'it-IT',
 });
 const attribution = captureAttribution();
 setProps({
 traffic_source: attribution.source || 'direct',
 traffic_medium: attribution.medium || 'direct',
 traffic_campaign: attribution.campaign || '(none)',
 });
 try {
 if (!sessionStorage.getItem(ATTRIBUTION_LOGGED_KEY)) {
 log('traffic_attribution', attribution);
 sessionStorage.setItem(ATTRIBUTION_LOGGED_KEY, '1');
 }
 } catch {
 log('traffic_attribution', attribution);
 }
 bindGlobalInteractionTracking();

 // Scroll depth tracking — uses module-level _maxScrollDepth
 // which is reset on each trackPageView() call for correct per-page tracking
 const onScroll = () => {
 const docHeight = document.documentElement.scrollHeight - window.innerHeight;
 if (docHeight <= 0) return;
 const scrollPercent = Math.round((window.scrollY / docHeight) * 100);
 if (scrollPercent > _maxScrollDepth) {
 _maxScrollDepth = scrollPercent;
 // Log at quarters: 25%, 50%, 75%, 100%
 if ([25, 50, 75, 100].includes(_maxScrollDepth)) {
 const pageCtx = deriveAnalyticsPageContext(currentScreen);
 const isMobile = (window.innerWidth || screen.width) < 768 && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
 log('scroll_depth', {
 percent_scrolled: _maxScrollDepth,
 page_path: currentScreen,
 page_template: pageCtx.pageTemplate,
 content_group: pageCtx.contentGroup,
 device_type: isMobile ? 'mobile' : 'desktop',
 screen_width: window.innerWidth || 0,
 doc_height: document.documentElement.scrollHeight,
 });
 // Bridge to Clarity — tag session with scroll milestone
 tagClarity('scroll', `${_maxScrollDepth}pct_${pageCtx.pageTemplate}`);
 }
 }
 };
 window.addEventListener('scroll', onScroll, { passive: true });

 // Session end tracking (pagehide keeps bfcache eligible)
 window.addEventListener('pagehide', () => {
 log('session_end', {
 engagement_time_sec: getEngagementTime(),
 page_path: currentScreen,
 });
 });

 console.log('✅ Firebase Analytics initialized');
 },

 // ─── GA4 Recommended Events ─────────────────────────────────

 /**
 * page_view — GA4 recommended event for web page navigation.
 * Fires ONLY page_view (not screen_view — that's for mobile apps).
 * Attribution is captured once per session via traffic_attribution,
 * not repeated on every page_view to keep events clean.
 *
 * BOUNCE CAPTURE: Static HTML pages include a lightweight gtag.js snippet
 * that fires page_view immediately on load (to capture sessions that bounce
 * before React hydrates). Firebase also fires page_view unconditionally so
 * that sessions where gtag.js is blocked (ad blockers, ~30-40% of users)
 * still have a page_view with correct page_location in GA4.
 * This means non-blocked users get a duplicate page_view (gtag + Firebase)
 * on the initial page, which is a minor metric inflation but correct.
 */
 trackPageView: (path: string, title?: string) => {
 const now = Date.now();
 if (path === lastTrackedPagePath && now - lastTrackedPageAt < 500) return;
 // NOTE: We intentionally do NOT skip Firebase page_view even when
 // window.__GTAG_PAGE_VIEW_SENT__ is set by static HTML pages.
 //
 // The flag is set synchronously by the inline GTAG_SNIPPET before gtag.js
 // loads (gtag.js is async). When gtag.js is blocked by an ad blocker or
 // privacy browser (~30-40% of users), the flag is set but gtag never fires
 // page_view. Other Firebase events (e.g. funnel_step) still fire, creating
 // a GA4 session with no page_view → landing page = "(not set)".
 //
 // By always firing the Firebase page_view, we ensure every session has a
 // page_view with correct page_location. Non-blocked users get a duplicate
 // page_view (gtag + Firebase), which is a minor metric inflation but far
 // better than 25% of sessions having "(not set)" landing page.
 //
 // The flag is cleared here so it doesn't interfere with any future code.
 const w = window as unknown as Record<string, unknown>;
 if (w.__GTAG_PAGE_VIEW_SENT__) {
 delete w.__GTAG_PAGE_VIEW_SENT__;
 }
 // Calculate time spent on previous page (for pagesPerSession accuracy)
 const timeOnPrevPage = previousScreen ? now - lastTrackedPageAt : 0;
 lastTrackedPagePath = path;
 lastTrackedPageAt = now;
 previousScreen = currentScreen;
 currentScreen = path;
 _maxScrollDepth = 0; // Reset scroll tracking for new page
 const pageContext = deriveAnalyticsPageContext(path);
 log('page_view', {
 page_path: path,
 page_title: title || path,
 page_location: window.location.origin + path,
 previous_page: previousScreen || '(none)',
 page_template: pageContext.pageTemplate,
 content_group: pageContext.contentGroup,
 site_section: pageContext.siteSection,
 content_locale: pageContext.contentLocale,
 route_family: pageContext.routeFamily,
 engagement_time_msec: timeOnPrevPage > 0 ? Math.min(timeOnPrevPage, 3600000) : undefined,
 });
 // Bridge: tag Clarity session with page template for filtering
 tagClarity('page_template', pageContext.pageTemplate);
 tagClarity('content_group', pageContext.contentGroup);
 // Reset dead-click counter for new page
 _deadClickCount = 0;
 },

 /**
 * Affiliate click — tracks partner clicks with context for revenue attribution
 */
 trackAffiliateClick: (partnerId: string, context: string) => {
 log('affiliate_click', {
 partner_id: partnerId,
 context,
 content_type: 'affiliate',
 item_id: `${partnerId}_${context}`,
 });
 },

 /**
 * select_content — evento raccomandato GA4
 */
 trackSelectContent: (contentType: string, itemId: string) => {
 log('select_content', {
 content_type: contentType,
 item_id: itemId,
 });
 },

 /**
 * share — evento raccomandato GA4
 */
 trackShare: (method: string, contentType: string, itemId?: string) => {
 log('share', {
 method,
 content_type: contentType,
 item_id: itemId,
 });
 },

 /**
 * search — evento raccomandato GA4
 */
 trackSearch: (
 searchTerm: string,
 options: {
 resultsCount?: number;
 searchSource?: string;
 } = {}
 ) => {
 const pageContext = deriveAnalyticsPageContext(`${window.location.pathname}${window.location.search}`);
 log('search', {
 search_term: searchTerm,
 search_results_count: options.resultsCount,
 search_origin: options.searchSource || pageContext.pageTemplate,
 page_template: pageContext.pageTemplate,
 content_group: pageContext.contentGroup,
 site_section: pageContext.siteSection,
 content_locale: pageContext.contentLocale,
 route_family: pageContext.routeFamily,
 });
 },

 /**
 * generate_lead — evento raccomandato GA4 (utente completa una simulazione)
 */
 trackGenerateLead: (value?: number, currency: string = 'CHF') => {
 log('generate_lead', { value, currency });
 },

 /**
 * @deprecated Use reportCaughtError() from '@/services/errorReporter' instead.
 * Kept as safety net: delegates to trackAppError so stray callers still get rich data.
 */
 trackError: (description: string, fatal: boolean = false) => {
 log('exception', { description, fatal });
 Analytics.trackAppError('api_error', {
 message: description,
 fatal,
 pagePath: typeof window !== 'undefined' ? window.location.pathname : undefined,
 });
 },

 /**
 * Comprehensive error tracking — sends to GA4 with rich context.
 * Visible in Firebase Console → Analytics → Events → app_error
 *
 * @param type Category of error (used as event param for filtering/grouping)
 * @param info Structured error details
 */
 trackAppError: (
 type:
 | 'error_boundary'
 | 'chunk_load'
 | 'unhandled_error'
 | 'unhandled_rejection'
 | 'page_404'
 | 'api_error'
 | 'resource_load'
 | 'sw_cache_stale'
 | 'cross_origin_script',
 info: {
 message?: string;
 stack?: string;
 componentStack?: string;
 pagePath?: string;
 pageTitle?: string;
 fatal?: boolean;
 resourceUrl?: string;
 statusCode?: number;
 apiEndpoint?: string;
 apiMethod?: string;
 errorFingerprint?: string;
 referrer?: string;
 sessionRedirect?: string;
 } = {}
 ) => {
 const pagePath = info.pagePath || (typeof window !== 'undefined'
 ? `${window.location.pathname}${window.location.search}`
 : '/');

 // Decode React minified errors (e.g., "Minified React error #310" → human-readable)
 const decodedMessage = decodeReactError(info.message || 'unknown');

 // GA4 recommended exception event — include error_type and error_message
 // so the Data API can query them regardless of which event name is used.
 log('exception', {
 description: truncate(`[${type}] ${decodedMessage}`, 150),
 fatal: info.fatal ?? false,
 error_type: type,
 error_message: truncate(decodedMessage, 100),
 });

 // Increment session error counter for cascade detection
 sessionErrorCount++;

 // Custom event with rich context for Firebase Console dashboards
 log('app_error', {
 error_type: type || 'uncategorized',
 error_message: truncate(decodedMessage, 200),
 error_stack: truncate(info.stack || '', 500),
 error_source: extractAppFrames(info.stack || ''),
 page_path: truncate(pagePath, 180),
 page_title: truncate(info.pageTitle || document.title || '', 80),
 is_fatal: info.fatal ?? false,
 resource_url: truncate(info.resourceUrl || '', 200),
 // PostHog canonical keys for api_error dashboards — MUST be non-null
 // even when the underlying info fields are absent. Callers that know
 // the endpoint/status/method should always populate info.apiEndpoint,
 // info.statusCode, and info.apiMethod — see errorReporter.reportCaughtError().
 endpoint: truncate(info.apiEndpoint || info.resourceUrl || '(unknown)', 100),
 status: info.statusCode ?? 0,
 method: truncate(info.apiMethod || '(unknown)', 20),
 // Legacy GA4 aliases (kept for backwards-compat with existing reports)
 status_code: info.statusCode ?? 0,
 api_endpoint: truncate(info.apiEndpoint || '', 100),
 api_method: truncate(info.apiMethod || '', 20),
 component_stack: truncate(info.componentStack || '', 200),
 active_section: deriveActiveSection(),
 locale: document.documentElement.lang || navigator.language || 'unknown',
 browser_info: parseBrowserInfo(navigator.userAgent || ''),
 clarity_session_id: getClaritySessionId() || '',
 session_error_sequence: sessionErrorCount,
 user_agent: truncate(navigator.userAgent || '', 150),
 connection_type: truncate(
 (navigator as any).connection?.effectiveType || 'unknown',
 20
 ),
 screen_width: window.innerWidth || 0,
 screen_height: window.innerHeight || 0,
 error_fingerprint: info.errorFingerprint || '',
 referrer: truncate(info.referrer || '', 200),
 session_redirect: truncate(info.sessionRedirect || '', 200),
 timestamp: new Date().toISOString(),
 });
 },

 /**
 * Track when the error boundary page is DISPLAYED to the user.
 * This is the key health metric: if error_page_view events increase,
 * the site is becoming unhealthier.
 *
 * - GA4 event: error_page_view (filterable by page_path, session count)
 * - User property: error_session_count (enables GA4 audience segmentation
 * e.g. "users who saw 2+ errors" → cohort analysis)
 * - Session counter stored in sessionStorage to track error rate per visit
 *
 * Use in GA4:
 * Explore → Free form → Metric: error_page_view event count
 * Real-time → filter event = error_page_view
 * Custom report: error_page_view trend over time = site health score
 */
 trackErrorPageView: (errorDigest?: string) => {
 const key = 'ft_error_page_count';
 let count = 0;
 try { count = parseInt(sessionStorage.getItem(key) || '0', 10) || 0; } catch {}
 count++;
 try { sessionStorage.setItem(key, String(count)); } catch {}

 log('error_page_view', {
 page_path: truncate(`${window.location.pathname}${window.location.search}`, 180),
 page_title: truncate(document.title || '', 80),
 session_error_count: count,
 error_fingerprint: errorDigest || '',
 referrer_path: truncate(previousScreen || '/', 180),
 user_agent: truncate(navigator.userAgent || '', 150),
 connection_type: truncate(
 (navigator as any).connection?.effectiveType || 'unknown',
 20
 ),
 timestamp: new Date().toISOString(),
 });

 // User property for GA4 audience segmentation & health dashboards
 setProps({ error_session_count: String(count) });
 },

 /**
 * Set up global error listeners (window error + unhandled rejections).
 * Call once from App.tsx after Analytics.init().
 */
 initGlobalErrorTracking: () => {
 // Uncaught JS errors
 window.addEventListener('error', (event) => {
 // Skip resource load errors (handled separately by chunk-load recovery)
 if (event.target && (event.target as any).tagName) return;
 const msg = event.message || '';
 // Skip third-party tracker/extension errors — not our code
 if (msg.includes('TrackerStorageType') || msg.includes('__gCrWeb')) return;
 // iOS Safari IndexedDB errors can also surface as plain errors (not just rejections)
 if (msg.includes('Indexed Database') || msg.includes('IDBDatabase') || msg.includes('IndexedDB')) {
 recoverFromIndexedDbLoss();
 return;
 }
 // Drop cross-origin "Script error" — opaque by design (browser CORS blocks
 // the stack and message). Tracking them costs ~50% of total GA4 errors with
 // zero diagnostic value (May 2026 audit: 1,783/3,543).
 if (!msg || msg === 'Script error.' || msg === 'Script error') return;
 // Drop ResizeObserver loop notifications — browser-internal layout signal,
 // not a bug. (22+/3,543 in May 2026 audit.)
 if (/ResizeObserver loop/i.test(msg)) return;
 Analytics.trackAppError('unhandled_error', {
 message: msg || 'Unknown error',
 stack: event.error?.stack || `at ${event.filename}:${event.lineno}:${event.colno}`,
 pagePath: window.location.pathname + window.location.search,
 fatal: true,
 });
 });

 // Unhandled promise rejections
 window.addEventListener('unhandledrejection', (event) => {
 const reason = event.reason;
 const message = reason instanceof Error
 ? `${reason.name}: ${reason.message}`
 : String(reason || 'Unknown rejection');
 // iOS Safari IndexedDB connection loss (WebKit bug 273827 / 277615):
 // Firebase Analytics uses IndexedDB internally for event persistence.
 // When iOS suspends/resumes the page, the IDB connection can die.
 // Instead of silently dropping events, attempt to re-initialize Analytics.
 if (message.includes('Indexed Database server lost') || message.includes('IDBDatabase')
 || message.includes('Internal error was encountered in the Indexed Database')
 || message.includes('Refusing to open IndexedDB')) {
 event.preventDefault();
 recoverFromIndexedDbLoss();
 return;
 }
 // Suppress third-party tracker errors
 if (message.includes('TrackerStorageType')) return;
 // Benign noise — same deny-list rationale as services/errorReporter.ts.
 // Module-script preload failures, ResizeObserver loop, and "Script error"
 // shapes account for the bulk of unactionable rejections.
 if (/Importing a module script failed/i.test(message)) return;
 if (/ResizeObserver loop/i.test(message)) return;
 if (/^(Error: )?Script error\.?$/i.test(message)) return;
 const stack = reason instanceof Error ? reason.stack || '' : '';
 Analytics.trackAppError('unhandled_rejection', {
 message,
 stack,
 pagePath: window.location.pathname + window.location.search,
 fatal: false,
 });
 });

 // Check if we're recovering from a stale SW cache reload (set by index.html)
 try {
 const pending = sessionStorage.getItem('_swErrorInfo');
 if (pending) {
 sessionStorage.removeItem('_swErrorInfo');
 const info = JSON.parse(pending);
 Analytics.trackAppError('sw_cache_stale', {
 message: `Stale chunk: ${info.resource || 'unknown'}`,
 resourceUrl: info.resource,
 pagePath: info.pagePath || '/',
 fatal: true,
 });
 }
 } catch { /* ignore */ }

 // Report stored force_reload events (queued by index.html before React boots)
 try {
 const reloadInfo = sessionStorage.getItem('_forceReloadInfo');
 if (reloadInfo) {
 sessionStorage.removeItem('_forceReloadInfo');
 const info = JSON.parse(reloadInfo);
 Analytics.trackForceReload({
 source: info.source || 'index_html',
 reason: info.reason || 'unknown',
 resourceUrl: info.resource || '',
 reloadCount: info.reloadCount || 1,
 pagePath: info.pagePath || '/',
 blocked: false,
 });
 }
 } catch { /* ignore */ }

 // Report stored resource_load_error events (queued by index.html)
 try {
 const resErrors = sessionStorage.getItem('_resourceErrors');
 if (resErrors) {
 sessionStorage.removeItem('_resourceErrors');
 const errors: any[] = JSON.parse(resErrors);
 for (const err of errors.slice(0, 10)) {
 Analytics.trackResourceLoadError({
 resourceType: err.type || 'unknown',
 resourceUrl: err.url || '',
 pagePath: err.pagePath || '/',
 triggeredReload: err.triggeredReload || false,
 blockedByAdBlocker: err.adBlocked || false,
 });
 }
 }
 } catch { /* ignore */ }

 // Report stored CSS fallback activation (queued by inline script)
 try {
 const cssFallback = sessionStorage.getItem('_cssFallbackInfo');
 if (cssFallback) {
 sessionStorage.removeItem('_cssFallbackInfo');
 const info = JSON.parse(cssFallback);
 Analytics.trackCssFallback({
 cssUrl: info.href || '',
 delayMs: info.delayMs || 3000,
 pagePath: info.pagePath || '/',
 });
 }
 } catch { /* ignore */ }
 },

 // ─── Resource & Reload Health Tracking ─────────────────────

 /**
 * Track a forced page reload event.
 * GA4 event: force_reload
 *
 * Captures WHO triggered the reload (index.html error handler, ErrorBoundary,
 * lazyRetry), WHY (stale chunk, CSS fail, etc.), and whether the max-reload
 * guard blocked it (indicating potential infinite loop).
 *
 * KEY METRICS:
 * - High force_reload count → deployment issues or SW cache problems
 * - blocked=true events → infinite loop successfully prevented
 * - Multiple reloads per session → guard failure (should NEVER happen)
 */
 trackForceReload: (info: {
 source: 'index_html_script' | 'index_html_import' | 'error_boundary' | 'user_click' | 'lazyRetry';
 reason: string;
 resourceUrl?: string;
 reloadCount?: number;
 pagePath?: string;
 blocked?: boolean;
 }) => {
 log('force_reload', {
 reload_source: info.source,
 reload_reason: truncate(info.reason, 100),
 resource_url: truncate(info.resourceUrl || '', 200),
 reload_count: info.reloadCount ?? 1,
 page_path: truncate(info.pagePath || window.location.pathname, 180),
 was_blocked: info.blocked ?? false,
 user_agent: truncate(navigator.userAgent || '', 150),
 connection_type: truncate((navigator as any).connection?.effectiveType || 'unknown', 20),
 screen_width: window.innerWidth || 0,
 screen_height: window.innerHeight || 0,
 timestamp: new Date().toISOString(),
 });
 },

 /**
 * Track a resource (JS/CSS) load failure.
 * GA4 event: resource_load_error
 *
 * Fires for EVERY resource that fails to load, even when the reload guard
 * prevents a page refresh. Captures whether the failure was caused by an
 * ad blocker (pattern-matched URL) vs a genuine stale chunk.
 *
 * KEY METRICS:
 * - blockedByAdBlocker=true → user has content blocker (informational, not actionable)
 * - blockedByAdBlocker=false → genuine stale chunk or network error (actionable)
 * - triggeredReload=true → the failure caused a page reload
 */
 trackResourceLoadError: (info: {
 resourceType: 'script' | 'link' | 'css' | 'unknown';
 resourceUrl: string;
 pagePath?: string;
 triggeredReload?: boolean;
 blockedByAdBlocker?: boolean;
 }) => {
 log('resource_load_error', {
 resource_type: info.resourceType,
 resource_url: truncate(info.resourceUrl, 200),
 page_path: truncate(info.pagePath || window.location.pathname, 180),
 triggered_reload: info.triggeredReload ?? false,
 ad_blocker: info.blockedByAdBlocker ?? false,
 user_agent: truncate(navigator.userAgent || '', 150),
 connection_type: truncate((navigator as any).connection?.effectiveType || 'unknown', 20),
 screen_width: window.innerWidth || 0,
 timestamp: new Date().toISOString(),
 });
 },

 /**
 * Track CSS fallback timer activation.
 * GA4 event: css_fallback
 *
 * Fires when the 3-second setTimeout had to force CSS media='all' because
 * the onload handler was stripped by a content blocker. This means the user
 * saw unstyled content for 3 seconds.
 *
 * If this count is HIGH → consider inlining more critical CSS or using
 * a different async loading strategy.
 */
 trackCssFallback: (info: {
 cssUrl?: string;
 delayMs?: number;
 pagePath?: string;
 }) => {
 log('css_fallback', {
 css_url: truncate(info.cssUrl || '', 200),
 delay_ms: info.delayMs ?? 3000,
 page_path: truncate(info.pagePath || window.location.pathname, 180),
 user_agent: truncate(navigator.userAgent || '', 150),
 connection_type: truncate((navigator as any).connection?.effectiveType || 'unknown', 20),
 screen_width: window.innerWidth || 0,
 timestamp: new Date().toISOString(),
 });
 },

 /**
 * Track lazy chunk import retry.
 * GA4 event: chunk_retry
 *
 * Fires when lazyRetry() attempts to reload a chunk after clearing caches.
 * Outcome is either 'success' (retry worked) or 'failure' (retry also failed,
 * error propagated to ErrorBoundary).
 */
 trackChunkRetry: (info: {
 outcome: 'success' | 'failure';
 errorMessage?: string;
 pagePath?: string;
 }) => {
 log('chunk_retry', {
 retry_outcome: info.outcome,
 error_message: truncate(info.errorMessage || '', 100),
 page_path: truncate(info.pagePath || window.location.pathname, 180),
 user_agent: truncate(navigator.userAgent || '', 150),
 connection_type: truncate((navigator as any).connection?.effectiveType || 'unknown', 20),
 timestamp: new Date().toISOString(),
 });
 },

 // ─── User Properties ────────────────────────────────────────

 /**
 * Imposta il tipo di lavoratore per segmentazione report
 */
 setWorkerType: (type: 'old' | 'new') => {
 setProps({ worker_type: type });
 },

 /**
 * Imposta preferenze utente come user properties
 */
 setUserPreferences: (prefs: { theme?: string; focusMode?: boolean; currency?: string }) => {
 const props: Record<string, string> = {};
 if (prefs.theme) props.preferred_theme = prefs.theme;
 if (prefs.focusMode !== undefined) props.focus_mode = String(prefs.focusMode);
 if (prefs.currency) props.preferred_currency = prefs.currency;
 setProps(props);
 },

 // ─── App-Specific Events (snake_case, max 40 char) ──────────

 /**
 * Simulazione fiscale completata — evento principale dell'app
 */
 trackCalculation: (workerType: 'old' | 'new', salary: number, hasChildren: boolean) => {
 Analytics.setWorkerType(workerType);
 log('simulation_complete', {
 worker_type: workerType,
 gross_salary: salary,
 has_children: hasChildren,
 engagement_time_sec: getEngagementTime(),
 });
 // Anche come generate_lead (l'utente ha completato il "funnel")
 Analytics.trackGenerateLead(salary, 'CHF');
 },

 /**
 * Cambio di un campo input — debounced a 2s per evitare event flooding
 * da slider e input numerici che inviano molti eventi rapidi.
 */
 trackInputChange: (() => {
 let debounceTimer: ReturnType<typeof setTimeout> | null = null;
 let lastField = '';
 let lastValue: string | number | boolean = '';
 return (field: string, value: string | number | boolean) => {
 lastField = field;
 lastValue = value;
 if (debounceTimer) clearTimeout(debounceTimer);
 debounceTimer = setTimeout(() => {
 log('input_change', {
 field_name: lastField,
 field_value: String(lastValue).substring(0, 100),
 });
 debounceTimer = null;
 }, 2000);
 };
 })(),

 /**
 * Interazione UI generica — formato strutturato:
 * page: pagina principale (es. 'simulatore', 'comparatori', 'guida')
 * section: sezione della pagina (es. 'cambio_valuta', 'spesa', 'calendario')
 * component: componente specifico (es. 'filtro', 'bottone', 'toggle')
 * action: azione eseguita (es. 'click', 'cambio_valore', 'espandi')
 * details: dettagli aggiuntivi opzionali
 * ctaId: stable id of the CTA for funnel joins (preferred over free-text details)
 *
 * PostHog requires `action`, `component`, and `cta_id` to be non-null for
 * ui_interaction dashboards — callers MUST pass meaningful values (not '').
 */
 trackUIInteraction: (
 page: string,
 section: string,
 component: string,
 action: string,
 details?: string,
 ctaId?: string,
 ) => {
 log('ui_interaction', {
 page,
 section,
 component,
 action,
 cta_id: ctaId || `${page}.${section}.${component}.${action}`,
 details: details?.substring(0, 100),
 });
 },

 /**
 * Toggle focus mode
 */
 trackFocusMode: (enabled: boolean) => {
 Analytics.setUserPreferences({ focusMode: enabled });
 log('toggle_focus_mode', { enabled });
 },

 /**
 * Generic custom event — use for one-off events that don't fit
 * a specific track* method.
 */
 trackEvent: (eventName: string, params?: Record<string, any>) => {
 log(eventName, params);
 },

 /**
 * Filtro valichi
 */
 trackBorderFilter: (filterType: string, resultCount: number) => {
 log('border_filter', { filter_type: filterType, result_count: resultCount });
 },

 /**
 * Vista dettaglio comune — single event, no double-fire with select_content
 */
 trackMunicipalityView: (name: string, taxLevel: string) => {
 log('municipality_view', { municipality_name: name, tax_level: taxLevel });
 },

 /**
 * Gestione spese
 */
 trackExpense: (action: 'add' | 'edit' | 'delete', category: string, amount?: number) => {
 log('expense_action', { action, expense_category: category, amount });
 },

 /**
 * Pianificatore pensione
 */
 trackPensionPlanner: (action: string, years?: number, amount?: number) => {
 log('pension_planner', { action, retirement_years: years, amount });
 },

 /**
 * Link esterno cliccato — uses outbound_click (not 'click' which is GA4 reserved)
 */
 trackExternalLink: (url: string, label?: string) => {
 log('outbound_click', { link_url: url, link_text: label || url, outbound: true });
 },

 /**
 * Interazione grafico — single event, no double-fire with select_content
 */
 trackChartInteraction: (chartType: string, action: string) => {
 log('chart_interaction', { chart_type: chartType, action });
 },

 /**
 * Cambio impostazioni
 */
 trackSettingsChange: (setting: string, value: string | boolean) => {
 log('settings_change', { setting_name: setting, setting_value: String(value) });
 if (setting === 'theme') {
 Analytics.setUserPreferences({ theme: String(value) });
 }
 },

 /**
 * Navigazione tra tab — fires tab_navigation only.
 * page_view is handled centrally by App.tsx on route change.
 */
 trackTabNavigation: (from: string, to: string) => {
 log('tab_navigation', { from_tab: from, to_tab: to });
 },

 /**
 * Selezione orario traffico
 */
 trackBorderTimeSelection: (timeSlot: string, recommendedCount: number) => {
 log('border_time_select', { time_slot: timeSlot, recommended_count: recommendedCount });
 },

 /**
 * Interazione mappa
 */
 trackMapInteraction: (mapType: string, action: string, location?: string) => {
 log('map_interaction', { map_type: mapType, action, location });
 },

 /**
 * Vista strumento comparatore — fires select_content only.
 * page_view is handled centrally by App.tsx on route change.
 */
 trackComparatorView: (tool: 'exchange' | 'mobile' | 'transport' | 'health' | 'banks' | 'traffic' | 'morning') => {
 log('select_content', { content_type: 'comparator_tool', item_id: tool });
 },

 /**
 * Cambio valuta
 */
 trackCurrencyExchange: (action: 'convert' | 'swap' | 'provider_view', provider?: string, amount?: number) => {
 log('currency_exchange', { action, provider, amount });
 },

 /**
 * Operatori mobili
 */
 trackMobileOperator: (action: 'view' | 'filter' | 'sort' | 'link_click', operator?: string, filter?: string) => {
 log('mobile_operator', { action, operator_name: operator, filter_type: filter });
 },

 /**
 * Calcolatore trasporti
 */
 trackTransportCalculator: (action: 'calculate' | 'change_type' | 'change_param', transportType?: string, value?: number) => {
 log('transport_calc', { action, transport_type: transportType, value });
 },

 /**
 * Assicurazione sanitaria
 */
 trackHealthInsurance: (action: 'view_provider' | 'filter' | 'compare', provider?: string) => {
 log('health_insurance', { action, provider_name: provider });
 },

 /**
 * Confronto banche
 */
 trackBankComparison: (action: 'view_bank' | 'filter' | 'link_click', bank?: string, country?: string) => {
 log('bank_comparison', { action, bank_name: bank, country });
 },

 /**
 * Traffico ai valichi
 */
 trackTrafficAlerts: (action: 'view' | 'refresh' | 'filter', crossing?: string, waitTime?: number) => {
 log('traffic_alerts', { action, crossing_name: crossing, wait_time_min: waitTime });
 },

 /**
 * Diagnostica API
 */
 trackApiDiagnostics: (action: 'view' | 'refresh' | 'test_api', apiName?: string) => {
 log('api_diagnostics', { action, api_name: apiName });
 },

 /**
 * Guida frontaliere — single event, no double-fire with select_content
 */
 trackGuideSection: (section: string, action: 'view' | 'expand' | 'link_click') => {
 log('guide_interaction', { section, action });
 },

 /**
 * What-if simulator
 */
 trackWhatIf: (scenario: string, action: 'select' | 'change_param' | 'view_result', details?: string) => {
 log('whatif_simulator', { scenario, action, details });
 },

 /**
 * Job auth gate funnel — full conversion tracking for the job detail login wall.
 * Tracks the job context (category, location, keywords, search query) so we
 * know exactly which listing triggered the sign-up.
 */
 trackJobAuthFunnel: (
 action: 'gate_view' | 'auth_method_click' | 'auth_success' | 'auth_fail' | 'gate_dismiss',
 details?: {
 method?: string;
 company?: string;
 jobTitle?: string;
 emailDomain?: string;
 category?: string;
 location?: string;
 searchQuery?: string;
 keywords?: string;
 }
 ) => {
 // The action value IS the funnel step — also emit it as `step`/`funnel`
 // so the PostHog funnel_step + job_auth_funnel dashboards share keys.
 log('job_auth_funnel', {
 action,
 step: action,
 funnel: 'job_auth',
 ...details,
 });
 // Also emit a normalized funnel_step event so all funnels can be queried
 // via the same event shape in PostHog.
 log('funnel_step', {
 step: action,
 funnel: 'job_auth',
 funnel_name: 'job_auth',
 step_name: action,
 step_index: 0,
 ...(details || {}),
 });
 },

 /**
 * Job comparator
 */
 trackJobComparison: (action: 'add_job' | 'remove_job' | 'compare' | 'view_result', jobCount?: number, bestCompany?: string) => {
 log('job_comparison', { action, job_count: jobCount, best_company: bestCompany });
 },

 /**
 * Tax calendar
 */
 trackCalendarEvent: (action: 'view' | 'filter' | 'expand_deadline', deadline?: string, daysUntil?: number) => {
 log('tax_calendar', { action, deadline_title: deadline, days_until: daysUntil });
 },

 /**
 * Work permits guide
 */
 trackPermitView: (permitType: string, action: 'select' | 'expand_section' | 'view_comparison') => {
 log('work_permits', { permit_type: permitType, action });
 },

 /**
 * 3rd pillar simulator
 */
 trackPillar3: (action: 'change_type' | 'change_param' | 'view_projection', pillarType?: string, amount?: number) => {
 log('pillar3_simulator', { action, pillar_type: pillarType, amount });
 },

 /**
 * Newsletter — subscribe is NOT a generate_lead (reserved for simulation_complete)
 */
 trackNewsletter: (action: 'view_form' | 'subscribe' | 'unsubscribe' | 'error', emailDomain?: string) => {
 log('newsletter', { action, email_domain: emailDomain });
 },

 trackNewsletterEvent: (
 action: 'send' | 'delivered' | 'open' | 'click' | 'unsubscribe',
 details: {
 campaignId?: string;
 messageId?: string;
 variant?: string;
 sectionId?: string;
 linkLabel?: string;
 targetUrl?: string;
 subscriberLocale?: string;
 sourceChannel?: string;
 sourcePage?: string;
 jobSlug?: string;
 locationInterest?: string;
 sectorInterest?: string;
 } = {},
 ) => {
 log('newsletter', {
 action,
 campaign_id: details.campaignId,
 message_id: details.messageId,
 variant: details.variant,
 section_id: details.sectionId,
 link_label: truncate(details.linkLabel || '', 100),
 target_url: truncate(details.targetUrl || '', 180),
 subscriber_locale: details.subscriberLocale,
 source_channel: details.sourceChannel,
 source_page: truncate(details.sourcePage || '', 180),
 job_slug: details.jobSlug,
 location_interest: details.locationInterest,
 sector_interest: details.sectorInterest,
 });
 },

 /**
 * Feedback — submit is NOT a generate_lead (reserved for simulation_complete)
 */
 trackFeedback: (action: 'open' | 'submit' | 'cancel', type?: 'bug' | 'feature' | 'question') => {
 log('feedback', { action, feedback_type: type });
 },

 /**
 * Download PDF report
 */
 trackDownload: (fileType: string, fileName?: string) => {
 log('file_download', { file_extension: fileType, file_name: fileName });
 },

 /**
 * Explicit CTA click — emits `cta_click` with stable `cta_id`, target,
 * and session attribution (utm_source/medium/campaign/content/term).
 *
 * Use this for in-code CTA instrumentation when you want reliable funnel
 * joins by `cta_id`. The global click listener also emits `cta_click`
 * events from generic DOM clicks; in-code calls here win because they
 * carry the authoritative `cta_id` the product team uses in dashboards.
 */
 trackCtaClick: (
 ctaId: string,
 details: {
 targetUrl?: string;
 component?: string;
 section?: string;
 label?: string;
 utm_source?: string;
 utm_medium?: string;
 utm_campaign?: string;
 utm_content?: string;
 utm_term?: string;
 } = {},
 ) => {
 let attribution: AttributionContext | null = null;
 try {
 const raw = sessionStorage.getItem(ATTRIBUTION_KEY);
 if (raw) attribution = JSON.parse(raw) as AttributionContext;
 } catch { /* storage unavailable */ }

 log('cta_click', {
 // REQUIRED: canonical keys PostHog dashboards key off
 cta_id: ctaId,
 target_url: truncate(details.targetUrl || '', 180),
 utm_source: truncate(details.utm_source || attribution?.source || '(none)', 60),
 utm_medium: truncate(details.utm_medium || attribution?.medium || '(none)', 40),
 utm_campaign: truncate(details.utm_campaign || attribution?.campaign || '(none)', 80),
 utm_content: truncate(details.utm_content || attribution?.content || '(none)', 80),
 utm_term: truncate(details.utm_term || attribution?.term || '(none)', 80),
 // Legacy compatibility with global cta_click listener
 page_path: typeof window !== 'undefined' ? truncate(`${window.location.pathname}${window.location.search}`, 180) : '',
 element_label: truncate(details.label || ctaId, 100),
 component: truncate(details.component || '(none)', 80),
 section: truncate(details.section || '(none)', 80),
 });
 },

 // ─── Funnel Tracking (multi-step conversion pipeline) ─────

 /**
 * Track explicit funnel steps for drop-off analysis.
 *
 * Canonical main-conversion steps: entry → input_start → calculate → compare → cta_click.
 * Any string step is accepted so feature-specific funnels (e.g., job_auth, chatbot,
 * newsletter_paywall) can flow through the same event with `funnel` set to their funnel id.
 *
 * IMPORTANT: the payload MUST always carry a non-null `step` property — PostHog
 * dashboards key off `step` directly (not `step_name`). Keeping both aliases
 * protects legacy GA4 reports that query `step_name`.
 */
 trackFunnelStep: (
 step: string,
 details?: Record<string, string | number | boolean | undefined> & { funnel?: string },
 ) => {
 const mainStepIndex: Record<string, number> = { entry: 1, input_start: 2, calculate: 3, compare: 4, cta_click: 5 };
 const paywallStepIndex: Record<string, number> = { paywall_shown: 1, paywall_email_submitted: 2, paywall_email_confirmed: 3 };
 const { funnel: funnelOverride, ...rest } = details || {};
 const funnel = funnelOverride || 'main_conversion';
 const stepIndex = funnel === 'newsletter_paywall'
 ? paywallStepIndex[step] ?? 0
 : mainStepIndex[step] ?? 0;
 log('funnel_step', {
 // Canonical keys (what PostHog dashboards read) — always present
 step,
 funnel,
 // Legacy aliases for GA4 reports that still query step_name/funnel_name
 funnel_name: funnel,
 step_name: step,
 step_index: stepIndex,
 ...rest,
 });
 },

 /**
 * Track consent change events for compliance analytics
 */
 trackConsentChange: (analytics: boolean, advertising: boolean) => {
 log('consent_update', {
 consent_analytics: analytics,
 consent_advertising: advertising,
 });
 },

 /**
 * Track SERP title/meta experiment exposure (for weekly SEO monitoring)
 */
 trackSerpExperimentExposure: (variant: string, section: string, pagePath: string, fromSearchReferrer: boolean, referrerHost?: string) => {
 log('seo_serp_variant_exposure', {
 variant,
 section,
 page_path: pagePath,
 from_search_referrer: fromSearchReferrer,
 referrer_host: referrerHost || 'direct',
 });
 },

 /**
 * Chatbot auth/conversion funnel tracking
 */
 trackChatbotFunnel: (
 step: 'open_chat' | 'question_started' | 'gate_opened' | 'method_selected' | 'auth_success' | 'response_generated',
 method?: 'google' | 'facebook' | 'email' | 'none',
 status?: 'ok' | 'error'
 ) => {
 log('chatbot_funnel', {
 step,
 method: method || 'none',
 status: status || 'ok',
 });
 },

 /**
 * Chatbot product usage telemetry (adoption/engagement diagnostics)
 */
 trackChatbotUsage: (
 event:
 | 'panel_open'
 | 'panel_close'
 | 'question_sent'
 | 'auth_gate_open'
 | 'api_error'
 | 'rate_limited'
 | 'inference_local_fallback'
 | 'tool_invoked',
 details?: Record<string, string | number | boolean>
 ) => {
 log('chatbot_usage', {
 event,
 ...(details || {}),
 });
 },

 /**
 * Store chatbot question content (sanitized) for topic analytics.
 * Tracks even for guest users (before login).
 */
 trackChatbotQuestion: (
 question: string,
 details?: {
 auth_state?: 'authed' | 'guest';
 trigger?: 'send' | 'send_attempt' | 'quick_question' | 'pending_autosend';
 }
 ) => {
 const clean = sanitizeChatbotQuestion(question);
 if (!clean) return;
 log('chatbot_question', {
 question_text: clean,
 question_length: clean.length,
 question_word_count: clean.split(/\s+/).filter(Boolean).length,
 ...(details || {}),
 });
 },

 // ── FRO-334: Job Alert analytics ──────────────────────────────

 trackJobAlertCreated: (details: { keywords?: string; location?: string; frequency?: string }) => {
 log('job_alert_created', {
 alert_keywords: details.keywords || '',
 alert_location: details.location || '',
 alert_frequency: details.frequency || 'daily',
 });
 },

 trackJobAlertDeleted: () => {
 log('job_alert_deleted', {});
 },

 /**
  * Track an interaction with a Job Alert conversion surface other than the
  * inline form itself. `surface` identifies where the event originated
  * (sticky banner, end-of-list card, post-auth prompt); `action` identifies
  * whether the user opened or dismissed it. Used to compare conversion rate
  * across surfaces and prune the ones that underperform.
  */
 trackJobAlertCtaClick: (
 surface: 'sticky_banner' | 'end_card' | 'post_auth_prompt' | 'post_auth_prompt_search' | 'post_auth_prompt_detail' | 'inline_card' | 'job_detail_prompt',
 action: 'open' | 'dismiss' | 'auto_expand' | 'shown' | 'accept' | 'success' | 'error',
 keyword?: string,
 ) => {
 log('job_alert_cta_click', {
 cta_surface: surface,
 cta_action: action,
 cta_keyword: (keyword || '').slice(0, 80),
 });
 },
};

// ─── Protect Analytics methods from external modification ──────
// Some browser extensions and ad blockers iterate over window/module objects
// and delete or overwrite properties that look analytics-related (e.g.,
// "trackEvent", "trackPageView"). This causes "x.trackEvent is not a function"
// errors in production (~24 errors/month from ~18 users).
// By making all function properties non-configurable and non-writable, we
// prevent external code from stripping them while still allowing
// `isInitialized` (a boolean) to be mutated by `init()`.
for (const key of Object.keys(Analytics)) {
 if (typeof (Analytics as any)[key] === 'function') {
 Object.defineProperty(Analytics, key, {
 writable: false,
 configurable: false,
 });
 }
}
