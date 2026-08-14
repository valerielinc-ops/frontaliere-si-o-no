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

// `isLikelyBot()` lives in services/botPatterns.ts (the shared, dependency-free
// home alongside BOT_UA_PATTERNS) so services/posthog.ts can gate its init on it
// without a circular import through this module. Re-exported here to preserve the
// historical `@/services/adAnalytics` import path used by <AdSenseBanner> + tests.
export { isLikelyBot } from './botPatterns';

export type AdEvent =
  | 'ad_request'
  | 'ad_filled'
  | 'ad_unfilled'
  | 'ad_collapsed'
  | 'ad_bot_skip'
  | 'ad_viewable'
  // Ads-consent banner outcomes (#5842). These make the post-deploy fill-rate
  // change *decomposable*: fill rate alone cannot distinguish "the gate is
  // costing us X%" from "AdSense demand dropped". With these, the drop is
  // attributable — consent_rate = granted / (granted + denied), and expected
  // fill ≈ baseline_fill × consent_rate.
  | 'ad_consent_shown'
  | 'ad_consent_granted'
  | 'ad_consent_denied';

export interface AdEventProps {
  slot: string;
  format: string;
  page_path?: string;
  page_template?: string;
  reason?: string;
  /**
   * Ad network that produced the event. Defaults to 'adsense' when omitted so
   * historical AdSense events keep their meaning; GPT/GAM slots pass 'gpt' so
   * fill-rate and viewability can be segmented per network (the un-tagged GPT
   * no-fills were what made the blended PostHog fill-rate look like a crash —
   * GAM side-rail no-fills were invisible in the metric).
   */
  network?: 'adsense' | 'gpt';
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
      network: props.network ?? 'adsense',
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
