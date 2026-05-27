/**
 * Shared user-agent patterns identifying low-RPM, high-volume bot traffic.
 *
 * Imported by:
 *  - services/adAnalytics.ts (browser-side `isLikelyBot()` for `<AdSenseBanner>` slots)
 *  - build-plugins/constants.ts (build-time inline gate in `ADSENSE_LAZY_LOADER`
 *    so adsbygoogle.js never loads for bots — extends the filter to Auto Ads
 *    formats which bypass the React component)
 *
 * Match strategy: lowercased substring match against `navigator.userAgent`.
 * Search-engine bots (Googlebot, Bingbot) are NOT in this list — they don't
 * execute JS, so the AdSense lazy loader never runs for them anyway.
 *
 * Keep the two consumers in sync by editing here, never by duplicating.
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
