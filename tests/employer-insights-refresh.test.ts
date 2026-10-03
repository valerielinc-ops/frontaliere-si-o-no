import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import * as employerInsightsBuilder from '../scripts/build-employer-insights.mjs';
import { validateD18Artifact } from '../scripts/ci/validate-employer-insights-d18-payload.mjs';
import { commitInChunks } from '../scripts/lib/firestore-batch.mjs';

const REFRESH_WORKFLOW_SOURCE = readFileSync(
  new URL('../.github/workflows/employer-insights-refresh.yml', import.meta.url),
  'utf8',
);
const BUILDER_SOURCE = readFileSync(
  new URL('../scripts/build-employer-insights.mjs', import.meta.url),
  'utf8',
);

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  'continue-on-error'?: unknown;
};
type WorkflowJob = { needs?: string | string[]; steps?: WorkflowStep[]; 'continue-on-error'?: unknown };

const LIVE_EVIDENCE_FLAG = '--require-live-ga4';
const WRITER_CALL = 'writeEmployerInsightsDocuments(';
const LEGACY_VALIDATOR = 'validate-employer-insights-payload.mjs';
const FRESHNESS_SCRIPT = 'scripts/ci/check-employer-insights-freshness.mjs';

function workflowJobs(source: string): Record<string, WorkflowJob> {
  return (YAML.parse(source)?.jobs ?? {}) as Record<string, WorkflowJob>;
}

/** Every job the given job waits for, directly or through another job. */
function upstreamJobs(jobs: Record<string, WorkflowJob>, jobId: string, seen = new Set<string>()): Set<string> {
  for (const need of [jobs[jobId]?.needs ?? []].flat()) {
    if (seen.has(need)) continue;
    seen.add(need);
    upstreamJobs(jobs, need, seen);
  }
  return seen;
}

/**
 * The one-off D18 acceptance must never sit in front of the recurring write.
 * Returns the violations, so the same check runs on the real workflow and on
 * the shape that kept twelve daily refreshes out of Firestore.
 */
function gateOrderViolations(source: string): string[] {
  const jobs = workflowJobs(source);
  const located = Object.entries(jobs).flatMap(([jobId, job]) =>
    (job.steps ?? []).map((step, index) => ({ jobId, step, index })));
  const writers = located.filter(({ step }) => String(step.run ?? '').includes(WRITER_CALL));
  const gates = located.filter(({ step }) => String(step.run ?? '').includes(LIVE_EVIDENCE_FLAG));
  const violations: string[] = [];
  if (writers.length === 0) violations.push('no step writes employer_insights');
  if (gates.length === 0) violations.push(`no step runs ${LIVE_EVIDENCE_FLAG}`);
  for (const writer of writers) {
    const upstream = upstreamJobs(jobs, writer.jobId);
    for (const gate of gates) {
      if (gate.jobId === writer.jobId && gate.index < writer.index) {
        violations.push(`"${gate.step.name}" precedes "${writer.step.name}" in job ${writer.jobId}`);
      }
      if (gate.jobId !== writer.jobId && upstream.has(gate.jobId)) {
        violations.push(`job ${writer.jobId} needs job ${gate.jobId}, which runs ${LIVE_EVIDENCE_FLAG}`);
      }
      if (gate.step.id && String(writer.step.if ?? '').includes(`steps.${gate.step.id}.`)) {
        violations.push(`"${writer.step.name}" is conditioned on the outcome of "${gate.step.name}"`);
      }
    }
  }
  return violations;
}

describe('employer insights refresh: the one-off D18 gate does not hold the daily write', () => {
  const jobs = workflowJobs(REFRESH_WORKFLOW_SOURCE);
  const steps = jobs.refresh?.steps ?? [];
  const indexOf = (predicate: (step: WorkflowStep) => boolean) => steps.findIndex(predicate);
  const writerIndex = indexOf((step) => String(step.run ?? '').includes(WRITER_CALL));
  const gateIndex = indexOf((step) => String(step.run ?? '').includes(LIVE_EVIDENCE_FLAG));

  it('runs the live-evidence gate after the write, never before it', () => {
    expect(gateOrderViolations(REFRESH_WORKFLOW_SOURCE)).toEqual([]);
  });

  it('rejects the ordering that blocked the write (gate first, same job)', () => {
    const blocked = YAML.parse(REFRESH_WORKFLOW_SOURCE);
    const blockedSteps: WorkflowStep[] = blocked.jobs.refresh.steps;
    const [gate] = blockedSteps.splice(gateIndex, 1);
    blockedSteps.splice(writerIndex, 0, gate);
    expect(gateOrderViolations(YAML.stringify(blocked)).join('\n')).toMatch(/precedes/);
  });

  it('rejects a write conditioned on the gate, in the same job or through needs', () => {
    const conditioned = YAML.parse(REFRESH_WORKFLOW_SOURCE);
    const gateId = conditioned.jobs.refresh.steps[gateIndex].id;
    expect(gateId).toBeTruthy();
    conditioned.jobs.refresh.steps[writerIndex].if = `steps.${gateId}.outcome == 'success'`;
    expect(gateOrderViolations(YAML.stringify(conditioned)).join('\n')).toMatch(/conditioned on the outcome/);

    const split = YAML.parse(REFRESH_WORKFLOW_SOURCE);
    const [gate] = split.jobs.refresh.steps.splice(gateIndex, 1);
    split.jobs.evidence = { 'runs-on': 'ubuntu-latest', steps: [gate] };
    split.jobs.refresh.needs = ['evidence'];
    expect(gateOrderViolations(YAML.stringify(split)).join('\n')).toMatch(/needs job evidence/);
  });

  it('keeps the daily write behind its own fail-closed validator and nothing else optional', () => {
    const validatorIndex = indexOf((step) => String(step.run ?? '').includes(LEGACY_VALIDATOR));
    expect(validatorIndex).toBeGreaterThanOrEqual(0);
    expect(validatorIndex).toBeLessThan(writerIndex);
    // No `if:` on either: both keep the implicit success() over every earlier step.
    expect(steps[validatorIndex].if).toBeUndefined();
    expect(steps[writerIndex].if).toBeUndefined();
    expect(steps[validatorIndex]['continue-on-error']).toBeUndefined();
    expect(steps[writerIndex]['continue-on-error']).toBeUndefined();
  });

  it('does not lower the gate: it still fails the run and judges the validated artifact', () => {
    const gate = steps[gateIndex];
    expect(gate['continue-on-error']).toBeUndefined();
    expect(jobs.refresh['continue-on-error']).toBeUndefined();
    const structuralIndex = indexOf((step) =>
      String(step.run ?? '').includes('validate-employer-insights-d18-payload.mjs')
      && !String(step.run ?? '').includes(LIVE_EVIDENCE_FLAG));
    expect(structuralIndex).toBeGreaterThanOrEqual(0);
    expect(structuralIndex).toBeLessThan(writerIndex);
    const structuralId = steps[structuralIndex].id;
    expect(structuralId).toBeTruthy();
    // The verdict does not depend on the write either: it is reported whenever
    // the artifact it reads was structurally valid.
    expect(String(gate.if)).toContain(`steps.${structuralId}.outcome == 'success'`);
    expect(String(gate.if)).toContain('!cancelled()');
  });

  it('checks freshness on every run, before the credentials are removed', () => {
    const freshnessIndex = indexOf((step) => String(step.run ?? '').includes(FRESHNESS_SCRIPT));
    const cleanupIndex = indexOf((step) => String(step.run ?? '').includes('rm -f /tmp/firebase-sa.json'));
    const uploadIndex = indexOf((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@'));
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(uploadIndex).toBeGreaterThanOrEqual(0);
    expect(freshnessIndex).toBeGreaterThan(writerIndex);
    expect(cleanupIndex).toBeGreaterThan(freshnessIndex);
    // Must run when an earlier step failed, timed out or was cancelled: those
    // are exactly the stale cases.
    expect(steps[freshnessIndex].if).toBe('always()');
    expect(YAML.parse(REFRESH_WORKFLOW_SOURCE).permissions.issues).toBe('write');
    expect(steps[uploadIndex].if).toBe('always()');
    expect(steps[cleanupIndex].if).toBe('always()');
  });
});

describe('employer insights refresh rollback', () => {
  it('fingerprints the complete identity catalog without materializing one giant string', () => {
    const jobs = Array.from({ length: 5_000 }, (_, index) => ({
      id: `job-${index}`,
      companyKey: `company-${index % 25}`,
      company: `Company ${index % 25}`,
      slug: `role-${index}`,
      slugByLocale: { it: `role-${index}`, en: `role-${index}-en` },
      previousSlugs: [`old-role-${index}`],
    }));
    const first = employerInsightsBuilder.buildIdentityCatalog(jobs);
    const second = employerInsightsBuilder.buildIdentityCatalog([...jobs].reverse());

    expect(first.identityCatalogSha).toMatch(/^[a-f0-9]{64}$/);
    expect(second.identityCatalogSha).toBe(first.identityCatalogSha);
    expect(BUILDER_SOURCE).toContain('sha256StableJson(identityRows)');
    expect(BUILDER_SOURCE).not.toContain('sha256(stableJson(identityRows))');
  });

  it('runs and validates the bounded D18 two-regime artifact beside the legacy writer', () => {
    expect(REFRESH_WORKFLOW_SOURCE).toContain('--d18-json-out /tmp/employer-insights-d18.json');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('--d18-include-applications');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('validate-employer-insights-d18-payload.mjs');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('--require-live-ga4');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('Upload D18 bounded artifact');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('/tmp/employer-insights-d18.json');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('/tmp/employer-insights-builder.log');
    expect(REFRESH_WORKFLOW_SOURCE).not.toMatch(/^\s+- posthog$/m);
    expect(BUILDER_SOURCE).toContain('boundD18Artifact');
    expect(BUILDER_SOURCE).toContain('D18_ARTIFACT_MAX_ADS_PER_COMPANY');
  });

  it('bounds by-ad detail before serializing while retaining declared coverage', () => {
    const window = {
      from: '2026-09-01T00:00:00+02:00',
      to: '2026-09-12T00:00:00+02:00',
      timezone: 'Europe/Zurich',
      inclusive: '[from,to)',
    };
    const jobs = Array.from({ length: 3 }, (_, index) => ({
      id: `job-${index}`,
      companyKey: 'acme',
      company: 'Acme SA',
      title: `Role ${index}`,
      slug: `role-${index}`,
      slugByLocale: { it: `role-${index}` },
      status: 'active',
    }));
    const catalog = employerInsightsBuilder.buildIdentityCatalog(jobs);
    const rows = jobs.map((job) => ({
      event: 'page_view',
      timestamp: '2026-09-10T00:00:00.000Z',
      employerKey: job.companyKey,
      jobSlug: job.slug,
      pageTemplate: 'job_detail',
      locale: 'it',
      observed: 1,
      emissionId: `emission-${job.id}`,
    }));
    const payload = employerInsightsBuilder.buildD18PayloadFromQuerySnapshots({
      window,
      generatedAt: '2026-09-12T06:00:00.000Z',
      catalog,
      ga4Result: {
        rows,
        coverage: {
          rowsReturned: rows.length,
          totalRows: rows.length,
          returnedRows: rows.length,
          returned: rows.length,
          sourceObserved: rows.length,
          identityObserved: rows.length,
          emissionIdDimensionRequested: true,
          emissionIdObserved: rows.length,
          emissionIdMissingObserved: 0,
          pages: 1,
          truncated: false,
          snapshotId: 'ga4-fixture',
          queryHash: 'ga4-query',
        },
      },
      applicationRecords: [],
    });

    const bounded = employerInsightsBuilder.boundD18Artifact(payload, { maxAdsPerCompany: 2 });
    expect(payload.companies[0].byAd).toHaveLength(3);
    expect(bounded.companies[0].byAd).toHaveLength(2);
    expect(bounded.companies[0].byAdCoverage).toMatchObject({
      total: 3,
      included: 2,
      omitted: 1,
      limitPerCompany: 2,
      truncated: true,
    });
    expect(bounded.detailCoverage.byAd).toMatchObject({ total: 3, included: 2, omitted: 1, truncated: true });
    expect(validateD18Artifact(bounded).ok).toBe(true);
    expect(JSON.stringify(bounded)).toContain('canonicalSlug');
  });

  it('accepts a D18 fixture with both regimes and keeps the period total non-summable', () => {
    const window = {
      from: '2026-09-01T00:00:00+02:00',
      to: '2026-09-12T00:00:00+02:00',
      timezone: 'Europe/Zurich',
      inclusive: '[from,to)',
    };
    const catalog = employerInsightsBuilder.buildIdentityCatalog([{
      id: 'job-1',
      companyKey: 'acme',
      company: 'Acme SA',
      title: 'Role',
      slug: 'role-it',
      slugByLocale: { it: 'role-it' },
      status: 'active',
    }]);
    const queryResult = (source: string, observed: number, snapshotId: string) => ({
      rows: [{
        event: 'page_view',
        timestamp: source === 'ga4' ? '2026-09-10T00:00:00.000Z' : '2026-09-08T10:00:00.000Z',
        employerKey: 'acme',
        jobSlug: 'role-it',
        pageTemplate: 'job_detail',
        locale: 'it',
        observed,
        visitorId: `${source}-visitor`,
        emissionId: `${source}-emission`,
      }],
      coverage: {
        rowsReturned: 1,
        totalRows: 1,
        returnedRows: 1,
        returned: observed,
        sourceObserved: observed,
        pages: 1,
        truncated: false,
        identityObserved: source === 'ga4' ? observed : undefined,
        snapshotId,
        queryHash: `${source}-query`,
      },
    });
    const payload = employerInsightsBuilder.buildD18PayloadFromQuerySnapshots({
      window,
      generatedAt: '2026-09-12T06:00:00.000Z',
      catalog,
      ga4Result: queryResult('ga4', 2, 'ga4-fixture'),
      posthogResult: queryResult('posthog', 3, 'posthog-fixture'),
      applicationRecords: [],
    });

    const validation = validateD18Artifact(payload);
    expect(validation.ok).toBe(true);
    const firstRunValidation = validateD18Artifact(payload, { requireLiveGa4: true });
    expect(firstRunValidation.ok).toBe(false);
    expect(firstRunValidation.errors.join('\n')).toMatch(/blocked|live|replay/);
    expect(payload.sourceRegimes.ga4.status).toBe('observed');
    expect(payload.sourceRegimes.posthog.status).toBe('parziale');
    expect(payload.periodTotal).toMatchObject({
      value: null,
      unit: 'composite_two_regimes',
      status: 'non sommabile fra regimi',
    });
    expect(payload.periodTotal.value).not.toBe(5);
    expect(payload.coverageMatrix.requestedDays.length).toBe(11);
    expect(payload.provenance.limitState).toBe('parziale, mai complete');

    const pending = employerInsightsBuilder.buildD18PayloadFromQuerySnapshots({
      window,
      generatedAt: '2026-09-12T06:00:00.000Z',
      catalog,
      ga4Result: queryResult('ga4', 2, 'ga4-fixture'),
      posthogUnavailableReason: 'blocked: backup credentials unavailable',
    });
    expect(validateD18Artifact(pending).ok).toBe(true);
    expect(pending.sourceRegimes.posthog.status).toBe('sorgente non disponibile');
    expect(pending.coverageMatrix.status).toBe('non disponibile');
  });

  it('replays a frozen GA4/PostHog snapshot deterministically without provider access', () => {
    const window = {
      from: '2026-09-01T00:00:00+02:00',
      to: '2026-09-12T00:00:00+02:00',
      timezone: 'Europe/Zurich',
      inclusive: '[from,to)',
    };
    const catalog = employerInsightsBuilder.buildIdentityCatalog([{
      id: 'job-1',
      companyKey: 'acme',
      company: 'Acme SA',
      title: 'Role',
      slug: 'role-it',
      slugByLocale: { it: 'role-it' },
      status: 'active',
    }]);
    const replayInput = {
      schemaVersion: 1,
      mode: 'replay',
      generatedAt: '2026-09-12T06:00:00.000Z',
      window,
      measurementWindow: {
        from: '2026-09-09T00:00:00+02:00',
        to: window.to,
        timezone: 'Europe/Zurich',
        inclusive: '[from,to)',
      },
      sources: {
        ga4: {
          rows: [{
            event: 'page_view',
            timestamp: '2026-09-10T00:00:00.000Z',
            employerKey: 'acme',
            jobSlug: 'role-it',
            observed: 2,
            emissionId: 'ga4-emission-1',
          }],
          coverage: {
            rowsReturned: 1,
            totalRows: 1,
            returnedRows: 1,
            returned: 2,
            sourceObserved: 2,
            identityObserved: 2,
            emissionIdDimensionRequested: true,
            emissionIdObserved: 2,
            emissionIdMissingObserved: 0,
            pages: 1,
            truncated: false,
            snapshotId: 'ga4-replay-snapshot',
            queryHash: 'ga4-replay-query',
          },
        },
        posthog: {
          rows: [{
            event: 'page_view',
            timestamp: '2026-09-08T10:00:00.000Z',
            employerKey: 'acme',
            jobSlug: 'role-it',
            observed: 3,
            emissionId: 'posthog-emission-1',
          }],
          coverage: {
            rowsReturned: 1,
            totalRows: 1,
            returnedRows: 1,
            returned: 3,
            sourceObserved: 3,
            pages: 1,
            truncated: false,
            snapshotId: 'posthog-replay-snapshot',
            queryHash: 'posthog-replay-query',
          },
        },
      },
      applicationRecords: [],
      deliveryRecords: [],
    };
    const replay = employerInsightsBuilder.parseEmployerInsightsReplay(replayInput, 'ga4');
    const build = () => employerInsightsBuilder.buildD18PayloadFromQuerySnapshots({
      window: replay.window,
      generatedAt: replay.generatedAt,
      catalog,
      ga4Result: replay.sources.ga4,
      posthogResult: replay.sources.posthog,
      applicationRecords: replay.applicationRecords,
      deliveryRecords: replay.deliveryRecords,
      runMode: 'replay',
      primarySource: 'ga4',
      ga4EvidenceWindow: replay.measurementWindow,
    });

    const first = build();
    const second = build();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.evidence).toMatchObject({ status: 'replay-valid', runMode: 'replay' });
    expect(first.evidence.measurementWindow).toMatchObject({
      from: replay.measurementWindow.from,
      to: replay.measurementWindow.to,
      timezone: replay.measurementWindow.timezone,
      inclusive: replay.measurementWindow.inclusive,
    });
    expect(validateD18Artifact(first).ok).toBe(true);
    expect(() => employerInsightsBuilder.parseEmployerInsightsReplay({ ...replayInput, sources: { posthog: replayInput.sources.posthog } }, 'ga4'))
      .toThrow(/missing the ga4 source result/);
  });

  it('keeps the settled report window separate from forward live GA4 evidence', () => {
    const window = {
      from: '2026-09-01T00:00:00+02:00',
      to: '2026-09-12T00:00:00+02:00',
      timezone: 'Europe/Zurich',
      inclusive: '[from,to)',
    };
    const evidenceWindow = {
      from: '2026-09-12T00:00:00+02:00',
      to: '2026-09-14T00:00:00+02:00',
      timezone: 'Europe/Zurich',
      inclusive: '[from,to)',
    };
    const catalog = employerInsightsBuilder.buildIdentityCatalog([{
      id: 'job-1',
      companyKey: 'acme',
      company: 'Acme SA',
      title: 'Role',
      slug: 'role-it',
      slugByLocale: { it: 'role-it' },
      status: 'active',
    }]);
    const queryResult = (timestamp: string, emissionId: string, snapshotId: string) => ({
      rows: [{
        event: 'page_view',
        timestamp,
        employerKey: 'acme',
        jobSlug: 'role-it',
        pageTemplate: 'job_detail',
        locale: 'it',
        observed: 2,
        emissionId,
      }],
      coverage: {
        rowsReturned: 1,
        totalRows: 1,
        returnedRows: 1,
        returned: 2,
        sourceObserved: 2,
        identityObserved: 2,
        emissionIdDimensionRequested: true,
        emissionIdObserved: 2,
        emissionIdMissingObserved: 0,
        firstCompleteIdentityAt: timestamp,
        pages: 1,
        truncated: false,
        snapshotId,
        queryHash: `${snapshotId}-query`,
      },
    });
    const payload = employerInsightsBuilder.buildD18PayloadFromQuerySnapshots({
      window,
      generatedAt: '2026-09-14T06:00:00.000Z',
      catalog,
      ga4Result: queryResult('2026-09-10T00:00:00.000Z', 'report-emission', 'report-snapshot'),
      ga4EvidenceWindow: evidenceWindow,
      ga4EvidenceResult: queryResult('2026-09-13T00:00:00.000Z', 'live-emission', 'live-snapshot'),
      measurementWindow: window,
      applicationRecords: [],
      runMode: 'live',
      primarySource: 'ga4',
    });

    expect(payload.evidence).toMatchObject({
      status: 'live-first-run-ready',
      measurementWindow: window,
      evidenceWindow,
    });
    expect(payload.evidence.ga4.emissionId).toMatchObject({
      status: 'complete',
      withValue: 2,
      withoutValue: 0,
    });
    expect(validateD18Artifact(payload, { requireLiveGa4: true }).ok).toBe(true);

    const blocked = employerInsightsBuilder.buildD18PayloadFromQuerySnapshots({
      window,
      generatedAt: '2026-09-14T06:00:00.000Z',
      catalog,
      ga4Result: queryResult('2026-09-10T00:00:00.000Z', 'report-emission', 'report-snapshot'),
      ga4EvidenceWindow: evidenceWindow,
      ga4EvidenceUnavailableReason: 'live probe unavailable',
      measurementWindow: window,
      applicationRecords: [],
      runMode: 'live',
      primarySource: 'ga4',
    });
    expect(blocked.evidence.status).toBe('blocked');
    expect(blocked.evidence.blockers.join('\n')).toMatch(/emission_id/);
    expect(validateD18Artifact(blocked, { requireLiveGa4: true }).ok).toBe(false);
  });

  it('starts the live evidence probe at the settled report cutoff', () => {
    const reportWindow = {
      from: '2026-09-01T00:00:00+02:00',
      to: '2026-09-12T00:00:00+02:00',
      timezone: 'Europe/Zurich',
      inclusive: '[from,to)',
    };
    const live = employerInsightsBuilder.d18LiveEvidenceWindow(reportWindow, '2026-09-14T06:00:00.000Z');

    expect(Date.parse(live.from)).toBe(Date.parse(reportWindow.to));
    expect(live.to).toBe('2026-09-14T06:00:00.000Z');
    expect(live.timezone).toBe('Europe/Zurich');
  });

  it('runs the now-supported GA4 identity feed on the periodic trigger', () => {
    expect(REFRESH_WORKFLOW_SOURCE).toMatch(/on:\s*[\s\S]*schedule:\s*[\s\S]*cron:\s*'15 5 \* \* \*'/);
    expect(REFRESH_WORKFLOW_SOURCE).toMatch(/ga4\) ;;/);
    expect(REFRESH_WORKFLOW_SOURCE).not.toContain('has no complete GA4 identity feed yet');
  });

  it('compares document coverage with the selected source, not legacy roots', () => {
    expect(REFRESH_WORKFLOW_SOURCE).toContain('const expectedSource = process.env.INSIGHTS_SOURCE;');
    expect(REFRESH_WORKFLOW_SOURCE).toMatch(/snapshot\.docs\s*\.filter\(\(doc\) => doc\.data\(\)\?\.source === expectedSource\)/);
    expect(REFRESH_WORKFLOW_SOURCE).toContain('has no ${expectedSource} documents');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('source: expectedSource');
  });

  it('reports items committed before a later Firestore chunk fails', async () => {
    let commitCount = 0;
    const committedBatches: unknown[][] = [];
    const db = {
      batch() {
        const operations: unknown[] = [];
        const batch = {
          set(ref: unknown, data: unknown) {
            operations.push({ ref, data });
            return batch;
          },
          update(ref: unknown, data: unknown) {
            operations.push({ ref, data });
            return batch;
          },
          delete(ref: unknown) {
            operations.push({ ref });
            return batch;
          },
          async commit() {
            commitCount += 1;
            committedBatches.push(operations);
            if (commitCount === 2) throw new Error('second chunk unavailable');
          },
        };
        return batch;
      },
    };

    const result = await commitInChunks(
      db as never,
      ['before-a', 'before-b', 'after-a'],
      (batch, item) => batch.set({ id: item } as never, { item }),
      { chunkSize: 2 },
    ).catch((error: unknown) => error as Error & { committedItems?: number });

    expect(result).toMatchObject({
      message: 'second chunk unavailable',
      committedItems: 2,
    });
    expect(committedBatches).toHaveLength(2);
    expect(committedBatches[0]).toHaveLength(2);
    expect(committedBatches[1]).toHaveLength(1);
  });

  it('keeps rollback completion and partial progress visible in the workflow error', () => {
    expect(REFRESH_WORKFLOW_SOURCE).toContain('error?.committedItems');
    expect(REFRESH_WORKFLOW_SOURCE).toMatch(
      /rollback incomplete: committed \$\{committed\}\/\$\{attempted\} documents \(Firestore items\)/,
    );
    expect(REFRESH_WORKFLOW_SOURCE).toContain('restoreEmployerInsightsSnapshot');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('expectedDocuments: expected');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('error?.attemptedItems');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('rollbackResult.committed');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('rollback status:');
  });

  it('verifies additional-window shards after the root write', () => {
    expect(REFRESH_WORKFLOW_SOURCE).toContain('employerInsightsWindowAdsSubcollection');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('after.windowAds');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('storedSummary.adsStorage');
    expect(REFRESH_WORKFLOW_SOURCE).toContain('storedAdsForWindow.size');
  });
});
