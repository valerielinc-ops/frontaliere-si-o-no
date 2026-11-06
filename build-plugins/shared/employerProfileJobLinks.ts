import { inlineScriptJson } from './inlineJsonScript';

/** Normalize a rendered internal href to the exact URL shape used by the job
 * sitemap allowlist. Unknown, external, query-bearing or malformed targets
 * stay unallowlisted so a stale/ambiguous card cannot leak through. */
function normalizeAllowlistedJobHref(
  rawHref: unknown,
  allowlist: ReadonlySet<string>,
): string | null {
  const raw = String(rawHref ?? '').trim().replace(/&amp;/g, '&');
  if (!raw || allowlist.size === 0) return null;

  let origin: string | null = null;
  for (const candidate of allowlist) {
    try {
      origin = new URL(candidate).origin;
      break;
    } catch {
      // A malformed registry entry is not a valid base for a rendered href.
    }
  }
  if (!origin) return null;

  try {
    const url = new URL(raw, `${origin}/`);
    if (url.origin !== origin || url.search || url.hash) return null;
    const pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    return `${origin}${pathname}`;
  } catch {
    return null;
  }
}

export function isAllowlistedJobHref(
  rawHref: unknown,
  allowlist: ReadonlySet<string>,
): boolean {
  const normalized = normalizeAllowlistedJobHref(rawHref, allowlist);
  return normalized !== null && allowlist.has(normalized);
}

const EMPLOYER_CARD_ITEM_RE = /<li\b[^>]*>[\s\S]*?<article\b[^>]*>[\s\S]*?<\/article>[\s\S]*?<\/li>/gi;
const EMPLOYER_CARD_CLASS_RE = /\bclass\s*=\s*(?:"[^"]*\bjc-card\b[^"]*"|'[^']*\bjc-card\b[^']*'|[^\s>]*\bjc-card\b)/i;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

function isItemListType(value: unknown): boolean {
  return value === 'ItemList' || (Array.isArray(value) && value.includes('ItemList'));
}

/**
 * Apply the active-detail registry to an already-rendered employer profile.
 * This is the final boundary for the sequential build: the profile emitter
 * must run before jobsSeoPagesPlugin because that producer consumes the
 * employer identity signal, so the post-consumer removes any cards and
 * ItemList entries that were rendered before the allowlist existed.
 */
export function filterEmployerProfileJobLinks(
  html: string,
  allowlist: ReadonlySet<string>,
  maxJobsListed = Number.POSITIVE_INFINITY,
): string {
  const cardLimit = Number.isFinite(maxJobsListed)
    ? Math.max(0, Math.floor(maxJobsListed))
    : Number.POSITIVE_INFINITY;
  let keptCardCount = 0;
  let filtered = html.replace(EMPLOYER_CARD_ITEM_RE, (item) => {
    if (!EMPLOYER_CARD_CLASS_RE.test(item)) return item;
    const href = item.match(HREF_RE);
    const rawHref = href?.[1] ?? href?.[2] ?? href?.[3] ?? null;
    if (!isAllowlistedJobHref(rawHref, allowlist)) return '';
    if (keptCardCount >= cardLimit) return '';
    keptCardCount++;
    return item;
  });

  filtered = filtered.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
    (full, attrs: string, body: string) => {
      const typeMatch = attrs.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const type = String(typeMatch?.[1] ?? typeMatch?.[2] ?? typeMatch?.[3] ?? '').toLowerCase();
      if (type !== 'application/ld+json') return full;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch (error) {
        if (/\bItemList\b/.test(body)) {
          throw new Error(`[employer-profile-pages] invalid ItemList JSON-LD: ${String(error)}`);
        }
        return full;
      }
      if (!isItemListType(parsed['@type'])) return full;

      const elements = Array.isArray(parsed.itemListElement) ? parsed.itemListElement : [];
      const kept = elements
        .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
        .filter((entry) => {
          const item = entry.item;
          const itemUrl = item && typeof item === 'object'
            ? (item as Record<string, unknown>).url
            : undefined;
          const target = itemUrl ?? entry.url;
          return isAllowlistedJobHref(target, allowlist);
        })
        .slice(0, cardLimit)
        .map((entry, index) => ({ ...entry, position: index + 1 }));

      if (kept.length === 0) return '';
      const unchanged = kept.length === elements.length
        && Number(parsed.numberOfItems) === kept.length
        && kept.every((entry, index) => Number(elements[index]?.position) === index + 1);
      if (unchanged) return full;

      parsed.numberOfItems = kept.length;
      parsed.itemListElement = kept;
      return `<script${attrs}>${inlineScriptJson(parsed)}</script>`;
    },
  );
  return filtered;
}
