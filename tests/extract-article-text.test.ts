/**
 * Tests for scripts/lib/extract-article-text.mjs.
 *
 * Verifies the hierarchical extraction (JSON-LD → article → main → og-fallback
 * → naive) actually prefers signal over noise. The previous naive
 * `html.replace(/<[^>]+>/g, ' ').slice(0, 8000)` fed the generator and the
 * fact-checker the same 70%+ junk (nav, ads, footer), which structurally
 * forced the LLM to fill the gap by inventing facts → fact-check cascade.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs file, no .d.ts
import { extractArticleText } from '../scripts/lib/extract-article-text.mjs';

describe('extractArticleText', () => {
  it('returns empty result for empty input', () => {
    const r = extractArticleText('');
    expect(r.text).toBe('');
    expect(r.method).toBe('empty');
  });

  it('falls back to naive strip when nothing structured present', () => {
    const html = '<html><body>'
      + '<div>Nav: Home | About | Login</div>'
      + '<div>Long enough paragraph that exceeds the junk floor so the naive fallback still has something to return when no article/main/og is present in the HTML at all really truly nothing.</div>'
      + '</body></html>';
    const r = extractArticleText(html);
    // Either og-fallback (description meta missing → still triggers via body paragraphs)
    // or naive-fallback if og-fallback didn't reach 200 chars. Both are acceptable.
    expect(r.text.length).toBeGreaterThan(0);
    expect(['og-fallback', 'naive-fallback']).toContain(r.method);
  });

  it('prefers JSON-LD articleBody over surrounding noise', () => {
    const html = `<html><head>
      <script type="application/ld+json">
        ${JSON.stringify({
          '@type': 'NewsArticle',
          headline: 'Frontaliere news',
          articleBody: 'Il governo ticinese ha approvato una nuova misura per i frontalieri italiani. La decisione entrerà in vigore il 1 gennaio 2027. Il provvedimento riguarda specificamente i lavoratori transfrontalieri che risiedono nelle zone di confine.',
        })}
      </script>
    </head><body><nav>Menu</nav><div>Lots of nav junk and ads</div></body></html>`;
    const r = extractArticleText(html);
    expect(r.method).toBe('jsonld');
    expect(r.text).toContain('governo ticinese');
    expect(r.text).toContain('frontalieri italiani');
  });

  it('prefers <article> tag paragraphs over surrounding noise', () => {
    const html = `<html><body>
      <header><nav>Home | Mondo | Sport | Politica | Economia | Sport | Auto | Cinema | Tech</nav></header>
      <article>
        <h1>Frontalieri Ticino: stipendi in calo nel 2026</h1>
        <p>I salari medi dei lavoratori frontalieri in Canton Ticino sono diminuiti del 2,3 per cento nel primo trimestre 2026 rispetto allo stesso periodo dell anno precedente, secondo i dati dell USTAT pubblicati questa settimana.</p>
        <p>La tendenza riflette il rallentamento del settore manifatturiero ticinese e l aumento della concorrenza interna nel mercato del lavoro transfrontaliero, dopo l entrata in vigore del nuovo accordo fiscale del 2026.</p>
      </article>
      <aside>Newsletter signup, related articles, advertising junk</aside>
      <footer>Cookie policy, privacy, terms of service</footer>
    </body></html>`;
    const r = extractArticleText(html);
    expect(r.method).toBe('article-tag');
    expect(r.text).toContain('USTAT');
    expect(r.text).toContain('2,3 per cento');
    expect(r.text).not.toContain('Cookie policy');
    expect(r.text).not.toContain('Newsletter signup');
  });

  it('drops junk paragraphs (cookie banners, newsletter ctas, related links)', () => {
    const html = `<html><body><article>
      <p>Real story body paragraph that contains the actual facts we want to extract for fact-checking purposes and feed to the LLM for article generation.</p>
      <p>Iscriviti alla newsletter di Tio</p>
      <p>Leggi anche: altri articoli sul tema</p>
      <p>Cookie policy</p>
      <p>Another substantive paragraph with concrete information about the topic at hand, also at least forty characters long.</p>
    </article></body></html>`;
    const r = extractArticleText(html);
    expect(r.method).toBe('article-tag');
    expect(r.text).toContain('Real story body');
    expect(r.text).toContain('Another substantive');
    expect(r.text).not.toContain('Iscriviti');
    expect(r.text).not.toContain('Leggi anche');
    expect(r.text).not.toContain('Cookie policy');
  });

  it('respects maxChars cap', () => {
    const longText = 'X'.repeat(20000);
    const html = `<html><body><article><p>${longText}</p></article></body></html>`;
    const r = extractArticleText(html, { maxChars: 1000 });
    expect(r.text.length).toBeLessThanOrEqual(1000);
  });

  it('handles malformed HTML gracefully via naive fallback', () => {
    const r = extractArticleText('<<not really html at all>>');
    // jsdom is lenient — this might still parse. Either way we should not throw
    // and we should produce a string result with a defined method.
    expect(typeof r.text).toBe('string');
    expect(r.method).toBeDefined();
  });
});
