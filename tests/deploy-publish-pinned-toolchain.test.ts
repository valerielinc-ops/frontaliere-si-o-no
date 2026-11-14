import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { collectRelativeImportClosure } from './helpers/collectRelativeImportClosure';
import { simulateWorkflow } from './helpers/workflowNeedsSimulator';
import {
  CONTRACT_MISMATCH_VERDICT,
  PUBLISH_CONTRACT_VERSION,
  acceptedPublishContractVersions,
  checkPublishContractVersion,
  createLocalePublishProvenance,
  readPublishContractVersion,
} from '../scripts/ci/locale-publish-provenance.mjs';
import { resolveLocalePublishPlan } from '../scripts/ci/resolve-locale-publish-plan.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => fs.readFileSync(path.resolve(root, file), 'utf8');
const publish = YAML.parse(read('.github/workflows/deploy-publish.yml')) as any;
const publishText = read('.github/workflows/deploy-publish.yml');
const validateDist = YAML.parse(read('.github/workflows/post-deploy-validate-dist.yml')) as any;
const deploy = YAML.parse(read('.github/workflows/deploy.yml')) as any;

type Step = Record<string, any>;
const jobSteps = (workflow: any, job: string): Step[] => workflow.jobs[job].steps as Step[];
const namedStep = (workflow: any, job: string, name: string): Step => {
  const step = jobSteps(workflow, job).find((candidate) => candidate.name === name);
  if (!step) throw new Error(`${job}: step ${JSON.stringify(name)} not found`);
  return step;
};

function checkoutRefs(workflow: any) {
  const rows: Array<{ job: string; step: string; ref: string | undefined; sparse: string[] }> = [];
  for (const [job, definition] of Object.entries<any>(workflow.jobs)) {
    for (const step of definition.steps ?? []) {
      if (!String(step.uses ?? '').startsWith('actions/checkout@')) continue;
      rows.push({
        job,
        step: String(step.name ?? ''),
        ref: step.with?.ref,
        sparse: String(step.with?.['sparse-checkout'] ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
      });
    }
  }
  return rows;
}

const PIN = '${{ github.sha }}';
// The one checkout allowed to stay on the build SHA. Its validators detect the
// build's contract by file presence, so they must run at the build's version.
const SOURCE_TREE_EXCEPTION = { job: 'publish-nonit-shards', step: 'Checkout source workflow SHA' };

describe('publisher toolchain pin (F0.2)', () => {
  // Diagnostics-only checkout that keeps matching the build (legacy-reporter
  // fallback by file presence, see post-deploy-validate-skew-guard.test.ts).
  const REPORTER_EXCEPTION = { job: 'validate-dist-report', step: 'Checkout source-side issue reporter' };

  it('runs every publisher script from github.sha, never from the build SHA or a moving main', () => {
    const rows = [...checkoutRefs(publish), ...checkoutRefs(validateDist)];
    expect(rows.length).toBeGreaterThan(15);
    const offenders = rows
      .filter((row) => !(row.job === SOURCE_TREE_EXCEPTION.job && row.step === SOURCE_TREE_EXCEPTION.step))
      .filter((row) => !(row.job === REPORTER_EXCEPTION.job && row.step === REPORTER_EXCEPTION.step))
      // An omitted ref defaults to the dispatch SHA, which is the pin itself.
      .filter((row) => row.ref !== undefined && row.ref !== PIN)
      .map((row) => `${row.job} / ${row.step}: ref=${row.ref}`);
    expect(offenders).toEqual([]);
  });

  it('keeps the documented checkouts on the build SHA to a minimum, and nothing resolves refs/heads/main', () => {
    const onSource = checkoutRefs(publish)
      .filter((row) => row.ref === '${{ inputs.source_sha }}')
      .map((row) => `${row.job} / ${row.step}`);
    expect(onSource).toEqual([`${SOURCE_TREE_EXCEPTION.job} / ${SOURCE_TREE_EXCEPTION.step}`]);
    expect(checkoutRefs(validateDist).filter((row) => row.ref === '${{ inputs.deploy_ref }}')
      .map((row) => `${row.job} / ${row.step}`)).toEqual([`${REPORTER_EXCEPTION.job} / ${REPORTER_EXCEPTION.step}`]);
    expect(publishText).not.toMatch(/ref:\s*refs\/heads\/main/);
    expect(read('.github/workflows/post-deploy-validate-dist.yml')).not.toMatch(/ref:\s*refs\/heads\/main/);
  });

  it.each([
    ['publish-it-cdn', 'Checkout IT publisher sources'],
    ['push-it-shard-groups', 'Checkout publisher toolchain at the dispatch SHA'],
    ['finalize-it-publish', 'Checkout publisher toolchain at the dispatch SHA'],
    ['commit-it-dist-history', 'Checkout IT history writer'],
    ['publish-nonit-shards', 'Checkout current shard publisher'],
    ['publish-nonit-shards', 'Checkout durable receipt resolver'],
    ['resolve-nonit-publish', 'Checkout current publish resolver'],
    ['validate-source-build', 'Checkout promotion gate'],
  ])('%s / %s is pinned to github.sha', (job, step) => {
    expect(namedStep(publish, job, step).with.ref).toBe(PIN);
  });

  it('pins the reusable fast gate to the caller SHA instead of an input', () => {
    expect(namedStep(validateDist, 'fast-gate', 'Checkout publisher gate toolchain').with.ref).toBe(PIN);
  });

  // The pinned checkouts are sparse. A module added to a script's import graph
  // after the sparse list was written breaks the whole publish (#18164 was
  // services/publicConfigConstants.mjs), so the closure is derived, not trusted.
  const closures: Array<{ workflow: 'publish' | 'validateDist'; job: string; step: string; entrypoints: string[] }> = [
    { workflow: 'publish', job: 'validate-source-build', step: 'Checkout promotion gate', entrypoints: ['scripts/ci/production-promotion-gate.mjs'] },
    { workflow: 'publish', job: 'recover-legacy-publish-contract', step: 'Checkout current deploy queue helper', entrypoints: ['scripts/ci/deploy-rearm-request.mjs'] },
    { workflow: 'publish', job: 'resolve-publish-receipts', step: 'Checkout receipt resolver', entrypoints: ['scripts/ci/publish-receipts.mjs'] },
    { workflow: 'publish', job: 'publish-nonit-shards', step: 'Checkout durable receipt resolver', entrypoints: ['scripts/ci/publish-receipts.mjs'] },
    {
      workflow: 'publish',
      job: 'resolve-nonit-publish',
      step: 'Checkout current publish resolver',
      entrypoints: ['scripts/ci/locale-publish-provenance.mjs', 'scripts/ci/resolve-nonit-publish-plan.mjs', 'scripts/ci/publish-receipts.mjs'],
    },
    {
      workflow: 'validateDist',
      job: 'fast-gate',
      step: 'Checkout publisher gate toolchain',
      entrypoints: ['scripts/ci/publisher-fast-gate.mjs', 'scripts/ci/shard-content-manifest.mjs', 'scripts/validate-sitemap-links.mjs'],
    },
  ];

  const sparseIncludes = (patterns: string[], file: string) => patterns.some((raw) => {
    const pattern = raw.replace(/^\/+/, '');
    if (!pattern || pattern.startsWith('!')) return false;
    const prefix = pattern.endsWith('/') ? pattern : `${pattern}/`;
    return file === pattern.replace(/\/$/u, '') || file.startsWith(prefix);
  });

  it.each(closures)('$job / $step is closed over the import graph of its entrypoints', ({ workflow, job, step, entrypoints }) => {
    const definition = workflow === 'publish' ? publish : validateDist;
    const patterns = String(namedStep(definition, job, step).with['sparse-checkout'])
      .split('\n').map((line) => line.trim()).filter(Boolean);
    const closure = new Set(entrypoints.flatMap((entry) => collectRelativeImportClosure(root, entry)));
    const missing = [...closure].filter((file) => !sparseIncludes(patterns, file));
    expect(missing).toEqual([]);
  });
});

describe('publish contract version (F0.3)', () => {
  const SOURCE_RUN_ID = '36850086638';
  const SOURCE_SHA = 'a'.repeat(40);
  const BUILD_ID = '1770000000000';
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  function sourceReceipt(locale: 'it' | 'en' | 'de' | 'fr', publishContractVersion?: unknown) {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-contract-'));
    tempDirs.push(dist);
    fs.writeFileSync(path.join(dist, 'build-id.txt'), `${BUILD_ID}\n`);
    const manifest = createLocalePublishProvenance({
      locale,
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      deployBuildId: BUILD_ID,
      artifactRunId: SOURCE_RUN_ID,
      distDir: dist,
      outcomes: { build: 'success', validate: 'success', sourceArtifact: 'success' },
      ...(publishContractVersion === undefined ? {} : { publishContractVersion: publishContractVersion as number }),
    });
    return { file: `${locale}.json`, manifest };
  }

  const jobs = {
    jobs: [
      { name: 'validate production promotion trigger', conclusion: 'success' },
      { name: 'matrix-setup', conclusion: 'success' },
      { name: 'prep', conclusion: 'success' },
      ...['it', 'en', 'de', 'fr'].map((locale) => ({ name: `build-locale (${locale})`, conclusion: 'success' })),
    ],
  };

  const plan = (versionByLocale: Partial<Record<'it' | 'en' | 'de' | 'fr', unknown>>) => resolveLocalePublishPlan({
    runConclusion: 'success',
    sourceRunId: SOURCE_RUN_ID,
    sourceSha: SOURCE_SHA,
    jobs,
    provenance: (['it', 'en', 'de', 'fr'] as const).map((locale) => sourceReceipt(locale, versionByLocale[locale])),
  });

  it('declares {N, N-1} and reads an absent field as the legacy contract N-1', () => {
    expect(acceptedPublishContractVersions()).toEqual([PUBLISH_CONTRACT_VERSION, PUBLISH_CONTRACT_VERSION - 1]);
    expect(readPublishContractVersion({})).toBe(0);
    expect(readPublishContractVersion({ publishContractVersion: 3 })).toBe(3);
    for (const unreadable of ['1', 1.5, -1, null, true, {}]) {
      expect(readPublishContractVersion({ publishContractVersion: unreadable })).toBeNull();
    }
  });

  it('accepts a current and an N-1 receipt, rejects N-2 and a build newer than the toolchain', () => {
    const current = 7;
    expect(checkPublishContractVersion({ publishContractVersion: 7 }, { current })).toMatchObject({ ok: true, verdict: 'ok', version: 7 });
    expect(checkPublishContractVersion({ publishContractVersion: 6 }, { current })).toMatchObject({ ok: true, verdict: 'ok', version: 6 });
    const nMinus2 = checkPublishContractVersion({ publishContractVersion: 5 }, { current });
    expect(nMinus2).toMatchObject({ ok: false, verdict: CONTRACT_MISMATCH_VERDICT, version: 5 });
    expect(nMinus2.reason).toContain('rebuild');
    expect(nMinus2.reason).toContain('a retry cannot succeed');
    expect(checkPublishContractVersion({ publishContractVersion: 8 }, { current }).verdict).toBe(CONTRACT_MISMATCH_VERDICT);
    expect(checkPublishContractVersion({ publishContractVersion: 'x' }, { current }).verdict).toBe(CONTRACT_MISMATCH_VERDICT);
  });

  it('admits receipts at N and at the legacy N-1 (no field) without a recovery request', () => {
    for (const version of [undefined, 0, PUBLISH_CONTRACT_VERSION]) {
      const resolved = plan({ it: version, en: version, de: version, fr: version });
      expect(resolved.allowed).toBe(true);
      expect(resolved.recoveryRequired).toBe(false);
      expect(resolved.contractMismatchLocales).toEqual([]);
    }
  });

  it('turns an unknown contract into contract-mismatch -> rebuild, never a retry', () => {
    const future = PUBLISH_CONTRACT_VERSION + 5;
    const resolved = plan({ it: future, en: future, de: future, fr: future });
    expect(resolved.allowed).toBe(false);
    expect(resolved.mode).toBe('blocked');
    expect(resolved.recoveryRequired).toBe(true);
    expect(resolved.recoveryKind).toBe(CONTRACT_MISMATCH_VERDICT);
    expect(resolved.contractMismatchLocales).toEqual(['it', 'en', 'de', 'fr']);
    expect(resolved.reason).toContain(CONTRACT_MISMATCH_VERDICT);
    expect(resolved.reason).toContain('retrying this publish cannot succeed');
    expect(resolved.tailLocales).toEqual([]);
    expect(resolved.healthyLocales).toEqual([]);
  });

  it('blocks the whole snapshot when a single locale speaks an unknown contract', () => {
    const resolved = plan({ de: PUBLISH_CONTRACT_VERSION + 1 });
    expect(resolved.allowed).toBe(false);
    expect(resolved.contractMismatchLocales).toEqual(['de']);
    expect(resolved.recoveryKind).toBe(CONTRACT_MISMATCH_VERDICT);
    expect(resolved.staleReasons.de).toContain(CONTRACT_MISMATCH_VERDICT);
  });

  it('only writes the field for a producer that declares its contract', () => {
    expect('publishContractVersion' in sourceReceipt('it').manifest).toBe(false);
    expect(sourceReceipt('it', PUBLISH_CONTRACT_VERSION).manifest.publishContractVersion).toBe(PUBLISH_CONTRACT_VERSION);
  });

  it('keeps the producer and the toolchain on the same version, and feeds the recovery reason to the rearm request', () => {
    const buildStep = namedStep(deploy, 'build-locale', 'Write locale publish provenance');
    expect(buildStep.env.PROVENANCE_PUBLISH_CONTRACT_VERSION).toBe(String(PUBLISH_CONTRACT_VERSION));
    const tailStep = namedStep(publish, 'finalize-it-publish', 'Write IT publish provenance');
    expect(tailStep.env.PROVENANCE_PUBLISH_CONTRACT_VERSION).toBe(String(PUBLISH_CONTRACT_VERSION));
    expect(publish.jobs['resolve-publish-plan'].outputs.recovery_reason).toBe('${{ steps.plan.outputs.recovery_reason }}');
    const enqueue = namedStep(publish, 'recover-legacy-publish-contract', 'Enqueue one current build for the legacy source contract');
    expect(enqueue.env.RECOVERY_REASON).toContain('needs.resolve-publish-plan.outputs.recovery_reason');
    expect(enqueue.run).toContain('--reason "$RECOVERY_REASON"');
  });
});

describe('publish graph admission (F0.2-bis, F0.3)', () => {
  const OUTPUTS = {
    'resolve-publish-plan': {
      allowed: 'true',
      it_admitted: 'true',
      tail_locales: '["it","en","de","fr"]',
      build_id: '1770000000000',
    },
    'resolve-publish-receipts': {
      pages_deployed: 'false',
      published_locales: '["en","de","fr"]',
      pending_nonit_locales: '[]',
    },
    'resolve-nonit-publish': { allowed: 'true' },
    'validate-dist': { integrity_ok: 'true' },
  };
  const INPUTS = { source_conclusion: 'success' };
  // `publish-outcome` has no outcome of its own: when its condition admits it,
  // it is the job that turns a quiet skip into a red run.
  const simulate = (options: Parameters<typeof simulateWorkflow>[1], workflow: any = publish) => simulateWorkflow(workflow, {
    ...options,
    overrides: { 'publish-outcome': 'failure', ...options.overrides },
  });

  // Run 43365469153: non-IT already published by an earlier attempt, IT fine,
  // Pages not deployed. The run concluded `success` with `deploy` skipped.
  it('does not skip deploy when the non-IT locales were already published (run 43365469153)', () => {
    const run = simulate({ outputs: OUTPUTS, inputs: INPUTS });
    expect(run['publish-nonit-shards']).toBe('skipped');
    expect(run['finalize-it-publish']).toBe('success');
    expect(run.deploy).toBe('success');
    expect(run['validate-dist']).toBe('success');
    expect(run['publish-outcome']).toBe('skipped');
  });

  it('reproduces the original skip with the pre-fix condition on the same graph', () => {
    const OLD_DEPLOY_IF = `\${{ needs.resolve-publish-plan.result == 'success' &&
      needs.resolve-publish-plan.outputs.allowed == 'true' &&
      needs.resolve-publish-plan.outputs.it_admitted == 'true' &&
      needs.resolve-publish-receipts.result == 'success' &&
      needs.resolve-nonit-publish.result == 'success' &&
      needs.resolve-nonit-publish.outputs.allowed == 'true' }}`;
    const oldWorkflow = {
      jobs: {
        ...publish.jobs,
        deploy: {
          ...publish.jobs.deploy,
          needs: ['resolve-publish-plan', 'resolve-publish-receipts', 'resolve-nonit-publish'],
          if: OLD_DEPLOY_IF,
        },
      },
    };
    const run = simulate({ outputs: OUTPUTS, inputs: INPUTS }, oldWorkflow);
    expect(run['resolve-nonit-publish']).toBe('success');
    expect(run['publish-nonit-shards']).toBe('skipped');
    expect(run.deploy).toBe('skipped');
  });

  it('deploys when the non-IT tail ran and succeeded', () => {
    const run = simulate({
      outputs: {
        ...OUTPUTS,
        'resolve-publish-receipts': { ...OUTPUTS['resolve-publish-receipts'], published_locales: '[]', pending_nonit_locales: '["en","de","fr"]' },
      },
      inputs: INPUTS,
    });
    expect(run['publish-nonit-shards']).toBe('success');
    expect(run.deploy).toBe('success');
  });

  it('does not deploy, and turns the skip into a red verdict, when a non-IT locale failed', () => {
    const run = simulate({
      outputs: {
        ...OUTPUTS,
        'resolve-publish-receipts': { ...OUTPUTS['resolve-publish-receipts'], pending_nonit_locales: '["de"]' },
        'resolve-nonit-publish': { allowed: 'false' },
      },
      overrides: { 'publish-nonit-shards': 'failure' },
      inputs: INPUTS,
    });
    expect(run.deploy).toBe('skipped');
    expect(run['validate-dist']).toBe('skipped');
    expect(run['publish-outcome']).toBe('failure');
  });

  it('does not deploy a skipped non-IT tail that still had pending locales', () => {
    const run = simulate({
      outputs: { ...OUTPUTS, 'resolve-publish-receipts': { ...OUTPUTS['resolve-publish-receipts'], pending_nonit_locales: '["en"]' } },
      overrides: { 'publish-nonit-shards': 'skipped' },
      forceSkip: ['publish-nonit-shards'],
      inputs: INPUTS,
    });
    expect(run['publish-nonit-shards']).toBe('skipped');
    expect(run.deploy).toBe('skipped');
    expect(run['publish-outcome']).toBe('failure');
  });

  it('stops at the failed IT group: no finalizer, no deploy, and the verdict names a red run', () => {
    const run = simulate({
      outputs: OUTPUTS,
      overrides: { 'push-it-shard-groups': 'failure' },
      inputs: INPUTS,
    });
    expect(run['push-it-shard-groups']).toBe('failure');
    expect(run['finalize-it-publish']).toBe('skipped');
    expect(run.deploy).toBe('skipped');
    expect(run['validate-dist']).toBe('skipped');
    expect(run['publish-outcome']).toBe('failure');
    expect(run['report-failure']).toBe('success');
  });

  it('stops at a failed IT CDN publish before any group or finalizer', () => {
    const run = simulate({ outputs: OUTPUTS, overrides: { 'publish-it-cdn': 'failure' }, inputs: INPUTS });
    expect(run['push-it-shard-groups']).toBe('skipped');
    expect(run['finalize-it-publish']).toBe('skipped');
    expect(run.deploy).toBe('skipped');
    expect(run['publish-outcome']).toBe('failure');
    expect(run['report-failure']).toBe('success');
  });

  it('keeps a deliberately blocked source a clean no-op', () => {
    const run = simulate({
      outputs: { ...OUTPUTS, 'resolve-publish-plan': { ...OUTPUTS['resolve-publish-plan'], allowed: 'false', it_admitted: 'false' } },
      inputs: INPUTS,
    });
    expect(run.deploy).toBe('skipped');
    expect(run['finalize-it-publish']).toBe('skipped');
    expect(run['publish-outcome']).toBe('skipped');
    expect(run['report-failure']).toBe('skipped');
  });

  it('does not demand a second Pages deployment when a durable receipt already proves it', () => {
    const run = simulate({
      outputs: { ...OUTPUTS, 'resolve-publish-receipts': { ...OUTPUTS['resolve-publish-receipts'], pages_deployed: 'true' } },
      overrides: { 'push-it-shard-groups': 'failure' },
      inputs: INPUTS,
    });
    expect(run.deploy).toBe('skipped');
    expect(run['publish-outcome']).toBe('skipped');
  });

  it('runs validate-dist in exactly the situations in which deploy runs', () => {
    const scenarios: Array<Parameters<typeof simulateWorkflow>[1]> = [
      { outputs: OUTPUTS, inputs: INPUTS },
      { outputs: OUTPUTS, overrides: { 'push-it-shard-groups': 'failure' }, inputs: INPUTS },
      { outputs: OUTPUTS, overrides: { 'publish-it-cdn': 'failure' }, inputs: INPUTS },
      { outputs: { ...OUTPUTS, 'resolve-nonit-publish': { allowed: 'false' } }, inputs: INPUTS },
      {
        outputs: { ...OUTPUTS, 'resolve-publish-receipts': { ...OUTPUTS['resolve-publish-receipts'], pending_nonit_locales: '["en","fr"]' } },
        overrides: { 'publish-nonit-shards': 'success' },
        inputs: INPUTS,
      },
    ];
    for (const scenario of scenarios) {
      const run = simulate(scenario);
      expect(run['validate-dist'] === 'skipped').toBe(run.deploy === 'skipped');
    }
  });

  it('writes deploy and validate-dist conditions with an explicit status function and explicit clauses', () => {
    for (const job of ['deploy', 'validate-dist']) {
      const expression = String(publish.jobs[job].if);
      expect(expression).toContain('always() && !cancelled()');
      expect(expression).toContain("needs.finalize-it-publish.result == 'success'");
      expect(expression).toContain("needs.resolve-nonit-publish.outputs.allowed == 'true'");
      expect(expression).toContain("needs.resolve-publish-receipts.outputs.pending_nonit_locales == '[]'");
      expect([].concat(publish.jobs[job].needs)).toEqual(expect.arrayContaining([
        'resolve-publish-plan',
        'resolve-publish-receipts',
        'publish-nonit-shards',
        'finalize-it-publish',
        'resolve-nonit-publish',
      ]));
    }
    expect(String(publish.jobs.deploy.if)).toContain("needs.publish-nonit-shards.result == 'success'");
  });

  it('starts finalize-it-publish only after the CDN and every IT group concluded success', () => {
    const expression = String(publish.jobs['finalize-it-publish'].if);
    expect(expression).toContain('always() && !cancelled()');
    expect(expression).toContain("needs.publish-it-cdn.result == 'success'");
    expect(expression).toContain("needs.push-it-shard-groups.result == 'success'");
  });

  it('fails with an explicit message when the Pages artifact of this run is gone', () => {
    const step = namedStep(publish, 'deploy', 'Require the github-pages artifact of this run');
    const steps = jobSteps(publish, 'deploy');
    expect(step.if).toBe("steps.pages-receipt.outputs.pages_deployed != 'true'");
    expect(step.run).toContain('select(.name == "github-pages" and .expired == false)');
    expect(step.run).toContain('Nothing was published');
    expect(step.run).toContain('exit 1');
    expect(steps.indexOf(step)).toBeLessThan(steps.findIndex((candidate) => candidate.id === 'deployment_first'));
    expect(publish.jobs.deploy.permissions.actions).toBe('read');
  });

  it('reports the real IT failure and the Pages verdict from report-failure', () => {
    const needs = publish.jobs['report-failure'].needs as string[];
    expect(needs).toEqual(expect.arrayContaining(['publish-it-cdn', 'push-it-shard-groups', 'finalize-it-publish', 'publish-outcome']));
    const condition = String(publish.jobs['report-failure'].if);
    for (const job of ['publish-it-cdn', 'push-it-shard-groups', 'finalize-it-publish', 'publish-outcome']) {
      expect(condition).toContain(`needs.${job}.result == 'failure'`);
    }
    const lookup = namedStep(publish, 'report-failure', 'Find the failed IT publish job');
    expect(lookup.run).toContain('startswith("Push IT section group")');
    const reporter = namedStep(publish, 'report-failure', 'Report IT publish failure');
    expect(reporter.with['log-from-job']).toBe('${{ steps.it-failed-job.outputs.job_name }}');
    expect(namedStep(publish, 'report-failure', 'Report Pages-not-deployed outcome').with['log-from-job']).toBe('publish-outcome');
    expect(publish.jobs['publish-outcome'].if).toContain("needs.deploy.result == 'skipped'");
  });
});
