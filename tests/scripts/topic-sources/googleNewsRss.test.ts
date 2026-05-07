import { describe, expect, it, vi } from 'vitest';

import * as newsRssMod from '../../../scripts/lib/topic-sources/googleNewsRss.mjs';

const { fetchNewsRssCandidates, parseNewsRss } = newsRssMod as any;

function makeRes({
  ok = true,
  status = 200,
  text = '',
}: { ok?: boolean; status?: number; text?: string }) {
  return {
    ok,
    status,
    text: async () => text,
  };
}

const NEWS_OK_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Frontalieri ticinesi: nuovo accordo fiscale 2026</title>
    <link>https://news.google.com/rss/articles/foo</link>
    <pubDate>Tue, 06 May 2026 08:00:00 GMT</pubDate>
    <source url="https://www.tio.ch">tio.ch</source>
  </item>
  <item>
    <title>Permesso G: cosa cambia con la nuova legge</title>
    <link>https://news.google.com/rss/articles/bar</link>
    <pubDate>Mon, 05 May 2026 14:00:00 GMT</pubDate>
    <source url="https://www.varesenews.it">VareseNews</source>
  </item>
  <item>
    <title>LAMal premio 2026 in calo per i frontalieri</title>
    <link>https://news.google.com/rss/articles/baz</link>
    <pubDate>Sun, 04 May 2026 09:00:00 GMT</pubDate>
    <source url="https://www.rsi.ch">RSI</source>
  </item>
</channel></rss>`;

describe('parseNewsRss', () => {
  it('extracts title/link/pubDate/source from valid RSS XML', () => {
    const items = parseNewsRss(NEWS_OK_XML);
    expect(items.length).toBe(3);
    expect(items[0].title).toMatch(/Frontalieri ticinesi/);
    expect(items[0].link).toMatch(/news\.google\.com/);
    expect(items[0].pubDate).toMatch(/06 May 2026/);
    expect(items[0].source).toBe('tio.ch');
  });

  it('returns [] on malformed XML', () => {
    expect(parseNewsRss('<not really xml>')).toEqual([]);
  });

  it('returns [] on empty channel (no <item>)', () => {
    expect(parseNewsRss('<rss><channel></channel></rss>')).toEqual([]);
  });

  it('returns [] when input is not a string', () => {
    expect(parseNewsRss(null as any)).toEqual([]);
    expect(parseNewsRss(undefined as any)).toEqual([]);
    expect(parseNewsRss(123 as any)).toEqual([]);
  });

  it('skips items missing <title> while keeping the rest', () => {
    const xml = `<rss><channel>
      <item><title>Has Title</title><link>x</link></item>
      <item><link>https://no-title.example</link></item>
      <item><title>Another One</title><link>y</link></item>
    </channel></rss>`;
    const items = parseNewsRss(xml);
    expect(items.length).toBe(2);
    expect(items[0].title).toBe('Has Title');
    expect(items[1].title).toBe('Another One');
  });

  it('handles CDATA-wrapped titles', () => {
    const xml = `<rss><channel>
      <item><title><![CDATA[Frontalieri & Tasse 2026]]></title><link>x</link></item>
    </channel></rss>`;
    const items = parseNewsRss(xml);
    expect(items.length).toBe(1);
    expect(items[0].title).toBe('Frontalieri & Tasse 2026');
  });
});

describe('fetchNewsRssCandidates', () => {
  it('happy path: 3 valid items → 3 Candidates with googleNewsRss source', async () => {
    const fetchImpl = vi.fn(async () => makeRes({ text: NEWS_OK_XML }));
    const r = await fetchNewsRssCandidates({
      seeds: ['frontalieri'],
      fetchImpl: fetchImpl as any,
    });
    expect(r.ok).toBe(true);
    expect(r.candidates.length).toBe(3);
    const c = r.candidates[0];
    expect(c.sources).toEqual(['googleNewsRss']);
    expect(c.locale).toBe('it');
    expect(c.demandSignals.googleNewsRssSeed).toBe('frontalieri');
    expect(c.demandSignals.googleNewsRssLink).toMatch(/news\.google/);
    expect(c.demandSignals.googleNewsRssSource).toBe('tio.ch');
    expect(c.id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('malformed XML → empty candidates, ok:true (HTTP 200 succeeded)', async () => {
    const fetchImpl = vi.fn(async () => makeRes({ text: '<not xml>' }));
    const r = await fetchNewsRssCandidates({
      seeds: ['x'],
      fetchImpl: fetchImpl as any,
    });
    // The fetch succeeded — parser yields [], so per-seed ok is true with
    // empty candidates. Top-level ok aggregates "any seed has candidates".
    expect(r.perSeed.x.ok).toBe(true);
    expect(r.perSeed.x.candidates).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('empty channel → ok:true with empty candidates', async () => {
    const fetchImpl = vi.fn(async () => makeRes({ text: '<rss><channel></channel></rss>' }));
    const r = await fetchNewsRssCandidates({
      seeds: ['x'],
      fetchImpl: fetchImpl as any,
    });
    expect(r.perSeed.x.ok).toBe(true);
    expect(r.perSeed.x.candidates).toEqual([]);
  });

  it('HTTP 4xx → empty candidates with reason', async () => {
    const fetchImpl = vi.fn(async () => makeRes({ ok: false, status: 404 }));
    const r = await fetchNewsRssCandidates({
      seeds: ['x'],
      fetchImpl: fetchImpl as any,
    });
    expect(r.perSeed.x.ok).toBe(false);
    expect(r.perSeed.x.reason).toMatch(/HTTP 404/);
  });

  it('HTTP 5xx → empty candidates with reason', async () => {
    const fetchImpl = vi.fn(async () => makeRes({ ok: false, status: 502 }));
    const r = await fetchNewsRssCandidates({
      seeds: ['x'],
      fetchImpl: fetchImpl as any,
    });
    expect(r.perSeed.x.ok).toBe(false);
    expect(r.perSeed.x.reason).toMatch(/HTTP 502/);
  });

  it('item missing <title> → skipped, others kept', async () => {
    const xml = `<rss><channel>
      <item><title>Real headline 2026</title><link>x</link></item>
      <item><link>https://orphan-link.example</link></item>
    </channel></rss>`;
    const fetchImpl = vi.fn(async () => makeRes({ text: xml }));
    const r = await fetchNewsRssCandidates({
      seeds: ['x'],
      fetchImpl: fetchImpl as any,
    });
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0].keyword).toBe('Real headline 2026');
  });

  it('one seed succeeds, one fails → partial result', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('frontalieri')) {
        return makeRes({ text: NEWS_OK_XML });
      }
      return makeRes({ ok: false, status: 500 });
    });
    const r = await fetchNewsRssCandidates({
      seeds: ['frontalieri', 'permesso G'],
      fetchImpl: fetchImpl as any,
    });
    expect(r.ok).toBe(true);
    expect(r.perSeed.frontalieri.ok).toBe(true);
    expect(r.perSeed.frontalieri.candidates.length).toBe(3);
    expect(r.perSeed['permesso G'].ok).toBe(false);
    expect(r.perSeed['permesso G'].candidates).toEqual([]);
  });

  it('respects maxPerSeed cap', async () => {
    // Build XML with 5 items but cap at 2.
    const items = Array.from({ length: 5 }, (_, i) =>
      `<item><title>Headline ${i}</title><link>x${i}</link></item>`,
    ).join('\n');
    const xml = `<rss><channel>${items}</channel></rss>`;
    const fetchImpl = vi.fn(async () => makeRes({ text: xml }));
    const r = await fetchNewsRssCandidates({
      seeds: ['x'],
      fetchImpl: fetchImpl as any,
      maxPerSeed: 2,
    });
    expect(r.candidates.length).toBe(2);
  });

  it('never throws even when fetch rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network blew up');
    });
    const r = await fetchNewsRssCandidates({
      seeds: ['x'],
      fetchImpl: fetchImpl as any,
    });
    expect(r.ok).toBe(false);
    expect(r.perSeed.x.ok).toBe(false);
    expect(r.perSeed.x.reason).toMatch(/fetch error|network/i);
  });
});
