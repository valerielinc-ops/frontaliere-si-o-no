// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve('scripts/monitor-gsc-job-indexation.mjs'), 'utf8');
const workflow = readFileSync(resolve('.github/workflows/monitor-gsc-seo.yml'), 'utf8');

describe('GSC canonical regression redeploy handoff', () => {
  it('checks a bounded main deploy queue before dispatching one redeploy', () => {
    expect(source).toContain("import { createdSinceQuery } from './ci/lib/run-listing-window.mjs';");
    expect(source).toMatch(/actions\/workflows\/\$\{DEPLOY_WORKFLOW\}\/runs\?branch=main&\$\{createdSinceQuery\(REDEPLOY_RUN_WINDOW_DAYS\)\}/);
    expect(source).toContain('LIVE_DEPLOY_RUN_STATUSES.has(text(run?.status))');
    expect(source).toContain("method: 'POST'");
    expect(source).toContain("body: JSON.stringify({ ref: 'main' })");
    expect(source).toContain('await enqueueBoundedRedeploy();');
    expect(source).toContain('await submitToIndexNow(canonicalFails.map(p => p.url));');
  });

  it('requests and verifies a dispatch-capable App token before preferring it', () => {
    expect(workflow).toContain("APP_TOKEN_REQUEST_DEPLOYMENTS_READ: 'true'");
    expect(workflow).toContain("env.APP_TOKEN_ACTIONS == 'true' && env.APP_TOKEN || env.GITHUB_PAT");
  });
});
