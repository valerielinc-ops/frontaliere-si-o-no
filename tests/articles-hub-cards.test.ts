import { describe, it, expect } from 'vitest';
import {
  ARTICLE_HUB_GRID_OPEN,
  ARTICLE_HUB_SHELL_NAV_OPEN,
  ensureArticleHubCards,
  renderArticleHubCards,
  renderArticleHubGridBlock,
  replaceArticleHubCards,
} from '../packages/articles/engine/articlesHubCards';

/**
 * The hub grid is emitted by two producers (the site build and nanako's
 * fast-publish). These tests pin the two properties that make that safe:
 * the markup is byte-identical to what production already serves, and the
 * in-place swap cannot eat the rest of the page.
 */

/**
 * Lifted verbatim from the live hub (articolifrontaliere-it shard), with the
 * ONE deliberate difference this change makes: the href carries its trailing
 * slash. The live no-slash form answers 301 to exactly this URL.
 */
const LIVE_CARD =
  '<a href="/articoli-frontaliere/fondo-liberta-svizzera-multe/" aria-label="Multe sui mezzi pubblici: il fondo che paga per gli indigenti" class="ssg-art-card">'
  + '<img src="https://cdn.frontaliereticino.ch/images/blog/fondo-liberta-svizzera-multe.webp" alt="Multe sui mezzi pubblici: il fondo che paga per gli indigenti" width="400" height="200" class="ssg-art-img" fetchpriority="high">'
  + '<div class="ssg-art-body"><span class="ssg-art-cat" style="background:#ecfdf5;color:#047857">Pratico</span>'
  + '<span class="ssg-art-date">29 lug 2026</span>'
  + '<h3 class="ssg-art-title">Multe sui mezzi pubblici: il fondo che paga per gli indigenti</h3>'
  + '<p class="ssg-art-desc">L\'associazione Freiheitsfonds Schweiz paga le multe di chi rischia la prigione per aver viaggiato senza biglietto. Scopri come funziona l\'iniziativa.</p>'
  + '</div></a>';

const ARTICLE = {
  id: 'fondo-liberta-svizzera-multe',
  category: 'pratico',
  date: '2026-07-29',
  image: 'https://cdn.frontaliereticino.ch/images/blog/fondo-liberta-svizzera-multe.webp',
};

const META = {
  title: 'Multe sui mezzi pubblici: il fondo che paga per gli indigenti',
  desc: "L'associazione Freiheitsfonds Schweiz paga le multe di chi rischia la prigione per aver viaggiato senza biglietto. Scopri come funziona l'iniziativa.",
};

describe('renderArticleHubCards', () => {
  it('reproduces the card markup production already serves, byte for byte', () => {
    const html = renderArticleHubCards({
      articles: [ARTICLE],
      locale: 'it',
      sectionSlug: 'articoli-frontaliere',
      localePrefix: '',
      resolveSlug: () => 'fondo-liberta-svizzera-multe',
      resolveMeta: () => META,
    });
    expect(html).toBe(LIVE_CARD);
  });

  it('marks only the first two cards as LCP candidates', () => {
    const html = renderArticleHubCards({
      articles: [ARTICLE, ARTICLE, ARTICLE],
      locale: 'it',
      sectionSlug: 'articoli-frontaliere',
      localePrefix: '',
      resolveSlug: (id) => id,
      resolveMeta: () => META,
    });
    expect(html.match(/fetchpriority="high"/g)).toHaveLength(2);
    expect(html.match(/loading="lazy"/g)).toHaveLength(1);
  });

  it('falls back to a de-slugified id when the caller has no meta', () => {
    const html = renderArticleHubCards({
      articles: [ARTICLE],
      locale: 'it',
      sectionSlug: 'articoli-frontaliere',
      localePrefix: '',
      resolveSlug: (id) => id,
      resolveMeta: () => null,
    });
    expect(html).toContain('Fondo Liberta Svizzera Multe');
    expect(html).not.toContain('ssg-art-desc');
  });

  it('prefixes non-IT locales', () => {
    const html = renderArticleHubCards({
      articles: [ARTICLE],
      locale: 'de',
      sectionSlug: 'grenzgaenger-artikel',
      localePrefix: 'de',
      resolveSlug: () => 'bussen-fonds',
      resolveMeta: () => META,
    });
    expect(html).toContain('href="/de/grenzgaenger-artikel/bussen-fonds/"');
  });

  it('links every card at its canonical trailing-slash URL', () => {
    // The no-slash form 301s to this one at the edge (`trailing-slash-301`),
    // so emitting it made every hub card a redirect hop.
    const html = renderArticleHubCards({
      articles: [ARTICLE, ARTICLE],
      locale: 'it',
      sectionSlug: 'articoli-svizzera',
      localePrefix: '',
      resolveSlug: (id) => id,
      resolveMeta: () => META,
    });
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toHaveLength(2);
    for (const href of hrefs) expect(href.endsWith('/')).toBe(true);
  });

  it('resolves meta through the slashed path the caller normalises anyway', () => {
    // `resolveMeta` receives the same string the href gets. Both call sites
    // key their map with `seoKey()`, which strips the slash, so the lookup is
    // unchanged — pin it so a future caller that keys on the raw path is
    // caught here rather than by 100 untitled cards in production.
    const seen: string[] = [];
    renderArticleHubCards({
      articles: [ARTICLE],
      locale: 'it',
      sectionSlug: 'articoli-frontaliere',
      localePrefix: '',
      resolveSlug: (id) => id,
      resolveMeta: (_id, artPath) => { seen.push(artPath); return META; },
    });
    expect(seen).toEqual(['/articoli-frontaliere/fondo-liberta-svizzera-multe/']);
  });
});

describe('replaceArticleHubCards', () => {
  // The cards contain nested <div>s. A non-greedy regex would close at the
  // first inner </div> and drop everything after it — and a hub truncated
  // mid-page still answers 200, so nothing downstream would notice.
  const PAGE =
    '<body><h2>Ultimi</h2><div class="ssg-article-grid">'
    + '<a class="ssg-art-card"><div class="ssg-art-body"><h3>old</h3></div></a>'
    + '</div><nav>keep me</nav></body>';

  it('swaps the grid and keeps everything around it', () => {
    const out = replaceArticleHubCards(PAGE, '<a>new</a>');
    expect(out).toBe(
      '<body><h2>Ultimi</h2><div class="ssg-article-grid"><a>new</a></div><nav>keep me</nav></body>',
    );
  });

  it('survives a round trip', () => {
    const once = replaceArticleHubCards(PAGE, '<a>new</a>')!;
    expect(replaceArticleHubCards(once, '<a>newer</a>')).toContain('<nav>keep me</nav>');
  });

  it('returns null rather than guessing when the grid is absent', () => {
    expect(replaceArticleHubCards('<body>no grid here</body>', '<a>x</a>')).toBeNull();
  });

  it('returns null on an unbalanced page instead of truncating it', () => {
    expect(replaceArticleHubCards('<div class="ssg-article-grid"><div>', '<a>x</a>')).toBeNull();
  });
});

describe('renderArticleHubGridBlock', () => {
  // Three emitters produce this block (both hub branches in
  // staticPagesPlugin and the insert path below). Pin the bytes here so a
  // change in one cannot silently stop matching the marker the corpus-side
  // refresher scans for.
  it('emits the heading + grid wrapper staticPagesPlugin already serves', () => {
    expect(renderArticleHubGridBlock('<a>card</a>', 'it')).toBe(
      '<h2 class="s-sXAwQz">Ultimi Articoli per Frontalieri</h2>'
      + '<div class="ssg-article-grid"><a>card</a></div>',
    );
  });

  it('uses the locale heading, falling back to IT for an unknown locale', () => {
    expect(renderArticleHubGridBlock('', 'de')).toContain('Neueste Artikel für Grenzgänger');
    expect(renderArticleHubGridBlock('', 'es')).toContain('Ultimi Articoli per Frontalieri');
  });
});

describe('ensureArticleHubCards (create-or-refresh)', () => {
  /**
   * The live `/articoli-svizzera/` shell, trimmed to the part that matters.
   * It came from staticPagesPlugin's GENERIC fallback branch — copy, an empty
   * 38rem CLS box, the shell nav — so it carries no grid marker, which is why
   * the corpus-side refresher reported "nothing to refresh" on it for a week
   * while 617 articles sat behind it.
   */
  const MARKERLESS_LANDING =
    '<div id="root"><main id="main-content"><div class="s-wWmcGm">'
    + '<article><h1 class="s-lHdmvf">Articoli Svizzera (guida frontaliere)</h1>'
    + '<p class="s-zvDmuv">Informazioni utili per frontalieri.</p></article>'
    + '<div style="border:1px solid #e2e8f0;border-radius:12px;background:#ffffff;height:38rem;margin-top:1.5rem"></div>'
    + '<nav class="s-eazYqN"><a href="/">Simulatore Fiscale</a></nav>'
    + '</div></main></div>';

  it('CREATES the grid on a landing that has no marker, in the site template\'s own order', () => {
    const out = ensureArticleHubCards(MARKERLESS_LANDING, '<a>card</a>', 'it');
    expect(out).toContain(
      '</article><h2 class="s-sXAwQz">Ultimi Articoli per Frontalieri</h2>'
      + '<div class="ssg-article-grid"><a>card</a></div><nav class="s-eazYqN">',
    );
    // The empty CLS box was reserving space for exactly this content, so the
    // grid takes its place rather than stacking under 38rem of white.
    expect(out).not.toContain('height:38rem');
    // Everything else survives untouched.
    expect(out).toContain('<h1 class="s-lHdmvf">Articoli Svizzera (guida frontaliere)</h1>');
    expect(out).toContain('<a href="/">Simulatore Fiscale</a>');
    expect(out!.endsWith('</nav></div></main></div>')).toBe(true);
  });

  it('self-heals into the ordinary refresh path: a second run is a plain swap', () => {
    const first = ensureArticleHubCards(MARKERLESS_LANDING, '<a>card</a>', 'it')!;
    // Same cards → byte-identical, i.e. it did NOT insert a second grid.
    expect(ensureArticleHubCards(first, '<a>card</a>', 'it')).toBe(first);
    const second = ensureArticleHubCards(first, '<a>newer</a>', 'it')!;
    expect(second.match(/ssg-article-grid/g)).toHaveLength(1);
    expect(second).toContain('<div class="ssg-article-grid"><a>newer</a></div>');
  });

  it('refreshes in place when the marker already exists, adding no heading', () => {
    const withGrid =
      '<div class="s-wWmcGm"><h2 class="s-sXAwQz">Ultimi Articoli per Frontalieri</h2>'
      + '<div class="ssg-article-grid"><a class="ssg-art-card"><div>old</div></a></div>'
      + '<nav class="s-eazYqN">n</nav></div>';
    const out = ensureArticleHubCards(withGrid, '<a>new</a>', 'it')!;
    expect(out.match(/s-sXAwQz/g)).toHaveLength(1);
    expect(out).toContain('<div class="ssg-article-grid"><a>new</a></div>');
  });

  it('refuses an unbalanced grid instead of falling through to a second one', () => {
    // Falling through to the insert path here would leave the broken grid AND
    // add a new one — two markers, and the refresher would then patch the
    // wrong (first) one forever.
    const broken = '<div class="ssg-article-grid"><div><nav class="s-eazYqN">n</nav>';
    expect(ensureArticleHubCards(broken, '<a>x</a>', 'it')).toBeNull();
  });

  it('refuses a page with no shell nav rather than appending the grid somewhere', () => {
    expect(ensureArticleHubCards('<body>no shell here</body>', '<a>x</a>', 'it')).toBeNull();
  });

  it('only drops an EMPTY inline-styled box, never one with content in it', () => {
    const withContent =
      '<div class="s-wWmcGm"><article>c</article>'
      + '<div style="height:38rem"><p>real content</p></div>'
      + '<nav class="s-eazYqN">n</nav></div>';
    const out = ensureArticleHubCards(withContent, '<a>x</a>', 'it')!;
    expect(out).toContain('<p>real content</p>');
  });

  it('never removes an AdSense placeholder (Non-Negotiable #7)', () => {
    // Ad slots are class-based and aria-hidden, never inline-styled, so the
    // empty-skeleton pattern must not be able to reach one.
    const withAd =
      '<div class="s-wWmcGm"><article>c</article><div class="s-1zvlaE" aria-hidden="true"></div>'
      + '<nav class="s-eazYqN">n</nav></div>';
    const out = ensureArticleHubCards(withAd, '<a>x</a>', 'it')!;
    expect(out).toContain('<div class="s-1zvlaE" aria-hidden="true"></div>');
    expect(out).toContain('<div class="ssg-article-grid"><a>x</a></div>');
  });

  it('exports the marker and anchor the corpus-side writer scans for', () => {
    expect(ARTICLE_HUB_GRID_OPEN).toBe('<div class="ssg-article-grid">');
    expect(ARTICLE_HUB_SHELL_NAV_OPEN).toBe('<nav class="s-eazYqN">');
  });
});
