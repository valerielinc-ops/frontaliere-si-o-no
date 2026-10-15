/**
 * Vitest stand-in for `virtual:seo-blog-shard-index`.
 *
 * The real module is produced by `build-plugins/seoBlogShardIndexPlugin.ts`, and
 * `vitest.config.ts` runs only `[react()]` — the build plugins are not loaded there,
 * so the specifier would not resolve and every test that touches `seoService` would
 * fail at import analysis.
 *
 * Deliberately EMPTY rather than a real index: an empty map sends
 * `loadBlogSeoEntry()` down the load-all fallback, so unit tests exercise the same
 * resolution semantics the code had before sharding. Tests that need the routed path
 * mock this module explicitly (see tests/seo-blog-shard-index.test.ts).
 */
const shardIndex: Record<string, number> = {};
export default shardIndex;
