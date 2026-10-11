import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  auditLiveDataRoots,
  automatedPullRequestPaths,
  directBotCommitPaths,
  isAutomatedDataPullRequest,
  LIVE_DATA_ROOT_AUDIT_TITLE,
  renderLiveDataRootDrift,
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
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain('node scripts/ci/audit-live-data-roots.mjs --since-days 30');
  });
});
