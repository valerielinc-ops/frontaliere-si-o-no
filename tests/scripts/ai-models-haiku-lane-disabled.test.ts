import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AI_MODELS,
  __installScoreStoreForTests,
  callLLM,
  getPreferredModel,
  isModelAvailable,
  resetState,
} from '../../scripts/lib/ai-models.mjs';

/**
 * La lane Claude Haiku e' spenta NEL CODICE (decisione del proprietario del
 * 2026-09-24: «Disattiva haiku! Voglio solo codex»). Il kill-switch di Remote
 * Config non basta: ENABLE_HAIKU_ARTICLE_FALLBACK e' anche il gate storico
 * della lane Codex e in produzione vale `true`. Qui si pinna che
 * `claude-cli/haiku` non esce mai — con flag e token presenti, da nessuna delle
 * porte da cui un modello entra in una chiamata — mentre Codex resta
 * disponibile alle stesse condizioni. Stessa regola del gemello in
 * frontaliere-articles (generator/tests/haiku-lane-disabled.test.mjs).
 */
const HAIKU = AI_MODELS.CLAUDE_CLI_HAIKU;
const CODEX = AI_MODELS.CODEX_CLI_PRIMARY;
const RIVALE = AI_MODELS.MISTRAL_SMALL;
const SEAM = '__enableClaudeCliLaneForTests';

describe('lane Claude Haiku spenta nel codice, Codex unica lane CLI', () => {
  const ENV_KEYS = [
    'ENABLE_HAIKU_ARTICLE_FALLBACK',
    'ENABLE_CODEX_ARTICLE_FALLBACK',
    'CODEX_AUTH_BROKER_SOCKET',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CLI_BIN',
    'AI_MODELS_PREFER',
    'AI_MODELS_FORCE_CHAIN',
    'MISTRAL_API_KEY',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let tempDir = '';
  let marker = '';

  beforeAll(() => {
    __installScoreStoreForTests(null);
  });

  beforeEach(() => {
    resetState();
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haiku-lane-disabled-'));
    marker = path.join(tempDir, 'claude-ran');
    const cli = path.join(tempDir, 'claude');
    // Una CLI Claude "funzionante": se qualcuno la lanciasse, lascerebbe il marker.
    fs.writeFileSync(cli, `#!/bin/sh\necho ran > '${marker}'\necho '{"type":"result","result":"OK"}'\n`, { mode: 0o755 });
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = 'true';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'haiku-disabled-test-token';
    process.env.CLAUDE_CLI_BIN = cli;
    process.env.ENABLE_CODEX_ARTICLE_FALLBACK = 'true';
    process.env.CODEX_AUTH_BROKER_SOCKET = path.join(tempDir, 'auth.sock');
    process.env.MISTRAL_API_KEY = 'test-key';
    delete process.env.AI_MODELS_PREFER;
    delete process.env.AI_MODELS_FORCE_CHAIN;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    resetState();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('con flag e token Haiku non e\' disponibile, Codex si', () => {
    expect(isModelAvailable(HAIKU)).toBe(false);
    expect(isModelAvailable(CODEX)).toBe(true);
  });

  it('nessuna preferenza lo riporta in testa', () => {
    expect(getPreferredModel({ chain: [HAIKU, RIVALE], prefer: [HAIKU] })).toBe(RIVALE);
    expect(getPreferredModel({ chain: [RIVALE, HAIKU], prefer: HAIKU })).toBe(RIVALE);
    process.env.AI_MODELS_PREFER = HAIKU;
    expect(getPreferredModel({ chain: [HAIKU, RIVALE] })).toBe(RIVALE);
    expect(getPreferredModel({ chain: [RIVALE, HAIKU], prefer: [HAIKU, CODEX] })).toBe(CODEX);
  });

  it('callLLM con Haiku come model, chain e prefer non lancia la CLI Claude', async () => {
    await expect(callLLM([{ role: 'user', content: 'ping' }], {
      model: HAIKU,
      chain: [HAIKU],
      prefer: [HAIKU],
      recordScore: false,
    })).rejects.toThrow(/claude-cli\/haiku: skipped — no API key for provider claude_cli/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('il seam che riaccende la macchina claude-cli vive solo nei test', () => {
    const root = process.cwd();
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(m?js|ts|ya?ml|sh)$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes(SEAM)) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    for (const dir of ['scripts', '.github', 'functions/src']) {
      if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
    }
    expect(offenders).toEqual(['scripts/lib/ai-models.mjs']);
  });
});
