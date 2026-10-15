/**
 * Topic-cluster assignment: which articles belong to which editorial topic
 * hub (issue #5001, "cluster tematici").
 *
 * WHY THE OBVIOUS DESIGN DOESN'T WORK
 * ───────────────────────────────────
 * The brief was "derive the clusters from the similarity graph built in
 * #5107 (connected components), not from the 4-value `category` enum". Both
 * halves of that were measured against the real 3.098-article corpus before
 * any of this was written, and the measurement moved the design:
 *
 * 1. Connected components on a thresholded similarity graph PERCOLATE. There
 *    is no threshold that yields usable clusters — at 0.10 the largest
 *    component holds 99,5% of the corpus (one blob); push the threshold up
 *    until the blob breaks (0.30) and only 702 of 3.098 articles are left in
 *    any component of 8+, with 1.520 singletons. The fix is not a better
 *    threshold, it is a better edge rule: keeping an edge only when it is in
 *    the top-K of BOTH endpoints (mutual k-NN) removes the bridging edges
 *    that fuse unrelated clusters. At k=4 / 0.20 the largest component drops
 *    to 7,6% and 55 components of 8+ cover 1.365 articles. That is why
 *    {@link TOPIC_MUTUAL_K} exists.
 *
 * 2. A component cannot NAME itself. Labelling each component by its
 *    dominant TF-IDF token produced, on this corpus: stems rather than words
 *    (`arrestat`, `stranier`, `impost`, `dignitos` — `foldInflection` strips
 *    the trailing vowel), a 224-article cluster named `2026`, and — fatally
 *    for a 4-locale site — a DIFFERENT concept per locale for the same set of
 *    articles (one cluster labelled `dignitos` / `cisl` / `wurdig` /
 *    `travail`). hreflang would then declare four pages equivalent while each
 *    named a different subject.
 *
 * So the naming comes from a curated taxonomy (`./topicTaxonomy.ts`) — stable
 * slugs, real words, translated once by hand — and the MEMBERSHIP comes from
 * the corpus, in two passes:
 *
 *   pass 1 (direct)      score every article against every topic's seed
 *                        vocabulary with the same TF-IDF cosine the related-
 *                        links ranking uses; assign the argmax above a floor.
 *   pass 2 (propagation) the mutual-kNN components carry the assignment to
 *                        articles whose own wording matched no seed. This is
 *                        where the similarity graph does the work the seed
 *                        list cannot: an article titled «Bilaterali III, ora
 *                        la palla passa al Parlamento» reaches
 *                        `accordi-politica` through its neighbours even when
 *                        it shares no seed token with the topic.
 *
 * Measured on the published corpus: 1.592 direct + 724 propagated = 2.316 of
 * 3.098 (74,8%) for the frontaliere section, 536 of 629 (85,2%) for svizzera,
 * with all 14 topics above the 8-article floor in both.
 *
 * MEMBERSHIP IS COMPUTED ONCE, ON ONE LOCALE, BY DESIGN. Running the
 * assignment per locale gives different sets per locale (`fiscalita`: 221 on
 * it, 151 on de — German compounds like `Grenzgängerbewilligung` don't split
 * into the seed vocabulary), and the four locale variants of a hub are
 * hreflang siblings, so they MUST hold the same articles. The caller passes
 * the canonical-locale corpus; every locale renders that same membership with
 * its own titles.
 *
 * DETERMINISM is a hard requirement, as it is for the related-links index
 * this shares its model with: the output is part of the build, and a hub
 * whose composition depends on iteration order would reshuffle its internal
 * links on every deploy. Every pass below iterates a sorted array and every
 * tie breaks on a stable key.
 */

import {
  buildCorpusModel,
  tokenize,
  type CorpusModel,
  type RelatedArticleInput,
} from './relatedArticlesIndex';

/**
 * Minimum raw cosine for an edge to exist at all. Below this the pair shares
 * only incidental vocabulary. See the header for why this alone is not enough.
 */
export const TOPIC_EDGE_THRESHOLD = 0.2;

/**
 * An edge survives only if it is among each endpoint's K strongest. This is
 * the anti-percolation rule: a hub-ish article that is weakly similar to
 * hundreds of others keeps only its K best links, so it can no longer fuse
 * every cluster it touches into one component.
 */
export const TOPIC_MUTUAL_K = 4;

/**
 * Minimum article↔topic cosine for a DIRECT assignment. Deliberately low: the
 * seed vocabulary is a handful of words against an article's full title +
 * excerpt, so even an on-topic article scores modestly. Precision is
 * recovered by taking the argmax over topics rather than by a high floor —
 * what matters is which topic fits best, not the absolute number.
 */
export const TOPIC_DIRECT_FLOOR = 0.05;

/** A topic as this module needs it: an identity plus the words that define it. */
export interface TopicSeedInput {
  /** Stable topic key. Also the tie-break for equal propagation votes. */
  readonly key: string;
  /**
   * Natural-language seed vocabulary in the corpus's own locale. Passed
   * through the same tokenizer as the corpus, so callers write real words
   * (`imposte`, `dichiarazione`) and inflection folding is handled for them.
   */
  readonly seedText: string;
}

export interface TopicAssignment {
  /** topicKey → member article ids, sorted. Every input topic key is present. */
  readonly byTopic: ReadonlyMap<string, readonly string[]>;
  /** articleId → topicKey, for the articles that got one. */
  readonly topicOf: ReadonlyMap<string, string>;
  /** How many articles matched a topic's seeds directly. */
  readonly directCount: number;
  /** How many were carried in by their similarity-graph component. */
  readonly propagatedCount: number;
  /** How many matched nothing and belong to no hub. */
  readonly unassignedCount: number;
}

/**
 * Mutual-kNN connected components over the corpus model.
 *
 * Exported because the component structure is worth asserting on directly in
 * tests (percolation is a property of the corpus, not of this code, and a
 * corpus change can bring it back).
 */
export function buildTopicComponents(
  articles: readonly RelatedArticleInput[],
  opts: { threshold?: number; mutualK?: number; model?: CorpusModel } = {},
): string[][] {
  const threshold = opts.threshold ?? TOPIC_EDGE_THRESHOLD;
  const mutualK = opts.mutualK ?? TOPIC_MUTUAL_K;
  // `model` is an optimisation, not a variant: building it is the expensive
  // part, and `assignArticlesToTopics` already has one for the same corpus.
  // Without this the model is rebuilt twice per call — four times per build
  // across the two article sections.
  const model = opts.model ?? buildCorpusModel(articles);
  const ids = model.docs.map((d) => d.articleId);

  // Each unordered pair scored once (`id < other` skips the mirror).
  const edges: Array<{ a: string; b: string; s: number }> = [];
  for (const id of ids) {
    for (const other of model.candidatesFor(id)) {
      if (id >= other) continue;
      const s = model.cosine(id, other);
      if (s >= threshold) edges.push({ a: id, b: other, s });
    }
  }

  const neighbours = new Map<string, Array<{ id: string; s: number }>>();
  const push = (from: string, to: string, s: number): void => {
    const list = neighbours.get(from);
    if (list) list.push({ id: to, s });
    else neighbours.set(from, [{ id: to, s }]);
  };
  for (const e of edges) {
    push(e.a, e.b, e.s);
    push(e.b, e.a, e.s);
  }
  const strongest = new Map<string, Set<string>>();
  for (const [node, list] of neighbours) {
    strongest.set(
      node,
      new Set(
        list
          .sort((x, y) => y.s - x.s || x.id.localeCompare(y.id))
          .slice(0, mutualK)
          .map((x) => x.id),
      ),
    );
  }

  // Union-find over the surviving (mutual) edges.
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x: string): string => {
    let cur = x;
    while (parent.get(cur) !== cur) {
      parent.set(cur, parent.get(parent.get(cur)!)!);
      cur = parent.get(cur)!;
    }
    return cur;
  };
  for (const e of edges) {
    if (!strongest.get(e.a)?.has(e.b) || !strongest.get(e.b)?.has(e.a)) continue;
    const ra = find(e.a);
    const rb = find(e.b);
    // Smaller id always becomes the root, so the root is a stable function of
    // the member set rather than of the edge iteration order.
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }

  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    const g = groups.get(root);
    if (g) g.push(id);
    else groups.set(root, [id]);
  }
  return [...groups.values()]
    .map((g) => g.sort())
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

/**
 * Assign each article to at most one topic. See the module header for the
 * two-pass design and the measured coverage.
 */
export function assignArticlesToTopics(
  articles: readonly RelatedArticleInput[],
  topics: readonly TopicSeedInput[],
  opts: { threshold?: number; mutualK?: number; directFloor?: number } = {},
): TopicAssignment {
  const directFloor = opts.directFloor ?? TOPIC_DIRECT_FLOOR;
  const model = buildCorpusModel(articles);
  const ids = model.docs.map((d) => d.articleId);

  const byTopic = new Map<string, string[]>();
  for (const t of topics) byTopic.set(t.key, []);
  const topicOf = new Map<string, string>();
  if (ids.length === 0 || topics.length === 0) {
    return { byTopic, topicOf, directCount: 0, propagatedCount: 0, unassignedCount: ids.length };
  }

  // ── pass 1: direct seed match ──────────────────────────────────────────
  // Topic order is fixed by the caller's array, and ties fall to the earlier
  // topic (strict `>`), so a corpus-independent tie resolves identically on
  // every build.
  const bags = topics.map((t) => {
    const bag = new Map<string, number>();
    for (const tok of tokenize(t.seedText)) bag.set(tok, (bag.get(tok) ?? 0) + 1);
    return { key: t.key, bag, norm: model.normOfTokens(bag) };
  });

  /** Direct-match strength, kept as the weight of this article's later vote. */
  const strength = new Map<string, number>();
  let directCount = 0;
  for (const id of ids) {
    let bestKey = '';
    let bestScore = 0;
    for (const t of bags) {
      const s = model.cosineWithBag(id, t.bag, t.norm);
      if (s > bestScore) {
        bestScore = s;
        bestKey = t.key;
      }
    }
    if (bestKey && bestScore >= directFloor) {
      topicOf.set(id, bestKey);
      strength.set(id, bestScore);
      directCount++;
    }
  }

  // ── pass 2: propagate through the similarity components ────────────────
  // A component votes for the topic its already-assigned members carry, each
  // vote weighted by how strongly that member matched. Unassigned members
  // then inherit the winner. Components with no assigned member stay
  // unassigned: propagation spreads a decision, it never invents one.
  let propagatedCount = 0;
  for (const members of buildTopicComponents(articles, { ...opts, model })) {
    if (members.length < 2) continue;
    const votes = new Map<string, number>();
    for (const m of members) {
      const key = topicOf.get(m);
      if (!key) continue;
      votes.set(key, (votes.get(key) ?? 0) + (strength.get(m) ?? 0));
    }
    if (votes.size === 0) continue;
    const winner = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    for (const m of members) {
      if (topicOf.has(m)) continue;
      topicOf.set(m, winner);
      propagatedCount++;
    }
  }

  for (const id of ids) {
    const key = topicOf.get(id);
    if (key) byTopic.get(key)!.push(id);
  }
  for (const list of byTopic.values()) list.sort();

  return {
    byTopic,
    topicOf,
    directCount,
    propagatedCount,
    unassignedCount: ids.length - topicOf.size,
  };
}
