// @vitest-environment node
//
// Regression coverage for issue #4887 — "previousSlugs writer regression".
//
// The "Recover Lost previousSlugs" monitor kept reporting 45-383 silently
// dropped previousSlugs entries per run (threshold 10) and blamed a crawler
// bypass of addPreviousSlugForLocale/captureLostSlugs. No .mjs writer was at
// fault: the loss happens AFTER node exits, inside git-commit-data.sh's JSON
// 3-way merge.
//
// commit_isolated_from_worktree() resolves `base_sha` once from the job's
// checkout HEAD and deliberately never fast-forwards it, so a workflow that
// invokes the script several times in one job (translate-pending.yml commits
// translations, then title fixes, then regenerated slugs) merges its later
// commits against a base that is already one-or-more of its own commits old.
// mergeArrayByDelta()'s multiset semantics then reads that stale base as
// intent:
//
//   • entries on remote but not in the stale base look like local additions
//     and get appended again      → duplicates injected;
//   • the next writer's `new Set` normalisation then reads as
//     `count_base - count_local` intentional removals → the merge DELETES
//     those slugs from remote.
//
// Both halves are fixed by giving the append-only SEO registries their real
// semantics: an ordered set union of remote and local that ignores base.
//
// Every fixture below is built from RELATIVE dates only (no calendar
// literals) so the suite can never rot.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-commit-data.sh');

// The script uses `declare -A` (associative arrays), requiring bash 4+.
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

interface Harness {
  originDir: string;
  repoDir: string;
  otherDir: string;
}

function initHarness(): Harness {
  const originDir = mkdtempSync(join(tmpdir(), 'gcd-appendonly-origin-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'gcd-appendonly-repo-'));
  const otherDir = mkdtempSync(join(tmpdir(), 'gcd-appendonly-other-'));
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', originDir]);
  execFileSync('git', ['clone', '-q', originDir, repoDir]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  return { originDir, repoDir, otherDir };
}

function writeJson(dir: string, relPath: string, value: unknown): void {
  mkdirSync(dirname(join(dir, relPath)), { recursive: true });
  writeFileSync(join(dir, relPath), `${JSON.stringify(value, null, 2)}\n`);
}

function commitAndPush(dir: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
  execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: dir });
}

/** Simulates the OTHER writer that pushed to origin/main after our checkout. */
function pushFromConcurrentWriter(
  h: Harness,
  mutate: (cloneDir: string) => void,
  message: string,
): void {
  const clone = join(h.otherDir, `clone-${Math.random().toString(36).slice(2, 8)}`);
  execFileSync('git', ['clone', '-q', h.originDir, clone]);
  execFileSync('git', ['config', 'user.email', 'other@example.com'], { cwd: clone });
  execFileSync('git', ['config', 'user.name', 'Other'], { cwd: clone });
  mutate(clone);
  commitAndPush(clone, message);
}

function runScript(h: Harness, extraPaths: string[], sliceFile?: string): void {
  execFileSync(BASH_BIN, [SCRIPT_PATH, '--slice-only', 'test commit', ...extraPaths], {
    cwd: h.repoDir,
    env: {
      ...process.env,
      ...(sliceFile ? { JOBS_SLICE_FILE: sliceFile } : {}),
      SKIP_AI_TRANSLATION: '1',
      SLUG_HISTORY_SUMMARY_FILE: join(h.repoDir, 'no-such-slug-history-summary.txt'),
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      GITHUB_RUN_ID: '',
      GITHUB_REPOSITORY: '',
      GITHUB_OUTPUT: '',
    },
  });
}

/** Reads a file back from origin/main — i.e. what was actually pushed. */
function readFromOrigin<T>(h: Harness, relPath: string): T {
  const out = execFileSync('git', ['show', `main:${relPath}`], {
    cwd: h.originDir,
    encoding: 'utf8',
  });
  return JSON.parse(out) as T;
}

function cleanup(h: Harness): void {
  for (const d of [h.originDir, h.repoDir, h.otherDir]) rmSync(d, { recursive: true, force: true });
}

interface JobRecord {
  url: string;
  slug: string;
  crawledAt: string;
  previousSlugs: string[];
  previousSlugsByLocale: Record<string, string[]>;
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    url: 'https://example.ch/jobs/acme-1',
    slug: 'operaio-acme-lugano',
    crawledAt: daysAgo(1),
    previousSlugs: [],
    previousSlugsByLocale: {},
    ...overrides,
  };
}

const SLICE = 'data/jobs/by-crawler/acme.json';

describe('git-commit-data.sh 3-way merge — append-only slug/path registries (#4887)', () => {
  it('unions previousSlugs instead of reading a deduped local array as intentional removals', () => {
    const h = initHarness();
    try {
      // Stale merge base: the job's checkout HEAD, carrying DUPLICATED entries
      // left behind by an earlier merge cycle (42 logical slugs stored twice).
      const historical = Array.from({ length: 8 }, (_, i) => `vecchio-slug-${i}`);
      writeJson(h.repoDir, SLICE, [job({ previousSlugs: [...historical, ...historical] })]);
      commitAndPush(h.repoDir, 'seed');

      // Concurrent writer normalised the array on origin/main: one copy each.
      pushFromConcurrentWriter(
        h,
        (dir) => writeJson(dir, SLICE, [job({ previousSlugs: [...historical] })]),
        'other writer: normalise previousSlugs',
      );

      // Our own worktree ALSO deduped (every writer funnels through
      // capSlugArray/`new Set`) and appended one freshly-renamed slug.
      writeJson(h.repoDir, SLICE, [
        job({ previousSlugs: [...historical, 'slug-appena-rinominato'] }),
      ]);

      runScript(h, [SLICE], SLICE);

      const merged = readFromOrigin<JobRecord[]>(h, SLICE);
      expect(merged).toHaveLength(1);
      // Pre-fix: mergeArrayByDelta computed removals = count_base(2) -
      // count_local(1) = 1 per fingerprint and deleted every historical slug
      // from remote, leaving only the new one.
      for (const slug of historical) {
        expect(merged[0].previousSlugs).toContain(slug);
      }
      expect(merged[0].previousSlugs).toContain('slug-appena-rinominato');
      // Set semantics: no duplicates survive the merge either, so the
      // inject-duplicates → read-dedupe-as-removal cycle cannot restart.
      expect(new Set(merged[0].previousSlugs).size).toBe(merged[0].previousSlugs.length);
    } finally {
      cleanup(h);
    }
  });

  it('never drops a previousSlug that only the concurrent writer knows about', () => {
    const h = initHarness();
    try {
      writeJson(h.repoDir, SLICE, [job({ previousSlugs: ['slug-base'] })]);
      commitAndPush(h.repoDir, 'seed');

      pushFromConcurrentWriter(
        h,
        (dir) => writeJson(dir, SLICE, [job({ previousSlugs: ['slug-base', 'solo-remoto'] })]),
        'other writer: rename captured on origin/main',
      );

      // Our stale snapshot never saw `solo-remoto`; it adds its own.
      writeJson(h.repoDir, SLICE, [job({ previousSlugs: ['slug-base', 'solo-locale'] })]);

      runScript(h, [SLICE], SLICE);

      const merged = readFromOrigin<JobRecord[]>(h, SLICE);
      expect(merged[0].previousSlugs).toEqual(
        expect.arrayContaining(['slug-base', 'solo-remoto', 'solo-locale']),
      );
    } finally {
      cleanup(h);
    }
  });

  it('applies the same set semantics per locale in previousSlugsByLocale', () => {
    const h = initHarness();
    try {
      const seed = ['alt-de-1', 'alt-de-2'];
      writeJson(h.repoDir, SLICE, [
        job({ previousSlugsByLocale: { de: [...seed, ...seed], en: ['old-en'] } }),
      ]);
      commitAndPush(h.repoDir, 'seed');

      pushFromConcurrentWriter(
        h,
        (dir) =>
          writeJson(dir, SLICE, [
            job({ previousSlugsByLocale: { de: [...seed], en: ['old-en', 'old-en-remote'] } }),
          ]),
        'other writer: locale slug regen',
      );

      writeJson(h.repoDir, SLICE, [
        job({ previousSlugsByLocale: { de: [...seed, 'alt-de-3'], en: ['old-en'] } }),
      ]);

      runScript(h, [SLICE], SLICE);

      const merged = readFromOrigin<JobRecord[]>(h, SLICE);
      expect(merged[0].previousSlugsByLocale.de).toEqual(
        expect.arrayContaining([...seed, 'alt-de-3']),
      );
      expect(new Set(merged[0].previousSlugsByLocale.de).size).toBe(
        merged[0].previousSlugsByLocale.de.length,
      );
      // The concurrent writer's EN capture must survive our stale EN snapshot.
      expect(merged[0].previousSlugsByLocale.en).toEqual(
        expect.arrayContaining(['old-en', 'old-en-remote']),
      );
    } finally {
      cleanup(h);
    }
  });

  // Sibling class (Non-Negotiable #6): the same stale-base multiset delta runs
  // over every append-only registry this script commits. data/seo-404-compat
  // has a `merge=compat-shard` set-union driver in .gitattributes, but that
  // only covers the REBASE path — the grouped-isolated commit path never
  // rebases and reaches merge_json_3way instead.
  it('unions data/seo-404-compat shard paths (grouped-isolated path has no merge driver)', () => {
    const h = initHarness();
    const SHARD = 'data/seo-404-compat/part-00.json';
    try {
      const seeded = ['/cerca-lavoro-ticino/a', '/cerca-lavoro-ticino/b'];
      writeJson(h.repoDir, SHARD, { paths: [...seeded, ...seeded] });
      commitAndPush(h.repoDir, 'seed');

      pushFromConcurrentWriter(
        h,
        (dir) => writeJson(dir, SHARD, { paths: [...seeded, '/cerca-lavoro-ticino/remoto'] }),
        'discover-404s: new compat path',
      );

      writeJson(h.repoDir, SHARD, { paths: [...seeded, '/cerca-lavoro-ticino/locale'] });

      runScript(h, [SHARD]);

      const merged = readFromOrigin<{ paths: string[] }>(h, SHARD);
      expect(merged.paths).toEqual(
        expect.arrayContaining([...seeded, '/cerca-lavoro-ticino/remoto', '/cerca-lavoro-ticino/locale']),
      );
      expect(new Set(merged.paths).size).toBe(merged.paths.length);
    } finally {
      cleanup(h);
    }
  });

  it('unions the root-level data/orphan-indexed-job-slugs.json registry', () => {
    const h = initHarness();
    const REGISTRY = 'data/orphan-indexed-job-slugs.json';
    try {
      const seeded = ['case-anziani', 'educatori'];
      writeJson(h.repoDir, REGISTRY, [...seeded, ...seeded]);
      commitAndPush(h.repoDir, 'seed');

      pushFromConcurrentWriter(
        h,
        (dir) => writeJson(dir, REGISTRY, [...seeded, 'nurses']),
        'sync-gsc-orphans: new orphan slug',
      );

      writeJson(h.repoDir, REGISTRY, [...seeded, 'logistica']);

      runScript(h, [REGISTRY]);

      const merged = readFromOrigin<string[]>(h, REGISTRY);
      expect(merged).toEqual(expect.arrayContaining([...seeded, 'nurses', 'logistica']));
      expect(new Set(merged).size).toBe(merged.length);
    } finally {
      cleanup(h);
    }
  });

  // Guard the blast radius: ordinary arrays must keep delta semantics, so a
  // crawler that genuinely drops a stale record still drops it.
  it('keeps multiset delta semantics for ordinary (non-registry) arrays', () => {
    const h = initHarness();
    const FILE = 'data/jobs/by-crawler/tags.json';
    try {
      writeJson(h.repoDir, FILE, [
        { url: 'https://example.ch/jobs/acme-1', tags: ['a', 'b', 'c'], crawledAt: daysAgo(2) },
      ]);
      commitAndPush(h.repoDir, 'seed');

      pushFromConcurrentWriter(
        h,
        (dir) =>
          writeJson(dir, FILE, [
            { url: 'https://example.ch/jobs/acme-1', tags: ['a', 'b', 'c', 'd'], crawledAt: daysAgo(1) },
          ]),
        'other writer: new tag',
      );

      // Local intentionally retires tag "b".
      writeJson(h.repoDir, FILE, [
        { url: 'https://example.ch/jobs/acme-1', tags: ['a', 'c'], crawledAt: daysAgo(1) },
      ]);

      runScript(h, [FILE], FILE);

      const merged = readFromOrigin<Array<{ tags: string[] }>>(h, FILE);
      expect(merged[0].tags).not.toContain('b');
      expect(merged[0].tags).toEqual(expect.arrayContaining(['a', 'c', 'd']));
    } finally {
      cleanup(h);
    }
  });
});
