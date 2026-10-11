import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GH_EXEC_MAX_BUFFER } from '../scripts/lib/gh-exec-buffer.mjs';

/**
 * Whoever reads `gh` through a synchronous exec declares its buffer.
 *
 * `execFileSync`, `spawnSync` and `execSync` stop reading the child at
 * `maxBuffer`, 1 MiB when it is not given, and fail with ENOBUFS. A REST
 * listing crosses that line without warning: the raw page of 60 deploy runs
 * weighs 1,074,863 bytes. PR 12277 read it through a bare `execFileSync` and
 * from its merge the deploy queue failed every read, retries included: no
 * deploy was requested for hours (issue 12308). The call looked exactly like
 * thirty others already in the tree.
 *
 * Every synchronous `gh` call whose output is captured must now declare the
 * same 64 MiB ceiling. Keeping the expected census empty makes regressions
 * fail at the call site instead of accumulating a permanent debt list.
 * `stdio: 'inherit'` is not a read and is not counted.
 *
 * The test reads the sources from disk and imports none of them: the selector
 * ties it to the diff through `sourceTreeLintTests` in
 * `scripts/ci/run-related-tests.mjs`, with the same perimeter as this scan.
 */
const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOT = 'scripts';
const GH_EXEC = /\b(?:execFileSync|spawnSync|execSync)\(\s*(['"])gh\1/g;

const KNOWN_UNBUFFERED_READS: Record<string, number> = {};

function moduleFiles(directory: string, found: string[] = []) {
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules') continue;
    const full = path.join(directory, name);
    const stat = lstatSync(full);
    if (stat.isDirectory()) moduleFiles(full, found);
    else if (stat.isFile() && name.endsWith('.mjs')) found.push(full);
  }
  return found;
}

/** One call, from the function name to the parenthesis that closes it. */
function callText(source: string, start: number) {
  const limit = Math.min(source.length, start + 2000);
  let depth = 0;
  for (let index = start; index < limit; index += 1) {
    if (source[index] === '(') depth += 1;
    else if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return source.slice(start, limit);
}

export function unbufferedGhReads(source: string) {
  let count = 0;
  for (const match of source.matchAll(GH_EXEC)) {
    const call = callText(source, match.index ?? 0);
    if (/\bmaxBuffer\b/.test(call)) continue;
    if (/stdio:\s*(['"])inherit\1/.test(call)) continue;
    count += 1;
  }
  return count;
}

describe('synchronous reads of gh declare their buffer', () => {
  it('uses one shared bound above the child-process default', () => {
    expect(GH_EXEC_MAX_BUFFER).toBe(64 * 1024 * 1024);
    expect(GH_EXEC_MAX_BUFFER).toBeGreaterThan(1024 * 1024);
  });

  it('recognises the bare form and the two forms that are not a risk', () => {
    expect(unbufferedGhReads("execFileSync('gh', args, { encoding: 'utf8' })")).toBe(1);
    expect(unbufferedGhReads('spawnSync("gh", ["api", path])')).toBe(1);
    expect(unbufferedGhReads("execFileSync('gh', args, {\n  encoding: 'utf8',\n  maxBuffer: 64 * 1024 * 1024,\n})")).toBe(0);
    expect(unbufferedGhReads("spawnSync('gh', ['pr', 'checkout', n], { stdio: 'inherit' })")).toBe(0);
    expect(unbufferedGhReads("execFileSync('git', ['status'])")).toBe(0);
    // Two calls in one file are two reads, whatever sits between them.
    expect(unbufferedGhReads("a = execFileSync('gh', x);\nconst maxBuffer = 1;\nb = execFileSync('gh', y);")).toBe(2);
  });

  it('finds no read outside the list, and every listed file at its number', () => {
    const counted: Record<string, number> = {};
    for (const file of moduleFiles(path.join(ROOT, SCAN_ROOT))) {
      const reads = unbufferedGhReads(readFileSync(file, 'utf8'));
      if (reads > 0) counted[path.relative(ROOT, file).split(path.sep).join('/')] = reads;
    }
    expect(counted).toEqual(KNOWN_UNBUFFERED_READS);
  });

  it('keeps the deploy control plane off the list', () => {
    for (const file of ['scripts/ci/request-latest-deploy.mjs', 'scripts/ci/rearm-deploy-build.mjs', 'scripts/crawler-quarantine-review.mjs']) {
      expect(KNOWN_UNBUFFERED_READS, file).not.toHaveProperty(file);
      expect(unbufferedGhReads(readFileSync(path.join(ROOT, file), 'utf8')), file).toBe(0);
    }
  });
});
