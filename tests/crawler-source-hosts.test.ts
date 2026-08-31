/**
 * The same employer, published twice — detection tests.
 *
 * These pin the machinery added after `eoc-candidati-posizioni` was
 * auto-promoted alongside `eoc-ente-ospedaliero-cantonale`: both crawlers read
 * the Umantis tenant `recruitingapp-2761.umantis.com`, so the site carried two
 * company identities for one hospital group, and three real vacancies existed
 * only under the fake one.
 *
 * Every fixture below is written against a temporary `data/jobs/by-crawler`
 * tree rather than the repo's own slices, so the assertions stay true as the
 * real corpus changes.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSourceHostOwnership, findOverlappingCrawlers, matchExistingCrawler,
  normalizeSourceHost, normalizeJobUrl, isSliceFile,
} from '../scripts/lib/crawler-source-hosts.mjs';
import { classifyFindings } from '../scripts/audit-duplicate-crawler-companies.mjs';
import { isCovered } from '../scripts/lib/prospector/coverage.mjs';

const UMANTIS = 'https://recruitingapp-2761.umantis.com';
const LOBBY = 'https://jobs.smartrecruiters.com';

let root: string;

/** Write a slice in the real shape: `{ crawlerKey, jobs: [...] }`. */
function slice(
  key: string,
  jobs: { url: string; companyKey?: string; title?: string; crawlerMissStreak?: number; expiredAt?: string }[],
  assembledAt = '2026-08-25T00:00:00.000Z',
) {
  const payload = {
    crawlerKey: key,
    assembledAt,
    jobs: jobs.map((j) => ({
      companyKey: j.companyKey ?? key,
      title: j.title ?? 'Ruolo',
      url: j.url,
      ...(j.crawlerMissStreak ? { crawlerMissStreak: j.crawlerMissStreak } : {}),
      ...(j.expiredAt ? { expiredAt: j.expiredAt } : {}),
    })),
  };
  fs.writeFileSync(path.join(root, 'data', 'jobs', 'by-crawler', `${key}.json`), JSON.stringify(payload, null, 1));
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-hosts-'));
  fs.mkdirSync(path.join(root, 'data', 'jobs', 'by-crawler'), { recursive: true });

  // The real shape of the bug: one tenant, two crawler identities. The
  // established crawler holds the bulk of the tenant (167 vacancies in
  // production); the twin shares 2 of its 3 and holds one the main crawler
  // never saw. The size difference is what marks the established one as the
  // crawler to keep and the twin as the witness.
  slice('eoc-ente-ospedaliero-cantonale', [
    ...Array.from({ length: 8 }, (_, i) => ({ url: `${UMANTIS}/Vacancies/${900 + i}/Description/4` })),
    { url: `${UMANTIS}/Vacancies/2741/Description/4` },
    { url: `${UMANTIS}/Vacancies/2764/Description/4` },
  ]);
  slice('eoc-candidati-posizioni', [
    { url: `${UMANTIS}/Vacancies/2741/Description/4` },
    { url: `${UMANTIS}/Vacancies/2764/Description/4` },
    // The symptom the reader reported: real, live, and only here.
    { url: `${UMANTIS}/Vacancies/2762/Description/4`, title: "Collaboratrice-ore dell'economia domestica a ore Collaboratrice-ore dell" },
  ]);

  // Two genuinely different employers behind one hosted-ATS lobby.
  slice('hug', [{ url: `${LOBBY}/hug/743999` }, { url: `${LOBBY}/hug/744000` }]);
  slice('cern', [{ url: `${LOBBY}/cern/500001` }, { url: `${LOBBY}/cern/500002` }]);

  // A scratch companion, which must not count as a crawler of its own.
  slice('eoc-ente-ospedaliero-cantonale-locale-cache', [{ url: `${UMANTIS}/Vacancies/931/Description/4` }]);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('source-host ownership', () => {
  it('treats a host used by one crawler as that employer, and a shared lobby as nobody', () => {
    const own = loadSourceHostOwnership(root);
    // Two crawler keys read the Umantis tenant, so it identifies neither.
    expect(own.sharedHosts.has('recruitingapp-2761.umantis.com')).toBe(true);
    expect(own.dedicatedHosts.has('recruitingapp-2761.umantis.com')).toBe(false);
    // The SmartRecruiters lobby fronts two employers — also not an identity.
    expect(own.sharedHosts.has('jobs.smartrecruiters.com')).toBe(true);
  });

  it('ignores scratch companions the way the dataset assembler does', () => {
    expect(isSliceFile('eoc-ente-ospedaliero-cantonale.json')).toBe(true);
    expect(isSliceFile('coop-ticino-locale-cache.json')).toBe(false);
    expect(isSliceFile('foo.cleanup-tmp.json')).toBe(false);
    const own = loadSourceHostOwnership(root);
    expect(own.slices.map((s) => s.key)).not.toContain('eoc-ente-ospedaliero-cantonale-locale-cache');
  });

  it('normalises hosts and job URLs so two spellings compare equal', () => {
    expect(normalizeSourceHost('WWW.Example.CH:443')).toBe('example.ch');
    expect(normalizeJobUrl('https://Host.ch/Job/1/?utm=x#top')).toBe('https://host.ch/job/1');
    expect(normalizeJobUrl("https://www.concorsi.ti.ch/offerte-d'impieghi.html?sid=abc&yid=4264"))
      .toBe("https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4264");
  });

  it('survives a sparse checkout with no slices at all', () => {
    const empty = loadSourceHostOwnership(path.join(root, 'nope'));
    expect(empty.slices).toEqual([]);
    expect(empty.dedicatedHosts.size).toBe(0);
  });
});

describe('isCovered — exact source host', () => {
  it('covers a tenant we already crawl even when the name shares nothing', () => {
    // `EOC candiDati Posizioni` vs `EOC – Ente Ospedaliero Cantonale` share only
    // the 3-char token `eoc`, below the length guards name matching uses on
    // purpose. The host is the signal that works.
    const coverage = {
      keys: new Set<string>(), names: new Set<string>(), domains: new Set<string>(),
      hosts: new Set(['recruitingapp-2761.umantis.com']), crawlerCount: 1,
    };
    expect(isCovered(coverage, { name: 'EOC candiDati Posizioni', sourceHost: 'recruitingapp-2761.umantis.com' }))
      .toMatchObject({ covered: true, via: 'source-host' });
  });

  it('does NOT claim a different tenant of the same vendor', () => {
    // The false positive the registrable-domain fold would have introduced:
    // `umantis.com` is the vendor's, and claiming it swallows every tenant.
    const coverage = {
      keys: new Set<string>(), names: new Set<string>(), domains: new Set<string>(),
      hosts: new Set(['recruitingapp-2761.umantis.com']), crawlerCount: 1,
    };
    expect(isCovered(coverage, { name: 'Tschuggen Hotel Group', sourceHost: 'recruitingapp-2904.umantis.com' }).covered)
      .toBe(false);
  });

  it('still works for a coverage index built before hosts existed', () => {
    const legacy = { keys: new Set(['artisa-group']), names: new Set(['artisa']), domains: new Set<string>(), crawlerCount: 1 };
    expect(isCovered(legacy, { name: 'Polverini Spazzacamino Sagl', sourceHost: 'x.example.ch' }).covered).toBe(false);
    expect(isCovered(legacy, { name: 'Artisa Group SA' }).covered).toBe(true);
  });
});

describe('overlap between crawlers', () => {
  it('pairs the two EOC crawlers by shared vacancy URL, not by title', () => {
    const own = loadSourceHostOwnership(root, { urls: true });
    const pairs = findOverlappingCrawlers(own);
    const eoc = pairs.find((p) => p.keys.includes('eoc-candidati-posizioni'));
    expect(eoc).toBeTruthy();
    expect(eoc!.keys).toEqual(['eoc-candidati-posizioni', 'eoc-ente-ospedaliero-cantonale']);
    expect(eoc!.shared).toHaveLength(2);
  });

  it('does not pair two employers that merely share a lobby host', () => {
    const own = loadSourceHostOwnership(root, { urls: true });
    const pairs = findOverlappingCrawlers(own);
    expect(pairs.some((p) => p.keys.includes('hug') && p.keys.includes('cern'))).toBe(false);
  });

  it('does not collapse distinct query-identified vacancies onto one listing URL', () => {
    const base = "https://www.concorsi.ti.ch/offerte-d'impieghi.html";
    slice('query-id-a', [{ url: `${base}?yid=4264&sid=session-a` }]);
    slice('query-id-b', [{ url: `${base}?sid=session-b&yid=4265` }]);

    const own = loadSourceHostOwnership(root, { urls: true });
    const pairs = findOverlappingCrawlers(own);
    expect(pairs.some((p) => p.keys.includes('query-id-a') && p.keys.includes('query-id-b')))
      .toBe(false);
  });
});

describe('audit findings', () => {
  it('reports the duplicate identity AND the coverage gap it exposes', () => {
    const own = loadSourceHostOwnership(root, { urls: true });
    const { duplicates, gaps } = classifyFindings(findOverlappingCrawlers(own));

    expect(duplicates.some((d) => d.keys.includes('eoc-candidati-posizioni'))).toBe(true);

    // The valuable half: the crawler we KEEP is missing a live vacancy that the
    // twin found. Vacancy 2762 is the one a reader reported.
    const gap = gaps.find((g) => g.key === 'eoc-ente-ospedaliero-cantonale');
    expect(gap).toBeTruthy();
    expect(gap!.twin).toBe('eoc-candidati-posizioni');
    expect(gap!.missing).toEqual([`${UMANTIS}/vacancies/2762/description/4`]);
  });

  it('does not call a group crawler\'s wider catalogue a gap', () => {
    // `coop-ticino` legitimately covers Fust's postings and thousands more.
    // Reporting "coop-ticino has 2422 vacancies Fust lacks" buried the real
    // finding under 14'697 phantom gaps before the direction was fixed.
    const big = Array.from({ length: 40 }, (_, i) => ({ url: `https://jobs.fust.ch/job/${i}` }));
    const small = big.slice(0, 20);
    slice('group-crawler', big);
    slice('brand-crawler', small);
    const own = loadSourceHostOwnership(root, { urls: true });
    const { gaps } = classifyFindings(findOverlappingCrawlers(own));
    expect(gaps.some((g) => g.key === 'brand-crawler')).toBe(false);
  });

  it('finds nothing when two crawlers share no vacancy', () => {
    const own = loadSourceHostOwnership(root, { urls: true });
    const pairs = findOverlappingCrawlers(own).filter((p) => p.keys.includes('hug') || p.keys.includes('cern'));
    expect(pairs).toHaveLength(0);
  });

  it('does not report a grace-period carry-over as a live coverage gap', () => {
    const shared = Array.from({ length: 6 }, (_, i) => ({ url: `https://retained.example.ch/job/${i}` }));
    slice('retained-keeper', shared);
    slice('retained-witness', [
      ...shared.slice(0, 4),
      { url: 'https://retained.example.ch/job/expired', crawlerMissStreak: 1 },
    ]);

    const own = loadSourceHostOwnership(root, { urls: true });
    const pair = findOverlappingCrawlers(own).find((p) => p.keys.includes('retained-keeper'));
    expect(pair?.onlyB).toEqual(['https://retained.example.ch/job/expired']);
    expect(pair?.activeOnlyB).toEqual([]);
    const findings = classifyFindings(pair ? [pair] : []);
    expect(findings.gaps).toEqual([]);
    expect(findings.ignored).toMatchObject([
      { key: 'retained-keeper', twin: 'retained-witness', reason: 'grace-period-retained' },
    ]);
  });

  it('does not report an expired archive-shaped record as a live coverage gap', () => {
    const shared = Array.from({ length: 6 }, (_, i) => ({ url: `https://expired.example.ch/job/${i}` }));
    slice('expired-keeper', shared);
    slice('expired-witness', [
      ...shared.slice(0, 4),
      { url: 'https://expired.example.ch/job/archived', expiredAt: '2026-08-31T00:00:00.000Z' },
    ]);

    const own = loadSourceHostOwnership(root, { urls: true });
    const pair = findOverlappingCrawlers(own).find((p) => p.keys.includes('expired-keeper'));
    expect(pair?.onlyB).toEqual(['https://expired.example.ch/job/archived']);
    expect(pair?.activeOnlyB).toEqual([]);
    expect(classifyFindings(pair ? [pair] : []).gaps).toEqual([]);
  });

  it('does not compare crawler snapshots from different daily cycles', () => {
    const shared = Array.from({ length: 6 }, (_, i) => ({ url: `https://skew.example.ch/job/${i}` }));
    slice('skew-keeper', shared, '2026-08-31T05:00:00.000Z');
    slice(
      'skew-witness',
      [...shared.slice(0, 4), { url: 'https://skew.example.ch/job/then-live' }],
      '2026-08-28T05:00:00.000Z',
    );

    const own = loadSourceHostOwnership(root, { urls: true });
    const pair = findOverlappingCrawlers(own).find((p) => p.keys.includes('skew-keeper'));
    expect(pair?.snapshotSkewMs).toBe(3 * 24 * 60 * 60 * 1000);
    const findings = classifyFindings(pair ? [pair] : []);
    expect(findings.gaps).toEqual([]);
    expect(findings.ignored).toMatchObject([
      { key: 'skew-keeper', twin: 'skew-witness', reason: 'snapshot-skew' },
    ]);
  });

  it('still reports a fresh witness gap when the keeper snapshot is the stale side', () => {
    const shared = Array.from({ length: 6 }, (_, i) => ({ url: `https://stale-keeper.example.ch/job/${i}` }));
    slice('stale-keeper', shared, '2026-08-28T05:00:00.000Z');
    slice(
      'fresh-witness',
      [...shared.slice(0, 4), { url: 'https://stale-keeper.example.ch/job/new-live' }],
      '2026-08-31T05:00:00.000Z',
    );

    const own = loadSourceHostOwnership(root, { urls: true });
    const pair = findOverlappingCrawlers(own).find((p) => p.keys.includes('stale-keeper'));
    expect(pair?.olderSnapshotKey).toBe('stale-keeper');
    const findings = classifyFindings(pair ? [pair] : []);
    expect(findings.gaps).toMatchObject([
      { key: 'stale-keeper', twin: 'fresh-witness', missing: ['https://stale-keeper.example.ch/job/new-live'] },
    ]);
    expect(findings.ignored).toEqual([]);
  });

  it.each([
    {
      label: 'A active keeper, B raw carry-over',
      onlyA: ['live-a-1', 'live-a-2'],
      onlyB: Array.from({ length: 100 }, (_, i) => `retained-b-${i}`),
      activeOnlyA: ['live-a-1', 'live-a-2'],
      activeOnlyB: [],
      activeTotalA: 10,
      activeTotalB: 8,
      keeper: 'active-a',
      witness: 'active-b',
    },
    {
      label: 'B active keeper, A raw carry-over',
      onlyA: Array.from({ length: 100 }, (_, i) => `retained-a-${i}`),
      onlyB: ['live-b-1', 'live-b-2'],
      activeOnlyA: [],
      activeOnlyB: ['live-b-1', 'live-b-2'],
      activeTotalA: 8,
      activeTotalB: 10,
      keeper: 'active-b',
      witness: 'active-a',
    },
  ])('elects by ACTIVE cardinality: $label', ({
    onlyA,
    onlyB,
    activeOnlyA,
    activeOnlyB,
    activeTotalA,
    activeTotalB,
    keeper,
    witness,
  }) => {
    const shared = Array.from({ length: 8 }, (_, i) => `shared-${i}`);
    const findings = classifyFindings([{
      keys: ['active-a', 'active-b'],
      shared,
      onlyA,
      onlyB,
      activeShared: shared,
      activeOnlyA,
      activeOnlyB,
      activeTotalA,
      activeTotalB,
    }]);

    expect(findings.gaps).toEqual([]);
    expect(findings.ignored).toMatchObject([
      { key: keeper, twin: witness, reason: 'grace-period-retained' },
    ]);
  });

  it('keeps raw-cardinality compatibility when active metadata is absent', () => {
    const shared = Array.from({ length: 8 }, (_, i) => `legacy-shared-${i}`);
    const onlyA = ['legacy-live-a-1', 'legacy-live-a-2'];
    const findings = classifyFindings([{
      keys: ['legacy-a', 'legacy-b'],
      shared,
      onlyA,
      onlyB: Array.from({ length: 100 }, (_, i) => `legacy-b-${i}`),
    }]);

    // Raw B is larger, exactly matching the pre-active-metadata election.
    expect(findings.gaps).toEqual([
      { key: 'legacy-b', twin: 'legacy-a', missing: onlyA },
    ]);
    expect(findings.ignored).toEqual([]);
  });

  it.each([
    ['confederazione-ticino', 'agroscope'],
    ['confederazione-ticino', 'vtg'],
    ['confederazione-ticino', 'agroscope-defr'],
    ['posta-svizzera-centro-regionale', 'postauto'],
    ['migros-ticino', 'denner'],
    ['migros-ticino', 'migrolino'],
  ])('treats source ownership %s / %s as unordered when cardinality reverses', (broad, dedicated) => {
    const shared = Array.from({ length: 5 }, (_, i) => ({ url: `https://${dedicated}.example.ch/job/${i}` }));
    const broadOnly = Array.from({ length: 5 }, (_, i) => ({ url: `https://${broad}.example.ch/job/broad-${i}` }));
    const dedicatedOnly = Array.from({ length: 5 }, (_, i) => ({ url: `https://${dedicated}.example.ch/job/dedicated-${i}` }));

    // Normal production shape: broad group is bigger, dedicated side exposes
    // two brand-owned vacancies that the group deliberately excludes.
    slice(broad, [...shared.slice(0, 3), ...broadOnly]);
    slice(dedicated, shared);

    let own = loadSourceHostOwnership(root, { urls: true });
    let pair = findOverlappingCrawlers(own).find(
      (p) => p.keys.includes(broad) && p.keys.includes(dedicated),
    );
    let findings = classifyFindings(pair ? [pair] : []);
    expect(findings.gaps).toEqual([]);
    expect(findings.ignored).toMatchObject([
      { key: broad, twin: dedicated, reason: 'source-ownership' },
    ]);

    // Reverse the cardinality. The ownership contract is unchanged even though
    // the audit now elects the dedicated crawler as `keeper`.
    slice(broad, shared);
    slice(dedicated, [...shared.slice(0, 3), ...dedicatedOnly]);

    own = loadSourceHostOwnership(root, { urls: true });
    pair = findOverlappingCrawlers(own).find(
      (p) => p.keys.includes(broad) && p.keys.includes(dedicated),
    );
    findings = classifyFindings(pair ? [pair] : []);
    expect(findings.gaps).toEqual([]);
    expect(findings.ignored).toMatchObject([
      { key: dedicated, twin: broad, reason: 'source-ownership' },
    ]);
  });

  it('keeps a cardinality-reversed pair as a gap when no ownership contract is registered', () => {
    const shared = Array.from({ length: 5 }, (_, i) => ({ url: `https://unregistered.example.ch/job/${i}` }));
    slice('unregistered-broad', shared);
    slice('unregistered-dedicated', [
      ...shared.slice(0, 3),
      ...Array.from({ length: 5 }, (_, i) => ({ url: `https://unregistered.example.ch/job/own-${i}` })),
    ]);

    const own = loadSourceHostOwnership(root, { urls: true });
    const pair = findOverlappingCrawlers(own).find(
      (p) => p.keys.includes('unregistered-broad') && p.keys.includes('unregistered-dedicated'),
    );
    const findings = classifyFindings(pair ? [pair] : []);
    expect(findings.gaps).toMatchObject([
      { key: 'unregistered-dedicated', twin: 'unregistered-broad', missing: expect.any(Array) },
    ]);
    expect(findings.ignored).toEqual([]);
  });
});

describe('matchExistingCrawler — the prospector-side guard', () => {
  it('rejects a candidate whose vacancies we mostly already carry', () => {
    const own = loadSourceHostOwnership(root, { urls: true });
    const scraped = [
      `${UMANTIS}/Vacancies/2741/Description/4`,
      `${UMANTIS}/Vacancies/2764/Description/4`,
      `${UMANTIS}/Vacancies/2762/Description/4`,
    ];
    // `exclude` mirrors production: the candidate never counts as its own twin.
    const twin = matchExistingCrawler(scraped, own, { exclude: 'eoc-candidati-posizioni' });
    expect(twin).toMatchObject({ key: 'eoc-ente-ospedaliero-cantonale', shared: 2, total: 3 });
  });

  it('matches through a different path on the same posting set, where the host check cannot help', () => {
    // The reason this guard exists on top of the host check: an aggregator or a
    // vanity domain gives a candidate a host we have never seen, while the
    // postings underneath are the ones we already publish.
    const own = loadSourceHostOwnership(root, { urls: true });
    const mixed = [`${UMANTIS}/Vacancies/2741/Description/4`, 'https://vanity.example.ch/jobs/1'];
    expect(matchExistingCrawler(mixed, own, { exclude: 'eoc-candidati-posizioni' })?.key)
      .toBe('eoc-ente-ospedaliero-cantonale');
  });

  it('lets a genuinely new employer through', () => {
    const own = loadSourceHostOwnership(root, { urls: true });
    const fresh = ['https://careers.newco.ch/job/1', 'https://careers.newco.ch/job/2'];
    expect(matchExistingCrawler(fresh, own)).toBeNull();
  });

  it('does not fire on a single incidental overlap below the majority threshold', () => {
    const own = loadSourceHostOwnership(root, { urls: true });
    const mostlyNew = [
      `${UMANTIS}/Vacancies/2741/Description/4`,
      'https://careers.newco.ch/job/1',
      'https://careers.newco.ch/job/2',
      'https://careers.newco.ch/job/3',
    ];
    expect(matchExistingCrawler(mostlyNew, own, { exclude: 'eoc-candidati-posizioni' })).toBeNull();
  });
});
