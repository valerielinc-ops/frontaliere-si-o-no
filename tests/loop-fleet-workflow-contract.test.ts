import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowDir = path.resolve('.github/workflows');
const loopWorkflows = [
  'loop-l0-data-truth.yml',
  'loop-l1-reliability.yml',
  'loop-l2-demand-utility.yml',
  'loop-l3-job-quality.yml',
  'loop-l4-alert-return.yml',
  'loop-l5-decision-moments.yml',
  'loop-l6-content-factuality.yml',
  'loop-l7-experiment-allocator.yml',
  'loop-l8-revenue-attribution.yml',
  'loop-l9-employer-activation.yml',
  'loop-l10-fleet-control.yml',
  'technical-operations-supervisor.yml',
];

describe('loop fleet workflow contract', () => {
  it('records canonical evidence for every loop with a read-only contents token', () => {
    for (const name of loopWorkflows) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain('record-loop-fleet-evidence.mjs');
      expect(source, name).toContain('--registry data/loop-fleet/loop-registry.json');
      expect(source, name).toContain('retention-days: 90');
      expect(source, name).toContain('contents: read');
      expect(source, name).not.toMatch(/contents:\s*write/u);
    }
  });

  it('starts every loop with explicit operational telemetry declarations', () => {
    for (const name of loopWorkflows) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain('LOOP_FLEET_STARTED_AT=');
      expect(source, name).toContain('LOOP_FLEET_QUOTA_UNITS=0');
      expect(source, name).toContain('LOOP_FLEET_COLLISIONS=0');
      expect(source, name).toContain('LOOP_FLEET_GATE_BYPASS=false');
    }
  });

  it('does not feed an append-only ledger merge back into L11', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'technical-operations-supervisor.yml'), 'utf8');
    const pushBlock = source.match(/\n  push:\n([\s\S]*?)\n  workflow_dispatch:/u)?.[1] ?? '';
    expect(pushBlock).toMatch(/branches:\n\s+- main/u);
    expect(pushBlock).toContain("paths-ignore:\n      - 'data/loop-fleet/ledger/**'");
    expect(pushBlock).not.toContain('data/loop-fleet/**');
  });

  it('does not feed the durable health ledger back into L10 on main pushes', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-l10-fleet-control.yml'), 'utf8');
    const pushBlock = source.match(/\n  push:\n([\s\S]*?)\n  pull_request:/u)?.[1] ?? '';
    const pullRequestBlock = source.match(/\n  pull_request:\n([\s\S]*?)\n  workflow_dispatch:/u)?.[1] ?? '';
    const healthLedger = 'data/loop-fleet/ledger/loop-health-history.jsonl';
    expect(pushBlock).toContain('data/loop-fleet/loop-registry.json');
    expect(pushBlock).not.toContain(healthLedger);
    expect(pullRequestBlock).toContain(healthLedger);
  });

  it('gates repaired loops on a runner-local fail-closed outcome export', () => {
    const contracts = [
      ['loop-l5-decision-moments.yml', 'l5-outcome.json', 'publishedDataUntouched', 'validate_l5_outcome'],
      ['loop-l8-revenue-attribution.yml', 'l8-outcome.json', 'externalCommercialStateUntouched', 'validate_l8_outcome'],
      ['loop-l10-fleet-control.yml', 'l10-outcome.json', 'ledgerWriteMode', 'validate_l10_outcome'],
    ];
    for (const [name, outcomeFile, marker, validatorId] of contracts) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain(`test -s \"$REPORT_DIR/${outcomeFile}\"`);
      expect(source, name).toContain(marker);
      expect(source, name).toContain('if: always()');
      expect(source, name).toContain(`id: ${validatorId}`);
      expect(source, name).toContain(`steps.${validatorId}.outcome == 'success'`);
    }
  });

  it('records L2 and L3 evidence even when their local outcome validator fails', () => {
    const contracts = [
      ['loop-l2-demand-utility.yml', 'L2', 'l2-outcome.json', ['.safeToAct == false', '.publishedDataUntouched == true', '.noThinPages == true', '.noKeywordStuffing == true', '.sourceRequired == true'], 'validate_l2_outcome'],
      ['loop-l3-job-quality.yml', 'L3', 'l3-outcome.json', ['.safeToAct == false', '.handoffIsNotApplication == true', '.runnerLocalQuarantine == true', '.publishedDataUntouched == true'], 'validate_l3_outcome'],
    ];
    for (const [name, loopId, outcomeFile, markers, validatorId] of contracts) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain(`test -s \"$REPORT_DIR/${outcomeFile}\"`);

      const validatorBlock = source.match(new RegExp(`- name: Validate runner-local ${loopId} outcome export\\n([\\s\\S]*?)(?=\\n      - name: Record canonical|$)`, 'u'))?.[0] || '';
      expect(validatorBlock, name).toContain('if: always()');
      for (const marker of markers) expect(validatorBlock, name).toContain(marker);
      expect(validatorBlock, name).toContain(`id: ${validatorId}`);

      const recorderBlock = source.match(new RegExp(`- name: Record canonical ${loopId} evidence\\n([\\s\\S]*?)(?=\\n      - name:|$)`, 'u'))?.[0] || '';
      expect(recorderBlock, name).toContain('if: always()');
      expect(recorderBlock, name).toContain(`LOOP_FLEET_VALIDATOR_OUTCOME: \${{ steps.${validatorId}.outcome }}`);
      expect(recorderBlock, name).not.toContain(`steps.${validatorId}.outcome == 'success'`);
    }
  });

  it('refreshes L5 and L7 evidence from PostHog without committing source exports', () => {
    const contracts = [
      ['loop-l5-decision-moments.yml', 'scripts/ci/export-loop-outcomes.mjs', 'Export fresh L5 outcomes', '$RUNNER_TEMP/decision-moment-outcomes.json'],
      ['loop-l7-experiment-allocator.yml', 'scripts/ci/export-l7-experiment-outcomes.mjs', 'Export fresh L7 outcomes', '$RUNNER_TEMP/experiment-outcomes.json'],
    ];
    for (const [name, exporter, step, outputPath] of contracts) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain(exporter);
      expect(source, name).toContain('scripts/lib/posthog-client.mjs');
      expect(source, name).toContain(step);
      expect(source, name).toContain(outputPath);
      expect(source, name).toContain('outcomes_path=');
      expect(source, name).toContain("if: github.event_name != 'pull_request'");
    }
  });

  it('keeps read-only credential outages observable and fail-closed', () => {
    const contracts = [
      ['loop-l1-reliability.yml', 'LOOP_FLEET_L1_EXPORT_UNAVAILABLE=1', '--loop L1 --unavailable'],
      ['loop-l2-demand-utility.yml', 'LOOP_FLEET_L2_EXPORT_UNAVAILABLE=1', 'export-l2-demand-outcomes.mjs --unavailable'],
      ['loop-l3-job-quality.yml', 'LOOP_FLEET_L3_EXPORT_UNAVAILABLE=1', '--loop L3 --unavailable'],
      ['loop-l4-alert-return.yml', 'LOOP_FLEET_L4_EXPORT_UNAVAILABLE=1', '--loop L4 --unavailable'],
      ['loop-l5-decision-moments.yml', 'LOOP_FLEET_L5_EXPORT_UNAVAILABLE=1', '--loop L5 --unavailable'],
      ['loop-l7-experiment-allocator.yml', 'LOOP_FLEET_L7_EXPORT_UNAVAILABLE=1', 'export-l7-experiment-outcomes.mjs --unavailable'],
    ];
    for (const [name, unavailableFlag, fallbackCommand] of contracts) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain(unavailableFlag);
      expect(source, name).toContain(fallbackCommand);
      expect(source, name).toContain('if: always()');
      expect(source, name).toContain('exit 0');
    }
  });

  it('fa leggere L10 dal ledger health canonico', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-l10-fleet-control.yml'), 'utf8');
    expect(source).toContain('data/loop-fleet/ledger/loop-health-history.jsonl');
    expect(source).toContain('collect-independent-fleet-outcome.mjs');
    expect(source).toContain('--independent-outcome "$REPORT_DIR/independent-fleet-outcome.json"');
    expect(source).toContain('actions: read');
    expect(source).not.toContain('data/loop-health-history.jsonl');
  });

  it('uploads lifecycle evidence for every loop', () => {
    for (const name of loopWorkflows) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      const uploadsWholeDirectory = /path:\s+\$\{\{\s*runner\.temp\s*\}\}\/loop-fleet-[^/]+\/\s*$/mu.test(source);
      expect(uploadsWholeDirectory || source.includes('lifecycle-events.jsonl'), name).toBe(true);
    }
  });

  it('uploads one canonical outcome artifact for every loop', () => {
    for (const name of loopWorkflows) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      const uploadsWholeDirectory = /path:\s+\$\{\{\s*runner\.temp\s*\}\}\/loop-fleet-[^/]+\/\s*$/mu.test(source);
      expect(uploadsWholeDirectory || source.includes('loop-fleet-outcome.json'), name).toBe(true);
    }
  });

  it('keeps the status roll-up read-only', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-fleet-status.yml'), 'utf8');
    expect(source).toContain('actions: read');
    expect(source).toContain('--strict');
    expect(source).toContain('inputs.strict');
    expect(source).toContain("- 'scripts/lib/loop-fleet-contract.mjs'");
    expect(source).not.toMatch(/issues:\s*write|contents:\s*write|pull-requests:\s*write/u);
  });

  it('creates the ledger-audit report directory before tee writes its log', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-fleet-ledger-audit.yml'), 'utf8');
    const directorySetup = source.indexOf('mkdir -p "$REPORT_DIR"');
    const stdoutPipe = source.indexOf('tee "$REPORT_DIR/stdout.txt"');
    expect(directorySetup).toBeGreaterThanOrEqual(0);
    expect(stdoutPipe).toBeGreaterThan(directorySetup);
  });

  it('keeps the detached typecheck PID alive until its status is published', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'tests.yml'), 'utf8');
    expect(source).toContain('setsid --wait bash "$script"');
    expect(source).toContain('gate_wait_limit=300');
    expect(source).toContain('launcher_gone_reported=0');
    expect(source).not.toContain('for retry in 1 2 3 4 5');
    expect(source).toContain("printf '%s\\n' \"\$!\" > \"\$state_dir/\$label.pid\"");
  });

  it('persists validated batches without a PR or review gate', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-fleet-ledger.yml'), 'utf8');
    expect(source).toContain('workflow_run:');
    expect(source).toContain('merge-loop-fleet-ledger.mjs');
    expect(source).toContain('--ledger-dir data/loop-fleet/ledger');
    expect(source).toContain('--registry data/loop-fleet/loop-registry.json');
    expect(source).toContain("ledger_branch='ledger/loop-fleet'");
    expect(source).toContain('git checkout -B ledger-work origin/main');
    expect(source).toContain('git ls-files --error-unmatch data/loop-fleet/ledger/');
    expect(source).toContain('Validate source run provenance');
    expect(source).toContain('source_branch');
    expect(source).toContain("!= 'main'");
    expect(source).not.toMatch(/contents:\s*write/u);
    expect(source).not.toContain('pull-requests: read');
  });

  it('routes both writers to one serialized branch with bounded push retries', () => {
    const writers = [
      ['loop-fleet-ledger.yml', 'merge-loop-fleet-ledger.mjs'],
      ['loop-fleet-lifecycle-observer.yml', 'append-loop-fleet-lifecycle.mjs'],
    ];
    for (const [name, validator] of writers) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain("ledger_branch='ledger/loop-fleet'");
      expect(source, name).toContain('HEAD:refs/heads/$ledger_branch');
      expect(source, name).toContain(validator);
      expect(source, name).toContain('--registry data/loop-fleet/loop-registry.json');
      expect(source, name).toContain('for attempt in 1 2 3 4 5');
      expect(source, name).toContain('bounded_remote git push origin "HEAD:refs/heads/$ledger_branch"');
      expect(source, name).toContain('git reset --hard "origin/$ledger_branch"');
      expect(source, name).toContain('sleep $((attempt * 3))');
      expect(source, name).toContain('after 5 attempts');
      expect(source, name).not.toMatch(/git push[^\n]*--force(?:-with-lease)?/u);
      if (name === 'loop-fleet-lifecycle-observer.yml') {
        expect(source, name).not.toContain('observer is read-only');
      }
      for (const forbidden of ['gh pr create', 'gh pr edit', 'pr-body-check-gate.mjs']) {
        expect(source, `${name}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('removes the obsolete epoch policy and all workflow references to it', () => {
    const policyName = ['loop-fleet', 'epoch-policy'].join('-');
    expect(fs.existsSync(path.resolve('scripts/ci', `${policyName}.mjs`))).toBe(false);
    for (const name of ['loop-fleet-ledger.yml', 'loop-fleet-lifecycle-observer.yml']) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).not.toContain(policyName);
    }
  });

  it('bounds both writers remote operations and disables interactive prompts', () => {
    for (const name of ['loop-fleet-ledger.yml', 'loop-fleet-lifecycle-observer.yml']) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain('remote_timeout_seconds=90');
      expect(source, name).toContain('timeout --signal=TERM --kill-after=10s');
      expect(source, name).toContain('persist-credentials: false');
      expect(source, name).toContain('local operation="${1:-remote-command}"');
      expect(source, name).toContain("remote operation '${operation}' failed or exceeded");
      expect(source, name).not.toContain('): $*');
      expect(source, name).not.toContain('push_url=');
      expect(source, name).toContain("GIT_CONFIG_KEY_0='http.https://github.com/.extraheader'");
      expect(source, name).toContain("basic_auth=$(printf 'x-access-token:%s' \"$GH_TOKEN\" | base64 | tr -d '\\n')");
      expect(source, name).toContain('GIT_CONFIG_VALUE_0="AUTHORIZATION: basic ${basic_auth}"');
      expect(source, name).toContain('unset basic_auth');
      expect(source, name).toContain('bounded_remote git fetch origin main');
      expect(source, name).toContain('bounded_remote git ls-remote --exit-code --heads origin');
      expect(source, name).toContain('bounded_remote git fetch origin "$ledger_branch"');
      expect(source, name).toContain('export GIT_TERMINAL_PROMPT=0');
    }
  });

  it('keeps the automatic ledger recovery probe bounded and unable to write repository content', () => {
    const source = fs.readFileSync(path.join(workflowDir, 'loop-fleet-ledger-reconcile.yml'), 'utf8');
    expect(source).toContain("cron: '*/20 * * * *'");
    expect(source).toContain('group: loop-fleet-ledger-reconcile');
    expect(source).not.toContain('group: loop-fleet-durable-ledger');
    expect(source).toContain('actions: write');
    expect(source).toContain('contents: read');
    expect(source).not.toMatch(/contents:\s*write/u);
    expect(source).not.toMatch(/pull-requests:\s*write/u);
    expect(source).toContain('LOOP_FLEET_RECONCILE_MAX_DISPATCHES: \'3\'');
    expect(source).toContain('loop-fleet-ledger-reconcile.mjs');
  });

  it('materializes the canonical JSON dependency in both ledger sparse checkouts', () => {
    for (const name of ['loop-fleet-ledger-reconcile.yml', 'loop-fleet-ledger-audit.yml']) {
      const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
      expect(source, name).toContain('/scripts/lib/canonical-json-digest.mjs');
    }
  });
});
