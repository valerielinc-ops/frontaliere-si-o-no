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

let _initialized = false;

/**
 * Initialize Microsoft Clarity. Call once after analytics consent is granted.
 * Loads the Clarity script dynamically — no impact on initial page load.
 */
export async function initClarity(): Promise<void> {
 if (_initialized) return;
 if (!isAnalyticsGranted()) return;

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
 const { getConfigValue } = await import('@/services/firebase');
 const projectId = await getConfigValue('CLARITY_PROJECT_ID');

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
 s.parentNode?.insertBefore(t, s);
 })(window, document, 'clarity', 'script', projectId);

 if (import.meta.env.DEV) {
 console.log(`[Clarity] Initialized with project ${projectId}`);
 }
 } catch (error) {
 if (import.meta.env.DEV) {
 console.warn('[Clarity] Failed to initialize:', error);
 }
 reportCaughtError(error, 'clarity.init');
 }
}
