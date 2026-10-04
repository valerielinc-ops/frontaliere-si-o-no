// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const workflow = fs.readFileSync(
  path.resolve(process.cwd(), '.github/workflows/audit-parser-quality.yml'),
  'utf8',
);

describe('Audit Parser Quality workflow observability', () => {
  it('installs declared dependencies before the strict audit imports them', () => {
    expect(workflow).toMatch(/name: Setup Node[\s\S]*?name: Install audit dependencies[\s\S]*?run: npm ci[\s\S]*?name: Run parser quality audit \(strict\)/);
  });

  it('reserves enough job time for the complete source-detail pass', () => {
    expect(workflow).toMatch(/jobs:\n  audit:[\s\S]*?timeout-minutes: (?:[6-9]\d|[1-9]\d{2,})/);
  });

  it('uploads the complete JSON report even when the strict audit fails', () => {
    expect(workflow).toContain('uses: actions/upload-artifact@v7');
    expect(workflow).toMatch(/name: Run parser quality audit \(strict\)[\s\S]*?rm -f data\/parser-quality-report\.json[\s\S]*?node scripts\/audit-parser-quality\.mjs --strict --check-source-details/);
    expect(workflow).toMatch(/name: Upload parser quality report[\s\S]*?if: always\(\) && steps\.parser-audit\.outcome != 'skipped'/);
    expect(workflow).toMatch(/path: data\/parser-quality-report\.json/);
    expect(workflow).toMatch(/if-no-files-found: error/);
  });

  it('Audit Parser Quality: lo strict fallisce senza che il motivo arrivi alla issue — the strict step writes a diag file the reporter reads', () => {
    // Issue 5253: runs 37192114497, 37193497505 and 37213030719 failed the
    // strict step and the issue said "nessun estratto disponibile", because
    // the in-job reporter cannot read its own job's log.
    const doc = YAML.parse(workflow);
    const steps = doc.jobs.audit.steps as Array<{ name?: string; id?: string; run?: string; with?: Record<string, string> }>;
    const strict = steps.find((s) => s.id === 'parser-audit');
    const reporter = steps.find((s) => s.name === 'Report failure to GitHub Issues');
    expect(strict, 'strict audit step').toBeDefined();
    expect(reporter, 'reporter step').toBeDefined();

    const flag = String(strict!.run).match(/--diag-file="\$RUNNER_TEMP\/([^"]+)"/);
    expect(flag, 'strict audit passes --diag-file under $RUNNER_TEMP').not.toBeNull();
    const diagName = flag![1];
    // A diag left over from an earlier attempt must not be reported as this one.
    expect(String(strict!.run)).toContain(`rm -f data/parser-quality-report.json "$RUNNER_TEMP/${diagName}"`);
    expect(String(reporter!.with?.['diag-file'] || '')).toBe(`\${{ runner.temp }}/${diagName}`);
  });

  it('reports a timeout cancellation instead of silently skipping the failure reporter', () => {
    // The cancelled() branch stays (a timeout is a cancellation). The guard
    // that filters out a supersession by a newer run (issue 5253) is checked
    // structurally by tests/cancel-superseded-reporter-contract.test.ts.
    const doc = YAML.parse(workflow);
    const reporter = doc.jobs.audit.steps.find((s: { name?: string }) => s.name === 'Report failure to GitHub Issues');
    expect(reporter, 'Report failure to GitHub Issues step').toBeDefined();
    expect(String(reporter.if)).toMatch(/\bfailure\(\)/);
    expect(String(reporter.if)).toMatch(/\bcancelled\(\)/);
  });
});
