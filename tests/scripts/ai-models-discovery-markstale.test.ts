import { describe, expect, it } from 'vitest';

const aiModels = await import('../../scripts/lib/ai-models.mjs');

const { collectOfferedIds, DISCOVERY_PROVIDERS } = aiModels as unknown as {
  collectOfferedIds: (cfg: { pick: (m: unknown) => string | null }, list: unknown[]) => Set<string>;
  DISCOVERY_PROVIDERS: ReadonlyArray<{ name: string; pick: (m: unknown) => string | null }>;
};

function provider(name: string) {
  const cfg = DISCOVERY_PROVIDERS.find((p) => p.name === name);
  if (!cfg) throw new Error(`provider ${name} not found in DISCOVERY_PROVIDERS`);
  return cfg;
}

describe('discovery markStale id matching (issue #892)', () => {
  it('Mistral: registers `-latest` aliases attached to a versioned entry', () => {
    // Mistral's /v1/models exposes the `-latest` tag only via aliases[] on a
    // versioned model id — not as a top-level m.id. The chain stores the
    // `-latest` id verbatim, so collectOfferedIds must surface the alias or
    // markStale wrongly pre-exhausts a live model for the whole UTC day.
    const list = [
      {
        id: 'mistral-small-2506',
        aliases: ['codestral-latest'],
        capabilities: { completion_chat: true },
        max_context_length: 128000,
      },
      {
        id: 'ministral-8b-2410',
        aliases: ['ministral-8b-latest'],
        capabilities: { completion_chat: true },
        max_context_length: 128000,
      },
    ];

    const offered = collectOfferedIds(provider('Mistral'), list);

    // Canonical versioned ids present...
    expect(offered.has('mistral-small-2506')).toBe(true);
    expect(offered.has('ministral-8b-2410')).toBe(true);
    // ...and the `-latest` aliases that the static chain stores verbatim.
    expect(offered.has('codestral-latest')).toBe(true);
    expect(offered.has('ministral-8b-latest')).toBe(true);
  });

  it('Mistral: an alias never resurrects a model rejected by the filter', () => {
    // A non-chat model must stay out even if it carries a chat-looking alias.
    const list = [
      {
        id: 'mistral-embed',
        aliases: ['mistral-small-latest'],
        capabilities: { completion_chat: false },
        max_context_length: 128000,
      },
    ];

    const offered = collectOfferedIds(provider('Mistral'), list);

    expect(offered.has('mistral-embed')).toBe(false);
    // Alias of a rejected entry must NOT be registered.
    expect(offered.has('mistral-small-latest')).toBe(false);
  });

  it('Groq: matches verbatim ids (namespaced + compound), no alias layer', () => {
    const list = [
      { id: 'llama-3.3-70b-versatile', active: true, context_window: 131072 },
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct', active: true, context_window: 131072 },
      { id: 'compound-beta', active: true, context_window: 131072 },
      // Inactive + non-chat models must be dropped.
      { id: 'llama-3.1-8b-instant', active: false, context_window: 131072 },
      { id: 'whisper-large-v3', active: true, context_window: 131072 },
    ];

    const offered = collectOfferedIds(provider('Groq'), list);

    expect(offered.has('llama-3.3-70b-versatile')).toBe(true);
    expect(offered.has('meta-llama/llama-4-scout-17b-16e-instruct')).toBe(true);
    expect(offered.has('compound-beta')).toBe(true);
    expect(offered.has('llama-3.1-8b-instant')).toBe(false); // inactive
    expect(offered.has('whisper-large-v3')).toBe(false); // non-chat
  });

  it('Cerebras: matches verbatim ids including dated preview ids', () => {
    const list = [
      { id: 'llama3.1-8b' },
      { id: 'llama3.3-70b' },
      { id: 'qwen-3-235b-a22b-instruct-2507' },
      { id: 'nemoretriever-embed' }, // non-chat → dropped
    ];

    const offered = collectOfferedIds(provider('Cerebras'), list);

    expect(offered.has('llama3.1-8b')).toBe(true);
    expect(offered.has('llama3.3-70b')).toBe(true);
    expect(offered.has('qwen-3-235b-a22b-instruct-2507')).toBe(true);
    expect(offered.has('nemoretriever-embed')).toBe(false);
  });

  it('tolerates a listing with no aliases field (no-op alias pass)', () => {
    const offered = collectOfferedIds(provider('Cerebras'), [{ id: 'llama3.1-8b' }]);
    expect([...offered]).toEqual(['llama3.1-8b']);
  });
});
