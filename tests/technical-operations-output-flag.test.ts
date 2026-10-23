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
});
