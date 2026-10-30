import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
const JOBS_SEO_PLUGIN = fs.readFileSync(
  path.join(ROOT, 'build-plugins/jobsSeoPagesPlugin.ts'),
  'utf8',
);

function trustedCheckoutBlock(source: string): string {
  const start = source.indexOf('CHECKOUT UNICO per tutte e quattro le famiglie');
  const end = source.indexOf('      # per `compare`', start);
  return start >= 0 && end > start ? source.slice(start, end) : '';
}

describe('jobsSeoPagesPlugin trusted renderer contract (#16058)', () => {
  it('runs the renderer verdict from the complete checkout path', () => {
    const checkout = trustedCheckoutBlock(WORKFLOW);

    expect(checkout).toContain('actions/checkout@v7');
    expect(checkout).toMatch(/fetch-depth:\s*0/);
    expect(checkout).toMatch(/filter:\s*tree:0/);
    expect(checkout).not.toMatch(/^\s+sparse-checkout(?:-cone-mode)?:/m);
    expect(WORKFLOW).toContain('node scripts/ci/run-related-tests.mjs --select-only');
    expect(WORKFLOW).toContain('node scripts/ci/run-related-tests.mjs --reporter=default');
  });

  it('keeps the renderer completion checkpoints observable', () => {
    expect(JOBS_SEO_PLUGIN).toContain('export function jobsSeoPagesPlugin');
    expect(JOBS_SEO_PLUGIN).toContain("activeJobPostingCoverage.assertComplete('jobposting-coverage')");
    expect(JOBS_SEO_PLUGIN).toContain("'jobsSeoPages: after corpus-release'");
    expect(JOBS_SEO_PLUGIN).toContain('releasedValidJobs: validJobs.length === 0 ? 1 : 0');
    expect(JOBS_SEO_PLUGIN).toContain('releasedJobHtmlCache: jobHtmlCache.size === 0 ? 1 : 0');
    expect(JOBS_SEO_PLUGIN).toContain(
      'releasedRelatedIndexes: relatedJobsByCategory.size === 0 && relatedJobsByLocation.size === 0 ? 1 : 0',
    );
  });
});
