/**
 * Shard identity + top-level key extraction for the `seo-blog*.ts` metadata files.
 *
 * PURE by design — no `node:fs`, no Vite. `services/seoService.ts` imports
 * `BLOG_SEO_SHARD_IDS` from here and ships it to the browser; the filesystem half
 * lives in `build-plugins/seoBlogShardIndexPlugin.ts`. Keep it that way: adding an
 * `fs` import here drags Node builtins into the SPA bundle.
 *
 * WHY THIS EXISTS
 * `seoService.loadBlogSeoChunk()` used to `Promise.all` all eight shards to read a
 * single `blog-<id>` record — ~956 KB transferred (measured, gzip) on every article
 * page, including `seo-blog-ch.ts` (the *svizzera* mirror) on a frontaliere article.
 * The build plugin turns these files into a `key → shard ordinal` index so the
 * runtime fetches exactly one shard.
 */

/**
 * The shards, in the order `loadBlogSeoChunk()` merges them.
 *
 * ORDER IS LOAD-BEARING. 983 keys are defined in TWO shards (verified against the
 * corpus at 2026-08-07: e.g. `blog-spese-bancarie-titoli-frontalieri` lives in both
 * `seo-blog.ts` and `seo-blog-5.ts`). The historical merge is a spread —
 * `{ ...entries1, ...entries2, … , ...entriesCh }` — so the LAST shard listed wins.
 * The index builder replays this array in the same order and lets later shards
 * overwrite earlier ones, which is what keeps single-shard resolution byte-identical
 * to the old load-everything behaviour. Reordering this array silently changes which
 * record a duplicated key resolves to.
 *
 * Adding a shard (`create-article.mjs` rolls over to `seo-blog-8.ts` etc.) means
 * appending its id here AND adding its loader to `BLOG_SEO_SHARD_LOADERS` in
 * `services/seoService.ts`. `tests/seo-blog-shard-index.test.ts` fails if either half
 * is missed, or if a `seo-blog-N.ts` exists on disk that nothing lists.
 */
export const BLOG_SEO_SHARD_IDS = [
  'blog',
  'blog-2',
  'blog-3',
  'blog-4',
  'blog-5',
  'blog-6',
  'blog-7',
  'blog-ch',
] as const;

export type BlogSeoShardId = (typeof BLOG_SEO_SHARD_IDS)[number];

/** `blog-5` → `seo-blog-5.ts`, `blog` → `seo-blog.ts`, `blog-ch` → `seo-blog-ch.ts`. */
export const blogSeoShardFileName = (id: BlogSeoShardId): string => `seo-${id}.ts`;

/** Repo-relative path of a shard's source file (a symlink into packages/articles). */
export const blogSeoShardSourcePath = (id: BlogSeoShardId): string =>
  `services/seo/${blogSeoShardFileName(id)}`;

/**
 * Extract the top-level keys of a shard's exported metadata record.
 *
 * These files are generated data: one `Record<string, SEOMetadata>` object literal
 * whose depth-1 keys are the `blog-<id>` section keys. Everything below depth 1
 * (`structuredData`, `image`, …) must be ignored — nested objects reuse ordinary
 * names like `description` and `url`, and `structuredData` also carries its own
 * nested `canonicalPath`-shaped fields.
 *
 * Hand-rolled scanner rather than a TypeScript AST parse: the eight shards total
 * ~11 MB of source and run on every build, where `ts.createSourceFile` costs seconds.
 * It tracks brace depth while stepping over strings, template literals (including
 * `${…}` interpolations, which contain real braces — `url: \`${BASE_URL}/x.webp\``)
 * and comments, so no quoted `{` can shift the depth.
 *
 * A miss here is a PERFORMANCE bug, never a correctness one: an absent or wrong
 * mapping makes `loadBlogSeoEntry()` fall back to loading every shard, i.e. exactly
 * the behaviour this replaces.
 */
export function extractTopLevelSeoKeys(src: string): string[] {
  const keys: string[] = [];
  const n = src.length;

  // Anchor on the record declaration rather than the first `= {` in the file, so a
  // future `const BASE_URL = {…}`-style preamble can't capture the scan.
  const decl = /:\s*Record<string,\s*SEOMetadata>\s*=\s*\{/.exec(src);
  let i = decl ? decl.index + decl[0].length - 1 : src.indexOf('= {') + 2;
  if (i < 1) return keys;

  let depth = 0;
  let started = false;

  const skipTemplate = (pos: number): number => {
    // pos points at the opening backtick.
    let p = pos + 1;
    while (p < n) {
      const c = src[p];
      if (c === '\\') { p += 2; continue; }
      if (c === '`') return p;
      if (c === '$' && src[p + 1] === '{') {
        // Step over the interpolation, honouring nested braces and strings.
        let braces = 1;
        p += 2;
        while (p < n && braces > 0) {
          const d = src[p];
          if (d === '\\') { p += 2; continue; }
          if (d === '{') braces++;
          else if (d === '}') braces--;
          else if (d === '"' || d === "'") { p = skipQuoted(p, d); }
          else if (d === '`') { p = skipTemplate(p); }
          p++;
        }
        continue;
      }
      p++;
    }
    return p;
  };

  const skipQuoted = (pos: number, quote: string): number => {
    let p = pos + 1;
    while (p < n) {
      if (src[p] === '\\') { p += 2; continue; }
      if (src[p] === quote) return p;
      p++;
    }
    return p;
  };

  for (; i < n; i++) {
    const c = src[i];

    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '`') { i = skipTemplate(i); continue; }

    if (c === '"' || c === "'") {
      const start = i + 1;
      i = skipQuoted(i, c);
      if (depth === 1) {
        // A depth-1 string immediately followed by `:` is an entry key.
        let j = i + 1;
        while (j < n && /\s/.test(src[j])) j++;
        if (src[j] === ':') keys.push(src.slice(start, i));
      }
      continue;
    }

    if (c === '{' || c === '[') { depth++; started = true; continue; }
    if (c === '}' || c === ']') {
      depth--;
      if (started && depth === 0) break;
      continue;
    }
  }

  return keys;
}

/**
 * Fold per-shard key lists into the `key → shard ordinal` map the runtime consumes.
 * Iterates `BLOG_SEO_SHARD_IDS` order so later shards overwrite earlier ones — the
 * same precedence as the spread merge it replaces (see the note on the ids array).
 */
export function buildBlogSeoShardIndex(
  keysByShard: ReadonlyMap<BlogSeoShardId, readonly string[]>,
): Record<string, number> {
  const index: Record<string, number> = {};
  BLOG_SEO_SHARD_IDS.forEach((id, ordinal) => {
    for (const key of keysByShard.get(id) ?? []) index[key] = ordinal;
  });
  return index;
}
