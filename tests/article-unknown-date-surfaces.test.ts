import { describe, expect, it } from 'vitest';
import { renderArticleHubCards } from '../packages/articles/engine/articlesHubCards';
import { renderArticleList } from '../build-plugins/sectionPagesPlugin';
import { isUnknownArticleDate } from '../services/articleSourceDates';

/**
 * `date: ''` in the article registry means "publication date unknown" — the
 * corpus decided not to invent one (corpus PR 2082). Every surface that prints
 * an article date has to render that as NO date: never "Invalid Date", never an
 * empty `<time datetime="">`, never a substitute date.
 */

const UNKNOWN = { id: 'stop-ristorni-tassa-salute', category: 'fiscale', date: '', image: '/images/blog/x.webp' };
const DATED = { id: 'fondo-liberta-svizzera-multe', category: 'pratico', date: '2026-07-29', image: '/images/blog/y.webp' };

describe('the unknown-date marker', () => {
  it('is exactly the empty string, not any falsy or malformed value', () => {
    expect(isUnknownArticleDate('')).toBe(true);
    for (const value of [undefined, null, 'unknown', '2026-02-30', 'invalid', ' ']) {
      expect(isUnknownArticleDate(value)).toBe(false);
    }
  });
});

describe('article hub cards', () => {
  const render = (articles: Array<typeof UNKNOWN>) => renderArticleHubCards({
    articles,
    locale: 'it',
    sectionSlug: 'articoli-frontaliere',
    localePrefix: '',
    resolveSlug: (id) => id,
    resolveMeta: () => ({ title: 'Titolo', desc: 'Descrizione' }),
  });

  it('renders no date at all for an unknown publication date', () => {
    const html = render([UNKNOWN]);
    expect(html).not.toContain('Invalid Date');
    expect(html).not.toContain('ssg-art-date');
    expect(html).toContain('href="/articoli-frontaliere/stop-ristorni-tassa-salute/"');
  });

  it('keeps the date of a dated card next to an undated one', () => {
    const html = render([DATED, UNKNOWN]);
    expect(html).toContain('<span class="ssg-art-date">29 lug 2026</span>');
    expect((html.match(/ssg-art-date/g) || []).length).toBe(1);
  });
});

describe('Google-News topic section list', () => {
  const row = (date: string) => ({
    id: 'stop-ristorni-tassa-salute',
    date,
    authorName: 'Laura Bianchi',
    localeSlug: 'stop-ristorni-tassa-salute',
    displayTitle: 'Stop ristorni',
  });

  it('omits the <time> element and its separator when the date is unknown', () => {
    const html = renderArticleList([row('') as never], 'it');
    expect(html).not.toContain('<time');
    expect(html).not.toContain('Invalid Date');
    expect(html).not.toContain(' · ');
    expect(html).toContain('<span>Laura Bianchi</span>');
  });

  it('keeps the dated byline unchanged', () => {
    const html = renderArticleList([row('2026-02-18T11:49:14.807Z') as never], 'it');
    expect(html).toContain('<time datetime="2026-02-18">18 febbraio 2026</time>');
    expect(html).toContain('<span aria-hidden="true"> · </span>');
  });
});
