/**
 * AdSense telemetry — bot detection + per-page fill-rate events.
 *
 * Why:
 * - AdSense PAGE_URL dimension only reports the URL where Auto Ads classifier
 *   recognized the page. Most explicit slots aren't bucketed there, so the
 *   report shows revenue without per-page granularity. Logging fill state
 *   from the client lets GA4/PostHog correlate revenue proxy (impressions ×
 *   format CPM) with page_path.
 * - Bot traffic with ~€0.07 RPM (e.g. 1.7k US PVs in last 30d) inflates
 *   ad_requests, lowers coverage %, and pollutes targeting signals. Skipping
 *   the adsbygoogle push for bots cuts request volume without affecting
 *   real users.
 *
 * Events:
 *  - ad_request   pushed to adsbygoogle queue (slot, format, page_path)
 *  - ad_filled    AdSense filled the slot
 *  - ad_unfilled  AdSense returned no ad
 *  - ad_collapsed slot hidden (no width, fill timeout, script failure, bot skip)
 */

import { captureEvent as posthogCapture } from './posthog';

// User-agents that monetize at near-zero RPM. Lowercased substring match.
// We deliberately exclude search-engine bots (Googlebot, Bingbot, etc.) — they
// don't request ads anyway since the AdSense script is lazy-loaded behind
// IntersectionObserver. The list targets scrapers/headless/automation that
// DO render JS and DO trigger ad pushes.
const BOT_UA_PATTERNS = [
  'headlesschrome',
  'phantomjs',
  'puppeteer',
  'playwright',
  'selenium',
  'webdriver',
  'cypress',
  'lighthouse',
  'pagespeed',
  'gtmetrix',
  'pingdom',
  'uptimerobot',
  'datadog',
  'newrelic',
  'screenshotlayer',
  'screenshotmachine',
  'urlpreviewbot',
  'http_request',
  'python-requests',
  'go-http-client',
  'okhttp',
  'curl/',
  'wget/',
  'libwww',
  'ahrefsbot',
  'semrushbot',
  'mj12bot',
  'dotbot',
  'sitechecker',
  'serpstatbot',
  'crawler',
  'spider',
  'scraper',
  'fetcher',
  'monitoring',
  'archive.org_bot',
];

export function isLikelyBot(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return true;
  // navigator.webdriver is set true by Selenium/Playwright/Puppeteer (most cases)
  if ((navigator as Navigator & { webdriver?: boolean }).webdriver === true) return true;
  const ua = (navigator.userAgent || '').toLowerCase();
  if (!ua) return true;
  for (const pattern of BOT_UA_PATTERNS) {
    if (ua.includes(pattern)) return true;
  }
  // Headless Chrome variants without "headlesschrome" in UA
  if (ua.includes('chrome') && !('chrome' in window)) return true;
  return false;
}

export type AdEvent = 'ad_request' | 'ad_filled' | 'ad_unfilled' | 'ad_collapsed' | 'ad_bot_skip';

export interface AdEventProps {
  slot: string;
  format: string;
  page_path?: string;
  page_template?: string;
  reason?: string;
}

function getPagePath(): string {
  if (typeof window === 'undefined') return '';
  return window.location.pathname || '/';
}

function classifyTemplate(path: string): string {
  if (path === '/' || path === '') return 'home';
  if (path.startsWith('/blog/') || path.startsWith('/articolo/')) return 'blog';
  if (path.includes('/cerca-lavoro') || path.startsWith('/lavoro/') || path.startsWith('/job/'))
    return 'jobs';
  if (path.startsWith('/calcolatore') || path.includes('/simulatore')) return 'calculator';
  if (path.startsWith('/comparatori/') || path.startsWith('/confronti/')) return 'comparators';
  if (path.startsWith('/fisco/') || path.startsWith('/tasse/')) return 'fisco';
  if (path.startsWith('/guida/') || path.startsWith('/guide/')) return 'guida';
  if (path.startsWith('/vita/') || path.startsWith('/vivere/')) return 'vita';
  if (path.startsWith('/statistiche/') || path.startsWith('/stats/')) return 'statistiche';
  if (path.startsWith('/glossario/')) return 'glossario';
  return 'other';
}

/**
 * Send an ad lifecycle event to PostHog and gtag (GA4) when present.
 * Fire-and-forget — never throws, never blocks.
 */
export function trackAdEvent(event: AdEvent, props: AdEventProps): void {
  try {
    const path = props.page_path ?? getPagePath();
    const payload = {
      slot: props.slot,
      ad_format: props.format,
      page_path: path,
      page_template: props.page_template ?? classifyTemplate(path),
      ...(props.reason ? { reason: props.reason } : {}),
    };
    posthogCapture(event, payload);
    const w = typeof window !== 'undefined' ? (window as Window & { gtag?: (...args: unknown[]) => void }) : undefined;
    if (w && typeof w.gtag === 'function') {
      w.gtag('event', event, payload);
    }
  } catch {
    // telemetry must never break ad rendering
  }
}
