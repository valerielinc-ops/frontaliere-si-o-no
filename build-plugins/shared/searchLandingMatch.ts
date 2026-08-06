// searchLandingMatch.ts
//
// The predicate behind `/cerca-lavoro-ticino/ricerca-<query>/` (and its
// en/de/fr siblings) and the batched form jobsSeoPagesPlugin runs it in.
//
// Why this is its own module: the batched form has to be provably
// interchangeable with the per-query form, and a closure buried in a
// 13 000-line `closeBundle` cannot be asserted against. Both live here so
// `tests/seo/search-landing-match-prepass.test.ts` can hold them to the same
// output on real-shaped job records.
//
// What it costs. `searchLandingHaystack` concatenates the job's title,
// company, location AND full description (~2.8 KB average) and runs an NFD
// normalisation plus three regex passes over the result — the most expensive
// per-job primitive in the plugin. The original call site was
//
//   { it: validJobs.filter(j => matchesSearchLanding(j, name, 'it')).slice(0,20), en: …, … }
//
// evaluated once per search leader, so the haystack was rebuilt
// `leaders x 4 x |validJobs|` times. On the `it` leg of run 31065272867 that
// block cost 330 s of wall clock — 17.8 % of jobsSeoPagesPlugin, 4.5 % of the
// whole 123-minute deploy — and it was invisible in the category profiler
// because only the 17 pages it emitted were bracketed by a timer; the filter
// itself sat in untimed glue.
//
// The haystack does not depend on the query and the token list does not
// depend on the job, so neither belongs inside the other's loop.
// `collectSearchLandingMatches` walks the jobs ONCE and tests every query
// against each haystack: `4 x |validJobs|` builds instead of
// `leaders x 4 x |validJobs|`. Measured on 5 290 real crawler records x 30
// leaders x 4 locales: 38.6 s -> 1.9 s (20.8x), 634 800 haystack builds down
// to 21 160, byte-identical match sets.
//
// No haystack cache: memoising them would cost ~250 MB (20 888 jobs x 4
// locales x ~3 KB) on a heap that already peaks at 11.4 GB against a 12 GB
// cap and has OOM-killed this plugin before (run 26488854594, exit 134).
// Inverting the loops needs no cache at all.

/** Lowercase, de-accent, collapse everything non-alphanumeric to single spaces. */
export function normalizeSearchTerm(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Normalised text a search-landing query is tested against.
 * Depends ONLY on `(job, locale)` — never on the query.
 */
export function searchLandingHaystack(job: any, locale: string): string {
  return normalizeSearchTerm([
    job?.titleByLocale?.[locale],
    job?.title,
    job?.company,
    job?.location,
    job?.canton,
    job?.descriptionByLocale?.[locale],
    job?.description,
  ].filter(Boolean).join(' '));
}

/** Query side of {@link matchesSearchLanding}. Depends ONLY on the query. */
export function searchLandingTokens(query: string): string[] {
  return normalizeSearchTerm(query).split(/\s+/).filter(Boolean);
}

/**
 * Reference predicate: every token of `query` must appear in the job's
 * haystack for `locale`. This is the definition of the behaviour; the batch
 * form below must agree with it for every input.
 */
export function matchesSearchLanding(job: any, query: string, locale: string): boolean {
  const haystack = searchLandingHaystack(job, locale);
  const tokens = searchLandingTokens(query);
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

/**
 * Match sets for many queries at once, in ONE walk over `jobs`.
 *
 * Equivalent, for every query `q` and locale `l`, to
 *   `jobs.filter(j => matchesSearchLanding(j, q.name, l)).slice(0, limit)`
 * because `jobs` is visited in order and each bucket stops at `limit` —
 * which is exactly the prefix `.filter().slice(0, limit)` yields for an
 * order-preserving filter with a side-effect-free predicate.
 *
 * Once every bucket for a locale is full its haystack is no longer built at
 * all; those buckets are already at `limit`, so nothing more can enter them.
 */
export function collectSearchLandingMatches<J>(
  jobs: readonly J[],
  queries: ReadonlyArray<{ key: string; name: string }>,
  locales: readonly string[],
  limit = 20,
): { matches: Map<string, Record<string, J[]>>; haystacksBuilt: number } {
  const matches = new Map<string, Record<string, J[]>>();
  const specs = queries.map((q) => ({ key: q.key, tokens: searchLandingTokens(q.name) }));
  for (const spec of specs) {
    const perLocale: Record<string, J[]> = {};
    for (const l of locales) perLocale[l] = [];
    matches.set(spec.key, perLocale);
  }
  if (specs.length === 0) return { matches, haystacksBuilt: 0 };

  const openByLocale: Record<string, number> = {};
  for (const l of locales) openByLocale[l] = specs.length;
  let haystacksBuilt = 0;
  for (const job of jobs) {
    for (const locale of locales) {
      if (openByLocale[locale] === 0) continue;
      const haystack = searchLandingHaystack(job, locale);
      haystacksBuilt += 1;
      for (const spec of specs) {
        if (spec.tokens.length === 0) continue;
        const bucket = matches.get(spec.key)![locale];
        if (bucket.length >= limit) continue;
        let all = true;
        for (const token of spec.tokens) {
          if (!haystack.includes(token)) { all = false; break; }
        }
        if (!all) continue;
        bucket.push(job);
        if (bucket.length === limit) openByLocale[locale] -= 1;
      }
    }
  }
  return { matches, haystacksBuilt };
}
