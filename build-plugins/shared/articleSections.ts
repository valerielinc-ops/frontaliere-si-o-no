/**
 * Shared per-section descriptor config for the article renderer
 * (`ogPagesPlugin.ts`'s `renderArticlePages`).
 *
 * **Why this module exists (issue #4881 Fase 4, AGENTS.md #6).** The corpus
 * re-render driver (`scripts/rerender-article-corpus.mjs`) needs to enumerate
 * every article id per section to build memory-bounded render batches. The
 * only correct-by-construction source for "which seoFiles/bodyDir/registry
 * back this section" is the same descriptor `renderArticlePages` itself parses
 * against — re-deriving those paths/prefixes with a second literal copy in the
 * driver script would drift the moment `ogPagesPlugin.ts` adds/renames a
 * seoFile or bodyDir (the exact class of bug AGENTS.md #6 requires closing by
 * extraction, not by promise). Hoisting the descriptor here, imported by BOTH
 * `ogPagesPlugin.ts` (unchanged behavior — same two entries, same field
 * values) and the corpus driver script, makes that drift impossible by
 * construction.
 *
 * Zero behavior change: this is a data-literal hoist. `ogPagesPlugin.ts`'s
 * `SECTIONS` local const is replaced by a reference to `ARTICLE_SECTIONS`;
 * the two frontaliere/svizzera entries are unchanged.
 */
export interface OgSection {
 name: 'frontaliere' | 'svizzera';
 seoFiles: string[];
 canonicalPrefix: string;
 bodyDir: string;
 metaPrefix: string;
 registry: string;
 sitemap: string;
 slugData: string;
 slugConst: string;
 indexSlug: Record<'it' | 'en' | 'de' | 'fr', string>;
}

export const ARTICLE_SECTIONS: OgSection[] = [
 {
 name: 'frontaliere',
 seoFiles: ['services/seo/seo-blog.ts',
 ...Array.from({ length: 9 }, (_, i) => `services/seo/seo-blog-${i + 2}.ts`)],
 canonicalPrefix: '/articoli-frontaliere/',
 bodyDir: 'blog-body',
 metaPrefix: 'blog-meta',
 registry: 'data/blog-articles-data.ts',
 sitemap: 'public/sitemap-blog.xml',
 slugData: 'services/routerBlogData.ts',
 slugConst: 'BLOG_SLUGS',
 indexSlug: { it: 'articoli-frontaliere', en: 'cross-border-articles', de: 'grenzgaenger-artikel', fr: 'articles-frontalier' },
 },
 {
 name: 'svizzera',
 seoFiles: ['services/seo/seo-blog-ch.ts'],
 canonicalPrefix: '/articoli-svizzera/',
 bodyDir: 'blog-body-ch',
 metaPrefix: 'blog-meta-ch',
 registry: 'data/swiss-articles-data.ts',
 sitemap: 'public/sitemap-blog-ch.xml',
 slugData: 'services/routerSwissData.ts',
 slugConst: 'SWISS_SLUGS',
 indexSlug: { it: 'articoli-svizzera', en: 'swiss-articles', de: 'schweiz-artikel', fr: 'articles-suisse' },
 },
];

/**
 * Find every `'blog-<slug>': {` entry-key position in a `seoFiles` source
 * file. Shared (issue #4881 Fase 4, AGENTS.md #6) between `ogPagesPlugin.ts`'s
 * entries-building loop (the render-time, byte-identity-critical use) and the
 * corpus re-render driver's id-enumeration (a superset-safe use — see
 * `blogKeyToArticleId` below). One literal regex, not two copies that could
 * silently diverge if the `blog-` key convention ever changed.
 */
export function extractBlogEntryPositions(source: string): Array<{ key: string; start: number }> {
 const keyRx = /'(blog-[^']+)':\s*\{/g;
 const out: Array<{ key: string; start: number }> = [];
 let m: RegExpExecArray | null;
 while ((m = keyRx.exec(source)) !== null) out.push({ key: m[1], start: m.index });
 return out;
}

/** `'blog-<slug>'` -> `<slug>` (the `articleId` shape `renderArticlePages` uses everywhere: `onlyArticleId`, body filenames, write-loop filter). */
export function blogKeyToArticleId(key: string): string {
 return key.replace(/^blog-/, '');
}
