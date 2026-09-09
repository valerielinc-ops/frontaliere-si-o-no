import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

describe('copertura workflow diretti', () => {
  it.each(workflowNames)('%s usa il fallback locale e il secret subscription-only', (workflowName) => {
    const workflow = readFileSync(resolve(repoRoot, '.github', 'workflows', workflowName), 'utf8');
    expect(workflow.match(/uses: \.\/\.github\/actions\/claude-codex-fallback/g)).toHaveLength(1);
    expect(workflow).toContain('preflight_blocked: ${{ steps.quota.outputs.codex_fallback }}');
    expect(workflow).toContain('codex_auth_json: ${{ secrets.CODEX_AUTH_JSON }}');
    expect(workflow).toContain("CODEX_FALLBACK_MODE: '1'");
    expect(workflow).not.toContain('OPENAI_API_KEY');
    expect(workflow).not.toContain('CODEX_ACCESS_TOKEN');
  });

  it('mantiene il contratto di invocazione Codex e cleanup effimero', () => {
    const action = readFileSync(resolve(repoRoot, '.github', 'actions', 'claude-codex-fallback', 'action.yml'), 'utf8');
    expect(action).toContain('@openai/codex@0.153.4');
    expect(action).toContain('--ephemeral');
    expect(action).toContain('--model gpt-5.6-luna');
    expect(action).toContain('-c model_reasoning_effort=max');
    expect(action).toContain('-c shell_environment_policy.ignore_default_excludes=false');
    expect(action).toContain('if: always()');
    expect(action).toContain('chmod 600 "$CODEX_HOME/auth.json"');
    expect(action).toContain('Never mark this Codex run rate-limited or refunded');
    expect(action).not.toContain('OPENAI_API_KEY');
    expect(action).not.toContain('CODEX_ACCESS_TOKEN');
  });
});
