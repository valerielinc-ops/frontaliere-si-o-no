/**
 * gh-models-endpoint.mjs — single source for the GitHub Models endpoint.
 *
 * The old host `models.inference.ai.azure.com` was retired and no longer
 * resolves at all (NXDOMAIN, verified 2026-09-05). A dead host is worse than a
 * dead endpoint: a DNS failure surfaces as a network error, which bounded-retry
 * helpers classify as TRANSIENT and therefore sleep-and-retry against a name
 * that can never come back — pure wasted wall clock on every run.
 *
 * The documented successor resolves and answers `410
 * github_models_retirement_brownout` while the retirement brownout is on. 410
 * is NOT 429 and NOT 5xx, so retry helpers correctly treat it as permanent and
 * give up after one attempt with zero wait.
 *
 * Kept here rather than inline so the URL cannot drift between the callers that
 * share it (issue #7399: it had already drifted into two literals).
 *
 * NOTE: this endpoint requires publisher-prefixed model ids (`openai/gpt-4o`,
 * not `gpt-4o`).
 */
export const GH_MODELS_URL = 'https://models.github.ai/inference/chat/completions';
