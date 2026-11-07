import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DISCOVERY_ARTICLES_ARTIFACT } from '../../scripts/lib/newsletter-discovery-selection.mjs';
import { syncDiscoveryArticleSnapshot } from '../../scripts/ci/discovery-article-snapshot.mjs';

const temporaryDirectories: string[] = [];
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function article(id: string, now: number) {
  return {
    id,
    publishedAt: new Date(now - 60_000).toISOString(),
    provider: 'google_trends',
    title: { it: `Titolo ${id}`, en: `Title ${id}`, de: `Titel ${id}`, fr: `Titre ${id}` },
    excerpt: { it: `Estratto ${id}`, en: `Excerpt ${id}`, de: `Auszug ${id}`, fr: `Extrait ${id}` },
    url: {
      it: `/articoli-frontaliere/${id}/`,
      en: `/en/cross-border-articles/${id}-en/`,
      de: `/de/grenzgaenger-artikel/${id}-de/`,
      fr: `/fr/articles-frontaliers/${id}-fr/`,
    },
  };
}

function snapshot(now: number, articles: ReturnType<typeof article>[], commit = COMMIT) {
  const index = {
    schema: 1,
    commit,
    generatedAt: new Date(now).toISOString(),
    count: articles.length,
    articles,
  };
  const rawIndex = JSON.stringify(index);
  const rawManifest = JSON.stringify({
    schema: 1,
    commit,
    files: { [DISCOVERY_ARTICLES_ARTIFACT]: Buffer.byteLength(rawIndex, 'utf8') },
    counts: { discoveryArticles: articles.length },
  });
  return { index, rawIndex, rawManifest };
}

function files() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-snapshot-'));
  temporaryDirectories.push(directory);
  return {
    indexFilePath: path.join(directory, 'discovery-articles.json'),
    manifestFilePath: path.join(directory, 'discovery-articles-manifest.json'),
  };
}

function html(title: string, canonical: string) {
  return `<!doctype html><html><head><title>${title} | Frontaliere Ticino</title>
    <meta property="og:title" content="${title}">
    <link rel="canonical" href="${canonical}"></head><body>
    <article class="ft-blog-article"><h1>${title}</h1><p>${'Contenuto articolo verificato. '.repeat(8)}</p></article>
    </body></html>`;
}

function apiAndRouteFetch(payload: ReturnType<typeof snapshot>['index'], rawIndex: string, rawManifest: string, {
  failPath = '',
  failedStatus = 403,
}: { failPath?: string; failedStatus?: number } = {}) {
  const routes: string[] = [];
  const articlesByUrl = new Map<string, { title: string }>();
  for (const item of payload.articles) {
    for (const [locale, url] of Object.entries(item.url)) {
      articlesByUrl.set(url, { title: item.title[locale as keyof typeof item.title] });
    }
  }

  const fetchImpl = async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/manifest.json')) {
      return { ok: true, status: 200, text: async () => rawManifest };
    }
    if (url.pathname.endsWith(`/${DISCOVERY_ARTICLES_ARTIFACT}`)) {
      return { ok: true, status: 200, text: async () => rawIndex };
    }
    routes.push(url.pathname);
    const articlePage = articlesByUrl.get(url.pathname);
    if (url.pathname === failPath) {
      return { ok: false, status: failedStatus, url: url.href, text: async () => 'challenge' };
    }
    if (!articlePage) return { ok: false, status: 404, url: url.href, text: async () => 'not found' };
    return {
      ok: true,
      status: 200,
      url: url.href,
      text: async () => html(articlePage.title, url.pathname),
    };
  };
  return { fetchImpl, routes };
}

describe('syncDiscoveryArticleSnapshot', () => {
  it('writes one manifest-pinned snapshot only after every selectable route is live, then reuses its route proof', async () => {
    const now = Date.now();
    const item = article('trend-a', now);
    const reddit = { ...article('reddit-a', now), provider: 'reddit' };
    const old = {
      ...article('old-trend', now - 61 * 24 * 60 * 60 * 1000),
      publishedAt: new Date(now - 61 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const source = snapshot(now, [item, reddit, old]);
    const output = files();
    const { fetchImpl, routes } = apiAndRouteFetch(source.index, source.rawIndex, source.rawManifest);

    const first = await syncDiscoveryArticleSnapshot({
      ...output,
      apiBase: 'https://api.example.test/corpus',
      fetchImpl,
      now: new Date(now),
      retries: 0,
    });

    expect(first).toMatchObject({ status: 'ready', changed: true, commit: COMMIT, count: 3 });
    expect(routes.sort()).toEqual(Object.values(item.url).sort());
    expect(fs.readFileSync(output.indexFilePath, 'utf8')).toBe(source.rawIndex);
    const compact = JSON.parse(fs.readFileSync(output.manifestFilePath, 'utf8'));
    expect(compact).toMatchObject({
      commit: COMMIT,
      counts: { discoveryArticles: 3 },
      routeReadiness: { schema: 1, entries: { 'trend-a': { verifiedAt: new Date(now).toISOString() } } },
    });

    routes.length = 0;
    const second = await syncDiscoveryArticleSnapshot({
      ...output,
      apiBase: 'https://api.example.test/corpus',
      fetchImpl,
      now: new Date(now),
      retries: 0,
      routeRetries: 0,
    });
    expect(second).toMatchObject({ status: 'unchanged', changed: false, commit: COMMIT, count: 3 });
    expect(routes).toEqual([]);
  });

  it('keeps the last-known-good pair when a newly published route is not ready', async () => {
    const now = Date.now();
    const previous = snapshot(now, [article('old-trend', now)], 'f'.repeat(40));
    const current = snapshot(now, [article('new-trend', now)]);
    const output = files();
    fs.writeFileSync(output.indexFilePath, previous.rawIndex);
    fs.writeFileSync(output.manifestFilePath, previous.rawManifest);
    const { fetchImpl } = apiAndRouteFetch(current.index, current.rawIndex, current.rawManifest, {
      failPath: '/fr/articles-frontaliers/new-trend-fr/',
      failedStatus: 403,
    });

    const result = await syncDiscoveryArticleSnapshot({
      ...output,
      apiBase: 'https://api.example.test/corpus',
      fetchImpl,
      now: new Date(now),
      retries: 0,
      routeRetries: 0,
    });

    expect(result).toMatchObject({ status: 'not-ready', changed: false, count: 1 });
    expect(result.readinessFailures).toMatchObject([{ articleId: 'new-trend', locale: 'fr', reason: 'indeterminate_waf: HTTP 403' }]);
    expect(fs.readFileSync(output.indexFilePath, 'utf8')).toBe(previous.rawIndex);
    expect(fs.readFileSync(output.manifestFilePath, 'utf8')).toBe(previous.rawManifest);
  });

  it('publishes a valid empty API release instead of leaving a stale non-empty snapshot', async () => {
    const now = Date.now();
    const previous = snapshot(now, [article('old-trend', now)], 'f'.repeat(40));
    const empty = snapshot(now, []);
    const output = files();
    fs.writeFileSync(output.indexFilePath, previous.rawIndex);
    fs.writeFileSync(output.manifestFilePath, previous.rawManifest);
    const { fetchImpl, routes } = apiAndRouteFetch(empty.index, empty.rawIndex, empty.rawManifest);

    const result = await syncDiscoveryArticleSnapshot({
      ...output,
      apiBase: 'https://api.example.test/corpus',
      fetchImpl,
      now: new Date(now),
      retries: 0,
      routeRetries: 0,
    });

    expect(result).toMatchObject({ status: 'ready', changed: true, count: 0 });
    expect(JSON.parse(fs.readFileSync(output.indexFilePath, 'utf8'))).toMatchObject({ count: 0, articles: [] });
    expect(JSON.parse(fs.readFileSync(output.manifestFilePath, 'utf8'))).toMatchObject({
      commit: COMMIT,
      counts: { discoveryArticles: 0 },
      routeReadiness: { entries: {} },
    });
    expect(routes).toEqual([]);
  });
});
