/**
 * Entry-level preservation across a corpus pull (issue #5289, third act).
 *
 * THE INCIDENT THIS REPLAYS
 * ────────────────────────
 * `pull-articles-corpus.mjs` was taught not to DELETE, which saved a
 * site-published article's per-article files — `blog-body/it/<id>.ts` exists
 * only downstream, so nothing removed it. The articles still vanished.
 *
 * Because an article is not only files. It is also ENTRIES inside files nanako
 * owns as well: the slug registries, the id union, the four i18n locales, the
 * SEO chunks, the article registries. Those exist on both sides, so the mirror
 * copied upstream's version over ours and the entries went with it. Not deleted
 * as files — overwritten as lines. On 2026-08-07 three articles answering HTTP
 * 200 lost their slugs, i18n and SEO exactly this way, twice, and were restored
 * by hand both times.
 *
 * So the fixtures below are shaped like the real surfaces, and the headline
 * test is the incident end to end: a local tree carrying three articles, an
 * upstream copy that has never heard of them, and the requirement that all
 * three come out complete on every surface.
 *
 * The `missing` assertions matter as much as the restoring ones. A surface this
 * cannot merge has to be reported, because a silent half-restore reproduces the
 * incident with nobody watching — which is the one outcome worse than a crash.
 */
import { describe, expect, it } from 'vitest';
import { localOnlyIds, mergeEntries, parseSlugIds } from '../scripts/lib/corpus-entry-merge.mjs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL_ONLY = ['caldo-torrido-lavoro-ticino', 'rimborsi-730-sostituti-imposta', 'lavoro-forzato-catene-svizzere'];

// ── Fixtures, shaped like the real generated files ──────────────────────────

const blogRegistry = (withLocal: boolean) => `import type { ArticleLocale } from '../engine/siteShell';
export const BLOG_SLUGS: Record<string, Record<ArticleLocale, string>> = {
 'stipendio-netto-2026': { it: 'stipendio-netto-frontaliere-2026', en: 'cross-border-net-salary-2026', de: 'nettolohn-grenzgaenger-2026', fr: 'salaire-net-frontalier-2026' },
 'claudio-simonetti-monsieur-peur': { it: 'claudio-simonetti-monsieur-peur', en: 'claudio-simonetti-monsieur-peur', de: 'claudio-simonetti-monsieur-peur', fr: 'claudio-simonetti-monsieur-peur' },${withLocal ? `
 'caldo-torrido-lavoro-ticino': { it: 'caldo-torrido-lavoro-ticino', en: 'hot-weather-work-ticino', de: 'heisses-wetter-arbeit-tessin', fr: 'chaleur-torrida-travail-tessin' },` : ''}
};

export const ALL_BLOG_ARTICLE_IDS: BlogArticleId[] = ['stipendio-netto-2026', 'claudio-simonetti-monsieur-peur'${withLocal ? `, 'caldo-torrido-lavoro-ticino'` : ''}];
`;

const swissRegistry = (withLocal: boolean) => `import type { ArticleLocale } from '../engine/siteShell';
export const SWISS_SLUGS: Record<string, Record<ArticleLocale, string>> = {
  'costo-vita-svizzera-2026': {
    it: 'costo-vita-svizzera-2026',
    en: 'cost-of-living-switzerland-2026',
    de: 'lebenshaltungskosten-schweiz-2026',
    fr: 'cout-vie-suisse-2026',
  },${withLocal ? `
 'rimborsi-730-sostituti-imposta': { it: 'rimborsi-730-sostituti-imposta', en: '730-refunds-substitute-tax', de: '730-erstattungen-ersatzsteuer', fr: 'remboursements-730-impot-substitutif' },
 'lavoro-forzato-catene-svizzere': { it: 'lavoro-forzato-catene-svizzere', en: 'forced-labour-swiss-supply-chains', de: 'zwangsarbeit-schweizer-lieferketten', fr: 'travail-force-chaines-approvisionnement-suisse' },` : ''}
};
`;

const idUnion = (withLocal: boolean) =>
  `type _BlogId5 = 'stipendio-netto-2026' | 'claudio-simonetti-monsieur-peur'${withLocal ? ` | 'caldo-torrido-lavoro-ticino'` : ''};\n`;

const metaIt = (withLocal: boolean) => `export const blogMetaIt = {
  it: {
    'blog.article.stipendio-netto-2026.title': 'Stipendio netto 2026',
    'blog.article.stipendio-netto-2026.excerpt': 'Quanto resta in tasca.',${withLocal ? `
    'blog.article.caldo-torrido-lavoro-ticino.title': 'Lavoro nel caldo torrido in Ticino',
    'blog.article.caldo-torrido-lavoro-ticino.excerpt': 'Sindacati e Consiglio di Stato.',
    'blog.article.caldo-torrido-lavoro-ticino.imageAlt': 'Lavoratori edili in pausa.',` : ''}
    'blog.article.claudio-simonetti-monsieur-peur.title': 'Claudio Simonetti',
  },
};
`;

/**
 * Shaped like the real seo-blog-ch.ts, nested `structuredData` and all — an
 * entry whose body is four flat lines cannot reproduce either of the two bugs
 * this fixture exists to catch: the key line `'blog-<id>': {` is preceded by a
 * HYPHEN (so a word-boundary scan skips it), and the entry contains inner `}`
 * lines plus template literals and braces inside strings (so brace counting
 * loses the close). Both defects produced valid syntax with the entry nested
 * inside its neighbour.
 */
const seoEntry = (key: string, slug: string, title: string) => `  'blog-${key}': {
    title: '${title}',
    canonicalPath: '/articoli-svizzera/${slug}/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "${title}",
      "image": {
        "@type": "ImageObject",
        "creator": { "@type": "Organization", "name": "Frontaliere Ticino" },
        "url": \\\`\${BASE_URL}/images/blog/${slug}.webp\\\`,
      },
      "mainEntityOfPage": \\\`\${BASE_URL}/articoli-svizzera/${slug}/\\\`,
    },
  },`;

const seoChunk = (withLocal: boolean) => `import type { SEOMetadata } from './seoMetadataType';
const BASE_URL = 'https://frontaliereticino.ch';
export const seoBlogCh: Record<string, SEOMetadata> = {
${seoEntry('costo-vita-svizzera-2026', 'costo-vita-svizzera-2026', 'Costo della vita')}
${withLocal ? `${seoEntry('rimborsi-730-sostituti-imposta', 'rimborsi-730-sostituti-imposta', 'Rimborsi 730')}

${seoEntry('lavoro-forzato-catene-svizzere', 'lavoro-forzato-catene-svizzere', 'Vero o falso')}
` : ''}};
`;

/**
 * Top-level keys of the exported map, by structure rather than by search: an
 * entry counts only if it opens at indent 2 AND the previous entry closed
 * before it. This is the assertion that separates "restored" from "nested
 * inside the neighbour", which every syntax check passes.
 */
function topLevelSeoKeys(text: string): string[] {
  const lines = text.split('\n');
  const keys: string[] = [];
  let depth = 0;
  for (const line of lines) {
    const m = /^ {2}'([^']+)': \{$/.exec(line);
    if (m && depth === 0) keys.push(m[1]);
    if (m) { depth++; continue; }
    if (line === '  },' || line === '  }') depth = Math.max(0, depth - 1);
  }
  return keys;
}

const articleRegistry = (withLocal: boolean) => `export const SWISS_ARTICLES = [
  {
    id: 'costo-vita-svizzera-2026',
    category: 'economia',
    date: '2026-06-02T00:00:00.000Z',
  },${withLocal ? `
  {
    id: 'rimborsi-730-sostituti-imposta',
    category: 'fiscale',
    date: '2026-08-07T04:42:27.683Z',
  },` : ''}
];
`;

/** Every mixed-ownership surface, as {local, upstream} pairs. */
const SURFACES = [
  { name: 'routerBlogData.ts', build: blogRegistry, ids: ['caldo-torrido-lavoro-ticino'] },
  { name: 'routerSwissData.ts', build: swissRegistry, ids: ['rimborsi-730-sostituti-imposta', 'lavoro-forzato-catene-svizzere'] },
  { name: 'blogArticleIds.ts', build: idUnion, ids: ['caldo-torrido-lavoro-ticino'] },
  { name: 'blog-meta-it.ts', build: metaIt, ids: ['caldo-torrido-lavoro-ticino'] },
  { name: 'seo-blog-ch.ts', build: seoChunk, ids: ['rimborsi-730-sostituti-imposta', 'lavoro-forzato-catene-svizzere'] },
  { name: 'swiss-articles-data.ts', build: articleRegistry, ids: ['rimborsi-730-sostituti-imposta'] },
];

describe('corpus entry merge — the #5289 overwrite, surface by surface', () => {
  it('identifies exactly the ids the site has and the corpus does not', () => {
    const ids = localOnlyIds({
      localSources: [blogRegistry(true), swissRegistry(true)],
      upstreamSources: [blogRegistry(false), swissRegistry(false)],
    });

    expect([...ids].sort()).toEqual([...LOCAL_ONLY].sort());
  });

  it.each(SURFACES)('restores $name after upstream overwrites it', ({ build, ids }) => {
    const { text, preserved, missing } = mergeEntries(build(false), build(true), ids);

    expect(missing).toEqual([]);
    expect(preserved.sort()).toEqual([...ids].sort());
    for (const id of ids) expect(text).toContain(id);
  });

  it('restores an SEO entry as a SIBLING, not nested inside its neighbour', () => {
    // The bug this pins shipped once and survived every check: the entry landed
    // after a unique line that happened to sit inside the PREVIOUS entry's
    // structuredData, so it parsed cleanly and `seoBlogCh['blog-<id>']` was
    // undefined at runtime. Presence of the id proves nothing — placement does.
    const before = topLevelSeoKeys(seoChunk(false));
    const { text, missing } = mergeEntries(seoChunk(false), seoChunk(true), [
      'rimborsi-730-sostituti-imposta',
      'lavoro-forzato-catene-svizzere',
    ]);

    expect(missing).toEqual([]);
    expect(before).toEqual(['blog-costo-vita-svizzera-2026']);
    expect(topLevelSeoKeys(text)).toEqual([
      'blog-costo-vita-svizzera-2026',
      'blog-rimborsi-730-sostituti-imposta',
      'blog-lavoro-forzato-catene-svizzere',
    ]);
  });

  it('restores every mention of an entry, not just the ones a token scan sees', () => {
    // 4 mentions per SEO entry: the `'blog-<id>':` key (preceded by a hyphen,
    // which a word-boundary scan skips), canonicalPath, the image URL and
    // mainEntityOfPage. Restoring 3 of 4 was the shape of the corruption.
    const id = 'rimborsi-730-sostituti-imposta';
    const count = (s: string) => (s.match(new RegExp(id, 'g')) ?? []).length;
    const { text } = mergeEntries(seoChunk(false), seoChunk(true), [id]);

    expect(count(text)).toBe(count(seoChunk(true)));
  });

  it('leaves upstream content intact while restoring — nothing is traded away', () => {
    const { text } = mergeEntries(blogRegistry(false), blogRegistry(true), ['caldo-torrido-lavoro-ticino']);

    // The article that only upstream had must survive the splice untouched.
    expect(text).toContain("'claudio-simonetti-monsieur-peur': { it: 'claudio-simonetti-monsieur-peur'");
    expect(text).toContain("'stipendio-netto-2026'");
    // And the restored id joins the membership list rather than replacing it.
    const list = text.split('\n').find((l) => l.startsWith('export const ALL_BLOG_ARTICLE_IDS'))!;
    expect(list).toContain("'claudio-simonetti-monsieur-peur'");
    expect(list).toContain("'caldo-torrido-lavoro-ticino'");
  });
});

describe('corpus entry merge — the direction of the data is not negotiable', () => {
  it('lets UPSTREAM win when both sides carry the id, and says so', () => {
    // The article finally made it up to nanako. Upstream's copy is now the
    // real one: ours must not shadow it, or this becomes a back channel and
    // an edit made upstream would be silently reverted on every sync.
    const upstream = blogRegistry(true).replace('hot-weather-work-ticino', 'heatwave-work-ticino-v2');

    const { text, preserved, upstreamWins } = mergeEntries(upstream, blogRegistry(true), ['caldo-torrido-lavoro-ticino']);

    expect(upstreamWins).toEqual(['caldo-torrido-lavoro-ticino']);
    expect(preserved).toEqual([]);
    expect(text).toContain('heatwave-work-ticino-v2');
    expect(text).not.toContain('hot-weather-work-ticino');
  });

  it('is a no-op when the id is not in the local file either', () => {
    const { text, preserved, missing } = mergeEntries(blogRegistry(false), blogRegistry(false), ['never-existed']);

    expect(preserved).toEqual([]);
    expect(missing).toEqual([]);
    expect(text).toBe(blogRegistry(false));
  });
});

describe('corpus entry merge — reports what it cannot do', () => {
  it('reports an unrecognised shape as missing instead of dropping it quietly', () => {
    // An entry with no usable anchor: the local file shares no unique line with
    // upstream, so there is nowhere to say "put it back here". The contract is
    // that this surfaces, because the caller exits non-zero on it.
    const local = "export const X = {\n  'ghost-article': { shape: 'unknown' },\n};\n";
    const upstream = 'totally different file\n';

    const { preserved, missing } = mergeEntries(upstream, local, ['ghost-article']);

    expect(preserved).toEqual([]);
    expect(missing).toEqual(['ghost-article']);
  });

  it('parseSlugIds reads both single-line and multi-line registry formatting', () => {
    expect(parseSlugIds(blogRegistry(true)).has('caldo-torrido-lavoro-ticino')).toBe(true);
    // routerSwissData.ts formats its first entry across five lines.
    expect(parseSlugIds(swissRegistry(true)).has('costo-vita-svizzera-2026')).toBe(true);
    expect(parseSlugIds(swissRegistry(true)).has('rimborsi-730-sostituti-imposta')).toBe(true);
  });
});

describe('corpus entry merge — the whole incident, end to end', () => {
  it('a pull that brings an upstream without the three articles leaves all three complete', () => {
    // Local tree: every surface carries the three site-published articles.
    // Upstream: has never heard of them. This is 2026-08-07 exactly.
    const ids = [...localOnlyIds({
      localSources: [blogRegistry(true), swissRegistry(true)],
      upstreamSources: [blogRegistry(false), swissRegistry(false)],
    })];

    const results = SURFACES.map(({ name, build }) => {
      const local = build(true);
      const mentioned = ids.filter((id) => local.includes(id)); // what the caller snapshots
      return { name, mentioned, ...mergeEntries(build(false), local, mentioned) };
    });

    // Nothing unmergeable anywhere — this is the assertion that would have
    // caught the incident before it shipped.
    expect(results.flatMap((r) => r.missing)).toEqual([]);

    // Every article is complete on every surface that carried it.
    for (const r of results) {
      for (const id of r.mentioned) {
        expect(r.text, `${r.name} lost ${id}`).toContain(id);
      }
    }

    // And all three are accounted for across the tree, not just one or two.
    const restored = new Set(results.flatMap((r) => r.preserved));
    expect([...restored].sort()).toEqual([...LOCAL_ONLY].sort());
  });
});

describe('il pull cabla davvero la preservazione delle voci', () => {
  // Il modulo puro sopra e' testato a fondo, ma la sua UTILITA' dipende dal
  // fatto che `pull-articles-corpus.mjs` lo chiami attorno a `mirrorTree`.
  // Dopo il merge con main — che ha portato la propria guardia sulle rimozioni
  // (`corpus-removal-guard.mjs`) — questo cablaggio e' l'unico pezzo che resta
  // solo nostro, e un rebase distratto lo perderebbe senza rompere nulla:
  // il sync tornerebbe verde e le voci solo-locali sparirebbero in silenzio.
  const src = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts/pull-articles-corpus.mjs'),
    'utf-8',
  );

  it('legge le voci solo-locali PRIMA del mirror e le rimette DOPO', () => {
    const iSnapshot = src.indexOf('localOnlyIds({');
    const iMirror = src.indexOf('mirrorTree(src, DEST');
    const iMerge = src.indexOf('mergeEntries(');
    expect(iSnapshot).toBeGreaterThan(-1);
    expect(iMirror).toBeGreaterThan(iSnapshot);
    expect(iMerge).toBeGreaterThan(iMirror);
  });

  it('rifiuta invece di degradare quando una superficie non e\' ricomponibile', () => {
    // Un ripristino parziale sembra un successo e si scopre giorni dopo da un
    // 404 o da un gate rosso sulla PR di qualcun altro.
    expect(src).toContain('const unmerged = []');
    expect(src).toContain('could not preserve these local-only entries — refusing');
  });

  it('convive con la guardia sulle rimozioni arrivata da main', () => {
    expect(src).toContain('corpus-removal-guard.mjs');
    expect(src).toContain('corpus-entry-merge.mjs');
  });
});
