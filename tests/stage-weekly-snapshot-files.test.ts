import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, truncateSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Issue #3663 regression coverage: the "Snapshot Jobs Weekly (F5)" workflow's
// commit step used to run a SINGLE combined size-ceiling check over BOTH
// related-search files under `set -euo pipefail` — an oversize
// related-search-candidates.json (organic growth, prune gated on owner
// decision #1658) aborted the entire step, silently dropping the unrelated
// jobs-snapshots-history/, weekly-employers-delta.json, and
// weekly-employers-top-pairs.json commits too.
//
// scripts/lib/stage-weekly-snapshot-files.sh fixes this by staging core
// files unconditionally and gating each related-search file on its OWN
// ceiling individually. These tests exercise the shared script directly
// (the same script used by both the main commit step and the
// --regenerate-cmd rebase-retry regeneration).

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MB = 1024 * 1024;

const tmpDirs: string[] = [];

function makeRepoFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stage-weekly-snapshot-'));
  tmpDirs.push(dir);

  // Mirror just enough of the real repo for the script's relative paths
  // (`scripts/lib/...`, `data/...`) to resolve without touching the real
  // repo's git index.
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  cpSync(
    join(REPO_ROOT, 'scripts', 'lib', 'stage-weekly-snapshot-files.sh'),
    join(dir, 'scripts', 'lib', 'stage-weekly-snapshot-files.sh'),
  );
  cpSync(
    join(REPO_ROOT, 'scripts', 'lib', 'assert-file-size-ceiling.mjs'),
    join(dir, 'scripts', 'lib', 'assert-file-size-ceiling.mjs'),
  );
  cpSync(
    join(REPO_ROOT, 'scripts', 'lib', 'related-search-output-limit.mjs'),
    join(dir, 'scripts', 'lib', 'related-search-output-limit.mjs'),
  );

  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });

  return dir;
}

/** Sparse-truncate a file to an exact logical byte size (fast, no real I/O). */
function writeSizedFile(path: string, bytes: number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  truncateSync(path, bytes);
}

function stagedFiles(dir: string): string[] {
  const out = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).sort();
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('scripts/lib/stage-weekly-snapshot-files.sh (issue #3663)', () => {
  it('stages core snapshot/delta/footer files even when both related-search files are within ceiling', () => {
    const dir = makeRepoFixture();
    writeSizedFile(join(dir, 'data', 'jobs-snapshots-history', '2026-07-06.json'), 10 * MB);
    writeSizedFile(join(dir, 'data', 'weekly-employers-delta.json'), 1 * MB);
    writeSizedFile(join(dir, 'data', 'weekly-employers-top-pairs.json'), 1 * MB);
    writeSizedFile(join(dir, 'data', 'related-search-enriched.json'), 9 * MB);
    writeSizedFile(join(dir, 'data', 'related-search-candidates.json'), 46 * MB);

    execFileSync('bash', ['scripts/lib/stage-weekly-snapshot-files.sh'], { cwd: dir });

    const staged = stagedFiles(dir);
    expect(staged).toContain('data/jobs-snapshots-history/2026-07-06.json');
    expect(staged).toContain('data/weekly-employers-delta.json');
    expect(staged).toContain('data/weekly-employers-top-pairs.json');
    expect(staged).toContain('data/related-search-enriched.json');
    expect(staged).toContain('data/related-search-candidates.json');
  });

  it('still stages core files when related-search-candidates.json exceeds its ceiling (the #3663 failure mode)', () => {
    const dir = makeRepoFixture();
    writeSizedFile(join(dir, 'data', 'jobs-snapshots-history', '2026-07-06.json'), 10 * MB);
    writeSizedFile(join(dir, 'data', 'weekly-employers-delta.json'), 1 * MB);
    writeSizedFile(join(dir, 'data', 'weekly-employers-top-pairs.json'), 1 * MB);
    writeSizedFile(join(dir, 'data', 'related-search-enriched.json'), 9 * MB);
    // Over the 90 MB candidates ceiling — organic long-tail growth (#1658).
    writeSizedFile(join(dir, 'data', 'related-search-candidates.json'), 99 * MB);

    // The script never exits non-zero — a hard failure here would still
    // abort the parent `set -e` commit step, reproducing #3663.
    expect(() =>
      execFileSync('bash', ['scripts/lib/stage-weekly-snapshot-files.sh'], { cwd: dir }),
    ).not.toThrow();

    const staged = stagedFiles(dir);
    expect(staged).toContain('data/jobs-snapshots-history/2026-07-06.json');
    expect(staged).toContain('data/weekly-employers-delta.json');
    expect(staged).toContain('data/weekly-employers-top-pairs.json');
    // Still-compliant sibling file stages normally.
    expect(staged).toContain('data/related-search-enriched.json');
    // Oversize file is skipped, not staged — but does NOT block the rest.
    expect(staged).not.toContain('data/related-search-candidates.json');
  });

  it('skips only the oversize related-search-enriched.json without blocking related-search-candidates.json', () => {
    const dir = makeRepoFixture();
    writeSizedFile(join(dir, 'data', 'jobs-snapshots-history', '2026-07-06.json'), 10 * MB);
    writeSizedFile(join(dir, 'data', 'weekly-employers-delta.json'), 1 * MB);
    writeSizedFile(join(dir, 'data', 'weekly-employers-top-pairs.json'), 1 * MB);
    // Over the 50 MB enriched ceiling — runaway re-enrich tripwire.
    writeSizedFile(join(dir, 'data', 'related-search-enriched.json'), 60 * MB);
    writeSizedFile(join(dir, 'data', 'related-search-candidates.json'), 46 * MB);

    execFileSync('bash', ['scripts/lib/stage-weekly-snapshot-files.sh'], { cwd: dir });

    const staged = stagedFiles(dir);
    expect(staged).toContain('data/jobs-snapshots-history/2026-07-06.json');
    expect(staged).not.toContain('data/related-search-enriched.json');
    expect(staged).toContain('data/related-search-candidates.json');
  });
});
