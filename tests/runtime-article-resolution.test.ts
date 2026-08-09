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
  publishedSlugsForIds,
  runtimeArticleRecords,
  staticArticleForSlug,
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
import { tryRenderMdTable } from '@/components/community/BlogArticles';
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

/** The shard URL an article is served at — the identity every body claim is checked against. */
const pathFor = (slug: string) => `/articoli-frontaliere/${slug}/`;
const POSTE = 'poste-italiane-consulenti-finanziari-varese';
const STIPENDIO = 'stipendio-netto-frontaliere-2026';

/** Put jsdom on a page. Production reads `location`; so must the tests. */
function visit(path: string): void {
  window.history.replaceState({}, '', path);
}

beforeEach(() => {
  vi.restoreAllMocks();
  __resetRuntimeArticleResolution();
  __resetStaticArticleFallback();
  document.body.innerHTML = '';
  visit('/');
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
    // The recovered markdown is the SOURCE markdown, not a transcript of the
    // static HTML: the plugin's positional <h2> scaffolding is dropped and the
    // body's own headings come back at the level they were written at, so this
    // article hydrates identically whether or not the bundle contains it
    // (issue #5415 §4 point 3).
    expect(parts[0]).not.toContain('Contesto');
    expect(parts[0]).toContain('## In breve');
    expect(parts[0]).toContain('- Primo punto');
    expect(parts[0]).toContain('- Secondo punto');
    expect(parts[0]).toContain('**grassetto**');
    expect(parts[0]).toContain('[un link](https://example.com)');
    expect(parts[1]).not.toContain('Dettagli operativi');
    expect(parts[1]).toContain('## Dettagli');
    // Blocks stay separated the way the SPA renderer splits them.
    expect(parts[0].split('\n\n').length).toBeGreaterThan(2);
  });

  it('gives back the markdown it was rendered from, heading levels included', () => {
    // The full round trip, asserted as equality rather than containment: what
    // the corpus wrote → static HTML → recovered markdown.
    const source = '## Sezione\nUn paragrafo.\n\n### Sotto-sezione\nAltro paragrafo.';
    document.body.innerHTML = renderStaticArticle([source]);

    expect(articleBodyPartsFromStaticArticle(staticArticle())).toEqual([
      '## Sezione\n\nUn paragrafo.\n\n### Sotto-sezione\n\nAltro paragrafo.',
    ]);
  });

  it('keeps the descriptive headings of the SEO fallback sections', () => {
    // Only the three GENERIC positional labels are scaffolding. The fallback
    // sections ogPagesPlugin appends to thin bodies carry real headings.
    document.body.innerHTML = renderStaticArticle([]).replace(
      '<nav>',
      '<section><h2>Cosa devi sapere</h2><p>Testo della sezione.</p></section><nav>',
    );

    const parts = articleBodyPartsFromStaticArticle(staticArticle());
    expect(parts).toEqual(['## Cosa devi sapere\n\nTesto della sezione.']);
  });

  it('recovers a pipe table as a pipe table, so the SPA can draw it again', () => {
    // Issue #5415: the daily brief's tables reached the visitor as raw pipes on
    // publication day. Nothing downstream can repair a table the recovery path
    // flattened, because the newlines are gone by then — this is where it has
    // to survive.
    const source = '| Valico | Attesa |\n|---|---|\n| Chiasso | 12 min |\n| Ponte Tresa | 0 min |';
    document.body.innerHTML = renderStaticArticle([source]);
    // Sanity: the production renderer emitted a real table, not a <p> of pipes.
    expect(document.body.innerHTML).toContain('<table>');

    const [part] = articleBodyPartsFromStaticArticle(staticArticle());
    expect(part).toBe('| Valico | Attesa |\n| --- | --- |\n| Chiasso | 12 min |\n| Ponte Tresa | 0 min |');
    // One block, no blank line inside: the SPA splits body text on \n\n, and a
    // table split in half is a table that fails tryRenderMdTable's separator check.
    expect(part.split('\n\n')).toHaveLength(1);
    // Closes the loop on the renderer that actually draws it.
    expect(tryRenderMdTable(part, 't0')).not.toBeNull();
  });

  it('does not hand the SPA table parser something that is not a table', () => {
    document.body.innerHTML = renderStaticArticle([
      'Il modulo va compilato | firmato | consegnato entro il 30 giugno.',
    ]);

    const [part] = articleBodyPartsFromStaticArticle(staticArticle());
    expect(part).toBe('Il modulo va compilato | firmato | consegnato entro il 30 giugno.');
    expect(tryRenderMdTable(part, 't0')).toBeNull();
  });

  // Drift guard. runtimeArticleResolution.ts spells the generic labels out
  // instead of importing ARTICLE_BODY_SECTION_LABELS, to keep the engine's four
  // locales of SEO filler prose out of the SPA bundle. This is what makes that
  // copy safe: rename a label in the engine and this fails.
  it('drops every generic positional label the engine can emit, in every locale', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      for (const n of [1, 2, 3]) {
        const label = articleBodySectionLabel(locale, n);
        document.body.innerHTML = renderStaticArticle([]).replace(
          '<nav>',
          `<section><h2>${label}</h2><p>Testo.</p></section><nav>`,
        );

        expect(articleBodyPartsFromStaticArticle(staticArticle()), `${locale} body${n} → "${label}"`)
          .toEqual(['Testo.']);
      }
    }
  });

  it('keeps inline markup inside recovered table cells', () => {
    document.body.innerHTML = renderStaticArticle([
      '| Voce | Valore |\n|---|---|\n| **Cambio** | [1.07](/cambio-chf-eur/) |',
    ]);

    const [part] = articleBodyPartsFromStaticArticle(staticArticle());
    expect(part).toContain('| **Cambio** | [1.07](/cambio-chf-eur/) |');
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
    // On the article's own page: the static HTML here IS this article's.
    visit(pathFor(POSTE));
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
  const mountShardPage = (slug = POSTE, body = '## In breve\n- Un punto') => {
    visit(pathFor(slug));
    document.body.innerHTML = '<div id="root"></div>' + renderStaticArticle([body]);
  };
  const runClsHandoff = () => {
    const root = document.getElementById('root')!;
    const fallback = document.querySelector<HTMLElement>('main.seo-static-content')!;
    // Same call the entry makes: the clone is stashed WITH the URL it came from.
    stashStaticArticleFallback(fallback, window.location.pathname);
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

// ── the leak this file exists to make impossible ────────────────────────────
//
// Production, 2026-08-09. A visitor lands on the daily brief
// (/articoli-frontaliere/bollettino-frontaliere-2026-08-09/) and then opens an
// article published after the last deploy. There is ONE stash per document and
// it survives client-side navigation, so it still held the brief's HTML — which
// got published under the second article's id. The page rendered the right
// title and excerpt from the corpus index with "Buongiorno, è domenica 9 agosto
// 2026…" underneath, and because `mergeArticleMetaOverlay` never overwrites, it
// stayed wrong for the rest of the session.
//
// Nothing in the old code was checking WHICH article the stash described. These
// tests are that check.
describe('un corpo non finisce mai sotto l’id di un altro articolo', () => {
  // `mergeArticleMetaOverlay` is module-global and never overwrites, so an id
  // another test has already published would answer for this one. These tests
  // own an article nothing else touches — the assertion "this key is still
  // unpublished" is only meaningful that way.
  const NUOVO = 'articolo-nuovo-di-giornata';
  /** An article for a test that must observe an id NOTHING has published yet. */
  const NUOVO_INEDITO = 'articolo-nuovo-mai-pubblicato';
  const publishedFor = (id: string): Responder => (url) => {
    if (url.includes('/slugs.json')) {
      return { body: { blog: { [id]: { it: id } }, swiss: {} } };
    }
    if (url.includes(INDEX_URL)) {
      return {
        body: {
          version: 1, section: 'frontaliere', locale: 'it', count: 1, total: 3134,
          articles: [{
            id,
            title: 'Articolo pubblicato dopo l’ultimo deploy',
            excerpt: 'Un articolo che questo bundle non conosce.',
            category: 'pratico',
            date: '2026-08-09T09:28:24.640Z',
            image: `/images/blog/${id}.webp`,
          }],
        },
      };
    }
    return { ok: false, status: 404 };
  };
  const nuovoPublished = publishedFor(NUOVO);

  /** Land on article A: its static HTML is stashed, then the handoff eats it. */
  const landOn = (slug: string, body: string) => {
    visit(pathFor(slug));
    document.body.innerHTML = '<div id="root"></div>' + renderStaticArticle([body]);
    const root = document.getElementById('root')!;
    const fallback = document.querySelector<HTMLElement>('main.seo-static-content')!;
    stashStaticArticleFallback(fallback, window.location.pathname);
    root.appendChild(fallback);
    root.innerHTML = '';
  };

  it('non pubblica il corpo della pagina di atterraggio sotto l’articolo successivo', async () => {
    landOn(STIPENDIO, '## In breve\n- IL CORPO DEL BOLLETTINO');
    // Client-side navigation: the URL changes, the stash does not.
    visit(pathFor(NUOVO));
    stubFetch(nuovoPublished);

    const adopted = await adoptRuntimeArticle('frontaliere', 'it', NUOVO);

    // The id still resolves — that part was never in doubt.
    expect(adopted?.id).toBe(NUOVO);
    // But nothing may be published under it that we cannot attribute to it.
    expect(t(`blog.article.${NUOVO}.body1`)).toBe(`blog.article.${NUOVO}.body1`);
    expect(t(`blog.article.${NUOVO}.body1`)).not.toContain('IL CORPO DEL BOLLETTINO');
    // No body we can prove is this article's ⇒ the SPA must not take the page.
    expect(adopted?.renderable).toBe(false);
  });

  it('non ripristina l’articolo di un’altra pagina sotto questa URL', () => {
    landOn(STIPENDIO, '## In breve\n- IL CORPO DEL BOLLETTINO');
    visit(pathFor(NUOVO));

    // The guard's precondition is false here: there is nothing correct to put
    // back. Restoring would paint the previous article under this URL.
    expect(hasStaticArticleFallback()).toBe(false);
    expect(restoreStaticArticleFallback()).toBe(false);
    expect(document.querySelector('main.seo-static-content')).toBeNull();
  });

  it('sulla sua pagina lo stash resta utilizzabile — il caso normale non regredisce', () => {
    landOn(NUOVO, '## In breve\n- Il corpo giusto');
    expect(hasStaticArticleFallback()).toBe(true);
    expect(restoreStaticArticleFallback()).toBe(true);
    expect(staticArticleForSlug(NUOVO)).not.toBeNull();
  });

  it('lo stash di un altro articolo non risponde mai per questo slug', () => {
    landOn(STIPENDIO, '## In breve\n- Un corpo qualsiasi');
    visit(pathFor(NUOVO));
    expect(staticArticleForSlug(NUOVO)).toBeNull();
    // …and it is still the right answer for the article it actually belongs to.
    expect(staticArticleFallback(pathFor(STIPENDIO))).not.toBeNull();
  });

  it('dopo una navigazione client-side il corpo arriva dalla pagina di QUESTO slug', async () => {
    landOn(STIPENDIO, '## In breve\n- IL CORPO DEL BOLLETTINO');
    visit(pathFor(NUOVO));
    // The shard serves this article's own page; that is where a body may come
    // from once the stash has been ruled out.
    stubFetch((url) => {
      if (url === pathFor(NUOVO)) {
        return { ok: true, text: renderStaticArticle(['## In breve\n- IL CORPO DELL’ARTICOLO NUOVO']) };
      }
      return nuovoPublished(url);
    });

    const adopted = await adoptRuntimeArticle('frontaliere', 'it', NUOVO, { path: pathFor(NUOVO) });

    expect(adopted?.renderable).toBe(true);
    expect(t(`blog.article.${NUOVO}.body1`)).toContain('IL CORPO DELL’ARTICOLO NUOVO');
    expect(t(`blog.article.${NUOVO}.body1`)).not.toContain('IL CORPO DEL BOLLETTINO');
  });

  it('non va a pescare un corpo da una URL che non è quella dello slug', async () => {
    landOn(STIPENDIO, '## In breve\n- IL CORPO DEL BOLLETTINO');
    visit('/qualche/altra/pagina/');
    const fetchMock = stubFetch(publishedFor(NUOVO_INEDITO));

    // Neither the stash nor the current URL can be attributed to this slug, and
    // an invented path would just be the same bug with an extra request.
    await adoptRuntimeArticle('frontaliere', 'it', NUOVO_INEDITO);

    const fetched = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(fetched.some((u) => u.includes('/qualche/altra/pagina/'))).toBe(false);
    expect(t(`blog.article.${NUOVO_INEDITO}.body1`)).toBe(`blog.article.${NUOVO_INEDITO}.body1`);
  });
});

// A card the overlay adds carries an id, and `buildPath` turns an id into a
// URL through the bundled slug map → the runtime one → the raw id. For an
// article this build never saw the first two miss, so the fallback publishes
// the id as if it were the slug. Wherever the slug is localized that URL does
// not exist: measured live 2026-08-06,
// /de/schweiz-artikel/rischio-bolla-svizzera-2026/ → 404 while the real
// /de/schweiz-artikel/schweizer-immobilien-bubble-risiko-2026/ → 200.
// The list could therefore paint a card that sends every visitor to a 404.
describe('publishedSlugsForIds — the forward map that keeps a new card clickable', () => {
  it('returns the published slugs for an id whose slug is NOT the id', async () => {
    stubFetch(fullyPublished);
    const pairs = await publishedSlugsForIds('frontaliere', ['stipendio-netto-2026']);
    expect(pairs).toHaveLength(1);
    const [id, slugs] = pairs[0];
    expect(id).toBe('stipendio-netto-2026');
    expect(slugs.it).toBe('stipendio-netto-frontaliere-2026');
    expect(slugs.de).toBe('nettolohn-grenzgaenger-2026');
  });

  it('reads the swiss half for a swiss section', async () => {
    stubFetch(fullyPublished);
    const pairs = await publishedSlugsForIds('svizzera', ['come-funzionano-votazioni-federali-ch']);
    expect(pairs[0][1].de).toBe('wie-funktionieren-eidgenoessische-abstimmungen');
  });

  it('skips an id the published maps do not know, rather than inventing one', async () => {
    stubFetch(fullyPublished);
    const pairs = await publishedSlugsForIds('frontaliere', ['mai-pubblicato', 'stipendio-netto-2026']);
    expect(pairs.map(([id]) => id)).toEqual(['stipendio-netto-2026']);
  });

  it('asks for nothing when there is nothing to ask about', async () => {
    const fetchMock = stubFetch(fullyPublished);
    expect(await publishedSlugsForIds('frontaliere', [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails OPEN when slugs.json is unreachable — no slugs, never a throw', async () => {
    stubFetch((u) => (u.includes('/slugs.json') ? { ok: false, status: 503 } : { ok: false, status: 404 }));
    await expect(publishedSlugsForIds('frontaliere', ['stipendio-netto-2026'])).resolves.toEqual([]);
  });
});
