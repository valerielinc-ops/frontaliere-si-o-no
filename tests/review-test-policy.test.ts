import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import {
  isReviewTestPath,
  isTestOnlySnapshot,
  postTestOnlyReview,
  findTestOnlyApproval,
  TEST_REVIEW_MARKER,
  LOOP_FLEET_LEDGER_FILES,
  LOOP_FLEET_LEDGER_REVIEW_MARKER,
  isLoopFleetLedgerPath,
  isLoopFleetLedgerSnapshot,
  validateLoopFleetLedgerJsonl,
  isReviewBodyComplete,
  inspectLedgerOnlyHead,
  postLedgerOnlyReview,
  findLedgerOnlyApproval,
} from '../scripts/ci/review-test-policy.mjs';
import { codeContributionFingerprint } from '../scripts/ci/auto-merge-eval.mjs';
const head = 'a'.repeat(40);
function fixture({ files = ['tests/a.test.ts'], complete = true, changedHead = false, previous = '', reviews = [] as any[] } = {}) {
  const posts: any[] = [];
  let reads = 0;
  const ghFn = (args: string[], options: any = {}) => {
    if (args.includes('POST')) { posts.push(JSON.parse(options.input)); return {}; }
    if (args[0] === 'pr') return { changedFiles: complete ? files.length : files.length + 1, files };
    if (args[1].endsWith('/files')) return args.includes('--slurp') ? [files.map(filename => ({ filename, previous_filename: previous }))] : files.join('\n');
    if (args[1].endsWith('/reviews')) return reviews;
    return { state: 'open', head: { sha: ++reads > 1 && changedHead ? 'b'.repeat(40) : head } };
  };
  return { ghFn, posts };
}

const ledgerBody = `## Implementato
- Appended the validated ledger batch.

## Non implementato (ancora)
- Nothing else in questa PR — per scelta.
`;
const ledgerHead = 'c'.repeat(40);
const ledgerBase = 'd'.repeat(40);

function ledgerFixture({
  files = [...LOOP_FLEET_LEDGER_FILES],
  complete = true,
  changedHead = false,
  changedBody = false,
  previous = '',
  statuses = {} as Record<string, string>,
  additions = {} as Record<string, number>,
  deletions = {} as Record<string, number>,
  contents = {} as Record<string, string>,
  reviews = [] as any[],
  body = ledgerBody,
  labels = [] as any[],
  state = 'open',
  draft = false,
  baseRef = 'main',
  authorType = 'Bot',
  authorLogin = 'frontaliere-automation[bot]',
  headRef = 'chore/loop-fleet-ledger',
  headRepoFullName = 'owner/repo',
  title = 'chore(loop-fleet): persist durable evidence batches',
} = {}) {
  const posts: any[] = [];
  let reads = 0;
  const entries = files.map((filename) => ({
    filename,
    status: statuses[filename] ?? 'modified',
    additions: additions[filename] ?? 1,
    deletions: deletions[filename] ?? 0,
    ...(previous ? { previous_filename: previous } : {}),
  }));
  const ghFn = (args: string[], options: any = {}) => {
    if (args.includes('POST')) { posts.push(JSON.parse(options.input)); return {}; }
    if (args[0] === 'pr') return { changedFiles: complete ? files.length : files.length + 1, files };
    const endpoint = String(args[1] ?? '');
    if (endpoint.endsWith('/files')) {
      return args.includes('--slurp') ? [entries] : entries.map((entry) => entry.filename).join('\n');
    }
    if (endpoint.endsWith('/reviews')) return reviews;
    if (endpoint.includes('/contents/')) {
      const filename = endpoint.split('/contents/')[1].split('?')[0];
      if (contents[filename] !== undefined) return contents[filename];
      const recordType = filename.endsWith('loop-observations.jsonl') ? 'observation'
        : filename.endsWith('loop-decisions.jsonl') ? 'decision'
        : filename.endsWith('loop-health-history.jsonl') ? 'health'
        : 'lifecycle-event';
      return `${JSON.stringify({
        recordType,
        schemaVersion: 1,
        loopId: 'L6',
        recordId: `lf-test-${recordType}`,
        recordedAt: '2026-09-17T00:00:00.000Z',
        occurredAt: '2026-09-17T00:00:00.000Z',
        execution: {
          loopId: 'L6',
          runId: '123',
          sha: ledgerHead,
          recordedAt: '2026-09-17T00:00:00.000Z',
        },
      })}\n`;
    }
    reads += 1;
    return {
      state,
      draft,
      title,
      body: changedBody && reads > 1 ? `${body}\nbody edit race` : body,
      head: {
        sha: changedHead && reads > 1 ? 'e'.repeat(40) : ledgerHead,
        ref: headRef,
        repo: { full_name: headRepoFullName },
      },
      base: { ref: baseRef, sha: ledgerBase },
      user: { type: authorType, login: authorLogin },
      labels,
    };
  };
  return { ghFn, posts };
}
describe('owner policy excluding test files from review', () => {
  it('recognizes test directories and colocated tests without excluding application or runner config', () => {
    for (const p of ['tests/setup.ts', 'generator/tests/a.test.mjs', 'src/__tests__/a.ts', 'src/a.spec.tsx', 'src/a.test.mts', 'src/a.test.d.ts', 'src/a.spec.d.mts']) expect(isReviewTestPath(p), p).toBe(true);
    for (const p of ['src/tests-api.ts', 'vitest.config.ts', '.github/workflows/tests.yml', 'scripts/test-runner.mjs', 'src/a.ts']) expect(isReviewTestPath(p), p).toBe(false);
  });
  it('requires a nonempty complete exclusively-test snapshot', () => {
    expect(isTestOnlySnapshot({ complete: true, files: ['tests/a.ts'] })).toBe(true);
    for (const value of [{ complete: false, files: ['tests/a.ts'] }, { complete: true, files: [] }, { complete: true, files: ['tests/a.ts', 'src/a.ts'] }]) expect(isTestOnlySnapshot(value)).toBe(false);
  });
  it('posts one structured LGTM on the pinned tests-only head', () => {
    const f = fixture();
    postTestOnlyReview({ repo: 'owner/repo', pr: 1, head, ghFn: f.ghFn });
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]).toMatchObject({ commit_id: head, event: 'COMMENT' });
    expect(f.posts[0].body).toContain(TEST_REVIEW_MARKER);
    expect(f.posts[0].body).toContain('## LGTM');
  });
  it.each([{ complete: false }, { changedHead: true }, { previous: 'src/production.ts' }, { files: ['tests/a.ts', 'src/a.ts'] }])('does not approve incomplete, changed-head or mixed input: %j', options => {
    const f = fixture(options);
    expect(() => postTestOnlyReview({ repo: 'owner/repo', pr: 1, head, ghFn: f.ghFn })).toThrow();
    expect(f.posts).toEqual([]);
  });
  it('accepts the marked bot review only after independently verifying the current complete file list', () => {
    const review = { commit_id: head, user: { type: 'Bot', login: 'github-actions[bot]' }, body: `${TEST_REVIEW_MARKER}\n## LGTM` };
    expect(findTestOnlyApproval([review], head, { ...fixture(), repo: 'owner/repo', pr: 1 })).toBe(review);
    expect(findTestOnlyApproval([review], head, { ...fixture({ files: ['src/a.ts'] }), repo: 'owner/repo', pr: 1 })).toBeNull();
    expect(findTestOnlyApproval([{ ...review, user: { type: 'User', login: 'someone' } }], head, { ...fixture(), repo: 'owner/repo', pr: 1 })).toBeNull();
    expect(findTestOnlyApproval([{ ...review, commit_id: 'b'.repeat(40) }], head, { ...fixture(), repo: 'owner/repo', pr: 1 })).toBeNull();
  });
  it('does not repost on the same head and keeps test-only changes out of the code fingerprint', () => {
    const review = { commit_id: head, user: { type: 'Bot', login: 'github-actions[bot]' }, body: `${TEST_REVIEW_MARKER}\n## LGTM` };
    const f = fixture({ reviews: [review] });
    postTestOnlyReview({ repo: 'owner/repo', pr: 1, head, ghFn: f.ghFn });
    expect(f.posts).toEqual([]);
    expect(codeContributionFingerprint([{ filename: 'tests/huge.test.ts' }])).toBe(codeContributionFingerprint([]));
    expect(codeContributionFingerprint([{ filename: 'tests/a.test.ts', previous_filename: 'src/a.ts', patch: '-production', status: 'renamed' }])).not.toBe(codeContributionFingerprint([]));
  });
  it('allows only the four canonical ledger JSONL paths and rejects unknown or duplicate paths', () => {
    for (const path of LOOP_FLEET_LEDGER_FILES) expect(isLoopFleetLedgerPath(path), path).toBe(true);
    for (const path of [
      'data/loop-fleet/ledger/unknown.jsonl',
      'data/loop-fleet/ledger/loop-observations.jsonl.bak',
      'data/loop-fleet/ledger/loop-observations.jsonl/child',
      'data/loop-fleet/ledger/../loop-observations.jsonl',
      'src/production.ts',
    ]) expect(isLoopFleetLedgerPath(path), path).toBe(false);
    expect(isLoopFleetLedgerSnapshot({ complete: true, files: LOOP_FLEET_LEDGER_FILES.slice(0, 2) })).toBe(true);
    for (const value of [
      { complete: false, files: LOOP_FLEET_LEDGER_FILES.slice(0, 2) },
      { complete: true, files: [] },
      { complete: true, files: [...LOOP_FLEET_LEDGER_FILES, 'data/loop-fleet/ledger/unknown.jsonl'] },
      { complete: true, files: [LOOP_FLEET_LEDGER_FILES[0], LOOP_FLEET_LEDGER_FILES[0]] },
      { complete: true, files: [LOOP_FLEET_LEDGER_FILES[0], 'src/production.ts'] },
    ]) expect(isLoopFleetLedgerSnapshot(value)).toBe(false);
  });
  it('requires the complete canonical body before the bounded lane can approve', () => {
    expect(isReviewBodyComplete(ledgerBody)).toBe(true);
    for (const body of [
      '## Summary\n- done\n\n## Non implementato (ancora)\nNessuno',
      '## Implementato\n- done\n\n## Non implementato\nNessuno',
      '## Implementato\n- \n\n## Non implementato (ancora)\n- ',
      '## Implementato\n- done\n\n## Non implementato (ancora)\nNessuno\nCloses #1 #2',
    ]) expect(isReviewBodyComplete(body)).toBe(false);
  });
  it('validates bounded JSONL structure at the candidate HEAD and fails closed', () => {
    const valid = JSON.stringify({
      recordType: 'observation',
      schemaVersion: 1,
      loopId: 'L6',
      recordId: 'lf-test-observation',
      recordedAt: '2026-09-17T00:00:00.000Z',
      execution: { loopId: 'L6', runId: '123', sha: ledgerHead },
    });
    expect(validateLoopFleetLedgerJsonl(`${valid}\n`, LOOP_FLEET_LEDGER_FILES[0])).toMatchObject({ ok: true, count: 1 });
    for (const [content, path] of [
      ['{broken', LOOP_FLEET_LEDGER_FILES[0]],
      [JSON.stringify({ ...JSON.parse(valid), recordType: 'decision' }), LOOP_FLEET_LEDGER_FILES[0]],
      [JSON.stringify({ ...JSON.parse(valid), execution: { loopId: 'L6', runId: '123', sha: 'bad' } }), LOOP_FLEET_LEDGER_FILES[0]],
      ['', LOOP_FLEET_LEDGER_FILES[0]],
      [valid, 'data/loop-fleet/ledger/unknown.jsonl'],
    ] as const) expect(validateLoopFleetLedgerJsonl(content, path).ok).toBe(false);
  });
  it.each([
    { files: [...LOOP_FLEET_LEDGER_FILES.slice(0, 1), 'src/production.ts'], label: 'mixed' },
    { files: ['data/loop-fleet/ledger/unknown.jsonl'], label: 'unknown' },
    { files: LOOP_FLEET_LEDGER_FILES.slice(0, 1), statuses: { [LOOP_FLEET_LEDGER_FILES[0]]: 'renamed' }, previous: 'src/production.ts', label: 'rename' },
    { files: LOOP_FLEET_LEDGER_FILES.slice(0, 1), statuses: { [LOOP_FLEET_LEDGER_FILES[0]]: 'deleted' }, label: 'deleted' },
    { files: LOOP_FLEET_LEDGER_FILES.slice(0, 1), deletions: { [LOOP_FLEET_LEDGER_FILES[0]]: 1 }, label: 'non-append-only' },
    { files: LOOP_FLEET_LEDGER_FILES.slice(0, 1), contents: { [LOOP_FLEET_LEDGER_FILES[0]]: '{not-json\n' }, label: 'invalid-jsonl' },
    { files: LOOP_FLEET_LEDGER_FILES.slice(0, 1), complete: false, label: 'incomplete' },
  ])('fails closed without publishing for $label ledger input', ({ label: _label, ...options }) => {
    const f = ledgerFixture(options);
    expect(() => postLedgerOnlyReview({ repo: 'owner/repo', pr: 1, head: ledgerHead, ghFn: f.ghFn })).toThrow();
    expect(f.posts).toEqual([]);
  });
  it('routes a mixed PR with an invalid body to the ordinary owner, never to a competing fast check', () => {
    const f = ledgerFixture({
      files: [...LOOP_FLEET_LEDGER_FILES.slice(0, 1), 'src/production.ts'],
      body: '## missing contract',
    });
    expect(inspectLedgerOnlyHead(f.ghFn, 'owner/repo', 1, ledgerHead)).toMatchObject({
      ok: false,
      kind: 'not-ledger-only',
    });
  });
  it('verifies exact HEAD, stable body/file-list metadata and publishes one structured App review', () => {
    const f = ledgerFixture();
    const inspected = inspectLedgerOnlyHead(f.ghFn, 'owner/repo', 1, ledgerHead);
    expect(inspected).toMatchObject({ ok: true, kind: 'eligible' });
    postLedgerOnlyReview({ repo: 'owner/repo', pr: 1, head: ledgerHead, ghFn: f.ghFn });
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]).toMatchObject({ commit_id: ledgerHead, event: 'COMMENT' });
    expect(f.posts[0].body).toContain(LOOP_FLEET_LEDGER_REVIEW_MARKER);
    expect(f.posts[0].body).toContain('## Scope');
    expect(f.posts[0].body).toContain('## Findings (Important: 0, Nit: 0)');
    expect(f.posts[0].body).toContain('## LGTM');
  });
  it.each([
    { authorType: 'User', label: 'author type' },
    { authorLogin: 'other[bot]', label: 'author login' },
    { headRef: 'other-branch', label: 'head branch' },
    { headRepoFullName: 'other/repo', label: 'head fork' },
    { baseRef: 'develop', label: 'base branch' },
  ])('classifies an untrusted ledger-only PR as not-ledger-only and never posts ($label)', ({ label: _label, ...options }) => {
    const f = ledgerFixture(options);
    expect(inspectLedgerOnlyHead(f.ghFn, 'owner/repo', 1, ledgerHead)).toMatchObject({
      ok: false,
      kind: 'not-ledger-only',
    });
    expect(() => postLedgerOnlyReview({ repo: 'owner/repo', pr: 1, head: ledgerHead, ghFn: f.ghFn })).toThrow();
    expect(f.posts).toEqual([]);
  });
  it.each([
    { changedHead: true, label: 'HEAD' },
    { changedBody: true, label: 'body' },
    { body: '## Implementato\n- done\n\n## Non implementato\nNessuno', label: 'body contract' },
    { labels: ['needs-human'], label: 'needs-human veto' },
  ])('does not publish when $label changes or is not verifiable', ({ label: _label, ...options }) => {
    const f = ledgerFixture(options);
    expect(() => postLedgerOnlyReview({ repo: 'owner/repo', pr: 1, head: ledgerHead, ghFn: f.ghFn })).toThrow();
    expect(f.posts).toEqual([]);
  });
  it('recognizes only the exact App review marker on the current verified head and never reposts it', () => {
    const review = {
      commit_id: ledgerHead,
      user: { type: 'Bot', login: 'frontaliere-automation[bot]' },
      state: 'COMMENTED',
      body: `${LOOP_FLEET_LEDGER_REVIEW_MARKER}\n## Findings (Important: 0, Nit: 0)\n\n## LGTM`,
    };
    const f = ledgerFixture({ reviews: [review] });
    expect(findLedgerOnlyApproval([review], ledgerHead, { ghFn: f.ghFn, repo: 'owner/repo', pr: 1 })).toBe(review);
    expect(findLedgerOnlyApproval([{ ...review, user: { type: 'User', login: 'frontaliere-automation[bot]' } }], ledgerHead, { ghFn: f.ghFn, repo: 'owner/repo', pr: 1 })).toBeNull();
    postLedgerOnlyReview({ repo: 'owner/repo', pr: 1, head: ledgerHead, ghFn: f.ghFn });
    expect(f.posts).toEqual([]);
    expect(findLedgerOnlyApproval([{ ...review, commit_id: 'e'.repeat(40) }], ledgerHead, { ghFn: f.ghFn, repo: 'owner/repo', pr: 1 })).toBeNull();
    expect(findLedgerOnlyApproval([{ ...review, user: { type: 'Bot', login: 'frontaliere-automation-evil[bot]' } }], ledgerHead, { ghFn: f.ghFn, repo: 'owner/repo', pr: 1 })).toBeNull();
  });
  it('retains the real test job and skips every model step for tests-only PRs', () => {
    const workflow = YAML.parse(readFileSync('.github/workflows/tests.yml', 'utf8'));
    const steps = workflow.jobs.vitest.steps;
    expect(steps.find((s: any) => s.id === 'test_only_review').if).toContain('success()');
    for (const id of ['prefetch', 'quota', 'codex_review']) expect(steps.find((s: any) => s.id === id).if).toContain("tier != 'tests-only'");
    for (const step of steps.filter((s: any) => String(s.name).startsWith('vitest '))) expect(step.if ?? '').not.toContain('tests-only');
  });
  it('mantiene un solo tests.yml/check e porta il ledger-only nello stesso job', () => {
    const workflow = YAML.parse(readFileSync('.github/workflows/tests.yml', 'utf8')) as any;
    const pullRequest = workflow.on?.pull_request ?? workflow.true?.pull_request;
    const source = readFileSync('.github/workflows/tests.yml', 'utf8');
    expect(workflow.name).toBe('tests');
    expect(workflow.jobs.vitest.name).toBe('vitest (unit + integration)');
    expect(pullRequest.paths).toBeUndefined();
    expect(pullRequest['paths-ignore']).toBeUndefined();
    expect(pullRequest.types).toContain('edited');
    expect(source).toContain('id: ledger_scope');
    expect(source).toContain('ledger-check');
    expect(source).toContain('ledger-post');
    expect(source).toContain("set_tier ledger-only bounded 0");
    expect(source).toContain("steps.tier.outputs.tier != 'ledger-only'");
    expect(source).toContain("github.head_ref != 'chore/loop-fleet-ledger'");
    expect(source).not.toContain('ledger-fast-review.yml');
  });
});
