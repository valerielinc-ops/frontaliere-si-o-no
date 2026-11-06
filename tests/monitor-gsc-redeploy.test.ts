// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve('scripts/monitor-gsc-job-indexation.mjs'), 'utf8');
const workflow = readFileSync(resolve('.github/workflows/monitor-gsc-seo.yml'), 'utf8');

describe('GSC canonical regression redeploy handoff', () => {
  it('accoda una sola richiesta durevole e lascia il dispatch al workflow self-driven', () => {
    expect(source).toContain("import { enqueueDeployRearmRequest } from './ci/deploy-rearm-request.mjs';");
    expect(source).toContain("reason: 'canonical-regression'");
    expect(source).toContain('enqueueDeployRearmRequest({');
    expect(source).not.toContain("body: JSON.stringify({ ref: 'main' })");
    expect(source).not.toContain("actions/workflows/${DEPLOY_WORKFLOW}/dispatches");
    expect(source).toContain('await submitToIndexNow(canonicalFails.map(p => p.url));');
  });

  it('concede solo i permessi necessari per scrivere la richiesta e leggere la coda', () => {
    expect(workflow).toContain('actions: read');
    expect(workflow).toContain('statuses: write');
    expect(workflow).not.toContain("APP_TOKEN_REQUEST_DEPLOYMENTS_READ: 'true'");
  });
});
