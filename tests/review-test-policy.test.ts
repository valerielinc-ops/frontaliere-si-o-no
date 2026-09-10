import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { isReviewTestPath, isTestOnlySnapshot, postTestOnlyReview, findTestOnlyApproval, TEST_REVIEW_MARKER } from '../scripts/ci/review-test-policy.mjs';
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
  it('retains the real test job and skips every model step for tests-only PRs', () => {
    const workflow = YAML.parse(readFileSync('.github/workflows/tests.yml', 'utf8'));
    const steps = workflow.jobs.vitest.steps;
    expect(steps.find((s: any) => s.id === 'test_only_review').if).toContain('success()');
    for (const id of ['prefetch', 'quota', 'claude_review']) expect(steps.find((s: any) => s.id === id).if).toContain("tier != 'tests-only'");
    for (const step of steps.filter((s: any) => String(s.name).startsWith('vitest '))) expect(step.if ?? '').not.toContain('tests-only');
  });
});
