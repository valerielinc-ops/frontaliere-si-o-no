import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import { AI_MODELS, callLLM, claudeCliChildEnv, resetState } from '../../scripts/lib/ai-models.mjs';

const AI_MODELS_SRC = readFileSync(
  new URL('../../scripts/lib/ai-models.mjs', import.meta.url),
  'utf-8',
);

/**
 * ── IL THINKING E' META' DELLA CHIAMATA, E IL DATO LO DICE ──────────────────
 *
 * La riga `🐢` del giro precedente ha risposto al primo giro. Tre chiamate reali
 * di `claude-cli/haiku`, log di produzione del corpus, 2026-08-19:
 *
 *   run 32261707656   wall 230s   ttft 111s   3 giri   21.166 out,  9.955 thinking
 *   run 32260372210   wall 181s   ttft 103s   2 giri   17.017 out,  9.430 thinking
 *   run 32260372210   wall  90s   ttft  85s   1 giro    8.147 out,  7.601 thinking
 *
 * Il rapporto thinking/ttft e' 89,7 · 91,6 · 89,4 token al secondo: la stessa
 * costante a tre cifre su tre chiamate indipendenti. Quindi `ttft_ms` non e'
 * attesa in coda — e' il tempo speso a PENSARE prima del primo token di
 * risposta — e vale il 48%, 57% e 94% dell'intera chiamata.
 *
 * E non e' coda: il `rate_limit_event` compare in tutte e tre ma dice
 * `status=allowed`. La quota Max condivisa con `pr-review-loop` e `issue-fix`
 * era il candidato causale piu' forte ed e' SCARTATA dal dato.
 *
 * Gemella di nanako#497. Qui il test e' end-to-end (il mock di
 * `node:child_process` che il corpus non ha): prova che il tetto arrivi
 * davvero all'ambiente del processo spawnato, non solo che l'helper lo calcoli.
 */
describe('claude CLI: il tetto al thinking arriva al processo', () => {
  const ENV_KEYS = ['ENABLE_HAIKU_ARTICLE_FALLBACK', 'CLAUDE_CODE_OAUTH_TOKEN', 'LOCAL_LLM_ENABLED', 'AI_COMPETING_TIERS', 'MAX_THINKING_TOKENS'] as const;
  const saved: Record<string, string | undefined> = {};

  const RESULT = `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'CORPO' })}\n`;

  function cliChe(chunks: string[]) {
    return () => {
      const so: Record<string, ((...a: unknown[]) => void)[]> = {};
      const on: Record<string, ((...a: unknown[]) => void)[]> = {};
      queueMicrotask(() => {
        for (const c of chunks) so.data?.forEach((cb) => cb(Buffer.from(c)));
        on.close?.forEach((cb) => cb(0));
      });
      return {
        stdout: { on: (e: string, cb: (...a: unknown[]) => void) => { (so[e] ||= []).push(cb); } },
        stderr: { on: () => {} },
        on: (e: string, cb: (...a: unknown[]) => void) => { (on[e] ||= []).push(cb); },
        kill: vi.fn(),
      };
    };
  }

  beforeEach(() => {
    resetState();
    spawnMock.mockReset();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ENABLE_HAIKU_ARTICLE_FALLBACK = '1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token';
    delete process.env.LOCAL_LLM_ENABLED;
    delete process.env.AI_COMPETING_TIERS;
    delete process.env.MAX_THINKING_TOKENS;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    resetState();
  });

  const chiama = () => callLLM(
    [{ role: 'user', content: 'Scrivi un articolo' }],
    { model: AI_MODELS.CLAUDE_CLI_HAIKU, chain: [AI_MODELS.CLAUDE_CLI_HAIKU] },
  );

  it('lo spawn riceve MAX_THINKING_TOKENS', async () => {
    spawnMock.mockImplementation(cliChe([RESULT]));
    await chiama();
    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(opts.env.MAX_THINKING_TOKENS).toBe('2048');
  });

  it('un valore gia\' impostato nell\'ambiente vince', async () => {
    // Chi lo imposta in un workflow lo fa apposta: una costante di libreria che
    // glielo cancella e' un override invisibile.
    process.env.MAX_THINKING_TOKENS = '512';
    spawnMock.mockImplementation(cliChe([RESULT]));
    await chiama();
    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(opts.env.MAX_THINKING_TOKENS).toBe('512');
  });

  it('il resto dell\'ambiente arriva intatto', async () => {
    spawnMock.mockImplementation(cliChe([RESULT]));
    await chiama();
    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('test-oauth-token');
  });

  it('non scrive su process.env del padre', () => {
    const base = { PATH: '/usr/bin' } as Record<string, string>;
    claudeCliChildEnv(base);
    expect(base.MAX_THINKING_TOKENS).toBeUndefined();
  });

  it('una stringa vuota non conta come «impostato»', () => {
    // E' cio' che produce un `env:` di GitHub Actions con un valore non
    // risolto: trattarla come scelta esplicita spegnerebbe il tetto proprio in
    // CI, cioe' dove serve.
    expect(claudeCliChildEnv({ MAX_THINKING_TOKENS: '' }).MAX_THINKING_TOKENS).toBe('2048');
  });

  it('il default sta SOTTO il thinking osservato, o sarebbe un no-op', () => {
    const m = /const CLAUDE_CLI_MAX_THINKING_TOKENS = \(\(\) => \{[\s\S]*?if \(!raw\) return (\d+);/.exec(AI_MODELS_SRC);
    expect(m).not.toBe(null);
    const tetto = Number(m![1]);
    expect(tetto).toBeLessThan(7601); // il minimo osservato in produzione
    expect(tetto).toBeGreaterThan(1024); // il minimo interno che la CLI sembra applicare
  });

  it('non tocca nessuna delle tre leve gia\' spese alla cieca', () => {
    expect(AI_MODELS_SRC).toMatch(/const CLAUDE_CLI_MIN_TIMEOUT_MS = 180_000;/);
    expect(AI_MODELS_SRC).toMatch(/const CLAUDE_CLI_MAX_CONCURRENCY = 2;/);
    expect(AI_MODELS_SRC).toMatch(/const CLAUDE_CLI_TIMEOUT_STORM_THRESHOLD = 3;/);
  });
});
