import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { evaluateExpression, simulateWorkflow } from './helpers/workflowNeedsSimulator';
import {
  IT_CDN_RECEIPT_PREFIX,
  IT_GROUP_RECEIPT_PREFIX,
  MAX_RECEIPT_STATUSES_PER_CONTEXT,
  assertItGroup,
  formatItCdnReceiptDescription,
  formatItGroupReceiptDescription,
  itCdnManifestArtifactName,
  itCdnReceiptContext,
  itGroupReceiptContext,
  itGroupResultArtifactName,
  missingItGroupResults,
  parseItGroupReceiptDescription,
  resolveItPublishReceipts,
} from '../scripts/ci/publish-receipts.mjs';
import {
  IT_SHARD_GROUP_IDS,
  expectedItGroupDigests,
  itShardGroupPlanDigest,
  validateItShardGroupPlan,
} from '../scripts/ci/it-shard-group-plan.mjs';
import {
  adoptEarlierSectionManifest,
  createSectionManifest,
} from '../scripts/ci/shard-content-manifest.mjs';

const root = path.resolve(import.meta.dirname, '..');
const publish = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows/deploy-publish.yml'), 'utf8')) as any;
const jobSteps = (job: string): any[] => publish.jobs[job].steps;
const namedStep = (job: string, name: string) => {
  const step = jobSteps(job).find((candidate) => candidate.name === name);
  if (!step) throw new Error(`${job}: step ${JSON.stringify(name)} not found`);
  return step;
};

const SOURCE_RUN_ID = '43410016876';
const SOURCE_SHA = 'b'.repeat(40);
const BUILD_ID = '1770000000001';
const PUBLISHER_RUN_ID = '43500000001';
const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const plan = {
  schemaVersion: 1,
  kind: 'it-shard-push-group-plan',
  sourceRunId: SOURCE_RUN_ID,
  sourceSha: SOURCE_SHA,
  buildId: BUILD_ID,
  requiredSections: ['argovia', 'basilea', 'berna', 'ginevra', 'svizzera', 'ticino', 'vaud', 'zurigo'],
  fileCounts: { argovia: 10, basilea: 11, berna: 12, ginevra: 13, svizzera: 500, ticino: 14, vaud: 15, zurigo: 400 },
  groups: [
    { id: 'zurigo', sections: ['zurigo'], files: 400 },
    { id: 'svizzera', sections: ['svizzera'], files: 500 },
    { id: 'small-1', sections: ['argovia', 'vaud'], files: 25 },
    { id: 'small-2', sections: ['basilea', 'ticino'], files: 25 },
    { id: 'small-3', sections: ['berna'], files: 12 },
    { id: 'small-4', sections: ['ginevra'], files: 13 },
  ],
};

const status = (context: string, description: string, extra: Record<string, unknown> = {}) => ({
  context,
  state: 'success',
  description,
  target_url: `https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/${PUBLISHER_RUN_ID}`,
  created_at: '2026-11-14T10:00:00Z',
  ...extra,
});
const groupReceipt = (group: string, digest = itShardGroupPlanDigest(plan, group), extra: Record<string, unknown> = {}) => status(
  itGroupReceiptContext(SOURCE_RUN_ID, group),
  formatItGroupReceiptDescription({ group, digest }),
  extra,
);
const cdnReceipt = (buildId = BUILD_ID, extra: Record<string, unknown> = {}) => status(
  itCdnReceiptContext(SOURCE_RUN_ID),
  formatItCdnReceiptDescription({ sourceRunId: SOURCE_RUN_ID, buildId }),
  extra,
);

describe('IT receipts: contexts, allowlist and digests (F0.9)', () => {
  it('uses source-run-scoped contexts and refuses a group outside the allowlist', () => {
    expect(itCdnReceiptContext(SOURCE_RUN_ID)).toBe(`${IT_CDN_RECEIPT_PREFIX}/${SOURCE_RUN_ID}`);
    expect(IT_CDN_RECEIPT_PREFIX).toBe('frontaliere/it-cdn-published');
    expect(IT_GROUP_RECEIPT_PREFIX).toBe('frontaliere/it-group-published');
    expect(itGroupReceiptContext(SOURCE_RUN_ID, 'small-2')).toBe(`${IT_GROUP_RECEIPT_PREFIX}/${SOURCE_RUN_ID}/small-2`);
    expect(itCdnReceiptContext('not-a-run')).toBe('');
    for (const bad of ['small-5', 'ZURIGO ', 'zurigo/../x', '', 'svizzera-it', '../small-1']) {
      expect(itGroupReceiptContext(SOURCE_RUN_ID, bad)).toBe('');
      expect(() => assertItGroup(bad)).toThrow(/allowlist/);
    }
    for (const group of IT_SHARD_GROUP_IDS) expect(assertItGroup(group)).toBe(group);
  });

  it('derives the allowlist from the group ids the publish workflow fans out over', () => {
    expect([...IT_SHARD_GROUP_IDS]).toEqual(['zurigo', 'svizzera', 'small-1', 'small-2', 'small-3', 'small-4']);
    expect(validateItShardGroupPlan(plan, { sourceRunId: SOURCE_RUN_ID, sourceSha: SOURCE_SHA, buildId: BUILD_ID }).valid).toBe(true);
  });

  it('keeps the digest stable across attempts of one population and changes it with the content', () => {
    const digest = itShardGroupPlanDigest(plan, 'small-1');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(itShardGroupPlanDigest(JSON.parse(JSON.stringify(plan)), 'small-1')).toBe(digest);
    const moreFiles = { ...plan, fileCounts: { ...plan.fileCounts, vaud: 16 } };
    expect(itShardGroupPlanDigest(moreFiles, 'small-1')).not.toBe(digest);
    expect(itShardGroupPlanDigest(moreFiles, 'zurigo')).toBe(itShardGroupPlanDigest(plan, 'zurigo'));
    expect(itShardGroupPlanDigest({ ...plan, buildId: '1770000000002' }, 'small-1')).not.toBe(digest);
    expect(() => itShardGroupPlanDigest(plan, 'small-9')).toThrow(/not part of the publication plan/);
    expect(Object.keys(expectedItGroupDigests(plan))).toEqual([...IT_SHARD_GROUP_IDS]);
  });

  it('fits the GitHub status description limit and round-trips the digest', () => {
    const digest = itShardGroupPlanDigest(plan, 'small-4');
    const description = formatItGroupReceiptDescription({ group: 'small-4', digest });
    expect(description.length).toBeLessThanOrEqual(140);
    expect(parseItGroupReceiptDescription(description)).toEqual({ group: 'small-4', digest });
    expect(parseItGroupReceiptDescription('IT section group small-4 published')).toBeNull();
    expect(parseItGroupReceiptDescription('digest=zz')).toBeNull();
    expect(formatItCdnReceiptDescription({ sourceRunId: SOURCE_RUN_ID, buildId: BUILD_ID }).length).toBeLessThanOrEqual(140);
    expect(() => formatItGroupReceiptDescription({ group: 'nope', digest })).toThrow(/allowlist/);
    expect(() => formatItGroupReceiptDescription({ group: 'small-4', digest: 'abc' })).toThrow(/digest/);
  });
});

describe('IT receipts: what a retry still has to do (F0.9)', () => {
  const expectedDigests = expectedItGroupDigests(plan);
  const resolve = (statuses: any[], options: Record<string, unknown> = {}) => resolveItPublishReceipts({
    statuses,
    sourceRunId: SOURCE_RUN_ID,
    buildId: BUILD_ID,
    expectedDigests,
    ...options,
  });

  it('retry with 4/6 groups published leaves a matrix of the 2 missing groups', () => {
    const state = resolve([
      groupReceipt('svizzera'),
      groupReceipt('small-2'),
      groupReceipt('small-3'),
      groupReceipt('small-4'),
    ]);
    expect(state.pendingItGroups).toEqual(['zurigo', 'small-1']);
    expect(state.publishedItGroups.map((entry: any) => entry.group)).toEqual(['svizzera', 'small-2', 'small-3', 'small-4']);
    expect(state.publishedItGroups[0]).toMatchObject({ publisherRunId: PUBLISHER_RUN_ID });
    expect(state.itCdnPublished).toBe(false);
  });

  it('with no receipt at all everything is pending, in canonical order', () => {
    const state = resolve([]);
    expect(state.pendingItGroups).toEqual([...IT_SHARD_GROUP_IDS]);
    expect(state.publishedItGroups).toEqual([]);
  });

  it('a receipt with a different digest is pending, not accepted', () => {
    const state = resolve([
      groupReceipt('zurigo'),
      groupReceipt('small-1', 'f'.repeat(64)),
    ]);
    expect(state.pendingItGroups).toContain('small-1');
    expect(state.pendingItGroups).not.toContain('zurigo');
    expect(state.rejectedItGroups).toEqual([{ group: 'small-1', reason: 'digest-mismatch' }]);
  });

  it('only the newest status of a context decides', () => {
    const stale = groupReceipt('zurigo', 'a'.repeat(64), { created_at: '2026-11-14T08:00:00Z' });
    const fresh = groupReceipt('zurigo', itShardGroupPlanDigest(plan, 'zurigo'), { created_at: '2026-11-14T11:00:00Z' });
    expect(resolve([stale, fresh]).pendingItGroups).not.toContain('zurigo');
    expect(resolve([fresh, stale]).pendingItGroups).not.toContain('zurigo');
    const newerFailure = { ...groupReceipt('zurigo'), state: 'failure', created_at: '2026-11-14T12:00:00Z' };
    expect(resolve([fresh, newerFailure]).pendingItGroups).toContain('zurigo');
  });

  it('ignores contexts of another source run, non-success states and unknown groups', () => {
    const state = resolve([
      status(itGroupReceiptContext('99999999', 'zurigo'), formatItGroupReceiptDescription({ group: 'zurigo', digest: expectedDigests.zurigo })),
      { ...groupReceipt('svizzera'), state: 'pending' },
      status(`${IT_GROUP_RECEIPT_PREFIX}/${SOURCE_RUN_ID}/small-9`, `digest=${'c'.repeat(64)}`),
    ]);
    expect(state.pendingItGroups).toEqual([...IT_SHARD_GROUP_IDS]);
  });

  it('refuses a receipt whose publisher run or artifact cannot be recovered', () => {
    const noRun = { ...groupReceipt('zurigo'), target_url: 'https://example.invalid/x' };
    expect(resolve([noRun]).pendingItGroups).toContain('zurigo');
    expect(resolve([noRun]).rejectedItGroups).toEqual([{ group: 'zurigo', reason: 'no-publisher-run' }]);
    const expired = resolve([groupReceipt('zurigo')], { artifactAvailable: () => false });
    expect(expired.pendingItGroups).toContain('zurigo');
    expect(expired.rejectedItGroups).toEqual([{ group: 'zurigo', reason: 'result-artifact-unavailable' }]);
    const seen: Array<{ group: string; publisherRunId: string }> = [];
    resolve([groupReceipt('zurigo')], { artifactAvailable: (entry: any) => { seen.push(entry); return true; } });
    expect(seen).toEqual([{ group: 'zurigo', publisherRunId: PUBLISHER_RUN_ID }]);
    expect(itGroupResultArtifactName('zurigo', SOURCE_RUN_ID)).toBe(`it-shard-result-group-zurigo-${SOURCE_RUN_ID}`);
  });

  it('without a readable plan nothing is skipped (more work, never a skipped group)', () => {
    const state = resolve([groupReceipt('zurigo'), cdnReceipt()], { expectedDigests: null });
    expect(state.pendingItGroups).toEqual([...IT_SHARD_GROUP_IDS]);
    expect(state.itCdnPublished).toBe(true);
  });

  it('accepts the CDN receipt only for the build id it was written for', () => {
    expect(resolve([cdnReceipt()]).itCdnPublished).toBe(true);
    expect(resolve([cdnReceipt('1770000000009')]).itCdnPublished).toBe(false);
    expect(resolve([{ ...cdnReceipt(), state: 'failure' }]).itCdnPublished).toBe(false);
    expect(resolve([cdnReceipt()], { buildId: undefined }).itCdnPublished).toBe(true);
  });

  it('tolerates the 1000-status cap by refusing to write near it, not by dropping receipts', () => {
    expect(MAX_RECEIPT_STATUSES_PER_CONTEXT).toBeLessThan(1000);
    expect(MAX_RECEIPT_STATUSES_PER_CONTEXT).toBeGreaterThan(100);
  });

  it('writes a group receipt only when every section of the group has its marker, manifest and tar', () => {
    const results = fs.mkdtempSync(path.join(os.tmpdir(), 'it-group-results-'));
    tempDirs.push(results);
    expect(missingItGroupResults({ plan, group: 'small-1', resultsDir: results })).toEqual([
      'shard-ok-argovia-it',
      'shard-content-manifests/it/argovia.json',
      'it-shard-results/argovia-dist-it.tar',
      'shard-ok-vaud-it',
      'shard-content-manifests/it/vaud.json',
      'it-shard-results/vaud-dist-it.tar',
    ]);
    for (const section of ['argovia', 'vaud']) {
      fs.mkdirSync(path.join(results, 'shard-content-manifests/it'), { recursive: true });
      fs.mkdirSync(path.join(results, 'it-shard-results'), { recursive: true });
      fs.writeFileSync(path.join(results, `shard-ok-${section}-it`), '');
      fs.writeFileSync(path.join(results, `shard-content-manifests/it/${section}.json`), '{}');
      fs.writeFileSync(path.join(results, `it-shard-results/${section}-dist-it.tar`), 'tar');
    }
    expect(missingItGroupResults({ plan, group: 'small-1', resultsDir: results })).toEqual([]);
    fs.writeFileSync(path.join(results, 'shard-content-manifests/it/vaud.json'), '');
    expect(missingItGroupResults({ plan, group: 'small-1', resultsDir: results })).toEqual(['shard-content-manifests/it/vaud.json']);
  });
});

describe('IT receipts: the publish graph (F0.9, F0.2-bis)', () => {
  const baseOutputs = (receipts: Record<string, string> = {}) => ({
    'resolve-publish-plan': {
      allowed: 'true',
      it_admitted: 'true',
      tail_locales: '["it","en","de","fr"]',
      build_id: BUILD_ID,
    },
    'resolve-publish-receipts': {
      pages_deployed: 'false',
      published_locales: '[]',
      pending_nonit_locales: '[]',
      it_cdn_published: 'false',
      pending_it_groups: JSON.stringify(IT_SHARD_GROUP_IDS),
      receipt_it_groups: '[]',
      ...receipts,
    },
    'resolve-nonit-publish': { allowed: 'true' },
    'validate-dist': { integrity_ok: 'true' },
  });
  const simulate = (options: Parameters<typeof simulateWorkflow>[1]) => simulateWorkflow(publish, {
    ...options,
    overrides: { 'publish-outcome': 'failure', ...options.overrides },
  });
  const receiptStateOutputs = (statuses: any[]) => {
    const state = resolveItPublishReceipts({
      statuses,
      sourceRunId: SOURCE_RUN_ID,
      buildId: BUILD_ID,
      expectedDigests: expectedItGroupDigests(plan),
    });
    return {
      it_cdn_published: String(state.itCdnPublished),
      pending_it_groups: JSON.stringify(state.pendingItGroups),
      receipt_it_groups: JSON.stringify(state.publishedItGroups.map((entry: any) => ({ group: entry.group, runId: entry.publisherRunId }))),
    };
  };

  it('fans out only over the groups the receipts leave pending', () => {
    expect(String(publish.jobs['push-it-shard-groups'].strategy.matrix.group))
      .toBe('${{ fromJSON(needs.resolve-publish-receipts.outputs.pending_it_groups) }}');
    const outputs = receiptStateOutputs([groupReceipt('svizzera'), groupReceipt('small-2'), groupReceipt('small-3'), groupReceipt('small-4'), cdnReceipt()]);
    expect(JSON.parse(outputs.pending_it_groups)).toEqual(['zurigo', 'small-1']);
    const run = simulate({ outputs: baseOutputs(outputs) });
    expect(run['publish-it-cdn']).toBe('skipped');
    expect(run['push-it-shard-groups']).toBe('success');
    expect(run['finalize-it-publish']).toBe('success');
    expect(run.deploy).toBe('success');
    expect(run['publish-outcome']).toBe('skipped');
  });

  it('skips the CDN job on a receipt without blocking groups, finalizer, non-IT tail or deploy', () => {
    const outputs = receiptStateOutputs([cdnReceipt()]);
    expect(outputs.it_cdn_published).toBe('true');
    const run = simulate({
      outputs: baseOutputs({ ...outputs, pending_nonit_locales: '["en","de","fr"]' }),
    });
    expect(run['publish-it-cdn']).toBe('skipped');
    expect(run['preflight-section-tree-layouts']).toBe('success');
    expect(run['push-it-shard-groups']).toBe('success');
    expect(run['publish-nonit-shards']).toBe('success');
    expect(run['finalize-it-publish']).toBe('success');
    expect(run.deploy).toBe('success');
    expect(run['validate-dist']).toBe('success');
  });

  it('a CDN receipt does not stand in for a CDN job that failed', () => {
    const run = simulate({
      outputs: baseOutputs({ it_cdn_published: 'false' }),
      overrides: { 'publish-it-cdn': 'failure' },
    });
    expect(run['push-it-shard-groups']).toBe('skipped');
    expect(run['finalize-it-publish']).toBe('skipped');
    expect(run.deploy).toBe('skipped');
    expect(run['publish-outcome']).toBe('failure');
  });

  it('with every group and the CDN already published the finalizer and deploy still run', () => {
    const outputs = receiptStateOutputs([
      cdnReceipt(),
      ...IT_SHARD_GROUP_IDS.map((group: string) => groupReceipt(group)),
    ]);
    expect(JSON.parse(outputs.pending_it_groups)).toEqual([]);
    const run = simulate({ outputs: baseOutputs(outputs) });
    expect(run['publish-it-cdn']).toBe('skipped');
    expect(run['push-it-shard-groups']).toBe('skipped');
    expect(run['finalize-it-publish']).toBe('success');
    expect(run.deploy).toBe('success');
    expect(run['validate-dist']).toBe('success');
    expect(run['publish-outcome']).toBe('skipped');
  });

  it('a group that fails while others were already published still stops the finalizer and deploy', () => {
    const outputs = receiptStateOutputs([cdnReceipt(), groupReceipt('svizzera'), groupReceipt('small-3')]);
    const run = simulate({ outputs: baseOutputs(outputs), overrides: { 'push-it-shard-groups': 'failure' } });
    expect(run['finalize-it-publish']).toBe('skipped');
    expect(run.deploy).toBe('skipped');
    expect(run['publish-outcome']).toBe('failure');
  });

  it('a digest mismatch puts the group back in the matrix and the run still publishes', () => {
    const outputs = receiptStateOutputs([
      cdnReceipt(),
      ...IT_SHARD_GROUP_IDS.map((group: string) => (group === 'small-3' ? groupReceipt(group, 'e'.repeat(64)) : groupReceipt(group))),
    ]);
    expect(JSON.parse(outputs.pending_it_groups)).toEqual(['small-3']);
    const run = simulate({ outputs: baseOutputs(outputs) });
    expect(run['push-it-shard-groups']).toBe('success');
    expect(run.deploy).toBe('success');
  });

  it('settles the CDN ordering gate from the receipt in every job that waits on it', () => {
    const gates: Array<[string, string]> = [
      ['push-it-shard-groups', 'Wait for current IT CDN build id before IT section pushes'],
      ['finalize-it-publish', 'Recheck current IT CDN build id before Pages preparation'],
      ['publish-nonit-shards', 'Wait for current IT CDN build id before non-IT shard pushes'],
    ];
    const context = (published: string) => ({
      result: () => 'success',
      output: (_job: string, key: string) => (key === 'it_cdn_published' ? published : ''),
      input: () => '',
    });
    for (const [job, name] of gates) {
      const env = namedStep(job, name).env;
      // Receipt: the marker poll still verifies the build id, but the jobs-API
      // wait on the skipped CDN job is switched off by emptying both names.
      expect(evaluateExpression(String(env.CDN_IT_JOB_NAME), context('true'))).toBe('');
      expect(evaluateExpression(String(env.CDN_IT_READY_STEP_NAME), context('true'))).toBe('');
      expect(evaluateExpression(String(env.CDN_IT_JOB_NAME), context('false'))).toBe('Publish IT CDN assets first');
      expect(evaluateExpression(String(env.CDN_IT_READY_STEP_NAME), context('false'))).toBe('Require IT CDN build id before shard pushes');
      expect(String(env.DEPLOY_BUILD_ID)).toContain('resolve-publish-plan.outputs.build_id');
    }
    const handoff = namedStep('push-it-shard-groups', 'Verify IT CDN handoff');
    expect(String(handoff.env.CDN_BUILD_ID)).toContain('it_cdn_published');
    expect(String(handoff.env.CDN_BUILD_ID)).toContain('resolve-publish-plan.outputs.build_id');
  });

  it('keeps the IT provenance receipt truthful when the CDN job or every group was skipped by receipts', () => {
    const provenance = namedStep('finalize-it-publish', 'Write IT publish provenance').env;
    const evaluate = (expression: string, results: Record<string, string>, outputs: Record<string, string>) => evaluateExpression(expression, {
      result: (job) => results[job] ?? 'success',
      output: (_job, key) => outputs[key] ?? '',
      input: () => '',
    });
    const fromReceipts = { 'publish-it-cdn': 'skipped', 'push-it-shard-groups': 'skipped' };
    const receiptOutputs = { it_cdn_published: 'true', pending_it_groups: '[]' };
    expect(evaluate(String(provenance.PROVENANCE_CDN_GATE_OUTCOME), fromReceipts, receiptOutputs)).toBe('success');
    expect(evaluate(String(provenance.PROVENANCE_SECTION_PUSH_OUTCOME), fromReceipts, receiptOutputs)).toBe('success');
    // A skip with no receipt behind it must stay visible as a skip.
    expect(evaluate(String(provenance.PROVENANCE_CDN_GATE_OUTCOME), fromReceipts, { it_cdn_published: 'false', pending_it_groups: '[]' })).toBe('skipped');
    expect(evaluate(String(provenance.PROVENANCE_SECTION_PUSH_OUTCOME), fromReceipts, { it_cdn_published: 'true', pending_it_groups: '["zurigo"]' })).toBe('skipped');
    expect(evaluate(String(provenance.PROVENANCE_CDN_GATE_OUTCOME), { 'publish-it-cdn': 'failure' }, receiptOutputs)).toBe('failure');
  });

  it('writes the CDN and group receipts after, and only after, their proof of success', () => {
    const cdnSteps = jobSteps('publish-it-cdn');
    const cdnReady = cdnSteps.findIndex((step) => step.id === 'cdn-ready');
    const cdnReceiptStep = namedStep('publish-it-cdn', 'Write durable IT CDN receipt');
    expect(cdnSteps.indexOf(cdnReceiptStep)).toBeGreaterThan(cdnReady);
    expect(String(cdnReceiptStep.if)).toContain("steps.cdn-ready.outcome == 'success'");
    expect(cdnReceiptStep['continue-on-error']).toBe(true);
    expect(cdnReceiptStep.run).toContain('--write it-cdn');
    expect(publish.jobs['publish-it-cdn'].permissions.statuses).toBe('write');

    const groupSteps = jobSteps('push-it-shard-groups');
    const upload = groupSteps.find((step) => step.name === 'Upload IT section group results and ok-markers');
    const groupReceiptStep = namedStep('push-it-shard-groups', 'Write durable IT group receipt');
    expect(upload.id).toBe('upload-group-results');
    expect(groupSteps.indexOf(groupReceiptStep)).toBeGreaterThan(groupSteps.indexOf(upload));
    expect(groupReceiptStep.if).toContain("steps.push-section-group.outcome == 'success'");
    expect(groupReceiptStep.if).toContain("steps.upload-group-results.outcome == 'success'");
    expect(groupReceiptStep['continue-on-error']).toBe(true);
    expect(groupReceiptStep.run).toContain('--write it-group');
    expect(groupReceiptStep.run).toContain('--group "$GROUP_ID"');
    expect(publish.jobs['push-it-shard-groups'].permissions.statuses).toBe('write');
    // Receipts never gate the run: the final requirement step is the verdict.
    expect(groupSteps.indexOf(groupReceiptStep)).toBeLessThan(groupSteps.findIndex((step) => step.name === 'Require IT section group and CDN gate success'));
  });

  it('feeds the finalizer the earlier groups, adopts their manifests, and drops the redundant step guards', () => {
    const steps = jobSteps('finalize-it-publish');
    const earlier = namedStep('finalize-it-publish', 'Download IT section group results from earlier attempts');
    const assemble = steps.findIndex((step) => step.name === 'Assemble IT root, section manifests and validation tars');
    const adopt = namedStep('finalize-it-publish', 'Adopt section manifests published by earlier attempts');
    expect(earlier.if).toBe("needs.resolve-publish-receipts.outputs.receipt_it_groups != '[]'");
    expect(steps.indexOf(earlier)).toBeLessThan(assemble);
    expect(earlier.run).toContain('gh run download');
    expect(earlier.run).toContain('it-shard-result-group-');
    // The restore step re-states the group allowlist in shell: keep it equal to
    // the one the receipts and the plan use.
    const restored = JSON.parse(/const allowed = (\[[^\]]*\]);/.exec(String(earlier.run))![1]);
    expect(restored).toEqual([...IT_SHARD_GROUP_IDS]);
    expect(steps.indexOf(adopt)).toBeGreaterThan(assemble);
    expect(steps.indexOf(adopt)).toBeLessThan(steps.findIndex((step) => step.name === 'Finalize IT section content manifests'));
    expect(adopt.run).toContain('shard-content-manifest.mjs adopt-sections');
    for (const step of steps.filter((candidate) => /^(Package IT post-push validation batches|Upload shard batch \d dist for post-deploy validation)$/.test(String(candidate.name)))) {
      // The job-level condition already proves every group is `success` or
      // fully receipt-backed; a `push-it-shard-groups.result == 'success'`
      // guard would skip the batches when every group came from receipts.
      expect(step.if, String(step.name)).toBeUndefined();
    }
    expect(publish.jobs['finalize-it-publish'].permissions.actions).toBe('read');
  });

  it('resolves the receipts with the source plan and exposes the three IT outputs', () => {
    const outputs = publish.jobs['resolve-publish-receipts'].outputs;
    expect(outputs.it_cdn_published).toBe('${{ steps.receipts.outputs.it_cdn_published }}');
    expect(outputs.pending_it_groups).toBe('${{ steps.receipts.outputs.pending_it_groups }}');
    expect(outputs.receipt_it_groups).toBe('${{ steps.receipts.outputs.receipt_it_groups }}');
    const resolver = namedStep('resolve-publish-receipts', 'Resolve source-run receipts');
    expect(resolver.run).toContain('--it-plan');
    expect(publish.jobs['resolve-publish-receipts'].permissions.actions).toBe('read');
    const download = namedStep('resolve-publish-receipts', 'Download IT shard source plan');
    expect(download['continue-on-error']).toBe(true);
    expect(download.with['run-id']).toBe('${{ inputs.source_run_id }}');
  });
});

describe('adopting a section manifest published by an earlier attempt', () => {
  function section(name = 'vaud', artifactRunId = PUBLISHER_RUN_ID, tarBody = 'tar-bytes') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-adopt-'));
    tempDirs.push(dir);
    const rootDir = path.join(dir, 'vaud-it');
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'index.html'), '<html></html>');
    const tar = path.join(dir, `${name}-dist-it.tar`);
    fs.writeFileSync(tar, tarBody);
    const manifest = createSectionManifest({
      root: rootDir,
      prefix: 'vaud-it',
      locale: 'it',
      section: name,
      sourceRunId: SOURCE_RUN_ID,
      sourceSha: SOURCE_SHA,
      artifactRunId,
      tarPath: tar,
      sourcePathLayout: undefined,
    });
    return { manifest, tar };
  }
  const identity = { locale: 'it', sourceRunId: SOURCE_RUN_ID, sourceSha: SOURCE_SHA, artifactRunId: '43600000009' };

  it('rebinds only the artifact run id after proving identity and tar content', () => {
    const { manifest, tar } = section();
    const adopted = adoptEarlierSectionManifest({ manifest, tarPath: tar, ...identity });
    expect(adopted.artifactRunId).toBe('43600000009');
    expect({ ...adopted, artifactRunId: manifest.artifactRunId }).toEqual(manifest);
  });

  it('leaves a manifest of the current run untouched', () => {
    const { manifest, tar } = section('vaud', '43600000009');
    expect(adoptEarlierSectionManifest({ manifest, tarPath: tar, ...identity })).toBe(manifest);
  });

  it('refuses another source identity or a tar that is not the one the manifest describes', () => {
    const { manifest, tar } = section();
    expect(() => adoptEarlierSectionManifest({ manifest, tarPath: tar, ...identity, sourceRunId: '1' })).toThrow(/identity/);
    expect(() => adoptEarlierSectionManifest({ manifest, tarPath: tar, ...identity, sourceSha: 'c'.repeat(40) })).toThrow(/identity/);
    expect(() => adoptEarlierSectionManifest({ manifest, tarPath: tar, ...identity, locale: 'en' })).toThrow(/kind or locale/);
    fs.writeFileSync(tar, 'a different tar');
    expect(() => adoptEarlierSectionManifest({ manifest, tarPath: tar, ...identity })).toThrow(/tar/);
    fs.rmSync(tar);
    expect(() => adoptEarlierSectionManifest({ manifest, tarPath: tar, ...identity })).toThrow(/tar/);
    expect(crypto.createHash('sha256').update('x').digest('hex')).toHaveLength(64);
  });
});

describe('publish-receipts.mjs CLI against a fake gh', () => {
  const REPO = 'valerielinc-ops/frontaliere-si-o-no';
  const script = path.join(root, 'scripts/ci/publish-receipts.mjs');

  function fakeGh(options: { statuses: any[]; artifactsByRun?: Record<string, any[]> }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
    tempDirs.push(dir);
    const log = path.join(dir, 'calls.jsonl');
    const fixture = path.join(dir, 'fixture.json');
    fs.writeFileSync(fixture, JSON.stringify(options));
    fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
const out = (text) => { fs.writeSync(1, text); process.exit(0); };
if (args.includes('POST')) out('{}');
if (/\\/statuses\\?/.test(endpoint) || /commits\\/[0-9a-f]{40}\\/statuses/.test(endpoint)) {
  out(JSON.stringify([fixture.statuses]));
}
const run = /actions\\/runs\\/(\\d+)\\/artifacts/.exec(endpoint);
if (run) {
  out(JSON.stringify([{ artifacts: (fixture.artifactsByRun || {})[run[1]] || [] }]));
}
process.stderr.write('unexpected gh call ' + args.join(' '));
process.exit(1);
`);
    fs.chmodSync(path.join(dir, 'gh'), 0o755);
    return { dir, log };
  }

  const run = (args: string[], gh: { dir: string }, extraEnv: Record<string, string> = {}) => {
    const output = path.join(gh.dir, 'github-output');
    const result = spawnSync(process.execPath, [script, ...args, '--github-output', output], {
      encoding: 'utf8',
      env: {
        PATH: `${gh.dir}:${process.env.PATH ?? ''}`,
        GITHUB_REPOSITORY: REPO,
        GH_TOKEN: 'test-token-not-a-secret',
        GITHUB_RUN_ID: PUBLISHER_RUN_ID,
        ...extraEnv,
      },
    });
    const outputs = fs.existsSync(output)
      ? Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
      : {};
    return { result, outputs };
  };
  const planFile = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-plan-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'it-shard-group-plan.json');
    fs.writeFileSync(file, JSON.stringify(plan));
    return file;
  };
  const resultArtifacts = (...groups: string[]) => groups.map((group) => ({ name: itGroupResultArtifactName(group, SOURCE_RUN_ID), expired: false }));
  const baseArgs = (file: string) => ['--resolve', '--source-run-id', SOURCE_RUN_ID, '--source-sha', SOURCE_SHA, '--locales', 'it,en,de,fr', '--it-plan', file, '--build-id', BUILD_ID];

  it('resolves the retry of run 43410016876: CDN published, 4 of 6 groups restorable', () => {
    const gh = fakeGh({
      statuses: [cdnReceipt(), groupReceipt('svizzera'), groupReceipt('small-2'), groupReceipt('small-3'), groupReceipt('small-4')],
      artifactsByRun: { [PUBLISHER_RUN_ID]: resultArtifacts('svizzera', 'small-2', 'small-3', 'small-4') },
    });
    const { result, outputs } = run(baseArgs(planFile()), gh);
    expect(result.status, result.stderr).toBe(0);
    expect(outputs.it_cdn_published).toBe('true');
    expect(JSON.parse(outputs.pending_it_groups)).toEqual(['zurigo', 'small-1']);
    expect(JSON.parse(outputs.receipt_it_groups)).toEqual([
      { group: 'svizzera', runId: PUBLISHER_RUN_ID },
      { group: 'small-2', runId: PUBLISHER_RUN_ID },
      { group: 'small-3', runId: PUBLISHER_RUN_ID },
      { group: 'small-4', runId: PUBLISHER_RUN_ID },
    ]);
    expect(outputs.pending_nonit_locales).toBe('["en","de","fr"]');
  });

  it('puts a group back in the matrix when its result artifact expired', () => {
    const gh = fakeGh({
      statuses: [groupReceipt('svizzera'), groupReceipt('small-2')],
      artifactsByRun: { [PUBLISHER_RUN_ID]: [...resultArtifacts('svizzera'), { name: itGroupResultArtifactName('small-2', SOURCE_RUN_ID), expired: true }] },
    });
    const { result, outputs } = run(baseArgs(planFile()), gh);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(outputs.pending_it_groups)).toEqual(['zurigo', 'small-1', 'small-2', 'small-3', 'small-4']);
    expect(JSON.parse(outputs.receipt_it_groups)).toEqual([{ group: 'svizzera', runId: PUBLISHER_RUN_ID }]);
  });

  it('skips nothing when the plan is missing or does not belong to the source run', () => {
    const gh = fakeGh({
      statuses: [cdnReceipt(), groupReceipt('zurigo')],
      artifactsByRun: { [PUBLISHER_RUN_ID]: resultArtifacts('zurigo') },
    });
    const missing = run(baseArgs('/nonexistent/it-shard-group-plan.json'), gh);
    expect(missing.result.status, missing.result.stderr).toBe(0);
    expect(JSON.parse(missing.outputs.pending_it_groups)).toEqual([...IT_SHARD_GROUP_IDS]);
    expect(missing.outputs.it_cdn_published).toBe('true');
    expect(missing.result.stdout + missing.result.stderr).toContain('unreadable');
    const wrongSource = run(['--resolve', '--source-run-id', '1', '--source-sha', SOURCE_SHA, '--it-plan', planFile()], gh);
    expect(JSON.parse(wrongSource.outputs.pending_it_groups)).toEqual([...IT_SHARD_GROUP_IDS]);
  });

  const results = (...sections: string[]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-group-proof-'));
    tempDirs.push(dir);
    for (const section of sections) {
      fs.mkdirSync(path.join(dir, 'shard-content-manifests/it'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'it-shard-results'), { recursive: true });
      fs.writeFileSync(path.join(dir, `shard-ok-${section}-it`), '');
      fs.writeFileSync(path.join(dir, `shard-content-manifests/it/${section}.json`), '{}');
      fs.writeFileSync(path.join(dir, `it-shard-results/${section}-dist-it.tar`), 'tar');
    }
    return dir;
  };
  const posts = (log: string) => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as string[]).filter((args) => args.includes('POST'));
  const writeArgs = (file: string, resultsDir: string, group = 'small-1') => [
    '--write', 'it-group', '--source-run-id', SOURCE_RUN_ID, '--source-sha', SOURCE_SHA,
    '--group', group, '--plan', file, '--results-dir', resultsDir,
  ];

  it('writes the group receipt with the plan digest and the publisher run, after the proof exists', () => {
    const gh = fakeGh({ statuses: [] });
    const { result } = run(writeArgs(planFile(), results('argovia', 'vaud')), gh);
    expect(result.status, result.stderr).toBe(0);
    const [post] = posts(gh.log);
    expect(post).toEqual(expect.arrayContaining([
      `repos/${REPO}/statuses/${SOURCE_SHA}`,
      'state=success',
      `context=${IT_GROUP_RECEIPT_PREFIX}/${SOURCE_RUN_ID}/small-1`,
      `description=${formatItGroupReceiptDescription({ group: 'small-1', digest: itShardGroupPlanDigest(plan, 'small-1') })}`,
      `target_url=https://github.com/${REPO}/actions/runs/${PUBLISHER_RUN_ID}`,
    ]));
  });

  it('refuses to write without the full proof, outside the allowlist, or on a foreign plan', () => {
    const gh = fakeGh({ statuses: [] });
    const partial = run(writeArgs(planFile(), results('argovia')), gh);
    expect(partial.result.status).toBe(1);
    expect(partial.result.stderr).toContain('no proof of its push yet');
    expect(partial.result.stderr).toContain('vaud');
    const unknown = run(writeArgs(planFile(), results('argovia', 'vaud'), 'small-9'), gh);
    expect(unknown.result.status).toBe(1);
    expect(unknown.result.stderr).toContain('allowlist');
    const foreign = run(['--write', 'it-group', '--source-run-id', '1', '--source-sha', SOURCE_SHA, '--group', 'small-1', '--plan', planFile(), '--results-dir', results('argovia', 'vaud')], gh);
    expect(foreign.result.status).toBe(1);
    expect(foreign.result.stderr).toContain('plan is invalid');
    expect(fs.existsSync(gh.log) ? posts(gh.log) : []).toEqual([]);
  });

  it('is idempotent for an identical receipt and refuses to write near the 1000-status cap', () => {
    const identical = fakeGh({ statuses: [groupReceipt('small-1')] });
    const again = run(writeArgs(planFile(), results('argovia', 'vaud')), identical);
    expect(again.result.status, again.result.stderr).toBe(0);
    expect(posts(identical.log)).toEqual([]);

    const crowded = fakeGh({
      statuses: Array.from({ length: MAX_RECEIPT_STATUSES_PER_CONTEXT }, (_unused, index) => ({
        ...groupReceipt('small-1', 'd'.repeat(64)),
        created_at: `2026-11-14T10:${String(index % 60).padStart(2, '0')}:00Z`,
      })),
    });
    const refused = run(writeArgs(planFile(), results('argovia', 'vaud')), crowded);
    expect(refused.result.status).toBe(1);
    expect(refused.result.stderr).toContain('GitHub keeps at most 1000');
    expect(posts(crowded.log)).toEqual([]);
  });

  it('writes the CDN receipt with the build id', () => {
    const gh = fakeGh({ statuses: [] });
    const { result } = run(['--write', 'it-cdn', '--source-run-id', SOURCE_RUN_ID, '--source-sha', SOURCE_SHA, '--build-id', BUILD_ID], gh);
    expect(result.status, result.stderr).toBe(0);
    expect(posts(gh.log)[0]).toEqual(expect.arrayContaining([
      `context=${IT_CDN_RECEIPT_PREFIX}/${SOURCE_RUN_ID}`,
      `description=${formatItCdnReceiptDescription({ sourceRunId: SOURCE_RUN_ID, buildId: BUILD_ID })}`,
    ]));
  });
});

describe('durable R2 OG manifest behind the IT CDN receipt', () => {
  const resolveCdn = (statuses: any[], options: Record<string, unknown> = {}) => resolveItPublishReceipts({
    statuses,
    sourceRunId: SOURCE_RUN_ID,
    buildId: BUILD_ID,
    expectedDigests: expectedItGroupDigests(plan),
    ...options,
  });

  it('extracts the publisher run that wrote the CDN receipt from its target_url', () => {
    const state = resolveCdn([cdnReceipt()]);
    expect(state.itCdnPublished).toBe(true);
    expect(state.itCdnRunId).toBe(PUBLISHER_RUN_ID);
    expect(resolveCdn([]).itCdnRunId).toBe('');
    expect(itCdnManifestArtifactName(SOURCE_RUN_ID)).toBe(`r2-og-manifest-it-${SOURCE_RUN_ID}`);
  });

  it('with an R2 target a receipt whose manifest artifact is gone does not skip the CDN job', () => {
    const seen: string[] = [];
    const gone = resolveCdn([cdnReceipt()], {
      cdnManifestRequired: true,
      cdnManifestAvailable: ({ publisherRunId }: any) => { seen.push(publisherRunId); return false; },
    });
    expect(seen).toEqual([PUBLISHER_RUN_ID]);
    expect(gone.itCdnPublished).toBe(false);
    expect(gone.itCdnRunId).toBe('');
    expect(gone.itCdnRejectedReason).toBe('r2-manifest-artifact-unavailable');
    const present = resolveCdn([cdnReceipt()], { cdnManifestRequired: true, cdnManifestAvailable: () => true });
    expect(present.itCdnPublished).toBe(true);
    expect(present.itCdnRunId).toBe(PUBLISHER_RUN_ID);
  });

  it('with an R2 target a receipt without a recoverable publisher run is not enough', () => {
    const noRun = { ...cdnReceipt(), target_url: 'https://example.invalid/x' };
    const state = resolveCdn([noRun], { cdnManifestRequired: true, cdnManifestAvailable: () => true });
    expect(state.itCdnPublished).toBe(false);
    expect(state.itCdnRejectedReason).toBe('no-publisher-run');
  });

  it('without an R2 target the manifest is not required (pages-only CDN keeps skipping)', () => {
    const state = resolveCdn([cdnReceipt()], { cdnManifestRequired: false, cdnManifestAvailable: () => false });
    expect(state.itCdnPublished).toBe(true);
    expect(state.itCdnRejectedReason).toBe('');
  });

  const publishedState = {
    result: () => 'success',
    output: () => '',
    input: () => '',
  };

  it('orders the workflow so a receipt can only exist after the manifest upload, and the finalizer restores it before deploy prep', () => {
    const cdnSteps = jobSteps('publish-it-cdn');
    const ready = cdnSteps.findIndex((step) => step.id === 'cdn-ready');
    const upload = cdnSteps.find((step) => step.id === 'upload-r2-og-manifest');
    const receiptStep = namedStep('publish-it-cdn', 'Write durable IT CDN receipt');
    expect(upload.uses).toMatch(/^actions\/upload-artifact@/);
    expect(upload.with.name).toBe('r2-og-manifest-it-${{ inputs.source_run_id }}');
    expect(upload.with.path).toBe('.cache/r2-og-published-manifest.json');
    expect(upload.with['include-hidden-files']).toBe(true);
    expect(upload.with['if-no-files-found']).toBe('error');
    expect(upload.with['retention-days']).toBe(2);
    expect(upload.if).toContain("steps.cdn-ready.outcome == 'success'");
    expect(upload.if).toContain("vars.CDN_TARGET == 'r2'");
    expect(cdnSteps.indexOf(upload)).toBeGreaterThan(ready);
    expect(cdnSteps.indexOf(receiptStep)).toBeGreaterThan(cdnSteps.indexOf(upload));
    // The receipt condition: CDN ready AND (no R2 target OR the upload succeeded).
    const expression = String(receiptStep.if);
    const evaluate = (target: string, uploadOutcome: string, ready_ = 'success') => evaluateExpression(
      expression.replace(/vars\.CDN_TARGET/g, JSON.stringify(target).replace(/"/g, "'"))
        .replace(/steps\.cdn-ready\.outcome/g, `'${ready_}'`)
        .replace(/steps\.upload-r2-og-manifest\.outcome/g, `'${uploadOutcome}'`),
      publishedState,
    );
    expect(evaluate('r2', 'success')).toBe(true);
    expect(evaluate('both', 'success')).toBe(true);
    expect(evaluate('r2', 'failure')).toBe(false);
    expect(evaluate('both', 'skipped')).toBe(false);
    expect(evaluate('pages', 'skipped')).toBe(true);
    expect(evaluate('r2', 'success', 'failure')).toBe(false);

    const steps = jobSteps('finalize-it-publish');
    const restore = namedStep('finalize-it-publish', 'Restore R2 OG manifest from the CDN receipt run');
    const prep = steps.findIndex((step) => step.name === 'Deploy prep (IT → Pages + CDN)');
    expect(steps.indexOf(restore)).toBeLessThan(prep);
    expect(restore.uses).toMatch(/^actions\/download-artifact@/);
    expect(restore.with.name).toBe('r2-og-manifest-it-${{ inputs.source_run_id }}');
    expect(restore.with.path).toBe('.cache');
    expect(restore.with['run-id']).toBe('${{ needs.resolve-publish-receipts.outputs.it_cdn_run_id }}');
    expect(restore.with['github-token']).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(restore.if).toContain("it_cdn_published == 'true'");
    expect(restore.if).toContain("vars.CDN_TARGET == 'r2'");
    expect(restore['continue-on-error']).toBeUndefined();
    // The per-run cache restore stays for the normal case (CDN job in this run).
    expect(namedStep('finalize-it-publish', 'Restore R2 OG manifest from the early CDN job').with.key)
      .toBe('r2-og-published-${{ github.run_id }}');
  });

  it('asks the resolver to require the manifest exactly for r2/both and exposes the run id', () => {
    const resolver = namedStep('resolve-publish-receipts', 'Resolve source-run receipts');
    expect(resolver.run).toContain('--cdn-manifest-required "$CDN_MANIFEST_REQUIRED"');
    expect(resolver.env.CDN_MANIFEST_REQUIRED)
      .toBe("${{ (vars.CDN_TARGET == 'r2' || vars.CDN_TARGET == 'both') && 'true' || 'false' }}");
    expect(publish.jobs['resolve-publish-receipts'].outputs.it_cdn_run_id).toBe('${{ steps.receipts.outputs.it_cdn_run_id }}');
  });

  it('CLI: an R2 retry skips the CDN job only when the previous run still lists the manifest artifact', () => {
    const script = path.join(root, 'scripts/ci/publish-receipts.mjs');
    const make = (artifacts: any[]) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-r2-'));
      tempDirs.push(dir);
      fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const endpoint = process.argv.slice(2).find((a) => a.startsWith('repos/')) || '';
const out = (t) => { fs.writeSync(1, t); process.exit(0); };
if (/statuses/.test(endpoint)) out(JSON.stringify([${JSON.stringify([cdnReceipt()])}]));
if (/actions\\/runs\\/\\d+\\/artifacts/.test(endpoint)) out(JSON.stringify([{ artifacts: ${JSON.stringify(artifacts)} }]));
process.exit(1);
`);
      fs.chmodSync(path.join(dir, 'gh'), 0o755);
      return dir;
    };
    const run = (dir: string, required: string) => {
      const output = path.join(dir, 'out');
      const plan_ = path.join(dir, 'plan.json');
      fs.writeFileSync(plan_, JSON.stringify(plan));
      const result = spawnSync(process.execPath, [script, '--resolve', '--source-run-id', SOURCE_RUN_ID, '--source-sha', SOURCE_SHA, '--it-plan', plan_, '--build-id', BUILD_ID, '--cdn-manifest-required', required, '--github-output', output], {
        encoding: 'utf8',
        env: { PATH: `${dir}:${process.env.PATH ?? ''}`, GITHUB_REPOSITORY: 'valerielinc-ops/frontaliere-si-o-no', GH_TOKEN: 'x' },
      });
      expect(result.status, result.stderr).toBe(0);
      return Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    };
    const listed = make([{ name: itCdnManifestArtifactName(SOURCE_RUN_ID), expired: false }]);
    expect(run(listed, 'true')).toMatchObject({ it_cdn_published: 'true', it_cdn_run_id: PUBLISHER_RUN_ID });
    const expired = make([{ name: itCdnManifestArtifactName(SOURCE_RUN_ID), expired: true }]);
    expect(run(expired, 'true')).toMatchObject({ it_cdn_published: 'false', it_cdn_run_id: '' });
    expect(run(expired, 'false')).toMatchObject({ it_cdn_published: 'true', it_cdn_run_id: PUBLISHER_RUN_ID });
  });
});
