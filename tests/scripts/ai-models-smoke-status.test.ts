import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MIN_HEALTHY_PROVIDER_LANES,
  classifyAiModelSmokeFailure,
  summarizeAiFleetHealth,
  summarizeGitHubModelsVerification,
} from '../../scripts/lib/ai-model-smoke-status.mjs';
import { getProvider } from '../../scripts/lib/ai-models.mjs';

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

describe('AI fleet health (crollo della flotta, run 35995800618)', () => {
  // Esiti reali della run del 2026-09-24: 4 pass su 104, solo nvidia e omniroute.
  const collapsed = [
    { model: 'omniroute/auto', status: 'pass' },
    { model: 'nvidia/google/gemma-4-31b-it', status: 'pass' },
    { model: 'nvidia/nvidia/nemotron-3-super-120b-a12b', status: 'pass' },
    { model: 'nvidia/meta/llama-3.1-8b-instruct', status: 'http_410' },
    { model: 'gemini-2.0-flash', status: 'http_404' },
    { model: 'gemini-2.5-flash', status: 'skipped_exhausted' },
    { model: 'gpt-4o', status: 'github_catalog_invalid' },
    { model: 'mistral/mistral-medium-latest', status: 'http_402' },
    { model: 'sn/DeepSeek-V3.2', status: 'http_402' },
    { model: 'cf/@cf/openai/gpt-oss-120b', status: 'no_key' },
  ];

  it('segnala il crollo quando meno di MIN_HEALTHY_PROVIDER_LANES provider passano', () => {
    const health = summarizeAiFleetHealth(collapsed, getProvider);
    expect(health.collapsed).toBe(true);
    expect(health.healthyLanes).toEqual(['nvidia', 'omniroute']);
    expect(health.minHealthyLanes).toBe(MIN_HEALTHY_PROVIDER_LANES);
    expect(health.passCount).toBe(3);
    expect(health.modelCount).toBe(collapsed.length);
  });

  it('rende visibili le cause esterne senza contarle come corsie sane', () => {
    const health = summarizeAiFleetHealth(collapsed, getProvider);
    expect(health.billingLanes).toEqual(['mistral', 'sambanova']);
    expect(health.noKeyLanes).toEqual(['cloudflare']);
    expect(health.retiredModels).toEqual(['nvidia/meta/llama-3.1-8b-instruct', 'gemini-2.0-flash']);
    expect(health.byProvider.github).toEqual({ pass: 0, total: 1, statuses: { github_catalog_invalid: 1 } });
  });

  it('non segnala nulla con provider indipendenti sani (run 35091955387, 5 corsie)', () => {
    const health = summarizeAiFleetHealth([
      { model: 'gemini-3-flash-preview', status: 'pass' },
      { model: 'cohere/command-r-plus-08-2024', status: 'pass' },
      { model: 'omniroute/auto', status: 'pass' },
      { model: 'nvidia/nvidia/nemotron-3-super-120b-a12b', status: 'pass' },
      { model: 'mistral/mistral-medium-latest', status: 'http_402' },
    ], getProvider);
    expect(health.collapsed).toBe(false);
    expect(health.healthyLanes).toEqual(['cohere', 'gemini', 'nvidia', 'omniroute']);
  });

  it('molti modelli sullo stesso provider restano UNA corsia', () => {
    const health = summarizeAiFleetHealth([
      { model: 'mistral/a-latest', status: 'pass' },
      { model: 'mistral/b-latest', status: 'pass' },
      { model: 'mistral/c-latest', status: 'pass' },
      { model: 'omniroute/auto', status: 'pass' },
    ], getProvider);
    expect(health.healthyLanes).toEqual(['mistral', 'omniroute']);
    expect(health.collapsed).toBe(true);
  });

  it('il workflow fallisce sul crollo dopo aver scritto il report', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/smoke-test-ai-models.yml'), 'utf8');
    const collapseAt = workflow.indexOf("fleetHealth.collapsed ? 0 : 1");
    expect(collapseAt).toBeGreaterThan(-1);
    expect(workflow.indexOf('cat .tmp/fleet-health.md >> "$GITHUB_STEP_SUMMARY"')).toBeLessThan(collapseAt);
    expect(workflow).toMatch(/::error title=AI model fleet collapsed::/);
    // Il gate Mistral (#892) resta: il suo exit code viene solo differito.
    expect(workflow).toMatch(/\|\| SMOKE_RC=\$\?/);
    expect(workflow).toMatch(/exit "\$SMOKE_RC"/);
  });
});
