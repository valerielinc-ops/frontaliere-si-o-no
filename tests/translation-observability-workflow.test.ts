import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const workflow = fs.readFileSync(path.resolve('.github/workflows/translate-pending-logic.yml'), 'utf8');
const portableWorkflow = fs.readFileSync(path.resolve('.github/corpus-workflows/translate-pending.yml'), 'utf8');
const titleFixScript = fs.readFileSync(path.resolve('scripts/fix-untranslated-titles.mjs'), 'utf8');

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

describe('translation observability workflow', () => {
  it('advances true-final state only on successful non-dry source and portable runs', () => {
    for (const [label, document] of [['source', workflow], ['portable artifact', portableWorkflow]]) {
      const steps = parseTranslationSteps(document);
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
});
