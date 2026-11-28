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
 * Aliases that name an entity only in a given context. «secondo pilastro» is
 * the LPP when the text speaks of pensions, and an unrelated figure of speech
 * in «l'Italia secondo pilastro della banca»: such a hit is dropped unless the
 * same text carries another hit of the entity or one of the context stems.
 */
const AMBIGUOUS_ALIASES = [{
  entity: 'pension',
  aliases: ['secondo pilastro', 'second pillar', 'zweite saule', 'deuxieme pilier'],
  context: /^(lpp|bvg|avs|ahv|pension|previden|prevoyan|rent|retrait|altersvorsorg|prelev|riscatt|capital|cassa$|kasse)/,
}];
const AMBIGUOUS_BY_ENTITY = new Map(AMBIGUOUS_ALIASES.map(rule => [rule.entity, rule]));

/** Hits that stay once ambiguous aliases without their context are dropped. */
function dropAmbiguousHits(hits, text) {
  const kept = [];
  const words = tokens(text).map(t => t.value);
  for (const hit of hits) {
    const rule = AMBIGUOUS_BY_ENTITY.get(hit.id);
    const phrase = tokens(hit.text).map(t => t.value).join(' ');
    if (!rule || !rule.aliases.includes(phrase)) { kept.push(hit); continue; }
    const supported = words.some(word => rule.context.test(word)) || hits.some(other => other !== hit && other.id === hit.id
      && !rule.aliases.includes(tokens(other.text).map(t => t.value).join(' ')));
    if (supported) kept.push(hit);
  }
  return kept;
}

/**
 * Keyword profile of an article for cross-section matching. Entities come from
 * the shared vocabulary (`match`, a matcher built with createContentKeywordMatcher),
 * tokens from the title and tags only: an excerpt is too wide to prove a shared
 * subject on single words. `tokenize` is injected (the related-articles tokenizer)
 * so the folding of accents and endings stays defined in one place. A token that
 * is part of an entity phrase is not counted again as a token: the entity already
 * says it, and a «specific» token must add something beyond it.
 */
export function buildKeywordProfile({ title = '', excerpt = '', tags = [] } = {}, { match, locale = 'it', tokenize } = {}) {
  const entities = new Map();
  const tokenWeights = new Map();
  const titleKeys = new Set();
  // Every non-generic token of title, tags and excerpt: only a corroboration of a
  // match found on title/tags (an excerpt alone never proves a shared subject).
  const contextTokens = new Set();
  const put = (map, key, weight) => { if ((map.get(key) || 0) < weight) map.set(key, weight); };
  const addEntities = (text, weight, inTitle, covered = new Set()) => {
    if (!match || !text) return covered;
    for (const hit of dropAmbiguousHits(match(String(text), locale), String(text))) {
      put(entities, hit.id, weight);
      if (inTitle) titleKeys.add(`e:${hit.id}`);
      if (tokenize) for (const token of tokenize(hit.text)) covered.add(token);
    }
    return covered;
  };
  const addTokens = (text, weight, inTitle, covered) => {
    if (!tokenize || !text) return;
    for (const token of tokenize(String(text))) {
      if (token.length < 5 || isGenericToken(token) || covered.has(token)) continue;
      contextTokens.add(token);
      if (weight === 0) continue;
      put(tokenWeights, token, weight);
      if (inTitle) titleKeys.add(`t:${token}`);
    }
  };
  const titleCovered = addEntities(title, PROFILE_WEIGHT.title, true);
  addTokens(title, PROFILE_WEIGHT.titleToken, true, titleCovered);
  addTokens(excerpt, 0, false, addEntities(excerpt, PROFILE_WEIGHT.excerpt, false, new Set(titleCovered)));
  for (const tag of tags) addTokens(tag, PROFILE_WEIGHT.tagToken, false, addEntities(tag, PROFILE_WEIGHT.tag, false));
  return { entities, tokens: tokenWeights, titleKeys, contextTokens };
}

/**
 * Relevance of `target` to `source`: shared entities add their lower weight, shared
 * tokens add theirs up to a cap of 4 (a long title must not pass on loose words).
 * `anchored` tells whether a shared keyword is visible in the target's title, which
 * is the anchor text of the link. `titleEntity` tells whether an entity of the shared
 * vocabulary is in the TITLE of both articles; `tokenCount` is the number of shared
 * title/tag tokens and `contextCount` the number of tokens shared anywhere (title,
 * tags, excerpt). The caller removes the high-frequency tokens from the source
 * profile first, so what is left is specific.
 */
export function scoreSharedKeywords(source, target) {
  const shared = [];
  let score = 0;
  let tokenScore = 0;
  let tokenCount = 0;
  let titleEntity = false;
  for (const [id, weight] of source.entities) {
    const other = target.entities.get(id);
    if (other === undefined) continue;
    score += Math.min(weight, other);
    shared.push(`e:${id}`);
    if (source.titleKeys.has(`e:${id}`) && target.titleKeys.has(`e:${id}`)) titleEntity = true;
  }
  for (const [token, weight] of source.tokens) {
    const other = target.tokens.get(token);
    if (other === undefined) continue;
    tokenScore += Math.min(weight, other);
    tokenCount += 1;
    shared.push(`t:${token}`);
  }
  score += Math.min(tokenScore, 4);
  shared.sort();
  let contextCount = 0;
  for (const token of source.contextTokens || []) if (target.contextTokens?.has(token)) contextCount += 1;
  return { score, shared, anchored: shared.some(key => target.titleKeys.has(key)), titleEntity, tokenCount, contextCount };
}
