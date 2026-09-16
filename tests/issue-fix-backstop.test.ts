import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyIssue } from '../scripts/lib/classify-issue.mjs';
import { classifyAutomationRisk } from '../scripts/ci/lib/automation-risk-policy.mjs';

const workflow = readFileSync(new URL('../.github/workflows/issue-fix.yml', import.meta.url), 'utf8');
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function extractInlineRiskScript() {
  const marker = workflow.indexOf("<<'NODE'\n", workflow.indexOf('Preflight F1/F7 path-risk policy'));
  const endMarker = workflow.indexOf('\n          NODE\n', marker);
  if (marker < 0 || endMarker < 0) throw new Error('inline F1/F7 risk script non trovato');
  return workflow.slice(marker + "<<'NODE'\n".length, endMarker).replace(/^ {10}/gmu, '');
}

const inlineRiskScript = extractInlineRiskScript();

function runInlineRisk(body: string) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'issue-fix-risk-'));
  const issueFile = join(tempRoot, 'issue.json');
  writeFileSync(issueFile, JSON.stringify({
    number: 42,
    state: 'OPEN',
    title: 'Follow-up: update the source module',
    body,
    labels: [{ name: 'follow-up' }],
  }));
  try {
    return JSON.parse(execFileSync(
      process.execPath,
      ['--input-type=module', '-', issueFile],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          ISSUE_NUMBER: '42',
          REPO: 'valerielinc-ops/frontaliere-si-o-no',
          SNAPSHOT_FINGERPRINT: '0'.repeat(64),
        },
        input: inlineRiskScript,
        encoding: 'utf8',
      },
    ));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe('issue-fix F1/F7 policy gate', () => {
  it('blocca prima di token App, quota, claim e agent', () => {
    const start = workflow.indexOf('  risk_policy:');
    const end = workflow.indexOf('\n  fix:', start);
    const gate = workflow.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(gate).toContain('Checkout F1/F7 policy only');
    expect(gate).toContain('classifyIssue(issue.title, issue.labels, issue.body ?? \'\')');
    expect(gate).toContain('needs-human');
    expect(gate).toContain('--remove-label "agent:fix"');
    expect(gate).toContain('--remove-label "agent:fix-queued"');
    expect(gate).toContain('--add-label "needs-human"');
    expect(gate).not.toContain('Mint GitHub App token');
    expect(workflow).toContain('needs: risk_policy');
    expect(workflow).toContain("needs.risk_policy.outputs.blocked != 'true'");
  });

  it('esegue il preflight path-risk zero-Claude prima di token e bridge', () => {
    const start = workflow.indexOf('  risk_policy:');
    const end = workflow.indexOf('\n  fix:', start);
    const gate = workflow.slice(start, end);
    const appToken = workflow.indexOf('Mint GitHub App token');
    const bridge = workflow.indexOf('uses: ./.github/actions/claude-codex-fallback');
    const outputGate = workflow.indexOf('- name: Enforce F1/F7 output diff gate');

    expect(gate).toContain('Preflight F1/F7 path-risk policy before capabilities');
    expect(gate).toContain('const pathTokenRe =');
    expect(gate).toContain('const absolutePathRe =');
    expect(gate).toContain('const repeatedSeparatorRe =');
    expect(gate).toContain('const rootPathRe =');
    expect(gate).toContain('const codeReferenceRe =');
    expect(gate).toContain("replaceAll('\\\\', '/')");
    expect(gate).toContain('classifyAutomationRisk');
    expect(gate).toContain('policyInput.pathsComplete = true');
    expect(gate).toContain('automationBlocked: risk.blocked');
    expect(gate).toContain('snapshot_fingerprint');
    expect(end).toBeLessThan(appToken);
    expect(end).toBeLessThan(bridge);
    expect(bridge).toBeLessThan(outputGate);

    expect(classifyIssue(
      'Follow-up: update the source module',
      ['follow-up'],
      'Suggested action: edit `src/fix.ts`.',
    )).toMatchObject({ automationBlocked: false });
    expect(classifyIssue(
      'Follow-up: update the source module',
      ['follow-up'],
      'Suggested action: edit `unknown-zone/agent-target.ts`.',
    )).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'unknown-path',
    });
    expect(classifyIssue(
      'Follow-up: update the workflow',
      ['follow-up'],
      'Suggested action: edit `.github/workflows/issue-fix.yml`.',
    )).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'control-plane',
    });
  });

  it('nega root-level, backslash, traversal e unknown; conserva i percorsi leciti', () => {
    const riskFor = (paths: string[]) => classifyAutomationRisk({
      title: 'Follow-up: update the source module',
      body: '',
      labels: ['follow-up'],
      category: 'follow-up',
      paths,
      pathsComplete: true,
    });

    expect(riskFor(['REVIEW.md'])).toMatchObject({
      blocked: true,
      denyCode: 'control-plane',
    });
    expect(riskFor(['scripts\\ci\\auto-merge-eval.mjs'])).toMatchObject({
      blocked: true,
      denyCode: 'control-plane',
    });
    expect(riskFor(['scripts/../src/fix.ts'])).toMatchObject({
      blocked: true,
      denyCode: 'paths-unverifiable',
    });
    expect(riskFor(['unknown-zone/agent-target.ts'])).toMatchObject({
      blocked: true,
      denyCode: 'unknown-path',
    });
    expect(riskFor(['src/fix.ts'])).toMatchObject({
      blocked: false,
      decision: 'allow',
    });
    expect(riskFor(['README.md'])).toMatchObject({
      blocked: false,
      decision: 'allow',
    });
  });

  it('applica davvero l estrattore inline ai riferimenti dell issue', () => {
    expect(runInlineRisk('.env')).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'high-risk-domain',
    });
    expect(runInlineRisk('.npmrc')).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'unknown-path',
    });
    expect(runInlineRisk('.gitignore')).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'unknown-path',
    });
    expect(runInlineRisk('/.env')).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'paths-unverifiable',
    });
    expect(runInlineRisk('REVIEW.md')).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'control-plane',
    });
    expect(runInlineRisk(String.raw`scripts\ci\auto-merge-eval.mjs`)).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'control-plane',
    });
    expect(runInlineRisk('scripts//ci/auto-merge-eval.mjs')).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'paths-unverifiable',
    });
    expect(runInlineRisk('scripts/../src/fix.ts')).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'paths-unverifiable',
    });
    expect(runInlineRisk('unknown-zone/agent-target.ts')).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'unknown-path',
    });
    expect(runInlineRisk('src/fix.ts')).toMatchObject({
      automationBlocked: false,
      riskDecision: 'allow',
    });
    expect(runInlineRisk('Makefile')).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'unknown-path',
    });
    expect(runInlineRisk('https://github.com/valerielinc-ops/frontaliere-si-o-no/blob/main/REVIEW.md')).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'control-plane',
    });
  });

  it('lega il mint a una snapshot verificabile e alla seconda lettura live', () => {
    const verification = workflow.indexOf(
      '- name: Verify issue snapshot immediately before App token and bridge',
    );
    const appToken = workflow.indexOf('Mint GitHub App token');
    expect(verification).toBeGreaterThan(-1);
    expect(verification).toBeLessThan(appToken);
    expect(workflow).toContain('--json number,state,title,body,labels');
    expect(workflow).toContain('jq -ceS --arg repo \"$REPO\" --argjson issue_number \"$ISSUE_NUMBER\"');
    expect(workflow).toContain('sha256sum');
    expect(workflow).toContain('EXPECTED_SNAPSHOT_FINGERPRINT');
    expect(workflow).toContain('issue snapshot cambiata o non coerente');
    expect(workflow).toContain('nessuna capability remota');
    expect(workflow).toContain('echo \"verified=true\" >> \"$GITHUB_OUTPUT\"');
    expect(workflow).toMatch(
      /if: always\(\) && steps\.issue_snapshot\.outputs\.verified == 'true'/u,
    );
  });

  it('usa actor type e login esatti, senza prefissi aggirabili', () => {
    expect(workflow).toContain("github.event.sender.type == 'User'");
    expect(workflow).toContain("github.event.sender.type == 'Bot'");
    expect(workflow).toContain("github.event.sender.login == 'claude[bot]'");
    expect(workflow).toContain("github.event.sender.login == 'frontaliere-automation[bot]'");
    expect(workflow).not.toContain("startsWith(github.event.sender.login, 'claude')");
  });

  it('mantiene il diff gate deterministico come barriera prima del checkpoint/push WIP', () => {
    const diffGate = workflow.indexOf('- name: Enforce F1/F7 output diff gate');
    const wip = workflow.indexOf('- name: Salva il lavoro parziale');
    const appToken = workflow.indexOf('Mint GitHub App token');
    expect(diffGate).toBeGreaterThan(-1);
    expect(wip).toBeGreaterThan(diffGate);
    expect(workflow.indexOf('risk_policy:')).toBeLessThan(appToken);
    expect(workflow).toContain('classifyAutomationRisk');
    expect(workflow).toContain('pathsComplete: true');
    expect(workflow).toContain('git diff --name-only origin/main');
    expect(workflow).toContain("steps.diff_gate.outcome == 'success'");
  });
});

describe('issue-fix FIX_OUTCOME backstop', () => {
  it('non lascia che un marker storico sopprima il run corrente', () => {
    expect(workflow).toMatch(/permissions:\n(?:  .*\n)*  actions: read\n/);
    expect(workflow).toContain('RUN_STARTED_AT=$(gh api "repos/$REPO/actions/runs/$GITHUB_RUN_ID"');
    expect(workflow).toContain("--jq '.run_started_at // .created_at'");
    expect(workflow).toContain('--arg started "$RUN_STARTED_AT"');
    expect(workflow).toContain('.createdAt // "") >= $started');
    expect(workflow).toMatch(
      /RUN_STARTED_AT non disponibile: backstop non emesso\.[\s\S]*?\n\s+exit 0\n\s+fi/,
    );
    expect(workflow).not.toContain(
      '--jq \'[.comments[].body | select(test("<!-- FIX_OUTCOME:"))] | length\'',
    );
  });
});

describe('issue-fix PR delivery verification', () => {
  it('fails closed after a recorded best-effort body write failure without a PR', () => {
    const start = workflow.indexOf('- name: Verify best-effort PR writes (zero-Claude)');
    const end = workflow.indexOf('- name:', start + 1);
    const verificationStep = workflow.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(workflow).toContain('PR_BODY_GATE_STATUS_FILE=$status_file');
    expect(workflow).toContain('PR_BODY_GATE_BASELINE_FILE=$baseline_file');
    expect(verificationStep).toContain('status_file="${PR_BODY_GATE_STATUS_FILE:-}"');
    expect(verificationStep).toContain('baseline_file="${PR_BODY_GATE_BASELINE_FILE:-}"');
    expect(verificationStep).toContain('ACTION_OUTCOME: ${{ steps.codex_fix.outcome }}');
    expect(verificationStep).toContain('action_outcome');
    expect(verificationStep).toContain('grep -Fxq \'best-effort-failed\' "$status_file"');
    expect(verificationStep).toContain('grep -Fxq "$candidate" "$baseline_file"');
    expect(verificationStep).toContain('gh pr list --repo "$REPO" --head "$BRANCH" --state all');
    expect(verificationStep).toContain('echo "::error::gh-pr-body-check ha registrato');
    expect(verificationStep).toContain('exit 1');
    expect(verificationStep).not.toContain('continue-on-error: true');
    expect(end).toBeGreaterThan(start);
    expect(workflow.indexOf('Classify outcome (work-done, not CLI exit)')).toBeGreaterThan(end);
  });
});
