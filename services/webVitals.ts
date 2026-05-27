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

type WebVitalMetric = {
 name: string;
 value: number;
 rating: string;
 id: string;
 navigationType: string;
 attribution?: unknown;
};

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

function getMetricAttribution(metric: WebVitalMetric): Record<string, string | number | null> {
 const a = metric.attribution as Record<string, unknown> | undefined;
 if (!a) return {};

 if (metric.name === 'CLS') {
 const source = a.largestShiftSource as { previousRect?: DOMRectReadOnly; currentRect?: DOMRectReadOnly } | undefined;
 return {
 largest_shift_target: String(a.largestShiftTarget || '').slice(0, 180) || null,
 largest_shift_value: typeof a.largestShiftValue === 'number' ? a.largestShiftValue : null,
 largest_shift_time: typeof a.largestShiftTime === 'number' ? Math.round(a.largestShiftTime) : null,
 largest_shift_load_state: String(a.loadState || '') || null,
 largest_shift_prev_y: source?.previousRect ? Math.round(source.previousRect.y) : null,
 largest_shift_prev_h: source?.previousRect ? Math.round(source.previousRect.height) : null,
 largest_shift_curr_y: source?.currentRect ? Math.round(source.currentRect.y) : null,
 largest_shift_curr_h: source?.currentRect ? Math.round(source.currentRect.height) : null,
 };
 }

 if (metric.name === 'LCP') {
 return {
 lcp_target: String(a.target || '').slice(0, 180) || null,
 lcp_url: String(a.url || '').slice(0, 240) || null,
 lcp_ttfb: typeof a.timeToFirstByte === 'number' ? Math.round(a.timeToFirstByte) : null,
 lcp_resource_load_delay: typeof a.resourceLoadDelay === 'number' ? Math.round(a.resourceLoadDelay) : null,
 lcp_resource_load_duration: typeof a.resourceLoadDuration === 'number' ? Math.round(a.resourceLoadDuration) : null,
 lcp_element_render_delay: typeof a.elementRenderDelay === 'number' ? Math.round(a.elementRenderDelay) : null,
 };
 }

 if (metric.name === 'INP') {
 return {
 inp_target: String(a.interactionTarget || '').slice(0, 180) || null,
 inp_type: String(a.interactionType || '') || null,
 inp_load_state: String(a.loadState || '') || null,
 inp_input_delay: typeof a.inputDelay === 'number' ? Math.round(a.inputDelay) : null,
 inp_processing_duration: typeof a.processingDuration === 'number' ? Math.round(a.processingDuration) : null,
 inp_presentation_delay: typeof a.presentationDelay === 'number' ? Math.round(a.presentationDelay) : null,
 inp_script_duration: typeof a.totalScriptDuration === 'number' ? Math.round(a.totalScriptDuration) : null,
 inp_style_layout_duration: typeof a.totalStyleAndLayoutDuration === 'number' ? Math.round(a.totalStyleAndLayoutDuration) : null,
 };
 }

 return {};
}

function sendToGA4(metric: WebVitalMetric) {
 if (!isAnalyticsGranted()) return;
 const pageContext = deriveAnalyticsPageContext(location.pathname);
 const device = getDeviceType();
 const conn = getConnectionInfo();
 const attribution = getMetricAttribution(metric);

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
 ...attribution,
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
 import('web-vitals/attribution').then(({ onCLS, onLCP, onFCP, onTTFB, onINP }) => {
 onCLS(sendToGA4);
 onLCP(sendToGA4);
 onFCP(sendToGA4);
 onTTFB(sendToGA4);
 onINP(sendToGA4);
 }).catch(() => {
 // Fallback: web-vitals not available — fail silently
 });
}
