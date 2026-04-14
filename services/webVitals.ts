/**
 * Web Vitals Telemetry — reports Core Web Vitals to GA4
 *
 * Uses Google's official `web-vitals` library for accurate measurements.
 * Reports: LCP, INP, CLS, FCP, TTFB
 *
 * Data is sent to GA4 via the existing Analytics.log() pipeline,
 * respecting consent state.
 *
 * Enhanced with device-type and connection-quality dimensions so that
 * GA4 reports can be filtered by mobile vs desktop and by network speed.
 */

import { isAnalyticsGranted } from '@/services/consentService';
import { deriveAnalyticsPageContext } from '@/services/analyticsPageContext';

/** Detect device type from screen width + touch capability */
function getDeviceType(): 'mobile' | 'tablet' | 'desktop' {
 const w = window.innerWidth || screen.width;
 const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
 if (w < 768 && hasTouch) return 'mobile';
 if (w < 1024 && hasTouch) return 'tablet';
 return 'desktop';
}

/** Get effective connection type from Network Information API */
function getConnectionInfo(): { effectiveType: string; downlink: number; rtt: number } {
 const conn = (navigator as any).connection;
 return {
 effectiveType: conn?.effectiveType || 'unknown',
 downlink: conn?.downlink ?? -1,
 rtt: conn?.rtt ?? -1,
 };
}

function sendToGA4(metric: { name: string; value: number; rating: string; id: string; navigationType: string }) {
 if (!isAnalyticsGranted()) return;
 const pageContext = deriveAnalyticsPageContext(location.pathname);
 const device = getDeviceType();
 const conn = getConnectionInfo();

 import('@/services/analytics').then(({ Analytics }) => {
 (Analytics as any).log?.('web_vitals', {
 metric_name: metric.name,
 metric_value: Math.round(metric.name === 'CLS' ? metric.value * 1000 : metric.value),
 metric_rating: metric.rating,
 metric_id: metric.id,
 navigation_type: metric.navigationType,
 page_path: location.pathname,
 page_template: pageContext.pageTemplate,
 content_group: pageContext.contentGroup,
 site_section: pageContext.siteSection,
 content_locale: pageContext.contentLocale,
 route_family: pageContext.routeFamily,
 device_type: device,
 connection_type: conn.effectiveType,
 connection_downlink: conn.downlink,
 connection_rtt: conn.rtt,
 screen_width: window.innerWidth || 0,
 screen_height: window.innerHeight || 0,
 });
 }).catch(() => {});

 if (import.meta.env.DEV) {
 const color = metric.rating === 'good' ? '🟢' : metric.rating === 'needs-improvement' ? '🟡' : '🔴';
 console.log(`${color} [WebVitals] ${metric.name}: ${metric.value.toFixed(1)} (${metric.rating}) [${device}/${conn.effectiveType}]`);
 }
}

/**
 * Initialize Web Vitals observers. Call once after first user interaction.
 * Uses Google's `web-vitals` library for accurate, spec-compliant measurements.
 */
export function initWebVitals() {
 import('web-vitals').then(({ onCLS, onLCP, onFCP, onTTFB, onINP }) => {
 onCLS(sendToGA4);
 onLCP(sendToGA4);
 onFCP(sendToGA4);
 onTTFB(sendToGA4);
 onINP(sendToGA4);
 }).catch(() => {
 // Fallback: web-vitals not available — fail silently
 });
}
