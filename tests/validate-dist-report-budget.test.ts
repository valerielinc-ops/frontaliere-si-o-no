import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * The 60–115 minute page-quality walk used to be the last step of
 * validate-dist-postbuild. Keeping it there made a report-only audit hold the
 * dist-validation lock and delay publish. These assertions pin the split:
 * the blocking workflow contains integrity only, while the reusable report
 * workflow owns the quality walk and can be called without a publish edge.
 */

const root = path.resolve(import.meta.dirname, '..');
const distPath = path.join(root, '.github', 'workflows', 'post-deploy-validate-dist.yml');
const auditPath = path.join(root, '.github', 'workflows', 'audit-dist-from-run.yml');
const distText = fs.readFileSync(distPath, 'utf8');
const auditText = fs.readFileSync(auditPath, 'utf8');
const distWorkflow = YAML.parse(distText) as any;
const auditWorkflow = YAML.parse(auditText) as any;
const distJob = distWorkflow.jobs['validate-dist-postbuild'];
const auditJob = auditWorkflow.jobs.audit;

const stepNames = (job: any): string[] => (job?.steps ?? []).map((step: any) => String(step?.name ?? ''));

describe('validate-dist: quality reports stay outside the blocking gate', () => {
  it('does not carry the serial page-SEO report or its timeout budget', () => {
    const names = stepNames(distJob);
    expect(names).not.toContain('Validate page SEO quality (report-only)');
    expect(names).not.toContain('Budget for the report-only SEO quality walk');
    expect(distText).not.toContain('npm run validate:page-seo');
    expect(distText).not.toContain('VALIDATE_DIST_STARTED_AT=');
  });

  it('keeps the blocking job fail-closed and bounded at 350 minutes', () => {
    expect(distJob['timeout-minutes']).toBe(350);
    expect(distText).toContain('collect_failed source /tmp/source-val-results.txt');
    expect(distText).toContain('collect_failed postbuild /tmp/post-build-timings.txt');
    expect(distText).not.toContain('collect_failed bfs /tmp/bfs-timings.txt');
    expect(distText).toContain('missing validator result file');
    expect(distText).toContain('[ "$FAIL" -eq 0 ] || exit 1');
  });

  it('exposes audit-dist-from-run as a reusable report workflow', () => {
    expect(auditWorkflow.on.workflow_call).toBeTruthy();
    expect(auditWorkflow.on.workflow_call.inputs.deploy_run_id.required).toBe(true);
    expect(auditWorkflow.on.workflow_call.inputs.audit_all_audits).toBeTruthy();
    expect(auditWorkflow.on.workflow_call.inputs.shard_artifact_run_id).toBeTruthy();
    expect(auditJob?.steps?.find((step: any) => step.name === 'Run requested audits')?.env?.INPUT_AUDIT_ALL).toContain('inputs.audit_all_audits');
    expect(auditText).toContain('report:meta-description');
  });
});
