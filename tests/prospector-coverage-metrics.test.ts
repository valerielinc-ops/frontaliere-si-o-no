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

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const tmpDirs: string[] = [];

function fixtureRoot() {
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
  ];
  fs.writeFileSync(path.join(root, 'jobs', 'by-crawler', 'seco-jobroom.json'), JSON.stringify({
    assembledAt: daysAgo(1),
    runId: 'fixture-seco',
    jobs: officialJobs,
  }));
  fs.writeFileSync(path.join(root, 'jobs', 'by-crawler', 'jobs-ch-fixture.json'), JSON.stringify({
    assembledAt: daysAgo(1),
    jobs: [{
      id: 'board-adecco-1',
      company: 'Adecco',
      title: 'Tecnico elettrico',
      canton: 'TI',
      url: 'https://www.jobs.ch/en/vacancies/detail/board-adecco-1/',
    }],
  }));
  return root;
}

function recentDirect(canton: string, key = canton) {
  return {
    key,
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
      confidence: 'curated-registry-residual',
    });

    const metric = measureCoverageExclusivity({ dataRoot: root, now: daysAgo(0) });
    expect(metric).toMatchObject({ status: 'ok', population: {
      officialOffers: 8,
      aggregatorOffers: 1,
      aggregatorMatchedOffers: 1,
      exclusiveOffers: 7,
    } });
    expect(metric.classification).toMatchObject({
      agency: { officialOffers: 2, aggregatorMatchedOffers: 1, exclusiveOffers: 1 },
      direct: { officialOffers: 6, aggregatorMatchedOffers: 0, exclusiveOffers: 6 },
      referenceEstimate: {
        estimatedAgencyShare: 0.31,
        referenceSnapshot: { officialOffers: 2432, adeccoOffers: 522 },
      },
    });
    expect(metric.byCantonAndSize.TI.micro).toMatchObject({
      officialOffers: 3,
      aggregatorMatchedOffers: 1,
      exclusiveOffers: 2,
    });
    expect(metric.byCantonAndSize.TI.small).toMatchObject({
      officialOffers: 5,
      exclusiveOffers: 5,
    });

    const historyPath = path.join(root, 'coverage-history.json');
    expect(appendCoverageHistory(metric, historyPath).runs).toHaveLength(1);
    expect(appendCoverageHistory(metric, historyPath).runs).toHaveLength(1);
  });
});

describe('Prospector cross-stage coverage priority', () => {
  it('puts direct employers with fresh SECO demand ahead of agency candidates', () => {
    const agency = { ...recentDirect('TI', 'agency'), secoEmployerClassification: 'agency' };
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
