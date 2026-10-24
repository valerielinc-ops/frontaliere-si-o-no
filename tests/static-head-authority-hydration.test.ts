// @vitest-environment jsdom
/**
 * The static head survives hydration (services/seo/staticHeadAuthority.ts).
 *
 * 2026-10 SEO audit, P1: the SPA rewrote the head the build had emitted —
 * JobBoard removed the static `noindex` of expired/orphan offers, wrote the
 * canonical from `window.location.origin`, and seoService rebuilt hreflang
 * towards every locale whether the twin existed or not. Googlebot reads the
 * rendered head, so the SPA's version is the one that counted.
 *
 * Each case seeds the head a build plugin would serve for one page family
 * (an offer, an expired offer, an article, a hub), runs the SPA head writers
 * that hydration runs on that URL, and compares the head before and after:
 * canonical and hreflang must be identical, and a static `noindex` must still
 * be there. The last cases are the controls — the generic SPA shell and a soft
 * navigation, where the SPA must still write the head.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildPath, getSeoSection, parsePath, preloadBlogData, type AppRoute } from '../services/router';
import { loadAllLocaleChunks, loadBlogMeta, mergeArticleMetaOverlay, setLocale } from '../services/i18n';
import { resetArticleBodyApiForTests } from '../services/articleBodyApi';
import { __resetStaticArticleFallback } from '../services/staticArticleFallback';
import {
  applyCanonicalHref,
  captureStaticHead,
  clearSpaNoindex,
  hasAuthoritativeStaticHead,
  resetStaticHeadAuthorityForTests,
} from '../services/seo/staticHeadAuthority';

const { updateMetaTags } = await vi.importActual<typeof import('../services/seoService')>('../services/seoService');

const BASE = 'https://frontaliereticino.ch';

interface HeadFixture {
  robots: string;
  canonical: string | null;
  hreflang: [string, string][];
}

function seedHead(f: HeadFixture): void {
  const links = f.hreflang
    .map(([lang, href]) => `<link rel="alternate" hreflang="${lang}" href="${href}">`)
    .join('');
  document.head.innerHTML = [
    '<title>Static page</title>',
    `<meta name="robots" content="${f.robots}">`,
    f.canonical ? `<link rel="canonical" href="${f.canonical}">` : '',
    links,
  ].join('');
}

function readHead() {
  return {
    noindex: /\bnoindex\b/i.test(document.querySelector('meta[name="robots"]')?.getAttribute('content') || ''),
    canonicals: Array.from(document.querySelectorAll('link[rel="canonical"]')).map((el) => el.getAttribute('href')),
    hreflang: Array.from(document.querySelectorAll('link[hreflang]'))
      .map((el) => `${el.getAttribute('hreflang')} ${el.getAttribute('href')}`)
      .sort(),
  };
}

/** Navigate (as the served URL), then record the head the document came with. */
function serve(path: string, head: HeadFixture) {
  window.history.replaceState({}, '', path);
  seedHead(head);
  resetStaticHeadAuthorityForTests();
  captureStaticHead();
  return readHead();
}

/** What hydration of a job-board URL does to the head (JobBoard + seoService). */
async function hydrateJobBoard(path: string) {
  const { route } = parsePath(path);
  await updateMetaTags(getSeoSection(route));
  // JobBoard's metadata effect, in its listing fallback, and its orphan branch.
  applyCanonicalHref(`${BASE}/cerca-lavoro-ticino/`);
  clearSpaNoindex();
}

function useLegacyArticleBodyApi(): void {
  resetArticleBodyApiForTests();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/manifest.json')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ commit: 'static-head-test' }) };
    }
    return { ok: false, status: 404, text: async () => '' };
  }));
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  __resetStaticArticleFallback();
  resetArticleBodyApiForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '', json: async () => ({}) }));
  document.body.innerHTML = '<div id="root"></div>';
  document.documentElement.lang = 'it';
  await loadAllLocaleChunks('it');
  setLocale('it');
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetStaticHeadAuthorityForTests();
});

describe('static head is authoritative after hydration', () => {
  it('active offer: canonical and hreflang survive the JobBoard and seoService passes', async () => {
    const path = '/cerca-lavoro-ticino/infermiere-diplomato-ente-ospedaliero-cantonale-lugano/';
    const before = serve(path, {
      robots: 'index,follow',
      canonical: `${BASE}${path}`,
      hreflang: [
        ['it', `${BASE}${path}`],
        ['en', `${BASE}/en/find-jobs-ticino/registered-nurse-ente-ospedaliero-cantonale-lugano/`],
        ['x-default', `${BASE}${path}`],
      ],
    });
    await hydrateJobBoard(path);
    expect(readHead()).toEqual(before);
  });

  it('expired offer: the static noindex is not lifted and the canonical stays', async () => {
    const path = '/cerca-lavoro-ticino/magazziniere-scaduto-mendrisio/';
    const before = serve(path, {
      robots: 'noindex,follow',
      canonical: `${BASE}${path}`,
      hreflang: [],
    });
    expect(before.noindex).toBe(true);
    await hydrateJobBoard(path);
    expect(readHead()).toEqual(before);
  });

  it('article: hreflang towards existing translations only and the canonical survive; a static noindex stays', async () => {
    useLegacyArticleBodyApi();
    await preloadBlogData();
    await loadBlogMeta('frontaliere');
    const id = 'static-head-authority-article';
    mergeArticleMetaOverlay('it', {
      [`blog.article.${id}.title`]: 'Articolo di prova per la testa statica',
      [`blog.article.${id}.excerpt`]: 'Fixture stabile per la verifica della testa statica.',
      [`blog.article.${id}.body1`]: 'Primo paragrafo completo e verificato.',
      [`blog.article.${id}.body2`]: 'Secondo paragrafo completo e verificato.',
    });
    const route: AppRoute = { activeTab: 'blog', blogArticle: id as AppRoute['blogArticle'] };
    const path = buildPath(route, 'it');
    // Only a German translation exists: the SPA would otherwise emit all four.
    const indexable = serve(path, {
      robots: 'index,follow',
      canonical: `${BASE}${path}`,
      hreflang: [
        ['it', `${BASE}${path}`],
        ['de', `${BASE}/de/blog/static-head-authority-artikel/`],
        ['x-default', `${BASE}${path}`],
      ],
    });
    await updateMetaTags(`blog-${id}`);
    expect(readHead()).toEqual(indexable);

    const quarantined = serve(path, { robots: 'noindex,follow', canonical: `${BASE}${path}`, hreflang: [] });
    await updateMetaTags(`blog-${id}`);
    expect(readHead()).toEqual(quarantined);
    // The blog registry/meta preload is the slow part (same cost as
    // tests/article-prompt-placeholder-runtime-robots.test.ts), not the guard.
  }, 60_000);

  it('hub: canonical and hreflang survive; a below-floor bridge keeps noindex and gains no canonical', async () => {
    const path = buildPath({ activeTab: 'job-board' }, 'it');
    const hub = serve(path, {
      robots: 'index,follow',
      canonical: `${BASE}${path}`,
      hreflang: [
        ['it', `${BASE}${path}`],
        ['en', `${BASE}${buildPath({ activeTab: 'job-board' }, 'en')}`],
        ['x-default', `${BASE}${path}`],
      ],
    });
    await hydrateJobBoard(path);
    expect(readHead()).toEqual(hub);

    const bridge = serve(path, { robots: 'noindex,follow', canonical: null, hreflang: [] });
    await hydrateJobBoard(path);
    expect(readHead()).toEqual(bridge);
  });
});

describe('controls: where the SPA still owns the head', () => {
  it('generic SPA shell (homepage canonical on another URL): the SPA writes its own canonical', async () => {
    const path = buildPath({ activeTab: 'job-board' }, 'it');
    serve(path, {
      robots: 'index, follow',
      canonical: `${BASE}/`,
      hreflang: [['it', `${BASE}/`], ['en', `${BASE}/en/`]],
    });
    await updateMetaTags(getSeoSection({ activeTab: 'job-board' }));
    const after = readHead();
    expect(after.canonicals).toEqual([`${BASE}${path}`]);
    expect(after.hreflang).toContain(`it ${BASE}${path}`);
  });

  it('soft navigation away from the served URL: the SPA writes the new page head', async () => {
    const servedPath = '/cerca-lavoro-ticino/magazziniere-scaduto-mendrisio/';
    serve(servedPath, { robots: 'noindex,follow', canonical: `${BASE}${servedPath}`, hreflang: [] });
    const nextPath = buildPath({ activeTab: 'job-board' }, 'it');
    window.history.pushState({}, '', nextPath);
    await updateMetaTags(getSeoSection({ activeTab: 'job-board' }));
    const after = readHead();
    expect(after.noindex).toBe(false);
    expect(after.canonicals).toEqual([`${BASE}${nextPath}`]);
  });

  it('does not restore static authority after leaving and returning to the initial pathname', () => {
    const servedPath = '/foo/';
    serve(servedPath, {
      robots: 'index,follow',
      canonical: `${BASE}${servedPath}`,
      hreflang: [['it', `${BASE}${servedPath}`]],
    });

    window.history.pushState({}, '', '/bar/');
    window.history.pushState({}, '', servedPath);

    expect(hasAuthoritativeStaticHead()).toBe(false);
    applyCanonicalHref(`${BASE}${servedPath}?spa-route`);
    expect(readHead().canonicals).toEqual([`${BASE}${servedPath}?spa-route`]);
  });
});
