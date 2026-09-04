import { describe, it, expect, vi } from 'vitest';

// fetchAllIpersonalJobs()/fetchAllMedIpersonalJobs() re-derive geography from
// each already-accepted listing as a defensive second layer. Stub the spec
// fetch so these tests control exactly what that second layer receives,
// without a real network crawl (mirrors the vi.mock pattern in
// tests/bucher-suter-crawler.test.ts).
const mockListings = vi.hoisted(() => ({ current: [] as any[] }));

vi.mock('../scripts/lib/prospector/spec-crawler.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/prospector/spec-crawler.mjs')>();
  return { ...actual, loadSpec: () => ({ companyKey: 'ipersonal' }) };
});

vi.mock('../scripts/lib/ipersonal-spec-runtime.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts/lib/ipersonal-spec-runtime.mjs')>();
  return { ...actual, runIpersonalSpecInProduction: async () => mockListings.current };
});

const { assertCompleteIpersonalSnapshot } = await import('../scripts/lib/ipersonal-spec-runtime.mjs');
const { fetchAllIpersonalJobs } = await import('../scripts/lib/ipersonal-job-parser.mjs');
const { fetchAllMedIpersonalJobs } = await import('../scripts/lib/med-ipersonal-job-parser.mjs');

function withCounts(listings: any[], overrides: Record<string, number> = {}) {
  const counts = {
    discoveredCount: listings.length,
    expectedSeedCount: 1,
    loadedSeedCount: 1,
    resolvedDetailCount: listings.length,
    parsedDetailCount: listings.length,
    qualityDroppedCount: 0,
    ...overrides,
  };
  for (const [key, value] of Object.entries(counts)) {
    Object.defineProperty(listings, key, { value, enumerable: false });
  }
  return listings;
}

// Buchs is a real Swiss municipality shared by AG, SG and ZH — resolveSourceBackedSwissGeography
// (scripts/lib/prospector/location-evidence.mjs) only accepts an ambiguous
// municipality name when a structured addressRegion disambiguates the canton;
// the upstream crawl already verified this via that addressRegion evidence.
const ambiguousMunicipalityListing = () => ({
  title: 'Elettricista',
  location: 'Buchs',
  addressLocality: 'Buchs',
  addressRegion: 'SG',
  addressCountry: 'CH',
  description: '<p>Attività professionale con responsabilità tecniche.</p>',
  url: 'https://med-ipersonal.ch/jobs/elettricista/',
});

describe.each([
  { name: 'iPersonal', fetchAll: fetchAllIpersonalJobs },
  { name: 'MediPersonal', fetchAll: fetchAllMedIpersonalJobs },
])('$name second-layer quality filter uses the evidence the upstream crawl already verified', ({ fetchAll }) => {
  it('keeps a listing whose canton is disambiguated only by structured addressRegion evidence', async () => {
    mockListings.current = withCounts([ambiguousMunicipalityListing()]);
    const jobs = await fetchAll();
    expect(jobs).toHaveLength(1);
    expect((jobs as any).qualityDroppedCount).toBe(0);
    expect(jobs[0].canton).toBe('SG');
  });

  it.each([
    ['short title', { title: 'X' }],
    ['empty description', { description: '' }],
  ])('does not relabel a downstream %s rejection as a legitimate quality drop', async (_label, change) => {
    mockListings.current = withCounts([
      { ...ambiguousMunicipalityListing(), ...change },
    ]);
    const jobs = await fetchAll();
    expect(jobs).toHaveLength(0);
    expect((jobs as any).qualityDroppedCount).toBe(0);
    expect(() => assertCompleteIpersonalSnapshot(jobs as any)).toThrow(/parsed 0\/1/);
  });
});
