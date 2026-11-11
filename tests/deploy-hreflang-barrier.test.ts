import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import YAML from 'yaml';
import {
  HREFLANG_FINALIZATION_MARKER,
  HREFLANG_FINALIZATION_MARKER_FILE,
  validateLocaleSourceHreflangContract,
} from '../scripts/ci/locale-source-hreflang-contract.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const deploy = YAML.parse(readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8')) as any;
const publish = YAML.parse(readFileSync(resolve(ROOT, '.github/workflows/deploy-publish.yml'), 'utf8')) as any;
const buildSteps = deploy.jobs['build-locale'].steps as any[];
const publishSteps = publish.jobs['publish-nonit-shards'].steps as any[];
const step = (steps: any[], name: string) => steps.find((candidate) => candidate.name === name);

let tempDir: string | undefined;
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('deferred same-run hreflang exchange', () => {
  it('keeps only IT behind the build-run barrier and marks non-IT source artifacts for finalization', () => {
    const exchange = step(buildSteps, 'Exchange same-run hreflang manifests');
    const rewrite = step(buildSteps, 'Hreflang index manifest (keep only reciprocal indexable clusters)');
    const validate = step(buildSteps, 'Validate locale shard output');
    const pack = step(buildSteps, 'Pack non-IT locale shard source artifact');
    const publishManifest = step(buildSteps, 'Publish hreflang index manifest (${{ matrix.locale }})');
    const provenance = step(buildSteps, 'Write locale publish provenance');

    expect(publishManifest).toBeDefined();
    expect(exchange.if).toBe("matrix.locale == 'it'");
    expect(rewrite.if).toBe("matrix.locale == 'it'");
    expect(validate.if).toBeUndefined();
    expect(provenance.env.PROVENANCE_VALIDATE_OUTCOME).toBe('${{ steps.validate-locale-shard.outcome }}');
    expect(publishManifest.with['retention-days']).toBe(3);
    expect(buildSteps.indexOf(publishManifest)).toBeLessThan(buildSteps.indexOf(exchange));
    expect(buildSteps.indexOf(exchange)).toBeLessThan(buildSteps.indexOf(rewrite));
    expect(buildSteps.indexOf(rewrite)).toBeLessThan(buildSteps.indexOf(pack));
    expect(pack.run).toContain(HREFLANG_FINALIZATION_MARKER);
    expect(pack.run).toContain(`${HREFLANG_FINALIZATION_MARKER_FILE}`);
    expect(pack.run.indexOf('ptar_create')).toBeLessThan(pack.run.indexOf(HREFLANG_FINALIZATION_MARKER));

    const retryPublish = step(buildSteps, 'Retry hreflang index manifest publish (${{ matrix.locale }})');
    expect(retryPublish.with['retention-days']).toBe(3);
  });

  it('binds non-IT sitemap receipts in the source job and IT only after publisher artifacts exist', () => {
    const bind = step(buildSteps, 'Bind sitemap page manifest to uploaded artifact digests');
    const uploadReceipt = step(buildSteps, 'Upload sitemap page manifest for publisher gate');

    expect(bind).toBeDefined();
    expect(bind.if).toContain("steps.validate-owned-sitemap-pages.outcome == 'success'");
    expect(bind.if).toContain("matrix.locale != 'it'");
    expect(bind.if).toContain("steps.upload-locale-source.outcome == 'success'");
    expect(bind.env.SECTION_ARTIFACT_DIGESTS_JSON).toBeUndefined();
    expect(bind.run).not.toContain('--section-artifact-digests');
    expect(uploadReceipt).toBeDefined();
    expect(uploadReceipt.if).toBe("always() && steps.bind-sitemap-page-manifest.outcome == 'success'");

    const itSteps = publish.jobs['finalize-it-publish'].steps as any[];
    const bindIt = step(itSteps, 'Bind sitemap page manifest to publisher artifact digests');
    const uploadIt = step(itSteps, 'Upload sitemap page manifest for publisher gate');
    expect(bindIt?.if).toContain("steps.upload-pages-artifact.outcome == 'success'");
    expect(bindIt?.if).toContain("steps.upload-sitemaps-bundle.outcome == 'success'");
    expect(bindIt?.env.ARTIFACT_RUN_ID).toBe('${{ github.run_id }}');
    expect(bindIt?.env.SOURCE_RUN_ID).toBe('${{ inputs.source_run_id }}');
    expect(bindIt?.run).toContain('--artifact-run-id "$ARTIFACT_RUN_ID"');
    expect(bindIt?.run).toContain('--base-artifact-name github-pages');
    expect(uploadIt?.with?.name).toBe('sitemap-page-manifest-it-${{ github.run_id }}');
    expect(itSteps.indexOf(bindIt)).toBeGreaterThan(itSteps.findIndex((candidate) => candidate.name === 'Upload Pages artifact (compression-level 9)'));
    expect(itSteps.indexOf(uploadIt)).toBeGreaterThan(itSteps.indexOf(bindIt));
  });

  it('finalizes pending source tarballs in the deferred publisher with the exact source attempt', () => {
    const sourceValidator = step(publish.jobs['validate-source-build'].steps, 'Validate source build identity and inputs');
    const sourceAttempt = publish.jobs['validate-source-build'].outputs.source_run_attempt;
    const planAttempt = publish.jobs['resolve-publish-plan'].outputs.source_run_attempt;
    const classify = step(publishSteps, 'Classify non-IT source hreflang state');
    const exchange = step(publishSteps, 'Exchange same-run hreflang manifests for deferred locale');
    const rewrite = step(publishSteps, 'Finalize deferred same-run hreflang graph');
    const validate = step(publishSteps, 'Validate finalized non-IT locale shard output');
    const provenance = step(publishSteps, 'Write non-IT locale publish provenance');
    const cdnGate = step(publishSteps, 'Wait for current IT CDN build id before non-IT shard pushes');

    expect(sourceValidator.id).toBe('validate-source-build-identity');
    expect(sourceValidator.run).toContain(".run_attempt | select(type == \"number\" and . >= 1 and . == floor)");
    expect(sourceValidator.run).toContain('source_run_attempt=$source_run_attempt');
    expect(sourceAttempt).toContain('steps.validate-source-build-identity.outputs.source_run_attempt');
    expect(planAttempt).toContain('needs.validate-source-build.outputs.source_run_attempt');
    expect(publish.jobs['publish-nonit-shards'].env.HREFlANG_RUN_ATTEMPT)
      .toBe('${{ needs.resolve-publish-plan.outputs.source_run_attempt }}');
    expect(classify.run).toContain('locale-source-hreflang-contract.mjs');
    expect(classify.run).toContain("state='already-finalized'");
    expect(exchange.if).toContain("steps.locale-source-hreflang-state.outputs.state == 'pending'");
    expect(exchange.env.HREFlANG_RUN_ID).toBe('${{ inputs.source_run_id }}');
    expect(rewrite.if).toBe(exchange.if);
    expect(validate).toBeDefined();
    expect(validate.id).toBe('validate-finalized-locale');
    expect(provenance.env.PROVENANCE_VALIDATE_OUTCOME)
      .toBe('${{ steps.validate-finalized-locale.outcome }}');
    expect(publishSteps.indexOf(classify)).toBeLessThan(publishSteps.indexOf(exchange));
    expect(publishSteps.indexOf(exchange)).toBeLessThan(publishSteps.indexOf(rewrite));
    expect(publishSteps.indexOf(rewrite)).toBeLessThan(publishSteps.indexOf(validate));
    expect(publishSteps.indexOf(validate)).toBeLessThan(publishSteps.indexOf(cdnGate));
  });

  it('rejects missing or unknown markers from a source that declares the new contract', () => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'locale-hreflang-contract-'));
    expect(() => validateLocaleSourceHreflangContract(tempDir!)).toThrow('missing hreflang-finalization-required.txt');

    writeFileSync(resolve(tempDir, HREFLANG_FINALIZATION_MARKER_FILE), `${HREFLANG_FINALIZATION_MARKER}\n`);
    expect(validateLocaleSourceHreflangContract(tempDir)).toBe('pending');

    writeFileSync(resolve(tempDir, HREFLANG_FINALIZATION_MARKER_FILE), 'unknown\n');
    expect(() => validateLocaleSourceHreflangContract(tempDir!)).toThrow('unsupported locale source hreflang marker');
  });
});
