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

  it('sends the complete source at the 2000-character boundary', async () => {
    vi.resetModules();
    vi.stubEnv('HF_TOKEN', 'test-token');
    vi.stubEnv('HUGGINGFACE_API_KEY', '');
    const source = 'a'.repeat(2000);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{ translation_text: 'traduzione completa' }],
    } as Response);
    const { translateWithHuggingFace } = await import('../../scripts/lib/free-translate.mjs');
    const outcome: { incomplete?: boolean } = {};

    const translated = await translateWithHuggingFace(source, 'it', 'en', outcome);

    expect(translated).toBe('traduzione completa');
    expect(outcome.incomplete).not.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, request] = fetchSpy.mock.calls[0];
    expect(JSON.parse(String(request?.body))).toMatchObject({ inputs: source });
  });
});
