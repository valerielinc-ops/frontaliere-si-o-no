/**
 * Topical related-articles index (issues #5003 topical authority, #5002
 * information gain).
 *
 * WHAT WAS WRONG, measured against the 3.085 published articles by replaying
 * the previous picker exactly:
 *
 *   99,48% of articles (3.069 / 3.085) received ZERO inbound internal links
 *   from any other article. Only 16 distinct articles were ever linked, and
 *   two of them were linked from all 3.084 others.
 *
 * The cause was not a bug, it was the ranking function. The picker took the 3
 * newest articles in the same `category` plus the 2 newest overall — and the
 * pool is sorted globally by date and never varies per article, so every page
 * on the site emitted almost the same five links. With four category values
 * (and `novita` holding 62% of the corpus) `category` is not a topic either.
 *
 * A site whose internal links all point at the same five URLs has no topical
 * structure to discover: link equity concentrates on a handful of pages and
 * every other article is reachable only from a paginated archive. That is the
 * concrete, measurable half of "topical authority".
 *
 * WHAT THIS DOES
 *
 * 1. Scores candidates by TOPIC — TF-IDF cosine over title + excerpt tokens —
 *    instead of by date. Deliberately no LLM and no embedding model: the
 *    corpus is ~3k short documents, this runs in well under a second, and it
 *    matches the zero-inference convention the rest of the repo's mining
 *    scripts already follow. An inverted index bounds the candidate set, so
 *    this is not the O(n²) it would be as a naive all-pairs scan.
 *
 * 2. Spreads inbound links instead of concentrating them. A pure "most
 *    similar" ranking has the same failure mode as recency, just with a
 *    different hub: the few articles that sit near the centroid of a big
 *    cluster win every slot. Each pick therefore carries a penalty that grows
 *    with how many inbound links that article has already been given.
 *
 * 3. Repairs whatever is still orphaned. After the main pass, any article with
 *    zero inbound links is appended to the related list of its best topical
 *    match that still has room. This is what turns "usually better" into a
 *    property the test can assert.
 *
 * DETERMINISM is a hard requirement, not a nicety: this runs inside the build,
 * and a picker whose output depends on iteration order would produce a
 * different set of internal links on every deploy — churn that looks to a
 * crawler like the site restructuring itself daily. Every pass below iterates
 * a sorted array and every tie breaks on `articleId`.
 */

/** One article, reduced to what the ranking needs. */
export interface RelatedArticleInput {
  articleId: string;
  /** Headline (publisher suffix already stripped by the caller, or not — both work). */
  title: string;
  /** Excerpt / meta description. */
  excerpt?: string;
  /** ISO date, used only as the final tie-break. */
  datePub?: string;
  /** Editorial category. A weak signal — a nudge, never the axis. */
  category?: string;
}

/** How many related links each article emits. Matches the previous picker. */
export const RELATED_LINKS_PER_ARTICLE = 5;

/**
 * Ceiling used when repairing orphans — an article may exceed
 * RELATED_LINKS_PER_ARTICLE by one to adopt an orphan, never more. Without a
 * ceiling the repair pass would pile every isolate onto the same few hosts and
 * recreate the concentration it exists to break.
 */
export const RELATED_LINKS_MAX_PER_ARTICLE = RELATED_LINKS_PER_ARTICLE + 1;

/**
 * Inbound count at which a candidate's score is halved. Not a hard cap: a
 * genuinely-best match should still win a slot when it is far ahead. It only
 * has to beat a near-tie by more than the penalty.
 */
const INBOUND_SOFT_CAP = 4;

/** Same-category bonus. Small on purpose — see the header on why `category` is weak. */
const SAME_CATEGORY_BONUS = 1.15;

/** Tokens shorter than this carry no topic signal in any of the four locales. */
const MIN_TOKEN_LENGTH = 4;

/**
 * Three-character tokens that ARE the topic in this corpus, exempted from the
 * length floor above.
 *
 * The floor exists to drop function words, and at four characters it also drops
 * every domain acronym — which in a corpus about cross-border taxation and
 * pensions is the most discriminating vocabulary there is. `AVS e LPP: come si
 * somma la pensione svizzera` is a real headline shape here, and without this
 * set its only surviving tokens are the generic ones, so it scores against
 * fiscal articles as readily as against pension ones.
 *
 * All four locales, because the same scheme has a different acronym in each
 * (AVS/AHV, LPP/BVG, IVA/TVA/MWST) and an article pair split across locales
 * must still recognise itself. `730` is included for the same reason it is in
 * `data/news-sitemap-whitelist.ts`: it names one specific Italian tax return
 * and nothing else.
 *
 * Deliberately an allowlist, not a lowered floor: dropping MIN_TOKEN_LENGTH to
 * 3 globally would admit the long tail of three-letter function words across
 * four languages, which STOPWORDS does not (and should not have to) enumerate.
 */
const DOMAIN_ACRONYMS = new Set([
  'avs', 'ahv', // old-age insurance, it/fr — de
  'lpp', 'bvg', // occupational pension, it/fr — de
  'iva', 'tva', // VAT, it — fr
  'cmb', 'cmi', // cassa malati frontalieri variants
  'imu', // Italian property tax
  '730', // the Italian tax return, cf. data/news-sitemap-whitelist.ts
]);

/**
 * A token appearing in more than this fraction of the corpus is treated as a
 * stopword regardless of the list below. "frontaliere" is in virtually every
 * title on this site: it identifies the domain, not the article. This is what
 * makes the list below a short hand-written seed rather than something that
 * has to be exhaustive per locale.
 */
const MAX_DOCUMENT_FREQUENCY_RATIO = 0.25;

/**
 * Floor under the ratio above, so a SMALL corpus is not degenerate. At 13
 * documents a 25% ratio drops every token appearing in 4 of them — i.e. the
 * shared topic vocabulary of a 5-article cluster, which is precisely the
 * signal. The ratio is right at corpus scale (3.085 articles → ~771) and wrong
 * below a few hundred, and `entries` is not always the whole corpus.
 */
const MIN_DOCUMENT_FREQUENCY_CEILING = 8;

/**
 * How many of an article's rarest tokens seed its candidate lookup. The rarest
 * tokens are the ones that actually discriminate; pulling candidates from the
 * common ones would drag in most of the corpus for no ranking gain.
 */
const CANDIDATE_SEED_TOKENS = 12;

/** Hard bound on candidates scored per article, so one very common seed cannot blow up. */
const MAX_CANDIDATES = 400;

/** Function words across the four locales the corpus is published in. */
const STOPWORDS = new Set([
  // it
  'come', 'quando', 'quanto', 'dove', 'perche', 'della', 'delle', 'degli', 'dello', 'sulla',
  'sulle', 'sugli', 'nella', 'nelle', 'negli', 'nello', 'questo', 'questa', 'questi', 'queste',
  'essere', 'anche', 'dopo', 'prima', 'senza', 'sono', 'stato', 'stata', 'tutti', 'tutto',
  'tutte', 'della', 'ecco', 'cosa', 'ogni', 'piu', 'meno', 'gli', 'con', 'per', 'una', 'uno',
  'che', 'non', 'del', 'dal', 'nel', 'sul', 'suo', 'sua', 'loro', 'quale', 'quali', 'guida',
  // en
  'what', 'when', 'where', 'which', 'this', 'that', 'these', 'those', 'with', 'from', 'your',
  'have', 'been', 'will', 'they', 'their', 'about', 'into', 'more', 'than', 'here', 'guide',
  // de
  'oder', 'aber', 'auch', 'nach', 'sich', 'sind', 'wird', 'werden', 'eine', 'einen', 'einem',
  'einer', 'dass', 'nicht', 'bei', 'von', 'zum', 'zur', 'den', 'der', 'das', 'die', 'und',
  // fr
  'pour', 'avec', 'dans', 'sont', 'être', 'etre', 'cette', 'votre', 'plus', 'tout', 'tous',
  'leur', 'leurs', 'mais', 'comment', 'quand', 'les', 'des', 'une', 'aux', 'est',
]);

/**
 * Fold the inflectional ending off a Romance/Germanic token.
 *
 * Without this, `fiscale` and `fiscali`, `pensione` and `pensioni`, `imposta`
 * and `imposte` are four unrelated tokens — and those pairs ARE the topic in
 * an Italian corpus about taxation and pensions. Two articles on the same
 * subject then share nothing to score on.
 *
 * Deliberately the crudest rule that works: strip ONE trailing vowel from
 * tokens long enough that the remainder is still a discriminating stem. Not a
 * real stemmer — a Porter/Snowball implementation would be a new dependency
 * inside a package whose confinement test forbids reaching outside itself, and
 * would buy precision this ranking does not need. The length floor is what
 * keeps it from collapsing short unrelated words together.
 */
function foldInflection(token: string): string {
  return token.length >= 6 && /[aeio]$/.test(token) ? token.slice(0, -1) : token;
}

/**
 * Split text into topic tokens. Accents folded so `perché`/`perche` and
 * `sanità`/`sanita` are one token — the corpus mixes both spellings — then
 * inflection folded so singular and plural of the same concept agree.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => (t.length >= MIN_TOKEN_LENGTH || DOMAIN_ACRONYMS.has(t)) && !STOPWORDS.has(t))
    .map(foldInflection);
}

/** Result: articleId → the ordered article ids it should link to. */
export type RelatedArticlesMap = Map<string, string[]>;

/**
 * Build the related-articles map for the whole corpus in one pass.
 *
 * Computed once per render run and shared by every page, not recomputed per
 * page: the inbound-fairness pass and the orphan repair are corpus-level
 * properties and cannot be decided one page at a time.
 */
export function buildRelatedArticlesIndex(articles: readonly RelatedArticleInput[]): RelatedArticlesMap {
  // Stable input order → stable output. Everything downstream depends on this.
  const docs = [...articles].sort((a, b) => a.articleId.localeCompare(b.articleId));
  const result: RelatedArticlesMap = new Map();
  if (docs.length <= 1) {
    for (const d of docs) result.set(d.articleId, []);
    return result;
  }

  // ── term vectors + inverted index ──────────────────────────────────────
  const tokensById = new Map<string, Map<string, number>>();
  const documentFrequency = new Map<string, number>();

  for (const doc of docs) {
    const counts = new Map<string, number>();
    for (const t of tokenize(`${doc.title} ${doc.excerpt ?? ''}`)) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    tokensById.set(doc.articleId, counts);
    for (const t of counts.keys()) documentFrequency.set(t, (documentFrequency.get(t) ?? 0) + 1);
  }

  const maxDf = Math.max(
    MIN_DOCUMENT_FREQUENCY_CEILING,
    Math.floor(docs.length * MAX_DOCUMENT_FREQUENCY_RATIO),
  );
  const idf = new Map<string, number>();
  for (const [t, df] of documentFrequency) {
    // Domain-ubiquitous token: identifies the site, not the article.
    if (df > maxDf) continue;
    idf.set(t, Math.log(docs.length / df));
  }

  const postings = new Map<string, string[]>();
  for (const doc of docs) {
    for (const t of tokensById.get(doc.articleId)!.keys()) {
      if (!idf.has(t)) continue;
      const list = postings.get(t);
      if (list) list.push(doc.articleId);
      else postings.set(t, [doc.articleId]);
    }
  }

  /** L2 norm of each doc's TF-IDF vector, for cosine normalisation. */
  const norm = new Map<string, number>();
  for (const doc of docs) {
    let sum = 0;
    for (const [t, tf] of tokensById.get(doc.articleId)!) {
      const w = (idf.get(t) ?? 0) * tf;
      sum += w * w;
    }
    norm.set(doc.articleId, Math.sqrt(sum) || 1);
  }

  const categoryById = new Map(docs.map((d) => [d.articleId, d.category ?? '']));
  const dateById = new Map(docs.map((d) => [d.articleId, d.datePub ?? '']));

  /** Raw topical similarity, before any fairness adjustment. */
  const similarity = (aId: string, bId: string): number => {
    const a = tokensById.get(aId)!;
    const b = tokensById.get(bId)!;
    // Iterate the smaller vector.
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let dot = 0;
    for (const [t, tf] of small) {
      const w = idf.get(t);
      if (w === undefined) continue;
      const other = large.get(t);
      if (other === undefined) continue;
      dot += w * tf * w * other;
    }
    if (dot === 0) return 0;
    let score = dot / (norm.get(aId)! * norm.get(bId)!);
    if (categoryById.get(aId) && categoryById.get(aId) === categoryById.get(bId)) {
      score *= SAME_CATEGORY_BONUS;
    }
    return score;
  };

  /** Candidates worth scoring for `doc`: articles sharing one of its rarest tokens. */
  const candidatesFor = (id: string): string[] => {
    const seeds = [...tokensById.get(id)!.keys()]
      .filter((t) => idf.has(t))
      // Rarest first — highest IDF discriminates most.
      .sort((a, b) => (idf.get(b)! - idf.get(a)!) || a.localeCompare(b))
      .slice(0, CANDIDATE_SEED_TOKENS);
    const seen = new Set<string>();
    for (const t of seeds) {
      for (const other of postings.get(t) ?? []) {
        if (other !== id) seen.add(other);
        if (seen.size >= MAX_CANDIDATES) break;
      }
      if (seen.size >= MAX_CANDIDATES) break;
    }
    return [...seen].sort();
  };

  const inbound = new Map<string, number>(docs.map((d) => [d.articleId, 0]));
  const byDateDesc = [...docs].sort(
    (a, b) => (b.datePub ?? '').localeCompare(a.datePub ?? '') || a.articleId.localeCompare(b.articleId),
  );

  // ── main pass ──────────────────────────────────────────────────────────
  for (const doc of docs) {
    const scored = candidatesFor(doc.articleId)
      .map((id) => ({ id, base: similarity(doc.articleId, id) }))
      .filter((c) => c.base > 0);

    const picks: string[] = [];
    // Greedy, re-ranked after each pick so the fairness penalty reflects the
    // links handed out so far — including the ones chosen moments ago.
    while (picks.length < RELATED_LINKS_PER_ARTICLE && scored.length > 0) {
      let bestIdx = -1;
      let bestScore = -1;
      for (let i = 0; i < scored.length; i++) {
        const c = scored[i];
        const adjusted = c.base / (1 + (inbound.get(c.id) ?? 0) / INBOUND_SOFT_CAP);
        if (
          adjusted > bestScore ||
          // Deterministic tie-break: newer first, then id.
          (adjusted === bestScore &&
            bestIdx >= 0 &&
            ((dateById.get(c.id) ?? '').localeCompare(dateById.get(scored[bestIdx].id) ?? '') > 0 ||
              c.id.localeCompare(scored[bestIdx].id) < 0))
        ) {
          bestScore = adjusted;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      const [chosen] = scored.splice(bestIdx, 1);
      picks.push(chosen.id);
      inbound.set(chosen.id, (inbound.get(chosen.id) ?? 0) + 1);
    }

    // Topic-poor article (very short title, no shared vocabulary): fall back to
    // recency rather than emitting an empty section. Still counts as inbound.
    for (const fallback of byDateDesc) {
      if (picks.length >= RELATED_LINKS_PER_ARTICLE) break;
      if (fallback.articleId === doc.articleId || picks.includes(fallback.articleId)) continue;
      picks.push(fallback.articleId);
      inbound.set(fallback.articleId, (inbound.get(fallback.articleId) ?? 0) + 1);
    }

    result.set(doc.articleId, picks);
  }

  // ── orphan repair ──────────────────────────────────────────────────────
  // Whatever the ranking left at zero inbound gets adopted by its best topical
  // match that still has room. This is the pass that makes "no article is
  // unreachable from another article" an assertable property rather than a
  // statistical tendency.
  const orphans = docs.map((d) => d.articleId).filter((id) => (inbound.get(id) ?? 0) === 0);
  for (const orphanId of orphans) {
    const hosts = candidatesFor(orphanId)
      .map((id) => ({ id, score: similarity(orphanId, id) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    let placed = false;
    for (const host of hosts) {
      const list = result.get(host.id);
      if (!list || list.length >= RELATED_LINKS_MAX_PER_ARTICLE || list.includes(orphanId)) continue;
      list.push(orphanId);
      inbound.set(orphanId, (inbound.get(orphanId) ?? 0) + 1);
      placed = true;
      break;
    }
    if (placed) continue;

    // No topical host with room. Adopt onto the newest article that has room —
    // a link from a page nobody would guess is better than no inbound link at
    // all, and this branch is reached only by true vocabulary isolates.
    for (const host of byDateDesc) {
      if (host.articleId === orphanId) continue;
      const list = result.get(host.articleId);
      if (!list || list.length >= RELATED_LINKS_MAX_PER_ARTICLE || list.includes(orphanId)) continue;
      list.push(orphanId);
      inbound.set(orphanId, (inbound.get(orphanId) ?? 0) + 1);
      break;
    }
  }

  return result;
}

/** Inbound-link count per article, for tests and for build-time reporting. */
export function inboundCounts(map: RelatedArticlesMap): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of map.keys()) counts.set(id, 0);
  for (const targets of map.values()) {
    for (const t of targets) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}
