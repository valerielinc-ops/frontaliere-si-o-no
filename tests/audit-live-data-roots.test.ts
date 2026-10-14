import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  auditLiveDataRoots,
  automatedPullRequestPaths,
  dayWindows,
  directBotCommitPaths,
  ghJson,
  isAutomatedDataPullRequest,
  listPullRequestsByDay,
  LIVE_DATA_ROOT_AUDIT_TITLE,
  PR_WINDOW_LIMIT,
  renderLiveDataRootDrift,
  resolveAutomatedPullRequestFiles,
  squashCommitPathsByPullNumber,
} from '../scripts/ci/audit-live-data-roots.mjs';

describe('audit periodico delle radici dati automatiche', () => {
  it('isola i percorsi dei commit bot diretti, escludendo i merge di PR', () => {
    const log = [
      '@@github-actions[bot]|chore: refresh the live snapshot',
      'data/live/current.json',
      'data/live/current.json',
      '@@Valerie|chore(data): sync snapshot (#123)',
      'data/from-pull-request.json',
      '@@release-bot|append state row',
      'data/from-another-bot.json',
    ].join('\n');
    expect(directBotCommitPaths(log)).toEqual([
      'data/from-another-bot.json',
      'data/live/current.json',
    ]);
  });

  it('richiede autore bot e prefisso dati, licenze o immagini per le PR automatiche', () => {
    expect(isAutomatedDataPullRequest({
      title: 'chore(data): refresh snapshot',
      author: { is_bot: true, login: 'app/frontaliere-automation' },
    })).toBe(true);
    expect(isAutomatedDataPullRequest({
      title: 'chore(images): refresh ledger',
      author: { is_bot: true, login: 'sync-bot[bot]' },
    })).toBe(true);
    expect(isAutomatedDataPullRequest({
      title: 'chore(licenses): refresh ledger',
      author: { is_bot: false, login: 'valerielinc-ops' },
    })).toBe(false);
    expect(isAutomatedDataPullRequest({
      title: 'fix(data): repair parser',
      author: { is_bot: true, login: 'sync-bot[bot]' },
    })).toBe(false);

    const found = automatedPullRequestPaths([
      {
        number: 1,
        title: 'chore(licenses): refresh image credits',
        author: { is_bot: true, login: 'licenses[bot]' },
        files: [{ path: 'data/blog-cover-ledger.json' }, { path: '../escape.json' }],
      },
      {
        number: 2,
        title: 'chore(data): human snapshot sync',
        author: { is_bot: false, login: 'valerielinc-ops' },
        files: [{ path: 'data/human.json' }],
      },
    ]);
    expect(found.candidates.map((pr) => pr.number)).toEqual([1]);
    expect(found.paths).toEqual(['data/blog-cover-ledger.json']);
  });

  it('deduplica gli output e conserva ogni percorso fuori dall’inventario', () => {
    const audit = auditLiveDataRoots({
      directPaths: ['data/live/one.json', 'data/new.json', 'docs/generated/report.json'],
      pullRequestPaths: ['data/new.json', 'data/pr-only.json', 'public/images/live/photo.webp'],
      roots: ['data/live/', 'public/images/live/'],
    });
    expect(audit.directPathCount).toBe(3);
    expect(audit.pullRequestPathCount).toBe(3);
    expect(audit.uncovered).toEqual([
      'data/new.json',
      'data/pr-only.json',
      'docs/generated/report.json',
    ]);
    expect(audit.directOnly).toEqual(['docs/generated/report.json']);
    expect(audit.pullRequestOnly).toEqual(['data/pr-only.json']);
    expect(audit.both).toEqual(['data/new.json']);
  });

  it('genera un report stabile con la finestra e tutti i percorsi scoperti', () => {
    const body = renderLiveDataRootDrift({
      sinceDate: '2026-09-10',
      commitPaths: ['data/direct.json'],
      pullRequestCount: 2,
      pullRequestPaths: ['data/pr.json'],
      uncovered: ['data/direct.json', 'data/pr.json'],
      runUrl: 'https://github.com/example/repo/actions/runs/1',
    });
    expect(LIVE_DATA_ROOT_AUDIT_TITLE).toBe('Live-data root drift (30-day bot inventory)');
    expect(body).toContain('2026-09-10');
    expect(body).toContain('data/direct.json');
    expect(body).toContain('data/pr.json');
    expect(body).toContain('osservatore non li autorizza né modifica l’inventario');
    expect(body).toContain('actions/runs/1');
  });

  it('collega l’osservatore al workflow main con permesso di sola lettura sulle PR', () => {
    const workflow = readFileSync(new URL('../.github/workflows/live-data-gates.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('pull-requests: read');
    expect(workflow).toContain("if: ${{ !cancelled() && github.ref == 'refs/heads/main' }}");
    expect(workflow).toContain('node scripts/ci/audit-live-data-roots.mjs --since-days 30');
  });

  it('l’audit gira dopo i test sui dati vivi: un suo errore non li salta più', () => {
    // 11-13 ottobre 2026: l’audit era il primo step e cadeva a ogni run, così
    // vitest e il reporter per file restavano `skipped`.
    const workflow = readFileSync(new URL('../.github/workflows/live-data-gates.yml', import.meta.url), 'utf8');
    const audit = workflow.indexOf('- name: Audit 30-day live-data roots');
    const vitest = workflow.indexOf('- name: vitest run (solo i test su dati vivi)');
    const reporter = workflow.indexOf('- name: Report live-data reds per test file');
    const failure = workflow.indexOf('- name: Report failure to GitHub Issues');
    expect(vitest).toBeGreaterThan(0);
    expect(audit).toBeGreaterThan(reporter);
    expect(reporter).toBeGreaterThan(vitest);
    expect(failure).toBeGreaterThan(audit);
    expect(workflow.slice(audit, failure)).not.toContain('continue-on-error');
  });
});

describe('raccolta delle PR automatiche per finestre giornaliere', () => {
  it('elenca ogni giorno dalla data di partenza a oggi, estremi inclusi', () => {
    expect(dayWindows('2026-09-29', new Date('2026-10-02T18:00:00Z'))).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
    expect(dayWindows('2026-10-02', new Date('2026-10-02T00:00:01Z'))).toEqual(['2026-10-02']);
  });

  it('interroga un giorno alla volta senza file (GraphQL 502) e deduplica le PR per numero', () => {
    const calls: string[][] = [];
    const pages: Record<string, unknown[]> = {
      '2026-10-01': [{ number: 7, title: 'chore(data): a', files: [] }],
      '2026-10-02': [
        { number: 7, title: 'chore(data): a', files: [] },
        { number: 8, title: 'chore(images): b', files: [] },
      ],
    };
    const listed = listPullRequestsByDay({
      repo: 'owner/repo',
      sinceDate: '2026-10-01',
      now: new Date('2026-10-02T12:00:00Z'),
      read: (args: string[]) => {
        calls.push(args);
        const search = args[args.indexOf('--search') + 1];
        return pages[search.slice('created:'.length, 'created:'.length + 10)] ?? [];
      },
    });
    expect(listed.map((pr: { number: number }) => pr.number)).toEqual([7, 8]);
    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect(args).toContain('--json');
      // 2026-10-14: con `files` GraphQL risponde 502 anche su un solo giorno.
      expect(args[args.indexOf('--json') + 1].split(',')).not.toContain('files');
      expect(args[args.indexOf('--json') + 1].split(',')).toContain('state');
      expect(args[args.indexOf('--search') + 1]).toMatch(/^created:\d{4}-\d{2}-\d{2} in:title chore$/u);
      expect(args[args.indexOf('--limit') + 1]).toBe(String(PR_WINDOW_LIMIT));
    }
  });

  it('una finestra al tetto ferma l’audit invece di riportarne uno parziale', () => {
    const full = Array.from({ length: PR_WINDOW_LIMIT }, (_, index) => ({ number: index + 1, title: 'chore(data): x' }));
    expect(() => listPullRequestsByDay({
      repo: 'owner/repo',
      sinceDate: '2026-10-01',
      now: new Date('2026-10-01T12:00:00Z'),
      read: () => full,
    })).toThrow(/2026-10-01 ha raggiunto il limite/u);
  });

  it('legge i file di una PR mergiata dal suo commit squash nella storia', () => {
    const log = [
      '@@Valerie|chore(data): refresh fuel prices (#13062)',
      'data/fuel-prices.json',
      'data/fuel-history.jsonl',
      '@@github-actions[bot]|chore: refresh the live snapshot',
      'data/live/current.json',
      '@@Valerie|fix(seo): something (#13063)',
      'services/seoService.ts',
      '../escape.json',
    ].join('\n');
    const byNumber = squashCommitPathsByPullNumber(log);
    expect(byNumber.get(13062)).toEqual(['data/fuel-history.jsonl', 'data/fuel-prices.json']);
    expect(byNumber.get(13063)).toEqual(['services/seoService.ts']);
    expect(byNumber.has(0)).toBe(false);
    expect([...byNumber.keys()]).toEqual([13062, 13063]);
  });

  it('risolve i file per stato: mergiata dalla storia, aperta da REST, chiusa senza merge esclusa', () => {
    const openReads: number[] = [];
    const { resolved, skippedClosed } = resolveAutomatedPullRequestFiles([
      { number: 1, state: 'MERGED', title: 'chore(data): a' },
      { number: 2, state: 'OPEN', title: 'chore(data): b' },
      { number: 3, state: 'CLOSED', title: 'chore(data): c' },
    ], {
      squashPaths: new Map([[1, ['data/a.json']]]),
      repo: 'owner/repo',
      readOpenFiles: (_repo: string, number: number) => {
        openReads.push(number);
        return ['data/b.json'];
      },
    });
    expect(resolved.map((pr: { number: number; files: string[] }) => [pr.number, pr.files])).toEqual([
      [1, ['data/a.json']],
      [2, ['data/b.json']],
    ]);
    expect(openReads).toEqual([2]);
    expect(skippedClosed).toBe(1);
  });

  it('una PR mergiata senza commit nella finestra, o con stato ignoto, ferma l’audit', () => {
    const options = { squashPaths: new Map(), repo: 'owner/repo', readOpenFiles: () => [] };
    expect(() => resolveAutomatedPullRequestFiles([{ number: 9, state: 'MERGED' }], options))
      .toThrow(/PR #9 mergiata ma senza commit/u);
    expect(() => resolveAutomatedPullRequestFiles([{ number: 10, state: 'DRAFT?' }], options))
      .toThrow(/stato sconosciuto/u);
  });

  it('ritenta una lettura gh fallita e poi cede con l’ultimo errore', () => {
    const slept: number[] = [];
    let calls = 0;
    const value = ghJson(['pr', 'list'], {
      exec: () => {
        calls += 1;
        if (calls < 3) throw new Error('HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)');
        return '[{"number":1}]';
      },
      sleep: (ms: number) => { slept.push(ms); },
    });
    expect(value).toEqual([{ number: 1 }]);
    expect(slept).toEqual([2000, 5000]);

    expect(() => ghJson(['pr', 'list'], {
      exec: () => { throw new Error('HTTP 502'); },
      sleep: () => {},
    })).toThrow('HTTP 502');
  });
});
