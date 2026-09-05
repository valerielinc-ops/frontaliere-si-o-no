// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isCrawlerGenerationToken,
  resolveCrawlerGenerationToken,
} from '../scripts/lib/crawler-generation-token.mjs';

function repositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'crawler-generation-token-fallback-'));
  const repository = join(root, 'repository');
  const runnerTemp = join(root, 'runner-temp');
  mkdirSync(runnerTemp);
  mkdirSync(repository);
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repository });
  mkdirSync(join(repository, 'data/jobs/by-crawler'), { recursive: true });
  writeFileSync(join(repository, 'data/jobs/by-crawler/acme.json'), '[]\n');
  execFileSync('git', ['add', '.'], { cwd: repository });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repository });
  writeFileSync(join(repository, 'data/jobs/by-crawler/acme.json'), '[{"id":"1"}]\n');
  return { repository, runnerTemp };
}

const ROOT = resolve(import.meta.dirname, '..');
const RECEIPT_MODULE = resolve(ROOT, 'scripts/lib/crawler-generation-receipt.mjs');

/** The CLI reads `process.cwd()`, and vitest workers forbid `process.chdir()`. */
function runDescriptorCli(
  repository: string,
  env: Record<string, string | undefined>,
): { status: number | null; stdout: string; stderr: string } {
  const script = `import(${JSON.stringify(RECEIPT_MODULE)}).then((module) => {`
    + " const descriptor = module.runCrawlerGroupCommitDescriptorCli(['data/jobs/by-crawler/acme.json']);"
    + ' process.stdout.write(descriptor.generationToken); });';
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('crawler generation token fallback', () => {
  it('derives the token from the run coordinates when the dispatcher input is empty', () => {
    const token = resolveCrawlerGenerationToken({
      CRAWLER_GENERATION_TOKEN: '',
      GITHUB_RUN_ID: '33585044260',
      GITHUB_RUN_ATTEMPT: '1',
    });
    expect(token).toBe('33585044260-1');
    expect(isCrawlerGenerationToken(token)).toBe(true);
  });

  it('keeps a non-empty dispatcher token authoritative, malformed included', () => {
    expect(resolveCrawlerGenerationToken({
      CRAWLER_GENERATION_TOKEN: '7-3',
      GITHUB_RUN_ID: '33585044260',
      GITHUB_RUN_ATTEMPT: '1',
    })).toBe('7-3');
    expect(resolveCrawlerGenerationToken({
      CRAWLER_GENERATION_TOKEN: 'not-a-token',
      GITHUB_RUN_ID: '33585044260',
      GITHUB_RUN_ATTEMPT: '1',
    })).toBe('not-a-token');
  });

  it('returns null when neither the input nor the run coordinates yield a token', () => {
    expect(resolveCrawlerGenerationToken({ CRAWLER_GENERATION_TOKEN: '' })).toBeNull();
    expect(resolveCrawlerGenerationToken({
      CRAWLER_GENERATION_TOKEN: '',
      GITHUB_RUN_ID: '33585044260',
      GITHUB_RUN_ATTEMPT: '0',
    })).toBeNull();
  });

  it('writes the group commit descriptor on an empty token instead of killing the group', () => {
    const { repository, runnerTemp } = repositoryFixture();
    const result = runDescriptorCli(repository, {
      CRAWLER_GENERATION_TOKEN: '',
      GITHUB_RUN_ID: '33585044260',
      GITHUB_RUN_ATTEMPT: '1',
      JOBS_HOUSEKEEPING_SCOPE: 'acme',
      CRAWLER_GROUP_COMMIT_MESSAGE: 'Auto-update ACME jobs',
      CRAWLER_GROUP_COMMIT_DIR: 'crawler-generation/commit-batch',
      RUNNER_TEMP: runnerTemp,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('33585044260-1');
    expect(isCrawlerGenerationToken(result.stdout)).toBe(true);
  });

  it('still throws on an empty token when the run coordinates are missing too', () => {
    const { repository, runnerTemp } = repositoryFixture();
    const result = runDescriptorCli(repository, {
      CRAWLER_GENERATION_TOKEN: '',
      GITHUB_RUN_ID: undefined,
      GITHUB_RUN_ATTEMPT: undefined,
      JOBS_HOUSEKEEPING_SCOPE: 'acme',
      CRAWLER_GROUP_COMMIT_MESSAGE: 'Auto-update ACME jobs',
      CRAWLER_GROUP_COMMIT_DIR: 'crawler-generation/commit-batch',
      RUNNER_TEMP: runnerTemp,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Missing CRAWLER_GENERATION_TOKEN/);
  });
});
