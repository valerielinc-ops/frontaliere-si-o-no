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
  LOOP_FLEET_LEDGER_BRANCH_RE,
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
const ledgerRegistry = JSON.parse(readFileSync('data/loop-fleet/loop-registry.json', 'utf8'));
const ledgerPolicy = ledgerRegistry.loops.find((loop: any) => loop.loopId === 'L6');

function ledgerRecordType(filename: string) {
  return filename.endsWith('loop-observations.jsonl') ? 'observation'
    : filename.endsWith('loop-decisions.jsonl') ? 'decision'
      : filename.endsWith('loop-health-history.jsonl') ? 'health'
        : 'lifecycle-event';
}

function ledgerRecord(filename: string, suffix: string, sha: string) {
  const recordType = ledgerRecordType(filename);
  const record = {
    recordType,
    schemaVersion: 1,
    loopId: 'L6',
    recordId: `lf-test-${recordType}-${suffix}`,
    recordedAt: '2026-09-17T00:00:00.000Z',
    occurredAt: '2026-09-17T00:00:00.000Z',
    execution: {
      loopId: 'L6',
      runId: '123',
      sha,
      recordedAt: '2026-09-17T00:00:00.000Z',
    },
  };
  if (recordType === 'lifecycle-event') {
    return {
      ...record,
      eventType: 'candidate',
      candidateId: `lf-test-candidate-${suffix}`,
      owner: ledgerPolicy.owner,
      sourceRecordId: `lf-test-source-${suffix}`,
      sourceRefs: ledgerPolicy.sourceRefs,
      lifecycle: ledgerPolicy.lifecycle,
      artifactOrPr: null,
    };
  }
  const contractRecord = {
    ...record,
    actionClass: recordType === 'decision' ? 'candidate' : 'observe',
    outcome: {
      recordType: 'outcome',
      schemaVersion: 1,
      outcomeId: ledgerPolicy.outcome.outcomeId,
      status: 'partial',
      independent: false,
      sourceRefs: ledgerPolicy.outcome.sourceRefs,
      primaryMetric: ledgerPolicy.primaryMetric,
      numerator: null,
      denominator: null,
      requiredFieldsPresent: [],
      missingFields: ledgerPolicy.outcome.requiredFields,
      reason: 'fixture evidence is intentionally partial',
      observedAt: null,
      allowNumeratorExceedDenominator: false,
      recordedAt: '2026-09-17T00:00:00.000Z',
    },
  };
  if (recordType === 'decision') {
    return {
      ...contractRecord,
      decision: 'candidate',
      startedAt: '2026-09-17T00:00:00.000Z',
      expiresAt: '2026-09-18T00:00:00.000Z',
      decidedAt: '2026-09-17T00:00:00.000Z',
    };
  }
  return contractRecord;
}

function defaultLedgerContent(filename: string, base: boolean) {
  const prefix = JSON.stringify(ledgerRecord(filename, 'base', ledgerBase));
  return base
    ? `${prefix}\n`
    : `${prefix}\n${JSON.stringify(ledgerRecord(filename, 'head', ledgerHead))}\n`;
}

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
  baseContents = {} as Record<string, string>,
  baseMissing = [] as string[],
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
  postRace = '' as '' | 'head' | 'body',
  postAuthorType = 'Bot',
  postAuthorLogin = 'frontaliere-automation[bot]',
  title = 'chore(loop-fleet): persist durable evidence batches',
} = {}) {
  const posts: any[] = [];
  let reads = 0;
  let postRaceActive = false;
  const entries = files.map((filename) => ({
    filename,
    status: statuses[filename] ?? 'modified',
    additions: additions[filename] ?? 1,
    deletions: deletions[filename] ?? 0,
    ...(previous ? { previous_filename: previous } : {}),
  }));
  const ghFn = (args: string[], options: any = {}) => {
    if (args.includes('POST')) {
      posts.push(JSON.parse(options.input));
      postRaceActive = postRace === 'head' || postRace === 'body';
      return { user: { type: postAuthorType, login: postAuthorLogin } };
    }
    if (args[0] === 'pr') return { changedFiles: complete ? files.length : files.length + 1, files };
    const endpoint = String(args[1] ?? '');
    if (endpoint.endsWith('/files')) {
      return args.includes('--slurp') ? [entries] : entries.map((entry) => entry.filename).join('\n');
    }
    if (endpoint.endsWith('/reviews')) return reviews;
    if (endpoint.includes('/contents/')) {
      const filename = endpoint.split('/contents/')[1].split('?')[0];
      const ref = endpoint.split('?ref=')[1] ?? '';
      if (ref === ledgerBase) {
        const entry = entries.find((item) => item.filename === filename);
        if (baseMissing.includes(filename)
            || (entry?.status === 'added' && baseContents[filename] === undefined)) {
          const error = new Error('HTTP 404: Not Found');
          (error as any).status = 404;
          throw error;
        }
        if (baseContents[filename] !== undefined) return baseContents[filename];
        return defaultLedgerContent(filename, true);
      }
      if (contents[filename] !== undefined) return contents[filename];
      return defaultLedgerContent(filename, false);
    }
    reads += 1;
    return {
      state,
      draft,
      title,
      body: (changedBody && reads > 1) || (postRaceActive && postRace === 'body')
        ? `${body}\nbody edit race` : body,
      head: {
        sha: (changedHead && reads > 1) || (postRaceActive && postRace === 'head')
          ? 'e'.repeat(40) : ledgerHead,
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
      [`${valid}\n${valid}`, LOOP_FLEET_LEDGER_FILES[0]],
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
  it('rejects a valid JSONL insertion in the middle despite additions>0 and deletions=0', () => {
    const path = LOOP_FLEET_LEDGER_FILES[0];
    const baseContent = [
      JSON.stringify(ledgerRecord(path, 'first', ledgerBase)),
      JSON.stringify(ledgerRecord(path, 'last', ledgerBase)),
      '',
    ].join('\n');
    const insertedContent = [
      JSON.stringify(ledgerRecord(path, 'first', ledgerBase)),
      JSON.stringify(ledgerRecord(path, 'inserted', ledgerHead)),
      JSON.stringify(ledgerRecord(path, 'last', ledgerBase)),
      '',
    ].join('\n');
    const f = ledgerFixture({
      files: [path],
      baseContents: { [path]: baseContent },
      contents: { [path]: insertedContent },
    });
    expect(inspectLedgerOnlyHead(f.ghFn, 'owner/repo', 1, ledgerHead)).toMatchObject({
      ok: false,
      kind: 'not-ledger-only',
    });
    expect(() => postLedgerOnlyReview({ repo: 'owner/repo', pr: 1, head: ledgerHead, ghFn: f.ghFn })).toThrow();
    expect(f.posts).toEqual([]);
  });
  it('accepts a genuinely added ledger file only when base lookup is a distinct 404', () => {
    const path = LOOP_FLEET_LEDGER_FILES[0];
    const f = ledgerFixture({
      files: [path],
      statuses: { [path]: 'added' },
      contents: { [path]: `${JSON.stringify(ledgerRecord(path, 'new', ledgerHead))}\n` },
    });
    expect(inspectLedgerOnlyHead(f.ghFn, 'owner/repo', 1, ledgerHead)).toMatchObject({
      ok: true,
      kind: 'eligible',
    });
  });
  it('rejects an added ledger file when the base lookup returns content instead of a real 404', () => {
    const path = LOOP_FLEET_LEDGER_FILES[0];
    const f = ledgerFixture({
      files: [path],
      statuses: { [path]: 'added' },
      baseContents: { [path]: `${JSON.stringify(ledgerRecord(path, 'base', ledgerBase))}\n` },
      contents: { [path]: `${JSON.stringify(ledgerRecord(path, 'new', ledgerHead))}\n` },
    });
    expect(inspectLedgerOnlyHead(f.ghFn, 'owner/repo', 1, ledgerHead)).toMatchObject({
      ok: false,
      kind: 'not-ledger-only',
    });
    expect(f.posts).toEqual([]);
  });
  it('fails closed when a modified file base lookup is not a verifiable content response', () => {
    const path = LOOP_FLEET_LEDGER_FILES[0];
    const f = ledgerFixture({ files: [path], baseMissing: [path] });
    expect(inspectLedgerOnlyHead(f.ghFn, 'owner/repo', 1, ledgerHead)).toMatchObject({
      ok: false,
      kind: 'unverifiable',
    });
    expect(() => postLedgerOnlyReview({ repo: 'owner/repo', pr: 1, head: ledgerHead, ghFn: f.ghFn })).toThrow();
    expect(f.posts).toEqual([]);
  });
  it('classifies malformed candidate JSONL as unverifiable rather than an ordinary known mismatch', () => {
    const path = LOOP_FLEET_LEDGER_FILES[0];
    const f = ledgerFixture({ files: [path], contents: { [path]: '{not-json\n' } });
    expect(inspectLedgerOnlyHead(f.ghFn, 'owner/repo', 1, ledgerHead)).toMatchObject({
      ok: false,
      kind: 'unverifiable',
    });
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
    'chore/loop-fleet-ledger-L6-35160222880-1',
    'chore/loop-fleet-ledger-lifecycle-35160615088-1',
  ])('accepts the trusted suffixed producer branch %s', (headRef) => {
    const f = ledgerFixture({ headRef });
    expect(LOOP_FLEET_LEDGER_BRANCH_RE.test(headRef)).toBe(true);
    expect(inspectLedgerOnlyHead(f.ghFn, 'owner/repo', 1, ledgerHead)).toMatchObject({
      ok: true,
      kind: 'eligible',
    });
  });
  it.each([
    'chore/loop-fleet-ledger-L12-35160222880-1',
    'chore/loop-fleet-ledger-L6-35160222880-attempt-1',
    'chore/loop-fleet-ledger-L6-35160222880-1-extra',
    'chore/loop-fleet-ledger-lifecycle-abc-1',
  ])('rejects a near-valid producer branch %s', (headRef) => {
    const f = ledgerFixture({ headRef });
    expect(LOOP_FLEET_LEDGER_BRANCH_RE.test(headRef)).toBe(false);
    expect(inspectLedgerOnlyHead(f.ghFn, 'owner/repo', 1, ledgerHead)).toMatchObject({
      ok: false,
      kind: 'not-ledger-only',
    });
    expect(() => postLedgerOnlyReview({ repo: 'owner/repo', pr: 1, head: ledgerHead, ghFn: f.ghFn })).toThrow();
    expect(f.posts).toEqual([]);
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
  it('classifies missing trusted producer metadata as unverifiable', () => {
    const f = ledgerFixture({ authorType: null as any });
    expect(inspectLedgerOnlyHead(f.ghFn, 'owner/repo', 1, ledgerHead)).toMatchObject({
      ok: false,
      kind: 'unverifiable',
    });
    expect(() => postLedgerOnlyReview({ repo: 'owner/repo', pr: 1, head: ledgerHead, ghFn: f.ghFn })).toThrow();
    expect(f.posts).toEqual([]);
  });
  it.each([
    { changedHead: true, label: 'HEAD' },
    { changedBody: true, label: 'body' },
    { body: '## Implementato\n- done\n\n## Non implementato\nNessuno', label: 'body contract' },
  ])('does not publish when $label changes or is not verifiable', ({ label: _label, ...options }) => {
    const f = ledgerFixture(options);
    expect(() => postLedgerOnlyReview({ repo: 'owner/repo', pr: 1, head: ledgerHead, ghFn: f.ghFn })).toThrow();
    expect(f.posts).toEqual([]);
  });
  it('does not give automatic LGTM to a ledger PR with pre-existing needs-human', () => {
    const f = ledgerFixture({ labels: ['needs-human'] });
    expect(inspectLedgerOnlyHead(f.ghFn, 'owner/repo', 1, ledgerHead)).toMatchObject({
      ok: false,
      kind: 'not-ledger-only',
      reason: 'veto needs-human presente',
    });
    expect(() => postLedgerOnlyReview({ repo: 'owner/repo', pr: 1, head: ledgerHead, ghFn: f.ghFn })).toThrow();
    expect(f.posts).toEqual([]);
  });
  it.each(['body', 'head'])('fails the current run when %s changes immediately after POST', (postRace) => {
    const f = ledgerFixture({ postRace });
    expect(() => postLedgerOnlyReview({ repo: 'owner/repo', pr: 1, head: ledgerHead, ghFn: f.ghFn })).toThrow(/dopo la review/iu);
    expect(f.posts).toHaveLength(1);
  });
  it('fails closed when the POST response is not authored by the trusted App', () => {
    const f = ledgerFixture({ postAuthorLogin: 'other[bot]' });
    expect(() => postLedgerOnlyReview({ repo: 'owner/repo', pr: 1, head: ledgerHead, ghFn: f.ghFn }))
      .toThrow(/identità della review App/iu);
    expect(f.posts).toHaveLength(1);
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
    expect(steps.find((s: any) => s.id === 'quota')).toBeUndefined();
    for (const id of ['prefetch', 'codex_review']) expect(steps.find((s: any) => s.id === id).if).toContain("tier != 'tests-only'");
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
    const ledgerScope = workflow.jobs.vitest.steps.find((step: any) => step.id === 'ledger_scope');
    expect(ledgerScope.run).toContain('10)');
    const unknownExit = ledgerScope.run.slice(ledgerScope.run.indexOf('*)'));
    expect(unknownExit).toContain('exit "$status"');
    expect(unknownExit).not.toContain('ledger_only=false');
    expect(source).toContain('group: tests-${{ github.workflow }}-${{ github.event.pull_request.number || inputs.pr_number || github.ref }}-${{ github.event.pull_request.head.sha || github.sha }}');
    expect(source).toContain('cancel-in-progress: false');
    expect(source).toContain('trusted loop-fleet bridge');
    expect(source).toContain('Classify bounded loop-fleet ledger path');
    const ledgerReview = workflow.jobs.vitest.steps.find((step: any) => step.id === 'ledger_review');
    expect(ledgerReview['continue-on-error']).toBeUndefined();
    expect(ledgerReview.run).toContain('APP_TOKEN');
    expect(source).not.toContain('ledger-fast-review.yml');
  });
});
