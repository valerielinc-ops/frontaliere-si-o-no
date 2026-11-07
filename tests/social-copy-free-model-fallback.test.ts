import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSocialCopyFallbackMessages,
  run,
  selectAvailableFreeModels,
} from '../scripts/social-copy/generate-free-model-fallback.mjs';

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
      { provider: 'github', model: 'gpt-a', context: 'compact' },
      { provider: 'github', model: 'gpt-b', context: 'compact' },
      { provider: 'gemini', model: 'gemma-a', context: 'full' },
      { provider: 'cloudflare', model: 'cf-a', context: 'full' },
    ];
    const selected = selectAvailableFreeModels({
      candidates,
      providerOf: (model) => model.startsWith('gpt') ? 'github' : model.startsWith('gemma') ? 'gemini' : 'cloudflare',
      available: () => true,
    });

    expect(selected).toEqual([candidates[0], candidates[2]]);
  });

  it('sends only the full context to large-context candidates and marks trend restrictions', () => {
    const compact = buildSocialCopyFallbackMessages({ context: 'compact', now: new Date('2026-11-07T12:00:00Z') });
    const full = buildSocialCopyFallbackMessages({ context: 'full', now: new Date('2026-11-07T12:00:00Z') });

    expect(compact[1]?.content).toContain('Non raccogliere dati da account Instagram concorrenti');
    expect(JSON.stringify(compact)).not.toContain('instagram-creative-study');
    expect(full[1]?.content).toContain('# Studio creativo Instagram');
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
