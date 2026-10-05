/**
 * The credit of a Wikimedia Commons cover on the SPA article page (P14 S2).
 *
 * Owner decision, 2026-10-03: «recuperiamo autore e licenza, corregendo i dati
 * strutturati. se dobbiamo mostrare un testo facciamo lo vedere in fondo
 * all'articolo». The static article page already does both (S1); the SPA view
 * replaces it after hydration, so without this the reader saw no credit and
 * the NewsArticle the SPA writes declared the cover as a bare URL.
 *
 * A real render of the article view, with the network stubbed at `fetch` and
 * only the modules that would reach for the corpus content or Firestore
 * replaced. The ad components are replaced by markers so their ORDER can be
 * read back: the credit line must not move or add any of them (AGENTS.md #7).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = vi.hoisted(() => {
  const id = 'fixture-credit-article';
  const cover = `https://cdn.frontaliereticino.ch/images/blog/${id}.webp`;
  return { id, cover };
});

vi.mock('@/data/blog-articles-data', () => ({
  ARTICLES: [
    { id: fixture.id, category: 'novita', date: '2026-10-01', image: fixture.cover, hasCalculator: false },
    { id: 'fixture-neighbour', category: 'novita', date: '2026-09-30', image: 'https://cdn.frontaliereticino.ch/images/blog/fixture-neighbour.webp', hasCalculator: false },
  ],
}));

// The meta and body chunks are corpus content; the test seeds the same keys
// through the i18n store instead (mergeArticleMetaOverlay, below).
vi.mock('@/services/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/i18n')>()),
  loadBlogMeta: vi.fn(async () => {}),
  loadArticleBody: vi.fn(async () => {}),
}));

vi.mock('@/services/router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/router')>()),
  preloadBlogData: vi.fn(async () => {}),
}));

vi.mock('@/services/authorProfileService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/authorProfileService')>()),
  getArticleAuthorOverride: vi.fn(async () => null),
}));

// Rails eligible: the ≥1280px desktop tier.
vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: (query: string) => query === '(min-width: 1280px)',
}));

// Ad components → markers that keep their identity and order.
vi.mock('@/components/shared/AdSenseBanner', () => ({
  default: ({ adSlot, enabled }: { adSlot: string; enabled?: boolean }) =>
    enabled ? <div data-ad="" data-ad-slot={adSlot} /> : null,
}));
vi.mock('@/components/shared/ArticleRailAdStack', () => ({
  default: ({ side, enabled }: { side: string; enabled?: boolean }) =>
    enabled ? <div data-ad="" data-ad-slot={`rail-${side}`} /> : null,
}));
vi.mock('@/components/shared/GptPocSlot', () => ({ default: () => null }));
vi.mock('@/components/shared/LeadMagnetCTA', () => ({ default: () => null }));
vi.mock('@/components/shared/PreferredSourceCTA', () => ({ default: () => <div data-preferred-source-cta="" /> }));
vi.mock('@/components/community/PreferredSourcePopup', () => ({ default: () => null }));
vi.mock('@/components/calculator/ConsultingCTA', () => ({ ConsultingCTA: () => null }));

import BlogArticles from '@/components/community/BlogArticles';
import NavigationContext, { type NavigationContextType } from '@/services/NavigationContext';
import { mergeArticleMetaOverlay } from '@/services/i18n';
import { __resetImageCreditsForTests } from '@/services/imageCredits';
import { AD_SLOTS } from '@/services/adsenseSlots';
import { SITE_ORGANIZATION_ID } from '@/services/seo/imageObjectLd';
import { renderImageCreditHtml, type ImageCreditRecord } from '@/packages/articles/engine/shared/imageCredits.mjs';

const words = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');
const body = (n: number) => [
  words(120, `intro${n}w`),
  `## Sezione ${n}.1`,
  words(220, `alpha${n}w`),
  `## Sezione ${n}.2`,
  words(220, `beta${n}w`),
].join('\n\n');

mergeArticleMetaOverlay('it', {
  [`blog.article.${fixture.id}.title`]: 'Articolo di prova con copertina accreditata',
  [`blog.article.${fixture.id}.excerpt`]: 'Un articolo inventato per il test dei crediti delle copertine.',
  [`blog.article.${fixture.id}.body1`]: body(1),
  [`blog.article.${fixture.id}.body2`]: body(2),
  [`blog.article.${fixture.id}.body3`]: body(3),
  [`blog.article.${fixture.id}.faq`]: JSON.stringify([
    { q: 'Prima domanda di prova?', a: 'Prima risposta di prova, abbastanza lunga.' },
    { q: 'Seconda domanda di prova?', a: 'Seconda risposta di prova, abbastanza lunga.' },
  ]),
  'blog.article.fixture-neighbour.title': 'Articolo vicino',
});

const PAGE_URL = 'https://commons.wikimedia.org/wiki/File:Fixture_Valley.jpg';
const credits = {
  schema: 1,
  commit: 'fixture-commit',
  section: 'frontaliere',
  files: {
    'Fixture Valley.jpg': {
      pageUrl: PAGE_URL,
      author: { name: 'Fixture Photographer', url: 'https://commons.wikimedia.org/wiki/User:Fixture_Photographer', type: 'Person' },
      attribution: null,
      licence: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/', family: 'cc-by-sa', attributionRequired: true },
      fetchedAt: '2026-10-04',
    },
  },
  covers: { [fixture.id]: { file: 'Fixture Valley.jpg', modified: 'cropped' } },
};

/** The record the static page renders from, for the wording comparison. */
const record: ImageCreditRecord = {
  schema: 1,
  cover: `/images/blog/${fixture.id}.webp`,
  source: 'wikimedia-commons',
  commons: { title: 'Fixture Valley.jpg', pageUrl: PAGE_URL },
  author: { text: 'Fixture Photographer', name: 'Fixture Photographer', url: 'https://commons.wikimedia.org/wiki/User:Fixture_Photographer', type: 'Person' },
  attribution: null,
  licence: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/', family: 'cc-by-sa', attributionRequired: true },
  restrictions: [],
  modified: 'cropped',
  fetchedAt: '2026-10-04',
  status: 'ok',
  curation: null,
};

const json = (status: number, payload?: unknown) => Promise.resolve({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(payload),
} as unknown as Response);

/** The same credits file with the cover under another licence. */
function creditsUnder(licence: Record<string, unknown>) {
  return { ...credits, files: { 'Fixture Valley.jpg': { ...credits.files['Fixture Valley.jpg'], licence } } };
}

/** Every request answers 404 except the credits file, when `withCredits` (`true` = the CC BY-SA file). */
function stubNetwork(withCredits: boolean | object) {
  const payload = withCredits === true ? credits : withCredits || null;
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (payload && url.includes('/data/image-credits-frontaliere.json')) return json(200, payload);
    return json(404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const nav = { navigateTo: vi.fn() } as unknown as NavigationContextType;

function renderArticle(): HTMLElement {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationContext.Provider value={nav}>{children}</NavigationContext.Provider>
  );
  return render(<BlogArticles selectedArticle={fixture.id as never} section="frontaliere" />, { wrapper }).container;
}

/** The static NewsArticle a shard page carries before the SPA replaces it. */
function addStaticNewsArticle(image: Record<string, unknown>): HTMLScriptElement {
  const el = document.createElement('script');
  el.type = 'application/ld+json';
  el.textContent = JSON.stringify({ '@context': 'https://schema.org', '@type': 'NewsArticle', headline: 'static', image });
  document.head.appendChild(el);
  return el;
}

/**
 * Budget for the render's async chain (registry, body, credits fetch: all
 * stubbed, normally a few ms) on a loaded CI runner. A real failure only takes
 * longer to report.
 */
const WAIT = { timeout: 5000 };

/** The NewsArticle the SPA wrote, or null before the first write. */
function readSpaNewsArticle(): Record<string, unknown> | null {
  const script = document.getElementById('blog-article-jsonld');
  return script ? JSON.parse(script.textContent || '{}') as Record<string, unknown> : null;
}

async function spaNewsArticle(): Promise<Record<string, unknown>> {
  await waitFor(() => expect(readSpaNewsArticle()).not.toBeNull(), WAIT);
  return readSpaNewsArticle()!;
}

/** Ad markers in document order. */
const adSequence = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('[data-ad]')].map((el) => el.dataset.adSlot ?? '');

/** The direct child of `parent` that contains `node`. */
function childOf(parent: Element, node: Element): Element | null {
  let current: Element | null = node;
  while (current && current.parentElement !== parent) current = current.parentElement;
  return current;
}

const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  __resetImageCreditsForTests();
  sessionStorage.setItem(`viewed_${fixture.id}`, '1');
  document.head.querySelectorAll('script[type="application/ld+json"]').forEach((el) => el.remove());
  // jsdom has none; the table-of-contents effect observes the headings.
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the cover credit at the end of the SPA article (P14)', () => {
  it('renders the line after the FAQ and before the contextual CTAs', async () => {
    stubNetwork(true);
    const root = renderArticle();
    const footer = await waitFor(() => {
      const el = root.querySelector('footer.ft-image-credit');
      expect(el).not.toBeNull();
      return el!;
    }, WAIT);

    const faq = root.querySelector('#article-faq-content')!;
    expect(faq, 'fixture FAQ not rendered').not.toBeNull();
    const article = footer.closest('article')!;
    expect(article, 'credit outside the <article>').not.toBeNull();
    const faqBlock = childOf(footer.parentElement!, faq);
    expect(footer.previousElementSibling, 'the line does not follow the FAQ').toBe(faqBlock);

    // The contextual CTA grid comes right after it; the feedback block and the
    // related articles further down.
    const ctaLink = [...root.querySelectorAll('a')].find((a) => a.className.includes('text-on-accent') && follows(footer, a));
    expect(ctaLink, 'no contextual CTA rendered').toBeDefined();
    expect(footer.nextElementSibling, 'the line is not right before the contextual CTAs').toBe(childOf(footer.parentElement!, ctaLink!));
  });

  it('says what the static page says, with the same links', async () => {
    stubNetwork(true);
    const root = renderArticle();
    const footer = await waitFor(() => {
      const el = root.querySelector('footer.ft-image-credit');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    }, WAIT);
    const staticFooter = document.createElement('div');
    staticFooter.innerHTML = renderImageCreditHtml(record, 'it');
    const expected = staticFooter.firstElementChild as HTMLElement;

    expect(footer.textContent).toBe(expected.textContent);
    expect(footer.getAttribute('data-image-credit')).toBe('wikimedia-commons');
    expect(footer.className).toContain('text-sm');
    expect(footer.className).toContain('text-subtle');
    expect(footer.className).not.toMatch(/dark:|#[0-9a-f]{3,6}/i);

    const links = [...footer.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([...expected.querySelectorAll('a')].map((a) => a.getAttribute('href')));
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener');
      expect(a.className).toContain('underline');
      expect(a.className).toContain('hover:text-body');
    }
    expect([...footer.querySelectorAll('bdi')].map((b) => b.textContent)).toEqual(['Fixture Valley', 'Fixture Photographer']);
  });

  it('renders no line when the cover has no credit', async () => {
    stubNetwork(false);
    const root = renderArticle();
    await spaNewsArticle();
    await waitFor(() => expect(root.querySelector('#article-faq-content')).not.toBeNull(), WAIT);
    expect(root.querySelector('footer.ft-image-credit')).toBeNull();
  });

  it('asks for the section credits once, with the body', async () => {
    const fn = stubNetwork(true);
    const root = renderArticle();
    await waitFor(() => expect(root.querySelector('footer.ft-image-credit')).not.toBeNull(), WAIT);
    const creditRequests = fn.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('image-credits-'));
    expect(creditRequests).toHaveLength(1);
    expect(creditRequests[0]).toMatch(/\/data\/image-credits-frontaliere\.json\?v=\d+$/);
  });
});

/**
 * Owner decision, 2026-10-05: «Togliere il credito» for public domain and CC0
 * covers. No visible line; the NewsArticle ImageObject keeps author, licence
 * and the Commons file page.
 */
describe('public domain and CC0 covers in the SPA (owner decision 2026-10-05)', () => {
  it.each([
    ['public domain', { name: 'Public domain', url: null, family: 'pd', attributionRequired: false }, 'Public domain', PAGE_URL],
    ['CC0', { name: 'CC0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', family: 'cc0', attributionRequired: false }, 'CC0', 'https://creativecommons.org/publicdomain/zero/1.0/'],
  ])('%s: no line, credited ImageObject', async (_label, licence, notice, license) => {
    stubNetwork(creditsUnder(licence));
    const root = renderArticle();
    await waitFor(() => {
      expect(readSpaNewsArticle()?.image).toMatchObject({
        '@type': 'ImageObject',
        contentUrl: fixture.cover,
        creator: { '@type': 'Person', name: 'Fixture Photographer', url: 'https://commons.wikimedia.org/wiki/User:Fixture_Photographer' },
        creditText: 'Fixture Photographer / Wikimedia Commons',
        copyrightNotice: notice,
        license,
        acquireLicensePage: PAGE_URL,
        isBasedOn: PAGE_URL,
      });
    }, WAIT);
    await waitFor(() => expect(root.querySelector('#article-faq-content')).not.toBeNull(), WAIT);
    expect(root.querySelector('footer.ft-image-credit')).toBeNull();
  });
});

describe('the SPA NewsArticle image (P14)', () => {
  it('carries the photo’s creator and licence once the credit has loaded', async () => {
    stubNetwork(true);
    renderArticle();
    await waitFor(() => {
      expect(readSpaNewsArticle()?.image).toMatchObject({
        '@type': 'ImageObject',
        contentUrl: fixture.cover,
        url: fixture.cover,
        creator: { '@type': 'Person', name: 'Fixture Photographer', url: 'https://commons.wikimedia.org/wiki/User:Fixture_Photographer' },
        creditText: 'Fixture Photographer / Wikimedia Commons',
        copyrightNotice: '© Fixture Photographer',
        license: 'https://creativecommons.org/licenses/by-sa/4.0/',
        acquireLicensePage: PAGE_URL,
        isBasedOn: PAGE_URL,
      });
    }, WAIT);
  });

  it('keeps the static page’s credited ImageObject when the credits fetch fails', async () => {
    stubNetwork(false);
    const staticImage = {
      '@type': 'ImageObject',
      contentUrl: fixture.cover,
      url: fixture.cover,
      creator: { '@type': 'Person', name: 'Fixture Photographer' },
      creditText: 'Fixture Photographer / Wikimedia Commons',
      copyrightNotice: '© Fixture Photographer',
      license: 'https://creativecommons.org/licenses/by-sa/4.0/',
      acquireLicensePage: PAGE_URL,
      isBasedOn: PAGE_URL,
      width: 1200,
      height: 675,
    };
    const staticScript = addStaticNewsArticle(staticImage);
    renderArticle();
    const ld = await spaNewsArticle();
    expect(staticScript.isConnected, 'the static NewsArticle was not replaced').toBe(false);
    expect(ld.image).toEqual(staticImage);
  });

  it('does not keep a static ImageObject that credits the site, or another cover', async () => {
    stubNetwork(false);
    addStaticNewsArticle({
      '@type': 'ImageObject',
      contentUrl: fixture.cover,
      creator: { '@type': 'Organization', '@id': SITE_ORGANIZATION_ID, name: 'Frontaliere Ticino' },
      copyrightNotice: '© 2024–2026 Frontaliere Ticino. Tutti i diritti riservati.',
    });
    addStaticNewsArticle({
      '@type': 'ImageObject',
      contentUrl: 'https://cdn.frontaliereticino.ch/images/blog/some-other-cover.webp',
      creator: { '@type': 'Person', name: 'Someone Else' },
    });
    renderArticle();
    expect((await spaNewsArticle()).image).toBe(fixture.cover);
  });

  it('stays a bare URL without a credit, as before', async () => {
    stubNetwork(false);
    renderArticle();
    expect((await spaNewsArticle()).image).toBe(fixture.cover);
  });
});

describe('the credit survives the article’s Print button', () => {
  it('is not among the footers the print stylesheet hides', () => {
    // index.css hides every `footer` in print — meant for the site chrome. The
    // cover prints, so its credit must print with it.
    const css = readFileSync(resolve(__dirname, '..', '..', 'index.css'), 'utf-8');
    const print = css.slice(css.indexOf('@media print'));
    const hidden = print.slice(0, print.indexOf('{ display: none !important; }'));
    expect(hidden).not.toMatch(/(^|[\s,])footer\s*,/);
    expect(hidden).toContain('footer:not(.ft-image-credit)');
  });
});

describe('the ad components keep their order (AGENTS.md #7)', () => {
  it('places the line after every in-article ad and before the end multiplex, moving none', async () => {
    stubNetwork(false);
    const plain = renderArticle();
    await waitFor(() => expect(adSequence(plain)).toContain(AD_SLOTS.ARTICLE_END_MULTIPLEX.slot), WAIT);
    await waitFor(() => expect(adSequence(plain)).toContain('rail-right'), WAIT);
    const without = adSequence(plain);
    cleanup();
    __resetImageCreditsForTests();

    stubNetwork(true);
    const credited = renderArticle();
    const footer = await waitFor(() => {
      const el = credited.querySelector('footer.ft-image-credit');
      expect(el).not.toBeNull();
      return el!;
    }, WAIT);
    await waitFor(() => expect(adSequence(credited)).toEqual(without), WAIT);

    const inline = [...credited.querySelectorAll<HTMLElement>('[data-ad]')]
      .filter((el) => !['rail-left', 'rail-right', AD_SLOTS.ARTICLE_END_MULTIPLEX.slot].includes(el.dataset.adSlot ?? ''));
    expect(inline.length, 'fixture body placed no in-article ad').toBeGreaterThan(0);
    for (const ad of inline) expect(follows(ad, footer), 'an in-article ad sits after the line').toBe(true);
    const end = credited.querySelector(`[data-ad-slot="${AD_SLOTS.ARTICLE_END_MULTIPLEX.slot}"]`)!;
    expect(follows(footer, end), 'the end multiplex moved above the line').toBe(true);
    expect(without[0]).toBe('rail-left');
    expect(without[without.length - 1]).toBe('rail-right');
  });
});
