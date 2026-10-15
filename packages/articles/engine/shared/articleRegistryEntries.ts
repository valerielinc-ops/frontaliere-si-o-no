import { articleRegistryObjectBodies, articleRegistryObjectFields } from './articleRegistryObjectBodies.mjs';

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
 * Here each entry is one flat object literal; the object scanner tracks braces
 * only outside quoted strings, so an id can never be paired with the next
 * entry's image even when a title contains `{` or `}`. Each field is read
 * from the object's top-level members only, in any order, so a field name
 * quoted inside another value is never mistaken for the field. An entry without a string `id`,
 * `category`, `image` and `date` is not an article entry (for instance the
 * `Article` interface body) and is skipped. `date: ''` is kept: it is the
 * corpus saying the date is UNKNOWN, and the renderers handle it
 * (`./sourceDates`).
 *
 * The shared scanner is pure and import-free, so this reader stays inside the
 * `packages/articles` confinement boundary and the corpus can run it unchanged.
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
  const out: ArticleRegistryEntry[] = [];
  const seen = new Set<string>();
  for (const body of articleRegistryObjectBodies(source)) {
    // Top-level members only: a field name inside another quoted value
    // (`title: "Promo image: 'x.jpg'"`) is data, not the field.
    const fields = articleRegistryObjectFields(body);
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
