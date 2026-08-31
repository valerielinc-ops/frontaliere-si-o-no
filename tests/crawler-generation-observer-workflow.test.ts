import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = path.join(
  ROOT,
  '.github/corpus-workflows/observers/workflows/crawler-generation-observer-shadow.yml',
);

function collectRelativeImportClosure(entrypoint: string) {
  const pending = [entrypoint];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const runtimePath = pending.pop()!;
    if (visited.has(runtimePath)) continue;
    visited.add(runtimePath);
    const source = fs.readFileSync(path.join(ROOT, runtimePath), 'utf8');
    for (const match of source.matchAll(/^\s*(?:import|export)\s+(?:(?:\{[\s\S]*?\}|[^'"\n]+)\s+from\s+)?['"](\.[^'"]+)['"]/gm)) {
      pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(runtimePath), match[1])));
    }
  }
  return [...visited].sort();
}

describe('portable crawler generation observer workflow', () => {
  it('is manual-only in PR A, so legacy and malformed crawler titles allocate zero observer runners', () => {
    const doc = YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
    expect(Object.keys(doc.on)).toEqual(['workflow_dispatch']);
    expect(doc.on).not.toHaveProperty('workflow_run');
    expect(doc.on.workflow_dispatch.inputs).toMatchObject({
      generation_token: { required: true, type: 'string' },
      site_code_commit: { required: true, type: 'string' },
      registry_json: { required: true, type: 'string' },
    });
    expect(doc['run-name']).toBe('crawler-generation-sentinel-${{ inputs.generation_token }}');
  });

  it('has read-only permissions, a pinned site checkout and no translate/repository dispatch', () => {
    const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
    const doc = YAML.parse(text);
    expect(doc.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(doc.concurrency).toEqual({
      group: 'crawler-generation-observer-${{ inputs.generation_token }}',
      'cancel-in-progress': false,
    });
    const job: any = doc.jobs.observe;
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
    expect(text).not.toMatch(/workflow_run:/);
    expect(text).not.toMatch(/translate-pending|gh workflow run|repository_dispatch|git push|contents:\s*write|actions:\s*write|secrets\./);
  });

  it('persists the same-run sentinel and bounded diagnostic report for 14 days', () => {
    const doc = YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
    const steps: any[] = doc.jobs.observe.steps;
    const uploads = steps.filter((step) => step.uses === 'actions/upload-artifact@v7');
    expect(uploads).toHaveLength(2);
    expect(uploads[0].with).toMatchObject({
      name: 'crawler-generation-sentinel-${{ inputs.generation_token }}',
      'retention-days': 14,
      overwrite: true,
      'if-no-files-found': 'error',
    });
    expect(uploads[1].with).toMatchObject({
      name: 'crawler-generation-observer-${{ inputs.generation_token }}-${{ github.run_id }}',
      'retention-days': 14,
      overwrite: true,
      'if-no-files-found': 'error',
    });
  });

  it('sparse-checkout contains the complete observer import closure plus the generated roster', () => {
    const doc = YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
    const checkout = doc.jobs.observe.steps.find((step: any) => step.uses === 'actions/checkout@v5');
    const sparsePaths = checkout.with['sparse-checkout']
      .split('\n')
      .map((value: string) => value.trim().replace(/^\//, ''))
      .filter(Boolean)
      .sort();
    expect(sparsePaths).toEqual([
      ...collectRelativeImportClosure('scripts/crawler-generation-observer.mjs'),
      'scripts/ci/crawler-generation-roster.json',
    ].sort());
  });
});
