import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildRelatedArticlesIndex,
  inboundCounts,
  tokenize,
  RELATED_LINKS_PER_ARTICLE,
  RELATED_LINKS_MAX_PER_ARTICLE,
  type RelatedArticleInput,
} from '../packages/articles/engine/relatedArticlesIndex';

/**
 * Topical authority = article→article links that describe a topic graph
 * (issues #5003 / #5002).
 *
 * The previous picker took the 3 newest same-category articles plus the 2
 * newest overall. Replayed against the 3.085 published articles: 99,48% of
 * them received ZERO inbound links from another article, and 2 articles were
 * linked from all 3.084 others. The corpus had no discoverable structure —
 * only a paginated archive and five permanently-linked pages.
 *
 * The tests below are the properties that failure violated. The synthetic
 * corpus is built from real domain vocabulary so the ranking is exercised for
 * the reason it exists, not against nonsense strings.
 */

/**
 * Deterministic pseudo-corpus: three topic clusters plus a vocabulary isolate.
 *
 * Each cluster carries its OWN shared vocabulary in the excerpts, the way real
 * articles do — an identical boilerplate suffix across every cluster would be
 * dropped as domain-ubiquitous (correctly) and leave the ranking nothing to
 * work with, which says more about the fixture than about the ranking.
 */
function buildCorpus(): RelatedArticleInput[] {
  const clusters: Record<string, { titles: string[]; vocab: string }> = {
    fisco: {
      titles: [
        'Imposta alla fonte Ticino: aliquote aggiornate',
        'Dichiarazione dei redditi: scadenze e moduli',
        'Ristorni fiscali ai comuni di confine',
        'Nuovo accordo fiscale: chi resta vecchio frontaliere',
        'Valore locativo e imposta: cosa dichiarare',
      ],
      vocab:
        'Imposta alla fonte, aliquota fiscale, dichiarazione dei redditi, imponibile, ' +
        'ritenuta fiscale e conguaglio per il residente italiano.',
    },
    previdenza: {
      titles: [
        'AVS e LPP: come si somma la pensione svizzera',
        'Riscatto del secondo pilastro prima del rientro',
        'Terzo pilastro 3a: deducibilita e limiti',
        'Pensione di vecchiaia svizzera: eta e calcolo',
      ],
      vocab:
        'Pensione svizzera, contributi previdenziali AVS, secondo pilastro LPP, ' +
        'prestazione di vecchiaia, riscatto contributivo e rendita previdenziale.',
    },
    sanita: {
      titles: [
        'LAMal o servizio sanitario nazionale: il diritto di opzione',
        'Cassa malati: premi a confronto',
        'Tassa salute: chi la paga e quanto',
      ],
      vocab:
        'Assicurazione malattia LAMal, cassa malati, premio assicurativo sanitario, ' +
        'copertura sanitaria e diritto di opzione per la salute.',
    },
  };

  const out: RelatedArticleInput[] = [];
  let day = 1;
  for (const [category, { titles, vocab }] of Object.entries(clusters)) {
    for (const title of titles) {
      out.push({
        articleId: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48),
        title,
        excerpt: `${title}. ${vocab}`,
        datePub: `2026-01-${String(day++).padStart(2, '0')}`,
        category,
      });
    }
  }
  // Shares no vocabulary with anything above — exercises the isolate path.
  out.push({
    articleId: 'zzz-isolate',
    title: 'Xilofono quadrifoglio zeppelin',
    excerpt: 'Ornitorinco kryptonite wunderbar.',
    datePub: '2026-02-01',
    category: 'novita',
  });
  return out;
}

const CORPUS = buildCorpus();
const MAP = buildRelatedArticlesIndex(CORPUS);
const INBOUND = inboundCounts(MAP);

describe('tokenizer', () => {
  it('folds accents so the corpus spelling variants collapse to one token', () => {
    expect(tokenize('sanità')).toEqual(tokenize('sanita'));
    expect(tokenize('perché')).toEqual(tokenize('perche'));
  });

  it('drops function words and sub-topical fragments', () => {
    const t = tokenize('Come funziona la pensione per il frontaliere');
    expect(t).not.toContain('come');
    expect(t).not.toContain('per');
    // Inflection-folded: `pensione` and `pensioni` must reach the same token,
    // otherwise singular and plural of the topic never match each other.
    expect(t).toContain('pension');
    expect(tokenize('le pensioni svizzere')).toContain('pension');
  });
});

describe('every article is reachable from another article (#5003)', () => {
  it('leaves NO article with zero inbound links', () => {
    const orphans = [...INBOUND.entries()].filter(([, n]) => n === 0).map(([id]) => id);
    expect(
      orphans,
      `${orphans.length}/${CORPUS.length} articles have no inbound internal link. This is the ` +
        `defect the topical index exists to fix — the recency picker it replaced left 99.48% of ` +
        `the live corpus in this state.`,
    ).toEqual([]);
  });

  it('adopts even a pure vocabulary isolate', () => {
    // The isolate shares no token with anything; it must still be linked, via
    // the recency fallback in the repair pass.
    expect(INBOUND.get('zzz-isolate')).toBeGreaterThan(0);
  });
});

describe('links describe a topic, not a publication date (#5002)', () => {
  it('links a fiscal article predominantly to other fiscal articles', () => {
    const source = CORPUS.find((a) => a.title.startsWith('Imposta alla fonte'))!;
    const picks = MAP.get(source.articleId)!;
    const categoryOf = new Map(CORPUS.map((a) => [a.articleId, a.category]));
    const sameTopic = picks.filter((id) => categoryOf.get(id) === 'fisco').length;
    expect(sameTopic).toBeGreaterThanOrEqual(2);
  });

  it('links a pension article to pension articles, not to the newest article', () => {
    const source = CORPUS.find((a) => a.title.startsWith('AVS e LPP'))!;
    const picks = MAP.get(source.articleId)!;
    const categoryOf = new Map(CORPUS.map((a) => [a.articleId, a.category]));
    expect(picks.filter((id) => categoryOf.get(id) === 'previdenza').length).toBeGreaterThanOrEqual(2);
    // The newest article in the corpus is the isolate. A recency-ranked picker
    // would have put it first on every single page; a topical one must not.
    expect(picks[0]).not.toBe('zzz-isolate');
  });
});

describe('link equity is spread, not concentrated', () => {
  it('never lets one article absorb a large share of all inbound links', () => {
    const total = [...INBOUND.values()].reduce((a, b) => a + b, 0);
    const max = Math.max(...INBOUND.values());
    // The old picker put ~3084 of ~15400 links on a single article (20%), and
    // the top two together took 40%. Anything near that is the same failure.
    expect(max / total).toBeLessThan(0.2);
  });

  it('respects the per-article link ceiling', () => {
    for (const [id, picks] of MAP) {
      expect(picks.length, `${id} emits ${picks.length} links`).toBeLessThanOrEqual(
        RELATED_LINKS_MAX_PER_ARTICLE,
      );
      expect(new Set(picks).size, `${id} emits a duplicate link`).toBe(picks.length);
      expect(picks, `${id} links to itself`).not.toContain(id);
    }
  });

  it('emits the intended number of links on a well-connected article', () => {
    const source = CORPUS.find((a) => a.title.startsWith('Imposta alla fonte'))!;
    expect(MAP.get(source.articleId)!.length).toBeGreaterThanOrEqual(RELATED_LINKS_PER_ARTICLE);
  });
});

describe('the index is deterministic', () => {
  it('produces byte-identical output across runs', () => {
    // A picker whose output depends on iteration order would rewrite every
    // article's internal links on every deploy — churn a crawler reads as the
    // site restructuring itself daily.
    const a = buildRelatedArticlesIndex(CORPUS);
    const b = buildRelatedArticlesIndex([...CORPUS].reverse());
    expect(JSON.stringify([...a].sort())).toBe(JSON.stringify([...b].sort()));
  });

  it('handles degenerate corpora without throwing', () => {
    expect([...buildRelatedArticlesIndex([])]).toEqual([]);
    const single: RelatedArticleInput[] = [{ articleId: 'only', title: 'Solo' }];
    expect(buildRelatedArticlesIndex(single).get('only')).toEqual([]);
  });
});

describe('the emitter uses the topical index', () => {
  const SOURCE = readFileSync(
    resolve(__dirname, '..', 'packages/articles/engine/ogPagesPlugin.ts'),
    'utf-8',
  );

  it('no longer ranks related articles by recency', () => {
    expect(SOURCE).toContain('buildRelatedArticlesIndex');
    // The exact expression that produced the 99.48% orphan rate.
    expect(SOURCE).not.toContain('sameCategory.slice(0, 3)');
  });

  it('builds the index once for the corpus, not once per page', () => {
    // Inside the per-page `html` closure it would see only one article and
    // could not enforce either corpus-level property.
    expect(SOURCE).toMatch(/const relatedArticlesMap = buildRelatedArticlesIndex\(/);
    const idx = SOURCE.indexOf('const relatedArticlesMap');
    const perPage = SOURCE.indexOf('const html = (locale');
    expect(idx).toBeGreaterThan(0);
    expect(idx).toBeLessThan(perPage);
  });
});
