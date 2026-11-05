import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { auditWorkflowText } from '../scripts/ci/technical-operations-audit.mjs';

describe('technical operations output audit', () => {
  it('keeps all printf keys in a continued GITHUB_OUTPUT command', () => {
    const printfLine = '        printf \'source_run_id=%s\\nsource_sha=%s\\npublisher_run_id=%s\\n\' ' + '\\';
    const source = [
      'name: continued output command',
      'on: [push]',
      'jobs:',
      '  resolve:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - id: source-identity',
      '        run: |',
      printfLine,
      '          "$source_id" "$source_sha" "$publisher_id" >> "$GITHUB_OUTPUT"',
      '          echo "${{ steps.source-identity.outputs.source_run_id }} ${{ steps.source-identity.outputs.source_sha }} ${{ steps.source-identity.outputs.publisher_run_id }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/continued-output.yml', source, {
      root: process.cwd(),
    });

    expect(findings.filter((finding: any) => finding.rule === 'workflow.output-not-produced')).toEqual([]);
  });

  it('follows destructured GITHUB_OUTPUT aliases into appendFileSync writers', () => {
    const scriptPath = path.resolve('scripts/ci/resolve-application-recovery-marker.mjs');
    const source = [
      'name: destructured output',
      'on: [push]',
      'jobs:',
      '  resolve:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - id: recovery',
      '        run: node scripts/ci/resolve-application-recovery-marker.mjs',
      '      - run: echo "${{ steps.recovery.outputs.apply }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/destructured-output.yml', source, {
      root: process.cwd(),
      exists: (candidate: string) => candidate === scriptPath,
      readFile: (candidate: string) => fs.readFileSync(candidate, 'utf8'),
    });

    expect(findings.filter((finding: any) => finding.rule === 'workflow.output-not-produced')).toEqual([]);
  });

  it('follows stdout writers when the workflow redirects them to GITHUB_OUTPUT', () => {
    const scriptPath = path.resolve('scripts/social-copy/reserve-codex-invocation.mjs');
    const source = [
      'name: stdout output',
      'on: [push]',
      'jobs:',
      '  reserve:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - id: codex-budget',
      '        run: node scripts/social-copy/reserve-codex-invocation.mjs >> "$GITHUB_OUTPUT"',
      '      - run: echo "${{ steps.codex-budget.outputs.allowed }} ${{ steps.codex-budget.outputs.count }} ${{ steps.codex-budget.outputs.limit }} ${{ steps.codex-budget.outputs.window_ends_at }} ${{ steps.codex-budget.outputs.message }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/stdout-output.yml', source, {
      root: process.cwd(),
      exists: (candidate: string) => candidate === scriptPath,
      readFile: (candidate: string) => fs.readFileSync(candidate, 'utf8'),
    });

    expect(findings.filter((finding: any) => finding.rule === 'workflow.output-not-produced')).toEqual([]);
  });

  it('ignora stdout.write dentro commenti e literal quando calcola le chiavi', () => {
    const scriptPath = path.resolve('scripts/ci/stdout-output-decoys.mjs');
    const delegatedSource = [
      '// process.stdout.write("fake_comment=yes")',
      'const documentation = `process.stdout.write("fake_string=yes")`;',
      '/* process.stdout.write("fake_block=yes") */',
      'process.stdout.write("real=yes\\n");',
    ].join('\n');
    const source = [
      'name: stdout output decoys',
      'on: [push]',
      'jobs:',
      '  resolve:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - id: generated',
      '        run: node scripts/ci/stdout-output-decoys.mjs >> "$GITHUB_OUTPUT"',
      '      - run: echo "${{ steps.generated.outputs.real }} ${{ steps.generated.outputs.fake_comment }} ${{ steps.generated.outputs.fake_string }} ${{ steps.generated.outputs.fake_block }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/stdout-output-decoys.yml', source, {
      root: process.cwd(),
      exists: (candidate: string) => candidate === scriptPath,
      readFile: (candidate: string) => {
        if (candidate !== scriptPath) throw new Error(`unexpected fixture path: ${candidate}`);
        return delegatedSource;
      },
    });
    const outputFindings = findings.filter((finding: any) => finding.rule === 'workflow.output-not-produced');

    expect(outputFindings).toHaveLength(3);
    expect(outputFindings.map((finding: any) => finding.evidence)).toEqual(expect.arrayContaining([
      'steps.generated.outputs.fake_comment',
      'steps.generated.outputs.fake_string',
      'steps.generated.outputs.fake_block',
    ]));
    expect(outputFindings.map((finding: any) => finding.evidence)).not.toContain('steps.generated.outputs.real');
  });

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
