import { imageContainerDefect, mergeRefreshContent } from '../scripts/ci/open-data-refresh-merge.mjs';

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MERGE_SCRIPT = path.join(ROOT, 'scripts/ci/merge-open-data-refresh.mjs');

/** A structurally valid WebP container around an arbitrary payload. */
function webpContainer(payload: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(payload.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, payload]);
}

const EVERY_BYTE = Buffer.from(Array.from({ length: 256 }, (_, index) => index));

describe('imageContainerDefect', () => {
  it('accepts image containers by content and ignores other paths', () => {
    expect(imageContainerDefect('public/images/blog/a.webp', webpContainer(EVERY_BYTE))).toBeNull();
    // The tree holds a JPEG named .png; sharp decodes by content, so must this.
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), EVERY_BYTE]);
    expect(imageContainerDefect('public/images/blog/a.png', jpeg)).toBeNull();
    expect(imageContainerDefect('data/events.json', Buffer.from('{}'))).toBeNull();
    expect(imageContainerDefect('public/images/blog/a.webp', null)).toBeNull();
  });

  it('names what is wrong with a mangled or truncated image', () => {
    const valid = webpContainer(EVERY_BYTE);
    // The incident: the blob was decoded and re-encoded as UTF-8 text.
    const roundTripped = Buffer.from(valid.toString('utf8'), 'utf8');
    expect(roundTripped.equals(valid)).toBe(false);
    expect(imageContainerDefect('public/images/blog/a.webp', roundTripped)).toMatch(/RIFF/);
    expect(imageContainerDefect('public/images/blog/a.webp', valid.subarray(0, 100)))
      .toMatch(/declares \d+ bytes, file has 100/);
    expect(imageContainerDefect('public/images/blog/a.webp', Buffer.from('<html>not an image</html>')))
      .toMatch(/signature/);
  });
});

describe('merge-open-data-refresh', () => {
  it('compares buffer contents and preserves binary snapshot changes and deletions', () => {
    const base = Buffer.from([0, 255, 254, 128]);
    const remote = Buffer.from([1, 255, 254, 128]);
    const refresh = Buffer.from([2, 255, 254, 128]);
    const file = 'public/images/blog/hero.webp';
    expect(mergeRefreshContent(file, base, remote, Buffer.from(base))).toEqual(remote);
    expect(mergeRefreshContent(file, base, Buffer.from(base), null)).toBeNull();
    expect(mergeRefreshContent(file, base, remote, refresh)).toEqual(refresh);
    expect(mergeRefreshContent(file, null, null, refresh)).toEqual(refresh);
    expect(mergeRefreshContent('data/history.jsonl', Buffer.from('base\n'),
      Buffer.from('base\nremote\n'), Buffer.from('base\nrefresh\n')))
      .toBe('base\nremote\nrefresh\n');
  });

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

  function write(repo: string, file: string, content: string | Buffer) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  }

  it('keeps every byte of added and updated binary assets on the stable branch', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-refresh-binary-'));
    tmpDirs.push(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    const file = 'public/images/blog/hero.webp';
    const added = 'public/images/blog/new-hero.webp';
    const original = Buffer.from([0, 128, 192, 255]);
    const newest = webpContainer(EVERY_BYTE);
    write(repo, file, original);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '-q', '-b', 'chore/refresh']);
    write(repo, file, Buffer.from([255, 254, 253]));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'remote']);
    const remote = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '-q', 'main']);
    write(repo, file, newest);
    write(repo, added, newest);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'refresh']);
    const refresh = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '-q', 'chore/refresh']);
    execFileSync(process.execPath, [MERGE_SCRIPT,
      '--base', base, '--remote', remote, '--refresh', refresh,
      '--path', 'public/images/blog'], { cwd: repo });
    expect(fs.readFileSync(path.join(repo, file))).toEqual(newest);
    expect(fs.readFileSync(path.join(repo, added))).toEqual(newest);
  });

  it('refuses to write an unreadable image and names it', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-refresh-broken-image-'));
    tmpDirs.push(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    const good = 'public/images/blog/good.webp';
    const broken = 'public/images/blog/broken.webp';
    const valid = webpContainer(EVERY_BYTE);
    write(repo, 'data/seed.json', '{}\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '-q', '-b', 'chore/refresh']);
    const remote = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '-q', 'main']);
    write(repo, good, valid);
    write(repo, broken, Buffer.from(valid.toString('utf8'), 'utf8'));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'refresh']);
    const refresh = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '-q', 'chore/refresh']);

    const result = spawnSync(process.execPath, [MERGE_SCRIPT,
      '--base', base, '--remote', remote, '--refresh', refresh,
      '--path', 'public/images/blog'], { cwd: repo, encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`::error file=${broken}`);
    expect(result.stderr).not.toContain(`file=${good}`);
    expect(fs.existsSync(path.join(repo, broken))).toBe(false);
    expect(fs.readFileSync(path.join(repo, good))).toEqual(valid);
  });

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
