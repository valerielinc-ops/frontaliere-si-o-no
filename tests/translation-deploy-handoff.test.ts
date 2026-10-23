import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_TRANSLATION_PENDING_TTL_MS,
  readTranslationDeployHandoff,
  translationDeployHandoffMatches,
  writeTranslationDeployHandoff,
} from '../scripts/ci/translation-deploy-handoff.mjs';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('translation deploy handoff admission', () => {
  it('holds a fresh pending tree, refreshes it for a new run, and admits terminal fallback/complete trees', () => {
    const root = temporaryDirectory('translation-handoff-');
    const filePath = join(root, 'handoff.json');

    expect(DEFAULT_TRANSLATION_PENDING_TTL_MS).toBe(2 * 60 * 60 * 1000);
    expect(readTranslationDeployHandoff({ filePath })).toMatchObject({ state: 'unmarked', admitted: true });
    expect(writeTranslationDeployHandoff({ state: 'pending', filePath, runId: '101', runAttempt: '1' })).toBe(true);
    expect(readTranslationDeployHandoff({ filePath })).toMatchObject({ state: 'pending', admitted: false });
    expect(writeTranslationDeployHandoff({ state: 'pending', filePath, runId: '101', runAttempt: '1' })).toBe(false);
    expect(writeTranslationDeployHandoff({ state: 'pending', filePath, runId: '101', runAttempt: '2' })).toBe(true);
    expect(writeTranslationDeployHandoff({ state: 'fallback', filePath, runId: '101', runAttempt: '2' })).toBe(true);
    expect(readTranslationDeployHandoff({ filePath })).toMatchObject({ state: 'fallback', admitted: true });
    expect(writeTranslationDeployHandoff({ state: 'complete', filePath, runId: '103', runAttempt: '1' })).toBe(true);
    expect(readTranslationDeployHandoff({ filePath })).toMatchObject({ state: 'complete', admitted: true });
    expect(writeTranslationDeployHandoff({ state: 'pending', filePath, runId: '104', runAttempt: '1' })).toBe(true);
    expect(readTranslationDeployHandoff({ filePath })).toMatchObject({ state: 'pending', admitted: false });
    expect(writeTranslationDeployHandoff({ state: 'complete', filePath, runId: '104', runAttempt: '1' })).toBe(true);
    expect(writeTranslationDeployHandoff({ state: 'fallback', filePath, runId: '104', runAttempt: '1' })).toBe(false);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({ state: 'complete', runId: '104', runAttempt: 1 });
    expect(writeTranslationDeployHandoff({ state: 'pending', filePath, runId: '104', runAttempt: '2' })).toBe(true);
    expect(readTranslationDeployHandoff({ filePath })).toMatchObject({ state: 'pending', runId: '104', runAttempt: 2 });
  });

  it('admits a pending marker only after its bounded TTL and fails closed without a timestamp', () => {
    const root = temporaryDirectory('translation-handoff-expiry-');
    const filePath = join(root, 'handoff.json');
    const nowMs = Date.now();
    writeFileSync(filePath, JSON.stringify({
      state: 'pending',
      updatedAt: new Date(nowMs - DEFAULT_TRANSLATION_PENDING_TTL_MS - 1).toISOString(),
      runId: '201',
    }), 'utf8');
    expect(readTranslationDeployHandoff({ filePath, nowMs })).toMatchObject({
      state: 'pending',
      admitted: true,
      expired: true,
    });
    writeFileSync(filePath, '{"state":"pending","runId":"202"}\n', 'utf8');
    expect(readTranslationDeployHandoff({ filePath, nowMs })).toMatchObject({ state: 'invalid', admitted: false });
  });

  it('fails closed for malformed or unknown marker content', () => {
    const root = temporaryDirectory('translation-handoff-invalid-');
    const filePath = join(root, 'handoff.json');
    writeFileSync(filePath, '{"state":"half-written"}\n', 'utf8');
    expect(readTranslationDeployHandoff({ filePath })).toMatchObject({ state: 'invalid', admitted: false });
    writeFileSync(filePath, '{not-json}\n', 'utf8');
    expect(readTranslationDeployHandoff({ filePath })).toMatchObject({ state: 'invalid', admitted: false });
  });

  it('releases only a pending marker owned by the expected recovery run', () => {
    const root = temporaryDirectory('translation-handoff-cas-');
    const filePath = join(root, 'handoff.json');
    const pending = { state: 'pending', runId: '123', runAttempt: 2, updatedAt: '2026-10-22T12:00:00.000Z' };
    writeFileSync(filePath, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');

    expect(writeTranslationDeployHandoff({
      state: 'fallback', filePath, runId: '123', runAttempt: '2', expectedRunId: '123', expectedRunAttempt: '2',
    })).toBe(true);
    expect(readTranslationDeployHandoff({ filePath })).toMatchObject({ state: 'fallback', runId: '123', runAttempt: 2 });

    const newerRun = { ...pending, runId: '456' };
    writeFileSync(filePath, `${JSON.stringify(newerRun, null, 2)}\n`, 'utf8');
    const before = readFileSync(filePath, 'utf8');
    expect(writeTranslationDeployHandoff({
      state: 'fallback', filePath, runId: '123', runAttempt: '2', expectedRunId: '123', expectedRunAttempt: '2',
    })).toBe(false);
    expect(readFileSync(filePath, 'utf8')).toBe(before);

    const newerAttempt = { ...pending, runAttempt: 3 };
    writeFileSync(filePath, `${JSON.stringify(newerAttempt, null, 2)}\n`, 'utf8');
    const beforeNewerAttempt = readFileSync(filePath, 'utf8');
    expect(writeTranslationDeployHandoff({
      state: 'fallback', filePath, runId: '123', runAttempt: '2', expectedRunId: '123', expectedRunAttempt: '2',
    })).toBe(false);
    expect(readFileSync(filePath, 'utf8')).toBe(beforeNewerAttempt);
    expect(writeTranslationDeployHandoff({
      state: 'fallback', filePath, runId: '123', runAttempt: '3', expectedRunId: '123', expectedRunAttempt: '3',
    })).toBe(true);

    writeFileSync(filePath, `${JSON.stringify({ ...pending, state: 'complete' }, null, 2)}\n`, 'utf8');
    expect(writeTranslationDeployHandoff({
      state: 'fallback', filePath, runId: '123', runAttempt: '2', expectedRunId: '123', expectedRunAttempt: '2',
    })).toBe(false);
    expect(() => writeTranslationDeployHandoff({
      state: 'fallback', filePath, runId: '123', runAttempt: '2', expectedRunId: '456', expectedRunAttempt: '2',
    })).toThrow(/match GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT/u);

    writeFileSync(filePath, '{not-json}\n', 'utf8');
    expect(() => writeTranslationDeployHandoff({
      state: 'fallback', filePath, runId: '123', runAttempt: '2', expectedRunId: '123', expectedRunAttempt: '2',
    })).toThrow(/invalid translation handoff marker/u);
  });

  it('refuses compare-and-set and matching when a valid owner has an invalid full marker schema', () => {
    const root = temporaryDirectory('translation-handoff-bad-schema-');
    const filePath = join(root, 'handoff.json');
    writeFileSync(filePath, JSON.stringify({ state: 'pending', runId: '123', runAttempt: 2 }), 'utf8');

    expect(readTranslationDeployHandoff({ filePath })).toMatchObject({ state: 'invalid', admitted: false });
    expect(() => writeTranslationDeployHandoff({
      state: 'fallback', filePath, runId: '123', runAttempt: '2', expectedRunId: '123', expectedRunAttempt: '2',
    })).toThrow(/invalid translation handoff marker/u);
    expect(() => translationDeployHandoffMatches({
      state: 'pending', runId: '123', runAttempt: '2', filePath,
    })).toThrow(/invalid translation handoff marker/u);
  });

  it('checks the local marker and distinguishes a mismatch from an unreadable marker', () => {
    const root = temporaryDirectory('translation-handoff-match-');
    const filePath = join(root, 'handoff.json');
    writeFileSync(filePath, JSON.stringify({
      state: 'pending', runId: '123', runAttempt: 2, updatedAt: '2026-10-22T12:00:00.000Z',
    }), 'utf8');

    expect(translationDeployHandoffMatches({ state: 'pending', runId: '123', runAttempt: '2', filePath })).toBe(true);
    expect(translationDeployHandoffMatches({ state: 'pending', runId: '123', runAttempt: '1', filePath })).toBe(false);
    expect(translationDeployHandoffMatches({ state: 'pending', runId: '456', runAttempt: '2', filePath })).toBe(false);
    expect(translationDeployHandoffMatches({ state: 'pending', runId: '123', runAttempt: '2', filePath: join(root, 'missing.json') })).toBe(false);

    const cli = resolve('scripts/ci/translation-deploy-handoff.mjs');
    const mismatch = spawnSync(process.execPath, [cli, '--matches', 'pending', '456', '2', '--file', filePath], {
      cwd: resolve('.'), encoding: 'utf8',
    });
    expect(mismatch.status).toBe(1);
    const staleAttempt = spawnSync(process.execPath, [cli, '--matches', 'pending', '123', '1', '--file', filePath], {
      cwd: resolve('.'), encoding: 'utf8',
    });
    expect(staleAttempt.status).toBe(1);
    writeFileSync(filePath, '{not-json}\n', 'utf8');
    const invalid = spawnSync(process.execPath, [cli, '--matches', 'pending', '123', '2', '--file', filePath], {
      cwd: resolve('.'), encoding: 'utf8',
    });
    expect(invalid.status).toBe(2);
    writeFileSync(filePath, JSON.stringify({ state: 'pending', runId: '123', runAttempt: 2, updatedAt: 'invalid' }), 'utf8');
    const invalidSchema = spawnSync(process.execPath, [cli, '--matches', 'pending', '123', '2', '--file', filePath], {
      cwd: resolve('.'), encoding: 'utf8',
    });
    expect(invalidSchema.status).toBe(2);
  });

  it('wires pending/complete/fallback around every translation publisher', () => {
    const files = [
      '.github/workflows/translate-pending-logic.yml',
      '.github/workflows/translate-pending.yml',
      '.github/corpus-workflows/translate-pending.yml',
    ].map((file) => readFileSync(resolve(file), 'utf8'));
    for (const workflow of files) {
      expect(workflow).toContain('TRANSLATION_DEPLOY_HANDOFF_STATE');
      expect(workflow).toContain('TRANSLATION_DEPLOY_HANDOFF_STATE=complete');
      expect(workflow).toContain('TRANSLATION_DEPLOY_HANDOFF_STATE=fallback');
      expect(workflow).toContain('Release translation deploy fallback after a failed phase');
      expect(workflow).toContain('data/translation-deploy-handoff.json');
      expect(workflow).toContain('validate-translation-completeness.mjs');
      expect(workflow).toContain('TRANSLATION_DEPLOY_HANDOFF_EXPECTED_RUN_ATTEMPT');
      expect(workflow).toContain('translate_timeout_recovery:');
    }
    const deploy = readFileSync(resolve('.github/workflows/deploy.yml'), 'utf8');
    expect(deploy).toContain('translation-deploy-handoff.mjs');
    expect(deploy).toContain('Reject an incomplete translation tree');
    expect(readFileSync(resolve('scripts/ci/rearm-deploy-build.mjs'), 'utf8'))
      .toContain('readTranslationDeployHandoff');
  });
});
