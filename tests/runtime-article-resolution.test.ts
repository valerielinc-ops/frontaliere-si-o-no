// Runtime article resolution — issue #4974 item 3.
//
// The contract this file defends is almost entirely about failure. An article
// URL the bundle does not know is ALREADY a correct page: the shard serves the
// full static HTML and the visitor can read it. The only way this code can do
// harm is by taking the page over with something worse, so every unhappy path
// must end in "resolve to nothing" and let the caller leave the page alone.
//
// The happy path matters too, and is measured: on 2026-08-04 seventeen live
// articles (8 frontaliere + 9 svizzera) were being overwritten by the hub list
// on hydration because their ids were in neither blogArticleIds.ts nor
// routerBlogData.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveArticleBySlug,
  adoptRuntimeArticle,
  articleBodyPartsFromStaticArticle,
  publishRuntimeArticleBody,
  articlesApiBase,
  __resetRuntimeArticleResolution,
  runtimeArticleRecords,
} from '@/services/runtimeArticleResolution';
import {
  cleanupArticleBodySections,
  renderArticleDerivedSectionsHtml,
  articleBodySectionLabel,
} from '@/build-plugins/articleSeoFallback';
import {
  stashStaticArticleFallback,
  hasStaticArticleFallback,
  restoreStaticArticleFallback,
  staticArticleFallback,
  __resetStaticArticleFallback,
} from '@/services/staticArticleFallback';
import { t } from '@/services/i18n';
import { learnRuntimeBlogSlugs, learnRuntimeSwissSlugs, resolveBlogSlug, resolveSwissSlug, buildPath } from '@/services/router';

// ── the published documents, in the shape the corpus actually emits ─────────

const INDEX_URL = '/data/blog-index-frontaliere-it.json';
const SWISS_INDEX_URL = '/data/blog-index-svizzera-it.json';

const publishedIndex = {
  version: 1,
  section: 'frontaliere',
  locale: 'it',
  count: 2,
  total: 3084,
  oldest: '2026-07-21T11:08:23.465Z',
  articles: [
    {
      id: 'poste-italiane-consulenti-finanziari-varese',
      title: 'Poste Italiane cerca consulenti finanziari in Varese',
      excerpt: 'Poste Italiane cerca laureati per consulenza finanziaria in provincia di Varese.',
      category: 'novita',
      date: '2026-08-05T03:21:31.000Z',
      image: '/images/blog/poste-italiane-consulenti-finanziari-varese.webp',
    },
    {
      id: 'stipendio-netto-2026',
      title: 'Stipendio netto frontaliere 2026',
      excerpt: 'Come si calcola il netto.',
      category: 'fiscale',
      date: '2026-01-02T00:00:00.000Z',
      image: '/images/blog/stipendio-netto-2026.webp',
    },
  ],
};

const publishedSlugs = {
  blog: {
    'poste-italiane-consulenti-finanziari-varese': {
      it: 'poste-italiane-consulenti-finanziari-varese',
      en: 'poste-italiane-financial-advisors-varese',
      de: 'poste-italiane-finanzberater-varese',
      fr: 'poste-italiane-conseillers-financiers-varese',
    },
    // The interesting case: the Italian slug is NOT the id.
    'stipendio-netto-2026': {
      it: 'stipendio-netto-frontaliere-2026',
      en: 'cross-border-net-salary-2026',
      de: 'nettolohn-grenzgaenger-2026',
      fr: 'salaire-net-frontalier-2026',
    },
  },
  blogReverse: {
    it: {
      'poste-italiane-consulenti-finanziari-varese': 'poste-italiane-consulenti-finanziari-varese',
      'stipendio-netto-frontaliere-2026': 'stipendio-netto-2026',
    },
    en: {
      'poste-italiane-financial-advisors-varese': 'poste-italiane-consulenti-finanziari-varese',
      'cross-border-net-salary-2026': 'stipendio-netto-2026',
    },
    de: {},
    fr: {},
  },
  swiss: {
    'come-funzionano-votazioni-federali-ch': {
      it: 'come-funzionano-votazioni-federali-ch',
      en: 'how-swiss-federal-votes-work',
      de: 'wie-funktionieren-eidgenoessische-abstimmungen',
      fr: 'comment-fonctionnent-les-votations-federales',
    },
  },
  swissReverse: {
    it: { 'come-funzionano-votazioni-federali-ch': 'come-funzionano-votazioni-federali-ch' },
    en: { 'how-swiss-federal-votes-work': 'come-funzionano-votazioni-federali-ch' },
    de: {},
    fr: {},
  },
};

type Responder = (url: string) => { ok?: boolean; status?: number; body?: unknown; text?: string } | Promise<never>;

function stubFetch(responder: Responder) {
  const fn = vi.fn((url: string | URL) => {
    const out = responder(String(url));
    if (out instanceof Promise) return out;
    if (out.ok === false) return Promise.resolve({ ok: false, status: out.status ?? 404 } as Response);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(out.body),
      text: () => Promise.resolve(out.text ?? ''),
    } as unknown as Response);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Serves every document the resolver can ask for. */
const fullyPublished: Responder = (url) => {
  if (url.includes('/slugs.json')) return { body: publishedSlugs };
  if (url.includes(INDEX_URL)) return { body: publishedIndex };
  if (url.includes(SWISS_INDEX_URL)) {
    return { body: { total: 615, articles: [{ id: 'come-funzionano-votazioni-federali-ch', title: 'Come funzionano le votazioni federali' }] } };
  }
  return { ok: false, status: 404 };
};

beforeEach(() => {
  vi.restoreAllMocks();
  __resetRuntimeArticleResolution();
  __resetStaticArticleFallback();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── slug → id ───────────────────────────────────────────────────────────────

describe('resolveArticleBySlug', () => {
  it('resolves an id the bundle never shipped, from the published index alone', async () => {
    const fetchMock = stubFetch(fullyPublished);
    const resolved = await resolveArticleBySlug('frontaliere', 'it', 'poste-italiane-consulenti-finanziari-varese');

    expect(resolved?.id).toBe('poste-italiane-consulenti-finanziari-varese');
    expect(resolved?.record?.title).toBe('Poste Italiane cerca consulenti finanziari in Varese');
    // The 65 KB index answered it. slugs.json is ~550 KB gzipped and must stay
    // off this path: 2,909 of 3,085 frontaliere ids ARE their Italian slug.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('slugs.json'))).toBe(false);
  });

  it('falls through to slugs.json when the slug is not itself an id', async () => {
    const fetchMock = stubFetch(fullyPublished);
    const resolved = await resolveArticleBySlug('frontaliere', 'it', 'stipendio-netto-frontaliere-2026');

    expect(resolved?.id).toBe('stipendio-netto-2026');
    expect(resolved?.slugs.en).toBe('cross-border-net-salary-2026');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('slugs.json'))).toBe(true);
  });

  it('resolves a localized slug, where the slug can never equal the id', async () => {
    stubFetch(fullyPublished);
    const resolved = await resolveArticleBySlug('frontaliere', 'en', 'poste-italiane-financial-advisors-varese');
    expect(resolved?.id).toBe('poste-italiane-consulenti-finanziari-varese');
  });

  it('resolves the svizzera mirror through its own half of the document', async () => {
    stubFetch(fullyPublished);
    const resolved = await resolveArticleBySlug('svizzera', 'en', 'how-swiss-federal-votes-work');
    expect(resolved?.id).toBe('come-funzionano-votazioni-federali-ch');
    expect(resolved?.slugs.it).toBe('come-funzionano-votazioni-federali-ch');
  });

  it('reads slugs.json once per page load, however many articles ask', async () => {
    const fetchMock = stubFetch(fullyPublished);
    await resolveArticleBySlug('frontaliere', 'it', 'stipendio-netto-frontaliere-2026');
    await resolveArticleBySlug('frontaliere', 'en', 'cross-border-net-salary-2026');
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('slugs.json'))).toHaveLength(1);
  });
});

describe('resolveArticleBySlug — every failure resolves to null', () => {
  const cases: Array<[string, Responder]> = [
    ['everything 404s', () => ({ ok: false, status: 404 })],
    ['the API is 500', () => ({ ok: false, status: 500 })],
    ['slugs.json is malformed JSON', (u) => (u.includes('slugs.json')
      ? { ok: true, body: undefined, status: 200 }
      : { body: publishedIndex })],
    ['slugs.json parses but has the wrong shape', (u) => (u.includes('slugs.json')
      ? { body: { totalmente: 'altro' } }
      : { body: publishedIndex })],
    ['slugs.json is an array, not an object', (u) => (u.includes('slugs.json')
      ? { body: [1, 2, 3] }
      : { body: publishedIndex })],
    ['the reverse map is present but empty', (u) => (u.includes('slugs.json')
      ? { body: { blog: publishedSlugs.blog, blogReverse: {}, swiss: {}, swissReverse: {} } }
      : { body: publishedIndex })],
    ['the network is down', () => Promise.reject(new Error('offline'))],
  ];

  it.each(cases)('%s', async (_label, responder) => {
    if (_label === 'slugs.json is malformed JSON') {
      vi.stubGlobal('fetch', vi.fn((url: string | URL) => (String(url).includes('slugs.json')
        ? Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError('Unexpected token')) } as unknown as Response)
        : Promise.resolve({ ok: true, json: () => Promise.resolve(publishedIndex) } as unknown as Response))));
    } else {
      stubFetch(responder);
    }
    await expect(resolveArticleBySlug('frontaliere', 'it', 'articolo-mai-visto')).resolves.toBeNull();
  });

  it('resolves to null on an empty slug without touching the network', async () => {
    const fetchMock = stubFetch(fullyPublished);
    await expect(resolveArticleBySlug('frontaliere', 'it', '')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives up rather than hanging when the API never answers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_u: string | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const pending = resolveArticleBySlug('frontaliere', 'it', 'qualcosa');
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toBeNull();
    vi.useRealTimers();
  });
});

describe('articlesApiBase', () => {
  it('defaults to the corpus Pages origin — the JSON contract, not a module', () => {
    expect(articlesApiBase()).toBe('https://nanakokyobashi-rgb.github.io/frontaliere-articles');
  });
});

// ── body recovered from the static HTML the shard already serves ────────────

/**
 * Builds the article markup through the REAL production renderer
 * (`ogPagesPlugin` → `cleanupArticleBodySections` + `renderArticleDerivedSectionsHtml`),
 * so this is a genuine round-trip and not a test against a hand-written guess
 * at what the shard emits.
 */
function renderStaticArticle(bodies: string[], extras = ''): string {
  const rendered = cleanupArticleBodySections(bodies.map((text, i) => ({ key: `body${i + 1}`, text })));
  const sectionsHtml = renderArticleDerivedSectionsHtml(
    rendered.map((s, i) => ({ heading: articleBodySectionLabel('it', i + 1), html: s.html })),
  );
  return `<main class="seo-static-content"><article class="ft-blog-article">`
    + `<h1>Titolo dell'articolo</h1>`
    + `<p class="article-byline">Di Redazione</p>`
    + `<p>Estratto dell'articolo.</p>`
    + sectionsHtml
    + extras
    + `<nav><a href="/">Simulatore</a></nav>`
    + `</article></main>`;
}

function staticArticle(): Element | null {
  return document.querySelector('main.seo-static-content article.ft-blog-article');
}

describe('articleBodyPartsFromStaticArticle', () => {
  it('round-trips the shard HTML back to one markdown part per bodyN', () => {
    document.body.innerHTML = renderStaticArticle([
      '## In breve\n- Primo punto\n- Secondo punto\n\nUn paragrafo con **grassetto** e [un link](https://example.com).',
      '## Dettagli\nAltro testo.',
    ]);

    const parts = articleBodyPartsFromStaticArticle(staticArticle());

    expect(parts).toHaveLength(2);
    // The plugin injects its own positional <h2> and demotes the body's own
    // headings to <h3>, so the recovered text carries both levels.
    expect(parts[0]).toContain('## Contesto');
    expect(parts[0]).toContain('### In breve');
    expect(parts[0]).toContain('- Primo punto');
    expect(parts[0]).toContain('- Secondo punto');
    expect(parts[0]).toContain('**grassetto**');
    expect(parts[0]).toContain('[un link](https://example.com)');
    expect(parts[1]).toContain('## Dettagli operativi');
    expect(parts[1]).toContain('### Dettagli');
    // Blocks stay separated the way the SPA renderer splits them.
    expect(parts[0].split('\n\n').length).toBeGreaterThan(2);
  });

  it('drops the "…" the static renderer leaves where it truncated', () => {
    // The static renderer's budget is 1,800 rendered characters per section,
    // cut at a whole-block boundary and marked with a "…" paragraph.
    const para = 'Frase di riempimento abbastanza lunga da consumare il budget. '.repeat(12);
    const long = `## Sezione\n${para}\n\n${para}\n\n${para}`;
    document.body.innerHTML = renderStaticArticle([long]);
    // Sanity: the production renderer really did truncate this one.
    expect(document.body.innerHTML).toContain('<p>…</p>');

    const parts = articleBodyPartsFromStaticArticle(staticArticle());
    expect(parts[0].split('\n\n')).not.toContain('…');
    expect(parts[0]).not.toMatch(/\n\n…\s*$/);
  });

  it('ignores the related-articles and FAQ blocks the plugin emits alongside', () => {
    const extras = '<details class="s-x"><summary>Domande frequenti</summary><dl><dt>D?</dt><dd>R.</dd></dl></details>'
      + '<section class="s-zzuqwx"><h2>Articoli correlati</h2><ul><li><a href="/x/">Altro articolo</a></li></ul></section>';
    document.body.innerHTML = renderStaticArticle(['## Solo questo\nTesto.'], extras);

    const parts = articleBodyPartsFromStaticArticle(staticArticle());
    expect(parts).toHaveLength(1);
    expect(parts.join('\n')).not.toContain('Articoli correlati');
    expect(parts.join('\n')).not.toContain('Domande frequenti');
  });

  it('returns nothing rather than guessing when there is no static article', () => {
    document.body.innerHTML = '<div id="root"></div>';
    expect(articleBodyPartsFromStaticArticle(staticArticle())).toEqual([]);
    expect(articleBodyPartsFromStaticArticle(null)).toEqual([]);
  });

  it('returns nothing for an article shell with no body sections (thin-page variant)', () => {
    document.body.innerHTML = '<main class="seo-static-content"><article class="ft-blog-article">'
      + '<h1>Titolo</h1><p>Estratto.</p><nav><a href="/">Home</a></nav></article></main>';
    expect(articleBodyPartsFromStaticArticle(staticArticle())).toEqual([]);
  });
});

describe('publishRuntimeArticleBody', () => {
  it('publishes under the same keys the bundled chunks use', () => {
    publishRuntimeArticleBody('articolo-runtime-1', 'it', ['## Uno\nTesto uno.', 'Testo due.']);
    expect(t('blog.article.articolo-runtime-1.body1')).toBe('## Uno\nTesto uno.');
    expect(t('blog.article.articolo-runtime-1.body2')).toBe('Testo due.');
    expect(t('blog.article.articolo-runtime-1.body3')).toBe('blog.article.articolo-runtime-1.body3');
  });

  it('never overwrites a body this build actually shipped', () => {
    publishRuntimeArticleBody('articolo-runtime-2', 'it', ['Originale del bundle.']);
    publishRuntimeArticleBody('articolo-runtime-2', 'it', ['RISCRITTO DALLA RETE']);
    expect(t('blog.article.articolo-runtime-2.body1')).toBe('Originale del bundle.');
  });

  it('is a no-op on an empty recovery', () => {
    expect(publishRuntimeArticleBody('articolo-runtime-3', 'it', [])).toBe(0);
    expect(t('blog.article.articolo-runtime-3.body1')).toBe('blog.article.articolo-runtime-3.body1');
  });
});

// ── the decision the router acts on ─────────────────────────────────────────

describe('adoptRuntimeArticle', () => {
  it('adopts an unknown article and declares it renderable', async () => {
    stubFetch(fullyPublished);
    document.body.innerHTML = renderStaticArticle(['## In breve\n- Un punto\n\nUn paragrafo.']);

    const adopted = await adoptRuntimeArticle('frontaliere', 'it', 'poste-italiane-consulenti-finanziari-varese');

    expect(adopted).toMatchObject({
      id: 'poste-italiane-consulenti-finanziari-varese',
      renderable: true,
    });
    expect(adopted?.slugs.it).toBe('poste-italiane-consulenti-finanziari-varese');
    // Title, excerpt and body are all reachable through the keys every existing
    // call site already uses.
    expect(t('blog.article.poste-italiane-consulenti-finanziari-varese.title'))
      .toBe('Poste Italiane cerca consulenti finanziari in Varese');
    expect(t('blog.article.poste-italiane-consulenti-finanziari-varese.body1')).toContain('Un paragrafo.');
    expect(runtimeArticleRecords('frontaliere').map((a) => a.id))
      .toContain('poste-italiane-consulenti-finanziari-varese');
  });

  it('refuses to render when the id resolves but there is no body — static HTML wins', async () => {
    stubFetch(fullyPublished);
    document.body.innerHTML = '<div id="root"></div>';

    const adopted = await adoptRuntimeArticle('frontaliere', 'it', 'poste-italiane-consulenti-finanziari-varese');

    // We know WHICH article this is — enough for canonical URLs and hreflang —
    // but not enough to draw it. Taking over with an empty body would be
    // strictly worse than the page the shard already served.
    expect(adopted?.id).toBe('poste-italiane-consulenti-finanziari-varese');
    expect(adopted?.renderable).toBe(false);
  });

  it('refuses to render when the index has no record for the resolved id', async () => {
    // slugs.json knows the pair; the recent window does not carry the entry.
    stubFetch((u) => {
      if (u.includes('/slugs.json')) return { body: publishedSlugs };
      if (u.includes(INDEX_URL)) return { body: { total: 3084, articles: [] } };
      return { ok: false, status: 404 };
    });
    document.body.innerHTML = renderStaticArticle(['## C\nTesto.']);

    const adopted = await adoptRuntimeArticle('frontaliere', 'it', 'stipendio-netto-frontaliere-2026');
    expect(adopted?.id).toBe('stipendio-netto-2026');
    expect(adopted?.renderable).toBe(false);
  });

  it('returns null when nothing can be resolved at all', async () => {
    stubFetch(() => ({ ok: false, status: 404 }));
    document.body.innerHTML = renderStaticArticle(['## C\nTesto.']);
    await expect(adoptRuntimeArticle('frontaliere', 'it', 'slug-inesistente')).resolves.toBeNull();
  });

  it('returns null when the network is down, without throwing at the caller', async () => {
    stubFetch(() => Promise.reject(new Error('offline')));
    await expect(adoptRuntimeArticle('svizzera', 'it', 'qualsiasi-cosa')).resolves.toBeNull();
  });
});

// ── what the router does with the pair once it has it ───────────────────────

describe('runtime slug pairs in the router', () => {
  it('makes an unknown slug resolvable in both directions', () => {
    learnRuntimeBlogSlugs('articolo-imparato', { it: 'slug-italiano-imparato', en: 'learned-english-slug' });

    expect(resolveBlogSlug('slug-italiano-imparato', 'it')).toBe('articolo-imparato');
    expect(resolveBlogSlug('learned-english-slug', 'en')).toBe('articolo-imparato');
    // The forward direction is what stops buildPath from rewriting a working
    // URL to /articoli-frontaliere/<id>/ — a 404 whenever slug !== id.
    expect(buildPath({ activeTab: 'blog', blogArticle: 'articolo-imparato' as never }, 'it'))
      .toContain('/slug-italiano-imparato/');
    expect(buildPath({ activeTab: 'blog', blogArticle: 'articolo-imparato' as never }, 'en'))
      .toContain('/learned-english-slug/');
  });

  it('does the same for the svizzera mirror', () => {
    learnRuntimeSwissSlugs('votazioni-imparato', { it: 'slug-svizzero-imparato' });
    expect(resolveSwissSlug('slug-svizzero-imparato', 'it')).toBe('votazioni-imparato');
    expect(buildPath({ activeTab: 'blog', blogSection: 'svizzera', swissArticle: 'votazioni-imparato' }, 'it'))
      .toContain('/slug-svizzero-imparato/');
  });

  it('leaves an unknown slug unresolved — it invents nothing', () => {
    expect(resolveBlogSlug('slug-che-nessuno-ha-mai-pubblicato', 'it')).toBeUndefined();
    expect(resolveSwissSlug('slug-che-nessuno-ha-mai-pubblicato', 'it')).toBeUndefined();
  });

  it('ignores an id with no slugs instead of poisoning the map', () => {
    learnRuntimeBlogSlugs('', { it: 'slug-orfano' });
    expect(resolveBlogSlug('slug-orfano', 'it')).toBeUndefined();
  });
});

// The entry's CLS handoff (index.tsx) moves `main.seo-static-content` INSIDE
// `#root` before createRoot().render(), which is why an unresolvable article
// page ends up DESTROYED rather than hidden — verified in Chromium on
// 2026-08-04: post-hydration, `document.querySelector('main.seo-static-content')`
// is null and the only h1 left is "Guida Frontaliere".
describe('static article fallback across the #root handoff', () => {
  const mountShardPage = () => {
    document.body.innerHTML = '<div id="root"></div>' + renderStaticArticle(['## In breve\n- Un punto']);
  };
  const runClsHandoff = () => {
    const root = document.getElementById('root')!;
    const fallback = document.querySelector<HTMLElement>('main.seo-static-content')!;
    stashStaticArticleFallback(fallback);
    root.appendChild(fallback);
  };

  it('survives the move into #root and the React render that follows', () => {
    mountShardPage();
    runClsHandoff();
    // React owns #root and replaces everything in it.
    document.getElementById('root')!.innerHTML = '<h1>Guida Frontaliere</h1>';
    expect(document.querySelector('main.seo-static-content')).toBeNull();

    expect(hasStaticArticleFallback()).toBe(true);
    expect(restoreStaticArticleFallback()).toBe(true);

    const restored = document.querySelector('main.seo-static-content');
    expect(restored).not.toBeNull();
    expect(document.getElementById('root')!.contains(restored)).toBe(false);
    expect(restored?.querySelector('h1')?.textContent).toBe("Titolo dell'articolo");
  });

  it('still yields the body after the handoff, so the article stays adoptable', async () => {
    mountShardPage();
    runClsHandoff();
    document.getElementById('root')!.innerHTML = '';
    stubFetch(fullyPublished);

    const adopted = await adoptRuntimeArticle('frontaliere', 'it', 'poste-italiane-consulenti-finanziari-varese');
    expect(adopted?.renderable).toBe(true);
  });

  it('reports nothing to restore when the page never had a static article', () => {
    document.body.innerHTML = '<div id="root"></div>';
    expect(hasStaticArticleFallback()).toBe(false);
    expect(restoreStaticArticleFallback()).toBe(false);
    expect(document.querySelector('main.seo-static-content')).toBeNull();
  });

  it('does not touch a fallback the handoff left outside #root', () => {
    mountShardPage();
    const before = document.querySelector('main.seo-static-content');
    expect(staticArticleFallback()).toBe(before);
    expect(restoreStaticArticleFallback()).toBe(true);
    expect(document.querySelector('main.seo-static-content')).toBe(before);
  });

  it('is idempotent — restoring twice leaves exactly one article on the page', () => {
    mountShardPage();
    runClsHandoff();
    document.getElementById('root')!.innerHTML = '';
    restoreStaticArticleFallback();
    restoreStaticArticleFallback();
    expect(document.querySelectorAll('main.seo-static-content')).toHaveLength(1);
  });
});
