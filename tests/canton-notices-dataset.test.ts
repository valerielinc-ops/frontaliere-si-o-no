import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  THRESHOLDS,
  buildRegistry,
  checkThresholds,
  mergeNotices,
  noticeId,
  selectNoticeSources,
  summarize,
  validateNotices,
  validateRegistry,
} from '../scripts/lib/canton-notices-dataset.mjs';
import { crawlSources, decodeBody } from '../scripts/crawl-canton-notices.mjs';

const ROOT = path.resolve(__dirname, '..');
const REGISTRY = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/canton-notice-sources.json'), 'utf8'));
const NOW = Date.parse('2026-10-05T08:00:00Z');

describe('registro data/canton-notice-sources.json', () => {
  it('rispetta il contratto statico', () => {
    expect(validateRegistry(REGISTRY)).toEqual([]);
  });

  it('copre i 24 gruppi e ogni esclusione ha un motivo', () => {
    expect(REGISTRY.cantons).toHaveLength(24);
    expect(new Set(REGISTRY.sources.map((s: { canton: string }) => s.canton)).size).toBeGreaterThanOrEqual(23);
    for (const e of REGISTRY.excluded) expect(e.reason, e.url).toMatch(/.{10,}/);
  });

  it('le fonti html-links hanno un pattern ancorato al path che compila', () => {
    for (const s of REGISTRY.sources.filter((x: { parser: string }) => x.parser === 'html-links')) {
      expect(s.linkPattern, s.url).toMatch(/^\^\//);
      expect(() => new RegExp(s.linkPattern)).not.toThrow();
    }
  });
});

describe('selezione dal profilo del corpus', () => {
  const profile = {
    schemaVersion: 1,
    aiInputAgents: ['ClaudeBot'],
    cantons: [
      {
        code: 'AG',
        newsSources: [
          { url: 'https://media.example.ch/rss', parser: 'rss', kind: 'media', topics: ['fisco'] },
          { url: 'https://www.ag.example/news', parser: 'html-links', kind: 'istituzionale', topics: ['cronaca', 'mobilita'] },
          { url: 'https://www.ag.example/kultur', parser: 'rss', kind: 'istituzionale', topics: ['cronaca'] },
        ],
        categoryDataSources: {
          fisco: [{ url: 'https://steuern.ag.example/feed', parser: 'rss', kind: 'fisco', topics: ['fisco'], quirks: { emptyPubDate: true, robotsTxt: 'absent' } }],
          carburanti: [{ url: 'https://prezzi.example/csv', parser: 'csv', kind: 'carburanti', topics: ['carburanti'] }],
          eventi: [{ url: 'https://stadt.example/termine.rss', parser: 'rss', kind: 'istituzionale', topics: ['eventi'] }],
        },
        ownerDecisionPending: [{ url: 'https://blocked.example/rss', parser: 'rss', kind: 'media' }],
      },
    ],
  };

  it('solo fonti lente: categorie avvisi, istituzionali news con un tema avvisi, mai media ne\' decisioni pendenti', () => {
    const { candidates } = selectNoticeSources(profile);
    expect(candidates.map((c: { url: string; fixedCategory: string | null }) => [c.url, c.fixedCategory])).toEqual([
      ['https://steuern.ag.example/feed', 'fisco'],
      ['https://stadt.example/termine.rss', 'eventi'],
      ['https://www.ag.example/news', null],
    ]);
    // i quirk del crawler passano, quelli informativi no
    expect(candidates[0].quirks).toEqual({ emptyPubDate: true });
  });

  it('una html-links senza pattern curato resta esclusa con il motivo; la curatela si conserva per canton+URL', () => {
    const first = buildRegistry(profile, { today: '2026-10-05' });
    expect(first.sources.map((s: { url: string }) => s.url)).not.toContain('https://www.ag.example/news');
    expect(first.excluded.find((e: { url: string }) => e.url === 'https://www.ag.example/news').reason).toMatch(/linkPattern/);
    const previous = { sources: [{ canton: 'AG', url: 'https://www.ag.example/news', linkPattern: '^/news/[^/]+' }], excluded: [] };
    const second = buildRegistry(profile, { previous, today: '2026-10-05' });
    expect(second.sources.find((s: { url: string }) => s.url === 'https://www.ag.example/news').linkPattern).toBe('^/news/[^/]+');
  });
});

describe('mergeNotices', () => {
  const registry = {
    cantons: ['AG', 'BE'],
    sources: [
      { key: 'ag-a', canton: 'AG', url: 'https://a.example/', parser: 'rss', categories: ['fisco'], fixedCategory: 'fisco' },
      { key: 'ag-b', canton: 'AG', url: 'https://b.example/', parser: 'rss', categories: ['fisco'], fixedCategory: 'fisco' },
      { key: 'be-c', canton: 'BE', url: 'https://c.example/', parser: 'rss', categories: ['mobilita'], fixedCategory: 'mobilita' },
    ],
  };
  const n = (canton: string, url: string, source: string, publishedAt: string | null, category = 'fisco') => ({
    id: noticeId(canton, url), canton, category, title: `Avviso ${url}`, url, publishedAt, source, language: 'de',
  });

  it('observedAt resta la prima osservazione; voci datate uscite dalla lista restano, quelle senza data no', () => {
    const previous = {
      notices: [
        { ...n('AG', 'https://a.example/1', 'ag-a', '2026-09-01'), observedAt: '2026-09-01T10:00:00.000Z' },
        { ...n('AG', 'https://a.example/old', 'ag-a', '2026-08-01'), observedAt: '2026-08-01T10:00:00.000Z' },
        { ...n('AG', 'https://a.example/nodate', 'ag-a', null), observedAt: '2026-08-01T10:00:00.000Z' },
      ],
      health: { sources: {} },
    };
    const results = new Map([
      ['ag-a', { status: 'ok', items: 1, notices: [n('AG', 'https://a.example/1', 'ag-a', '2026-09-01')] }],
    ]);
    const { notices } = mergeNotices({ registry, results, previous, now: NOW });
    const urls = notices.map((x: { url: string }) => x.url);
    expect(urls).toEqual(['https://a.example/1', 'https://a.example/old']);
    expect(notices[0].observedAt).toBe('2026-09-01T10:00:00.000Z');
  });

  it('fonte in errore: last-known-good e consecutiveFailures; bloccata da robots: le voci escono', () => {
    const previous = {
      notices: [
        { ...n('BE', 'https://c.example/1', 'be-c', '2026-09-20', 'mobilita'), observedAt: '2026-09-20T10:00:00.000Z' },
        { ...n('AG', 'https://b.example/1', 'ag-b', '2026-09-20'), observedAt: '2026-09-20T10:00:00.000Z' },
      ],
      health: { sources: { 'be-c': { consecutiveFailures: THRESHOLDS.failingAfter - 1, lastOkAt: '2026-09-30T00:00:00.000Z' } } },
    };
    const results = new Map<string, object>([
      ['be-c', { status: 'network-error', error: 'ECONNRESET' }],
      ['ag-b', { status: 'robots-blocked', robotsRule: 'User-agent: * -> Disallow: /' }],
    ]);
    const { notices, health } = mergeNotices({ registry, results, previous, now: NOW });
    expect(notices.map((x: { source: string }) => x.source)).toEqual(['be-c']);
    expect(health['be-c']).toMatchObject({ status: 'network-error', consecutiveFailures: THRESHOLDS.failingAfter, failing: true, lastOkAt: '2026-09-30T00:00:00.000Z' });
    expect(health['ag-b']).toMatchObject({ status: 'robots-blocked', notices: 0 });
  });

  it('la stessa pagina da due fonti dello stesso cantone compare una volta sola', () => {
    const shared = n('AG', 'https://a.example/shared', 'ag-a', '2026-10-01');
    const results = new Map([
      ['ag-a', { status: 'ok', items: 1, notices: [shared] }],
      ['ag-b', { status: 'ok', items: 1, notices: [{ ...shared, source: 'ag-b' }] }],
    ]);
    const { notices } = mergeNotices({ registry, results, previous: null, now: NOW });
    expect(notices.filter((x: { url: string }) => x.url === 'https://a.example/shared')).toHaveLength(1);
    expect(validateNotices(notices, registry.cantons)).toEqual([]);
  });

  it('soglie: troppe fonti perse, troppo pochi avvisi, crollo rispetto al giro prima', () => {
    const summary = { okRatio: 0.5, ok: 5, attempted: 10, notices: 100, cantons: 10 };
    const fails = checkThresholds(summary, { previous: { notices: new Array(1000) } });
    expect(fails.join('\n')).toMatch(/fonti lette/);
    expect(fails.join('\n')).toMatch(/avvisi 100 </);
    expect(fails.join('\n')).toMatch(/gruppi cantonali/);
    expect(fails.join('\n')).toMatch(/giro precedente/);
  });
});

describe('crawlSources (rete finta)', () => {
  const registry = { aiInputAgents: ['ClaudeBot'], cantons: ['GE', 'SZ', 'AG'] };
  const feed = (title: string) =>
    `<rss><channel><item><title>${title}</title><link>https://www.ge.example/n/1</link><pubDate>Fri, 02 Oct 2026 10:00:00 +0200</pubDate></item></channel></rss>`;

  function fakeFetch(routes: Record<string, { status: number; body?: string | Uint8Array; type?: string }>, calls: string[]) {
    return async (url: string) => {
      calls.push(url);
      const r = routes[url] ?? { status: 404, body: '' };
      const body = typeof r.body === 'string' || r.body == null ? new TextEncoder().encode(r.body ?? '') : r.body;
      return {
        status: r.status,
        url,
        headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? r.type ?? '' : null) },
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      };
    };
  }
  const lookup = async () => ({ address: '192.0.2.10' });

  it('robots per noi, divieto AI, charset dichiarato, e una sola richiesta senza retry sulle fonti con maxRequestsPerRun', async () => {
    const latin1 = Uint8Array.from([...'<rss><channel><item><title>Prix '].map((c) => c.charCodeAt(0)).concat([0xe0], [...' la consommation à Genève</title><link>https://www.ge.example/n/2</link></item></channel></rss>'].map((c) => c.charCodeAt(0))));
    const routes = {
      'https://www.ge.example/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\n' },
      'https://www.ge.example/rss': { status: 200, body: feed('Guide fiscal 2025 pour les indépendants') },
      'https://www.ge.example/stat': { status: 200, body: latin1, type: 'application/rss+xml; charset=ISO-8859-1' },
      'https://www.sz.example/robots.txt': { status: 404 },
      'https://www.sz.example/mm': { status: 503, body: 'down' },
      'https://www.ag.example/robots.txt': { status: 200, body: 'User-agent: ClaudeBot\nDisallow: /\n' },
      'https://www.ag.example/rss': { status: 200, body: feed('Mai letto') },
    };
    const calls: string[] = [];
    const sources = [
      { key: 'ge-1', canton: 'GE', url: 'https://www.ge.example/rss', parser: 'rss', categories: ['fisco'], fixedCategory: 'fisco', quirks: {} },
      { key: 'ge-2', canton: 'GE', url: 'https://www.ge.example/stat', parser: 'rss', categories: ['servizi'], fixedCategory: 'servizi', quirks: {} },
      { key: 'sz-1', canton: 'SZ', url: 'https://www.sz.example/mm', parser: 'html-links', linkPattern: '^/x/', categories: ['servizi'], fixedCategory: null, quirks: { maxRequestsPerRun: 1 } },
      { key: 'ag-1', canton: 'AG', url: 'https://www.ag.example/rss', parser: 'rss', categories: ['fisco'], fixedCategory: 'fisco', quirks: {} },
    ];
    const res = await crawlSources(registry, sources, { fetchImpl: fakeFetch(routes, calls) as unknown as typeof fetch, now: NOW, delayScale: 0, lookup });
    expect(res.get('ge-1')).toMatchObject({ status: 'ok', items: 1 });
    expect(res.get('ge-2').notices[0].title).toBe('Prix à la consommation à Genève');
    expect(res.get('sz-1')).toMatchObject({ status: 'http-error', httpStatus: 503 });
    expect(calls.filter((u) => u === 'https://www.sz.example/mm')).toHaveLength(1);
    expect(res.get('ag-1')).toMatchObject({ status: 'ai-input-blocked' });
    expect(calls).not.toContain('https://www.ag.example/rss');
  });

  it('decodeBody legge il charset dalla dichiarazione XML quando l\'header tace', () => {
    const bytes = Uint8Array.from([...'<?xml version="1.0" encoding="ISO-8859-1"?><t>'].map((c) => c.charCodeAt(0)).concat([0xe9], [...'</t>'].map((c) => c.charCodeAt(0))));
    expect(decodeBody(bytes, 'text/xml')).toContain('<t>é</t>');
  });

  it('summarize conta le fonti lette escludendo quelle bloccate da robots', () => {
    const health = { a: { status: 'ok' }, b: { status: 'empty' }, c: { status: 'robots-blocked' }, d: { status: 'http-error' } };
    expect(summarize({ sources: [{}, {}, {}, {}] }, [], health)).toMatchObject({ attempted: 3, ok: 2 });
  });
});
