/**
 * Unit tests for the blog → feature contextual link injection plugin (A6).
 *
 * Verifies the pure injector function (`injectContextualLinks`) behaves as
 * expected on realistic HTML fixtures for all four locales. End-to-end
 * filesystem behavior is covered implicitly by the production build step —
 * we keep these tests focused on the transformation, not on I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  injectContextualLinks,
  countBodyWords,
} from '@/build-plugins/blogContextualLinksPlugin';
import {
  BLOG_CONTEXTUAL_LINKS,
  BLOG_LINKS_MAX_PER_ARTICLE,
  type BlogLinkLocale,
} from '@/build-plugins/blogContextualLinksData';

// A compact, realistic body that matches multiple IT rules:
// - "prezzi del diesel" → /prezzi-diesel/oggi/
// - "premi cassa malati" → /premi-cassa-malati/ticino/
// - "mercato del lavoro" → /mercato-lavoro-ticino/
// - "aziende che assumono" → /aziende-che-assumono/ticino/settimana-corrente/
const LONG_IT_BODY = `
<article>
  <h1>Guida frontalieri 2026</h1>
  <p>${'lorem ipsum dolor sit amet '.repeat(80)}</p>
  <p>I prezzi del diesel in Svizzera hanno subito un aumento del 12% rispetto al 2025, mentre in Italia la variazione è stata più contenuta.</p>
  <p>Per quanto riguarda i premi cassa malati in Ticino, gli aumenti 2026 colpiscono soprattutto le famiglie.</p>
  <p>Il mercato del lavoro in Ticino mostra segnali di espansione in diversi settori chiave.</p>
  <p>Tante aziende che assumono a Lugano e Mendrisio cercano profili tecnici con competenze multilingue.</p>
  <p>${'filler paragraph to push word count '.repeat(40)}</p>
</article>
`;

const SHORT_IT_BODY = `
<article>
  <h1>Breve aggiornamento</h1>
  <p>I prezzi del diesel sono aumentati.</p>
</article>
`;

describe('countBodyWords', () => {
  it('returns 0 for empty HTML', () => {
    expect(countBodyWords('')).toBe(0);
  });
  it('strips tags and counts visible words', () => {
    expect(countBodyWords('<p>one two three</p>')).toBe(3);
  });
  it('ignores inline script content', () => {
    expect(countBodyWords('<p>visible</p><script>alert("x")</script>')).toBe(1);
  });
});

describe('injectContextualLinks — IT', () => {
  it('injects up to maxLinks per article', () => {
    const result = injectContextualLinks(LONG_IT_BODY, 'it');
    expect(result.injected.length).toBeGreaterThan(0);
    expect(result.injected.length).toBeLessThanOrEqual(BLOG_LINKS_MAX_PER_ARTICLE);
  });

  it('preserves the matched text as anchor text', () => {
    const result = injectContextualLinks(LONG_IT_BODY, 'it');
    for (const ij of result.injected) {
      expect(ij.anchorText.length).toBeGreaterThan(0);
      expect(result.html).toContain(`>${ij.anchorText}</a>`);
    }
  });

  it('produces exactly one link per chosen target URL', () => {
    const result = injectContextualLinks(LONG_IT_BODY, 'it');
    const targets = result.injected.map((ij) => ij.targetUrl);
    const unique = new Set(targets);
    expect(unique.size).toBe(targets.length);
  });

  it('is idempotent: running the injector twice yields no new links', () => {
    const pass1 = injectContextualLinks(LONG_IT_BODY, 'it');
    const pass2 = injectContextualLinks(pass1.html, 'it');
    // Second pass must not inject anything (targets already present).
    expect(pass2.injected).toHaveLength(0);
    expect(pass2.html).toBe(pass1.html);
  });

  it('skips articles shorter than 500 words (noMatch because rules gated out)', () => {
    const result = injectContextualLinks(SHORT_IT_BODY, 'it');
    expect(result.injected).toHaveLength(0);
  });

  it('never inserts a link inside a heading', () => {
    const htmlWithHeading = `
      <article>
        <h1>Prezzi del diesel in Ticino — titolo</h1>
        <p>${'filler '.repeat(550)}</p>
        <p>I prezzi del diesel sono aumentati in tutta la regione.</p>
      </article>`;
    const result = injectContextualLinks(htmlWithHeading, 'it');
    // Verify: anchor is NOT in the <h1>, but <p> below still got modified.
    expect(result.html).toMatch(/<h1>Prezzi del diesel in Ticino — titolo<\/h1>/);
    if (result.injected.length > 0) {
      const anchorIdx = result.html.indexOf('<a ');
      const h1End = result.html.indexOf('</h1>');
      expect(anchorIdx).toBeGreaterThan(h1End);
    }
  });

  it('never nests an anchor inside an existing <a>', () => {
    const htmlWithAnchor = `
      <article>
        <p>${'filler '.repeat(550)}</p>
        <p>Vedi anche <a href="/approfondimento/">i prezzi del diesel in Ticino</a> e altri articoli.</p>
        <p>I prezzi del diesel in Ticino sono molto discussi in questi giorni.</p>
      </article>`;
    const result = injectContextualLinks(htmlWithAnchor, 'it');
    // The existing <a>-wrapped text must survive untouched.
    expect(result.html).toContain('<a href="/approfondimento/">i prezzi del diesel in Ticino</a>');
    // Count outermost <a ... /prezzi-diesel/oggi/: should be 0 or 1 total.
    const anchorsToTarget = (result.html.match(/href="\/prezzi-diesel\/oggi\/"/g) ?? []).length;
    expect(anchorsToTarget).toBeLessThanOrEqual(1);
  });

  it('skips rule whose target URL already appears in the document', () => {
    const htmlPreLinked = `
      <article>
        <p>${'filler '.repeat(550)}</p>
        <p>Come spiegato nella <a href="/prezzi-diesel/oggi/">pagina prezzi diesel</a>, gli aumenti sono significativi.</p>
        <p>Nuovi prezzi del diesel in Ticino ogni giorno.</p>
      </article>`;
    const result = injectContextualLinks(htmlPreLinked, 'it');
    const targets = result.injected.map((ij) => ij.targetUrl);
    expect(targets).not.toContain('/prezzi-diesel/oggi/');
  });

  it('preserves <code> / <pre> content verbatim', () => {
    const htmlWithCode = `
      <article>
        <p>${'filler '.repeat(550)}</p>
        <pre><code>prezzi del diesel = 1.85 CHF/L</code></pre>
        <p>I prezzi del diesel in Ticino sono aggiornati ogni giorno.</p>
      </article>`;
    const result = injectContextualLinks(htmlWithCode, 'it');
    expect(result.html).toContain('<pre><code>prezzi del diesel = 1.85 CHF/L</code></pre>');
  });

  it('preserves image tags with width/height/alt attributes', () => {
    const htmlWithImg = `
      <article>
        <p>${'filler '.repeat(550)}</p>
        <figure><img src="/img.png" width="600" height="400" alt="prezzi del diesel"></figure>
        <p>I prezzi del diesel sono saliti molto nelle ultime settimane.</p>
      </article>`;
    const result = injectContextualLinks(htmlWithImg, 'it');
    expect(result.html).toContain('<img src="/img.png" width="600" height="400" alt="prezzi del diesel">');
  });
});

describe('injectContextualLinks — per-locale matchers', () => {
  const fixtures: Record<BlogLinkLocale, string> = {
    it: `
      <article>
        <p>${'lorem '.repeat(550)}</p>
        <p>I prezzi del diesel in Ticino sono aumentati significativamente.</p>
        <p>Anche i premi cassa malati 2026 hanno subito un aumento.</p>
      </article>`,
    en: `
      <article>
        <p>${'lorem '.repeat(550)}</p>
        <p>The price of diesel in Switzerland has risen sharply.</p>
        <p>Health-insurance premiums in Ticino are reviewed annually.</p>
      </article>`,
    de: `
      <article>
        <p>${'lorem '.repeat(550)}</p>
        <p>Die Dieselpreise sind in den letzten Monaten stark gestiegen.</p>
        <p>Krankenkassenprämien im Tessin werden jedes Jahr neu berechnet.</p>
      </article>`,
    fr: `
      <article>
        <p>${'lorem '.repeat(550)}</p>
        <p>Le prix du diesel a fortement augmenté ces derniers mois.</p>
        <p>Les primes d'assurance-maladie au Tessin sont revues chaque année.</p>
      </article>`,
  };

  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    it(`injects at least one link for ${locale}`, () => {
      const result = injectContextualLinks(fixtures[locale], locale);
      expect(result.injected.length).toBeGreaterThan(0);
      // Every injected link's target URL must be present in the rewritten HTML.
      for (const ij of result.injected) {
        expect(result.html).toContain(`href="${ij.targetUrl}"`);
      }
    });

    it(`${locale} links target locale-appropriate URLs`, () => {
      const result = injectContextualLinks(fixtures[locale], locale);
      for (const ij of result.injected) {
        if (locale === 'it') {
          expect(ij.targetUrl.startsWith('/')).toBe(true);
          expect(ij.targetUrl.startsWith('/en/')).toBe(false);
        } else {
          expect(ij.targetUrl.startsWith(`/${locale}/`)).toBe(true);
        }
      }
    });
  }
});

describe('injectContextualLinks — edge cases', () => {
  it('returns unchanged HTML when no rules match', () => {
    const html = `
      <article>
        <p>${'lorem '.repeat(600)}</p>
        <p>Un articolo generico sul turismo in montagna senza alcun riferimento alle feature.</p>
      </article>`;
    const result = injectContextualLinks(html, 'it');
    expect(result.injected).toHaveLength(0);
    expect(result.html).toBe(html);
  });

  it('respects a custom maxLinks option', () => {
    const result = injectContextualLinks(LONG_IT_BODY, 'it', { maxLinks: 1 });
    expect(result.injected).toHaveLength(1);
  });

  it('emits anchor with data-contextual-link attribute for telemetry', () => {
    const result = injectContextualLinks(LONG_IT_BODY, 'it');
    if (result.injected.length > 0) {
      expect(result.html).toMatch(/<a href="[^"]+" data-contextual-link="[^"]+">/);
    }
  });

  it('handles HTML with nested tags inside the text segment', () => {
    const html = `
      <article>
        <p>${'lorem '.repeat(550)}</p>
        <p>I <strong>prezzi</strong> del diesel in Ticino sono aumentati.</p>
        <p>Nuovi prezzi del diesel ogni giorno in tutte le stazioni.</p>
      </article>`;
    const result = injectContextualLinks(html, 'it');
    // The <strong> block must survive verbatim; any anchor lands on a
    // separate text node further down.
    expect(result.html).toContain('<strong>prezzi</strong>');
  });
});

describe('BLOG_CONTEXTUAL_LINKS — config integrity', () => {
  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    it(`${locale} rule set is non-empty and uses absolute target URLs`, () => {
      const rules = BLOG_CONTEXTUAL_LINKS[locale];
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(rule.id).toBeTruthy();
        expect(rule.targetUrl.startsWith('/')).toBe(true);
        expect(rule.priority).toBeGreaterThan(0);
      }
    });

    it(`${locale} rule IDs are unique`, () => {
      const ids = BLOG_CONTEXTUAL_LINKS[locale].map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  }

  it('non-IT locales point only at locale-prefixed URLs', () => {
    for (const locale of ['en', 'de', 'fr'] as const) {
      for (const rule of BLOG_CONTEXTUAL_LINKS[locale]) {
        expect(rule.targetUrl.startsWith(`/${locale}/`)).toBe(true);
      }
    }
  });

  it('no locale links to /traffico-dogane/ yet (F8 not shipped)', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      for (const rule of BLOG_CONTEXTUAL_LINKS[locale]) {
        expect(rule.targetUrl.includes('traffico-dogane')).toBe(false);
        expect(rule.targetUrl.includes('border-wait')).toBe(false);
      }
    }
  });
});
