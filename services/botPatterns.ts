/**
 * Shared user-agent patterns + `isLikelyBot()` identifying low-RPM,
 * high-volume bot traffic.
 *
 * Imported by:
 *  - services/adAnalytics.ts (re-exports `isLikelyBot()` for `<AdSenseBanner>` slots)
 *  - services/posthog.ts (gates `ensurePostHog()` so bot sessions never init
 *    PostHog — no $pageview / $pageleave / session-replay / explicit captures
 *    fire, keeping event volume under the free-tier 1M/mo cap)
 *  - build-plugins/constants.ts (build-time inline gate `BOT_GATE_FN`, the JS
 *    twin of `isLikelyBot()`, embedded in `ADSENSE_LAZY_LOADER` +
 *    `POSTHOG_INIT_CONTENT` so neither adsbygoogle.js nor PostHog loads for bots
 *    on static pages — extends the filter to surfaces the React component never
 *    mounts on)
 *
 * Match strategy: lowercased substring match against `navigator.userAgent`.
 * Search-engine bots (Googlebot, Bingbot) are NOT in this list — they don't
 * execute JS, so the AdSense lazy loader never runs for them anyway.
 *
 * Keep all consumers in sync by editing here, never by duplicating. The build
 * inline gate (`BOT_GATE_FN` in build-plugins/constants.ts) is the one place
 * the logic is necessarily re-expressed as a string — it is kept byte-aligned
 * with `isLikelyBot()` and covered by tests/bot-gate-parity.test.ts.
 */
export const BOT_UA_PATTERNS: readonly string[] = [
  // Headless browsers / automation
  'headlesschrome',
  'phantomjs',
  'puppeteer',
  'playwright',
  'selenium',
  'webdriver',
  'cypress',
  // Performance / synthetic monitoring
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
  // HTTP client libraries
  'http_request',
  'python-requests',
  'go-http-client',
  'okhttp',
  'curl/',
  'wget/',
  'libwww',
  // SEO crawlers
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
  // AI assistants — render JS like real users but produce zero-RPM impressions
  'gptbot',
  'chatgpt-user',
  'oai-searchbot',
  'claudebot',
  'claude-web',
  'claude-user',
  'claude-searchbot',
  'anthropic-ai',
  'perplexitybot',
  'perplexity-user',
  'google-extended',
  'googleother',
  'applebot-extended',
  'meta-externalagent',
  'facebookbot',
  'ccbot',
  'amazonbot',
  'bytespider',
  'cohere-ai',
  'youbot',
  'mistralbot',
  'qwenbot',
  'grokbot',
  'phindbot',
  'exabot',
  'kagibot',
  'iaskbot',
  'deepseekbot',
  'copilotbot',
  'bravebot',
  'neevabot',
  'diffbot',
];

/**
 * Layered bot detection. Each layer cuts a different population:
 *  1. SSR / no UA      — never an ad-eligible session.
 *  2. webdriver flag   — Playwright/Selenium/Puppeteer base.
 *  3. UA substring     — known crawler / AI / monitoring strings.
 *  4. Chrome-without-chrome-object — old headless Chrome stealth.
 *  5. Inconsistent navigator props — modern stealth-puppeteer signals
 *     (empty languages, missing plugins on a real Chrome UA, missing
 *     `permissions` API). False-positive risk on iframes / restricted
 *     contexts is bounded by REQUIRING the UA to claim a "real" browser.
 *
 * On purpose NOT here: WebGL renderer / canvas fingerprint / TLS JA3.
 * Those add weight but are bypassable by `puppeteer-extra-plugin-stealth`
 * and other anti-detect kits — false confidence at high bundle cost. We'd
 * spend ~25KB to catch a rounding error in invalid traffic. The honest
 * structural fix is a Cloudflare gray-cloud edge filter; until then this
 * client-side gate stays purposely lightweight.
 *
 * Consumed by both AdSense slot gating (services/adAnalytics.ts) and the
 * PostHog init gate (services/posthog.ts) so bot traffic neither requests ads
 * nor emits analytics events. The static-HTML twin is `BOT_GATE_FN` in
 * build-plugins/constants.ts — keep the two in sync (tests/bot-gate-parity).
 */
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

  // ── Modern stealth signals — only fire when UA claims a real desktop browser ──
  // (otherwise we'd reject restricted iframes, IGNORE preview bots Google wants
  // through, and other legit edge cases.)
  const claimsDesktopChrome = ua.includes('chrome') && !ua.includes('mobile');
  if (claimsDesktopChrome) {
    // Real Chrome ships ≥1 language; headless defaults to [].
    const langs = navigator.languages;
    if (Array.isArray(langs) && langs.length === 0) return true;

    // Real Chrome on desktop ships ≥1 plugin (PDF Viewer at minimum since
    // Chrome 87). Headless Chrome reports plugins.length === 0 by default.
    const plugins = (navigator as Navigator & { plugins?: { length: number } }).plugins;
    if (plugins && plugins.length === 0) {
      // Don't reject mobile — mobile Chrome reports 0 plugins legitimately.
      return true;
    }

    // The Permissions API exists in all real Chrome ≥ 43. Missing on the
    // claimed-Chrome UA = stealth.
    if (typeof (navigator as Navigator & { permissions?: unknown }).permissions === 'undefined') {
      return true;
    }
  }

  return false;
}
