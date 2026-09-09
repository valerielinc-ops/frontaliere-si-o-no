import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const nonGeneratedWorkflowNames = [
  'translate-pending.yml',
  'analytics.yml',
  'batch-faq-articles.yml',
  'generate-article.yml',
  'generate-company-parser.yml',
  'publish-journalist-articles.yml',
  'send-newsletter.yml',
  'smoke-test-ai-models.yml',
  'snapshot-jobs-weekly.yml',
];

const workflowDir = path.resolve(process.cwd(), '.github/workflows');
const corpusWorkflowDir = path.resolve(process.cwd(), '.github/corpus-workflows');
const workflowTargets = [
  ...nonGeneratedWorkflowNames.map((name) => ({ dir: workflowDir, name })),
  { dir: workflowDir, name: 'translate-pending-logic.yml' },
  ...fs.readdirSync(workflowDir)
    .filter((name) => /^crawler-group-\d+(?:-logic)?\.yml$/.test(name))
    .map((name) => ({ dir: workflowDir, name })),
  ...fs.readdirSync(corpusWorkflowDir)
    .filter((name) => /^crawler-group-\d+\.yml$/.test(name) || name === 'translate-pending.yml')
    .map((name) => ({ dir: corpusWorkflowDir, name })),
];
const setupActionPattern = /(?:^\.\/|[^/]+\/[^/]+\/)?\.github\/actions\/setup-claude-haiku-fallback(?:@[^/]+)?$/;
const codexSecretExpression = '${{ secrets.CODEX_AUTH_JSON }}';
const codexBrokerOutputExpression = '${{ steps.setup_claude_haiku_fallback.outputs.codex_auth_broker_socket }}';

describe('indirect Codex auth workflow inventory', () => {
  it('keeps the raw secret out of every process env and scopes it to setup input', () => {
    for (const { dir, name } of workflowTargets) {
      const filePath = path.join(dir, name);
      const workflow = YAML.parse(fs.readFileSync(filePath, 'utf8')) as {
        jobs?: Record<string, { env?: Record<string, unknown>; steps?: Array<Record<string, any>> }>;
      };
      expect(fs.existsSync(filePath), name).toBe(true);
      const jobs = Object.values(workflow.jobs ?? {});
      expect(jobs.some((job) => Object.prototype.hasOwnProperty.call(job.env ?? {}, 'CODEX_AUTH_BROKER_SOCKET')), name)
        .toBe(false);
      const envMaps = jobs.flatMap((job) => [
        job.env ?? {},
        ...(job.steps ?? []).map((step) => step.env ?? {}),
      ]);
      expect(envMaps.some((env) => Object.prototype.hasOwnProperty.call(env, 'CODEX_AUTH_JSON')), name)
        .toBe(false);

      const setupSteps = jobs.flatMap((job) => job.steps ?? [])
        .filter((step) => typeof step.uses === 'string' && setupActionPattern.test(step.uses));
      expect(setupSteps, name).toHaveLength(1);
      expect(setupSteps[0].id, name).toBe('setup_claude_haiku_fallback');
      expect(setupSteps[0].with?.codex_auth_json, name).toBe(codexSecretExpression);

      const aiSteps = jobs.flatMap((job) => job.steps ?? [])
        .filter((step) => Object.prototype.hasOwnProperty.call(step.env ?? {}, 'CLAUDE_CODE_OAUTH_TOKEN'));
      expect(aiSteps.length, name).toBeGreaterThan(0);
      for (const step of aiSteps) {
        expect(step.env?.CODEX_AUTH_BROKER_SOCKET, name).toBe(codexBrokerOutputExpression);
      }

      const cleanupSteps = jobs.flatMap((job) => job.steps ?? [])
        .filter((step) => step.name === 'Cleanup Codex auth broker');
      expect(cleanupSteps, name).toHaveLength(1);
      expect(cleanupSteps[0].if, name).toBe('always()');
      expect(cleanupSteps[0].env?.CODEX_AUTH_BROKER_SOCKET, name).toBe(codexBrokerOutputExpression);
      expect(cleanupSteps[0].run, name).toContain('--cleanup --socket "$CODEX_AUTH_BROKER_SOCKET"');
    }
  });
});
