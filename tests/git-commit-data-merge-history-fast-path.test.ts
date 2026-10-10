// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SHELL_PATH = resolve(ROOT, 'scripts/lib/git-commit-data.sh');
const SLICE = 'data/jobs/by-crawler/acme.json';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

describe('git-commit-data merge history fast path (#12498)', () => {
  it('keeps previousSlugs from both inputs when a base-equality shortcut selects a stale side', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gcd-history-fast-path-'));
    tempDirs.push(dir);
    const basePath = join(dir, 'base.json');
    const remotePath = join(dir, 'remote.json');
    const localPath = join(dir, 'local.json');
    const outPath = join(dir, 'merged.json');
    const base = [{
      url: 'https://example.ch/jobs/123456',
      slug: 'active-route',
      title: 'Original title',
      previousSlugs: ['legacy-route'],
      previousSlugsByLocale: { it: ['legacy-route'], de: ['alte-route'] },
    }];
    const local = [{
      ...base[0],
      title: 'Updated title',
      previousSlugs: [],
      previousSlugsByLocale: {},
    }];
    writeJson(basePath, base);
    writeJson(remotePath, base);
    writeJson(localPath, local);

    const shell = readFileSync(SHELL_PATH, 'utf8');
    const heredoc = shell.match(
      /node - "\$base_file" "\$remote_file" "\$local_file" "\$out_file" "\$key_field" "\$label" <<'NODE'\n([\s\S]*?)\nNODE\n/,
    )?.[1];
    expect(heredoc).toBeTruthy();

    const output = execFileSync(
      process.execPath,
      ['-', basePath, remotePath, localPath, outPath, 'url', SLICE],
      { cwd: ROOT, input: heredoc, encoding: 'utf8' },
    );
    const merged = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(merged[0].title).toBe('Updated title');
    expect(merged[0].previousSlugs).toContain('legacy-route');
    expect(merged[0].previousSlugsByLocale.it).toContain('legacy-route');
    expect(merged[0].previousSlugsByLocale.de).toContain('alte-route');
    expect(output).toContain('Historical slug preserved');
  });
});
