import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import YAML from 'yaml';

/**
 * Guards for the parallel SEO audit-gate block in
 * .github/workflows/post-deploy-validate-dist.yml (gates were moved here from
 * deploy.yml in commit a2a7283f3c to avoid extending the critical deploy path)
 * and the tuned default flush concurrency in build-plugins/batchWrite.ts.
 *
 * These tests catch the most likely regression vectors:
 *   1) A new audit script is added to package.json but never wired into CI.
 *   2) A gate is moved out of the parallel block into a serial step (regressing
 *      validation time) without updating these assertions.
 *   3) The spawn_capped helper is replaced with serial execution.
 *   4) batchWrite default concurrency is downgraded below the tuned floor.
 */

const ROOT = resolve(import.meta.dirname, '..');
const VALIDATION_YML = readFileSync(resolve(ROOT, '.github/workflows/post-deploy-validate-dist.yml'), 'utf-8');
const DEPLOY_YML = readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf-8');
const POST_BUILD_MATRIX_YML = readFileSync(resolve(ROOT, '.github/workflows/post-build-matrix-test.yml'), 'utf-8');
const DEPLOY_REQUEST_YML = readFileSync(resolve(ROOT, '.github/workflows/deploy-request.yml'), 'utf-8');
const DEPLOY_PUBLISH_YML = readFileSync(resolve(ROOT, '.github/workflows/deploy-publish.yml'), 'utf-8');
const AUDIT_REPORT_YML = readFileSync(resolve(ROOT, '.github/workflows/audit-dist-from-run.yml'), 'utf-8');
const AUDIT_PUBLISHED_YML = readFileSync(resolve(ROOT, '.github/workflows/audit-published-dist.yml'), 'utf-8');
const AUDIT_FULL_YML = readFileSync(resolve(ROOT, '.github/workflows/audit-published-dist-full.yml'), 'utf-8');
const CRAWLER_CONTENT_AUDIT_YML = readFileSync(resolve(ROOT, '.github/workflows/crawler-content-plausibility-audit.yml'), 'utf-8');
const EXPIRED_ROUTE_AUDIT_YML = readFileSync(resolve(ROOT, '.github/workflows/backfill-expired-from-history.yml'), 'utf-8');
const AUDIT_SURFACE_YML = `${DEPLOY_YML}\n${VALIDATION_YML}\n${AUDIT_REPORT_YML}\n${AUDIT_PUBLISHED_YML}\n${AUDIT_FULL_YML}`;
const DEPLOY_PUBLISH_WORKFLOW = YAML.parse(DEPLOY_PUBLISH_YML) as any;
const POST_BUILD_MATRIX_WORKFLOW = YAML.parse(POST_BUILD_MATRIX_YML) as any;
const REPORT_AUDIT_NAMES = new Set<string>([
  ...String((YAML.parse(AUDIT_PUBLISHED_YML) as any).jobs?.report?.with?.audits ?? '')
    .split(/[\s,]+/).filter(Boolean),
  ...String((YAML.parse(AUDIT_PUBLISHED_YML) as any).jobs?.report?.with?.audit_all_audits ?? '')
    .split(/[\s,]+/).filter(Boolean).map((name) => `audit:${name}`),
  ...String((YAML.parse(AUDIT_FULL_YML) as any).jobs?.['full-audit']?.with?.audits ?? '')
    .split(/[\s,]+/).filter(Boolean),
  ...String((YAML.parse(AUDIT_FULL_YML) as any).jobs?.['full-audit']?.with?.audit_all_audits ?? '')
    .split(/[\s,]+/).filter(Boolean).map((name) => `audit:${name}`),
]);
// Every workflow that uploads dist/audit-reports/** as an artifact — the
// directory scripts/lib/auditReport.mjs writes to (discover-eligibility.json
// included). Since #6202 that report is written only 1-in-7 post-deploy
// runs, so an upload step over this path MUST tolerate a run where the
// directory is empty or absent (issue #6208 item 2).
const AUDIT_REPORTS_UPLOAD_WORKFLOWS = [
  '.github/workflows/post-deploy-validate-dist.yml',
  '.github/workflows/post-build-matrix-test.yml',
  '.github/workflows/cathedral-seo-gates-check.yml',
  '.github/workflows/audit-dist-from-run.yml',
  '.github/workflows/post-deploy-validate-live.yml',
] as const;
// Section rehydrate loop (rehydrate_section) lives here, extracted out of
// post-deploy-validate-dist.yml's inline copy + the 4 seed-baseline
// workflows' copies into one shared script (AGENTS.md #6 dedupe).
const REHYDRATE_SECTION_SCRIPT = readFileSync(resolve(ROOT, 'scripts/lib/rehydrate-section-shards.sh'), 'utf-8');
// Locale rehydrate loop (rehydrate_locale) — same dedupe, extracted out of
// post-deploy-validate-dist.yml's inline copy (issue #4828) into one shared
// script.
const REHYDRATE_LOCALE_SCRIPT = readFileSync(resolve(ROOT, 'scripts/lib/rehydrate-locale-shards.sh'), 'utf-8');
const PACKAGE_JSON = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const BATCH_WRITE = readFileSync(resolve(ROOT, 'build-plugins/batchWrite.ts'), 'utf-8');
const AUDIT_ALL_REGISTRY_SRC = readFileSync(resolve(ROOT, 'scripts/audit-all.mjs'), 'utf-8');
const BUILD_LOCALE_ENV = (YAML.parse(DEPLOY_YML) as any).jobs['build-locale'].env as Record<string, unknown>;

// Direct Pages-artifact extractors must release the source tar before shard
// rehydration. Keeping both copies is enough to exhaust the hosted runner.
const PAGES_ARTIFACT_EXTRACTION_WORKFLOWS = [
  '.github/workflows/audit-dist-from-run.yml',
  '.github/workflows/revalidate-dist-from-run.yml',
  '.github/workflows/matrix-equivalence-check.yml',
  '.github/workflows/seed-title-baselines.yml',
  '.github/workflows/seed-text-html-ratio-baseline.yml',
  '.github/workflows/seed-bfs-depth-baseline.yml',
  '.github/workflows/seed-orphan-pages-baseline.yml',
] as const;

// `audit:title-uniqueness` was moved to a separate weekly workflow because it
// OOM-killed the parallel block. All remaining gates must stay in parallel.
const AUDIT_SCRIPTS_IN_VALIDATION_SURFACE = [
  'audit:hreflang',
  'audit:content-duplicates',
  'audit:page-weight',
  'audit:text-html-ratio',
  'audit:h1-title-duplicates',
  'audit:title-length',
] as const;

/**
 * Parse the REGISTRY block of scripts/audit-all.mjs to extract the set of
 * audit names that the unified runner wraps. Each entry has the shape
 *   `{ factory: <ident>, name: '<audit-name>' }` — we match the `name: '…'`
 * literal so additions to the registry are automatically picked up.
 */
function parseAuditAllRegistry(src: string): Set<string> {
  const out = new Set<string>();
  const re = /\bname:\s*['"]([a-z][a-z0-9-]*)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) out.add(`audit:${m[1]}`);
  return out;
}

const AUDIT_ALL_WRAPS = parseAuditAllRegistry(AUDIT_ALL_REGISTRY_SRC);

/**
 * Returns true if the workflow invokes the audit either directly via
 * `npm run audit:<name>` OR transitively via `npm run audit:all` (when the
 * audit is registered in audit-all.mjs).
 */
function isInvokedDirectlyOrViaAuditAll(name: string): boolean {
  const directRe = new RegExp(`npm run ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  if (directRe.test(AUDIT_SURFACE_YML)) return true;
  if (REPORT_AUDIT_NAMES.has(name) && /script=\$\(resolve_script "\$n"\)/.test(AUDIT_REPORT_YML)) return true;
  return AUDIT_ALL_WRAPS.has(name) && /npm run audit:all\b/.test(AUDIT_SURFACE_YML);
}

describe('publisher integrity gate and asynchronous historical audits', () => {
  it('keeps post-build per-page profiling opt-in', () => {
    const inputs = POST_BUILD_MATRIX_WORKFLOW.on.workflow_dispatch.inputs;
    expect(inputs.profile_job_phases).toMatchObject({
      type: 'boolean',
      default: false,
    });

    const buildStep = POST_BUILD_MATRIX_WORKFLOW.jobs.build.steps.find((step: any) => step.name === 'Build');
    expect(String(buildStep.env.JOBS_SEO_PROFILE_PHASES)).toContain('profile_job_phases');
    expect(buildStep.env.JOBS_SEO_PROFILE_PHASES).not.toBe('1');
  });

  it('supports pinned locale-leg memory comparisons without publishing', () => {
    const inputs = POST_BUILD_MATRIX_WORKFLOW.on.workflow_dispatch.inputs;
    expect(inputs.build_locale).toMatchObject({
      type: 'choice',
      default: 'monolithic',
      options: ['monolithic', 'it', 'en', 'de', 'fr'],
    });
    expect(inputs.build_source_sha).toMatchObject({ type: 'string', default: '' });

    const checkout = POST_BUILD_MATRIX_WORKFLOW.jobs.build.steps.find(
      (step: any) => step.uses === 'actions/checkout@v7',
    );
    expect(checkout.with.ref).toContain('build_source_sha');

    const buildStep = POST_BUILD_MATRIX_WORKFLOW.jobs.build.steps.find(
      (step: any) => step.name === 'Build',
    );
    expect(String(buildStep.env.BUILD_LOCALE)).toContain('build_locale');

    const uploadStep = POST_BUILD_MATRIX_WORKFLOW.jobs.build.steps.find(
      (step: any) => step.name === 'Upload build output for shards',
    );
    expect(uploadStep.if).toContain("build_only != 'true'");
  });

  it('keeps the blocking publisher gate short and limited to provenance evidence', () => {
    const workflow = YAML.parse(VALIDATION_YML) as any;
    const job = workflow.jobs['fast-gate'];
    const gateStep = job.steps.find((step: any) => step.id === 'publisher-fast-gate');
    expect(job['timeout-minutes']).toBe(10);
    expect(job.steps[0].id).toBe('gate-clock');
    expect(gateStep.env.GATE_START_MS).toContain('steps.gate-clock.outputs.start_ms');
    expect(gateStep.run).toContain('publisherFastGateDurationMs');
    expect(gateStep.run).toContain('publisherFastGateBudgetMs: 300000');
    expect(gateStep.run).toContain('duration_ms=$gate_ms');
    expect(gateStep.run).toContain('build_skew_guard_run node scripts/ci/publisher-fast-gate.mjs');
    expect(VALIDATION_YML).toContain('Download publisher sitemap bundle');
    expect(VALIDATION_YML).toContain('Download source page manifests');
    expect(VALIDATION_YML).toContain('Download publisher section manifests');
    expect(VALIDATION_YML).not.toContain('rehydrate-locale-shards.sh');
    expect(VALIDATION_YML).not.toContain('npm run audit:all');
    expect(VALIDATION_YML).not.toContain('npm run validate:page-seo');
  });

  it('dispatches report audits with immutable publisher inputs and no publisher dependency edge', () => {
    const published = YAML.parse(AUDIT_PUBLISHED_YML) as any;
    const publisher = YAML.parse(DEPLOY_PUBLISH_YML) as any;
    const publishNeeds = publisher.jobs.publish.needs as string[];
    expect(published.on.workflow_dispatch.inputs).toMatchObject({
      deploy_run_id: { type: 'string' },
      shard_artifact_run_id: { type: 'string' },
      deploy_ref: { type: 'string' },
      audit_sample_salt: { type: 'string' },
    });
    expect(published.on.workflow_run).toBeUndefined();
    expect(published.jobs.report.uses).toBe('./.github/workflows/audit-dist-from-run.yml');
    expect(String(published.jobs.report.with.audits)).toContain('validate:page-seo');
    expect(String(published.jobs.report.with.audits)).toContain('validate:og-images');
    const dispatchStep = publisher.jobs.publish.steps.find(
      (step: any) => step.name === 'Dispatch published dist audit',
    );
    expect(dispatchStep.if).toContain("needs.publish.result == 'success'");
    expect(dispatchStep.run).toContain('audit-published-dist.yml');
    expect(dispatchStep.run).toContain('-f deploy_run_id="$PUBLISHER_SOURCE_RUN_ID"');
    expect(dispatchStep.run).toContain('-f shard_artifact_run_id="$PUBLISHER_RUN_ID"');
    expect(publisher.jobs['audit-dist-report']).toBeUndefined();
    expect(publishNeeds).not.toContain('audit-dist-report');
    expect(publishNeeds).toContain('validate-dist');
    expect(String(publisher.jobs.publish.if)).toContain("needs.validate-dist.outputs.integrity_ok == 'true'");
  });

  it('uses manifest-indexed receipts and supports explicit full scans', () => {
    const workflow = YAML.parse(AUDIT_REPORT_YML) as any;
    expect(workflow.on.workflow_call.inputs.full_scan.type).toBe('boolean');
    expect(workflow.on.workflow_call.inputs.it_shard_artifact_run_id).toBeTruthy();
    const steps = workflow.jobs.audit.steps;
    const indexValidatorCheckout = steps.find((step: any) => step.name === 'Checkout current publisher index validator');
    expect(indexValidatorCheckout.uses).toBe('actions/checkout@v7');
    expect(indexValidatorCheckout.with.ref).toBe('refs/heads/main');
    expect(indexValidatorCheckout.with['sparse-checkout']).toContain('/scripts/ci/page-audit-index.mjs');
    expect(steps.some((step: any) => step.name === 'Download source page manifests')).toBe(true);
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const upperLocale = locale.toUpperCase();
      const step = steps.find((candidate: any) => candidate.name === `Download publisher ${upperLocale} section manifests`);
      expect(step, `missing ${locale} publisher section manifest download`).toMatchObject({
        'continue-on-error': true,
        uses: 'actions/download-artifact@v8',
        with: {
          pattern: `section-page-manifest-${locale}-*`,
          path: '${{ runner.temp }}/publisher-audit-manifests/sections',
          'run-id': locale === 'it'
            ? '${{ inputs.it_shard_artifact_run_id || inputs.shard_artifact_run_id || env.SHARD_ARTIFACT_RUN_ID_IT }}'
            : '${{ inputs.shard_artifact_run_id || env.SHARD_ARTIFACT_RUN_ID_' + upperLocale + ' }}',
          'merge-multiple': true,
        },
      });
      expect(step.if).toContain(`env.SHARD_ARTIFACT_RUN_ID_${upperLocale}`);
    }
    const indexDetector = steps.find((step: any) => step.id === 'publisher-index');
    expect(indexDetector.name).toContain('complete');
    expect(indexDetector.run).toContain('current-index-validator/scripts/ci/page-audit-index.mjs');
    expect(indexDetector.env.SECTION_MANIFEST_DIR).toContain('publisher-audit-manifests/sections');
    expect(indexDetector.run).toContain('full audit path');
    expect(steps.some((step: any) => step.uses === 'actions/cache/restore@v6')).toBe(true);
    expect(steps.some((step: any) => step.uses === 'actions/cache/save@v6')).toBe(true);
    const auditStep = steps.find((step: any) => step.id === 'audits');
    expect(auditStep.env.AUDIT_FORCE_FULL).toContain('inputs.full_scan');
    expect(auditStep.env.PUBLISHER_PAGE_MANIFEST_DIR).toContain('publisher-audit-manifests/pages');
    expect(auditStep.env.PUBLISHER_AUDIT_RECEIPT_DIR).toContain('publisher-audit-receipts');
  });

  it('uses bounded parallelism only after source-only images are pruned', () => {
    const workflow = YAML.parse(AUDIT_REPORT_YML) as any;
    const rehydrateStep = workflow.jobs.audit.steps.find((step: any) => (
      step.name === 'Rehydrate locale then section shards into dist/ (when sharding active)'
    ));

    expect(rehydrateStep?.env?.REHYDRATE_MAX_PARALLEL)
      .toBe("${{ inputs.prune_source_images && '2' || '1' }}");
  });

  it('pins the selected source or publisher run so the shared action validates publication identity', () => {
    const workflow = YAML.parse(AUDIT_REPORT_YML) as any;
    const fetchPages = workflow.jobs.audit.steps.find((step: any) => step.name === 'Fetch the deployed dist (github-pages artifact)');
    expect(fetchPages.with['run-id']).toBe('${{ inputs.shard_artifact_run_id || inputs.deploy_run_id }}');
    expect(fetchPages.with['run-id']).not.toContain('SHARD_ARTIFACT_RUN_ID_IT');
    const rehydrate = workflow.jobs.audit.steps.find((step: any) => (
      step.name === 'Rehydrate locale then section shards into dist/ (when sharding active)'
    ));
    expect(rehydrate.env.SHARD_ARTIFACT_RUN_ID_IT).toContain('inputs.it_shard_artifact_run_id');
  });

  it('prunes only the source-only image tree for the opted-in weekly full replay', () => {
    const workflow = YAML.parse(AUDIT_REPORT_YML) as any;
    const full = YAML.parse(AUDIT_FULL_YML) as any;
    const published = YAML.parse(AUDIT_PUBLISHED_YML) as any;
    const steps = workflow.jobs.audit.steps;
    const pruneIndex = steps.findIndex((step: any) => (
      step.name === 'Prune source-only images before full dist rehydrate'
    ));
    const freeIndex = steps.findIndex((step: any) => step.name === 'Free disk space on runner');
    const rehydrateIndex = steps.findIndex((step: any) => (
      step.name === 'Rehydrate locale then section shards into dist/ (when sharding active)'
    ));
    const prune = steps[pruneIndex];

    expect(workflow.on.workflow_dispatch.inputs.prune_source_images).toMatchObject({
      default: false,
      type: 'boolean',
    });
    expect(workflow.on.workflow_call.inputs.prune_source_images).toMatchObject({
      default: false,
      type: 'boolean',
    });
    expect(prune?.if).toBe('${{ inputs.prune_source_images }}');
    expect(prune?.run).toContain('rm -rf -- public/images');
    expect(prune?.run).toContain('df -i /');
    expect(pruneIndex).toBeGreaterThan(-1);
    expect(pruneIndex).toBeLessThan(freeIndex);
    expect(pruneIndex).toBeLessThan(rehydrateIndex);
    expect(full.jobs['full-audit'].with.prune_source_images).toBe(true);
    expect(steps[rehydrateIndex]?.env?.REHYDRATE_MAX_PARALLEL)
      .toBe("${{ inputs.prune_source_images && '2' || '1' }}");
    expect(published.jobs.report.with.prune_source_images).not.toBe(true);
  });

  it('reconciles sitemap membership after shard rehydration and before final-dist audits', () => {
    const workflow = YAML.parse(AUDIT_REPORT_YML) as any;
    const steps = workflow.jobs.audit.steps;
    const provenanceIndex = steps.findIndex((step: any) => step.name === 'Verify replay shard provenance after rehydrate');
    const reconcileIndex = steps.findIndex((step: any) => step.id === 'reconcile_rehydrated_sitemaps');
    const completeIndex = steps.findIndex((step: any) => step.name === 'Assert dist/ is the complete logical site');
    const auditIndex = steps.findIndex((step: any) => step.id === 'audits');

    expect(PACKAGE_JSON.scripts['validate:rehydrated-sitemaps'])
      .toBe('npx tsx scripts/ci/reconcile-rehydrated-sitemaps.ts');
    expect(reconcileIndex).toBeGreaterThan(provenanceIndex);
    expect(reconcileIndex).toBeLessThan(completeIndex);
    expect(auditIndex).toBeGreaterThan(completeIndex);
    expect(steps[reconcileIndex]?.run).toBe('npm run validate:rehydrated-sitemaps');
    expect(steps[reconcileIndex]?.['continue-on-error']).not.toBe(true);
  });

  it('schedules a periodic full audit outside the publisher workflow', () => {
    const workflow = YAML.parse(AUDIT_FULL_YML) as any;
    expect(workflow.on.schedule).toHaveLength(1);
    expect(workflow.jobs.cadence.outputs.due).toContain('steps.cadence.outputs.due');
    expect(workflow.jobs.cadence.steps[0].run).toContain('604800');
    expect(workflow.jobs['full-audit'].with.full_scan).toBe(true);
    expect(workflow.jobs['full-audit'].with.audit_sample_rate).toBe('1');
  });

  it('keeps every artifact required by the weekly full audit for its full retention window', () => {
    const retentionDays = 8;
    const runId = '${{ github.run_id }}';
    const matrixLocale = '${{ matrix.locale }}';
    const sourceSteps = (YAML.parse(DEPLOY_YML) as any).jobs['build-locale'].steps;
    const itPublisherSteps = (YAML.parse(DEPLOY_PUBLISH_YML) as any).jobs['finalize-it-publish'].steps;
    const publisherSteps = (YAML.parse(DEPLOY_PUBLISH_YML) as any).jobs['publish-nonit-shards'].steps;
    const upload = (steps: any[], name: string) => {
      const matches = steps.filter((step) => step?.uses === 'actions/upload-artifact@v7' && step?.with?.name === name);
      expect(matches, `missing unique upload step for ${name}`).toHaveLength(1);
      return matches[0];
    };
    const assertRetention = (steps: any[], names: string[]) => {
      for (const name of names) {
        expect(Number(upload(steps, name).with['retention-days']), `${name} must survive the weekly replay window`)
          .toBeGreaterThanOrEqual(retentionDays);
      }
    };

    assertRetention(sourceSteps, [
      `jobs-master-${runId}`,
      `sitemap-page-manifest-${matrixLocale}-${runId}`,
    ]);
    assertRetention(itPublisherSteps, [
      'github-pages',
      `sitemaps-${runId}`,
      `sitemap-page-manifest-it-${runId}`,
      `section-page-manifest-it-${runId}`,
      ...Array.from({ length: 6 }, (_, index) => `shard-batch-${index + 1}-dist-it-${runId}`),
    ]);
    assertRetention(publisherSteps, [
      `locale-dist-${matrixLocale}-${runId}`,
      `section-page-manifest-${matrixLocale}-${runId}`,
      ...Array.from({ length: 6 }, (_, index) => `shard-batch-${index + 1}-dist-${matrixLocale}-${runId}`),
    ]);
  });

  it('keeps the publisher selector fail-closed when any source or shard artifact is absent', () => {
    const workflow = YAML.parse(AUDIT_FULL_YML) as any;
    const selector = workflow.jobs['source-identity'].steps.find((step: any) => step.id === 'identity').run as string;

    expect(selector).toContain('select(.expired == false)');
    expect(selector).toContain('actions/runs/$publisher_id/jobs?per_page=100');
    expect(selector).toContain('select(.name == "deploy")');
    expect(selector).toContain('publisher_deploy_conclusion');
    expect(selector).toContain('[ "$publisher_deploy_conclusion" != \'success\' ]');
    expect(selector).toContain('source_complete=true');
    expect(selector).toContain('publisher_complete=true');
    expect(selector).toContain('source_it_complete=true');
    expect(selector).toContain('publisher_it_complete=true');
    expect(selector).toContain('has_name "$source_names" "$name" || source_it_complete=false');
    expect(selector).toContain('has_name "$publisher_names" "$name" || publisher_it_complete=false');
    expect(selector).toContain('it_shard_artifact_run_id');
    expect(selector).toContain('"sitemaps-$source_id"');
    expect(selector).toContain('"sitemaps-$publisher_id"');
    expect(selector).toContain('has_name "$publisher_names" "locale-dist-$locale-$publisher_id" || publisher_complete=false');
    expect(selector).toContain('has_name "$publisher_names" "section-page-manifest-$locale-$publisher_id" || publisher_complete=false');
    expect(selector).toContain('if [ "$source_complete" != true ] || [ "$publisher_complete" != true ]; then');
    expect(selector).toContain('No publisher run with a successful deploy job has a complete, unexpired source and shard artifact set.');
    expect(selector).toMatch(/echo '::error::No publisher run with a successful deploy job[\s\S]*?exit 1/);
  });

  it('records French tail step outcomes and distinguishes an unattributed job failure', () => {
    const workflow = YAML.parse(DEPLOY_PUBLISH_YML) as any;
    const steps = workflow.jobs['publish-nonit-shards'].steps;
    const diagnostic = steps.find((step: any) => step.name === 'Diagnose French tail outcomes');
    expect(diagnostic.if).toContain('always()');
    expect(diagnostic.env.CDN_WAIT_RESULT).toContain('steps.cdn-gate.outputs.cdn_wait_result');
    expect(diagnostic.env.TAIL_BUDGET_OUTCOME).toContain('steps.tail-budget.outcome');
    expect(diagnostic.run).toContain('Unattributed failure: job failed but no recorded tail step reports failure.');
  });

  it('runs source SEO tests once in the build workflow', () => {
    const invocations = DEPLOY_YML.match(/npm run gate:seo-source/g) ?? [];
    expect(invocations).toHaveLength(1);
    expect(VALIDATION_YML).not.toContain('gate:seo-source');
  });

  it('every audit is reachable from the validation/report surface (directly or via audit:all)', () => {
    for (const name of AUDIT_SCRIPTS_IN_VALIDATION_SURFACE) {
      expect(isInvokedDirectlyOrViaAuditAll(name), `${name} is not reachable from an async audit workflow`).toBe(true);
    }
  });

  it('every audit script added to package.json is reachable or has a declared manual/weekly owner', () => {
    const manualOrSeparateWorkflow = new Set([
      'audit:active-jobs-regression', 'audit:job-locations', 'audit:slug-prompt-leaks',
      'audit:all', 'audit:sitemap-canonicals', 'audit:title-uniqueness',
      'audit:no-merge-markers', 'audit:parser-quality', 'audit:job-content-plausibility',
      'audit:expired-at-parsable',
    ]);
    const scripts = PACKAGE_JSON.scripts || {};
    for (const name of Object.keys(scripts).filter((key) => key.startsWith('audit:') && !key.endsWith(':rebaseline'))) {
      if (manualOrSeparateWorkflow.has(name) || name.startsWith('audit:dist-multi')) continue;
      expect(isInvokedDirectlyOrViaAuditAll(name), `${name} is not reachable from an audit workflow`).toBe(true);
    }
    expect(CRAWLER_CONTENT_AUDIT_YML).toContain('node scripts/audit-job-content-plausibility.mjs');
    expect(EXPIRED_ROUTE_AUDIT_YML).toContain('node scripts/audit-expired-at-parsable.mjs');
  });

  it('source sitemap page validation remains attached to build output', () => {
    expect(DEPLOY_YML).toContain('node scripts/validate-sitemap-links.mjs');
    expect(DEPLOY_YML).toContain('npm run audit:no-dotfile-html');

    const workflow = YAML.parse(DEPLOY_YML) as any;
    const steps = workflow.jobs['build-locale']?.steps ?? [];
    const dotfileGate = steps.find((step: any) => step.name === 'Reject generated HTML under dotfile paths');
    const dotfileIndex = steps.findIndex((step: any) => step.name === 'Reject generated HTML under dotfile paths');
    const localeArtifactIndex = steps.findIndex((step: any) => step.name === 'Upload non-IT locale shard source artifact');
    const itSourceIndex = steps.findIndex((step: any) => step.name === 'Package IT publication source artifacts');
    expect(dotfileGate).toBeDefined();
    expect(dotfileGate.if).toBeUndefined();
    expect(dotfileIndex).toBeLessThan(localeArtifactIndex);
    expect(dotfileIndex).toBeLessThan(itSourceIndex);

    const itSchemaGate = steps.find((step: any) => step.name === 'Validate IT JobPosting schema before artifact upload');
    const itSchemaIndex = steps.findIndex((step: any) => step.name === 'Validate IT JobPosting schema before artifact upload');
    expect(itSchemaGate?.if).toContain("matrix.locale == 'it'");
    expect(itSchemaGate?.run).toContain('npm run validate:jobposting-schema');
    expect(itSchemaIndex).toBeLessThan(itSourceIndex);
    const publisherSteps = DEPLOY_PUBLISH_WORKFLOW.jobs['finalize-it-publish'].steps;
    expect(publisherSteps.some((step: any) => step.name === 'Upload Pages artifact (compression-level 9)')).toBe(true);
  });

  it('blocks non-IT shard publication on the complete locale JobPosting schema', () => {
    const job = DEPLOY_PUBLISH_WORKFLOW.jobs['publish-nonit-shards'];
    const steps = job.steps ?? [];
    const schemaIndex = steps.findIndex((step: any) => step.name === 'Validate non-IT JobPosting schema before shard publication');
    const sectionPushIndex = steps.findIndex((step: any) => step.name === 'Push section shards (non-IT → frontaliere-<section>-<loc>)');
    const localePushIndex = steps.findIndex((step: any) => step.name === 'Push locale shard');
    const schemaStep = steps[schemaIndex];

    expect(schemaIndex).toBeGreaterThan(-1);
    expect(schemaIndex).toBeLessThan(sectionPushIndex);
    expect(schemaIndex).toBeLessThan(localePushIndex);
    expect(schemaStep.if).toContain("env.DURABLE_LOCALE_PUBLISHED != 'true'");
    expect(schemaStep.run).toContain('npm run validate:jobposting-schema');
    expect(schemaStep['continue-on-error']).not.toBe(true);
  });
});

describe('Pages artifact extraction disk lifetime', () => {
  it('removes the source tar in every direct extractor before shard rehydration', () => {
    for (const workflowPath of PAGES_ARTIFACT_EXTRACTION_WORKFLOWS) {
      const workflow = YAML.parse(readFileSync(resolve(ROOT, workflowPath), 'utf-8')) as any;
      const extractionSteps = Object.values(workflow.jobs ?? {}).flatMap((job: any) => (
        Array.isArray(job?.steps)
          ? job.steps.filter((step: any) => (
            typeof step?.run === 'string'
            && /\btar -xf\b/.test(step.run)
            && /(artifact\.tar|TAR_PATH|tar-path)/.test(step.run)
          ))
          : []
      ));

      expect(extractionSteps, `${workflowPath} must have one direct Pages-artifact extractor`).toHaveLength(1);
      const run = (extractionSteps[0] as any).run as string;
      const extractIndex = run.indexOf('tar -xf');
      const cleanupIndex = run.indexOf('rm -f', extractIndex);
      expect(cleanupIndex, `${workflowPath} must remove the source tar after extraction`).toBeGreaterThan(extractIndex);
      expect(run.slice(cleanupIndex, cleanupIndex + 160)).toMatch(/(artifact\.tar|TAR_PATH|tar-path)/);
    }
  });

  // deploy-publish run 36810296662 and cathedral-seo-gates-check run
  // 36810296254 (2026-10-01) died with "No space left on device" inside the
  // rehydrate: the logical dist now ends at 134 of the runner's 145 GB. The
  // disk cleanup that keeps it inside existed in nine inline copies that had
  // drifted (cathedral's had 6 paths and no docker prune, the others 9), so
  // the class is "a job that rehydrates the logical dist without THE cleanup".
  // Every such job — found by what it runs, not by a hand-kept list — must call
  // the one shared script after its checkout and before the rehydrate.
  it('every job that rehydrates section shards frees disk through the one shared script first', () => {
    const workflowsDir = resolve(ROOT, '.github/workflows');
    const rehydrating: string[] = [];
    for (const file of readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
      const workflow = YAML.parse(readFileSync(resolve(workflowsDir, file), 'utf-8')) as any;
      for (const [jobName, job] of Object.entries<any>(workflow?.jobs ?? {})) {
        const steps: any[] = Array.isArray(job?.steps) ? job.steps : [];
        const runOf = (step: any) => (typeof step?.run === 'string' ? step.run : '');
        const rehydrateIdx = steps.findIndex((step) => /rehydrate-section-shards\.sh/.test(runOf(step)));
        if (rehydrateIdx === -1) continue;
        const where = `${file} → ${jobName}`;
        rehydrating.push(where);
        const cleanupIdx = steps.findIndex((step) => /(^|\s)bash (tooling\/)?scripts\/ci\/free-runner-disk\.sh\b/.test(runOf(step)));
        const checkoutIdx = steps.findIndex((step) => /^actions\/checkout@/.test(String(step?.uses ?? '')));
        expect(cleanupIdx, `${where}: no step runs scripts/ci/free-runner-disk.sh`).toBeGreaterThan(-1);
        expect(cleanupIdx, `${where}: the cleanup must run before the rehydrate`).toBeLessThan(rehydrateIdx);
        expect(cleanupIdx, `${where}: the cleanup script lives in the repo, so it runs after a checkout`).toBeGreaterThan(checkoutIdx);
        // A second, inline list next to the shared one is how the copies drifted.
        for (const step of steps) {
          expect(runOf(step), `${where}: inline toolchain cleanup — use the shared script`).not.toMatch(/rm -rf[^\n]*\/usr\/share\/dotnet/);
        }
      }
    }
    // The two reds of 2026-10-01 plus the replays that rebuild the same dist.
    expect(rehydrating).toEqual(expect.arrayContaining([
      'cathedral-seo-gates-check.yml → check',
      'audit-dist-from-run.yml → audit',
    ]));
    expect(rehydrating.length).toBeGreaterThanOrEqual(8);
  });

  it('the shared cleanup reports blocks AND inodes before and after, and keeps node in the tool cache', () => {
    const script = readFileSync(resolve(ROOT, 'scripts/ci/free-runner-disk.sh'), 'utf-8');
    const live = script.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    // One directory per job page: inode exhaustion reads exactly like a full
    // disk ("No space left on device"), so both counters are printed.
    expect(live).toMatch(/report\(\) \{\s*df -h \/\s*df -i \/\s*\}/);
    expect(live.match(/^report$/gm)?.length, 'df before AND after the cleanup').toBe(2);
    // setup-node reuses /opt/hostedtoolcache/node; deleting it would only
    // force a re-download, never free the space the rehydrate needs.
    expect(live).toContain('[ "$(basename "$p")" = node ] && continue');
    // Best-effort like the inline copies it replaced: an image refresh that
    // already dropped a path must not fail the job.
    expect(live).not.toMatch(/^\s*set\s+-\S*e\S*\b/m);
    expect(live.trimEnd().endsWith('exit 0')).toBe(true);
  });
});

/**
 * Guard for issue #6208 item 2: `audit:discover-eligibility` and
 * `seo/meta-description-audit` are report-only (rc=0 cabled) and, since
 * #6202, run at a 1-in-7 cadence — so `dist/audit-reports/discover-
 * eligibility.json` is absent on 6 of every 7 post-deploy runs. Every
 * `upload-artifact` step whose `path:` includes `dist/audit-reports/**` must
 * therefore tolerate a missing/empty directory (`if-no-files-found: ignore`
 * or `warn`), never `error` — an `error` setting would fail the job on the
 * 6-in-7 skipped runs for a "problem" that isn't one.
 */
function extractUploadArtifactSteps(yml: string): string[] {
  const stepStarts: number[] = [];
  const re = /\n( {2,10})- name:/g;
  let m;
  while ((m = re.exec(yml)) !== null) stepStarts.push(m.index + 1);
  stepStarts.push(yml.length);
  const steps: string[] = [];
  for (let i = 0; i < stepStarts.length - 1; i++) steps.push(yml.slice(stepStarts[i], stepStarts[i + 1]));
  return steps.filter((s) => /uses:\s*actions\/upload-artifact@/.test(s));
}

describe('dist/audit-reports/** artifact uploads tolerate the report-only 1-in-7 cadence (#6208)', () => {
  it('every upload-artifact step over dist/audit-reports/** sets if-no-files-found to ignore or warn, never error', () => {
    let matchingStepsFound = 0;
    for (const relPath of AUDIT_REPORTS_UPLOAD_WORKFLOWS) {
      const yml = readFileSync(resolve(ROOT, relPath), 'utf-8');
      const steps = extractUploadArtifactSteps(yml).filter((s) => /dist\/audit-reports/.test(s));
      for (const step of steps) {
        matchingStepsFound++;
        const nameMatch = step.match(/- name:\s*(.+)/);
        const stepName = nameMatch ? nameMatch[1].trim() : '(unnamed step)';
        const valueMatch = step.match(/if-no-files-found:\s*(\S+)/);
        // Field absent → GitHub defaults to `warn`, which is also safe.
        const value = valueMatch ? valueMatch[1] : 'warn';
        expect(
          value,
          `${relPath} — "${stepName}": if-no-files-found="${value}" would fail the job on the ` +
          `6-in-7 runs where the report-only cadence (#6202) skips writing dist/audit-reports/. ` +
          `Use "ignore" or "warn".`,
        ).not.toBe('error');
      }
    }
    expect(matchingStepsFound, 'expected at least one dist/audit-reports/** upload step across the checked workflows').toBeGreaterThan(0);
  });
});

describe('build-plugins/batchWrite.ts — flush concurrency', () => {
  it('default flush concurrency is tuned for CI SSD (≥ 500, ≤ 1024)', () => {
    // Catches accidental regressions like "concurrency = 200" sneaking back in.
    // Cap at ~1024 to avoid macOS launchd ulimit -n 256/1024 contention.
    const matches = BATCH_WRITE.match(/concurrency\s*=\s*(\d+)/g) || [];
    expect(matches.length, 'expected default-concurrency literals').toBeGreaterThan(0);
    for (const m of matches) {
      const n = Number(m.match(/(\d+)/)![1]);
      expect(n, `default concurrency literal "${m}" below tuned floor`).toBeGreaterThanOrEqual(500);
      expect(n, `default concurrency literal "${m}" above safe ceiling`).toBeLessThanOrEqual(1024);
    }
  });
});

/**
 * Guards for issue #2761 (follow-up of PR #2758's tar-pack rehydrate fast
 * path): the tar artifact fast path must not silently validate a
 * partial/corrupt shard with no fallback.
 *
 *   1) Producer side (deploy.yml): each "Pack ... shard dist (tar)" step
 *      must self-verify the tar's file count against the source directory
 *      it was packed from, so a future refactor that lets the two paths
 *      drift (or a tar bug) is caught instead of silently uploading a
 *      mismatched artifact.
 *   2) Consumer side (post-deploy-validate-dist.yml): after `tar xf ...`,
 *      the rehydrate loops must check EXTRACTION COMPLETENESS (tar's own
 *      listing count vs what actually landed on disk), not just
 *      `[ -d dist/$loc ]` existence — a truncated/corrupted tar can still
 *      create a partially-populated directory that passes a bare
 *      existence check with no fallback to the safe git-clone path.
 */
describe('deploy.yml + audit-dist-from-run.yml — tar-pack rehydrate fast path (#2761)', () => {
  it('every "Pack ... shard dist (tar)" step in deploy.yml self-verifies packed vs source file count', () => {
    const packSteps = `${DEPLOY_YML}\n${DEPLOY_PUBLISH_YML}`.match(/- name: Pack [^\n]*shard dist \(tar\)[^\n]*\n(?:.*\n)*?(?=\n {6}- name:|\n {4}- name:)/g) || [];
    expect(packSteps.length, 'expected the two deferred non-IT tail pack steps; IT validation tars are produced after successful IT pushes').toBeGreaterThanOrEqual(2);
    for (const step of packSteps) {
      expect(step, `pack step missing tar -cvf output count:\n${step}`).toMatch(/if ! packed_n=\$\(tar -C [^\n]* -cvf [^\n]*\| awk '!\/\\\/\$\/ \{ n\+\+ \} END \{ print n \+ 0 \}'\); then[\s\S]*rm -f "\$RUNNER_TEMP\/[^\"]+\.tar"[\s\S]*(?:return|exit) 0/);
      expect(step, `pack step missing packed-vs-source file count comparison:\n${step}`).toMatch(/if \[ "\$packed_n" -ne "\$(?:live_src_n|src_n)" \]/);
      expect(step, `pack step must discard a mismatched tar (rm -f), not upload it:\n${step}`).toMatch(/rm -f "\$RUNNER_TEMP\/[^"]*\.tar"/);
    }
  });

  it('locale + section (Ticino/Svizzera/Zurigo) rehydrate loops check tar-extraction completeness, not just directory existence', () => {
    // The old (insufficient) guard was a bare existence check right after
    // `tar -C dist -xf ... || true`. Both loops must now compute an
    // `expected_n` from the tar's own listing BEFORE relying on the
    // extracted directory, and gate the "accept this tar" branch on
    // `actual_n` meeting `expected_n` — not merely on the directory existing.
    // Match EXACT, not "at least" (issue #6260): a tar that is itself
    // truncated stops `tar -tf`'s listing early, so `expected_n` undercounts
    // and `-ge` read the short extraction as complete. `-eq` is the only
    // comparison that catches drift in either direction, and this suite is
    // the THIRD place that pins the same line — the two per-script suites
    // are the other two — so it has to move with them or it pins the form
    // the fix just removed.
    // The section loop's tar filename is `$section-dist-$loc.tar` (a shell
    // variable, not a literal per-section name) since rehydrate_section()
    // covers ticino/svizzera/zurigo through the same code path.
    // locale rehydrate was extracted into scripts/lib/rehydrate-locale-shards.sh
    // and section rehydrate into scripts/lib/rehydrate-section-shards.sh
    // (section shared with the 4 seed-baseline workflows too, AGENTS.md #6
    // dedupe) — the guarded invariant is unchanged, only its file moved.
    expect(REHYDRATE_LOCALE_SCRIPT).toContain('"repos/$repo/actions/runs/$artifact_run_id/artifacts?name=$artifact_name&per_page=100"');
    expect(REHYDRATE_LOCALE_SCRIPT).toContain('"repos/$repo/actions/artifacts/$artifact_id/zip"');
    expect(REHYDRATE_LOCALE_SCRIPT).toContain('expected_n="$(unzip -p "$dl/$locale_zip" "$locale_member"');
    expect(REHYDRATE_LOCALE_SCRIPT).toContain('unzip -p "$dl/$locale_zip" "$locale_member" | tar -C dist -xf -');
    expect(REHYDRATE_LOCALE_SCRIPT).toContain('"${unzip_rc:-2}" -eq 0');
    expect(REHYDRATE_LOCALE_SCRIPT).toContain('"${tar_rc:-2}" -eq 0');
    const localeLiveCode = REHYDRATE_LOCALE_SCRIPT
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(localeLiveCode).not.toContain('gh run download');
    expect(REHYDRATE_LOCALE_SCRIPT, 'locale rehydrate loop missing completeness gate (expected_n/actual_n)').toMatch(
      /if \[ "\$\{unzip_rc:-2\}" -eq 0 \][\s\S]*?\[ "\$actual_n" -eq "\$expected_n" \]/,
    );
    // The section loop no longer has a tar FILE (2026-10-01, deploy-publish
    // run 36810296662 out of disk): both passes stream `$section-dist-$loc.tar`
    // out of the batch zip. Same gate — listing first, exact count after —
    // plus unzip's CRC verdict, which the two passes cannot replace: a corrupt
    // stream is listed and extracted identically, so only the CRC tells.
    const sectionRe = new RegExp(
      `member="\\$section-dist-\\$loc\\.tar"[\\s\\S]*?` +
      `expected_n=\\$\\(unzip -p "\\$dl/\\$BATCH_ZIP" "\\$member" 2>/dev/null \\| tar -tf - 2>/dev/null \\| \\{ grep -vc '/\\$' \\|\\| true; \\}\\)[\\s\\S]*?` +
      `unzip -p "\\$dl/\\$BATCH_ZIP" "\\$member" \\| tar -C dist -xf -\\n[\\s\\S]*?` +
      `unzip_rc="\\$\\{PIPESTATUS\\[0\\]\\}"[\\s\\S]*?` +
      `if \\[ "\\\$\\{unzip_rc:-2\\}" -eq 0 \\] && \\[ -d "dist/\\$sub" \\] && \\[ "\\\$\\{expected_n:-0\\}" -gt 0 \\] && \\[ "\\$actual_n" -eq "\\$expected_n" \\]`,
    );
    expect(REHYDRATE_SECTION_SCRIPT, 'section rehydrate loop missing completeness gate (expected_n/actual_n/unzip_rc)').toMatch(sectionRe);
    // The bare `if [ -d dist/$loc ]; then ... continue; fi` (no count check)
    // pattern from before the fix must not remain anywhere in the tar
    // extraction branches, in either file.
    for (const { text, name } of [
      { text: REHYDRATE_LOCALE_SCRIPT, name: 'rehydrate-locale-shards.sh' },
      { text: REHYDRATE_SECTION_SCRIPT, name: 'rehydrate-section-shards.sh' },
    ]) {
      expect(
        text,
        `${name}: a bare directory-existence-only accept branch survived post-tar-extract (regression of #2761 item 2)`,
      ).not.toMatch(/\|\| true\n\s*rm -rf "\$dl"\n\s*if \[ -d "dist\/\$(?:loc|sub)" \]; then\n\s*echo "rehydrated/);
    }
  });
});

describe('deploy.yml — wall-time delle fasi post-build nella storia committata (#7301)', () => {
  // La storia in data/build-history/memory-peaks.jsonl portava un solo campo
  // temporale, `wall_seconds`, alimentato dallo step `Build`: le fasi
  // post-build del leg (push degli shard di sezione, pack tar) — 23 min + 5
  // min dei 130 min totali del leg IT sul run 33833300860 — non lasciavano
  // traccia, e l'unica fonte restava l'API Actions run-per-run, soggetta a
  // retention e ai run cancellati.
  //
  // Questi test valgono sullo SCHEMA DELLO STEP, non sulle righe storiche: le
  // 294 righe gia' committate non avranno mai le chiavi nuove.
  const BUILD_LOCALE_STEPS: Array<Record<string, any>> =
    (YAML.parse(DEPLOY_YML) as any).jobs['build-locale'].steps;
  const NONIT_TAIL_STEPS: Array<Record<string, any>> =
    (YAML.parse(DEPLOY_PUBLISH_YML) as any).jobs['publish-nonit-shards'].steps;
  const IT_TAIL_STEPS: Array<Record<string, any>> =
    (YAML.parse(DEPLOY_PUBLISH_YML) as any).jobs['push-it-shard-groups'].steps;
  const ALL_PHASE_STEPS = [...BUILD_LOCALE_STEPS, ...IT_TAIL_STEPS, ...NONIT_TAIL_STEPS];
  const stepById = (id: string) => {
    const step = ALL_PHASE_STEPS.find((s) => s.id === id);
    expect(step, `nessuno step con id "${id}" nei workflow build/deferred-tail`).toBeDefined();
    return step!;
  };
  // Tutte le fasi post-build del job, non solo le due nominate dalla issue:
  // e' la stessa classe di buco (fase lunga, nessun wall-time committato) e
  // lasciarne meta' strumentata la riapre al primo che tocca lo step gemello.
  const PHASE_STEP_IDS = [
    'push-section-shards-nonit',
    'pack-section-shards-nonit',
    'push-shard',
    'pack-locale-shard',
  ];

  it.each(PHASE_STEP_IDS)('lo step "%s" emette wall_seconds su ogni uscita', (id) => {
    const run: string = stepById(id).run;
    // Trap EXIT, non un echo prima dell'`exit` finale: gli step di push hanno
    // anche un'uscita fatale sull'ordering, e la fase serve misurata proprio
    // quando e' andata storta.
    expect(run, `step "${id}": la fase non emette il proprio wall-time`).toMatch(
      /trap 'echo "wall_seconds=\$SECONDS" >> "\$GITHUB_OUTPUT"' EXIT/,
    );
  });

  it('lo step di append delle fasi propaga gli output di TUTTI e quattro gli step di fase', () => {
    const step = BUILD_LOCALE_STEPS.find((s) => s.name === 'Append post-build phase timings row');
    expect(step, 'deploy.yml: manca lo step "Append post-build phase timings row"').toBeDefined();
    const env: Record<string, string> = step!.env ?? {};
    // Ogni step di fase dev'essere cablato: senza, la sua colonna resta a null
    // per sempre e il buco e' invisibile (lo step ha continue-on-error).
    for (const id of ['pack-locale-source']) {
      expect(
        Object.values(env),
        `"Append post-build phase timings row": nessuna env legge steps.${id}.outputs.wall_seconds`,
      ).toContainEqual(expect.stringContaining(`steps.${id}.outputs.wall_seconds`));
    }
    // if: always() — una fase lenta e' spesso quella di un leg finito rosso.
    expect(step!.if, 'lo step di append deve girare anche sui leg falliti').toBe('always()');
    // Le chiavi che la riga deve portare: sono LORO il contratto verso chi
    // interroga la storia (`jq 'has("push_shards_seconds")'`).
    for (const key of [
      'push_shards_seconds',
      'pack_tar_seconds',
      'pack_locale_source_seconds',
    ]) {
      expect(step!.run, `la riga appesa non porta la chiave "${key}"`).toContain(key);
    }
    const tailTiming = NONIT_TAIL_STEPS.find((s) => s.name === 'Record non-IT tail timing');
    expect(tailTiming?.if).toBe('always()');
    expect(tailTiming?.run).toContain('section push');
    expect(tailTiming?.run).toContain('section pack');
    expect(tailTiming?.run).toContain('locale push');
    const itPush = IT_TAIL_STEPS.find((s) => s.id === 'push-section-group');
    expect(itPush?.run).toContain('wall_seconds=$SECONDS');
  });

  it('tutti i produttori di righe passano dallo stesso script di staging', () => {
    // La validazione della riga ha un solo posto in cui cambiare; il commit
    // e il push li fa il job build-history-commit (#9247), vedi
    // tests/build-history-single-writer.test.ts.
    const producers = BUILD_LOCALE_STEPS.filter((s) =>
      typeof s.run === 'string' && s.run.includes('scripts/lib/append-build-history-row.sh'),
    );
    expect(
      producers.map((s) => s.name),
      'attesi tre produttori di righe di build-history (memoria + fasi post-build + manifest)',
    ).toEqual([
      'Append build memory history row',
      'Append post-build phase timings row',
      'Append incremental manifest history row',
    ]);
    for (const s of producers) {
      expect(s.env?.HISTORY_STAGE_DIR, `"${s.name}": nessuna cartella di staging`).toBe(
        '${{ runner.temp }}/build-history-rows',
      );
      expect(s.run, `"${s.name}": la gamba non deve piu' committare`).not.toContain('HISTORY_COMMIT_MSG=');
      expect(s.run, `"${s.name}": push dentro la gamba`).not.toMatch(/\bgit\s+push\b/);
    }
  });

  it('#7546 — il profilo delle fasi post-build arriva nel riepilogo del job', () => {
    const step = BUILD_LOCALE_STEPS.find((s) => s.name === 'Build profile summary');
    expect(step, 'deploy.yml: manca lo step Build profile summary').toBeDefined();
    expect(step!.if).toBe('always()');
    expect(step!.run).toContain('$GITHUB_STEP_SUMMARY');
    expect(step!.run).toContain('/tmp/build.log');
    expect(step!.run).toMatch(/\/\^\\\[phase-timing/);
  });

  it('#9247 — osserva ogni fase e apre un allarme advisory oltre il +30%', () => {
    const observe = BUILD_LOCALE_STEPS.find((s) => s.name === 'Observe phase timing per locale');
    expect(observe, 'deploy.yml: manca l osservatore delle fasi').toBeDefined();
    expect(observe!.if).toBe('always()');
    expect(observe!['continue-on-error']).toBe(true);
    expect(observe!.run).toContain('scripts/ci/phase-timing-observer.mjs');
    expect(observe!.run).toContain('$GITHUB_STEP_SUMMARY');
    expect(observe!.env?.PHASE_TIMING_HISTORY).toBe('data/build-history/memory-peaks.jsonl');
    expect(observe!.env?.PHASE_TIMING_LOCALE).toContain('matrix.locale');

    const report = BUILD_LOCALE_STEPS.find((s) => s.name === 'Report build phase timing regression to GitHub Issues');
    expect(report, 'deploy.yml: manca il report dell allarme fasi').toBeDefined();
    expect(report!.if).toContain("steps.phase_timing.outputs.alert == 'true'");
    expect(report!['continue-on-error']).toBe(true);
    expect(report!.with?.title).toBe('Build phase timing regression (+30% median)');

    const history = (YAML.parse(DEPLOY_YML) as any).jobs['build-history-commit'];
    expect(history.permissions?.issues).toBe('write');
    const resolver = history.steps.find((s: any) => s.name === 'Resolve build phase timing regression issue on green');
    expect(resolver, 'deploy.yml: manca la chiusura dell allarme sul verde').toBeDefined();
    expect(resolver!.if).toContain("needs.build-locale.result == 'success'");
    expect(resolver!.run).toContain('--resolve');
    expect(resolver!.run).toContain('Build phase timing regression (+30% median)');
    expect(resolver!.run).toContain('gh run list');
    expect(resolver!.run).toContain('--recovery-ready');
    expect(resolver!.env?.PHASE_TIMING_RUNS_FILE).toContain('phase-timing-runs.json');
    expect(resolver!.env?.PHASE_TIMING_RECOVERY_RUNS).toBe('3');
    const historyCheckout = history.steps.find((s: any) => s.name === 'Checkout build-history writer');
    expect(historyCheckout?.with?.['sparse-checkout']).toContain('/scripts/ci/phase-timing-observer.mjs');

    const profileAppend = BUILD_LOCALE_STEPS.find((s) => s.name === 'Append post-build phase timings row');
    expect(profileAppend?.env?.ROW_BUILD_STATUS).toBe("${{ job.status }}");
    expect(profileAppend?.run).toContain('build_status: process.env.ROW_BUILD_STATUS || null');
  });

  it('#7548 — gli append di build-history non riattivano un deploy completo', () => {
    const workflow = YAML.parse(DEPLOY_REQUEST_YML) as any;
    const ignored = workflow.on?.push?.['paths-ignore'] ?? [];
    expect(ignored).toContain('data/build-history/**');
  });

  it('ignora solo i commit di telemetria che non alimentano il dist', () => {
    const workflow = YAML.parse(DEPLOY_REQUEST_YML) as any;
    const ignored = workflow.on?.push?.['paths-ignore'] ?? [];
    expect(ignored).toEqual(expect.arrayContaining([
      'data/loop-fleet/**',
      'data/translation-observability-history.json',
      'data/translation-observability-state.json',
      'data/translation-stats-history.json',
    ]));
  });
});

describe('deploy.yml — expired archive memory delta observation (#17888)', () => {
  const workflow = YAML.parse(DEPLOY_YML) as any;
  const steps: Array<Record<string, any>> = workflow.jobs['build-locale'].steps;

  it('observes anon peak, RSS and duration without changing the deploy gate', () => {
    const observer = steps.find((step) => step.name === 'Observe expired archive memory delta');
    expect(observer, 'deploy.yml: manca l osservatore della memoria dell archivio scaduto').toBeDefined();
    expect(observer!.id).toBe('expired_archive_memory_delta');
    expect(observer!.if).toBe('always()');
    expect(observer!['continue-on-error']).toBe(true);
    expect(observer!.env).toMatchObject({
      EXPIRED_ARCHIVE_BASELINE_PEAK_ANON_MB: '20002',
      EXPIRED_ARCHIVE_BREACH: '${{ steps.memguard.outputs.breach }}',
      EXPIRED_ARCHIVE_PEAK_ANON_MB: '${{ steps.memguard.outputs.peak_anon_mb }}',
      EXPIRED_ARCHIVE_PEAK_RSS_MB: '${{ steps.memguard.outputs.peak_rss_mb }}',
      EXPIRED_ARCHIVE_WALL_SECONDS: '${{ steps.build_step.outputs.wall_seconds }}',
    });
    expect(observer!.run).toContain('expiredArchiveMemoryDeltaObserved()');
    expect(observer!.run).toContain('peak_anon_mb');
    expect(observer!.run).toContain('peak_rss_mb');
    expect(observer!.run).toContain('wall_seconds');
    expect(observer!.run).toContain('20.002 MB');
    expect(observer!.run).toContain('revert: dynamic memory threshold breached');
  });
});

describe('deploy.yml — Rollup cap build memory budget observation (#18517)', () => {
  const workflow = YAML.parse(DEPLOY_YML) as any;
  const steps: Array<Record<string, any>> = workflow.jobs['build-locale'].steps;

  it('wires a read-only, always-running report directly after memguard', () => {
    const memguardIndex = steps.findIndex((step) => step.id === 'memguard');
    const observer = steps.find((step) => step.id === 'build_memory_budget');
    expect(observer, 'deploy.yml: manca l osservatore del budget memoria Rollup').toBeDefined();
    expect(observer!.name).toBe('Observe build memory budget after Rollup cap');
    expect(observer!.if).toBe('always()');
    expect(observer!['continue-on-error']).toBe(true);
    expect(steps.indexOf(observer!)).toBe(memguardIndex + 1);
    expect(observer!.env).toMatchObject({
      BUILD_MEMORY_BUDGET_BASELINE_PEAK_RSS_MB: '13200',
      BUILD_MEMORY_BUDGET_MAX_WALL_SECONDS: '21000',
      BUILD_MEMORY_BUDGET_REPORT_PATH: '/tmp/build-memory-peak.json',
      BUILD_MEMORY_BUDGET_BREACH: '${{ steps.memguard.outputs.breach }}',
      BUILD_MEMORY_BUDGET_PEAK_RSS_MB: '${{ steps.memguard.outputs.peak_rss_mb }}',
      BUILD_MEMORY_BUDGET_PEAK_ANON_MB: '${{ steps.memguard.outputs.peak_anon_mb }}',
      BUILD_MEMORY_BUDGET_WALL_SECONDS: '${{ steps.build_step.outputs.wall_seconds }}',
    });
    expect(observer!.run).toContain('buildMemoryBudgetObserved()');
    expect(observer!.run).toContain('peak_rss_mb');
    expect(observer!.run).toContain('peak_anon_mb');
    expect(observer!.run).toContain('wall_seconds');
    expect(observer!.run).toContain('report availability');
    expect(observer!.run).toContain('not-comparable');
    expect(observer!.run).toContain('350 minutes');
    expect(observer!.run).toContain('revert: wall_seconds exceeded 350-minute budget');
  });

  it('keeps the existing build and memory gate wiring intact', () => {
    const build = steps.find((step) => step.id === 'build_step');
    const memguard = steps.find((step) => step.id === 'memguard');
    expect(build!.run).toContain('wall_seconds=$SECONDS');
    expect(memguard!.if).toBe('always()');
    expect(memguard!.run).toContain('/tmp/build-memory-peak.json');
  });
});

describe('deploy.yml — incremental manifest shadow observation (PR 1b)', () => {
  const workflow = YAML.parse(DEPLOY_YML) as any;
  const steps: Array<Record<string, any>> = workflow.jobs['build-locale'].steps;
  const stepByName = (name: string) => {
    const step = steps.find((candidate) => candidate.name === name);
    expect(step, `deploy.yml: manca lo step "${name}" nel job build-locale`).toBeDefined();
    return step!;
  };

  it('gates the manifest env on the Build step behind a repository variable', () => {
    const build = stepByName('Build (BUILD_LOCALE=${{ matrix.locale }})');
    // Run 35146607926: always-on registration cost +44 min on the IT leg.
    // Unset variable → empty string → INCREMENTAL_MANIFEST_ENABLED false.
    expect(build.env?.INCREMENTAL_MANIFEST).toBe("${{ vars.INCREMENTAL_MANIFEST == '1' && '1' || '' }}");
  });

  it('restores and saves one manifest cache per locale around the build', () => {
    const restore = stepByName('Restore previous incremental manifest');
    const stash = stepByName('Stash previous incremental manifest before build overwrites it');
    const buildIndex = steps.indexOf(stepByName('Build (BUILD_LOCALE=${{ matrix.locale }})'));
    const restoreIndex = steps.indexOf(restore);
    const stashIndex = steps.indexOf(stash);
    expect(restore.uses).toBe('actions/cache/restore@v6');
    expect(restore.with).toMatchObject({
      path: '.cache/incremental-manifest',
      key: 'incremental-manifest-${{ matrix.locale }}-${{ github.run_id }}',
    });
    expect(String(restore.with['restore-keys']).trim()).toBe('incremental-manifest-${{ matrix.locale }}-');
    expect(stash.run).toContain('.cache/incremental-manifest-prev');
    expect(stash.run).toContain('mv "$previous"');
    expect(restoreIndex).toBeLessThan(stashIndex);
    expect(stashIndex).toBeLessThan(buildIndex);

    const save = stepByName('Save incremental manifest cache');
    expect(save.uses).toBe('actions/cache/save@v6');
    expect(save.if).toContain('always()');
    expect(save.with).toMatchObject({
      path: '.cache/incremental-manifest',
      key: 'incremental-manifest-${{ matrix.locale }}-${{ github.run_id }}',
    });
    expect(steps.indexOf(save)).toBe(steps.length - 1);
  });

  it('reports the real previous/current CLI and remains non-blocking', () => {
    const report = stepByName('Incremental manifest shadow report');
    expect(report.if).toBe('always()');
    expect(report['continue-on-error']).toBe(true);
    expect(report.run).toContain('node scripts/ci/incremental-manifest-report.mjs "$MANIFEST_PREVIOUS" "$MANIFEST_CURRENT"');
    expect(report.run).toContain('$GITHUB_STEP_SUMMARY');
    expect(report.env).toMatchObject({
      MANIFEST_PREVIOUS: '.cache/incremental-manifest-prev/${{ matrix.locale }}.jsonl',
      MANIFEST_CURRENT: '.cache/incremental-manifest/${{ matrix.locale }}.jsonl',
    });
  });

  it('appends a manifest telemetry row with first-run and per-kind fields', () => {
    const history = stepByName('Append incremental manifest history row');
    expect(history.if).toBe('always()');
    expect(history['continue-on-error']).toBe(true);
    expect(history.run).toContain('kind: "incremental-manifest"');
    expect(history.run).toContain('previous: previous ?');
    expect(history.run).toContain('file_size_bytes');
    expect(history.run).toContain('by_kind');
    expect(history.run).toContain('scripts/lib/append-build-history-row.sh');
    expect(history.run).toContain('HISTORY_LABEL=build-history-manifest');
    expect(history.env?.HISTORY_STAGE_DIR).toBe('${{ runner.temp }}/build-history-rows');
  });
});

describe('deploy.yml — bounded jobs SEO heap collection cadence', () => {
  it('sets the canary-validated 512 MiB collection interval for production builds', () => {
    const build = ((YAML.parse(DEPLOY_YML) as any).jobs['build-locale'].steps as Array<Record<string, any>>)
      .find((step) => step.name === 'Build (BUILD_LOCALE=${{ matrix.locale }})');
    expect(build?.env?.JOBS_SEO_HTML_GC_INTERVAL_MB).toBe('512');
  });
});

describe('deploy.yml — job OG cache version isolation (#12380)', () => {
  const workflow = YAML.parse(DEPLOY_YML) as any;
  const steps: Array<Record<string, any>> = workflow.jobs['build-locale'].steps;
  const resolveVersion = steps.find((step) => step.name === 'Resolve job OG image cache version');
  const restore = steps.find((step) => step.name === 'Restore per-job OG images');
  const save = steps.find((step) => step.name === 'Save per-job OG images after successful build');

  it('uses the raster version for both restore and save namespaces', () => {
    expect(resolveVersion?.if).toBe("matrix.locale == 'it'");
    expect(resolveVersion?.id).toBe('job_og_image_version');
    expect(resolveVersion?.run).toContain("./build-plugins/shared/jobOgImageVersion.mjs");
    expect(resolveVersion?.run).toContain('GITHUB_OUTPUT');
    expect(restore?.uses).toBe('actions/cache/restore@v6');
    expect(restore?.id).toBe('job_og_images_cache');
    expect(restore?.with?.path).toBe('.cache/og-jobs');
    expect(String(restore?.with?.key)).toContain(
      'og-jobs-${{ runner.os }}-${{ steps.job_og_image_version.outputs.version }}-',
    );
    expect(String(restore?.with?.['restore-keys']).trim().split('\n')).toEqual([
      'og-jobs-${{ runner.os }}-${{ steps.job_og_image_version.outputs.version }}-',
    ]);
    expect(save?.uses).toBe('actions/cache/save@v6');
    expect(save?.with?.path).toBe('.cache/og-jobs');
    expect(String(save?.with?.key)).toContain(
      'og-jobs-${{ runner.os }}-${{ steps.job_og_image_version.outputs.version }}-',
    );
    expect(String(save?.with?.key)).toContain('${{ github.run_id }}');
    expect(String(save?.if)).toContain("steps.build_step.outcome == 'success'");
    expect(steps.indexOf(resolveVersion!)).toBeLessThan(steps.indexOf(restore!));
    expect(steps.indexOf(restore!)).toBeLessThan(steps.indexOf(save!));
    const observer = steps.find((step) => step.name === 'Observe phase timing per locale');
    expect(observer?.env?.PHASE_TIMING_JOB_OG_CACHE_MATCHED_KEY).toContain(
      'steps.job_og_images_cache.outputs.cache-matched-key',
    );
  });
});

describe('deploy.yml — shard push mode and advisory delta verification', () => {
  const workflow = YAML.parse(DEPLOY_YML) as any;
  const publishWorkflow = YAML.parse(DEPLOY_PUBLISH_YML) as any;
  const steps: Array<Record<string, any>> = [
    ...workflow.jobs['build-locale'].steps,
    ...publishWorkflow.jobs['push-it-shard-groups'].steps,
    ...publishWorkflow.jobs['publish-nonit-shards'].steps,
  ];
  const pushStep = (name: string) => {
    const step = steps.find((candidate) => candidate.name === name);
    expect(step, `deploy.yml: manca lo step "${name}" nel job build-locale`).toBeDefined();
    return step!;
  };
  const sectionSteps = [
    'Push and package IT section group',
    'Push section shards (non-IT → frontaliere-<section>-<loc>)',
  ];

  it('pins SHARD_PUSH_MODE to the repository-variable expression on every shard push step', () => {
    for (const name of [...sectionSteps, 'Push locale shard']) {
      expect(pushStep(name).env?.SHARD_PUSH_MODE).toBe("${{ vars.SHARD_PUSH_MODE == 'delta' && 'delta' || 'full' }}");
    }
  });

  it('exposes the advisory verifier only through vars.SHARD_PUSH_VERIFY', () => {
    for (const name of [...sectionSteps, 'Push locale shard']) {
      expect(pushStep(name).env?.SHARD_PUSH_VERIFY).toBe("${{ vars.SHARD_PUSH_VERIFY == '1' && '1' || '' }}");
    }
  });

  it('derives the IT section timeout from its job deadline and preserves the non-IT cap', () => {
    for (const name of sectionSteps) {
      const run = String(pushStep(name).run ?? '');
      if (name.startsWith('Push and package IT')) {
        const helper = readFileSync(resolve(ROOT, 'scripts/ci/push-it-shard-group.sh'), 'utf8');
        expect(run, `${name}: must call the IT group helper`).toContain('scripts/ci/push-it-shard-group.sh');
        expect(helper, `${name}: preserve cleanup grace`).toContain('cleanup_grace_seconds=600');
        expect(helper, `${name}: derive timeout from the group's six-hour deadline`).toContain(
          'job_start + 360 * 60 - now_epoch - cleanup_grace_seconds - post_push_reserve_seconds',
        );
        expect(helper, `${name}: preserve the one-hour section cap`).toContain('section_timeout_cap_seconds=3600');
        expect(helper, `${name}: keep cleanup and post-push reserves`).toContain('post_push_reserve_seconds=1200');
        expect(helper, `${name}: keep per-section timeout telemetry`).toContain('timeout_seconds=$timeout_seconds cleanup_grace_seconds=$cleanup_grace_seconds');
      } else {
        const timeoutMatch = run.match(
          /timeout --verbose --signal=TERM --kill-after=(\d+)s (\d+)s/,
        );
        expect(timeoutMatch, `${name}: keep its separate bounded worker`).not.toBeNull();
        expect(Number(timeoutMatch![1]), `${name}: preserve signal-cleanup grace`).toBe(600);
        // Run 37728960699 completed a non-IT full-overlay push in 2,524s;
        // that leg retains its independent 60-minute cap.
        expect(Number(timeoutMatch![2]), `${name}: preserve its reviewed 60 min cap`).toBe(3600);
        expect(run).toContain('timeout_seconds=3600 cleanup_grace_seconds=600');
        expect(run, `${name}: serialize each section shard through the shared lease`).toContain(
          'node scripts/ci/with-shard-writer-lock.mjs',
        );
        expect(run, `${name}: wait for an active full-deploy writer`).toContain('--policy wait');
        expect(run, `${name}: keep the lock wait bounded to the worker deadline`).toContain(
          '--timeout-ms 3600000',
        );
        expect(run, `${name}: wrap the existing checkpointed section push`).toContain(
          'bash scripts/lib/push-section-shard.sh',
        );
      }
      if (name.startsWith('Push and package IT')) {
        const helper = readFileSync(resolve(ROOT, 'scripts/ci/push-it-shard-group.sh'), 'utf8');
        expect(helper, `${name}: missing per-section start telemetry`).toContain('[section-push] event=start');
        expect(helper, `${name}: missing explicit timeout telemetry`).toContain('event=timeout');
        expect(helper, `${name}: forced termination must be distinguishable from a timeout`).toContain('event=forced-termination');
      } else {
        expect(run, `${name}: missing per-section start telemetry`).toContain('[section-push] event=start');
        expect(run, `${name}: missing explicit timeout telemetry`).toContain('event=timeout');
        expect(run, `${name}: forced termination must be distinguishable from a timeout`).toContain('event=forced-termination');
        expect(run, `${name}: timeout must leave the existing publish fallback unchanged`).toMatch(
          /existing (?:apex and strip-marker|live\/ok-marker) fallback remains in effect/,
        );
      }
    }
  });

  it('uploads mismatch reports under the locale/run-scoped artifact name without blocking deploy', () => {
    const upload = pushStep('Upload advisory shard push verification report');
    expect(upload.if).toBe("always() && vars.SHARD_PUSH_VERIFY == '1'");
    expect(upload['continue-on-error']).toBe(true);
    expect(upload.uses).toBe('actions/upload-artifact@v7');
    expect(upload.with).toMatchObject({
      name: 'shard-push-verify-${{ matrix.locale }}-${{ github.run_id }}',
      path: '${{ runner.temp }}/shard-push-verify',
      'if-no-files-found': 'ignore',
    });
  });
});

describe('deploy.yml — every checkout has an explicit CA bundle (#9681)', () => {
  const workflow = YAML.parse(DEPLOY_YML) as any;
  const checkoutSteps = Object.entries(workflow.jobs).flatMap(([jobName, job]: [string, any]) => {
    const steps: Array<Record<string, any>> = Array.isArray(job.steps) ? job.steps : [];
    return steps.flatMap((step, index) =>
      step.uses === 'actions/checkout@v7' ? [{ jobName, steps, index }] : [],
    );
  });

  it('repairs a missing bundle and exports explicit trust paths before every checkout', () => {
    expect(checkoutSteps.length).toBeGreaterThan(0);

    for (const { jobName, steps, index } of checkoutSteps) {
      const caStep = steps[index - 1];
      expect(caStep?.name, `${jobName}: checkout must follow the CA preflight`).toBe(
        'Restore runner CA trust before checkout (#9681)',
      );
      expect(caStep.run).toContain('sudo update-ca-certificates --fresh');
      expect(caStep.run).toContain('test -s "$ca_file"');
      expect(caStep.run).toContain('GIT_SSL_CAINFO=$ca_file');
      expect(caStep.run).toContain('GIT_SSL_CAPATH=/etc/ssl/certs');
    }
  });

  it('does not weaken TLS verification while handling the runner defect', () => {
    for (const { jobName, steps, index } of checkoutSteps) {
      const caStep = steps[index - 1];
      expect(caStep.run, `${jobName}: CA preflight must keep TLS verification enabled`).not.toMatch(
        /GIT_SSL_NO_VERIFY|sslVerify\s+false/i,
      );
    }
  });
});

describe('deploy.yml — benchmark-only controls never enter production', () => {
  it('does not set the experiment stop, sample, or benchmark guard', () => {
    expect(DEPLOY_YML).not.toContain('BUILD_STOP_AFTER');
    expect(DEPLOY_YML).not.toContain('JOBS_SEO_SAMPLE');
    expect(DEPLOY_YML).not.toContain('BUILD_BENCH');
    expect(BUILD_LOCALE_ENV).not.toHaveProperty('BUILD_STOP_AFTER');
    expect(BUILD_LOCALE_ENV).not.toHaveProperty('JOBS_SEO_SAMPLE');
    expect(BUILD_LOCALE_ENV).not.toHaveProperty('BUILD_BENCH');
  });
});

describe('deploy.yml — closeBundle serializzati in produzione (OOM run 35100583972)', () => {
  // #8818 aveva reso paralleli gli hook in produzione: heap a 11 GB gia' prima di
  // jobs-seo-pages (6,8 GB in sequenziale) e OOM su tutti e quattro i leg. Il
  // parallelo resta solo opt-in esplicito da workflow_dispatch.
  it('vale 1 su push e diventa vuoto solo con parallel_plugins esplicito', () => {
    const sequentialProfile = String(BUILD_LOCALE_ENV.SEQUENTIAL_PROFILE ?? '');
    expect(sequentialProfile).toContain('fromJSON(\'["1",""]\')');
    expect(sequentialProfile).toContain("github.event_name == 'workflow_dispatch'");
    expect(sequentialProfile).toContain("github.event.inputs.parallel_plugins == 'true'");
    expect(sequentialProfile).not.toContain('profile_sequential');
  });
});

describe('deploy.yml — canonical fallback stays inline on the 16 GiB runner', () => {
  it('caps the jobs SEO fallback pre-pass at one worker', () => {
    // `JOBS_SEO_FALLBACK_WORKERS=1` selects the plugin's inline path: it keeps
    // the output unchanged while avoiding one structured clone per worker of
    // the full canonical tuple set.
    expect(BUILD_LOCALE_ENV.JOBS_SEO_FALLBACK_WORKERS).toBe('1');
  });
});

describe('deploy-publish.yml — Pages action failure cannot certify publication', () => {
  const deploy = YAML.parse(DEPLOY_PUBLISH_YML).jobs.deploy;
  const steps = deploy.steps as Array<Record<string, any>>;
  const terminal = steps.find((step) => step.name === 'Require successful GitHub Pages deployment')!;
  const receipt = steps.find((step) => step.name === 'Write durable Pages deployment receipt')!;
  const evaluate = (condition: string, first: string, retry: string, resumed = false, healthy = true) => {
    const expression = condition.replace(/\$\{\{|\}\}/g, '').replaceAll('steps.pages-receipt', "steps['pages-receipt']");
    return new Function('steps', 'success', 'always', `return (${expression});`)({
      'pages-receipt': { outputs: { pages_deployed: String(resumed) } },
      deployment_first: { outcome: first }, deployment: { outcome: retry },
    }, () => healthy, () => true);
  };

  it.each([
    ['failure', 'failure', false, true, false],
    ['success', 'skipped', false, false, true],
    ['failure', 'success', false, false, true],
    ['skipped', 'skipped', true, false, false],
    ['skipped', 'skipped', false, true, false],
    ['failure', 'cancelled', false, true, false],
    ['', '', false, true, false],
    ['failure', '', false, true, false],
  ])('first=%s retry=%s resumed=%s', (first, retry, resumed, mustFail, mayWrite) => {
    expect(evaluate(terminal.if, first as string, retry as string, resumed as boolean)).toBe(mustFail);
    expect(evaluate(terminal.if, first as string, retry as string, resumed as boolean, false)).toBe(mustFail);
    expect(evaluate(receipt.if, first as string, retry as string, resumed as boolean)).toBe(mayWrite);
    expect(evaluate(receipt.if, first as string, retry as string, resumed as boolean, false)).toBe(false);
  });

  it.each(['in_progress', 'success'])('fails immediately without consulting an environment deployment in %s', (environmentState) => {
    const dir = mkdtempSync(resolve(tmpdir(), 'pages-action-failure-'));
    try {
      const trace = resolve(dir, 'calls');
      for (const command of ['gh', 'sleep']) {
        writeFileSync(resolve(dir, command), `#!/bin/sh\necho ${command} >> "$TRACE"\necho "$ENVIRONMENT_STATE"\n`, { mode: 0o700 });
      }
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', terminal.run], {
        encoding: 'utf8', timeout: 2000,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TRACE: trace, ENVIRONMENT_STATE: environmentState,
          PAGES_FIRST_OUTCOME: 'failure', PAGES_RETRY_OUTCOME: 'failure', GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '42' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('no successful deploy-pages attempt (first=failure, retry=failure)');
      expect(result.stdout).toContain('https://github.com/owner/repo/actions/runs/42');
      expect(result.stdout).toContain('no receipt will be written');
      expect(existsSync(trace)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves the real actions, single retry and publication order', () => {
    expect(deploy['timeout-minutes']).toBe(360);
    const actions = steps.filter((step) => step.uses === 'actions/deploy-pages@v5');
    expect(actions.map((step) => step.id)).toEqual(['deployment_first', 'deployment']);
    expect(actions[1].if).toContain("steps.deployment_first.outcome == 'failure'");
    expect(steps.find((step) => step.name === 'Wait for previous Pages deployment to finish')!.run).toContain('sleep 30');
    expect(steps.indexOf(actions[1])).toBeLessThan(steps.indexOf(terminal));
    expect(steps.indexOf(terminal)).toBeLessThan(steps.indexOf(receipt));
    expect(steps.some((step) => step.run?.includes('/deployments?environment=github-pages'))).toBe(false);
  });
});
