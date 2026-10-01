import { mergeRefreshContent } from '../scripts/ci/open-data-refresh-merge.mjs';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MERGE_SCRIPT = path.join(ROOT, 'scripts/ci/merge-open-data-refresh.mjs');

describe('merge-open-data-refresh', () => {
  it('preserves both runs in append-only history and posted ledgers', () => {
    const baseHistory = '{"run":"base"}\n';
    const remoteHistory = `${baseHistory}{"run":"first"}\n`;
    const refreshHistory = `${baseHistory}{"run":"second"}\n`;
    expect(mergeRefreshContent(
      'data/cf-5xx-history.jsonl',
      baseHistory,
      remoteHistory,
      refreshHistory,
    )).toBe(`${baseHistory}{"run":"first"}\n{"run":"second"}\n`);

    const baseLedger = JSON.stringify({ schemaVersion: 1, posted: [{ id: 'base' }] });
    const remoteLedger = JSON.stringify({ schemaVersion: 1, posted: [{ id: 'base' }, { id: 'first' }] });
    const refreshLedger = JSON.stringify({ schemaVersion: 1, posted: [{ id: 'base' }, { id: 'second' }] });
    const mergedLedger = JSON.parse(
      mergeRefreshContent(
        'data/telegram-posted-jobs.json',
        baseLedger,
        remoteLedger,
        refreshLedger,
      ),
    ) as { posted: Array<{ id: string }> };
    expect(mergedLedger.posted.map((entry) => entry.id)).toEqual(['base', 'first', 'second']);
  });
});

// crawl-events.yml publishes article surfaces through their historical
// symlinked paths (`services/locales/blog-body/<locale>/…` lives behind a
// symlinked directory, `data/blog-articles-data.ts` and
// `services/seo/seo-blog-5.ts` are file symlinks into
// packages/articles/content/). `git diff -- <symlinked path>` reports nothing
// for an edit made through the symlink, so on the stable-branch path the
// current run's article update was dropped while the job stayed green.
describe('merge-open-data-refresh on symlinked refresh paths', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function git(cwd: string, args: string[]) {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    }).trim();
  }

  function write(repo: string, file: string, content: string) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  }

  it('applies the current run through symlinked directory and file paths', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-refresh-symlinks-'));
    tmpDirs.push(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'core.symlinks', 'true']);
    write(repo, 'packages/articles/content/blog-body/it/eventi.ts', 'export default "base";\n');
    write(repo, 'packages/articles/content/blog-articles-data.ts', 'export const modified = "base";\n');
    write(repo, 'data/events.json', '{"run":"base"}\n');
    write(repo, 'data/stable-only.json', '{"run":"base"}\n');
    fs.mkdirSync(path.join(repo, 'services/locales'), { recursive: true });
    fs.symlinkSync('../../packages/articles/content/blog-body', path.join(repo, 'services/locales/blog-body'));
    fs.symlinkSync('../packages/articles/content/blog-articles-data.ts', path.join(repo, 'data/blog-articles-data.ts'));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const base = git(repo, ['rev-parse', 'HEAD']);

    // The stable refresh branch still carries an earlier, unmerged run.
    git(repo, ['checkout', '-q', '-b', 'chore/refresh']);
    write(repo, 'services/locales/blog-body/it/eventi.ts', 'export default "first run";\n');
    write(repo, 'data/stable-only.json', '{"run":"first"}\n');
    git(repo, ['add', '-A', '--', 'packages/articles/content/blog-body/it/eventi.ts', 'data/stable-only.json']);
    git(repo, ['commit', '-q', '-m', 'first run']);
    const remote = git(repo, ['rev-parse', 'HEAD']);

    // The current run commits from the workflow checkout (main) first.
    git(repo, ['checkout', '-q', 'main']);
    write(repo, 'services/locales/blog-body/it/eventi.ts', 'export default "second run";\n');
    write(repo, 'data/blog-articles-data.ts', 'export const modified = "second run";\n');
    // The production refresh failed on a blob larger than execFileSync's
    // default 1 MiB buffer. Include multibyte text so the size is in bytes.
    const dataset = `${JSON.stringify({ run: 'second', description: 'é'.repeat(700_000) })}\n`;
    write(repo, 'data/events.json', dataset);
    git(repo, ['add', '-A', '--',
      'packages/articles/content/blog-body/it/eventi.ts',
      'packages/articles/content/blog-articles-data.ts',
      'data/events.json']);
    git(repo, ['commit', '-q', '-m', 'second run']);
    const refresh = git(repo, ['rev-parse', 'HEAD']);

    // open-data-refresh-pr.sh then selects the stable branch and merges.
    git(repo, ['checkout', '-q', 'chore/refresh']);
    const output = execFileSync(process.execPath, [
      MERGE_SCRIPT,
      '--base', base,
      '--remote', remote,
      '--refresh', refresh,
      '--path', 'data/events.json',
      '--path', 'services/locales/blog-body/it/eventi.ts',
      '--path', 'data/blog-articles-data.ts',
      '--path', 'data/stable-only.json',
    ], { cwd: repo, encoding: 'utf8' });

    expect(output).toContain('applied 3 path(s)');
    const real = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8');
    expect(real('packages/articles/content/blog-body/it/eventi.ts')).toBe('export default "second run";\n');
    expect(real('packages/articles/content/blog-articles-data.ts')).toBe('export const modified = "second run";\n');
    expect(real('data/events.json')).toBe(dataset);
    // A path the current run did not touch keeps the stable branch's value.
    expect(real('data/stable-only.json')).toBe('{"run":"first"}\n');
    // The symlinks themselves stay symlinks: the merge writes the real blobs.
    expect(fs.lstatSync(path.join(repo, 'services/locales/blog-body')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(repo, 'data/blog-articles-data.ts')).isSymbolicLink()).toBe(true);
  });

  it('reads large generated blobs during stable-branch reconciliation', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-refresh-large-'));
    tmpDirs.push(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    write(repo, 'data/events.json', `${'base'.repeat(512 * 1024)}\n`);
    git(repo, ['add', 'data/events.json']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const base = git(repo, ['rev-parse', 'HEAD']);

    git(repo, ['checkout', '-q', '-b', 'chore/refresh']);
    write(repo, 'data/events.json', `${'remote'.repeat(512 * 1024)}\n`);
    git(repo, ['add', 'data/events.json']);
    git(repo, ['commit', '-q', '-m', 'remote']);
    const remote = git(repo, ['rev-parse', 'HEAD']);

    git(repo, ['checkout', '-q', 'main']);
    write(repo, 'data/events.json', `${'refresh'.repeat(512 * 1024)}\n`);
    git(repo, ['add', 'data/events.json']);
    git(repo, ['commit', '-q', '-m', 'refresh']);
    const refresh = git(repo, ['rev-parse', 'HEAD']);

    git(repo, ['checkout', '-q', 'chore/refresh']);
    const output = execFileSync(process.execPath, [
      MERGE_SCRIPT,
      '--base', base,
      '--remote', remote,
      '--refresh', refresh,
      '--path', 'data/events.json',
    ], { cwd: repo, encoding: 'utf8' });

    expect(output).toContain('applied 1 path(s)');
    expect(fs.readFileSync(path.join(repo, 'data/events.json'), 'utf8')).toBe(`${'refresh'.repeat(512 * 1024)}\n`);
  });
});
