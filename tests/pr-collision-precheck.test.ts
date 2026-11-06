import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  findCollisions,
  formatCollisionWarning,
  isPullRequestCreate,
  isWidelySharedFile,
  runPrecheck,
  targetBase,
  targetRepository,
} from '../scripts/ci/pr-collision-precheck.mjs';

const SCRIPT = resolve(__dirname, '../scripts/ci/pr-collision-precheck.mjs');
const REPO_ROOT = resolve(__dirname, '..');

// The 19-09 incident: four PRs on the same three files.
const OPEN_PRS = [
  {
    number: 9263,
    title: 'jobs SEO reuse',
    headRefName: 'fix/jobs-seo-reuse',
    files: [
      { path: 'src/alpha-reuse.mjs' },
      { path: 'src/beta-plugin.ts' },
      { path: 'package.json' },
    ],
  },
  {
    number: 9265,
    title: 'reuse fingerprint',
    headRefName: 'fix/reuse-fp',
    files: [{ path: 'tests/gamma.test.ts' }],
  },
  { number: 9300, title: 'draft', headRefName: 'wip', isDraft: true, files: [{ path: 'src/beta-plugin.ts' }] },
  { number: 9301, title: 'unrelated', headRefName: 'fix/other', files: [{ path: 'services/other.ts' }] },
  { number: 9302, title: 'self', headRefName: 'fix/mine', files: [{ path: 'src/beta-plugin.ts' }] },
];

const OWN_FILES = [
  'src/alpha-reuse.mjs',
  'src/beta-plugin.ts',
  'tests/gamma.test.ts',
  'package.json',
];

describe('pr-collision-precheck', () => {
  it('recognizes the gh pr create command and its repo/base flags', () => {
    expect(isPullRequestCreate('gh pr create --repo a/b --title x')).toBe(true);
    expect(isPullRequestCreate('cd /tmp && gh pr create --title x')).toBe(true);
    expect(isPullRequestCreate('gh pr view 1')).toBe(false);
    expect(targetRepository('gh pr create --repo nanakokyobashi-rgb/frontaliere-articles --body-file x')).toBe('nanakokyobashi-rgb/frontaliere-articles');
    expect(targetRepository('gh pr create --title x')).toBe('valerielinc-ops/frontaliere-si-o-no');
    expect(targetBase('gh pr create --base fix/other --title x')).toBe('fix/other');
    expect(targetBase('gh pr create --title x --body "use --base evil"')).toBe('main');
  });

  it('finds overlaps with open non-draft PRs, excluding the own branch', () => {
    const collisions = findCollisions(OWN_FILES, OPEN_PRS, { ownBranch: 'fix/mine' });
    expect(collisions.map(({ number }) => number)).toEqual([9263, 9265]);
    expect(collisions[0].strong).toEqual([
      'src/alpha-reuse.mjs',
      'src/beta-plugin.ts',
    ]);
    expect(collisions[0].weak).toEqual(['package.json']);
  });

  it('warns loudly and suggests serializing or merging the work', () => {
    const warning = formatCollisionWarning(findCollisions(OWN_FILES, OPEN_PRS, { ownBranch: 'fix/mine' }), {
      repository: 'valerielinc-ops/frontaliere-si-o-no',
    });
    expect(warning).toMatch(/COLLISIONE/);
    expect(warning).toMatch(/#9263 \(fix\/jobs-seo-reuse\)/);
    expect(warning).toMatch(/--base fix\/jobs-seo-reuse/);
    expect(warning).toMatch(/Accorpa/);
    expect(warning).toMatch(/non un blocco/);
  });

  it('does not raise the warning for widely shared files only', () => {
    expect(isWidelySharedFile('scripts/ci/loop-sync-manifest.json')).toBe(true);
    expect(isWidelySharedFile('package-lock.json')).toBe(true);
    expect(isWidelySharedFile('src/beta-plugin.ts')).toBe(false);
    const warning = formatCollisionWarning(findCollisions(['package.json'], OPEN_PRS));
    expect(warning).not.toMatch(/COLLISIONE/);
    expect(warning).toMatch(/solo su file molto condivisi/);
    expect(formatCollisionWarning([])).toBeNull();
  });

  it('runs against the branch of the payload cwd with injected git and gh', () => {
    const seen: { repository?: string; base?: string } = {};
    const warning = runPrecheck(
      { cwd: REPO_ROOT, tool_input: { command: 'gh pr create --repo valerielinc-ops/frontaliere-si-o-no --head fix/mine --title x' } },
      {
        listChangedFiles: (_cwd: string, base: string) => { seen.base = base; return OWN_FILES; },
        listOpenPrs: (repository: string) => { seen.repository = repository; return OPEN_PRS; },
      },
    );
    expect(seen).toEqual({ repository: 'valerielinc-ops/frontaliere-si-o-no', base: 'main' });
    expect(warning).toMatch(/COLLISIONE/);
    expect(runPrecheck({ cwd: REPO_ROOT, tool_input: { command: 'git status' } })).toBeNull();
  });

  it('exits 0 silently when the payload is not a PR creation or is malformed', () => {
    for (const input of ['not json', JSON.stringify({ tool_input: { command: 'ls' } })]) {
      const result = spawnSync('node', [SCRIPT], { input, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    }
  });
});
