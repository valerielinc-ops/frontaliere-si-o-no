// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('translateWithHuggingFace', () => {
  it('rejects source longer than 2000 characters instead of translating a prefix (#7699)', async () => {
    vi.resetModules();
    vi.stubEnv('HF_TOKEN', 'test-token');
    vi.stubEnv('HUGGINGFACE_API_KEY', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { translateWithHuggingFace } = await import('../../scripts/lib/free-translate.mjs');
    const outcome: { incomplete?: boolean } = {};

    const translated = await translateWithHuggingFace(
      'a'.repeat(3000),
      'it',
      'en',
      outcome,
    );

    expect(translated).toBe('');
    expect(outcome.incomplete).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
