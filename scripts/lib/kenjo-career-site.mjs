const KENJO_HOST = 'tinext.kenjo.io';
const NO_OPENINGS_RE = /\bno\s+job\s+openings\s+are\s+available\s+at\s+this\s+moment\b/i;
const INVISIBLE_TAGS = new Set(['head', 'script', 'style', 'noscript', 'template', 'title']);
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

function hasHiddenMarker(openingTag) {
  const attributes = openingTag.replace(/^<\s*[a-z][\w:-]*/i, '').replace(/\/?>\s*$/, '');
  const classMatch = /\bclass\s*=\s*(["'])(.*?)\1/i.exec(attributes);
  const classNames = classMatch ? classMatch[2].split(/\s+/) : [];
  return (
    /(?:^|\s)hidden(?:\s|=|$)/i.test(attributes)
    || /\baria-hidden\s*=\s*(?:["']true["']|true)(?![\w-])/i.test(attributes)
    || /\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden|opacity\s*:\s*0)[^"']*["']/i.test(attributes)
    || classNames.some((className) => ['hidden', 'd-none', 'sr-only', 'visually-hidden'].includes(className))
  );
}

function visibleTextFromHtml(value) {
  const source = String(value ?? '');
  const text = [];
  const stack = [];
  const tokenRe = /<!--[\s\S]*?-->|<\/?[a-z][^>]*>/gi;
  let cursor = 0;
  let match;

  while ((match = tokenRe.exec(source))) {
    if (match.index > cursor && !stack.some((frame) => frame.hidden)) {
      text.push(source.slice(cursor, match.index));
    }

    const token = match[0];
    cursor = tokenRe.lastIndex;
    if (token.startsWith('<!--')) continue;

    const tagMatch = /^<\/?\s*([a-z][\w:-]*)/i.exec(token);
    if (!tagMatch) continue;
    const tag = tagMatch[1].toLowerCase();

    if (/^<\//.test(token)) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].tag === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    const hidden = (
      stack.some((frame) => frame.hidden)
      || INVISIBLE_TAGS.has(tag)
      || hasHiddenMarker(token)
    );
    if (!VOID_TAGS.has(tag) && !/\/\s*>$/.test(token)) stack.push({ tag, hidden });
  }

  if (cursor < source.length && !stack.some((frame) => frame.hidden)) {
    text.push(source.slice(cursor));
  }

  return text.join(' ')
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Kenjo's public career page states this exact empty condition instead of
 * exposing a source-proven zero through every public API response.
 *
 * The raw markup is required here. Matching after a blanket HTML strip makes
 * hidden/template copy indistinguishable from the visible empty-state message
 * and can retire live jobs when cards are still present.
 */
export function isKenjoCareerSiteEmpty(value = '') {
  const source = String(value ?? '');
  if (!/<\/?[a-z][^>]*>/i.test(source)) return false;
  const text = visibleTextFromHtml(source);
  return NO_OPENINGS_RE.test(text);
}

/**
 * Resolve the public career-site path used by the listing/detail APIs.
 * Kenjo has exposed the same value as customUrl and customJobUrl over time;
 * accept the public URL/slug variants too, but never turn an API endpoint or
 * a foreign host into a detail path by accident.
 */
export function resolveKenjoPositionPath(position = {}) {
  for (const key of ['customUrl', 'customJobUrl', 'jobUrl', 'url', 'slug']) {
    const rawValue = position?.[key];
    const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!raw) continue;

    let candidate = raw;
    if (candidate.startsWith('//')) continue;
    if (/^https?:\/\//i.test(candidate)) {
      try {
        const parsed = new URL(candidate);
        if (parsed.hostname.toLowerCase() !== KENJO_HOST) continue;
        candidate = parsed.pathname;
      } catch {
        continue;
      }
    }

    candidate = candidate.split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, '');
    if (!candidate || /(^|\/)api\//i.test(candidate) || /:\/\//.test(candidate)) continue;
    return candidate;
  }

  return '';
}
