import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Instagram Reel experiment workflow', () => {
  it('reports missing Graph credentials and skips only the live publish step', () => {
    const workflow = YAML.parse(fs.readFileSync(
      path.join(ROOT, '.github', 'workflows', 'instagram-reel-experiment.yml'),
      'utf8',
    ));
    const steps = workflow.jobs.build.steps as Array<{ name?: string; if?: string }>;
    const warn = steps.find((step) => /missing Instagram Graph API credentials/.test(step.name ?? ''));
    const publish = steps.find((step) => /Render and publish controlled Reel through Graph API/.test(step.name ?? ''));

    expect(warn?.if).toBe("env.DRY_RUN != 'true' && (env.INSTAGRAM_ACCESS_TOKEN == '' || env.INSTAGRAM_BUSINESS_ACCOUNT_ID == '')");
    expect(publish?.if).toBe("env.DRY_RUN == 'true' || (env.INSTAGRAM_ACCESS_TOKEN != '' && env.INSTAGRAM_BUSINESS_ACCOUNT_ID != '')");
  });
});
