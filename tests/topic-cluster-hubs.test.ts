/**
 * Article topic hubs (#5001).
 *
 * The properties asserted here are the ones the measurement that designed this
 * feature showed are NOT free:
 *
 *  - the similarity graph must not percolate into one giant component (plain
 *    connected components on this corpus put 99,5% of articles in one blob;
 *    mutual-kNN is what prevents it, and a future tweak to the edge rule could
 *    bring the blob back);
 *  - propagation must spread an existing decision and never invent one;
 *  - the URL space must be stable and every topic URL must resolve, hub or
 *    bridge — that is what makes the searchConsoleCompat self-map honest.
 */

import fs from 'node:fs';
import np from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  readArticleExcerpts,
  readArticleSlugs,
} from '../packages/articles/engine/shared/articleReaders';

import {
  TOPIC_CLUSTERS,
  TOPIC_HUB_SEGMENT,
  TOPIC_LOCALES,
} from '../packages/articles/engine/topicTaxonomy';
import {
  assignArticlesToTopics,
  buildTopicComponents,
} from '../packages/articles/engine/topicClusters';
import {
  buildTopicHubPath,
  isTopicClusterHubPath,
  resolveTopicClusterHubCanonical,
  resolveTopicClusterHubSection,
  TOPIC_HUB_CANONICAL_PATHS,
  TOPIC_HUB_LOCALES,
  TOPIC_HUB_SECTIONS,
} from '../build-plugins/topicClusterHubsData';

const SEEDS = TOPIC_CLUSTERS.map((t) => ({ key: t.key, seedText: t.seedText }));

describe('topic taxonomy', () => {
  it('has unique keys', () => {
    const keys = TOPIC_CLUSTERS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has a unique slug per locale — two topics sharing one would collide on a URL', () => {
    for (const locale of TOPIC_LOCALES) {
      const slugs = TOPIC_CLUSTERS.map((t) => t.slug[locale]);
      expect(new Set(slugs).size, `duplicate slug in ${locale}`).toBe(slugs.length);
    }
  });

  it('carries label, intro and slug in all four locales', () => {
    for (const topic of TOPIC_CLUSTERS) {
      for (const locale of TOPIC_LOCALES) {
        expect(topic.slug[locale], `${topic.key}.slug.${locale}`).toBeTruthy();
        expect(topic.label[locale], `${topic.key}.label.${locale}`).toBeTruthy();
        expect(topic.intro[locale], `${topic.key}.intro.${locale}`).toBeTruthy();
      }
    }
  });

  it('keeps the lede within the 120-char budget AGENTS.md sets for SEO landings', () => {
    for (const topic of TOPIC_CLUSTERS) {
      for (const locale of TOPIC_LOCALES) {
        expect(topic.intro[locale].length, `${topic.key}/${locale}`).toBeLessThanOrEqual(120);
      }
    }
  });

  it('uses URL-safe slugs (lowercase, no accents, no umlauts)', () => {
    for (const topic of TOPIC_CLUSTERS) {
      for (const locale of TOPIC_LOCALES) {
        expect(topic.slug[locale], `${topic.key}/${locale}`).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      }
    }
  });

  it('has a seed vocabulary for every topic', () => {
    for (const topic of TOPIC_CLUSTERS) {
      expect(topic.seedText.trim().split(/\s+/).length, topic.key).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('topic hub paths', () => {
  it('builds one canonical path per locale × section × topic', () => {
    expect(TOPIC_HUB_CANONICAL_PATHS.size).toBe(
      TOPIC_HUB_LOCALES.length * TOPIC_HUB_SECTIONS.length * TOPIC_CLUSTERS.length,
    );
  });

  it('recognises every path it emits', () => {
    for (const path of TOPIC_HUB_CANONICAL_PATHS) {
      expect(isTopicClusterHubPath(path), path).toBe(true);
    }
  });

  it('puts the localized topic segment in the path', () => {
    for (const locale of TOPIC_HUB_LOCALES) {
      const path = buildTopicHubPath(locale, 'frontaliere', TOPIC_CLUSTERS[0].key);
      expect(path).toContain(`/${TOPIC_HUB_SEGMENT[locale]}/`);
    }
  });

  it('prefixes non-Italian locales and leaves Italian bare', () => {
    expect(buildTopicHubPath('it', 'frontaliere', 'fiscalita')).toBe(
      '/articoli-frontaliere/argomenti/tasse-e-imposte/',
    );
    expect(buildTopicHubPath('de', 'svizzera', 'fiscalita')).toBe(
      '/de/schweiz-artikel/themen/steuern/',
    );
  });

  it('accepts pagination and maps it back to page 1', () => {
    const p1 = buildTopicHubPath('it', 'frontaliere', 'trasporti');
    const p7 = buildTopicHubPath('it', 'frontaliere', 'trasporti', 7);
    expect(p7).toBe('/articoli-frontaliere/argomenti/trasporti-e-traffico/page-7/');
    expect(isTopicClusterHubPath(p7)).toBe(true);
    // A page that was live when the topic was larger still resolves — to the
    // page guaranteed to exist on every build.
    expect(resolveTopicClusterHubCanonical(p7)).toBe(p1);
    expect(resolveTopicClusterHubCanonical(p1)).toBe(p1);
  });

  it('tolerates a missing trailing slash', () => {
    expect(isTopicClusterHubPath('/articoli-frontaliere/argomenti/tasse-e-imposte')).toBe(true);
  });

  it('rejects paths outside the family', () => {
    for (const path of [
      '/articoli-frontaliere/tutti/',
      '/articoli-frontaliere/argomenti/',
      '/articoli-frontaliere/argomenti/non-esiste/',
      '/de/schweiz-artikel/argomenti/steuern/', // Italian segment under /de
      '/',
      '/cerca-lavoro-ticino/',
    ]) {
      expect(isTopicClusterHubPath(path), path).toBe(false);
    }
  });

  it('resolves the owning section', () => {
    expect(resolveTopicClusterHubSection(buildTopicHubPath('fr', 'svizzera', 'pensioni'))).toBe(
      'svizzera',
    );
    expect(resolveTopicClusterHubSection(buildTopicHubPath('fr', 'frontaliere', 'pensioni'))).toBe(
      'frontaliere',
    );
    expect(resolveTopicClusterHubSection('/nope/')).toBeNull();
  });

  it('throws on an unknown topic key rather than emitting a path for it', () => {
    expect(() => buildTopicHubPath('it', 'frontaliere', 'not-a-topic')).toThrow(/unknown topic/);
  });
});

/** Two tight vocabulary islands plus one article that belongs to neither. */
const CORPUS = [
  { articleId: 'a1', title: 'Imposta alla fonte e dichiarazione dei redditi', excerpt: 'Aliquota, ristorni e franchigia per chi lavora oltre confine.' },
  { articleId: 'a2', title: 'Dichiarazione dei redditi e ristorni: guida', excerpt: 'Imposta alla fonte, aliquota e franchigia spiegate.' },
  { articleId: 'a3', title: 'Ristorni e franchigia: cosa cambia', excerpt: 'Dichiarazione dei redditi e imposta alla fonte.' },
  { articleId: 'b1', title: 'Treni TILO e abbonamento ferroviario', excerpt: 'Traffico, autostrada e code per i pendolari.' },
  { articleId: 'b2', title: 'Abbonamento treni TILO per pendolari', excerpt: 'Traffico e code in autostrada ogni giorno.' },
  { articleId: 'b3', title: 'Traffico e code in autostrada', excerpt: 'Treni TILO e abbonamento per i pendolari.' },
  { articleId: 'z1', title: 'Sagra del pesce a Morcote', excerpt: 'Musica dal vivo e bancarelle sul lungolago.' },
];

describe('topic clustering', () => {
  it('does not fuse two disjoint vocabulary islands into one component', () => {
    const comps = buildTopicComponents(CORPUS);
    const withA = comps.find((c) => c.includes('a1'))!;
    const withB = comps.find((c) => c.includes('b1'))!;
    expect(withA).not.toBe(withB);
    expect(withA).not.toContain('b1');
    expect(withB).not.toContain('a1');
  });

  it('is deterministic under input reordering', () => {
    const forward = assignArticlesToTopics(CORPUS, SEEDS);
    const reversed = assignArticlesToTopics([...CORPUS].reverse(), SEEDS);
    for (const topic of SEEDS) {
      expect(reversed.byTopic.get(topic.key)).toEqual(forward.byTopic.get(topic.key));
    }
  });

  it('routes each island to the topic its vocabulary belongs to', () => {
    const { topicOf } = assignArticlesToTopics(CORPUS, SEEDS);
    expect(topicOf.get('a1')).toBe('fiscalita');
    expect(topicOf.get('a2')).toBe('fiscalita');
    expect(topicOf.get('b1')).toBe('trasporti');
    expect(topicOf.get('b2')).toBe('trasporti');
  });

  it('leaves an article that matches nothing unassigned rather than guessing', () => {
    const { topicOf, unassignedCount } = assignArticlesToTopics(CORPUS, SEEDS);
    expect(topicOf.has('z1')).toBe(false);
    expect(unassignedCount).toBeGreaterThanOrEqual(1);
  });

  it('propagates only within a component that already carries a decision', () => {
    // `x1` shares no seed word with any topic, but sits squarely inside the
    // transport island's vocabulary — so it may only ever inherit `trasporti`.
    const corpus = [
      ...CORPUS,
      { articleId: 'x1', title: 'TILO abbonamento pendolari', excerpt: 'Code autostrada traffico treni.' },
    ];
    const { topicOf } = assignArticlesToTopics(corpus, SEEDS);
    const assigned = topicOf.get('x1');
    if (assigned !== undefined) expect(assigned).toBe('trasporti');
  });

  it('assigns every article to at most one topic', () => {
    const { byTopic, topicOf } = assignArticlesToTopics(CORPUS, SEEDS);
    const seen = new Set<string>();
    for (const members of byTopic.values()) {
      for (const id of members) {
        expect(seen.has(id), `${id} in two topics`).toBe(false);
        seen.add(id);
      }
    }
    expect(seen.size).toBe(topicOf.size);
  });

  it('returns an entry for every topic, including the empty ones', () => {
    const { byTopic } = assignArticlesToTopics(CORPUS, SEEDS);
    for (const topic of SEEDS) expect(byTopic.has(topic.key)).toBe(true);
  });

  it('keeps members sorted, so the rendered order is a function of the data alone', () => {
    const { byTopic } = assignArticlesToTopics(CORPUS, SEEDS);
    for (const members of byTopic.values()) {
      expect([...members]).toEqual([...members].sort());
    }
  });

  it('degrades to no assignment on an empty corpus instead of throwing', () => {
    const empty = assignArticlesToTopics([], SEEDS);
    expect(empty.topicOf.size).toBe(0);
    expect(empty.unassignedCount).toBe(0);
  });
});

describe('hreflang invariant: every locale renders the same article set', () => {
  const itTitles = new Map([
    ['a', 'Imposta alla fonte'],
    ['b', 'Treni TILO'],
    ['c', 'Cassa malati'],
  ]);
  const itExcerpts = new Map([
    ['a', 'aliquote'],
    ['b', 'abbonamenti'],
    ['c', 'premi'],
  ]);
  const dates = new Map([['a', '2026-01-01']]);

  it('keeps an article whose locale meta chunk has no entry for it', async () => {
    const { buildLocaleRows } = await import('../build-plugins/topicClusterHubsPlugin');
    // `de` is missing 'c' entirely — the case that would otherwise drop the
    // article from the German hub alone and split the hreflang cluster.
    const rows = buildLocaleRows({
      locale: 'de',
      itTitles,
      itExcerpts,
      localeTitles: new Map([['a', 'Quellensteuer'], ['b', 'TILO-Züge']]),
      localeExcerpts: new Map([['a', 'Sätze']]),
      urlSlugs: {},
      dates,
    });

    expect([...rows.keys()].sort()).toEqual(['a', 'b', 'c']);
    // Translated where available…
    expect(rows.get('a')!.title).toBe('Quellensteuer');
    // …and falling back to Italian rather than disappearing.
    expect(rows.get('c')!.title).toBe('Cassa malati');
    expect(rows.get('b')!.excerpt).toBe('abbonamenti');
  });

  it('produces the identical id set for all four locales', async () => {
    const { buildLocaleRows } = await import('../build-plugins/topicClusterHubsPlugin');
    const idSets = TOPIC_HUB_LOCALES.map((locale) =>
      [
        ...buildLocaleRows({
          locale,
          itTitles,
          itExcerpts,
          // Each locale is missing a different id.
          localeTitles: new Map([[locale === 'it' ? 'a' : locale === 'en' ? 'b' : 'c', 'x']]),
          localeExcerpts: new Map(),
          urlSlugs: {},
          dates,
        }).keys(),
      ].sort(),
    );
    for (const set of idSets) expect(set).toEqual(idSets[0]);
  });
});

describe('searchConsoleCompat self-map', () => {
  it('resolves every topic hub to a live target instead of leaving it 404', async () => {
    const { resolveSearchConsoleCompatTarget } = await import(
      '../build-plugins/searchConsoleCompat'
    );
    for (const path of TOPIC_HUB_CANONICAL_PATHS) {
      expect(resolveSearchConsoleCompatTarget(path), path).toEqual(
        expect.objectContaining({ canonicalPath: path }),
      );
    }
  });

  it('recovers a paginated hub URL onto the page that always exists', async () => {
    const { resolveSearchConsoleCompatTarget } = await import(
      '../build-plugins/searchConsoleCompat'
    );
    expect(
      resolveSearchConsoleCompatTarget(buildTopicHubPath('en', 'frontaliere', 'pensioni', 12)),
    ).toEqual(
      expect.objectContaining({
        canonicalPath: buildTopicHubPath('en', 'frontaliere', 'pensioni'),
      }),
    );
  });
});

/**
 * Percolation is a property of the REAL corpus, not of a hand-built fixture:
 * on seven synthetic documents every node keeps all its neighbours, so the
 * mutual-kNN filter has nothing to remove and a fixture-based assertion would
 * pass with the filter deleted. These run against the published corpus, which
 * is where the 99,5%-in-one-component measurement came from.
 */
describe('topic clustering on the published corpus', () => {
  const rootDir = np.resolve(__dirname, '..');
  const metaFile = np.join(rootDir, 'services/locales/blog-meta-it.ts');
  const available = fs.existsSync(metaFile);

  const loadCorpus = () => {
    const titles = readArticleSlugs(fs, np, rootDir, 'it');
    const excerpts = readArticleExcerpts(fs, np, rootDir, 'it');
    return titles.map(({ slug, title }) => ({
      articleId: slug,
      title,
      excerpt: excerpts.get(slug) ?? '',
    }));
  };

  it.runIf(available)(
    'keeps the largest component well under a third of the corpus',
    () => {
      const corpus = loadCorpus();
      expect(corpus.length).toBeGreaterThan(500);
      const comps = buildTopicComponents(corpus);
      const largest = comps[0].length;
      // Measured at ~7,6% with the shipped edge rule. The guard is set at 33%
      // because that is the point where the hub stops being a topic and starts
      // being a second archive — plain connected components hit 99,5% here.
      expect(largest / corpus.length).toBeLessThan(0.33);
    },
    120_000,
  );

  it.runIf(available)(
    'assigns a majority of the corpus and fills more than half the taxonomy',
    () => {
      const corpus = loadCorpus();
      const { byTopic, directCount, propagatedCount, unassignedCount } = assignArticlesToTopics(
        corpus,
        SEEDS,
      );
      const assigned = corpus.length - unassignedCount;
      expect(assigned).toBe(directCount + propagatedCount);
      // Measured 74,8% on the frontaliere corpus. A floor of 55% catches a
      // seed list that has drifted away from the corpus vocabulary without
      // failing on ordinary editorial drift.
      expect(assigned / corpus.length).toBeGreaterThan(0.55);
      // The graph must earn its place: if propagation contributes nothing, the
      // similarity half of this design is dead code.
      expect(propagatedCount).toBeGreaterThan(0);

      const aboveFloor = [...byTopic.values()].filter((m) => m.length >= 8).length;
      expect(aboveFloor).toBeGreaterThan(TOPIC_CLUSTERS.length / 2);
    },
    120_000,
  );
});
