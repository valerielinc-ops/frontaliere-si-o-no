import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');
const PRUNE_SCRIPT = 'scripts/prune-404-compat-paths.ts';
const EXPECTED_CALLERS = [
  'discover-404s-via-cloudflare.yml',
  'discover-404s.yml',
  'seo-health-loop.yml',
  'sync-gsc-orphans.yml',
].sort();

type WorkflowStep = {
  name?: string;
  run?: string;
  env?: Record<string, unknown>;
};

type Workflow = {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
};

describe('404 compatibility prune workflow callers', () => {
  it('fails closed in every workflow before committing or proposing a compatibility snapshot', () => {
    const callerFiles = new Set<string>();
    const unprotectedCallers: string[] = [];

    for (const file of fs.readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/.test(name))) {
      const source = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8');
      if (!source.includes(PRUNE_SCRIPT)) continue;

      const workflow = parseYaml(source) as Workflow;
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        for (const [stepIndex, step] of (job.steps ?? []).entries()) {
          if (!step.run?.includes(PRUNE_SCRIPT)) continue;

          callerFiles.add(file);
          const strictEnv = String(step.env?.PRUNE_404_STRICT ?? '') === '1';
          const strictInline = /^\s*PRUNE_404_STRICT=1(?:\s|$)/.test(step.run);
          if (!strictEnv && !strictInline) {
            unprotectedCallers.push(`${file}: ${jobName}/${step.name ?? stepIndex}`);
          }
        }
      }
    }

    expect([...callerFiles].sort()).toEqual(EXPECTED_CALLERS);
    expect(
      unprotectedCallers,
      `Unprotected prune call(s) could silently skip validation: ${unprotectedCallers.join(', ')}`,
    ).toEqual([]);
  });
});
