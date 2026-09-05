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
 * them instead of failing the whole group. Returns null when neither source
 * yields a valid token; callers decide whether that is fatal.
 */
export function resolveCrawlerGenerationToken(env = process.env) {
  const explicit = env.CRAWLER_GENERATION_TOKEN;
  // A non-empty explicit token stays authoritative even when malformed: the
  // downstream validators must keep rejecting it instead of silently drifting
  // onto the run coordinates.
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const derived = `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  return isCrawlerGenerationToken(derived) ? derived : null;
}
