import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { buildStatusRows } from '../../scripts/ci/loop-fleet-status.mjs';

type Step = { name: string; run?: string; uses?: string; with?: { path?: string } };

const amount = '987654.321';
const diagnostic = 'SYNTHETIC_PRIVATE_DIAGNOSTIC';
const experiment = 'synthetic-private-experiment';
const cases = [
  ['revenue-monitor', 'Run revenue monitor (save report)', 'Report failure to GitHub Issues', 'revenue-monitor.md', 23],
  ['funnel-metrics-snapshot', 'Collect funnel metrics (revenue-monitor JSON)', 'Comment snapshot on tracker issues', 'funnel-revenue.json', 0],
  ['adsense-format-ab-report', 'Run AdSense format A/B report (save)', 'Open/update the weekly tracking issue', 'adsense-format-ab-report.md', 23],
  ['loop-l8-revenue-attribution', 'Audit revenue attribution', 'Write public L8 execution status', 'l8-private/cli-output.log', 23],
] as const;

function workflowSteps(workflow: string): Step[] {
  const source = readFileSync('.github/workflows/' + workflow + '.yml', 'utf8');
  const { jobs } = YAML.parse(source) as { jobs: Record<string, { steps: Step[] }> };
  return Object.values(jobs).flatMap(({ steps }) => steps);
}

function assertPrivate(publicText: string) {
  for (const marker of [amount, diagnostic, experiment]) expect(publicText).not.toContain(marker);
  expect(publicText).not.toMatch(/--(?:body|description)-file/);
}

describe('economic reports stay on the runner', () => {
  it.each(cases)('%s isolates report and diagnostic output', (workflow, dataStep, publicStep, privateFile, failureCode) => {
    const dir = mkdtempSync(join(tmpdir(), 'economic-report-'));
    try {
      const reportDir = join(dir, 'l8-private');
      const summary = join(dir, 'summary');
      const issue = join(dir, 'issue');
      const output = join(dir, 'output');
      for (const file of [summary, issue, output]) writeFileSync(file, '');
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const env = {
        ...process.env,
        PATH: bin + ':' + process.env.PATH,
        RUNNER_TEMP: dir,
        REPORT_DIR: reportDir,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_OUTPUT: output,
        GITHUB_ENV: join(dir, 'env'),
        GITHUB_REF_NAME: 'synthetic',
        GITHUB_RUN_ID: '123',
        GITHUB_SHA: 'a'.repeat(40),
        ISSUE_ENABLED: 'true',
        ISSUE_CAPTURE: issue,
        SOURCE_LOOP: 'L8',
        AUDIT_STATUS: 'failure',
        VALIDATION_STATUS: 'success',
        EVIDENCE_STATUS: 'success',
        SYNTHETIC_AMOUNT: amount,
        SYNTHETIC_DIAGNOSTIC: diagnostic,
        SYNTHETIC_EXPERIMENT: experiment,
      };
      writeFileSync(join(bin, 'node'), `#!/bin/bash
case "$1" in
  --input-type=module) echo "$SYNTHETIC_EXPERIMENT"; exit 0 ;;
  *adsense-format-ab-plan.mjs)
    printf 'active=true\\nexperiments=%s\\n' "$SYNTHETIC_EXPERIMENT" >> "$GITHUB_OUTPUT"
    if [ -n "$GITHUB_STEP_SUMMARY" ]; then echo "$SYNTHETIC_EXPERIMENT" >> "$GITHUB_STEP_SUMMARY"; fi
    echo "$SYNTHETIC_DIAGNOSTIC" >&2
    exit 0 ;;
  *github-issue-creator.mjs) printf '%s\\n' "$@" >> "$ISSUE_CAPTURE"; exit 0 ;;
esac
echo "$SYNTHETIC_AMOUNT"
echo "$SYNTHETIC_DIAGNOSTIC" >&2
exit "$MOCK_EXIT"
`, { mode: 0o700 });
      writeFileSync(join(bin, 'gh'), '#!/bin/bash\nprintf "%s\\n" "$@" >> "$ISSUE_CAPTURE"\n', { mode: 0o700 });

      writeFileSync(join(bin, 'git'), `#!/bin/bash
case "$1" in
  status) echo ' M synthetic-history' ;;
  diff) exit 1 ;;
esac
`, { mode: 0o700 });
      writeFileSync(join(bin, 'bash'), `#!/bin/bash
echo "$SYNTHETIC_DIAGNOSTIC" >&2
exit "$MOCK_EXIT"
`, { mode: 0o700 });

      const steps = workflowSteps(workflow);
      function run(name: string, mockExit = 0, expectedExit = 0, jobSteps = steps) {
        const step = jobSteps.find((candidate) => candidate.name === name);
        expect(step?.run).toBeDefined();
        const result = spawnSync('/bin/bash', ['-eo', 'pipefail', '-c', step!.run!.replace(/\$\{\{[^}]+\}\}/g, 'metadata')], {
          cwd: dir, env: { ...env, MOCK_EXIT: String(mockExit) }, encoding: 'utf8',
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(expectedExit);
        assertPrivate(result.stdout + result.stderr);
      }

      const uploads = steps.filter((step) => step.uses?.includes('upload-artifact'));
      if (workflow === 'adsense-format-ab-report') run('Resolve active experiments');
      run(dataStep);
      run(publicStep);
      run(dataStep, 23, failureCode);
      run(publicStep);

      if (workflow !== 'loop-l8-revenue-attribution') {
        const historyStep = steps.find((step) => step.name.startsWith('Commit '));
        expect(historyStep?.name).toBeDefined();
        run(historyStep!.name);
        run(historyStep!.name, 23, 23);
      }

      if (workflow === 'funnel-metrics-snapshot') {
        run('Build snapshot and validate history');
        run('Summarize snapshot status');
        run('Build snapshot and validate history', 23, 23);
      }

      const privateReport = join(dir, privateFile);
      expect(readFileSync(privateReport, 'utf8')).toContain(amount);
      expect(statSync(privateReport).mode & 0o077).toBe(0);
      assertPrivate([summary, issue, output].map((file) => readFileSync(file, 'utf8')).join('\n'));

      if (workflow === 'loop-l8-revenue-attribution') {
        run('Export fresh L8 attribution outcome');
        run('Export fresh L8 attribution outcome', 23, 23);
        run('Build unavailable L8 attribution input for pull requests');
        run('Build unavailable L8 attribution input for pull requests', 23, 23);
        run('Record canonical L8 evidence');
        run('Record canonical L8 evidence', 23, 23);
        expect(uploads.map((step) => step.with?.path)).toEqual(['${{ runner.temp }}/l8-public/loop-fleet-evidence.json']);
        const projected = readFileSync(join(dir, 'l8-public/loop-fleet-evidence.json'), 'utf8');
        assertPrivate(projected);
        expect(JSON.parse(projected)).toMatchObject({
          loopId: 'L8', auditStatus: 'failure', privateEvidence: true, evidenceComplete: false,
          outcome: { status: 'unmeasurable', independent: false },
        });
        writeFileSync(join(reportDir, 'l8-result.json'), '{"issued":true,"ok":false}');
        run(dataStep, 23);
        expect(readFileSync(summary, 'utf8')).toContain('L8 finding persisted');

        run('Download immutable source artifact', 0, 0, workflowSteps('loop-fleet-ledger'));
        expect(readFileSync(output, 'utf8')).toContain('available=false');
        expect(readFileSync(issue, 'utf8')).toBe('');
        expect(readFileSync(summary, 'utf8')).toContain('Durable persistence is unavailable');
      } else {
        expect(uploads).toEqual([]);
        expect(steps.map(({ run }) => run).join('\n')).not.toMatch(/git add -A|git add .*reports\//);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits legacy L8 outcomes, diagnostics and durable records from fleet status', () => {
    const registry = JSON.parse(readFileSync('data/loop-fleet/loop-registry.json', 'utf8'));
    const privateEvidence = {
      outcome: { status: 'observed', independent: true, numerator: Number(amount), reason: diagnostic },
      quality: 'observed',
      outcomePolicyCompliant: true,
      lifecycleCompliant: true,
    };
    const [l8] = buildStatusRows(registry, {}, { L8: {
      evidence: privateEvidence, canonicalHealth: privateEvidence, canonicalError: diagnostic,
    } }).filter((row: { loopId: string }) => row.loopId === 'L8');
    assertPrivate(JSON.stringify(l8));
    expect(l8.outcome).toMatchObject({ status: 'unmeasurable', independent: false });
    expect(l8.missingOutcome).toContain('private');
  });
});
