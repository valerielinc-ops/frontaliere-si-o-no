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
import { JSDOM } from 'jsdom';
import { extractArticleText, extractPublishedDate } from '../scripts/lib/extract-article-text.mjs';

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

  it('preserves active noscript fallback markup when scripting is disabled', () => {
    const html = `<main><noscript>
      <h1>Headline from the no-script article page</h1>
      <p>First substantive fallback paragraph with facts that identify the real article for source validation.</p>
      <p>Second substantive fallback paragraph with the article context and details needed by the generator.</p>
    </noscript></main>`;
    // JSDOM parses with scripting disabled by default. The explicit option is
    // still needed so cleanup keeps the fallback if a noscript node is present.
    const noScriptResult = extractArticleText(html, { scriptingDisabled: true });
    expect(noScriptResult.method).toBe('main-tag');
    expect(noScriptResult.text).toContain('First substantive fallback paragraph');
    expect(noScriptResult.text).toContain('Second substantive fallback paragraph');
  });

  it('normalizes nested noscript markup preserved as a text node', () => {
    const html = `<main><noscript>&lt;div&gt;
      &lt;p&gt;First substantive fallback paragraph with facts that identify the real article for source validation.&lt;/p&gt;
      &lt;p&gt;Second substantive fallback paragraph with the article context and details needed by the generator.&lt;/p&gt;
    &lt;/div&gt;</noscript></main>`;
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.method).toBe('main-tag');
    expect(result.text).toContain('First substantive fallback paragraph');
    expect(result.text).toContain('Second substantive fallback paragraph');
    expect(result.text).not.toContain('&lt;p&gt;');
  });

  it('fails closed when raw-text markup inside noscript is malformed', () => {
    const malformedPayload = 'Malformed raw-text payload that must not truncate or contaminate the remaining source text.';
    const outerParagraph = 'Stable article paragraph outside the malformed fallback remains available to the extractor.';
    const html = '<main><noscript>'
      + '&lt;script type="application/ld+json"&gt;{"articleBody":"unterminated"}'
      + `&lt;p&gt;${malformedPayload}&lt;/p&gt;`
      + '</noscript>'
      + `<p>${outerParagraph}</p></main>`;
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).toContain(outerParagraph);
    expect(result.text).not.toContain(malformedPayload);
    expect(result.text).not.toContain('unterminated');
  });

  it('validates unescaped raw-text markup before trusting the parsed noscript DOM', () => {
    const malformedParagraph = 'Paragraph before an unclosed raw-text element belongs to the rejected fallback.';
    const outerParagraph = 'Stable source prose after the malformed noscript remains available to the extractor.';
    const html = '<main><noscript>'
      + `<p>${malformedParagraph}</p>`
      + '<script type="application/ld+json">{"articleBody":"unterminated"}'
      + '</noscript>'
      + `<p>${outerParagraph}</p></main>`;
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).toContain(outerParagraph);
    expect(result.text).not.toContain(malformedParagraph);
    expect(result.text).not.toContain('unterminated');
  });

  it('preserves outer prose after a source-level noscript end tag', () => {
    const outerParagraph = 'Reliable outer content after a source-level noscript close remains available.';
    const html = '<main><noscript><script type="application/ld+json">'
      + '{"articleBody":"unterminated"}</noscript>'
      + `<p>${outerParagraph}</p></main>`;
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).toContain(outerParagraph);
  });

  it('does not expose outer prose after a plaintext raw-text noscript end tag', () => {
    const html = '<main><noscript><plaintext>RAW</noscript><p>OUTER</p></main>';
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).not.toContain('OUTER');
    expect(result.text).toBe('');
  });

  it('preserves an unambiguously paired source tail after an unclosed raw-text tag', () => {
    const rejected = 'Paragraph before the unclosed raw-text element belongs to the rejected fallback.';
    const recovered = 'Paragraph after the malformed raw-text prefix remains recoverable source prose.';
    const html = '<main><noscript>'
      + `<p>${rejected}</p>`
      + `<script>\n<p>${recovered}</p>`;
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).toContain(recovered);
    expect(result.text).not.toContain(rejected);
  });

  it('does not expose code after a recovered paragraph tail close', () => {
    const html = '<main><noscript><script><p>ok</p> const leaked = 1;</noscript></main>';
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).not.toContain('leaked');
    expect(result.text).toBe('');
  });

  it.each([
    ['JavaScript string', payload => `const template = "<p>${payload}</p>";`],
    ['JSON string', payload => `{"html":"<p>${payload}</p>"}`],
    ['block comment', payload => `/* <p>${payload}</p> */`],
    ['JavaScript regex literal', payload => `const template = /<p>${payload}/;`],
  ])('does not promote paragraph-shaped markup inside an unclosed raw-text %s', (_label, rawText) => {
    const payload = 'Ambiguous paragraph-shaped script payload must remain excluded from source text.';
    const html = `<main><noscript><script>${rawText(payload)}</main>`;
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).not.toContain(payload);
    expect(result.text).toBe('');
  });

  it('fails closed on an ambiguous JavaScript division before a paragraph-shaped tail', () => {
    const html = '<main><noscript><script>const value = a / b / c; '
      + '<p>DIVISION_PAYLOAD</p></main>';
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).not.toContain('DIVISION_PAYLOAD');
    expect(result.text).toBe('');
  });

  it('recognizes a real noscript boundary after ordinary JavaScript division', () => {
    const outerParagraph = 'Outer source prose after a single division slash remains available to extraction.';
    const html = '<main><noscript><script>const ratio = 4 / 2;'
      + `</noscript><p>${outerParagraph}</p></main>`;
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).toContain(outerParagraph);
  });

  it('recognizes a real noscript boundary after a regex body on a control-flow branch', () => {
    const outerParagraph = 'Outer source prose after a control-flow regex remains available to extraction.';
    const html = '<main><noscript><script>if (x) /</;'
      + `</noscript><p>${outerParagraph}</p></main>`;
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).toContain(outerParagraph);
  });

  it('ignores raw-text-looking openers inside HTML comments', () => {
    const outerParagraph = 'Editorial prose after a commented script opener remains available to extraction.';
    const html = '<main><noscript><!-- <script> -->'
      + `<p>${outerParagraph}</p></noscript></main>`;
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).toContain(outerParagraph);
  });

  it('fails closed on a minified JavaScript comparison before a paragraph-shaped tail', () => {
    const html = '<main><noscript><script>const comparison=a<p>b; '
      + '<p>COMPARISON_PAYLOAD</p></main>';
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).not.toContain('COMPARISON_PAYLOAD');
    expect(result.text).toBe('');
  });

  it.each([
    ['JavaScript string', 'const template = "</p>";'],
    ['JavaScript comment', '/* </p> */'],
    ['JSON string', '{"html":"</p>"}'],
  ])('fails closed on comparison plus a lexical %s before a paragraph tail', (_label, lexicalSource) => {
    const html = `<main><noscript><script>const comparison=a<p>b; ${lexicalSource} `
      + '<p>MIXED_COMPARISON_PAYLOAD</p></main>';
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).not.toContain('MIXED_COMPARISON_PAYLOAD');
    expect(result.text).toBe('');
  });

  it.each([
    ['string', 'before "STRING_CLOSE_PAYLOAD</p>"'],
    ['JSON', 'before {"html":"JSON_CLOSE_PAYLOAD</p>"}'],
    ['comment', 'before /* COMMENT_CLOSE_PAYLOAD</p> */'],
  ])('fails closed when an immediate HTML opener contains a lexical %s before its close', (_label, source) => {
    const html = `<main><noscript><script><p>${source}</main>`;
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).not.toContain('STRING_CLOSE_PAYLOAD');
    expect(result.text).not.toContain('JSON_CLOSE_PAYLOAD');
    expect(result.text).not.toContain('COMMENT_CLOSE_PAYLOAD');
    expect(result.text).toBe('');
  });

  it.each([
    ['string', 'const value = "</noscript>";'],
    ['JSON', '{"html":"</noscript>"}'],
    ['comment', '/* </noscript> */'],
    ['regex', String.raw`const value = /<\/noscript>/;`],
  ])('does not treat a lexical %s noscript end tag as an outer boundary', (_label, source) => {
    const outerParagraph = 'False noscript close must not expose outer content after a lexical payload.';
    const html = `<main><noscript><script>${source}</main><p>${outerParagraph}</p>`;
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).not.toContain(outerParagraph);
    expect(result.text).toBe('');
  });

  it('does not expose outer prose after a nested template fake noscript end tag', () => {
    const outerParagraph = 'FALSE_OUTER_FROM_NESTED_TEMPLATE';
    const html = '<main><noscript><script>const value = `outer ${`</noscript>`}`;'
      + `<p>${outerParagraph}</p></main>`;
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).not.toContain(outerParagraph);
    expect(result.text).toBe('');
  });

  it('keeps adjacent tracking noscript blocks out of the fallback path', () => {
    const editorial = 'Editorial fallback paragraph with enough substantive source context for extraction.';
    const tracking = 'Tracking payload that is long enough to pass the paragraph floor and must never enter source text.';
    const html = '<article>'
      + `<noscript><p>${editorial}</p></noscript>`
      + `<noscript><div class="tracking-pixel"><p>${tracking}</p></div></noscript>`
      + '</article>';
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).toContain(editorial);
    expect(result.text).not.toContain(tracking);
  });

  it('preserves editorial order across adjacent noscript blocks', () => {
    const first = 'First adjacent editorial fallback paragraph retains its original document position.';
    const tracking = 'Adjacent tracking payload remains excluded even when surrounded by editorial blocks.';
    const second = 'Second adjacent editorial fallback paragraph follows the first without reordering.';
    const html = '<article>'
      + `<noscript><p>${first}</p></noscript>`
      + `<noscript><div data-track-pixel="1"><p>${tracking}</p></div></noscript>`
      + `<noscript><p>${second}</p></noscript>`
      + '</article>';
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.method).toBe('article-tag');
    expect(result.text).toBe(`${first}\n\n${second}`);
    expect(result.text).not.toContain(tracking);
  });

  it('preserves JSON-LD precedence inside normalized noscript markup', () => {
    const articleBody = 'Structured JSON-LD body wins over fallback prose and remains the authoritative source. '.repeat(4);
    const fallbackOne = 'Fallback prose paragraph one is long enough to survive extraction but must not outrank JSON-LD.';
    const fallbackTwo = 'Fallback prose paragraph two is also long enough to survive extraction but must not outrank JSON-LD.';
    const html = '<main><noscript>'
      + `&lt;script type="application/ld+json"&gt;${JSON.stringify({ '@type': 'NewsArticle', articleBody })}&lt;/script&gt;`
      + `&lt;p&gt;${fallbackOne}&lt;/p&gt;`
      + `&lt;p&gt;${fallbackTwo}&lt;/p&gt;`
      + '</noscript></main>';
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.method).toBe('jsonld');
    expect(result.text).toContain('Structured JSON-LD body wins');
    expect(result.text).not.toContain(fallbackOne);
    expect(result.text).not.toContain(fallbackTwo);
  });

  it.each(['direct', 'normalized'])('rejects %s JSON-LD marked as tracking on the script candidate', (shape) => {
    const trackingBody = 'Tracking JSON-LD payload must not become the authoritative article source. '.repeat(4);
    const fallbackOne = 'Editorial fallback paragraph one remains available when tracking JSON-LD is rejected.';
    const fallbackTwo = 'Editorial fallback paragraph two remains available when tracking JSON-LD is rejected.';
    const markup = '<script type="application/ld+json" class="tracking-pixel">'
      + `${JSON.stringify({ articleBody: trackingBody })}</script>`
      + `<p>${fallbackOne}</p><p>${fallbackTwo}</p>`;
    const fallback = shape === 'normalized'
      ? markup.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      : markup;
    const html = `<main><noscript>${fallback}</noscript></main>`;
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.method).toBe('main-tag');
    expect(result.text).toContain(fallbackOne);
    expect(result.text).toContain(fallbackTwo);
    expect(result.text).not.toContain('Tracking JSON-LD payload');
  });

  it('rejects a noscript fallback inside an external tracking wrapper', () => {
    const tracking = 'Tracking wrapper payload must never enter extracted article text.';
    const first = 'First regular article paragraph remains available outside the tracking wrapper.';
    const second = 'Second regular article paragraph remains available outside the tracking wrapper.';
    const html = '<article>'
      + `<div class="tracking-pixel"><noscript><p>${tracking}</p></noscript></div>`
      + `<p>${first}</p><p>${second}</p>`
      + '</article>';
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.method).toBe('article-tag');
    expect(result.text).toContain(first);
    expect(result.text).toContain(second);
    expect(result.text).not.toContain(tracking);
  });

  it.each([
    ['plain text', 'Plain noscript source text remains available when no paragraph wrapper is present.'],
    ['div text', '<div>Noscript source text inside a plain div remains available without a paragraph wrapper.</div>'],
  ])('preserves valid %s in the legacy fallback path', (_label, fallback) => {
    const html = `<main><noscript>${fallback}</noscript></main>`;
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.method).toBe('naive-fallback');
    expect(result.text.toLowerCase()).toContain('noscript source text');
  });

  it('filters document noise wrappers from normalized noscript markup', () => {
    const html = '<main><noscript>&lt;div class="advert"&gt;&lt;p&gt;Sponsored offer text for the partner placement with details and pricing.&lt;/p&gt;&lt;/div&gt;&lt;p&gt;Article paragraph one contains the actual source story and enough prose.&lt;/p&gt;&lt;p&gt;Article paragraph two continues the actual source story with more context.&lt;/p&gt;</noscript></main>';
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.method).toBe('main-tag');
    expect(result.text).not.toContain('Sponsored offer text for the partner placement with details and pricing.');
    expect(result.text).toContain('Article paragraph one contains the actual source story and enough prose.');
    expect(result.text).toContain('Article paragraph two continues the actual source story with more context.');
  });

  it('keeps metadata and tracking noscript blocks out of the OG fallback', () => {
    const ogDescription = 'This description identifies the source article and provides enough verified context for the generator to use as a fallback without relying on any no-script tracking payload from the page. It also contains a second sentence so the existing long-description floor remains the deliberate gate for the OG fallback path.';
    const trackingPayload = 'Tracking payload that is long enough to pass the paragraph floor and must never become article source text for the generator.';
    const html = `<html><head>
      <meta property="og:description" content="${ogDescription}">
    </head><body>
      <noscript><div class="tracking-pixel"><p>${trackingPayload}</p></div></noscript>
      <noscript>&lt;meta name="description" content="metadata only"&gt;&lt;div data-nosnippet="true"&gt;&lt;p&gt;${trackingPayload}&lt;/p&gt;&lt;/div&gt;</noscript>
    </body></html>`;
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.method).toBe('og-fallback');
    expect(result.text).toContain(ogDescription);
    expect(result.text).not.toContain(trackingPayload);
  });

  it('filters metadata from a noscript wrapper marked as hidden', () => {
    const html = '<main><noscript hidden><p>Hidden tracking payload that must never enter the extracted article text.</p></noscript>'
      + '<p>Editorial paragraph one with enough content for extraction.</p>'
      + '<p>Editorial paragraph two with enough content for extraction.</p></main>';
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.method).toBe('main-tag');
    expect(result.text).not.toContain('Hidden tracking payload');
    expect(result.text).toContain('Editorial paragraph one');
  });

  it.each([
    ['hidden', '<p hidden>'],
    ['aria-hidden', '<p aria-hidden="true">'],
    ['data-nosnippet', '<p data-nosnippet="true">'],
    ['tracking class', '<p class="tracking-pixel">'],
    ['tracking pixel attribute', '<p data-track-pixel="1">'],
    ['tracking analytics attribute', '<p data-track-analytics="1">'],
  ])('filters a non-content marker on the candidate paragraph: %s', (_label, openingTag) => {
    const payload = 'Candidate-level tracking payload that must never enter the extracted article text.';
    const html = `<article><noscript>${openingTag}${payload}</p>`
      + '<p>Editorial paragraph one with enough content for extraction.</p>'
      + '<p>Editorial paragraph two with enough content for extraction.</p>'
      + '</noscript></article>';
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.method).toBe('article-tag');
    expect(result.text).not.toContain(payload);
    expect(result.text).toContain('Editorial paragraph one');
    expect(result.text).toContain('Editorial paragraph two');
  });

  it('preserves editorial noscript paragraphs with normal analytics attributes', () => {
    const html = '<article><noscript>'
      + '<p data-track-id="story-1">Editorial noscript paragraph one with enough content for extraction.</p>'
      + '<p data-track-id="story-2">Editorial noscript paragraph two with enough content for extraction.</p>'
      + '</noscript><p>Regular article paragraph one with enough content for extraction.</p>'
      + '<p>Regular article paragraph two with enough content for extraction.</p></article>';
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.method).toBe('article-tag');
    expect(result.text).toContain('Editorial noscript paragraph one');
    expect(result.text).toContain('Editorial noscript paragraph two');
  });

  it('filters tracked wrappers inside a mixed editorial noscript fallback', () => {
    const html = '<article><noscript>'
      + '<p>Editorial fallback paragraph one with enough words to survive extraction.</p>'
      + '<p>Editorial fallback paragraph two with enough words to survive extraction.</p>'
      + '<div data-track-id="pixel"><p>Tracking payload paragraph with enough words to survive extraction.</p></div>'
      + '</noscript></article>';
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.method).toBe('article-tag');
    expect(result.text).toContain('Editorial fallback paragraph one');
    expect(result.text).toContain('Editorial fallback paragraph two');
    expect(result.text).not.toContain('Tracking payload paragraph');
  });

  it('filters numeric data-track-id wrappers while preserving the candidate paragraph', () => {
    const editorial = 'Editorial fallback paragraph with a normal tracking identifier remains eligible for extraction.';
    const tracking = 'Numeric tracking wrapper payload must never enter the extracted article text.';
    const html = '<article><noscript>'
      + `<p data-track-id="story-1">${editorial}</p>`
      + `<div data-track-id="123"><p>${tracking}</p></div>`
      + '</noscript></article>';
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.text).toContain(editorial);
    expect(result.text).not.toContain(tracking);
  });

  it('preserves a non-paragraph data-track-id candidate while filtering marked ancestors', () => {
    const editorial = 'Editorial non-paragraph fallback candidate contains enough substantive source context for generation.';
    const tracking = 'Tracking child inside a marked ancestor must never become legacy article source text.';
    const html = '<main><noscript>'
      + `<div data-track-id="story-1">${editorial}</div>`
      + `<div data-track-id="tracking-wrapper"><span>${tracking}</span></div>`
      + '</noscript></main>';
    const result = extractArticleText(html, { scriptingDisabled: true });

    expect(result.method).toBe('naive-fallback');
    expect(result.text).toContain(editorial);
    expect(result.text).not.toContain(tracking);
  });

  it('caps very long noscript paragraphs before the final source join', () => {
    const oversized = 'Editorial fallback source '.repeat(500);
    const trailing = 'Trailing paragraph that must not be collected after the source cap is exhausted.';
    const html = `<main><noscript><p>${oversized}</p><p>${trailing}</p></noscript></main>`;
    const result = extractArticleText(html, { scriptingDisabled: true, maxChars: 8000 });

    expect(result.method).toBe('main-tag');
    expect(result.text).toHaveLength(8000);
    expect(result.paragraphCount).toBe(2);
    expect(result.text).not.toContain('Trailing paragraph');
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


describe('source publication date provenance', () => {
  const publishedAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const modifiedAt = new Date(Date.now() - 86_400_000).toISOString();
  function publication(markup: string) {
    const dom = new JSDOM(markup);
    try { return extractPublishedDate(dom.window.document); }
    finally { dom.window.close(); }
  }

  it('retains explicit JSON-LD publication over a later modification', () => {
    expect(publication(`<script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', datePublished: publishedAt, dateModified: modifiedAt })}</script>`)).toBe(publishedAt);
  });

  it.each(['dateCreated', 'dateModified'])('does not reinterpret JSON-LD %s as publication', (field) => {
    expect(publication(`<script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', [field]: modifiedAt })}</script>`)).toBe('');
  });

  it.each([
    '<meta name="date" content="DATE">',
    '<meta property="article:modified_time" content="DATE">',
    '<time datetime="DATE">Updated</time>',
    '<time itemprop="dateModified" datetime="DATE">Updated</time>',
  ])('leaves ambiguous or modification markup unknown: %s', (markup) => {
    expect(publication(markup.replace('DATE', modifiedAt))).toBe('');
  });

  it.each([
    '<meta property="article:published_time" content="DATE">',
    '<meta itemprop="datePublished" content="DATE">',
    '<meta name="pubdate" content="DATE">',
    '<time itemprop="datePublished" datetime="DATE">Published</time>',
  ])('retains explicitly identified publication markup: %s', (markup) => {
    expect(publication(markup.replace('DATE', publishedAt))).toBe(publishedAt);
  });

  it('continues past modification-only graph nodes to explicit publication', () => {
    const graph = { '@graph': [{ dateModified: modifiedAt }, { '@type': 'NewsArticle', datePublished: publishedAt }] };
    expect(publication(`<script type="application/ld+json">${JSON.stringify(graph)}</script>`)).toBe(publishedAt);
  });

  it('falls through invalid JSON-LD publication to an explicit publication meta tag', () => {
    expect(publication(`<script type="application/ld+json">{"datePublished":"invalid","dateModified":"${modifiedAt}"}</script><meta property="article:published_time" content="${publishedAt}">`)).toBe(publishedAt);
  });
});
