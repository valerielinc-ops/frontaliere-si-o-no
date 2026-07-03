import { describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pure-ESM script. The CLI block is gated on `import.meta.url ===
// file://${process.argv[1]}`, so importing is side-effect-free.
import * as scheduler from '../../scripts/schedule-fb-articles-daily.mjs';

interface ArticleLike {
  id: string;
  section: 'frontaliere' | 'svizzera';
  category?: string;
  date: string;
  url: string;
  ogTitle: string;
  ogDescription?: string;
}

interface PostedEntry {
  id: string;
  url: string;
  ts: string;
  fbPostId: string;
}

interface PostedLedger {
  schemaVersion: number;
  posted: PostedEntry[];
}

interface Payload {
  articleId: string;
  section: string;
  url: string;
  message: string;
}

const {
  parseArticleRegistry,
  parseSlugMap,
  parseMetaMap,
  loadArticles,
  selectUnpostedArticles,
  buildArticleUrl,
  buildArticleCaption,
  loadPosted,
  appendPosted,
  run,
} = scheduler as unknown as {
  parseArticleRegistry: (src: string) => Array<{ id: string; category?: string; date: string }>;
  parseSlugMap: (src: string) => Record<string, string>;
  parseMetaMap: (src: string) => Record<string, { title?: string; excerpt?: string }>;
  loadArticles: (repoRoot: string, log?: (...a: unknown[]) => void) => ArticleLike[];
  selectUnpostedArticles: (
    articles: ArticleLike[],
    postedSet: Set<string>,
    opts?: { maxAgeDays?: number; limit?: number; now?: Date },
  ) => ArticleLike[];
  buildArticleUrl: (section: string, slugIt: string) => string | null;
  buildArticleCaption: (a: { ogTitle: string; ogDescription?: string; category?: string }) => string;
  loadPosted: (repoRoot: string) => PostedLedger;
  appendPosted: (repoRoot: string, entries: PostedEntry[]) => void;
  run: (opts: {
    env?: Record<string, string | undefined>;
    now?: Date;
    repoRoot?: string;
    fetchImpl?: typeof fetch;
    log?: (...a: unknown[]) => void;
    warn?: (...a: unknown[]) => void;
  }) => Promise<{ ok: boolean; posted: number; dryRun: boolean; payloads: Payload[] }>;
};

// ── parseArticleRegistry ──────────────────────────────────

describe('parseArticleRegistry', () => {
  const REGISTRY = `
import type { BlogArticleId } from '@/services/router';
export interface Article {
 id: string;
 category: 'fiscale' | 'pratico' | 'novita' | 'pensione';
 date: string;
}
const RAW_ARTICLES = [
 {
 id: 'stipendio-netto-2026',
 category: 'fiscale',
 date: '2026-01-15',
 updatedAt: '2026-04-03',
 image: '/images/places/lugano-view.webp',
 },
 {
 id: 'lamal-vs-cmi',
 category: 'pratico',
 date: '2026-02-20',
 image: cdnBlogImage('mendrisio.webp'),
 },
];`;

  it('parses id, category, date for each entry', () => {
    const out = parseArticleRegistry(REGISTRY);
    expect(out).toEqual([
      { id: 'stipendio-netto-2026', category: 'fiscale', date: '2026-01-15' },
      { id: 'lamal-vs-cmi', category: 'pratico', date: '2026-02-20' },
    ]);
  });

  it('does NOT emit a phantom entry from the Article interface block', () => {
    // The interface has `id: string;` (no quoted value) → must be skipped.
    const out = parseArticleRegistry(REGISTRY);
    expect(out.find((a) => a.date === undefined)).toBeUndefined();
    expect(out).toHaveLength(2);
  });

  it('skips entries without a quoted date', () => {
    const src = `const X = [{ id: 'no-date', category: 'novita' }];`;
    expect(parseArticleRegistry(src)).toEqual([]);
  });

  it('returns [] for empty / non-string input', () => {
    expect(parseArticleRegistry('')).toEqual([]);
    expect(parseArticleRegistry(null as unknown as string)).toEqual([]);
  });
});

// ── parseSlugMap ──────────────────────────────────────────

describe('parseSlugMap', () => {
  it('maps article id → IT slug', () => {
    const src = `export const BLOG_SLUGS = {
 'stipendio-netto-2026': { it: 'stipendio-netto-frontaliere-2026', en: 'cross-border-net-salary-2026', de: 'x', fr: 'y' },
 'lamal-vs-cmi': { it: 'lamal-vs-cmi-frontaliere', en: 'z', de: 'a', fr: 'b' },
};`;
    const map = parseSlugMap(src);
    expect(map['stipendio-netto-2026']).toBe('stipendio-netto-frontaliere-2026');
    expect(map['lamal-vs-cmi']).toBe('lamal-vs-cmi-frontaliere');
  });

  it('returns {} for empty input', () => {
    expect(parseSlugMap('')).toEqual({});
  });
});

// ── parseMetaMap ──────────────────────────────────────────

describe('parseMetaMap', () => {
  it('maps id → title + excerpt and unescapes apostrophes', () => {
    const src = `const blogMetaIt = {
 'blog.article.stipendio-netto-2026.title': 'Stipendio netto 2026',
 'blog.article.stipendio-netto-2026.excerpt': 'Guida completa, porta d\\'ingresso al calcolo.',
 'blog.article.stipendio-netto-2026.imageAlt': 'Lugano',
};`;
    const map = parseMetaMap(src);
    expect(map['stipendio-netto-2026'].title).toBe('Stipendio netto 2026');
    expect(map['stipendio-netto-2026'].excerpt).toBe("Guida completa, porta d'ingresso al calcolo.");
  });

  it('returns {} for empty input', () => {
    expect(parseMetaMap('')).toEqual({});
  });
});

// ── loadArticles (joins the three sources via tmp files) ──

describe('loadArticles', () => {
  function setup(): string {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-art-load-'));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    mkdirSync(join(tmp, 'services', 'locales'), { recursive: true });
    // frontaliere
    writeFileSync(
      join(tmp, 'data', 'blog-articles-data.ts'),
      `const RAW_ARTICLES = [{ id: 'a1', category: 'fiscale', date: '2026-06-10' }, { id: 'no-meta', category: 'pratico', date: '2026-06-11' }];`,
    );
    writeFileSync(
      join(tmp, 'services', 'routerBlogData.ts'),
      `export const BLOG_SLUGS = { 'a1': { it: 'articolo-uno', en: 'x', de: 'y', fr: 'z' }, 'no-meta': { it: 'senza-meta', en: 'x', de: 'y', fr: 'z' } };`,
    );
    writeFileSync(
      join(tmp, 'services', 'locales', 'blog-meta-it.ts'),
      `const m = { 'blog.article.a1.title': 'Titolo Uno', 'blog.article.a1.excerpt': 'Estratto uno.' };`,
    );
    // svizzera (empty registry but files present)
    writeFileSync(join(tmp, 'data', 'swiss-articles-data.ts'), `const RAW_SWISS_ARTICLES = [];`);
    writeFileSync(join(tmp, 'services', 'routerSwissData.ts'), `export const SWISS_SLUGS = {};`);
    writeFileSync(join(tmp, 'services', 'locales', 'blog-meta-ch-it.ts'), `const m = {};`);
    return tmp;
  }

  it('joins registry+slug+meta and drops articles missing a title', () => {
    const tmp = setup();
    const out = loadArticles(tmp);
    // 'no-meta' has a slug but no title → dropped. Only 'a1' survives.
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'a1',
      section: 'frontaliere',
      category: 'fiscale',
      date: '2026-06-10',
      url: 'https://frontaliereticino.ch/articoli-frontaliere/articolo-uno/',
      ogTitle: 'Titolo Uno',
      ogDescription: 'Estratto uno.',
    });
  });
});

// ── selectUnpostedArticles ────────────────────────────────

describe('selectUnpostedArticles', () => {
  const NOW = new Date(Date.UTC(2026, 5, 12, 12, 0, 0)); // 2026-06-12
  const articles: ArticleLike[] = [
    { id: 'fresh-1', section: 'frontaliere', date: '2026-06-12', url: 'u', ogTitle: 't' },
    { id: 'fresh-2', section: 'svizzera', date: '2026-06-11', url: 'u', ogTitle: 't' },
    { id: 'old', section: 'frontaliere', date: '2026-06-01', url: 'u', ogTitle: 't' },
    { id: 'bad-date', section: 'frontaliere', date: 'not-a-date', url: 'u', ogTitle: 't' },
  ];

  it('keeps only articles within the recency window, most-recent first', () => {
    const out = selectUnpostedArticles(articles, new Set(), { maxAgeDays: 2, limit: 10, now: NOW });
    expect(out.map((a) => a.id)).toEqual(['fresh-1', 'fresh-2']);
  });

  it('excludes already-posted ids', () => {
    const out = selectUnpostedArticles(articles, new Set(['fresh-1']), { maxAgeDays: 2, limit: 10, now: NOW });
    expect(out.map((a) => a.id)).toEqual(['fresh-2']);
  });

  it('respects the per-run limit', () => {
    const out = selectUnpostedArticles(articles, new Set(), { maxAgeDays: 30, limit: 1, now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('fresh-1');
  });

  it('drops unparseable dates', () => {
    const out = selectUnpostedArticles(articles, new Set(), { maxAgeDays: 9999, limit: 10, now: NOW });
    expect(out.map((a) => a.id)).not.toContain('bad-date');
  });

  it('returns [] for non-array input', () => {
    expect(selectUnpostedArticles(null as unknown as ArticleLike[], new Set(), {})).toEqual([]);
  });
});

// ── buildArticleUrl / buildArticleCaption ─────────────────

describe('buildArticleUrl', () => {
  it('builds a trailing-slash IT URL per section', () => {
    expect(buildArticleUrl('frontaliere', 'mio-slug')).toBe(
      'https://frontaliereticino.ch/articoli-frontaliere/mio-slug/',
    );
    expect(buildArticleUrl('svizzera', 'mio-slug')).toBe(
      'https://frontaliereticino.ch/articoli-svizzera/mio-slug/',
    );
  });

  it('returns null when slug or section is missing', () => {
    expect(buildArticleUrl('frontaliere', '')).toBeNull();
    expect(buildArticleUrl('unknown', 'x')).toBeNull();
  });
});

describe('buildArticleCaption', () => {
  it('uses category emoji + hashtags and includes title/description', () => {
    const c = buildArticleCaption({ ogTitle: 'Mio Titolo', ogDescription: 'Mia descrizione.', category: 'fiscale' });
    expect(c).toContain('📊 Mio Titolo');
    expect(c).toContain('Mia descrizione.');
    expect(c).toContain("👉 Leggi l'articolo completo:");
    expect(c).toContain('#frontalieri #ticino #tasse #fisco #svizzera #italia');
  });

  it('falls back to the default emoji + hashtags for an unknown category', () => {
    const c = buildArticleCaption({ ogTitle: 'X', category: 'mistero' });
    expect(c).toContain('📰 X');
    expect(c).toContain('#frontalieri #ticino #lavoro #svizzera #italia');
  });
});

// ── loadPosted / appendPosted ─────────────────────────────

describe('loadPosted / appendPosted', () => {
  it('round-trips via <repoRoot>/data/fb-posted-articles.json', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-art-ledger-'));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    appendPosted(tmp, [{ id: 'a', url: 'u', ts: 't', fbPostId: 'p1' }]);
    const raw = readFileSync(join(tmp, 'data', 'fb-posted-articles.json'), 'utf-8');
    expect(JSON.parse(raw).posted[0].id).toBe('a');
    expect(loadPosted(tmp).posted).toHaveLength(1);
  });

  it('returns empty for a missing ledger', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-art-miss-'));
    expect(loadPosted(tmp).posted).toEqual([]);
  });
});

// ── run() integration ─────────────────────────────────────

describe('run()', () => {
  function setupRepo(opts: { articles: Array<{ id: string; date: string }>; posted?: string[] }): string {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-art-run-'));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    mkdirSync(join(tmp, 'services', 'locales'), { recursive: true });
    const reg = opts.articles
      .map((a) => `{ id: '${a.id}', category: 'novita', date: '${a.date}' }`)
      .join(', ');
    const slugs = opts.articles.map((a) => `'${a.id}': { it: '${a.id}-slug', en: 'x', de: 'y', fr: 'z' }`).join(', ');
    const meta = opts.articles
      .map((a) => `'blog.article.${a.id}.title': 'Titolo ${a.id}', 'blog.article.${a.id}.excerpt': 'Estratto ${a.id}.'`)
      .join(', ');
    writeFileSync(join(tmp, 'data', 'blog-articles-data.ts'), `const RAW_ARTICLES = [${reg}];`);
    writeFileSync(join(tmp, 'services', 'routerBlogData.ts'), `export const BLOG_SLUGS = { ${slugs} };`);
    writeFileSync(join(tmp, 'services', 'locales', 'blog-meta-it.ts'), `const m = { ${meta} };`);
    writeFileSync(join(tmp, 'data', 'swiss-articles-data.ts'), `const RAW_SWISS_ARTICLES = [];`);
    writeFileSync(join(tmp, 'services', 'routerSwissData.ts'), `export const SWISS_SLUGS = {};`);
    writeFileSync(join(tmp, 'services', 'locales', 'blog-meta-ch-it.ts'), `const m = {};`);
    writeFileSync(
      join(tmp, 'data', 'fb-posted-articles.json'),
      JSON.stringify({ schemaVersion: 1, posted: (opts.posted || []).map((id) => ({ id, url: 'u', ts: 't', fbPostId: 'p' })) }),
    );
    return tmp;
  }

  const NOW = new Date(Date.UTC(2026, 5, 12, 12, 0, 0));

  it('DRY_RUN: no fetch, payloads for recent unposted articles', async () => {
    const tmp = setupRepo({ articles: [{ id: 'a1', date: '2026-06-12' }, { id: 'a2', date: '2026-06-01' }] });
    const fetchSpy = vi.fn<typeof fetch>();
    const result = await run({
      env: { DRY_RUN: '1', FB_ARTICLE_MAX_AGE_DAYS: '2', FB_PAGE_ID: 'pid', FB_PAGE_ACCESS_TOKEN: 'tok' },
      now: NOW,
      repoRoot: tmp,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: () => {},
      warn: () => {},
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    // a2 is older than the 2-day window → excluded.
    expect(result.payloads.map((p) => p.articleId)).toEqual(['a1']);
    expect(result.payloads[0].url).toBe('https://frontaliereticino.ch/articoli-frontaliere/a1-slug/');
    // Ledger untouched in dry-run.
    expect(loadPosted(tmp).posted).toHaveLength(0);
  });

  it('real run: posts each article (preflight + rescrape + feed) and updates the ledger', async () => {
    const tmp = setupRepo({ articles: [{ id: 'a1', date: '2026-06-12' }] });
    const fetchSpy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      // Pre-flight HEAD probe of the landing page → live (2xx).
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      if (u.includes('scrape=true')) return new Response(JSON.stringify({ scraped: true }), { status: 200 });
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ id: 'pid_post_1' }), { status: 200 });
    });
    const result = await run({
      env: { FB_ARTICLE_MAX_AGE_DAYS: '2', FB_PAGE_ID: 'pid', FB_PAGE_ACCESS_TOKEN: 'tok' },
      now: NOW,
      repoRoot: tmp,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: () => {},
      warn: () => {},
    });
    expect(result.posted).toBe(1);
    expect(result.ok).toBe(true);
    // pre-flight HEAD + OG rescrape + /feed POST = 3 calls.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const ledger = loadPosted(tmp);
    expect(ledger.posted).toHaveLength(1);
    expect(ledger.posted[0].id).toBe('a1');
    expect(ledger.posted[0].fbPostId).toBe('pid_post_1');
  });

  it('skips the post when the landing page is not live yet (HEAD 4xx)', async () => {
    const tmp = setupRepo({ articles: [{ id: 'a1', date: '2026-06-12' }] });
    const fetchSpy = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 404 });
      return new Response(JSON.stringify({ id: 'pid_post_1' }), { status: 200 });
    });
    const result = await run({
      env: { FB_ARTICLE_MAX_AGE_DAYS: '2', FB_PAGE_ID: 'pid', FB_PAGE_ACCESS_TOKEN: 'tok' },
      now: NOW,
      repoRoot: tmp,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: () => {},
      warn: () => {},
    });
    expect(result.posted).toBe(0);
    expect(result.skipped).toBe(1);
    // a 4xx landing short-circuits before any rescrape/feed POST.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(loadPosted(tmp).posted).toHaveLength(0);
  });

  it('does not re-post an article already in the ledger', async () => {
    const tmp = setupRepo({ articles: [{ id: 'a1', date: '2026-06-12' }], posted: ['a1'] });
    const fetchSpy = vi.fn<typeof fetch>();
    const result = await run({
      env: { FB_ARTICLE_MAX_AGE_DAYS: '2', FB_PAGE_ID: 'pid', FB_PAGE_ACCESS_TOKEN: 'tok' },
      now: NOW,
      repoRoot: tmp,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: () => {},
      warn: () => {},
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.posted).toBe(0);
  });

  it('soft-fails when credentials are missing (no fetch, ok=false)', async () => {
    const tmp = setupRepo({ articles: [{ id: 'a1', date: '2026-06-12' }] });
    const fetchSpy = vi.fn<typeof fetch>();
    const warns: string[] = [];
    const result = await run({
      env: { FB_ARTICLE_MAX_AGE_DAYS: '2' }, // no creds
      now: NOW,
      repoRoot: tmp,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: () => {},
      warn: (...a) => warns.push(a.join(' ')),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(warns.some((w) => w.toLowerCase().includes('missing'))).toBe(true);
  });

  it('exits gracefully when no recent articles exist', async () => {
    const tmp = setupRepo({ articles: [{ id: 'old', date: '2026-01-01' }] });
    const fetchSpy = vi.fn<typeof fetch>();
    const result = await run({
      env: { DRY_RUN: '1', FB_ARTICLE_MAX_AGE_DAYS: '2' },
      now: NOW,
      repoRoot: tmp,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      log: () => {},
      warn: () => {},
    });
    expect(result.posted).toBe(0);
    expect(result.payloads).toEqual([]);
  });
});

// Ledger file existence sanity (mirrors the jobs scheduler test).
describe('ledger path', () => {
  it('is a no-op for an empty append (no file created)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fb-art-noop-'));
    mkdirSync(join(tmp, 'data'), { recursive: true });
    appendPosted(tmp, []);
    expect(existsSync(join(tmp, 'data', 'fb-posted-articles.json'))).toBe(false);
  });
});
