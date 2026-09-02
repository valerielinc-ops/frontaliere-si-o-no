import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { GROUP_IDS, createCrawlerGenerationSentinel } from '../scripts/lib/crawler-generation-contract.mjs';
import { collectRelativeImportClosure } from './helpers/collectRelativeImportClosure';

const root = path.resolve(import.meta.dirname, '..');
const orchestratorPath = '.github/workflows/orchestrate-crawlers.yml';
const observerPath = '.github/corpus-workflows/observers/workflows/crawler-generation-observer-shadow.yml';
const uploadArtifactV7Sha = '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
const shadowFinalizeName = 'Finalize translation shadow preflight v2 observation';
const shadowUploadName = 'Upload translation shadow preflight v2 artifacts';
const shadowCascadeEnv = {
  SHADOW_RUN_ATTEMPT: '${{ github.run_attempt }}',
  SHADOW_RUN_ID: '${{ github.run_id }}',
  SHADOW_SOURCE_REPOSITORY: '${{ github.repository }}',
  SHADOW_SOURCE_WORKFLOW: '${{ github.workflow_ref }}',
  SHADOW_WORKFLOW_BLOB_SHA: '${{ github.workflow_sha }}',
};
const expectedShadowHashes = {
  cascadeRun: 'd111ba88beb2ff9af1eb4246f81fdf7d9e87c866e7e0061b055430dc59e176af',
  finalize: '74dee29ad0d005a9a350bfce73c68348ac31e3d50fe1b5c5c8df4803b9a7e857',
  upload: '0c184849503095b03f5d268617fed8cfac7aa8fd4e112a99ed3aa7a782dc9568',
};

function translateStep(document: string) {
  const parsed = YAML.parse(document);
  return parsed.jobs.dispatch.steps.find((step: any) => step.name === 'Dispatch translate-pending (frontaliere-articles)');
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function cloneDocument<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function findUniqueStep(steps: any[], name: string) {
  const indexes = steps.flatMap((step, index) => step.name === name ? [index] : []);
  expect(indexes, `${name}: expected exactly one step`).toHaveLength(1);
  const index = indexes[0];
  return { index, step: steps[index] };
}

function expectCurrentShadowContract(currentDocument: any, baseDocument: any, sourceDocument: any) {
  expect(currentDocument).toEqual(baseDocument);
  expect(currentDocument.concurrency).toEqual({
    group: 'jobs-data-pipeline',
    'cancel-in-progress': false,
    queue: 'max',
  });

  const currentSteps = currentDocument.jobs.translate.steps;
  const sourceSteps = sourceDocument.jobs.translate.steps;
  const cascadeName = 'Phase 2b: Translate pending jobs (cascade top-up)';
  const currentCascade = findUniqueStep(currentSteps, cascadeName).step;
  const sourceCascade = findUniqueStep(sourceSteps, cascadeName).step;
  expect(currentCascade.id).toBe('translation_shadow_preflight_v2_decision');
  expect(typeof currentCascade.run).toBe('string');
  expect(sha256(currentCascade.run)).toBe(expectedShadowHashes.cascadeRun);
  expect(Object.fromEntries(Object.keys(shadowCascadeEnv).map((key) => [
    key, currentCascade.env[key],
  ]))).toEqual(shadowCascadeEnv);
  expect(currentCascade).toEqual(sourceCascade);

  const finalize = findUniqueStep(currentSteps, shadowFinalizeName);
  const upload = findUniqueStep(currentSteps, shadowUploadName);
  const rollup = findUniqueStep(currentSteps, 'Roll up translation observability history');
  expect(finalize.index + 1).toBe(upload.index);
  expect(upload.index + 1).toBe(rollup.index);
  expect(Object.keys(finalize.step).sort()).toEqual([
    'continue-on-error', 'env', 'id', 'if', 'name', 'run',
  ]);
  expect(Object.keys(finalize.step.env).sort()).toEqual([
    'SHADOW_DEFAULT_COMPANY_KEY', 'SHADOW_DEFAULT_DRY_RUN', 'SHADOW_DEFAULT_MAX_JOBS',
    'SHADOW_DEFAULT_MOPUP_MAX_JOBS', 'SHADOW_DEFAULT_SKIP_HOUSEKEEPING',
    'SHADOW_DEFAULT_SKIP_TRANSLATE', 'SHADOW_EVENT_ACTION', 'SHADOW_EVENT_NAME',
    'SHADOW_EXPECTED_CONTRACT_DIGEST', 'SHADOW_EXPECTED_DECISION_DIGEST',
    'SHADOW_FINAL_TRANSLATION_COMMIT', 'SHADOW_OBSERVED_JOB_STATUS', 'SHADOW_RUN_ATTEMPT',
    'SHADOW_RUN_ID', 'SHADOW_SOURCE_COMMIT', 'SHADOW_SOURCE_REPOSITORY',
    'SHADOW_SOURCE_WORKFLOW', 'SHADOW_WORKFLOW_BLOB_SHA',
  ]);
  expect(Object.keys(upload.step).sort()).toEqual([
    'continue-on-error', 'if', 'name', 'uses', 'with',
  ]);
  expect(Object.keys(upload.step.with).sort()).toEqual([
    'if-no-files-found', 'name', 'path', 'retention-days',
  ]);
  expect(finalize.step).toEqual(findUniqueStep(sourceSteps, shadowFinalizeName).step);
  expect(upload.step).toEqual(findUniqueStep(sourceSteps, shadowUploadName).step);
  expect(sha256(JSON.stringify(finalize.step))).toBe(expectedShadowHashes.finalize);
  expect(sha256(JSON.stringify(upload.step))).toBe(expectedShadowHashes.upload);
  expect(upload.step.uses).toBe(`actions/upload-artifact@${uploadArtifactV7Sha}`);
  expect(findUniqueStep(currentSteps, 'Upload translation observability report').step)
    .toEqual(findUniqueStep(sourceSteps, 'Upload translation observability report').step);
}

describe('crawler generation PR B workflow wiring', () => {
  it('keeps the current portable translation baseline and every generation group token/ref/hash-bound', () => {
    const base = execFileSync('git', ['show', `origin/main:${orchestratorPath}`], { encoding: 'utf8' });
    const current = fs.readFileSync(orchestratorPath, 'utf8');
    expect(translateStep(current)).toEqual(translateStep(base));
    const portableTranslate = '.github/corpus-workflows/translate-pending.yml';
    const portableCurrent = YAML.parse(fs.readFileSync(portableTranslate, 'utf8'));
    const portableBase = YAML.parse(execFileSync(
      'git', ['show', `origin/main:${portableTranslate}`], { encoding: 'utf8' },
    ));
    expect(portableCurrent.concurrency).toEqual({
      group: 'jobs-data-pipeline',
      'cancel-in-progress': false,
      queue: 'max',
    });
    const sourceTranslate = YAML.parse(fs.readFileSync(
      '.github/workflows/translate-pending-logic.yml',
      'utf8',
    ));
    expectCurrentShadowContract(portableCurrent, portableBase, sourceTranslate);
    const baselineMutation = cloneDocument(portableCurrent);
    baselineMutation.jobs.translate['timeout-minutes'] += 1;
    expect(() => expectCurrentShadowContract(baselineMutation, portableBase, sourceTranslate))
      .toThrowError();
    const currentTriggerDeploy = portableCurrent.jobs.translate.steps
      .find((step: any) => step.name === 'Trigger deploy');
    const sourceTriggerDeploy = sourceTranslate.jobs.translate.steps
      .find((step: any) => step.name === 'Trigger deploy');
    expect(currentTriggerDeploy).toBeDefined();
    expect(sourceTriggerDeploy).toBeDefined();
    expect(currentTriggerDeploy).toEqual(sourceTriggerDeploy);
    const contract = JSON.parse(fs.readFileSync('.github/corpus-workflows/contract.json', 'utf8'));
    for (const group of GROUP_IDS) {
      const workflowPath = `.github/corpus-workflows/crawler-group-${group}.yml`;
      const workflowSource = fs.readFileSync(workflowPath, 'utf8');
      const crawler = YAML.parse(workflowSource);
      expect(crawler).toEqual(YAML.parse(execFileSync(
        'git', ['show', `origin/main:${workflowPath}`], { encoding: 'utf8' },
      )));
      expect(crawler.concurrency).toEqual({
        group: `jobs-crawler-group-${group}`,
        'cancel-in-progress': false,
      });
      expect(crawler['run-name']).toBe(`crawler-generation-${'${{ inputs.generation_token }}'}-group-${group}`);
      expect(crawler.on.workflow_dispatch.inputs.generation_token)
        .toMatchObject({ required: false, default: '', type: 'string' });
      const job = Object.values(crawler.jobs)[0] as any;
      expect(job.env.CRAWLER_GENERATION_TOKEN).toBe('${{ inputs.generation_token }}');
      const siteCheckouts = job.steps.filter((step: any) => step.with?.repository === 'valerielinc-ops/frontaliere-si-o-no');
      expect(siteCheckouts).toHaveLength(2);
      expect(siteCheckouts.every((step: any) => step.with.ref === "${{ inputs.site_code_commit || 'main' }}"))
        .toBe(true);
      const artifact = contract.artifacts.find((entry: any) => entry.file === `crawler-group-${group}.yml`);
      expect(artifact?.artifactSha256).toBe(sha256(workflowSource));
      expect(artifact?.sourceSha256).toBe(sha256(fs.readFileSync(
        `.github/workflows/${artifact.sourceLogic}`,
        'utf8',
      )));
    }
    expect(contract.crawlerGeneration).toMatchObject({ mode: 'shadow', dispatchesTranslation: false });
  });

  it('wires checkpointed generation dispatch and an always-run sentinel without return_run_details', () => {
    const source = fs.readFileSync(orchestratorPath, 'utf8');
    const parsed = YAML.parse(source);
    const steps = parsed.jobs.dispatch.steps;
    const preflight = steps.find((step: any) => step.name === 'Preflight crawler generation shadow transport');
    const dispatch = steps.find((step: any) => step.name === 'Dispatch crawler generation wave');
    const sentinel = steps.find((step: any) => step.name === 'Dispatch crawler generation sentinel');
    const cleanup = steps.find((step: any) => step.name === 'Cleanup accepted crawler generation ref');
    const failureReporter = steps.find((step: any) => step.name === 'Report failure to GitHub Issues');
    expect(preflight).not.toHaveProperty('continue-on-error');
    expect(dispatch.id).toBe('generation_wave');
    expect(dispatch.if).toBe("steps.generation_preflight.outputs.ready == 'true'");
    expect(dispatch.run).toContain('scripts/crawler-generation-dispatch.mjs dispatch-groups');
    expect(dispatch.run).toContain('--corpus-code-commit "$CORPUS_CODE_COMMIT"');
    expect(dispatch.env.CORPUS_CODE_COMMIT).toContain('steps.generation_preflight.outputs.corpus_commit');
    expect(dispatch.env.CORPUS_CODE_COMMIT).not.toContain('unavailable');
    expect(dispatch.env.SHADOW_READY).toBe('${{ steps.generation_preflight.outputs.ready }}');
    expect(sentinel.if).toBe('always()');
    expect(sentinel.id).toBe('generation_sentinel');
    expect(sentinel.run).toContain('scripts/crawler-generation-dispatch.mjs dispatch-sentinel');
    expect(sentinel.run).toContain('[ "$SHADOW_READY" != "true" ]');
    expect(sentinel.env.SHADOW_READY).toContain('steps.generation_wave.outputs.shadow_ready');
    expect(cleanup.if).toContain("steps.generation_wave.outputs.shadow_ready == 'true'");
    expect(cleanup.if).toContain("steps.generation_sentinel.outcome == 'success'");
    expect(cleanup.if).toContain("steps.generation_sentinel.outputs.accepted == 'true'");
    expect(cleanup.run).toContain('scripts/crawler-generation-dispatch.mjs cleanup-ref');
    expect(cleanup.env).not.toHaveProperty('GITHUB_PAT_NANAKO');
    expect(JSON.stringify(cleanup)).not.toContain('secrets.GITHUB_PAT_NANAKO');
    expect(failureReporter.if).toBe('failure()');
    expect(failureReporter.run).toContain('scripts/lib/github-issue-creator.mjs');
    expect(failureReporter.run).toContain('--title "Workflow Failure: ${{ github.workflow }}"');
    expect(source).not.toContain('return_run_details');
    const sentinelValidation = YAML.parse(fs.readFileSync(observerPath, 'utf8'))
      .jobs.sentinel.steps.find((step: any) => step.name === 'Validate manual sentinel binding before checkout');
    expect(sentinelValidation.env.CORPUS_CODE_COMMIT).toBe('${{ github.sha }}');
    expect(sentinelValidation.run).toContain('envelope.corpusCodeCommit !== process.env.CORPUS_CODE_COMMIT');
  });

  it('materializes the complete dispatcher import closure in the orchestrator sparse checkout', () => {
    const workflow = YAML.parse(fs.readFileSync(orchestratorPath, 'utf8'));
    const checkout = workflow.jobs.dispatch.steps.find((step: any) => step.uses === 'actions/checkout@v5');
    const sparsePaths = checkout.with['sparse-checkout']
      .split('\n')
      .map((value: string) => value.trim().replace(/^\//, ''))
      .filter(Boolean);
    const isMaterialized = (runtimePath: string) => sparsePaths.some(
      (sparsePath: string) => runtimePath === sparsePath || runtimePath.startsWith(`${sparsePath}/`),
    );
    const closure = collectRelativeImportClosure(root, 'scripts/crawler-generation-dispatch.mjs');
    expect(closure).toContain('functions/src/githubApiHeaders.js');
    expect(closure.filter((runtimePath) => !isMaterialized(runtimePath))).toEqual([]);
  });

  it('uses event-specific run identity, skips legacy events server-side and coalesces heavy work by probe token', () => {
    const source = fs.readFileSync(observerPath, 'utf8');
    const workflow = YAML.parse(source);
    expect(workflow.on.workflow_run.workflows).toEqual(GROUP_IDS.map(
      (group) => `Crawler Group ${group} (sparse cross-repo execution)`,
    ));
    expect(workflow.on.workflow_run.branches).toEqual(['crawler-generation-shadow-*']);
    expect(workflow['run-name']).toContain('github.event.workflow_run.id');
    expect(workflow.jobs.probe.if).toContain("!startsWith(github.event.workflow_run.display_title, 'crawler-generation--group-')");
    expect(workflow.jobs.probe.if).toContain("startsWith(github.event.workflow_run.head_branch, 'crawler-generation-shadow-')");
    const probeScript = workflow.jobs.probe.steps[0].run;
    for (const binding of [
      '.id == $runId',
      '.repository.full_name == $repository',
      '.path == $workflowPath or .path == ($workflowPath + "@" + $workflowRef)',
      '.name == $workflowName or .name == $title',
      '.head_sha == $headSha',
      '.path == ".github/workflows/crawler-generation-observer-shadow.yml"',
      '.display_title == $title',
      '.name == "Crawler Generation Observer (shadow)" or .name == $title',
      '.event == "workflow_dispatch"',
      '.head_branch == $workflowRef',
      '.head_sha | type == "string"',
      '.run_attempt | type == "number"',
      '.status == "completed"',
    ]) expect(probeScript).toContain(binding);
    expect(probeScript).toContain('github_get_with_retry()');
    expect(probeScript).toContain('gh api --method GET');
    expect(probeScript.match(/gh api/g)).toHaveLength(1);
    expect(JSON.stringify(workflow.jobs.probe.steps)).not.toContain('actions/checkout');
    expect(workflow.jobs.observe_event.concurrency.group).toContain('needs.probe.outputs.generation_token');
    expect(workflow.jobs.observe_event.concurrency['cancel-in-progress']).toBe(true);
  });

  it('adds bounded read-only six-hour reconciliation without changing heavy concurrency', () => {
    const source = fs.readFileSync(observerPath, 'utf8');
    const workflow = YAML.parse(source);
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch', 'workflow_run']);
    expect(workflow.on.schedule).toEqual([{ cron: '23 2,8,14,20 * * *' }]);
    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(workflow.jobs.reconcile_select.strategy).toBeUndefined();
    expect(workflow.jobs.reconcile_scheduled.strategy['max-parallel']).toBe(2);
    expect(workflow.jobs.reconcile_scheduled.concurrency.group)
      .toBe('crawler-generation-observer-${{ matrix.generation.generation_token }}');
    expect(workflow.jobs.observe_event.concurrency.group)
      .toBe('crawler-generation-observer-${{ needs.probe.outputs.generation_token }}');
    const scheduledSource = JSON.stringify(workflow.jobs.reconcile_select);
    expect(scheduledSource).toContain('crawler-generation-observer-selector.mjs');
    expect(scheduledSource).not.toMatch(/POST|git push|gh issue|secrets\./);
    expect(JSON.stringify(workflow.jobs.reconcile_scheduled)).toContain('--timed-out');
    for (const jobName of ['sentinel', 'observe_event', 'reconcile_scheduled']) {
      const upload = workflow.jobs[jobName].steps.find((step: any) => (
        step.uses === 'actions/upload-artifact@v7'
        && String(step.with.name).startsWith('crawler-generation-observer-')
      ));
      expect(upload.with.name).not.toContain('github.run_id');
      expect(upload.with.overwrite).toBe(true);
      expect(upload.with['retention-days']).toBe(14);
    }
  });

  it('keeps observe=false when the triggering run ID is not bound by the sentinel', () => {
    const workflow = YAML.parse(fs.readFileSync(observerPath, 'utf8'));
    const script = workflow.jobs.probe.steps[0].run;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-generation-probe-'));
    try {
      const payload = path.join(root, 'payload');
      const bin = path.join(root, 'bin');
      fs.mkdirSync(payload);
      fs.mkdirSync(bin);
      const sentinel = createCrawlerGenerationSentinel({
        generationToken: '9001-2',
        siteCodeCommit: 'a'.repeat(40),
        corpusCodeCommit: 'b'.repeat(40),
        groupRunIds: Object.fromEntries(GROUP_IDS.map((group, index) => [
          group, String(10_000 + index),
        ])),
      });
      fs.writeFileSync(
        path.join(payload, 'crawler-generation-sentinel.json'),
        JSON.stringify(sentinel),
      );
      const archive = path.join(root, 'sentinel.zip');
      execFileSync('zip', ['-q', archive, 'crawler-generation-sentinel.json'], { cwd: payload });
      const artifactJson = path.join(root, 'artifacts.json');
      fs.writeFileSync(artifactJson, JSON.stringify({
        total_count: 1,
        artifacts: [{
          id: 77,
          name: 'crawler-generation-sentinel-9001-2',
          expired: false,
          size_in_bytes: fs.statSync(archive).size,
          workflow_run: { id: 88 },
        }],
      }));
      const sentinelRunJson = path.join(root, 'sentinel-run.json');
      const validSentinelRun = {
        id: 88,
        repository: { full_name: 'nanakokyobashi-rgb/frontaliere-articles' },
        name: 'crawler-generation-sentinel-9001-2',
        path: '.github/workflows/crawler-generation-observer-shadow.yml',
        display_title: 'crawler-generation-sentinel-9001-2',
        event: 'workflow_dispatch',
        head_branch: 'crawler-generation-shadow-9001-2',
        head_sha: 'b'.repeat(40),
        run_attempt: 1,
        status: 'in_progress',
        conclusion: null,
      };
      fs.writeFileSync(sentinelRunJson, JSON.stringify(validSentinelRun));
      const triggerRunJson = path.join(root, 'trigger-run.json');
      const validTriggerRun = {
        id: 10_000,
        repository: { full_name: 'nanakokyobashi-rgb/frontaliere-articles' },
        name: 'crawler-generation-9001-2-group-01',
        display_title: 'crawler-generation-9001-2-group-01',
        path: '.github/workflows/crawler-group-01.yml',
        event: 'workflow_dispatch',
        head_branch: 'crawler-generation-shadow-9001-2',
        head_sha: 'b'.repeat(40),
        run_attempt: 1,
        status: 'completed',
        conclusion: 'success',
      };
      fs.writeFileSync(triggerRunJson, JSON.stringify(validTriggerRun));
      const gh = path.join(bin, 'gh');
      const callLog = path.join(root, 'gh-calls');
      fs.writeFileSync(gh, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$PROBE_CALL_LOG"
case "$*" in
  *"/actions/artifacts?name="*) cat "$PROBE_ARTIFACT_JSON" ;;
  *"/actions/runs/88"*) cat "$PROBE_SENTINEL_RUN_JSON" ;;
  *"/actions/artifacts/77/zip"*) cat "$PROBE_ARCHIVE" ;;
  *"--jq .status"*)
    if [[ "$*" == *"/actions/runs/10022"* ]] \
        && [ -n "\${PROBE_TRANSIENT_STATUS_ONCE:-}" ] \
        && [ ! -f "$PROBE_TRANSIENT_MARKER" ]; then
      printf '%s' "$PROBE_TRANSIENT_STATUS_ONCE" > "$PROBE_TRANSIENT_MARKER"
      case "$PROBE_TRANSIENT_STATUS_ONCE" in
        429|500) exit 22 ;;
        transport) exit 1 ;;
        *) exit 91 ;;
      esac
    fi
    printf '%s\\n' completed
    ;;
  *"/actions/runs/"*) cat "$PROBE_TRIGGER_RUN_JSON" ;;
  *) exit 91 ;;
esac
`);
      fs.chmodSync(gh, 0o755);
      const output = path.join(root, 'github-output');
      execFileSync('bash', ['-c', script], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_TOKEN: 'test',
          REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
          TRIGGER_TITLE: 'crawler-generation-9001-2-group-01',
          TRIGGER_RUN_ID: '99999',
          TRIGGER_HEAD_SHA: 'b'.repeat(40),
          PROBE_ROOT: path.join(root, 'probe'),
          GITHUB_OUTPUT: output,
          PROBE_ARTIFACT_JSON: artifactJson,
          PROBE_ARCHIVE: archive,
          PROBE_SENTINEL_RUN_JSON: sentinelRunJson,
          PROBE_TRIGGER_RUN_JSON: triggerRunJson,
          PROBE_CALL_LOG: callLog,
        },
      });
      expect(fs.readFileSync(output, 'utf8')).toBe('observe=false\n');

      fs.writeFileSync(output, '');
      fs.writeFileSync(callLog, '');
      execFileSync('bash', ['-c', script], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_TOKEN: 'test',
          REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
          TRIGGER_TITLE: 'crawler-generation-9001-2-group-01',
          TRIGGER_RUN_ID: '10000',
          TRIGGER_HEAD_SHA: 'b'.repeat(40),
          PROBE_ROOT: path.join(root, 'probe-positive'),
          GITHUB_OUTPUT: output,
          PROBE_ARTIFACT_JSON: artifactJson,
          PROBE_ARCHIVE: archive,
          PROBE_SENTINEL_RUN_JSON: sentinelRunJson,
          PROBE_TRIGGER_RUN_JSON: triggerRunJson,
          PROBE_CALL_LOG: callLog,
        },
      });
      expect(fs.readFileSync(output, 'utf8')).toContain('observe=true\n');
      expect(fs.readFileSync(output, 'utf8')).toContain('generation_token=9001-2\n');
      const calls = fs.readFileSync(callLog, 'utf8');
      expect(calls.match(/\/actions\/runs\//g)).toHaveLength(25);
      expect(calls).not.toContain('/artifacts?name=crawler-group-');

      for (const transientKind of ['429', '500', 'transport']) {
        fs.writeFileSync(output, '');
        fs.writeFileSync(callLog, '');
        const transientMarker = path.join(root, `transient-last-status-${transientKind}`);
        execFileSync('bash', ['-c', script], {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            GH_TOKEN: 'test',
            REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
            TRIGGER_TITLE: 'crawler-generation-9001-2-group-01',
            TRIGGER_RUN_ID: '10000',
            TRIGGER_HEAD_SHA: 'b'.repeat(40),
            PROBE_ROOT: path.join(root, `probe-transient-last-status-${transientKind}`),
            GITHUB_OUTPUT: output,
            PROBE_ARTIFACT_JSON: artifactJson,
            PROBE_ARCHIVE: archive,
            PROBE_SENTINEL_RUN_JSON: sentinelRunJson,
            PROBE_TRIGGER_RUN_JSON: triggerRunJson,
            PROBE_CALL_LOG: callLog,
            PROBE_TRANSIENT_STATUS_ONCE: transientKind,
            PROBE_TRANSIENT_MARKER: transientMarker,
          },
        });
        expect(fs.readFileSync(output, 'utf8')).toContain('observe=true\n');
        expect(fs.readFileSync(transientMarker, 'utf8')).toBe(transientKind);
        expect(fs.readFileSync(callLog, 'utf8').match(/\/actions\/runs\//g)).toHaveLength(26);
      }

      fs.writeFileSync(output, '');
      fs.writeFileSync(callLog, '');
      execFileSync('bash', ['-c', script], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_TOKEN: 'test',
          REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
          TRIGGER_TITLE: 'crawler-generation-9001-2-group-01',
          TRIGGER_RUN_ID: '10000',
          TRIGGER_HEAD_SHA: 'c'.repeat(40),
          PROBE_ROOT: path.join(root, 'probe-corpus-drift'),
          GITHUB_OUTPUT: output,
          PROBE_ARTIFACT_JSON: artifactJson,
          PROBE_ARCHIVE: archive,
          PROBE_SENTINEL_RUN_JSON: sentinelRunJson,
          PROBE_TRIGGER_RUN_JSON: triggerRunJson,
          PROBE_CALL_LOG: callLog,
        },
      });
      expect(fs.readFileSync(output, 'utf8')).toBe('observe=false\n');
      expect(fs.readFileSync(callLog, 'utf8')).not.toContain('/actions/artifacts/77/zip');

      for (const [label, triggerOverride] of [
        ['path', { path: '.github/workflows/untrusted-producer.yml' }],
        ['name', { name: 'Crawler Group 02 (sparse cross-repo execution)' }],
      ] as const) {
        fs.writeFileSync(triggerRunJson, JSON.stringify({ ...validTriggerRun, ...triggerOverride }));
        fs.writeFileSync(output, '');
        fs.writeFileSync(callLog, '');
        execFileSync('bash', ['-c', script], {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            GH_TOKEN: 'test',
            REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
            TRIGGER_TITLE: 'crawler-generation-9001-2-group-01',
            TRIGGER_RUN_ID: '10000',
            TRIGGER_HEAD_SHA: 'b'.repeat(40),
            PROBE_ROOT: path.join(root, `probe-spoofed-trigger-${label}`),
            GITHUB_OUTPUT: output,
            PROBE_ARTIFACT_JSON: artifactJson,
            PROBE_ARCHIVE: archive,
            PROBE_SENTINEL_RUN_JSON: sentinelRunJson,
            PROBE_TRIGGER_RUN_JSON: triggerRunJson,
            PROBE_CALL_LOG: callLog,
          },
        });
        expect(fs.readFileSync(output, 'utf8')).toBe('observe=false\n');
        expect(fs.readFileSync(callLog, 'utf8')).not.toContain('/actions/artifacts?name=');
      }
      fs.writeFileSync(triggerRunJson, JSON.stringify(validTriggerRun));

      fs.writeFileSync(sentinelRunJson, JSON.stringify({
        ...validSentinelRun,
        path: '.github/workflows/untrusted-producer.yml',
      }));
      fs.writeFileSync(output, '');
      fs.writeFileSync(callLog, '');
      execFileSync('bash', ['-c', script], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_TOKEN: 'test',
          REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
          TRIGGER_TITLE: 'crawler-generation-9001-2-group-01',
          TRIGGER_RUN_ID: '10000',
          TRIGGER_HEAD_SHA: 'b'.repeat(40),
          PROBE_ROOT: path.join(root, 'probe-spoofed-owner'),
          GITHUB_OUTPUT: output,
          PROBE_ARTIFACT_JSON: artifactJson,
          PROBE_ARCHIVE: archive,
          PROBE_SENTINEL_RUN_JSON: sentinelRunJson,
          PROBE_TRIGGER_RUN_JSON: triggerRunJson,
          PROBE_CALL_LOG: callLog,
        },
      });
      expect(fs.readFileSync(output, 'utf8')).toBe('observe=false\n');
      expect(fs.readFileSync(callLog, 'utf8')).toContain('/actions/runs/88');
      expect(fs.readFileSync(callLog, 'utf8')).not.toContain('/actions/artifacts/77/zip');
      fs.writeFileSync(sentinelRunJson, JSON.stringify(validSentinelRun));

      const oversizedArchive = path.join(root, 'sentinel-oversized.zip');
      fs.writeFileSync(
        path.join(payload, 'crawler-generation-sentinel.json'),
        'x'.repeat(128 * 1024),
      );
      execFileSync('zip', ['-q', oversizedArchive, 'crawler-generation-sentinel.json'], { cwd: payload });
      fs.writeFileSync(artifactJson, JSON.stringify({
        total_count: 1,
        artifacts: [{
          id: 77,
          name: 'crawler-generation-sentinel-9001-2',
          expired: false,
          size_in_bytes: fs.statSync(oversizedArchive).size,
          workflow_run: { id: 88 },
        }],
      }));
      fs.writeFileSync(output, '');
      fs.writeFileSync(callLog, '');
      const oversizedProbeRoot = path.join(root, 'probe-oversized');
      execFileSync('bash', ['-c', script], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_TOKEN: 'test',
          REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
          TRIGGER_TITLE: 'crawler-generation-9001-2-group-01',
          TRIGGER_RUN_ID: '10000',
          TRIGGER_HEAD_SHA: 'b'.repeat(40),
          PROBE_ROOT: oversizedProbeRoot,
          GITHUB_OUTPUT: output,
          PROBE_ARTIFACT_JSON: artifactJson,
          PROBE_ARCHIVE: oversizedArchive,
          PROBE_SENTINEL_RUN_JSON: sentinelRunJson,
          PROBE_TRIGGER_RUN_JSON: triggerRunJson,
          PROBE_CALL_LOG: callLog,
        },
      });
      expect(fs.readFileSync(output, 'utf8')).toBe('observe=false\n');
      expect(fs.existsSync(path.join(
        oversizedProbeRoot,
        'crawler-generation-sentinel-77.json',
      ))).toBe(false);
      expect(fs.readFileSync(callLog, 'utf8').match(/\/actions\/runs\//g)).toHaveLength(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
