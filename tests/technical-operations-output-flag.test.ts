import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { auditWorkflowText } from '../scripts/ci/technical-operations-audit.mjs';

describe('technical operations output audit', () => {
  it('follows --github-output into args[github-output] writers', () => {
    const scriptPath = path.resolve('scripts/ci/publish-receipts.mjs');
    const source = [
      'name: delegated receipt output',
      'on: [push]',
      'jobs:',
      '  resolve:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - id: receipts',
      '        run: node scripts/ci/publish-receipts.mjs --resolve --github-output "$GITHUB_OUTPUT"',
      '      - run: echo "${{ steps.receipts.outputs.pages_deployed }} ${{ steps.receipts.outputs.pending_locales }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/output-flag.yml', source, {
      root: process.cwd(),
      exists: (candidate: string) => candidate === scriptPath,
      readFile: (candidate: string) => fs.readFileSync(candidate, 'utf8'),
    });

    expect(findings.filter((finding: any) => finding.rule === 'workflow.output-not-produced')).toEqual([]);
  });

  it('follows object-entry output maps inside delegated writers', () => {
    const scriptPath = path.resolve('scripts/ci/resolve-locale-publish-plan.mjs');
    const source = [
      'name: delegated plan output',
      'on: [push]',
      'jobs:',
      '  resolve:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - id: plan',
      '        run: node scripts/ci/resolve-locale-publish-plan.mjs --github-output "$GITHUB_OUTPUT"',
      '      - run: echo "${{ steps.plan.outputs.allowed }} ${{ steps.plan.outputs.it_admitted }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/plan-output.yml', source, {
      root: process.cwd(),
      exists: (candidate: string) => candidate === scriptPath,
      readFile: (candidate: string) => fs.readFileSync(candidate, 'utf8'),
    });

    expect(findings.filter((finding: any) => finding.rule === 'workflow.output-not-produced')).toEqual([]);
  });

  it('does not treat unrelated delegated file writers as GitHub output sinks', () => {
    const scriptPath = path.resolve('scripts/ci/delegated-output-fixture.mjs');
    const delegatedSource = [
      "function writeGithubOutputs(file, state) {",
      "  const lines = [`pages_deployed=${state.pagesDeployed}`];",
      "  fs.appendFileSync(file, `${lines.join('\\n')}\\n`);",
      "  fs.writeFileSync('/tmp/report', ['missing=from-report'].join('\\n'));",
      "}",
      "writeGithubOutputs(args['github-output'], state);",
    ].join('\n');
    const source = [
      'name: delegated output with report',
      'on: [push]',
      'jobs:',
      '  resolve:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - id: receipts',
      '        run: node scripts/ci/delegated-output-fixture.mjs --github-output "$GITHUB_OUTPUT"',
      '      - run: echo "${{ steps.receipts.outputs.missing }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/output-flag-report.yml', source, {
      root: process.cwd(),
      exists: (candidate: string) => candidate === scriptPath,
      readFile: (candidate: string) => {
        if (candidate !== scriptPath) throw new Error(`unexpected fixture path: ${candidate}`);
        return delegatedSource;
      },
    });

    expect(findings.filter((finding: any) => finding.rule === 'workflow.output-not-produced')).toEqual([
      expect.objectContaining({
        evidence: 'steps.receipts.outputs.missing',
      }),
    ]);
  });
});
