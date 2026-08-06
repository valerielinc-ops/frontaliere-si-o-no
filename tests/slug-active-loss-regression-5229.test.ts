// @vitest-environment node
//
// Regression coverage for issue #5229 — "previousSlugs writer regression".
//
// #5229 re-opened the same tripwire #5157 had closed, and the 9 genuinely
// post-fix losses split into TWO different holes, both reproduced here from
// the shapes the recovery run's own events.jsonl recorded:
//
//   1. THE WRITE-BOUNDARY GUARD GAVE UP AT THE CAP.
//      scripts/lib/slug-preservation-guard.mjs rescues a dropped slug by
//      inserting it at the OLDEST position and then calling capSlugArray,
//      which keeps the NEWEST `cap` entries — so the rescued slug was always
//      the first one evicted. Any write that left the bucket at/over cap made
//      the guard a guaranteed no-op that returned the benign-looking
//      'cap-trim' outcome, and writeJsonAtomic discards the return value, so
//      the give-up was silent. Observed on coop-ticino.json job
//      `company-okmjz4` in commit 1ea970faae: the GSC orphan sync pushed the
//      flat array 12 -> 80 (cap) and the `it` bucket 12 -> 20 (cap), evicting
//      three already-indexed slugs on the way in.
//
//      The cap only EXPLAINS a disappearance when the bucket was already full
//      BEFORE the write — which is exactly the condition
//      scan-prev-slug-losses.mjs's classifyCapTrim() requires before it
//      excuses one. While guard and scanner disagreed, the guard waved through
//      losses the tripwire then reported.
//
//   2. CONFLICT RESOLUTION DELETED AN ACTIVE SLUG.
//      #4887 established that these losses happen after node exits, inside
//      git-commit-data.sh's JSON 3-way merge, and fixed it for the ARCHIVE
//      arrays by giving them append-only union semantics. `slug` and
//      `slugByLocale.<locale>` are SCALARS, so they kept falling through to
//      "Scalar conflict … Keeping local" and the losing side vanished with
//      nothing banked. Observed on banca-cler.json job `company-1u7ff1` in
//      commit 97f59fc792: en/de/fr collapsed onto the it slug and three live
//      translated URLs disappeared.
//
// Both halves are invisible to tests/slug-write-encapsulation.test.ts: its AST
// walk only parses scripts/** .ts|.mjs|.js, and half of this lives in a .sh.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import {
  preserveSlugHistory,
  GUARD_PER_LOCALE_CAP,
  GUARD_LEGACY_CAP,
} from '../scripts/lib/slug-preservation-guard.mjs';

/* ────────────────────────────────────────────────────────────────────────
   1. The guard must not let the cap swallow a slug that was already serving
   ──────────────────────────────────────────────────────────────────────── */

describe('slug-preservation-guard — cap must not swallow proven history (#5229)', () => {
  const SLICE = '/repo/data/jobs/by-crawler/coop-ticino.json';

  /** A job whose `it` bucket holds `n` historical slugs, well under cap. */
  const jobWithHistory = (n: number) => ({
    id: 'company-okmjz4',
    url: 'https://example.ch/jobs/okmjz4',
    slug: 'vendita-prodotti-freschi-coop',
    slugByLocale: { it: 'vendita-prodotti-freschi-coop' },
    previousSlugs: Array.from({ length: n }, (_, i) => `storico-${i}`),
    previousSlugsByLocale: { it: Array.from({ length: n }, (_, i) => `storico-${i}`) },
  });

  it('keeps an already-indexed slug when the WRITE itself fills the bucket', () => {
    // Before: 12 historical slugs, cap 20 — the bucket is NOT full.
    const before = { jobs: [jobWithHistory(12)] };

    // The write drops three of them and adds enough fresh entries to land the
    // bucket exactly at cap — the sync-gsc-orphans shape from 1ea970faae.
    const survivors = ['storico-0', 'storico-1', 'storico-2', 'storico-3', 'storico-4',
      'storico-5', 'storico-6', 'storico-7', 'storico-8'];
    const dropped = ['storico-9', 'storico-10', 'storico-11'];
    const fresh = Array.from({ length: GUARD_PER_LOCALE_CAP - survivors.length }, (_, i) => `orfano-${i}`);
    const next = {
      jobs: [{
        ...jobWithHistory(0),
        previousSlugs: [...survivors, ...fresh],
        previousSlugsByLocale: { it: [...survivors, ...fresh] },
      }],
    };

    const res = preserveSlugHistory(SLICE, next, { previousValue: before, denylist: new Set() });

    const bucket = next.jobs[0].previousSlugsByLocale.it;
    // Pre-fix: recapture() prepended each rescued slug and capSlugArray kept
    // the newest 20, evicting it again → restored=0, capTrimmed=3, and three
    // indexed URLs gone with no journal entry.
    for (const slug of dropped) {
      expect(bucket, `bucket must retain already-indexed ${slug}`).toContain(slug);
      expect(next.jobs[0].previousSlugs, `flat mirror must retain ${slug}`).toContain(slug);
    }
    expect(res.restored).toBe(dropped.length);
    expect(res.capTrimmed).toBe(0);
    // The cap is still honoured — history won a slot, it did not grow one.
    expect(bucket.length).toBeLessThanOrEqual(GUARD_PER_LOCALE_CAP);
    expect(next.jobs[0].previousSlugs.length).toBeLessThanOrEqual(GUARD_LEGACY_CAP);
  });

  it('still treats eviction from an ALREADY-full bucket as a legitimate cap-trim', () => {
    // The bucket was at cap BEFORE the write: routine LRU, and exactly what
    // scan-prev-slug-losses.mjs's classifyCapTrim() excuses. The guard must
    // agree with the scanner here too, or it would fight normal operation.
    const full = Array.from({ length: GUARD_PER_LOCALE_CAP }, (_, i) => `storico-${i}`);
    const before = {
      jobs: [{
        ...jobWithHistory(0),
        previousSlugs: full,
        previousSlugsByLocale: { it: full },
      }],
    };
    const next = {
      jobs: [{
        ...jobWithHistory(0),
        previousSlugs: [...full.slice(1), 'appena-catturato'],
        previousSlugsByLocale: { it: [...full.slice(1), 'appena-catturato'] },
      }],
    };

    const res = preserveSlugHistory(SLICE, next, { previousValue: before, denylist: new Set() });
    expect(res.capTrimmed).toBeGreaterThan(0);
    expect(next.jobs[0].previousSlugsByLocale.it.length).toBe(GUARD_PER_LOCALE_CAP);
  });
});

/* ────────────────────────────────────────────────────────────────────────
   2. The 3-way merge must not delete an active slug
   ──────────────────────────────────────────────────────────────────────── */

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-commit-data.sh');
// The script uses `declare -A` (associative arrays), requiring bash 4+.
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';
const SLICE = 'data/jobs/by-crawler/banca-cler.json';

interface Harness { originDir: string; repoDir: string; otherDir: string }

function initHarness(): Harness {
  const originDir = mkdtempSync(join(tmpdir(), 'gcd-5229-origin-'));
  const repoDir = mkdtempSync(join(tmpdir(), 'gcd-5229-repo-'));
  const otherDir = mkdtempSync(join(tmpdir(), 'gcd-5229-other-'));
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

function pushFromConcurrentWriter(h: Harness, mutate: (d: string) => void, message: string): void {
  const clone = join(h.otherDir, `clone-${Math.random().toString(36).slice(2, 8)}`);
  execFileSync('git', ['clone', '-q', h.originDir, clone]);
  execFileSync('git', ['config', 'user.email', 'other@example.com'], { cwd: clone });
  execFileSync('git', ['config', 'user.name', 'Other'], { cwd: clone });
  mutate(clone);
  commitAndPush(clone, message);
}

function runScript(h: Harness, sliceFile: string): void {
  execFileSync(BASH_BIN, [SCRIPT_PATH, '--slice-only', 'test commit', sliceFile], {
    cwd: h.repoDir,
    env: {
      ...process.env,
      JOBS_SLICE_FILE: sliceFile,
      SKIP_AI_TRANSLATION: '1',
      SLUG_HISTORY_SUMMARY_FILE: join(h.repoDir, 'no-such-slug-history-summary.txt'),
      GH_TOKEN: '', GITHUB_TOKEN: '', GITHUB_RUN_ID: '',
      GITHUB_REPOSITORY: '', GITHUB_OUTPUT: '',
    },
  });
}

function readFromOrigin<T>(h: Harness, relPath: string): T {
  return JSON.parse(
    execFileSync('git', ['show', `main:${relPath}`], { cwd: h.originDir, encoding: 'utf8' }),
  ) as T;
}

function cleanup(h: Harness): void {
  for (const d of [h.originDir, h.repoDir, h.otherDir]) rmSync(d, { recursive: true, force: true });
}

interface JobRecord {
  url: string;
  slug: string;
  slugByLocale: Record<string, string>;
  previousSlugs: string[];
  previousSlugsByLocale: Record<string, string[]>;
}

/** Every slug this record can still serve. */
function reachable(job: JobRecord): Set<string> {
  return new Set([
    job.slug,
    ...Object.values(job.slugByLocale ?? {}),
    ...(job.previousSlugs ?? []),
    ...Object.values(job.previousSlugsByLocale ?? {}).flat(),
  ].filter(Boolean));
}

describe('git-commit-data.sh 3-way merge — active slugs survive conflict resolution (#5229)', () => {
  it('banks the displaced translated slugs instead of deleting them', () => {
    const h = initHarness();
    try {
      const IT = 'consulente-clientela-privata-lugano-bank-cler';
      const base: JobRecord = {
        url: 'https://example.ch/jobs/1u7ff1',
        slug: IT,
        slugByLocale: {
          it: IT,
          en: 'individual-customer-advisor-lugano-bank-cler',
          de: 'individueller-kundenberater-lugano-bank-cler',
          fr: 'conseiller-client-individuel-lugano-bank-cler',
        },
        previousSlugs: [],
        previousSlugsByLocale: {},
      };
      writeJson(h.repoDir, SLICE, [base]);
      commitAndPush(h.repoDir, 'seed');

      // A concurrent writer re-translated on origin/main: three NEW localized
      // slugs, all live and indexable.
      const remoteTranslated = {
        en: 'individual-customer-advisor-lugano-80-100-bank-cler',
        de: 'individueller-kundenberater-lugano-80-100-bank-cler',
        fr: 'conseiller-client-individuel-lugano-80-100-bank-cler',
      };
      pushFromConcurrentWriter(
        h,
        (dir) => writeJson(dir, SLICE, [{ ...base, slugByLocale: { it: IT, ...remoteTranslated } }]),
        'other writer: fresh translations',
      );

      // Our own crawl produced NO translation this round and collapsed every
      // locale back onto the source slug — the 97f59fc792 shape.
      writeJson(h.repoDir, SLICE, [
        { ...base, slugByLocale: { it: IT, en: IT, de: IT, fr: IT } },
      ]);

      runScript(h, SLICE);

      const [merged] = readFromOrigin<JobRecord[]>(h, SLICE);
      const live = reachable(merged);

      // Pre-fix: "Scalar conflict … Keeping local" replaced each locale with
      // the it slug and banked nothing — three indexed URLs went to 404.
      for (const [locale, slug] of Object.entries(remoteTranslated)) {
        expect(live, `displaced ${locale} slug must still resolve: ${slug}`).toContain(slug);
      }
      // Local still wins the ACTIVE field: the merge decides which slug is
      // live, this fix only decides that the loser keeps a redirect.
      expect(merged.slugByLocale.en).toBe(IT);
    } finally {
      cleanup(h);
    }
  });

  it('leaves a conflict-free merge untouched', () => {
    const h = initHarness();
    try {
      const base: JobRecord = {
        url: 'https://example.ch/jobs/stabile',
        slug: 'operaio-acme-lugano',
        slugByLocale: { it: 'operaio-acme-lugano', en: 'worker-acme-lugano' },
        previousSlugs: [],
        previousSlugsByLocale: {},
      };
      writeJson(h.repoDir, SLICE, [base]);
      commitAndPush(h.repoDir, 'seed');

      // Only the concurrent writer changes anything, and only a non-slug field.
      pushFromConcurrentWriter(
        h,
        (dir) => writeJson(dir, SLICE, [{ ...base, previousSlugs: ['vecchio-slug'] }]),
        'other writer: capture a rename',
      );
      writeJson(h.repoDir, SLICE, [base]);

      runScript(h, SLICE);

      const [merged] = readFromOrigin<JobRecord[]>(h, SLICE);
      expect(merged.slugByLocale).toEqual(base.slugByLocale);
      expect(merged.previousSlugs).toEqual(['vecchio-slug']);
    } finally {
      cleanup(h);
    }
  });
});
