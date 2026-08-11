import { describe, expect, it } from 'vitest';

import {
  MAX_PREFLIGHT_REQUEST_TOKENS,
  estimateRequestTokens,
  shouldUseSchemaMode,
} from '../../scripts/lib/ai-models.mjs';

/**
 * The pre-flight skip-guard has to size the body that will ACTUALLY be sent.
 *
 * `opts.jsonSchema` is only forwarded to providers that honor OpenAI's strict
 * `response_format: { type: 'json_schema' }` contract (GitHub, OpenRouter,
 * Mistral, Local) plus Gemini's native `responseSchema` path. Everyone else —
 * Groq most notably, which 400s on the shape and is deliberately excluded —
 * receives plain `json_object`, a handful of characters.
 *
 * estimateRequestTokens used to add the serialized schema for EVERY model, so
 * Groq was charged ~516 tokens of payload it would never receive and got
 * pre-flight-skipped for exceeding its cap without the call ever being
 * attempted. A false-positive skip: the model was usable.
 *
 * The fix is not a second copy of the provider list. shouldUseSchemaMode() is
 * the single source of truth and both halves now ask it — the send side when
 * it builds the body, the estimate side when it sizes that same body. These
 * tests pin that they cannot drift apart again.
 */
describe('estimateRequestTokens — the schema is only counted for providers that receive it', () => {
  /**
   * Production-scale stand-in for buildArticleJsonSchema()'s output (measured
   * at ~1805 serialized chars ≈ 516 tokens). The assertions below derive from
   * the MEASURED length of this object, never from a hardcoded token count, so
   * editing the fixture cannot quietly turn a real assertion into a tautology.
   */
  const jsonSchema = {
    name: 'article',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'slug', 'excerpt', 'body1', 'body2', 'body3', 'imageAlt', 'tags'],
      properties: {
        title: { type: 'string', description: 'Titolo dell articolo, tra 50 e 70 caratteri, informativo e senza clickbait ne maiuscole enfatiche' },
        slug: { type: 'string', description: 'Slug URL-safe derivato dal titolo, tutto minuscolo, parole separate da trattini, senza accenti' },
        excerpt: { type: 'string', description: 'Sommario di 150-160 caratteri usato come meta description, deve reggersi da solo fuori contesto' },
        body1: { type: 'string', description: 'Primo blocco del corpo in HTML, almeno 400 parole, apre con il fatto e non con una premessa generica' },
        body2: { type: 'string', description: 'Secondo blocco del corpo in HTML, almeno 400 parole, sviluppa il contesto normativo e le fonti citate' },
        body3: { type: 'string', description: 'Terzo blocco del corpo in HTML, almeno 400 parole, chiude con le conseguenze pratiche per il lettore' },
        imageAlt: { type: 'string', description: 'Testo alternativo descrittivo per l immagine di copertina, massimo 125 caratteri, niente parole chiave forzate' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Da tre a sei tag tematici in minuscolo, coerenti con la tassonomia esistente del sito' },
        category: { type: 'string', description: 'Una sola categoria scelta fra quelle gia esistenti, mai inventata sul momento' },
        sources: { type: 'array', items: { type: 'string' }, description: 'URL assoluti delle fonti effettivamente consultate, nessun link inventato o ricostruito' },
        publishedAt: { type: 'string', description: 'Data di pubblicazione in formato ISO 8601, fuso orario Europe/Zurich' },
        locale: { type: 'string', description: 'Codice lingua del contenuto prodotto: it, en, de oppure fr' },
      },
    },
  };

  const SCHEMA_CHARS = JSON.stringify(jsonSchema.schema).length;

  function messagesOfChars(chars: number) {
    return [{ role: 'user', content: 'x'.repeat(chars) }];
  }

  it('uses a production-scale schema fixture (otherwise the deltas below prove nothing)', () => {
    expect(SCHEMA_CHARS).toBeGreaterThan(1000);
  });

  it('differs by exactly the serialized schema between a provider in the list and one outside it', () => {
    const messages = messagesOfChars(10_000);

    // GitHub is in PROVIDERS_WITH_STRICT_JSON_SCHEMA → receives the schema.
    const inList = estimateRequestTokens(messages, { jsonSchema }, 'GitHub');
    // Groq is deliberately NOT → receives json_object, never the schema.
    const outOfList = estimateRequestTokens(messages, { jsonSchema }, 'Groq');

    // Exact, computed the same way the estimator does — ceil() on the SUM is
    // not the same as ceil() of each term, so the delta is derived, not guessed.
    const expectedDelta = Math.ceil((10_000 + SCHEMA_CHARS) / 3.5) - Math.ceil(10_000 / 3.5);

    expect(inList - outOfList).toBe(expectedDelta);
    expect(expectedDelta).toBeGreaterThan(0);
  });

  it('charges a provider outside the list nothing at all for the schema', () => {
    const messages = messagesOfChars(10_000);
    expect(estimateRequestTokens(messages, { jsonSchema }, 'Groq'))
      .toBe(estimateRequestTokens(messages, {}, 'Groq'));
  });

  it('still counts the schema when no provider is given (provider-agnostic upper bound preserved)', () => {
    const messages = messagesOfChars(10_000);
    // Callers that ask "how big could this get across the fleet?" — including
    // the corpus' news-prompt budget test — must keep the conservative answer.
    expect(estimateRequestTokens(messages, { jsonSchema }))
      .toBe(estimateRequestTokens(messages, { jsonSchema }, 'GitHub'));
  });

  it('reverses a real pre-flight skip at the declared 8000-token cap', () => {
    // (cap - 500) * 3.5 is the exact char boundary the divisor test pins.
    const boundaryChars = (MAX_PREFLIGHT_REQUEST_TOKENS - 500) * 3.5;
    const messages = messagesOfChars(boundaryChars);

    const groqEstimate = estimateRequestTokens(messages, { jsonSchema }, 'Groq');
    const githubEstimate = estimateRequestTokens(messages, { jsonSchema }, 'GitHub');

    // Groq's real request fits — it must NOT be skipped.
    expect(groqEstimate).toBeLessThanOrEqual(MAX_PREFLIGHT_REQUEST_TOKENS);
    // GitHub's really does carry the schema and really is over — still skipped.
    expect(githubEstimate).toBeGreaterThan(MAX_PREFLIGHT_REQUEST_TOKENS);
  });

  it('honors the per-model learned incompatibility and the ops kill-switch through the same function', () => {
    const messages = messagesOfChars(10_000);
    const withSchema = estimateRequestTokens(messages, { jsonSchema }, 'GitHub');
    const withoutSchema = estimateRequestTokens(messages, {}, 'GitHub');

    const prev = process.env.AI_MODELS_SCHEMA_MODE;
    try {
      // AI_MODELS_SCHEMA_MODE=off stops the schema being sent to anyone, so it
      // must stop being counted for anyone too.
      process.env.AI_MODELS_SCHEMA_MODE = 'off';
      expect(estimateRequestTokens(messages, { jsonSchema }, 'GitHub')).toBe(withoutSchema);
      // =force sends it to everyone, including Groq.
      process.env.AI_MODELS_SCHEMA_MODE = 'force';
      expect(estimateRequestTokens(messages, { jsonSchema }, 'Groq')).toBe(withSchema);
    } finally {
      if (prev === undefined) delete process.env.AI_MODELS_SCHEMA_MODE;
      else process.env.AI_MODELS_SCHEMA_MODE = prev;
    }
  });
});

/**
 * The estimate side reaches the decision from getProvider(), which returns the
 * lowercase PROVIDER.* constant ('groq'), while the send side passes the human
 * display name ('Groq'). The strict-schema set used to hold display names
 * only, so querying it with a PROVIDER constant returned false for EVERY
 * provider — which would have under-counted GitHub/OpenRouter/Mistral/Local
 * rather than over-counting Groq. Same defect, opposite sign, and the worse
 * one: this file's cost model rates a wrong pass (a guaranteed 413) above a
 * wrong skip (one chain step). These lock the two spellings together.
 */
describe('shouldUseSchemaMode — one answer regardless of how the provider is spelled', () => {
  const cases: Array<[string, string, boolean]> = [
    ['GitHub', 'github', true],
    ['OpenRouter', 'openrouter', true],
    ['Mistral', 'mistral', true],
    ['Local', 'local', true],
    ['Gemini', 'gemini', true],
    ['Groq', 'groq', false],
    ['Cohere', 'cohere', false],
    ['NVIDIA', 'nvidia', false],
    ['OmniRoute', 'omniroute', false],
    ['Z.AI', 'zai', false],
  ];

  it.each(cases)('%s and %s agree (expected %s)', (displayName, providerConstant, expected) => {
    expect(shouldUseSchemaMode(displayName, true)).toBe(expected);
    expect(shouldUseSchemaMode(providerConstant, true)).toBe(expected);
  });

  it('makes the estimate identical for both spellings of the same provider', () => {
    const messages = [{ role: 'user', content: 'x'.repeat(10_000) }];
    const jsonSchema = { name: 'x', schema: { type: 'object', properties: { a: { type: 'string' } } } };
    for (const [displayName, providerConstant] of cases) {
      expect(estimateRequestTokens(messages, { jsonSchema }, displayName))
        .toBe(estimateRequestTokens(messages, { jsonSchema }, providerConstant));
    }
  });
});
