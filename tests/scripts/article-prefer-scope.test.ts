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
  it('porta Codex solo sulle due chiamate di generazione del corpo', () => {
    expect(CREATE_ARTICLE).toContain(
      'const PREFERRED_GENERATION_MODELS = [AI_MODELS.CODEX_CLI_PRIMARY];',
    );

    const bodyCalls = [...CREATE_ARTICLE.matchAll(
      /callLLM\(llmMessages, \{ model: forceModel \|\| GH_MODEL_HEAVY,[\s\S]*?jsonSchema: articleSchema \}\)/g,
    )].map((match) => match[0]);

    expect(bodyCalls).toHaveLength(2);
    expect(bodyCalls.every((call) => call.includes('prefer: PREFERRED_GENERATION_MODELS'))).toBe(true);
    expect(CREATE_ARTICLE.match(/prefer: PREFERRED_GENERATION_MODELS/g)).toHaveLength(2);
  });

  it('non lascia una preferenza Codex globale nel workflow', () => {
    expect(GENERATE_ARTICLE_WORKFLOW).not.toMatch(/^\s+AI_MODELS_PREFER:/m);
  });
});
