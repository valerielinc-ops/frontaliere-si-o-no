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

/** Sentence (stripped text) that contains [start, end): boundaries are `.!?` before a space/end, `;` and newlines. */
export function sentenceAt(text, start, end) {
  let a = start;
  while (a > 0 && !(/[;\n]/u.test(text[a - 1]) || (/[.!?]/u.test(text[a - 1]) && /\s/u.test(text[a] || ' ')))) a -= 1;
  const rel = text.slice(end).search(/[.!?](?=\s|$)|[;\n]/u);
  return text.slice(a, rel < 0 ? text.length : end + rel);
}

// Safari/WebKit older than 16.4 throws at parse time on regex lookbehind, and this module ships in
// the client bundle (check-client-lookbehind). The patterns below therefore express «not preceded by
// a letter» as a left word boundary checked here, with the same semantics as `(?<!\p{L})`.
const LETTER = /^\p{L}$/u;

function letterBefore(text, index) {
  if (index <= 0) return false;
  const last = [...text.slice(Math.max(0, index - 2), index)].pop();
  return LETTER.test(last);
}

/** Next match of the global regex `re` from `from` whose start is not preceded by a letter. */
export function execLeftBounded(re, text, from = 0) {
  re.lastIndex = from;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!letterBefore(text, m.index)) return m;
    re.lastIndex = m.index + ((text.codePointAt(m.index) ?? 0) > 0xffff ? 2 : 1);
  }
  return null;
}

/** `re.test(text)` with a «not preceded by a letter» start; `re` must be global. */
export function testLeftBounded(re, text) {
  return execLeftBounded(re, text) !== null;
}

function replaceLeftBounded(re, text, replacement) {
  let out = '';
  let pos = 0;
  for (let m = execLeftBounded(re, text, 0); m; m = execLeftBounded(re, text, pos)) {
    out += text.slice(pos, m.index) + replacement;
    pos = m.index + m[0].length;
    if (m[0].length === 0) break;
  }
  return out + text.slice(pos);
}

// Every pattern here is matched through the *LeftBounded helpers: the start must not follow a letter.
// «non solo X», «not only X», «nicht nur X», «pas seulement X» introduce the topic: not a negation.
const NOT_NEGATION = {
  it: /non\s+(?:(?:è|sono|e|si\s+tratta)\s+)?(?:solo|soltanto|solamente|tanto|che)(?!\p{L})/giu,
  en: /not\s+(?:only|just|merely|simply)(?!\p{L})/giu,
  de: /nicht\s+(?:nur|bloss|bloß|allein)(?!\p{L})/giu,
  fr: /(?:ne\s+)?pas\s+(?:seulement|uniquement|que)(?!\p{L})/giu,
};
// Negation or exclusion in the same sentence: the topic is cited to say it is NOT covered.
const NEGATION = {
  it: /(?:non|né|nè|nemmeno|neppure|neanche|senza|nessun[oa]?|niente|nulla|lascia\s+fuori|fuori\s+dal|resta(?:no)?\s+fuori|esclus[aeio])(?![\p{L}\p{N}])/giu,
  en: /(?:not|no|nor|neither|never|none|nobody|nothing|without|cannot|can[’']t|\p{L}+n[’']t|leaves?\s+out|left\s+out|excluded?|outside\s+the\s+(?:text|scope))(?![\p{L}\p{N}])/giu,
  de: /(?:nicht|nichts|kein(?:e|en|em|er|es)?|niemals|nie|weder|ohne|ausserhalb|außerhalb|ausgeklammert|aussen\s+vor|außen\s+vor)(?![\p{L}\p{N}])/giu,
  fr: /(?:(?:ne\s+|n[’'])(?:\p{L}+\s+){0,3}?(?:pas|plus|jamais|aucun(?:e|es|s)?|rien|guère)|(?:pas|aucun(?:e|es|s)?|ni|non|sans|rien|exclu(?:e|es|s)?|hors\s+du\s+texte|laisse\s+de\s+côté))(?![\p{L}\p{N}])/giu,
};

/** True when the sentence denies or excludes its topic (IT/EN/DE/FR). */
export function isNegatedSentence(sentence, locale = 'it') {
  const re = NEGATION[locale];
  if (!re) return false;
  const cleaned = replaceLeftBounded(NOT_NEGATION[locale], sentence, ' ');
  return testLeftBounded(re, cleaned);
}
