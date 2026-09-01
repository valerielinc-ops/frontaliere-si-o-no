/** Canonical grammar shared by crawler-generation producers and observers. */
const CRAWLER_GENERATION_TOKEN_RE = /^[1-9][0-9]*-[1-9][0-9]*$/;

export function isCrawlerGenerationToken(value) {
  return typeof value === 'string' && CRAWLER_GENERATION_TOKEN_RE.test(value);
}
