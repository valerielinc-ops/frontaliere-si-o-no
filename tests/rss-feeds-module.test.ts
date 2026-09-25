import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildAllRssFeeds, buildSectionFeeds, RSS_SECTIONS, RSS_MAX_ITEMS } from '../packages/articles/engine/rssFeeds.mjs';
import { repairSerpSnippet } from '../build-plugins/shared/clauseTail.mjs';

/**
 * Gate for the RSS generator after it moved out of `scripts/generate-rss-feeds.mjs`
 * into the articles package (issue #4974 item 2), where BOTH this site and the
 * articles repository's publisher call it.
 *
 * What matters here is the two things the move actually changed:
 *   1. the corpus location is a parameter (`layout`), so the publisher can point
 *      at `content/` while the site keeps pointing at `services/locales`;
 *   2. `media:content` is resolved from the article registry instead of probing
 *      `public/images/**` — a filesystem the publisher does not have.
 * Everything else must keep emitting the same shape, which is why the fixture
 * asserts on the rendered XML rather than on intermediate structures.
 */

const LAYOUT = { seoDir: 'seo', localesDir: 'locales' };

/** Minimal on-disk corpus in the shape the readers parse. */
function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-feeds-'));
  const section = RSS_SECTIONS[0]; // frontaliere

  fs.mkdirSync(path.join(root, 'seo'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'seo', section.seoFiles[0]),
    `export const BLOG_SEO_METADATA = {
  'blog-alpha': {
    structuredData: { "headline": "Alpha headline", "description": "Alpha description", "datePublished": "2026-03-02", "articleSection": "Fiscale", "author": { "@type": "Person", "@id": "https://frontaliereticino.ch/autori/guest-author/#person", "name": "Guest Author", "url": "https://frontaliereticino.ch/autori/guest-author/" } },
  },
  'blog-beta': {
    structuredData: { "headline": "Beta headline", "description": "Beta description", "datePublished": "2026-03-01", "articleSection": "Pratico", "author": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "Redazione Frontaliere Ticino" } },
  },
};
`,
  );

  // Slug map — `slugFile` is repo-relative and NOT part of `layout`, so the
  // fixture writes it at exactly the path the section descriptor names.
  const slugFile = path.join(root, section.slugFile);
  fs.mkdirSync(path.dirname(slugFile), { recursive: true });
  fs.writeFileSync(
    slugFile,
    `const BLOG_SLUGS = {
  'alpha': { it: 'alpha-it', en: 'alpha-en', de: 'alpha-de', fr: 'alpha-fr' },
  'beta': { it: 'beta-it', en: 'beta-en', de: 'beta-de', fr: 'beta-fr' },
};
`,
  );

  fs.mkdirSync(path.join(root, 'locales'), { recursive: true });
  for (const locale of ['it', 'en', 'de', 'fr']) {
    fs.writeFileSync(
      path.join(root, 'locales', section.metaFile(locale)),
      `const meta = {
 'blog.article.alpha.title': 'Alpha ${locale}',
 'blog.article.alpha.excerpt': 'Alpha excerpt ${locale}',
 'blog.article.beta.title': 'Beta ${locale}',
 'blog.article.beta.excerpt': 'Beta excerpt ${locale}',
};
`,
    );
    const bodyDir = path.join(root, 'locales', section.bodyDir, locale);
    fs.mkdirSync(bodyDir, { recursive: true });
    fs.writeFileSync(
      path.join(bodyDir, 'alpha.ts'),
      'export default { ' +
        "'blog.article.alpha.body1': `Alpha body text in " +
        locale +
        ', long enough to clear the fifty character minimum.` };\n',
    );
  }

  return root;
}

const REGISTRY = [
  { id: 'alpha', image: 'https://cdn.frontaliereticino.ch/images/blog/alpha.webp' },
  { id: 'beta', image: '/images/places/beta.webp' },
];

describe('packages/articles/engine/rssFeeds', () => {
  it('reads the corpus from the layout it is given, not a hardcoded site path', () => {
    const root = makeFixture();
    const [section] = buildAllRssFeeds({
      repairSerpSnippet,
      fs,
      path,
      rootDir: root,
      registries: { frontaliere: REGISTRY },
      layout: LAYOUT,
    });

    expect(section.id).toBe('frontaliere');
    expect(section.articleCount).toBe(2);
    expect(section.slugCount).toBe(2);
    // 4 locales + the main feed copy.
    expect(section.feeds.map(([name]) => name)).toEqual([
      'rss-it.xml',
      'rss.xml',
      'rss-en.xml',
      'rss-de.xml',
      'rss-fr.xml',
    ]);
  });

  it('re-parents the slug module via slugDir (the publisher keeps it under content/)', () => {
    const root = makeFixture();
    const section = RSS_SECTIONS[0];
    // Move the slug file from the site path (`services/routerBlogData.ts`) to a
    // flat `corpus/` dir — exactly the reshaping the articles repo needs.
    const from = path.join(root, section.slugFile);
    const to = path.join(root, 'corpus', path.basename(section.slugFile));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);

    // Without slugDir the slug map is unreachable → slugs fall back to article ids.
    const blind = buildSectionFeeds({
      repairSerpSnippet,
      fs, path, rootDir: root, section, registry: REGISTRY, layout: LAYOUT,
    });
    expect(blind.slugCount).toBe(0);
    expect(blind.feeds.find(([n]) => n === 'rss-it.xml')![1]).toContain(
      '<link>https://frontaliereticino.ch/articoli-frontaliere/alpha/</link>',
    );

    const located = buildSectionFeeds({
      repairSerpSnippet,
      fs, path, rootDir: root, section, registry: REGISTRY,
      layout: { ...LAYOUT, slugDir: 'corpus' },
    });
    expect(located.slugCount).toBe(2);
    expect(located.feeds.find(([n]) => n === 'rss-it.xml')![1]).toContain(
      '<link>https://frontaliereticino.ch/articoli-frontaliere/alpha-it/</link>',
    );
  });

  it('emits nothing for a section whose seo chunks are absent, instead of throwing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-empty-'));
    const result = buildSectionFeeds({
      repairSerpSnippet,
      fs,
      path,
      rootDir: root,
      section: RSS_SECTIONS[0],
      registry: REGISTRY,
      layout: LAYOUT,
    });
    expect(result.articleCount).toBe(0);
    expect(result.feeds).toEqual([]);
  });

  it('resolves media:content from the registry, absolutising origin-relative images', () => {
    const root = makeFixture();
    const [section] = buildAllRssFeeds({
      repairSerpSnippet,
      fs,
      path,
      rootDir: root,
      registries: { frontaliere: REGISTRY },
      layout: LAYOUT,
    });
    const it = section.feeds.find(([name]) => name === 'rss-it.xml')![1];

    // Already-absolute CDN URL passes through untouched.
    expect(it).toContain(
      '<media:content url="https://cdn.frontaliereticino.ch/images/blog/alpha.webp" medium="image"/>',
    );
    // `/images/places/*` is NOT CDN-offloaded and must be served from origin —
    // the filesystem probe this replaced did exactly that.
    expect(it).toContain(
      '<media:content url="https://frontaliereticino.ch/images/places/beta.webp" medium="image"/>',
    );
  });

  it('falls back to the app icon when the registry has no image for an article', () => {
    const root = makeFixture();
    const [section] = buildAllRssFeeds({
      repairSerpSnippet,
      fs,
      path,
      rootDir: root,
      registries: { frontaliere: [] },
      layout: LAYOUT,
    });
    const it = section.feeds.find(([name]) => name === 'rss-it.xml')![1];
    expect(it).toContain(
      '<media:content url="https://frontaliereticino.ch/icons/icon-512x512.png" medium="image"/>',
    );
  });

  it('renders localized titles, excerpts, bodies and trailing-slash article links', () => {
    const root = makeFixture();
    const [section] = buildAllRssFeeds({
      repairSerpSnippet,
      fs,
      path,
      rootDir: root,
      registries: { frontaliere: REGISTRY },
      layout: LAYOUT,
    });
    const de = section.feeds.find(([name]) => name === 'rss-de.xml')![1];

    expect(de).toContain('<title>Alpha de</title>');
    // «Alpha excerpt de» finisce su `de`, che è nella lista di stopword (art.
    // tedesco/francese), quindi repairSerpSnippet la spela e chiude con il punto.
    // Il fixture nomina i campi `<cosa> <locale>` e la coincidenza col locale
    // rende questa asserzione la prova più diretta che la riparazione è ATTIVA
    // su questo percorso: senza il parametro passato, qui leggeremmo ancora
    // «Alpha excerpt de».
    expect(de).toContain('<![CDATA[Alpha excerpt.]]>');
    expect(de).toContain('<content:encoded><![CDATA[Alpha body text');
    // Localized slug + localized section prefix, trailing slash (site convention).
    expect(de).toContain('<link>https://frontaliereticino.ch/de/grenzgaenger-artikel/alpha-de/</link>');
    // Il guid porta l'articleId, non lo slug, e non e un permalink (#162).
    expect(de).toContain(
      '<guid isPermaLink="false">https://frontaliereticino.ch/de/grenzgaenger-artikel/alpha</guid>',
    );
    // Category comes from the seo chunk's articleSection.
    expect(de).toContain('<category>Fiscale</category>');
    // Newest first.
    expect(de.indexOf('Alpha de')).toBeLessThan(de.indexOf('Beta de'));
  });

  it('makes the main feed a byte copy of the Italian one, self-linking to the main filename', () => {
    const root = makeFixture();
    const [section] = buildAllRssFeeds({
      repairSerpSnippet,
      fs,
      path,
      rootDir: root,
      registries: { frontaliere: REGISTRY },
      layout: LAYOUT,
    });
    const it = section.feeds.find(([name]) => name === 'rss-it.xml')![1];
    const main = section.feeds.find(([name]) => name === 'rss.xml')![1];

    expect(main).toBe(it);
    expect(main).toContain(
      '<atom:link href="https://frontaliereticino.ch/rss.xml" rel="self" type="application/rss+xml"/>',
    );
  });

  it('caps each feed at RSS_MAX_ITEMS', () => {
    const root = makeFixture();
    const section = RSS_SECTIONS[0];
    // Overwrite the seo chunk with more entries than the cap allows.
    const entries = Array.from({ length: RSS_MAX_ITEMS + 10 }, (_, i) => {
      const day = String((i % 28) + 1).padStart(2, '0');
      return `  'blog-art${i}': { structuredData: { "headline": "H${i}", "description": "D${i}", "datePublished": "2026-03-${day}", "articleSection": "Notizie" } },`;
    }).join('\n');
    fs.writeFileSync(
      path.join(root, 'seo', section.seoFiles[0]),
      `export const BLOG_SEO_METADATA = {\n${entries}\n};\n`,
    );

    const result = buildSectionFeeds({
      repairSerpSnippet,
      fs,
      path,
      rootDir: root,
      section,
      registry: REGISTRY,
      layout: LAYOUT,
    });
    const it = result.feeds.find(([name]) => name === 'rss-it.xml')![1];
    expect((it.match(/<item>/g) ?? []).length).toBe(RSS_MAX_ITEMS);
  });
});

/**
 * The feed must read the chunk new articles are actually written to.
 *
 * `seoFiles` was `['seo-blog.ts', 'seo-blog-2.ts']`, on the reasoning that the
 * feed "only needs the freshest chunks". That stopped being true when
 * create-article started appending to `seo-blog-5.ts` (its `SECTION.seoFile`):
 * the two chunks the feed read stopped receiving articles, and since they are
 * the sole source of the item list, the feed froze. Measured when found: the
 * live rss.xml's newest item was 3 May while the corpus published daily into
 * July — three months invisible to subscribers, and nothing failed, because a
 * feed that stops updating still serves 200.
 *
 * So the guard is not "read these files" but "read wherever the generator
 * writes", checked against the generator's own configuration.
 */
describe('RSS reads the chunk create-article writes to (#4974)', () => {
  it('covers the section seoFile create-article appends new articles to', () => {
    const createArticle = fs.readFileSync(
      path.resolve(__dirname, '..', 'scripts', 'create-article.mjs'),
      'utf-8',
    );
    const written = [...createArticle.matchAll(/seoFile:\s*'services\/seo\/([^']+)'/g)].map(
      (m) => m[1],
    );
    expect(written.length, 'no seoFile found in create-article.mjs').toBeGreaterThan(0);

    for (const section of RSS_SECTIONS) {
      const covered = written.filter((f) => section.seoFiles.includes(f));
      expect(
        covered.length,
        `section '${section.id}' reads ${JSON.stringify(section.seoFiles)} but new articles ` +
          `go to one of ${JSON.stringify(written)} — a feed that does not read the chunk ` +
          `being written to silently stops updating`,
      ).toBeGreaterThan(0);
    }
  });
});

/**
 * Il parametro non deve mai tornare opzionale (issue #5453).
 *
 * Il produttore REALE dei dieci feed non e' questo repo: e'
 * `scripts/build-api.mjs` di nanakokyobashi-rgb/frontaliere-articles, che
 * importa questo modulo dall'engine mirrorato. Qui dentro l'unico chiamante e'
 * questo file. Quindi un default identita' — `repairSerpSnippet = (s) => s` —
 * lascerebbe la riparazione inerte esattamente dove serve, con questa suite
 * verde: la firma del SiteShellContract, dove la meta' mancante non lancia.
 *
 * Questo test fallisce se qualcuno "addolcisce" la firma per far passare un
 * chiamante dimenticato, che e' il modo in cui il difetto tornerebbe.
 */
describe('buildSectionFeeds — repairSerpSnippet e obbligatoria (#5453)', () => {
  it('lancia quando manca, invece di degradare in silenzio', () => {
    expect(() =>
      buildSectionFeeds({
        fs,
        path,
        rootDir: os.tmpdir(),
        section: RSS_SECTIONS[0],
        registry: [],
        layout: {},
      } as never),
    ).toThrow(/repairSerpSnippet is required/);
  });

  it('lancia anche se non e una funzione', () => {
    expect(() =>
      buildSectionFeeds({
        fs,
        path,
        rootDir: os.tmpdir(),
        section: RSS_SECTIONS[0],
        registry: [],
        layout: {},
        repairSerpSnippet: 'nope',
      } as never),
    ).toThrow(TypeError);
  });
});

/**
 * `<guid>` stabile fra i rename di slug, e escaping XML (issue #162 / #182 del
 * corpus).
 *
 * Il guid si costruiva da `item.slug` con `isPermaLink="true"`, cioe' lo stesso
 * valore di `<link>`. Rinominare uno slug — cosa che il corpus fa per togliere i
 * placeholder — cambiava anche il guid, e ogni iscritto RSS si vedeva ripresentare
 * l'articolo come nuovo senza che nulla dell'articolo fosse cambiato. `articleId`
 * e' permanente per la vita dell'articolo, quindi il guid ora deriva da quello;
 * `<link>` continua a portare lo slug corrente, perche' quello deve risolvere.
 *
 * Perche' questa suite esiste QUI e non solo sul corpus: `engine/rssFeeds.mjs`
 * e' `outOfScope` nel `loop-sync-manifest.json` del corpus proprio perche' ha un
 * canale di discesa automatico (`mirror-articles-engine.yml`), che dichiara i 25
 * file dell'engine byte-identici a `packages/articles/engine/` di questo repo.
 * La fix era stata fatta solo corpus-side: la lockstep successiva
 * (nanakokyobashi-rgb/frontaliere-articles#205) la regrediva, il test corpus la
 * ribloccava, e nessun test di QUESTO repo se ne accorgeva — il drift check
 * confronta i file uno per uno e non vede l'assenza di un test da un lato.
 * Questo blocco e' il gemello vitest di `generator/tests/rss-feed-guid.test.mjs`
 * del corpus: senza, la regressione puo' rientrare da qui e ribloccare il mirror.
 */
describe('RSS <guid> — stabile ai rename e XML-escaped (#162, #182)', () => {
  const SECTION = RSS_SECTIONS.find((s) => s.id === 'frontaliere')!;
  const SEO_FILE = path.join('services/seo', SECTION.seoFiles[0]);
  const IT_FEED = SECTION.feedFile('it');

  /**
   * Fake fs in memoria invece del fixture su disco di `makeFixture()`: qui serve
   * variare articleId e slug per chiamata, e nessun file deve sopravvivere fra
   * i due render che il test confronta.
   */
  function buildFeedXml(articleId: string, itSlug: string, description = 'Test description'): string {
    const files = new Map<string, string>([
      [
        SEO_FILE,
        `export default {
  'blog-${articleId}': {
    "headline": "Test headline",
    "description": "${description}",
    "datePublished": "2026-08-01T00:00:00.000Z",
    "articleSection": "Notizie",
  },
};
`,
      ],
      [
        SECTION.slugFile,
        `export const BLOG_SLUGS = {
 '${articleId}': { it: '${itSlug}', en: 'x', de: 'y', fr: 'z' },
};
`,
      ],
    ]);
    const fakeFs = {
      existsSync: (p: string) => files.has(p),
      readFileSync: (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
        return files.get(p)!;
      },
      readdirSync: () => [],
    };

    const { feeds } = buildSectionFeeds({
      fs: fakeFs,
      path,
      rootDir: '',
      section: SECTION,
      registry: [],
      repairSerpSnippet,
    } as never);

    return feeds.find(([filename]: [string, string]) => filename === IT_FEED)![1];
  }

  it('il guid sopravvive a un rename di slug (deriva da articleId, non dallo slug)', () => {
    const before = buildFeedXml('my-article', 'slug-before-rename');
    const after = buildFeedXml('my-article', 'slug-after-rename');

    const guidBefore = before.match(/<guid[^>]*>([^<]+)<\/guid>/)![1];
    const guidAfter = after.match(/<guid[^>]*>([^<]+)<\/guid>/)![1];
    const linkBefore = before.match(/<link>([^<]+)<\/link>/g)!.at(-1)!;
    const linkAfter = after.match(/<link>([^<]+)<\/link>/g)!.at(-1)!;

    expect(guidBefore, 'il guid non deve cambiare se cambia solo lo slug').toBe(guidAfter);
    expect(guidBefore).toMatch(/my-article/);
    expect(guidBefore, 'il guid non deve portare lo slug').not.toMatch(/slug-before-rename/);

    // `<link>`, al contrario, DEVE seguire lo slug corrente: e' l'unico dei due
    // che deve risolvere a una URL.
    expect(linkBefore).not.toBe(linkAfter);
    expect(linkBefore).toMatch(/slug-before-rename/);
    expect(linkAfter).toMatch(/slug-after-rename/);

    expect(before, 'il guid non e piu un permalink reale').toMatch(/<guid isPermaLink="false">/);
  });

  it('guid e link fanno escaping dei caratteri XML speciali (#182)', () => {
    // La regex di estrazione di parseSeoBlogs (/'blog-([^']+)':\s*\{/g) accetta
    // qualunque carattere tranne l'apostrofo, quindi un articleId o uno slug che
    // porta '&' o '<' arriva a renderFeed verbatim: non escapato, rompe l'XML
    // del feed pubblicato.
    const xml = buildFeedXml('art&id<x', 'slug&rename<x');

    const guid = xml.match(/<guid[^>]*>([^<]+)<\/guid>/)![1];
    const link = xml.match(/<link>([^<]+)<\/link>/g)!.at(-1)!;

    expect(guid).toMatch(/art&amp;id&lt;x/);
    expect(link).toMatch(/slug&amp;rename&lt;x/);
    expect(xml, 'l articleId grezzo non escapato non deve comparire nel feed').not.toMatch(
      /art&id</,
    );
  });

  it('la sequenza ]]> nel testo non chiude la CDATA in anticipo (follow-up #5586)', () => {
    // Un excerpt che contiene letteralmente `]]>` chiuderebbe la CDATA subito
    // dopo, lasciando il resto del testo come XML non-escapato nel feed.
    const xml = buildFeedXml('cdata-article', 'cdata-slug', 'Testo con ]]> dentro.');

    // Il canale ha una propria <description> non-CDATA (meta.description):
    // matcha solo quella dell'item, che e' avvolta in CDATA.
    const description = xml.match(/<description><!\[CDATA\[[\s\S]*?<\/description>/)![0];
    // La CDATA va spezzata in due sezioni adiacenti (`]]]]><![CDATA[>`) cosi'
    // che il testo letterale "]]>" sopravviva senza chiudere la sezione.
    expect(description).toBe('<description><![CDATA[Testo con ]]]]><![CDATA[> dentro.]]></description>');
  });

  // Un feed reader non ha altro che il titolo del canale per attribuire un
  // pezzo: senza <dc:creator> ogni articolo — anche quelli di un autore
  // ospite — viene sindacato come scritto dalla Redazione. E' lo stesso
  // difetto che `article:author` aveva in ogPagesPlugin.ts, sull'altra
  // superficie di metadati.
  it('emette <dc:creator> per articolo quando l\'autore e\' una Person', () => {
    const root = makeFixture();
    const [section] = buildAllRssFeeds({
      repairSerpSnippet,
      fs,
      path,
      rootDir: root,
      registries: { frontaliere: REGISTRY },
      layout: LAYOUT,
    });
    const xml = section.feeds.find(([name]) => name === 'rss-it.xml')![1];

    // Il namespace deve essere dichiarato, altrimenti il prefisso dc: e' XML
    // non valido e il parser del reader scarta l'intero feed.
    expect(xml).toContain('xmlns:dc="http://purl.org/dc/elements/1.1/"');

    const alphaItem = xml.match(/<item>[\s\S]*?<\/item>/g)!.find((i) => i.includes('Alpha it'))!;
    expect(alphaItem).toContain('<dc:creator><![CDATA[Guest Author]]></dc:creator>');
  });

  it('non ripete la Redazione in <dc:creator> quando l\'autore e\' l\'Organization', () => {
    // Il canale gia' dichiara Frontaliere Ticino: ripeterlo per item non
    // aggiunge informazione, e un dc:creator uguale al canale non distingue
    // piu' un pezzo firmato da uno redazionale.
    const root = makeFixture();
    const [section] = buildAllRssFeeds({
      repairSerpSnippet,
      fs,
      path,
      rootDir: root,
      registries: { frontaliere: REGISTRY },
      layout: LAYOUT,
    });
    const xml = section.feeds.find(([name]) => name === 'rss-it.xml')![1];

    const betaItem = xml.match(/<item>[\s\S]*?<\/item>/g)!.find((i) => i.includes('Beta it'))!;
    expect(betaItem).not.toContain('<dc:creator>');
  });
});
