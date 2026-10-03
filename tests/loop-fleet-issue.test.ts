import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  LOOP_OK_STREAK,
  LOOP_STATE_CHANGE_MARKER,
  LOOP_STATE_END,
  LOOP_STATE_START,
  MAYBE_RESOLVED_LABEL,
  parseLoopState,
  reasonSignature,
  reportLoopIssue,
  resolveLoopIssue,
  upsertLoopStateBlock,
  // @ts-expect-error — dependency-free ESM CI module.
} from '../scripts/lib/loop-fleet-issue.mjs';
// @ts-expect-error — dependency-free ESM CI module.
import { LOOP_ISSUE_TITLES as L2_TITLES } from '../scripts/ci/loop-l2-demand-utility.mjs';

const TITLE = 'L3 Job Quality: apply handoff cannot be trusted';
const OTHER_TITLE = 'L3 Job Quality: another class of the same loop';
const NOW = new Date('2026-10-03T12:00:00.000Z');

type Issue = {
  number: number;
  title: string;
  url: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  stateReason?: string;
  labels: { name: string }[];
  comments: string[];
  bodyEdits: number;
};

/** GitHub in memoria: `gh`, `createGithubIssue` e `resolveGithubIssue` iniettati. */
function fakeGithub({ failOn = null as null | ((args: string[]) => boolean) } = {}) {
  const issues: Issue[] = [];
  let nextNumber = 100;
  const byNumber = (value: string) => {
    const issue = issues.find((candidate) => candidate.number === Number(value));
    if (!issue) throw new Error(`issue ${value} not found`);
    return issue;
  };
  const flag = (args: string[], name: string) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
  };
  const add = (title: string, body = '', labels: string[] = []) => {
    const issue: Issue = {
      number: nextNumber += 1,
      title,
      url: `https://example.test/issues/${nextNumber}`,
      body,
      state: 'OPEN',
      labels: labels.map((name) => ({ name })),
      comments: [],
      bodyEdits: 0,
    };
    issues.push(issue);
    return issue;
  };
  const gh = (args: string[]) => {
    if (failOn?.(args)) throw new Error('gh refused');
    const [, verb, target] = args;
    if (verb === 'list') {
      const phrase = String(flag(args, '--search')).match(/in:title "(.*)"$/u)?.[1] ?? '';
      return JSON.stringify(issues
        .filter((issue) => issue.state === 'OPEN' && issue.title.startsWith(phrase))
        .map(({ number, title, url, body, labels }) => ({ number, title, url, body, labels })));
    }
    if (verb === 'view') {
      const { body, labels } = byNumber(target);
      return JSON.stringify({ body, labels });
    }
    if (verb === 'comment') {
      byNumber(target).comments.push(String(flag(args, '--body')));
      return '';
    }
    if (verb === 'edit') {
      const issue = byNumber(target);
      const file = flag(args, '--body-file');
      if (file) {
        issue.body = fs.readFileSync(file, 'utf8');
        issue.bodyEdits += 1;
      }
      const removed = flag(args, '--remove-label');
      if (removed) issue.labels = issue.labels.filter((label) => label.name !== removed);
      return '';
    }
    if (verb === 'close') {
      const issue = byNumber(target);
      issue.state = 'CLOSED';
      issue.stateReason = String(flag(args, '--reason'));
      const comment = flag(args, '--comment');
      if (comment) issue.comments.push(comment);
      return '';
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const deps = {
    gh,
    env: {} as Record<string, string>,
    now: () => NOW,
    logger: { log() {}, error() {} },
    createIssue: async ({ title, description }: { title: string; description: string }) => {
      const issue = add(title, description);
      return { number: issue.number, title, url: issue.url, state: 'OPEN', persisted: true };
    },
    resolveIssue: (title: string) => {
      const issue = issues.find((candidate) => candidate.state === 'OPEN' && candidate.title === title);
      if (!issue) return null;
      issue.comments.push('✅ Auto-resolved — the failing check is green again');
      issue.state = 'CLOSED';
      issue.stateReason = 'completed';
      return { number: issue.number, title, url: issue.url, persisted: true };
    },
  };
  const open = () => issues.filter((issue) => issue.state === 'OPEN');
  const recurrences = (issue: Issue) => issue.comments.filter((comment) => comment.startsWith(LOOP_STATE_CHANGE_MARKER));
  return { issues, add, deps, open, recurrences };
}

const report = (github: ReturnType<typeof fakeGithub>, reason: string, eventName = 'schedule', extra = {}) =>
  reportLoopIssue({
    title: TITLE,
    description: `details for: ${reason}`,
    priority: 2,
    labels: ['monitoring', 'loop-l3'],
    workflow: 'Loop L3 Job Quality to Apply',
    loopId: 'L3',
    reason,
    loopTitles: [TITLE],
    eventName,
    ...extra,
  }, github.deps);

const resolve = (github: ReturnType<typeof fakeGithub>, eventName: string | null = 'schedule') =>
  resolveLoopIssue({ loopId: 'L3', loopTitles: [TITLE], workflow: 'Loop L3 Job Quality to Apply', eventName }, github.deps);

describe('reasonSignature', () => {
  it('collapses reasons that differ only by numbers', () => {
    expect(reasonSignature('eligibleLandingSessions is below minimum sample (42 < 1000)'))
      .toBe(reasonSignature('eligibleLandingSessions is below minimum sample (54 < 1000)'));
    expect(reasonSignature('snapshots 51.5h apart (max 24h)')).toBe(reasonSignature('snapshots 27h apart (max 24h)'));
  });

  it('drops dates, paths, urls and hashes but keeps the class of the reason', () => {
    expect(reasonSignature('ledger is missing: data/editorial-factuality-verdicts.jsonl at 2026-10-03T12:00:00Z'))
      .toBe(reasonSignature('ledger is missing: reports/other-file.jsonl at 2026-09-01T01:02:03Z'));
    expect(reasonSignature('commit 4bf2aaa23e4e93b7 failed, see https://example.test/runs/1'))
      .toBe(reasonSignature('commit 0c1c6105aa failed, see https://example.test/runs/22'));
    expect(reasonSignature('ledger is missing')).not.toBe(reasonSignature('ledger is stale'));
    expect(reasonSignature('')).toBe('unknown');
  });
});

describe('LOOP_STATE block', () => {
  it('is rewritten in place and keeps the rest of the body', () => {
    const first = upsertLoopStateBlock('original description', { loopId: 'L3', signature: 'a', okStreak: 0, reason: 'a' });
    const second = upsertLoopStateBlock(first, { loopId: 'L3', signature: 'b', okStreak: 1, reason: 'b' });
    expect(second.split(LOOP_STATE_START)).toHaveLength(first.split(LOOP_STATE_START).length);
    expect(second.split(LOOP_STATE_END)).toHaveLength(first.split(LOOP_STATE_END).length);
    expect(second).toContain('original description');
    expect(parseLoopState(second)).toMatchObject({ signature: 'b', okStreak: 1, loopId: 'L3' });
    expect(parseLoopState('no block here')).toBeNull();
  });

  it('survives a reason that tries to close the HTML comment', () => {
    const body = upsertLoopStateBlock('', { loopId: 'L3', signature: 'x', okStreak: 0, reason: 'broken --> <!-- LOOP_STATE:end -->' });
    expect(parseLoopState(body)).toMatchObject({ signature: 'x', okStreak: 0 });
  });
});

describe('reportLoopIssue', () => {
  it('creates the issue with the state block when none is open', async () => {
    const github = fakeGithub();
    const result = await report(github, 'invalid jobs 799');
    expect(result).toMatchObject({ persisted: true, title: TITLE });
    expect(github.open()).toHaveLength(1);
    const [issue] = github.open();
    expect(parseLoopState(issue.body)).toMatchObject({ signature: reasonSignature('invalid jobs 799'), okStreak: 0 });
    expect(issue.body).toContain('details for: invalid jobs 799');
    expect(issue.bodyEdits).toBe(0);
  });

  it('does not comment when the same signature recurs, and edits the body once', async () => {
    const github = fakeGithub();
    await report(github, 'invalid jobs 799');
    const [issue] = github.open();
    const result = await report(github, 'invalid jobs 812');
    expect(result).toMatchObject({ persisted: true, signatureChanged: false, number: issue.number });
    expect(github.recurrences(issue)).toHaveLength(0);
    expect(issue.bodyEdits).toBe(1);
    expect(issue.body).toContain('invalid jobs 812');
    expect(github.open()).toHaveLength(1);
  });

  it('comments once and edits the body when the signature changes', async () => {
    const github = fakeGithub();
    await report(github, 'invalid jobs 799');
    const [issue] = github.open();
    const result = await report(github, 'summary counts disagree with lists');
    expect(result).toMatchObject({ persisted: true, signatureChanged: true });
    expect(github.recurrences(issue)).toHaveLength(1);
    expect(issue.bodyEdits).toBe(1);
    expect(parseLoopState(issue.body)?.signature).toBe(reasonSignature('summary counts disagree with lists'));
  });

  it('keeps push detection: a push run comments on a new signature and stays silent on the same one', async () => {
    const github = fakeGithub();
    await report(github, 'invalid jobs 799', 'schedule');
    const [issue] = github.open();
    await report(github, 'invalid jobs 801', 'push');
    expect(github.recurrences(issue)).toHaveLength(0);
    await report(github, 'sourceRefs must exactly match the registry', 'push');
    expect(github.recurrences(issue)).toHaveLength(1);
    expect(parseLoopState(issue.body)).toMatchObject({ event: 'push', okStreak: 0 });
  });

  it('adopts a legacy issue without a state block with a single comment', async () => {
    const github = fakeGithub();
    const issue = github.add(TITLE, 'body written the day the issue was opened');
    await report(github, 'invalid jobs 799');
    await report(github, 'invalid jobs 800');
    expect(github.recurrences(issue)).toHaveLength(1);
    expect(issue.body).toContain('body written the day the issue was opened');
    expect(issue.body.indexOf(LOOP_STATE_START)).toBe(0);
  });

  it('removes maybe-resolved when a non-ok verdict contradicts it, and no other label', async () => {
    const github = fakeGithub();
    const issue = github.add(TITLE, '', [MAYBE_RESOLVED_LABEL, 'monitoring']);
    await report(github, 'export is blind');
    expect(issue.labels.map((label) => label.name)).toEqual(['monitoring']);
  });

  it('closes the issue of a previous title as not planned and keeps one open per loop', async () => {
    const github = fakeGithub();
    const previous = github.add(OTHER_TITLE, 'older class');
    const result = await report(github, 'invalid jobs 799', 'schedule', { loopTitles: [TITLE, OTHER_TITLE] });
    expect(result.persisted).toBe(true);
    expect(previous).toMatchObject({ state: 'CLOSED', stateReason: 'not planned' });
    expect(previous.comments.join('\n')).toContain(`#${result.number}`);
    expect(github.open().map((issue) => issue.title)).toEqual([TITLE]);
  });

  it('returns persisted=false and does not advance the signature when the body write fails', async () => {
    const github = fakeGithub();
    await report(github, 'invalid jobs 799');
    const [issue] = github.open();
    const before = issue.body;
    const failing = fakeGithub({ failOn: (args) => args[1] === 'edit' });
    failing.issues.push(issue);
    const result = await report(failing, 'summary counts disagree with lists');
    expect(result.persisted).toBe(false);
    expect(issue.body).toBe(before);
    expect(parseLoopState(issue.body)?.signature).toBe(reasonSignature('invalid jobs 799'));
    // La run successiva vede ancora il cambio: non lo si perde in silenzio.
    const retry = await report(github, 'summary counts disagree with lists');
    expect(retry).toMatchObject({ persisted: true, signatureChanged: true });
  });

  it('returns persisted=false without writing the body when the change comment fails', async () => {
    const github = fakeGithub({ failOn: (args) => args[1] === 'comment' });
    const issue = github.add(TITLE, upsertLoopStateBlock('', { loopId: 'L3', signature: 'old', okStreak: 0, reason: 'old' }));
    const result = await report(github, 'a brand new reason');
    expect(result.persisted).toBe(false);
    expect(issue.bodyEdits).toBe(0);
  });

  it('refuses to create a duplicate when the open-issue lookup is unreliable', async () => {
    const github = fakeGithub({ failOn: (args) => args[1] === 'list' });
    const result = await report(github, 'invalid jobs 799');
    expect(result).toMatchObject({ persisted: false, lookupFailed: true });
    expect(github.issues).toHaveLength(0);
  });

  it('resets a stale okStreak on an issue the creator reopened behind the lookup', async () => {
    const github = fakeGithub();
    const stale = upsertLoopStateBlock('', { loopId: 'L3', signature: reasonSignature('invalid jobs 1'), okStreak: LOOP_OK_STREAK - 1, reason: 'ok' });
    const reopened = github.add('placeholder', stale);
    reopened.state = 'CLOSED';
    github.deps.createIssue = async ({ title }: { title: string }) => {
      reopened.state = 'OPEN';
      reopened.title = title;
      return { number: reopened.number, title, url: reopened.url, state: 'OPEN', persisted: true };
    };
    const result = await report(github, 'invalid jobs 799');
    expect(result.persisted).toBe(true);
    expect(parseLoopState(reopened.body)?.okStreak).toBe(0);
  });

  it('honours ENABLE_FAILURE_REPORT=false like the creator', async () => {
    const github = fakeGithub();
    github.deps.env = { ENABLE_FAILURE_REPORT: 'false' };
    expect(await report(github, 'invalid jobs 799')).toBeNull();
    expect(await resolve(github)).toBeNull();
    expect(github.issues).toHaveLength(0);
  });
});

describe('resolveLoopIssue', () => {
  it('does not close below the streak and never comments', async () => {
    const github = fakeGithub();
    await report(github, 'invalid jobs 799');
    const [issue] = github.open();
    for (let run = 1; run < LOOP_OK_STREAK; run += 1) {
      await resolve(github);
      expect(parseLoopState(issue.body)?.okStreak).toBe(run);
    }
    expect(issue.state).toBe('OPEN');
    expect(issue.comments).toHaveLength(0);
  });

  it('closes after LOOP_OK_STREAK consecutive scheduled ok verdicts', async () => {
    const github = fakeGithub();
    await report(github, 'invalid jobs 799');
    const [issue] = github.open();
    let last;
    for (let run = 0; run < LOOP_OK_STREAK; run += 1) last = await resolve(github);
    expect(issue).toMatchObject({ state: 'CLOSED', stateReason: 'completed' });
    expect(issue.comments.join('\n')).toContain('Auto-resolved');
    expect(last).toMatchObject({ persisted: true, closed: [issue.number] });
  });

  it('resets the streak on a non-ok verdict in between', async () => {
    const github = fakeGithub();
    await report(github, 'invalid jobs 799');
    const [issue] = github.open();
    for (let run = 1; run < LOOP_OK_STREAK; run += 1) await resolve(github);
    await report(github, 'invalid jobs 640');
    expect(parseLoopState(issue.body)?.okStreak).toBe(0);
    await resolve(github);
    expect(issue.state).toBe('OPEN');
    expect(parseLoopState(issue.body)?.okStreak).toBe(1);
    expect(github.recurrences(issue)).toHaveLength(0);
  });

  it('does not advance the streak for push, workflow_dispatch or a missing event', async () => {
    const github = fakeGithub();
    await report(github, 'invalid jobs 799');
    const [issue] = github.open();
    for (const eventName of ['push', 'workflow_dispatch', null]) {
      for (let run = 0; run < LOOP_OK_STREAK; run += 1) {
        expect(await resolve(github, eventName)).toMatchObject({ skipped: 'event-is-not-schedule' });
      }
    }
    expect(issue.state).toBe('OPEN');
    expect(issue.bodyEdits).toBe(0);
    expect(parseLoopState(issue.body)?.okStreak).toBe(0);
  });

  it('lets a non-ok push verdict reset a streak built by scheduled runs', async () => {
    const github = fakeGithub();
    await report(github, 'invalid jobs 799');
    const [issue] = github.open();
    for (let run = 1; run < LOOP_OK_STREAK; run += 1) await resolve(github);
    expect(parseLoopState(issue.body)?.okStreak).toBe(LOOP_OK_STREAK - 1);
    await report(github, 'invalid jobs 799', 'push');
    expect(parseLoopState(issue.body)?.okStreak).toBe(0);
    await resolve(github);
    expect(issue.state).toBe('OPEN');
  });

  it('reads the event from GITHUB_EVENT_NAME when the caller does not pass one', async () => {
    const github = fakeGithub();
    await report(github, 'invalid jobs 799');
    const [issue] = github.open();
    github.deps.env = { GITHUB_EVENT_NAME: 'schedule' };
    await resolveLoopIssue({ loopId: 'L3', loopTitles: [TITLE] }, github.deps);
    expect(parseLoopState(issue.body)?.okStreak).toBe(1);
  });

  it('never throws: a refused close is reported as persisted=false and retried next run', async () => {
    const github = fakeGithub();
    await report(github, 'invalid jobs 799');
    const [issue] = github.open();
    for (let run = 1; run < LOOP_OK_STREAK; run += 1) await resolve(github);
    const working = github.deps.resolveIssue;
    github.deps.resolveIssue = () => { throw new Error('close rejected'); };
    expect(await resolve(github)).toMatchObject({ persisted: false, closed: [] });
    expect(issue.state).toBe('OPEN');
    github.deps.resolveIssue = working;
    expect(await resolve(github)).toMatchObject({ persisted: true, closed: [issue.number] });
  });

  it('is a no-op when no issue of the loop is open', async () => {
    const github = fakeGithub();
    expect(await resolve(github)).toMatchObject({ persisted: true, closed: [], advanced: [] });
  });

  it('refuses to run the real gh binary under Vitest when gh is not injected', async () => {
    const errors: string[] = [];
    const outcome = await resolveLoopIssue(
      { loopTitles: [TITLE], eventName: 'schedule' },
      { env: { VITEST: 'true' }, logger: { log() {}, error: (line: string) => errors.push(line) } },
    );
    expect(outcome).toMatchObject({ persisted: false, closed: [], advanced: [] });
    expect(errors.join('\n')).toContain('gh non iniettato sotto Vitest');
  });
});

describe('loop scripts go through loop-fleet-issue', () => {
  const scriptDir = path.resolve('scripts/ci');
  const loopScripts = fs.readdirSync(scriptDir).filter((name) => /^loop-l\d+-[\w-]+\.mjs$/u.test(name)).sort();
  // Script lasciati sul vecchio default perché un loro test esistente non
  // reggeva il nuovo: vuota per costruzione, ogni voce è un debito dichiarato.
  const LEGACY_DIRECT_CREATOR: string[] = [];

  it('Loop fleet: uno script di loop apre issue senza passare da loop-fleet-issue', () => {
    expect(loopScripts.length).toBeGreaterThan(0);
    for (const name of loopScripts) {
      if (LEGACY_DIRECT_CREATOR.includes(name)) continue;
      const source = fs.readFileSync(path.join(scriptDir, name), 'utf8');
      expect(source, name).not.toMatch(/\bcreateGithubIssue\s*\(/u);
      expect(source, name).not.toMatch(/createIssueImpl\s*=\s*createGithubIssue/u);
      expect(source, name).not.toMatch(/github-issue-creator\.mjs/u);
      expect(source, name).toMatch(/createIssueImpl\s*=\s*reportLoopIssue\b/u);
      expect(source, name).toMatch(/resolveIssueImpl\s*=\s*resolveLoopIssue\b/u);
      expect(source, name).toMatch(/else if \(issue\) \{\n\s+await resolveIssueImpl\(/u);
      expect(source, name).toMatch(/reason: verdict\.reason,\n\s+loopTitles: /u);
    }
  });

  it('declares every L2 title so a change of class leaves one open issue', () => {
    const source = fs.readFileSync(path.join(scriptDir, 'loop-l2-demand-utility.mjs'), 'utf8');
    const switchBody = source.match(/export function issueTitleForVerdict[\s\S]*?\n\}/u)?.[0] ?? '';
    const returned = [...switchBody.matchAll(/return ([A-Z_]+);/gu)].map((match) => match[1]);
    expect(returned.length).toBeGreaterThan(0);
    expect(switchBody).not.toMatch(/return '/u);
    const declared = source.match(/export const LOOP_ISSUE_TITLES = \[([\s\S]*?)\];/u)?.[1] ?? '';
    for (const name of returned) expect(declared, name).toContain(name);
    expect(new Set(L2_TITLES).size).toBe(L2_TITLES.length);
  });

  it('ships the library to every loop workflow that checks out a file list', () => {
    // I workflow dei loop fanno sparse checkout di un elenco di file: una
    // libreria importata ma non elencata è ERR_MODULE_NOT_FOUND su ogni run.
    const workflowDir = path.resolve('.github/workflows');
    const library = 'scripts/lib/loop-fleet-issue.mjs';
    const workflows = fs.readdirSync(workflowDir).filter((name) => /^loop-l\d+-[\w-]+\.yml$/u.test(name));
    expect(workflows.length).toBeGreaterThan(0);
    for (const name of workflows) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      const sparse = source.match(/sparse-checkout: \|\n([\s\S]*?)\n\s+sparse-checkout-cone-mode:/u)?.[1] ?? '';
      const lines = sparse.split('\n').map((line) => line.trim());
      if (!lines.includes('/*')) expect(lines, `${name} sparse checkout`).toContain(`/${library}`);
      if (source.includes("- 'scripts/lib/github-issue-creator.mjs'")) {
        const pushPaths = source.match(/\n  push:\n([\s\S]*?)\n  pull_request:/u)?.[1] ?? '';
        const pullRequestPaths = source.match(/\n  pull_request:\n([\s\S]*?)\n  workflow_dispatch:/u)?.[1] ?? '';
        expect(pushPaths, `${name} push paths`).toContain(`- '${library}'`);
        expect(pullRequestPaths, `${name} pull_request paths`).toContain(`- '${library}'`);
      }
    }
  });
});
