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
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');

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

/** Strip comments so a path named only in an explanatory comment is not a hit. */
function stripComments(yaml: string): string {
  return yaml
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
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
    const violations: string[] = [];

    for (const file of fs.readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))) {
      const src = stripComments(fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf-8'));

      // Each `git add ...` / `git diff ...` invocation, up to the next shell
      // separator or end of line — line continuations kept, since these commands
      // routinely span several lines.
      const commands = src.match(/\bgit\s+(?:add|diff)\b[^\n&|;]*(?:\\\n[^\n&|;]*)*/g) ?? [];

      for (const cmd of commands) {
        for (const link of symlinks) {
          // The symlink itself, or any path descending through it.
          const rx = new RegExp(`(?:^|[\\s'"])${link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[/\\s'"]|$)`);
          if (!rx.test(cmd)) continue;
          violations.push(
            `${file}: \`${cmd.split('\n')[0].trim()}\` touches symlinked '${link}' — ` +
              `use \`node scripts/lib/git-add-resolved.mjs\` (add) or its \`--print-only\` ` +
              `output (diff), or the change is silently dropped`,
          );
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
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
