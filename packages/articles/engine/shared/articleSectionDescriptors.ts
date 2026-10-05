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
import { ARTICLE_SECTION_CORE_LIST } from './articleSectionCore.mjs';
import { CANONICAL_OVERRIDE_FILES } from './canonicalOverrideFiles.mjs';
// @ts-ignore The site symlink can make tsc resolve this shared source from
// build-plugins/shared, where this engine-local sibling is not visible at the
// link path; Node/Vite resolve the realpath correctly at runtime.
import { findAllSeoEntryMatches } from './seo-entry.mjs';

function isMissingPathError(error: unknown): boolean {
 return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

type SectionKind = 'frontaliere' | 'national' | 'canton';
/** Same open shape as `ArticleSection` in `articleSections.ts` (not imported: see the seo-entry note above). */
type SectionId = 'frontaliere' | 'svizzera' | `canton-${string}`;

export interface OgSection {
 /** Section id: `frontaliere`, `svizzera` or `canton-<code>`. */
 name: SectionId;
 /** Editorial family from the core — what renderer branches look up instead of `name`. */
 kind: SectionKind;
 /** Pages-shard token (`articolifrontaliere`, …); `null` for canton sections (R2). */
 shardKey: string | null;
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

interface CoreEntry {
 section: SectionId;
 kind: SectionKind;
 shardKey: string | null;
 indexSlug: Record<'it' | 'en' | 'de' | 'fr', string>;
 bodyDir: string;
 metaPrefix: string;
 registryFile: string;
 slugDataFile: string;
 slugConst: string;
}

/**
 * The fields that are local to THIS shape, per section kind (they are not in
 * the core tuple because no other consumer needs them). The frontaliere and
 * national rows are the two literals this module held before the table: same
 * seoFiles, sitemap and override candidates. The canton row derives the same
 * fields from the section id (`seo-blog-canton-<code>.ts`,
 * `sitemap-articles-<id>.xml`) and has no canonical-override map yet: a canton
 * section starts empty, so every page is self-canonical by construction.
 */
const KIND_LOCAL_FIELDS: Record<SectionKind, (core: CoreEntry) => Pick<OgSection, 'seoFiles' | 'sitemap' | 'canonicalOverrides'>> = {
 frontaliere: () => ({
 seoFiles: ['services/seo/seo-blog.ts',
 ...Array.from({ length: 9 }, (_, i) => `services/seo/seo-blog-${i + 2}.ts`)],
 sitemap: 'public/sitemap-blog.xml',
 canonicalOverrides: CANONICAL_OVERRIDE_FILES.frontaliere,
 }),
 national: () => ({
 seoFiles: ['services/seo/seo-blog-ch.ts'],
 sitemap: 'public/sitemap-blog-ch.xml',
 canonicalOverrides: CANONICAL_OVERRIDE_FILES.svizzera,
 }),
 canton: (core) => ({
 seoFiles: [`services/seo/seo-blog-${core.section}.ts`],
 sitemap: `public/sitemap-articles-${core.section}.xml`,
 canonicalOverrides: [],
 }),
};

/** Project a core entry onto the field names/shape this module's consumers expect. */
function descriptorFor(core: CoreEntry): OgSection {
 const local = KIND_LOCAL_FIELDS[core.kind];
 if (!local) throw new Error(`articleSectionDescriptors: tipo di sezione non gestito "${core.kind}" (${core.section})`);
 return {
 name: core.section,
 kind: core.kind,
 shardKey: core.shardKey,
 ...local(core),
 canonicalPrefix: `/${core.indexSlug.it}/`,
 bodyDir: core.bodyDir,
 metaPrefix: core.metaPrefix,
 registry: core.registryFile,
 slugData: core.slugDataFile,
 slugConst: core.slugConst,
 indexSlug: core.indexSlug,
 };
}

/**
 * One descriptor per ACTIVE section, in core order (frontaliere, svizzera,
 * then any activated canton). Derived from `ARTICLE_SECTION_CORE_LIST`, so
 * while no canton is active this is exactly the two hand-written entries it
 * replaced.
 */
export const ARTICLE_SECTION_DESCRIPTORS: OgSection[] =
 (ARTICLE_SECTION_CORE_LIST as unknown as CoreEntry[]).map(descriptorFor);

/**
 * Find every `'blog-<slug>': {` entry-key position in a `seoFiles` source
 * file. Shared (issue #4881 Fase 4, AGENTS.md #6) between `ogPagesPlugin.ts`'s
 * entries-building loop (the render-time, byte-identity-critical use) and the
 * article-id enumerators (see `blogKeyToArticleId` below). One literal regex,
 * not two copies that could silently diverge if the `blog-` key convention ever
 * changed.
 */
export function extractBlogEntryPositions(source: string): Array<{ key: string; start: number; end: number }> {
 return findAllSeoEntryMatches(source).map(({ id, index, closeIdx }) => ({
  key: 'blog-' + id,
  start: index,
  end: closeIdx + 1,
 }));
}

/** `'blog-<slug>'` -> `<slug>` (the `articleId` shape `renderArticlePages` uses everywhere: `onlyArticleId`, body filenames, write-loop filter). */
export function blogKeyToArticleId(key: string): string {
 return key.replace(/^blog-/, '');
}

/**
 * Read the SEO entry ids that `renderArticlePages` can actually render. Body
 * directories are deliberately not consulted here: a body chunk can outlive
 * its SEO entry during an article refresh/retirement, but it is not a live page
 * that the byte-identity audit can compare.
 */
function enumerateSeoArticleIds(section: OgSection, rootDir: string): Set<string> {
 const ids = new Set<string>();

 for (const seoFile of section.seoFiles) {
  let src = '';
  try {
   src = fs.readFileSync(path.resolve(rootDir, seoFile), 'utf-8');
  } catch (err) {
   if (!isMissingPathError(err)) throw err;
   continue; // matches renderArticlePages's own per-seoFile tolerance
  }
  for (const { key } of extractBlogEntryPositions(src)) ids.add(blogKeyToArticleId(key));
 }

 return ids;
}

/**
 * Enumerate only ids with a renderable SEO entry. This is the population for
 * live byte-identity checks: sampling body-only ids would produce no locale
 * verdict because `renderArticlePages` correctly treats them as no-ops.
 */
export function enumerateRenderableSectionArticleIds(section: OgSection, rootDir: string): string[] {
 return [...enumerateSeoArticleIds(section, rootDir)];
}

/**
 * Superset-safe enumeration of every known article id in a section: union of
 * renderable `'blog-<slug>'` keys and every locale's body-directory file
 * listing. The corpus re-render driver keeps this broader population because
 * its batching input must remain tolerant of a body/SEO sync race; extra ids
 * are harmless no-ops (`renderArticlePages`'s `onlyArticleIds` silently skips
 * anything that isn't a real entry — see
 * `tests/render-article-pages-single-vs-full.test.ts`'s phantom-id case).
 */
export function enumerateSectionArticleIds(section: OgSection, rootDir: string): string[] {
 const ids = enumerateSeoArticleIds(section, rootDir);

 for (const locale of ['it', 'en', 'de', 'fr'] as const) {
  const dir = path.resolve(rootDir, 'services', 'locales', section.bodyDir, locale);
  let files: string[] = [];
  try {
   files = fs.readdirSync(dir);
  } catch (err) {
   if (isMissingPathError(err)) continue;
   throw err;
  }
  for (const file of files) {
   if (file.endsWith('.ts')) ids.add(file.slice(0, -3));
  }
 }

 return [...ids];
}
