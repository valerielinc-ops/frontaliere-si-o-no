import { describe, expect, it, vi } from 'vitest';

const freeTranslateWithRetryDetailed = vi.hoisted(() => vi.fn());

vi.mock('../scripts/lib/free-translate.mjs', () => ({ freeTranslateWithRetryDetailed }));

import { translate } from '../scripts/lib/translation-shadow-provider-v2.mjs';

describe('translation shadow provider v2 generation guard', () => {
  it('does not invoke free translation when generation is disabled', () => {
    const previousGenerationFlag = process.env.TRANSLATION_SHADOW_ENABLE_GENERATION;
    const fail = vi.fn();
    try {
      process.env.TRANSLATION_SHADOW_ENABLE_GENERATION = '0';

      const returned = translate({
        sourceText: 'Senior developer for international projects',
        sourceLang: 'en',
        targetLang: 'it',
        field: 'title',
      }, {
        signal: new AbortController().signal,
        succeedText: vi.fn(),
        fail,
      });

      expect(returned).toBeUndefined();
      expect(fail).toHaveBeenCalledTimes(1);
      expect(freeTranslateWithRetryDetailed).not.toHaveBeenCalled();
    } finally {
      if (previousGenerationFlag === undefined) delete process.env.TRANSLATION_SHADOW_ENABLE_GENERATION;
      else process.env.TRANSLATION_SHADOW_ENABLE_GENERATION = previousGenerationFlag;
    }
  });
});
