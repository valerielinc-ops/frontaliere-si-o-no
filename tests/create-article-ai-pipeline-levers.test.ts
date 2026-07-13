/**
 * Tests for the two AI-optimization levers added to scripts/create-article.mjs
 * on top of the fact-check gate (see AGENTS.md Non-Negotiable #1 — never
 * publish unverified content):
 *
 * LEVA A — Fact-check response cache (DEFAULT ON — kill switch).
 *   buildFactCheckCallOptions() decides whether a fact-check _aiCallLLM()
 *   call carries `cache: true`, gated by the CREATE_ARTICLE_FACTCHECK_CACHE
 *   env flag. Production already hard-codes `cache: true` on this call (no
 *   flag, no namespace) — so the default here must stay ON to preserve
 *   today's behavior byte-identically; the env var is a kill switch to turn
 *   the cache OFF, not an opt-in to turn it on. Safe by construction
 *   (ai-models.mjs' response cache key is content+model+force-chain-state
 *   keyed — see scripts/lib/ai-models.mjs ~1070-1088), so no cacheNamespace
 *   is added either (adding one would change the cache key vs. production).
 *
 * LEVA B — Min-words retry model dedup (quality-neutral, DEFAULT ON).
 *   selectMinWordsRetryModel() never repeats the immediately preceding
 *   attempt's model back-to-back. Same model set, same relative order —
 *   only skips a redundant consecutive repeat (which is a near-certain
 *   repeat of the same too-short output).
 */

import { describe, expect, it, afterEach } from 'vitest';
import { buildFactCheckCallOptions, selectMinWordsRetryModel } from '../scripts/create-article.mjs';

describe('buildFactCheckCallOptions (Leva A — fact-check cache, default ON / kill switch)', () => {
  const ENV_KEY = 'CREATE_ARTICLE_FACTCHECK_CACHE';
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('includes exactly cache: true (no cacheNamespace) when the env flag is unset — byte-identical to production', () => {
    delete process.env[ENV_KEY];
    const opts = buildFactCheckCallOptions({ model: 'gpt-4o', temperature: 0, maxTokens: 4000, timeout: 60_000, bypassForceChain: true });

    expect(opts).toMatchObject({ cache: true, model: 'gpt-4o', temperature: 0, maxTokens: 4000, timeout: 60_000, bypassForceChain: true });
    expect(opts).not.toHaveProperty('cacheNamespace');
  });

  it('includes exactly cache: true (no cacheNamespace) when the env flag is the empty string', () => {
    process.env[ENV_KEY] = '';
    const opts = buildFactCheckCallOptions({ model: 'gpt-4o' });
    expect(opts).toMatchObject({ cache: true });
    expect(opts).not.toHaveProperty('cacheNamespace');
  });

  it('does NOT include cache for explicit OFF flag values (kill switch)', () => {
    for (const v of ['0', 'false', 'no', 'off', 'OFF', 'False']) {
      process.env[ENV_KEY] = v;
      const opts = buildFactCheckCallOptions({ model: 'gpt-4o' });
      expect(opts, `flag value "${v}" must disable cache`).not.toHaveProperty('cache');
    }
  });

  it('includes cache: true for explicit ON-ish flag values (any non-OFF value stays ON)', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', 'anything-else']) {
      process.env[ENV_KEY] = v;
      const opts = buildFactCheckCallOptions({ model: 'gpt-4o', bypassForceChain: true });
      expect(opts, `flag value "${v}" must keep cache enabled`).toMatchObject({ cache: true });
      expect(opts).not.toHaveProperty('cacheNamespace');
    }
  });

  it('the explicit cacheEnabled param overrides env (unit-test hook, no network/env needed)', () => {
    delete process.env[ENV_KEY];
    expect(buildFactCheckCallOptions({ model: 'x' }, true)).toMatchObject({ cache: true });
    process.env[ENV_KEY] = '0';
    expect(buildFactCheckCallOptions({ model: 'x' }, false)).not.toHaveProperty('cache');
  });

  it('never mutates the caller-supplied base opts object', () => {
    const base = { model: 'gpt-4o', modelUsedRef: { model: null } };
    const frozenSnapshot = JSON.stringify({ model: base.model });
    buildFactCheckCallOptions(base, true);
    expect(JSON.stringify({ model: base.model })).toBe(frozenSnapshot);
    expect(base).not.toHaveProperty('cache');
  });
});

describe('selectMinWordsRetryModel (Leva B — min-words retry model dedup, default ON)', () => {
  it('never repeats the previous attempt model back-to-back over an extended retry run (real rotation)', () => {
    // Uses the REAL MIN_WORDS_MODEL_ROTATION (default param) — no rotation
    // override — across more attempts than the rotation has entries, which
    // is exactly the case that used to clamp-repeat the last model.
    let previous: string | null = null;
    for (let attempt = 1; attempt <= 15; attempt++) {
      const model = selectMinWordsRetryModel(attempt, previous);
      if (previous !== null) {
        expect(model, `attempt ${attempt} repeated previous model "${previous}"`).not.toBe(previous);
      }
      previous = model;
    }
  });

  it('is a no-op for the default 6-attempt config (all 6 picks already distinct, no behavior change)', () => {
    let previous: string | null = null;
    const picks: string[] = [];
    for (let attempt = 1; attempt <= 6; attempt++) {
      const model = selectMinWordsRetryModel(attempt, previous);
      picks.push(model);
      previous = model;
    }
    expect(new Set(picks).size).toBe(6);
  });

  it('advances to the next distinct rotation entry when the plain pick would repeat the previous model', () => {
    const rotation = ['a', 'b', 'c'];
    // Plain index for attempt 2 is rotation[1] = 'b'; if attempt 1 already
    // used 'b' (e.g. an outer-context forced model), attempt 2 must skip to 'c'.
    expect(selectMinWordsRetryModel(2, 'b', rotation)).toBe('c');
    // Normal case (no collision) is untouched.
    expect(selectMinWordsRetryModel(2, 'a', rotation)).toBe('b');
  });

  it('wraps around at the tail once attempts exceed the rotation length, still skipping the duplicate', () => {
    const rotation = ['a', 'b', 'c'];
    // attempt 4 clamps to index 2 ('c'). If the previous attempt (3) was
    // also 'c' (the exact latent bug: CREATE_ARTICLE_MIN_WORDS_RETRIES > 3),
    // it must wrap forward to 'a' instead of repeating 'c'.
    expect(selectMinWordsRetryModel(4, 'c', rotation)).toBe('a');
    // attempt 5 clamps to index 2 ('c') again; previous model was 'a' (from
    // the wrap above), so no collision this time — plain pick stands.
    expect(selectMinWordsRetryModel(5, 'a', rotation)).toBe('c');
  });

  it('keeps the full model set and relative order — only skips consecutive duplicates, never reorders below the plain pick', () => {
    const rotation = ['a', 'b', 'c', 'd'];
    // No collision anywhere: every attempt must equal the plain clamped pick.
    let previous: string | null = null;
    const expected = ['a', 'b', 'c', 'd'];
    for (let i = 0; i < expected.length; i++) {
      const model = selectMinWordsRetryModel(i + 1, previous, rotation);
      expect(model).toBe(expected[i]);
      previous = model;
    }
  });

  it('can be disabled via the enabled flag to restore the exact legacy clamp (duplicates allowed) — rollback path', () => {
    const rotation = ['a', 'b', 'c'];
    expect(selectMinWordsRetryModel(4, 'c', rotation, false)).toBe('c');
    expect(selectMinWordsRetryModel(1, 'a', rotation, false)).toBe('a');
  });
});
