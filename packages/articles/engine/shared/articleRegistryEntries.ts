import {
  findTopLevelStaticObjectLiterals,
  findTopLevelArrays,
  findObjectLiterals,
  parseStaticSource,
  readStaticObjectProperties,
  readStaticString,
  staticPropertyName,
} from './staticSourceAst.mjs';

/**
 * Reads the entries of an article registry SOURCE
 * (`blog-articles-data.ts` / `swiss-articles-data.ts`) without importing it.
 *
 * Why the source and not the module: the module's runtime export rewrites
 * every `image` to its CDN URL (`cdnBlogImage`), while the build plugins need
 * the site-relative literal (`/images/blog/...`) for preload hints, intrinsic
 * size reads off `public/` and the card `<img>`. The raw literals stay
 * site-relative precisely so these readers can use them.
 *
 * Why not a single regex over the whole file: every reader that tried encoded
 * the field ORDER (`id, category, date, image` adjacent). The registry does
 * not keep it — an entry may carry `updatedAt` between `date` and `image`, or
 * even before `category`. Measured on 2026-10-05: 306 of 4,139 blog entries and
 * 60 of 2,557 svizzera entries have `updatedAt` between `date` and `image`, so
 * the hub card grid, its hero and the jobs pages' "recent articles" never saw
 * them — and they are the most recently updated articles, exactly the ones a
 * newest-first grid should show.
 *
 * Here each entry is one flat object literal from the compiler AST, so an id
 * can never be paired with the next entry's image even when a title contains
 * `{` or `}`. Each field is read from the object's top-level members only, in
 * any order, so a field name quoted inside another value is never mistaken for
 * the field. An entry without a string `id`,
 * `category`, `image` and `date` is not an article entry (for instance the
 * `Article` interface body) and is skipped. `date: ''` is kept: it is the
 * corpus saying the date is UNKNOWN, and the renderers handle it
 * (`./sourceDates`).
 *
 * The AST helper is a plain-Node `.mjs` module with an explicit TypeScript
 * runtime dependency, so this reader stays inside the `packages/articles`
 * confinement boundary and the corpus can mirror it unchanged.
 */

export interface ArticleRegistryEntry {
  readonly id: string;
  readonly category: string;
  /** `''` when the publication date is unknown. */
  readonly date: string;
  readonly image: string;
  readonly updatedAt?: string;
}


/**
 * Every article entry of the registry source, in source order. A repeated id
 * keeps its first occurrence.
 */
export function parseArticleRegistryEntries(source: string): ArticleRegistryEntry[] {
  let sourceFile;
  try {
    sourceFile = parseStaticSource(source, 'article-registry.ts', {
      errorPrefix: '[article-registry]',
    });
  } catch (error) {
    // Unit callers and a few legacy publish helpers pass a comma-separated
    // object fragment rather than a complete module. Parse that fragment as a
    // synthetic array, still through the compiler, instead of reviving a
    // delimiter scanner just for the compatibility shape.
    try {
      sourceFile = parseStaticSource(`const __article_registry_fragment = [${source}];`, 'article-registry-fragment.ts', {
        errorPrefix: '[article-registry]',
      });
    } catch {
      throw error;
    }
  }
  const arrays = findTopLevelArrays(sourceFile);
  const objects = arrays.length > 0
    ? findTopLevelStaticObjectLiterals(sourceFile)
    : findObjectLiterals(sourceFile);
  const out: ArticleRegistryEntry[] = [];
  const seen = new Set<string>();
  for (const object of objects) {
    const fields = new Map<string, string>();
    for (const property of readStaticObjectProperties(object, 'article registry entry')) {
      const key = staticPropertyName(property.name);
      if (!key || !['id', 'category', 'date', 'image', 'updatedAt'].includes(key)) continue;
      fields.set(key, readStaticString(property.initializer, sourceFile, {
        label: `${key} in article registry entry`,
        errorPrefix: '[article-registry]',
      }));
    }
    const id = fields.get('id');
    if (!id || seen.has(id)) continue;
    const category = fields.get('category');
    const date = fields.get('date');
    const image = fields.get('image');
    if (category === undefined || date === undefined || !image) continue;
    const updatedAt = fields.get('updatedAt');
    seen.add(id);
    out.push(updatedAt === undefined ? { id, category, date, image } : { id, category, date, image, updatedAt });
  }
  return out;
}
