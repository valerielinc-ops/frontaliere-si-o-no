import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Ratchet for a regression that has broken production deploys twice.
 *
 * The owner's 16/09/2026 decision is that PRs and deploys flow without a
 * human veto; the deny control-plane survives only on the issue surface.
 * Twice a loop-fleet hardening PR has re-added a GitHub "approval
 * environment" in front of the deploy chain:
 *
 *   - #8883 (16/09) -> deploy run 35164342731 failed in the job
 *     `approve production promotion`; reverted by #8947.
 *   - #9238 (19/09, commit fde49a93) -> every deploy from 2026-09-19T21:11Z
 *     failed the same way; production served a 9h-stale build until the
 *     revert that added this file.
 *
 * Both times the mechanism was identical: the `production-deploy`
 * environment carries no required reviewers and no attestation secret, so
 * the gate can never pass, and `matrix-setup` / `build-locale` / `rearm` are
 * skipped. Nothing is published — the failure is upstream of any deploy
 * side effect, so production freezes rather than breaking.
 *
 * Configuring the secret is NOT the fix: that installs the human veto the
 * owner refused. If this test fails, the change under review is the
 * regression, not this test.
 *
 * Admission stays fail-closed without a human via
 * `scripts/ci/production-promotion-gate.mjs` (trigger / caller / source-run
 * modes), all decidable from the run context alone.
 */

const root = path.resolve(import.meta.dirname, '..');
const workflowDir = path.join(root, '.github', 'workflows');

const APPROVAL_SECRET = 'PRODUCTION_DEPLOY_APPROVAL';
const APPROVAL_ENVIRONMENT = 'production-deploy';

/**
 * Environments that carry deployment credentials rather than a human gate.
 * These are legitimate: they exist so `secrets.*` resolves for a job, and
 * none of them is configured with required reviewers.
 */
const CREDENTIAL_ENVIRONMENTS = new Set([
  'github-pages',
  'shard-secrets-overflow',
]);

function workflowFiles(): string[] {
  return fs.readdirSync(workflowDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}

function environmentName(environment: unknown): string | undefined {
  if (typeof environment === 'string') return environment;
  if (environment && typeof environment === 'object') {
    const name = (environment as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

describe('no human-approval environment gates production deploys', () => {
  it(`no workflow references the ${APPROVAL_SECRET} attestation secret`, () => {
    const offenders = workflowFiles().filter((file) =>
      fs.readFileSync(path.join(workflowDir, file), 'utf8').includes(APPROVAL_SECRET));

    expect(offenders, [
      `${APPROVAL_SECRET} is the approval-environment attestation removed in`,
      'the #9238 revert. Re-adding it re-freezes production deploys, because',
      `the ${APPROVAL_ENVIRONMENT} environment has no reviewers and no secret.`,
      'Read this file\'s header before "fixing" it by configuring the secret.',
    ].join(' ')).toEqual([]);
  });

  it(`no job declares the ${APPROVAL_ENVIRONMENT} approval environment`, () => {
    const offenders: string[] = [];
    for (const file of workflowFiles()) {
      const doc = YAML.parse(fs.readFileSync(path.join(workflowDir, file), 'utf8'));
      for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
        const name = environmentName((job as { environment?: unknown })?.environment);
        if (name === undefined) continue;
        if (CREDENTIAL_ENVIRONMENTS.has(name)) continue;
        offenders.push(`${file}:${jobId} -> ${name}`);
      }
    }

    expect(offenders, [
      'A job declares a GitHub environment that is not a known credential',
      'environment. An environment used purely as an approval boundary is the',
      'regression this file guards. If a new credential environment is',
      'genuinely needed, add it to CREDENTIAL_ENVIRONMENTS and state in the PR',
      'that it carries no required reviewers.',
    ].join(' ')).toEqual([]);
  });

  it('no deploy-chain job waits on an approval job', () => {
    const offenders: string[] = [];
    for (const file of workflowFiles()) {
      const doc = YAML.parse(fs.readFileSync(path.join(workflowDir, file), 'utf8'));
      for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
        if (/approval/i.test(jobId)) {
          offenders.push(`${file}: job ${jobId}`);
          continue;
        }
        const rawNeeds = (job as { needs?: unknown })?.needs;
        const needs = Array.isArray(rawNeeds)
          ? rawNeeds
          : (typeof rawNeeds === 'string' ? [rawNeeds] : []);
        for (const need of needs) {
          if (typeof need === 'string' && /approval/i.test(need)) {
            offenders.push(`${file}: ${jobId} needs ${need}`);
          }
        }
      }
    }

    expect(offenders, [
      'An approval job (or a dependency on one) reappeared in the workflow',
      'graph. This is the shape that skipped build-locale and rearm in both',
      'incidents. See this file\'s header.',
    ].join(' ')).toEqual([]);
  });

  it('the promotion gate exposes no approval mode to call', () => {
    const gate = fs.readFileSync(
      path.join(root, 'scripts', 'ci', 'production-promotion-gate.mjs'),
      'utf8',
    );

    expect(gate).not.toContain('validateApprovalAttestation');
    expect(gate).not.toContain(APPROVAL_SECRET);
    expect(gate).not.toContain("mode === 'approval'");
    // The context-provable admission checks must survive: this ratchet
    // removes the human veto, not the fail-closed source validation.
    expect(gate).toContain("mode === 'trigger'");
    expect(gate).toContain("mode === 'caller'");
    expect(gate).toContain("mode === 'source-run'");
  });
});
