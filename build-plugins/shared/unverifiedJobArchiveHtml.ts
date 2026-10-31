import { hasRecordedJobIdentity } from './jobArchiveEvidence';

function attributeValues(tag: string, name: string): string[] {
  const values: string[] = [];
  const attributes = /(?:^|\s)([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of tag.matchAll(attributes)) {
    if (match[1].toLowerCase() === name) values.push((match[2] ?? match[3] ?? match[4]).trim());
  }
  return values;
}

function normalizedSlug(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const slug = decodeURIComponent(value).normalize('NFC');
    return slug && !/[\/\\?#\u0000-\u001f\u007f]/.test(slug) ? slug : null;
  } catch { return null; }
}

function containsJobPosting(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) { pending.push(...item); continue; }
    const record = item as Record<string, unknown>;
    const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
    if (types.some((type) => typeof type === 'string' && /(?:^|[/#])JobPosting$/i.test(type))) return true;
    pending.push(...Object.values(record).filter((entry) => entry && typeof entry === 'object'));
  }
  return false;
}

/** Positive evidence for the same route's title-less orphan fallback.
 * Recorded archives, active postings and ambiguous documents remain protected.
 */
export function isUnverifiedJobArchiveHtml(html: string, pathname: string): boolean {
  if (!pathname.startsWith('/') || pathname.startsWith('//') || /[?#]/.test(pathname)) return false;
  const expectedSlug = normalizedSlug(pathname.replace(/\/+$/, '').split('/').pop());
  if (!expectedSlug) return false;
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  if (markup.includes('<!--')) return false;
  const heads = [...markup.matchAll(/<head(?:\s[^>]*)?>([\s\S]*?)<\/head\s*>/gi)];
  if (heads.length !== 1) return false;
  let noindex = false;
  for (const [tag] of heads[0][1].matchAll(/<meta(?:\s[^>]*)?>/gi)) {
    const names = attributeValues(tag, 'name').map((name) => name.toLowerCase());
    if (!names.includes('robots')) continue;
    if (names.some((name) => name !== 'robots')) return false;
    const contents = attributeValues(tag, 'content');
    if (!contents.length || contents.some((content) => {
      const tokens = content.toLowerCase().split(/[\s,]+/);
      return !tokens.includes('noindex') || tokens.includes('index');
    })) return false;
    noindex = true;
  }
  if (!noindex) return false;

  const seeds: Record<string, unknown>[] = [];
  for (const [, attributes, code] of markup.matchAll(/<script((?:\s[^>]*)?)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/window\s*(?:\.\s*__JOB_SEED__|\[\s*(['"])__JOB_SEED__\1\s*\])\s*=/.test(code)) return false;
    const types = attributeValues(attributes, 'type').map((type) => type.toLowerCase().split(';')[0].trim());
    if (types.includes('application/ld+json')) {
      if (types.some((type) => type !== 'application/ld+json')) return false;
      try { if (containsJobPosting(JSON.parse(code))) return false; } catch { return false; }
    }
    const assignment = /^\s*window\s*(?:\.\s*__EXPIRED_JOB_DATA__|\[\s*(['"])__EXPIRED_JOB_DATA__\1\s*\])\s*=\s*/.exec(code);
    if (!assignment) {
      if (/__EXPIRED_JOB_DATA__(?:['"]\s*\])?\s*=/.test(code)) return false;
      continue;
    }
    if (attributeValues(attributes, 'src').length || new Set(types).size > 1
      || types.some((type) => !['', 'text/javascript', 'application/javascript', 'module'].includes(type))) return false;
    let seed: unknown;
    try { seed = JSON.parse(code.slice(assignment[0].length).trim().replace(/;$/, '').trim()); } catch { return false; }
    if (!seed || typeof seed !== 'object' || Array.isArray(seed)) return false;
    seeds.push(seed as Record<string, unknown>);
  }
  if (seeds.length !== 1 || normalizedSlug(seeds[0].slug) !== expectedSlug) return false;
  const seed = seeds[0];
  if ('title' in seed && typeof seed.title !== 'string') return false;
  const localized = seed.titleByLocale;
  if (localized !== undefined && (!localized || typeof localized !== 'object' || Array.isArray(localized)
    || Object.values(localized).some((title) => typeof title !== 'string'))) return false;
  return !hasRecordedJobIdentity({ title: seed.title, titleByLocale: localized as Record<string, unknown> | undefined });
}
