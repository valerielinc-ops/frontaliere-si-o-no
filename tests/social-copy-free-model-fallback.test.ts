import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSocialCopyFallbackMessages,
  classifySocialCopyFallbackFailure,
  fallbackPackEditorialParity,
  FREE_SOCIAL_COPY_MODEL_CANDIDATES,
  run,
  selectAvailableFreeModels,
} from '../scripts/social-copy/generate-free-model-fallback.mjs';
import { normalizeSocialCopyPack } from '../scripts/lib/social-copy-pack.mjs';

const ROOT = path.resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'social-copy-fallback-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('social copy free-model fallback', () => {
  it('keeps the fallback chain to one available model per allowlisted free provider', () => {
    const candidates = [
      { provider: 'openrouter', model: 'openrouter/free', context: 'compact' },
      { provider: 'openrouter', model: 'openrouter/static:free', context: 'compact' },
      { provider: 'gemini', model: 'gemma-a', context: 'full' },
      { provider: 'cloudflare', model: 'cf-a', context: 'full' },
      { provider: 'github', model: 'gpt-a', context: 'compact' },
    ];
    const selected = selectAvailableFreeModels({
      candidates,
      providerOf: (model) => model.startsWith('openrouter/')
        ? 'openrouter'
        : model.startsWith('gemma') ? 'gemini'
          : model.startsWith('gpt') ? 'github' : 'cloudflare',
      available: () => true,
    });

    expect(selected).toEqual([candidates[0], candidates[2]]);
  });

  it('routes the configured dynamic free-model candidate through OpenRouter', () => {
    const candidate = FREE_SOCIAL_COPY_MODEL_CANDIDATES.find((entry) => entry.provider === 'openrouter');

    expect(candidate?.model).toBe('openrouter/openrouter/free');
    expect(selectAvailableFreeModels({ candidates: candidate ? [candidate] : [], available: () => true }))
      .toEqual(candidate ? [candidate] : []);
  });

  it('sends only the full context to large-context candidates and marks trend restrictions', () => {
    const creativeStudyFile = path.join(temporaryDirectory(), 'creative-study.md');
    writeFileSync(creativeStudyFile, '# Studio creativo Instagram\nFixture di ricerca creativa.\n');
    const compact = buildSocialCopyFallbackMessages({ context: 'compact', now: new Date('2026-11-07T12:00:00Z') });
    const full = buildSocialCopyFallbackMessages({
      context: 'full',
      creativeStudyFile,
      now: new Date('2026-11-07T12:00:00Z'),
    });

    expect(compact[1]?.content).toContain('Non raccogliere dati da account Instagram concorrenti');
    expect(compact[1]?.content).toContain('senza sticker, risposte o metriche implicite');
    expect(compact[1]?.content).toContain('punteggi lessicali inglesi');
    expect(JSON.stringify(compact)).not.toContain('instagram-creative-study');
    expect(full[1]?.content).toContain('# Studio creativo Instagram');
  });

  it.each([
    [new Error('Gemini API key not set'), 'provider-auth-failed'],
    [new Error('[model] HTTP 401: credential detail'), 'provider-auth-failed'],
    [new Error('[model] HTTP 403: access denied'), 'provider-access-denied'],
    [new Error('[model] HTTP 429: quota exceeded'), 'provider-quota-or-rate-limit'],
    [new Error('[model] HTTP 404: model not found'), 'model-unavailable'],
    [new Error('[model] HTTP 503: unavailable'), 'provider-temporary-failure'],
    [new Error('[model] HTTP 400: request rejected'), 'provider-request-rejected'],
    [new Error('fetch failed: ECONNRESET'), 'provider-temporary-failure'],
  ])('classifies provider failures safely as %s', (error, category) => {
    expect(classifySocialCopyFallbackFailure(error)).toBe(category);
  });

  it('reports request and response failures separately without logging provider error text', async () => {
    const directory = temporaryDirectory();
    const previousPath = path.join(ROOT, 'data/social-copy-packs/current.json');
    const workflowOutputPath = path.join(directory, 'github-output.txt');
    const stdout = { value: '', write(text: string) { this.value += text; } };
    const candidates = [
      { provider: 'gemini', model: 'gemini-test', context: 'compact' },
      { provider: 'groq', model: 'groq-test', context: 'compact' },
    ];

    const result = await run({
      env: {
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'example/social',
        GITHUB_RUN_ID: '125',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_OUTPUT: workflowOutputPath,
      },
      now: new Date('2026-11-07T12:00:00.000Z'),
      modelCandidates: candidates,
      available: () => true,
      providerOf: (model) => model.startsWith('gemini') ? 'gemini' : 'groq',
      db: {} as any,
      callModel: async (_messages: unknown, options: Record<string, unknown>) => {
        if (options.model === 'gemini-test') throw new Error('[model] HTTP 401: private-token-value');
        return 'not valid JSON';
      },
      reserve: async () => ({ allowed: true } as any),
      stdout: stdout as any,
      inputPaths: { previousPack: previousPath },
      outputPath: path.join(directory, 'response.json'),
    });

    expect(result).toMatchObject({
      packGenerated: false,
      reason: 'all-free-models-failed',
      failures: [
        { provider: 'gemini', phase: 'request', category: 'provider-auth-failed' },
        { provider: 'groq', phase: 'validation', category: 'response-invalid' },
      ],
    });
    expect(stdout.value).toContain('gemini:request:provider-auth-failed');
    expect(stdout.value).toContain('groq:validation:response-invalid');
    expect(stdout.value).not.toContain('private-token-value');
    const workflowOutput = readFileSync(workflowOutputPath, 'utf8');
    expect(workflowOutput).toContain('attempt_failures=gemini:request:provider-auth-failed,groq:validation:response-invalid');
    expect(workflowOutput).not.toContain('private-token-value');
  });

  it('does not reserve or call a provider when no response output path is configured', async () => {
    let reserved = 0;
    let called = 0;

    const result = await run({
      env: {
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'example/social',
        GITHUB_RUN_ID: '126',
        GITHUB_RUN_ATTEMPT: '1',
      },
      modelCandidates: [{ provider: 'gemini', model: 'gemini-test', context: 'compact' }],
      available: () => true,
      providerOf: () => 'gemini',
      db: {} as any,
      callModel: async () => { called += 1; return '{}'; },
      reserve: async () => { reserved += 1; return { allowed: true } as any; },
      stdout: { write() {} } as any,
    });

    expect(result).toMatchObject({ packGenerated: false, reason: 'response-output-path-missing' });
    expect(reserved).toBe(0);
    expect(called).toBe(0);
  });

  it('validates, attributes, and writes one free-model pack without making provider calls in the test', async () => {
    const directory = temporaryDirectory();
    const previousPath = path.join(ROOT, 'data/social-copy-packs/current.json');
    const previous = JSON.parse(readFileSync(previousPath, 'utf8'));
    const response = JSON.stringify({ editorialPlan: previous.editorialPlan, channels: previous.channels });
    const outputPath = path.join(directory, 'response.json');
    const stdout = { value: '', write(text: string) { this.value += text; } };
    let reserved = 0;
    let callOptions: Record<string, unknown> | undefined;

    const result = await run({
      env: {
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'example/social',
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '1',
      },
      now: new Date('2026-11-07T12:00:00.000Z'),
      modelCandidates: [{ provider: 'gemini', model: 'gemini-test', context: 'compact' }],
      available: () => true,
      providerOf: () => 'gemini',
      db: {} as any,
      callModel: async (_messages: unknown, options: Record<string, unknown>) => {
        callOptions = options;
        return response;
      },
      reserve: async () => {
        reserved += 1;
        return { allowed: true } as any;
      },
      stdout: stdout as any,
      inputPaths: { previousPack: previousPath },
      outputPath,
    });

    const generated = JSON.parse(readFileSync(outputPath, 'utf8'));
    expect(result).toMatchObject({ packGenerated: true, provider: 'gemini', attempted: ['gemini'] });
    expect(reserved).toBe(1);
    expect(callOptions).toMatchObject({ model: 'gemini-test', jsonMode: true, maxRetriesPerModel: 1, recordScore: false });
    expect(Object.keys(generated).sort()).toEqual(['channels', 'editorialPlan']);
    expect(stdout.value).toContain('provider=gemini');
    expect(stdout.value).toContain('editorial_parity=match');
    expect(stdout.value).toContain('editorial_parity_provider=gemini');
    expect(result.editorialParity).toMatchObject({ provider: 'gemini', status: 'match' });
  });

  it('observes stable Italian editorial parity per generation provider', () => {
    const previousPath = path.join(ROOT, 'data/social-copy-packs/current.json');
    const previous = JSON.parse(readFileSync(previousPath, 'utf8'));
    const generated = normalizeSocialCopyPack({
      editorialPlan: previous.editorialPlan,
      channels: previous.channels,
    }, { generatedAt: previous.generatedAt, generationProvider: 'gemini' });

    expect(fallbackPackEditorialParity(generated, previous)).toMatchObject({
      provider: 'gemini',
      status: 'match',
      baseline: 'current-pack-editorial-plan',
    });
  });

  it('rejects an invalid normalized pack before editorial parity can be observed', () => {
    const previousPath = path.join(ROOT, 'data/social-copy-packs/current.json');
    const previous = JSON.parse(readFileSync(previousPath, 'utf8'));
    const invalid = structuredClone(previous);
    delete invalid.channels.instagram.article[0].cta;

    expect(() => fallbackPackEditorialParity(invalid, previous)).toThrow(/cta/i);
  });

  it('does not reserve the fallback allowance when a supplied brief is missing', async () => {
    const directory = temporaryDirectory();
    let reserved = 0;

    await expect(run({
      env: {
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: 'example/social',
        GITHUB_RUN_ID: '124',
        GITHUB_RUN_ATTEMPT: '1',
      },
      now: new Date('2026-11-07T12:00:00.000Z'),
      modelCandidates: [{ provider: 'gemini', model: 'gemini-test', context: 'compact' }],
      available: () => true,
      providerOf: () => 'gemini',
      inputPaths: {
        previousPack: path.join(ROOT, 'data/social-copy-packs/current.json'),
        ga4: path.join(directory, 'missing-ga4.json'),
      },
      outputPath: path.join(directory, 'response.json'),
      reserve: async () => { reserved += 1; return { allowed: true } as any; },
      callModel: async () => { throw new Error('model must not be called'); },
      stdout: { write() {} } as any,
    })).rejects.toThrow('GA4 brief is missing');

    expect(reserved).toBe(0);
  });
});
