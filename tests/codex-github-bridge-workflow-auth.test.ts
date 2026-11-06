import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOWS = join(ROOT, '.github/workflows');
const CODEX_ACTION = './.github/actions/claude-codex-fallback';

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => join(WORKFLOWS, name));
}

describe('Codex GitHub bridge workflow auth', () => {
  it('requires every Codex action caller to supply its explicit bridge token', () => {
    const callers: Array<{ workflow: string; token: unknown }> = [];

    for (const file of workflowFiles()) {
      const document = YAML.parse(readFileSync(file, 'utf8')) as {
        jobs?: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }>;
      };
      for (const [jobName, job] of Object.entries(document.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (step.uses === CODEX_ACTION) {
            callers.push({
              workflow: `${file.slice(ROOT.length + 1)}:${jobName}`,
              token: step.with?.codex_github_token,
            });
          }
        }
      }
    }

    expect(callers.length).toBeGreaterThan(0);
    for (const caller of callers) {
      expect(caller.token, `${caller.workflow} must pass codex_github_token`).toEqual(expect.any(String));
      expect((caller.token as string).trim(), `${caller.workflow} must not pass an empty token`).not.toBe('');
    }
  });

  it('keeps social copy generation on the read-only workflow token', () => {
    const workflow = YAML.parse(readFileSync(join(WORKFLOWS, 'social-copy-pack.yml'), 'utf8')) as {
      jobs?: {
        generate?: {
          permissions?: Record<string, string>;
          steps?: Array<{ name?: string; with?: Record<string, unknown> }>;
        };
      };
    };
    const generate = workflow.jobs?.generate;
    const codex = generate?.steps?.find((step) => step.name === 'Generate social copy with Codex');

    expect(generate?.permissions).toEqual({ contents: 'read' });
    expect(codex?.with?.codex_github_token).toBe('${{ secrets.GITHUB_TOKEN }}');
  });
});
