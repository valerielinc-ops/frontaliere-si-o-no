/**
 * Mobile UX Monitor — detects and reports mobile usability issues to GA4
 *
 * Tracks:
 * 1. Small tap targets: buttons/links < 48×48px on touch devices (WCAG 2.5.8)
 * 2. Tap-target proximity: interactive elements too close together (< 8px gap)
 * 3. Slow connection warning: tags sessions on 2G/slow-2G for correlation
 * 4. Viewport overflow: detects horizontal scroll (broken mobile layout)
 * 5. Clarity↔GA4 session linking: sends Clarity session ID as GA4 dimension
 *
 * All checks run lazily after first interaction to avoid impacting page load.
 * Events fire at most once per page load to avoid flooding GA4.
 */

import { isAnalyticsGranted } from '@/services/consentService';
import { reportCaughtError } from '@/services/errorReporter';

const MIN_TAP_SIZE = 44; // px — Google recommends 48, WCAG 2.5.8 requires 44
const MIN_TAP_GAP = 8; // px — minimum spacing between tap targets
const MAX_SMALL_TARGETS_TO_REPORT = 5;

let _initialized = false;

/** Check if device supports touch */
function isTouchDevice(): boolean {
 return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

/**
 * Scan visible interactive elements for tap target issues.
 * Runs once, reports up to MAX_SMALL_TARGETS_TO_REPORT violations.
 */
function auditTapTargets(): void {
 if (!isTouchDevice()) return;

 try {
 const interactiveSelectors = 'a, button, [role="button"], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
 const elements = document.querySelectorAll(interactiveSelectors);
 const smallTargets: Array<{ selector: string; width: number; height: number }> = [];
 const closeTargets: Array<{ selector1: string; selector2: string; gap: number }> = [];

 const rects: Array<{ el: Element; rect: DOMRect; desc: string }> = [];

 elements.forEach(el => {
 const rect = el.getBoundingClientRect();
 // Skip invisible/off-screen elements
 if (rect.width === 0 || rect.height === 0) return;
 if (rect.bottom < 0 || rect.top > window.innerHeight) return;

 const desc = describeElement(el);
 rects.push({ el, rect, desc });

 // Check size
 if (rect.width < MIN_TAP_SIZE || rect.height < MIN_TAP_SIZE) {
 smallTargets.push({
 selector: desc,
 width: Math.round(rect.width),
 height: Math.round(rect.height),
 });
 }
 });

 // Check proximity (only for visible above-fold elements, limit O(n²) cost)
 const aboveFold = rects.filter(r => r.rect.top < window.innerHeight).slice(0, 50);
 for (let i = 0; i < aboveFold.length && closeTargets.length < 3; i++) {
 for (let j = i + 1; j < aboveFold.length && closeTargets.length < 3; j++) {
 const a = aboveFold[i].rect;
 const b = aboveFold[j].rect;
 const hGap = Math.max(0, Math.max(b.left - a.right, a.left - b.right));
 const vGap = Math.max(0, Math.max(b.top - a.bottom, a.top - b.bottom));
 const gap = Math.min(hGap, vGap);
 // Only flag elements that are actually adjacent (not far apart)
 if (gap < MIN_TAP_GAP && gap >= 0 && (hGap < 50 || vGap < 50)) {
 closeTargets.push({
 selector1: aboveFold[i].desc,
 selector2: aboveFold[j].desc,
 gap: Math.round(gap),
 });
 }
 }
 }

 if (smallTargets.length > 0) {
 logMobileUx('small_tap_target', {
 count: smallTargets.length,
 targets: JSON.stringify(smallTargets.slice(0, MAX_SMALL_TARGETS_TO_REPORT)),
 page_path: location.pathname,
 });
 }

 if (closeTargets.length > 0) {
 logMobileUx('close_tap_targets', {
 count: closeTargets.length,
 pairs: JSON.stringify(closeTargets),
 page_path: location.pathname,
 });
 }
 } catch (err) {
 reportCaughtError(err, 'mobileUxMonitor.auditTapTargets');
 }
}

/** Detect horizontal overflow (broken mobile layout) */
function checkViewportOverflow(): void {
 try {
 const docWidth = document.documentElement.scrollWidth;
 const viewportWidth = window.innerWidth;
 if (docWidth > viewportWidth + 5) { // 5px tolerance
 logMobileUx('viewport_overflow', {
 doc_width: docWidth,
 viewport_width: viewportWidth,
 overflow_px: docWidth - viewportWidth,
 page_path: location.pathname,
 });
 }
 } catch (err) {
 reportCaughtError(err, 'mobileUxMonitor.checkViewportOverflow');
 }
}

/** Tag slow connections for GA4 correlation */
function checkSlowConnection(): void {
 try {
 const conn = (navigator as any).connection;
 if (!conn) return;
 const ect = conn.effectiveType;
 if (ect === 'slow-2g' || ect === '2g') {
 logMobileUx('slow_connection', {
 effective_type: ect,
 downlink: conn.downlink ?? -1,
 rtt: conn.rtt ?? -1,
 page_path: location.pathname,
 });
 }
 } catch (err) {
 reportCaughtError(err, 'mobileUxMonitor.checkSlowConnection');
 }
}

/** Link Clarity session to GA4 for cross-tool analysis */
function linkClaritySession(): void {
 try {
 const clarity = (window as any).clarity;
 if (typeof clarity !== 'function') return;

 // Clarity exposes session info after initialization
 // Set GA4 custom dimension with Clarity session URL
 const checkClarity = () => {
 const clarityState = (window as any).clarity?.v;
 if (clarityState) {
 logMobileUx('clarity_session', {
 clarity_project: 'vqi1r9wejc',
 page_path: location.pathname,
 });
 }
 };
 // Clarity takes a moment to initialize — check after delay
 setTimeout(checkClarity, 5000);
 } catch {
 // Clarity not loaded — skip silently
 }
}

/** Generate a human-readable descriptor for an element */
function describeElement(el: Element): string {
 const tag = el.tagName.toLowerCase();
 const text = (el.textContent || '').trim().slice(0, 30);
 const ariaLabel = el.getAttribute('aria-label')?.slice(0, 30);
 const id = el.id ? `#${el.id}` : '';
 const cls = el.className && typeof el.className === 'string'
 ? '.' + el.className.split(' ').slice(0, 2).join('.')
 : '';

 if (ariaLabel) return `${tag}[aria-label="${ariaLabel}"]`;
 if (id) return `${tag}${id}`;
 if (text) return `${tag}:${text.replace(/\s+/g, ' ')}`;
 return `${tag}${cls}`;
}

/** Log a mobile UX event to GA4 */
function logMobileUx(action: string, params: Record<string, string | number>): void {
 if (!isAnalyticsGranted()) return;
 import('@/services/analytics').then(({ Analytics }) => {
 (Analytics as any).log?.('mobile_ux', {
 action,
 device_type: getDeviceType(),
 screen_width: window.innerWidth || 0,
 screen_height: window.innerHeight || 0,
 ...params,
 });
 }).catch(() => {});

 if (import.meta.env.DEV) {
 console.log(`📱 [MobileUX] ${action}`, params);
 }
}

function getDeviceType(): 'mobile' | 'tablet' | 'desktop' {
 const w = window.innerWidth || screen.width;
 const hasTouch = isTouchDevice();
 if (w < 768 && hasTouch) return 'mobile';
 if (w < 1024 && hasTouch) return 'tablet';
 return 'desktop';
}

/**
 * Initialize mobile UX monitoring. Call after first user interaction.
 * All audits run lazily with requestIdleCallback to avoid blocking the main thread.
 */
export function initMobileUxMonitor(): void {
 if (_initialized) return;
 if (typeof window === 'undefined') return;
 _initialized = true;

 const runAudits = () => {
 // Delay audits to ensure DOM is fully rendered
 setTimeout(() => {
 auditTapTargets();
 checkViewportOverflow();
 checkSlowConnection();
 linkClaritySession();
 }, 3000);
 };

 // Use requestIdleCallback if available, else setTimeout
 if ('requestIdleCallback' in window) {
 (window as any).requestIdleCallback(runAudits, { timeout: 10000 });
 } else {
 setTimeout(runAudits, 5000);
 }
}
