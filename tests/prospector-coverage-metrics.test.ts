import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendCoverageHistory,
  measureCoverageExclusivity,
} from '../scripts/lib/prospector/coverage-exclusivity.mjs';
import { prioritizeSynthesisCandidates } from '../scripts/lib/prospector/synthesis-schedule.mjs';
import { prioritizeTraceCandidates } from '../scripts/lib/prospector/trace-priority.mjs';
import { prioritizeValidationSpecs } from '../scripts/lib/prospector/validation-schedule.mjs';
import { classifyStaffingEmployer, loadStaffingRegistry } from '../scripts/lib/prospector/seco-staffing-classifier.mjs';
import { staffingClassificationForCandidate } from '../scripts/lib/prospector/coverage-priority.mjs';
import { auditStaffingClassifier } from '../scripts/lib/prospector/staffing-classifier-audit.mjs';

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const tmpDirs: string[] = [];

function fixtureRoot({ includeAggregator = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-coverage-'));
  tmpDirs.push(root);
  fs.mkdirSync(path.join(root, 'jobs', 'by-crawler'), { recursive: true });
  fs.writeFileSync(path.join(root, 'seco-staffing-registry.json'), JSON.stringify({
    curated: true,
    fetchedAt: daysAgo(2),
    agencies: [{ name: 'Adecco Resources SA', type: 'placement-and-staffing' }],
  }));
  const officialJobs = [
    { id: 'adecco-1', company: 'Adecco', title: 'Tecnico elettrico', canton: 'TI', url: 'https://www.job-room.ch/job/adecco-1', crawledAt: daysAgo(1) },
    { id: 'adecco-2', company: 'Adecco', title: 'Assistente tecnico', canton: 'TI', url: 'https://www.job-room.ch/job/adecco-2', crawledAt: daysAgo(1) },
    { id: 'forno-1', company: 'Forno Piccolo Sagl', title: 'Panettiere', canton: 'TI', url: 'https://www.job-room.ch/job/forno-1', crawledAt: daysAgo(1) },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `small-${index}`,
      company: 'Piccola Industria SA',
      title: `Operaio linea ${index}`,
      canton: 'TI',
      url: `https://www.job-room.ch/job/small-${index}`,
      crawledAt: daysAgo(1),
    })),
    { id: 'acme-1', company: 'Acme SA', title: 'Tecnico supporto', canton: 'TI', url: 'https://www.job-room.ch/job/acme-1', crawledAt: daysAgo(1) },
  ];
  fs.writeFileSync(path.join(root, 'jobs', 'by-crawler', 'seco-jobroom.json'), JSON.stringify({
    assembledAt: daysAgo(1),
    runId: 'fixture-seco',
    jobs: officialJobs,
  }));
  if (includeAggregator) {
    fs.writeFileSync(path.join(root, 'jobs', 'by-crawler', 'jobs-ch-fixture.json'), JSON.stringify({
      assembledAt: daysAgo(1),
      jobs: [{
        id: 'board-adecco-1',
        company: 'Adecco',
        title: 'Tecnico elettrico',
        canton: 'TI',
        url: 'https://www.jobs.ch/en/vacancies/detail/board-adecco-1/',
      }, {
        id: 'board-acme-1',
        company: 'Acme Services',
        title: 'Tecnico supporto',
        canton: 'TI',
        url: 'https://www.jobs.ch/en/vacancies/detail/board-acme-1/',
      }],
    }));
  }
  return root;
}

function recentDirect(canton: string, key = canton) {
  return {
    key,
    name: 'Forno Piccolo Sagl',
    secoEmployerName: 'Forno Piccolo Sagl',
    canton,
    adCount: 1,
    sourceSeenAt: { seco: daysAgo(2) },
    secoEmployerClassification: 'direct',
    firstSeenAt: daysAgo(10),
  };
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('Prospector coverage exclusivity and staffing classification', () => {
  it('reads registry.agencies, matches brand aliases, and measures exclusive offers by canton and size', () => {
    const root = fixtureRoot();
    const registry = loadStaffingRegistry(path.join(root, 'seco-staffing-registry.json'));
    expect(classifyStaffingEmployer('Adecco', registry)).toMatchObject({
      classification: 'agency',
      matchedAgency: 'Adecco Resources SA',
      matchedAlias: 'adecco',
    });
    expect(classifyStaffingEmployer('Forno Piccolo Sagl', registry)).toMatchObject({
      classification: 'direct',
      confidence: 'curated-registry-and-signal-residual',
    });
    expect(classifyStaffingEmployer('leteam ressources humaines', registry)).toMatchObject({
      classification: 'agency',
      confidence: 'known-brand-signal',
    });
    expect(classifyStaffingEmployer('Müntener & Thomas Personal- und Unternehmensberatung AG', registry)).toMatchObject({
      classification: 'agency',
      confidence: 'name-signal',
    });
    expect(classifyStaffingEmployer('Azienda non dichiarata', registry, {
      offerCount: 12,
      cantons: ['TI', 'GR'],
      undisclosedCount: 2,
    })).toMatchObject({
      classification: 'agency',
      confidence: 'undisclosed-and-cross-canton-signal',
    });

    const metric = measureCoverageExclusivity({ dataRoot: root, now: daysAgo(0) });
    expect(metric).toMatchObject({ status: 'ok', population: {
      officialOffers: 9,
      aggregatorOffers: 2,
      aggregatorPortalOffers: 2,
      aggregatorMatchedOffers: 2,
      unmatchedOfficialOffers: 7,
      exclusiveOffers: null,
      exclusivityRate: null,
      measurementStatus: 'nonMisurabile',
    } });
    expect(metric.classification).toMatchObject({
      agency: { officialOffers: 2, aggregatorMatchedOffers: 1, unmatchedOfficialOffers: 1, exclusiveOffers: null },
      direct: { officialOffers: 7, aggregatorMatchedOffers: 1, unmatchedOfficialOffers: 6, exclusiveOffers: null },
      referenceEstimate: {
        estimatedAgencyShare: 0.31,
        referenceSnapshot: { officialOffers: 2432, adeccoOffers: 522 },
      },
    });
    expect(metric.byCantonAndSize.TI.micro).toMatchObject({
      officialOffers: 4,
      aggregatorMatchedOffers: 2,
      unmatchedOfficialOffers: 2,
      exclusiveOffers: null,
    });
    expect(metric.byCantonAndSize.TI.small).toMatchObject({
      officialOffers: 5,
      unmatchedOfficialOffers: 5,
      exclusiveOffers: null,
    });
    expect(metric.portals['jobs.ch']).toMatchObject({
      status: 'nonMisurabile',
      observed: true,
      aggregatorOffers: 2,
      matchedOfficialOffers: 2,
      exclusivityRate: null,
    });
    expect(metric.portals['jobup.ch']).toMatchObject({
      status: 'nonMisurabile',
      observed: false,
      aggregatorOffers: 0,
      exclusivityRate: null,
    });

    const historyPath = path.join(root, 'coverage-history.json');
    expect(appendCoverageHistory(metric, historyPath).runs).toHaveLength(1);
    expect(appendCoverageHistory(metric, historyPath).runs).toHaveLength(1);
  });

  it('marks an empty aggregator population non-measurable and invalidates the old false 100%', () => {
    const root = fixtureRoot({ includeAggregator: false });
    const metric = measureCoverageExclusivity({ dataRoot: root, now: daysAgo(0) });
    expect(metric.population).toMatchObject({
      aggregatorOffers: 0,
      aggregatorSlices: 0,
      aggregatorMatchedOffers: 0,
      exclusiveOffers: null,
      exclusivityRate: null,
      measurementStatus: 'nonMisurabile',
    });
    expect(metric.portals['jobs.ch']).toMatchObject({ status: 'nonMisurabile', observed: false });

    const historyPath = path.join(root, 'coverage-history.json');
    fs.writeFileSync(historyPath, JSON.stringify({
      schemaVersion: 1,
      metricVersion: 1,
      runs: [{
        runId: 'old-empty-corpus',
        status: 'ok',
        population: {
          officialOffers: 9,
          aggregatorOffers: 0,
          aggregatorSlices: 0,
          aggregatorMatchedOffers: 0,
          exclusiveOffers: 9,
          exclusivityRate: 1,
        },
      }],
    }));
    const history = appendCoverageHistory(metric, historyPath);
    expect(history.runs).toHaveLength(2);
    expect(history.runs.find((run) => run.runId === 'old-empty-corpus')).toMatchObject({
      status: 'invalidated',
      invalidatedReason: expect.stringContaining('popolazione aggregatori vuota'),
    });
  });

  it('returns unknown for malformed registry data instead of treating it as direct', () => {
    const root = fixtureRoot({ includeAggregator: false });
    const registryPath = path.join(root, 'malformed-registry.json');
    fs.writeFileSync(registryPath, '{');
    const registry = loadStaffingRegistry(registryPath);
    expect(registry).toMatchObject({ available: false, malformed: true });
    expect(classifyStaffingEmployer('leteam ressources humaines', registry)).toMatchObject({
      classification: 'unknown',
      confidence: 'malformed-registry',
    });
  });

  it('reports precision, recall, and residual examples from an independent manual sample', () => {
    const root = fixtureRoot({ includeAggregator: false });
    fs.mkdirSync(path.join(root, 'prospector'), { recursive: true });
    fs.writeFileSync(path.join(root, 'prospector', 'staffing-classifier-manual-sample.json'), JSON.stringify({
      sampleSize: 3,
      sampling: 'fixture top-three employers',
      manualBasis: 'fixture labels reviewed independently',
      labels: {
        'Piccola Industria SA': 'direct',
        Adecco: 'agency',
        'Acme SA': 'direct',
      },
    }));
    expect(auditStaffingClassifier({ dataRoot: root })).toMatchObject({
      status: 'ok',
      sampleSize: 3,
      precision: 1,
      recall: 1,
      residualErrors: { falsePositives: [], falseNegatives: [] },
    });
  });
});

describe('Prospector cross-stage coverage priority', () => {
  it('puts direct employers with fresh SECO demand ahead of agency candidates', () => {
    const agency = {
      ...recentDirect('TI', 'agency'),
      name: 'leteam ressources humaines',
      secoEmployerName: 'leteam ressources humaines',
      secoEmployerClassification: 'agency',
    };
    const directRecent = recentDirect('SG', 'direct-recent');
    const directOld = {
      ...recentDirect('GR', 'direct-old'),
      sourceSeenAt: { seco: daysAgo(31) },
    };
    expect(prioritizeTraceCandidates([agency, directOld, directRecent], 1, Date.now())[0].key)
      .toBe('direct-recent');
    expect(prioritizeSynthesisCandidates([agency, directOld, directRecent], 1, Date.now())[0].key)
      .toBe('direct-recent');
    const specs = [agency, directOld, directRecent].map((candidate) => ({ companyKey: candidate.key }));
    const candidates = Object.fromEntries([agency, directOld, directRecent].map((candidate) => [candidate.key, candidate]));
    expect(prioritizeValidationSpecs(specs, (spec) => candidates[spec.companyKey], {
      limit: 1,
      date: Date.now(),
    })[0].companyKey).toBe('direct-recent');
  });

  it('recomputes the shared classifier instead of trusting a stale persisted label', () => {
    const agency = {
      ...recentDirect('TI', 'agency-name-signal'),
      name: 'leteam ressources humaines',
      secoEmployerName: 'leteam ressources humaines',
      secoEmployerClassification: 'direct',
    };
    const direct = {
      ...recentDirect('GR', 'direct-name-signal'),
      name: 'Hamilton AG',
      secoEmployerName: 'Hamilton AG',
      secoEmployerClassification: 'agency',
    };
    expect(staffingClassificationForCandidate(agency)).toBe('agency');
    expect(staffingClassificationForCandidate(direct)).toBe('direct');
    expect(prioritizeTraceCandidates([agency, direct], 1, Date.now())[0].key).toBe('direct-name-signal');
    expect(prioritizeSynthesisCandidates([agency, direct], 1, Date.now())[0].key).toBe('direct-name-signal');
    const specs = [agency, direct].map((candidate) => ({ companyKey: candidate.key }));
    const candidates = Object.fromEntries([agency, direct].map((candidate) => [candidate.key, candidate]));
    expect(prioritizeValidationSpecs(specs, (spec) => candidates[spec.companyKey], {
      limit: 1,
      date: Date.now(),
    })[0].companyKey).toBe('direct-name-signal');
  });

  it('keeps the requested frontier order and reserves one rest-canton slot', () => {
    const frontier = ['TI', 'GR', 'VS'].map((canton) => recentDirect(canton));
    const rest = [{ key: 'ZH', canton: 'ZH', vacancyCount: 999, firstSeenAt: daysAgo(1) }];
    const now = Date.now();
    expect(prioritizeTraceCandidates([...frontier, ...rest], 4, now).map(({ canton }) => canton))
      .toEqual(['TI', 'GR', 'VS', 'ZH']);
    expect(prioritizeSynthesisCandidates([...frontier, ...rest], 4, now).map(({ canton }) => canton))
      .toEqual(['TI', 'GR', 'VS', 'ZH']);

    const specs = [...frontier, ...rest].map((candidate) => ({ companyKey: candidate.key, canton: candidate.canton }));
    const candidates = Object.fromEntries([...frontier, ...rest].map((candidate) => [candidate.key, candidate]));
    expect(prioritizeValidationSpecs(specs, (spec) => candidates[spec.companyKey], {
      limit: 4,
      date: now,
    }).map(({ canton }) => canton)).toEqual(['TI', 'GR', 'VS', 'ZH']);
  });
});
