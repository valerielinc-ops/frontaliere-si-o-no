const KENJO_HOST = 'tinext.kenjo.io';
const NO_OPENINGS_RE = /\bno\s+job\s+openings\s+are\s+available\s+at\s+this\s+moment\b/i;

/**
 * Kenjo's public career page states this exact empty condition instead of
 * exposing a source-proven zero through every public API response.
 */
export function isKenjoCareerSiteEmpty(value = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
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
