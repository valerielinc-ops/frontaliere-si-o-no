import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { GROUP_IDS } from '../scripts/lib/crawler-generation-contract.mjs';
import { collectRelativeImportClosure } from './helpers/collectRelativeImportClosure';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = path.join(
  ROOT,
  '.github/corpus-workflows/observers/workflows/crawler-generation-observer-shadow.yml',
);

describe('portable crawler generation observer workflow', () => {
  it('uses exactly 23 workflow_run triggers and rejects legacy empty-token runs before runner allocation', () => {
    const doc = YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
    expect(Object.keys(doc.on)).toEqual(['workflow_dispatch', 'workflow_run', 'schedule']);
    expect(doc.on.schedule).toEqual([{ cron: '23 2,8,14,20 * * *' }]);
    expect(doc.on.workflow_run.workflows).toEqual(GROUP_IDS.map(
      (group) => `Crawler Group ${group} (sparse cross-repo execution)`,
    ));
    expect(doc.jobs.probe.if).toContain("!startsWith(github.event.workflow_run.display_title, 'crawler-generation--group-')");
    expect(doc.on.workflow_dispatch.inputs).toMatchObject({
      generation_token: { required: true, type: 'string' },
      site_code_commit: { required: true, type: 'string' },
      registry_json: { required: true, type: 'string' },
    });
    expect(doc['run-name']).toContain('github.event.workflow_run.id');
    expect(doc.jobs.probe.steps[0].run).toContain('^crawler-generation-([1-9][0-9]*-[1-9][0-9]*)-group-');
    expect(doc.jobs.probe.steps[0].env.TRIGGER_RUN_ID).toBe('${{ github.event.workflow_run.id }}');
    expect(doc.jobs.probe.steps[0].run).toContain('.groups[$group].runId == $triggerRunId');
  });

  it('has read-only permissions, a pinned site checkout and no translate/repository dispatch', () => {
    const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const doc = YAML.parse(text);
    expect(doc.permissions).toEqual({ actions: 'read', contents: 'read' });
    const job: any = doc.jobs.sentinel;
    expect(job['timeout-minutes']).toBeLessThanOrEqual(15);
    const checkout = job.steps.find((step: any) => step.uses === 'actions/checkout@v5');
    expect(checkout.with.repository).toBe('valerielinc-ops/frontaliere-si-o-no');
    expect(checkout.with.ref).toBe('${{ inputs.site_code_commit }}');
    expect(checkout.with['persist-credentials']).toBe(false);
    const prepare = job.steps.find((step: any) => step.name === 'Validate and persist same-run sentinel');
    expect(prepare.env).toEqual({
      EXPECTED_GENERATION_TOKEN: '${{ inputs.generation_token }}',
      EXPECTED_SITE_CODE_COMMIT: '${{ inputs.site_code_commit }}',
    });
    expect(prepare.run).toContain('--expected-generation-token "$EXPECTED_GENERATION_TOKEN"');
    expect(prepare.run).toContain('--expected-site-code-commit "$EXPECTED_SITE_CODE_COMMIT"');
    expect(doc.jobs.probe.steps.some((step: any) => step.uses === 'actions/checkout@v5')).toBe(false);
    expect(doc.jobs.observe_event.concurrency).toEqual({
      group: 'crawler-generation-observer-${{ needs.probe.outputs.generation_token }}',
      'cancel-in-progress': true,
    });
    expect(text).not.toMatch(/translate-pending|gh workflow run|repository_dispatch|git push|contents:\s*write|actions:\s*write|secrets\./);
  });

  it('persists the same-run sentinel and bounded diagnostic report for 14 days', () => {
    const doc = YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
    const steps: any[] = doc.jobs.sentinel.steps;
    const uploads = steps.filter((step) => step.uses === 'actions/upload-artifact@v7');
    expect(uploads).toHaveLength(2);
    expect(uploads[0].with).toMatchObject({
      name: 'crawler-generation-sentinel-${{ inputs.generation_token }}',
      'retention-days': 14,
      overwrite: true,
      'if-no-files-found': 'error',
    });
    expect(uploads[1].with).toMatchObject({
      name: 'crawler-generation-observer-${{ inputs.generation_token }}',
      'retention-days': 14,
      overwrite: true,
      'if-no-files-found': 'error',
    });
    const eventUpload = doc.jobs.observe_event.steps.find(
      (step: any) => step.uses === 'actions/upload-artifact@v7',
    );
    expect(eventUpload.with).toMatchObject({
      'retention-days': 14,
      overwrite: true,
      'if-no-files-found': 'error',
    });
  });

  it('sparse-checkout contains the complete observer import closure plus the generated roster', () => {
    const doc = YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
    for (const job of [doc.jobs.sentinel, doc.jobs.observe_event]) {
      const checkout = job.steps.find((step: any) => step.uses === 'actions/checkout@v5');
      const sparsePaths = checkout.with['sparse-checkout']
        .split('\n')
        .map((value: string) => value.trim().replace(/^\//, ''))
        .filter(Boolean)
        .sort();
      expect(sparsePaths).toEqual([
        ...collectRelativeImportClosure(ROOT, 'scripts/crawler-generation-observer.mjs'),
        'scripts/ci/crawler-generation-roster.json',
      ].sort());
    }
  });
});
