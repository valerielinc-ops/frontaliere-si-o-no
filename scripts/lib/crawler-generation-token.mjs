/** Canonical grammar shared by crawler-generation producers and observers. */
const CRAWLER_GENERATION_TOKEN_RE = /^[1-9][0-9]*-[1-9][0-9]*$/;

export function isCrawlerGenerationToken(value) {
  return typeof value === 'string' && CRAWLER_GENERATION_TOKEN_RE.test(value);
}

/**
 * Resolve the generation token for a crawler-group run.
 *
 * `CRAWLER_GENERATION_TOKEN` arrives from the dispatcher input, so a group run
 * started without it (direct dispatch, re-run of a leg) sees an EMPTY string —
 * which used to kill every crawler of the group. The run coordinates carry the
 * same grammar the orchestrator computes for its dispatches, so derive from
 * them when the input is absent. A non-empty malformed explicit token fails
 * closed rather than silently falling back to different run coordinates.
 * Returns null when neither source yields a valid token; callers decide whether
 * that is fatal.
 */
export function resolveCrawlerGenerationToken(env = process.env) {
  const explicit = env.CRAWLER_GENERATION_TOKEN;
  // An explicit token stays authoritative only when it obeys the shared
  // grammar. A non-empty malformed value is rejected before the caller builds
  // a descriptor; it must not silently fall back to different run coordinates.
  if (typeof explicit === 'string' && explicit.length > 0) {
    return isCrawlerGenerationToken(explicit) ? explicit : null;
  }
  const derived = `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  return isCrawlerGenerationToken(derived) ? derived : null;
}
