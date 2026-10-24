/**
 * GA4 bot gate for the SPA (2026-10-24).
 *
 * AdSense and PostHog already skipped bot sessions through `isLikelyBot()`;
 * Firebase Analytics did not, so the 1280x1200 headless fleet reached GA4 as
 * ~106k sessions in 28 days (half of the property, 0 key events), and the
 * 1600x1600 Chrome 99 fleet as ~11k more. The verdict
 * is the same union the static `gtag-init.js` applies (`GA4_BOT_GATE_FN` in
 * build-plugins/constants.ts): `isLikelyBot()` OR a declared crawler/unfurler
 * (`isCrawlerVisitorAgent()`).
 *
 * The crawler pattern lives in functions/src/lib/returnVisit.js, which also
 * carries the return-visit classifier; it is imported lazily so the early
 * Firebase chunk does not grow for a regex. Fail-open on that import: a failed
 * chunk must not silence analytics for real visitors.
 */
import { CRAWLER_UA_DEVICE_EXCEPTIONS, isLikelyBot } from './botPatterns';

export async function isAutomatedAnalyticsVisitor(): Promise<boolean> {
  if (isLikelyBot()) return true;
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent || '';
  // A handset whose model name contains `bot` (CUBOT) is a person, not a crawler.
  const lower = userAgent.toLowerCase();
  if (CRAWLER_UA_DEVICE_EXCEPTIONS.some((token) => lower.includes(token))) return false;
  try {
    const { isCrawlerVisitorAgent } = await import('@/functions/src/lib/returnVisit.js');
    return isCrawlerVisitorAgent(userAgent);
  } catch {
    return false;
  }
}
