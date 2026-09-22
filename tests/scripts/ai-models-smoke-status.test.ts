import { describe, expect, it } from 'vitest';

import {
  classifyAiModelSmokeFailure,
  summarizeGitHubModelsVerification,
} from '../../scripts/lib/ai-model-smoke-status.mjs';

describe('AI model smoke status', () => {
  it('non lascia che uno skip senza chiave mascheri il catalogo GitHub non JSON', () => {
    const message = 'All AI models failed. Chain: [codex-cli/gpt-5.6-luna → gpt-4o]. Errors: '
      + 'codex-cli/gpt-5.6-luna: skipped — no API key for provider codex_cli | '
      + 'gpt-4o: [GitHub] catalogo GitHub Models non disponibile: JSON non valido';

    expect(classifyAiModelSmokeFailure(message)).toBe('github_catalog_invalid');
  });

  it('distingue il brownout osservato dal payload invalido', () => {
    expect(classifyAiModelSmokeFailure(
      'gpt-4o: [GitHub] catalogo GitHub Models non disponibile (brownout 410)',
    )).toBe('github_catalog_brownout');
  });

  it('conserva le classi preflight quando nessun provider viene tentato', () => {
    expect(classifyAiModelSmokeFailure(
      'All AI models failed. Errors: gpt-4o: skipped — no API key for provider github',
    )).toBe('no_key');
  });

  it('rende il blocco publisher-prefix una metrica esplicita e bounded', () => {
    const result = summarizeGitHubModelsVerification([
      { model: 'gpt-4o', status: 'github_catalog_invalid' },
      { model: 'Phi-4', status: 'github_catalog_invalid' },
    ], ['gpt-4o', 'Phi-4']);

    expect(result).toEqual({
      state: 'github_catalog_invalid',
      rosterBareCount: 2,
      observedCount: 2,
      affectedModels: ['gpt-4o', 'Phi-4'],
      counts: { github_catalog_invalid: 2 },
    });
  });

  it('dichiara verified solo quando ogni id bare osservato passa', () => {
    expect(summarizeGitHubModelsVerification([
      { model: 'gpt-4o', status: 'pass' },
    ], ['gpt-4o', 'Phi-4']).state).toBe('inconclusive');

    expect(summarizeGitHubModelsVerification([
      { model: 'gpt-4o', status: 'pass' },
      { model: 'Phi-4', status: 'pass' },
    ], ['gpt-4o', 'Phi-4']).state).toBe('verified');
  });
});
