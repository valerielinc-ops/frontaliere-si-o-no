import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PROFESSION_CANTON_KEYS,
  buildProfessionCantonPath,
} from '../build-plugins/professionCantonData';
import {
  ALL_CANTON_PROFESSION_IDS,
  PROFESSION_LOCALES,
  type AnyProfessionId,
} from '../build-plugins/professionLandingsData';

type Evidence = {
  schemaVersion: number;
  issue: number;
  evidenceKind: string;
  historicalRun: { runId: string; previousCount: number; currentCount: number };
  sourceCommit: string;
  jobsDatasetSha256: string;
  generatorSha256: string;
  minimumJobs: number;
  localeCount: number;
  emitter: {
    pagesWritten: number;
    bridgesWritten: number;
    pagesSkippedForJobs: number;
    pagesSkippedForWordCount: number;
    sitemapUrlCount: number;
    sitemapUrlsSha256: string;
  };
  qualifyingPairs: string[];
};

const fixturePath = resolve(
  import.meta.dirname,
  'fixtures/issue-9246-profession-cantons-authoritative.json',
);
const evidence = JSON.parse(readFileSync(fixturePath, 'utf8')) as Evidence;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('issue #9246 — authoritative profession-canton inventory', () => {
  it('reconstructs the measured emitter sitemap from real qualifying pairs, without an arithmetic waiver', () => {
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      issue: 9246,
      evidenceKind: 'tracked-jobs-profession-canton-emitter',
      minimumJobs: 3,
      localeCount: PROFESSION_LOCALES.length,
    });
    expect(evidence.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(evidence.jobsDatasetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.generatorSha256).toBe(sha256(readFileSync(
      resolve(import.meta.dirname, '../build-plugins/professionCantonLandings.ts'),
      'utf8',
    )));

    const seenPairs = new Set<string>();
    const urls: string[] = [];
    for (const encoded of evidence.qualifyingPairs) {
      const [cantonKey, professionId, rawLiveCount] = encoded.split('|');
      const pairKey = `${cantonKey}|${professionId}`;
      expect(seenPairs.has(pairKey), pairKey).toBe(false);
      seenPairs.add(pairKey);
      expect(PROFESSION_CANTON_KEYS).toContain(cantonKey);
      expect(ALL_CANTON_PROFESSION_IDS).toContain(professionId);
      expect(Number(rawLiveCount)).toBeGreaterThanOrEqual(evidence.minimumJobs);
      for (const locale of PROFESSION_LOCALES) {
        const path = buildProfessionCantonPath(
          locale,
          cantonKey as (typeof PROFESSION_CANTON_KEYS)[number],
          professionId as AnyProfessionId,
        );
        urls.push(`https://frontaliereticino.ch${path}`);
      }
    }

    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).toHaveLength(evidence.emitter.pagesWritten);
    expect(evidence.emitter.sitemapUrlCount).toBe(evidence.emitter.pagesWritten);
    expect(evidence.emitter.pagesSkippedForWordCount).toBe(0);
    expect(sha256([...urls].sort().join('\n'))).toBe(evidence.emitter.sitemapUrlsSha256);
    expect(evidence.emitter.pagesWritten).toBeGreaterThan(evidence.historicalRun.previousCount);
    expect(evidence.emitter.pagesWritten).toBeGreaterThan(evidence.historicalRun.currentCount);
  });
});
