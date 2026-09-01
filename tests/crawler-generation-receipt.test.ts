// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { digestDocument } from '../scripts/lib/canonical-json-digest.mjs';
import {
  createCrawlerGroupCommitDescriptor,
  validateCrawlerGenerationReceipt,
  validateCrawlerGroupCommitDescriptor,
} from '../scripts/lib/crawler-generation-receipt.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_PATH = resolve(ROOT, 'scripts/lib/git-commit-data.sh');
const BASH_BIN = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find(existsSync) ?? 'bash';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'crawler-generation-receipt-'));
  const origin = join(root, 'origin.git');
  const repository = join(root, 'repository');
  const runnerTemp = join(root, 'runner-temp');
  const receiptDir = join(runnerTemp, 'crawler-generation', 'receipts', '01');
  mkdirSync(runnerTemp);
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
  execFileSync('git', ['clone', '-q', origin, repository]);
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repository });
  mkdirSync(join(repository, 'data/jobs/by-crawler'), { recursive: true });
  writeFileSync(join(repository, 'data/jobs/by-crawler/acme.json'), '[]\n');
  execFileSync('git', ['add', '.'], { cwd: repository });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repository });
  execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repository });
  return { root, origin, repository, runnerTemp, receiptDir };
}

function runHelper(
  value: ReturnType<typeof fixture>,
  {
    enabled = true,
    generationToken = '9001-2',
    pushFailure = null,
    relativeReceiptDir = false,
  }: { enabled?: boolean; generationToken?: string; pushFailure?: string | null; relativeReceiptDir?: boolean } = {},
) {
  let pathValue = process.env.PATH ?? '';
  if (pushFailure !== null) {
    const shim = join(value.root, 'git-shim');
    mkdirSync(shim);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(shim, 'git'), `#!/bin/bash\nif [ "$1" = "push" ]; then\n  printf '%s\\n' '${pushFailure}' >&2\n  exit 1\nfi\nexec '${realGit}' "$@"\n`);
    chmodSync(join(shim, 'git'), 0o755);
    pathValue = `${shim}${delimiter}${pathValue}`;
  }
  return spawnSync(BASH_BIN, [SCRIPT_PATH, '--slice-only', 'test receipt'], {
    cwd: value.repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: pathValue,
      MAX_PUSH_ATTEMPTS: '1',
      JOBS_SLICE_FILE: 'data/jobs/by-crawler/acme.json',
      JOBS_HOUSEKEEPING_SCOPE: 'acme',
      CRAWLER_GENERATION_TOKEN: generationToken,
      CRAWLER_GENERATION_RECEIPT_DIR: enabled
        ? relativeReceiptDir ? 'crawler-generation/receipts/01' : value.receiptDir
        : '',
      RUNNER_TEMP: value.runnerTemp,
      SKIP_AI_TRANSLATION: '1',
      SLUG_HISTORY_SUMMARY_FILE: join(value.root, 'no-summary'),
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      GITHUB_RUN_ID: '',
      GITHUB_REPOSITORY: '',
      GITHUB_OUTPUT: '',
    },
  });
}

function onlyReceipt(receiptDir: string, diagnostics = '') {
  expect(existsSync(receiptDir), diagnostics).toBe(true);
  const files = readdirSync(receiptDir);
  expect(files).toEqual(['acme.json']);
  const receipt = JSON.parse(readFileSync(join(receiptDir, files[0]), 'utf8'));
  expect(validateCrawlerGenerationReceipt(receipt)).toEqual({ valid: true, errors: [] });
  return receipt;
}

describe('crawler generation receipt emitted by the isolated commit tree', () => {
  it('records pushed and noop outcomes from exact commit blobs, including explicit absence', () => {
    const pushedFixture = fixture();
    writeFileSync(
      join(pushedFixture.repository, 'data/jobs/by-crawler/acme.json'),
      `[{"id":"new","token":"super-secret-fixture","body":"${'x'.repeat(2 * 1024 * 1024)}"}]\n`,
    );
    const pushed = runHelper(pushedFixture, { relativeReceiptDir: true });
    expect(pushed.status).toBe(0);
    const pushedReceipt = onlyReceipt(pushedFixture.receiptDir, `${pushed.stdout}${pushed.stderr}`);
    expect(pushedReceipt).toMatchObject({ schemaVersion: 2, generationToken: '9001-2' });
    expect(pushedReceipt.outcome).toBe('pushed');
    expect(pushedReceipt.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'data/jobs/by-crawler/acme.json', state: 'present', sha256: expect.stringMatching(/^sha256:/) }),
      expect.objectContaining({ path: 'data/jobs/expired/by-crawler/acme.json', state: 'absent', sha256: null }),
    ]));
    expect(JSON.stringify(pushedReceipt)).not.toContain('super-secret-fixture');
    expect(JSON.stringify(pushedReceipt)).not.toContain('"id":"new"');

    const noopFixture = fixture();
    const noop = runHelper(noopFixture);
    expect(noop.status).toBe(0);
    expect(onlyReceipt(noopFixture.receiptDir, `${noop.stdout}${noop.stderr}`).outcome).toBe('noop');
  });

  it.each([
    ['push_contention', ' ! [rejected] main -> main (fetch first)', 42],
    ['failed', 'fatal: authentication failed', 1],
  ])('records %s without changing the helper exit code', (outcome, failure, expectedExit) => {
    const value = fixture();
    writeFileSync(join(value.repository, 'data/jobs/by-crawler/acme.json'), '[{"id":"new"}]\n');
    const result = runHelper(value, { pushFailure: failure });
    expect(result.status).toBe(expectedExit);
    expect(onlyReceipt(value.receiptDir, `${result.stdout}${result.stderr}`).outcome).toBe(outcome);
  });

  it('is byte-behavior opt-in: disabled mode creates no receipt or receipt warning', () => {
    const value = fixture();
    writeFileSync(join(value.repository, 'data/jobs/by-crawler/acme.json'), '[{"id":"new"}]\n');
    const result = runHelper(value, { enabled: false });
    expect(result.status).toBe(0);
    expect(existsSync(value.receiptDir)).toBe(false);
    expect(`${result.stdout}${result.stderr}`).not.toContain('generation receipt');
  });

  it('never falls back to an unbound receipt when the generation token is missing', () => {
    const value = fixture();
    const result = runHelper(value, { generationToken: '' });

    expect(result.status).toBe(0);
    expect(existsSync(value.receiptDir)).toBe(false);
    expect(`${result.stdout}${result.stderr}`).toContain('generation receipt failed');
  });

  it('keeps push success authoritative when receipt output is unsafe or unwritable', () => {
    const value = fixture();
    writeFileSync(join(value.repository, 'data/jobs/by-crawler/acme.json'), '[{"id":"new"}]\n');
    value.receiptDir = join(value.repository, 'data/jobs/by-crawler');
    const result = runHelper(value);
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('generation receipt');
    expect(execFileSync('git', ['show', 'origin/main:data/jobs/by-crawler/acme.json'], {
      cwd: value.repository,
      encoding: 'utf8',
    })).toContain('new');
  });

  it('rejects a receipt-root symlink escape while preserving the push result', () => {
    const value = fixture();
    writeFileSync(join(value.repository, 'data/jobs/by-crawler/acme.json'), '[{"id":"new"}]\n');
    const generationRoot = join(value.runnerTemp, 'crawler-generation');
    mkdirSync(generationRoot, { recursive: true });
    symlinkSync(join(value.repository, 'data/jobs/by-crawler'), join(generationRoot, 'receipts'));

    const result = runHelper(value);

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('generation receipt');
    expect(existsSync(join(value.repository, 'data/jobs/by-crawler', '01', 'acme.json'))).toBe(false);
  });

  it('keeps legacy v1 compatibility explicit for historical verification', () => {
    const value = fixture();
    const result = runHelper(value);
    expect(result.status).toBe(0);
    const current = onlyReceipt(value.receiptDir, `${result.stdout}${result.stderr}`);
    const { digest: _digest, generationToken: _generationToken, ...legacyPayload } = current;
    const legacy = { ...legacyPayload, schemaVersion: 1 };
    const legacyReceipt = { ...legacy, digest: digestDocument(legacy) };

    expect(validateCrawlerGenerationReceipt(legacyReceipt)).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateCrawlerGenerationReceipt(legacyReceipt, { allowLegacyV1: false })).toEqual({
      valid: false,
      errors: ['legacy_schema_not_allowed'],
    });
    expect(validateCrawlerGenerationReceipt(legacyReceipt, { allowLegacyV1: true })).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('binds deferred commit descriptors to the same generation token', () => {
    const value = fixture();
    const descriptor = createCrawlerGroupCommitDescriptor({
      cwd: value.repository,
      generationToken: '9001-2',
      crawlerId: 'acme',
      commitMessage: 'test descriptor',
      paths: ['data/jobs/by-crawler/acme.json'],
    });

    expect(descriptor).toMatchObject({ schemaVersion: 3, generationToken: '9001-2' });
    expect(validateCrawlerGroupCommitDescriptor(descriptor)).toEqual({ valid: true, errors: [] });
  });
});
