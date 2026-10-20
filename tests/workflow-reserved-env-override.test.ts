// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * A workflow `env:` cannot change a default GITHUB_* / RUNNER_* variable.
 *
 * Failure title if this goes red:
 *   «Workflow: un env: assegna una variabile GITHUB_* di default e GitHub lo ignora»
 *
 * GitHub docs, "Variables": "You can't overwrite the value of the default
 * environment variables named GITHUB_* and RUNNER_* … If you attempt to
 * override the value of one of these default variables, the assignment is
 * ignored." deploy-publish.yml set `GITHUB_RUN_ID: ${{ github.event.workflow_run.id }}`
 * on the cross-shard CDN gate: the value never arrived, the gate polled the
 * publish run instead of the deploy run, found no `build-locale (it)` job and
 * held every non-IT shard tail fail-closed for its whole 3 h budget (run
 * 37255215160, 05-10). A value meant to differ from the default must travel
 * under a free name and be assigned inside `run:` (`GITHUB_RUN_ID="$X" bash …`).
 *
 * Restating the default itself (`GITHUB_REPOSITORY: ${{ github.repository }}`)
 * is a no-op and stays allowed: 80+ steps do it to make a script's inputs
 * explicit.
 */

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');

/** Default variables with a same-valued `github` context, as GitHub documents them. */
const RESTATABLE: Record<string, string> = {
  GITHUB_ACTOR: 'github.actor',
  GITHUB_API_URL: 'github.api_url',
  GITHUB_BASE_REF: 'github.base_ref',
  GITHUB_EVENT_NAME: 'github.event_name',
  GITHUB_GRAPHQL_URL: 'github.graphql_url',
  GITHUB_HEAD_REF: 'github.head_ref',
  GITHUB_JOB: 'github.job',
  GITHUB_REF: 'github.ref',
  GITHUB_REF_NAME: 'github.ref_name',
  GITHUB_REPOSITORY: 'github.repository',
  GITHUB_REPOSITORY_OWNER: 'github.repository_owner',
  GITHUB_RUN_ATTEMPT: 'github.run_attempt',
  GITHUB_RUN_ID: 'github.run_id',
  GITHUB_RUN_NUMBER: 'github.run_number',
  GITHUB_SERVER_URL: 'github.server_url',
  GITHUB_SHA: 'github.sha',
  GITHUB_WORKFLOW: 'github.workflow',
  GITHUB_WORKSPACE: 'github.workspace',
};

/** Default variables with no context to restate: any assignment is ignored. */
const NOT_ASSIGNABLE = new Set([
  'GITHUB_ACTION', 'GITHUB_ACTION_PATH', 'GITHUB_ACTION_REPOSITORY', 'GITHUB_ACTIONS',
  'GITHUB_ACTOR_ID', 'GITHUB_ENV', 'GITHUB_EVENT_PATH', 'GITHUB_OUTPUT', 'GITHUB_PATH',
  'GITHUB_REF_PROTECTED', 'GITHUB_REF_TYPE', 'GITHUB_REPOSITORY_ID', 'GITHUB_REPOSITORY_OWNER_ID',
  'GITHUB_RETENTION_DAYS', 'GITHUB_STEP_SUMMARY', 'GITHUB_TRIGGERING_ACTOR', 'GITHUB_WORKFLOW_REF',
  'GITHUB_WORKFLOW_SHA', 'RUNNER_ARCH', 'RUNNER_DEBUG', 'RUNNER_ENVIRONMENT', 'RUNNER_NAME',
  'RUNNER_OS', 'RUNNER_TEMP', 'RUNNER_TOOL_CACHE',
]);

type Env = Record<string, unknown> | undefined;

/** `<where>: KEY=value` for every env entry that GitHub would silently drop. */
export function findIgnoredDefaultEnv(doc: unknown, file: string): string[] {
  const out: string[] = [];
  const check = (env: Env, where: string) => {
    if (!env || typeof env !== 'object') return;
    for (const [key, raw] of Object.entries(env)) {
      const value = String(raw).trim();
      if (NOT_ASSIGNABLE.has(key)) {
        out.push(`${file} ${where}: ${key}=${value}`);
        continue;
      }
      const ctx = RESTATABLE[key];
      if (!ctx) continue;
      const restated = new RegExp(`^\\$\\{\\{\\s*${ctx.replace('.', '\\.')}\\s*\\}\\}$`);
      if (!restated.test(value)) out.push(`${file} ${where}: ${key}=${value}`);
    }
  };
  const wf = (doc ?? {}) as { env?: Env; jobs?: Record<string, { env?: Env; steps?: { name?: string; env?: Env }[] }> };
  check(wf.env, 'workflow env');
  for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
    check(job?.env, `job ${jobId}`);
    (job?.steps ?? []).forEach((step, i) => check(step?.env, `job ${jobId} step ${step?.name ?? i}`));
  }
  return out;
}

describe('workflow env never assigns a default GITHUB_*/RUNNER_* variable a different value', () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();

  it('every workflow under .github/workflows', () => {
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((f) =>
      findIgnoredDefaultEnv(parse(readFileSync(join(WORKFLOWS, f), 'utf8')), f));
    expect(offenders).toEqual([]);
  });

  it('the scanner goes red on the 05-10 shape and stays green on restatements and free names', () => {
    const bad = parse([
      'jobs:',
      '  tail:',
      '    steps:',
      '      - name: gate',
      '        env:',
      '          GITHUB_RUN_ID: ${{ github.event.workflow_run.id }}',
      '          GITHUB_SHA: ${{ github.event.workflow_run.head_sha }}',
      '          RUNNER_TEMP: /tmp/x',
    ].join('\n'));
    expect(findIgnoredDefaultEnv(bad, 'x.yml')).toHaveLength(3);
    const good = parse([
      'env:',
      '  GITHUB_REPOSITORY: ${{ github.repository }}',
      'jobs:',
      '  tail:',
      '    env:',
      '      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
      '    steps:',
      '      - name: gate',
      '        env:',
      '          GITHUB_RUN_ID: ${{ github.run_id }}',
      '          CDN_IT_RUN_ID: ${{ github.event.workflow_run.id }}',
      '          GITHUB_RUN_URL: ${{ github.server_url }}/x',
      '        run: GITHUB_RUN_ID="$CDN_IT_RUN_ID" bash gate.sh',
    ].join('\n'));
    expect(findIgnoredDefaultEnv(good, 'x.yml')).toEqual([]);
  });

  it('deploy-publish.yml: the CDN gate gets the deploy run id inside run:, not through env', () => {
    const src = readFileSync(join(WORKFLOWS, 'deploy-publish.yml'), 'utf8');
    const start = src.indexOf('      - name: Wait for IT CDN push (cross-shard ordering guard)');
    expect(start, 'CDN gate step not found').toBeGreaterThan(-1);
    const step = src.slice(start, src.indexOf('\n      - name: ', start + 1));
    expect(step).toMatch(/CDN_IT_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
    expect(step).toMatch(/run: GITHUB_RUN_ID="\$CDN_IT_RUN_ID" bash scripts\/lib\/wait-cdn-build-id\.sh/);
  });
});
