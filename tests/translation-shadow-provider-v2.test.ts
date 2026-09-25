import { afterEach, describe, expect, it, vi } from 'vitest';

const { freeTranslateWithRetryDetailed } = vi.hoisted(() => ({
  freeTranslateWithRetryDetailed: vi.fn(),
}));

vi.mock('../scripts/lib/free-translate.mjs', () => ({
  freeTranslateWithRetryDetailed,
}));

import { translate } from '../scripts/lib/translation-shadow-provider-v2.mjs';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('translation shadow provider v2 generation guard', () => {
  it('fails closed before a non-zero canary dispatch can call the provider when generation is disabled', () => {
    vi.stubEnv('TRANSLATION_SHADOW_ENABLE_GENERATION', '0');
    const fail = vi.fn();
    const succeedText = vi.fn();

    translate(
      {
        sourceText: 'Senior developer',
        sourceLang: 'en',
        targetLang: 'it',
        field: 'title',
      },
      {
        signal: new AbortController().signal,
        succeedText,
        fail,
      },
    );

    expect(freeTranslateWithRetryDetailed).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledOnce();
    expect(succeedText).not.toHaveBeenCalled();
  });
});
