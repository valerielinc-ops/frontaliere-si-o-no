import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MAX_TARGETED_FILES } from '../scripts/lib/cf-purge-limits.mjs';

type WorkflowStep = {
  name?: string;
  if?: string;
  env?: Record<string, unknown>;
  run?: string;
};

const WORKFLOW = parse(readFileSync(
  new URL('../.github/workflows/post-deploy-validate-live.yml', import.meta.url),
  'utf8',
)) as { jobs: { 'validate-live': { steps: WorkflowStep[] } } };
const STEP = WORKFLOW.jobs['validate-live'].steps.find(
  (step) => step.name === 'Purge exact cache entry for the Pages home',
);
const HOME_URL = 'https://frontaliereticino.ch/';
const SITEMAP_INDEX_URL = 'https://frontaliereticino.ch/sitemap.xml';

describe('post-deploy live sitemap index purge', () => {
  it('targets the exact Pages home and sitemap index URLs within Cloudflare limits', () => {
    const urls = String(STEP?.env?.PAGES_PURGE_URLS ?? '')
      .split(',')
      .map((url) => url.trim());

    expect(STEP).toBeTruthy();
    expect(urls).toEqual([HOME_URL, SITEMAP_INDEX_URL]);
    expect(urls.length).toBeLessThanOrEqual(MAX_TARGETED_FILES);
    expect(STEP?.run).toContain('node scripts/cf-purge-cache.mjs "--files=$purge_urls"');
  });

  it('runs only after propagation and never invokes a zone-wide purge', () => {
    const run = String(STEP?.run ?? '');
    const executableRun = run
      .replace(/\\\r?\n[ \t]*/gu, ' ')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    const purgeInvocations = executableRun
      .split('\n')
      .filter((line) => /\bscripts\/cf-purge-cache\.mjs\b/u.test(line));

    expect(STEP?.if).toBe("steps.propagation.outcome == 'success'");
    expect(JSON.stringify(STEP)).not.toContain('purge_everything');
    expect(run).toContain('if [ -z "${CF_API_TOKEN:-}" ]; then');
    expect(run).toContain('if [ -z "$purge_urls" ]; then');
    expect(purgeInvocations).toHaveLength(1);
    expect(purgeInvocations.every((line) => /--files=/u.test(line))).toBe(true);
  });
});
