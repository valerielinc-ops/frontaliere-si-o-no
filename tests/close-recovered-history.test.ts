import { describe, expect, it } from 'vitest';
import {
  HISTORY_NOT_EVALUABLE_MARKER,
  assessBranchRecovery,
  branchRecoveryNote,
  buildRunListArgs,
  canUseBranchRecovery,
  classifyRunListFailure,
  failureRunScope,
  mergeRunHistoryResults,
  historyUnavailableNote,
  alreadyHistoryUnavailable,
  branchHistoryStartAt,
  BRANCH_HISTORY_FALLBACK_MARGIN_DAYS,
  runHistoryMemoKey,
  RUN_HISTORY_STATUS_FILTERS,
} from '../scripts/ci/close-recovered-failure-issues.mjs';

const NOW = Date.parse('2026-10-06T20:00:00Z');

function run(id: number, createdAt: string, conclusion: 'success' | 'failure' | 'timed_out' | 'startup_failure', extra = {}) {
  return {
    databaseId: id,
    status: 'completed',
    conclusion,
    createdAt,
    headBranch: 'fix/11955',
    event: 'pull_request_target',
    ...extra,
  };
}

describe('close-recovered history reads', () => {
  it('builds server-filtered ordinary listings and leaves crawler population untouched', () => {
    expect(RUN_HISTORY_STATUS_FILTERS).toEqual(['success', 'failure', 'timed_out', 'startup_failure']);
    const success = buildRunListArgs('Deploy to GitHub Pages', { status: 'success' });
    const failure = buildRunListArgs('Deploy to GitHub Pages', { status: 'failure' });
    expect(success).toContain('--status');
    expect(success).toContain('success');
    expect(failure).toContain('failure');
    expect(success).toContain('main');

    const timeout = buildRunListArgs('Deploy to GitHub Pages', { status: 'timed_out' });
    expect(timeout).toContain('timed_out');

    const crawler = buildRunListArgs('Crawler Group 02 (26 crawlers)', {
      includeCrawlerShadowBranches: true,
    });
    expect(crawler).not.toContain('--status');
    expect(crawler).not.toContain('-b');
  });

  it('filtra dal server il branch push o l\'evento PR e include la finestra creata', () => {
    const push = buildRunListArgs('Orphan push warn', {
      historyScope: 'branch',
      branch: 'feat/canton-hubs-producer',
      event: 'push',
      created: '>=2026-10-05',
      status: 'success',
    });
    expect(push).toEqual(expect.arrayContaining([
      '--branch', 'feat/canton-hubs-producer',
      '--event', 'push',
      '--created', '>=2026-10-05',
    ]));
    expect(push).not.toEqual(expect.arrayContaining(['-b']));

    const pr = buildRunListArgs('Retry code check after corrected PR body', {
      historyScope: 'event',
      event: 'pull_request_target',
      created: '>=2026-10-05',
      status: 'failure',
    });
    expect(pr).toEqual(expect.arrayContaining([
      '--event', 'pull_request_target',
      '--created', '>=2026-10-05',
    ]));
    expect(pr).not.toContain('--branch');
  });

  it('parte dalla data della run fallita o dall\'issue meno il margine dichiarato', () => {
    expect(branchHistoryStartAt(
      { createdAt: '2026-10-05T22:36:39Z' },
      '2026-10-05T20:53:49Z',
    )).toMatchObject({
      filter: '>=2026-10-05',
      source: 'failure-run',
    });
    expect(branchHistoryStartAt({ createdAt: '2026-10-05T22:36:39Z' }, null)).toMatchObject({
      filter: '>=2026-10-04',
      source: 'issue-open-minus-margin',
    });
    expect(BRANCH_HISTORY_FALLBACK_MARGIN_DAYS).toBeGreaterThan(0);
  });

  it('merges meaningful status pages without letting cancelled rows consume the history', () => {
    const result = mergeRunHistoryResults([
      {
        kind: 'ok',
        runs: [run(3, '2026-10-06T19:00:00Z', 'success')],
      },
      {
        kind: 'ok',
        runs: [run(2, '2026-10-06T18:00:00Z', 'failure')],
      },
    ]);

    expect(result).toMatchObject({ kind: 'ok' });
    expect(result.runs?.map((item) => item.databaseId)).toEqual([3, 2]);
  });

  it('keeps main, branch fallback, and crawler histories in separate memo populations', () => {
    expect(runHistoryMemoKey('w', 'o/r', { historyScope: 'main' }))
      .not.toBe(runHistoryMemoKey('w', 'o/r', { historyScope: 'branches' }));
    expect(runHistoryMemoKey('w', 'o/r', { historyScope: 'branches' }))
      .not.toBe(runHistoryMemoKey('w', 'o/r', { includeCrawlerShadowBranches: true }));
    expect(runHistoryMemoKey('w', 'o/r', {
      historyScope: 'branch', branch: 'feat/a', created: '>=2026-10-05',
    })).not.toBe(runHistoryMemoKey('w', 'o/r', {
      historyScope: 'branch', branch: 'feat/b', created: '>=2026-10-05',
    }));
    expect(runHistoryMemoKey('w', 'o/r', {
      historyScope: 'branch', branch: 'feat/a', created: '>=2026-10-05',
    })).not.toBe(runHistoryMemoKey('w', 'o/r', {
      historyScope: 'branch', branch: 'feat/a', created: '>=2026-10-06',
    }));
  });

  it('uses the stricter branch proof and rejects a still-red PR in the gate window', () => {
    const clean = assessBranchRecovery([
      run(12, '2026-10-06T19:30:00Z', 'success'),
      run(11, '2026-10-06T19:00:00Z', 'success'),
      run(10, '2026-10-06T18:30:00Z', 'success'),
      run(9, '2026-10-05T10:00:00Z', 'failure'),
    ], {
      issue: { createdAt: '2026-10-05T09:00:00Z' },
      scope: { branch: 'fix/11955', event: 'pull_request_target' },
      now: NOW,
      windowHours: 8,
      minGreenStreak: 3,
    });
    expect(clean).toMatchObject({ recovered: true, run: { databaseId: 12 }, greenStreak: 3 });

    const redNow = assessBranchRecovery([
      run(12, '2026-10-06T19:30:00Z', 'success'),
      run(11, '2026-10-06T19:00:00Z', 'success'),
      run(10, '2026-10-06T18:30:00Z', 'success'),
      run(8, '2026-10-06T17:30:00Z', 'failure'),
    ], {
      issue: { createdAt: '2026-10-05T09:00:00Z' },
      scope: { branch: 'fix/11955', event: 'pull_request_target' },
      now: NOW,
      windowHours: 8,
      minGreenStreak: 3,
    });
    expect(redNow).toMatchObject({ recovered: false, redInWindow: true });
  });

  it('scopes push recovery to its branch but lets PR recovery use the workflow population', () => {
    const push = failureRunScope({
      workflow: 'Orphan push warn',
      body: '**Branch:** `feat/canton-hubs-producer`\n- **Evento:** `push`',
    });
    expect(push).toEqual({ branch: 'feat/canton-hubs-producer', event: 'push' });
    expect(canUseBranchRecovery(push)).toBe(true);

    const pr = failureRunScope({
      workflow: 'Retry code check after corrected PR body',
      body: '**Branch:** `closed-pr`\n- **Evento:** `pull_request_target`',
    });
    expect(pr).toEqual({ branch: null, event: 'pull_request_target' });
    expect(canUseBranchRecovery(pr)).toBe(true);
    expect(canUseBranchRecovery({ branch: 'main', event: 'push' })).toBe(false);

    const realReporterShape = failureRunScope({
      workflow: 'Orphan push warn',
      body: '- Branch: `feat/canton-hubs-producer`\n- Evento: `push`',
    });
    expect(realReporterShape).toEqual({ branch: 'feat/canton-hubs-producer', event: 'push' });
  });

  it('declares the strict branch proof and the green run ids in the close comment', () => {
    const note = branchRecoveryNote({
      workflow: 'Orphan push warn',
      repo: 'nanakokyobashi-rgb/frontaliere-articles',
      evidence: {
        scope: { branch: 'feat/canton-hubs-producer', event: 'push' },
        greenStreak: 3,
        windowHours: 8,
        history: [
          run(37382984159, '2026-10-06T19:00:00Z', 'success'),
          run(37374204436, '2026-10-06T18:00:00Z', 'success'),
          run(37373257362, '2026-10-06T17:00:00Z', 'success'),
        ],
      },
    });
    expect(note).toContain('3 verdi consecutive');
    expect(note).toContain('#37382984159');
    expect(note).toContain('feat/canton-hubs-producer');
  });

  it('separates a missing workflow from an unreadable gh history', () => {
    expect(classifyRunListFailure('could not find any workflows named Missing workflow')).toBe('workflow-missing');
    expect(classifyRunListFailure('gh: API rate limit exceeded')).toBe('history-unreadable');

    expect(mergeRunHistoryResults([
      { kind: 'workflow-missing', runs: null },
      { kind: 'workflow-missing', runs: null },
    ])).toMatchObject({ kind: 'workflow-missing', runs: null });
    expect(mergeRunHistoryResults([
      { kind: 'ok', runs: [] },
      { kind: 'history-unreadable', runs: null },
    ])).toMatchObject({ kind: 'history-unreadable', runs: null });
  });

  it('makes the non-evaluable comment idempotent per true reason', () => {
    const note = historyUnavailableNote({
      workflow: 'Retry code check after corrected PR body',
      kind: 'history-unreadable',
    });
    expect(note).toContain(HISTORY_NOT_EVALUABLE_MARKER);
    expect(note).toContain('history-unreadable');
    expect(alreadyHistoryUnavailable([{ body: note }], 'history-unreadable')).toBe(true);
    expect(alreadyHistoryUnavailable([{ body: note }], 'workflow-missing')).toBe(false);
  });
});
