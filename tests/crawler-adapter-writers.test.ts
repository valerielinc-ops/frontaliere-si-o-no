import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertAbbAdapterParity,
  ensureAdapterSeedUrls as ensureAbb,
  fetchAbbJobDetailUrls,
} from '../scripts/update-abb-jobs.mjs';
import {
  assertMigrosAdapterParity,
  compareMigrosDetailUrls,
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
  buildJyskCrawlerEnv,
  ensureAdapterSeedUrls as ensureJysk,
  fetchJyskJobUrls,
} from '../scripts/update-jysk-jobs.mjs';
import {
  assertRaiffeisenAdapterParity,
  ensureAdapterSeedUrls as ensureRaiffeisen,
  fetchJobUrls as fetchRaiffeisenJobUrls,
  buildRaiffeisenAuthoritativeEmptySnapshot,
} from '../scripts/update-raiffeisen-vc-jobs.mjs';
import {
  assertSbbAdapterParity,
  buildSbbSourceHealth,
  ensureAdapterSeedUrls as ensureSbb,
  fetchLoginSbbDetailUrls,
  fetchSbbJobDetailUrls,
  getSbbDetailIdentity,
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

describe('SBB current SuccessFactors discovery', () => {
  it('accepts six-digit IDs in the identity and official listing fallback', async () => {
    const detailUrl = 'https://careers.sbb.ch/job/example/123456/';
    expect(getSbbDetailIdentity(detailUrl)).toBe('careers:123456');

    const listingHtml = [
      '<main>Posti liberi — Jobfinder</main>',
      '<p>1 posti di lavoro trovati</p>',
      '<p>Dettagli della posizione e informazioni sul posto di lavoro disponibili per i candidati interessati.</p>',
      `<a href="${detailUrl}">Vacancy</a>`,
    ].join('');
    const result = await fetchSbbJobDetailUrls({
      fetchPageImpl: async (input: string | URL | Request) => (
        String(input).includes('/jobfilter.results.json') ? null : listingHtml
      ),
      fetchJinaImpl: async () => ({ ok: false, status: 503 }),
      timeoutMs: 1000,
    });

    expect(result.source).toBe('sbb-vacancies-listing');
    expect(result.urls).toEqual(['https://careers.sbb.ch/job/example/123456']);
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

  // #6932 item 4: the duplicate-identity winner is chosen by locale
  // precedence (it > de > others), not by lexical order, and the choice is
  // stable across reruns whatever order the listing emits the variants in.
  // A lexical-only comparator picks /de/ ("de" < "it") and fails here.
  it('prefers the Italian variant of one posting regardless of discovery order (#6932)', () => {
    const fr = `/fr/nos-entreprises/job/migros-ticino/test/${uuid}`;
    const otherUuid = '22222222-2222-4222-8222-222222222222';
    const deOnly = `/de/unsere-unternehmen/job/migros-ticino/other/${otherUuid}`;
    const frOnlyTwin = `/fr/nos-entreprises/job/migros-ticino/other/${otherUuid}`;
    const options = { termination: 'next-disabled', pagesFetched: 1 } as const;

    const orders = [
      [de, fr, itPath, frOnlyTwin, deOnly],
      [itPath, de, fr, deOnly, frOnlyTwin],
      [fr, deOnly, itPath, frOnlyTwin, de],
    ];
    const results = orders.map((paths) => finalizeMigrosDiscovery(paths, options));
    for (const result of results) {
      expect(result.duplicateIdentity).toBe(3);
      expect(result.urls).toEqual([
        `https://jobs.migros.ch${itPath}`,
        `https://jobs.migros.ch${deOnly}`,
      ]);
    }
    expect(compareMigrosDetailUrls(`https://jobs.migros.ch${itPath}`, `https://jobs.migros.ch${de}`))
      .toBeLessThan(0);
    expect(compareMigrosDetailUrls(`https://jobs.migros.ch${de}`, `https://jobs.migros.ch${fr}`))
      .toBeLessThan(0);
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
    await expect(fetchTichJobDetailUrls({
      fetchImpl: unavailable,
      timeoutMs: 1000,
      retries: 0,
      retryBaseMs: 0,
    })).rejects.toThrow(/both/);
  });

  it('accepts a verified source-zero and rejects two unrelated HTTP-200 bodies', async () => {
    const zero = async (input: string | URL | Request) => new Response(
      String(input).includes('rss_generator') ? `${rssMarker}</feed>` : listingMarker,
      { status: 200 },
    );
    await expect(fetchTichJobDetailUrls({ fetchImpl: zero, timeoutMs: 1000 }))
      .resolves.toMatchObject({ urls: [], sourceZero: true, listingSucceeded: true, rssSucceeded: true });
    const unrelated = async () => new Response('<html>challenge</html>', { status: 200 });
    await expect(fetchTichJobDetailUrls({
      fetchImpl: unrelated,
      timeoutMs: 1000,
      retries: 0,
      retryBaseMs: 0,
    })).rejects.toThrow(/both/);
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
  it('routes detail-page fetches through the host-scoped clean egress by default', () => {
    expect(buildJyskCrawlerEnv({}).JOBS_CRAWLER_FETCH_PROXY).toBe('jobs.de.jysk.ch');
    expect(buildJyskCrawlerEnv({ JOBS_CRAWLER_FETCH_PROXY: 'custom.example' }).JOBS_CRAWLER_FETCH_PROXY)
      .toBe('custom.example');
  });

  it('retries transient transport failures while preserving discovery guards', async () => {
    const marker = '<title>Switzerland (German) | JYSK Open Positions</title>';
    const complete = async () => new Response(`${marker}<a href="/offene-stellen/verkaeufer-lugano">job</a>`, { status: 200 });
    await expect(fetchJyskJobUrls({ fetchImpl: complete, timeoutMs: 1000 })).resolves.toMatchObject({
      urls: ['https://jobs.de.jysk.ch/offene-stellen/verkaeufer-lugano'], sourceZero: false, duplicateIdentity: 0,
    });
    let attempts = 0;
    const transientThenComplete = async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('fetch failed');
      return new Response(`${marker}<a href="/offene-stellen/verkaeufer-lugano">job</a>`, { status: 200 });
    };
    await expect(fetchJyskJobUrls({
      fetchImpl: transientThenComplete,
      timeoutMs: 1000,
      retries: 1,
      retryBaseMs: 0,
    })).resolves.toMatchObject({ urls: ['https://jobs.de.jysk.ch/offene-stellen/verkaeufer-lugano'] });
    expect(attempts).toBe(2);
    const zero = async () => new Response(`${marker}<main>Nessuna posizione</main>`, { status: 200 });
    await expect(fetchJyskJobUrls({ fetchImpl: zero, timeoutMs: 1000 })).resolves.toMatchObject({ urls: [], sourceZero: true });
    const unavailable = async () => new Response('down', { status: 503 });
    await expect(fetchJyskJobUrls({ fetchImpl: unavailable, timeoutMs: 1000, retries: 0 })).rejects.toThrow(/503/);
    const unrelated = async () => new Response('<html>challenge</html>', { status: 200 });
    await expect(fetchJyskJobUrls({ fetchImpl: unrelated, timeoutMs: 1000 })).rejects.toThrow(/identity marker/);
  });
});

describe('Raiffeisen VC bilingual discovery invariants', () => {
  const detail = 'https://jobs.raiffeisen.ch/posti-vacanti/consulente/e2c8937c-104e-4234-8353-3b21a3a51b46';
  const marker = '<html><title>Banca Raiffeisen Vedeggio Cassarate</title><main>vedeggio-cassarate raiffeisen</main>';
  it('requires both pages and deduplicates their shared vacancy identity', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = async (url: string) => {
      requestedUrls.push(url);
      return new Response(`${marker}<a href="${detail}">job</a></html>`, { status: 200 });
    };
    await expect(fetchRaiffeisenJobUrls({ fetchImpl, timeoutMs: 1000 })).resolves.toMatchObject({
      urls: [detail], pagesSucceeded: 2, duplicateIdentity: 1, sourceZero: false,
    });
    expect(requestedUrls).toEqual([
      'https://www.raiffeisen.ch/vedeggio-cassarate/it/chi-siamo/carriera/lavorare-banca-raiffeisen.html',
      'https://www.raiffeisen.ch/vedeggio-cassarate/de/ueber-uns/karriere-stellen.html',
    ]);
    const unavailable = async () => new Response('down', { status: 503 });
    await expect(fetchRaiffeisenJobUrls({ fetchImpl: unavailable, timeoutMs: 1000, retries: 0 })).rejects.toThrow(/503/);
  });

  it('retries a transient careers-page fetch before applying the bilingual discovery guard', async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ECONNRESET' };
        throw error;
      }
      return new Response(`${marker}<a href="${detail}">job</a></html>`, { status: 200 });
    };

    await expect(fetchRaiffeisenJobUrls({
      fetchImpl,
      timeoutMs: 1000,
      retries: 1,
      retryBaseMs: 0,
    })).resolves.toMatchObject({ urls: [detail], pagesSucceeded: 2 });
    expect(attempts).toBe(3);
  });

  it('accepts zero only from both branded pages with explicit listing evidence', async () => {
    const zero = async () => new Response(
      `${marker}<div class="listing-count">0</div><p>Offene Stellen – 0 neue Hinweise</p></html>`,
      { status: 200 },
    );
    await expect(fetchRaiffeisenJobUrls({ fetchImpl: zero, timeoutMs: 1000 }))
      .resolves.toMatchObject({ urls: [], pagesSucceeded: 2, sourceZero: true });
    const localizedZero = async (url: string) => {
      const emptyText = url.includes('/de/')
        ? 'Derzeit haben wir keine offenen Stellen.'
        : 'Attualmente non ci sono posizioni aperte.';
      return new Response(
        `${marker.replace('</main>', '')}<section><h2>Offene Stellen</h2><p>${emptyText}</p></section></main></html>`,
        { status: 200 },
      );
    };
    await expect(fetchRaiffeisenJobUrls({ fetchImpl: localizedZero, timeoutMs: 1000 }))
      .resolves.toMatchObject({ urls: [], pagesSucceeded: 2, sourceZero: true });
    const duplicatedCount = async () => new Response(
      `${marker}<div class="listing-count">0</div><div class="listing-count">0</div></html>`,
      { status: 200 },
    );
    await expect(fetchRaiffeisenJobUrls({ fetchImpl: duplicatedCount, timeoutMs: 1000 }))
      .rejects.toThrow(/explicit zero-open-positions marker/);
    const unrelatedCopy = async () => new Response(
      `${marker}<p>Offene Stellen – 0 neue Hinweise</p></html>`,
      { status: 200 },
    );
    await expect(fetchRaiffeisenJobUrls({ fetchImpl: unrelatedCopy, timeoutMs: 1000 }))
      .rejects.toThrow(/explicit zero-open-positions marker/);
    const unrelated = async () => new Response(
      `${marker}<div class="job-filter"><span class="total">0 nuove indicazioni</span></div></html>`,
      { status: 200 },
    );
    await expect(fetchRaiffeisenJobUrls({ fetchImpl: unrelated, timeoutMs: 1000 }))
      .rejects.toThrow(/explicit zero-open-positions marker/);
    const labelledCount = async () => new Response(
      `${marker}<div class="listing-count">0 nuove indicazioni</div></html>`,
      { status: 200 },
    );
    await expect(fetchRaiffeisenJobUrls({ fetchImpl: labelledCount, timeoutMs: 1000 }))
      .rejects.toThrow(/explicit zero-open-positions marker/);
    const unmarkedZero = async () => new Response(`${marker}</html>`, { status: 200 });
    await expect(fetchRaiffeisenJobUrls({ fetchImpl: unmarkedZero, timeoutMs: 1000 }))
      .rejects.toThrow(/explicit zero-open-positions marker/);
    const invalid = async () => new Response('<html>challenge</html>', { status: 200 });
    await expect(fetchRaiffeisenJobUrls({ fetchImpl: invalid, timeoutMs: 1000 }))
      .rejects.toThrow(/identity marker/);
  });

  it('builds a health-visible authoritative zero and reports removed jobs', () => {
    const priorJob = {
      companyKey: 'banca-raiffeisen-vedeggio-cassarate',
      slug: 'consulente-clientela-privata-banca-raiffeisen-vedeggio-cassarate',
      title: 'Consulente clientela privata',
      url: detail,
    };
    const result = buildRaiffeisenAuthoritativeEmptySnapshot(
      [priorJob],
      '2026-10-03T00:00:00.000Z',
      42,
    );
    expect(result.jobs).toEqual([]);
    expect(result.jobs.authoritativeEmptyState).toBe('authoritative-source-zero');
    expect(result.summary).toMatchObject({
      authoritativeEmptySnapshot: true,
      authoritativeSnapshotVerified: true,
      total: 0,
      removedCount: 1,
      durationMs: 42,
    });
    expect(result.crawlDiff.removedJobs).toHaveLength(1);
  });
});

describe('SBB two-source discovery invariants', () => {
  const sbbUrl = 'https://jobs.sbb.ch/v2/offene-stellen/macchinista/11111111-1111-4111-8111-111111111111';
  it('sends the AEM discovery as a same-origin browser XHR', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      requests.push({ url: String(url), init });
      return new Response('[]', { status: 200 });
    }));
    try {
      await expect(fetchSbbJobDetailUrls({ timeoutMs: 1000 })).resolves.toMatchObject({ sourceZero: true });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(requests).toHaveLength(1);
    expect(requests[0].init.headers).toMatchObject({
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'it-CH,it;q=0.9,en;q=0.8',
      Referer: 'https://company.sbb.ch/it/impieghi-carriera/jobs/posti-liberi.html',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': expect.stringContaining('Chrome/131.0.0.0'),
    });
  });

  it('sends the official listing fallback as a browser document request', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const detailUrl = 'https://jobs.sbb.ch/v2/offene-stellen/macchinista/33333333-3333-4333-8333-333333333333';
    const listingHtml = `<html><body><h1>Posti liberi.</h1><div>1 Posti di lavoro trovati per il tuo profilo.</div>
      <p>Jobfinder e informazioni sulle candidature disponibili presso le FFS.</p><a href="${detailUrl}">Vai alla descrizione del lavoro</a></body></html>`;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('jobfilter.results.json')) return new Response('', { status: 403 });
      return new Response(listingHtml, { status: 200 });
    }));
    try {
      await expect(fetchSbbJobDetailUrls({
        fetchJinaImpl: async () => ({ ok: false, status: 502, text: async () => '' }),
        timeoutMs: 1000,
      })).resolves.toMatchObject({ urls: [detailUrl], source: 'sbb-vacancies-listing' });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(requests).toHaveLength(2);
    expect(requests[1].url).toContain('posti-liberi.html?startItem=1');
    expect(requests[1].init.headers).toMatchObject({
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'it-CH,it;q=0.9,en;q=0.8',
      Referer: 'https://company.sbb.ch/it/impieghi-carriera/jobs/posti-liberi.html',
      'User-Agent': expect.stringContaining('Chrome/131.0.0.0'),
    });
    expect(requests[1].init.headers).not.toHaveProperty('X-Requested-With');
  });

  it('accepts current SAP SuccessFactors careers URLs from the official listing', async () => {
    const currentCareerUrl = 'https://careers.sbb.ch/job/Z%C3%BCrich-Fachspezialistin-f%C3%BCr-Material-und-Equipment-Stammdaten-Pers/1457236233/';
    const listingHtml = `<html><body><h1>Posti liberi.</h1><div>1 Posti di lavoro trovati per il tuo profilo.</div>
      <p>Jobfinder e informazioni sulle candidature disponibili presso le FFS.</p><a href="${currentCareerUrl}">Vai alla descrizione del lavoro</a></body></html>`;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('jobfilter.results.json')) return new Response('', { status: 403 });
      return new Response(listingHtml, { status: 200 });
    }));
    try {
      await expect(fetchSbbJobDetailUrls({
        fetchJinaImpl: async () => ({ ok: false, status: 502, text: async () => '' }),
        timeoutMs: 1000,
      })).resolves.toMatchObject({
        urls: [currentCareerUrl.replace(/\/$/, '')],
        source: 'sbb-vacancies-listing',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects the generic uncounted no-results shell instead of publishing source-zero', async () => {
    const listingHtml = `<html><body><h1>Posti liberi.</h1><div>Posti di lavoro trovati per il tuo profilo.</div>
      <p>Non ha prodotto risultati.</p><p>Jobfinder e informazioni sulle candidature disponibili.</p></body></html>`;
    let listingValidationReason;
    const fetchJina = vi.fn(async (
      url: string,
      options: { validateBody?: (body: string) => string | null } = {},
    ) => {
      if (url.includes('jobfilter.results.json')) return { ok: false, status: 502, text: async () => '' };
      if (listingValidationReason === undefined) listingValidationReason = options.validateBody?.(listingHtml);
      return { ok: true, status: 200, text: async () => listingHtml };
    });

    await expect(fetchSbbJobDetailUrls({
      fetchPageImpl: async () => null,
      fetchJinaImpl: fetchJina,
      timeoutMs: 1000,
    })).rejects.toThrow(/unavailable/);
    expect(listingValidationReason).toBe('SBB vacancies listing result count missing');
  });

  it('uses the current Italian AEM endpoint for discovery', async () => {
    const requestedUrls: string[] = [];
    const fetchAem = async (url: string) => {
      requestedUrls.push(url);
      return '[]';
    };

    await expect(fetchSbbJobDetailUrls({ fetchPageImpl: fetchAem, timeoutMs: 1000 }))
      .resolves.toMatchObject({ urls: [], sourceZero: true });
    expect(requestedUrls).toEqual([
      'https://company.sbb.ch/content/internet/corporate/it/jobs-karriere/jobs/job-suche/jcr:content/parmain/jobfilter.results.json',
    ]);
  });

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

  it('accepts current SAP SuccessFactors careers detail URLs from AEM', async () => {
    const currentCareerUrl = 'https://careers.sbb.ch/job/Z%C3%BCrich-Fachspezialistin-f%C3%BCr-Material-und-Equipment-Stammdaten-Pers/1457236233/';
    const aemJob = {
      id: '1457236233',
      title: 'Fachspezialistin für Material- und Equipment Stammdaten',
      links: { directlink: currentCareerUrl },
      attributes: { '100': ['Zürich'], '110': ['Zürich (ZH)'], '160': ['60-100%'] },
    };

    await expect(fetchSbbJobDetailUrls({
      fetchPageImpl: async () => JSON.stringify([aemJob]),
      timeoutMs: 1000,
    })).resolves.toMatchObject({
      urls: [currentCareerUrl.replace(/\/$/, '')],
      targetJobs: 1,
      duplicateIdentity: 0,
      sourceZero: false,
    });
  });

  it('rescues a blocked AEM feed through the Jina clean-IP proxy', async () => {
    const aemJob = {
      id: '1', title: 'Macchinista', links: { directlink: sbbUrl },
      attributes: { '100': ['Bellinzona'], '110': ['Ticino (TI)'], '160': ['100%'] },
    };
    const fetchJina = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([aemJob]),
    }));

    await expect(fetchSbbJobDetailUrls({
      fetchPageImpl: async () => null,
      fetchJinaImpl: fetchJina,
      timeoutMs: 1000,
    })).resolves.toMatchObject({ urls: [sbbUrl], targetJobs: 1, sourceZero: false });
    expect(fetchJina).toHaveBeenCalledWith(
      expect.stringContaining('jobfilter.results.json'),
      expect.objectContaining({ format: 'text', accept: 'application/json', timeoutMs: 1000 }),
    );
  });

  it('unwraps the Jina JSON envelope instead of treating its content as the AEM body', async () => {
    const aemJob = {
      id: '1', title: 'Macchinista', links: { directlink: sbbUrl },
      attributes: { '100': ['Bellinzona'], '110': ['Ticino (TI)'], '160': ['100%'] },
    };
    const fetchJina = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: { url, content: JSON.stringify([aemJob]) },
      }),
    }));

    await expect(fetchSbbJobDetailUrls({
      fetchPageImpl: async () => null,
      fetchJinaImpl: fetchJina,
      timeoutMs: 1000,
    })).resolves.toMatchObject({ urls: [sbbUrl], targetJobs: 1, sourceZero: false });
    expect(fetchJina).toHaveBeenCalledWith(
      expect.stringContaining('jobfilter.results.json'),
      expect.objectContaining({ accept: 'application/json', validateBody: expect.any(Function) }),
    );
  });

  it('rejects an unverified Jina envelope without an AEM source URL', async () => {
    const fetchJina = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { content: '[]' } }),
    }));

    await expect(fetchSbbJobDetailUrls({
      fetchPageImpl: async () => null,
      fetchJinaImpl: fetchJina,
      timeoutMs: 1000,
    })).rejects.toThrow(/unavailable/);
  });

  it('falls back to the complete official vacancies listing when AEM and its proxy are unavailable', async () => {
    const secondSbbUrl = 'https://jobs.sbb.ch/v2/offene-stellen/technico/22222222-2222-4222-8222-222222222222';
    const listingPageOne = `<!doctype html><html><head><link rel="canonical" href="${'https://company.sbb.ch/it/impieghi-carriera/jobs/posti-liberi.html'}"></head><body>
      <h1>Posti liberi.</h1><p>Fai qualcosa di grande. Scopri opportunità.</p>
      <div>2 Posti di lavoro trovati per il tuo profilo.</div><p>Jobfinder e informazioni sulle candidature disponibili.</p>
      <a href="${sbbUrl}">Vai alla descrizione del lavoro</a>
      <a href="https://company.sbb.ch/it/impieghi-carriera/jobs/posti-liberi.html?startItem=2">Pagina successiva</a>
      <p>Il portale ufficiale delle FFS pubblica posizioni nazionali e aggiorna i risultati della ricerca.</p>
    </body></html>`;
    const listingPageTwo = `<!doctype html><html><body>
      <h1>Posti liberi.</h1><p>Jobfinder per le opportunità presso le FFS.</p>
      <div>2 Posti di lavoro trovati per il tuo profilo.</div>
      <a href="${secondSbbUrl}">Vai alla descrizione del lavoro</a>
      <p>Le offerte sono pubblicate dal portale ufficiale delle FFS e restano collegate alla pagina della posizione.</p>
    </body></html>`;
    const fetchJina = vi.fn(async (url: string) => {
      if (url.includes('jobfilter.results.json')) return { ok: false, status: 502, text: async () => '' };
      return {
        ok: true,
        status: 200,
        text: async () => url.includes('startItem=2') ? listingPageTwo : listingPageOne,
      };
    });

    const result = await fetchSbbJobDetailUrls({
      fetchPageImpl: async () => null,
      fetchJinaImpl: fetchJina,
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({
      urls: [secondSbbUrl, sbbUrl].sort(),
      sourceZero: false,
      totalJobs: 2,
      source: 'sbb-vacancies-listing',
    });
    expect(buildSbbSourceHealth(result, { urls: [], degraded: false })).toMatchObject({
      status: 'degraded',
      degradedSources: ['sbb-aem-json'],
      sources: { aem: { status: 'degraded', fallbackSource: 'sbb-vacancies-listing' } },
    });
    expect(fetchJina).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('posti-liberi.html?startItem=1'),
      expect.objectContaining({ format: 'html', validateBody: expect.any(Function) }),
    );
    expect(fetchJina).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('posti-liberi.html?startItem=2'),
      expect.objectContaining({ format: 'html', validateBody: expect.any(Function) }),
    );
  });

  it('falls back to the official careers sitemap when AEM and the vacancies listing are blocked', async () => {
    const currentCareerUrls = [
      'https://careers.sbb.ch/job/Bellinzona-Macchinista/1457236233/',
      'https://careers.sbb.ch/job/Lugano-Tecnica-di-manutenzione/1457236433/',
    ];
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>${currentCareerUrls[0]}</loc></url>
      <url><loc>${currentCareerUrls[1]}</loc></url>
      <url><loc>https://careers.sbb.ch/jobs</loc></url>
    </urlset>`;
    const requested: Array<{ url: string; accept?: string }> = [];
    const fetchPage = async (url: string, _timeoutMs: number, accept?: string) => {
      requested.push({ url, accept });
      return url === 'https://careers.sbb.ch/sitemap.xml' ? sitemap : null;
    };

    const result = await fetchSbbJobDetailUrls({
      fetchPageImpl: fetchPage,
      fetchJinaImpl: async () => ({ ok: false, status: 502, text: async () => '' }),
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      urls: currentCareerUrls.map((url) => url.replace(/\/$/, '')).sort(),
      sourceZero: false,
      totalJobs: 2,
      source: 'sbb-careers-sitemap',
    });
    expect(buildSbbSourceHealth(result, { urls: [], degraded: false })).toMatchObject({
      status: 'degraded',
      degradedSources: ['sbb-aem-json'],
      sources: { aem: { fallbackSource: 'sbb-careers-sitemap' } },
    });
    expect(requested.at(-1)).toMatchObject({
      url: 'https://careers.sbb.ch/sitemap.xml',
      accept: 'application/xml,text/xml;q=0.9,text/plain;q=0.8',
    });
  });

  it('fails closed when the official careers sitemap has no canonical job URLs', async () => {
    const emptySitemap = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://careers.sbb.ch/jobs</loc></url></urlset>';
    const fetchPage = async (url: string) => (url === 'https://careers.sbb.ch/sitemap.xml' ? emptySitemap : null);
    await expect(fetchSbbJobDetailUrls({
      fetchPageImpl: fetchPage,
      fetchJinaImpl: async () => ({ ok: true, status: 200, text: async () => emptySitemap }),
      timeoutMs: 1000,
    })).rejects.toThrow(/unavailable/);
  });

  it('fails closed on the primary AEM source, degrades the secondary login.org source on outage, and supports verified empty sources', async () => {
    const unavailable = async () => null;
    // Primary source (AEM API) and the source-backed HTML fallback are both
    // unavailable, so discovery remains fatal rather than publishing a guess.
    await expect(fetchSbbJobDetailUrls({
      fetchPageImpl: unavailable,
      fetchJinaImpl: async () => ({ ok: false, status: 502, text: async () => '' }),
      timeoutMs: 1000,
    })).rejects.toThrow(/unavailable/);
    // Secondary source (login.org apprenticeships, #6961): unavailable
    // degrades in place (zero NEW seeds, `sourceZero: false` so existing
    // apprenticeship jobs are never treated as verified-gone) instead of
    // throwing and taking down the whole SBB crawl over an optional source.
    await expect(fetchLoginSbbDetailUrls({ fetchPageImpl: unavailable, timeoutMs: 1000 })).resolves.toMatchObject({
      urls: [], sourceZero: false, degraded: true,
    });
    const emptyAem = async () => '[]';
    await expect(fetchSbbJobDetailUrls({ fetchPageImpl: emptyAem, timeoutMs: 1000 })).resolves.toMatchObject({ urls: [], sourceZero: true });
    const emptyLogin = async () => '<link rel="canonical" href="https://www.login.org/it/panoramica-dei-posti-di-tirocinio-disponibili-nel"><html>No apprenticeships</html>';
    await expect(fetchLoginSbbDetailUrls({ fetchPageImpl: emptyLogin, timeoutMs: 1000 })).resolves.toMatchObject({ urls: [], sourceZero: true });
    // Malformed payload (challenge/WAF page masquerading as the listing):
    // still a hard failure, distinct from a plain HTTP-level outage — it
    // signals our identity marker/URL-extraction contract may have drifted,
    // which is worth failing loud on rather than silently degrading.
    const unrelatedLogin = async () => '<html>challenge</html>';
    await expect(fetchLoginSbbDetailUrls({ fetchPageImpl: unrelatedLogin, timeoutMs: 1000 })).rejects.toThrow(/identity marker/);
  });

  it('degrades login.org on a real HTTP 451 response without touching the AEM path (#6961)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 451 })));
    try {
      await expect(fetchLoginSbbDetailUrls({ timeoutMs: 1000 })).resolves.toMatchObject({
        urls: [], sourceZero: false, degraded: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
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
