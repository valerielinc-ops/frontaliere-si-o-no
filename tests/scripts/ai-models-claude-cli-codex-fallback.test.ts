import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import {
  AI_MODELS,
  CODEX_INDIRECT_FALLBACK_EFFORT,
  __codexFallbackTimeoutForTests,
  __installScoreStoreForTests,
  callLLM,
  getStats,
  resetState,
} from '../../scripts/lib/ai-models.mjs';
import {
  CODEX_FALLBACK_EFFORT,
  CODEX_FALLBACK_MODEL,
} from '../../scripts/ci/claude-codex-fallback.mjs';

type Listener = (...args: unknown[]) => void;
type SpawnOptions = { env?: Record<string, string | undefined>; cwd?: string };

const ENV_KEYS = [
  'ENABLE_HAIKU_ARTICLE_FALLBACK',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_AUTH_JSON',
  'CODEX_CLI_TIMEOUT_MS',
  'LOCAL_LLM_ENABLED',
  'AI_COMPETING_TIERS',
  'AI_MODELS_SCHEMA_MODE',
  'RUNNER_TEMP',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
] as const;

describe('Claude CLI usage-limit → indirect Codex fallback', () => {
  const saved: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;
  let markerRoot = '';
  let runNumber = 0;

  beforeAll(() => {
    __installScoreStoreForTests(null);
  });

  beforeEach(() => {
    resetState();
    spawnMock.mockReset();
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-claude-oauth-token';
    process.env.CODEX_AUTH_JSON = '{"access_token":"TOP-SECRET-CODEX-AUTH"}';
    process.env.CODEX_CLI_TIMEOUT_MS = '15000';
    delete process.env.LOCAL_LLM_ENABLED;
    delete process.env.AI_COMPETING_TIERS;
    delete process.env.AI_MODELS_SCHEMA_MODE;
    markerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-codex-fallback-test-'));
    process.env.RUNNER_TEMP = markerRoot;
    process.env.GITHUB_RUN_ID = `test-${process.pid}-${runNumber++}`;
    process.env.GITHUB_RUN_ATTEMPT = '1';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    if (markerRoot) fs.rmSync(markerRoot, { recursive: true, force: true });
    markerRoot = '';
    resetState();
  });

  function fakeChild({
    bin,
    args,
    options,
    claudeResult = 'usage limit exceeded',
    claudeCode = 1,
    claudeRateLimitEvent = false,
    claudeStructuredPayload,
    codexResult = 'CODEX-FALLBACK-RESULT',
    codexCode = 0,
    onCodexStart,
  }: {
    bin: string;
    args: string[];
    options: SpawnOptions;
    claudeResult?: string;
    claudeCode?: number;
    claudeRateLimitEvent?: boolean;
    claudeStructuredPayload?: unknown;
    codexResult?: string;
    codexCode?: number;
    onCodexStart?: (args: string[], options: SpawnOptions) => void;
  }) {
    const listeners: Record<string, Listener[]> = {};
    const stdoutListeners: Record<string, Listener[]> = {};
    const child = {
      stdin: { end: vi.fn() },
      stdout: { on: (event: string, cb: Listener) => { (stdoutListeners[event] ||= []).push(cb); } },
      stderr: { on: () => {} },
      on: (event: string, cb: Listener) => { (listeners[event] ||= []).push(cb); },
      kill: vi.fn(),
    };

    if (bin === 'codex') onCodexStart?.(args, options);
    queueMicrotask(() => {
      if (bin === 'claude') {
        if (claudeRateLimitEvent) {
          const event = JSON.stringify({
            type: 'rate_limit_event',
            rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' },
          });
          stdoutListeners.data?.forEach((cb) => cb(Buffer.from(`${event}\n`)));
          listeners.close?.forEach((cb) => cb(claudeCode));
          return;
        }
        if (claudeStructuredPayload !== undefined) {
          const event = JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: claudeStructuredPayload }] },
          });
          stdoutListeners.data?.forEach((cb) => cb(Buffer.from(`${event}\n`)));
        }
        const payload = JSON.stringify({
          type: 'result',
          subtype: 'error',
          is_error: true,
          api_error_status: claudeResult.includes('429') ? 429 : undefined,
          result: claudeResult,
        });
        stdoutListeners.data?.forEach((cb) => cb(Buffer.from(`${payload}\n`)));
        listeners.close?.forEach((cb) => cb(claudeCode));
        return;
      }

      const outputIndex = args.indexOf('--output-last-message');
      if (codexCode === 0 && outputIndex >= 0) {
        fs.writeFileSync(args[outputIndex + 1], `${codexResult}\n`);
      }
      listeners.close?.forEach((cb) => cb(codexCode));
    });
    return child;
  }

  function installClaudeThenCodex({
    claudeResult,
    claudeCode = 1,
    claudeRateLimitEvent = false,
    claudeStructuredPayload,
    codexResult = 'CODEX-FALLBACK-RESULT',
    codexCode = 0,
    onCodexStart,
  }: {
    claudeResult?: string;
    claudeCode?: number;
    claudeRateLimitEvent?: boolean;
    claudeStructuredPayload?: unknown;
    codexResult?: string;
    codexCode?: number;
    onCodexStart?: (args: string[], options: SpawnOptions) => void;
  }) {
    spawnMock.mockImplementation((bin: string, args: string[], options: SpawnOptions) => fakeChild({
      bin,
      args,
      options,
      claudeResult,
      claudeCode,
      claudeRateLimitEvent,
      claudeStructuredPayload,
      codexResult,
      codexCode,
      onCodexStart,
    }));
  }

  const messages = [
    { role: 'system', content: 'Return the requested structured article.' },
    { role: 'user', content: 'Write the article body.' },
  ];

  it('uses gpt-5.6-luna at medium effort, preserves output/schema, and cleans auth', async () => {
    let codexHome = '';
    let codexArgs: string[] = [];
    let codexEnv: Record<string, string | undefined> = {};
    const schema = {
      name: 'article',
      schema: {
        type: 'object',
        properties: { body: { type: 'string' } },
        required: ['body'],
        additionalProperties: false,
      },
    };

    installClaudeThenCodex({
      claudeResult: 'Claude HTTP 429 usage limit',
      codexResult: '{"body":"from-codex"}',
      onCodexStart: (args, options) => {
        codexArgs = args;
        codexEnv = options.env || {};
        codexHome = codexEnv.CODEX_HOME || '';
        expect(fs.statSync(path.join(codexHome, 'auth.json')).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8')).toBe(process.env.CODEX_AUTH_JSON);
        expect(fs.statSync(path.join(codexHome, 'claude-haiku-fallback.config.toml')).mode & 0o777).toBe(0o600);
        const profile = fs.readFileSync(path.join(codexHome, 'claude-haiku-fallback.config.toml'), 'utf8');
        expect(profile).toContain('extends = ":read-only"');
        expect(profile).toContain('":root" = "deny"');
        expect(profile).toContain('":minimal" = "read"');
        expect(profile).toContain('enabled = false');
        expect(options.cwd).toBeTruthy();
        expect(fs.readdirSync(options.cwd || '')).toEqual([]);
      },
    });

    const result = await callLLM(messages, {
      model: AI_MODELS.CLAUDE_CLI_HAIKU,
      chain: [AI_MODELS.CLAUDE_CLI_HAIKU],
      jsonSchema: schema,
    });

    expect(result).toBe('{"body":"from-codex"}');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(getStats().consecutive429s[AI_MODELS.CLAUDE_CLI_HAIKU]).toBe(1);
    expect(getStats().scoreBoard.find((entry) => entry.model === AI_MODELS.CLAUDE_CLI_HAIKU)?.failures).toBe(1);
    expect(getStats().scoreBoard.find((entry) => entry.model === CODEX_FALLBACK_MODEL)?.successes).toBe(1);
    const claudeEnv = (spawnMock.mock.calls[0] as [string, string[], SpawnOptions])[2].env || {};
    expect(claudeEnv.CODEX_AUTH_JSON).toBeUndefined();
    expect(codexArgs).toEqual(expect.arrayContaining([
      'exec',
      '--ephemeral',
      '--strict-config',
      '--ignore-rules',
      '--profile', 'claude-haiku-fallback',
      '--cd', expect.any(String),
      '--skip-git-repo-check',
      '--model', CODEX_FALLBACK_MODEL,
      '-c', `model_reasoning_effort=${CODEX_INDIRECT_FALLBACK_EFFORT}`,
      '--output-schema',
    ]));
    expect(codexArgs).toContain('-c');
    expect(codexArgs).toContain('shell_environment_policy.inherit=none');
    expect(codexArgs).toContain('shell_environment_policy.include_only=["PATH","LANG","LC_ALL","TERM"]');
    expect(codexArgs).not.toContain('--ignore-user-config');
    expect(codexArgs).not.toContain('--sandbox');
    expect(codexArgs).not.toContain('model_reasoning_effort=max');
    expect(codexArgs[codexArgs.indexOf('--output-schema') + 1]).toMatch(/output-schema\.json$/);
    expect(codexEnv.CODEX_AUTH_JSON).toBeUndefined();
    expect(codexEnv.OPENAI_API_KEY).toBeUndefined();
    expect(codexEnv.CODEX_HOME).toBe(codexHome);
    expect(Object.keys(codexEnv).sort()).toEqual(expect.arrayContaining(['CODEX_HOME', 'PATH', 'TMPDIR']));
    expect(Object.keys(codexEnv).every((key) => ['CODEX_HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR'].includes(key))).toBe(true);
    expect(codexEnv.HOME).toBeUndefined();
    expect(codexEnv.GITHUB_TOKEN).toBeUndefined();
    expect(fs.existsSync(codexHome)).toBe(false);
    expect(JSON.stringify(spawnMock.mock.calls[1])).not.toContain('TOP-SECRET-CODEX-AUTH');
  });

  it('gives Codex priority over a salvageable Claude payload after HTTP 429', async () => {
    installClaudeThenCodex({
      claudeResult: 'HTTP 429 usage limit',
      claudeStructuredPayload: { body: 'partial-from-claude' },
      codexResult: 'COMPLETE-FROM-CODEX',
    });

    await expect(callLLM(messages, {
      model: AI_MODELS.CLAUDE_CLI_HAIKU,
      chain: [AI_MODELS.CLAUDE_CLI_HAIKU],
    })).resolves.toBe('COMPLETE-FROM-CODEX');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect((spawnMock.mock.calls[1] as [string])[0]).toBe('codex');
  });

  it.each([
    ['HTTP 529 overloaded', 1],
    ['error_max_turns', 1],
    ['generic subprocess crash', 1],
    ['too many requests; rate limit', 1],
  ])('does not invoke Codex for %s', async (claudeResult, claudeCode) => {
    installClaudeThenCodex({ claudeResult, claudeCode });

    await expect(callLLM(messages, {
      model: AI_MODELS.CLAUDE_CLI_HAIKU,
      chain: [AI_MODELS.CLAUDE_CLI_HAIKU],
    })).rejects.toThrow();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect((spawnMock.mock.calls[0] as [string])[0]).toBe('claude');
  });

  it('uses the rejected rate_limit_event signal even without a result envelope', async () => {
    installClaudeThenCodex({ claudeRateLimitEvent: true, codexResult: 'EVENT-FALLBACK-RESULT' });

    await expect(callLLM(messages, {
      model: AI_MODELS.CLAUDE_CLI_HAIKU,
      chain: [AI_MODELS.CLAUDE_CLI_HAIKU],
    })).resolves.toBe('EVENT-FALLBACK-RESULT');

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect((spawnMock.mock.calls[1] as [string])[0]).toBe('codex');
  });

  it('keeps the normal subsequent chain when the one Codex attempt fails', async () => {
    process.env.LOCAL_LLM_ENABLED = '1';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ message: { content: 'NORMAL-CHAIN-RESULT' } }] }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    installClaudeThenCodex({ claudeResult: 'usage limit HTTP 429', codexCode: 1 });

    const result = await callLLM(messages, {
      model: AI_MODELS.CLAUDE_CLI_HAIKU,
      chain: [AI_MODELS.CLAUDE_CLI_HAIKU, AI_MODELS.LOCAL_FALLBACK],
    });

    expect(result).toBe('NORMAL-CHAIN-RESULT');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect((spawnMock.mock.calls[1] as [string])[0]).toBe('codex');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('attributes a successful replacement to Codex through modelUsedRef', async () => {
    installClaudeThenCodex({ claudeResult: 'HTTP 429 usage limit', codexResult: 'ATTRIBUTED-CODEX' });
    const modelUsedRef: { model?: string; provider?: string; indirectFallback?: boolean } = {};

    await expect(callLLM(messages, {
      model: AI_MODELS.CLAUDE_CLI_HAIKU,
      chain: [AI_MODELS.CLAUDE_CLI_HAIKU],
      modelUsedRef,
    })).resolves.toBe('ATTRIBUTED-CODEX');

    expect(modelUsedRef).toEqual({
      model: CODEX_FALLBACK_MODEL,
      provider: 'codex-cli',
      indirectFallback: true,
    });
  });

  it('keeps jsonMode structured output when no caller schema is supplied', async () => {
    let schemaContents = '';
    installClaudeThenCodex({
      claudeResult: 'HTTP 429 usage limit',
      codexResult: '{"ok":true}',
      onCodexStart: (args) => {
        const schemaPath = args[args.indexOf('--output-schema') + 1];
        schemaContents = fs.readFileSync(schemaPath, 'utf8');
      },
    });

    await expect(callLLM(messages, {
      model: AI_MODELS.CLAUDE_CLI_HAIKU,
      chain: [AI_MODELS.CLAUDE_CLI_HAIKU],
      jsonMode: true,
    })).resolves.toBe('{"ok":true}');

    const codexArgs = (spawnMock.mock.calls[1] as [string, string[], SpawnOptions])[1];
    expect(codexArgs).toContain('--output-schema');
    expect(JSON.parse(schemaContents)).toEqual({ type: 'object' });
  });

  it('honors AI_MODELS_SCHEMA_MODE=off while still validating JSON-mode output', async () => {
    process.env.AI_MODELS_SCHEMA_MODE = 'off';
    installClaudeThenCodex({ claudeResult: 'HTTP 429 usage limit', codexResult: '{"killSwitch":true}' });

    await expect(callLLM(messages, {
      model: AI_MODELS.CLAUDE_CLI_HAIKU,
      chain: [AI_MODELS.CLAUDE_CLI_HAIKU],
      jsonMode: true,
    })).resolves.toBe('{"killSwitch":true}');

    const codexArgs = (spawnMock.mock.calls[1] as [string, string[], SpawnOptions])[1];
    expect(codexArgs).not.toContain('--output-schema');
  });

  it('rejects non-JSON Codex output in jsonMode and continues the normal chain', async () => {
    process.env.AI_MODELS_SCHEMA_MODE = 'off';
    installClaudeThenCodex({ claudeResult: 'HTTP 429 usage limit', codexResult: 'not-json' });

    await expect(callLLM(messages, {
      model: AI_MODELS.CLAUDE_CLI_HAIKU,
      chain: [AI_MODELS.CLAUDE_CLI_HAIKU],
      jsonMode: true,
    })).rejects.toThrow(/All AI models failed/);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('never extends a near-expiry caller deadline for Codex', () => {
    process.env.CODEX_CLI_TIMEOUT_MS = '600000';
    const deadlineMs = Date.now() + 5000;
    const timeout = __codexFallbackTimeoutForTests({ deadlineMs });
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(5000);
    expect(__codexFallbackTimeoutForTests({ deadlineMs: Date.now() + 15000 })).toBeLessThanOrEqual(15000);
  });

  it('consumes the indirect Codex fallback at most once per process', async () => {
    installClaudeThenCodex({ claudeResult: 'usage limit HTTP 429', codexCode: 1 });
    const options = { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain: [AI_MODELS.CLAUDE_CLI_HAIKU] };

    await expect(callLLM(messages, options)).rejects.toThrow();
    await expect(callLLM(messages, options)).rejects.toThrow();

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect((spawnMock.mock.calls[0] as [string])[0]).toBe('claude');
    expect((spawnMock.mock.calls[1] as [string])[0]).toBe('codex');
    expect((spawnMock.mock.calls[2] as [string])[0]).toBe('claude');
  });

  it('keeps medium effort for the indirect path while direct workflow fallback remains max', () => {
    expect(CODEX_INDIRECT_FALLBACK_EFFORT).toBe('medium');
    expect(CODEX_FALLBACK_MODEL).toBe('gpt-5.6-luna');
    expect(CODEX_FALLBACK_EFFORT).toBe('max');
  });
});
