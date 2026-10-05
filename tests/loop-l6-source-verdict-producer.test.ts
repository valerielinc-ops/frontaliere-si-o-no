// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { escapeForTS } from '../scripts/lib/blog-body-io.mjs';
import { SKIP_LIVE_DATA } from './helpers/live-data';
import { validateEditorialFactualityLedger } from '../scripts/ci/export-l6-factuality-outcomes.mjs';
import {
  ARTICLES_DATA_PATH,
  bodyPath,
  main,
  parseRawArticles,
  produceVerdicts,
  rawArticlesBlock,
  selectArticles,
} from '../scripts/ci/produce-l6-source-verdicts.mjs';

/**
 * Observer of the L6 producer: it must keep reading the article list and the
 * cited sources, and every row it writes must pass the L6 export contract.
 * Failure title: "L6: produttore di verdetti non legge piu' articoli e fonti citate".
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

// Same shape as packages/articles/content/blog-articles-data.ts.
const DATA_FIXTURE = `export interface Article { id: string; category: string; date: string; updatedAt?: string }

const RAW_ARTICLES = [
 {
 id: 'evergreen-guida',
 category: 'fiscale',
 date: '2026-01-15',
 updatedAt: '2026-09-30',
 image: '/images/places/lugano-view.webp',
 hasCalculator: true,
 },
  {
 id: 'notizia-vecchia-aggiornata',
 category: 'novita',
 date: '2026-03-01',
 updatedAt: '2026-09-20T08:00:00.000Z',
 image: '/images/blog/a.webp',
 hasCalculator: false,
 },
 {
 id: 'notizia-recente',
 category: 'novita',
 date: '2026-09-25T10:00:00.000Z',
 image: '/images/blog/b.webp',
 hasCalculator: false,
 authorSlug: 'redazione',
 authorName: 'Redazione Frontaliere Ticino',
 },
 {
 id: 'notizia-intermedia',
 category: 'novita',
 date: '2026-09-10',
 image: '/images/blog/c.webp',
 hasCalculator: false,
 },
 {
 id: 'notizia-antica',
 category: 'novita',
 date: '2025-12-01',
 image: '/images/blog/d.webp',
 hasCalculator: false,
 },
] satisfies Article[];

export const ARTICLES = RAW_ARTICLES.map((a) => ({ ...a }));
`;

const SOURCE_URL = 'https://www.ticinonews.ch/ticino/blocco-dei-ristorni-la-politica-e-possibilista-433327';
const IT_BODY = `## In breve\n- I partiti sono possibilisti\n\n## Fatti chiave\n- Quando: Decisione entro fine giugno 2026\n- Importo: 120 milioni di franchi\n\nIl Consiglio di Stato puo' trattenere i 120 milioni.\n\n*Fonte: [ticinonews.ch](${SOURCE_URL})*`;
const TRANSLATIONS: Record<string, string> = {
  en: '## Key facts\n- Amount: 120 million francs',
  de: '## Wichtige Fakten\n- Betrag: 120 Millionen Franken',
  fr: '## Faits clés\n- Montant : 120 millions de francs',
};
const SOURCE_HTML = `<html><body><article><p>${'Il Consiglio di Stato ha tempo fino a fine giugno per decidere. '.repeat(5)}Si parla di 120 Mio. di franchi.</p></article></body></html>`;

function bodyModule(id: string, body: string) {
  return `const body: Record<string, string> = {\n    'blog.article.${id}.body1': '${escapeForTS(body)}',\n};\n\nexport default body;\n`;
}

function tempRoot(articles: Array<{ id: string; locales?: string[] }>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l6-producer-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, path.dirname(ARTICLES_DATA_PATH)), { recursive: true });
  fs.writeFileSync(path.join(root, ARTICLES_DATA_PATH), DATA_FIXTURE);
  for (const { id, locales = ['it', 'en', 'de', 'fr'] } of articles) {
    for (const locale of locales) {
      const file = path.join(root, bodyPath(locale, id));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bodyModule(id, locale === 'it' ? IT_BODY : TRANSLATIONS[locale]));
    }
  }
  return root;
}

function htmlResponse(body: string, init: ResponseInit = {}) {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
}

describe('selection from RAW_ARTICLES', () => {
  it('takes news articles by max(date, updatedAt), newest first, up to the limit', () => {
    const selected = selectArticles(parseRawArticles(DATA_FIXTURE), { limit: 3 });
    expect(selected.map((entry) => entry.id)).toEqual(['notizia-recente', 'notizia-vecchia-aggiornata', 'notizia-intermedia']);
  });

  it('reads an unknown publication date as an empty string and ranks it after every dated article', () => {
    const withUnknown = DATA_FIXTURE.replace("id: 'notizia-antica',\n category: 'novita',\n date: '2025-12-01',", "id: 'notizia-antica',\n category: 'novita',\n date: '',");
    expect(withUnknown).not.toBe(DATA_FIXTURE);
    const entries = parseRawArticles(withUnknown);
    expect(entries.find((entry) => entry.id === 'notizia-antica')?.date).toBe('');
    const selected = selectArticles(entries, { limit: entries.length });
    expect(selected.at(-1)?.id).toBe('notizia-antica');
  });

  it('keeps an article when a quoted field contains braces', () => {
    const withBraces = DATA_FIXTURE.replace(
      "id: 'notizia-recente',",
      "id: 'notizia-recente',\n title: 'Aliquota { speciale }',",
    );
    expect(parseRawArticles(withBraces).map((entry) => entry.id)).toContain('notizia-recente');
  });

  it('does not read a field name inside another quoted value as the field', () => {
    const decoy = DATA_FIXTURE.replace(
      "id: 'notizia-recente',",
      "title: \"Promo category: 'pratico', date: '1999-01-01'\",\n id: 'notizia-recente',",
    );
    const real = parseRawArticles(DATA_FIXTURE).find((entry) => entry.id === 'notizia-recente');
    const parsed = parseRawArticles(decoy).find((entry) => entry.id === 'notizia-recente');
    expect(real).toBeDefined();
    expect(parsed).toEqual(real);
  });

  it('reads rows from a registry with an explicit Article[] annotation', () => {
    const typedFixture = `const RAW_ARTICLES: Article[] = [
      { id: 'typed-entry', category: 'novita', date: '2026-10-05' },
    ] satisfies Article[];`;

    expect(parseRawArticles(typedFixture).map((entry) => entry.id)).toEqual(['typed-entry']);
    expect(rawArticlesBlock(typedFixture)).toContain("id: 'typed-entry'");
  });

  it('reads typed literal chunks without double-counting the spread aggregator', () => {
    const chunkedFixture = `const RAW_ARTICLES_CHUNK_01: Article[] = [
      { id: 'chunk-one', category: 'novita', date: '2026-10-04' },
    ];
    const RAW_ARTICLES_CHUNK_02: Article[] = [
      { id: 'chunk-two', category: 'novita', date: '2026-10-05' },
    ];
    const RAW_ARTICLES: Article[] = [
      ...RAW_ARTICLES_CHUNK_01,
      ...RAW_ARTICLES_CHUNK_02,
      { id: 'appended-entry', category: 'novita', date: '2026-10-06' },
    ] satisfies Article[];`;

    expect(parseRawArticles(chunkedFixture).map((entry) => entry.id)).toEqual([
      'chunk-one',
      'chunk-two',
      'appended-entry',
    ]);
  });

  it('--select prints the four body paths of each selected article, one per line', async () => {
    const root = tempRoot([]);
    let printed = '';
    await main({ argv: ['--select', '--limit', '2', '--root', root], stdout: { write: (chunk: string) => { printed += chunk; return true; } } });
    expect(printed.trim().split('\n')).toEqual(['notizia-recente', 'notizia-vecchia-aggiornata'].flatMap((id) => (
      ['it', 'en', 'de', 'fr'].map((locale) => `packages/articles/content/blog-body/${locale}/${id}.ts`)
    )));
  });

  it('reads rows from a registry with an explicit Article[] annotation', () => {
    const typedFixture = `const RAW_ARTICLES: Article[] = [
      { id: 'typed-entry', category: 'novita', date: '2026-10-05' },
] satisfies Article[];`;

    expect(parseRawArticles(typedFixture).map((entry) => entry.id)).toEqual(['typed-entry']);
    expect(rawArticlesBlock(typedFixture)).toContain("id: 'typed-entry'");
  });

  it('reads typed literal chunks without double-counting the spread aggregator', () => {
    const chunkedFixture = `const RAW_ARTICLES_CHUNK_01: Article[] = [
  { id: 'chunk-one', category: 'novita', date: '2026-10-04' },
];
const RAW_ARTICLES_CHUNK_02: Article[] = [
  { id: 'chunk-two', category: 'novita', date: '2026-10-05' },
];
const RAW_ARTICLES: Article[] = [
  ...RAW_ARTICLES_CHUNK_01,
  ...RAW_ARTICLES_CHUNK_02,
  { id: 'appended-entry', category: 'novita', date: '2026-10-06' },
] satisfies Article[];`;

    expect(parseRawArticles(chunkedFixture).map((entry) => entry.id)).toEqual([
      'chunk-one',
      'chunk-two',
      'appended-entry',
    ]);
  });

  const realData = path.join(ROOT, ARTICLES_DATA_PATH);
  const realPresent = fs.existsSync(realData);
  // The one live-data case of this file (LIVE_DATA_PARTIAL_TESTS): the article
  // list is rewritten by the publishing pipeline, so the check runs in
  // live-data-gates, not in the blocking PR job. It asserts no count, only that
  // the producer's regex reads as many entries as an independent count: it goes
  // red when the RAW_ARTICLES format changes and the producer stops reading.
  // A local sparse worktree may lack the file; CI never does.
  it.skipIf(SKIP_LIVE_DATA || (!realPresent && !process.env.CI))('reads every entry of the real blog-articles-data.ts', () => {
    const text = fs.readFileSync(realData, 'utf8');
    const entries = parseRawArticles(text);
    const independentCount = (rawArticlesBlock(text).match(/^\s*id\s*:/gm) || []).length;
    const fileWideCount = (text.match(/^\s*id\s*:\s*['"]/gm) || []).length;
    expect(independentCount).toBeGreaterThan(0);
    expect(entries.length).toBe(independentCount);
    expect(entries.length).toBe(fileWideCount);
    // `date: ''` = publication date unknown (corpus PR 2082): the producer
    // must still READ the field (a missing match is null), and a present
    // date must parse. selectArticles ranks the unknown ones last.
    expect(entries.filter((entry) => !entry.category || typeof entry.date !== 'string')).toEqual([]);
    expect(entries.filter((entry) => entry.date !== '' && !Number.isFinite(Date.parse(entry.date!)))).toEqual([]);
    expect(entries.every((entry) => (
      typeof entry.category === 'string' && entry.category.length > 0 && typeof entry.date === 'string'
    ))).toBe(true);
    expect(entries.filter((entry) => entry.category === 'novita').length).toBeGreaterThan(0);
    expect(entries.every((entry) => (
      typeof entry.category === 'string' && entry.category.length > 0 && typeof entry.date === 'string'
    ))).toBe(true);
  });

  it.skipIf(SKIP_LIVE_DATA || (!realPresent && !process.env.CI))('keeps the generated raw registry and public export explicitly typed', () => {
    const text = fs.readFileSync(realData, 'utf8');
    const declarations = [...text.matchAll(/const\s+(RAW_ARTICLES(?:_CHUNK_\d+)?)([^\n]*)/g)];
    expect(declarations.length).toBeGreaterThan(0);
    expect(declarations.every((match) => /:\s*Article\[\]\s*=/.test(match[2]))).toBe(true);
    expect(text).toMatch(/export\s+const\s+ARTICLES\s*:\s*Article\[\]\s*=/);

    if (!text.includes('const RAW_ARTICLES_CHUNK_01')) {
      const start = text.indexOf('const RAW_ARTICLES: Article[] = [');
      const end = text.indexOf('\n];', start);
      expect(end).toBeGreaterThan(start);
      expect(text.slice(start, end)).not.toContain('satisfies Article[]');
    }
  });
});

describe('produceVerdicts', () => {
  it('writes rows that the L6 export contract accepts', async () => {
    const root = tempRoot([{ id: 'notizia-recente' }]);
    const calls: string[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push(url);
      expect((init.headers as Record<string, string>)['user-agent']).toMatch(/l6-source-check/);
      return htmlResponse(SOURCE_HTML);
    };
    const { rows, summary } = await produceVerdicts({ root, ids: ['notizia-recente'], fetchImpl });
    expect(calls).toEqual([SOURCE_URL]);
    expect(rows.map((row) => row.locale)).toEqual(['it', 'en', 'de', 'fr']);
    expect(summary.rowsWritten).toBe(rows.length);
    const verdict = validateEditorialFactualityLedger(rows.map((row) => JSON.stringify(row)).join('\n'));
    expect(verdict.invalidRecords).toEqual([]);
    expect(verdict.quality).toBe('observed');
    expect(verdict.snapshot.reviewedArticles).toBe(rows.length);
    expect(rows[0].evidence.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a source answering 404 produces no row and counts as fetch-failed', async () => {
    const root = tempRoot([{ id: 'notizia-recente' }]);
    const { rows, summary } = await produceVerdicts({
      root,
      ids: ['notizia-recente'],
      fetchImpl: async () => new Response('not found', { status: 404 }),
    });
    expect(rows).toEqual([]);
    expect(summary.rowsWritten).toBe(0);
    expect(summary.skipped['fetch-failed']).toBe(1);
  });

  it('a body that stalls, a stream that breaks or a malformed redirect is fetch-failed, and the run keeps the other rows', async () => {
    const ids = ['notizia-lenta', 'notizia-interrotta', 'notizia-redirect-rotto', 'notizia-recente'];
    const root = tempRoot(ids.map((id) => ({ id })));
    const brokenSources: Record<string, (init: RequestInit) => Response> = {
      stall: (init) => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('<html><body>'));
          init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      }), { status: 200, headers: { 'content-type': 'text/html' } }),
      broken: () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('<html><body>'));
          controller.error(new TypeError('terminated'));
        },
      }), { status: 200, headers: { 'content-type': 'text/html' } }),
      badRedirect: () => new Response(null, { status: 302, headers: { location: 'http://[::1' } }),
    };
    const sourceFor: Record<string, keyof typeof brokenSources> = {
      'notizia-lenta': 'stall',
      'notizia-interrotta': 'broken',
      'notizia-redirect-rotto': 'badRedirect',
    };
    for (const id of Object.keys(sourceFor)) {
      const file = path.join(root, bodyPath('it', id));
      fs.writeFileSync(file, bodyModule(id, IT_BODY.replace(SOURCE_URL, `https://www.ticinonews.ch/${id}`)));
    }
    const fetchImpl = async (url: string, init: RequestInit) => {
      const id = Object.keys(sourceFor).find((key) => url.endsWith(`/${key}`));
      return id ? brokenSources[sourceFor[id]](init) : htmlResponse(SOURCE_HTML);
    };
    const { rows, summary } = await produceVerdicts({ root, ids, fetchImpl, timeoutMs: 50 });
    expect(summary.skipped['fetch-failed']).toBe(Object.keys(sourceFor).length);
    expect(summary.skippedDetail.map((entry: { articleId: string }) => entry.articleId)).toEqual(Object.keys(sourceFor));
    expect(summary.skippedDetail[0].detail).toMatch(/timeout after 50ms/);
    expect(rows.map((row) => row.articleId)).toEqual(['notizia-recente', 'notizia-recente', 'notizia-recente', 'notizia-recente']);
  });

  it('refuses a redirect towards an IP literal and records a followed third-party redirect', async () => {
    const root = tempRoot([{ id: 'notizia-recente' }]);
    const toIp = await produceVerdicts({
      root,
      ids: ['notizia-recente'],
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://10.0.0.1/x' } }),
    });
    expect(toIp.rows).toEqual([]);
    expect(toIp.summary.skipped['fetch-failed']).toBe(1);

    const moved = 'https://www.ticinonews.ch/ticino/articolo-spostato-433327';
    const followed = await produceVerdicts({
      root,
      ids: ['notizia-recente'],
      fetchImpl: async (url: string) => (url === SOURCE_URL
        ? new Response(null, { status: 301, headers: { location: moved } })
        : htmlResponse(SOURCE_HTML)),
    });
    expect(followed.rows[0].evidence.sourceUrl).toBe(SOURCE_URL);
    expect(followed.rows[0].evidence.sourceFinalUrl).toBe(moved);
  });

  it('a PDF or an empty JavaScript shell is unreadable, not a defect', async () => {
    const root = tempRoot([{ id: 'notizia-recente' }]);
    const pdf = await produceVerdicts({
      root,
      ids: ['notizia-recente'],
      fetchImpl: async () => new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    });
    const shell = await produceVerdicts({
      root,
      ids: ['notizia-recente'],
      fetchImpl: async () => htmlResponse('<html><body><div id="app"></div><script>render()</script></body></html>'),
    });
    for (const result of [pdf, shell]) {
      expect(result.rows).toEqual([]);
      expect(result.summary.skipped['source-unreadable']).toBe(1);
    }
  });

  it('counts missing citation, figures and locale bodies by reason', async () => {
    const root = tempRoot([{ id: 'notizia-recente', locales: ['it', 'en', 'de'] }, { id: 'notizia-intermedia', locales: [] }]);
    const { rows, summary } = await produceVerdicts({ root, ids: ['notizia-recente', 'notizia-intermedia'], fetchImpl: async () => htmlResponse(SOURCE_HTML) });
    expect(rows.map((row) => row.locale)).toEqual(['it', 'en', 'de']);
    expect(summary.skipped['locale-missing']).toBe(2);
    expect(summary.skippedDetail).toEqual(expect.arrayContaining([
      expect.objectContaining({ articleId: 'notizia-recente', locale: 'fr', reason: 'locale-missing' }),
      expect.objectContaining({ articleId: 'notizia-intermedia', locale: 'it', reason: 'locale-missing' }),
    ]));
  });

  it('main appends rows to --out, writes --summary and succeeds with zero rows', async () => {
    const root = tempRoot([{ id: 'notizia-recente' }]);
    const out = path.join(root, 'run', 'l6.jsonl');
    const summaryPath = path.join(root, 'run', 'l6-summary.json');
    const quiet = { write: () => true };
    await main({ argv: ['--limit', '1', '--root', root, '--out', out, '--summary', summaryPath], stdout: quiet, fetchImpl: async () => htmlResponse(SOURCE_HTML) });
    const lines = fs.readFileSync(out, 'utf8').trim().split('\n');
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    expect(summary.rowsWritten).toBe(lines.length);
    expect(summary.selected).toBe(1);

    fs.rmSync(out);
    await main({ argv: ['--limit', '1', '--root', root, '--out', out, '--summary', summaryPath], stdout: quiet, fetchImpl: async () => new Response('', { status: 500 }) });
    expect(fs.readFileSync(out, 'utf8')).toBe('');
    expect(JSON.parse(fs.readFileSync(summaryPath, 'utf8')).rowsWritten).toBe(0);
  });
});
