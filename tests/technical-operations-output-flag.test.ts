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

  it('ignora stdout.write dentro regex literal preservando divisioni e writer reali', () => {
    const scriptPath = path.resolve('scripts/ci/stdout-output-regex-decoy.mjs');
    const delegatedSource = [
      'const pattern = /process.stdout.write("fake=ok")/;',
      'const classPattern = /[/]process.stdout.write("fake=class")/;',
      'const quotient = left / process.stdout.write("division=yes\\n") / right;',
      'process.stdout.write("real=yes\\n");',
    ].join('\n');
    const source = [
      'name: stdout output regex decoys',
      'on: [push]',
      'jobs:',
      '  resolve:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - id: generated',
      '        run: node scripts/ci/stdout-output-regex-decoy.mjs >> "$GITHUB_OUTPUT"',
      '      - run: echo "${{ steps.generated.outputs.real }} ${{ steps.generated.outputs.division }} ${{ steps.generated.outputs.fake }} ${{ steps.generated.outputs.fake_class }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/stdout-output-regex-decoys.yml', source, {
      root: process.cwd(),
      exists: (candidate: string) => candidate === scriptPath,
      readFile: (candidate: string) => {
        if (candidate !== scriptPath) throw new Error(`unexpected fixture path: ${candidate}`);
        return delegatedSource;
      },
    });
    const outputFindings = findings.filter((finding: any) => finding.rule === 'workflow.output-not-produced');

    expect(outputFindings).toHaveLength(2);
    expect(outputFindings.map((finding: any) => finding.evidence)).toEqual(expect.arrayContaining([
      'steps.generated.outputs.fake',
      'steps.generated.outputs.fake_class',
    ]));
    expect(outputFindings.map((finding: any) => finding.evidence)).not.toEqual(expect.arrayContaining([
      'steps.generated.outputs.division',
      'steps.generated.outputs.real',
    ]));
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

  it('follows inline object maps passed to env.GITHUB_OUTPUT writers', () => {
    const scriptPath = path.resolve('scripts/social-copy/generate-free-model-fallback.mjs');
    const delegatedSource = [
      "import { appendFileSync } from 'node:fs';",
      'function writeWorkflowOutput(env, values) {',
      "  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\\n');",
      '  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${lines}\\n`);',
      '}',
      "writeWorkflowOutput(env, { pack_generated: false, provider: 'none', reason: 'failed', attempt_failures: 'none' });",
    ].join('\n');
    const source = [
      'name: social fallback output',
      'on: [push]',
      'jobs:',
      '  generate:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - id: free_fallback',
      '        run: node scripts/social-copy/generate-free-model-fallback.mjs',
      '      - run: echo "${{ steps.free_fallback.outputs.pack_generated }} ${{ steps.free_fallback.outputs.provider }} ${{ steps.free_fallback.outputs.reason }} ${{ steps.free_fallback.outputs.attempt_failures }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/social-copy-pack.yml', source, {
      root: process.cwd(),
      exists: (candidate: string) => candidate === scriptPath,
      readFile: (candidate: string) => {
        if (candidate !== scriptPath) throw new Error(`unexpected fixture path: ${candidate}`);
        return delegatedSource;
      },
    });

    expect(findings.filter((finding: any) => finding.rule === 'workflow.output-not-produced')).toEqual([]);
  });

  it('follows async writeFile targets derived from a --github-output flag', () => {
    const scriptPath = path.resolve('scripts/ci/section-tree-layout-preflight.mjs');
    const delegatedSource = [
      "import { writeFile } from 'node:fs/promises';",
      'function flag(argv, name, fallback) {',
      '  const index = argv.indexOf(name);',
      '  return index === -1 ? fallback : (argv[index + 1] || fallback);',
      '}',
      'const args = process.argv.slice(2);',
      "const output = flag(args, '--github-output', process.env.GITHUB_OUTPUT);",
      "if (output) await writeFile(output, 'ready=true\\n', { flag: 'a' });",
    ].join('\n');
    const workflow = (target: string) => [
      'name: async output flag',
      'on: [push]',
      'jobs:',
      '  preflight:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - id: preflight',
      `        run: node scripts/ci/section-tree-layout-preflight.mjs --github-output ${target}`,
      '      - run: echo "${{ steps.preflight.outputs.ready }}"',
    ].join('\n');
    const files = new Map([[scriptPath, delegatedSource]]);
    const audit = (source: string) => auditWorkflowText('.github/workflows/deploy-publish.yml', source, {
      root: process.cwd(),
      exists: (candidate: string) => files.has(candidate),
      readFile: (candidate: string) => files.get(candidate) || '',
    }).filter((finding: any) => finding.rule === 'workflow.output-not-produced');

    expect(audit(workflow('"$GITHUB_OUTPUT"'))).toEqual([]);
    expect(audit(workflow('"$RUNNER_TEMP/preflight.txt"')).map((finding: any) => finding.evidence))
      .toEqual(['steps.preflight.outputs.ready']);
  });

  it('does not infer a GitHub output sink from a report path containing the flag name', () => {
    const scriptPath = path.resolve('scripts/ci/report-with-flag-named-path.mjs');
    const delegatedSource = [
      "import { writeFile } from 'node:fs/promises';",
      "const report = path.join(dir, '--github-output');",
      "await writeFile(report, 'fake=true\\n');",
    ].join('\n');
    const source = [
      'name: report path output decoy',
      'on: [push]',
      'jobs:',
      '  report:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - id: report',
      '        run: node scripts/ci/report-with-flag-named-path.mjs --github-output "$GITHUB_OUTPUT"',
      '      - run: echo "${{ steps.report.outputs.fake }}"',
    ].join('\n');
    const findings = auditWorkflowText('.github/workflows/report-path-output.yml', source, {
      root: process.cwd(),
      exists: (candidate: string) => candidate === scriptPath,
      readFile: (candidate: string) => {
        if (candidate !== scriptPath) throw new Error(`unexpected fixture path: ${candidate}`);
        return delegatedSource;
      },
    });

    expect(findings.filter((finding: any) => finding.rule === 'workflow.output-not-produced'))
      .toEqual([expect.objectContaining({ evidence: 'steps.report.outputs.fake' })]);
  });
});
