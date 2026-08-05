import { describe, it, expect } from 'vitest';
import {
  renderArticleHubCards,
  replaceArticleHubCards,
} from '../packages/articles/engine/articlesHubCards';

/**
 * The hub grid is emitted by two producers (the site build and nanako's
 * fast-publish). These tests pin the two properties that make that safe:
 * the markup is byte-identical to what production already serves, and the
 * in-place swap cannot eat the rest of the page.
 */

/** Lifted verbatim from the live hub (articolifrontaliere-it shard). */
const LIVE_CARD =
  '<a href="/articoli-frontaliere/fondo-liberta-svizzera-multe" aria-label="Multe sui mezzi pubblici: il fondo che paga per gli indigenti" class="ssg-art-card">'
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
    expect(html).toContain('href="/de/grenzgaenger-artikel/bussen-fonds"');
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
