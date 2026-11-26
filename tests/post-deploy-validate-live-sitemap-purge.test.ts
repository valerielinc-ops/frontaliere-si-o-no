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
const CONSENT_PURGE_URLS = [
  'https://frontaliereticino.ch/cerca-lavoro-ticino/',
  'https://origin-ticino-it.frontaliereticino.ch/cerca-lavoro-ticino/',
  'https://frontaliereticino.ch/cerca-lavoro-zurigo/',
  'https://origin-zurigo-it.frontaliereticino.ch/cerca-lavoro-zurigo/',
];
const EXPECTED_PURGE_URLS = [HOME_URL, SITEMAP_INDEX_URL, ...CONSENT_PURGE_URLS];
const ZONE_ID = '435c32ec15993fe826d2bb5eb62d3d43';

describe('post-deploy live exact-key purge', () => {
  it('targets the Pages, sitemap, and consent-probe keys within Cloudflare limits', () => {
    const urls = String(STEP?.env?.PAGES_PURGE_URLS ?? '')
      .split(',')
      .map((url) => url.trim());

    expect(STEP).toBeTruthy();
    expect(urls).toEqual(EXPECTED_PURGE_URLS);
    expect(STEP?.env?.CF_ZONE_ID).toBe(ZONE_ID);
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
