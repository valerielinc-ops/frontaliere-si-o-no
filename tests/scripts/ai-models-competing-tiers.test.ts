import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AI_COMPETING_TIERS — CSV kill-switch promoting last-resort tiers (local/,
 * omniroute/, claude-cli/) to tier-0 so they compete on real Firestore score
 * against every normal chain model, instead of unconditionally sinking below
 * all of them (scripts/lib/ai-models.mjs's _lastResortTier / sortChainByScore).
 *
 * Background (2026-07-29, owner decision): OmniRoute has ~74 registered
 * providers (~45 unused = real spare capacity) and free-tier direct models
 * hit 429/exhaustion often (run 30375068235: 42×429, 3 cooldowns, 185s pure
 * sleep). Default promotes omniroute + claude-cli; local/ deliberately never
 * promoted (CPU inference ~12-17min/gen, run 28802314827, must never win a
 * live race against a network call regardless of score).
 *
 * These tests cover: default promotion, the AI_COMPETING_TIERS="" instant
 * rollback (exact pre-2026-07-29 behavior), malformed-value fallback+warn
 * once, the gradual-ramp-up property (no artificial score boost — a promoted
 * tier only wins a tie via its DEFAULT_CHAIN array position, which stays at
 * the bottom), and the composition with AI_LAST_RESORT_ORDER for whichever
 * tiers are NOT promoted. Relative dates only where dates are involved
 * (none here — this is pure string/env-var/tier-rank logic).
 */
const aiModels = await import('../../scripts/lib/ai-models.mjs');
const { AI_MODELS, DEFAULT_CHAIN, getPreferredModel, resetState } = aiModels;

describe('ai-models AI_COMPETING_TIERS kill-switch', () => {
  const ENV_KEYS = [
    'AI_COMPETING_TIERS', 'AI_LAST_RESORT_ORDER',
    'OMNIROUTE_ENABLED', 'OMNIROUTE_URL', 'OMNIROUTE_API_KEY',
    'LOCAL_LLM_ENABLED',
    'ENABLE_HAIKU_ARTICLE_FALLBACK', 'CLAUDE_CODE_OAUTH_TOKEN',
    'GEMINI_API_KEY',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    resetState();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    warnSpy.mockRestore();
    resetState();
  });

  /** Enables all 3 last-resort tiers so every one is a candidate in the chain. */
  function enableAllLastResortTiers() {
    process.env.OMNIROUTE_ENABLED = '1';
    process.env.LOCAL_LLM_ENABLED = '1';
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
  }

  describe('default (unset AI_COMPETING_TIERS)', () => {
    it('promotes omniroute/auto above local/fallback (tier-0 beats tier-1, regardless of chain order)', () => {
      enableAllLastResortTiers();
      // local/fallback listed FIRST in the chain array — if tier rank didn't
      // matter, index-order or score tiebreak alone could pick it. It must
      // still lose to the promoted tier.
      const chain = [AI_MODELS.LOCAL_FALLBACK, AI_MODELS.OMNIROUTE_AUTO];
      expect(getPreferredModel({ chain })).toBe(AI_MODELS.OMNIROUTE_AUTO);
    });

    it('promotes claude-cli/haiku above local/fallback (tier-0 beats tier-1, regardless of chain order)', () => {
      enableAllLastResortTiers();
      const chain = [AI_MODELS.LOCAL_FALLBACK, AI_MODELS.CLAUDE_CLI_HAIKU];
      expect(getPreferredModel({ chain })).toBe(AI_MODELS.CLAUDE_CLI_HAIKU);
    });

    it('local/fallback alone still wins when it is the only available candidate (never removed from the chain)', () => {
      process.env.LOCAL_LLM_ENABLED = '1';
      expect(getPreferredModel({ chain: [AI_MODELS.LOCAL_FALLBACK] })).toBe(AI_MODELS.LOCAL_FALLBACK);
    });

    it('ramp-up: a normal tier-0 model with no accumulated score still outranks a freshly-promoted tier tied at score 0 (DEFAULT_CHAIN array-position tiebreak, no artificial initial score)', () => {
      process.env.GEMINI_API_KEY = 'fake-key-for-routing-test-only';
      enableAllLastResortTiers();
      // sortChainByScore's index tiebreak (scripts/lib/ai-models.mjs) is the
      // position within the chain ARRAY PASSED IN, not a lookup into
      // DEFAULT_CHAIN — so this test must reproduce DEFAULT_CHAIN's real
      // relative order for the tiebreak to mean anything, instead of hand-
      // ordering the array (a hand-written order silently asserts nothing
      // about DEFAULT_CHAIN once tier-0 makes both candidates equal-tier).
      // Deriving it from the real DEFAULT_CHAIN also makes this assertion
      // self-updating if the array is ever reordered. GEMINI_FLASH sits far
      // earlier in DEFAULT_CHAIN than OMNIROUTE_AUTO / CLAUDE_CLI_HAIKU (both
      // live at the very bottom of the array — see ai-models.mjs lines
      // ~600-622). With every score equal (0, nothing persisted yet), the
      // promoted tiers start BEHIND, not pinned to the top.
      const candidates = new Set([AI_MODELS.CLAUDE_CLI_HAIKU, AI_MODELS.OMNIROUTE_AUTO, AI_MODELS.GEMINI_FLASH]);
      const chain = DEFAULT_CHAIN.filter((m) => candidates.has(m));
      expect(chain).toEqual([AI_MODELS.GEMINI_FLASH, AI_MODELS.OMNIROUTE_AUTO, AI_MODELS.CLAUDE_CLI_HAIKU]); // sanity-check the assumed real order
      expect(getPreferredModel({ chain })).toBe(AI_MODELS.GEMINI_FLASH);
    });
  });

  describe('AI_COMPETING_TIERS="" (explicit empty string — instant rollback)', () => {
    it('restores the exact pre-2026-07-29 behavior: all 3 tiers sink below tier-0, ranked among themselves by AI_LAST_RESORT_ORDER (default: omniroute, local, claude-cli)', () => {
      enableAllLastResortTiers();
      process.env.AI_COMPETING_TIERS = '';
      const chain = [AI_MODELS.CLAUDE_CLI_HAIKU, AI_MODELS.LOCAL_FALLBACK, AI_MODELS.OMNIROUTE_AUTO];
      expect(getPreferredModel({ chain })).toBe(AI_MODELS.OMNIROUTE_AUTO);
      expect(getPreferredModel({ chain: chain.filter((m) => m !== AI_MODELS.OMNIROUTE_AUTO) })).toBe(AI_MODELS.LOCAL_FALLBACK);
      expect(getPreferredModel({ chain: [AI_MODELS.CLAUDE_CLI_HAIKU, AI_MODELS.LOCAL_FALLBACK] })).toBe(AI_MODELS.LOCAL_FALLBACK);
      expect(warnSpy).not.toHaveBeenCalled(); // explicit "" is valid, not malformed
    });

    it('a normal tier-0 cloud model still outranks all 3 last-resort tiers under the rollback, same as before this feature existed', () => {
      process.env.GEMINI_API_KEY = 'fake-key-for-routing-test-only';
      enableAllLastResortTiers();
      process.env.AI_COMPETING_TIERS = '';
      const chain = [AI_MODELS.CLAUDE_CLI_HAIKU, AI_MODELS.LOCAL_FALLBACK, AI_MODELS.OMNIROUTE_AUTO, AI_MODELS.GEMINI_FLASH];
      expect(getPreferredModel({ chain })).toBe(AI_MODELS.GEMINI_FLASH);
    });
  });

  describe('malformed AI_COMPETING_TIERS', () => {
    it.each([
      ['unknown tier name', 'omniroute,cloudflare'],
      ['garbage string', 'not-a-real-value'],
      ['empty entries only', ',,'],
    ])('falls back to the default (omniroute, claude-cli) without crashing, and warns once (%s: %s)', (_label, value) => {
      enableAllLastResortTiers();
      process.env.AI_COMPETING_TIERS = value;
      const chain = [AI_MODELS.LOCAL_FALLBACK, AI_MODELS.OMNIROUTE_AUTO];

      expect(() => getPreferredModel({ chain })).not.toThrow();
      expect(getPreferredModel({ chain })).toBe(AI_MODELS.OMNIROUTE_AUTO); // default competing tiers applied

      // Call again (simulates the next callLLM in the same run) — the warning
      // must not repeat every call, only once per process.
      getPreferredModel({ chain });
      getPreferredModel({ chain });
      const matching = warnSpy.mock.calls.filter((args) => String(args[0]).includes('AI_COMPETING_TIERS'));
      expect(matching).toHaveLength(1);
    });

    it('resetState() clears the warn-once flag so a new process/test can warn again', () => {
      enableAllLastResortTiers();
      process.env.AI_COMPETING_TIERS = 'garbage';
      getPreferredModel({ chain: [AI_MODELS.LOCAL_FALLBACK, AI_MODELS.OMNIROUTE_AUTO] });
      expect(warnSpy.mock.calls.filter((a) => String(a[0]).includes('AI_COMPETING_TIERS'))).toHaveLength(1);

      resetState();
      getPreferredModel({ chain: [AI_MODELS.LOCAL_FALLBACK, AI_MODELS.OMNIROUTE_AUTO] });
      expect(warnSpy.mock.calls.filter((a) => String(a[0]).includes('AI_COMPETING_TIERS'))).toHaveLength(2);
    });

    // A subset that's valid but has one bad entry must NOT partially apply —
    // the whole value is rejected, falling back to the full default.
    it('a partially-valid value (one good tier name + one bad) is rejected wholesale, not partially applied', () => {
      enableAllLastResortTiers();
      process.env.AI_COMPETING_TIERS = 'omniroute,not-a-tier';
      const chain = [AI_MODELS.LOCAL_FALLBACK, AI_MODELS.CLAUDE_CLI_HAIKU];
      // Default (omniroute, claude-cli) applies, not just "omniroute" from the
      // partially-valid input — claude-cli/haiku must still be promoted.
      expect(getPreferredModel({ chain })).toBe(AI_MODELS.CLAUDE_CLI_HAIKU);
    });
  });

  describe('whitespace and duplicate tolerance', () => {
    it('tolerates whitespace around tier names', () => {
      enableAllLastResortTiers();
      process.env.AI_COMPETING_TIERS = ' omniroute , claude-cli ';
      const chain = [AI_MODELS.LOCAL_FALLBACK, AI_MODELS.OMNIROUTE_AUTO];
      expect(getPreferredModel({ chain })).toBe(AI_MODELS.OMNIROUTE_AUTO);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('tolerates a duplicate tier name (deduped, not rejected)', () => {
      enableAllLastResortTiers();
      process.env.AI_COMPETING_TIERS = 'omniroute,omniroute,claude-cli';
      const chain = [AI_MODELS.LOCAL_FALLBACK, AI_MODELS.OMNIROUTE_AUTO];
      expect(getPreferredModel({ chain })).toBe(AI_MODELS.OMNIROUTE_AUTO);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('a single promoted tier — AI_LAST_RESORT_ORDER still governs the tiers left behind', () => {
    it('AI_COMPETING_TIERS=claude-cli promotes only claude-cli; omniroute and local still rank between themselves via the default AI_LAST_RESORT_ORDER (omniroute first)', () => {
      enableAllLastResortTiers();
      process.env.AI_COMPETING_TIERS = 'claude-cli';
      const chain = [AI_MODELS.LOCAL_FALLBACK, AI_MODELS.OMNIROUTE_AUTO, AI_MODELS.CLAUDE_CLI_HAIKU];

      // claude-cli promoted → wins outright.
      expect(getPreferredModel({ chain })).toBe(AI_MODELS.CLAUDE_CLI_HAIKU);
      // With claude-cli removed, the remaining two are still both last-resort
      // — omniroute outranks local under the DEFAULT AI_LAST_RESORT_ORDER.
      expect(getPreferredModel({ chain: chain.filter((m) => m !== AI_MODELS.CLAUDE_CLI_HAIKU) })).toBe(AI_MODELS.OMNIROUTE_AUTO);
    });

    it('AI_LAST_RESORT_ORDER overrides the relative order of the tiers AI_COMPETING_TIERS did NOT promote, while the promoted tier is unaffected by it', () => {
      enableAllLastResortTiers();
      process.env.AI_COMPETING_TIERS = 'claude-cli';
      process.env.AI_LAST_RESORT_ORDER = 'local,omniroute,claude-cli'; // flips omniroute/local order
      const chain = [AI_MODELS.LOCAL_FALLBACK, AI_MODELS.OMNIROUTE_AUTO, AI_MODELS.CLAUDE_CLI_HAIKU];

      // claude-cli stays promoted (tier-0) regardless of AI_LAST_RESORT_ORDER
      // even including it in that CSV — a model's tier IDENTITY doesn't
      // change, only the RANK of tiers that are still sinking does.
      expect(getPreferredModel({ chain })).toBe(AI_MODELS.CLAUDE_CLI_HAIKU);
      // Among the remaining two, local now outranks omniroute per the override.
      expect(getPreferredModel({ chain: chain.filter((m) => m !== AI_MODELS.CLAUDE_CLI_HAIKU) })).toBe(AI_MODELS.LOCAL_FALLBACK);
    });
  });
});
