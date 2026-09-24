import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { formatRotationMarker } from '../scripts/ci/codex-auth-rotate.mjs';

const WORKFLOW = readFileSync(new URL('../.github/workflows/codex-auth-recovery.yml', import.meta.url), 'utf8');
const DEFINITION = YAML.parse(WORKFLOW) as {
  on?: {
    workflow_run?: { workflows?: string[]; types?: string[] };
    schedule?: Array<{ cron?: string }>;
    workflow_dispatch?: Record<string, unknown>;
  };
  permissions?: Record<string, string>;
  jobs?: Record<string, { steps?: Array<{ uses?: string; with?: { script?: string } }> }>;
};
const RECOVERY_SCRIPT = Object.values(DEFINITION.jobs ?? {})
  .flatMap((job) => job.steps ?? [])
  .find((step) => step.uses === 'actions/github-script@v8')?.with?.script ?? '';

describe('Codex auth recovery', () => {
  it('si attiva sul completamento dei test e della rotazione e dispone di una riconciliazione periodica', () => {
    expect(DEFINITION.on?.workflow_run).toMatchObject({ workflows: ['tests', 'Codex auth rotate'], types: ['completed'] });
    expect(DEFINITION.on?.schedule).toEqual([{ cron: '*/15 * * * *' }]);
    expect(DEFINITION.on?.workflow_dispatch).toEqual({});
    expect(DEFINITION.permissions).toMatchObject({
      actions: 'write',
      contents: 'read',
      issues: 'write',
      'pull-requests': 'write',
    });
  });

  it('usa un digest non segreto e riavvia solo la run tests pull_request esatta', () => {
    expect(WORKFLOW).toContain('CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}');
    expect(WORKFLOW).toContain('sha256sum');
    expect(RECOVERY_SCRIPT).toContain("const TESTS_WORKFLOW_PATH = '.github/workflows/tests.yml';");
    expect(RECOVERY_SCRIPT).toContain("run.path !== TESTS_WORKFLOW_PATH");
    expect(RECOVERY_SCRIPT).toContain("run.event !== 'pull_request'");
    expect(RECOVERY_SCRIPT).toContain('run.head_sha !== pr.head.sha');
    expect(RECOVERY_SCRIPT).toContain('run.pull_requests.some');
    expect(RECOVERY_SCRIPT).toContain('currentDigest === String(blocked.authDigest).toLowerCase()');
    expect(RECOVERY_SCRIPT).toContain('github.rest.actions.reRunWorkflow');
    expect(RECOVERY_SCRIPT).not.toContain('createWorkflowDispatch');
    expect(RECOVERY_SCRIPT).not.toContain('workflow_dispatch');
  });

  it('mantiene checkpoint e alert idempotenti e non trasferisce il segreto nei commenti', () => {
    expect(WORKFLOW).toContain('CODEX_AUTH_BLOCKED:');
    expect(WORKFLOW).toContain('CODEX_AUTH_RECOVERY:');
    expect(RECOVERY_SCRIPT).toContain('CODEX_AUTH_ALERT_TITLE');
    expect(RECOVERY_SCRIPT).toContain('CODEX_AUTH_BOT_LOGIN_RE');
    expect(RECOVERY_SCRIPT).toContain('authDigest');
    expect(RECOVERY_SCRIPT).not.toContain('process.env.CODEX_AUTH_JSON');
    expect(RECOVERY_SCRIPT).not.toMatch(/console\.(log|info|warn|error)\([^\n]*CODEX_AUTH/iu);
  });
});

const ACTION = readFileSync(new URL('../.github/actions/claude-codex-fallback/action.yml', import.meta.url), 'utf8');
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const PR_HEAD = 'c'.repeat(40);

type Call = [string, unknown];

async function runRecovery({
  currentDigest,
  issues = [],
  comments = {},
  prs = [],
  eventName = 'schedule',
  payload = {},
  runs = {},
}: {
  currentDigest: string;
  issues?: Array<Record<string, unknown>>;
  comments?: Record<number, Array<Record<string, unknown>>>;
  prs?: Array<Record<string, any>>;
  eventName?: string;
  payload?: Record<string, unknown>;
  runs?: Record<number, Record<string, unknown>>;
}): Promise<Call[]> {
  const calls: Call[] = [];
  const rest = {
    pulls: {
      list: Symbol('pulls.list'),
      get: async ({ pull_number }: { pull_number: number }) => ({ data: prs.find((pr) => pr.number === pull_number) }),
    },
    issues: {
      listForRepo: Symbol('issues.listForRepo'),
      listComments: Symbol('issues.listComments'),
      create: async (params: unknown) => { calls.push(['create', params]); return { data: { number: 900 } }; },
      createComment: async (params: unknown) => { calls.push(['createComment', params]); return { data: {} }; },
      update: async (params: unknown) => { calls.push(['update', params]); return { data: {} }; },
    },
    actions: {
      getWorkflowRun: async ({ run_id }: { run_id: number }) => {
        if (runs[run_id]) return { data: runs[run_id] };
        throw new Error('run not found');
      },
      reRunWorkflow: async (params: unknown) => { calls.push(['reRunWorkflow', params]); },
    },
  };
  const github = {
    rest,
    paginate: async (fn: symbol, params: { issue_number?: number }) => {
      if (fn === rest.pulls.list) return prs;
      if (fn === rest.issues.listForRepo) return issues;
      if (fn === rest.issues.listComments) return comments[params.issue_number ?? 0] ?? [];
      throw new Error(`paginate inatteso: ${String(fn)}`);
    },
  };
  const core = { info: () => {}, warning: (message: string) => { calls.push(['warning', message]); } };
  const context = { eventName, repo: { owner: 'owner', repo: 'repo' }, payload };
  const fakeProcess = { env: { CODEX_AUTH_DIGEST: currentDigest, CODEX_AUTH_PRESENT: 'true', REPOSITORY: 'owner/repo' } };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction('github', 'context', 'core', 'process', RECOVERY_SCRIPT)(github, context, core, fakeProcess);
  return calls;
}

describe('Codex auth recovery — alert dei run senza PR', () => {
  const ALERT_TITLE = /const CODEX_AUTH_ALERT_TITLE = '([^']+)';/u.exec(RECOVERY_SCRIPT)?.[1] ?? '';
  const nonPrMarker = (authDigest: string, workflow = 'post-merge-followup') =>
    `<!-- CODEX_AUTH_BLOCKED_RUN: ${JSON.stringify({ version: 1, status: 'blocked', workflow, runId: 11, runAttempt: 1, authDigest })} -->`;
  const alert = (body: string, login = 'github-actions[bot]') => ({ number: 42, title: ALERT_TITLE, body, user: { login } });
  const closed = (calls: Call[]) => calls.some(([kind, params]) => kind === 'update'
    && (params as { issue_number?: number; state?: string }).issue_number === 42
    && (params as { state?: string }).state === 'closed');

  it('l\'action apre lo STESSO alert che il monitor riusa e chiude', () => {
    expect(ALERT_TITLE).toBe('Codex auth down: CODEX_AUTH_JSON refresh token rejected');
    expect(ACTION).toContain(`alert_title='${ALERT_TITLE}'`);
    expect(ACTION).toContain('<!-- CODEX_AUTH_BLOCKED_RUN: %s -->');
    expect(RECOVERY_SCRIPT).toContain("const AUTH_BLOCKED_RUN_PREFIX = '<!-- CODEX_AUTH_BLOCKED_RUN:';");
  });

  it('chiude l\'alert non-PR quando il secret non è più nessuna credenziale rifiutata', async () => {
    const calls = await runRecovery({
      currentDigest: DIGEST_B,
      issues: [alert(nonPrMarker(DIGEST_A))],
      comments: { 42: [{ user: { login: 'github-actions[bot]' }, body: nonPrMarker(DIGEST_A, 'growth-report') }] },
    });
    expect(closed(calls)).toBe(true);
    const comment = calls.find(([kind]) => kind === 'createComment')?.[1] as { body?: string };
    expect(comment.body).toContain('post-merge-followup, growth-report');
  });

  it('lascia aperto l\'alert finché il secret resta quello rifiutato', async () => {
    const calls = await runRecovery({
      currentDigest: DIGEST_A,
      issues: [alert(nonPrMarker(DIGEST_B))],
      comments: { 42: [{ user: { login: 'github-actions[bot]' }, body: nonPrMarker(DIGEST_A, 'growth-report') }] },
    });
    expect(closed(calls)).toBe(false);
  });

  it('non chiude un alert del percorso PR, né su marker umani o su un evento workflow_run', async () => {
    expect(closed(await runRecovery({ currentDigest: DIGEST_B, issues: [alert('## Codex review authentication blocked')] }))).toBe(false);
    expect(closed(await runRecovery({ currentDigest: DIGEST_B, issues: [alert(nonPrMarker(DIGEST_A), 'someone')] }))).toBe(false);
    expect(closed(await runRecovery({
      currentDigest: DIGEST_B,
      issues: [alert(nonPrMarker(DIGEST_A))],
      eventName: 'workflow_run',
    }))).toBe(false);
  });

  it('non chiude mentre una PR è ancora bloccata in attesa del rerun esatto', async () => {
    const pr = { number: 5, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: PR_HEAD } };
    const blocked = {
      id: 1,
      user: { login: 'github-actions[bot]' },
      body: `<!-- CODEX_AUTH_BLOCKED: ${JSON.stringify({
        version: 1, status: 'blocked', prNumber: 5, headSha: PR_HEAD, runId: 77, runAttempt: 1, authDigest: DIGEST_A,
      })} -->`,
    };
    const calls = await runRecovery({
      currentDigest: DIGEST_B,
      prs: [pr],
      issues: [alert(nonPrMarker(DIGEST_A))],
      comments: { 5: [blocked] },
    });
    expect(closed(calls)).toBe(false);
    expect(calls.some(([kind]) => kind === 'create')).toBe(false);
  });
});

describe('Codex auth recovery — rotazione della credenziale', () => {
  const ALERT_TITLE = /const CODEX_AUTH_ALERT_TITLE = '([^']+)';/u.exec(RECOVERY_SCRIPT)?.[1] ?? '';
  const rotation = (status: 'failed' | 'succeeded', extra: Record<string, unknown> = {}) => formatRotationMarker({
    version: 1, status, stage: status === 'failed' ? 'write-secondary' : 'done', runId: 31, runAttempt: 1, authDigest: DIGEST_A, consumed: false, ...extra,
  });
  const nonPrMarker = (authDigest: string) =>
    `<!-- CODEX_AUTH_BLOCKED_RUN: ${JSON.stringify({ version: 1, status: 'blocked', workflow: 'growth-report', runId: 11, runAttempt: 1, authDigest })} -->`;
  const alert = (body: string) => ({ number: 42, title: ALERT_TITLE, body, user: { login: 'github-actions[bot]' } });
  const bot = (id: number, body: string) => ({ id, body, user: { login: 'github-actions[bot]' } });
  const closed = (calls: Call[]) => calls.some(([kind, params]) => kind === 'update' && (params as { state?: string }).state === 'closed');

  it('resta aperto mentre l\'ultima rotazione è fallita, anche se il digest è cambiato', async () => {
    const calls = await runRecovery({
      currentDigest: DIGEST_B,
      issues: [alert(nonPrMarker(DIGEST_A))],
      comments: { 42: [bot(1, rotation('failed'))] },
    });
    expect(closed(calls)).toBe(false);
  });

  it('chiude dopo una rotazione riuscita, con o senza marker dei consumer', async () => {
    expect(closed(await runRecovery({
      currentDigest: DIGEST_B,
      issues: [alert(rotation('failed'))],
      comments: { 42: [bot(2, rotation('succeeded', { runId: 32, authDigest: DIGEST_B }))] },
    }))).toBe(true);
    const calls = await runRecovery({
      currentDigest: DIGEST_B,
      issues: [alert(nonPrMarker(DIGEST_A))],
      comments: { 42: [bot(1, rotation('failed')), bot(2, rotation('succeeded', { runId: 32 }))] },
    });
    expect(closed(calls)).toBe(true);
    const comment = calls.find(([kind]) => kind === 'createComment')?.[1] as { body?: string };
    expect(comment.body).toContain('growth-report');
    expect(comment.body).toContain('credential rotation recovered');
  });

  it('ignora i marker di rotazione non scritti dall\'automazione', async () => {
    const calls = await runRecovery({
      currentDigest: DIGEST_B,
      issues: [alert(rotation('failed'))],
      comments: { 42: [{ id: 2, body: rotation('succeeded'), user: { login: 'someone' } }] },
    });
    expect(closed(calls)).toBe(false);
  });

  const rotateRun = (extra: Record<string, unknown> = {}) => ({
    id: 555,
    run_attempt: 1,
    path: '.github/workflows/codex-auth-rotate.yml',
    repository: { full_name: 'owner/repo' },
    event: 'schedule',
    head_branch: 'main',
    conclusion: 'failure',
    display_title: 'Codex auth rotate',
    html_url: 'https://github.com/owner/repo/actions/runs/555',
    ...extra,
  });
  const rotateEvent = (run: Record<string, unknown>) => ({
    eventName: 'workflow_run',
    payload: { workflow_run: { id: run.id, path: run.path } },
    runs: { [Number(run.id)]: run },
  });

  it('una run di rotazione fallita senza marker apre l\'alert', async () => {
    const run = rotateRun();
    const calls = await runRecovery({ currentDigest: DIGEST_B, ...rotateEvent(run) });
    const created = calls.find(([kind]) => kind === 'create')?.[1] as { title?: string; body?: string; labels?: string[] };
    expect(created?.title).toBe(ALERT_TITLE);
    expect(created?.labels).toEqual(['automation']);
    expect(created?.body).toContain('<!-- CODEX_AUTH_ROTATION: {"version":1,"status":"failed","stage":"unknown","runId":555');
  });

  it('non allerta per dry run, branch diversi da main, run riuscite o già registrate', async () => {
    for (const run of [
      rotateRun({ display_title: 'Codex auth rotate (dry run)' }),
      rotateRun({ head_branch: 'feature' }),
      rotateRun({ conclusion: 'success' }),
      rotateRun({ conclusion: 'cancelled' }),
    ]) {
      const calls = await runRecovery({ currentDigest: DIGEST_B, ...rotateEvent(run) });
      expect(calls.filter(([kind]) => kind === 'create' || kind === 'createComment'), JSON.stringify(run)).toEqual([]);
    }
    const recorded = await runRecovery({
      currentDigest: DIGEST_B,
      ...rotateEvent(rotateRun()),
      issues: [alert(rotation('failed', { runId: 555 }))],
    });
    expect(recorded.filter(([kind]) => kind === 'create' || kind === 'createComment')).toEqual([]);
  });

  it('non sovrascrive un fallimento già registrato (il marker consumed blocca il replay)', async () => {
    const calls = await runRecovery({
      currentDigest: DIGEST_A,
      ...rotateEvent(rotateRun()),
      issues: [alert(rotation('failed', { stage: 'refresh', consumed: true, runId: 400 }))],
    });
    expect(calls.filter(([kind]) => kind === 'create' || kind === 'createComment')).toEqual([]);
  });
});
