import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertAbbAdapterParity,
  ensureAdapterSeedUrls as ensureAbb,
  fetchAbbJobDetailUrls,
} from '../scripts/update-abb-jobs.mjs';
import {
  assertMigrosAdapterParity,
  ensureAdapterSeedUrls as ensureMigros,
  finalizeMigrosDiscovery,
} from '../scripts/update-migros-jobs.mjs';
import {
  assertTichAdapterParity,
  ensureAdapterSeedUrls as ensureTich,
  fetchTichJobDetailUrls,
} from '../scripts/update-tich-jobs.mjs';
import {
  assertEfgAdapterParity,
  ensureAdapterSeedUrls as ensureEfg,
  fetchEfgRequisitions,
} from '../scripts/update-efg-jobs.mjs';
import {
  assertJyskAdapterParity,
  ensureAdapterSeedUrls as ensureJysk,
  fetchJyskJobUrls,
} from '../scripts/update-jysk-jobs.mjs';
import {
  assertRaiffeisenAdapterParity,
  ensureAdapterSeedUrls as ensureRaiffeisen,
  fetchJobUrls as fetchRaiffeisenJobUrls,
} from '../scripts/update-raiffeisen-vc-jobs.mjs';
import {
  assertSbbAdapterParity,
  ensureAdapterSeedUrls as ensureSbb,
  fetchLoginSbbDetailUrls,
  fetchSbbJobDetailUrls,
} from '../scripts/update-sbb-jobs.mjs';
import {
  assertLisAdapterParity,
  assertLisListingSeeds,
  ensureAdapterSeedUrls as ensureLis,
} from '../scripts/update-lis-jobs.mjs';

const UPDATED_AT = '2026-09-01T00:00:00.000Z';
const LIS_URLS = [
  'https://lavoraconnoi.lugano-lis.ch/jobs.php?custom2=Yes&source=direct',
  'https://lavoraconnoi.lugano-lis.ch/jobs.php?custom2=Yes&source=direct&page=2',
];

const writerCases = [
  {
    name: 'ABB',
    urls: ['https://careers.abb/global/en/job/ABB1GLOBALJR00001EXTERNALENGLOBAL/Test_JR00001'],
    ensure: (urls: string[], file: string) => ensureAbb(urls, { [urls[0]]: { canton: 'TI' } }, file, UPDATED_AT),
    assertMismatch: () => assertAbbAdapterParity({ seedUrls: [] }, ['expected'], {}),
  },
  {
    name: 'Migros',
    urls: ['https://jobs.migros.ch/it/le-nostre-imprese/job/migros-ticino/test/11111111-1111-4111-8111-111111111111'],
    ensure: (urls: string[], file: string) => ensureMigros(urls, file, UPDATED_AT),
    assertMismatch: () => assertMigrosAdapterParity({ seedUrls: [] }, ['expected']),
  },
  {
    name: 'Ti.CH',
    urls: ["https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4264"],
    ensure: (urls: string[], file: string) => ensureTich(urls, file, UPDATED_AT),
    assertMismatch: () => assertTichAdapterParity({ seedUrls: [] }, ['expected']),
  },
  {
    name: 'EFG',
    urls: ['https://efginternational.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/12345'],
    ensure: (urls: string[], file: string) => ensureEfg(urls, file, UPDATED_AT),
    assertMismatch: () => assertEfgAdapterParity({ seedUrls: [] }, ['expected']),
  },
  {
    name: 'JYSK',
    urls: ['https://jobs.de.jysk.ch/offene-stellen/verkaeufer-lugano'],
    ensure: (urls: string[], file: string) => ensureJysk(urls, file, UPDATED_AT),
    assertMismatch: () => assertJyskAdapterParity({ seedUrls: [] }, ['expected']),
  },
  {
    name: 'Raiffeisen VC',
    urls: ['https://jobs.raiffeisen.ch/posti-vacanti/consulente/e2c8937c-104e-4234-8353-3b21a3a51b46'],
    ensure: (urls: string[], file: string) => ensureRaiffeisen(urls, file, UPDATED_AT),
    assertMismatch: () => assertRaiffeisenAdapterParity({ seedUrls: [] }, ['expected']),
  },
  {
    name: 'SBB',
    urls: ['https://jobs.sbb.ch/v2/offene-stellen/macchinista/11111111-1111-4111-8111-111111111111'],
    ensure: (urls: string[], file: string) => ensureSbb(urls, file, UPDATED_AT),
    assertMismatch: () => assertSbbAdapterParity({ seedUrls: [] }, ['expected']),
  },
  {
    name: 'LIS',
    urls: LIS_URLS,
    ensure: (urls: string[], file: string) => ensureLis(urls, file, UPDATED_AT),
    assertMismatch: () => assertLisAdapterParity({ seedUrls: [] }, LIS_URLS),
  },
];

describe.each(writerCases)('$name adapter writer', ({ name, urls, ensure, assertMismatch }) => {
  it('is atomic, parity-checked, idempotent, and propagates stale/write failures', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name.toLowerCase().replace(/\W+/g, '-')}-adapter-`));
    const adapterPath = path.join(dir, 'adapter.json');
    try {
      ensure(urls, adapterPath);
      const firstBytes = fs.readFileSync(adapterPath, 'utf8');
      ensure(urls, adapterPath);
      expect(fs.readFileSync(adapterPath, 'utf8')).toBe(firstBytes);
      expect(assertMismatch).toThrow(/parity failed/);

      fs.writeFileSync(adapterPath, '{ stale');
      const staleBytes = fs.readFileSync(adapterPath, 'utf8');
      expect(() => ensure(urls, adapterPath)).toThrow();
      expect(fs.readFileSync(adapterPath, 'utf8')).toBe(staleBytes);
      expect(() => ensure(urls, dir)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ABB Phenom discovery invariants', () => {
  const abbJob = (id: number) => ({
    reqId: `JR${id}`,
    jobSeqNo: `ABB1GLOBALJR${id}EXTERNALENGLOBAL`,
    title: `Automation Engineer ${id}`,
    location: 'Quartino, Ticino, Switzerland',
    descriptionTeaser: 'Automation and service engineering',
  });

  it('drains the advertised total and accepts a coherent source-zero', async () => {
    const fetchImpl = async (_input: unknown, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      const jobs = body.from === 0 ? [abbJob(10001)] : [abbJob(10002)];
      return new Response(JSON.stringify({ refineSearch: { hits: jobs.length, totalHits: 2, data: { jobs } } }), { status: 200 });
    };
    const result = await fetchAbbJobDetailUrls({ fetchImpl, pageSize: 1, maxPages: 3, timeoutMs: 1000 });
    expect(result).toMatchObject({ totalHits: 2, fetched: 2, duplicateIdentity: 0, droppedMalformed: 0, sourceZero: false });
    expect(result.urls).toHaveLength(2);

    const zero = async () => new Response(JSON.stringify({ refineSearch: { hits: 0, totalHits: 0, data: { jobs: [] } } }), { status: 200 });
    await expect(fetchAbbJobDetailUrls({ fetchImpl: zero, timeoutMs: 1000 })).resolves.toMatchObject({ urls: [], sourceZero: true });
  });

  it('fails closed when pagination stops before the advertised total', async () => {
    const fetchImpl = async (_input: unknown, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      const jobs = body.from === 0 ? [abbJob(20001)] : [];
      return new Response(JSON.stringify({ refineSearch: { hits: jobs.length, totalHits: 2, data: { jobs } } }), { status: 200 });
    };
    await expect(fetchAbbJobDetailUrls({ fetchImpl, pageSize: 1, maxPages: 3, timeoutMs: 1000 }))
      .rejects.toThrow(/fetched 1\/2/);
  });
});

describe('Migros SPA discovery finalization', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';
  const itPath = `/it/le-nostre-imprese/job/migros-ticino/test/${uuid}`;
  const de = `/de/unsere-unternehmen/job/migros-ticino/test/${uuid}`;

  it('deduplicates localized identities only after explicit terminal pagination', () => {
    const result = finalizeMigrosDiscovery([itPath, de], { termination: 'next-disabled', pagesFetched: 2 });
    expect(result).toMatchObject({ sourceZero: false, duplicateIdentity: 1, pagesFetched: 2 });
    expect(result.urls).toHaveLength(1);
  });

  it('fails closed without terminal pagination or on a malformed detail path', () => {
    expect(() => finalizeMigrosDiscovery([itPath], { termination: '', pagesFetched: 1000 })).toThrow(/incomplete/);
    expect(() => finalizeMigrosDiscovery(['/it/not-a-job'], { termination: 'next-disabled', pagesFetched: 1 }))
      .toThrow(/non-canonical/);
  });

  it('accepts source-zero only after an explicit terminal UI state', () => {
    expect(finalizeMigrosDiscovery([], { termination: 'next-unavailable', pagesFetched: 1 }))
      .toMatchObject({ urls: [], sourceZero: true, rawUniqueUrls: 0 });
    expect(() => finalizeMigrosDiscovery([], { termination: 'stalled', pagesFetched: 1 }))
      .toThrow(/incomplete/);
  });
});

describe('Ti.CH redundant discovery', () => {
  const listingMarker = '<title>Amministrazione Cantonale Ticino Jobportal</title><div id="jobsearch"></div>';
  const rssMarker = '<feed xmlns="http://www.w3.org/2005/Atom"><title>Amministrazione Cantonale Ticino Jobportal - Offerte di lavoro</title>';
  const listing = `${listingMarker}<a href="offerte-d'impieghi.html?yid=4264&sid=session">job</a>`;
  const rss = `${rssMarker}<link href="https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4264"/><link href="https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4265"/></feed>`;
  it('builds the canonical yid union and accepts one authoritative fallback', async () => {
    const fetchImpl = async (input: string | URL | Request) => new Response(String(input).includes('rss_generator') ? rss : listing, { status: 200 });
    const result = await fetchTichJobDetailUrls({ fetchImpl, timeoutMs: 1000 });
    expect(result).toMatchObject({ listingSucceeded: true, rssSucceeded: true, duplicateIdentity: 1, sourceZero: false });
    expect(result.urls).toEqual([
      "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4264",
      "https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4265",
    ]);
  });

  it('fails only when both redundant sources are unavailable', async () => {
    const unavailable = async () => new Response('down', { status: 503 });
    await expect(fetchTichJobDetailUrls({ fetchImpl: unavailable, timeoutMs: 1000 })).rejects.toThrow(/both/);
  });

  it('accepts a verified source-zero and rejects two unrelated HTTP-200 bodies', async () => {
    const zero = async (input: string | URL | Request) => new Response(
      String(input).includes('rss_generator') ? `${rssMarker}</feed>` : listingMarker,
      { status: 200 },
    );
    await expect(fetchTichJobDetailUrls({ fetchImpl: zero, timeoutMs: 1000 }))
      .resolves.toMatchObject({ urls: [], sourceZero: true, listingSucceeded: true, rssSucceeded: true });
    const unrelated = async () => new Response('<html>challenge</html>', { status: 200 });
    await expect(fetchTichJobDetailUrls({ fetchImpl: unrelated, timeoutMs: 1000 })).rejects.toThrow(/both/);
  });
});

describe('EFG Oracle discovery invariants', () => {
  const request = (id: number) => ({ Id: id, Title: `Private Banker ${id}` });
  it('requires exact total accounting and supports verified source-zero', async () => {
    const fetchJsonImpl = async () => ({ items: [{ TotalJobsCount: 2, requisitionList: [request(1), request(2)] }] });
    await expect(fetchEfgRequisitions({ fetchJsonImpl, delayMs: 0 })).resolves.toMatchObject({
      totalCount: 2, fetched: 2, duplicateIdentity: 0, sourceZero: false,
    });
    const zero = async () => ({ items: [{ TotalJobsCount: 0, requisitionList: [] }] });
    await expect(fetchEfgRequisitions({ fetchJsonImpl: zero, delayMs: 0 })).resolves.toMatchObject({ requisitions: [], sourceZero: true });
  });

  it('fails closed on a premature empty page', async () => {
    let calls = 0;
    const fetchJsonImpl = async () => ({
      items: [{ TotalJobsCount: 2, requisitionList: calls++ === 0 ? [request(1)] : [] }],
    });
    await expect(fetchEfgRequisitions({ fetchJsonImpl, delayMs: 0 })).rejects.toThrow(/fetched 1\/2/);
  });
});

describe('JYSK SSR discovery invariants', () => {
  it('accepts canonical details/verified zero and rejects transport failure', async () => {
    const marker = '<title>Switzerland (German) | JYSK Open Positions</title>';
    const complete = async () => new Response(`${marker}<a href="/offene-stellen/verkaeufer-lugano">job</a>`, { status: 200 });
    await expect(fetchJyskJobUrls({ fetchImpl: complete, timeoutMs: 1000 })).resolves.toMatchObject({
      urls: ['https://jobs.de.jysk.ch/offene-stellen/verkaeufer-lugano'], sourceZero: false, duplicateIdentity: 0,
    });
    const zero = async () => new Response(`${marker}<main>Nessuna posizione</main>`, { status: 200 });
    await expect(fetchJyskJobUrls({ fetchImpl: zero, timeoutMs: 1000 })).resolves.toMatchObject({ urls: [], sourceZero: true });
    const unavailable = async () => new Response('down', { status: 503 });
    await expect(fetchJyskJobUrls({ fetchImpl: unavailable, timeoutMs: 1000 })).rejects.toThrow(/503/);
    const unrelated = async () => new Response('<html>challenge</html>', { status: 200 });
    await expect(fetchJyskJobUrls({ fetchImpl: unrelated, timeoutMs: 1000 })).rejects.toThrow(/identity marker/);
  });
});

describe('Raiffeisen VC bilingual discovery invariants', () => {
  const detail = 'https://jobs.raiffeisen.ch/posti-vacanti/consulente/e2c8937c-104e-4234-8353-3b21a3a51b46';
  const marker = '<html><title>Banca Raiffeisen Vedeggio Cassarate</title><main>vedeggio-cassarate raiffeisen</main>';
  it('requires both pages and deduplicates their shared vacancy identity', async () => {
    const fetchImpl = async () => new Response(`${marker}<a href="${detail}">job</a></html>`, { status: 200 });
    await expect(fetchRaiffeisenJobUrls({ fetchImpl, timeoutMs: 1000 })).resolves.toMatchObject({
      urls: [detail], pagesSucceeded: 2, duplicateIdentity: 1, sourceZero: false,
    });
    const unavailable = async () => new Response('down', { status: 503 });
    await expect(fetchRaiffeisenJobUrls({ fetchImpl: unavailable, timeoutMs: 1000 })).rejects.toThrow(/503/);
  });

  it('accepts zero only from both branded pages and rejects a partial/foreign body', async () => {
    const zero = async () => new Response(`${marker}</html>`, { status: 200 });
    await expect(fetchRaiffeisenJobUrls({ fetchImpl: zero, timeoutMs: 1000 }))
      .resolves.toMatchObject({ urls: [], pagesSucceeded: 2, sourceZero: true });
    const unrelated = async () => new Response('<html>challenge</html>', { status: 200 });
    await expect(fetchRaiffeisenJobUrls({ fetchImpl: unrelated, timeoutMs: 1000 }))
      .rejects.toThrow(/identity marker/);
  });
});

describe('SBB two-source discovery invariants', () => {
  const sbbUrl = 'https://jobs.sbb.ch/v2/offene-stellen/macchinista/11111111-1111-4111-8111-111111111111';
  it('validates the AEM identity and the explicitly drained login.org listing', async () => {
    const aemJob = {
      id: '1', title: 'Macchinista', links: { directlink: sbbUrl },
      attributes: { '100': ['Bellinzona'], '110': ['Ticino (TI)'], '160': ['100%'] },
    };
    const fetchAem = async () => JSON.stringify([aemJob]);
    await expect(fetchSbbJobDetailUrls({ fetchPageImpl: fetchAem, timeoutMs: 1000 })).resolves.toMatchObject({
      urls: [sbbUrl], targetJobs: 1, duplicateIdentity: 0, sourceZero: false,
    });

    const fetchLogin = async () => '<link rel="canonical" href="https://www.login.org/it/panoramica-dei-posti-di-tirocinio-disponibili-nel"><a href="/it/123-macchinista">job</a>';
    await expect(fetchLoginSbbDetailUrls({ fetchPageImpl: fetchLogin, timeoutMs: 1000 })).resolves.toMatchObject({
      urls: ['https://www.login.org/it/123-macchinista'], pagesFetched: 1, duplicateIdentity: 0, sourceZero: false,
    });
  });

  it('fails closed when either source is unavailable and supports verified empty sources', async () => {
    const unavailable = async () => null;
    await expect(fetchSbbJobDetailUrls({ fetchPageImpl: unavailable, timeoutMs: 1000 })).rejects.toThrow(/unavailable/);
    await expect(fetchLoginSbbDetailUrls({ fetchPageImpl: unavailable, timeoutMs: 1000 })).rejects.toThrow(/unavailable/);
    const emptyAem = async () => '[]';
    await expect(fetchSbbJobDetailUrls({ fetchPageImpl: emptyAem, timeoutMs: 1000 })).resolves.toMatchObject({ urls: [], sourceZero: true });
    const emptyLogin = async () => '<link rel="canonical" href="https://www.login.org/it/panoramica-dei-posti-di-tirocinio-disponibili-nel"><html>No apprenticeships</html>';
    await expect(fetchLoginSbbDetailUrls({ fetchPageImpl: emptyLogin, timeoutMs: 1000 })).resolves.toMatchObject({ urls: [], sourceZero: true });
    const unrelatedLogin = async () => '<html>challenge</html>';
    await expect(fetchLoginSbbDetailUrls({ fetchPageImpl: unrelatedLogin, timeoutMs: 1000 })).rejects.toThrow(/identity marker/);
  });
});

describe('LIS static seed contract', () => {
  it('pins the complete unique two-page Arca24 listing boundary', () => {
    expect(assertLisListingSeeds(LIS_URLS)).toBe(true);
    expect(() => assertLisListingSeeds([LIS_URLS[0]])).toThrow(/two configured/);
    expect(() => assertLisListingSeeds([LIS_URLS[0], LIS_URLS[0]])).toThrow(/exact and unique/);
  });
});

describe('adapter-writer fail-open sibling ratchet', () => {
  it('leaves no dedicated crawler adapter writer that swallows persistence failures', () => {
    const scriptsDir = path.resolve(__dirname, '..', 'scripts');
    const offenders: string[] = [];
    for (const file of fs.readdirSync(scriptsDir).filter((name) => /^update-.+-jobs\.mjs$/.test(name))) {
      const source = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
      if (/Could not update adapter/i.test(source)) offenders.push(`${file}:legacy-warning`);
      const match = /function ensureAdapterSeed(?:Detail)?Urls\s*\([^)]*\)\s*\{/.exec(source);
      if (!match) continue;
      const open = source.indexOf('{', match.index);
      let depth = 0;
      let end = open;
      for (; end < source.length; end += 1) {
        if (source[end] === '{') depth += 1;
        if (source[end] === '}') depth -= 1;
        if (depth === 0) break;
      }
      const body = source.slice(open + 1, end);
      for (const caught of body.matchAll(/\bcatch\s*\([^)]*\)\s*\{([^}]*)\}/g)) {
        if (!/\bthrow\b/.test(caught[1])) offenders.push(`${file}:swallowed-catch`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
