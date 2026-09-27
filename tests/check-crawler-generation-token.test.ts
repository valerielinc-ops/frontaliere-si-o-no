import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { checkCrawlerGenerationToken } from '../scripts/check-crawler-generation-token.mjs';
import { CRAWLER_GENERATION_TOKEN_PREFLIGHT_STEP_NAME } from '../scripts/generate-crawler-group-workflows.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUN = { GITHUB_RUN_ID: '36310046588', GITHUB_RUN_ATTEMPT: '1' };

describe('checkCrawlerGenerationToken', () => {
  it('accepts the orchestrator token', () => {
    expect(checkCrawlerGenerationToken({ ...RUN, CRAWLER_GENERATION_TOKEN: '36326506734-1' }))
      .toEqual({ ok: true, token: '36326506734-1' });
  });

  it('derives the token from the run coordinates when the input is empty', () => {
    expect(checkCrawlerGenerationToken({ ...RUN, CRAWLER_GENERATION_TOKEN: '' }))
      .toEqual({ ok: true, token: '36310046588-1' });
  });

  it('normalizes YAML quoting around a valid explicit token', () => {
    expect(checkCrawlerGenerationToken({ ...RUN, CRAWLER_GENERATION_TOKEN: " '36326506734-2' " }))
      .toEqual({ ok: true, token: '36326506734-2' });
  });

  it('rejects the free-form token that crawled for an hour on 2026-09-27', () => {
    const result = checkCrawlerGenerationToken({
      ...RUN,
      CRAWLER_GENERATION_TOKEN: 'backlog-100-20260927-group19',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('"backlog-100-20260927-group19"');
      expect(result.message).toContain('<run_id>-<run_attempt>');
    }
  });

  it('does not fall back to run coordinates for a malformed explicit value', () => {
    for (const token of ['0-1', '123-0', '123', '"   "', 'crawler-generation-1-1']) {
      expect(checkCrawlerGenerationToken({ ...RUN, CRAWLER_GENERATION_TOKEN: token }).ok).toBe(false);
    }
  });
});

function groupWorkflows(dir: string, pattern: RegExp) {
  return fs.readdirSync(path.join(ROOT, dir))
    .filter((file) => pattern.test(file))
    .map((file) => ({ file, doc: YAML.parse(fs.readFileSync(path.join(ROOT, dir, file), 'utf8')) }));
}

describe('generated crawler groups validate the token before crawling', () => {
  const workflows = [
    ...groupWorkflows('.github/workflows', /^crawler-group-\d{2}-logic\.yml$/),
    ...groupWorkflows('.github/corpus-workflows', /^crawler-group-\d{2}\.yml$/),
  ];

  it('covers every logic and corpus group workflow', () => {
    expect(workflows.length).toBe(48);
  });

  it.each(workflows.map(({ file, doc }) => [file, doc]))('%s', (_file, doc: any) => {
    const job: any = Object.values(doc.jobs)[0];
    const names = job.steps.map((step: any) => step.name ?? step.uses);
    const preflight = names.indexOf(CRAWLER_GENERATION_TOKEN_PREFLIGHT_STEP_NAME);
    const setup = job.steps.findIndex((step: any) => step.id === 'crawler_group_setup');
    const firstLaunch = job.steps.findIndex((step: any) => String(step.id ?? '').startsWith('crawler-launch-'));
    const lastCheckout = job.steps.reduce(
      (last: number, step: any, index: number) => (String(step.uses ?? '').startsWith('actions/checkout@') ? index : last),
      -1,
    );

    expect(preflight).toBeGreaterThan(lastCheckout);
    expect(preflight).toBeLessThan(setup);
    expect(setup).toBeLessThan(firstLaunch);
    // Without an `if`, a failed preflight skips the setup confirmation, and
    // every launcher/commit step is gated on that confirmation's success.
    expect(job.steps[preflight].if).toBeUndefined();
    expect(job.steps[setup].if).toBeUndefined();
    expect(job.steps[preflight].run).toBe('node scripts/check-crawler-generation-token.mjs');
    expect(job.env.CRAWLER_GENERATION_TOKEN)
      .toBe("${{ inputs.generation_token || format('{0}-{1}', github.run_id, github.run_attempt) }}");
  });
});
