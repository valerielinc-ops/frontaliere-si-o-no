/**
 * Contextual-link injection — the pure transform, with ZERO runtime imports.
 *
 * Split out of blogContextualLinksPlugin.ts for the post-walk worker (#4959 §4).
 * The worker resolves its transforms with plain Node ESM (the tsx loader is NOT
 * active inside a worker thread — `new Worker(url, { execArgv: ['--import','tsx'] })`
 * does not activate it, verified directly). Importing the plugin module dragged in
 * the site-shell bootstrap and a 48-module graph full of extensionless specifiers
 * and attribute-less JSON imports, none of which plain Node resolves, so every
 * `build-locale` job failed with ERR_MODULE_NOT_FOUND on articlesSiteShellBootstrap
 * and POST_WALK_WORKERS had to be pinned to 1.
 *
 * Adding explicit extensions was tried and measured: it fixes the specifiers and
 * then dies on the JSON imports. The fix is to stop the worker needing that graph
 * at all — this module imports only TYPES (erased at runtime) and takes everything
 * it would have read off the site shell as an explicit `defaults` parameter.
 */
import type {
  ArticleContextualLinkRule as BlogContextualLinkRule,
  ArticleLocale as BlogLinkLocale,
} from '../siteShell';

/**
 * The slice of SiteShellContract the injector needs. Resolved once by the caller
 * — in-process from getSiteShell(), or in the worker from workerData — so this
 * module never reaches for the shell itself.
 */
export interface ContextualLinkDefaults {
  maxLinksPerArticle: number;
  rulesByLocale: Readonly<Partial<Record<BlogLinkLocale, readonly BlogContextualLinkRule[]>>>;
  defaultMinWords: number;
}

export type { BlogContextualLinkRule, BlogLinkLocale };

/**
 * Tags whose text content must never be mutated. Matters for HTML validity
 * (nested <a> is not allowed), readability (headings stay clean), and
 * semantics (code blocks stay literal).
 */
const BLACKLISTED_TAGS = new Set([
  'a',
  'code',
  'pre',
  'script',
  'style',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'nav', // already-injected related-links and breadcrumb navs
  'textarea',
  'title',
]);

// ── HTML segment tokenizer ────────────────────────────────────────

interface HtmlSegment {
  /** `text` = mutable prose; `tag` = raw markup we must pass through. */
  readonly kind: 'text' | 'tag';
  /** Raw substring (preserves original whitespace, entities, case). */
  readonly raw: string;
  /**
   * For `text` segments: the stack of open tag names at the moment this
   * segment begins (lowercased, innermost last). Empty stack means the text
   * is at the document root.
   */
  readonly tagStack: readonly string[];
}

/**
 * Split a full HTML string into alternating text/tag segments while tracking
 * the open-tag stack for every text slice. This is a deliberately simple
 * tokenizer — it handles the subset of HTML we produce (no CDATA, no
 * processing instructions, no weird script fragments).
 */
function tokenizeHtml(html: string): HtmlSegment[] {
  const out: HtmlSegment[] = [];
  const stack: string[] = [];
  let i = 0;
  const n = html.length;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      // Trailing text with no further tags.
      const raw = html.slice(i);
      if (raw.length > 0) out.push({ kind: 'text', raw, tagStack: [...stack] });
      break;
    }

    if (lt > i) {
      out.push({ kind: 'text', raw: html.slice(i, lt), tagStack: [...stack] });
    }

    // Handle comments and doctype/CDATA-like runs as opaque tag segments.
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      const close = end === -1 ? n : end + 3;
      out.push({ kind: 'tag', raw: html.slice(lt, close), tagStack: [...stack] });
      i = close;
      continue;
    }
    if (html.startsWith('<!', lt)) {
      const end = html.indexOf('>', lt + 2);
      const close = end === -1 ? n : end + 1;
      out.push({ kind: 'tag', raw: html.slice(lt, close), tagStack: [...stack] });
      i = close;
      continue;
    }

    const gt = html.indexOf('>', lt + 1);
    if (gt === -1) {
      // Malformed — emit remainder as text and bail.
      out.push({ kind: 'text', raw: html.slice(lt), tagStack: [...stack] });
      break;
    }

    const tagRaw = html.slice(lt, gt + 1);
    const inner = tagRaw.slice(1, -1).trim();
    const isClose = inner.startsWith('/');
    const isSelfClose = inner.endsWith('/');
    const nameMatch = inner.replace(/^\//, '').match(/^([A-Za-z][A-Za-z0-9-]*)/);
    const tagName = nameMatch ? nameMatch[1].toLowerCase() : '';

    out.push({ kind: 'tag', raw: tagRaw, tagStack: [...stack] });

    if (tagName === 'script' || tagName === 'style') {
      // Skip to the matching closing tag — their inner content is opaque.
      if (!isClose && !isSelfClose) {
        const closeNeedle = `</${tagName}`;
        const closeIdx = html.toLowerCase().indexOf(closeNeedle, gt + 1);
        if (closeIdx === -1) { i = n; continue; }
        const closeGt = html.indexOf('>', closeIdx);
        const innerText = html.slice(gt + 1, closeIdx);
        const closingRaw = closeGt === -1 ? html.slice(closeIdx) : html.slice(closeIdx, closeGt + 1);
        // Emit the inner block as a `tag` segment so we never mutate it.
        stack.push(tagName);
        out.push({ kind: 'tag', raw: innerText, tagStack: [...stack] });
        out.push({ kind: 'tag', raw: closingRaw, tagStack: [...stack] });
        stack.pop();
        i = closeGt === -1 ? n : closeGt + 1;
        continue;
      }
    }

    if (tagName) {
      if (isClose) {
        // Pop until we find a matching tag (tolerant of malformed HTML).
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s] === tagName) {
            stack.splice(s, stack.length - s);
            break;
          }
        }
      } else if (!isSelfClose && !isVoidElement(tagName)) {
        stack.push(tagName);
      }
    }

    i = gt + 1;
  }

  return out;
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);
function isVoidElement(name: string): boolean {
  return VOID_ELEMENTS.has(name);
}

function stackHasBlacklisted(stack: readonly string[]): boolean {
  for (const t of stack) {
    if (BLACKLISTED_TAGS.has(t)) return true;
  }
  return false;
}

// ── Link injection ────────────────────────────────────────────────

/**
 * Rough article-body word count. Cheap — strips tags, counts whitespace-
 * separated tokens. Good enough for the minArticleWords gate.
 */
export function countBodyWords(html: string): number {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped ? stripped.split(' ').length : 0;
}

export interface InjectionResult {
  readonly html: string;
  readonly injected: readonly InjectedLink[];
  readonly skipped: SkipReason | null;
}

export type SkipReason =
  | 'tooShort'
  | 'noRules'
  | 'noMatch';

export interface InjectedLink {
  readonly ruleId: string;
  readonly targetUrl: string;
  readonly anchorText: string;
}

/**
 * Escape a string for inclusion inside an HTML attribute value.
 */
function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface MatchCandidate {
  readonly rule: BlogContextualLinkRule;
  readonly segmentIndex: number;
  readonly startInSegment: number;
  readonly endInSegment: number;
  readonly matchedText: string;
}

/**
 * Inject contextual links into a blog-article HTML string.
 *
 * Pure function — no I/O. Exported for unit testing.
 */
export function injectContextualLinksWith(
  html: string,
  locale: BlogLinkLocale,
  defaults: ContextualLinkDefaults,
  opts?: { maxLinks?: number; rules?: readonly BlogContextualLinkRule[] },
): InjectionResult {
  const maxLinks = opts?.maxLinks ?? defaults.maxLinksPerArticle;
  const rules = opts?.rules ?? defaults.rulesByLocale[locale] ?? [];
  if (rules.length === 0) {
    return { html, injected: [], skipped: 'noRules' };
  }

  const wordCount = countBodyWords(html);

  const segments = tokenizeHtml(html);

  // Track which target URLs are already present (idempotency) or will be
  // inserted (dedup per article).
  const existingTargets = new Set<string>();
  const existingHrefRx = /href\s*=\s*"([^"]+)"/gi;
  // Count of contextual links already present (from a previous build pass) so
  // re-running the injector never exceeds the per-article cap.
  const existingContextualRx = /data-contextual-link\s*=\s*"/gi;
  let existingContextualCount = 0;
  for (const seg of segments) {
    if (seg.kind !== 'tag') continue;
    let hm: RegExpExecArray | null;
    existingHrefRx.lastIndex = 0;
    while ((hm = existingHrefRx.exec(seg.raw)) !== null) {
      existingTargets.add(hm[1]);
    }
    existingContextualRx.lastIndex = 0;
    while (existingContextualRx.exec(seg.raw) !== null) {
      existingContextualCount++;
    }
  }

  const remainingBudget = Math.max(0, maxLinks - existingContextualCount);
  if (remainingBudget === 0) {
    return { html, injected: [], skipped: 'noMatch' };
  }

  // Gather all candidate matches, respecting minArticleWords per rule.
  const candidates: MatchCandidate[] = [];
  for (const rule of rules) {
    if (existingTargets.has(rule.targetUrl)) continue;
    const effectiveMinWords = rule.minArticleWords ?? defaults.defaultMinWords;
    if (wordCount < effectiveMinWords) continue;

    // RegExp re-use: clone with a fresh global flag for stateful .exec().
    const flags = (rule.keywordPattern.flags.includes('g')
      ? rule.keywordPattern.flags
      : rule.keywordPattern.flags + 'g');
    const rx = new RegExp(rule.keywordPattern.source, flags);

    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      if (seg.kind !== 'text') continue;
      if (stackHasBlacklisted(seg.tagStack)) continue;
      // Need at least one <p>/<section>/<article>/<body> ancestor to avoid
      // whitespace-only root text nodes. The SPA bundle pages wrap bodies in
      // <article>; the flat pages wrap in <main>. Both are safe.
      if (seg.raw.trim().length === 0) continue;

      rx.lastIndex = 0;
      const m = rx.exec(seg.raw);
      if (m && m.index !== undefined) {
        candidates.push({
          rule,
          segmentIndex: si,
          startInSegment: m.index,
          endInSegment: m.index + m[0].length,
          matchedText: m[0],
        });
      }
    }
  }

  if (candidates.length === 0) {
    return { html, injected: [], skipped: 'noMatch' };
  }

  // Sort: higher priority first, then earlier segment, then earlier offset.
  // Ties on everything else keep a stable order by array insertion.
  const sorted = [...candidates].sort((a, b) => {
    if (a.rule.priority !== b.rule.priority) return b.rule.priority - a.rule.priority;
    if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex;
    return a.startInSegment - b.startInSegment;
  });

  // Greedy selection: at most one link per target URL, at most one per segment
  // (avoids visually clustered anchors), at most `maxLinks` total.
  const chosen: MatchCandidate[] = [];
  const usedTargets = new Set<string>();
  const usedSegments = new Set<number>();
  for (const c of sorted) {
    if (chosen.length >= remainingBudget) break;
    if (usedTargets.has(c.rule.targetUrl)) continue;
    if (usedSegments.has(c.segmentIndex)) continue;
    chosen.push(c);
    usedTargets.add(c.rule.targetUrl);
    usedSegments.add(c.segmentIndex);
  }

  if (chosen.length === 0) {
    return { html, injected: [], skipped: 'noMatch' };
  }

  // Apply injections: rebuild each modified segment with the anchor spliced
  // in. We only ever mutate ONE span per segment so string math stays simple.
  const segmentInjection = new Map<number, MatchCandidate>();
  for (const c of chosen) segmentInjection.set(c.segmentIndex, c);

  const rebuiltSegments = segments.map((seg, idx) => {
    const injection = segmentInjection.get(idx);
    if (!injection) return seg.raw;
    const before = seg.raw.slice(0, injection.startInSegment);
    const after = seg.raw.slice(injection.endInSegment);
    const anchor = `<a href="${escAttr(injection.rule.targetUrl)}" data-contextual-link="${escAttr(injection.rule.id)}">${injection.matchedText}</a>`;
    return `${before}${anchor}${after}`;
  });

  const rebuiltHtml = rebuiltSegments.join('');
  const injected: InjectedLink[] = chosen.map((c) => ({
    ruleId: c.rule.id,
    targetUrl: c.rule.targetUrl,
    anchorText: c.matchedText,
  }));
  return { html: rebuiltHtml, injected, skipped: wordCount < 500 ? 'tooShort' : null };
}
