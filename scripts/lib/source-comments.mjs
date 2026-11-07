/**
 * Blank JavaScript/TypeScript comments while preserving strings, templates,
 * regular-expression literals, and line breaks. Path and source scanners can
 * use this before inspecting executable text without counting examples in
 * comments or mistaking `https://` inside a string for a comment.
 */
import { isRegexLiteralStart } from './inline-comment-marker.mjs';

function blankCommentCharacter(character) {
  return character === '\n' || character === '\r' ? character : ' ';
}

export function stripSourceComments(source) {
  const src = String(source ?? '');
  // Lexer offsets are JavaScript string offsets (UTF-16 code units), so the
  // mutable output must use the same indexing model even when source has emoji.
  const out = src.split('');
  const blank = (index) => { out[index] = blankCommentCharacter(src[index]); };

  function skipQuoted(start, quote) {
    for (let i = start; i < src.length; i += 1) {
      if (src[i] === '\\') {
        i += 1;
      } else if (src[i] === quote) {
        return i + 1;
      }
    }
    return src.length;
  }

  function skipRegex(start) {
    let inClass = false;
    for (let i = start + 1; i < src.length; i += 1) {
      if (src[i] === '\\') {
        i += 1;
      } else if (src[i] === '[') {
        inClass = true;
      } else if (src[i] === ']' && inClass) {
        inClass = false;
      } else if (src[i] === '/' && !inClass) {
        return i + 1;
      }
    }
    return src.length;
  }

  function scanTemplate(start) {
    for (let i = start; i < src.length; i += 1) {
      if (src[i] === '\\') {
        i += 1;
      } else if (src[i] === '`') {
        return i + 1;
      } else if (src[i] === '$' && src[i + 1] === '{') {
        i = scanCode(i + 2, true) - 1;
      }
    }
    return src.length;
  }

  function scanCode(start, stopAtBrace = false) {
    let braceDepth = 0;

    for (let i = start; i < src.length; i += 1) {
      const character = src[i];
      const next = src[i + 1];

      if (character === '/' && next === '/') {
        blank(i);
        blank(i + 1);
        let end = i + 2;
        while (end < src.length && src[end] !== '\n' && src[end] !== '\r') {
          blank(end);
          end += 1;
        }
        i = end - 1;
        continue;
      }
      if (character === '/' && next === '*') {
        blank(i);
        blank(i + 1);
        let end = i + 2;
        while (end < src.length) {
          if (src[end] === '*' && src[end + 1] === '/') {
            blank(end);
            blank(end + 1);
            i = end + 1;
            break;
          }
          blank(end);
          end += 1;
        }
        if (end >= src.length) return src.length;
        continue;
      }
      if (character === '\'' || character === '"') {
        i = skipQuoted(i + 1, character) - 1;
        continue;
      }
      if (character === '`') {
        i = scanTemplate(i + 1) - 1;
        continue;
      }
      if (character === '/' && isRegexLiteralStart(src, i)) {
        i = skipRegex(i) - 1;
        continue;
      }
      if (stopAtBrace && character === '}' && braceDepth === 0) return i + 1;
      if (character === '{') {
        braceDepth += 1;
        continue;
      }
      if (character === '}') {
        if (braceDepth > 0) braceDepth -= 1;
        continue;
      }

      if (/\s/.test(character)) continue;
    }
    return src.length;
  }

  scanCode(0);
  return out.join('');
}
