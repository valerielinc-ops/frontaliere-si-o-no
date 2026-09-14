/**
 * Pure source reader shared by the TypeScript article engine and the
 * dependency-free corpus floor verifier.
 *
 * The two runtimes must agree on the grammar of the section slug maps. Keeping
 * the parser here means a new router formatting variant changes both readers
 * together instead of changing the archive emitter and its floor reference
 * independently.
 */

const LOCALES = ['it', 'en', 'de', 'fr'];

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SLUG_MAP_ENTRY_RE = /["']([^"']+)["']\s*:\s*\{\s*it:\s*["']([^"']+)["']\s*,\s*en:\s*["']([^"']+)["']\s*,\s*de:\s*["']([^"']+)["']\s*,\s*fr:\s*["']([^"']+)["']/g;

/**
 * Parse one `const <slugConst> = { ... }` source block into its locale URL
 * map. A missing or empty declaration is represented by `{}` so the caller
 * can choose whether an empty source is a valid fallback or a hard error.
 *
 * @param {string} source
 * @param {string} slugConst
 * @returns {Record<string, Record<string, string>>}
 */
export function parseArticleUrlSlugs(source, slugConst) {
  if (typeof source !== 'string' || typeof slugConst !== 'string' || slugConst.length === 0) return {};
  const block = source.match(new RegExp(`const ${escapeRegex(slugConst)}[\\s\\S]*?\\n\\};`, 'm'))?.[0] ?? '';
  if (!block) return {};

  const out = {};
  for (const match of block.matchAll(SLUG_MAP_ENTRY_RE)) {
    out[match[1]] = Object.fromEntries(LOCALES.map((locale, index) => [locale, match[index + 2]]));
  }
  return out;
}
