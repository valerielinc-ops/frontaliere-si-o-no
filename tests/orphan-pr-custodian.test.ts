import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  actionMarker,
  cancelledRequiredSuites,
  classifyOrphan,
  isAutonomousPr,
} from '../scripts/ci/orphan-pr-custodian.mjs';
import { VITEST_CHECK_NAME } from '../scripts/ci/lib/constants.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const NOW_S = Date.parse('2026-09-19T17:40:00Z') / 1000;
const WORKFLOW = readFileSync(new URL('../.github/workflows/stale-pr-rescuer.yml', import.meta.url), 'utf8');

function pr(overrides: Record<string, unknown> = {}) {
  return {
    number: 1591,
    draft: false,
    headRef: 'audit-stale-claim-marker',
    headSha: HEAD,
    updatedAt: '2026-09-19T11:09:00Z',
    authorType: 'User',
    labels: [] as string[],
    ...overrides,
  };
}

function review(body: string, commit = HEAD, id = 10) {
  return { id, state: 'COMMENTED', commit_id: commit, body, user: { type: 'Bot', login: 'frontaliere-automation[bot]' } };
}

function checkRun(id: number, suite: number, conclusion: string | null, status = 'completed', sha = HEAD) {
  return {
    id,
    name: VITEST_CHECK_NAME,
    head_sha: sha,
    status,
    conclusion,
    check_suite: { id: suite },
    details_url: `https://github.com/o/r/actions/runs/${suite * 10}/job/${id}`,
  };
}

const outOfScope = {
  user: { login: 'github-actions[bot]' },
  body: '<!-- REDFLAG_OUT_OF_SCOPE -->\nℹ️ 🔴-fixer: fuori scope',
};
const IMPORTANT = '## Findings\nscripts/x.mjs:L1: 🔴 Important: rompe il contratto.';

describe('orphan-pr-custodian — rerun di un check richiesto CANCELLED con LGTM (corpus #1591)', () => {
  it('rilancia la suite cancellata anche quando un\'altra suite dello stesso check e\' verde', () => {
    const decision = classifyOrphan({
      pr: pr(),
      checkRuns: [checkRun(1, 7, 'cancelled'), checkRun(2, 8, 'success')],
      reviews: [review('## LGTM\nTutto ok.')],
      comments: [],
      nowS: NOW_S,
    });
    expect(decision.action).toBe('rerun');
    expect(decision.runIds).toEqual(['70']);
  });

  it('usa solo l\'ultima generazione di ogni suite: un rerun verde chiude la suite', () => {
    const { cancelled } = cancelledRequiredSuites(
      [checkRun(1, 7, 'cancelled'), checkRun(3, 7, 'success')], HEAD, VITEST_CHECK_NAME);
    expect(cancelled).toEqual([]);
  });

  it('non agisce senza LGTM sulla HEAD, con una run in volo, o dopo il marker', () => {
    const base = { checkRuns: [checkRun(1, 7, 'cancelled')], comments: [] as unknown[], nowS: NOW_S };
    expect(classifyOrphan({ ...base, pr: pr(), reviews: [review('## LGTM', OLD)] }).action).toBe('none');
    expect(classifyOrphan({ ...base, pr: pr(), reviews: [review(`## LGTM\n${IMPORTANT}`)] }).action).not.toBe('rerun');
    expect(classifyOrphan({
      ...base, pr: pr(), reviews: [review('## LGTM')],
      checkRuns: [checkRun(1, 7, 'cancelled'), checkRun(4, 9, null, 'in_progress')],
    }).action).toBe('none');
    expect(classifyOrphan({
      ...base, pr: pr(), reviews: [review('## LGTM')],
      comments: [{ user: { login: 'github-actions[bot]' }, body: actionMarker('rerun', HEAD) }],
    }).action).toBe('none');
  });

  it('non tocca una PR con attivita\' nelle ultime 2 ore o in draft', () => {
    const args = { checkRuns: [checkRun(1, 7, 'cancelled')], reviews: [review('## LGTM')], comments: [], nowS: NOW_S };
    expect(classifyOrphan({ ...args, pr: pr({ updatedAt: '2026-09-19T16:30:00Z' }) }).action).toBe('none');
    expect(classifyOrphan({ ...args, pr: pr({ draft: true }) }).action).toBe('none');
  });
});

describe('orphan-pr-custodian — adozione di un 🔴 fuori scope (sito #9221/#9224/#9230)', () => {
  it('adotta una PR umana con 🔴 sulla HEAD e REDFLAG_OUT_OF_SCOPE', () => {
    const decision = classifyOrphan({
      pr: pr(), checkRuns: [], reviews: [review(IMPORTANT)], comments: [outOfScope], nowS: NOW_S,
    });
    expect(decision.action).toBe('adopt');
  });

  it('lascia ai fixer le PR gia\' autonome e rispetta needs-human', () => {
    const args = { checkRuns: [], reviews: [review(IMPORTANT)], comments: [outOfScope], nowS: NOW_S };
    expect(classifyOrphan({ ...args, pr: pr({ headRef: 'fix/issue-1' }) }).action).toBe('none');
    expect(classifyOrphan({ ...args, pr: pr({ labels: ['agent:autofix'] }) }).action).toBe('none');
    expect(classifyOrphan({ ...args, pr: pr({ authorType: 'Bot' }) }).action).toBe('none');
    expect(classifyOrphan({ ...args, pr: pr({ labels: ['needs-human'] }) }).action).toBe('none');
  });

  it('non adotta senza dichiarazione di fuori scope, su review vecchia o due volte', () => {
    expect(classifyOrphan({
      pr: pr(), checkRuns: [], reviews: [review(IMPORTANT)], comments: [], nowS: NOW_S,
    }).action).toBe('none');
    expect(classifyOrphan({
      pr: pr(), checkRuns: [], reviews: [review(IMPORTANT, OLD)], comments: [outOfScope], nowS: NOW_S,
    }).action).toBe('none');
    expect(classifyOrphan({
      pr: pr(), checkRuns: [], reviews: [review(IMPORTANT)],
      comments: [outOfScope, { user: { login: 'github-actions[bot]' }, body: actionMarker('adopt', HEAD) }],
      nowS: NOW_S,
    }).action).toBe('none');
  });

  it('non si fida di un REDFLAG_OUT_OF_SCOPE scritto da un utente qualsiasi', () => {
    expect(classifyOrphan({
      pr: pr(), checkRuns: [], reviews: [review(IMPORTANT)],
      comments: [{ user: { login: 'someone' }, body: outOfScope.body }], nowS: NOW_S,
    }).action).toBe('none');
  });

  it('usa la stessa definizione di autonomia dei fixer', () => {
    expect(isAutonomousPr(pr({ headRef: 'automerge-x' }))).toBe(true);
    expect(isAutonomousPr(pr())).toBe(false);
  });
});

describe('stale-pr-rescuer — cablaggio', () => {
  it('non crea nemmeno il run per i tests di main (filtro sul trigger)', () => {
    expect(WORKFLOW).toMatch(/workflow_run:\n\s+workflows: \["tests"\]\n\s+types: \[completed\]\n(?:\s+#.*\n)*\s+branches-ignore: \[main\]\n/);
  });

  it('non gira sui completamenti di tests dei push su main', () => {
    expect(WORKFLOW).toContain("if: github.event_name != 'workflow_run' || github.event.workflow_run.event != 'push'");
  });

  it('esegue il custode con lo script e le costanti presenti nel checkout sparse', () => {
    expect(WORKFLOW).toMatch(/sparse-checkout: \|\n(?:\s+\S+\n)*\s+scripts\/ci\/orphan-pr-custodian\.mjs\n/);
    expect(WORKFLOW).toContain('scripts/ci/lib/constants.mjs');
    expect(WORKFLOW).toContain('run: node scripts/ci/orphan-pr-custodian.mjs');
  });
});
