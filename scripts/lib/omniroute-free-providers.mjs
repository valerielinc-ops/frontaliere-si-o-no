/**
 * Single source of truth for which OmniRoute provider connections we are
 * willing to use. Shared by the CI registrar (scripts/ci/omniroute-poc-register.mjs)
 * and the local Remote Config publisher (scripts/sync-omniroute-providers-rc.mjs)
 * so the two can never drift apart — the list lived in one of them first, and a
 * copy-paste would have guaranteed exactly that drift (AGENTS.md #6).
 *
 * ALLOWLIST, not denylist: an unknown provider is EXCLUDED. Losing a free
 * provider costs some routing capacity; admitting a paid one costs money, and
 * the project runs on a standing $0 constraint.
 *
 * Inclusion criterion: a PERMANENT free tier reachable with an API key alone —
 * not a trial credit balance that silently converts to billing once spent.
 * That is why fireworks/together are absent even though they sit in our own
 * DEFAULT_CHAIN: their starting credits run out, and OmniRoute's "auto" routing
 * gives us no per-model control over what it spends them on.
 *
 * Excluded by construction (verified against the live 77-provider set on
 * 2026-07-29, and corroborated by ~/.omniroute call_logs):
 *   - pay-per-token gateways — deepinfra, hyperbolic, novita, nscale, poe,
 *     reka, requesty, siliconflow, upstage, baseten, aimlapi (403 observed), …
 *   - non-chat APIs that never serve completions — exa-search, firecrawl,
 *     jina-*, serper-search, tavily-search, stability-ai, fal-ai, voyage-ai, …
 *   - reverse-engineered web endpoints that fail anti-abuse checks from CI IPs
 *     — deepseek-web, gemini-web, perplexity-web, huggingchat
 *     (duckduckgo-web: HTTP 418 "anti-abuse challenge failed")
 *   - CLI/OAuth-bound providers with no binary or session on a runner —
 *     opencode-*, ollama-*, auggie (HTTP 502 "Auggie CLI not found")
 */
export const OMNIROUTE_FREE_PROVIDERS = Object.freeze([
  // Free tiers we already run at $0 in scripts/lib/ai-models.mjs's own chain.
  'cerebras', 'cloudflare-ai', 'codestral', 'cohere', 'gemini', 'github-models',
  'groq', 'huggingface', 'mistral', 'nvidia', 'openrouter', 'sambanova', 'zai',
  // Free-by-construction gateways (no paid plan to fall through to).
  'freeaiapikey', 'freemodel-dev', 'hackclub', 'llm7', 'pollinations',
  'publicai', 'puter', 'uncloseai',
]);

/**
 * Resolve the effective allowlist, honouring the ops override.
 *
 * OMNIROUTE_PROVIDER_ALLOWLIST (CSV) replaces the built-in list outright, and
 * an explicit empty string disables filtering altogether — both settable from
 * Remote Config, so a live incident can be widened or reverted with no deploy.
 * Unset (the normal case) yields the built-in free list.
 *
 * @param {string|undefined} rawOverride typically process.env.OMNIROUTE_PROVIDER_ALLOWLIST
 * @returns {{ allowlist: Set<string>, filteringOff: boolean }}
 */
export function resolveOmniRouteAllowlist(rawOverride) {
  if (rawOverride === undefined) {
    return { allowlist: new Set(OMNIROUTE_FREE_PROVIDERS), filteringOff: false };
  }
  const parsed = rawOverride.split(',').map((s) => s.trim()).filter(Boolean);
  return { allowlist: new Set(parsed), filteringOff: parsed.length === 0 };
}
