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
const alreadyResolvedGate = readFileSync(
  new URL('../scripts/ci/check-issue-already-resolved.mjs', import.meta.url),
  'utf8',
);
const workflowScopeGate = readFileSync(
  new URL('../scripts/ci/check-workflows-scope.mjs', import.meta.url),
  'utf8',
);
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
          GH_TOKEN: '',
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
    expect(gate).toContain('extractIssueReferences');
    expect(gate).toContain('references.paths');
    expect(gate).not.toContain('const pathTokenRe =');
    expect(gate).not.toContain('const absolutePathRe =');
    expect(gate).not.toContain('const repeatedSeparatorRe =');
    expect(gate).not.toContain('const rootPathRe =');
    expect(gate).not.toContain('const codeReferenceRe =');
    expect(gate).toContain('classifyAutomationRisk');
    expect(gate).toContain('policyInput.pathsComplete = references.pathsComplete');
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
      pathsComplete: true,
    });
  });

  it('ignora URL GitHub non-file e non trasforma un comando in un path vuoto', () => {
    expect(runInlineRisk(
      'Run: https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/123',
    )).toMatchObject({
      automationBlocked: false,
      riskDenyCode: null,
      pathsComplete: null,
    });
    expect(runInlineRisk(
      'Run: https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/123/',
    )).toMatchObject({
      automationBlocked: false,
      riskDenyCode: null,
      pathsComplete: null,
    });
    const code = String.fromCharCode(96);
    const commandBody = code
      + "git show origin/main:data/crawler-health.json | jq -r '.status'"
      + code;
    expect(runInlineRisk(commandBody)).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'unknown-path',
      pathsComplete: true,
    });
    expect(runInlineRisk('Europe/Zurich gh/push REST/GraphQL github.event_name')).toMatchObject({
      automationBlocked: false,
      riskDenyCode: null,
      pathsComplete: null,
    });
  });

  it('mantiene parity tra classifier e preflight inline sullo stesso snapshot', () => {
    const code = String.fromCharCode(96);
    const bodies = [
      'Workflow run: https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/123',
      'Workflow run: https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/123/',
      code + "git show origin/main:data/crawler-health.json | jq -r '.status'" + code,
      code + 'cat unknown.json' + code,
      code + 'git show origin/main:package.json' + code,
      'https://github.com/valerielinc-ops/frontaliere-si-o-no/blob/feature/docs/.github/workflows/issue-fix.yml',
      'Suggested action: edit src/fix.ts.',
      'Suggested action: edit `package.json` and `unknown.json`.',
    ];
    for (const body of bodies) {
      const inline = runInlineRisk(body);
      const classifier = classifyIssue(
        'Follow-up: update the source module',
        ['follow-up'],
        body,
        { repository: 'valerielinc-ops/frontaliere-si-o-no' },
      );
      expect(inline.automationBlocked).toBe(classifier.automationBlocked);
      expect(inline.riskDenyCode).toBe(classifier.riskDenyCode);
    }
  });

  it('nega URL GitHub con confine ref/path non verificabile', () => {
    expect(runInlineRisk(
      'https://www.github.com/valerielinc-ops/frontaliere-si-o-no/blob/feature/docs/.github/workflows/issue-fix.yml',
    )).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'paths-unverifiable',
      pathsComplete: false,
    });
    expect(runInlineRisk(
      'https://raw.githubusercontent.com/valerielinc-ops/frontaliere-si-o-no/feature/docs/.github/workflows/issue-fix.yml',
    )).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'paths-unverifiable',
      pathsComplete: false,
    });
    expect(runInlineRisk(
      'https://github.com/valerielinc-ops/frontaliere-si-o-no/blob/feature/scripts/foo.mjs',
    )).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'paths-unverifiable',
      pathsComplete: false,
    });
    expect(runInlineRisk(
      'https://www.github.com/valerielinc-ops/frontaliere-si-o-no/blob/feature/docs/foo.mjs',
    )).toMatchObject({
      automationBlocked: true,
      riskDenyCode: 'paths-unverifiable',
      pathsComplete: false,
    });
  });

  it('lega il mint a una snapshot verificabile e congela il payload consumato', () => {
    const verification = workflow.indexOf(
      '- name: Verify issue snapshot immediately before App token and bridge',
    );
    const group = workflow.indexOf(
      '- name: Load issue group context (B19, frozen before capabilities)',
    );
    const appToken = workflow.indexOf('Mint GitHub App token');
    const tier = workflow.indexOf('- name: Determine fix tier');
    const closing = workflow.indexOf('- name: Closing keyword for the PR body');
    expect(verification).toBeGreaterThan(-1);
    expect(group).toBeGreaterThan(verification);
    expect(group).toBeLessThan(appToken);
    expect(verification).toBeLessThan(appToken);
    expect(tier).toBeGreaterThan(group);
    expect(closing).toBeGreaterThan(tier);
    expect(workflow).toContain('--json number,state,title,body,labels,comments');
    expect(workflow).toContain('jq -ceS --arg repo \"$REPO\" --argjson issue_number \"$ISSUE_NUMBER\"');
    expect(workflow).toContain('comments: (.comments | sort_by');
    expect(workflow).toContain('printf \'%s\\n\' \"$snapshot\" > \"$ctx_dir/issue.json\"');
    expect(workflow).toContain('sha256sum');
    expect(workflow).toContain('EXPECTED_SNAPSHOT_FINGERPRINT');
    expect(workflow).toContain('issue snapshot cambiata o non coerente');
    expect(workflow).toContain('nessuna capability remota');
    expect(workflow).toContain('echo \"verified=true\" >> \"$GITHUB_OUTPUT\"');
    expect(workflow).toContain('snapshot issue congelato mancante o non verificabile durante il prefetch');
    expect(workflow).not.toContain('fallback `gh issue view $ISSUE_NUMBER --json number,title,body,labels,comments`');
    expect(workflow.slice(tier, closing)).not.toContain('gh issue view');
    expect(workflow).toMatch(
      /if: always\(\) && steps\.issue_snapshot\.outputs\.verified == 'true'/u,
    );
  });

  it('fa consumare ai preflight lo stesso snapshot senza fallback live', () => {
    const preflight = workflow.indexOf('id: preflight');
    const scopeGuard = workflow.indexOf('id: scope_guard');
    const tier = workflow.indexOf('- name: Determine fix tier');

    expect(workflow.slice(preflight, tier)).toContain(
      'ISSUE_FIX_SNAPSHOT_FILE: ${{ runner.temp }}/issue-fix-ctx/issue.json',
    );
    expect(workflow.slice(scopeGuard, tier)).toContain(
      'ISSUE_FIX_SNAPSHOT_FILE: ${{ runner.temp }}/issue-fix-ctx/issue.json',
    );
    for (const source of [alreadyResolvedGate, workflowScopeGate]) {
      const snapshotBranch = source.indexOf('if (ISSUE_FIX_SNAPSHOT_FILE)');
      const liveRead = source.indexOf("['issue', 'view', ISSUE");
      expect(snapshotBranch).toBeGreaterThan(-1);
      expect(liveRead).toBeGreaterThan(snapshotBranch);
      expect(source).toContain('proceeding without a live fallback');
    }
  });

  it('consuma le label normalizzate dello snapshot come stringhe', () => {
    const group = workflow.indexOf(
      '- name: Load issue group context (B19, frozen before capabilities)',
    );
    const tier = workflow.indexOf('- name: Determine fix tier');
    const closing = workflow.indexOf('- name: Closing keyword for the PR body');
    const groupContext = workflow.slice(group, tier);
    const tierDecision = workflow.slice(tier, closing);
    const normalizedIssueBody =
      'body=$(jq -r \'.title + "\\n" + (.body // "") + "\\n" + ([.labels[]?] | join("\\n"))\' "$CTX_DIR/issue.json")';
    const objectIssueBody =
      'body=$(jq -r \'.title + "\\n" + (.body // "") + "\\n" + ([.labels[]?.name] | join("\\n"))\' "$CTX_DIR/issue.json")';

    expect(groupContext).toContain('[.labels[]? | select(test($pattern))]');
    expect(groupContext).not.toContain('[.labels[]?.name | select(test($pattern))]');
    expect(tierDecision).toContain(normalizedIssueBody);
    expect(tierDecision).not.toContain(objectIssueBody);
  });

  it('classifica ogni membro B19 prima di coniare capability', () => {
    const group = workflow.indexOf(
      '- name: Validate issue group context and member risk (zero-Claude)',
    );
    const appToken = workflow.indexOf('Mint GitHub App token');
    const groupValidation = workflow.slice(group, appToken);

    expect(group).toBeGreaterThan(-1);
    expect(groupValidation).toContain('Preflight F1/F7 path-risk policy');
    expect(groupValidation).toContain('group_member_decision');
    expect(groupValidation).toContain('automationBlocked');
    expect(groupValidation).toContain('riskDecision');
    expect(groupValidation).toContain('exit 1');
    expect(group).toBeLessThan(appToken);
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
    expect(workflow).toContain('PR_DELIVERY_BASELINE_FILE=$delivery_baseline');
    expect(workflow).toContain("RUN_STARTED_AT=$(jq -er '.runStartedAt // empty' \"$baseline_file\"");
    expect(workflow).toContain('--arg started "$RUN_STARTED_AT"');
    expect(workflow).toContain('.createdAt // "") >= $started');
    expect(workflow).toMatch(
      /RUN_STARTED_AT non verificabile dal baseline: backstop non emesso\.[\s\S]*?\n\s+exit 0\n\s+fi/,
    );
    expect(workflow).toContain('lookup commenti issue non disponibile: backstop non emesso.');
    expect(workflow).toContain('delivery=$DELIVERY_STATUS: backstop non emesso.');
    expect(workflow).toContain('jq -r --arg started "$RUN_STARTED_AT"');
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
    expect(workflow).toContain('PR_DELIVERY_BASELINE_FILE=$delivery_baseline');
    expect(verificationStep).toContain('status_file="${PR_BODY_GATE_STATUS_FILE:-}"');
    expect(verificationStep).toContain('evidence_file="${PR_DELIVERY_EVIDENCE_FILE:-}"');
    expect(verificationStep).toContain('ACTION_OUTCOME: ${{ steps.codex_fix.outcome }}');
    expect(verificationStep).toContain('action_outcome');
    expect(verificationStep).toContain('grep -Fxq \'best-effort-failed\' "$status_file"');
    expect(verificationStep).toContain('jq -e \'select(.status == "verified-delivery")\' "$evidence_file"');
    expect(verificationStep).not.toContain('gh pr list --repo "$REPO" --head "$BRANCH" --state all');
    expect(verificationStep).toContain('echo "::error::gh-pr-body-check ha registrato');
    expect(verificationStep).toContain('exit 1');
    expect(verificationStep).not.toContain('continue-on-error: true');
    expect(end).toBeGreaterThan(start);
    expect(workflow.indexOf('Classify outcome (work-done, not CLI exit)')).toBeGreaterThan(end);
  });

  it('lega baseline, snapshot e classify allo stesso helper tri-state', () => {
    expect(workflow).toContain('pr-delivery-evidence.mjs" capture');
    expect(workflow).toContain('--run-attempt "$GITHUB_RUN_ATTEMPT"');
    expect(workflow).toContain('--legacy-output "$baseline_file"');
    expect(workflow).toContain('pr-delivery-evidence.mjs" evaluate');
    expect(workflow).toContain('pr-delivery-evidence.mjs" classify');
    expect(workflow).toContain('pr-delivery-baseline-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.json');

    const classifyStart = workflow.indexOf('- name: Classify outcome (work-done, not CLI exit)');
    const releaseStart = workflow.indexOf('- name: Release in-progress claim', classifyStart);
    const classifyStep = workflow.slice(classifyStart, releaseStart);
    expect(classifyStep).not.toContain('gh pr list');
    expect(classifyStep).not.toContain('gh issue view');
    expect(classifyStep).not.toContain('FIX_OUTCOME: rate-limited');
    expect(classifyStep).toContain('--evidence "${PR_DELIVERY_EVIDENCE_FILE:-}"');

    const provenanceStart = workflow.indexOf('- name: Mark autonomous PR provenance (zero-Claude)');
    const backstopStart = workflow.indexOf('- name: Emit FIX_OUTCOME telemetry (deterministic backstop)', provenanceStart);
    const provenanceStep = workflow.slice(provenanceStart, backstopStart);
    expect(provenanceStep).toContain('PR_DELIVERY_EVIDENCE_FILE');
    expect(provenanceStep).toContain('verified-delivery');
    expect(provenanceStep).not.toContain('gh pr list');
    expect(provenanceStep).not.toContain('sort_by(.createdAt)');
  });

  it('non forza marker su skipped/cancelled e non collassa lookup failure in lista vuota', () => {
    const backstopStart = workflow.indexOf('- name: Emit FIX_OUTCOME telemetry (deterministic backstop)');
    const classifyStart = workflow.indexOf('- name: Classify outcome (work-done, not CLI exit)', backstopStart);
    const backstop = workflow.slice(backstopStart, classifyStart);
    expect(backstop).toContain('[ "$action_outcome" = "skipped" ]');
    expect(backstop).toContain('[ "$action_outcome" = "cancelled" ]');
    expect(backstop).toContain('lookup commenti issue non disponibile: backstop non emesso.');
    expect(backstop).not.toContain('|| echo \'{"comments":[]}\'');
    expect(backstop).not.toContain('pr list --head');
    expect(backstop).toContain('verified-delivery');
    expect(backstop).toContain('verified-none');
    expect(backstop).toContain('delivery=$DELIVERY_STATUS: backstop non emesso.');
  });
});
