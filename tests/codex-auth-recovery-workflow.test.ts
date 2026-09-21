import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const WORKFLOW = readFileSync(new URL('../.github/workflows/codex-auth-recovery.yml', import.meta.url), 'utf8');
const DEFINITION = YAML.parse(WORKFLOW) as {
  on?: {
    workflow_run?: { workflows?: string[]; types?: string[] };
    schedule?: Array<{ cron?: string }>;
    workflow_dispatch?: Record<string, unknown>;
  };
  permissions?: Record<string, string>;
  jobs?: Record<string, { steps?: Array<{ uses?: string; with?: { script?: string } }> }>;
};
const RECOVERY_SCRIPT = Object.values(DEFINITION.jobs ?? {})
  .flatMap((job) => job.steps ?? [])
  .find((step) => step.uses === 'actions/github-script@v8')?.with?.script ?? '';

describe('Codex auth recovery', () => {
  it('si attiva sul completamento dei test e dispone di una riconciliazione periodica', () => {
    expect(DEFINITION.on?.workflow_run).toMatchObject({ workflows: ['tests'], types: ['completed'] });
    expect(DEFINITION.on?.schedule).toEqual([{ cron: '*/15 * * * *' }]);
    expect(DEFINITION.on?.workflow_dispatch).toEqual({});
    expect(DEFINITION.permissions).toMatchObject({
      actions: 'write',
      contents: 'read',
      issues: 'write',
      'pull-requests': 'write',
    });
  });

  it('usa un digest non segreto e riavvia solo la run tests pull_request esatta', () => {
    expect(WORKFLOW).toContain('CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}');
    expect(WORKFLOW).toContain('sha256sum');
    expect(RECOVERY_SCRIPT).toContain("const TESTS_WORKFLOW_PATH = '.github/workflows/tests.yml';");
    expect(RECOVERY_SCRIPT).toContain("run.path !== TESTS_WORKFLOW_PATH");
    expect(RECOVERY_SCRIPT).toContain("run.event !== 'pull_request'");
    expect(RECOVERY_SCRIPT).toContain('run.head_sha !== pr.head.sha');
    expect(RECOVERY_SCRIPT).toContain('run.pull_requests.some');
    expect(RECOVERY_SCRIPT).toContain('currentDigest === String(blocked.authDigest).toLowerCase()');
    expect(RECOVERY_SCRIPT).toContain('github.rest.actions.reRunWorkflow');
    expect(RECOVERY_SCRIPT).not.toContain('createWorkflowDispatch');
    expect(RECOVERY_SCRIPT).not.toContain('workflow_dispatch');
  });

  it('mantiene checkpoint e alert idempotenti e non trasferisce il segreto nei commenti', () => {
    expect(WORKFLOW).toContain('CODEX_AUTH_BLOCKED:');
    expect(WORKFLOW).toContain('CODEX_AUTH_RECOVERY:');
    expect(RECOVERY_SCRIPT).toContain('CODEX_AUTH_ALERT_TITLE');
    expect(RECOVERY_SCRIPT).toContain('CODEX_AUTH_BOT_LOGIN_RE');
    expect(RECOVERY_SCRIPT).toContain('authDigest');
    expect(RECOVERY_SCRIPT).not.toContain('process.env.CODEX_AUTH_JSON');
    expect(RECOVERY_SCRIPT).not.toMatch(/console\.(log|info|warn|error)\([^\n]*CODEX_AUTH/iu);
  });
});
