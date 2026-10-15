import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CREATE_ARTICLE = readFileSync(resolve(ROOT, 'scripts/create-article.mjs'), 'utf8');
const GENERATE_ARTICLE_WORKFLOW = readFileSync(
  resolve(ROOT, '.github/workflows/generate-article.yml'),
  'utf8',
);

describe('scoping della preferenza Codex per la generazione articolo', () => {
  it('porta Codex solo sulle due chiamate di generazione del corpo, in entrambi i rami', () => {
    expect(CREATE_ARTICLE).toContain(
      'const PREFERRED_GENERATION_MODELS = [AI_MODELS.CODEX_CLI_PRIMARY];',
    );

    // Chiamata unica e retry per JSON malformato, ciascuna nel ramo generico
    // e in quello dello slot `gemini` della rotazione (tentativo 3): senza
    // `prefer` sul ramo Gemini quel tentativo saltava Codex
    // (review di frontaliere-articles#1751).
    const bodyCalls = [...CREATE_ARTICLE.matchAll(
      /callLLM\(llmMessages, \{ model: (?:forceModel \|\| GH_MODEL_HEAVY|AI_MODELS\.GEMINI_FLASH),[\s\S]*?jsonSchema: articleSchema \}\)/g,
    )].map((match) => match[0]);

    expect(bodyCalls).toHaveLength(4);
    expect(bodyCalls.filter((call) => !call.includes('prefer: PREFERRED_GENERATION_MODELS'))).toEqual([]);
    expect(CREATE_ARTICLE.match(/prefer: PREFERRED_GENERATION_MODELS/g)).toHaveLength(4);
  });

  it('non lascia una preferenza Codex globale nel workflow', () => {
    expect(GENERATE_ARTICLE_WORKFLOW).not.toMatch(/^\s+AI_MODELS_PREFER:/m);
  });
});
