import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkEmployerIdentity } from '../scripts/lib/prospector/employer-identity.mjs';
import {
  classifyValidationFailure,
  isValidationRetryDue,
  prioritizeValidationSpecs,
  validationRetryAt,
} from '../scripts/lib/prospector/validation-schedule.mjs';
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
    ], validationAt);
    const published = {
      assembledAt: new Date(base + 60 * 60 * 1000).toISOString(),
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
