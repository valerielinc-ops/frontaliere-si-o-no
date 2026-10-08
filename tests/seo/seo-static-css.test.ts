import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const CSS_PATH = path.resolve(process.cwd(), 'public/assets/seo-static.css');
const SPA_CSS_PATH = path.resolve(process.cwd(), 'index.css');

describe('seo-static.css', () => {
  it('parses through the extracted static class tail', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');

    expect(css).not.toMatch(/\[\^/);
    expect(css).not.toMatch(/'\s*\+\s*[A-Z_]+\s*\+\s*'/);
    expect(css).not.toMatch(/\\(?:\(|\))/);

    const root = postcss.parse(css, { from: CSS_PATH });
    const selectors = new Set<string>();
    root.walkRules((rule) => {
      selectors.add(rule.selector);
    });

    expect(selectors.has('.s-XENO3U')).toBe(true);
    expect(selectors.has('.s-rBJXSS')).toBe(true);
    expect(selectors.has('.s-zzuqwx')).toBe(true);
  });

  // Regression guard (inverted from the #1249 clip-rect lock): the cluster
  // static body must be VISIBLE pre-hydration. These landings have no other
  // paintable content — `#root` is empty until the SPA chunks arrive — so an
  // off-screen/hidden recipe here means users stare at a blank page until
  // hydration (measured FCP ~4s desktop, worse on the 75% mobile share).
  // The duplication bug #1249 worked around (static body visible BELOW the
  // hydrated JobBoard) is fixed at the root in App.tsx, whose pre-paint
  // useLayoutEffect hides `main.cluster-seo-prose` on hydration — asserted
  // by the companion test below.
  it('keeps the .related-search-cluster body visible pre-hydration (no off-screen recipe)', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const root = postcss.parse(css, { from: CSS_PATH });

    let rule: postcss.Rule | undefined;
    root.walkRules('.related-search-cluster', (r) => {
      if (rule === undefined) rule = r;
    });
    expect(rule, '.related-search-cluster rule must exist in seo-static.css').toBeDefined();

    const decls = new Map<string, string>();
    rule!.walkDecls((d) => { decls.set(d.prop.toLowerCase(), d.value); });

    // No hide vector may reappear: any single one of these blanks the page
    // pre-hydration again.
    expect(decls.get('display')).not.toBe('none');
    expect(decls.get('visibility')).not.toBe('hidden');
    expect(decls.get('position')).not.toBe('absolute');
    expect(decls.get('width')).not.toBe('1px');
    expect(decls.get('height')).not.toBe('1px');
    expect(decls.has('clip')).toBe(false);
    expect(decls.has('clip-path')).toBe(false);
  });

  // Companion contract: App.tsx must hide `main.cluster-seo-prose` in the
  // same pre-paint useLayoutEffect that handles `main.seo-static-content`.
  // Without it, the now-visible static body duplicates the hydrated
  // JobBoard below the SPA view — the exact regression #1249 was papering
  // over with the clip-rect.
  it('App.tsx pre-paint toggle covers main.cluster-seo-prose', () => {
    const appSrc = fs.readFileSync(path.resolve(process.cwd(), 'App.tsx'), 'utf8');
    expect(appSrc).toMatch(/main\.seo-static-content,\s*main\.cluster-seo-prose/);
  });

  // The toggle must hide with INLINE !important: index.css carries
  // `main:not(...) { display: block !important }` (AdSense side-rail layout
  // guard) and any !important display rule beats a plain inline
  // `style.display = 'none'`. Observed live post-#1918: inline display:none
  // set, computed display still block → static body duplicated below the
  // hydrated JobBoard.
  it("App.tsx hides via setProperty('display','none','important')", () => {
    const appSrc = fs.readFileSync(path.resolve(process.cwd(), 'App.tsx'), 'utf8');
    expect(appSrc).toMatch(/setProperty\(\s*'display',\s*'none',\s*'important'\s*\)/);
  });

  // Il pre-footer statico (rail di discovery + pannello SEO) ha UNA sola fonte:
  // index.css. La home e' l'index.html di Vite e non carica questo foglio, quindi
  // una regola definita solo qui lascia i rail con i default del browser
  // (misurato in produzione il 2026-10-07: `display: inline` su ogni link). Una
  // seconda copia qui, oltre a non servire alla home, diverge dalla prima.
  it('does not carry a second copy of the static pre-footer rules', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const root = postcss.parse(css, { from: CSS_PATH });
    const offenders: string[] = [];

    root.walkRules((rule) => {
      for (const selector of rule.selectors) {
        if (/aside\.seo-footer-block|\.homepage-(discovery|language-switch|locale-main-nav)|\.hp-(language|discovery|canton|cross-hub)/.test(selector)) {
          offenders.push(selector);
        }
      }
    });

    expect(offenders).toEqual([]);
  });
});

// Cascade-source guard (inverted by the visible-pre-hydration contract).
//
// Every cluster page loads BOTH `seo-static.css` and the hashed SPA bundle
// compiled from `index.css`. With the static body now visible pre-hydration,
// the failure mode flipped: a later-source `.related-search-cluster` (or
// `.cluster-seo-prose`) rule in `index.css` that re-hides the block —
// display:none, visibility:hidden, the old clip-rect recipe — silently
// blanks ~180k cluster landings until the SPA paints, re-opening the
// blank-page regression this PR fixed without failing the
// seo-static.css-only guard above.
describe('index.css (SPA bundle source) cascade does not re-hide the cluster body', () => {
  const collectRules = (selectorPart: string): postcss.Rule[] => {
    const css = fs.readFileSync(SPA_CSS_PATH, 'utf8');
    const root = postcss.parse(css, { from: SPA_CSS_PATH });
    const matches: postcss.Rule[] = [];
    root.walkRules((rule) => {
      if (rule.selector.includes(selectorPart)) matches.push(rule);
    });
    return matches;
  };

  // Any single one of these declarations hides the body pre-hydration.
  const HIDE_VECTORS: Record<string, RegExp> = {
    display: /^none$/i,
    visibility: /^hidden$/i,
    position: /^absolute$/i,
    width: /^1px$/i,
    height: /^1px$/i,
    clip: /^rect\(/i,
    'clip-path': /^inset\(/i,
    opacity: /^0$/,
  };

  it('does not hide .related-search-cluster or .cluster-seo-prose pre-hydration', () => {
    for (const selectorPart of ['.related-search-cluster', 'cluster-seo-prose']) {
      for (const rule of collectRules(selectorPart)) {
        rule.walkDecls((d) => {
          const hideMatcher = HIDE_VECTORS[d.prop.toLowerCase()];
          if (!hideMatcher) return;
          expect(
            hideMatcher.test(d.value.trim()),
            `index.css rule "${rule.selector}" sets ${d.prop}:${d.value} — this ` +
              `re-hides the cluster static body pre-hydration, blanking ~180k ` +
              `cluster landings until the SPA paints. Hiding-on-hydration is ` +
              `App.tsx's job (pre-paint useLayoutEffect), not the stylesheet's.`,
          ).toBe(false);
        });
      }
    }
  });

  // Miss-class the substring guard above cannot see: a broad `main`/
  // `main:not(...)` selector that does NOT name the static classes but
  // forces `display` with !important (e.g. the AdSense side-rail guard
  // `main:not(.seo-static-content) { display:block !important }`) overrides
  // App.tsx's hide on every <main> it still matches. Any such rule must
  // exclude BOTH static-handoff mains.
  it('broad main display:!important rules exclude both static-handoff classes', () => {
    const css = fs.readFileSync(SPA_CSS_PATH, 'utf8');
    const root = postcss.parse(css, { from: SPA_CSS_PATH });
    root.walkRules((rule) => {
      if (!/(^|[,\s])main(:not\(|\s*\{|\s*,|$)/.test(rule.selector) && !rule.selector.startsWith('main:not(')) return;
      rule.walkDecls('display', (d) => {
        if (!d.important) return;
        for (const cls of ['.seo-static-content', '.cluster-seo-prose']) {
          expect(
            rule.selector.includes(`:not(${cls})`),
            `index.css rule "${rule.selector}" forces display:${d.value} !important ` +
              `on <main> without :not(${cls}) — it beats App.tsx's ` +
              `hide-at-hydration inline style and re-shows the static body below ` +
              `the hydrated SPA (live duplication observed post-#1918).`,
          ).toBe(true);
        }
      });
    });
  });

  // Contratto del pre-footer statico: le regole vivono nel foglio che la home
  // carica davvero, i link restano comodi al tocco, il pannello va a due
  // colonne solo se il markup porta i due contenitori di layout.
  describe('static pre-footer (discovery rails + SEO panel)', () => {
    const css = fs.readFileSync(SPA_CSS_PATH, 'utf8');
    const root = postcss.parse(css, { from: SPA_CSS_PATH });
    const rootRule = (selector: string): postcss.Rule | undefined => {
      let match: postcss.Rule | undefined;
      root.walkRules((rule) => {
        if (rule.parent === root && rule.selectors.includes(selector)) match = rule;
      });
      return match;
    };
    const mediaRule = (params: string, selector: string): postcss.Rule | undefined => {
      let match: postcss.Rule | undefined;
      root.walkAtRules('media', (media) => {
        if (media.params !== params) return;
        media.walkRules((rule) => {
          if (rule.selectors.includes(selector)) match = rule;
        });
      });
      return match;
    };

    it.each([
      '.homepage-discovery',
      '.homepage-language-switch',
      '.homepage-locale-main-nav',
      '.hp-discovery-heading',
      '.hp-discovery-links',
      '.hp-canton-summary',
      'aside.seo-footer-block',
      'aside.seo-footer-block .seo-fb-title',
    ])('styles %s in the stylesheet the homepage loads', (selector) => {
      expect(rootRule(selector), `${selector} must be styled in index.css`).toBeDefined();
    });

    it.each(['.hp-language-option', '.hp-discovery-pill', '.hp-canton-link', '.hp-cross-hub-link'])(
      'keeps %s at a 44px minimum touch target by default',
      (selector) => {
        let minHeight: string | undefined;
        rootRule(selector)?.walkDecls('min-height', (declaration) => {
          minHeight = declaration.value;
        });
        expect(minHeight, `${selector} needs a 44px minimum touch target`).toBe('44px');
        // La riga compatta e' ammessa solo dove c'e' un puntatore fine.
        expect(mediaRule('(hover: hover) and (pointer: fine)', selector)).toBeDefined();
      },
    );

    it('lays the SEO panel out in two columns only when the layout wrappers are present', () => {
      const gridRule = mediaRule('(min-width: 900px)', 'aside.seo-footer-block:has(> .seo-fb-head)');
      expect(gridRule?.toString()).toContain('display: grid');
      // Senza i wrapper (artefatto incrementale piu' vecchio) il pannello resta a blocco.
      expect(rootRule('aside.seo-footer-block')?.toString()).not.toContain('display: grid');
    });

    // Uno sticky sul titolo scivola sopra il disclaimer e sopra gli annunci
    // inseriti nel pannello: Chrome lo vincola al pannello, non alla riga.
    it('never pins a part of the SEO panel while scrolling', () => {
      const pinned: string[] = [];
      root.walkDecls('position', (declaration) => {
        const rule = declaration.parent as postcss.Rule;
        if (/sticky|fixed/.test(declaration.value) && /seo-footer-block/.test(rule.selector ?? '')) {
          pinned.push(rule.selector);
        }
      });
      expect(pinned).toEqual([]);
    });

    it('keeps the tools list responsive without boxing each entry', () => {
      const cards = rootRule('aside.seo-footer-block .seo-fb-cards');
      expect(cards?.toString()).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
      expect(mediaRule('(max-width: 640px)', 'aside.seo-footer-block .seo-fb-cards')?.toString())
        .toContain('grid-template-columns: 1fr');
      const card = rootRule('aside.seo-footer-block .seo-fb-card')?.toString() ?? '';
      expect(card).not.toMatch(/border|background/);
    });

    it('turns motion off for visitors who ask for less of it', () => {
      expect(mediaRule('(prefers-reduced-motion: reduce)', 'aside.seo-footer-block details[open] > .seo-fb-section-body')?.toString())
        .toContain('animation: none');
    });
  });
});
