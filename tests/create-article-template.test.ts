/**
 * Tests for the AI Search optimization template wired into
 * scripts/create-article.mjs (Semrush issue 223 — A6).
 *
 * Verifies:
 *   1. The AI_SEARCH_PROMPT_BLOCK_IT helper exposes TL;DR + Fatti chiave
 *      instructions and is injected into create-article.mjs.
 *   2. buildAiSearchMarkdown() emits the expected markdown shape so that
 *      the static HTML produced by build-plugins/ogPagesPlugin.ts contains
 *      the AI-search optimization signals.
 *   3. hasAiSearchOptimization() correctly detects optimized vs un-optimized
 *      body1 strings across all 4 locales.
 *   4. validateBackfillPayload() rejects malformed AI responses.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AI_SEARCH_PROMPT_BLOCK_IT,
  buildAiSearchMarkdown,
  hasAiSearchOptimization,
  prependAiSearchToBody1,
  buildBackfillPrompt,
  validateBackfillPayload,
  getTldrHeading,
  getKeyFactsHeading,
} from '../scripts/lib/ai-search-template.mjs';

describe('AI Search prompt block', () => {
  it('contains TL;DR instruction', () => {
    expect(AI_SEARCH_PROMPT_BLOCK_IT).toMatch(/## In breve/);
    expect(AI_SEARCH_PROMPT_BLOCK_IT).toMatch(/TL;DR/i);
  });

  it('contains Fatti chiave instruction', () => {
    expect(AI_SEARCH_PROMPT_BLOCK_IT).toMatch(/## Fatti chiave/);
  });

  it('mentions Semrush AI Search optimization check', () => {
    expect(AI_SEARCH_PROMPT_BLOCK_IT).toMatch(/AI Search optimization/i);
  });

  it('forbids fabrication (must come from SOURCE CONTENT)', () => {
    expect(AI_SEARCH_PROMPT_BLOCK_IT).toMatch(/SOURCE CONTENT/);
    expect(AI_SEARCH_PROMPT_BLOCK_IT).toMatch(/NON inventare/);
  });

  it('is injected into scripts/create-article.mjs', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'scripts', 'create-article.mjs'),
      'utf-8',
    );
    expect(src).toMatch(/AI_SEARCH_PROMPT_BLOCK_IT/);
    // The import must point at the helper module
    expect(src).toMatch(/from\s+['"]\.\/lib\/ai-search-template\.mjs['"]/);
    // body1 spec must mention In breve + Fatti chiave so the model emits them
    expect(src).toMatch(/## In breve/);
    expect(src).toMatch(/## Fatti chiave/);
  });
});

describe('buildAiSearchMarkdown()', () => {
  const tldr = ['Punto chiave 1', 'Punto chiave 2', 'Punto chiave 3'];
  const keyFacts = [
    { term: 'Cosa', value: 'Nuova legge frontalieri' },
    { term: 'Quando', value: 'Dal 1° gennaio 2026' },
    { term: 'Dove', value: 'Canton Ticino' },
  ];

  it('emits ## In breve and ## Fatti chiave headings (IT)', () => {
    const md = buildAiSearchMarkdown({ tldr, keyFacts, locale: 'it' });
    expect(md).toContain('## In breve');
    expect(md).toContain('## Fatti chiave');
  });

  it('emits TL;DR bullets as markdown list', () => {
    const md = buildAiSearchMarkdown({ tldr, keyFacts });
    expect(md).toContain('- Punto chiave 1');
    expect(md).toContain('- Punto chiave 2');
    expect(md).toContain('- Punto chiave 3');
  });

  it('emits key facts as bold-term markdown definition list', () => {
    const md = buildAiSearchMarkdown({ tldr, keyFacts });
    expect(md).toContain('- **Cosa**: Nuova legge frontalieri');
    expect(md).toContain('- **Quando**: Dal 1° gennaio 2026');
  });

  it('rejects too-short TL;DR', () => {
    expect(() => buildAiSearchMarkdown({ tldr: ['only one'], keyFacts })).toThrow();
  });

  it('rejects too-short key-facts', () => {
    expect(() =>
      buildAiSearchMarkdown({ tldr, keyFacts: [{ term: 'a', value: 'b' }] }),
    ).toThrow();
  });

  it('produces locale-specific headings', () => {
    expect(getTldrHeading('en')).toBe('## TL;DR');
    expect(getTldrHeading('de')).toBe('## Auf einen Blick');
    expect(getTldrHeading('fr')).toBe('## En bref');
    expect(getKeyFactsHeading('en')).toBe('## Key facts');
  });
});

describe('hasAiSearchOptimization()', () => {
  it('returns false for an article body without TL;DR/key-facts', () => {
    const body =
      'Il flusso quotidiano di migliaia di frontalieri tra l\'Italia e il Canton Ticino è un nervo scoperto.';
    expect(hasAiSearchOptimization(body)).toBe(false);
  });

  it('returns true when both ## In breve and ## Fatti chiave are present', () => {
    const body = `## In breve\n- a\n- b\n\n## Fatti chiave\n- **Cosa**: x\n\nLead paragraph...`;
    expect(hasAiSearchOptimization(body)).toBe(true);
  });

  it('returns false when only TL;DR is present (incomplete)', () => {
    const body = `## In breve\n- a\n\nLead paragraph...`;
    expect(hasAiSearchOptimization(body)).toBe(false);
  });

  it('returns false on null/empty input', () => {
    expect(hasAiSearchOptimization('')).toBe(false);
    expect(hasAiSearchOptimization(null as unknown as string)).toBe(false);
    expect(hasAiSearchOptimization(undefined as unknown as string)).toBe(false);
  });

  it('detects all 4 locale variants', () => {
    expect(hasAiSearchOptimization('## TL;DR\n- a\n## Key facts\n- a')).toBe(true);
    expect(hasAiSearchOptimization('## Auf einen Blick\n- a\n## Wichtige Fakten\n- a')).toBe(true);
    expect(hasAiSearchOptimization('## En bref\n- a\n## Faits clés\n- a')).toBe(true);
  });
});

describe('prependAiSearchToBody1()', () => {
  const tldr = ['a', 'b', 'c'];
  const keyFacts = [
    { term: 'Cosa', value: 'x' },
    { term: 'Quando', value: 'y' },
    { term: 'Dove', value: 'z' },
  ];

  it('prepends the markdown block when missing', () => {
    const body1 = 'Lead originale dell\'articolo.';
    const updated = prependAiSearchToBody1(body1, { tldr, keyFacts });
    expect(updated.startsWith('## In breve')).toBe(true);
    expect(updated.endsWith(body1)).toBe(true);
  });

  it('is idempotent — second call does not double-prepend', () => {
    const body1 = 'Lead originale dell\'articolo.';
    const once = prependAiSearchToBody1(body1, { tldr, keyFacts });
    const twice = prependAiSearchToBody1(once, { tldr, keyFacts });
    expect(twice).toBe(once);
  });
});

describe('buildBackfillPrompt()', () => {
  it('embeds the article title and body in the prompt', () => {
    const prompt = buildBackfillPrompt({
      title: 'Nuovo accordo frontalieri',
      fullBody: 'Body content here.',
      locale: 'it',
    });
    expect(prompt).toContain('Nuovo accordo frontalieri');
    expect(prompt).toContain('Body content here.');
    expect(prompt).toMatch(/JSON/);
    expect(prompt).toMatch(/tldr/);
    expect(prompt).toMatch(/keyFacts/);
  });
});

describe('validateBackfillPayload()', () => {
  const valid = {
    tldr: ['a', 'b', 'c'],
    keyFacts: [
      { term: 'Cosa', value: 'x' },
      { term: 'Quando', value: 'y' },
      { term: 'Dove', value: 'z' },
    ],
  };

  it('accepts a well-formed payload', () => {
    expect(() => validateBackfillPayload(valid)).not.toThrow();
  });

  it('rejects missing tldr', () => {
    expect(() => validateBackfillPayload({ keyFacts: valid.keyFacts })).toThrow();
  });

  it('rejects too few key facts', () => {
    expect(() =>
      validateBackfillPayload({
        tldr: valid.tldr,
        keyFacts: [{ term: 'Cosa', value: 'x' }],
      }),
    ).toThrow();
  });

  it('rejects non-string tldr bullets', () => {
    expect(() =>
      validateBackfillPayload({ tldr: [1, 2, 3], keyFacts: valid.keyFacts }),
    ).toThrow();
  });

  it('rejects oversized key-fact value', () => {
    expect(() =>
      validateBackfillPayload({
        tldr: valid.tldr,
        keyFacts: [
          { term: 'Cosa', value: 'x'.repeat(500) },
          { term: 'Quando', value: 'y' },
          { term: 'Dove', value: 'z' },
        ],
      }),
    ).toThrow();
  });
});
