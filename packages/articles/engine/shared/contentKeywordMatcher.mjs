/** Locale-aware exact phrases and nearby concept pairs/triples. No I/O or AI.
 * Entries may describe tools, guides or published articles; offsets always
 * refer to the original text, including accents and non-ASCII characters.
 */
function normalize(value) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss');
}

function tokens(value) {
  return Array.from(String(value || '').matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu), m => ({
    value: normalize(m[0]), start: m.index, end: m.index + m[0].length,
  }));
}

/** aliases[locale] = phrases; combinations[locale] = arrays of 2–3 groups
 * of synonyms. Every group must occur within maxGap intervening words, in
 * the same sentence. A bare ambiguous word is never added implicitly.
 */
export function createContentKeywordMatcher(entries, { maxGap = 3 } = {}) {
  const compiled = entries.map(entry => ({
    ...entry,
    phrases: Object.fromEntries(Object.entries(entry.aliases || {}).map(([locale, phrases]) =>
      [locale, phrases.map(phrase => tokens(phrase).map(t => t.value)).filter(p => p.length)])),
    groups: Object.fromEntries(Object.entries(entry.combinations || {}).map(([locale, combinations]) =>
      [locale, combinations.filter(groups => groups.length >= 2 && groups.length <= 3)
        .map(groups => groups.map(variants => new Set(variants.map(normalize))))])),
  }));

  return (text, locale = 'it') => {
    const words = tokens(text);
    const candidates = [];
    const add = (entry, first, last, size, gaps = 0) => {
      const start = words[first].start, end = words[last].end;
      candidates.push({ id: entry.id, start, end, text: text.slice(start, end),
        score: size * 10 - gaps + (entry.priority || 0), target: entry.target });
    };
    for (const entry of compiled) {
      for (const phrase of entry.phrases[locale] || []) {
        for (let i = 0; i <= words.length - phrase.length; i++) {
          if (!phrase.every((word, j) => words[i + j].value === word)) continue;
          const end = i + phrase.length - 1;
          if (/[.!?;\n]/u.test(text.slice(words[i].end, words[end].start))) continue;
          add(entry, i, end, phrase.length);
        }
      }
      for (const groups of entry.groups[locale] || []) {
        for (let i = 0; i < words.length; i++) {
          if (!groups.some(g => g.has(words[i].value))) continue;
          const positions = [];
          // Bound the search by the number of concepts, independently of body length.
          const last = Math.min(words.length - 1, i + groups.length + maxGap - 1);
          for (let j = i; j <= last; j++) {
            if (/[.!?;\n]/u.test(text.slice(words[i].end, words[j].start))) break;
            positions.push(j);
            const assign = (group, used) => {
              if (group === groups.length) return used;
              for (const pos of positions) {
                if (!used.includes(pos) && groups[group].has(words[pos].value)) {
                  const result = assign(group + 1, [...used, pos]);
                  if (result) return result;
                }
              }
              return null;
            };
            const matched = assign(0, []);
            if (matched && Math.min(...matched) === i) {
              const end = Math.max(...matched);
              add(entry, i, end, groups.length, end - i + 1 - groups.length);
              break;
            }
          }
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.start - b.start || a.id.localeCompare(b.id));
    const selected = [];
    for (const match of candidates) {
      if (!selected.some(m => match.start < m.end && match.end > m.start)) selected.push(match);
    }
    return selected.sort((a, b) => a.start - b.start);
  };
}

/** Rank destinations; title/lede matches outweigh repeated incidental terms. */
export function rankContentDestinations(match, { title = '', excerpt = '', body = '', locale = 'it' } = {}) {
  const scores = new Map();
  for (const [text, weight] of [[title, 6], [excerpt, 3], [body, 1]]) {
    const counts = new Map();
    for (const hit of match(text, locale)) {
      // Saturate repeated terms so a long paragraph cannot dominate the title.
      const count = counts.get(hit.id) || 0;
      if (count < 3) scores.set(hit.id, (scores.get(hit.id) || 0) + hit.score * weight);
      counts.set(hit.id, count + 1);
    }
  }
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, score]) => ({ id, score }));
}

/** Words that name the whole site, not a subject: they never count as a shared keyword. */
// Stems, not words: the tokenizer folds one trailing vowel (`ticino` -> `ticin`, `lavoro` -> `lavor`).
const GENERIC_STEMS = ['frontalier', 'grenzg', 'ticin', 'tessin', 'svizzer', 'swiss', 'schweiz', 'suisse', 'switzerl', 'lavor'];
const isGenericToken = token => GENERIC_STEMS.some(stem => token.startsWith(stem));

/** Weight of a keyword by where it occurs; the higher wins when it occurs in several places. */
const PROFILE_WEIGHT = { title: 3, tag: 2, excerpt: 2, titleToken: 1, tagToken: 1 };

/**
 * Keyword profile of an article for cross-section matching. Entities come from
 * the shared vocabulary (`match`, a matcher built with createContentKeywordMatcher),
 * tokens from the title and tags only: an excerpt is too wide to prove a shared
 * subject on single words. `tokenize` is injected (the related-articles tokenizer)
 * so the folding of accents and endings stays defined in one place.
 */
export function buildKeywordProfile({ title = '', excerpt = '', tags = [] } = {}, { match, locale = 'it', tokenize } = {}) {
  const entities = new Map();
  const tokenWeights = new Map();
  const titleKeys = new Set();
  const put = (map, key, weight) => { if ((map.get(key) || 0) < weight) map.set(key, weight); };
  const addEntities = (text, weight, inTitle) => {
    if (!match || !text) return;
    for (const hit of match(String(text), locale)) {
      put(entities, hit.id, weight);
      if (inTitle) titleKeys.add(`e:${hit.id}`);
    }
  };
  const addTokens = (text, weight, inTitle) => {
    if (!tokenize || !text) return;
    for (const token of tokenize(String(text))) {
      if (token.length < 5 || isGenericToken(token)) continue;
      put(tokenWeights, token, weight);
      if (inTitle) titleKeys.add(`t:${token}`);
    }
  };
  addEntities(title, PROFILE_WEIGHT.title, true);
  addEntities(excerpt, PROFILE_WEIGHT.excerpt, false);
  addTokens(title, PROFILE_WEIGHT.titleToken, true);
  for (const tag of tags) {
    addEntities(tag, PROFILE_WEIGHT.tag, false);
    addTokens(tag, PROFILE_WEIGHT.tagToken, false);
  }
  return { entities, tokens: tokenWeights, titleKeys };
}

/**
 * Relevance of `target` to `source`: shared entities add their lower weight, shared
 * tokens add theirs up to a cap of 4 (a long title must not pass on loose words).
 * `anchored` tells whether a shared keyword is visible in the target's title, which
 * is the anchor text of the link.
 */
export function scoreSharedKeywords(source, target) {
  const shared = [];
  let score = 0;
  let tokenScore = 0;
  for (const [id, weight] of source.entities) {
    const other = target.entities.get(id);
    if (other === undefined) continue;
    score += Math.min(weight, other);
    shared.push(`e:${id}`);
  }
  for (const [token, weight] of source.tokens) {
    const other = target.tokens.get(token);
    if (other === undefined) continue;
    tokenScore += Math.min(weight, other);
    shared.push(`t:${token}`);
  }
  score += Math.min(tokenScore, 4);
  shared.sort();
  return { score, shared, anchored: shared.some(key => target.titleKeys.has(key)) };
}
