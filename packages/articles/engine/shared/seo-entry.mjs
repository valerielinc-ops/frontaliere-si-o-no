/**
 * Lexical, balanced resolver for generated SEO entries.
 *
 * This module lives under the engine subtree because that subtree is mirrored
 * to the site. Corpus scripts use the compatibility re-export at
 * `scripts/lib/seo-entry.mjs`; the implementation must remain self-contained
 * so a mirrored engine consumer never imports a corpus-only helper.
 */

const CLOSING = { '{': '}', '[': ']', '(': ')' };
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Find the closing delimiter for the one at `openIdx`, ignoring strings,
 * comments, and regular-expression literals. Returns `-1` when unclosed.
 */
function matchingDelimiter(src, openIdx) {
  const open = src[openIdx];
  const close = CLOSING[open];
  if (!close) throw new Error(`matchingDelimiter: '${open}' non è un delimitatore di apertura`);
  let depth = 0;
  let quote = null;

  const canStartRegex = (idx) => {
    let j = idx - 1;
    while (j >= openIdx && /\s/.test(src[j])) j -= 1;
    if (j < openIdx) return true;
    const previous = src[j];
    if ('([{=,:;!?&|+\-*%^~<>'.includes(previous)) return true;
    let end = j;
    while (j >= openIdx && /[A-Za-z_$]/.test(src[j])) j -= 1;
    if (end === j) return false;
    return /^(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|else|do)$/.test(src.slice(j + 1, end + 1));
  };

  const skipRegex = (start) => {
    let inClass = false;
    for (let i = start + 1; i < src.length; i += 1) {
      if (src[i] === '\\') { i += 1; continue; }
      if (src[i] === '\n' || src[i] === '\r') return start;
      if (src[i] === '[') { inClass = true; continue; }
      if (src[i] === ']' && inClass) { inClass = false; continue; }
      if (src[i] === '/' && !inClass) {
        // A second slash is a line comment, not a regex terminator. Treat the
        // ambiguous literal as unclosed so a hidden bracket cannot be used as
        // an entry boundary.
        if (src[i + 1] === '/') return -1;
        while (/[A-Za-z]/.test(src[i + 1] || '')) i += 1;
        return i;
      }
    }
    return -1;
  };

  for (let i = openIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (quote !== null) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl === -1) return -1;
      i = nl;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === '/' && canStartRegex(i)) {
      const end = skipRegex(i);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Return the end of an ordinary quoted JavaScript string, or `-1`. */
function quotedEnd(src, start, quote) {
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === '\\') { i += 1; continue; }
    if (src[i] === quote) return i;
    if (src[i] === '\n' || src[i] === '\r') return -1;
  }
  return -1;
}

/**
 * Find the closing backtick, including `${...}` expressions and nested
 * literals. Template text is not an SEO entry.
 */
function templateEnd(src, start) {
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === '\\') { i += 1; continue; }
    if (src[i] === '`') return i;
    if (src[i] !== '$' || src[i + 1] !== '{') continue;

    let depth = 1;
    for (i += 2; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '\\') { i += 1; continue; }
      if (ch === "'" || ch === '"') {
        const end = quotedEnd(src, i, ch);
        if (end === -1) return -1;
        i = end;
        continue;
      }
      if (ch === '`') {
        const end = templateEnd(src, i);
        if (end === -1) return -1;
        i = end;
        continue;
      }
      if (ch === '/' && src[i + 1] === '/') {
        const end = src.indexOf('\n', i + 2);
        if (end === -1) return -1;
        i = end;
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end === -1) return -1;
        i = end + 1;
        continue;
      }
      if (ch === '{') depth += 1;
      if (ch === '}' && --depth === 0) break;
    }
    if (depth !== 0) return -1;
  }
  return -1;
}

function isRealSeoKey(src, start, end) {
  let lineStart = start;
  while (lineStart > 0 && src[lineStart - 1] !== '\n' && src[lineStart - 1] !== '\r') {
    lineStart -= 1;
  }
  if (!/^[\t ]*$/.test(src.slice(lineStart, start))) return false;
  const key = src.slice(start + 1, end);
  return /^blog-[^'\\\r\n]+$/.test(key) && /^\s*:\s*\{/.test(src.slice(end + 1));
}

/**
 * Mask comments and literal contents without changing UTF-16 offsets.
 * Canonical single-quoted SEO keys are deliberately kept visible.
 * Unclosed tokens are rejected instead of turning the remainder into an
 * apparently valid prefix.
 */
export function maskSeoSource(source, file = 'SEO source') {
  const src = String(source);
  const masked = new Array(src.length);
  for (let i = 0; i < src.length; i += 1) {
    masked[i] = src[i] === '\n' || src[i] === '\r' ? src[i] : ' ';
  }

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i + 2);
      i = end === -1 ? src.length - 1 : end - 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new Error(`${file}: commento multilinea non chiuso`);
      i = end + 1;
      continue;
    }
    if (ch === '`') {
      const end = templateEnd(src, i);
      if (end === -1) throw new Error(`${file}: template literal non chiuso`);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = quotedEnd(src, i, ch);
      if (end === -1) throw new Error(`${file}: stringa ${ch} non chiusa`);
      if (ch === "'" && end !== -1 && isRealSeoKey(src, i, end)) {
        for (let j = i; j <= end; j += 1) masked[j] = src[j];
      }
      i = end;
      continue;
    }
    masked[i] = ch;
  }
  return masked.join('');
}

function locateSeoEntryMatches(source, entryRe, file) {
  const src = String(source);
  const masked = maskSeoSource(src, file);
  const matches = [];
  for (const match of masked.matchAll(entryRe)) {
    const keyOffset = match[0].indexOf("'blog-");
    const index = match.index + keyOffset;
    const openIdx = match.index + match[0].length - 1;
    const closeIdx = matchingDelimiter(src, openIdx);
    if (closeIdx === -1) {
      const id = match[1] ?? 'unknown';
      throw new Error(`${file}: graffe sbilanciate attorno a blog-${id}`);
    }
    matches.push({
      id: match[1],
      index,
      lineStart: match.index,
      indent: match[0].slice(0, keyOffset),
      openIdx,
      closeIdx,
    });
  }
  return matches;
}

/** Locate every real `blog-<id>` object entry, regardless of indentation. */
export function findSeoEntryMatches(source, id, file = 'SEO source') {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${file}: article id must be a non-empty string`);
  }

  const escaped = escapeRegex(id);
  const entryRe = new RegExp(`^[\\t ]*'blog-(${escaped})'\\s*:\\s*\\{`, 'gm');
  return locateSeoEntryMatches(source, entryRe, file);
}

/** Locate all real SEO entries for consumers that need the whole chunk. */
export function findAllSeoEntryMatches(source, file = 'SEO source') {
  return locateSeoEntryMatches(source, /^[\t ]*'blog-([^']+)'\s*:\s*\{/gm, file);
}

/** Remove every `'blog-<id>': { ... },` block from `source`. */
export function removeSeoEntriesFromSource(source, id, file = 'SEO source') {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${file}: article id must be a non-empty string`);
  }

  let src = String(source);
  const matches = findSeoEntryMatches(src, id, file);
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const { lineStart, closeIdx } = matches[i];
    let end = closeIdx + 1;
    if (src[end] === ',') end += 1;
    if (src[end] === '\r') end += 1;
    if (src[end] === '\n') end += 1;
    src = src.slice(0, lineStart) + src.slice(end);
  }

  const remaining = findSeoEntryMatches(src, id, file).length;
  if (remaining !== 0) {
    throw new Error(`${file}: restano ${remaining} voci SEO per blog-${id} dopo la rimozione`);
  }
  return { changed: matches.length > 0, src, removed: matches.length };
}
