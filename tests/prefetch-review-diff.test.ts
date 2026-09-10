import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeReviewDiff } from '../scripts/ci/prefetch-review-diff.mjs';

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
});
