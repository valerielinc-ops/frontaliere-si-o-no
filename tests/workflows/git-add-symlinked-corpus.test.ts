import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Guard for a failure class that is invisible at review time and silent at run
 * time (issue #4974, found reviewing the seo-blog corpus move).
 *
 * The article corpus lives under `packages/articles/content/`, with symlinks
 * left at the historical paths (`services/locales/blog-*`, `services/seo/seo-blog*.ts`,
 * `data/blog-articles-data.ts`, …). Against those paths, git behaves in two
 * ways that both lose work:
 *
 *   - `git add services/locales/blog-body/it/x.ts` → `fatal: pathspec ... is
 *     beyond a symbolic link`, which under `set -e` aborts the whole commit,
 *     including unrelated files staged in the same command;
 *   - `git add services/seo/seo-blog-5.ts` → exit 0, stages NOTHING. The
 *     symlink blob is unchanged; the edit written through it lives at the real
 *     path, which was never in the pathspec.
 *
 * The second is what makes a test necessary: no error, no warning, the job goes
 * on reporting success, and the change is dropped every run forever. Two live
 * workflows were doing exactly that — `crawl-events.yml` losing the weekly
 * `dateModified` bump, and `batch-faq-articles.yml` gating its commit on a
 * `git diff` that reads zero for the same reason.
 *
 * Workflows must therefore route these paths through
 * `scripts/lib/git-add-resolved.mjs`, which resolves them with `realpathSync`.
 */

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Everything that can run `git add`/`git diff` against a corpus path: the
 * workflows themselves, the composite actions they call, and the shell/node
 * helpers those invoke. Scoping this to `.github/workflows` alone would leave
 * the same mistake free to reappear one directory over.
 */
const SCAN_DIRS = [
  path.join(ROOT, '.github', 'workflows'),
  path.join(ROOT, '.github', 'actions'),
  path.join(ROOT, 'scripts'),
  path.join(ROOT, '.githooks'),
];
const SCAN_EXT = /\.(ya?ml|sh|mjs|js)$/;

/** Repo-relative paths that are tracked as symlinks (mode 120000). */
function trackedSymlinks(): string[] {
  // maxBuffer: the index carries 30k+ entries (the body-copy corpus alone is
  // ~14k files), well past execFileSync's 1 MB default → ENOBUFS.
  const out = execFileSync('git', ['ls-files', '-s'], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .filter((l) => l.startsWith('120000'))
    .map((l) => l.split('\t')[1])
    .filter(Boolean);
}

/**
 * Strip comments so a path named only in an explanatory comment is not a hit.
 *
 * Both comment styles, because the scan covers YAML/shell (`#`) and the Node
 * helpers (`//`, `/* *\/`) — the docblock of `git-add-resolved.mjs` itself
 * quotes the very commands this test looks for.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1').replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

/**
 * Join shell line-continuations BEFORE scanning.
 *
 * These commands routinely span several lines, and the offending path is
 * usually not on the first one — `crawl-events.yml` carried `seo-blog-5.ts` on
 * the LAST line of a nine-line `git add`. Trying to express the continuation
 * inside the command regex does not work: a greedy `[^\n&|;]*` swallows the
 * trailing backslash itself, the continuation group then matches zero times,
 * and the scan silently sees only the first line — a test that reports pass
 * while looking at almost none of the command.
 */
function joinContinuations(src: string): string {
  return src.replace(/\\\n\s*/g, ' ');
}

function scanFiles(): Array<{ label: string; src: string }> {
  const out: Array<{ label: string; src: string }> = [];
  for (const dir of SCAN_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true }) as Array<
      fs.Dirent & { parentPath?: string; path?: string }
    >) {
      if (!entry.isFile() || !SCAN_EXT.test(entry.name)) continue;
      const parent = entry.parentPath ?? entry.path ?? dir;
      const full = path.join(parent, entry.name);
      out.push({
        label: path.relative(ROOT, full),
        src: joinContinuations(stripComments(fs.readFileSync(full, 'utf-8'))),
      });
    }
  }
  return out;
}

/** Every `git add`/`git diff` invocation that names one of `symlinks`. */
function findViolations(files: Array<{ label: string; src: string }>, symlinks: string[]): string[] {
  const violations: string[] = [];
  for (const { label, src } of files) {
    // One invocation = `git add`/`git diff` up to the next shell separator.
    // Continuations are already joined, so this sees the whole command.
    const commands = src.match(/\bgit\s+(?:add|diff)\b[^\n&|;]*/g) ?? [];
    for (const cmd of commands) {
      for (const link of symlinks) {
        // The symlink itself, or any path descending through it.
        const rx = new RegExp(
          `(?:^|[\\s'"])${link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[/\\s'"]|$)`,
        );
        if (!rx.test(cmd)) continue;
        violations.push(
          `${label}: \`${cmd.trim().slice(0, 120)}\` touches symlinked '${link}' — ` +
            `use \`node scripts/lib/git-add-resolved.mjs\` (add) or its \`--print-only\` ` +
            `output (diff), or the change is silently dropped`,
        );
      }
    }
  }
  return violations;
}

describe('workflows never stage corpus paths that are symlinks (#4974)', () => {
  const symlinks = trackedSymlinks();

  it('finds the tracked corpus symlinks (guards against a vacuous pass)', () => {
    expect(symlinks.length).toBeGreaterThan(10);
    expect(symlinks).toContain('services/locales/blog-body');
    expect(symlinks).toContain('services/seo/seo-blog-5.ts');
    expect(symlinks).toContain('data/blog-articles-data.ts');
  });

  it('routes every git add / git diff over a symlinked path through git-add-resolved', () => {
    const violations = findViolations(scanFiles(), symlinks);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('detects a symlinked path on a continuation line, not just the first one', () => {
    // The shape that actually shipped broken: a multi-line `git add` whose
    // offending path sits on the last line. An earlier version of this test
    // scanned only the first line and passed on exactly this input.
    const sample = [
      { label: 'sample.yml', src: joinContinuations(stripComments(
        '          git add data/events.json \\\n' +
        '            data/events/by-source/tio-agenda.json \\\n' +
        '            data/blog-articles-data.ts services/seo/seo-blog-5.ts\n',
      )) },
    ];
    const found = findViolations(sample, symlinks);
    expect(found.join('\n')).toMatch(/services\/seo\/seo-blog-5\.ts/);
    expect(found.join('\n')).toMatch(/data\/blog-articles-data\.ts/);
  });

  it('git-add-resolved --print-only resolves a symlinked corpus path to its real location', () => {
    const printed = execFileSync(
      'node',
      ['scripts/lib/git-add-resolved.mjs', '--print-only', 'services/seo/seo-blog-5.ts', 'services/locales/blog-body/'],
      { cwd: ROOT, encoding: 'utf-8' },
    ).trim().split('\n');

    expect(printed[0]).toBe('packages/articles/content/seo/seo-blog-5.ts');
    // Trailing slash preserved, so `git add dir/` keeps meaning the directory.
    expect(printed[1]).toBe('packages/articles/content/blog-body/');
  });
});
