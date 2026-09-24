/**
 * Runtime-safe core for the profession synonym bridge.
 *
 * Keep the taxonomy expansion in an .mjs module so both browser-bundled
 * TypeScript consumers and the Node job-alert sender use the same aliases.
 * The TypeScript facade preserves the existing import surface for UI code.
 */
import {
  LOCALITY_TOKENS,
  matchProfession,
  normalizeText,
  PROFESSION_TAXONOMY,
  SEARCH_STOP_WORDS,
} from '../scripts/lib/profession-taxonomy.mjs';

const ALIAS_TEXT_BY_PROFESSION_ID = new Map(
  PROFESSION_TAXONOMY.map((entry) => [entry.id, entry.aliases.join(' ')]),
);

const PROFESSION_ID_CACHE = new Map();
const PROFESSION_ID_CACHE_MAX = 2048;

function cachedMatchProfession(text) {
  let id = PROFESSION_ID_CACHE.get(text);
  if (id === undefined) {
    id = matchProfession(text);
    if (PROFESSION_ID_CACHE.size >= PROFESSION_ID_CACHE_MAX) PROFESSION_ID_CACHE.clear();
    PROFESSION_ID_CACHE.set(text, id);
  }
  return id;
}

/**
 * Return every locale/gender alias for the profession recognized in a title.
 * A job titled "Infermiera" therefore gains "nurse", "infirmier" and
 * "pflegefachfrau" as searchable text.
 */
export function professionSynonymText(title) {
  const id = cachedMatchProfession(String(title || ''));
  return id ? (ALIAS_TEXT_BY_PROFESSION_ID.get(id) ?? '') : '';
}

function isPlausibleProfessionToken(keyword) {
  const tokens = normalizeText(keyword)
    .split(' ')
    .filter((token) => (
      token.length >= 2
      && !SEARCH_STOP_WORDS.has(token)
      && !LOCALITY_TOKENS.has(token)
      && !/^\d+$/.test(token)
    ));
  return tokens.length > 0;
}

/**
 * Expand query keywords with sibling-profession aliases from the shared
 * taxonomy. Non-profession keywords are returned unchanged.
 */
export function expandKeywordsWithSynonyms(keywords = []) {
  const source = Array.isArray(keywords) ? keywords : [];
  const expanded = new Set(source);
  for (const keyword of source) {
    if (!isPlausibleProfessionToken(keyword)) continue;
    const id = cachedMatchProfession(keyword);
    const aliasText = id ? ALIAS_TEXT_BY_PROFESSION_ID.get(id) : undefined;
    if (!aliasText) continue;
    for (const alias of aliasText.split(' ')) {
      if (alias) expanded.add(alias);
    }
  }
  return Array.from(expanded);
}
