import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  CODEX_FALLBACK_EFFORT,
  CODEX_FALLBACK_MODEL,
  FALLBACK_STATUS,
  FALLBACK_TRIGGER,
  classifyCodexFallbackOutcome,
  decideClaudeCodexFallback,
  formatCodexFallbackEvidence,
  hasSuccessfulCodexFallbackEvidence,
  isValidCodexFallbackEvidence,
  parseCodexFallbackEvidence,
} from '../scripts/ci/claude-codex-fallback.mjs';
import {
  MAX_OUTPUT_BYTES as GH_MAX_OUTPUT_BYTES,
  MAX_REQUEST_BYTES as GH_MAX_REQUEST_BYTES,
  MAX_ACTIVE_CONNECTIONS as GH_MAX_ACTIVE_CONNECTIONS,
  SOCKET_TIMEOUT_MS as GH_SOCKET_TIMEOUT_MS,
  CHILD_TIMEOUT_MS as GH_CHILD_TIMEOUT_MS,
  FORCE_KILL_GRACE_MS as GH_FORCE_KILL_GRACE_MS,
  SHUTDOWN_TIMEOUT_MS as GH_SHUTDOWN_TIMEOUT_MS,
  CORPUS_REPOSITORY,
  resolveGhScope,
  validatePrBodyContract,
  validateGhArgs,
} from '../.github/actions/claude-codex-fallback/gh-bridge-server.mjs';
import {
  MAX_OUTPUT_BYTES as GIT_MAX_OUTPUT_BYTES,
  MAX_REQUEST_BYTES as GIT_MAX_REQUEST_BYTES,
  MAX_ACTIVE_CONNECTIONS as GIT_MAX_ACTIVE_CONNECTIONS,
  SOCKET_TIMEOUT_MS as GIT_SOCKET_TIMEOUT_MS,
  CHILD_TIMEOUT_MS as GIT_CHILD_TIMEOUT_MS,
  FORCE_KILL_GRACE_MS as GIT_FORCE_KILL_GRACE_MS,
  SHUTDOWN_TIMEOUT_MS as GIT_SHUTDOWN_TIMEOUT_MS,
  buildGitNetworkArgs,
  canonicalGitRemote,
  validateGitArgs,
} from '../.github/actions/claude-codex-fallback/git-bridge-server.mjs';
import {
  POSIX_PROCESS_GROUPS,
  childSpawnOptions,
  forceChildTermination,
  isChildRunning,
  requestChildTermination,
} from '../.github/actions/claude-codex-fallback/child-lifecycle.mjs';
import { sanitizeGitConfig } from '../.github/actions/claude-codex-fallback/sanitize-git-config.mjs';

const runtime429 = JSON.stringify([
  {
    type: 'result',
    subtype: 'success',
    is_error: true,
    terminal_reason: 'api_error',
    api_error_status: 429,
  },
]);

const runtime529 = JSON.stringify([
  {
    type: 'result',
    subtype: 'success',
    is_error: true,
    terminal_reason: 'api_error',
    api_error_status: 529,
  },
]);

const maxTurns = JSON.stringify([
  { type: 'result', subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns' },
]);

const workflowNames = [
  'tests.yml',
  'issue-fix.yml',
  'post-merge-followup.yml',
  'issue-decompose.yml',
  'pr-redflag-fixer.yml',
  'pr-redcheck-fixer.yml',
  'needs-human-sweep.yml',
  'lessons-harvester.yml',
  'growth-report.yml',
  'crawler-content-plausibility-audit.yml',
];

const repoRoot = resolve(import.meta.dirname, '..');

describe('decisione Claude → Codex', () => {
  it('preflight con beacon attivo autorizza una sola fallback Codex', () => {
    expect(decideClaudeCodexFallback({ preflightBlocked: true })).toMatchObject({
      shouldFallback: true,
      trigger: FALLBACK_TRIGGER.PREFLIGHT_QUOTA,
      reason: 'preflight-quota',
    });
  });

  it('runtime 429 esplicito autorizza fallback anche se il preflight era verde', () => {
    expect(decideClaudeCodexFallback({ executionRaw: runtime429 })).toMatchObject({
      shouldFallback: true,
      trigger: FALLBACK_TRIGGER.RUNTIME_429,
      reason: 'runtime-429',
    });
  });

  it.each([
    ['529 overloaded', runtime529],
    ['max-turns', maxTurns],
    ['errore generico', JSON.stringify([{ type: 'result', is_error: true, terminal_reason: 'api_error' }])],
    ['testo generico che cita rate limit', JSON.stringify([{ type: 'result', is_error: true, message: 'too many requests; rate limit' }])],
    ['rate-limit event non rifiutato', JSON.stringify([{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }])],
  ])('non usa fallback su %s', (_label, executionRaw) => {
    expect(decideClaudeCodexFallback({ executionRaw })).toMatchObject({
      shouldFallback: false,
      trigger: null,
    });
  });

  it('non usa una seconda fallback dopo che la prima è stata tentata', () => {
    expect(decideClaudeCodexFallback({ preflightBlocked: true, alreadyAttempted: true })).toMatchObject({
      shouldFallback: false,
      reason: 'one-shot-consumed',
    });
    expect(decideClaudeCodexFallback({ executionRaw: runtime429, alreadyAttempted: true })).toMatchObject({
      shouldFallback: false,
      reason: 'one-shot-consumed',
    });
  });
});

describe('contratto di evidenza strutturata', () => {
  it('emette e riparsa il marker con modello/effort esatti', () => {
    const marker = formatCodexFallbackEvidence({
      trigger: FALLBACK_TRIGGER.RUNTIME_429,
      status: FALLBACK_STATUS.SUCCESS,
      detail: 'execution file contained api_error_status=429',
    });
    expect(marker).toContain(`"model":"${CODEX_FALLBACK_MODEL}"`);
    expect(marker).toContain(`"effort":"${CODEX_FALLBACK_EFFORT}"`);
    expect(parseCodexFallbackEvidence(marker)).toMatchObject({
      provider: 'codex',
      model: CODEX_FALLBACK_MODEL,
      effort: CODEX_FALLBACK_EFFORT,
      trigger: FALLBACK_TRIGGER.RUNTIME_429,
      status: FALLBACK_STATUS.SUCCESS,
    });
    expect(hasSuccessfulCodexFallbackEvidence(marker)).toBe(true);
  });

  it('rifiuta evidenza alterata, non strutturata o con modello/effort diversi', () => {
    const marker = formatCodexFallbackEvidence({
      trigger: FALLBACK_TRIGGER.PREFLIGHT_QUOTA,
      status: FALLBACK_STATUS.SUCCESS,
    });
    expect(parseCodexFallbackEvidence(marker.replace(CODEX_FALLBACK_MODEL, 'gpt-5'))).toBeNull();
    expect(parseCodexFallbackEvidence('Codex ha detto ## LGTM')).toBeNull();
    expect(parseCodexFallbackEvidence('<!-- CODEX_FALLBACK_EVIDENCE: {"provider":"codex"} -->')).toBeNull();
  });

  it('valida anche oggetti già deserializzati senza accettare status isolato', () => {
    const valid = {
      provider: 'codex',
      model: CODEX_FALLBACK_MODEL,
      effort: CODEX_FALLBACK_EFFORT,
      trigger: FALLBACK_TRIGGER.PREFLIGHT_QUOTA,
      status: FALLBACK_STATUS.SUCCESS,
    };
    expect(isValidCodexFallbackEvidence(valid)).toBe(true);
    expect(isValidCodexFallbackEvidence({ status: FALLBACK_STATUS.SUCCESS })).toBe(false);
    expect(isValidCodexFallbackEvidence({ ...valid, model: 'gpt-5' })).toBe(false);
  });

  it('un Codex riuscito non viene classificato rate-limited/refunded', () => {
    expect(classifyCodexFallbackOutcome({ status: FALLBACK_STATUS.SUCCESS })).toBe('codex-success');
    expect(classifyCodexFallbackOutcome({ status: FALLBACK_STATUS.SUCCESS })).not.toMatch(/rate-limited|refunded/);
  });

  it('un fallback fallito resta distinto dalla quota Claude', () => {
    const marker = formatCodexFallbackEvidence({
      trigger: FALLBACK_TRIGGER.PREFLIGHT_QUOTA,
      status: FALLBACK_STATUS.FAILURE,
    });
    expect(hasSuccessfulCodexFallbackEvidence(marker)).toBe(false);
    expect(classifyCodexFallbackOutcome({ status: FALLBACK_STATUS.FAILURE })).toBe('codex-failure');
  });
});

describe('validator dei bridge host-side', () => {
  it('nega auth/file-input/debug gh e accetta solo file reali nello scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-gh-validator-'));
    const workspace = join(root, 'workspace');
    const scratch = join(root, 'scratch');
    const outsideAuth = join(root, 'auth.json');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(workspace, 'body.md'), 'body');
    writeFileSync(join(scratch, 'payload.json'), '{}');
    writeFileSync(outsideAuth, 'fixture-secret');
    symlinkSync(outsideAuth, join(scratch, 'auth-link'));
    const context = {
      cwd: workspace,
      workspaceRoot: workspace,
      scratchRoot: scratch,
      repository: 'owner/repo',
      host: 'github.com',
    };
    try {
      expect(validateGhArgs(['auth', 'token'], context)).toMatch(/not permitted/);
      expect(validateGhArgs(['--repo', 'owner/repo', 'auth', 'token'], context)).toMatch(/not permitted/);
      expect(validateGhArgs(['api', '--method', 'GET', '--input', outsideAuth], context)).toMatch(/workspace\/scratch/);
      expect(validateGhArgs(['issue', 'create', '--body-file', join(scratch, 'auth-link')], context)).toMatch(/workspace\/scratch/);
      expect(validateGhArgs(['issue', 'create', '--body-file', join(workspace, 'body.md')], context)).toBe('');
      expect(validateGhArgs(['api', '--method', 'GET', '-F', `body=@${outsideAuth}`], context)).toMatch(/workspace\/scratch/);
      expect(validateGhArgs(['api', '--method', 'GET', '-F', `body=@${join(scratch, 'payload.json')}`], context)).toBe('');
      expect(validateGhArgs(['api', '--template', `@${outsideAuth}`], context)).toMatch(/workspace\/scratch/);
      expect(validateGhArgs(['api', '--template', '{{.number}}'], context)).toBe('');
      expect(validateGhArgs(['pr', 'view', '--verbose'], context)).toMatch(/not permitted/);
      expect(validateGhArgs(['api', '/repos/owner/repo/actions/secrets'], context)).toMatch(/not permitted/);
      expect(validateGhArgs(['issue', 'list', '--repo', 'other/repo'], context)).toMatch(/restricted to owner\/repo/);
      expect(validateGhArgs(['issue', 'list', '--repo=owner/other'], context)).toMatch(/restricted to owner\/repo/);
      expect(validateGhArgs(['issue', 'list', '-R', 'other/repo'], context)).toMatch(/restricted to owner\/repo/);
      expect(validateGhArgs(['issue', 'list', '--hostname', 'evil.example'], context)).toMatch(/hostname is restricted/);
      expect(validateGhArgs(['issue', 'list', '--hostname=github.com'], context)).toBe('');
      expect(validateGhArgs(['api', 'https://evil.example/repos/owner/repo/issues'], context)).toMatch(/relative endpoint/);
      expect(validateGhArgs(['api', 'repos/other/repo/issues'], context)).toMatch(/current repository/);
      expect(validateGhArgs(['api', '/repos/owner/repo/issues'], context)).toBe('');
      expect(validateGhArgs(['api', 'repos/owner/repo/../other'], context)).toMatch(/dot segments/);
      expect(validateGhArgs(['api', 'repos/owner/repo/%2e%2e/other'], context)).toMatch(/percent-encoded/);
      expect(validateGhArgs(['api', 'repos%2Fowner%2Frepo/issues'], context)).toMatch(/percent-encoded/);
      for (const bodyFlag of ['--input', '-F', '--field', '-f', '--raw-field']) {
        const bodyArgs = bodyFlag === '--input' ? [bodyFlag, join(scratch, 'payload.json')] : [bodyFlag, 'state=open'];
        expect(validateGhArgs(['api', 'repos/owner/repo/issues', ...bodyArgs], context)).toMatch(/body flags.*explicit GET/);
        expect(validateGhArgs(['api', 'repos/owner/repo/issues', '--method', 'POST', ...bodyArgs], context)).toMatch(/body flags.*explicit GET/);
        expect(validateGhArgs(['api', 'repos/owner/repo/issues', '--method', 'GET', ...bodyArgs], context)).toBe('');
      }
      expect(validateGhArgs(['api', 'repos/owner/repo/issues', '-Fstate=@' + outsideAuth], context)).toMatch(/body flags.*explicit GET/);
      expect(validateGhArgs(['api', 'repos/owner/repo/issues', '--method', 'GET', '-Fstate=@' + outsideAuth], context)).toMatch(/workspace\/scratch/);
      expect(validateGhArgs(['search', 'code', 'secret'], context)).toMatch(/not permitted/);
      expect(validateGhArgs(['search', 'issues'], context)).toMatch(/explicit current-repository/);
      expect(validateGhArgs(['search', 'issues', '--repo', 'owner/repo'], context)).toBe('');
      expect(validateGhArgs(['search', 'issues', '-R', 'owner/repo'], context)).toBe('');
      expect(validateGhArgs(['run', 'download', '123', '--dir', outsideAuth], context)).toMatch(/download/);
      expect(validateGhArgs(['run', 'cancel', '123'], context)).toMatch(/operation is not permitted/);
      expect(validateGhArgs(['label', 'delete', 'needs-human'], context)).toMatch(/operation is not permitted/);
      expect(validateGhArgs(['issue', 'close', '123'], context)).toMatch(/operation is not permitted/);
      expect(validateGhArgs(['pr', 'merge', '123'], context)).toMatch(/operation is not permitted/);
      expect(validateGhArgs(['issue', 'view', 'https://evil.example/owner/repo/issues/1'], context)).toMatch(/positional URLs/);
      expect(validateGhArgs(['pr', 'view', 'https://github.com/other/repo/pull/1'], context)).toMatch(/positional URLs/);
      expect(validateGhArgs(['pr', 'view', 'https://github.com/owner/repo/pull/1'], context)).toMatch(/positional URLs/);
      expect(validateGhArgs(['api', 'repos/owner/repo/issues', '--method', 'DELETE'], context)).toMatch(/mutations/);
      expect(validateGhArgs(['api', 'repos/owner/repo/issues', '-XPOST'], context)).toMatch(/mutations/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('seleziona server-side solo sito o corpus esatto, con token separati e operazioni corpus ristrette', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-gh-scope-'));
    const workspace = join(root, 'workspace');
    const scratch = join(root, 'scratch');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(scratch, { recursive: true });
    const context = { cwd: workspace, workspaceRoot: workspace, scratchRoot: scratch, host: 'github.com' };
    try {
      const site = resolveGhScope(['issue', 'view'], {
        ...context,
        repository: 'owner/repo',
        siteToken: 'site-secret',
        corpusToken: 'corpus-secret',
      });
      expect(site).toMatchObject({ kind: 'site', repository: 'owner/repo', token: 'site-secret' });

      const corpus = resolveGhScope(['issue', 'create', '--repo', CORPUS_REPOSITORY], {
        ...context,
        repository: 'owner/repo',
        siteToken: 'site-secret',
        corpusToken: 'corpus-secret',
      });
      expect(corpus).toMatchObject({ kind: 'corpus', repository: CORPUS_REPOSITORY, token: 'corpus-secret' });
      expect(validateGhArgs(['issue', 'create', '--repo', CORPUS_REPOSITORY], {
        ...context,
        repository: corpus.repository,
        allowedCommandSet: corpus.allowedCommandSet,
        allowedSubcommandMap: corpus.allowedSubcommandMap,
      })).toBe('');
      expect(validateGhArgs(['pr', 'view', '--repo', CORPUS_REPOSITORY], {
        ...context,
        repository: corpus.repository,
        allowedCommandSet: corpus.allowedCommandSet,
        allowedSubcommandMap: corpus.allowedSubcommandMap,
      })).toMatch(/not permitted/);
      expect(resolveGhScope(['issue', 'view', '--repo', 'other/repo'], {
        ...context,
        repository: 'owner/repo',
        siteToken: 'site-secret',
        corpusToken: 'corpus-secret',
      })).toMatchObject({ error: expect.stringMatching(/restricted/) });
      expect(resolveGhScope(['issue', 'view', '--repo', CORPUS_REPOSITORY], {
        ...context,
        repository: 'owner/repo',
        siteToken: 'site-secret',
      })).toMatchObject({ error: expect.stringMatching(/corpus bridge credential/) });
      expect(resolveGhScope(['api', 'repos/' + CORPUS_REPOSITORY + '/issues', '--repo', CORPUS_REPOSITORY], {
        ...context,
        repository: 'owner/repo',
        siteToken: 'site-secret',
        corpusToken: 'corpus-secret',
      })).toMatchObject({ kind: 'corpus' });
      expect(validateGhArgs(['api', 'repos/' + CORPUS_REPOSITORY + '/issues', '--repo', CORPUS_REPOSITORY], {
        ...context,
        repository: corpus.repository,
        allowedCommandSet: corpus.allowedCommandSet,
        allowedSubcommandMap: corpus.allowedSubcommandMap,
      })).toMatch(/not permitted/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('valida il body delle PR nel bridge senza eseguire codice del workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-pr-body-'));
    const workspace = join(root, 'workspace');
    const scratch = join(root, 'scratch');
    const marker = join(root, 'workspace-executed');
    const validBody = join(scratch, 'valid.md');
    const invalidBody = join(scratch, 'invalid.md');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(workspace, 'gh-pr-body-check.mjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
    writeFileSync(validBody, [
      '## Implementato',
      '- Body validation is enforced in questa PR.',
      '',
      '## Non implementato (ancora)',
      'Nessuno',
      '',
    ].join('\n'));
    writeFileSync(invalidBody, '## Summary\n- missing required sections\n');
    const context = {
      cwd: workspace,
      workspaceRoot: workspace,
      scratchRoot: scratch,
      repository: 'owner/repo',
      host: 'github.com',
    };
    try {
      expect(validatePrBodyContract(readFileSync(validBody, 'utf8')).ok).toBe(true);
      expect(validatePrBodyContract(readFileSync(invalidBody, 'utf8')).ok).toBe(false);
      expect(validateGhArgs(['pr', 'create', '--repo', 'owner/repo', '--body-file', validBody], context)).toBe('');
      expect(validateGhArgs(['pr', 'create', '--repo', 'owner/repo', '--body-file', invalidBody], context)).toMatch(/body contract/);
      expect(validateGhArgs(['pr', 'create', '--repo', 'owner/repo', '--body', 'inline body'], context)).toMatch(/inline/);
      expect(validateGhArgs(['pr', 'create', '--repo', 'owner/repo'], context)).toMatch(/body-file/);
      expect(validateGhArgs(['pr', 'edit', '--repo', 'owner/repo', '--body-file', validBody], context)).toBe('');
      expect(validateGhArgs(['pr', 'edit', '--repo', 'owner/repo', '--body-file', invalidBody], context)).toMatch(/body contract/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('richiede il vero primo comando git e blocca alias/config/path/URL bypass', () => {
    expect(validateGitArgs(['-c', 'alias.x=!cat /tmp/secret', 'push'])).toMatch(/config\/exec\/path/);
    expect(validateGitArgs(['--git-dir=/tmp/other', 'push'])).toMatch(/config\/exec\/path/);
    expect(validateGitArgs(['push', '--upload-pack=cat', 'origin'])).toMatch(/config\/exec\/path/);
    expect(validateGitArgs(['push', 'https://example.invalid/repo.git'])).toMatch(/paths and URLs/);
    expect(validateGitArgs(['push', 'upstream', 'main'])).toMatch(/remote is not permitted/);
    expect(validateGitArgs(['push', '--force-with-lease', 'origin', 'HEAD:refs/heads/main'])).toBe('');
    expect(validateGitArgs(['fetch', 'origin', 'main'])).toBe('');
    expect(validateGitArgs(['ls-remote', 'origin', 'refs/heads/main'])).toBe('');
    const expectedRemote = 'https://github.com/owner/repo.git';
    expect(canonicalGitRemote({ host: 'https://github.com', repository: 'owner/repo' })).toBe(expectedRemote);
    expect(buildGitNetworkArgs(['push', 'origin', 'HEAD:refs/heads/main'], expectedRemote)).toEqual([
      'push', expectedRemote, 'HEAD:refs/heads/main',
    ]);
    expect(buildGitNetworkArgs(['fetch', '--prune'], expectedRemote)).toEqual([
      'fetch', '--prune', expectedRemote,
    ]);
    expect(buildGitNetworkArgs(['push', '--', 'origin', 'main'], expectedRemote)).toEqual([
      'push', '--', expectedRemote, 'main',
    ]);
  });

  it('mantiene limiti espliciti del protocollo e output dei due broker', () => {
    expect(GH_MAX_REQUEST_BYTES).toBe(64 * 1024);
    expect(GH_MAX_OUTPUT_BYTES).toBe(1024 * 1024);
    expect(GH_MAX_ACTIVE_CONNECTIONS).toBe(8);
    expect(GH_SOCKET_TIMEOUT_MS).toBe(30_000);
    expect(GH_CHILD_TIMEOUT_MS).toBe(120_000);
    expect(GH_FORCE_KILL_GRACE_MS).toBe(2_000);
    expect(GH_SHUTDOWN_TIMEOUT_MS).toBe(2_500);
    expect(GIT_MAX_REQUEST_BYTES).toBe(64 * 1024);
    expect(GIT_MAX_OUTPUT_BYTES).toBe(1024 * 1024);
    expect(GIT_MAX_ACTIVE_CONNECTIONS).toBe(8);
    expect(GIT_SOCKET_TIMEOUT_MS).toBe(30_000);
    expect(GIT_CHILD_TIMEOUT_MS).toBe(120_000);
    expect(GIT_FORCE_KILL_GRACE_MS).toBe(2_000);
    expect(GIT_SHUTDOWN_TIMEOUT_MS).toBe(2_500);
  });

  it('forza un child stubborn dopo SIGTERM e non uccide un child già terminato', async () => {
    const signals = [];
    const stubborn = {
      exitCode: null,
      signalCode: null,
      kill(signal) { signals.push(signal); },
    };
    expect(isChildRunning(stubborn)).toBe(true);
    const timer = requestChildTermination(stubborn, { graceMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    clearTimeout(timer);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    stubborn.exitCode = 0;
    expect(isChildRunning(stubborn)).toBe(false);
    expect(requestChildTermination(stubborn, { graceMs: 1 })).toBeNull();
  });

  it('termina il gruppo Git POSIX e il discendente che eredita il marker/token', async () => {
    if (!POSIX_PROCESS_GROUPS) return;
    const root = mkdtempSync(join(tmpdir(), 'codex-process-group-'));
    const marker = join(root, 'marker.txt');
    const pidFile = join(root, 'descendant.pid');
    const nodePath = process.execPath;
    const pathValue = process.env.PATH || '/usr/bin:/bin';
    const waitFor = async (predicate, timeoutMs = 1_500) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('process-group fixture timed out');
    };
    const isAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const descendantScript = [
      "require('node:fs').writeFileSync(process.env.MARKER_FILE, process.env.FIXTURE_TOKEN);",
      'setInterval(() => {}, 1_000);',
    ].join('');
    const parentScript = [
      "const {spawn}=require('node:child_process');",
      "const {writeFileSync}=require('node:fs');",
      `const descendant=spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{stdio:'ignore'});`,
      `writeFileSync(${JSON.stringify(pidFile)},String(descendant.pid));`,
      // Model git exiting while git-remote-https remains in its process group.
      'process.exit(0);',
    ].join('');
    const child = spawn(nodePath, ['-e', parentScript], {
      ...childSpawnOptions({ processGroup: true }),
      env: {
        PATH: pathValue,
        MARKER_FILE: marker,
        FIXTURE_TOKEN: 'fixture-token',
      },
      stdio: 'ignore',
    });
    const childClosed = new Promise((resolve) => child.once('close', resolve));
    try {
      await waitFor(() => {
        if (!existsSync(pidFile) || !existsSync(marker)) return false;
        return readFileSync(marker, 'utf8') === 'fixture-token';
      });
      const descendantPid = Number(readFileSync(pidFile, 'utf8'));
      expect(Number.isInteger(descendantPid)).toBe(true);
      expect(readFileSync(marker, 'utf8')).toBe('fixture-token');
      await childClosed;
      requestChildTermination(child, {
        graceMs: 50,
        processGroup: true,
      });
      await waitFor(() => !isAlive(descendantPid));
      expect(isAlive(descendantPid)).toBe(false);
    } finally {
      forceChildTermination(child, { processGroup: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('sanitizzazione git host-side', () => {
  it('rimuove userinfo URL, pushurl e tutti gli extraheader locali', () => {
    const repo = mkdtempSync(join(tmpdir(), 'codex-git-sanitize-'));
    try {
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('git', ['-C', repo, 'config', '--local', 'remote.origin.url', 'https://x-access-token:fixture-secret@github.com/owner/repo.git']);
      execFileSync('git', ['-C', repo, 'config', '--local', 'remote.origin.pushurl', 'https://oauth2:fixture-secret@github.com/owner/repo.git']);
      execFileSync('git', ['-C', repo, 'config', '--local', 'url.evil.insteadOf', 'https://github.com/owner/repo.git']);
      execFileSync('git', ['-C', repo, 'config', '--local', 'url.evil.pushInsteadOf', 'https://github.com/owner/repo.git']);
      execFileSync('git', ['-C', repo, 'config', '--local', 'http.extraheader', 'AUTHORIZATION: basic fixture-secret']);
      execFileSync('git', ['-C', repo, 'config', '--local', 'http.github.com.extraheader', 'AUTHORIZATION: basic fixture-secret']);
      sanitizeGitConfig({ cwd: repo });
      const cleanConfig = execFileSync('git', ['-C', repo, 'config', '--local', '--list'], { encoding: 'utf8' });
      expect(cleanConfig).not.toContain('fixture-secret');
      expect(cleanConfig).not.toContain('extraheader');
      expect(cleanConfig).not.toMatch(/(?:pushurl|insteadof)/i);
      expect(cleanConfig).toContain('remote.origin.url=https://github.com/owner/repo.git');
      expect(cleanConfig).not.toContain('remote.origin.pushurl');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rimuove proxy, CA/SSL, helper, include e hook/exec config avversaria', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-git-adversarial-'));
    const repo = join(root, 'repo');
    const included = join(root, 'included.gitconfig');
    mkdirSync(repo, { recursive: true });
    writeFileSync(included, '[credential]\n\thelper = !cat /tmp/secret\n[http]\n\tproxy = http://evil.example\n');
    try {
      execFileSync('git', ['init', '-q', repo]);
      const values = [
        ['include.path', included],
        ['core.hooksPath', join(root, 'hooks')],
        ['core.sshCommand', '!cat /tmp/secret'],
        ['core.gitProxy', '!cat /tmp/secret'],
        ['credential.helper', '!cat /tmp/secret'],
        ['http.proxy', 'http://evil.example'],
        ['http.sslVerify', 'false'],
        ['http.sslCAInfo', join(root, 'ca.pem')],
        ['http.sslCAPath', root],
        ['remote.origin.uploadpack', '!cat /tmp/secret'],
        ['remote.origin.receivepack', '!cat /tmp/secret'],
        ['url.evil.insteadOf', 'https://github.com/owner/repo.git'],
        ['url.evil.pushInsteadOf', 'https://github.com/owner/repo.git'],
        ['filter.evil.process', '!cat /tmp/secret'],
        ['diff.evil.textconv', '!cat /tmp/secret'],
        ['merge.evil.driver', '!cat /tmp/secret'],
        ['mergetool.evil.cmd', '!cat /tmp/secret'],
      ];
      for (const [key, value] of values) {
        execFileSync('git', ['-C', repo, 'config', '--local', key, value]);
      }
      sanitizeGitConfig({ cwd: repo });
      const cleanConfig = execFileSync('git', ['-C', repo, 'config', '--local', '--no-includes', '--list'], { encoding: 'utf8' });
      expect(cleanConfig).not.toMatch(/(?:proxy|sslverify|sslca|credential|include|hookspath|sshcommand|gitproxy|uploadpack|receivepack|insteadof|textconv|driver|mergetool)/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('copertura workflow diretti', () => {
  it.each(workflowNames)('%s usa il fallback locale e il secret subscription-only', (workflowName) => {
    const workflow = readFileSync(resolve(repoRoot, '.github', 'workflows', workflowName), 'utf8');
    expect(workflow.match(/uses: \.\/\.github\/actions\/claude-codex-fallback/g)).toHaveLength(1);
    expect(workflow).toContain('preflight_blocked: ${{ steps.quota.outputs.codex_fallback }}');
    expect(workflow).toContain('codex_auth_json: ${{ secrets.CODEX_AUTH_JSON }}');
    expect(workflow).toContain('codex_github_token:');
    expect(workflow).toContain('github_token:');
    expect(workflow).toContain("CODEX_FALLBACK_MODE: '1'");
    expect(workflow).not.toContain('OPENAI_API_KEY');
    expect(workflow).not.toContain('CODEX_ACCESS_TOKEN');
  });

  it('separa l’identità Claude dal token del bridge quando il mint App fallisce soft', () => {
    for (const workflowName of ['tests.yml', 'issue-fix.yml', 'issue-decompose.yml', 'needs-human-sweep.yml', 'growth-report.yml']) {
      const workflow = readFileSync(resolve(repoRoot, '.github', 'workflows', workflowName), 'utf8');
      expect(workflow).toContain('codex_github_token: ${{ env.APP_TOKEN || secrets.GITHUB_TOKEN }}');
    }
    const issueFix = readFileSync(resolve(repoRoot, '.github', 'workflows', 'issue-fix.yml'), 'utf8');
    expect(issueFix).toMatch(/\n\s+github_token: \$\{\{ env\.APP_TOKEN \}\}/);
    expect(issueFix).not.toMatch(/\n\s+github_token: \$\{\{ env\.APP_TOKEN \|\| secrets\.GITHUB_TOKEN \}\}/);
  });

  it('mantiene il contratto di invocazione Codex e cleanup effimero', () => {
    const action = readFileSync(resolve(repoRoot, '.github', 'actions', 'claude-codex-fallback', 'action.yml'), 'utf8');
    const actionDir = resolve(repoRoot, '.github', 'actions', 'claude-codex-fallback');
    const ghBridge = readFileSync(resolve(actionDir, 'gh-bridge-server.mjs'), 'utf8');
    const gitBridge = readFileSync(resolve(actionDir, 'git-bridge-server.mjs'), 'utf8');
    const lifecycle = readFileSync(resolve(actionDir, 'child-lifecycle.mjs'), 'utf8');
    const ghClient = readFileSync(resolve(actionDir, 'gh-bridge-client.mjs'), 'utf8');
    const gitClient = readFileSync(resolve(actionDir, 'git-bridge-client.mjs'), 'utf8');
    const gitSanitizer = readFileSync(resolve(actionDir, 'sanitize-git-config.mjs'), 'utf8');
    const postMerge = readFileSync(resolve(repoRoot, '.github', 'workflows', 'post-merge-followup.yml'), 'utf8');
    expect(action).toContain('anthropics/claude-code-action@9c5ddab2e6d17b83ea679153b31f1d5f023cf636');
    expect(action).not.toContain('anthropics/claude-code-action@v1');
    expect(action).toContain('@openai/codex@0.153.4');
    expect(action).toContain('--ephemeral');
    expect(action).toContain('--model gpt-5.6-luna');
    expect(action).toContain('default_permissions = "codex-fallback"');
    expect(action).toContain('extends = ":workspace"');
    expect(action).toContain('[permissions.codex-fallback.network]');
    expect(action).toContain('enabled = false');
    expect(action).toContain('[permissions.codex-fallback.network.unix_sockets]');
    expect(action).toContain('CODEX_ACTION_PATH: ${{ github.action_path }}');
    expect(action).toContain('codex_corpus_github_token:');
    expect(action).toContain('copy_bridge_file gh-bridge.sh gh');
    expect(action).toContain('copy_bridge_file git-bridge.sh git');
    expect(action).toContain('copy_bridge_file child-lifecycle.mjs child-lifecycle.mjs');
    expect(action).toContain('find_trusted_tool()');
    expect(action).toContain('trusted_roots=()');
    expect(action).toContain('path_components_trusted()');
    expect(action).toContain('node_archive_sha256=');
    expect(action).toContain("[ \"$owner\" = '0' ] || return 1");
    expect(action).toContain("printf '%s\\n' /usr/local/bin /usr/bin /bin");
    expect(action).toContain('npm_realpath=');
    expect(action).toContain('gh_realpath=');
    expect(action).toContain('git_realpath=');
    expect(action).toContain('realpath "$candidate"');
    expect(action).toContain('copy_attested_file "$gh_binary_source" "$gh_host_tools/bin/gh"');
    expect(action).toContain('copy_attested_file "$git_binary_source" "$gh_host_tools/bin/git"');
    expect(action).toContain('copy_attested_file "$git_binary_source" "$git_sandbox_binary"');
    expect(action).toContain('git_host_realpath');
    expect(action).toContain('sha256_file');
    expect(action).toContain('Resolve trusted Node runtime');
    expect(action).toContain('find_trusted_tool()');
    expect(action).toContain('node_sha256=');
    expect(action).toContain('Snapshot Codex fallback runtime before Claude');
    expect(action).not.toContain('gh_host_launcher');
    expect(action).not.toContain('gh-pr-body-check.mjs');
    expect(action).not.toContain('pr-body-check-gate.mjs');
    expect(action).not.toContain('scripts/lib/pr-body-sections-check.mjs');
    expect(action).not.toContain("node -p 'process.execPath'");
    expect(action).toContain('CODEX_REAL_GH="$gh_host_realpath"');
    expect(action).toContain('CODEX_GH_REAL="$gh_sandbox_binary"');
    expect(action).not.toContain('real_gh="$(command -v gh');
    expect(action).toContain('CODEX_GH_CORPUS_AUTH="$codex_corpus_github_auth"');
    expect(action).toContain('CODEX_GH_CORPUS_REPOSITORY="nanakokyobashi-rgb/frontaliere-articles"');
    expect(postMerge).toContain('codex_corpus_github_token: ${{ env.GITHUB_PAT }}');
    expect(action).toContain('codex_install_root=');
    const installStart = action.indexOf('- name: Install pinned Codex CLI');
    const authStart = action.indexOf('- name: Prepare ephemeral Codex subscription auth');
    const codexStart = action.indexOf('- name: Run one Codex subscription fallback');
    expect(installStart).toBeGreaterThan(-1);
    expect(installStart).toBeLessThan(authStart);
    expect(authStart).toBeLessThan(codexStart);
    const installBlock = action.slice(installStart, authStart);
    const codexBlock = action.slice(codexStart, action.indexOf('- name: Record structured Codex fallback evidence'));
    expect(installBlock).toContain('env -i');
    expect(installBlock).toContain('NPM_CONFIG_USERCONFIG=/dev/null');
    expect(installBlock).toContain('TRUSTED_NPM: ${{ steps.trusted_node.outputs.npm_realpath }}');
    expect(installBlock).toContain('"$trusted_node" "$trusted_npm" install --global');
    expect(installBlock).toContain('PATH="$(/usr/bin/dirname "$trusted_npm"):$(/usr/bin/dirname "$trusted_node"):/usr/bin:/bin"');
    expect(installBlock).toContain('npm_config_prefix="$codex_prefix"');
    expect(installBlock).toContain('codex_path="$codex_prefix/bin/codex"');
    expect(installBlock).toContain('case "$codex_path" in');
    expect(installBlock).toContain('codex_version="$("$codex_path" --version 2>/dev/null || true)"');
    expect(installBlock).toContain("[ \"$codex_version\" != 'codex-cli 0.153.4' ]");
    expect(installBlock).not.toContain('command -v codex');
    expect(installBlock).not.toMatch(/^\s+CODEX_HOME:/m);
    expect(installBlock).not.toMatch(/^\s+CODEX_GH_AUTH:/m);
    expect(codexBlock).not.toContain('npm install --global');
    expect(codexBlock).toContain('"$codex_bin" sandbox');
    expect(codexBlock).toContain('"$codex_bin" exec');
    expect(codexBlock).toContain('"$CODEX_BIN" --version');
    expect(action).toContain('CODEX_SANITIZER_GIT="$git_host_realpath"');
    expect(action).toContain('"$node_realpath" "$runtime_snapshot/action/sanitize-git-config.mjs"');
    expect(action).toContain('snapshot_file "$workspace_root/scripts/ci/claude-rate-limit-contract.mjs"');
    expect(action).toContain('git rev-parse --git-dir');
    expect(action).toContain('git rev-parse --git-common-dir');
    expect(action).toContain('"$auth_file_toml" = "deny"');
    expect(action).toContain('"$codex_bin" sandbox -P codex-fallback -C "${PWD:-.}" /bin/sh -c');
    expect(action).toContain('printf probe > "$probe"');
    expect(action).toContain('test "$(dd if="$probe" bs=16 count=1 2>/dev/null)" = probe');
    expect(action).toContain('printf probe > "$common_probe"');
    expect(action).toContain('test "$(dd if="$common_probe" bs=16 count=1 2>/dev/null)" = probe');
    expect(action).toContain('! touch "$common_git_dir/hooks/codex-fallback-probe.$$" 2>/dev/null');
    expect(action).toContain('! dd if="$CODEX_HOME/auth.json" of=/dev/null bs=1 count=1 2>/dev/null');
    expect(action).toContain('tmp_probe="$TMPDIR/codex-fallback-tmp-probe.$$"');
    expect(action).toContain('":root" = "deny"');
    expect(action).toContain('":minimal" = "read"');
    expect(action).toContain('":tmpdir" = "deny"');
    expect(action).toContain('":slash_tmp" = "deny"');
    expect(action).toContain('[permissions.codex-fallback.filesystem.":workspace_roots"]');
    expect(action).toContain('scratch_dir="$CODEX_HOME/scratch"');
    expect(action).toContain('bridge_dir="$scratch_dir/bin"');
    expect(action).toContain('[permissions.codex-fallback.filesystem."$bridge_dir_toml"]');
    expect(action).toContain('"TMPDIR=$scratch_dir"');
    expect(action).toContain('PATH="$bridge_dir:$(/usr/bin/dirname "$node_realpath"):/usr/bin:/bin"');
    expect(action).toContain('gh --version >/dev/null');
    expect(action).toContain('printf probe > "$probe"');
    expect(action).toContain('! dd if="$CODEX_HOME/auth.json" of=/dev/null bs=1 count=1 2>/dev/null');
    expect(action).toContain('--strict-config');
    expect(action).toContain('--ignore-user-config');
    expect(action).toContain('permissions.codex-fallback.filesystem=$codex_filesystem');
    expect(action).toContain('-c model_reasoning_effort=max');
    expect(action).toContain('-c \'default_permissions="codex-fallback"\'');
    expect(action).toContain('-c shell_environment_policy.ignore_default_excludes=false');
    expect(action).toContain('-c "shell_environment_policy.include_only=$codex_env_patterns"');
    expect(action).toContain('env -i "${codex_env[@]}" "$codex_bin" exec');
    expect(action).toContain('CODEX_GH_AUTH: ${{ inputs.codex_github_token }}');
    expect(action).toContain('codex_github_token:');
    expect(action).toContain('CODEX_GH_REPOSITORY="$codex_github_repository"');
    expect(action).toContain('CODEX_GH_HOST="$codex_github_host"');
    expect(action).toContain('CODEX_GH_AUTH="$codex_github_auth"');
    expect(action).toContain('unset CODEX_GH_AUTH');
    expect(action).toContain('auth_output="$(gh auth token 2>/dev/null)"');
    expect(action).toContain('test -z "$auth_output"');
    expect(action).not.toContain('GH_TOKEN="$CODEX_GH_AUTH" exec');
    expect(action).not.toContain('CODEX_GH_AUTH=$CODEX_GH_AUTH');
    expect(action).not.toContain('CODEX_GH_AUTH"]');
    expect(action).toContain('codex_git_remote="${codex_github_host%/}/${codex_github_repository}.git"');
    expect(action).toContain('CODEX_NODE_REAL=$node_realpath');
    expect(action).toContain('"$TRUSTED_NODE" "$RUNTIME_ROOT/ci/claude-codex-fallback.mjs"');
    expect(action).toContain('"$TRUSTED_NODE" -e');
    expect(action).toContain('CODEX_GIT_AUTH="$codex_github_auth"');
    expect(action).toContain('CODEX_REAL_GIT="$git_host_realpath"');
    expect(action).toContain('TRUSTED_GH_SHA256: ${{ steps.trusted_node.outputs.gh_sha256 }}');
    expect(action).toContain('TRUSTED_GIT_SHA256: ${{ steps.trusted_node.outputs.git_sha256 }}');
    expect(action).toContain('verify_trusted_tool gh "$gh_binary_source"');
    expect(action).toContain('verify_trusted_tool git "$git_binary_source"');
    expect(action).toContain('CODEX_GIT_REAL="$git_sandbox_binary"');
    expect(action).toContain('CODEX_GIT_REMOTE="$codex_git_remote"');
    expect(action).toContain('CODEX_GIT_HOST_SCRATCH="$git_bridge_host_scratch"');
    expect(action).toContain('CODEX_GIT_COMMON_DIR="$common_git_dir"');
    expect(gitBridge).toContain('const configEntries = [');
    expect(gitBridge).toContain("['http.proxy', '']");
    expect(gitBridge).toContain("['http.sslVerify', 'true']");
    expect(gitBridge).toContain("['credential.helper', '']");
    expect(gitBridge).toContain("['core.hooksPath', '/dev/null']");
    expect(gitBridge).toContain("['remote.origin.url', expectedRemote]");
    expect(action).toContain('git remote -v | grep -Eiq');
    expect(action).toContain('CODEX_GIT_CLIENT=$bridge_dir/git-client.mjs');
    expect(action).toContain('chmod 700 "$bridge_dir"');
    expect(action).toContain('if: always()');
    expect(action).toContain('chmod 600 "$CODEX_HOME/auth.json"');
    expect(action).toContain('Cleanup ephemeral Codex CLI install');
    expect(action).toContain('fs.rmSync(process.argv[1], {recursive:true, force:true})');
    expect(action).toContain('Never mark this Codex run rate-limited or refunded');
    expect(action).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(action).not.toContain('--sandbox danger-full-access');
    expect(action).not.toContain('--sandbox workspace-write');
    expect(action).not.toContain('sandbox_workspace_write.network_access=true');
    expect(action).not.toContain('--allow-unix-socket');
    expect(action).not.toContain('ignore_default_excludes=true');
    expect(action).not.toContain('codex_github_auth="${GH_TOKEN');
    expect(action).not.toContain('codex_github_auth="${GITHUB_TOKEN');
    expect(action).not.toContain('OPENAI_API_KEY');
    expect(action).not.toContain('CODEX_ACCESS_TOKEN');
    expect(ghBridge).toContain("'auth', 'config', 'alias', 'extension', 'secret'");
    expect(ghBridge).toContain('validatePrBodyContract');
    expect(ghBridge).toContain('validatePrBodyArgs');
    expect(ghBridge).not.toContain('gh-pr-body-check');
    expect(gitSanitizer).toContain('CODEX_SANITIZER_GIT');
    expect(ghBridge).toContain('const blockedApiPath =');
    expect(ghBridge).toContain('MAX_REQUEST_BYTES');
    expect(ghBridge).toContain('MAX_ACTIVE_CONNECTIONS');
    expect(ghBridge).toContain('SOCKET_TIMEOUT_MS');
    expect(ghBridge).toContain('CHILD_TIMEOUT_MS');
    expect(ghBridge).toContain('SHUTDOWN_TIMEOUT_MS');
    expect(ghBridge).toContain('const clients = new Set()');
    expect(ghBridge).toContain('clients.add(client)');
    expect(ghBridge).toContain('for (const client of clients) client.destroy()');
    expect(ghBridge).toContain('hardExitTimer');
    expect(ghBridge).not.toContain('child.killed');
    expect(ghBridge).toContain('net.createServer({ allowHalfOpen: true }');
    expect(ghBridge).toContain("terminateChild('client-disconnected')");
    expect(ghBridge).toContain('requestChildTermination(child)');
    expect(lifecycle).toContain('POSIX_PROCESS_GROUPS');
    expect(lifecycle).toContain('detached: true');
    expect(lifecycle).toContain('process.kill(-pid, signal)');
    expect(lifecycle).toContain('child.kill(signal)');
    expect(gitBridge).toContain('childSpawnOptions({ processGroup: useProcessGroups })');
    expect(gitBridge).toContain('forceChildTermination(child, { processGroup: useProcessGroups })');
    expect(gitBridge).toContain('pendingProcessGroups');
    expect(ghBridge).toContain('GH_HOST: host');
    expect(ghBridge).toContain('GH_REPO: scope.repository');
    expect(ghBridge).toContain('GH_TOKEN: scope.token');
    expect(ghClient).toContain('client.setTimeout(RESPONSE_TIMEOUT_MS');
    expect(gitClient).toContain('client.setTimeout(RESPONSE_TIMEOUT_MS');
    expect(gitBridge).not.toContain('currentOrigin(');
    expect(gitBridge).toContain('buildGitNetworkArgs(args, expectedRemote)');
    expect(gitBridge).toContain('GIT_COMMON_DIR: shadowCommonDir');
    expect(gitBridge).toContain('net.createServer({ allowHalfOpen: true }');
    expect(gitBridge).toContain("terminateChild('client-disconnected')");
    expect(gitBridge).toContain('requestChildTermination(child, {');
    expect(gitBridge).toContain('MAX_REQUEST_BYTES');
    expect(gitBridge).toContain('SHUTDOWN_TIMEOUT_MS');
    expect(gitBridge).toContain('const clients = new Set()');
    expect(gitBridge).toContain('clients.add(client)');
    expect(gitBridge).toContain('for (const client of clients) client.destroy()');
    expect(gitBridge).toContain('hardExitTimer');
    expect(gitBridge).not.toContain('child.killed');
    expect(gitSanitizer).toContain('parseNullRecords');
    expect(gitSanitizer).toContain('http.extraheader');
    expect(gitSanitizer).toContain('--no-includes');
    expect(gitSanitizer).toContain('timeout: 10_000');
    expect(gitSanitizer).toContain('credential');
    expect(gitSanitizer).toContain('hookspath');
    expect(ghBridge).toContain('CODEX_GH_CORPUS_AUTH');
    expect(ghBridge).toContain('CORPUS_REPOSITORY');
    expect(ghBridge).toContain('resolveGhScope(args');
  });

  it('verifica URL, versione e SHA-256 della release Node pinnata', () => {
    const action = readFileSync(resolve(repoRoot, '.github', 'actions', 'claude-codex-fallback', 'action.yml'), 'utf8');
    expect(action).toContain("node_version='v24.21.0'");
    expect(action).toContain('node_archive="node-${node_version}-linux-x64.tar.xz"');
    expect(action).toContain('node_url="https://nodejs.org/dist/${node_version}/${node_archive}"');
    expect(action).toContain("node_archive_sha256='fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6'");
    expect(action).toContain('Linux:x86_64');
    expect(action).toContain('/usr/bin/curl --fail --silent --show-error --location');
    expect(action).toContain('/usr/bin/tar --extract --file "$archive_path"');
    expect(action).toContain('--use-compress-program=/usr/bin/xz');
    expect(action).toContain('node_realpath="$(realpath "$node_root/bin/node")"');
    expect(action).toContain('npm_realpath="$(realpath "$node_root/lib/node_modules/npm/bin/npm-cli.js")"');
    expect(action).not.toContain('RUNNER_TOOL_CACHE');
  });

  it('rifiuta un archivio Node con checksum alterato', () => {
    const action = readFileSync(resolve(repoRoot, '.github', 'actions', 'claude-codex-fallback', 'action.yml'), 'utf8');
    const checksumStart = action.indexOf('        archive_sha256="$(/usr/bin/sha256sum');
    const nodeRootStart = action.indexOf('\n        node_root=', checksumStart);
    expect(checksumStart).toBeGreaterThanOrEqual(0);
    expect(nodeRootStart).toBeGreaterThan(checksumStart);
    const checksumSource = action.slice(checksumStart, nodeRootStart)
      .split('\n')
      .map((line) => line.startsWith('        ') ? line.slice(8) : line)
      .join('\n');
    const root = mkdtempSync(join(tmpdir(), 'codex-node-checksum-'));
    const archivePath = join(root, 'node.tar.xz');
    const checksumTool = join(root, 'sha256sum');
    const fixture = 'pinned node archive fixture\n';
    const expected = createHash('sha256').update(fixture).digest('hex');
    writeFileSync(archivePath, fixture);
    writeFileSync(checksumTool, '#!/bin/sh\nprintf "%s  %s\\n" "$CHECKSUM_FIXTURE" "$2"\n');
    chmodSync(checksumTool, 0o755);
    const runChecksum = (checksum: string) => {
      const source = checksumSource.replaceAll('/usr/bin/sha256sum', checksumTool);
      const script = [
        'set -euo pipefail',
        `archive_path='${archivePath}'`,
        `node_archive_sha256='${checksum}'`,
        source,
      ].join('\n');
      return () => execFileSync('/bin/bash', ['-c', script], {
        encoding: 'utf8',
        env: { CHECKSUM_FIXTURE: expected },
      });
    };
    try {
      expect(runChecksum(expected)).not.toThrow();
      expect(runChecksum('0000000000000000000000000000000000000000000000000000000000000000')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function hostResolverSource() {
    const action = readFileSync(resolve(repoRoot, '.github/actions/claude-codex-fallback/action.yml'), 'utf8');
    const start = action.indexOf('        trusted_roots=()');
    const end = action.indexOf('        sha256_file()', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return action.slice(start, end).split('\n').map((line) => line.slice(8)).join('\n');
  }

  it('rifiuta shim gh/git nel PATH e trova i binari di sistema', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-host-trust-'));
    const evil = join(root, 'evil');
    mkdirSync(evil);
    for (const tool of ['gh', 'git']) {
      writeFileSync(join(evil, tool), '#!/bin/sh\nexit 97\n');
      chmodSync(join(evil, tool), 0o755);
    }
    try {
      const output = execFileSync('/bin/bash', ['-c', [
        'set -euo pipefail',
        `realpath() { "$NODE_TEST" -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$@"; }`,
        'tr_cmd=/usr/bin/tr',
        'workspace_root=/unused/workspace; action_path=/unused/action; runner_temp=/unused/temp',
        hostResolverSource(),
        'for tool in gh git; do',
        '  selected="$(find_trusted_tool "$tool" || true)"',
        '  case "$selected" in "$EVIL"/*) exit 1 ;; esac',
        'done',
        // git is present in /usr/bin on both macOS and Ubuntu, even when PATH is poisoned.
        'find_trusted_tool git',
      ].join('\n')], { encoding: 'utf8', env: { PATH: evil, EVIL: evil, NODE_TEST: process.execPath } });
      expect(output.trim()).toBe('/usr/bin/git');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accetta 0755 root-owned e rifiuta permessi scrivibili o owner runner', () => {
    // Mock stat only: run the actual ownership and octal-mode predicate on /usr/bin/git.
    const source = hostResolverSource();
    const run = (mode: string, owner: string) => spawnSync('/bin/bash', ['-c', [
      'set -euo pipefail',
      `realpath() { "$NODE_TEST" -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$@"; }`,
      source,
      'stat_mode() { printf "%s" "$FIXTURE_MODE"; }',
      'stat_owner() { printf "%s" "$FIXTURE_OWNER"; }',
      'path_components_trusted /usr/bin/git',
    ].join('\n')], { env: { FIXTURE_MODE: mode, FIXTURE_OWNER: owner, NODE_TEST: process.execPath } }).status;
    expect(run('755', '0')).toBe(0);
    expect(run('775', '0')).not.toBe(0);
    expect(run('757', '0')).not.toBe(0);
    expect(run('755', '1001')).not.toBe(0);
    expect(run('invalid', '0')).not.toBe(0);
  });

  it('propaga ogni failure o skip inatteso dei passi di decisione', () => {
    const action = readFileSync(resolve(repoRoot, '.github', 'actions', 'claude-codex-fallback', 'action.yml'), 'utf8');
    expect(action).toContain('runtime_snapshot_outcome="${{ steps.runtime_snapshot.outcome }}"');
    expect(action).toContain('preflight_outcome="${{ steps.preflight.outcome }}"');
    expect(action).toContain('runtime_outcome="${{ steps.runtime.outcome }}"');
    expect(action).toContain('finalize_outcome="${{ steps.finalize.outcome }}"');
    const preserveStart = action.indexOf('    - name: Preserve primary/fallback outcome');
    const runStart = action.indexOf('      run: |\n', preserveStart);
    expect(preserveStart).toBeGreaterThanOrEqual(0);
    expect(runStart).toBeGreaterThan(preserveStart);
    const preserveScript = action.slice(runStart + '      run: |\n'.length)
      .split('\n')
      .map((line) => line.startsWith('        ') ? line.slice(8) : line)
      .join('\n');
    const runPreserve = (overrides: Record<string, string> = {}) => {
      const values: Record<string, string> = {
        trusted_node: 'success',
        runtime_snapshot: 'success',
        preflight: 'success',
        runtime: 'success',
        finalize: 'success',
        fallback_used: 'false',
        fallback_success: 'false',
        claude: 'success',
        ...overrides,
      };
      const expressions: Record<string, string> = {
        '${{ steps.trusted_node.outcome }}': values.trusted_node,
        '${{ steps.runtime_snapshot.outcome }}': values.runtime_snapshot,
        '${{ steps.preflight.outcome }}': values.preflight,
        '${{ steps.runtime.outcome }}': values.runtime,
        '${{ steps.finalize.outcome }}': values.finalize,
        '${{ steps.finalize.outputs.fallback_used }}': values.fallback_used,
        '${{ steps.finalize.outputs.fallback_success }}': values.fallback_success,
        '${{ steps.claude.outcome }}': values.claude,
      };
      let script = preserveScript;
      for (const [expression, value] of Object.entries(expressions)) {
        script = script.replaceAll(expression, value);
      }
      try {
        execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8' });
        return 0;
      } catch (error) {
        return (error as { status?: number }).status ?? 1;
      }
    };
    expect(runPreserve()).toBe(0);
    for (const step of ['runtime_snapshot', 'preflight', 'runtime', 'finalize']) {
      for (const outcome of ['failure', 'skipped']) {
        expect(runPreserve({ [step]: outcome })).not.toBe(0);
      }
    }
    expect(runPreserve({ trusted_node: 'failure' })).not.toBe(0);
    expect(runPreserve({ fallback_used: 'true', fallback_success: 'true' })).toBe(0);
    expect(runPreserve({ fallback_used: 'true', fallback_success: 'false' })).not.toBe(0);
  });

  it('esegue il preflight dal runtime snapshot minimale senza import mancanti', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-runtime-snapshot-'));
    const snapshotCi = join(root, 'ci');
    const output = join(root, 'github-output');
    mkdirSync(snapshotCi, { recursive: true });
    writeFileSync(output, '');
    const runtimeFiles = [
      'claude-codex-fallback.mjs',
      'claude-rate-limit.mjs',
      'claude-rate-limit-contract.mjs',
    ];
    try {
      for (const name of runtimeFiles) {
        copyFileSync(resolve(repoRoot, 'scripts', 'ci', name), join(snapshotCi, name));
      }
      const snapshotEntry = realpathSync(join(snapshotCi, 'claude-codex-fallback.mjs'));
      const stdout = execFileSync(process.execPath, [snapshotEntry], {
        encoding: 'utf8',
        env: {
          PREFLIGHT_BLOCKED: 'true',
          FALLBACK_ATTEMPTED: 'false',
          GITHUB_OUTPUT: output,
        },
      });
      expect(stdout).toContain('fallback=true');
      expect(readFileSync(output, 'utf8')).toContain('trigger=preflight-quota');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
