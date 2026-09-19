import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { main, writeReviewDiff } from '../scripts/ci/prefetch-review-diff.mjs';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-diff-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const output = join(root, 'output');
  mkdirSync(repo); mkdirSync(output);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, 'deleted.js'), 'old\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  return { root, repo, output, git, base };
}

describe('host-prepared complete review patch', () => {
  it('retains more than 20,000 code lines while excluding generated data', () => {
    const f = fixture();
    mkdirSync(join(f.repo, 'data'));
    mkdirSync(join(f.repo, 'tests'));
    writeFileSync(join(f.repo, 'tests/a.test.ts'), 'excluded test content\n');
    writeFileSync(join(f.repo, 'a.spec.ts'), 'excluded spec content\n');
    writeFileSync(join(f.repo, 'a.test.d.ts'), 'excluded declaration test\n');
    writeFileSync(join(f.repo, 'large.js'), Array.from({ length: 21000 }, (_, i) => `const value${i} = ${i};`).join('\n') + '\n');
    writeFileSync(join(f.repo, 'data/generated.json'), 'generated-only\n');
    rmSync(join(f.repo, 'deleted.js'));
    writeFileSync(join(f.repo, 'binary.bin'), Buffer.from([0, 1, 2]));
    f.git('add', '.'); f.git('commit', '-qm', 'change');
    const names = writeReviewDiff({ base: f.base, head: f.git('rev-parse', 'HEAD'), directory: f.output, exclusions: ['data'], cwd: f.repo });
    const patch = readFileSync(join(f.output, 'diff.patch'), 'utf8');
    expect(patch).toContain('+const value20999 = 20999;');
    expect(patch.split('\n').length).toBeGreaterThan(21000);
    expect(patch).toContain('deleted file mode');
    expect(patch).toContain('Binary files');
    expect(patch).not.toContain('generated-only');
    expect(patch).not.toContain('excluded test content');
    expect(patch).not.toContain('excluded spec content');
    expect(patch).not.toContain('excluded declaration test');
    expect(names).toEqual(['binary.bin', 'deleted.js', 'large.js']);
  });

  it('keeps all 301 incremental files and omits the already-reviewed contribution', () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'reviewed.js'), 'already reviewed\n');
    f.git('add', '.'); f.git('commit', '-qm', 'reviewed');
    const base = f.git('rev-parse', 'HEAD');
    for (let i = 0; i < 301; i++) writeFileSync(join(f.repo, `delta-${i}.js`), `change ${i}\n`);
    f.git('add', '.'); f.git('commit', '-qm', 'delta');
    const names = writeReviewDiff({ base, head: f.git('rev-parse', 'HEAD'), directory: f.output, exclusions: ['data'], incremental: true, cwd: f.repo });
    expect(names).toHaveLength(301);
    expect(readFileSync(join(f.output, 'delta-files.txt'), 'utf8').trim().split('\n')).toHaveLength(301);
    expect(readFileSync(join(f.output, 'delta.patch'), 'utf8')).not.toContain('already reviewed');
    expect(readFileSync(join(f.output, 'diff.patch'), 'utf8')).toContain('see delta.patch');
  });

  it('hydrates missing historical blobs in a partial clone before the sandbox', () => {
    const f = fixture();
    f.git('config', 'uploadpack.allowFilter', 'true');
    f.git('config', 'uploadpack.allowAnySHA1InWant', 'true');
    rmSync(join(f.repo, 'deleted.js'));
    writeFileSync(join(f.repo, 'current.js'), 'current\n');
    f.git('add', '.'); f.git('commit', '-qm', 'head');
    const clone = join(f.root, 'partial');
    execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${f.repo}`, clone]);
    writeReviewDiff({ base: f.base, head: f.git('rev-parse', 'HEAD'), directory: f.output, exclusions: ['data'], cwd: clone });
    const patch = readFileSync(join(f.output, 'diff.patch'), 'utf8');
    expect(patch).toContain('-old');
    expect(patch).toContain('+current');
  });

  it('fails instead of returning an empty review when a revision is unavailable', () => {
    const f = fixture();
    expect(() => writeReviewDiff({ base: 'a'.repeat(40), head: f.base, directory: f.output, exclusions: ['data'], cwd: f.repo })).toThrow();
  });

  // Issue #9189. Reproduces the real topology of #9141: the branch was
  // force-pushed, so the previous review's commit sits on abandoned history and
  // `merge_base(lastRev, HEAD)` lands on `main` — 90 commits behind HEAD there,
  // which put 506 files in a 3-file PR's delta and made #9175's merged work
  // (`scripts/lib/nord-anglia-job-parser.mjs`) a finding against #9141.
  it('never anchors the incremental delta on foreign commits that reached main', () => {
    const f = fixture();
    // main advances with work this PR never touched.
    writeFileSync(join(f.repo, 'foreign-parser.mjs'), 'export const foreign = "other PR work";\n');
    f.git('add', '.'); f.git('commit', '-qm', 'foreign PR merged on main');
    const mainTip = f.git('rev-parse', 'HEAD');
    // The head that was reviewed, branched BEFORE main advanced: abandoned by a
    // later force-push, so it is not an ancestor of the current head.
    f.git('checkout', '-q', '-b', 'abandoned', f.base);
    writeFileSync(join(f.repo, 'owned-stable.mjs'), 'export const stable = 1;\n');
    f.git('add', '.'); f.git('commit', '-qm', 'reviewed head');
    const lastRev = f.git('rev-parse', 'HEAD');
    // The current head, rebased onto the advanced main.
    f.git('checkout', '-q', '-b', 'pr', mainTip);
    writeFileSync(join(f.repo, 'owned-stable.mjs'), 'export const stable = 1;\n');
    writeFileSync(join(f.repo, 'owned-moved.mjs'), 'export const moved = "new since review";\n');
    f.git('add', '.'); f.git('commit', '-qm', 'pr head');
    const head = f.git('rev-parse', 'HEAD');
    expect(f.git('merge-base', lastRev, head)).toBe(f.base); // the contaminating anchor

    const compare: Record<string, string> = {
      [`repos/o/r/compare/${mainTip}...${head}`]: JSON.stringify({ merge_base_commit: { sha: mainTip } }),
      'repos/o/r/pulls/9141': JSON.stringify({ base: { sha: mainTip } }),
    };
    main({
      HEAD_SHA: head, REPO: 'o/r', PR_NUMBER: '9141', CTX_DIR: f.output,
      INCREMENTAL_BASE: lastRev, REVIEW_DIFF_EXCLUSIONS: 'data',
    }, { api: (endpoint: string) => compare[endpoint], cwd: f.repo });

    const delta = readFileSync(join(f.output, 'delta.patch'), 'utf8');
    const deltaFiles = readFileSync(join(f.output, 'delta-files.txt'), 'utf8').trim().split('\n').filter(Boolean);
    // The whole point: a file only `main` advanced by must never be reviewable.
    expect(deltaFiles).not.toContain('foreign-parser.mjs');
    expect(delta).not.toContain('other PR work');
    // ...while what this PR actually moved since the review is still there.
    expect(deltaFiles).toEqual(['owned-moved.mjs']);
    expect(delta).toContain('new since review');
  });

  it('writes an empty delta rather than the whole PR when nothing moved', () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'owned.mjs'), 'export const owned = 1;\n');
    f.git('add', '.'); f.git('commit', '-qm', 'pr head');
    const head = f.git('rev-parse', 'HEAD');
    // `reviewedFrom === head` → nothing moved. An empty pathspec list must not
    // degrade into `git diff --`, which would serve every file again.
    const names = writeReviewDiff({
      base: f.base, head, directory: f.output, exclusions: ['data'],
      incremental: true, reviewedFrom: head, cwd: f.repo,
    });
    expect(names).toEqual([]);
    expect(readFileSync(join(f.output, 'delta.patch'), 'utf8')).toBe('');
    expect(readFileSync(join(f.output, 'delta-files.txt'), 'utf8')).toBe('');
  });
});
