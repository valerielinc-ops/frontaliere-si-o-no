/**
 * Derives the FIRST-PAINT layout reserve for `public/assets/seo-static.css`
 * out of that sheet itself, instead of hand-copying its rules into
 * `criticalCss.ts` a family at a time.
 *
 * Why derive instead of copy (issue #5001 point 3)
 * ────────────────────────────────────────────────
 * `seo-static.css` is loaded NON-render-blocking (the `media="print"` swap in
 * `htmlTemplate.asyncCssHeadBlock`), so between first paint and the swap every
 * element it styles renders with UA-default geometry and then snaps into place.
 * `criticalCss.ts` already answers that for four families by hand
 * (`SEO_STATIC_HERO_RESERVE_CSS`, `SEO_SEARCH_HUB_RESERVE_CSS`,
 * `SEO_ARTICLE_SHELL_RESERVE_CSS`, …) — one block per family, each written
 * after that family's CLS showed up in a trace. There are ~40 static families
 * and the sheet has ~1000 layout-bearing rules, so the hand-copied approach is
 * both incomplete (a family nobody measured keeps its shift) and a permanent
 * drift surface (AGENTS.md §6: a literal duplicated across ≥2 files).
 *
 * Deriving from the sheet closes both: the reserve is, by construction, the
 * sheet's own layout half, and it can never disagree with it.
 *
 * Why this is safe to emit BEFORE the sheet
 * ─────────────────────────────────────────
 * The output is unlayered, exactly like `seo-static.css` itself, and
 * `criticalCss.ts` is linked ahead of it in `<head>`. Equal specificity +
 * earlier source order = the real sheet always wins once it lands, so the
 * derived copy can only ever govern the pre-swap frame. That is also why only
 * LAYOUT declarations are kept: colour/background/shadow/transition are paint,
 * they cost render-blocking bytes and they cannot cause a layout shift.
 * `:hover`/`:focus`-style state variants are dropped for the same reason — no
 * pointer has interacted with anything at first paint.
 *
 * `@media print` blocks are dropped: they never apply to a screen first paint.
 *
 * Pure space reservation (AGENTS.md §7): no ad, content or markup is added or
 * removed — the same boxes exist before and after the swap.
 */

/**
 * Declarations that can move a box. `scrollbar-width` / `-ms-overflow-style`
 * and the `-webkit-line-clamp` pair are in the list on purpose: they are not
 * "classic" layout properties but they DO change the used size (a classic
 * scrollbar eats ~15px of an `overflow-x:auto` row; an un-clamped label wraps
 * to more lines), and both were measured as real residual shifts on the hub
 * sub-nav.
 */
const LAYOUT_PROPS: ReadonlySet<string> = new Set([
  'display', 'box-sizing', 'position',
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
  'grid-auto-flow', 'grid-auto-rows', 'grid-auto-columns',
  'gap', 'column-gap', 'row-gap',
  'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
  'align-items', 'align-self', 'align-content', 'justify-content', 'justify-items',
  'justify-self', 'place-items', 'place-content', 'order',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'margin-inline', 'margin-inline-start', 'margin-inline-end', 'margin-block',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'padding-inline', 'padding-block',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'inline-size', 'block-size',
  'font-size', 'line-height', 'font-weight', 'letter-spacing', 'text-transform',
  'font-family', 'font-style',
  'list-style', 'list-style-type', 'list-style-position',
  'border-width', 'border-top-width', 'border-right-width', 'border-bottom-width',
  'border-left-width', 'border-style', 'border-inline-width', 'border-block-width',
  'white-space', 'text-overflow', 'overflow', 'vertical-align', 'aspect-ratio',
  'float', 'clear', 'text-align', 'word-break', 'overflow-wrap', 'text-wrap',
  'top', 'right', 'bottom', 'left', 'inset',
  'scrollbar-width', '-ms-overflow-style', '-webkit-line-clamp', '-webkit-box-orient',
]);

/**
 * `border` shorthands are half layout (the WIDTH is part of the border-box)
 * and half paint (the colour). `seo-static.css` writes them as
 * `border:1px solid var(--color-edge)`, so keeping the property whole would
 * drag a colour into a block that must not paint, while dropping it would
 * under-reserve every carded box by its border width on each side — the reason
 * the older hand-written blocks in `criticalCss.ts` spell out
 * `border:1px solid transparent`. We split them instead: width + style are
 * emitted as longhands, the colour is discarded.
 *
 * `border-style` has to come along: a width with no style computes to a
 * zero-width border, so emitting the width alone would reserve nothing.
 */
const BORDER_SHORTHANDS: Record<string, string> = {
  border: 'border-width',
  'border-top': 'border-top-width',
  'border-right': 'border-right-width',
  'border-bottom': 'border-bottom-width',
  'border-left': 'border-left-width',
  'border-block': 'border-block-width',
  'border-inline': 'border-inline-width',
};

const BORDER_STYLE_KEYWORDS = new Set([
  'none', 'hidden', 'dotted', 'dashed', 'solid', 'double',
  'groove', 'ridge', 'inset', 'outset',
]);

const BORDER_WIDTH_KEYWORDS = new Set(['thin', 'medium', 'thick']);

/** Top-level whitespace split (keeps `var(--x, y)` / `calc(…)` intact). */
function splitTokens(value: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of value) {
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    if (/\s/.test(c) && depth === 0) {
      if (current) tokens.push(current);
      current = '';
    } else current += c;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** `1px solid var(--color-edge)` → `[['border-width','1px'],['border-style','solid']]`. */
function expandBorderShorthand(widthProp: string, value: string): [string, string][] {
  const styleProp = widthProp.replace(/width$/, 'style');
  let width = '';
  let style = '';
  for (const token of splitTokens(value)) {
    const low = token.toLowerCase();
    if (BORDER_STYLE_KEYWORDS.has(low)) style = low;
    else if (BORDER_WIDTH_KEYWORDS.has(low) || /^[\d.]/.test(low) || low.startsWith('calc(')) width = token;
  }
  if (!width && !style) return [];
  return [
    [widthProp, width || 'medium'],
    // No style keyword in the shorthand means the border is `none` — i.e. zero
    // used width. Mirror that instead of inventing a solid border.
    [styleProp, style || 'none'],
  ];
}

/** State variants: nothing is hovered/focused/checked at first paint. */
const STATE_VARIANT = /:(hover|focus|active|visited|focus-visible|focus-within|target|checked)/;

/** At-rules whose body holds nested style rules (everything else is skipped). */
const NESTING_AT_RULES = ['@media', '@supports', '@layer', '@container'];

interface StyleRule {
  /** Enclosing at-rule preludes, outermost first. */
  readonly at: readonly string[];
  readonly selector: string;
  readonly body: string;
}

/** Index of the `}` that closes the `{` at `open`, skipping quoted strings. */
function closingBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    const c = css[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < css.length && css[i] !== quote) {
        if (css[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return css.length - 1;
}

/** Flattens a stylesheet into style rules, carrying the at-rule stack along. */
function parseRules(css: string, at: readonly string[] = []): StyleRule[] {
  const out: StyleRule[] = [];
  let i = 0;
  while (i < css.length) {
    const next = /[{};]/.exec(css.slice(i));
    if (!next) break;
    const at0 = i + next.index;
    if (next[0] !== '{') {
      i = at0 + 1;
      continue;
    }
    const prelude = css.slice(i, at0).trim();
    const end = closingBrace(css, at0);
    const body = css.slice(at0 + 1, end);
    if (prelude.startsWith('@')) {
      const low = prelude.toLowerCase();
      // @font-face / @keyframes / @property hold declarations, not rules.
      if (NESTING_AT_RULES.some((name) => low.startsWith(name))) {
        out.push(...parseRules(body, [...at, prelude]));
      }
    } else if (prelude) {
      out.push({ at, selector: prelude, body });
    }
    i = end + 1;
  }
  return out;
}

/** Splits a declaration block, ignoring `;` nested inside `calc(…)`/`var(…)`. */
function parseDeclarations(body: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let current = '';
  const flush = (): void => {
    const idx = current.indexOf(':');
    if (idx > 0) out.push([current.slice(0, idx).trim().toLowerCase(), current.slice(idx + 1).trim()]);
    current = '';
  };
  for (const c of body) {
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    if (c === ';' && depth === 0) flush();
    else current += c;
  }
  if (current.trim()) flush();
  return out;
}

/**
 * The layout-only, state-free, screen-only projection of `css`, in SOURCE
 * ORDER (the cascade inside a single unlayered sheet is order-sensitive, so
 * reordering would change which rule wins at first paint).
 */
export function deriveSeoStaticFirstPaintReserve(css: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const chunks: { at: readonly string[]; selector: string; decls: Map<string, string> }[] = [];

  for (const rule of parseRules(withoutComments)) {
    // `@media print` never applies to a screen first paint.
    if (rule.at.some((prelude) => /\bprint\b/i.test(prelude))) continue;
    // A rule inside `@layer` cannot be reproduced faithfully — this block is
    // emitted unlayered, so copying it would change its cascade rank rather
    // than reserve its box. `seo-static.css` has no layers today; if one ever
    // appears, skipping is the safe answer.
    if (rule.at.some((prelude) => prelude.toLowerCase().startsWith('@layer'))) continue;
    const selectors = rule.selector
      .split(',')
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter((s) => s.length > 0 && !STATE_VARIANT.test(s));
    if (selectors.length === 0) continue;

    // Last declaration wins inside one block, as in the cascade.
    const decls = new Map<string, string>();
    for (const [prop, value] of parseDeclarations(rule.body)) {
      if (LAYOUT_PROPS.has(prop)) {
        decls.set(prop, value);
        continue;
      }
      const borderWidthProp = BORDER_SHORTHANDS[prop];
      if (borderWidthProp) {
        for (const [p, v] of expandBorderShorthand(borderWidthProp, value)) decls.set(p, v);
      }
    }
    if (decls.size === 0) continue;

    const selector = selectors.join(',');
    // Conditional groups are carried over verbatim so a rule that only applies
    // at one breakpoint keeps applying only there. (`@layer` is excluded above;
    // everything else that can wrap a style rule is a condition, not a rank.)
    const media = rule.at.filter((prelude) => /^@(media|supports|container)/i.test(prelude));
    const previous = chunks[chunks.length - 1];
    // Adjacent blocks with the same selector under the same media condition are
    // merged so the reserve does not repeat a selector the sheet split for
    // readability.
    if (previous && previous.selector === selector && sameAt(previous.at, media)) {
      for (const [prop, value] of decls) previous.decls.set(prop, value);
      continue;
    }
    chunks.push({ at: media, selector, decls });
  }

  let out = '';
  let openAt: readonly string[] = [];
  for (const chunk of chunks) {
    if (!sameAt(openAt, chunk.at)) {
      out += '}'.repeat(openAt.length);
      out += chunk.at.map((prelude) => `${prelude}{`).join('');
      openAt = chunk.at;
    }
    const declText = [...chunk.decls].map(([prop, value]) => `${prop}:${value}`).join(';');
    out += `${chunk.selector}{${declText}}`;
  }
  out += '}'.repeat(openAt.length);
  return out;
}

function sameAt(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
