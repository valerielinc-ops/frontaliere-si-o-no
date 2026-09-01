import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const workflow = fs.readFileSync(path.resolve('.github/workflows/translate-pending-logic.yml'), 'utf8');
const portableWorkflow = fs.readFileSync(path.resolve('.github/corpus-workflows/translate-pending.yml'), 'utf8');
const portableContract = JSON.parse(fs.readFileSync(path.resolve('.github/corpus-workflows/contract.json'), 'utf8'));
const titleFixScript = fs.readFileSync(path.resolve('scripts/fix-untranslated-titles.mjs'), 'utf8');
const UPLOAD_ARTIFACT_V7_SHA = '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';

type YamlMapping = Record<string, unknown>;

function isYamlMapping(value: unknown): value is YamlMapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTranslationSteps(document: string): YamlMapping[] {
  const parsed: unknown = YAML.parse(document);
  if (!isYamlMapping(parsed) || !isYamlMapping(parsed.jobs) ||
      !isYamlMapping(parsed.jobs.translate) || !Array.isArray(parsed.jobs.translate.steps)) {
    throw new Error('translate workflow must define jobs.translate.steps');
  }
  return parsed.jobs.translate.steps.map((step, index) => {
    if (!isYamlMapping(step)) throw new Error(`translate workflow step ${index} must be a mapping`);
    return step;
  });
}

function sha256(document: string) {
  return createHash('sha256').update(document).digest('hex');
}

describe('translation observability workflow', () => {
  it('advances true-final state only on successful non-dry source and portable runs', () => {
    for (const [label, document] of [['source', workflow], ['portable artifact', portableWorkflow]]) {
      const steps = parseTranslationSteps(document);
      const parsed: any = YAML.parse(document);
      expect(parsed.jobs.translate['timeout-minutes'], `${label}: workflow margin changed`).toBe(350);
      const final = steps.find((step) => step.name === 'Capture final translation observability (shadow)');
      if (!final || typeof final.name !== 'string' || typeof final.if !== 'string' || typeof final.run !== 'string') {
        throw new Error(`${label}: final observability step must define name, if, and run`);
      }
      expect(final, `${label}: final observability step missing`).toMatchObject({
        if: "always() && steps.translation_observability_before.outputs.ready == 'true'",
      });
      expect(final.run).toContain('--state data/translation-observability-state.json');
      expect(final.run).toContain('--state-output data/translation-observability-state.json');
      expect(final.run).toContain('--advance-state "${{ job.status == \'success\' && inputs.dry_run != true }}"');
    }
  });

  it('captures baseline after markers and final only after the Phase 2c persistence barrier', () => {
    const before = workflow.indexOf('Capture translation observability baseline');
    const marker = workflow.indexOf('Flag wrong-language job titles');
    const mopup = workflow.indexOf('Phase 2c mop-up');
    const persist = workflow.indexOf('Re-assemble dataset after Phase 2c mop-up');
    const titleFix = workflow.indexOf('Fix untranslated titles (free cascade)');
    const titleCommit = workflow.indexOf('Commit title fixes');
    const trueFinal = workflow.indexOf('Re-assemble true-final translation dataset');
    const final = workflow.indexOf('Capture final translation observability (shadow)');
    const commit = workflow.indexOf('Commit translations');
    const finalize = workflow.indexOf('Finalize translation observability report');
    const rollup = workflow.indexOf('Roll up translation observability history');
    expect(before).toBeGreaterThan(marker);
    expect(persist).toBeGreaterThan(mopup);
    expect(workflow.slice(mopup, persist)).not.toContain('scatter-jobs-to-slices.mjs');
    expect(trueFinal).toBeGreaterThan(titleFix);
    expect(trueFinal).toBeGreaterThan(titleCommit);
    expect(commit).toBeGreaterThan(persist);
    expect(commit).toBeLessThan(titleFix);
    expect(final).toBeGreaterThan(trueFinal);
    expect(finalize).toBeGreaterThan(final);
    expect(rollup).toBeGreaterThan(finalize);
    expect(workflow.slice(final, finalize)).toContain('if: always()');
    expect(workflow).toContain('steps.commit_title_fixes.outputs.final_commit || steps.commit_translations.outputs.final_commit');
    expect(workflow).toContain("retention-days: 14");
    expect(workflow).toContain('inputs.dry_run != true');
    expect(workflow).not.toContain('translation-shadow-plan.mjs');

    const steps: any[] = YAML.parse(workflow).jobs.translate.steps;
    const mopupIndex = steps.findIndex((step) => step.name === 'Phase 2c mop-up: local MT (Argos Translate, in-process)');
    expect(steps[mopupIndex + 1]).toMatchObject({
      name: 'Re-assemble dataset after Phase 2c mop-up',
      run: 'node scripts/assemble-jobs-dataset.mjs',
    });
    expect(steps.slice(mopupIndex + 1).some((step) => step.run === 'node scripts/scatter-jobs-to-slices.mjs')).toBe(false);
    expect(titleFixScript).toContain('BY_CRAWLER_DIR');
    expect(titleFixScript).toContain('writeJson(slicePath, sliceData)');
  });

  it('remains parseable and leaves the translation engine/dispatch commands unchanged', () => {
    const doc: any = YAML.parse(workflow);
    const runs = doc.jobs.translate.steps.map((step: any) => step.run || '').join('\n');
    expect(runs).toContain('node scripts/relocalize-pending-jobs.mjs "${ARGS[@]}"');
    expect(runs).toContain('node scripts/local-mt-mopup.mjs --max-jobs "$INPUT_MOPUP_MAX_JOBS"');
    expect(runs).toContain('node scripts/assemble-jobs-dataset.mjs');
    expect(runs).not.toContain('gh workflow run');
  });

  it('wires only shadow preflight v2 through source, generated artifact, and hash contract', () => {
    for (const [label, document] of [['source', workflow], ['portable artifact', portableWorkflow]]) {
      const steps = parseTranslationSteps(document);
      const cascade = steps.find((step) => step.name === 'Phase 2b: Translate pending jobs (cascade top-up)');
      const finalize = steps.find((step) => step.name === 'Finalize translation shadow preflight v2 observation');
      const upload = steps.find((step) => step.name === 'Upload translation shadow preflight v2 artifacts');
      expect(cascade, `${label}: decision step id missing`).toMatchObject({
        id: 'translation_shadow_preflight_v2_decision',
      });
      const cascadeRun = cascade?.run;
      if (typeof cascadeRun !== 'string') {
        throw new Error(`${label}: cascade wiring must be a string`);
      }
      expect(cascadeRun, `${label}: cascade wiring missing`).toContain('--shadow-preflight-v2-output "$RUNNER_TEMP/translation-shadow-preflight-v2-decision.json"');
      expect(cascadeRun).toContain('--shadow-preflight-v2-runner-temp "$RUNNER_TEMP"');
      expect(cascadeRun).toContain('--shadow-preflight-v2-repository "$SHADOW_SOURCE_REPOSITORY"');
      expect(cascadeRun).toContain('--shadow-preflight-v2-workflow "$SHADOW_SOURCE_WORKFLOW"');
      expect(cascadeRun).toContain('--shadow-preflight-v2-run-id "$SHADOW_RUN_ID"');
      expect(cascadeRun).toContain('--shadow-preflight-v2-run-attempt "$SHADOW_RUN_ATTEMPT"');
      expect(cascadeRun).toContain('--shadow-preflight-v2-workflow-blob-sha "$SHADOW_WORKFLOW_BLOB_SHA"');
      expect(cascadeRun).toContain('--mode capture');
      expect(cascadeRun).toContain('^expected_(decision|contract)_digest=sha256:[a-f0-9]{64}$');
      expect(cascadeRun).toContain('>> "$GITHUB_OUTPUT"');
      expect(cascadeRun).toContain('legacy_status=$?');
      expect(cascadeRun).toContain('exit "$legacy_status"');
      expect(cascadeRun.indexOf('node scripts/relocalize-pending-jobs.mjs'))
        .toBeLessThan(cascadeRun.indexOf('--mode capture'));
      expect(cascade?.env, `${label}: dry-run must not alter Phase 2b`).not.toHaveProperty('RELOCALIZE_DRY_RUN');
      expect(JSON.stringify(cascade), `${label}: Phase 2b must not consume dry-run`).not.toContain('inputs.dry_run');
      expect(finalize, `${label}: finalizer missing`).toMatchObject({
        if: "always() && steps.checkout.outcome == 'success'",
        'continue-on-error': true,
        env: {
          SHADOW_FINAL_TRANSLATION_COMMIT: '${{ steps.commit_title_fixes.outputs.final_commit || steps.commit_translations.outputs.final_commit }}',
        },
      });
      expect(finalize?.run).toContain('node scripts/translation-shadow-preflight-v2.mjs');
      expect(finalize?.run).toContain('--final-translation-commit "$SHADOW_FINAL_TRANSLATION_COMMIT"');
      expect(finalize?.run).toContain('--expected-decision-digest "$SHADOW_EXPECTED_DECISION_DIGEST"');
      expect(finalize?.run).toContain('--expected-contract-digest "$SHADOW_EXPECTED_CONTRACT_DIGEST"');
      expect(finalize?.run).toContain('--source-repository "$SHADOW_SOURCE_REPOSITORY"');
      expect(finalize?.run).toContain('--source-workflow "$SHADOW_SOURCE_WORKFLOW"');
      expect(finalize?.run).toContain('--workflow-blob-sha "$SHADOW_WORKFLOW_BLOB_SHA"');
      expect(finalize?.env).toMatchObject({
        SHADOW_EXPECTED_DECISION_DIGEST: '${{ steps.translation_shadow_preflight_v2_decision.outputs.expected_decision_digest }}',
        SHADOW_EXPECTED_CONTRACT_DIGEST: '${{ steps.translation_shadow_preflight_v2_decision.outputs.expected_contract_digest }}',
        SHADOW_RUN_ATTEMPT: '${{ github.run_attempt }}',
        SHADOW_RUN_ID: '${{ github.run_id }}',
        SHADOW_SOURCE_REPOSITORY: '${{ github.repository }}',
        SHADOW_SOURCE_WORKFLOW: '${{ github.workflow_ref }}',
        SHADOW_WORKFLOW_BLOB_SHA: '${{ github.workflow_sha }}',
      });
      expect(upload).toMatchObject({
        'continue-on-error': true,
        uses: `actions/upload-artifact@${UPLOAD_ARTIFACT_V7_SHA}`,
      });
      expect(upload?.with).toMatchObject({
        'retention-days': 14,
        'if-no-files-found': 'warn',
      });
      expect(JSON.stringify(upload?.with)).toContain('translation-shadow-preflight-v2-decision.json');
      expect(JSON.stringify(upload?.with)).toContain('translation-shadow-preflight-v2-observation.json');
      expect(JSON.stringify(upload?.with)).not.toContain('translation-shadow-preflight-v2/');
      expect(document).not.toContain('translation-shadow-plan.mjs');
      const uploadSteps = steps.filter((step) => typeof step.uses === 'string'
        && step.uses.startsWith('actions/upload-artifact@'));
      expect(uploadSteps.length).toBeGreaterThan(0);
      expect(uploadSteps.every((step) => step.uses === `actions/upload-artifact@${UPLOAD_ARTIFACT_V7_SHA}`))
        .toBe(true);
    }

    expect(portableContract.siteRuntimePaths).toEqual(expect.arrayContaining([
      'scripts/lib/translation-shadow-preflight-v2.mjs',
      'scripts/translation-shadow-preflight-v2.mjs',
    ]));
    const translateArtifact = portableContract.artifacts.find((artifact: any) => artifact.file === 'translate-pending.yml');
    expect(translateArtifact).toMatchObject({ sourceLogic: 'translate-pending-logic.yml' });
    expect(translateArtifact.sourceSha256).toBe(sha256(workflow));
    expect(translateArtifact.artifactSha256).toBe(sha256(portableWorkflow));
  });
});
