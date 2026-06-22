/**
 * local-opus-mt — LOCAL Opus-MT translation tier (Helsinki-NLP via
 * @huggingface/transformers/onnxruntime, no keys/quota/rate-limit). Mirrors the
 * embeddingClient local-inference pattern. These tests use the injectable
 * translator seam (setLocalOpusMtForTests) so they never download/run real ONNX
 * models. The tier is opt-in via MT_LOCAL_OPUSMT and fails CLOSED (returns '').
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  translateWithLocalOpusMt,
  localOpusMtEnabled,
  setLocalOpusMtForTests,
} from '../scripts/lib/local-opus-mt.mjs';

const ORIG = process.env.MT_LOCAL_OPUSMT;

beforeEach(() => {
  process.env.MT_LOCAL_OPUSMT = '1';
});
afterEach(() => {
  setLocalOpusMtForTests(null);
  if (ORIG === undefined) delete process.env.MT_LOCAL_OPUSMT;
  else process.env.MT_LOCAL_OPUSMT = ORIG;
});

/**
 * Fake translator factory: records which model ids were instantiated and every
 * text each was called with. Each model id maps a chunk to `<id>:<text>` so
 * pivot legs are distinguishable.
 */
function fakeFactory() {
  const loaded: string[] = [];
  const calls: { model: string; text: string }[] = [];
  const factory = (modelId: string) => {
    loaded.push(modelId);
    return async (text: string) => {
      calls.push({ model: modelId, text });
      // Strip a previous-leg prefix so pivot output stays readable.
      const base = text.includes('] ') ? text.slice(text.indexOf('] ') + 2) : text;
      return [{ translation_text: `[${modelId}] ${base}` }];
    };
  };
  return Object.assign(factory, { loaded, calls });
}

describe('local-opus-mt — opt-in gate', () => {
  it('localOpusMtEnabled reflects MT_LOCAL_OPUSMT truthiness', () => {
    process.env.MT_LOCAL_OPUSMT = '1';
    expect(localOpusMtEnabled()).toBe(true);
    process.env.MT_LOCAL_OPUSMT = 'true';
    expect(localOpusMtEnabled()).toBe(true);
    process.env.MT_LOCAL_OPUSMT = '0';
    expect(localOpusMtEnabled()).toBe(false);
    process.env.MT_LOCAL_OPUSMT = '';
    expect(localOpusMtEnabled()).toBe(false);
  });

  it('returns "" without touching the model when disabled', async () => {
    process.env.MT_LOCAL_OPUSMT = '0';
    const f = fakeFactory();
    setLocalOpusMtForTests(f);
    expect(await translateWithLocalOpusMt('Ciao mondo', 'it', 'en')).toBe('');
    expect(f.loaded).toHaveLength(0);
  });
});

describe('local-opus-mt — direct English-paired models', () => {
  it('it→en loads exactly Xenova/opus-mt-it-en and returns its output', async () => {
    const f = fakeFactory();
    setLocalOpusMtForTests(f);
    const out = await translateWithLocalOpusMt('Cerchiamo un infermiere', 'it', 'en');
    expect(f.loaded).toEqual(['Xenova/opus-mt-it-en']);
    expect(out).toBe('[Xenova/opus-mt-it-en] Cerchiamo un infermiere');
  });

  it('en→de uses the direct en-de model', async () => {
    const f = fakeFactory();
    setLocalOpusMtForTests(f);
    await translateWithLocalOpusMt('We are hiring', 'en', 'de');
    expect(f.loaded).toEqual(['Xenova/opus-mt-en-de']);
  });
});

describe('local-opus-mt — English pivot for non-EN pairs', () => {
  it('de→fr pivots de→en then en→fr (only EN-paired models)', async () => {
    const f = fakeFactory();
    setLocalOpusMtForTests(f);
    const out = await translateWithLocalOpusMt('Wir suchen einen Pfleger', 'de', 'fr');
    expect(f.loaded).toEqual(['Xenova/opus-mt-de-en', 'Xenova/opus-mt-en-fr']);
    // Second leg receives the first leg's output as input.
    expect(f.calls[1].text).toContain('opus-mt-de-en');
    expect(out).toContain('opus-mt-en-fr');
  });

  it('it→fr pivots it→en then en→fr', async () => {
    const f = fakeFactory();
    setLocalOpusMtForTests(f);
    await translateWithLocalOpusMt('Cerchiamo personale', 'it', 'fr');
    expect(f.loaded).toEqual(['Xenova/opus-mt-it-en', 'Xenova/opus-mt-en-fr']);
  });
});

describe('local-opus-mt — guards (fail closed)', () => {
  it('same source and target returns ""', async () => {
    const f = fakeFactory();
    setLocalOpusMtForTests(f);
    expect(await translateWithLocalOpusMt('Ciao', 'it', 'it')).toBe('');
    expect(f.loaded).toHaveLength(0);
  });

  it('empty / whitespace text returns ""', async () => {
    setLocalOpusMtForTests(fakeFactory());
    expect(await translateWithLocalOpusMt('   ', 'it', 'en')).toBe('');
  });

  it('unsupported locale returns ""', async () => {
    setLocalOpusMtForTests(fakeFactory());
    expect(await translateWithLocalOpusMt('Hola', 'es', 'en')).toBe('');
  });

  it('output identical to input is rejected (no real translation)', async () => {
    setLocalOpusMtForTests(() => async (text: string) => [{ translation_text: text }]);
    expect(await translateWithLocalOpusMt('Ciao mondo', 'it', 'en')).toBe('');
  });

  it('unavailable model (factory returns null) returns ""', async () => {
    setLocalOpusMtForTests(() => null);
    expect(await translateWithLocalOpusMt('Ciao mondo', 'it', 'en')).toBe('');
  });

  it('inference throwing returns "" (never propagates)', async () => {
    setLocalOpusMtForTests(() => async () => { throw new Error('onnx boom'); });
    expect(await translateWithLocalOpusMt('Ciao mondo', 'it', 'en')).toBe('');
  });
});

describe('local-opus-mt — pivot intermediate identity guard', () => {
  it('returns "" when the src→en leg echoes its entire input (whole-text passthrough)', async () => {
    // Simulates a model that returns the input unchanged — passthrough on all chunks.
    setLocalOpusMtForTests((modelId: string) => async (text: string) => [{ translation_text: text }]);
    expect(await translateWithLocalOpusMt('Wir suchen einen Pfleger', 'de', 'fr')).toBe('');
  });

  it('returns "" when the src→en leg echoes a single chunk of a multi-chunk input', async () => {
    // First call (de-en) echoes its input; second call (en-fr) would produce garbage.
    let callCount = 0;
    setLocalOpusMtForTests((modelId: string) => async (text: string) => {
      callCount++;
      // de-en model: echo chunk (passthrough failure on first chunk)
      if (modelId.endsWith('-de-en')) return [{ translation_text: text }];
      // en-fr model: should NOT be reached
      return [{ translation_text: `[en-fr] ${text}` }];
    });
    const out = await translateWithLocalOpusMt('Wir suchen einen Pfleger', 'de', 'fr');
    expect(out).toBe('');
  });

  it('proceeds normally when the src→en leg produces real translation', async () => {
    setLocalOpusMtForTests((modelId: string) => async (text: string) => {
      if (modelId.endsWith('-de-en')) return [{ translation_text: `[en] ${text}` }];
      return [{ translation_text: `[fr] ${text}` }];
    });
    const out = await translateWithLocalOpusMt('Wir suchen', 'de', 'fr');
    expect(out).toContain('[fr]');
    expect(out).not.toBe('');
  });
});

describe('local-opus-mt — chunking long text', () => {
  it('splits text over the chunk budget into multiple model calls', async () => {
    const f = fakeFactory();
    setLocalOpusMtForTests(f);
    // Build > 600 chars across several sentences to force chunking.
    const long = Array.from({ length: 12 }, (_, i) => `Questa è la frase numero ${i} del testo lungo da tradurre.`).join(' ');
    expect(long.length).toBeGreaterThan(600);
    const out = await translateWithLocalOpusMt(long, 'it', 'en');
    expect(f.calls.length).toBeGreaterThan(1);
    expect(out).toContain('opus-mt-it-en');
  });
});
