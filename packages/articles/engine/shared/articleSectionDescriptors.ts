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
 * `SECTIONS` local const is replaced by a reference to `ARTICLE_SECTION_DESCRIPTORS`;
 * the two frontaliere/svizzera entries are unchanged.
 *
 * **Naming note.** Deliberately named `articleSectionDescriptors`, not
 * `articleSections`, despite the obvious short name — `services/articleSections.ts`
 * already exists and calls itself the section "single source truth" for a
 * DIFFERENT, differently-shaped per-section config (`ArticleSectionConfig`:
 * `registryFile`/`slugDataFile`, no `seoFiles`/`canonicalPrefix`/`sitemap`)
 * consumed by `create-article.mjs`/`staticPagesPlugin.ts`/`router.ts`. That
 * duplication (same bodyDir/metaPrefix/slugConst/indexSlug values, two
 * independent shapes) PRE-DATES this module — `ogPagesPlugin.ts` already
 * carried its own separate inline `SECTIONS` literal with this exact shape
 * before issue #4881 Fase 4 touched it; this file only hoists that
 * pre-existing literal out of local scope, it does not introduce a new copy.
 *
 * **Reconciled (issue #4881 Fase 6).** The overlapping fields
 * (`bodyDir`/`metaPrefix`/`registry`/`slugData`/`slugConst`/`indexSlug`) now
 * come from `build-plugins/shared/articleSectionCore.mjs`'s `ARTICLE_SECTION_CORE`
 * — the same canonical tuple `services/articleSections.ts` re-exports as
 * `ARTICLE_SECTIONS`. Only the fields that are genuinely local to THIS shape
 * (`seoFiles`, `canonicalPrefix`, `sitemap` — none of which exist on the
 * `services/articleSections.ts` side) stay hand-authored below. The two
 * registries keep their distinct shapes/names (still serving different
 * consumers with different needs) but no longer duplicate any value.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ARTICLE_SECTION_CORE } from './articleSectionCore.mjs';
import { CANONICAL_OVERRIDE_FILES } from './canonicalOverrideFiles.mjs';

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
 /**
  * Repo-root-relative candidate paths of this section's canonical-override
  * map, first-readable-wins (`shared/canonicalOverrideFiles.mjs` holds the
  * literal and explains the per-repo layouts). Present for BOTH sections:
  * before this field `ogPagesPlugin.ts` hardwired the mechanism to
  * `SECTION.name === 'svizzera'`, so a frontaliere near-duplicate pair had no
  * way to consolidate. A section with no file on disk simply loads `{}` and
  * every page stays self-canonical, exactly as before.
  */
 canonicalOverrides: readonly string[];
}

/** Project a core entry onto the field names/shape this module's consumers expect. */
function coreFields(id: 'frontaliere' | 'svizzera') {
 const core = ARTICLE_SECTION_CORE[id];
 return {
 bodyDir: core.bodyDir,
 metaPrefix: core.metaPrefix,
 registry: core.registryFile,
 slugData: core.slugDataFile,
 slugConst: core.slugConst,
 indexSlug: core.indexSlug,
 };
}

export const ARTICLE_SECTION_DESCRIPTORS: OgSection[] = [
 {
 name: 'frontaliere',
 seoFiles: ['services/seo/seo-blog.ts',
 ...Array.from({ length: 9 }, (_, i) => `services/seo/seo-blog-${i + 2}.ts`)],
 canonicalPrefix: '/articoli-frontaliere/',
 sitemap: 'public/sitemap-blog.xml',
 canonicalOverrides: CANONICAL_OVERRIDE_FILES.frontaliere,
 ...coreFields('frontaliere'),
 },
 {
 name: 'svizzera',
 seoFiles: ['services/seo/seo-blog-ch.ts'],
 canonicalPrefix: '/articoli-svizzera/',
 sitemap: 'public/sitemap-blog-ch.xml',
 canonicalOverrides: CANONICAL_OVERRIDE_FILES.svizzera,
 ...coreFields('svizzera'),
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

/**
 * Superset-safe enumeration of every known article id in a section: union of
 * (a) `'blog-<slug>'` keys found across the section's `seoFiles` and (b)
 * every locale's body-directory file listing. Shared (issue #4881 Fase 4,
 * AGENTS.md #6) between the corpus re-render driver
 * (`scripts/rerender-article-corpus.mjs`, batching source) and the
 * drift-audit script (`scripts/audit-article-corpus-drift.mjs`, sampling
 * source) — both need "every article id in this section" and neither single
 * source is guaranteed exhaustive on its own. A superset is always safe for
 * both callers: extra ids are harmless no-ops (`renderArticlePages`'s
 * `onlyArticleIds` silently skips anything that isn't a real entry — see
 * `tests/render-article-pages-single-vs-full.test.ts`'s phantom-id case;
 * the audit script would at worst log an early liveness failure from
 * `check-article-byte-identity.mjs` for a phantom id, never crash).
 */
export function enumerateSectionArticleIds(section: OgSection, rootDir: string): string[] {
 const ids = new Set<string>();

 for (const seoFile of section.seoFiles) {
  let src = '';
  try {
   src = fs.readFileSync(path.resolve(rootDir, seoFile), 'utf-8');
  } catch {
   continue; // matches renderArticlePages's own per-seoFile tolerance
  }
  for (const { key } of extractBlogEntryPositions(src)) ids.add(blogKeyToArticleId(key));
 }

 for (const locale of ['it', 'en', 'de', 'fr'] as const) {
  const dir = path.resolve(rootDir, 'services', 'locales', section.bodyDir, locale);
  let files: string[] = [];
  try {
   files = fs.readdirSync(dir);
  } catch (err) {
   if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
   throw err;
  }
  for (const file of files) {
   if (file.endsWith('.ts')) ids.add(file.slice(0, -3));
  }
 }

 return [...ids];
}
