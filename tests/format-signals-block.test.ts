import { describe, it, expect, vi } from 'vitest';

// Same mock pattern as tests/github-issue-creator-gate.test.ts: `formatSignalsBlock`
// is pure, but the file also runs a CLI-mode side effect on import in some
// environments, so keep node:child_process mocked defensively.
const execFileSync = vi.fn();
vi.mock('node:child_process', () => {
  const mock = { execFileSync: (...args: unknown[]) => execFileSync(...args) };
  return { ...mock, default: mock };
});

const { formatSignalsBlock, createGithubIssue } = await import(
  '../scripts/lib/github-issue-creator.mjs'
);

describe('formatSignalsBlock', () => {
  it('renders nothing for null/undefined/empty signals', () => {
    expect(formatSignalsBlock(null)).toBe('');
    expect(formatSignalsBlock(undefined)).toBe('');
    expect(formatSignalsBlock({})).toBe('');
  });

  it('renders only the fields that are present', () => {
    const out = formatSignalsBlock({ cosa: 'X è rosso' });
    expect(out).toBe('## Segnali (raccolti automaticamente)\n- Cosa: X è rosso');
  });

  it('renders metrica only when osservato or atteso is present', () => {
    const out = formatSignalsBlock({ metrica: { osservato: 3, atteso: 0 } });
    expect(out).toContain('- Metrica: osservato=3 atteso=0');
  });

  it('renders comando in backticks', () => {
    const out = formatSignalsBlock({ comando: 'npm run audit:foo' });
    expect(out).toContain('- Comando di riproduzione: `npm run audit:foo`');
  });

  it('joins evidenza entries with a middle dot and drops falsy ones', () => {
    const out = formatSignalsBlock({ evidenza: ['run 123', '', null, 'file.ts:42'] });
    expect(out).toContain('- Evidenza: run 123 · file.ts:42');
  });

  it('renders the full block with every field, in order', () => {
    const out = formatSignalsBlock({
      cosa: 'audit:foo sopra soglia',
      metrica: { osservato: 12, atteso: 5 },
      comando: 'npm run audit:foo',
      evidenza: ['run 999'],
    });
    expect(out).toBe(
      [
        '## Segnali (raccolti automaticamente)',
        '- Cosa: audit:foo sopra soglia',
        '- Metrica: osservato=12 atteso=5',
        '- Comando di riproduzione: `npm run audit:foo`',
        '- Evidenza: run 999',
      ].join('\n'),
    );
  });
});

describe('createGithubIssue — signals wiring', () => {
  it('prepends the Segnali block before the free-form description in the issue body', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/x/y/issues/1';
      return '';
    });

    await createGithubIssue({
      title: 'audit:foo drift',
      description: 'testo libero esistente',
      signals: { cosa: 'foo sopra soglia', comando: 'npm run audit:foo' },
    });

    const createCall = execFileSync.mock.calls
      .map((c) => c[1] as string[])
      .find((a) => a[0] === 'issue' && a[1] === 'create');
    expect(createCall).toBeTruthy();
    const bodyIdx = createCall!.indexOf('--body');
    const body = createCall![bodyIdx + 1];
    expect(body.indexOf('## Segnali')).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('## Segnali')).toBeLessThan(body.indexOf('testo libero esistente'));
  });

  it('omits the Segnali block entirely when signals is not passed (unchanged behaviour)', async () => {
    execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/x/y/issues/2';
      return '';
    });

    await createGithubIssue({ title: 'no-signals case', description: 'solo descrizione' });

    const createCall = execFileSync.mock.calls
      .map((c) => c[1] as string[])
      .find((a) => a[0] === 'issue' && a[1] === 'create');
    const bodyIdx = createCall!.indexOf('--body');
    const body = createCall![bodyIdx + 1];
    expect(body).not.toContain('## Segnali');
  });
});
