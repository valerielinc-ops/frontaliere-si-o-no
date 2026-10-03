import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * OSSERVATORE: ogni summary dei crawler porta il commit del codice che l'ha
 * prodotta (`codeCommit`).
 *
 * Senza il campo il monitor di salute non distingue «la fix non funziona» da
 * «la fix non ha ancora girato»: le ondate lanciate dal fallback di contratto
 * su un commit arretrato del sito (run corpus 37112857893) hanno fatto
 * riaprire issue crawler già corrette. Il campo deve esserci su ENTRAMBI i
 * cammini di scrittura — pipeline e guardia di uscita — e mancare, invece di
 * essere inventato, quando il commit non è determinabile.
 */

const written = vi.hoisted(() => [] as Array<{ filePath: string; value: any }>);

vi.mock('../scripts/lib/atomic-write-json.mjs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // La summary non deve finire nel file tracciato durante il test.
  writeJsonAtomic: (filePath: string, value: any) => { written.push({ filePath, value }); },
}));

import {
  resolveCheckoutCodeCommit,
  stampCodeCommit,
} from '../scripts/lib/checkout-code-commit.mjs';
import {
  registerCrawlerSummaryGuard,
  writeSummaryCrawlerSlice,
} from '../scripts/assemble-jobs-dataset.mjs';

const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: path.resolve(__dirname, '..'),
  encoding: 'utf8',
}).trim();
const OTHER = 'ab'.repeat(20);

afterEach(() => {
  written.length = 0;
  vi.restoreAllMocks();
});

describe('resolveCheckoutCodeCommit', () => {
  it('legge HEAD dal checkout che contiene gli script, non dalla cwd del processo', () => {
    const exec = vi.fn(() => `${OTHER}\n`);
    expect(resolveCheckoutCodeCommit({ exec })).toBe(OTHER);
    const [command, args, options] = exec.mock.calls[0] as unknown as [string, string[], { cwd: string }];
    expect([command, ...args]).toEqual(['git', 'rev-parse', 'HEAD']);
    expect(options.cwd).toBe(path.resolve(__dirname, '..', 'scripts', 'lib'));
    expect(resolveCheckoutCodeCommit()).toBe(HEAD);
  });

  it.each([
    ['git fallisce (nessun .git, binario assente)', () => { throw new Error('not a git repository'); }],
    ['git stampa qualcosa che non è un commit', () => 'HEAD\n'],
    ['git stampa uno sha abbreviato', () => 'abc1234\n'],
  ])('restituisce null quando %s', (_label, exec) => {
    expect(resolveCheckoutCodeCommit({ exec })).toBeNull();
  });
});

describe('stampCodeCommit', () => {
  it('aggiunge il commit senza toccare gli altri campi né l oggetto ricevuto', () => {
    const summary = { key: 'acme', total: 3 };
    expect(stampCodeCommit(summary, OTHER)).toEqual({ key: 'acme', total: 3, codeCommit: OTHER });
    expect(summary).toEqual({ key: 'acme', total: 3 });
  });

  it('omette il campo quando il commit non è determinabile, anche se la summary ne ereditava uno', () => {
    expect(stampCodeCommit({ key: 'acme', codeCommit: OTHER }, null)).toEqual({ key: 'acme' });
    expect(stampCodeCommit({ key: 'acme', codeCommit: OTHER }, 'main')).toEqual({ key: 'acme' });
  });

  it('sostituisce un commit ereditato da una summary precedente con quello di questa esecuzione', () => {
    expect(stampCodeCommit({ key: 'acme', codeCommit: OTHER }, HEAD)).toEqual({ key: 'acme', codeCommit: HEAD });
  });
});

describe('summary slice dei crawler', () => {
  // Per primo: la guardia scrive solo se la pipeline non ha già pubblicato.
  it('la guardia di uscita firma il segnaposto col commit del checkout', () => {
    const listeners: Array<(code: number) => void> = [];
    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: (code: number) => void) => {
      if (event === 'exit') listeners.push(listener);
      return process;
    }) as typeof process.on);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');

    registerCrawlerSummaryGuard('code-commit-guard-fixture', 'Fixture');
    expect(listeners).toHaveLength(1);
    listeners[0](0);
    vi.unstubAllEnvs();

    expect(written).toHaveLength(1);
    expect(written[0].filePath).toMatch(/jobs-crawler-summaries[\\/]by-crawler[\\/]code-commit-guard-fixture\.json$/);
    expect(written[0].value).toMatchObject({
      key: 'code-commit-guard-fixture',
      earlyExit: true,
      codeCommit: HEAD,
    });
  });

  it('la pipeline firma la summary pubblicata e non si fida di un commit passato dal chiamante', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    writeSummaryCrawlerSlice({
      key: 'code-commit-pipeline-fixture',
      generatedAt: new Date().toISOString(),
      total: 0,
      codeCommit: OTHER,
    });

    expect(written).toHaveLength(1);
    expect(written[0].value.codeCommit).toBe(HEAD);
  });
});
