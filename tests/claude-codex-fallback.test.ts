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
import YAML from 'yaml';
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
  isMutatingGhArgs,
  materializeConditionalBodyPatch,
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
  isMutatingGitArgs,
  resolveCurrentWorkBranchRef,
  validateGitArgs,
} from '../.github/actions/claude-codex-fallback/git-bridge-server.mjs';
import {
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

const mutatingBridgeWorkflows = [
  'issue-fix.yml',
  'pr-redflag-fixer.yml',
  'pr-redcheck-fixer.yml',
  'issue-decompose.yml',
  'needs-human-sweep.yml',
  'growth-report.yml',
  'tests.yml',
  'post-merge-followup.yml',
  'crawler-content-plausibility-audit.yml',
  'lessons-harvester.yml',
];

function jobBlockContaining(workflow: string, needle: string): string {
  const jobsStart = workflow.indexOf('\njobs:\n');
  if (jobsStart < 0) return '';
  const lines = workflow.slice(jobsStart + '\njobs:\n'.length).split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^  [A-Za-z0-9_-]+:\s*$/u.test(line)) {
      if (current.length > 0) blocks.push(current.join('\n'));
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks.find((block) => block.includes(needle)) || '';
}

type WorkflowStep = {
  uses?: unknown;
  with?: Record<string, unknown>;
};

function codexFallbackWith(workflow: string): Record<string, unknown> {
  const parsed = YAML.parse(workflow) as {
    jobs?: Record<string, { steps?: WorkflowStep[] }>;
  };
  for (const job of Object.values(parsed.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step.uses === './.github/actions/claude-codex-fallback' && step.with) {
        return step.with;
      }
    }
  }
  return {};
}

const highConcurrencyReviewWorkflows = new Set([
  'tests.yml',
  'pr-redflag-fixer.yml',
  'pr-redcheck-fixer.yml',
]);

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

  it('registra l\'effort per tier e accetta solo l\'insieme chiuso', () => {
    const high = formatCodexFallbackEvidence({
      trigger: FALLBACK_TRIGGER.PREFLIGHT_QUOTA,
      status: FALLBACK_STATUS.SUCCESS,
      effort: 'high',
    });
    expect(parseCodexFallbackEvidence(high)).toMatchObject({ effort: 'high' });
    expect(parseCodexFallbackEvidence(high.replace('"effort":"high"', '"effort":"low"'))).toBeNull();
    expect(() => formatCodexFallbackEvidence({
      trigger: FALLBACK_TRIGGER.PREFLIGHT_QUOTA,
      status: FALLBACK_STATUS.SUCCESS,
      effort: 'medium',
    })).toThrow(/effort/);
    const byDefault = formatCodexFallbackEvidence({
      trigger: FALLBACK_TRIGGER.PREFLIGHT_QUOTA,
      status: FALLBACK_STATUS.SUCCESS,
    });
    expect(parseCodexFallbackEvidence(byDefault)).toMatchObject({ effort: CODEX_FALLBACK_EFFORT });
    expect(CODEX_FALLBACK_EFFORT).toBe('max');
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
    writeFileSync(join(scratch, 'payload.json'), '## Implementato\n\n- body valido in questa PR\n\n## Non implementato (ancora)\n\nNessuno\n');
    writeFileSync(join(scratch, 'invalid-body.md'), 'not a PR body');
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
      expect(validateGhArgs(['api', '--include', 'repos/owner/repo/pulls/123'], context)).toBe('');
      expect(validateGhArgs(['api', '--include', 'repos/owner/repo/issues'], context)).toMatch(/gh flag is not permitted/);
      expect(validateGhArgs([
        'api', 'repos/owner/repo/pulls/123', '--method', 'PATCH',
        '--header', 'If-Match: W/"v1"', '--field', `body=@${join(scratch, 'payload.json')}`,
      ], context)).toBe('');
      expect(validateGhArgs([
        'api', 'repos/owner/repo/pulls/123', '--method', 'PATCH',
        '--header', 'If-Match: W/"v1"', '--field', `body=@${outsideAuth}`,
      ], context)).toMatch(/workspace\/scratch/);
      expect(validateGhArgs([
        'api', 'repos/owner/repo/pulls/123', '--method', 'PATCH',
        '--header', 'If-Match: W/"v1"', '--field', `body=@${join(scratch, 'invalid-body.md')}`,
      ], context)).toMatch(/body contract/);
      expect(validateGhArgs([
        'api', 'repos/owner/repo/pulls/123', '--method', 'PATCH',
        '--header', 'If-Match: W/"v1"', '--input', '-',
      ], context)).toMatch(/body flags.*explicit GET/);
      expect(validateGhArgs([
        'api', 'repos/owner/repo/pulls/123', '--method', 'PATCH',
        '--header', 'If-Match: W/"v1"', '--field', `body=@${join(scratch, 'payload.json')}`, '--field', 'body=x',
      ], context)).toMatch(/body flags.*explicit GET/);
      expect(validateGhArgs([
        'api', 'repos/owner/repo/pulls/123', '--method', 'PATCH',
        '--header', 'Authorization: token nope', '--field', `body=@${join(scratch, 'payload.json')}`,
      ], context)).toMatch(/body flags.*explicit GET/);
      expect(validateGhArgs([
        'api', 'repos/owner/repo/pulls/123', '--method', 'PATCH',
        '--header', 'If-Match: *', '--field', `body=@${join(scratch, 'payload.json')}`,
      ], context)).toMatch(/body flags.*explicit GET/);
      expect(validateGhArgs([
        'api', 'repos/owner/repo/issues/123', '--method', 'PATCH',
        '--header', 'If-Match: W/"v1"', '--field', `body=@${join(scratch, 'payload.json')}`,
      ], context)).toMatch(/body flags.*explicit GET/);
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

  it('materializza il body CAS in un file host-private contro la race locale', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-gh-body-cas-'));
    const workspace = join(root, 'workspace');
    const scratch = join(root, 'scratch');
    const source = join(scratch, 'body.md');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(scratch, { recursive: true });
    const validBody = '## Implementato\n\n- body fissato in questa PR\n\n## Non implementato (ancora)\n\nNessuno\n';
    writeFileSync(source, validBody, 'utf8');
    let cleanup = () => {};
    try {
      const prepared = materializeConditionalBodyPatch([
        'api', 'repos/owner/repo/pulls/123', '--method', 'PATCH',
        '--header', 'If-Match: W/"v1"', '--field', `body=@${source}`,
      ], 1, {
        repository: 'owner/repo',
        cwd: workspace,
        allowedRoots: [realpathSync(workspace), realpathSync(scratch)],
      });
      cleanup = prepared.cleanup;
      writeFileSync(source, 'not a PR body', 'utf8');
      expect(prepared.args.some((arg) => arg === `body=@${prepared.bodyPath}`)).toBe(true);
      expect(readFileSync(prepared.bodyPath, 'utf8')).toBe(validBody);
      cleanup();
      expect(() => readFileSync(prepared.bodyPath, 'utf8')).toThrow();
    } finally {
      cleanup();
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

      const corpusCheckout = resolveGhScope(['issue', 'create', '--repo', CORPUS_REPOSITORY], {
        ...context,
        repository: CORPUS_REPOSITORY,
        siteToken: 'site-secret',
        corpusToken: 'corpus-secret',
      });
      expect(corpusCheckout).toMatchObject({ kind: 'corpus', repository: CORPUS_REPOSITORY, token: 'corpus-secret' });
      const implicitCorpus = resolveGhScope(['issue', 'list'], {
        ...context,
        repository: CORPUS_REPOSITORY,
        siteToken: 'site-secret',
        corpusToken: 'corpus-secret',
      });
      expect(implicitCorpus).toMatchObject({
        kind: 'site',
        repository: CORPUS_REPOSITORY,
        token: 'site-secret',
      });
      expect(implicitCorpus.allowedCommandSet).toContain('pr');
      expect(resolveGhScope(['pr', 'view', '--repo', 'owner/repo'], {
        ...context,
        repository: CORPUS_REPOSITORY,
        siteToken: 'site-secret',
        corpusToken: 'corpus-secret',
      })).toMatchObject({ error: expect.stringMatching(/restricted/) });
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
      const currentCorpus = resolveGhScope(['pr', 'comment'], {
        ...context,
        repository: CORPUS_REPOSITORY,
        siteToken: 'site-secret',
        corpusToken: 'corpus-secret',
      });
      expect(currentCorpus).toMatchObject({
        kind: 'site',
        repository: CORPUS_REPOSITORY,
        token: 'site-secret',
      });
      expect(validateGhArgs(['pr', 'comment'], {
        ...context,
        repository: currentCorpus.repository,
        allowedCommandSet: currentCorpus.allowedCommandSet,
        allowedSubcommandMap: currentCorpus.allowedSubcommandMap,
      })).toBe('');
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
      expect(validateGhArgs(['api', 'repos/' + CORPUS_REPOSITORY + '/issues', '--repo', CORPUS_REPOSITORY, '--method', 'GET'], {
        ...context,
        repository: corpus.repository,
        allowedCommandSet: corpus.allowedCommandSet,
        allowedSubcommandMap: corpus.allowedSubcommandMap,
      })).toBe('');
      expect(validateGhArgs(['api', 'repos/' + CORPUS_REPOSITORY + '/issues', '--repo', CORPUS_REPOSITORY, '--method', 'POST'], {
        ...context,
        repository: corpus.repository,
        allowedCommandSet: corpus.allowedCommandSet,
        allowedSubcommandMap: corpus.allowedSubcommandMap,
      })).toMatch(/mutations/);
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
      expect(validatePrBodyContract([
        '## Implementato',
        '- Body validation is enforced in questa PR.',
        '',
        '## Non implementato (ancora)',
        '- Il finding è un falso positivo.',
        '',
      ].join('\n')).violations).toContain('decision deferrals require concrete Motivo and Prossimo passo');
      expect(validatePrBodyContract([
        '## Implementato',
        '- Body validation is enforced in questa PR.',
        '',
        '## Non implementato (ancora)',
        '- Il finding non è un falso positivo: va sistemato nel follow-up.',
        '',
      ].join('\n')).ok).toBe(true);
      expect(validatePrBodyContract([
        '## Implementato',
        '- Body validation is enforced in questa PR.',
        '',
        '## Non implementato (ancora)',
        '- Il finding è un falso positivo. **Motivo:** il parser ha un contratto diverso. **Prossimo passo:** verificare il fixture condiviso.',
        '',
      ].join('\n')).ok).toBe(true);
      expect(validatePrBodyContract([
        '## Implementato',
        '- Body validation is enforced in questa PR.',
        '',
        '## Non implementato (ancora)',
        '- Il finding è un falso positivo. **Motivo:** **TBD**. **Prossimo passo:** verificare il fixture condiviso.',
        '',
      ].join('\n')).violations).toContain('decision deferrals require concrete Motivo and Prossimo passo');
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

  it('richiede il vero primo comando git e applica la policy fail-closed dei push', () => {
    expect(validateGitArgs(['-c', 'alias.x=!cat /tmp/secret', 'push'])).toMatch(/config\/exec\/path/);
    expect(validateGitArgs(['--git-dir=/tmp/other', 'push'])).toMatch(/config\/exec\/path/);
    expect(validateGitArgs(['push', '--upload-pack=cat', 'origin'])).toMatch(/config\/exec\/path/);
    expect(validateGitArgs(['push', 'https://example.invalid/repo.git'])).toMatch(/paths and URLs/);
    expect(validateGitArgs(['push', 'upstream', 'main'])).toMatch(/remote is not permitted/);
    const workBranch = 'codex/fallback-bridge-test';
    const workBranchRef = `refs/heads/${workBranch}`;
    for (const flag of [
      '--all',
      '--force',
      '--force=refs/heads/other',
      '-f',
      '--force-with-lease',
      '--force-with-lease=refs/heads/other',
      '--delete',
      '--delete=refs/heads/other',
      '-d',
      '--mirror',
      '--mirror=refs/heads/other',
    ]) {
      expect(validateGitArgs(['push', flag, 'origin', `HEAD:refs/heads/${workBranch}`])).toMatch(/Git push option is not permitted/);
    }
    for (const refspec of [
      'HEAD:refs/heads/other',
      'HEAD:other',
      `${workBranch}:refs/heads/other`,
      `${workBranchRef}:refs/heads/other`,
      `other:${workBranchRef}`,
      `refs/heads/other:${workBranchRef}`,
      'a'.repeat(40),
      `${'a'.repeat(40)}:${workBranchRef}`,
      'v1.2.3',
      `v1.2.3:${workBranchRef}`,
      `refs/tags/v1.2.3:${workBranchRef}`,
      `refs/remotes/origin/${workBranch}:${workBranchRef}`,
      'refs/tags/v1.2.3',
      'HEAD:refs/heads/main',
      'HEAD:refs/tags/release',
      'HEAD:refs/remotes/origin/work',
      ':refs/heads/work',
      'HEAD:refs/heads/work:',
      '+HEAD:refs/heads/work',
      'HEAD:refs/heads/work*',
    ]) {
      expect(validateGitArgs(['push', 'origin', refspec], { allowedWorkBranch: workBranchRef })).toMatch(/Git push (?:refspec|source|destination)|work branch/);
    }
    expect(validateGitArgs(['push'], { allowedWorkBranch: workBranchRef })).toMatch(/exactly one explicit work-branch refspec/);
    expect(validateGitArgs(['push', 'origin'], { allowedWorkBranch: workBranchRef })).toMatch(/exactly one explicit work-branch refspec/);
    expect(validateGitArgs(['push', 'origin', 'HEAD', 'other'], { allowedWorkBranch: workBranchRef })).toMatch(/exactly one explicit work-branch refspec/);
    for (const refspec of [
      'HEAD',
      `HEAD:${workBranchRef}`,
      `HEAD:${workBranch}`,
      workBranch,
      `${workBranch}:${workBranch}`,
      workBranchRef,
      `${workBranchRef}:${workBranchRef}`,
    ]) {
      expect(validateGitArgs(['push', 'origin', refspec], { allowedWorkBranch: workBranchRef })).toBe('');
    }
    expect(validateGitArgs(['push', '--set-upstream', 'origin', workBranchRef], { allowedWorkBranch: workBranchRef })).toBe('');
    expect(validateGitArgs(['push', 'origin', `HEAD:${workBranchRef}`], { allowedWorkBranch: '' })).toMatch(/current work branch/);
    expect(validateGitArgs(['push', 'origin', `HEAD:${workBranchRef}`], { allowedWorkBranch: 'refs/heads/main' })).toMatch(/current work branch/);
    expect(validateGitArgs(['fetch', 'origin', 'main'])).toBe('');
    expect(validateGitArgs(['ls-remote', 'origin', 'refs/heads/main'])).toBe('');
    const expectedRemote = 'https://github.com/owner/repo.git';
    expect(canonicalGitRemote({ host: 'https://github.com', repository: 'owner/repo' })).toBe(expectedRemote);
    expect(buildGitNetworkArgs(['push', 'origin', `HEAD:${workBranchRef}`], expectedRemote)).toEqual([
      'push', expectedRemote, `HEAD:${workBranchRef}`,
    ]);
    expect(buildGitNetworkArgs(['push', 'origin', 'HEAD'], expectedRemote, { allowedWorkBranch: workBranchRef })).toEqual([
      'push', expectedRemote, `HEAD:${workBranchRef}`,
    ]);
    expect(buildGitNetworkArgs(['push', 'origin', workBranch], expectedRemote, { allowedWorkBranch: workBranchRef })).toEqual([
      'push', expectedRemote, workBranchRef,
    ]);
    expect(buildGitNetworkArgs(['push', 'origin', `HEAD:${workBranch}`], expectedRemote, { allowedWorkBranch: workBranchRef })).toEqual([
      'push', expectedRemote, `HEAD:${workBranchRef}`,
    ]);
    expect(buildGitNetworkArgs(['push', 'origin', `${workBranch}:${workBranch}`], expectedRemote, { allowedWorkBranch: workBranchRef })).toEqual([
      'push', expectedRemote, `${workBranchRef}:${workBranchRef}`,
    ]);
    expect(buildGitNetworkArgs(['fetch', '--prune'], expectedRemote)).toEqual([
      'fetch', '--prune', expectedRemote,
    ]);
    expect(buildGitNetworkArgs(['push', '--', 'origin', workBranchRef], expectedRemote)).toEqual([
      'push', '--', expectedRemote, workBranchRef,
    ]);
  });

  it('risolve nel runtime Git solo HEAD sotto refs/heads e rifiuta tag, remote, detached e main', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-git-namespace-'));
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
    delete gitEnv.GIT_DIR;
    delete gitEnv.GIT_COMMON_DIR;
    delete gitEnv.GIT_WORK_TREE;
    const resolveHead = () => resolveCurrentWorkBranchRef({ realGit: 'git', cwd: repo, env: gitEnv });
    const setHead = (ref) => execFileSync('git', ['-C', repo, 'symbolic-ref', 'HEAD', ref], { env: gitEnv });
    try {
      execFileSync('git', ['init', '-q', repo], { env: gitEnv });
      execFileSync('git', ['-C', repo, '-c', 'user.name=codex-fixture', '-c', 'user.email=codex-fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { env: gitEnv });
      execFileSync('git', ['-C', repo, 'checkout', '-qb', 'codex/fallback-bridge-runtime'], { env: gitEnv });
      setHead('refs/tags/fallback-tag');
      expect(resolveHead()).toBe('');
      expect(validateGitArgs(['push', 'origin', 'HEAD'], { allowedWorkBranch: resolveHead() })).toMatch(/current work branch/);
      setHead('refs/remotes/origin/fallback-remote');
      expect(resolveHead()).toBe('');
      expect(validateGitArgs(['push', 'origin', 'HEAD'], { allowedWorkBranch: resolveHead() })).toMatch(/current work branch/);
      setHead('refs/heads/codex/fallback-bridge-runtime');
      expect(resolveHead()).toBe('refs/heads/codex/fallback-bridge-runtime');
      expect(validateGitArgs(['push', 'origin', 'HEAD'], { allowedWorkBranch: resolveHead() })).toBe('');
      execFileSync('git', ['-C', repo, 'checkout', '--detach', 'HEAD'], { env: gitEnv, stdio: 'ignore' });
      expect(resolveHead()).toBe('');
      setHead('refs/heads/main');
      expect(resolveHead()).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    expect(workflow).not.toContain('preflight_blocked:');
    expect(workflow).toContain('codex_auth_json: ${{ secrets.CODEX_AUTH_JSON }}');
    expect(workflow).toContain('codex_github_token:');
    expect(workflow).toContain('github_token:');
    if (highConcurrencyReviewWorkflows.has(workflowName)) {
      expect(workflow).not.toContain("CODEX_FALLBACK_MODE: '1'");
      expect(workflow).not.toContain('check-quota-backoff.mjs');
    } else {
      expect(workflow).toContain("CODEX_FALLBACK_MODE: '1'");
    }
    expect(workflow).not.toContain('OPENAI_API_KEY');
    expect(workflow).not.toContain('CODEX_ACCESS_TOKEN');
  });

  it('separa l’identità del bridge dalla GITHUB_TOKEN su tutti i caller mutanti', () => {
    for (const workflowName of mutatingBridgeWorkflows) {
      const workflow = readFileSync(resolve(repoRoot, '.github', 'workflows', workflowName), 'utf8');
      const bridgeLine = workflow.split('\n').find((line) => line.trim().startsWith('codex_github_token:'));
      expect(bridgeLine, `${workflowName} deve dichiarare il token bridge`).toContain(
        'codex_github_token: ${{ env.APP_TOKEN || env.GITHUB_PAT }}',
      );
      expect(bridgeLine).not.toContain('secrets.GITHUB_TOKEN');
    }
  });

  it('mantiene github_token separato dal bridge host-side', () => {
    for (const workflowName of mutatingBridgeWorkflows) {
      const workflow = readFileSync(resolve(repoRoot, '.github', 'workflows', workflowName), 'utf8');
      const actionWith = codexFallbackWith(workflow);
      const bridgeToken = String(actionWith.codex_github_token ?? '');
      const helperToken = String(actionWith.github_token ?? '');
      expect(bridgeToken, `${workflowName} deve avere il bridge`).toContain('env.APP_TOKEN || env.GITHUB_PAT');
      expect(helperToken, `${workflowName} deve conservare il lifecycle helper`).not.toBe('');
    }
    const issueFix = readFileSync(resolve(repoRoot, '.github', 'workflows', 'issue-fix.yml'), 'utf8');
    const issueFixWith = codexFallbackWith(issueFix);
    expect(issueFixWith.github_token).toBe('${{ env.APP_TOKEN }}');
    expect(issueFixWith.github_token).not.toBe('${{ env.APP_TOKEN || secrets.GITHUB_TOKEN }}');
  });

  it('prepara App/PAT prima dei caller senza token già caricato', () => {
    for (const workflowName of [
      'lessons-harvester.yml',
      'crawler-content-plausibility-audit.yml',
      'post-merge-followup.yml',
    ]) {
      const workflow = readFileSync(resolve(repoRoot, '.github', 'workflows', workflowName), 'utf8');
      expect(workflow).toContain('Mint GitHub App token for Codex bridge (zero-Claude)');
      expect(workflow).toContain('APP_ID: ${{ secrets.APP_ID }}');
      expect(workflow).toContain('APP_PRIVATE_KEY: ${{ secrets.APP_PRIVATE_KEY }}');
    }
  });

  it('colloca mint/load del bridge nello stesso job del consumer YAML', () => {
    for (const workflowName of mutatingBridgeWorkflows) {
      const workflow = readFileSync(resolve(repoRoot, '.github', 'workflows', workflowName), 'utf8');
      const job = jobBlockContaining(workflow, 'codex_github_token: ${{ env.APP_TOKEN || env.GITHUB_PAT }}');
      expect(job, `${workflowName} deve avere consumer e job riconoscibili`).not.toBe('');
      const mintMatch = job.match(/Mint(?: GitHub)? App token/u);
      const mint = mintMatch?.index ?? -1;
      const bridge = job.indexOf('codex_github_token: ${{ env.APP_TOKEN || env.GITHUB_PAT }}');
      expect(mint, `${workflowName} deve caricare App/PAT nello stesso job`).toBeGreaterThanOrEqual(0);
      expect(mint, `${workflowName} deve caricare App/PAT prima del consumer`).toBeLessThan(bridge);
    }
  });

  it('classifica i side-effect dei bridge prima di autorizzare un retry', () => {
    expect(isMutatingGhArgs(['--repo', 'owner/repo', 'pr', 'comment', '--body-file', 'body.md'])).toBe(true);
    expect(isMutatingGhArgs(['--repo', 'owner/repo', 'pr', 'view', '1'])).toBe(false);
    expect(isMutatingGitArgs(['push', 'origin', 'HEAD'])).toBe(true);
    expect(isMutatingGitArgs(['ls-remote', 'origin', 'HEAD'])).toBe(false);
  });

  it('verifica URL, versione e SHA-256 della release Node pinnata', () => {
    const action = readFileSync(resolve(repoRoot, '.github', 'actions', 'claude-codex-fallback', 'action.yml'), 'utf8');
    expect(action).toContain("node_version='v24.21.0'");
    expect(action).toContain('node_archive="node-${node_version}-linux-x64.tar.xz"');
    expect(action).toContain('node_url="https://nodejs.org/dist/${node_version}/${node_archive}"');
    expect(action).toContain("node_archive_sha256='fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6'");
    expect(action).toContain('Linux:x86_64');
    expect(action).toContain('/usr/bin/curl --fail --silent --show-error --location');
    // Download limitato: la run 35735836333 di post-merge-followup e' rimasta
    // 32 minuti in questo step su una connessione appesa, fino al timeout.
    expect(action).toMatch(/\/usr\/bin\/curl [^\n]*\\\n\s+--connect-timeout \d+ --max-time \d+ --retry \d+/);
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

  it('accetta il successo Codex e propaga gli esiti inattesi', () => {
    const action = readFileSync(resolve(repoRoot, '.github', 'actions', 'claude-codex-fallback', 'action.yml'), 'utf8');
    expect(action).toContain('finalize_outcome="${{ steps.finalize.outcome }}"');
    expect(action).toContain('action_success="${{ steps.finalize.outputs.action_success }}"');
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
        finalize: 'success',
        action_success: 'true',
        codex_outcome: 'success',
        codex_auth_failure: 'false',
        claude_outcome: 'skipped',
        ...overrides,
      };
      const expressions: Record<string, string> = {
        '${{ steps.finalize.outcome }}': values.finalize,
        '${{ steps.finalize.outputs.action_success }}': values.action_success,
        '${{ steps.finalize.outputs.codex_outcome }}': values.codex_outcome,
        '${{ steps.finalize.outputs.codex_auth_failure }}': values.codex_auth_failure,
        '${{ steps.finalize.outputs.claude_outcome }}': values.claude_outcome,
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
    expect(runPreserve({ codex_outcome: 'failure', claude_outcome: 'success' })).toBe(0);
    expect(runPreserve({ action_success: 'false', codex_outcome: 'failure', claude_outcome: 'failure' })).not.toBe(0);
    expect(runPreserve({ finalize: 'failure' })).not.toBe(0);
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

type ActionStep = {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  'continue-on-error'?: boolean;
};

function codexActionDefinition(): {
  inputs: Record<string, { default?: string }>;
  runs: { steps: ActionStep[] };
} {
  return YAML.parse(readFileSync(resolve(repoRoot, '.github', 'actions', 'claude-codex-fallback', 'action.yml'), 'utf8'));
}

function codexActionStep(name: string): ActionStep {
  const step = codexActionDefinition().runs.steps.find((candidate) => candidate.name === name);
  if (!step?.run) throw new Error(`step dell'action non trovato: ${name}`);
  return step;
}

// Override espliciti del watchdog (minuti, input `exec_timeout_minutes` di
// #9690): i lane agentici di main (issue-fix, issue-decompose,
// needs-human-sweep) e i caller batch che hanno misurato sessioni vicine o
// oltre il vecchio cap fisso da 15 min (#1975/#1979, growth-report 658s).
// Tutti gli altri restano sul default.
const EXEC_TIMEOUT_OVERRIDES: Record<string, string> = {
  'growth-report.yml': '30',
  'issue-decompose.yml': '70',
  'issue-fix.yml': '110',
  'needs-human-sweep.yml': '100',
  'post-merge-followup.yml': '25',
};
// Setup Codex (Node, CLI, sandbox apt: ~105s misurati il 2026-09-24), kill
// grace di 30s e coda di finalize/cleanup: il watchdog deve lasciare questo
// margine allo step, altrimenti il runner uccide lo step prima del watchdog e
// `codex_timed_out` non viene mai pubblicato.
const CODEX_SETUP_AND_TAIL_SECONDS = 300;

describe('watchdog Codex per caller', () => {
  it('ha default 15 minuti e accetta solo minuti interi 1-300', () => {
    expect(codexActionDefinition().inputs.exec_timeout_minutes?.default).toBe('15');
    const codexStep = codexActionStep('Run Codex primary (one subscription attempt)');
    const script = codexStep.run!;
    const start = script.indexOf('codex_exec_timeout_minutes="${CODEX_EXEC_TIMEOUT_MINUTES:-15}"');
    const end = script.indexOf('codex_exec_kill_grace_seconds=30', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const validation = script.slice(start, end);
    const validate = (value: string | undefined) => {
      const env: Record<string, string> = { PATH: process.env.PATH || '/usr/bin:/bin' };
      if (value !== undefined) env.CODEX_EXEC_TIMEOUT_MINUTES = value;
      const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail\n${validation}\nprintf 'cap=%s\\n' "$codex_exec_timeout_seconds"`], {
        env,
        encoding: 'utf8',
      });
      return result.status === 0 ? result.stdout.trim().split('\n').pop() : `exit=${result.status}`;
    };
    expect(validate(undefined)).toBe('cap=900');
    expect(validate('')).toBe('cap=900');
    expect(validate('25')).toBe('cap=1500');
    expect(validate('1')).toBe('cap=60');
    expect(validate('300')).toBe('cap=18000');
    // 0 disattiverebbe GNU timeout: deve fallire, non ricadere sul default.
    for (const invalid of ['0', '301', '015', '15m', ' 15', '900s', '-1']) {
      expect(validate(invalid), invalid).toBe('exit=1');
    }
  });

  it('alza il cap solo sui caller dichiarati e lo tiene sotto il tetto effettivo dello step', () => {
    const overrides: Record<string, string> = {};
    for (const workflowName of workflowNames) {
      const parsed = YAML.parse(readFileSync(resolve(repoRoot, '.github', 'workflows', workflowName), 'utf8')) as {
        jobs?: Record<string, { 'timeout-minutes'?: number; steps?: Array<WorkflowStep & { 'timeout-minutes'?: number }> }>;
      };
      for (const job of Object.values(parsed.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (step.uses !== './.github/actions/claude-codex-fallback') continue;
          expect(step.with?.exec_timeout_seconds, `${workflowName}: input rimosso, usare exec_timeout_minutes`).toBeUndefined();
          const value = step.with?.exec_timeout_minutes;
          if (value === undefined) continue;
          overrides[workflowName] = String(value);
          const caps = [step['timeout-minutes'], job['timeout-minutes']].filter((cap): cap is number => typeof cap === 'number');
          expect(caps.length, `${workflowName}: serve un timeout-minutes`).toBeGreaterThan(0);
          const effectiveSeconds = Math.min(...caps) * 60;
          expect(Number(value) * 60 + CODEX_SETUP_AND_TAIL_SECONDS, `${workflowName}: watchdog oltre il kill del runner`)
            .toBeLessThanOrEqual(effectiveSeconds);
        }
      }
    }
    expect(overrides).toEqual(EXEC_TIMEOUT_OVERRIDES);
  });
});

describe('alert auth Codex per i caller senza PR', () => {
  const ALERT_TITLE = 'Codex auth down: CODEX_AUTH_JSON refresh token rejected';
  const DIGEST = 'a'.repeat(64);
  const alertStep = codexActionStep('Raise Codex authentication alert for non-PR callers');
  const marker = (fields: Record<string, unknown>) =>
    `<!-- CODEX_AUTH_BLOCKED_RUN: ${JSON.stringify({ version: 1, status: 'blocked', runId: 1, runAttempt: 1, ...fields })} -->`;

  const runAlert = (issues: unknown[], comments: unknown[] = [], workflow = 'post-merge-followup') => {
    const root = mkdtempSync(join(tmpdir(), 'codex-auth-alert-'));
    const fakeGh = join(root, 'gh');
    const log = join(root, 'gh.log');
    writeFileSync(fakeGh, [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');",
      "if (args[0] === 'api') {",
      "  const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';",
      "  process.stdout.write(endpoint.includes('/comments') ? process.env.FAKE_GH_COMMENTS : process.env.FAKE_GH_ISSUES);",
      '}',
    ].join('\n'));
    chmodSync(fakeGh, 0o755);
    writeFileSync(log, '');
    try {
      execFileSync('/bin/bash', ['-c', alertStep.run!], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin',
          TRUSTED_GH: fakeGh,
          REPO: 'owner/repo',
          SERVER_URL: 'https://github.com',
          WORKFLOW_NAME: workflow,
          AUTH_DIGEST: DIGEST,
          RUN_ID: '123',
          RUN_ATTEMPT: '2',
          FAKE_GH_LOG: log,
          FAKE_GH_ISSUES: JSON.stringify(issues),
          FAKE_GH_COMMENTS: JSON.stringify(comments),
        },
      });
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const writes = (calls: string[][]) => calls.filter((args) => args[0] === 'issue');

  it('scatta solo senza PR, best-effort, con la GITHUB_TOKEN', () => {
    expect(alertStep.if).toBe("always() && steps.finalize.outputs.codex_auth_failure == 'true' && env.PR_NUMBER == ''");
    expect(alertStep['continue-on-error']).toBe(true);
    expect(alertStep.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(alertStep.run).toContain(`alert_title='${ALERT_TITLE}'`);
  });

  it('apre l\'alert canonico con il marker del run quando manca', () => {
    const pullRequestWithSameTitle = { number: 3, title: ALERT_TITLE, pull_request: {}, user: { login: 'github-actions[bot]' } };
    const otherIssue = { number: 4, title: 'Codex auth down: something else', user: { login: 'github-actions[bot]' } };
    const [create, ...rest] = writes(runAlert([pullRequestWithSameTitle, otherIssue]));
    expect(rest).toEqual([]);
    expect(create.slice(0, 8)).toEqual(['issue', 'create', '--repo', 'owner/repo', '--title', ALERT_TITLE, '--label', 'automation']);
    const body = create[create.indexOf('--body') + 1];
    expect(body).toContain('Workflow: `post-merge-followup`');
    expect(body).toContain('https://github.com/owner/repo/actions/runs/123');
    expect(body).toContain('`codex-auth-recovery`');
    const json = /<!-- CODEX_AUTH_BLOCKED_RUN: (\{.*\}) -->/u.exec(body)?.[1];
    expect(JSON.parse(json || '{}')).toEqual({
      version: 1, status: 'blocked', workflow: 'post-merge-followup', runId: 123, runAttempt: 2, authDigest: DIGEST,
    });
  });

  it('registra una sola volta ogni coppia credenziale/workflow sull\'alert aperto', () => {
    const alert = {
      number: 7,
      title: ALERT_TITLE,
      user: { login: 'github-actions[bot]' },
      body: marker({ workflow: 'post-merge-followup', authDigest: DIGEST }),
    };
    expect(writes(runAlert([alert]))).toEqual([]);
    const sameInComment = [{ user: { login: 'frontaliere-automation[bot]' }, body: marker({ workflow: 'growth-report', authDigest: DIGEST }) }];
    expect(writes(runAlert([{ ...alert, body: '' }], sameInComment, 'growth-report'))).toEqual([]);
    const [comment] = writes(runAlert([alert], [], 'needs-human-sweep'));
    expect(comment.slice(0, 5)).toEqual(['issue', 'comment', '7', '--repo', 'owner/repo']);
    expect(comment[comment.indexOf('--body') + 1]).toContain('"workflow":"needs-human-sweep"');
    // Un marker scritto da un umano non sopprime l'alert, e nemmeno una
    // credenziale diversa già registrata.
    const human = [{ user: { login: 'someone' }, body: marker({ workflow: 'growth-report', authDigest: DIGEST }) }];
    expect(writes(runAlert([{ ...alert, body: '' }], human, 'growth-report'))).toHaveLength(1);
    const oldDigest = { ...alert, body: marker({ workflow: 'post-merge-followup', authDigest: 'b'.repeat(64) }) };
    expect(writes(runAlert([oldDigest]))).toHaveLength(1);
  });
});

describe('prompt Codex che postano markdown', () => {
  it('scrivono il body in un file e usano --body-file, mai --body inline', () => {
    const tests = readFileSync(resolve(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
    expect(tests).toContain('gh pr review ${PR_NUMBER} --comment --body-file "$TMPDIR/review.md"');
    expect(tests).toContain("<<'REVIEW_EOF'");
    expect(tests).not.toMatch(/gh pr review \$\{PR_NUMBER\} --comment --body (?!-file)/u);
    const audit = readFileSync(resolve(repoRoot, '.github', 'workflows', 'crawler-content-plausibility-audit.yml'), 'utf8');
    expect(audit).toContain('--label job-content-quality --body-file "$TMPDIR/issue.md"');
    expect(audit).toContain("<<'ISSUE_EOF'");
    expect(audit).not.toContain('--body "<corpo>"');
  });
});
