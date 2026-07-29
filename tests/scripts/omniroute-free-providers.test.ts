import { describe, expect, it } from 'vitest';
import {
  OMNIROUTE_FREE_PROVIDERS,
  resolveOmniRouteAllowlist,
} from '../../scripts/lib/omniroute-free-providers.mjs';

/**
 * Free-only allowlist for OmniRoute provider registration.
 *
 * OMNIROUTE_PROVIDERS_JSON ships every apikey connection decrypted from the dev
 * machine (77 active on 2026-07-29), pay-per-token accounts included. Both the
 * CI registrar and the Remote Config publisher filter through this module, so
 * a paid account is never registered and its key never reaches Remote Config.
 */
describe('OmniRoute free-provider allowlist', () => {
  it('is an allowlist of known free tiers, with no duplicates', () => {
    expect(OMNIROUTE_FREE_PROVIDERS.length).toBeGreaterThan(0);
    expect(new Set(OMNIROUTE_FREE_PROVIDERS).size).toBe(OMNIROUTE_FREE_PROVIDERS.length);
  });

  it('keeps the free providers our own chain already runs at $0', () => {
    for (const p of ['gemini', 'groq', 'openrouter', 'cerebras', 'github-models', 'huggingface']) {
      expect(OMNIROUTE_FREE_PROVIDERS).toContain(p);
    }
  });

  it('excludes pay-per-token gateways', () => {
    // Observed live in ~/.omniroute call_logs and/or billed per token.
    for (const p of ['deepinfra', 'hyperbolic', 'novita', 'nscale', 'poe', 'reka',
      'requesty', 'siliconflow', 'upstage', 'baseten', 'aimlapi', 'deepseek']) {
      expect(OMNIROUTE_FREE_PROVIDERS).not.toContain(p);
    }
  });

  it('excludes trial-credit providers even though they sit in our DEFAULT_CHAIN', () => {
    // Starting credits convert to billing once spent, and OmniRoute's "auto"
    // routing gives us no per-model control over what it spends them on.
    expect(OMNIROUTE_FREE_PROVIDERS).not.toContain('fireworks');
    expect(OMNIROUTE_FREE_PROVIDERS).not.toContain('together');
  });

  it('excludes non-chat APIs that never serve completions', () => {
    for (const p of ['exa-search', 'firecrawl', 'jina-reader', 'serper-search',
      'tavily-search', 'stability-ai', 'fal-ai', 'voyage-ai']) {
      expect(OMNIROUTE_FREE_PROVIDERS).not.toContain(p);
    }
  });

  it('excludes reverse-engineered web endpoints and CLI-bound providers', () => {
    // duckduckgo-web returned HTTP 418 (anti-abuse challenge), auggie HTTP 502
    // ("Auggie CLI not found") — neither can work from a CI runner.
    for (const p of ['deepseek-web', 'gemini-web', 'perplexity-web', 'huggingchat',
      'auggie', 'opencode-go', 'opencode-zen', 'ollama-cloud']) {
      expect(OMNIROUTE_FREE_PROVIDERS).not.toContain(p);
    }
  });

  describe('resolveOmniRouteAllowlist', () => {
    it('unset override yields the built-in free list, filtering on', () => {
      const { allowlist, filteringOff } = resolveOmniRouteAllowlist(undefined);
      expect(filteringOff).toBe(false);
      expect(allowlist.size).toBe(OMNIROUTE_FREE_PROVIDERS.length);
      expect(allowlist.has('groq')).toBe(true);
      expect(allowlist.has('deepinfra')).toBe(false);
    });

    it('an explicit empty string disables filtering (documented ops escape hatch)', () => {
      const { allowlist, filteringOff } = resolveOmniRouteAllowlist('');
      expect(filteringOff).toBe(true);
      expect(allowlist.size).toBe(0);
    });

    it('a CSV override replaces the list outright rather than extending it', () => {
      const { allowlist, filteringOff } = resolveOmniRouteAllowlist('groq, gemini');
      expect(filteringOff).toBe(false);
      expect([...allowlist].sort()).toEqual(['gemini', 'groq']);
      // Not a merge: a built-in entry absent from the override is dropped.
      expect(allowlist.has('cerebras')).toBe(false);
    });

    it('tolerates whitespace and stray separators in the override', () => {
      const { allowlist, filteringOff } = resolveOmniRouteAllowlist('  groq , , gemini ,');
      expect(filteringOff).toBe(false);
      expect([...allowlist].sort()).toEqual(['gemini', 'groq']);
    });

    it('a whitespace-only override reads as empty, i.e. filtering off', () => {
      expect(resolveOmniRouteAllowlist('   ').filteringOff).toBe(true);
    });
  });

  it('filters a realistic mixed payload down to free providers only', () => {
    const offered = ['groq', 'deepinfra', 'gemini', 'poe', 'cerebras', 'stability-ai',
      'openrouter', 'hyperbolic', 'gemini-web', 'llm7'];
    const { allowlist } = resolveOmniRouteAllowlist(undefined);
    expect(offered.filter((p) => allowlist.has(p)).sort())
      .toEqual(['cerebras', 'gemini', 'groq', 'llm7', 'openrouter']);
  });
});
