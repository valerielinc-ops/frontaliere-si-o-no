/**
 * Regression gate for issue #5415 Fase 1 point 6, on REAL corpus text.
 *
 * The renderers touched by that fix serve every one of the corpus's 3.100+
 * articles, in four locales — 37.620 body sections as of 2026-08-08. The risk
 * of adding a table branch is not that tables render badly: it is that a `|`
 * somewhere in ordinary prose starts a table that was never meant to exist, on
 * an article nobody was looking at.
 *
 * `tests/__fixtures__/corpus-body-sample.json` is that population, sampled: per
 * locale, ≥10 real bodies drawn evenly across the alphabetical corpus (so the
 * mix is evergreen guides, news and job pages rather than one article's bodyN
 * run), in three groups — bodies with a real pipe table, bodies with a `|` in
 * plain prose, and bodies with no pipe at all. Regenerated with
 * `scripts/ci/sample-corpus-bodies.mjs` against a corpus checkout.
 *
 * The whole-corpus version of this ran once, at fix time, against the pre-fix
 * and post-fix renderer over all 37.620 bodies: 386 outputs changed, every one
 * of them a body containing a `|---|` separator, and zero raw separators left
 * in any rendered output. This file keeps that result from rotting.
 */
import { describe, expect, it } from 'vitest';

import {
  articleBodySectionLabel,
  cleanupArticleBodySections,
  renderArticleDerivedSectionsHtml,
} from '@/build-plugins/articleSeoFallback';
import { articleBodyPartsFromStaticArticle } from '@/services/runtimeArticleResolution';
import { tryRenderMdTable } from '@/components/community/BlogArticles';

import sample from './__fixtures__/corpus-body-sample.json';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const SEPARATOR_RX = /^\|(\s*:?-{2,}:?\s*\|)+\s*$/m;
const bodies = sample as Record<string, Record<string, string>>;

const render = (text: string) => cleanupArticleBodySections([{ key: 'body1', text }])[0]?.html ?? '';
/** What the visitor actually reads: tag names and attributes stripped out. */
const visibleText = (html: string) => html.replace(/<[^>]+>/g, '\n');

describe('corpus body rendering', () => {
  it('samples at least 10 real bodies per locale', () => {
    for (const locale of LOCALES) {
      expect(Object.keys(bodies[locale]).length, locale).toBeGreaterThanOrEqual(10);
    }
  });

  for (const locale of LOCALES) {
    describe(locale, () => {
      const entries = Object.entries(bodies[locale] ?? {});
      const withTable = entries.filter(([, text]) => SEPARATOR_RX.test(text));
      const withPipeProse = entries.filter(([, text]) => !SEPARATOR_RX.test(text) && text.includes('|'));
      const withoutPipe = entries.filter(([, text]) => !text.includes('|'));

      it('has all three sample groups', () => {
        expect(withTable.length).toBeGreaterThan(0);
        expect(withPipeProse.length).toBeGreaterThan(0);
        expect(withoutPipe.length).toBeGreaterThan(0);
      });

      it.each(withTable)('renders %s as a table with no pipes left in the text', (_id, text) => {
        const html = render(text);
        // A sample long enough to be truncated would assert the 1.800-char
        // budget rather than table rendering — sample-corpus-bodies.mjs caps
        // the source length to keep that out, and this says so when it slips.
        expect(html, 'sample truncated: lower MAX_LEN in sample-corpus-bodies.mjs').not.toContain('<p>…</p>');
        expect(html).toContain('<table>');
        expect(SEPARATOR_RX.test(visibleText(html))).toBe(false);
      });

      // The false-positive guard, and the reason this file exists.
      it.each([...withPipeProse, ...withoutPipe])('leaves %s untouched by the table branch', (_id, text) => {
        const html = render(text);
        expect(html).not.toContain('<table>');
        expect(html).not.toContain('<td>');
        expect(html).not.toContain('<th>');
      });

      // Counting only holds when nothing was cut: the 1.800-char budget drops
      // whole blocks, pipes included. `it`'s pipe-prose bodies are all long
      // (ten in the whole corpus, none short), so there it is the assertion
      // above that carries the guarantee.
      const shortPipeProse = withPipeProse.filter(([, text]) => !render(text).includes('<p>…</p>'));
      it.each(shortPipeProse)('keeps every pipe of %s in the rendered text', (_id, text) => {
        expect((visibleText(render(text)).match(/\|/g) ?? []).length)
          .toBe((text.match(/\|/g) ?? []).length);
      });

      // The full chain, on real text: corpus markdown → static HTML → the
      // markdown the SPA recovers on publication day → the parser that draws it.
      it.each(withTable)('round-trips %s back to a table the SPA parser accepts', (_id, text) => {
        const html = renderArticleDerivedSectionsHtml([
          { heading: articleBodySectionLabel(locale, 1), html: render(text) },
        ]);
        document.body.innerHTML = `<main class="seo-static-content"><article class="ft-blog-article">${html}</article></main>`;
        const article = document.querySelector('main.seo-static-content article.ft-blog-article');

        const [recovered] = articleBodyPartsFromStaticArticle(article);
        const tableBlock = recovered.split('\n\n').find((block) => block.startsWith('|'));
        expect(tableBlock, 'recovered markdown carries a pipe-table block').toBeDefined();
        expect(tryRenderMdTable(tableBlock!, 'rt')).not.toBeNull();
      });
    });
  }
});
