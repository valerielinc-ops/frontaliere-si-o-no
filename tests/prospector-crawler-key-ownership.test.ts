import { describe, expect, it } from 'vitest';
import {
  crawlerKeyFor,
  disambiguateCrawlerKey,
  findMiskeyedCandidates,
} from '../scripts/lib/prospector/synthesize.mjs';
import { requeueMiskeyedCandidate } from '../scripts/lib/prospector/candidate-store.mjs';
import { evaluatePromotion } from '../scripts/lib/prospector/promotion-gate.mjs';
import { KNOWN_AGGREGATOR_DOMAINS } from '../scripts/lib/known-aggregator-domains.mjs';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('crawlerKeyFor — vendor host labels', () => {
  it('does not key an employer on a shared board label', () => {
    // `my.jobalino.ch` serves many employers; `my` collided with a live crawler.
    expect(crawlerKeyFor({ tenantHost: 'my.jobalino.ch', name: 'IBB Energie AG', domain: 'ibbrugg.ch' }))
      .toBe('ibb-energie-ag');
    expect(crawlerKeyFor({ tenantHost: 'link.ostendis.com', name: 'Wassermann&Company AG', domain: 'wassermann-company.ch' }))
      .toBe('wassermann-company-ag');
  });

  it('replaces a readable label the employer domain contradicts', () => {
    // `company.sbb.ch` reached production as crawler key `company` for elvetino.
    expect(crawlerKeyFor({ tenantHost: 'company.sbb.ch', name: 'elvetino', domain: 'elvetino.ch' }))
      .toBe('elvetino');
    expect(crawlerKeyFor({ tenantHost: 'ch.talent.com', name: 'Global Sana', domain: 'globalsana.ch' }))
      .toBe('global-sana');
  });

  it('falls back to the employer domain when the name is not corroborated by it', () => {
    expect(crawlerKeyFor({ tenantHost: 'rekrutierung.stgag.ch', name: 'Ospedale', domain: 'thurmed-immobilien.ch' }))
      .toBe('thurmed-immobilien-ch');
  });

  it('keeps a tenant label that names the employer', () => {
    expect(crawlerKeyFor({ tenantHost: 'chmedia.recruitee.com', name: 'CH Media', domain: 'chmedia.ch' })).toBe('chmedia');
    expect(crawlerKeyFor({ tenantHost: 'vaudoise.softgarden.io', name: 'Vaudoise Assurances' })).toBe('vaudoise');
  });

  it('does not trust a vendor-only identity to contradict the tenant label', () => {
    // careers-page.com tenants carry the vendor (Manatal) as name and host:
    // the label is still the only employer-specific identity.
    expect(crawlerKeyFor({ tenantHost: 'bluedotbpo.careers-page.com', name: 'Manatal', domain: 'bluedotbpo.careers-page.com' }))
      .toBe('bluedotbpo');
  });
});

describe('disambiguateCrawlerKey', () => {
  it('returns the key untouched when it is free', () => {
    expect(disambiguateCrawlerKey('acme', { domain: 'acme.ch' }, () => false)).toBe('acme');
  });

  it('never hands out a key that is taken', () => {
    const taken = new Set(['my', 'teo-jakob-ch']);
    expect(disambiguateCrawlerKey('my', { domain: 'stiftung-helsenberg.ch' }, (k) => taken.has(k)))
      .toBe('stiftung-helsenberg-ch');
    expect(disambiguateCrawlerKey('teo-jakob-ch', { domain: 'teojakob.ch' }, (k) => taken.has(k) || k === 'teojakob-ch'))
      .toBe('teo-jakob-ch-teojakob-ch');
    const all = new Set(['wepractice', 'wepractice-ch', 'wepractice-wepractice-ch']);
    expect(disambiguateCrawlerKey('wepractice', { domain: 'wepractice.ch' }, (k) => all.has(k))).toBe('wepractice-2');
  });
});

describe('findMiskeyedCandidates', () => {
  const productionKeys = new Set(['my']);
  const specFor = (key: string) => (key === 'my' ? { companyName: 'Teo Jakob AG' } : null);

  it('sends shared-label candidates back to synthesis', () => {
    const hits = findMiskeyedCandidates([
      { key: 'ibbrugg.ch', status: 'promoted', crawlerKey: 'my', tenantHost: 'my.jobalino.ch', name: 'IBB Energie AG', domain: 'ibbrugg.ch' },
      { key: 'tkb.ch', status: 'synthesized', crawlerKey: 'jobportal', tenantHost: 'app.jobportal.abaservices.ch', name: 'Thurgauer Kantonalbank', domain: 'tkb.ch' },
    ], { productionKeys, specFor });
    expect(hits.map((h) => [h.candidate.key, h.from, h.to])).toEqual([
      ['ibbrugg.ch', 'my', 'ibb-energie-ag'],
      ['tkb.ch', 'jobportal', 'tkb-ch'],
    ]);
  });

  it('leaves alone the owner of the live crawler, opaque ids and production rows', () => {
    const hits = findMiskeyedCandidates([
      { key: 'teo-jakob@liebefeld', status: 'promoted', crawlerKey: 'my', tenantHost: 'my.jobalino.ch', name: 'Teo Jakob AG', domain: 'teojakob.ch' },
      { key: 'recruitingapp-2896@umantis.com', status: 'validated', crawlerKey: 'recruitingapp-2896', tenantHost: 'recruitingapp-2896.umantis.com', name: 'GZ Dielsdorf' },
      { key: 'seilbahnen.ch', status: 'production', crawlerKey: 'my', tenantHost: 'my.jobalino.ch', name: 'Inauen-Schätti AG', domain: 'seilbahnen.ch' },
    ], { productionKeys, specFor });
    expect(hits).toEqual([]);
  });

  it('fails closed when the production spec cannot be read', () => {
    const hits = findMiskeyedCandidates([
      { key: 'ibbrugg.ch', status: 'promoted', crawlerKey: 'my', tenantHost: 'my.jobalino.ch', name: 'IBB Energie AG', domain: 'ibbrugg.ch' },
    ], {
      productionKeys,
      specFor: () => { throw new SyntaxError('malformed production spec'); },
    });
    expect(hits).toEqual([]);
  });
});

describe('requeueMiskeyedCandidate', () => {
  it('rewinds to traced, drops the borrowed history and records the rekey', () => {
    const store = {
      candidates: {
        'ibbrugg.ch': {
          key: 'ibbrugg.ch',
          status: 'promoted',
          crawlerKey: 'my',
          qualityScore: 1,
          qualityVerdict: 'good',
          validationHistory: [{ at: daysAgo(2), verdict: 'good' }],
        },
      },
      aliases: {},
    };
    const c = requeueMiskeyedCandidate(store as any, 'ibbrugg.ch', { from: 'my', to: 'ibb-energie-ag' }, null);
    expect(c).toMatchObject({ status: 'traced', rekeyedFrom: 'my', validationHistory: [] });
    expect(c?.crawlerKey).toBeUndefined();
    expect(c?.qualityVerdict).toBeUndefined();
    expect(typeof c?.rekeyedAt).toBe('string');
    expect(requeueMiskeyedCandidate(store as any, 'ibbrugg.ch', { from: 'my', to: 'x' }, null)).toBeNull();
  });
});

describe('rekey batch ownership', () => {
  it('leaves candidates beyond synthesisLimit eligible for the next run', () => {
    const candidates = Array.from({ length: 26 }, (_, index) => ({
      key: `employer-${index}.ch`,
      status: 'promoted',
      crawlerKey: 'my',
      tenantHost: 'my.jobalino.ch',
      name: `Employer ${index}`,
      domain: `employer-${index}.ch`,
    }));
    const hits = findMiskeyedCandidates(candidates, {
      productionKeys: new Set(['my']),
      specFor: () => ({ companyName: 'Vendor label' }),
    });
    expect(hits).toHaveLength(26);
    const firstBatch = hits.slice(0, 25);
    const deferred = hits.slice(25);
    expect(firstBatch).toHaveLength(25);
    expect(deferred[0].candidate.status).toBe('promoted');
    expect(deferred[0].candidate.crawlerKey).toBe('my');
    expect(findMiskeyedCandidates(deferred.map(({ candidate }) => candidate), {
      productionKeys: new Set(['my']),
      specFor: () => ({ companyName: 'Vendor label' }),
    })).toHaveLength(1);
  });
});

describe('promotion gate', () => {
  const good = (at: string) => ({
    at,
    qualityContractVersion: 3,
    verdict: 'good',
    score: 1,
    vacancyCount: 4,
    sampled: 3,
    reachableRate: 1,
    titleMatchRate: 1,
    contentfulRate: 1,
    locationSourceRate: 1,
    distinctRate: 1,
    jobLikeEvidenceRate: 1,
    employerIdentityRate: 1,
    employerIdentityMismatchCount: 0,
    logoFound: true,
    runtimeSnapshotComplete: true,
  });
  const candidate = (patch: Record<string, unknown> = {}) => ({
    key: 'acme.ch',
    status: 'promoted',
    crawlerKey: 'acme',
    qualityContractVersion: 3,
    vacancyCount: 4,
    validationHistory: [good(daysAgo(3)), good(daysAgo(2))],
    ...patch,
  });

  it('passes the baseline candidate', () => {
    expect(evaluatePromotion(candidate()).passed).toBe(true);
  });

  it('ignores gradings older than a rekey', () => {
    const result = evaluatePromotion(candidate({ rekeyedAt: daysAgo(1) }));
    expect(result.checks.runs).toBe(false);
    expect(result.checks.days).toBe(false);
  });

  it('refuses a candidate read from a known aggregator domain', () => {
    expect(KNOWN_AGGREGATOR_DOMAINS.has('talent.com')).toBe(true);
    const result = evaluatePromotion(candidate({
      tenantHost: 'ch.talent.com',
      careersUrl: 'https://ch.talent.com/view?id=554547064889945322',
    }));
    expect(result.checks.notAggregator).toBe(false);
    expect(result.reasons.join(' ')).toContain('talent.com');
  });
});
