import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
  validateGhArgs,
} from '../.github/actions/claude-codex-fallback/gh-bridge-server.mjs';
import {
  MAX_OUTPUT_BYTES as GIT_MAX_OUTPUT_BYTES,
  MAX_REQUEST_BYTES as GIT_MAX_REQUEST_BYTES,
  validateGitArgs,
} from '../.github/actions/claude-codex-fallback/git-bridge-server.mjs';
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
    const context = { cwd: workspace, workspaceRoot: workspace, scratchRoot: scratch };
    try {
      expect(validateGhArgs(['auth', 'token'], context)).toMatch(/not permitted/);
      expect(validateGhArgs(['--repo', 'owner/repo', 'auth', 'token'], context)).toMatch(/not permitted/);
      expect(validateGhArgs(['api', '--input', outsideAuth], context)).toMatch(/workspace\/scratch/);
      expect(validateGhArgs(['issue', 'create', '--body-file', join(scratch, 'auth-link')], context)).toMatch(/workspace\/scratch/);
      expect(validateGhArgs(['issue', 'create', '--body-file', join(workspace, 'body.md')], context)).toBe('');
      expect(validateGhArgs(['api', '-F', `body=@${outsideAuth}`], context)).toMatch(/workspace\/scratch/);
      expect(validateGhArgs(['api', '-F', `body=@${join(scratch, 'payload.json')}`], context)).toBe('');
      expect(validateGhArgs(['api', '--template', `@${outsideAuth}`], context)).toMatch(/workspace\/scratch/);
      expect(validateGhArgs(['api', '--template', '{{.number}}'], context)).toBe('');
      expect(validateGhArgs(['pr', 'view', '--verbose'], context)).toMatch(/not permitted/);
      expect(validateGhArgs(['api', '/repos/owner/repo/actions/secrets'], context)).toMatch(/not permitted/);
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
  });

  it('mantiene limiti espliciti del protocollo e output dei due broker', () => {
    expect(GH_MAX_REQUEST_BYTES).toBe(64 * 1024);
    expect(GH_MAX_OUTPUT_BYTES).toBe(1024 * 1024);
    expect(GIT_MAX_REQUEST_BYTES).toBe(64 * 1024);
    expect(GIT_MAX_OUTPUT_BYTES).toBe(1024 * 1024);
  });
});

describe('sanitizzazione git host-side', () => {
  it('rimuove userinfo URL, pushurl e tutti gli extraheader locali', () => {
    const repo = mkdtempSync(join(tmpdir(), 'codex-git-sanitize-'));
    try {
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('git', ['-C', repo, 'config', '--local', 'remote.origin.url', 'https://x-access-token:fixture-secret@github.com/owner/repo.git']);
      execFileSync('git', ['-C', repo, 'config', '--local', 'remote.origin.pushurl', 'https://oauth2:fixture-secret@github.com/owner/repo.git']);
      execFileSync('git', ['-C', repo, 'config', '--local', 'http.extraheader', 'AUTHORIZATION: basic fixture-secret']);
      execFileSync('git', ['-C', repo, 'config', '--local', 'http.github.com.extraheader', 'AUTHORIZATION: basic fixture-secret']);
      sanitizeGitConfig({ cwd: repo });
      const cleanConfig = execFileSync('git', ['-C', repo, 'config', '--local', '--list'], { encoding: 'utf8' });
      expect(cleanConfig).not.toContain('fixture-secret');
      expect(cleanConfig).not.toContain('extraheader');
      expect(cleanConfig).toContain('remote.origin.url=https://github.com/owner/repo.git');
      expect(cleanConfig).toContain('remote.origin.pushurl=https://github.com/owner/repo.git');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('copertura workflow diretti', () => {
  it.each(workflowNames)('%s usa il fallback locale e il secret subscription-only', (workflowName) => {
    const workflow = readFileSync(resolve(repoRoot, '.github', 'workflows', workflowName), 'utf8');
    expect(workflow.match(/uses: \.\/\.github\/actions\/claude-codex-fallback/g)).toHaveLength(1);
    expect(workflow).toContain('preflight_blocked: ${{ steps.quota.outputs.codex_fallback }}');
    expect(workflow).toContain('codex_auth_json: ${{ secrets.CODEX_AUTH_JSON }}');
    expect(workflow).toContain('github_token:');
    expect(workflow).toContain("CODEX_FALLBACK_MODE: '1'");
    expect(workflow).not.toContain('OPENAI_API_KEY');
    expect(workflow).not.toContain('CODEX_ACCESS_TOKEN');
  });

  it('mantiene il contratto di invocazione Codex e cleanup effimero', () => {
    const action = readFileSync(resolve(repoRoot, '.github', 'actions', 'claude-codex-fallback', 'action.yml'), 'utf8');
    const actionDir = resolve(repoRoot, '.github', 'actions', 'claude-codex-fallback');
    const ghBridge = readFileSync(resolve(actionDir, 'gh-bridge-server.mjs'), 'utf8');
    const gitBridge = readFileSync(resolve(actionDir, 'git-bridge-server.mjs'), 'utf8');
    const gitSanitizer = readFileSync(resolve(actionDir, 'sanitize-git-config.mjs'), 'utf8');
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
    expect(action).toContain('copy_bridge_file gh-bridge.sh gh');
    expect(action).toContain('copy_bridge_file git-bridge.sh git');
    expect(action).toContain('node "$action_path/sanitize-git-config.mjs"');
    expect(action).toContain('git rev-parse --git-dir');
    expect(action).toContain('git rev-parse --git-common-dir');
    expect(action).toContain('"$auth_file_toml" = "deny"');
    expect(action).toContain('codex sandbox -P codex-fallback -C "${PWD:-.}" /bin/sh -c');
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
    expect(action).toContain('PATH="$bridge_dir:$PATH"');
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
    expect(action).toContain('env -i "${codex_env[@]}" codex exec');
    expect(action).toContain('CODEX_GH_AUTH: ${{ inputs.github_token }}');
    expect(action).toContain('CODEX_GH_AUTH="$codex_github_auth"');
    expect(action).toContain('unset CODEX_GH_AUTH');
    expect(action).toContain('auth_output="$(gh auth token 2>/dev/null)"');
    expect(action).toContain('test -z "$auth_output"');
    expect(action).not.toContain('GH_TOKEN="$CODEX_GH_AUTH" exec');
    expect(action).not.toContain('CODEX_GH_AUTH=$CODEX_GH_AUTH');
    expect(action).not.toContain('CODEX_GH_AUTH"]');
    expect(action).toContain('codex_git_remote="$(git config --local --get remote.origin.url');
    expect(action).toContain('node "$action_path/sanitize-git-config.mjs"');
    expect(action).toContain('CODEX_GIT_AUTH="$codex_github_auth"');
    expect(action).toContain('CODEX_GIT_REMOTE="$codex_git_remote"');
    expect(gitBridge).toContain("GIT_CONFIG_KEY_0: 'http.extraheader'");
    expect(action).toContain('git remote -v | grep -Eiq');
    expect(action).toContain('CODEX_GIT_CLIENT=$bridge_dir/git-client.mjs');
    expect(action).toContain('chmod 700 "$bridge_dir"');
    expect(action).toContain('if: always()');
    expect(action).toContain('chmod 600 "$CODEX_HOME/auth.json"');
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
    expect(ghBridge).toContain('const blockedApiPath =');
    expect(ghBridge).toContain('MAX_REQUEST_BYTES');
    expect(gitBridge).toContain('currentOrigin(realGit, cwd)');
    expect(gitBridge).toContain('MAX_REQUEST_BYTES');
    expect(gitSanitizer).toContain('parseNullRecords');
    expect(gitSanitizer).toContain('http.extraheader');
  });
});
