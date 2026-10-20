import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkEmployerIdentity } from '../scripts/lib/prospector/employer-identity.mjs';
import {
  classifyValidationFailure,
  isValidationRetryDue,
  needsProductionQualityAudit,
  prioritizeProductionAuditSpecs,
  prioritizeValidationSpecs,
  validationRetryAt,
} from '../scripts/lib/prospector/validation-schedule.mjs';
import { prioritizeSynthesisCandidates } from '../scripts/lib/prospector/synthesis-schedule.mjs';
import { adaptiveValidationSampleSize, selectValidationSample } from '../scripts/lib/prospector/validation-sample.mjs';
import { comparePublicationSnapshots, createValidationSnapshot } from '../scripts/lib/prospector/snapshot-comparison.mjs';
import { reconcileAwaitingFirstCrawls } from '../scripts/lib/prospector/production-output.mjs';

describe('Prospector validation evidence and production feedback', () => {
  let dir = '';

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('checks employer identity from structured name, company domain, and tenant host', () => {
    expect(checkEmployerIdentity(
      { company: 'ACME AG' },
      'https://jobs.acme.ch/openings/1',
      { companyName: 'ACME AG', companyHost: 'acme.ch' },
    ).status).toBe('match');
    expect(checkEmployerIdentity(
      {},
      'https://careers.acme.ch/jobs',
      { companyName: 'ACME AG', companyHost: 'acme.ch' },
    )).toMatchObject({ status: 'match', evidence: 'company_domain' });
    expect(checkEmployerIdentity(
      {},
      'https://acme.umantis.com/jobs',
      { companyName: 'ACME AG', tenantHost: 'acme.umantis.com' },
    )).toMatchObject({ status: 'match', evidence: 'tenant_host' });
    expect(checkEmployerIdentity(
      { company: 'Different Employer SA' },
      'https://jobs.acme.ch/openings/1',
      { companyName: 'ACME AG', companyHost: 'acme.ch' },
    ).status).toBe('mismatch');
    expect(checkEmployerIdentity({}, 'https://vendor.example/jobs', { companyName: 'ACME AG' }).status).toBe('unknown');
    expect(checkEmployerIdentity(
      { company: 'Legal Entity SA' },
      'https://jobs.vendor.example/openings/1',
      { companyName: 'Portal Display Name' },
      { name: 'Portal Display Name', secoName: 'Legal Entity SA' },
    )).toMatchObject({ status: 'match', evidence: 'structured_seco_name' });
  });

  it('reserves synthesis slots for older candidates while retaining volume priority', () => {
    const candidates = [
      { key: 'high-1', vacancyCount: 100, firstSeenAt: '2026-10-10' },
      { key: 'high-2', vacancyCount: 90, firstSeenAt: '2026-10-11' },
      { key: 'high-3', vacancyCount: 80, firstSeenAt: '2026-10-12' },
      { key: 'small-old', vacancyCount: 1, firstSeenAt: '2026-01-01' },
      { key: 'small-new', vacancyCount: 2, firstSeenAt: '2026-09-01' },
    ];

    expect(prioritizeSynthesisCandidates(candidates, 4).map(({ key }) => key)).toEqual([
      'small-old', 'high-1', 'high-2', 'high-3',
    ]);
  });

  it('audits production only until two complete current-contract days exist', () => {
    const spec = { companyKey: 'example', qualityContractVersion: 3 };
    const candidate: any = {
      key: 'example', status: 'production', qualityContractVersion: 3,
      validationHistory: [
        { at: '2026-10-17T09:00:00Z', verdict: 'good', runtimeSnapshotComplete: true },
        { at: '2026-10-18T09:00:00Z', verdict: 'good', runtimeSnapshotComplete: true },
      ],
    };
    const adapterVersionFor = () => null;
    expect(needsProductionQualityAudit(spec, candidate, {
      date: '2026-10-20T03:00:00Z', adapterVersionFor,
    })).toBe(true);

    candidate.validationHistory.push({
      at: '2026-10-20T03:00:00Z', qualityContractVersion: 3,
      verdict: 'good', runtimeSnapshotComplete: true,
    });
    expect(needsProductionQualityAudit(spec, candidate, {
      date: '2026-10-20T04:00:00Z', adapterVersionFor,
    })).toBe(false);
    expect(needsProductionQualityAudit(spec, candidate, {
      date: '2026-10-21T03:00:00Z', adapterVersionFor,
    })).toBe(true);
    candidate.validationHistory.push({
      at: '2026-10-21T03:00:00Z', qualityContractVersion: 3,
      verdict: 'good', runtimeSnapshotComplete: true,
    });
    expect(needsProductionQualityAudit(spec, candidate, {
      date: '2026-10-22T03:00:00Z', adapterVersionFor,
    })).toBe(false);
  });

  it('restarts stability after a weak observation and rotates the oldest production audits first', () => {
    const adapterVersionFor = () => null;
    const spec = { companyKey: 'example', qualityContractVersion: 3 };
    const candidate: any = {
      key: 'example', status: 'production', qualityContractVersion: 3,
      validationHistory: [
        { at: '2026-10-16T03:00:00Z', qualityContractVersion: 3, verdict: 'good', runtimeSnapshotComplete: true },
        { at: '2026-10-17T03:00:00Z', qualityContractVersion: 3, verdict: 'good', runtimeSnapshotComplete: true },
        { at: '2026-10-18T03:00:00Z', qualityContractVersion: 3, verdict: 'weak', runtimeSnapshotComplete: true },
      ],
    };
    expect(needsProductionQualityAudit(spec, candidate, {
      date: '2026-10-20T03:00:00Z', adapterVersionFor,
    })).toBe(true);

    const older = {
      companyKey: 'older', qualityContractVersion: 3,
      validationHistory: [{ at: '2026-10-10T03:00:00Z', qualityContractVersion: 3, verdict: 'weak', runtimeSnapshotComplete: true }],
    };
    const newer = {
      companyKey: 'newer', qualityContractVersion: 3,
      validationHistory: [{ at: '2026-10-19T03:00:00Z', qualityContractVersion: 3, verdict: 'weak', runtimeSnapshotComplete: true }],
    };
    const specs = [newer, older];
    expect(prioritizeProductionAuditSpecs(specs, (item) => item, { adapterVersionFor })
      .map(({ companyKey }) => companyKey)).toEqual(['older', 'newer']);
  });

  it('adapts sample size to inventory and prioritizes unresolved anomaly URLs', () => {
    const candidate = { validationHistory: [{ verdict: 'weak' }], validationAnomalyIds: ['https://jobs.example/3'] };
    expect(adaptiveValidationSampleSize({ baseSampleSize: 3, populationCount: 10 })).toBe(3);
    expect(adaptiveValidationSampleSize({ baseSampleSize: 3, populationCount: 40 })).toBe(5);
    expect(adaptiveValidationSampleSize({ baseSampleSize: 3, populationCount: 40, candidate })).toBe(8);

    const vacancies = Array.from({ length: 12 }, (_, index) => ({ url: `https://jobs.example/${index}`, title: `Job ${index}` }));
    const sample = selectValidationSample(vacancies, {
      companyKey: 'example.ch', sampleSize: 4,
      anomalyIds: ['https://jobs.example/3', 'https://jobs.example/9'],
      date: new Date(),
    });
    expect(sample.selected.slice(0, 2).map((row) => row.id)).toEqual([
      'https://jobs.example/3', 'https://jobs.example/9',
    ]);
    expect(new Set(sample.selected.map((row) => row.id)).size).toBe(4);
  });

  it('classifies incomplete runtime failures and defers retries until their backoff expires', () => {
    const now = Date.now();
    const retryAt = validationRetryAt('timeout', now);
    expect(classifyValidationFailure({ runErrors: ['HTTP 429 too many requests'] })).toBe('rate_limited');
    expect(classifyValidationFailure({ samples: [{ status: 404 }] })).toBe('not_found');
    expect(Date.parse(retryAt)).toBeGreaterThan(now);

    const spec = { companyKey: 'example.ch', qualityContractVersion: 3 };
    const candidate = {
      key: 'example.ch', status: 'validated', qualityContractVersion: 3,
      validationHistory: [{
        at: new Date(now).toISOString(), qualityContractVersion: 3,
        runtimeSnapshotComplete: false, retryAfterAt: retryAt,
      }],
    };
    const lookup = () => candidate;
    expect(isValidationRetryDue(candidate, now, { qualityContractVersion: 3 })).toBe(false);
    expect(prioritizeValidationSpecs([spec], lookup, { date: now, adapterVersionFor: () => null })).toEqual([]);
    expect(isValidationRetryDue(candidate, Date.parse(retryAt), { qualityContractVersion: 3 })).toBe(true);
    expect(prioritizeValidationSpecs([spec], lookup, { date: Date.parse(retryAt), adapterVersionFor: () => null })).toEqual([spec]);

    candidate.validationHistory[0].qualityContractVersion = 2;
    expect(isValidationRetryDue(candidate, now, { qualityContractVersion: 3 })).toBe(true);
  });

  it('compares aligned public output snapshots by hashed stable URL identity', () => {
    const base = Date.now();
    const validationAt = new Date(base).toISOString();
    const validation = createValidationSnapshot([
      { url: 'https://jobs.example/1?utm_source=test' },
      { url: 'https://jobs.example/2#posting' },
    ], validationAt, 'run-1');
    const published = {
      assembledAt: new Date(base + 60 * 60 * 1000).toISOString(),
      runId: 'run-1',
      jobs: [{ url: 'https://jobs.example/1' }, { url: 'https://jobs.example/2#posting' }],
    };
    expect(comparePublicationSnapshots(validation, published)).toMatchObject({
      classification: 'matched', shared: 2, validationOnly: 0, publishedOnly: 0,
    });

    const changed = comparePublicationSnapshots(validation, {
      ...published,
      jobs: [{ url: 'https://jobs.example/1' }, { url: 'https://jobs.example/3' }],
    });
    expect(changed).toMatchObject({ classification: 'different_snapshot', shared: 1, validationOnly: 1, publishedOnly: 1 });
    expect(comparePublicationSnapshots(validation, {
      ...published,
      assembledAt: new Date(base + 8 * 60 * 60 * 1000).toISOString(),
    }).classification).toBe('near_time_delta');
    expect(comparePublicationSnapshots(validation, { ...published, runId: 'run-2' }))
      .toMatchObject({ classification: 'time_aligned_estimate', shared: 2, reason: 'run_id_mismatch' });
    expect(comparePublicationSnapshots(createValidationSnapshot([
      { url: 'https://jobs.example/1' },
    ], validationAt), published))
      .toMatchObject({ classification: 'time_aligned_estimate', reason: 'run_id_missing' });
    expect(comparePublicationSnapshots(validation, null).classification).toBe('missing');
  });

  it('requires a fresh non-empty public slice before marking a merged crawler production', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-first-crawl-'));
    const jobsDir = path.join(dir, 'jobs', 'by-crawler');
    fs.mkdirSync(jobsDir, { recursive: true });
    const now = Date.now();
    const store: any = {
      version: 2,
      candidates: {
        'empty.example': {
          key: 'empty.example', crawlerKey: 'empty-example', status: 'awaiting_first_crawl',
          promotedAt: new Date(now - 49 * 60 * 60 * 1000).toISOString(),
        },
        'ready.example': {
          key: 'ready.example', crawlerKey: 'ready-example', status: 'awaiting_first_crawl',
          promotedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        },
      },
    };
    fs.writeFileSync(path.join(jobsDir, 'empty-example.json'), JSON.stringify({ assembledAt: new Date(now).toISOString(), jobs: [] }));
    fs.writeFileSync(path.join(jobsDir, 'ready-example.json'), JSON.stringify({
      crawlerKey: 'ready-example', assembledAt: new Date(now).toISOString(), jobs: [{ url: 'https://jobs.example/1' }],
    }));

    const result = reconcileAwaitingFirstCrawls(store, { dataRoot: dir, now, ledgerFile: null });
    expect(result).toMatchObject({ verified: 1, pending: 0, escalated: 1, changed: 2 });
    expect(store.candidates['empty.example']).toMatchObject({
      status: 'awaiting_first_crawl', firstCrawlerOutputStatus: 'empty', firstCrawlerOutputAttention: true,
    });
    expect(store.candidates['ready.example']).toMatchObject({
      status: 'production', firstCrawlerOutputStatus: 'published', firstCrawlerJobCount: 1,
    });
  });
});
