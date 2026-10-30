/**
 * Microsoft Clarity Integration
 *
 * Provides free heatmaps, session recordings, and rage-click detection.
 * Loads lazily after analytics consent, using the project ID from Firebase Remote Config.
 *
 * Clarity is a free tool from Microsoft — no API key or billing required.
 * The project ID is public (appears in page source, like GA measurement IDs).
 *
 * Setup: Create a project at https://clarity.microsoft.com, then add the
 * project ID to Firebase Remote Config as CLARITY_PROJECT_ID.
 */

import { isAnalyticsGranted } from '@/services/consentService';
import { reportCaughtError } from '@/services/errorReporter';
import { resilientImport } from '@/services/resilientImport';
import { wasNewsletterAutologinAttempted } from '@/services/newsletterAutologinSignal';
import { sanitizeTelemetryProperties } from '@/services/analyticsUrlPrivacy';

let _initialized = false;
let _sensitiveDocument = wasNewsletterAutologinAttempted();

function isSensitiveDocument(): boolean {
 if (_sensitiveDocument) return true;
 if (typeof window === 'undefined') return false;
 const context = { page_location: window.location.href, page_referrer: typeof document === 'undefined' ? '' : document.referrer };
 const safeContext = sanitizeTelemetryProperties(context);
 _sensitiveDocument = context.page_location !== safeContext.page_location
 || context.page_referrer !== safeContext.page_referrer;
 return _sensitiveDocument;
}

/**
 * Initialize Microsoft Clarity. Call once after analytics consent is granted.
 * Loads the Clarity script dynamically — no impact on initial page load.
 */
export async function initClarity(): Promise<void> {
 // Cleaning history does not clean URLs retained in DOM attributes. In the
 // observed replay an ad iframe kept the signed entry URL inside its src.
 // Exclude this whole document, including failed/expired auth and later retries;
 // never rewrite auth URLs or mutate third-party iframes to make replay safe.
 if (_initialized || isSensitiveDocument() || !isAnalyticsGranted()) return;

 // Only load Clarity on the official production domain — skip everywhere else
 // (localhost, preview builds, staging, GitHub Pages default domain, etc.)
 const PRODUCTION_HOSTS = ['frontaliereticino.ch', 'frontaliereticino.ch'];
 const host = window.location.hostname;
 if (!PRODUCTION_HOSTS.includes(host)) {
 if (import.meta.env.DEV) {
 console.log(`[Clarity] Skipped — not production (host: ${host})`);
 }
 return;
 }

 try {
 const { getConfigValue } = await resilientImport(() => import('@/services/firebase'), (m) => typeof m.getConfigValue === 'function');
 const projectId = await getConfigValue('CLARITY_PROJECT_ID');

 // Capture sensitive context even when configuration disables the SDK.
 if (_initialized || isSensitiveDocument() || !isAnalyticsGranted()) return;

 if (!projectId) {
 if (import.meta.env.DEV) {
 console.log('[Clarity] No project ID configured — skipping');
 }
 return;
 }

 _initialized = true;

 // Inject the Clarity script (standard snippet from https://clarity.microsoft.com)
 (function (c: any, l: Document, a: string, r: string, i: string) {
 c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
 const t = l.createElement(r) as HTMLScriptElement;
 t.async = true;
 t.crossOrigin = 'anonymous';
 t.src = 'https://www.clarity.ms/tag/' + i;
 const s = l.getElementsByTagName(r)[0];
 if (s && s.parentNode) s.parentNode.insertBefore(t, s);
 else (l.head || l.documentElement).appendChild(t);
 })(window, document, 'clarity', 'script', projectId);

 if (import.meta.env.DEV) {
 console.log(`[Clarity] Initialized with project ${projectId}`);
 }
 } catch (error) {
 // A failed config fetch must not let a later clean-URL retry bypass the latch.
 isSensitiveDocument();
 if (import.meta.env.DEV) {
 console.warn('[Clarity] Failed to initialize:', error);
 }
 reportCaughtError(error, 'clarity.init');
 }
}
